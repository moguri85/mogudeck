'use strict';
// Valor de un mazo en euros (precio de tendencia de Cardmarket que publica Scryfall).
// Acepta texto (Moxfield, Archidekt, MTGA, ManaBox: «1 Sol Ring (C21) 263 *F*») o el CSV de ManaBox.
const crypto = require('crypto');
const { db } = require('./db');
const pricedb = require('./pricedb');

db.exec(`CREATE TABLE IF NOT EXISTS card_cache (key TEXT PRIMARY KEY, json TEXT, fetched_at INTEGER)`);
const TTL = 24 * 3600e3;
const UA = { 'User-Agent': 'JupiterTorneos/1.0', Accept: 'application/json' };
const API = (process.env.SCRYFALL_URL || 'https://api.scryfall.com').replace(/\/$/, '');

// ---------- Lectura de listas ----------
// Acepta casi cualquier formato: secciones con o sin «:» y recuento («Commander (1)», «Creatures (30)»), comandante
// arriba o abajo, marcas como *CMDR* o [Commander], exportación MTGO (comandante en el sideboard)…
// Si la lista no dice cuál es el comandante, se deduce después con los datos de las cartas (ver inferCommander).
// Cabeceras sueltas o entre corchetes, llaves o asteriscos: «Commander», «[COMMANDER]», «{Mainboard}», «**Sideboard**»
const H = '^(?:\\/\\/\\s*|#+\\s*)?[\\[\\{\\*_]*\\s*';
const TAIL = '\\s*[\\]\\}\\*_]*\\s*(?:\\(\\d+\\))?\\s*:?\\s*$';
const CMD_HEAD = new RegExp(`${H}(?:commanders?|comandantes?|command\\s*zone|commander\\s*\\(s\\))${TAIL}`, 'i');
const COMP_HEAD = new RegExp(`${H}(?:companions?|compa[ñn]eros?)${TAIL}`, 'i');
const SIDE_HEAD = new RegExp(`${H}(?:sideboard|side|banquillo|reserva)${TAIL}`, 'i');
const SKIP_HEAD = new RegExp(`${H}(?:maybeboard|maybe|considering|tokens?|fichas|acquireboard|wishlist|sideboard\\s*\\(maybe\\))${TAIL}`, 'i');
const MAIN_HEAD = new RegExp(`${H}(?:deck|mazo|main|mainboard|main\\s*deck|maindeck|library|biblioteca|creatures?|criaturas?|lands?|tierras?|instants?|instant[aá]neos?|sorcer(?:y|ies)|conjuros?|artifacts?|artefactos?|enchantments?|encantamientos?|planeswalkers?|battles?|batallas?|spells?|other|otros?)${TAIL}`, 'i');
const TYPE_COUNT_HEAD = /^[A-Za-zÀ-ÿ' ]{3,30}\s*\(\d+\)\s*:?$/;
const CMD_MARK = /\s*(\*cmdr\*|\[[^\]]*\bcommander\b[^\]]*\]|\(commander\)|#\s*!?commander\b|\s-\s*commander\s*$)/i;

