'use strict';
// Cuentas de jugadores (separadas de los usuarios del staff).
// Cada cuenta tiene su propia clave de persona «a:<id>». Cuando el staff aprueba que reclama una ficha,
// esa clave se vincula a la ficha (identity.link), así todo lo que se juega con la cuenta suma en la misma ficha.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, addColumn } = require('./db');
const config = require('./config');
const I = require('./identity');

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_login TEXT,
  reset_hash TEXT,
  reset_expires INTEGER
);
CREATE TABLE IF NOT EXISTS account_sessions (
  token TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  person_key TEXT NOT NULL,
  label TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  decided_by TEXT,
  decided_at TEXT,
  reason TEXT
);
CREATE TABLE IF NOT EXISTS account_decks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  commander TEXT,
  list TEXT NOT NULL,
  value_cents INTEGER,
  bracket INTEGER,
  legal INTEGER,
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

addColumn('accounts', 'nick', 'TEXT');
addColumn('accounts', 'notes', 'TEXT');

const COOKIE = 'mt_player';
const DAYS = 90;
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const keyOf = acc => 'a:' + acc.id;
// Ficha de la cuenta (su propia clave o la ficha a la que está vinculada)
const personKey = acc => I.resolve(keyOf(acc));
const linked = acc => personKey(acc) !== keyOf(acc);

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const cookieStr = (v, maxAge) => `${COOKIE}=${v}; Path=${config.basePath || '/'}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`;

// Limitador de intentos por IP (login, registro, cambio de contraseña)
const hits = new Map();
function tooMany(ip, max = 10) {
  const now = Date.now();
  const a = (hits.get(ip) || []).filter(t => now - t < 15 * 60e3);
  hits.set(ip, a);
  return a.length >= max;
}
const fail = ip => { const a = hits.get(ip) || []; a.push(Date.now()); hits.set(ip, a); };

class AccountError extends Error {}
const cleanEmail = e => String(e || '').trim().toLowerCase().slice(0, 120);
const cleanName = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 60);
const cleanNick = n => String(n || '').replace(/\s+/g, '').trim().slice(0, 24);
function checkNick(nick, exceptId = 0) {
  if (!nick) return null;
  if (nick.length < 2 || !/^[\p{L}\p{N}_.\-]+$/u.test(nick)) throw new AccountError('El nick puede tener letras, números, punto, guion y guion bajo (2 a 24 caracteres, sin espacios).');
  if (db.prepare('SELECT 1 FROM accounts WHERE lower(nick) = lower(?) AND id != ?').get(nick, exceptId)) throw new AccountError('Ese nick ya lo usa otra persona.');
  return nick;
}
// Nombre corto para mostrar: el nick si lo hay
const shown = acc => acc.nick || acc.name;
function checkPassword(pw) {
  if (String(pw || '').length < 8) throw new AccountError('La contraseña debe tener al menos 8 caracteres.');
}

function startSession(res, acc) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO account_sessions (token, account_id, expires_at) VALUES (?, ?, ?)').run(sha(token), acc.id, Date.now() + DAYS * 864e5);
  db.prepare('DELETE FROM account_sessions WHERE expires_at < ?').run(Date.now());
  db.prepare("UPDATE accounts SET last_login = datetime('now') WHERE id = ?").run(acc.id);
  res.append('Set-Cookie', cookieStr(token, DAYS * 86400));
}

function register(req, res, { email, name, password, nick }) {
  if (tooMany(req.ip, 6)) throw new AccountError('Demasiados intentos. Prueba en 15 minutos.');
  email = cleanEmail(email); name = cleanName(name); nick = checkNick(cleanNick(nick));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountError('Escribe un email válido.');
  if (name.length < 2) throw new AccountError('Escribe tu nombre (el que usas en la tienda o en Melee).');
  checkPassword(password);
  if (db.prepare('SELECT 1 FROM accounts WHERE email = ?').get(email)) { fail(req.ip); throw new AccountError('Ya hay una cuenta con ese email. Entra con ella.'); }
  const id = db.prepare('INSERT INTO accounts (email, name, nick, pass_hash) VALUES (?, ?, ?, ?)').run(email, name, nick, bcrypt.hashSync(String(password), 11)).lastInsertRowid;
  fail(req.ip); // cuenta como intento para frenar altas masivas
  const acc = get(id);
  startSession(res, acc);
  return acc;
}

function login(req, res, { email, password }) {
  if (tooMany(req.ip)) throw new AccountError('Demasiados intentos. Prueba en 15 minutos.');
  const acc = db.prepare('SELECT * FROM accounts WHERE email = ?').get(cleanEmail(email));
  if (!acc || !bcrypt.compareSync(String(password || ''), acc.pass_hash)) { fail(req.ip); throw new AccountError('Email o contraseña incorrectos.'); }
  startSession(res, acc);
  return acc;
}

function logout(req, res) {
  const t = cookies(req)[COOKIE];
  if (t) db.prepare('DELETE FROM account_sessions WHERE token = ?').run(sha(t));
  res.append('Set-Cookie', cookieStr('', 0));
}

