'use strict';
// Cartas de las decklists de Melee: se leen de la lista del torneo o, si no vienen, del detalle de cada decklist.
// Sirven para el meta por cartas (qué cartas se juegan, en cuántos mazos y cómo les va).
const { db, log } = require('./db');
const melee = require('./melee');
const data = require('./data');
const cardimg = require('./cardimg');

db.exec(`
CREATE TABLE IF NOT EXISTS decklist_cards (
  decklist_id TEXT NOT NULL, name TEXT NOT NULL, section TEXT NOT NULL DEFAULT '', qty INTEGER NOT NULL,
  PRIMARY KEY (decklist_id, name, section)
);
CREATE INDEX IF NOT EXISTS idx_dlc_name ON decklist_cards(name);
CREATE TABLE IF NOT EXISTS decklist_fetch (
  id TEXT PRIMARY KEY, fetched_at TEXT DEFAULT (datetime('now')), cards INTEGER, source TEXT, error TEXT, raw TEXT
);
`);

// ---------- Extraer cartas de un JSON cualquiera ----------
const QTY = ['Quantity', 'quantity', 'Qty', 'qty', 'q', 'Count', 'count', 'Copies', 'copies', 'Amount', 'amount', 'Number'];
const NAME = ['Name', 'name', 'CardName', 'cardName', 'card_name', 'n', 'Title', 'title', 'DisplayName', 'displayName'];
const SEC = ['Category', 'category', 'Section', 'section', 'Component', 'component', 'Board', 'board', 'Zone', 'zone', 'Group', 'group', 'Type', 'type', 't'];
const BOARD_KEY = /^(main|mainboard|maindeck|deck|side|sideboard|leaders?|bases?|legends?|commanders?|companions?|gigs?|champions?|battlefields?|runes?|records|cards|components)$/i;

function qtyOf(o) {
  for (const k of QTY) {
    const v = o[k];
    if (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 1 && Number(v) <= 99) return Math.round(Number(v));
  }
  return null;
}
function nameOf(o, depth = 0) {
  for (const k of NAME) if (typeof o[k] === 'string' && o[k].trim() && !/^[0-9a-f-]{20,}$/i.test(o[k])) return o[k].trim();
  if (depth < 2) for (const k of ['Card', 'card', 'CardDefinition', 'Definition']) if (o[k] && typeof o[k] === 'object') { const n = nameOf(o[k], depth + 1); if (n) return n; }
  return null;
}
function secOf(o) {
  for (const k of SEC) if (o[k] != null && typeof o[k] !== 'object' && String(o[k]).trim()) return String(o[k]).trim();
  return null;
}
function parseText(txt, section) {
  const out = [];
  let sec = section || '';
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d{1,2})\s*x?\s+(.+?)\s*$/i);
    if (m) out.push({ name: m[2].replace(/\s+\([A-Z0-9]{2,6}\)\s*[\w-]*$/, ''), qty: Number(m[1]), section: sec });
    else if (line.length < 40 && !/\d/.test(line)) sec = line.replace(/[:\s]+$/, '');
  }
  return out;
}
// Formato de Melee: Records [{ l: id, n: nombre, s: subtítulo, q: copias, c: categoría (0 mazo, 9 leyendas, 99 sideboard…), t: "Deck" }]
const MELEE_CAT = { 0: 'Main', 9: 'Legends', 99: 'Sideboard' };
const isMeleeRecord = o => o && typeof o === 'object' && 'n' in o && 'q' in o && ('c' in o || 'l' in o);
function meleeRecord(o) {
  const name = o.s ? `${String(o.n).trim()}: ${String(o.s).trim()}` : String(o.n || '').trim();
  const sec = o.c != null && o.c !== '' ? (MELEE_CAT[o.c] || `Categoría ${o.c}`) : '';
  return { name, qty: Number(o.q) || 0, section: sec };
}