function parseText(text) {
  const out = [];
  let section = '', block = 0, prevBlank = true, any = false;
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.replace(/\t/g, ' ').trim();
    if (!line) {
      if (any && !prevBlank) block++;
      // La sección del comandante acaba en la primera línea en blanco tras sus cartas
      if (section === 'commander' && out.length && out[out.length - 1].commander) section = 'main';
      if (section === 'companion' && out.length && out[out.length - 1].companion) section = 'main';
      prevBlank = true; continue;
    }
    // Comentarios: «// Commander» abre sección; cualquier otro comentario cierra la del comandante y se ignora
    if (/^(\/\/|#)/.test(line) && !CMD_HEAD.test(line) && !SIDE_HEAD.test(line) && !MAIN_HEAD.test(line) && !COMP_HEAD.test(line)) { if (section === 'commander') section = 'main'; continue; }
    if (CMD_HEAD.test(line)) { section = 'commander'; prevBlank = false; continue; }
    if (SKIP_HEAD.test(line)) { section = 'skip'; continue; }
    if (COMP_HEAD.test(line)) { section = 'companion'; prevBlank = false; continue; }
    if (SIDE_HEAD.test(line)) { section = 'side'; prevBlank = false; continue; }
    if (MAIN_HEAD.test(line) || (TYPE_COUNT_HEAD.test(line) && !/^\d/.test(line))) { section = 'main'; prevBlank = false; continue; }
    if (section === 'skip') continue;
    let side = section === 'side';
    if (/^SB:\s*/i.test(line)) { side = true; line = line.replace(/^SB:\s*/i, ''); }
    let commander = section === 'commander';
    if (CMD_MARK.test(line)) { commander = true; line = line.replace(CMD_MARK, ' ').trim(); }
    if (/\[[^\]]*\b(maybeboard|considering)\b[^\]]*\]/i.test(line)) continue;
    if (/\[[^\]]*\bsideboard\b[^\]]*\]/i.test(line)) side = true;
    const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    let qty = 1, rest = line;
    if (m) { qty = parseInt(m[1], 10); rest = m[2]; }
    const foil = /\*(F|E)\*|\(foil\)|\bfoil\b/i.test(rest);
    rest = rest.replace(/\*(F|E)\*/gi, '').replace(/\(foil\)/gi, '').replace(/\s+#.*$/, '').replace(/\s+\[[^\]]*\]/g, '').replace(/\s+\^[^^]*\^/g, '').trim();
    let set = null, cn = null;
    const st = rest.match(/^(.+?)\s+\(([A-Za-z0-9]{2,6})\)(?:\s+([\w★\-]+))?\s*$/) || rest.match(/^(.+?)\s+\[([A-Za-z0-9]{2,6})\](?:\s+([\w★\-]+))?\s*$/);
    if (st) { rest = st[1]; set = st[2].toLowerCase(); cn = st[3] || null; }
    if (!rest || qty < 1 || qty > 250) continue;
    const companion = section === 'companion' && !commander;
    out.push({ qty, name: rest.trim(), set, cn, foil, commander: commander && !side && !companion, side: side && !commander && !companion, companion, block, pos: out.length });
    any = true; prevBlank = false;
  }
  // Bloques separados por líneas en blanco: un bloque pequeño al principio o al final suele ser el comandante
  const blocks = new Map();
  for (const it of out) blocks.set(it.block, (blocks.get(it.block) || 0) + 1);
  const ids = [...blocks.keys()];
  for (const it of out) {
    it.isolated = ids.length > 1 && blocks.get(it.block) <= 2 && (it.block === ids[0] || it.block === ids[ids.length - 1]);
    it.first = it.pos === 0;
    it.last = it.pos === out.length - 1;
  }
  return out;
}

// ---------- Tierras básicas en cualquier idioma ----------
// Nunca cuentan para el presupuesto. Se traducen al inglés para encontrarlas.
const BASIC_NAMES = {
  Plains: ['plains', 'llanura', 'llanuras', 'plaine', 'plaines', 'ebene', 'pianura', 'planicie', 'planície', '平地', '平原', '들', 'равнина'],
  Island: ['island', 'isla', 'ile', 'île', 'insel', 'isola', 'ilha', '島', '岛屿', '海岛', '海島', '섬', 'остров'],
  Swamp: ['swamp', 'pantano', 'marais', 'sumpf', 'palude', 'pântano', 'pantano', '沼', '沼泽', '沼澤', '늪', 'болото'],
  Mountain: ['mountain', 'montaña', 'montana', 'montagne', 'gebirge', 'montagna', 'montanha', '山', '山脉', '山脈', '산', 'гора'],
  Forest: ['forest', 'bosque', 'foret', 'forêt', 'wald', 'foresta', 'floresta', '森', '树林', '樹林', '숲', 'лес'],
  Wastes: ['wastes', 'yermo', 'yermos', 'terres desolees', 'terres désolées', 'ödnis', 'odnis', 'distese desolate', 'ermos', '荒地', '荒野', '황무지', 'пустоши'],
};
const BASIC_INDEX = new Map();
const nk = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
for (const [en, list] of Object.entries(BASIC_NAMES)) for (const n of list) BASIC_INDEX.set(nk(n), en);
// Nevadas: «Snow-Covered Forest», «Bosque nevado», «Forêt enneigée», «Verschneiter Wald», «Foresta innevata»…
const SNOW = /^(snow[-\s]covered\s+|verschneite[rs]?\s+)|\s+(nevad[oa]s?|enneigee?s?|innevat[oa]|coberta de neve|cobert[oa]s? de neve|nevad[oa])$/i;
function englishBasic(name) {
  let n = nk(name).replace(/\s*\(.*\)$/, '');
  let snow = false;
  if (SNOW.test(n)) { snow = true; n = n.replace(SNOW, '').trim(); }
  const en = BASIC_INDEX.get(n);
  if (!en) return null;
  return snow && en !== 'Wastes' ? `Snow-Covered ${en}` : en;
}