const get = id => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) || null;

// Carga req.account si hay sesión de jugador
function middleware(req, res, next) {
  req.account = null;
  const t = cookies(req)[COOKIE];
  if (t) {
    const row = db.prepare('SELECT a.* FROM account_sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token = ? AND s.expires_at > ?').get(sha(t), Date.now());
    if (row) { req.account = row; req.account.key = keyOf(row); req.account.person = personKey(row); }
  }
  res.locals.account = req.account;
  next();
}

function changePassword(acc, current, next) {
  if (!bcrypt.compareSync(String(current || ''), acc.pass_hash)) throw new AccountError('La contraseña actual no es correcta.');
  checkPassword(next);
  db.prepare('UPDATE accounts SET pass_hash = ? WHERE id = ?').run(bcrypt.hashSync(String(next), 11), acc.id);
}
// Cambiar datos (el jugador: nombre y nick; el staff además email y notas)
function update(accId, { name, nick, email, notes }, { admin = false } = {}) {
  const acc = get(accId);
  if (!acc) throw new AccountError('Cuenta no encontrada.');
  name = cleanName(name);
  if (name.length < 2) throw new AccountError('Escribe el nombre.');
  nick = checkNick(cleanNick(nick), acc.id);
  let mail = acc.email;
  if (admin && email != null) {
    mail = cleanEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new AccountError('Email no válido.');
    if (db.prepare('SELECT 1 FROM accounts WHERE email = ? AND id != ?').get(mail, acc.id)) throw new AccountError('Ese email ya es de otra cuenta.');
  }
  db.transaction(() => {
    db.prepare('UPDATE accounts SET name = ?, nick = ?, email = ?, notes = ? WHERE id = ?').run(name, nick, mail, admin ? (String(notes ?? acc.notes ?? '').slice(0, 1000) || null) : acc.notes, acc.id);
    // Los torneos que aún no han terminado usan el nombre y el nick nuevos
    db.prepare(`UPDATE cmd_players SET name = ?, username = ? WHERE account_id = ? AND event_id IN (SELECT id FROM cmd_events WHERE status != 'finished')`).run(name, nick, acc.id);
  })();
}
const rename = (acc, name) => update(acc.id, { name, nick: acc.nick });
function setPassword(accId, pw) {
  checkPassword(pw);
  db.prepare('UPDATE accounts SET pass_hash = ?, reset_hash = NULL, reset_expires = NULL WHERE id = ?').run(bcrypt.hashSync(String(pw), 11), accId);
  db.prepare('DELETE FROM account_sessions WHERE account_id = ?').run(accId);
}
const sessions = accId => db.prepare('SELECT COUNT(*) c FROM account_sessions WHERE account_id = ? AND expires_at > ?').get(accId, Date.now()).c;
const closeSessions = accId => db.prepare('DELETE FROM account_sessions WHERE account_id = ?').run(accId);
const allClaims = accId => db.prepare('SELECT * FROM account_claims WHERE account_id = ? ORDER BY id DESC').all(accId);

// Enlace de un solo uso para cambiar la contraseña (lo genera el staff y se lo pasa al jugador)
function resetLink(accountId) {
  const t = crypto.randomBytes(24).toString('base64url');
  db.prepare('UPDATE accounts SET reset_hash = ?, reset_expires = ? WHERE id = ?').run(sha(t), Date.now() + 48 * 3600e3, accountId);
  return `/cuenta/nueva-clave/${t}`;
}
function byResetToken(t) {
  return db.prepare('SELECT * FROM accounts WHERE reset_hash = ? AND reset_expires > ?').get(sha(t), Date.now()) || null;
}
function useReset(req, res, t, password) {
  const acc = byResetToken(t);
  if (!acc) throw new AccountError('El enlace ha caducado o ya se usó. Pide otro en la tienda.');
  checkPassword(password);
  db.prepare('UPDATE accounts SET pass_hash = ?, reset_hash = NULL, reset_expires = NULL WHERE id = ?').run(bcrypt.hashSync(String(password), 11), acc.id);
  db.prepare('DELETE FROM account_sessions WHERE account_id = ?').run(acc.id);
  startSession(res, acc);
  return acc;
}

