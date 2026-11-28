'use strict';
const resolveKey = k => require('./identity').resolve(k);
// Consultas de lectura compartidas por vistas públicas y de administración
const { db, setting } = require('./db');
const { STATUS } = require('./melee');

function isLive(t) {
  if (!t) return false;
  if (t.status === STATUS.IN_PROGRESS) return true;
  if ([STATUS.UNPUBLISHED, STATUS.CANCELLED, STATUS.ENDED].includes(t.status)) return false;
  if (!t.last_pair) return false;
  return Date.now() - new Date(t.last_pair).getTime() < 14 * 3600e3;
}

function tournament(id) {
  return db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
}

function liveTournaments() {
  return db.prepare('SELECT * FROM tournaments WHERE status NOT IN (0,3,4) AND hidden = 0 ORDER BY start_date').all().filter(isLive);
}

function upcomingTournaments(limit = 50) {
  return db.prepare(`SELECT * FROM tournaments WHERE status IN (1) AND hidden = 0
    AND (start_date IS NULL OR start_date >= datetime('now', '-12 hours'))
    ORDER BY start_date IS NULL, start_date LIMIT ?`).all(limit).filter(t => !isLive(t));
}

function recentTournaments(limit = 10) {
  return db.prepare(`SELECT * FROM tournaments WHERE status = 4 AND hidden = 0
    ORDER BY COALESCE(start_date, last_pair) DESC LIMIT ?`).all(limit);
}

function showRealNames() { return setting('show_real_names') === '1'; }

function playerName(p, admin = false) {
  if (!p) return '—';
  if (admin || showRealNames()) return p.full_name || p.display_name || p.username || '—';
  return p.display_name || p.username || '—';
}

function playersMap(tid) {
  const map = new Map();
  for (const p of db.prepare('SELECT * FROM players WHERE tournament_id = ?').all(tid)) map.set(p.team_id, p);
  return map;
}

function currentRound(tid) {
  const r = db.prepare('SELECT MAX(round_number) r FROM matches WHERE tournament_id = ? AND published = 1').get(tid);
  return r && r.r ? r.r : 0;
}

// Emparejamientos de una ronda con nombres resueltos
function pairings(tid, round, admin = false) {
  const pm = playersMap(tid);
  const rows = db.prepare(`SELECT * FROM matches WHERE tournament_id = ? AND round_number = ? AND published = 1
    ORDER BY is_bye, table_number`).all(tid, round);
  return rows.map(m => ({
    table: m.table_number,
    bye: !!m.is_bye,
    hasResult: !!m.has_result,
    p1: playerName(pm.get(m.team1), admin),
    p2: m.team2 ? playerName(pm.get(m.team2), admin) : null,
    u1: pm.get(m.team1)?.username || '',
    u2: m.team2 ? (pm.get(m.team2)?.username || '') : '',
    t1: m.team1, t2: m.team2,
    w1: m.wins1, w2: m.wins2, d: m.draws,
    result: m.result_string,
  }));
}

// Récord y forma (resultado por ronda) de cada jugador a partir de las partidas
function records(tid) {
  const rec = new Map();
  const get = t => { if (!rec.has(t)) rec.set(t, { w: 0, l: 0, d: 0, form: [] }); return rec.get(t); };
  const rows = db.prepare('SELECT * FROM matches WHERE tournament_id = ? AND published = 1 ORDER BY round_number').all(tid);
  for (const m of rows) {
    const a = get(m.team1);
    if (m.is_bye || !m.team2) { if (m.has_result) { a.w++; a.form.push({ r: m.round_number, res: 'B' }); } continue; }
    const b = get(m.team2);
    if (!m.has_result) { a.form.push({ r: m.round_number, res: '?' }); b.form.push({ r: m.round_number, res: '?' }); continue; }
    const w1 = m.wins1 ?? 0, w2 = m.wins2 ?? 0;
    const ra = w1 > w2 ? 'W' : w2 > w1 ? 'L' : 'D';
    const rb = ra === 'W' ? 'L' : ra === 'L' ? 'W' : 'D';
    a[ra === 'W' ? 'w' : ra === 'L' ? 'l' : 'd']++; b[rb === 'W' ? 'w' : rb === 'L' ? 'l' : 'd']++;
    a.form.push({ r: m.round_number, res: ra, score: `${w1}-${w2}` }); b.form.push({ r: m.round_number, res: rb, score: `${w2}-${w1}` });
  }
  return rec;
}

// Resumen ligero para portada y TV
function summary(t) {
  const round = currentRound(t.id);
  const pr = round ? db.prepare('SELECT has_result, is_bye FROM matches WHERE tournament_id = ? AND round_number = ? AND published = 1').all(t.id, round) : [];
  const real = pr.filter(m => !m.is_bye);
  const top = db.prepare('SELECT team_id FROM standings WHERE tournament_id = ? ORDER BY rank LIMIT 1').get(t.id);
  const pm = top ? playersMap(t.id) : null;
  return {
    round, roundsTotal: t.rounds_total, timerEnd: t.timer_end,
    done: real.filter(m => m.has_result).length, total: real.length,
    players: counts(t.id).total || 0,
    winner: t.status === 4 && top ? playerName(pm.get(top.team_id)) : null,
  };
}

