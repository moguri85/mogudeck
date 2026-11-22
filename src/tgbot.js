'use strict';
// Avisos personales por Telegram: cada jugador se apunta una vez (enlace t.me/<bot>?start=<código>) y recibe
// un mensaje privado con su mesa en cada ronda, en torneos de Melee y de Commander. /stop para darse de baja.
// Usa el mismo bot que los avisos al grupo (Ajustes → token de Telegram). Sin webhook: sondeo con getUpdates.
const crypto = require('crypto');
const { db, setting, setSetting, log } = require('./db');

const API = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');
db.exec(`
CREATE TABLE IF NOT EXISTS tg_subs (chat_id INTEGER NOT NULL, person_key TEXT NOT NULL, label TEXT, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (chat_id, person_key));
CREATE TABLE IF NOT EXISTS tg_links (code TEXT PRIMARY KEY, person_key TEXT NOT NULL, label TEXT, created_at TEXT DEFAULT (datetime('now')));
`);
require('./db').addColumn('tournaments', 'tg_round', 'INTEGER DEFAULT 0');
require('./db').addColumn('cmd_events', 'tg_round', 'TEXT');

const token = () => setting('telegram_token') || '';
const resolve = k => require('./identity').resolve(k);

async function call(method, body, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${API}/bot${token()}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw Object.assign(new Error(j.description || `Telegram ${r.status}`), { code: j.error_code || r.status });
    return j.result;
  } finally { clearTimeout(t); }
}

let botName = null;
async function name() {
  if (!token()) return null;
  if (botName) return botName;
  try { botName = (await call('getMe')).username; setSetting('telegram_bot_name', botName); } catch { botName = setting('telegram_bot_name') || null; }
  return botName;
}
const enabled = () => Boolean(token());

// Enlace para apuntarse (uno por persona; se reutiliza)
async function link(personKey, label) {
  const bot = await name();
  if (!bot) return null;
  const key = resolve(personKey);
  let row = db.prepare('SELECT code FROM tg_links WHERE person_key = ?').get(key);
  if (!row) {
    row = { code: crypto.randomBytes(9).toString('base64url') };
    db.prepare('INSERT INTO tg_links (code, person_key, label) VALUES (?, ?, ?)').run(row.code, key, String(label || '').slice(0, 80));
  }
  return `https://t.me/${bot}?start=${row.code}`;
}

async function send(chatId, text) {
  try { await call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }); return true; }
  catch (e) {
    // El jugador ha bloqueado el bot: se le da de baja
    if (e.code === 403) db.prepare('DELETE FROM tg_subs WHERE chat_id = ?').run(chatId);
    else log('warn', `Telegram (aviso personal): ${e.message}`);
    return false;
  }
}

// Mensajes a varias personas: Map(personKey → texto)
async function notifyPeople(messages) {
  if (!enabled() || !messages.size) return 0;
  const subs = db.prepare('SELECT * FROM tg_subs').all();
  if (!subs.length) return 0;
  const byKey = new Map();
  for (const s of subs) { const k = resolve(s.person_key); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(s.chat_id); }
  let n = 0;
  for (const [k, text] of messages) {
    for (const chat of byKey.get(resolve(k)) || []) { if (await send(chat, text)) n++; await new Promise(r => setTimeout(r, 60)); }
  }
  return n;
}

async function handle(msg) {
  if (!msg || !msg.chat || msg.chat.type !== 'private' || typeof msg.text !== 'string') return;
  const chat = msg.chat.id;
  const store = setting('store_name') || 'la tienda';
  const [cmd, arg] = msg.text.trim().split(/\s+/, 2);
  if (cmd === '/start' && arg) {
    const l = db.prepare('SELECT * FROM tg_links WHERE code = ?').get(arg);
    if (!l) return send(chat, 'Ese enlace ya no vale. Pide uno nuevo desde la página del torneo.');
    db.prepare('INSERT OR IGNORE INTO tg_subs (chat_id, person_key, label) VALUES (?, ?, ?)').run(chat, l.person_key, l.label);
    return send(chat, `✅ Listo${l.label ? `, ${l.label}` : ''}. Te avisaré por aquí de tu mesa en cada ronda de los torneos de ${store}.\n\nEscribe /stop para dejar de recibir avisos.`);
  }
  if (cmd === '/stop') {
    const r = db.prepare('DELETE FROM tg_subs WHERE chat_id = ?').run(chat);
    return send(chat, r.changes ? '🔕 Hecho: ya no recibirás avisos. Puedes volver a apuntarte desde la página de cualquier torneo.' : 'No tenías avisos activos.');
  }
  if (cmd === '/start') return send(chat, `Hola 👋 Para recibir tu mesa en los torneos de ${store}, entra en la página del torneo, di quién eres y pulsa «Avísame por Telegram».`);
}

let polling = false, offset = 0, stopped = false;
async function poll() {
  if (polling) return;
  polling = true;
  while (!stopped) {
    if (!enabled()) { await new Promise(r => setTimeout(r, 60e3)); continue; }
    try {
      const ups = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 35000);
      for (const u of ups) { offset = u.update_id + 1; try { await handle(u.message); } catch (e) { log('warn', 'Telegram: ' + e.message); } }
    } catch (e) {
      // 409: hay un webhook u otra instancia leyendo; se reintenta más tarde
      if (e.name !== 'AbortError') log('warn', `Telegram (getUpdates): ${e.message}`);
      await new Promise(r => setTimeout(r, e.code === 409 ? 120e3 : 15e3));
    }
  }
}

function start() { setTimeout(() => { name().catch(() => {}); poll(); }, 5e3); }

function stats() { return { subs: db.prepare('SELECT COUNT(DISTINCT person_key) c FROM tg_subs').get().c, bot: setting('telegram_bot_name') || null }; }

module.exports = { enabled, name, link, notifyPeople, handle, start, stats };