// ---------- Reclamar fichas ----------
// Cuenta que ya tiene una ficha (si hay alguna)
function ownerOf(key) {
  const k = I.resolve(key);
  for (const a of db.prepare('SELECT * FROM accounts').all()) if (personKey(a) === k) return a;
  return null;
}
function claims(accountId) {
  return db.prepare('SELECT * FROM account_claims WHERE account_id = ? ORDER BY id DESC').all(accountId);
}
function requestClaim(acc, key, label, note) {
  key = String(key || '').slice(0, 200);
  if (!/^(u|n|p|a):/.test(key)) throw new AccountError('Ficha no válida.');
  const k = I.resolve(key);
  if (k === personKey(acc)) throw new AccountError('Esa ficha ya es tuya.');
  const owner = ownerOf(k);
  if (owner && owner.id !== acc.id) throw new AccountError('Esa ficha ya está vinculada a otra cuenta. Si es tuya, habla con la tienda.');
  if (db.prepare("SELECT 1 FROM account_claims WHERE account_id = ? AND person_key = ? AND status = 'pending'").get(acc.id, k)) throw new AccountError('Ya lo has pedido: falta que la tienda lo confirme.');
  db.prepare('INSERT INTO account_claims (account_id, person_key, label, note) VALUES (?, ?, ?, ?)').run(acc.id, k, String(label || '').slice(0, 80), String(note || '').slice(0, 300) || null);
}
function cancelClaim(acc, claimId) {
  db.prepare("DELETE FROM account_claims WHERE id = ? AND account_id = ? AND status = 'pending'").run(claimId, acc.id);
}
function pendingClaims() {
  return db.prepare(`SELECT c.*, a.name aname, a.email FROM account_claims c JOIN accounts a ON a.id = c.account_id
    WHERE c.status = 'pending' ORDER BY c.id`).all();
}
const pendingCount = () => db.prepare("SELECT COUNT(*) c FROM account_claims WHERE status = 'pending'").get().c;

// Aprobar: la cuenta pasa a ser esa ficha. Si ya tenía otra, se unen las dos.
function approveClaim(claimId, by) {
  const c = db.prepare('SELECT * FROM account_claims WHERE id = ?').get(claimId);
  if (!c || c.status !== 'pending') throw new AccountError('Solicitud no encontrada.');
  const acc = get(c.account_id);
  const target = I.resolve(c.person_key);
  const owner = ownerOf(target);
  if (owner && owner.id !== acc.id) throw new AccountError(`Esa ficha ya es de la cuenta de ${owner.name}. Quita antes ese vínculo.`);
  db.transaction(() => {
    const mine = personKey(acc);
    if (mine === keyOf(acc)) I.link(keyOf(acc), target, { by, kind: 'cuenta', reason: `Cuenta de ${acc.name}` });
    else if (mine !== target) I.link(target, mine, { by, kind: 'cuenta', reason: `Cuenta de ${acc.name}` });
    db.prepare("UPDATE account_claims SET status = 'approved', decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(by, c.id);
  })();
  return acc;
}
function rejectClaim(claimId, by, reason) {
  db.prepare("UPDATE account_claims SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), reason = ? WHERE id = ? AND status = 'pending'")
    .run(by, String(reason || '').slice(0, 200) || null, claimId);
}
// Quitar el vínculo de la cuenta con su ficha (vuelve a tener solo la suya)
function unlinkAccount(accountId) {
  const acc = get(accountId);
  if (!acc) return false;
  return I.unlink(keyOf(acc));
}

function list() {
  return db.prepare('SELECT * FROM accounts ORDER BY id DESC').all().map(a => ({ ...a, key: keyOf(a), person: personKey(a), linked: linked(a) }));
}
function remove(accountId) {
  const acc = get(accountId);
  if (!acc) return;
  db.transaction(() => {
    I.unlink(keyOf(acc));
    db.prepare('UPDATE cmd_players SET account_id = NULL WHERE account_id = ?').run(acc.id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(acc.id);
  })();
}

// ---------- Mis mazos ----------
const decks = accId => db.prepare('SELECT * FROM account_decks WHERE account_id = ? ORDER BY updated_at DESC').all(accId);
const deck = (accId, id) => db.prepare('SELECT * FROM account_decks WHERE account_id = ? AND id = ?').get(accId, id) || null;
function saveDeck(accId, { id, name, commander, list: text, value_cents, bracket, legal }) {
  name = String(name || commander || 'Mi mazo').replace(/\s+/g, ' ').trim().slice(0, 80);
  text = String(text || '').slice(0, 20000);
  if (!text.trim()) throw new AccountError('La lista está vacía.');
  if (id && deck(accId, id)) {
    db.prepare("UPDATE account_decks SET name = ?, commander = ?, list = ?, value_cents = ?, bracket = ?, legal = ?, updated_at = datetime('now') WHERE id = ? AND account_id = ?")
      .run(name, commander || null, text, value_cents ?? null, bracket ?? null, legal ?? null, id, accId);
    return id;
  }
  if (db.prepare('SELECT COUNT(*) c FROM account_decks WHERE account_id = ?').get(accId).c >= 40) throw new AccountError('Has llegado al máximo de 40 mazos guardados.');
  return db.prepare('INSERT INTO account_decks (account_id, name, commander, list, value_cents, bracket, legal) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(accId, name, commander || null, text, value_cents ?? null, bracket ?? null, legal ?? null).lastInsertRowid;
}
const deleteDeck = (accId, id) => db.prepare('DELETE FROM account_decks WHERE account_id = ? AND id = ?').run(accId, id);

module.exports = {
  AccountError, register, login, logout, middleware, get, keyOf, personKey, linked, changePassword, rename, update, setPassword, sessions, closeSessions, allClaims, shown, cleanNick,
  resetLink, byResetToken, useReset, ownerOf, claims, requestClaim, cancelClaim, pendingClaims, pendingCount, approveClaim, rejectClaim,
  unlinkAccount, list, remove, decks, deck, saveDeck, deleteDeck,
};
