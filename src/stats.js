'use strict';
const { db, setting } = require('./db');
const data = require('./data');
const C = require('./commander');
const people = require('./people');

// ---------- Liga ----------
// En temporadas de Commander los eventos se guardan en season_excluded con id negativo
function seasonTournaments(season) {
  const excluded = new Set(db.prepare('SELECT tournament_id FROM season_excluded WHERE season_id = ?').all(season.id).map(r => r.tournament_id));
  if (season.game === 'commander') {
    return db.prepare(`SELECT * FROM cmd_events WHERE status = 'finished'
      AND date(COALESCE(start_date, created_at)) BETWEEN date(?) AND date(?) ORDER BY COALESCE(start_date, created_at)`)
      .all(season.start_date, season.end_date)
      .map(e => ({ ...e, id: -e.id, cmdId: e.id, start_date: e.start_date || e.created_at, excluded: excluded.has(-e.id) }));
  }
  return db.prepare(`SELECT * FROM tournaments WHERE game = ? AND status = 4 AND hidden = 0
    AND date(COALESCE(start_date, last_pair)) BETWEEN date(?) AND date(?)
    ORDER BY COALESCE(start_date, last_pair)`).all(season.game, season.start_date, season.end_date)
    .map(t => ({ ...t, excluded: excluded.has(t.id) }));
}

function commanderLeague(season, tournaments, bonus) {
  const idx = people.nameIndex();
  const table = new Map();
  for (const t of tournaments) {
    for (const s of C.standings(t.cmdId)) {
      if (!s.played) continue;
      const key = people.cmdKey(s, idx);
      const r = table.get(key) || { key, name: C.pubName(s), username: s.username, points: 0, events: 0, w: 0, l: 0, d: 0, best: null, wins: 0 };
      r.events++; r.w += s.wins; r.l += s.losses; r.d += s.draws;
      r.points += s.points + season.pts_attend + (s.rank && s.rank <= bonus.length ? bonus[s.rank - 1] : 0);
      if (s.rank === 1) r.wins++;
      if (s.rank && (r.best == null || s.rank < r.best)) r.best = s.rank;
      table.set(key, r);
    }
  }
  const rows = [...table.values()].sort((a, b) => b.points - a.points || b.w - a.w || b.events - a.events || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.pos = i > 0 && rows[i - 1].points === r.points && rows[i - 1].w === r.w ? rows[i - 1].pos : i + 1; });
  return { tournaments, rows };
}

function leagueTable(season, admin = false) {
  const tournaments = seasonTournaments(season).filter(t => !t.excluded);
  const bonus = String(season.pts_bonus || '').split(',').map(x => parseInt(x, 10) || 0);
  if (season.game === 'commander') return commanderLeague(season, tournaments, bonus);
  const table = new Map();
  const row = (p) => {
    const k = people.keyForMelee(p);
    if (!table.has(k)) {
      table.set(k, {
        key: k, name: data.playerName(p, admin), username: p.username,
        points: 0, events: 0, w: 0, l: 0, d: 0, best: null, wins: 0,
      });
    }
    return table.get(k);
  };
  for (const t of tournaments) {
    const pm = data.playersMap(t.id);
    for (const p of pm.values()) {
      if (p.status === 0) continue;
      const r = row(p);
      r.events++;
      r.points += season.pts_attend;
    }
    for (const m of db.prepare('SELECT * FROM matches WHERE tournament_id = ? AND has_result = 1').all(t.id)) {
      const a = pm.get(m.team1);
      const b = m.team2 ? pm.get(m.team2) : null;
      if (!a) continue;
      if (m.is_bye || !b) { const r = row(a); r.w++; r.points += season.pts_win; continue; }
      const ra = row(a), rb = row(b);
      if ((m.wins1 ?? 0) > (m.wins2 ?? 0)) { ra.w++; rb.l++; ra.points += season.pts_win; rb.points += season.pts_loss; }
      else if ((m.wins2 ?? 0) > (m.wins1 ?? 0)) { rb.w++; ra.l++; rb.points += season.pts_win; ra.points += season.pts_loss; }
      else { ra.d++; rb.d++; ra.points += season.pts_draw; rb.points += season.pts_draw; }
    }
    for (const s of db.prepare('SELECT * FROM standings WHERE tournament_id = ? ORDER BY rank').all(t.id)) {
      const p = pm.get(s.team_id);
      if (!p) continue;
      const r = row(p);
      if (s.rank && s.rank <= bonus.length) r.points += bonus[s.rank - 1];
      if (s.rank === 1) r.wins++;
      if (s.rank && (r.best == null || s.rank < r.best)) r.best = s.rank;
    }
  }
  const rows = [...table.values()].sort((a, b) => b.points - a.points || b.w - a.w || b.events - a.events || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.pos = i > 0 && rows[i - 1].points === r.points && rows[i - 1].w === r.w ? rows[i - 1].pos : i + 1; });
  return { tournaments, rows };
}

