'use strict';
// Auditoría del contador de vidas de los torneos: cada acción tal cual llega (sin juntar toques), quién la hace, desde dónde,
// y lo que cambió (valor antes → después). También se guardan las que se rechazan. Se ve en Admin › Auditoría.
const { db } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS life_audit (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, event_id INTEGER, pod_id INTEGER, table_no INTEGER, round_no INTEGER,
  by_id INTEGER, by_name TEXT, account_id INTEGER, account_name TEXT, device TEXT,
  op TEXT, params TEXT, changes TEXT, ok INTEGER NOT NULL DEFAULT 1, error TEXT, version INTEGER
);
CREATE INDEX IF NOT EXISTS idx_life_audit_ev ON life_audit(event_id, id);
CREATE INDEX IF NOT EXISTS idx_life_audit_pod ON life_audit(pod_id, id);`);

const HOW = { vida: 'vidas', comandante: 'comandante', veneno: 'veneno' };
// Qué cambió entre dos estados del contador: vidas, veneno, daño de comandante, eliminaciones, turno, mesa terminada…
function diff(a, b) {
  if (!a || !b) return [];
  const out = [];
  const name = id => ((b.players || []).find(p => p.id === Number(id)) || (a.players || []).find(p => p.id === Number(id)) || {}).name || `#${id}`;
  const add = (who, field, from, to) => { if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) out.push({ who, field, from: from ?? null, to: to ?? null }); };
  for (const pb of b.players || []) {
    const pa = (a.players || []).find(p => p.id === pb.id) || {};
    add(pb.name, 'Vidas', pa.life, pb.life);
    add(pb.name, 'Veneno', pa.poison, pb.poison);
    const keys = new Set([...Object.keys(pa.cmd || {}), ...Object.keys(pb.cmd || {})]);
    for (const k of keys) add(pb.name, `Daño de comandante de ${name(parseInt(k, 10))}${/b$/.test(k) ? ' (2º)' : ''}`, (pa.cmd || {})[k] || 0, (pb.cmd || {})[k] || 0);
    add(pb.name, 'Eliminado', pa.out ? `sí${pa.killer ? ` (por ${name(pa.killer)})` : pa.how ? ` (${HOW[pa.how] || pa.how})` : ''}` : 'no', pb.out ? `sí${pb.killer ? ` (por ${name(pb.killer)})` : pb.how ? ` (${HOW[pb.how] || pb.how})` : ''}` : 'no');
    const xk = new Set([...Object.keys(pa.x || {}), ...Object.keys(pb.x || {})]);
    for (const k of xk) add(pb.name, `Contador ${k}`, (pa.x || {})[k] || 0, (pb.x || {})[k] || 0);
    if (pa.dual !== undefined || pb.dual !== undefined) add(pb.name, 'Dos comandantes', pa.dual ? 'sí' : 'no', pb.dual ? 'sí' : 'no');
  }
  const turn = t => (t ? `vuelta ${t.lap || 1}, ${name(t.pid)}` : 'sin turnos');
  add('Mesa', 'Turno', turn(a.turn), turn(b.turn));
  add('Mesa', 'Monarca', a.monarch ? name(a.monarch) : 'nadie', b.monarch ? name(b.monarch) : 'nadie');
  add('Mesa', 'Iniciativa', a.init ? name(a.init) : 'nadie', b.init ? name(b.init) : 'nadie');
  add('Mesa', 'Muerte súbita', a.sudden ? 'sí' : 'no', b.sudden ? 'sí' : 'no');
  add('Mesa', 'Terminada', a.done ? `sí${a.done.winner ? ` (gana ${name(a.done.winner)})` : ''}` : 'no', b.done ? `sí${b.done.winner ? ` (gana ${name(b.done.winner)})` : ''}` : 'no');
  return out;
}
const PARAMS = ['pid', 'd', 'rd', 'from', 'slot', 'killer', 'how', 'to', 'on', 'key', 'winner', 'id'];
function record({ req, ev, podId, view0, out, byId, byName, op, body, error }) {
  try {
    const names = new Map(((view0 && view0.state && view0.state.players) || []).map(p => [p.id, p.name]));
    const params = {};
    for (const k of PARAMS) if (body && body[k] != null && body[k] !== '') params[k] = ['pid', 'from', 'killer', 'to', 'winner'].includes(k) && names.has(Number(body[k])) ? names.get(Number(body[k])) : String(body[k]).slice(0, 60);
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().replace(/^::ffff:/, '');
    const masked = ip.includes('.') ? ip.split('.').slice(0, 3).join('.') + '.x' : ip.split(':').slice(0, 3).join(':') + ':…';
    const ua = String(req.headers['user-agent'] || '');
    const dev = `${/iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : 'Otro'} · ${masked}`;
    const changes = !error && view0 && out && out.state ? diff(view0.state, out.state) : [];
    db.prepare(`INSERT INTO life_audit (at, event_id, pod_id, table_no, round_no, by_id, by_name, account_id, account_name, device, op, params, changes, ok, error, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(Date.now(), ev.id, podId, (out || view0 || {}).table ?? null, (out || view0 || {}).round ?? null,
      byId || null, byName || null, req.account ? req.account.id : null, req.account ? (req.account.name || req.account.nick || req.account.email || null) : null, dev,
      op, JSON.stringify(params), JSON.stringify(changes), error ? 0 : 1, error ? String(error).slice(0, 300) : null, out ? out.version : null);
  } catch (e) { /* la auditoría nunca rompe el contador */ }
}

const OPS = { life: 'Vidas', poison: 'Veneno', cmd: 'Daño de comandante', undo: 'Deshacer', redo: 'Rehacer', turn: 'Turno', kill: 'Eliminar', revive: 'Volver a la partida',
  finish: 'Terminar la mesa', reset: 'Reiniciar contador', reopen: 'Reabrir la mesa', dual: 'Dos comandantes', sudden: 'Muerte súbita', extra: 'Contador extra', holder: 'Monarca / Iniciativa',
  day: 'Día / noche', lap: 'Corregir vuelta', turnoff: 'Quitar turnos', art: 'Fondo', vote: 'Votos de bracket', judge: 'Llamar al juez' };
function list({ eventId, podId, q, op, errors, before, limit = 200 } = {}) {
  const w = [], a = [];
  if (eventId) { w.push('l.event_id = ?'); a.push(eventId); }
  if (podId) { w.push('l.pod_id = ?'); a.push(podId); }
  if (op) { w.push('l.op = ?'); a.push(op); }
  if (errors) w.push('l.ok = 0');
  if (before) { w.push('l.id < ?'); a.push(before); }
  if (q) { w.push('(l.by_name LIKE ? OR l.account_name LIKE ? OR l.changes LIKE ?)'); a.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  return db.prepare(`SELECT l.*, e.name ev_name FROM life_audit l LEFT JOIN cmd_events e ON e.id = l.event_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY l.id DESC LIMIT ?`)
    .all(...a, limit).map(r => ({ ...r, params: JSON.parse(r.params || '{}'), changes: JSON.parse(r.changes || '[]') }));
}
const events = () => db.prepare('SELECT DISTINCT e.id, e.name, e.start_date FROM life_audit l JOIN cmd_events e ON e.id = l.event_id ORDER BY e.id DESC LIMIT 100').all();

module.exports = { record, list, events, diff, OPS };
