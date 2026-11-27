'use strict';
// Insignias especiales: las da la tienda a mano (Beta tester, Staff, Juez…). Pueden ser ocultas (no salen en el catálogo
// hasta que alguien las tiene) y destacadas (salen junto al nombre en el perfil y en los rankings)
const { db } = require('./db');
const I = require('./identity');

db.exec(`
CREATE TABLE IF NOT EXISTS special_badges (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, descr TEXT, icon TEXT, color TEXT,
  hidden INTEGER DEFAULT 1, featured INTEGER DEFAULT 1, xp INTEGER DEFAULT 0, pos INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS special_awards (badge_id INTEGER NOT NULL REFERENCES special_badges(id) ON DELETE CASCADE, person_key TEXT NOT NULL,
  note TEXT, awarded_by TEXT, at TEXT DEFAULT (datetime('now')), PRIMARY KEY (badge_id, person_key));
`);
// De serie
const SEED = [
  ['beta', 'Beta tester', 'Probó la web antes que nadie y ayudó a mejorarla', 'β', '#7b5ea7', 1, 1, 50, 1],
  ['staff', 'Staff', 'Del equipo de la tienda', '★', '#f47700', 1, 1, 0, 2],
  ['juez', 'Juez', 'Juez en los torneos de la tienda', '⚖', '#2a7de1', 1, 1, 0, 3],
  ['fundador', 'Fundador', 'Jugó los primeros torneos con la web de la tienda', '1', '#b8860b', 0, 1, 25, 4],
];
const ins = db.prepare('INSERT OR IGNORE INTO special_badges (slug, name, descr, icon, color, hidden, featured, xp, pos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
for (const s of SEED) ins.run(...s);

const list = () => db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM special_awards a WHERE a.badge_id = b.id) holders FROM special_badges b ORDER BY b.pos, b.id`).all();
const get = id => db.prepare('SELECT * FROM special_badges WHERE id = ?').get(id);
const clean = (v, n) => String(v || '').trim().slice(0, n);
function save(b, id) {
  const name = clean(b.name, 40);
  if (!name) throw new Error('Ponle nombre');
  const v = [name, clean(b.descr, 140) || null, clean(b.icon, 3) || name.slice(0, 1), /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#f47700',
    b.hidden ? 1 : 0, b.featured ? 1 : 0, Math.min(Math.max(Number(b.xp) || 0, 0), 500)];
  if (id) db.prepare('UPDATE special_badges SET name = ?, descr = ?, icon = ?, color = ?, hidden = ?, featured = ?, xp = ? WHERE id = ?').run(...v, id);
  else {
    const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
    id = db.prepare('INSERT INTO special_badges (slug, name, descr, icon, color, hidden, featured, xp, pos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100)').run(slug, ...v).lastInsertRowid;
  }
  bust();
  return id;
}
const remove = id => { db.prepare('DELETE FROM special_badges WHERE id = ?').run(id); bust(); };
function award(id, personKey, note, by) {
  if (!get(id)) throw new Error('Esa insignia no existe');
  const key = I.resolve(String(personKey || ''));
  if (!key) throw new Error('Elige un jugador');
  db.prepare('INSERT OR REPLACE INTO special_awards (badge_id, person_key, note, awarded_by) VALUES (?, ?, ?, ?)').run(id, key, clean(note, 140) || null, by || null);
  bust();
}
const revoke = (id, personKey) => { db.prepare('DELETE FROM special_awards WHERE badge_id = ? AND person_key = ?').run(id, personKey); bust(); };
const holders = id => db.prepare('SELECT * FROM special_awards WHERE badge_id = ? ORDER BY at DESC').all(id);

// Insignias especiales de una persona (resolviendo fichas unidas)
let cache = null;
function bust() { cache = null; try { require('./badges').invalidate(); } catch (e) { /* nada */ } }
function byKey() {
  if (cache) return cache;
  const m = new Map();
  for (const r of db.prepare('SELECT a.person_key, a.note, a.at, b.* FROM special_awards a JOIN special_badges b ON b.id = a.badge_id ORDER BY b.pos, b.id').all()) {
    const k = I.resolve(r.person_key);
    if (!m.has(k)) m.set(k, []);
    if (!m.get(k).some(x => x.id === r.id)) m.get(k).push(r);
  }
  cache = m;
  return m;
}
const of = key => byKey().get(I.resolve(key)) || [];
const featured = key => of(key).filter(b => b.featured);

module.exports = { list, get, save, remove, award, revoke, holders, of, featured, byKey, bust };
