'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const config = require('./config');

const COOKIE = 'mt_session';
const SESSION_DAYS = 30;

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hashPassword(pw) {
  return bcrypt.hashSync(pw, 11);
}

function createUser(username, password, role = 'staff') {
  return db.prepare('INSERT INTO users(username, pass_hash, role) VALUES(?, ?, ?)')
    .run(username.trim(), hashPassword(password), role === 'admin' ? 'admin' : 'staff');
}

function ensureAdmin() {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (count > 0) return;
  let pw = config.adminPassword;
  if (!pw) {
    pw = crypto.randomBytes(9).toString('base64url');
    console.log('==============================================');
    console.log(` Usuario admin creado: ${config.adminUser}`);
    console.log(` Contraseña generada: ${pw}`);
    console.log(' Cámbiala en Admin > Usuarios tras entrar.');
    console.log('==============================================');
  }
  createUser(config.adminUser, pw, 'admin');
}

// Limitador simple de intentos de login por IP
const attempts = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(ip, a);
  return a.length < 10;
}
function loginFailed(ip) {
  const a = attempts.get(ip) || [];
  a.push(Date.now());
  attempts.set(ip, a);
}

function login(req, res, username, password) {
  const ip = req.ip;
  if (!loginAllowed(ip)) return { error: 'Demasiados intentos. Prueba en 15 minutos.' };
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!user || !bcrypt.compareSync(String(password || ''), user.pass_hash)) {
    loginFailed(ip);
    return { error: 'Usuario o contraseña incorrectos.' };
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES(?, ?, ?)').run(token, user.id, expires);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  res.setHeader('Set-Cookie', cookieString(token, SESSION_DAYS * 86400));
  return { user };
}

function cookieString(value, maxAge) {
  return `${COOKIE}=${value}; Path=${config.basePath || '/'}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`;
}

function logout(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', cookieString('', 0));
}

// Carga req.user si hay sesión válida
function sessionMiddleware(req, res, next) {
  const token = parseCookies(req)[COOKIE];
  req.user = null;
  if (token) {
    const row = db.prepare(`SELECT u.id, u.username, u.role, s.expires_at FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
    if (row && row.expires_at > Date.now()) req.user = { id: row.id, username: row.username, role: row.role };
  }
  next();
}

// Protección CSRF: las peticiones que modifican datos deben venir del mismo origen
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return res.status(403).send('Origen no válido');
  try {
    const host = new URL(origin).host;
    if (host !== req.headers.host && host !== req.headers['x-forwarded-host']) {
      return res.status(403).send('Origen no válido');
    }
  } catch {
    return res.status(403).send('Origen no válido');
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.redirect('/admin/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/admin/login');
  if (req.user.role !== 'admin') return res.status(403).send('Solo administradores');
  next();
}

module.exports = {
  ensureAdmin, login, logout, sessionMiddleware, sameOrigin, requireUser, requireAdmin,
  createUser, hashPassword,
};
