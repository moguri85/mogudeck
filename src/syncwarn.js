'use strict';
// Avisos de sincronización para el staff: todo lo que pinta mal al traer datos de Melee, playriftbound.com, EventLink y el calendario.
// Se calculan al momento (no se guardan) y salen en Inicio del admin, con un contador en el menú.
const { db, feature, setting } = require('./db');
const config = require('./config');
require('./riftbound'); // columnas linked_ref y source

const when = iso => (iso ? new Date(iso).toLocaleString('es-ES', { timeZone: config.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const SRC = { melee: 'Melee', riftbound: 'playriftbound.com', eventlink: 'EventLink' };
const ago = ms => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} días`; };

let cache = null, cacheAt = 0;
function list() {
  if (cache && Date.now() - cacheAt < 30e3) return cache;
  const out = [];
  const add = (level, text, href) => out.push({ level, text, href: href || null });
  const st = (mod, label, href) => {
    try {
      const s = require(mod).state();
      if (s.lastError) add('err', `${label}: ${s.lastError}`, href);
      return s;
    } catch (e) { return null; }
  };

  // Errores de cada fuente
  const ms = st('./sync', 'Melee', '/admin/torneos');
  if (ms && !ms.configured) add('err', 'Melee: faltan MELEE_CLIENT_ID / MELEE_CLIENT_SECRET en el .env');
  if (ms && ms.configured && ms.lastListSync && Date.now() - ms.lastListSync > 30 * 60e3) add('warn', `Melee: no se lee desde hace ${ago(Date.now() - ms.lastListSync)}`, '/admin/torneos');
  if (feature('riftbound')) {
    const rs = st('./riftbound', 'Riftbound', '/admin/riftbound');
    if (rs && rs.lastList && Date.now() - rs.lastList > 45 * 60e3) add('warn', `Riftbound: no se lee desde hace ${ago(Date.now() - rs.lastList)}`, '/admin/riftbound');
  }
  if (feature('eventlink')) {
    const es = st('./eventlink', 'EventLink', '/admin/magic');
    if (es && es.connected && es.status === 'caducada') add('err', 'EventLink: la sesión ha caducado, hay que volver a conectarla', '/admin/magic');
    if (es && es.connected && !es.org) add('warn', 'EventLink: falta el identificador de la tienda (solo se leen los eventos añadidos a mano)', '/admin/magic');
    if (es && es.pageInfo && !/eventos en su lista/.test(es.pageInfo)) add('warn', `EventLink: no se pudo leer la lista de eventos (${es.pageInfo})`, '/admin/magic');
  }
  if (feature('calendar')) {
    try {
      const cs = require('./jupcal').status();
      if (cs.lastError) add('err', `Calendario de la tienda: ${cs.lastError}`, '/admin/calendario');
      if (cs.at && Date.now() - new Date(cs.at).getTime() > 8 * 3600e3) add('warn', `Calendario de la tienda: no se lee desde hace ${ago(Date.now() - new Date(cs.at).getTime())}`, '/admin/calendario');
    } catch (e) { /* sin calendario */ }
  }

  // Torneos que se han quedado mal
  const now = Date.now();
  for (const t of db.prepare('SELECT id, name, status, status_desc, start_date, synced_at, source, last_pair FROM tournaments WHERE hidden = 0 AND status IN (1, 2)').all()) {
    const start = t.start_date ? Date.parse(t.start_date) : NaN;
    const src = SRC[t.source || 'melee'] || t.source;
    const href = `/admin/torneos/${t.id}`;
    if (t.status === 1 && !isNaN(start) && now - start > 12 * 3600e3) add('warn', `«${t.name}» (${when(t.start_date)}) sigue con la inscripción abierta en ${src}: ¿no se llegó a jugar o no se cerró?`, href);
    if (t.status === 2 && !isNaN(start) && now - start > 20 * 3600e3) add('warn', `«${t.name}» (${when(t.start_date)}) sigue «en juego» en ${src}: falta cerrarlo allí`, href);
    if (t.status === 2 && t.synced_at && now - Date.parse(t.synced_at.replace(' ', 'T') + 'Z') > 10 * 60e3) add('err', `«${t.name}» está en juego pero no se actualiza desde hace ${ago(now - Date.parse(t.synced_at.replace(' ', 'T') + 'Z'))}`, href);
    if (/\(.+\)$/.test(t.status_desc || '')) add('warn', `«${t.name}»: estado desconocido en ${src} ${t.status_desc.replace(/^.*\(/, '(')}`, href);
    if (t.status === 1 && !t.start_date && (t.source || 'melee') === 'melee') add('warn', `«${t.name}» no tiene fecha: no se pudo leer de Melee, ponla a mano`, href);
  }
  // Terminados sin clasificación
  for (const t of db.prepare(`SELECT id, name, source FROM tournaments t WHERE hidden = 0 AND status = 4 AND COALESCE(start_date, last_pair) >= datetime('now', '-14 days')
      AND NOT EXISTS (SELECT 1 FROM standings s WHERE s.tournament_id = t.id) AND EXISTS (SELECT 1 FROM matches m WHERE m.tournament_id = t.id)`).all())
    add('warn', `«${t.name}» está terminado pero ${SRC[t.source || 'melee']} no da clasificación`, `/admin/torneos/${t.id}`);
  // Mesas con resultado pendiente en rondas que ya no son la última (resultados que faltan)
  for (const r of db.prepare(`SELECT t.id, t.name, m.round_number, COUNT(*) n FROM matches m JOIN tournaments t ON t.id = m.tournament_id
      WHERE t.hidden = 0 AND m.is_bye = 0 AND m.has_result = 0 AND m.round_number < (SELECT MAX(round_number) FROM matches x WHERE x.tournament_id = t.id)
      AND COALESCE(t.start_date, t.last_pair) >= datetime('now', '-14 days') GROUP BY t.id, m.round_number`).all())
    add('warn', `«${r.name}»: ${r.n === 1 ? '1 mesa' : `${r.n} mesas`} de la ronda ${r.round_number} sin resultado`, `/admin/torneos/${r.id}`);
  // Eventos de EventLink ocultos solos (rol, juego libre) y unidos a un Commander de aquí: informativo
  const auto = db.prepare("SELECT COUNT(*) n FROM tournaments WHERE source = 'eventlink' AND hidden = 1 AND linked_ref IS NULL AND COALESCE(start_date, '') >= datetime('now', '-1 day')").get();
  if (auto && auto.n) add('info', `${auto.n === 1 ? '1 evento' : `${auto.n} eventos`} de EventLink no salen en la web por no ser torneos (rol, juego libre)`, '/admin/magic');

  cache = out; cacheAt = Date.now();
  return out;
}
const count = () => list().filter(w => w.level !== 'info').length;
const bust = () => { cache = null; };

module.exports = { list, count, bust };
