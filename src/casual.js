'use strict';
// Partidas casuales: salas compartidas del contador (código de 4 letras), liga casual opcional y «Busco mesa»
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { db } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS casual_rooms (code TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS casual_games (id INTEGER PRIMARY KEY, token TEXT UNIQUE NOT NULL, room TEXT, players TEXT NOT NULL, started_at INTEGER, ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')), confirmed_at TEXT);
CREATE TABLE IF NOT EXISTS casual_game_players (game_id INTEGER NOT NULL REFERENCES casual_games(id) ON DELETE CASCADE, slot INTEGER NOT NULL,
  account_id INTEGER NOT NULL, at TEXT DEFAULT (datetime('now')), PRIMARY KEY (game_id, slot), UNIQUE (game_id, account_id));
CREATE TABLE IF NOT EXISTS lfg (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, day TEXT NOT NULL, time TEXT, game TEXT DEFAULT 'commander', bracket TEXT,
  slots INTEGER DEFAULT 4, note TEXT, created_at TEXT DEFAULT (datetime('now')), cancelled INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS lfg_join (lfg_id INTEGER NOT NULL REFERENCES lfg(id) ON DELETE CASCADE, account_id INTEGER NOT NULL, at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (lfg_id, account_id));
`);

class CasualError extends Error {}
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: require('./config').tz });
const bus = new EventEmitter();
bus.setMaxListeners(500);

// ---------- Salas ----------
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sin I ni O para no confundir
const newCode = () => Array.from(crypto.randomBytes(4), b => ABC[b % ABC.length]).join('');
const MAX = 96 * 1024;
function cleanState(state) {
  const s = typeof state === 'string' ? state : JSON.stringify(state || {});
  if (s.length > MAX) throw new CasualError('La partida es demasiado grande');
  const o = JSON.parse(s);
  if (!o || !Array.isArray(o.players) || o.players.length < 2 || o.players.length > 6) throw new CasualError('Partida no válida');
  return JSON.stringify(o);
}
function cleanup() { db.prepare("DELETE FROM casual_rooms WHERE updated_at < datetime('now', '-2 days')").run(); }
function createRoom(state) {
  cleanup();
  const s = cleanState(state);
  for (let i = 0; i < 20; i++) {
    const code = newCode();
    if (db.prepare('INSERT OR IGNORE INTO casual_rooms (code, state) VALUES (?, ?)').run(code, s).changes) return { code, version: 1 };
  }
  throw new CasualError('No se pudo crear la sala');
}
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
function getRoom(code) {
  const r = db.prepare('SELECT * FROM casual_rooms WHERE code = ?').get(normCode(code));
  if (!r) throw new CasualError('No existe esa sala (o ya caducó)');
  return { code: r.code, version: r.version, state: JSON.parse(r.state) };
}
// Guarda solo si nadie ha cambiado la partida desde la versión que tenía este móvil
function saveRoom(code, state, base) {
  code = normCode(code);
  const s = cleanState(state);
  const cur = db.prepare('SELECT version FROM casual_rooms WHERE code = ?').get(code);
  if (!cur) throw new CasualError('No existe esa sala (o ya caducó)');
  if (Number(base) !== cur.version) return { conflict: true, ...getRoom(code) };
  db.prepare("UPDATE casual_rooms SET state = ?, version = version + 1, updated_at = datetime('now') WHERE code = ?").run(s, code);
  const version = cur.version + 1;
  setImmediate(() => bus.emit('room', code, version));
  return { code, version };
}

// ---------- Liga casual ----------
const POINTS = place => (place === 1 ? 3 : 1);
function registerGame(state, room) {
  const st = JSON.parse(cleanState(state));
  const alive = st.players.filter(p => !p.out);
  if (alive.length !== 1) throw new CasualError('La partida tiene que haber terminado (solo uno en pie)');
  const order = [alive[0], ...st.players.filter(p => p.out).sort((a, b) => b.ord - a.ord)];
  const players = order.map((p, i) => ({ slot: i, name: String(p.name || '').slice(0, 24), deck: String(p.deck || '').slice(0, 120), place: i + 1, killer: p.killer ? (st.players.find(q => q.id === p.killer) || {}).name || null : null }));
  const token = crypto.randomBytes(9).toString('base64url');
  const id = db.prepare('INSERT INTO casual_games (token, room, players, started_at, ended_at) VALUES (?, ?, ?, ?, ?)').run(token, room || null, JSON.stringify(players), st.startedAt || null, Date.now()).lastInsertRowid;
  return { id, token };
}
function game(token) {
  const g = db.prepare('SELECT * FROM casual_games WHERE token = ?').get(String(token || ''));
  if (!g) return null;
  g.players = JSON.parse(g.players);
  const cl = db.prepare('SELECT slot, account_id FROM casual_game_players WHERE game_id = ?').all(g.id);
  for (const p of g.players) { const c = cl.find(x => x.slot === p.slot); p.account = c ? c.account_id : null; }
  return g;
}
function claimSlot(token, slot, accountId) {
  const g = game(token);
  if (!g) throw new CasualError('Partida no encontrada');
  if (g.status === 'expired') throw new CasualError('Esta partida caducó sin que la confirmasen todos');
  if (Date.now() - new Date(g.created_at.replace(' ', 'T') + 'Z') > 48 * 3600e3 && g.status === 'pending') {
    db.prepare("UPDATE casual_games SET status = 'expired' WHERE id = ?").run(g.id);
    throw new CasualError('Han pasado más de 48 horas: esta partida ya no cuenta');
  }
  const p = g.players.find(x => x.slot === Number(slot));
  if (!p) throw new CasualError('Ese jugador no está en la partida');
  if (p.account && p.account !== accountId) throw new CasualError(`${p.name} ya lo ha confirmado otra cuenta`);
  if (g.players.some(x => x.account === accountId && x.slot !== p.slot)) throw new CasualError('Ya has confirmado como otro jugador de esta partida');
  db.prepare('INSERT OR REPLACE INTO casual_game_players (game_id, slot, account_id) VALUES (?, ?, ?)').run(g.id, p.slot, accountId);
  const n = db.prepare('SELECT COUNT(*) c FROM casual_game_players WHERE game_id = ?').get(g.id).c;
  if (n === g.players.length && g.status === 'pending') db.prepare("UPDATE casual_games SET status = 'ok', confirmed_at = datetime('now') WHERE id = ?").run(g.id);
  require('./badges').invalidate && require('./badges').invalidate();
  return game(token);
}
function unclaim(token, accountId) {
  const g = game(token);
  if (!g || g.status !== 'pending') return;
  db.prepare('DELETE FROM casual_game_players WHERE game_id = ? AND account_id = ?').run(g.id, accountId);
}
// Clasificación: solo partidas confirmadas por todos. month = 'AAAA-MM' o null para siempre
function standings(month) {
  const rows = db.prepare(`SELECT g.id, g.players, g.confirmed_at, gp.slot, gp.account_id FROM casual_games g JOIN casual_game_players gp ON gp.game_id = g.id
    WHERE g.status = 'ok' ${month ? "AND strftime('%Y-%m', g.confirmed_at) = ?" : ''}`).all(...(month ? [month] : []));
  const by = new Map();
  for (const r of rows) {
    const p = JSON.parse(r.players).find(x => x.slot === r.slot);
    const o = by.get(r.account_id) || { account: r.account_id, pts: 0, games: 0, wins: 0, cmds: new Set() };
    o.games++; o.pts += POINTS(p.place); if (p.place === 1) o.wins++; if (p.deck) o.cmds.add(p.deck);
    by.set(r.account_id, o);
  }
  return [...by.values()].map(o => ({ ...o, cmds: o.cmds.size })).sort((a, b) => b.pts - a.pts || b.wins - a.wins || a.games - b.games);
}
const gamesOf = accountId => db.prepare(`SELECT g.*, gp.slot FROM casual_games g JOIN casual_game_players gp ON gp.game_id = g.id WHERE gp.account_id = ? AND g.status = 'ok' ORDER BY g.id DESC`).all(accountId)
  .map(g => { const ps = JSON.parse(g.players); return { ...g, players: ps, me: ps.find(x => x.slot === g.slot) }; });
const allGames = (limit = 100) => db.prepare('SELECT * FROM casual_games ORDER BY id DESC LIMIT ?').all(limit).map(g => ({ ...g, players: JSON.parse(g.players), claimed: db.prepare('SELECT COUNT(*) c FROM casual_game_players WHERE game_id = ?').get(g.id).c }));
const deleteGame = id => db.prepare('DELETE FROM casual_games WHERE id = ?').run(id);

// ---------- Busco mesa ----------
function lfgList() {
  const rows = db.prepare(`SELECT l.*, a.id aid FROM lfg l JOIN accounts a ON a.id = l.account_id WHERE l.cancelled = 0 AND l.day >= ? ORDER BY l.day, l.time, l.id`).all(today());
  const jq = db.prepare('SELECT account_id FROM lfg_join WHERE lfg_id = ? ORDER BY at');
  return rows.map(r => ({ ...r, joined: jq.all(r.id).map(x => x.account_id) }));
}
function lfgCreate(accountId, b) {
  const day = String(b.day || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new CasualError('Pon el día');
  if (day < today()) throw new CasualError('Ese día ya ha pasado');
  if (db.prepare("SELECT COUNT(*) c FROM lfg WHERE account_id = ? AND cancelled = 0 AND day >= ?").get(accountId, today()).c >= 5) throw new CasualError('Ya tienes 5 quedadas abiertas');
  const time = /^\d{2}:\d{2}$/.test(b.time || '') ? b.time : null;
  const slots = Math.min(Math.max(Number(b.slots) || 4, 2), 8);
  const bracket = ['1', '2', '3', '4', '5', 'any'].includes(String(b.bracket)) ? String(b.bracket) : 'any';
  const game = String(b.game || 'commander').slice(0, 20);
  const id = db.prepare('INSERT INTO lfg (account_id, day, time, game, bracket, slots, note) VALUES (?, ?, ?, ?, ?, ?, ?)').run(accountId, day, time, game, bracket, slots, String(b.note || '').trim().slice(0, 200) || null).lastInsertRowid;
  db.prepare('INSERT INTO lfg_join (lfg_id, account_id) VALUES (?, ?)').run(id, accountId);
  return id;
}
function lfgJoin(id, accountId, on) {
  const l = db.prepare('SELECT * FROM lfg WHERE id = ? AND cancelled = 0').get(id);
  if (!l) throw new CasualError('Esa quedada ya no existe');
  if (!on) { if (l.account_id === accountId) throw new CasualError('Eres quien la organiza: cancélala si no vas'); db.prepare('DELETE FROM lfg_join WHERE lfg_id = ? AND account_id = ?').run(id, accountId); return; }
  const n = db.prepare('SELECT COUNT(*) c FROM lfg_join WHERE lfg_id = ?').get(id).c;
  if (n >= l.slots) throw new CasualError('Ya está completa');
  db.prepare('INSERT OR IGNORE INTO lfg_join (lfg_id, account_id) VALUES (?, ?)').run(id, accountId);
}
function lfgCancel(id, accountId, admin = false) {
  db.prepare(`UPDATE lfg SET cancelled = 1 WHERE id = ? ${admin ? '' : 'AND account_id = ?'}`).run(...(admin ? [id] : [id, accountId]));
}
const lfgToday = () => lfgList().filter(l => l.day === today());

module.exports = { CasualError, bus, createRoom, getRoom, saveRoom, normCode, registerGame, game, claimSlot, unclaim, standings, gamesOf, allGames, deleteGame, POINTS,
  lfgList, lfgCreate, lfgJoin, lfgCancel, lfgToday };