// ---------- Comandante ----------
// 1) Si la lista lo marca, ese. 2) Exportación MTGO: 1-2 cartas en el sideboard que pueden ser comandante.
// 3) Si no, se deduce: carta legendaria (o «puede ser tu comandante») cuya identidad de color cubre la del mazo,
//    dando más peso a la que está sola arriba o abajo de la lista; también parejas válidas (Partner, Partner with,
//    Friends forever, Choose a Background + Background, Doctor + Doctor's companion).
const lc = s => String(s || '').toLowerCase();
function compatible(a, b) {
  const pa = a.card.pt || '', pb = b.card.pt || '';
  if (pa === 'partner' && pb === 'partner') return true;
  if (pa.startsWith('pt:') && pa === pb) return true;
  if (pa.startsWith('pw:') && lc(b.card.name).startsWith(pa.slice(3))) return true;
  if (pb.startsWith('pw:') && lc(a.card.name).startsWith(pb.slice(3))) return true;
  if (pa === 'friends' && pb === 'friends') return true;
  if ((pa === 'choosebg' && pb === 'background') || (pb === 'choosebg' && pa === 'background')) return true;
  if ((pa === 'doctor' && pb === 'companion') || (pb === 'doctor' && pa === 'companion')) return true;
  return false;
}
function inferCommander(items) {
  const info = { how: null, sure: true, alternatives: [], notes: [] };
  const sum = arr => arr.reduce((s, i) => s + i.qty, 0);
  const known = i => i.card && i.card.cmd != null;
  // Compañero: en su sección, o una carta con «Companion» suelta en el sideboard (exportaciones de MTGO/Arena)
  for (const i of items) if (i.side && i.qty === 1 && i.card && i.card.comp) { i.side = false; i.companion = true; }
  const comps = items.filter(i => i.companion);
  if (comps.length) info.notes.push(`Compañero: ${comps.map(i => (i.card && i.card.name) || i.name).join(', ')} (va fuera de las 100 cartas)`);
  let side = items.filter(i => i.side);
  let main = items.filter(i => !i.side && !i.companion);
  let marked = items.filter(i => i.commander);
  // Más de dos «comandantes» marcados: la marca no es fiable, se deduce entre todas
  if (marked.length > 2) {
    info.notes.push(`La sección del comandante tenía ${marked.length} cartas: se ha deducido cuál es`);
    marked.forEach(i => { i.commander = false; });
    marked = [];
  }
  if (marked.length) {
    info.how = 'marcado';
    for (const m of marked) if (known(m) && !m.card.cmd) info.notes.push(`«${m.card.name}» está marcada como comandante pero no puede serlo (no es criatura legendaria ni Vehículo legendario)`);
  } else if (side.length && side.length <= 2 && side.every(i => i.qty === 1 && known(i) && i.card.cmd) && sum(main) + sum(side) >= 98) {
    side.forEach(i => { i.commander = true; i.side = false; });
    info.how = 'sideboard';
  } else {
    const U = new Set(main.filter(i => i.card && i.card.ci != null).flatMap(i => i.card.ci.split('')));
    const covers = ci => [...U].every(k => (ci || '').includes(k));
    const cands = main.filter(i => i.qty === 1 && known(i) && i.card.cmd);
    const score = i => (i.isolated ? 4 : 0) + (i.first ? 2 : 0) + (i.last ? 2 : 0)
      + ((i.card.ci || '').length === U.size ? 1.5 : 0) + (/creature/i.test(i.card.tl || '') ? 0.5 : 0);
    const opts = [];
    for (const c of cands) if (c.card.pt !== 'background' && covers(c.card.ci)) opts.push({ items: [c], score: score(c) });
    for (let x = 0; x < cands.length; x++) for (let y = x + 1; y < cands.length; y++) {
      const a = cands[x], b = cands[y];
      if (!compatible(a, b) || !covers((a.card.ci || '') + (b.card.ci || ''))) continue;
      const together = a.block === b.block && Math.abs(a.pos - b.pos) === 1 ? 2 : 0;
      opts.push({ items: [a, b], score: (score(a) + score(b)) / 2 + together + (covers(a.card.ci) || covers(b.card.ci) ? -1 : 1) });
    }
    opts.sort((p, q) => q.score - p.score);
    if (opts.length) {
      opts[0].items.forEach(i => { i.commander = true; });
      info.how = 'deducido';
      info.sure = opts.length === 1 || opts[0].score - opts[1].score >= 2;
      info.alternatives = opts.slice(1, 4).map(o => o.items.map(i => i.card.name).join(' + '));
    } else if (main.some(known)) info.notes.push('No he sabido cuál es el comandante: márcalo escribiendo «Commander» en la línea de encima');
  }
  // Lo que quede en el sideboard no es parte del mazo
  for (const i of items) if (i.side) i.skip = true;
  // 101 cartas porque el comandante está también dentro del mazo: se quita la copia repetida
  let deck = items.filter(i => !i.skip && !i.companion);
  if (sum(deck) > 100) {
    for (const c of deck.filter(i => i.commander)) {
      const dup = deck.find(i => i !== c && !i.commander && i.card && c.card && i.card.name === c.card.name);
      if (dup && sum(deck) > 100) { dup.skip = true; info.notes.push(`«${c.card.name}» aparecía también dentro del mazo: no se cuenta dos veces`); deck = items.filter(i => !i.skip && !i.companion); }
    }
  }
  const n = sum(deck);
  if (n !== 100) info.notes.push(`La lista tiene ${n} cartas (un mazo de Commander tiene 100, comandante incluido)`);
  return info;
}

