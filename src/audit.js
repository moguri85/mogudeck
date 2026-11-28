'use strict';
// Auditoría de acciones: todo lo que se hace desde el admin (staff) y lo que hacen los jugadores en la web (apuntarse, borrarse,
// subir o cambiar el mazo, check-in, reportar…). Se guarda quién, desde dónde, qué acción y el valor antes y después de lo que cambió.
// Funciona como middleware: antes de cada POST se fotografía lo que va a tocar y, al terminar, se compara.
const { db } = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor_kind TEXT, actor TEXT, area TEXT, action TEXT, target TEXT,
  path TEXT, params TEXT, changes TEXT, status INTEGER, device TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(id);`);

const SECRET = /pass|clave|password|token|secret|refresh|webhook|hash|claim|cookie/i;
const short = v => (v == null ? null : String(v).length > 160 ? String(v).slice(0, 157) + '…' : String(v));

// ---------- Qué se fotografía según la ruta ----------
const PL_FIELDS = { name: 'Nombre', username: 'Usuario de Melee', deck: 'Comandante', deck_value_cents: 'Valor del mazo', deck_bracket: 'Bracket', deck_legal: 'Mazo legal',
  paid: 'Pagado', paid_method: 'Forma de pago', paid_by: 'Cobrado por', waitlist: 'Lista de espera', dropped_round: 'Fuera desde la ronda', checked_in_at: 'Llegada',
  phone_locked: 'Móvil bloqueado', account_id: 'Cuenta' };
const playersOf = ev => new Map(db.prepare(`SELECT id, ${Object.keys(PL_FIELDS).join(', ')} FROM cmd_players WHERE event_id = ?`).all(ev).map(r => [r.id, r]));
const row = (table, id) => { try { return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) || null; } catch (e) { return null; } };
// Ajustes efectivos (con los valores por defecto), para que guardar el formulario sin tocar nada no salga como cambio
const settingsMap = () => { const o = require('./db').settings(); for (const k of Object.keys(o)) if (o[k] == null) o[k] = ''; return o; };
const podSnap = pod => {
  const p = row('cmd_pods', pod); if (!p) return null;
  const seats = db.prepare('SELECT s.player_id, s.place, pl.name FROM cmd_seats s JOIN cmd_players pl ON pl.id = s.player_id WHERE s.pod_id = ?').all(pod);
  return { 'Mesa': p.table_number, 'Resultado': p.reported ? 'sí' : 'no', 'Ganador': (seats.find(s => s.player_id === p.winner_id) || {}).name || null,
    ...Object.fromEntries(seats.map(s => [`Puesto de ${s.name}`, s.place])) };
};
// Devuelve { area, target, take() } para la ruta, o null si no se audita
function subject(req) {
  const p = req.path, m = (re) => p.match(re);
  let x;
  if (/\/vidas(\/|\.|$)|\/(porra|healthz|push\/|entrar$|admin\/login|admin\/logout)/.test(p)) return null; // el contador va aparte; lo demás no es una acción a auditar
  if ((x = m(/^\/admin\/commander\/(\d+)\/(jugadores|espera)\/(\d+)\//))) return { area: 'Commander', ev: +x[1], take: () => ({ players: playersOf(+x[1]) }), only: +x[3] };
  if ((x = m(/^\/admin\/commander\/(\d+)\/mesa\/(\d+)/))) return { area: 'Commander', ev: +x[1], take: () => ({ obj: podSnap(+x[2]) }) };
  if ((x = m(/^\/admin\/commander\/(\d+)(\/|$)/))) return { area: 'Commander', ev: +x[1], take: () => ({ obj: row('cmd_events', +x[1]), players: playersOf(+x[1]) }) };
  if ((x = m(/^\/commander\/(\d+)\//))) return { area: 'Commander (jugador)', ev: +x[1], take: () => ({ players: playersOf(+x[1]) }) };
  if ((x = m(/^\/admin\/torneos\/(\d+)/))) return { area: 'Torneos', target: (row('tournaments', +x[1]) || {}).name, take: () => ({ obj: row('tournaments', +x[1]) }) };
  if ((x = m(/^\/admin\/calendario\/(\d+)/))) return { area: 'Calendario', take: () => ({ obj: db.prepare('SELECT * FROM cal_acts WHERE aid = ?').get(+x[1]) || null }), target: ((db.prepare('SELECT title FROM cal_acts WHERE aid = ?').get(+x[1])) || {}).title };
  if ((x = m(/^\/admin\/cuentas\/(\d+)/))) return { area: 'Cuentas', take: () => ({ obj: row('accounts', +x[1]) }), target: (row('accounts', +x[1]) || {}).name };
  if (/^\/admin\/(ajustes|riftbound|magic)/.test(p)) return { area: 'Ajustes', take: () => ({ obj: settingsMap() }) };
  if (/^\/cuenta\//.test(p) && req.account) return { area: 'Mi cuenta', take: () => ({ obj: row('accounts', req.account.id) }) };
  if (/^\/admin\//.test(p)) return { area: p.split('/')[2] ? p.split('/')[2].replace(/^\w/, c => c.toUpperCase()) : 'Admin', take: () => ({}) };
  return { area: 'Web', take: () => ({}) };
}

// ---------- Diferencias ----------
const yn = v => (v == null ? null : Number(v) ? 'sí' : 'no');
const eur = v => (v == null ? null : `${(Number(v) / 100).toFixed(2).replace('.', ',')} €`);
const FMT = { paid: yn, waitlist: yn, deck_legal: yn, phone_locked: yn, visible: yn, hidden: yn, deck_value_cents: eur, price_cents: eur, budget_cents: eur };
function diffObj(a, b, labels) {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (/^(updated_at|synced_at|details_synced_at|version|state|last_login|seen_at|fetched_at)$/.test(k)) continue;
    const va = a ? a[k] : undefined, vb = b ? b[k] : undefined;
    if (JSON.stringify(va ?? null) === JSON.stringify(vb ?? null)) continue;
    const secret = SECRET.test(k);
    const fmt = v => (secret ? (v ? '••••' : null) : FMT[k] ? FMT[k](v) : short(v));
    out.push({ field: (labels && labels[k]) || k, from: fmt(va), to: fmt(vb) });
  }
  return out;
}
function diffPlayers(a, b, only) {
  const out = [];
  const ids = new Set([...(a ? a.keys() : []), ...(b ? b.keys() : [])]);
  for (const id of ids) {
    if (only && id !== only && a.has(id) && b.has(id)) continue;
    const pa = a.get(id), pb = b.get(id), who = (pb || pa).name;
    if (!pa) { out.push({ who, field: 'Jugador', from: null, to: 'apuntado' + (pb.waitlist ? ' (lista de espera)' : '') }); continue; }
    if (!pb) { out.push({ who, field: 'Jugador', from: 'apuntado', to: 'borrado' }); continue; }
    for (const c of diffObj(pa, pb, PL_FIELDS)) out.push({ who, ...c });
  }
  return out;
}

const ACT = { pago: 'Pago', drop: 'Dejar fuera / volver', borrar: 'Borrar', datos: 'Editar datos', mazo: 'Mazo', 'mazo-detalle': 'Lista del mazo', subir: 'Subir de la espera',
  quitar: 'Quitar de la espera', llegada: 'Llegada', bloquear: 'Bloquear móvil', liberar: 'Liberar móvil', limpiar: 'Limpiar', resetear: 'Resetear', jugadores: 'Añadir jugadores',
  jugador: 'Añadir jugador', importar: 'Importar jugadores', ajustes: 'Ajustes del evento', emparejar: 'Emparejar ronda', final: 'Mesa final', deshacer: 'Deshacer ronda', mesa: 'Resultado de mesa',
  propuesta: 'Propuesta de resultado', 'confirmar-todas': 'Confirmar resultados', terminar: 'Terminar evento', reabrir: 'Reabrir evento', cambiar: 'Cambiar mesas', timer: 'Tiempo de ronda',
  premio: 'Premio', duplicar: 'Duplicar evento', apuntarme: 'Apuntarse', borrarme: 'Borrarse', checkin: 'Check-in', reportar: 'Reportar resultado', valor: 'Validar mazo',
  publicar: 'Publicar', ocultar: 'Ocultar', editar: 'Editar', uniones: 'Unir con torneo', restaurar: 'Volver al de su web', mantener: 'Mantener el cambio', registro: 'Crear cuenta',
  mazos: 'Mis mazos', reclamar: 'Reclamar ficha', clave: 'Cambiar contraseña', conectar: 'Conectar', desconectar: 'Desconectar', leer: 'Leer ahora', anadir: 'Añadir' };
function actionOf(p) {
  if (/^\/admin\/ajustes/.test(p)) return 'Guardar ajustes';
  const segs = p.split('/').filter(Boolean).filter(s => !/^\d+$/.test(s) && s !== 'admin' && s !== 'commander');
  const last = segs[segs.length - 1] || 'crear';
  return ACT[last] || ACT[segs[segs.length - 2]] || last;
}
function device(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim().replace(/^::ffff:/, '');
  const masked = ip.includes('.') ? ip.split('.').slice(0, 3).join('.') + '.x' : ip.split(':').slice(0, 3).join(':') + ':…';
  const ua = String(req.headers['user-agent'] || '');
  return `${/iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Otro'} · ${masked}`;
}
function params(body) {
  const o = {};
  for (const [k, v] of Object.entries(body || {})) { if (SECRET.test(k) || /^(_csrf|list|deck_list|cards|names|info|text)$/.test(k)) continue; o[k] = short(v); }
  return o;
}

