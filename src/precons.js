'use strict';
// Mazos preconstruidos de Commander (lista de MTGJSON, actualizada a diario).
// La lista de cartas de cada mazo se descarga la primera vez que alguien lo elige y se guarda.
const { db, log, setting, setSetting } = require('./db');

const API = (process.env.MTGJSON_URL || 'https://mtgjson.com/api/v5').replace(/\/$/, '');
const UA = { 'User-Agent': 'JupiterTorneos/1.0', Accept: 'application/json' };

db.exec(`
CREATE TABLE IF NOT EXISTS precons (file TEXT PRIMARY KEY, name TEXT, code TEXT, release TEXT, type TEXT);
CREATE TABLE IF NOT EXISTS precon_lists (file TEXT PRIMARY KEY, text TEXT, commander TEXT, cards INTEGER, fetched_at TEXT DEFAULT (datetime('now')));
`);
require('./db').addColumn('precon_lists', 'colors', 'TEXT');

let lastError = null;
async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!r.ok) throw new Error(`MTGJSON HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function refresh({ force = false } = {}) {
  const last = setting('precons_at');
  if (!force && last && Date.now() - new Date(last).getTime() < 20 * 3600e3 && count()) return;
  try {
    const j = await get(`${API}/DeckList.json`);
    const list = (j.data || []).filter(d => /commander/i.test(d.type || '') && d.fileName);
    if (!list.length) throw new Error('MTGJSON no devolvió mazos de Commander');
    db.transaction(() => {
      db.prepare('DELETE FROM precons').run();
      const ins = db.prepare('INSERT OR REPLACE INTO precons (file, name, code, release, type) VALUES (?, ?, ?, ?, ?)');
      for (const d of list) ins.run(d.fileName, d.name, d.code || null, d.releaseDate || null, d.type || null);
    })();
    setSetting('precons_at', new Date().toISOString());
    lastError = null;
    log('info', `Mazos preconstruidos de Commander: ${list.length}`);
  } catch (e) { lastError = e.message; throw e; }
}

const count = () => db.prepare('SELECT COUNT(*) c FROM precons').get().c;
function list() {
  return db.prepare(`SELECT p.file, p.name, p.code, p.release, p.type, l.commander, l.colors, l.cards FROM precons p
    LEFT JOIN precon_lists l ON l.file = p.file ORDER BY COALESCE(p.release, '') DESC, p.name`).all();
}
function status() { return { count: count(), updatedAt: setting('precons_at') || null, lastError }; }

// Texto de la lista en el formato de «Valor de mazo»: sección Commander y sección Deck

async function text(file) {
  const cached = db.prepare('SELECT * FROM precon_lists WHERE file = ?').get(file);
  if (cached) return cached;
  const p = db.prepare('SELECT * FROM precons WHERE file = ?').get(file);
  if (!p) throw new Error('Mazo no encontrado');
  const j = await get(`${API}/decks/${encodeURIComponent(file)}.json`);
  const d = j.data || {};
  const cmd = d.commander || [];
  const main = d.mainBoard || [];
  // Algunos mazos antiguos traen el comandante dentro del mazo y marcado aparte (displayCommander)
  const shown = (d.displayCommander || []).filter(c => !cmd.some(x => x.name === c.name));
  const merge = arr => {
    const m = new Map();
    for (const c of arr) m.set(c.name, (m.get(c.name) || 0) + (c.count || 1));
    return [...m].map(([name, n]) => `${n} ${name}`);
  };
  const cmdLines = merge([...cmd, ...shown]);
  const mainLines = merge(main.filter(c => !shown.some(x => x.name === c.name)));
  const body = [`// ${p.name}${p.code ? ` (${p.code})` : ''}`, 'Commander', ...cmdLines, '', 'Deck', ...mainLines].join('\n');
  const cards = [...cmd, ...main].reduce((s, c) => s + (c.count || 1), 0);
  const heads = cmd.length ? cmd : shown;
  const colors = 'WUBRG'.split('').filter(k => heads.some(c => (c.colorIdentity || c.colors || []).includes(k))).join('');
  db.prepare("INSERT OR REPLACE INTO precon_lists (file, text, commander, cards, colors, fetched_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
    .run(file, body, heads.map(c => c.name).join(' + ') || null, cards, colors || 'C');
  return db.prepare('SELECT * FROM precon_lists WHERE file = ?').get(file);
}

// En segundo plano se descargan, poco a poco, las listas que faltan (así se sabe el comandante y los colores de cada mazo)
let filling = false;
async function fill() {
  if (filling) return;
  filling = true;
  try {
    const todo = db.prepare(`SELECT p.file FROM precons p LEFT JOIN precon_lists l ON l.file = p.file
      WHERE l.file IS NULL OR l.colors IS NULL ORDER BY COALESCE(p.release, '') DESC`).all();
    for (const { file } of todo) {
      try { await text(file); } catch (e) { lastError = `${file}: ${e.message}`; }
      await new Promise(r => setTimeout(r, 1500));
    }
  } finally { filling = false; }
}

function start() {
  const tick = () => refresh().then(fill).catch(e => log('warn', 'Mazos preconstruidos: ' + e.message));
  setTimeout(tick, 45e3);
  setInterval(tick, 24 * 3600e3);
}

module.exports = { refresh, list, text, status, start };