function csvRows(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === ';') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

// CSV de ManaBox (o cualquiera con columnas Quantity / Name / Scryfall ID / Set code / Collector number / Foil)
function parseCSV(text) {
  const rows = csvRows(text);
  if (rows.length < 2) return null;
  const h = rows[0].map(x => x.trim().toLowerCase());
  const col = (...names) => h.findIndex(x => names.includes(x));
  const iQ = col('quantity', 'qty', 'count', 'cantidad'), iN = col('name', 'card name', 'nombre'), iId = col('scryfall id', 'scryfall_id');
  const iS = col('set code', 'set', 'edition'), iC = col('collector number', 'card number', 'collector_number'), iF = col('foil');
  if (iN < 0 && iId < 0) return null;
  return rows.slice(1).map(r => ({
    qty: Math.max(parseInt(r[iQ], 10) || 1, 1), name: iN >= 0 ? r[iN].trim() : '', id: iId >= 0 ? r[iId].trim() || null : null,
    set: iS >= 0 && r[iS] && r[iS].trim().length <= 6 ? r[iS].trim().toLowerCase() : null, cn: iC >= 0 ? r[iC].trim() || null : null,
    foil: iF >= 0 && /^(foil|etched|true|yes|1|s[ií])$/i.test(r[iF].trim()), commander: false,
  })).filter(x => x.name || x.id).map((x, i, arr) => ({ ...x, pos: i, first: i === 0, last: i === arr.length - 1, block: 0, isolated: false }));
}

function parse(text) {
  const first = String(text).split(/\r?\n/).find(l => l.trim()) || '';
  if (/,|;/.test(first) && /(quantity|scryfall id|name)/i.test(first)) {
    const csv = parseCSV(text);
    if (csv) return csv;
  }
  return parseText(text);
}

// ---------- Scryfall con caché ----------
const getCache = db.prepare('SELECT json, fetched_at FROM card_cache WHERE key = ?');
const putCache = db.prepare('INSERT OR REPLACE INTO card_cache (key, json, fetched_at) VALUES (?, ?, ?)');
function cached(key) {
  const r = getCache.get(key);
  if (!r || Date.now() - r.fetched_at >= TTL) return undefined;
  const j = JSON.parse(r.json);
  return j && j.name && j.rv !== pricedb.RULES_V ? undefined : j; // guardada con reglas antiguas: se vuelve a pedir
}
function store(key, card) { putCache.run(key, JSON.stringify(card), Date.now()); }