function standings(tid, admin = false) {
  const pm = playersMap(tid);
  return db.prepare('SELECT * FROM standings WHERE tournament_id = ? ORDER BY rank').all(tid).map(s => ({
    ...s,
    team: s.team_id,
    pkey: resolveKey(pm.get(s.team_id)?.username ? 'u:' + pm.get(s.team_id).username.toLowerCase() : pm.get(s.team_id)?.user_key),
    name: playerName(pm.get(s.team_id), admin),
    username: pm.get(s.team_id)?.username || '',
    dropped: pm.get(s.team_id)?.dropped_round || null,
  }));
}

function counts(tid) {
  return db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN dropped_round IS NULL THEN 1 ELSE 0 END) active,
    SUM(paid) paid, SUM(checked_in) checked FROM players WHERE tournament_id = ? AND status != 0`).get(tid);
}

// Cuadro de la eliminatoria (top 8…): rondas de la fase final con sus mesas en orden; las que aún no tienen rivales salen «por decidir»
function bracket(tid, admin = false) {
  const t = tournament(tid);
  if (!t || !['riftbound', 'eventlink'].includes(t.source)) return null;
  const rs = db.prepare(`SELECT * FROM rounds WHERE tournament_id = ? AND phase_sort = (SELECT MAX(phase_sort) FROM rounds WHERE tournament_id = ?) AND phase_sort > 1
    ORDER BY sort_order`).all(tid, tid);
  if (!rs.length) return null;
  const pm = playersMap(tid);
  const out = [];
  let size = null;
  rs.forEach((r, i) => {
    const ms = db.prepare('SELECT * FROM matches WHERE tournament_id = ? AND round_number = ? AND is_bye = 0 ORDER BY COALESCE(slot, 999), table_number').all(tid, r.sort_order);
    if (i === 0) size = Math.max(ms.length, 1);
    const want = Math.max(1, Math.round(size / Math.pow(2, i)));
    const list = ms.map(m => ({ slot: m.slot, table: m.table_number, p1: playerName(pm.get(m.team1), admin), p2: playerName(pm.get(m.team2), admin), t1: m.team1, t2: m.team2,
      w1: m.wins1, w2: m.wins2, has: !!m.has_result, win: m.has_result ? (m.wins1 > m.wins2 ? 1 : m.wins2 > m.wins1 ? 2 : 0) : 0 }));
    // Huecos por decidir, colocados en su posición si se conoce
    const slots = Array.from({ length: Math.max(want, list.length) }, () => null);
    for (const m of list) { const k = m.slot && m.slot <= slots.length && !slots[m.slot - 1] ? m.slot - 1 : slots.indexOf(null); slots[k] = m; }
    out.push({ name: r.name, round: r.sort_order, matches: slots });
  });
  const last = out[out.length - 1], f = last.matches.length === 1 && last.matches[0];
  return { rounds: out, champion: f && f.has && f.win ? (f.win === 1 ? f.p1 : f.p2) : null, current: out.some(r => r.round === currentRound(tid)) };
}

function liveSnapshot(tid, admin = false) {
  const t = tournament(tid);
  if (!t) return null;
  const round = currentRound(tid);
  const pr = round ? pairings(tid, round, admin) : [];
  return {
    id: t.id,
    name: t.name,
    game: t.game,
    status: t.status,
    statusDesc: t.status_desc,
    live: isLive(t),
    round,
    roundsTotal: t.rounds_total,
    timerEnd: t.timer_end,
    timerState: t.timer_state,
    startDate: t.start_date,
    pairings: pr,
    pending: pr.filter(p => !p.bye && !p.hasResult).length,
    done: pr.filter(p => !p.bye && p.hasResult).length,
    tables: pr.filter(p => !p.bye).length,
    rounds: Array.from({ length: round }, (_, i) => ({ round: i + 1, pairings: i + 1 === round ? pr : pairings(tid, i + 1, admin) })),
    records: Object.fromEntries([...records(tid)].map(([k, v]) => [k, v])),
    roster: [...playersMap(tid).values()].filter(p => p.status !== 0).map(p => ({ team: p.team_id, name: playerName(p, admin), username: p.username || '', dropped: p.dropped_round,
      pkey: resolveKey(p.username ? 'u:' + p.username.toLowerCase() : p.user_key) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    standings: standings(tid, admin),
    bracket: bracket(tid, admin),
    roundName: t.source && t.source !== 'melee' && round ? (db.prepare('SELECT name FROM rounds WHERE tournament_id = ? AND sort_order = ?').get(tid, round) || {}).name || null : null,
    players: counts(tid),
    syncedAt: t.synced_at,
  };
}

module.exports = {
  bracket,
  isLive, tournament, liveTournaments, upcomingTournaments, recentTournaments, pairings, standings,
  currentRound, liveSnapshot, playerName, playersMap, counts, records, summary,
};
