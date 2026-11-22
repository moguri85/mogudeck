'use strict';
// Nombres de cartas de Magic en todos los idiomas → nombre en inglés.
// Se descarga una vez a la semana el fichero «All Cards» de Scryfall (todas las impresiones en todos los idiomas, ~2 GB
// sin comprimir, se lee en streaming sin guardarlo) y se guarda solo la tabla de traducción.
const zlib = require('zlib');
const readline = require('readline');
const { Readable } = require('stream');
const { db, setting, setSetting, log } = require('./db');

const API = (process.env.SCRYFALL_URL || 'https://api.scryfall.com').replace(/\/$/, '');
const UA = { 'User-Agent': 'JupiterTorneos/1.0', Accept: 'application/json' };

db.exec('CREATE TABLE IF NOT EXISTS card_names (key TEXT PRIMARY KEY, name TEXT NOT NULL, lang TEXT)');

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[’`´]/g, "'").replace(/\s+/g, ' ').trim();

const get = db.prepare('SELECT name FROM card_names WHERE key = ?');
function lookup(name) {
  const k = norm(name);
  if (!k) return null;
  const r = get.get(k) || (k.includes('/') ? get.get(norm(k.split(/\s*\/\/?\s*/)[0])) : null);
  return r ? r.name : null;
}
const count = () => db.prepare('SELECT COUNT(*) c FROM card_names').get().c;

let running = false, lastError = null;
async function refresh({ force = false } = {}) {
  if (running) return;
  const last = setting('card_names_at');
  if (!force && last && Date.now() - new Date(last).getTime() < 7 * 864e5 && count()) return;
  running = true;
  try {
    const list = await fetch(`${API}/bulk-data`, { headers: UA }).then(r => { if (!r.ok) throw new Error(`Scryfall ${r.status}`); return r.json(); });
    const entry = (list.data || []).find(d => d.type === 'all_cards');
    if (!entry) throw new Error('Scryfall no ofrece el fichero all_cards');
    const uri = entry.jsonl_download_uri || entry.download_uri;
    const res = await fetch(uri, { headers: { 'User-Agent': UA['User-Agent'] } });
    if (!res.ok) throw new Error(`Descarga de nombres: HTTP ${res.status}`);
    let stream = Readable.fromWeb(res.body);
    if (/\.gz($|\?)/.test(uri)) stream = stream.pipe(zlib.createGunzip());
    const map = new Map();
    const add = (printed, name, lang) => {
      const k = norm(printed);
      if (!k || k === norm(name) || map.has(k)) return;
      map.set(k, [name, lang]);
    };
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (let line of rl) {
      line = line.trim();
      if (!line.startsWith('{')) continue;
      if (line.endsWith(',')) line = line.slice(0, -1);
      // Atajo: las impresiones en inglés no aportan nada
      if (line.includes('"lang":"en"')) continue;
      let c;
      try { c = JSON.parse(line); } catch { continue; }
      if (!c.lang || c.lang === 'en' || !c.name) continue;
      if (c.printed_name) add(c.printed_name, c.name, c.lang);
      for (const f of c.card_faces || []) if (f.printed_name) add(f.printed_name, c.name, c.lang);
    }
    if (map.size < 1000 && !process.env.SCRYFALL_URL) throw new Error(`Fichero de nombres incompleto (${map.size})`);
    db.transaction(() => {
      db.exec('DROP TABLE IF EXISTS card_names_new');
      db.exec('CREATE TABLE card_names_new (key TEXT PRIMARY KEY, name TEXT NOT NULL, lang TEXT)');
      const ins = db.prepare('INSERT OR IGNORE INTO card_names_new VALUES (?, ?, ?)');
      for (const [k, [n, l]] of map) ins.run(k, n, l);
      db.exec('DROP TABLE card_names');
      db.exec('ALTER TABLE card_names_new RENAME TO card_names');
    })();
    setSetting('card_names_at', new Date().toISOString());
    lastError = null;
    log('info', `Nombres de cartas en otros idiomas: ${map.size}`);
  } catch (e) {
    lastError = e.message;
    log('warn', 'Nombres de cartas en otros idiomas: ' + e.message);
  } finally { running = false; }
}

function status() { return { count: count(), updatedAt: setting('card_names_at') || null, running, lastError }; }

function start() {
  const tick = () => refresh().catch(() => {});
  setTimeout(tick, 10 * 60e3); // después de la base de precios
  setInterval(tick, 12 * 3600e3);
}

module.exports = { lookup, refresh, status, start, norm };
