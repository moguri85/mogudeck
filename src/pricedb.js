'use strict';
// Base local de precios: descarga diaria del fichero «Default Cards» de Scryfall y se guarda,
// para cada carta, el precio en euros (Cardmarket) de su impresión más barata.
const zlib = require('zlib');
const readline = require('readline');
const { Readable } = require('stream');
const { db, setting, setSetting, log } = require('./db');

const API = (process.env.SCRYFALL_URL || 'https://api.scryfall.com').replace(/\/$/, '');
// Guía de precios pública de Cardmarket para Magic (se publica a diario): avg, low, trend, avg1, avg7, avg30 y sus versiones foil
const CM_GUIDE = process.env.CARDMARKET_GUIDE_URL || 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json';
const SOURCES = {
  avg: 'Precio medio de venta (average) de Cardmarket',
  trend: 'Precio de tendencia (trend) de Cardmarket',
  low: 'Precio más bajo (desde) de Cardmarket',
  avg7: 'Media de ventas de los últimos 7 días de Cardmarket',
  avg30: 'Media de ventas de los últimos 30 días de Cardmarket',
  scryfall: 'Precio de Cardmarket que publica Scryfall',
};
const source = () => (SOURCES[setting('price_source')] ? setting('price_source') : 'avg');
let guideInfo = null; // { createdAt, products, used, error }
async function loadGuide(field) {
  const r = await fetch(CM_GUIDE, { headers: { 'User-Agent': UA['User-Agent'], Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Cardmarket respondió ${r.status}`);
  const j = await r.json();
  const list = j.priceGuides || j.priceguides || [];
  if (!list.length) throw new Error('La guía de precios de Cardmarket viene vacía');
  const map = new Map();
  for (const g of list) {
    const n = Number(g[field]), f = Number(g[field + '-foil']);
    map.set(Number(g.idProduct), { n: n > 0 ? n : null, f: f > 0 ? f : null });
  }
  return { map, createdAt: j.createdAt || null };
}
const UA = { 'User-Agent': 'JupiterTorneos/1.0', Accept: 'application/json' };

db.exec('CREATE TABLE IF NOT EXISTS card_cache (key TEXT PRIMARY KEY, json TEXT, fetched_at INTEGER)');
db.exec(`CREATE TABLE IF NOT EXISTS card_prices (
  key TEXT PRIMARY KEY, name TEXT, eur REAL, set_code TEXT, set_name TEXT, cn TEXT, img TEXT, url TEXT
)`);

// Quita los parámetros de seguimiento que añade Scryfall (referrer, utm_*): Cloudflare de Cardmarket bloquea esos enlaces
function cleanUrl(u) {
  if (!u) return u;
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) if (k === 'referrer' || k.startsWith('utm_')) x.searchParams.delete(k);
    return x.toString();
  } catch { return u; }
}

// v3: además del precio, datos para reconocer al comandante (tipo, identidad de color, si puede ser comandante y compañeros)
{
  const cols = db.prepare('PRAGMA table_info(card_prices)').all().map(c => c.name);
  let added = false;
  for (const [c, t] of [['art', 'TEXT'], ['tl', 'TEXT'], ['ci', 'TEXT'], ['cmd', 'INTEGER'], ['pt', 'TEXT'], ['gc', 'INTEGER'], ['et', 'INTEGER'], ['tut', 'INTEGER'], ['leg', 'TEXT'], ['maxc', 'INTEGER']]) {
    if (!cols.includes(c)) { db.exec(`ALTER TABLE card_prices ADD COLUMN ${c} ${t}`); added = true; }
  }
  if (added) setSetting('price_db_version', '');
}

// Datos de reglas de una carta de Scryfall: tipo, identidad de color, si puede ser comandante y cómo se empareja
function rulesInfo(c) {
  const face = (c.card_faces && c.card_faces[0]) || c;
  const tl = c.type_line || face.type_line || '';
  const frontType = face.type_line || tl;
  const text = [c.oracle_text, ...(c.card_faces || []).map(f => f.oracle_text)].filter(Boolean).join('\n');
  const kw = (c.keywords || []).map(k => k.toLowerCase());
  const ci = 'WUBRG'.split('').filter(k => (c.color_identity || []).includes(k)).join('');
  const legendary = /legendary/i.test(frontType);
  const cmd = legendary && (/creature/i.test(frontType) || /can be your commander/i.test(text)) ? 1 : 0;
  let pt = '';
  const pw = text.match(/partner with ([^\n(]+?)(?:\s*\(|\n|$)/i);
  if (pw) pt = 'pw:' + pw[1].trim().toLowerCase();
  else if (kw.includes('partner') || /^partner(\s*\(|$)/im.test(text)) pt = 'partner';
  else if (kw.includes('friends forever') || /friends forever/i.test(text)) pt = 'friends';
  else if (/choose a background/i.test(text)) pt = 'choosebg';
  else if (/\bbackground\b/i.test(tl) && /legendary enchantment/i.test(tl)) pt = 'background';
  else if (/doctor's companion/i.test(text)) pt = 'companion';
  else if (/time lord doctor/i.test(tl)) pt = 'doctor';
  // Para el bracket: Game Changer (lista oficial, viene de Scryfall), turnos extra y tutores
  const gc = c.game_changer ? 1 : 0;
  const et = /\btakes? an extra turn\b|\bextra turn after this one\b/i.test(text) ? 1 : 0;
  const tut = /search your library for (?:a|an|up to \w+) card(?:s)?\b(?! named)/i.test(text) && !/basic land card/i.test(text) ? 1 : 0;
  // Legalidad en Commander y copias permitidas (Relentless Rats y similares: cualquier número; Siete Enanos: 7; Nazgûl: 9)
  const leg = (c.legalities && c.legalities.commander) || null;
  let maxc = 1;
  if (/a deck can have any number of cards named/i.test(text)) maxc = 99;
  else { const m = text.match(/a deck can have up to (\w+) cards named/i); if (m) maxc = { seven: 7, nine: 9 }[m[1].toLowerCase()] || parseInt(m[1], 10) || 1; }
  return { tl, ci, cmd: cmd || (pt === 'background' ? 1 : 0), pt, gc, et, tut, leg, maxc };
}

let running = false;
let lastError = null;

const get = db.prepare('SELECT * FROM card_prices WHERE key = ?');
function lookup(name) {
  const k = String(name || '').trim().toLowerCase();
  if (!k) return undefined;
  const r = get.get(k) || get.get(k.split(/\s*\/\/?\s*/)[0]);
  if (!r) return undefined;
  return { name: r.name, eur: r.eur, eurFoil: null, set: r.set_code, setName: r.set_name, cn: r.cn, img: r.img, art: r.art || null, url: cleanUrl(r.url),
    tl: r.tl || null, ci: r.ci ?? null, cmd: r.cmd ?? null, pt: r.pt || '', gc: r.gc ?? null, et: r.et ?? null, tut: r.tut ?? null, leg: r.leg || null, maxc: r.maxc ?? null };
}

function count() { return db.prepare('SELECT COUNT(*) c FROM card_prices').get().c; }
function status() {
  const used = setting('price_db_source') || 'scryfall';
  return { count: count(), updatedAt: setting('price_db_at') || null, version: setting('price_db_version') || null, running, lastError,
    source: used, sourceLabel: SOURCES[used] || SOURCES.scryfall, wanted: source(), guide: guideInfo };
}

// Impresiones que no valen para jugar (tamaño grande, recuerdos, tokens…)
function playable(c) {
  if (c.digital || c.oversized) return false;
  if (c.games && !c.games.includes('paper')) return false;
  if (['token', 'memorabilia', 'minigame'].includes(c.set_type)) return false;
  if (['token', 'double_faced_token', 'emblem', 'art_series', 'vanguard', 'scheme', 'planar'].includes(c.layout)) return false;
  return true;
}

async function refresh({ force = false } = {}) {
  if (running) return status();
  running = true;
  lastError = null;
  try {
    const list = await fetch(`${API}/bulk-data`, { headers: UA }).then(r => {
      if (!r.ok) throw new Error(`Scryfall respondió ${r.status}`);
      return r.json();
    });
    const entry = (list.data || []).find(d => d.type === 'default_cards');
    if (!entry) throw new Error('Scryfall no ofrece el fichero default_cards');
    // Fuente del precio: la guía de Cardmarket (si se puede descargar) o, si falla, el precio de Scryfall
    const src = source();
    let guide = null;
    if (src !== 'scryfall') {
      try { guide = await loadGuide(src); guideInfo = { createdAt: guide.createdAt, products: guide.map.size, used: 0, error: null }; }
      catch (e) { guideInfo = { error: e.message }; log('warn', 'Guía de precios de Cardmarket: ' + e.message + '. Se usan los precios de Scryfall.'); }
    }
    const version = `${entry.updated_at}|${guide ? src + '|' + (guide.createdAt || '') : 'scryfall'}`;
    if (!force && version === setting('price_db_version') && count() > 0) return status();
    const uri = entry.jsonl_download_uri || entry.download_uri;
    const res = await fetch(uri, { headers: { 'User-Agent': UA['User-Agent'] } });
    if (!res.ok) throw new Error(`Descarga de precios: HTTP ${res.status}`);
    let stream = Readable.fromWeb(res.body);
    if (/\.gz($|\?)/.test(uri)) stream = stream.pipe(zlib.createGunzip());
    const best = new Map();
    let seen = 0;
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (let line of rl) {
      line = line.trim();
      if (!line.startsWith('{')) continue;
      if (line.endsWith(',')) line = line.slice(0, -1);
      let c;
      try { c = JSON.parse(line); } catch { continue; }
      seen++;
      if (!playable(c) || !c.prices) continue;
      const g = guide && c.cardmarket_id ? guide.map.get(Number(c.cardmarket_id)) : null;
      let prices = g ? [g.n, g.f].filter(v => v != null) : [];
      if (prices.length) guideInfo.used++;
      else prices = [c.prices.eur, c.prices.eur_foil, c.prices.eur_etched].map(v => (v ? parseFloat(v) : null)).filter(v => v != null && v > 0);
      if (!prices.length) continue;
      const eur = Math.min(...prices);
      const img = c.image_uris || (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris) || {};
      const rec = { name: c.name, eur, set: c.set, setName: c.set_name, cn: c.collector_number, img: img.small || null, art: img.art_crop || null, ...rulesInfo(c),
        url: cleanUrl((c.purchase_uris && c.purchase_uris.cardmarket) || c.scryfall_uri) };
      const keys = [c.name.toLowerCase()];
      if (c.name.includes(' // ')) keys.push(c.name.split(' // ')[0].toLowerCase());
      for (const k of keys) {
        const cur = best.get(k);
        if (!cur || eur < cur.eur) best.set(k, rec);
      }
    }
    if (best.size < 1000 && !process.env.SCRYFALL_URL) throw new Error(`Fichero de precios incompleto (${best.size} cartas)`);
    // Se carga en una tabla nueva y se cambia de golpe: las consultas no ven datos a medias
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS card_prices_new');
      db.exec('CREATE TABLE card_prices_new (key TEXT PRIMARY KEY, name TEXT, eur REAL, set_code TEXT, set_name TEXT, cn TEXT, img TEXT, url TEXT, art TEXT, tl TEXT, ci TEXT, cmd INTEGER, pt TEXT, gc INTEGER, et INTEGER, tut INTEGER, leg TEXT, maxc INTEGER)');
      const ins = db.prepare('INSERT INTO card_prices_new VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const [k, r] of best) ins.run(k, r.name, r.eur, r.set, r.setName, r.cn, r.img, r.url, r.art, r.tl, r.ci, r.cmd, r.pt, r.gc, r.et, r.tut, r.leg, r.maxc);
      db.exec('DROP TABLE card_prices');
      db.exec('ALTER TABLE card_prices_new RENAME TO card_prices');
    })();
    setSetting('price_db_version', version);
    setSetting('price_db_source', guide ? src : 'scryfall');
    setSetting('price_db_at', new Date().toISOString());
    db.prepare("DELETE FROM card_cache WHERE key LIKE 'cheap:%'").run();
    log('info', `Precios de cartas actualizados: ${best.size} cartas (de ${seen} impresiones)`);
    return status();
  } catch (e) {
    lastError = e.message;
    log('error', 'Precios de cartas: ' + e.message);
    throw e;
  } finally {
    running = false;
  }
}

// Revisa cada 3 horas si Scryfall ha publicado precios nuevos (lo hace una vez al día)
function start() {
  const tick = () => refresh().catch(() => {});
  setTimeout(tick, 90e3);
  setInterval(tick, 3 * 3600e3);
}

module.exports = { lookup, refresh, start, status, count, cleanUrl, rulesInfo, SOURCES };