// Planificador: como mucho ~9 peticiones por segundo a Scryfall (piden no pasar de 10), varias en vuelo a la vez
let nextSlot = 0;
async function slot() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 110;
  if (at > now) await new Promise(r => setTimeout(r, at - now));
}
async function call(url, opts = {}, tries = 0) {
  await slot();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  let res;
  try {
    res = await fetch(API + url, { ...opts, headers: { ...UA, ...(opts.headers || {}) }, signal: ctrl.signal });
  } catch (e) {
    if (tries < 1) return call(url, opts, tries + 1);
    throw Object.assign(new Error(e.name === 'AbortError' ? 'Scryfall no responde (tiempo agotado)' : `No se puede conectar con Scryfall: ${e.cause?.code || e.message}`), { network: true });
  } finally { clearTimeout(t); }
  if (res.status === 404) return null;
  if (res.status === 429 && tries < 3) { await new Promise(r => setTimeout(r, 1000 * (tries + 1))); return call(url, opts, tries + 1); }
  if (!res.ok) throw new Error(`Scryfall respondió ${res.status}`);
  return res.json();
}

// Solo guardamos lo necesario de cada carta
function slim(c) {
  const img = c.image_uris || (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris) || {};
  return {
    name: c.name, set: c.set, cn: c.collector_number, setName: c.set_name, eur: c.prices.eur ? parseFloat(c.prices.eur) : null,
    eurFoil: c.prices.eur_foil ? parseFloat(c.prices.eur_foil) : null, img: img.small || img.normal || null, url: c.scryfall_uri,
    cardmarket: c.purchase_uris && c.purchase_uris.cardmarket ? c.purchase_uris.cardmarket : null,
    ...pricedb.rulesInfo(c), rv: pricedb.RULES_V,
  };
}

const front = n => n.split(/\s*\/\/?\s*/)[0].trim();

// Impresión exacta (por id o edición + número)
async function exactCards(items) {
  const need = [];
  for (const it of items) {
    it.key = it.id ? `id:${it.id}` : `sc:${it.set}:${it.cn}`;
    const c = cached(it.key);
    if (c !== undefined) it.card = c; else need.push(it);
  }
  for (let i = 0; i < need.length; i += 75) {
    const lote = need.slice(i, i + 75);
    const res = await call('/cards/collection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers: lote.map(it => (it.id ? { id: it.id } : { set: it.set, collector_number: it.cn })) }),
    });
    const found = (res && res.data) || [];
    for (const it of lote) {
      const c = found.find(x => (it.id ? x.id === it.id : x.set === it.set && x.collector_number === it.cn));
      it.card = c ? slim(c) : null;
      store(it.key, it.card);
    }
  }
}

// Impresión más barata en euros (cuando la lista no dice edición, o la indicada no tiene precio)
async function cheapest(name) {
  const key = `cheap:${front(name).toLowerCase()}`;
  const c = cached(key);
  if (c !== undefined) return c;
  const q = encodeURIComponent(`!"${front(name).replace(/"/g, '')}" eur>0 game:paper -st:memorabilia -st:token`);
  let res = await call(`/cards/search?q=${q}&unique=prints&order=eur&dir=asc`);
  let card = res && res.data && res.data[0] ? slim(res.data[0]) : null;
  if (!card) {
    // Puede existir pero sin precio en euros
    res = await call(`/cards/named?fuzzy=${encodeURIComponent(front(name))}`);
    card = res && res.object === 'card' ? { ...slim(res), eur: null, eurFoil: null } : null;
  }
  store(key, card);
  return card;
}