function middleware(req, res, next) {
  if (req.method !== 'POST') return next();
  let sub = null; try { sub = subject(req); } catch (e) { sub = null; }
  if (!sub) return next();
  let before = {}; try { before = sub.take(); } catch (e) { before = {}; }
  const startedPath = req.path, body = params(req.body);
  res.on('finish', () => {
    try {
      let after = {}; try { after = sub.take(); } catch (e) { after = {}; }
      const changes = [...(before.obj !== undefined || after.obj !== undefined ? diffObj(before.obj, after.obj).map(c => ({ who: sub.target || '', ...c })) : []),
        ...(before.players && after.players ? diffPlayers(before.players, after.players, sub.only) : [])];
      const staff = req.user && /^\/admin\//.test(startedPath);
      const acc = req.account;
      let actor = staff ? req.user.username : acc ? (acc.name || acc.email) : null;
      if (!actor && req.body && req.body.by && sub.ev) { const p = db.prepare('SELECT name FROM cmd_players WHERE id = ? AND event_id = ?').get(Number(req.body.by), sub.ev); actor = p ? `${p.name} (sin cuenta)` : null; }
      const target = sub.target || (sub.ev ? (db.prepare('SELECT name FROM cmd_events WHERE id = ?').get(sub.ev) || {}).name : null);
      // Solo se guardan las acciones que cambian algo o las que fallan (si no, sería ruido: búsquedas, vistas previas…)
      if (!changes.length && res.statusCode < 400 && !/^\/admin\//.test(startedPath)) return;
      db.prepare('INSERT INTO audit_log (at, actor_kind, actor, area, action, target, path, params, changes, status, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(Date.now(), staff ? 'staff' : acc ? 'cuenta' : 'anónimo', actor || 'anónimo', sub.area, actionOf(startedPath), target || null, startedPath,
          JSON.stringify(body), JSON.stringify(changes.slice(0, 200)), res.statusCode, device(req));
    } catch (e) { /* la auditoría nunca rompe nada */ }
  });
  next();
}

function list({ q, area, kind, before, limit = 200 } = {}) {
  const w = [], a = [];
  if (area) { w.push('area = ?'); a.push(area); }
  if (kind) { w.push('actor_kind = ?'); a.push(kind); }
  if (before) { w.push('id < ?'); a.push(before); }
  if (q) { w.push('(actor LIKE ? OR target LIKE ? OR changes LIKE ? OR action LIKE ?)'); a.push(...Array(4).fill(`%${q}%`)); }
  return db.prepare(`SELECT * FROM audit_log ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...a, limit)
    .map(r => ({ ...r, params: JSON.parse(r.params || '{}'), changes: JSON.parse(r.changes || '[]') }));
}
const areas = () => db.prepare('SELECT DISTINCT area FROM audit_log ORDER BY area').all().map(r => r.area);

module.exports = { middleware, list, areas };
