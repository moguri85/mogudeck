'use strict';
// Enfrentamientos entre personas (Melee 1 contra 1 y mesas de Commander): cara a cara, némesis y revanchas.
const { db } = require('./db');
const data = require('./data');
const I = require('./identity');

let cache = null, cacheAt = 0;
const TTL = 15e3;

// Lista de enfrentamientos: { a, b, ra (resultado de a: W/L/D/N), game, source, eventId, event, href, date, round, table }
// N = estaban en la misma mesa de Commander pero ganó otro.
function build() {
  const people = require('./people');
  const out = [];
  // Melee
  const ts = db.prepare('SELECT id, name, game, start_date, last_pair FROM tournaments WHERE status IN (2,4) AND hidden = 0').all();
  for (const t of ts) {
    const pm = data.playersMap(t.id);
    const keyOf = team => { const p = pm.get(team); return p ? I.resolve(p.username ? 'u:' + p.username.toLowerCase() : p.user_key) : null; };
    for (const m of db.prepare('SELECT * FROM matches WHERE tournament_id = ? AND has_result = 1 AND is_bye = 0 AND team2 IS NOT NULL').all(t.id)) {
      const a = keyOf(m.team1), b = keyOf(m.team2);
      if (!a || !b || a === b) continue;
      const w1 = m.wins1 ?? 0, w2 = m.wins2 ?? 0;
      out.push({ a, b, ra: w1 > w2 ? 'W' : w2 > w1 ? 'L' : 'D', game: t.game, source: 'melee', eventId: t.id, event: t.name,
        href: `/t/${t.id}`, date: t.start_date || t.last_pair, at: m.created_at, round: m.round_number, table: m.table_number, score: `${w1}-${w2}` });
    }
  }
  // Commander (solo eventos públicos)
  const idx = people.nameIndex();
  const pods = db.prepare(`SELECT pd.*, rd.number rnum, rd.created_at rat, e.id eid, e.name ename, e.start_date, e.created_at FROM cmd_pods pd
    JOIN cmd_rounds rd ON rd.id = pd.round_id JOIN cmd_events e ON e.id = rd.event_id WHERE pd.reported = 1 AND e.public = 1`).all();
  const seatQ = db.prepare('SELECT s.place, p.id, p.name, p.username, p.person_key FROM cmd_seats s JOIN cmd_players p ON p.id = s.player_id WHERE s.pod_id = ?');
  for (const pd of pods) {
    const seats = seatQ.all(pd.id).map(s => ({ ...s, key: people.cmdKey(s, idx), place: s.place || (pd.winner_id === s.id ? 1 : null) }));
    for (let x = 0; x < seats.length; x++) for (let y = x + 1; y < seats.length; y++) {
      const A = seats[x], B = seats[y];
      if (A.key === B.key) continue;
      let ra = 'N';
      if (pd.is_draw) ra = 'D';
      else if (A.place && B.place) ra = A.place < B.place ? 'W' : A.place > B.place ? 'L' : 'D';
      else if (pd.winner_id === A.id) ra = 'W';
      else if (pd.winner_id === B.id) ra = 'L';
      out.push({ a: A.key, b: B.key, ra, game: 'commander', source: 'commander', eventId: pd.eid, event: pd.ename,
        href: `/commander/${pd.eid}`, date: pd.start_date || pd.created_at, at: pd.rat, round: pd.rnum, table: pd.table_number, podSize: pd.size });
    }
  }
  return out;
}
function all() {
  if (!cache || Date.now() - cacheAt > TTL) { cache = build(); cacheAt = Date.now(); }
  return cache;
}
function invalidate() { cache = null; }

const flip = r => ({ W: 'L', L: 'W', D: 'D', N: 'N' }[r]);
// Enfrentamientos de una persona, desde su punto de vista
function of(key) {
  key = I.resolve(key);
  const out = [];
  for (const e of all()) {
    if (e.a === key) out.push({ ...e, me: key, opp: e.b, r: e.ra });
    else if (e.b === key) out.push({ ...e, me: key, opp: e.a, r: flip(e.ra), score: e.score ? e.score.split('-').reverse().join('-') : undefined });
  }
  return out.sort((x, y) => String(y.date).localeCompare(String(x.date)) || (y.round || 0) - (x.round || 0));
}
function tally(list) {
  const t = { w: 0, l: 0, d: 0, n: 0, games: list.length };
  for (const e of list) t[{ W: 'w', L: 'l', D: 'd', N: 'n' }[e.r]]++;
  return t;
}
// Cara a cara entre dos personas
function h2h(a, b) {
  a = I.resolve(a); b = I.resolve(b);
  const list = of(a).filter(e => e.opp === b);
  return { a, b, list, ...tally(list) };
}
// Rivales de una persona con su balance, némesis (quien más le gana) y víctima favorita
function rivals(key) {
  const by = new Map();
  for (const e of of(key)) {
    if (!by.has(e.opp)) by.set(e.opp, []);
    by.get(e.opp).push(e);
  }
  const list = [...by.entries()].map(([opp, l]) => ({ key: opp, ...tally(l), last: l[0] }));
  list.sort((x, y) => (y.w + y.l + y.d) - (x.w + x.l + x.d) || y.games - x.games);
  const nemesis = list.filter(r => r.l >= 2 && r.l > r.w).sort((x, y) => (y.l - y.w) - (x.l - x.w) || y.l - x.l)[0] || null;
  const victim = list.filter(r => r.w >= 2 && r.w > r.l).sort((x, y) => (y.w - y.l) - (x.w - x.l) || y.w - x.w)[0] || null;
  return { list, nemesis, victim };
}
// ¿Es una revancha? (antes de este evento ya se habían enfrentado con resultado y uno es némesis del otro o llevan 2+ duelos)
function rematch(a, b, exceptEvent) {
  if (!a || !b || a === b) return null;
  const list = h2h(a, b).list.filter(e => !(exceptEvent && e.eventId === exceptEvent.id && e.source === exceptEvent.source) && e.r !== 'N');
  if (!list.length) return null;
  const t = tally(list);
  const na = rivals(a).nemesis, nb = rivals(b).nemesis;
  const nem = (na && na.key === b) ? 'a' : (nb && nb.key === a) ? 'b' : null;
  if (!nem && t.w + t.l + t.d < 2) return null;
  return { ...t, nemesis: nem };
}

module.exports = { all, of, h2h, rivals, rematch, invalidate, tally };