// ---------- Cálculo ----------
// Siempre la impresión más barata de cada carta (sin foil), aunque la lista indique otra edición.
async function value(text, onProgress = () => {}) {
  const items = parse(text).slice(0, 300);
  if (!items.length) throw new Error('No he encontrado cartas en la lista');
  // Solo hace falta buscar la impresión concreta si la línea no trae nombre (CSV con solo Scryfall ID)
  // Básicas en otros idiomas → nombre en inglés
  for (const it of items) { const en = it.name ? englishBasic(it.name) : null; if (en) { it.name = en; it.set = null; it.cn = null; } }
  // Resto de cartas en otros idiomas (tabla de traducción de Scryfall, todas las impresiones)
  const cardnames = require('./cardnames');
  const hasLocal = pricedb.count() > 0;
  let translated = 0;
  for (const it of items) {
    if (!it.name || (hasLocal && pricedb.lookup(front(it.name)))) continue;
    const en = cardnames.lookup(it.name);
    if (en) { it.from = it.name; it.name = en; translated++; }
  }
  const noName = items.filter(it => !it.name && (it.id || (it.set && it.cn)));
  if (noName.length) {
    await exactCards(noName);
    for (const it of noName) if (it.card) it.name = it.card.name;
  }
  const names = [...new Set(items.map(it => front(it.name || '').toLowerCase()).filter(Boolean))];
  const cheap = new Map();
  let done = 0, i = 0, fatal = null;
  onProgress(0, names.length);
  // Primero lo que ya está en caché (instantáneo); el resto con 6 peticiones en paralelo
  // 1º la base local diaria de precios; 2º la caché; 3º la API (cartas muy nuevas o si aún no hay base local)
  const pending = [];
  const local = pricedb.count() > 0;
  for (const n of names) {
    const l = local ? pricedb.lookup(n) : undefined;
    if (l) { cheap.set(n, l); done++; continue; }
    const c = cached(`cheap:${n}`);
    if (c !== undefined) { cheap.set(n, c); done++; } else pending.push(n);
  }
  onProgress(done, names.length);
  const worker = async () => {
    while (i < pending.length && !fatal) {
      const n = pending[i++];
      try { cheap.set(n, await cheapest(n)); } catch (e) { if (e.network) fatal = e; else cheap.set(n, null); }
      onProgress(++done, names.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, pending.length) }, worker));
  if (fatal) throw fatal;
  for (const it of items) it.card = it.name ? cheap.get(front(it.name).toLowerCase()) || null : null;
  const cmdInfo = inferCommander(items);
  const lines = [], missing = [], noPrice = [];
  let total = 0;
  for (const it of items) {
    if (it.skip) continue;
    const card = it.card;
    if (!card) { missing.push(it.name || it.id || `${it.set} ${it.cn}`); continue; }
    const unit = card.eur ?? card.eurFoil;
    if (unit == null) noPrice.push(card.name);
    const sub = (unit || 0) * it.qty;
    total += sub;
    lines.push({ qty: it.qty, name: card.name, set: card.set, setName: card.setName, cn: card.cn, unit, total: Math.round(sub * 100) / 100,
      img: card.img, url: pricedb.cleanUrl(card.cardmarket || card.url), commander: !!it.commander, companion: !!it.companion, from: it.from || null,
      basic: BASICS.test(card.name) || /\bbasic\b/i.test(card.tl || '') });
  }
  // Juntar líneas repetidas de la misma carta
  const merged = new Map();
  for (const l of lines) {
    const m = merged.get(l.name);
    if (m) { m.qty += l.qty; m.total = Math.round((m.total + l.total) * 100) / 100; m.commander = m.commander || l.commander; m.companion = m.companion || l.companion; } else merged.set(l.name, l);
  }
  const out = [...merged.values()].sort((a, b) => (b.commander - a.commander) || (b.companion - a.companion) || (b.total - a.total));
  // Legalidad en Commander
  const legality = checkLegality(out, new Map(items.filter(i => i.card).map(i => [i.card.name, i.card])), cmdInfo);
  if (missing.length) { legality.problems.push({ k: 'missing', msg: `No encontradas (no se pueden comprobar): ${missing.join(', ')}` }); legality.ok = false; }
  // Bracket estimado
  let bracket = null;
  try {
    const infoOf = new Map(items.filter(i => i.card).map(i => [i.card.name, i.card]));
    bracket = await require('./bracket').estimate(out.map(l => ({ name: l.name, qty: l.qty, commander: l.commander, info: infoOf.get(l.name) })));
  } catch (e) { bracket = null; }
  const cmd = out.filter(l => l.commander).map(l => l.name);
  return {
    total: Math.round(total * 100) / 100, cards: out.reduce((s, l) => s + (l.companion ? 0 : l.qty), 0), companion: out.filter(l => l.companion).map(l => l.name).join(', ') || null, lines: out, missing, noPrice,
    commander: cmd.length ? cmd.join(' + ') : null,
    bracket, legality,
    translated,
    commanderHow: cmdInfo.how, commanderSure: cmdInfo.sure, commanderAlternatives: cmdInfo.alternatives, notes: cmdInfo.notes,
    at: new Date().toISOString(),
    pricesAt: pricedb.status().updatedAt,
  };
}

