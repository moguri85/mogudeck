'use strict';
// Avisos en el móvil (Web Push): «Ronda 2: te toca la mesa 3». Solo llegan si el jugador lo ha activado
// (en iPhone, con la web instalada en la pantalla de inicio)
const webpush = require('web-push');
const { db, setting, setSetting, log } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, keys TEXT NOT NULL, event_id INTEGER, player_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')))`);
db.exec('CREATE INDEX IF NOT EXISTS idx_push_ev ON push_subs(event_id, player_id)');

let ready = false;
function init() {
  if (ready) return true;
  let pub = setting('vapid_public'), priv = setting('vapid_private');
  if (!pub || !priv) { const k = webpush.generateVAPIDKeys(); pub = k.publicKey; priv = k.privateKey; setSetting('vapid_public', pub); setSetting('vapid_private', priv); }
  const mail = setting('contact_email') || 'tienda@example.com';
  webpush.setVapidDetails(`mailto:${mail}`, pub, priv);
  ready = true;
  return true;
}
const publicKey = () => { init(); return setting('vapid_public'); };

function subscribe(sub, eventId, playerId) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) throw new Error('Suscripción no válida');
  if (sub.endpoint.length > 1000) throw new Error('Suscripción no válida');
  db.prepare('INSERT OR REPLACE INTO push_subs (endpoint, keys, event_id, player_id) VALUES (?, ?, ?, ?)')
    .run(sub.endpoint, JSON.stringify({ p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 100) }), eventId, playerId);
}
const unsubscribe = endpoint => db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(String(endpoint || ''));
const has = (eventId, playerId) => db.prepare('SELECT COUNT(*) c FROM push_subs WHERE event_id = ? AND player_id = ?').get(eventId, playerId).c > 0;

async function sendTo(row, payload) {
  try {
    await webpush.sendNotification({ endpoint: row.endpoint, keys: JSON.parse(row.keys) }, JSON.stringify(payload), { TTL: 1800 });
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) unsubscribe(row.endpoint);
    else log('warn', `Aviso al móvil fallido: ${e.statusCode || ''} ${e.message}`);
  }
}
// msg(playerId) → { title, body, url } o null
function toEvent(eventId, msg) {
  const rows = db.prepare('SELECT * FROM push_subs WHERE event_id = ?').all(eventId);
  if (!rows.length) return;
  init();
  for (const r of rows) { const m = msg(r.player_id); if (m) sendTo(r, m); }
}

// Se emparejó una ronda: a cada jugador, su mesa
function roundPaired(eventId) {
  const C = require('./commander');
  const ev = C.getEvent(eventId);
  const rd = db.prepare('SELECT * FROM cmd_rounds WHERE event_id = ? ORDER BY number DESC LIMIT 1').get(eventId);
  if (!ev || !rd) return;
  const seats = db.prepare('SELECT s.player_id, s.seat, pd.table_number, pd.size FROM cmd_seats s JOIN cmd_pods pd ON pd.id = s.pod_id WHERE pd.round_id = ?').all(rd.id);
  const url = `${require('./config').basePath || ''}/commander/${eventId}`;
  toEvent(eventId, pid => {
    const s = seats.find(x => x.player_id === pid);
    if (!s) return null;
    return { title: `${rd.kind === 'final' ? 'Mesa final' : `Ronda ${rd.number}`}: mesa ${s.table_number}`, body: `${ev.name} · ${s.seat === 1 ? 'empiezas tú' : `juegas ${s.seat}º de ${s.size}`}`, url, tag: `r${rd.id}` };
  });
}
function timerStarted(eventId, minutes) {
  const C = require('./commander');
  const ev = C.getEvent(eventId);
  const rd = db.prepare('SELECT * FROM cmd_rounds WHERE event_id = ? ORDER BY number DESC LIMIT 1').get(eventId);
  if (!ev || !rd) return;
  toEvent(eventId, () => ({ title: `¡Empieza la ronda ${rd.number}!`, body: `${ev.name} · ${minutes} minutos`, url: `${require('./config').basePath || ''}/commander/${eventId}`, tag: `t${rd.id}` }));
}

module.exports = { publicKey, subscribe, unsubscribe, has, toEvent, roundPaired, timerStarted };
