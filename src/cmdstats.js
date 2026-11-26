'use strict';
// Estadísticas de Commander: por comandante, por jugador, resumen de la noche e informe del evento.
// Salen de las mesas con resultado (y, si hay, de lo que se apuntó en el contador de vidas) y de la liga casual
const { db } = require('./db');

let cache = null, cacheAt = 0;
const TTL = 60e3;
const ts = s => (s ? new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z')).getTime() : null);

// Una fila por jugador sentado en una mesa terminada: { key, name, cmd, place, win, size, kills, killsCmd, killsPoison, avgTurn, turns, lifeEnd, eventId, podId, source }
function rows() {
  if (cache && Date.now() - cacheAt < TTL) return cache;
  const L = require('./life');
  const people = require('./people');
  const idx = people.nameIndex();
  const out = [];
  const pods = db.prepare(`SELECT pd.id, pd.size, pd.winner_id, rd.event_id, rd.created_at FROM cmd_pods pd JOIN cmd_rounds rd ON rd.id = pd.round_id
    JOIN cmd_events e ON e.id = rd.event_id WHERE pd.reported = 1 AND e.public = 1`).all();
  const seatQ = db.prepare('SELECT s.place, p.id, p.name, p.username, p.person_key, p.deck FROM cmd_seats s JOIN cmd_players p ON p.id = s.player_id WHERE s.pod_id = ?');
  const killQ = db.prepare('SELECT killer_id, how FROM cmd_kills WHERE pod_id = ?');
  const lifeQ = db.prepare('SELECT state FROM cmd_life WHERE pod_id = ?');
  for (const pd of pods) {
    const kills = killQ.all(pd.id);
    let st = null; try { const r = lifeQ.get(pd.id); st = r ? JSON.parse(r.state) : null; } catch (e) { st = null; }
    for (const s of seatQ.all(pd.id)) {
      const t = st && st.tstats && st.tstats[s.id];
      const lp = st && st.players.find(p => p.id === s.id);
      const mine = kills.filter(k => k.killer_id === s.id);
      out.push({ key: people.cmdKey(s, idx), name: s.name, cmd: L.cmdName(s.deck) || null, place: s.place || (pd.winner_id === s.id ? 1 : null), win: pd.winner_id === s.id, size: pd.size,
        kills: mine.length, killsCmd: mine.filter(k => k.how === 'comandante').length, killsPoison: mine.filter(k => k.how === 'veneno').length,
        turns: t ? t.n : 0, turnMs: t ? t.ms : 0, lifeEnd: lp ? lp.life : null, eventId: pd.event_id, podId: pd.id, source: 'torneo' });
    }
  }
  // Liga casual (solo partidas confirmadas por todos)
  try {
    const A = require('./accounts');
    for (const g of db.prepare("SELECT g.players, gp.slot, gp.account_id FROM casual_games g JOIN casual_game_players gp ON gp.game_id = g.id WHERE g.status = 'ok'").all()) {
      const ps = JSON.parse(g.players), p = ps.find(x => x.slot === g.slot);
      const acc = A.get(g.account_id); if (!acc || !p) continue;
      out.push({ key: A.personKey(acc), name: p.name, cmd: L.cmdName(p.deck) || null, place: p.place, win: p.place === 1, size: ps.length,
        kills: ps.filter(x => x.killer === p.name).length, killsCmd: 0, killsPoison: 0, turns: 0, turnMs: 0, lifeEnd: null, source: 'casual' });
    }
  } catch (e) { /* sin liga casual */ }
  cache = out; cacheAt = Date.now();
  return out;
}
const invalidate = () => { cache = null; };

function byCommander({ source } = {}) {
  const m = new Map();
  for (const r of rows()) {
    if (!r.cmd || (source && r.source !== source)) continue;
    const o = m.get(r.cmd) || { name: r.cmd, games: 0, wins: 0, kills: 0, turns: 0, turnMs: 0, players: new Set() };
    o.games++; if (r.win) o.wins++; o.kills += r.kills; o.turns += r.turns; o.turnMs += r.turnMs; o.players.add(r.key);
    m.set(r.cmd, o);
  }
  return [...m.values()].map(o => ({ ...o, players: o.players.size, rate: o.games ? o.wins / o.games : 0, avgTurn: o.turns ? o.turnMs / o.turns : null }))
    .sort((a, b) => b.wins - a.wins || b.rate - a.rate || b.games - a.games);
}
// Comandantes de una persona
function byPerson(key) {
  const m = new Map();
  for (const r of rows()) {
    if (r.key !== key || !r.cmd) continue;
    const o = m.get(r.cmd) || { name: r.cmd, games: 0, wins: 0, kills: 0 };
    o.games++; if (r.win) o.wins++; o.kills += r.kills;
    m.set(r.cmd, o);
  }
  return [...m.values()].map(o => ({ ...o, rate: o.wins / o.games })).sort((a, b) => b.games - a.games || b.wins - a.wins);
}
// Datos para insignias: por persona (todas de una vez)
function factsByKey() {
  const by = new Map();
  for (const r of rows()) { if (!by.has(r.key)) by.set(r.key, []); by.get(r.key).push(r); }
  return new Map([...by.entries()].map(([k, rs]) => [k, facts(rs)]));
}
function personFacts(key) { return facts(rows().filter(r => r.key === key)); }
function facts(rs) {
  const turns = rs.reduce((n, r) => n + r.turns, 0), ms = rs.reduce((n, r) => n + r.turnMs, 0);
  return {
    commanders: new Set(rs.filter(r => r.cmd).map(r => r.cmd)).size,
    comebacks: rs.filter(r => r.win && r.lifeEnd != null && r.lifeEnd <= 5).length,
    killsCmd: rs.reduce((n, r) => n + r.killsCmd, 0),
    killsPoison: rs.reduce((n, r) => n + r.killsPoison, 0),
    turns, avgTurn: turns ? ms / turns : null,
    casualGames: rs.filter(r => r.source === 'casual').length,
    casualWins: rs.filter(r => r.source === 'casual' && r.win).length,
    fastPods: rs.filter(r => r.turns >= 4 && r.turnMs / r.turns < 90000).length,
    winCommanders: new Set(rs.filter(r => r.cmd && r.win).map(r => r.cmd)).size,
  };
}

// Resumen de la noche de un evento (para la TV)
function nightSummary(eventId) {
  const L = require('./life');
  const pods = db.prepare(`SELECT pd.id, pd.table_number tn, rd.number rn FROM cmd_pods pd JOIN cmd_rounds rd ON rd.id = pd.round_id WHERE rd.event_id = ? AND pd.reported = 1`).all(eventId);
  if (!pods.length) return null;
  const name = new Map(db.prepare('SELECT id, name, username FROM cmd_players WHERE event_id = ?').all(eventId).map(p => [p.id, require('./commander').pubName(p)]));
  const kills = new Map(), cmdDmg = new Map();
  let longest = null, comeback = null;
  for (const pd of pods) {
    for (const k of db.prepare('SELECT killer_id FROM cmd_kills WHERE pod_id = ? AND killer_id IS NOT NULL').all(pd.id)) kills.set(k.killer_id, (kills.get(k.killer_id) || 0) + 1);
    const r = db.prepare('SELECT state FROM cmd_life WHERE pod_id = ?').get(pd.id);
    if (!r) continue;
    const st = JSON.parse(r.state);
    if (st.startedAt && st.done && st.done.at) {
      const ms = st.done.at - st.startedAt;
      if (!longest || ms > longest.ms) longest = { ms, table: pd.tn, round: pd.rn, players: st.players.map(p => p.name) };
    }
    for (const p of st.players) for (const [from, v] of Object.entries(p.cmd || {})) cmdDmg.set(Number(from), (cmdDmg.get(Number(from)) || 0) + v);
    if (st.done) {
      const w = st.players.find(p => p.id === st.done.winner);
      if (w && w.life <= 10 && (!comeback || w.life < comeback.life)) comeback = { name: w.name, life: w.life, table: pd.tn, round: pd.rn };
    }
  }
  const top = m => { const e = [...m.entries()].sort((a, b) => b[1] - a[1])[0]; return e && e[1] ? { name: name.get(e[0]) || '—', n: e[1] } : null; };
  return { kills: top(kills), cmdDmg: top(cmdDmg), longest: longest ? { ...longest, mins: Math.round(longest.ms / 60000) } : null, comeback, pods: pods.length, judge: L.judgeCalls(eventId, false).length };
}

// Informe del evento para la tienda
function eventReport(eventId) {
  const C = require('./commander');
  const L = require('./life');
  const ev = C.getEvent(eventId);
  const all = db.prepare('SELECT * FROM cmd_players WHERE event_id = ?').all(eventId);
  const rounds = db.prepare('SELECT * FROM cmd_rounds WHERE event_id = ? ORDER BY number').all(eventId).map(rd => {
    const pods = db.prepare('SELECT * FROM cmd_pods WHERE round_id = ? ORDER BY table_number').all(rd.id);
    const start = ts(rd.created_at);
    const ends = pods.map(p => ts(p.reported_at)).filter(Boolean);
    const timer = rd.timer_end ? ts(rd.timer_end) : null;
    const lifeQ = db.prepare('SELECT state FROM cmd_life WHERE pod_id = ?');
    const overtime = pods.filter(p => { const r = lifeQ.get(p.id); if (r) { const s = JSON.parse(r.state); if (s.ot || s.sudden) return true; } return timer && p.reported_at && ts(p.reported_at) > timer; }).length;
    return { number: rd.number, kind: rd.kind, pods: pods.length, reported: pods.filter(p => p.reported).length, mins: ends.length ? Math.round((Math.max(...ends) - start) / 60000) : null,
      podMins: ends.length ? Math.round(ends.reduce((n, e) => n + (e - start), 0) / ends.length / 60000) : null, overtime };
  });
  const turnStats = L.turnStats(eventId);
  return {
    ev, signed: all.length, waitlist: all.filter(p => p.waitlist).length, played: all.filter(p => !p.waitlist).length,
    checkedIn: all.filter(p => p.checked_in_at).length, dropped: all.filter(p => p.dropped_round != null).length,
    paid: ev.price_cents != null ? all.filter(p => p.paid && !p.waitlist).length : null,
    rounds, slow: turnStats.slice(0, 5), fast: turnStats.filter(t => t.n >= 3).slice(-3).reverse(),
    judge: L.judgeCalls(eventId, false), votes: L.bracketVotes(eventId).filter(v => v.up || v.down), night: nightSummary(eventId),
  };
}

module.exports = { rows, invalidate, byCommander, byPerson, personFacts, factsByKey, nightSummary, eventReport };