// Trabajos en segundo plano (la primera vez puede tardar unos segundos por los límites de Scryfall)
const jobs = new Map();
function startJob(text) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, text: String(text).slice(0, 60000), status: 'running', done: 0, total: 0, result: null, error: null, created: Date.now() };
  jobs.set(id, job);
  value(text, (d, t) => { job.done = d; job.total = t; })
    .then(r => { job.status = 'done'; job.result = r; })
    .catch(e => { job.status = 'error'; job.error = e.message; });
  for (const [k, j] of jobs) if (Date.now() - j.created > 3600e3) jobs.delete(k);
  return id;
}
const getJob = id => jobs.get(id) || null;

// ---------- Legalidad en Commander ----------
// 100 cartas con el comandante, una copia de cada (salvo básicas y cartas que lo permiten), sin prohibidas
// y todas dentro de la identidad de color del comandante.
function checkLegality(lines, info, cmdInfo) {
  const problems = [];
  const of = l => info.get(l.name) || {};
  const total = lines.reduce((s, l) => s + (l.companion ? 0 : l.qty), 0);
  const cmds = lines.filter(l => l.commander);
  const comps = lines.filter(l => l.companion);
  if (comps.reduce((s, l) => s + l.qty, 0) > 1) problems.push({ k: 'companion', msg: `Solo puede haber un compañero: ${comps.map(l => l.name).join(', ')}` });
  if (!cmds.length) problems.push({ k: 'commander', msg: 'No se sabe cuál es el comandante' });
  for (const c of cmds) if (of(c).cmd === 0) problems.push({ k: 'commander', msg: `«${c.name}» no puede ser comandante` });
  if (cmds.length === 2 && of(cmds[0]).pt != null && !compatible({ card: { ...of(cmds[0]), name: cmds[0].name } }, { card: { ...of(cmds[1]), name: cmds[1].name } })) {
    problems.push({ k: 'commander', msg: `${cmds[0].name} y ${cmds[1].name} no pueden ser comandantes juntos` });
  }
  if (cmds.length > 2) problems.push({ k: 'commander', msg: `Hay ${cmds.length} comandantes` });
  if (total !== 100) problems.push({ k: 'count', msg: `${total} cartas (deben ser 100 contando el comandante)` });
  const dup = lines.filter(l => !l.basic && l.qty > (of(l).maxc || 1));
  if (dup.length) problems.push({ k: 'singleton', msg: `Más de una copia: ${dup.map(l => `${l.qty} × ${l.name}`).join(', ')}` });
  const banned = lines.filter(l => of(l).leg === 'banned');
  if (banned.length) problems.push({ k: 'banned', msg: `Prohibidas en Commander: ${banned.map(l => l.name).join(', ')}` });
  const notLegal = lines.filter(l => of(l).leg === 'not_legal');
  if (notLegal.length) problems.push({ k: 'banned', msg: `No legales en Commander: ${notLegal.map(l => l.name).join(', ')}` });
  const allowed = new Set(cmds.flatMap(c => (of(c).ci || '').split('')).filter(Boolean));
  const ciKnown = cmds.length && cmds.every(c => of(c).ci != null);
  if (ciKnown) {
    const out = lines.filter(l => !l.commander && of(l).ci != null && of(l).ci.split('').some(k => k && !allowed.has(k)));
    if (out.length) problems.push({ k: 'colors', msg: `Fuera de los colores del comandante: ${out.map(l => l.name).join(', ')}` });
  }
  const checked = lines.some(l => of(l).leg != null);
  return { ok: !problems.length, checked, problems };
}

// Valor que cuenta para el presupuesto según las reglas del evento
const BASICS = /^(snow-covered\s+)?(plains|island|swamp|mountain|forest|wastes)$/i;
// Las tierras básicas no cuentan nunca (en cualquier idioma); el comandante, según el evento
function budgetValue(result, { exCommander = false } = {}) {
  let v = 0;
  for (const l of result.lines) {
    if (l.basic || BASICS.test(l.name) || englishBasic(l.name)) continue;
    if (exCommander && l.commander) continue;
    v += l.total || 0;
  }
  return Math.round(v * 100) / 100;
}

module.exports = { checkLegality, englishBasic, parse, parseText, parseCSV, inferCommander, value, startJob, getJob, budgetValue, BASICS };
