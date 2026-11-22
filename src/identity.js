'use strict';
// Vínculos entre fichas de jugadores (reversibles) y parecido entre nombres.
// Una «clave» identifica una ficha: «u:usuario_melee» o «n:nombre». Un vínculo hace que una clave apunte a otra (la principal).
const { db } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS person_alias (
  src TEXT PRIMARY KEY, dst TEXT NOT NULL, kind TEXT, reason TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS person_notsame (
  a TEXT NOT NULL, b TEXT NOT NULL, created_by TEXT, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS person_info (
  key TEXT PRIMARY KEY, nick TEXT, aliases TEXT, notes TEXT
);
`);

let aliasCache = null, notCache = null;
function invalidate() { aliasCache = null; notCache = null; }
function aliases() {
  if (!aliasCache) aliasCache = new Map(db.prepare('SELECT src, dst FROM person_alias').all().map(r => [r.src, r.dst]));
  return aliasCache;
}
function notSameSet() {
  if (!notCache) notCache = new Set(db.prepare('SELECT a, b FROM person_notsame').all().map(r => `${r.a}|${r.b}`));
  return notCache;
}

// Clave principal (sigue la cadena de vínculos)
function resolve(key) {
  if (!key) return key;
  const m = aliases();
  let k = key;
  for (let i = 0; i < 20 && m.has(k); i++) k = m.get(k);
  return k;
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
function isNotSame(a, b) {
  const s = notSameSet();
  return s.has(pairKey(a, b)) || s.has(pairKey(resolve(a), resolve(b)));
}

// Une la ficha «from» dentro de «to» (la que se conserva como principal)
function link(from, to, { by = null, kind = 'manual', reason = null } = {}) {
  const a = resolve(from), b = resolve(to);
  if (!a || !b || a === b) return false;
  db.prepare('INSERT OR REPLACE INTO person_alias (src, dst, kind, reason, created_by) VALUES (?, ?, ?, ?, ?)').run(a, b, kind, reason, by);
  const [x, y] = a < b ? [a, b] : [b, a];
  db.prepare('DELETE FROM person_notsame WHERE a = ? AND b = ?').run(x, y);
  invalidate();
  return true;
}

// Deshace un vínculo: la clave vuelve a ser una ficha propia (con lo que tuviera unido a ella)
function unlink(src) {
  const r = db.prepare('DELETE FROM person_alias WHERE src = ?').run(src);
  invalidate();
  return r.changes > 0;
}

function markNotSame(a, b, by = null) {
  const [x, y] = a < b ? [a, b] : [b, a];
  db.prepare('INSERT OR IGNORE INTO person_notsame (a, b, created_by) VALUES (?, ?, ?)').run(x, y, by);
  invalidate();
}

function forgetNotSame(a, b) {
  db.prepare('DELETE FROM person_notsame WHERE a = ? AND b = ?').run(a, b);
  invalidate();
}

function links() {
  return db.prepare('SELECT * FROM person_alias ORDER BY created_at DESC').all();
}

function info(key) {
  return db.prepare('SELECT * FROM person_info WHERE key = ?').get(key) || null;
}
function saveInfo(key, { nick, aliases: al, notes }) {
  db.prepare('INSERT OR REPLACE INTO person_info (key, nick, aliases, notes) VALUES (?, ?, ?, ?)')
    .run(key, (nick || '').trim() || null, (al || '').trim() || null, (notes || '').trim() || null);
}

// ---------- Parecido entre nombres ----------
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

// Puntuación 0..1 y motivo entre dos textos ya normalizados
function score(x, y) {
  if (!x || !y) return null;
  if (x === y) return { s: 1, why: 'mismo nombre' };
  const tx = x.split(' '), ty = y.split(' ');
  const cx = x.replace(/ /g, ''), cy = y.replace(/ /g, '');
  if (cx === cy) return { s: 0.97, why: 'mismo nombre (sin espacios)' };
  if (tx.length > 1 && [...tx].sort().join(' ') === [...ty].sort().join(' ')) return { s: 0.95, why: 'mismas palabras' };
  if (tx.length >= 2 && ty.length >= 2 && tx[tx.length - 1] === ty[ty.length - 1] && tx[0][0] === ty[0][0]
      && (tx[0].length === 1 || ty[0].length === 1 || tx[0].startsWith(ty[0]) || ty[0].startsWith(tx[0]))) return { s: 0.86, why: 'misma inicial y apellido' };
  if (Math.min(cx.length, cy.length) >= 6 && cx[0] === cy[0] && lev(cx, cy) <= (Math.min(cx.length, cy.length) >= 10 ? 2 : 1)) return { s: 0.83, why: 'casi igual (errata)' };
  const [small, big] = tx.length <= ty.length ? [tx, ty] : [ty, tx];
  if (small.length >= 2 && small.every(t => big.includes(t))) return { s: 0.8, why: 'un nombre contiene al otro' };
  if (tx.length >= 2 && ty.length >= 2 && tx[0] === ty[0] && tx[1].length >= 3 && ty[1].length >= 3 && (tx[1].startsWith(ty[1]) || ty[1].startsWith(tx[1]))) {
    return { s: 0.78, why: 'mismo nombre y apellido parecido' };
  }
  return null;
}

// Parecido entre dos personas (cada una con varias formas de llamarla)
function personScore(a, b) {
  let best = null;
  for (const x of a.variants) for (const y of b.variants) {
    const r = score(x, y);
    if (r && (!best || r.s > best.s)) best = r;
  }
  // El nick de uno es el nombre del otro
  for (const [p, q] of [[a, b], [b, a]]) {
    for (const n of p.handles) for (const v of q.variants) {
      if (n && n.length >= 4 && n === v.replace(/ /g, '') && (!best || best.s < 0.9)) best = { s: 0.9, why: 'el nick de uno es el nombre del otro' };
    }
  }
  return best;
}

module.exports = { resolve, link, unlink, markNotSame, forgetNotSame, isNotSame, links, info, saveInfo, norm, score, personScore, pairKey };