function extractCards(root) {
  const out = [];
  const walk = (node, section, depth) => {
    if (depth > 8 || node == null) return;
    if (Array.isArray(node) && node.length && node.filter(isMeleeRecord).length >= node.length * 0.6) {
      for (const o of node.filter(isMeleeRecord)) { const r = meleeRecord(o); if (r.name && r.qty > 0) out.push(r); }
      return;
    }
    if (Array.isArray(node)) {
      const objs = node.filter(x => x && typeof x === 'object' && !Array.isArray(x));
      const cards = objs.filter(o => qtyOf(o) && nameOf(o));
      if (cards.length && cards.length >= objs.length * 0.6) {
        for (const o of cards) out.push({ name: nameOf(o), qty: qtyOf(o), section: secOf(o) || section || '' });
        return;
      }
      for (const x of node) walk(x, section, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        const sec = BOARD_KEY.test(k) && !/^(records|cards|components)$/i.test(k) ? k : section;
        if (v && typeof v === 'object') walk(v, sec, depth + 1);
        else if (typeof v === 'string' && v.length > 20 && v.includes('\n') && /(deck|list|text|cards|export)/i.test(k)) {
          const parsed = parseText(v, sec);
          if (parsed.length >= 3) out.push(...parsed);
        } else if (typeof v === 'string' && v.length > 20 && /^[\[{]/.test(v.trim())) {
          try { walk(JSON.parse(v), sec, depth + 1); } catch { /* no es JSON */ }
        }
      }
    }
  };
  walk(root, '', 0);
  // Une repetidas (misma carta y sección)
  const m = new Map();
  for (const c of out) {
    const k = c.name.toLowerCase() + '|' + c.section;
    const cur = m.get(k);
    if (cur) cur.qty += c.qty; else m.set(k, { ...c });
  }
  return [...m.values()];
}

function saveCards(id, cards, source, raw, error = null) {
  db.transaction(() => {
    db.prepare('DELETE FROM decklist_cards WHERE decklist_id = ?').run(id);
    const ins = db.prepare('INSERT OR REPLACE INTO decklist_cards (decklist_id, name, section, qty) VALUES (?, ?, ?, ?)');
    for (const c of cards) ins.run(id, c.name.slice(0, 120), String(c.section || '').slice(0, 40), c.qty);
    db.prepare(`INSERT OR REPLACE INTO decklist_fetch (id, fetched_at, cards, source, error, raw) VALUES (?, datetime('now'), ?, ?, ?, ?)`)
      .run(id, cards.length, source, error, raw ? String(raw).slice(0, 40000) : null);
  })();
}

// Lee las cartas de las decklists que aún no las tienen (como mucho «limit» peticiones a Melee)
// Las peticiones se hacen en cola: nunca dos lecturas a la vez
let busy = false;
let queue = Promise.resolve();
function ensureCards(opts = {}) {
  const run = queue.then(() => readCards(opts));
  queue = run.catch(() => {});
  return run;
}
async function readCards({ tournamentId = null, limit = 60 } = {}) {
  busy = true;
  let fetched = 0, found = 0;
  try {
    const rows = db.prepare(`SELECT d.* FROM decklists d LEFT JOIN decklist_fetch f ON f.id = d.id
      WHERE ${tournamentId ? 'd.tournament_id = ? AND' : ''} (f.id IS NULL OR (f.cards = 0 AND f.fetched_at < datetime('now', '-1 day')))
      ORDER BY d.tournament_id DESC`).all(...(tournamentId ? [tournamentId] : []));
    for (const d of rows) {
      let fromList = [];
      try { fromList = extractCards(JSON.parse(d.raw || '{}')); } catch { fromList = []; }
      if (fromList.length >= 3) { saveCards(d.id, fromList, 'lista', null); found++; continue; }
      if (fetched >= limit || String(d.id).startsWith('0.')) continue;
      fetched++;
      try {
        const det = await melee.api.decklist(d.id);
        const cards = extractCards(det);
        saveCards(d.id, cards, 'detalle', JSON.stringify(det));
        if (cards.length) found++;
      } catch (e) {
        saveCards(d.id, [], 'detalle', null, e.message);
        if (e.fatal) break;
      }
      await new Promise(r => setTimeout(r, 250));
    }
  } finally { busy = false; }
  if (found) log('info', `Cartas leídas de ${found} decklist(s)`);
  return { fetched, found };
}

function status() {
  const total = db.prepare('SELECT COUNT(*) c FROM decklists').get().c;
  const withCards = db.prepare('SELECT COUNT(*) c FROM decklist_fetch WHERE cards > 0').get().c;
  const tried = db.prepare('SELECT COUNT(*) c FROM decklist_fetch').get().c;
  const lastError = (db.prepare('SELECT error FROM decklist_fetch WHERE error IS NOT NULL ORDER BY fetched_at DESC LIMIT 1').get() || {}).error || null;
  return { total, withCards, tried, lastError, busy };
}

// ---------- Meta por cartas ----------
// Tipo de sección según el nombre que use Melee (Legends, Main, Sideboard, Leader, Base…)
const KINDS = [
  ['legend', 'Leyendas', /legend|leyenda/],
  ['leader', 'Líderes', /leader|lider/],
  ['base', 'Bases', /^bases?$|\bbase\b/],
  ['commander', 'Comandantes', /command/],
  ['main', 'Cartas', /.*/],
  ['side', 'Sideboard', /side|banquillo|reserva/],
  ['other', 'Otras', /^categoria /],
];
function sectionKind(sec) {
  const s = String(sec || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/side|banquillo|reserva/.test(s)) return 'side';
  if (/^categoria /.test(s)) return 'other';
  for (const [k, , re] of KINDS) if (k !== 'main' && k !== 'side' && re.test(s)) return k;
  return 'main';
}
const kindLabel = k => (KINDS.find(x => x[0] === k) || [k, k])[1];

const deckKey = name => String(name || '').replace(/\s+/g, ' ').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// opts.deck: limitar a una baraja (nombre del mazo) para ver el win rate de cada carta dentro de ella
function cardMeta(game, from, to, opts = {}) {
  let decks = db.prepare(`SELECT d.id, d.tournament_id, d.team_id, d.name, s.rank
    FROM decklists d JOIN tournaments t ON t.id = d.tournament_id
    JOIN decklist_fetch f ON f.id = d.id AND f.cards > 0
    LEFT JOIN standings s ON s.tournament_id = d.tournament_id AND s.team_id = d.team_id
    WHERE t.game = ? AND date(COALESCE(t.start_date, t.last_pair)) BETWEEN date(?) AND date(?)`).all(game, from, to);
  if (opts.deck) decks = decks.filter(d => deckKey(d.name) === deckKey(opts.deck));
  const recCache = new Map();
  const rec = d => {
    if (!recCache.has(d.tournament_id)) recCache.set(d.tournament_id, data.records(d.tournament_id));
    const r = recCache.get(d.tournament_id).get(d.team_id) || { w: 0, l: 0, d: 0, form: [] };
    const byes = (r.form || []).filter(f => f.res === 'B').length; // los byes no cuentan para el win rate
    return { w: r.w - byes, l: r.l, d: r.d };
  };
  const cardsQ = db.prepare('SELECT name, section, qty FROM decklist_cards WHERE decklist_id = ?');
  const cards = new Map();
  const top4Total = decks.filter(d => d.rank && d.rank <= 4).length;
  const all = { w: 0, l: 0, d: 0 };
  for (const d of decks) {
    const r = rec(d);
    all.w += r.w; all.l += r.l; all.d += r.d;
    const seen = new Set();
    for (const c of cardsQ.all(d.id)) {
      const ci = cardimg.info(game, c.name);
      if (!ci) cardimg.queueResolve(game, c.name);
      let kind = sectionKind(c.section);
      // Si Melee no dice la sección, el tipo de la carta indica si es una Leyenda
      if (kind === 'main' && ci && /legend/i.test(ci.type || '')) kind = 'legend';
      const k = kind + '|' + (ci ? ci.slug : c.name.toLowerCase());
      const x = cards.get(k) || { name: ci ? ci.name : c.name, type: ci ? ci.type : null, color: ci ? ci.color : null, kind, decks: 0, copies: 0, top4: 0, wins: 0, w: 0, l: 0, dr: 0, rankSum: 0, ranked: 0, players: new Set() };
      x.copies += c.qty;
      if (!seen.has(k)) {
        seen.add(k);
        x.decks++;
        if (d.rank && d.rank <= 4) x.top4++;
        if (d.rank === 1) x.wins++;
        if (d.rank) { x.rankSum += d.rank; x.ranked++; }
        x.w += r.w; x.l += r.l; x.dr += r.d;
        x.players.add(d.team_id);
      }
      cards.set(k, x);
    }
  }
  const n = decks.length;
  const rows = [...cards.values()].map(x => ({
    name: x.name, type: x.type, color: x.color, kind: x.kind, decks: x.decks, pct: n ? Math.round(x.decks * 100 / n) : 0,
    avg: Math.round(x.copies * 10 / x.decks) / 10, top4: x.top4, top4pct: top4Total ? Math.round(x.top4 * 100 / top4Total) : 0, wins: x.wins,
    winrate: x.w + x.l + x.dr ? Math.round(x.w * 100 / (x.w + x.l + x.dr)) : null, games: x.w + x.l + x.dr,
    avgRank: x.ranked ? Math.round(x.rankSum * 10 / x.ranked) / 10 : null,
    w: x.w, l: x.l, d: x.dr,
    // Mazos (de la selección) que NO llevan la carta
    wo: (() => { const w = all.w - x.w, l = all.l - x.l, d = all.d - x.dr, g = w + l + d; return { w, l, d, games: g, decks: decks.length - x.decks, winrate: g ? Math.round(w * 100 / g) : null }; })(),
  })).sort((a, b) => b.decks - a.decks || b.top4 - a.top4 || a.name.localeCompare(b.name));
  const order = ['legend', 'leader', 'base', 'commander', 'main', 'side', 'other'];
  const groups = order.map(k => ({ kind: k, label: kindLabel(k), rows: rows.filter(r => r.kind === k) })).filter(g => g.rows.length);
  // Win rate: solo cartas con muestra suficiente (al menos 2 mazos y 8 partidas sin contar byes), de mayor a menor
  const allGames = all.w + all.l + all.d;
  const minGames = opts.deck ? 6 : 8;
  const wrRank = list => list.filter(r => r.decks >= 2 && r.games >= minGames)
    .sort((a, b) => b.winrate - a.winrate || b.games - a.games || a.name.localeCompare(b.name));
  const wrGroups = groups.map(g => ({ ...g, rows: wrRank(g.rows) })).filter(g => g.rows.length);
  return { decks: n, top4Decks: top4Total, groups, rows, wrGroups, minGames, baseWinrate: allGames ? Math.round(all.w * 100 / allGames) : null, games: allGames };
}

// Win rate por baraja (el nombre del mazo en Melee, que suele ser la combinación de leyendas o líder/base)
function deckWinrate(game, from, to) {
  const decks = db.prepare(`SELECT d.tournament_id, d.team_id, d.name, s.rank
    FROM decklists d JOIN tournaments t ON t.id = d.tournament_id
    LEFT JOIN standings s ON s.tournament_id = d.tournament_id AND s.team_id = d.team_id
    WHERE t.game = ? AND date(COALESCE(t.start_date, t.last_pair)) BETWEEN date(?) AND date(?)`).all(game, from, to);
  const recs = new Map();
  const by = new Map();
  const all = { w: 0, l: 0, d: 0 };
  for (const d of decks) {
    const name = String(d.name || '').replace(/\s+/g, ' ').trim();
    if (!name) continue;
    if (!recs.has(d.tournament_id)) recs.set(d.tournament_id, data.records(d.tournament_id));
    const r = recs.get(d.tournament_id).get(d.team_id) || { w: 0, l: 0, d: 0, form: [] };
    const byes = (r.form || []).filter(f => f.res === 'B').length;
    const w = r.w - byes;
    all.w += w; all.l += r.l; all.d += r.d;
    const key = deckKey(name);
    const x = by.get(key) || { names: new Map(), decks: 0, events: new Set(), w: 0, l: 0, d: 0, top4: 0, champs: 0 };
    x.names.set(name, (x.names.get(name) || 0) + 1);
    x.decks++; x.events.add(d.tournament_id); x.w += w; x.l += r.l; x.d += r.d;
    if (d.rank && d.rank <= 4) x.top4++;
    if (d.rank === 1) x.champs++;
    by.set(key, x);
  }
  const n = [...by.values()].reduce((s, x) => s + x.decks, 0);
  const minGames = 8;
  const rows = [...by.values()].map(x => {
    const games = x.w + x.l + x.d;
    return { name: [...x.names.entries()].sort((a, b) => b[1] - a[1])[0][0], decks: x.decks, events: x.events.size, pct: n ? Math.round(x.decks * 100 / n) : 0,
      w: x.w, l: x.l, d: x.d, games, winrate: games ? Math.round(x.w * 100 / games) : null, top4: x.top4, champs: x.champs };
  });
  const ranked = rows.filter(r => r.decks >= 2 && r.games >= minGames).sort((a, b) => b.winrate - a.winrate || b.games - a.games || a.name.localeCompare(b.name));
  const few = rows.filter(r => !(r.decks >= 2 && r.games >= minGames)).sort((a, b) => b.decks - a.decks || a.name.localeCompare(b.name));
  const allGames = all.w + all.l + all.d;
  return { decks: n, rows: ranked, few, minGames, baseWinrate: allGames ? Math.round(all.w * 100 / allGames) : null, games: allGames };
}

// Juegos con decklists leídas (para el meta público)
function gamesWithCards() {
  return db.prepare(`SELECT t.game, COUNT(DISTINCT d.id) n FROM decklists d JOIN tournaments t ON t.id = d.tournament_id
    JOIN decklist_fetch f ON f.id = d.id AND f.cards > 0 GROUP BY t.game ORDER BY n DESC`).all();
}

function start() {
  // v2: se vuelven a leer las cartas con el formato real de Melee (nombre + subtítulo y categoría)
  if (require('./db').setting('decks_extract_v') !== '2') {
    db.prepare("DELETE FROM decklist_cards WHERE decklist_id IN (SELECT id FROM decklist_fetch WHERE source = 'lista')").run();
    db.prepare("DELETE FROM decklist_fetch WHERE source = 'lista'").run();
    require('./db').setSetting('decks_extract_v', '2');
    ensureCards({ limit: 0 }).catch(() => {});
  }
  const tick = () => ensureCards({ limit: 60 }).catch(e => log('warn', 'Cartas de decklists: ' + e.message));
  setTimeout(tick, 120e3);
  setInterval(tick, 30 * 60e3);
}

module.exports = { extractCards, parseText, ensureCards, status, cardMeta, deckWinrate, deckKey, gamesWithCards, sectionKind, start };