// ---------- Jugadores ----------
function playersOverview(game) {
  const where = game ? 'AND t.game = ?' : '';
  const args = game ? [game] : [];
  const rows = db.prepare(`SELECT p.user_key, MAX(p.username) username, MAX(p.display_name) display_name, MAX(p.full_name) full_name,
      COUNT(DISTINCT p.tournament_id) events,
      MIN(COALESCE(t.start_date, t.last_pair)) first_seen, MAX(COALESCE(t.start_date, t.last_pair)) last_seen,
      GROUP_CONCAT(DISTINCT t.game) games
    FROM players p JOIN tournaments t ON t.id = p.tournament_id
    WHERE t.status IN (2,4) AND p.status != 0 ${where}
    GROUP BY p.user_key ORDER BY events DESC, last_seen DESC`).all(...args);
  const inactiveDays = parseInt(setting('inactive_days'), 10) || 30;
  const now = Date.now();
  for (const r of rows) {
    const last = r.last_seen ? new Date(r.last_seen).getTime() : 0;
    const first = r.first_seen ? new Date(r.first_seen).getTime() : 0;
    r.daysSince = last ? Math.floor((now - last) / 864e5) : null;
    r.isNew = first && now - first < inactiveDays * 864e5;
    r.inactive = r.events >= 2 && r.daysSince != null && r.daysSince > inactiveDays;
  }
  return rows;
}

function playerProfile(userKey) {
  const entries = db.prepare(`SELECT p.*, t.name tname, t.game, t.start_date, t.last_pair, t.status tstatus,
      s.rank, s.points, s.match_record
    FROM players p JOIN tournaments t ON t.id = p.tournament_id
    LEFT JOIN standings s ON s.tournament_id = p.tournament_id AND s.team_id = p.team_id
    WHERE p.user_key = ? ORDER BY COALESCE(t.start_date, t.last_pair) DESC`).all(userKey);
  let w = 0, l = 0, d = 0;
  const rivals = new Map();
  for (const e of entries) {
    const pm = data.playersMap(e.tournament_id);
    for (const m of db.prepare('SELECT * FROM matches WHERE tournament_id = ? AND has_result = 1 AND (team1 = ? OR team2 = ?)')
      .all(e.tournament_id, e.team_id, e.team_id)) {
      if (m.is_bye) { w++; continue; }
      const me1 = m.team1 === e.team_id;
      const mine = me1 ? m.wins1 ?? 0 : m.wins2 ?? 0;
      const theirs = me1 ? m.wins2 ?? 0 : m.wins1 ?? 0;
      const opp = pm.get(me1 ? m.team2 : m.team1);
      if (mine > theirs) w++; else if (theirs > mine) l++; else d++;
      if (opp) {
        const k = opp.user_key;
        const r = rivals.get(k) || { name: data.playerName(opp, true), key: k, w: 0, l: 0, d: 0 };
        if (mine > theirs) r.w++; else if (theirs > mine) r.l++; else r.d++;
        rivals.set(k, r);
      }
    }
  }
  return { entries, w, l, d, rivals: [...rivals.values()].sort((a, b) => (b.w + b.l + b.d) - (a.w + a.l + a.d)).slice(0, 10) };
}

// ---------- Meta ----------
function meta(game, from, to) {
  return db.prepare(`SELECT d.name, COUNT(*) copies, COUNT(DISTINCT d.tournament_id) events,
      SUM(CASE WHEN s.rank = 1 THEN 1 ELSE 0 END) wins,
      SUM(CASE WHEN s.rank <= 4 THEN 1 ELSE 0 END) top4,
      ROUND(AVG(s.rank), 1) avg_rank
    FROM decklists d JOIN tournaments t ON t.id = d.tournament_id
    LEFT JOIN standings s ON s.tournament_id = d.tournament_id AND s.team_id = d.team_id
    WHERE t.game = ? AND date(COALESCE(t.start_date, t.last_pair)) BETWEEN date(?) AND date(?)
    GROUP BY d.name ORDER BY copies DESC, wins DESC`).all(game, from, to);
}

// ---------- Caja ----------
function cash(from, to) {
  const ts = db.prepare(`SELECT * FROM tournaments WHERE status IN (2,4) AND hidden = 0
    AND date(COALESCE(start_date, last_pair)) BETWEEN date(?) AND date(?)
    ORDER BY COALESCE(start_date, last_pair)`).all(from, to);
  const defPrice = Math.round(parseFloat(String(setting('default_price')).replace(',', '.')) * 100) || 0;
  return ts.map(t => {
    const c = data.counts(t.id);
    const price = t.price_cents ?? defPrice;
    const prizes = db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM prizes WHERE tournament_id = ? AND cmd_event_id IS NULL').get(t.id).s;
    return {
      id: t.id, name: t.name, game: t.game, date: t.start_date || t.last_pair,
      players: c.total || 0, paidMelee: c.paid || 0, price,
      income: (c.total || 0) * price, prizes, net: (c.total || 0) * price - prizes,
    };
  }).concat(db.prepare(`SELECT * FROM cmd_events WHERE status IN ('running','finished')
    AND date(COALESCE(start_date, created_at)) BETWEEN date(?) AND date(?)`).all(from, to).map(e => {
    const players = db.prepare('SELECT COUNT(*) c FROM cmd_players WHERE event_id = ? AND COALESCE(waitlist, 0) = 0 AND (dropped_round IS NULL OR dropped_round > 0)').get(e.id).c;
    const paid = db.prepare('SELECT COUNT(*) c FROM cmd_players WHERE event_id = ? AND paid = 1').get(e.id).c;
    const price = e.price_cents ?? defPrice;
    const prizes = db.prepare('SELECT COALESCE(SUM(amount_cents),0) s FROM prizes WHERE cmd_event_id = ?').get(e.id).s;
    return { id: e.id, cmd: true, name: e.name, game: 'commander', date: e.start_date || e.created_at, players, paidMelee: paid, price,
      income: players * price, prizes, net: players * price - prizes };
  })).sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

module.exports = { leagueTable, seasonTournaments, playersOverview, playerProfile, meta, cash };
