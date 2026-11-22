'use strict';
// Datos, imágenes y enlaces de cartas para el meta.
// Cyberpunk TCG: la base de cartas de la web oficial la sirve Netdeck (api.netdeck.gg). Se descarga entera
// (son pocas cartas) para saber el tipo de cada una (Legend, Unit, Gear, Program) y las imágenes se guardan
// en data/cardimg la primera vez que se piden (los enlaces originales caducan).
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { db, log, setting, setSetting } = require('./db');

const NETDECK = (process.env.NETDECK_URL || 'https://api.netdeck.gg').replace(/\/$/, '');
const DIR = path.join(config.dataDir, 'cardimg');
// Cabeceras como las de la web oficial (la API las espera de un navegador en cyberpunktcg.com)
const UA = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json', Origin: 'https://cyberpunktcg.com', Referer: 'https://cyberpunktcg.com/',
};
let lastError = null;

db.exec(`CREATE TABLE IF NOT EXISTS game_cards (
  game TEXT NOT NULL, key TEXT NOT NULL, name TEXT, slug TEXT, type TEXT, color TEXT, PRIMARY KEY (game, key)
)`);

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[—–]/g, '-').replace(/[^a-z0-9]+/g, ' ').trim();
const slug = name => norm(name).replace(/ /g, '-');

let cache = null;
function index() {
  if (!cache) {
    cache = new Map();
    for (const r of db.prepare('SELECT * FROM game_cards').all()) cache.set(r.game + '|' + r.key, r);
  }
  return cache;
}
// Datos de una carta por su nombre tal como viene en la decklist
function info(game, name) {
  if (game !== 'CyberpunkTCG') return null;
  return index().get(game + '|' + norm(name)) || null;
}

async function refreshCyberpunk(opts) {
  try { await doRefresh(opts); lastError = null; clearMisses(); } catch (e) { lastError = e.message; throw e; }
}
async function doRefresh({ force = false } = {}) {
  const last = setting('cards_cyberpunk_at');
  if (!force && last && Date.now() - new Date(last).getTime() < 7 * 864e5 && db.prepare("SELECT COUNT(*) c FROM game_cards WHERE game = 'CyberpunkTCG'").get().c) return;
  const items = [];
  for (let offset = 0, total = 1; offset < total && offset < 5000; offset += 100) {
    const r = await fetch(`${NETDECK}/api/cards/cyberpunk?limit=100&offset=${offset}`, { headers: UA });
    if (!r.ok) throw new Error(`Netdeck HTTP ${r.status}`);
    const j = await r.json();
    total = Number(j.total) || 0;
    items.push(...(j.items || []));
    if (!(j.items || []).length) break;
  }
  if (!items.length) throw new Error('Netdeck no devolvió cartas');
  db.transaction(() => {
    db.prepare("DELETE FROM game_cards WHERE game = 'CyberpunkTCG'").run();
    const ins = db.prepare("INSERT OR REPLACE INTO game_cards (game, key, name, slug, type, color) VALUES ('CyberpunkTCG', ?, ?, ?, ?, ?)");
    // Nombres con los que puede venir en una decklist: «V: Streetkid», «V — Streetkid», «V - Streetkid»
    const byBase = new Map();
    for (const c of items) { const b = norm(c.name); byBase.set(b, (byBase.get(b) || 0) + 1); }
    for (const c of items) {
      const keys = new Set([c.display_name, c.canonical_name, c.subname ? `${c.name} ${c.subname}` : c.name].map(norm).filter(Boolean));
      if (byBase.get(norm(c.name)) === 1) keys.add(norm(c.name));
      for (const k of keys) ins.run(k, c.display_name || c.name, c.slug, c.card_type || null, c.color || null);
    }
  })();
  cache = null;
  setSetting('cards_cyberpunk_at', new Date().toISOString());
  log('info', `Cartas de Cyberpunk TCG: ${items.length}`);
}

// Busca una carta que no está en la base por su nombre (p. ej. «Meredith Stout» → «Meredith Stout: Stone Cold Corpo»)
const tried = new Map();
async function resolveName(game, name) {
  if (game !== 'CyberpunkTCG') return null;
  const hit = info(game, name);
  if (hit) return hit;
  const k = norm(name);
  if (!k || (tried.has(k) && Date.now() - tried.get(k) < 3600e3)) return null;
  tried.set(k, Date.now());
  try {
    const r = await fetch(`${NETDECK}/api/cards/cyberpunk?limit=20&q=${encodeURIComponent(name)}`, { headers: UA });
    if (!r.ok) throw new Error(`Netdeck HTTP ${r.status}`);
    const items = (await r.json()).items || [];
    const pick = items.find(c => [c.display_name, c.canonical_name].map(norm).includes(k))
      || (items.filter(c => norm(c.name) === k).length === 1 ? items.find(c => norm(c.name) === k) : null)
      || (items.length === 1 ? items[0] : null);
    if (!pick) return null;
    db.prepare("INSERT OR REPLACE INTO game_cards (game, key, name, slug, type, color) VALUES ('CyberpunkTCG', ?, ?, ?, ?, ?)")
      .run(k, pick.display_name || pick.name, pick.slug, pick.card_type || null, pick.color || null);
    cache = null;
    return info(game, name);
  } catch (e) { lastError = e.message; return null; }
}
// Se buscan en segundo plano los nombres que no se reconocen (salen bien en la siguiente visita)
const queue = [];
let qBusy = false;
function queueResolve(game, name) {
  if (game !== 'CyberpunkTCG' || info(game, name) || queue.some(q => q[1] === name)) return;
  const k = norm(name);
  if (tried.has(k) && Date.now() - tried.get(k) < 3600e3) return;
  queue.push([game, name]);
  if (qBusy) return;
  qBusy = true;
  (async () => {
    while (queue.length) { const [g, n] = queue.shift(); await resolveName(g, n); await new Promise(r => setTimeout(r, 200)); }
    qBusy = false;
  })();
}
function clearMisses() {
  const dir = path.join(DIR, 'cyberpunk');
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.none')) fs.unlinkSync(path.join(dir, f)); } catch { /* sin carpeta */ }
  tried.clear();
}
function status() {
  return { count: db.prepare("SELECT COUNT(DISTINCT slug) c FROM game_cards WHERE game = 'CyberpunkTCG'").get().c, updatedAt: setting('cards_cyberpunk_at') || null, lastError };
}

// Enlace público de la carta (solo juegos con web de cartas)
function cardUrl(game, name) {
  if (game !== 'CyberpunkTCG') return null;
  const i = info(game, name);
  return `https://cyberpunktcg.com/cards/${i ? i.slug : slug(name)}`;
}
const hasImages = game => game === 'CyberpunkTCG';

const pending = new Map();
let active = 0;
const waiters = [];
const slot = () => new Promise(r => { if (active < 3) { active++; r(); } else waiters.push(r); });
const free = () => { const n = waiters.shift(); if (n) n(); else active--; };

async function download(s) {
  await slot();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const img = await fetch(`${NETDECK}/api/cards/cyberpunk/${encodeURIComponent(s)}/image`, { headers: { 'User-Agent': UA['User-Agent'], Referer: UA.Referer, Accept: 'image/*' }, signal: ctrl.signal });
    clearTimeout(t);
    if (!img.ok) throw new Error(`HTTP ${img.status}`);
    const type = img.headers.get('content-type') || '';
    if (!/^image\//.test(type)) throw new Error('no es una imagen');
    const ext = /png/.test(type) ? 'png' : /jpe?g/.test(type) ? 'jpg' : 'webp';
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length > 4e6) throw new Error('imagen demasiado grande');
    return { buf, ext };
  } finally { free(); }
}

// Devuelve la ruta del fichero en disco o null si no hay imagen
async function getImage(game, name) {
  if (!hasImages(game)) return null;
  const i = info(game, name) || await resolveName(game, name);
  const s = i ? i.slug : slug(name);
  if (!s) return null;
  const dir = path.join(DIR, 'cyberpunk');
  fs.mkdirSync(dir, { recursive: true });
  for (const ext of ['webp', 'png', 'jpg']) { const f = path.join(dir, `${s}.${ext}`); if (fs.existsSync(f)) return f; }
  const miss = path.join(dir, `${s}.none`);
  if (fs.existsSync(miss) && Date.now() - fs.statSync(miss).mtimeMs < 864e5) return null;
  if (!pending.has(s)) {
    pending.set(s, download(s).then(({ buf, ext }) => {
      const f = path.join(dir, `${s}.${ext}`);
      fs.writeFileSync(f, buf);
      return f;
    }).catch(e => { fs.writeFileSync(miss, e.message); log('warn', `Imagen de carta ${s}: ${e.message}`); return null; })
      .finally(() => pending.delete(s)));
  }
  return pending.get(s);
}

function start() {
  const tick = () => refreshCyberpunk().catch(e => log('warn', 'Cartas de Cyberpunk TCG: ' + e.message));
  setTimeout(tick, 20e3);
  setInterval(tick, 24 * 3600e3);
}

module.exports = { slug, norm, info, cardUrl, hasImages, getImage, refreshCyberpunk, resolveName, queueResolve, status, start };
