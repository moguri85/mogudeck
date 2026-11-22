'use strict';
// Personas unificadas: jugadores de torneos de Melee y de Commander bajo una misma ficha.
// Clave: «u:usuario_de_melee» si se conoce; si no, «n:nombre» (jugadores apuntados a mano en Commander).
const { db, setting } = require('./db');
const data = require('./data');
const C = require('./commander');

const I = require('./identity');

const low = s => String(s || '').trim().toLowerCase();
const meleeKey = p => I.resolve(p.username ? 'u:' + low(p.username) : p.user_key);

// Índice nombre real → usuario de Melee, para enlazar a los apuntados a mano en Commander
function nameIndex() {
  const idx = new Map();
  for (const r of db.prepare('SELECT DISTINCT username, full_name, display_name FROM players WHERE username IS NOT NULL').all()) {
    for (const n of [r.full_name, r.display_name]) {
      const k = low(n);
      if (!k) continue;
      if (!idx.has(k)) idx.set(k, new Set());
      idx.get(k).add(low(r.username));
    }
  }
  return idx;
}
// Vínculo automático: nombre idéntico a un único jugador de Melee (reversible con «Separar»)
function autoMatch(name, idx) {
  const m = idx.get(low(name));
  if (!m || m.size !== 1) return null;
  const u = 'u:' + [...m][0];
  return I.isNotSame('n:' + low(name), u) ? null : u;
}
function rawCmdKey(p, idx) {
  if (p.person_key) return p.person_key;
  if (p.username) return 'u:' + low(p.username);
  const n = 'n:' + low(p.name);
  if (I.resolve(n) !== n) return n;
  return autoMatch(p.name, idx) || n;
}
function cmdKey(p, idx) { return I.resolve(rawCmdKey(p, idx || nameIndex())); }

const realNames = () => setting('show_real_names') === '1';

// Todas las participaciones (una por persona y evento)
function entries() {
  const out = [];
  const melee = db.prepare(`SELECT p.*, t.name tname, t.game, t.start_date, t.last_pair, t.status tstatus,
      s.rank, s.points, s.match_record
    FROM players p JOIN tournaments t ON t.id = p.tournament_id
    LEFT JOIN standings s ON s.tournament_id = p.tournament_id AND s.team_id = p.team_id
    WHERE t.status IN (2,4) AND t.hidden = 0 AND p.status != 0`).all();
  const recCache = new Map();
  for (const p of melee) {
    if (!recCache.has(p.tournament_id)) recCache.set(p.tournament_id, data.records(p.tournament_id));
    const r = recCache.get(p.tournament_id).get(p.team_id) || { w: 0, l: 0, d: 0 };
    out.push({
      key: meleeKey(p), source: 'melee', eventId: p.tournament_id, href: `/t/${p.tournament_id}`, adminHref: `/admin/torneos/${p.tournament_id}`,
      event: p.tname, game: p.game, date: p.start_date || p.last_pair, finished: p.tstatus === 4,
      rank: p.rank, points: p.points, record: p.match_record || `${r.w}-${r.l}-${r.d}`, w: r.w, l: r.l, d: r.d,
      username: p.username, display: p.display_name, full: p.full_name, teamId: p.team_id,
    });
  }
  const idx = nameIndex();
  for (const ev of db.prepare("SELECT * FROM cmd_events WHERE status IN ('running','finished')").all()) {
    for (const s of C.standings(ev.id)) {
      if (!s.played && !s.finalist) continue;
      out.push({
        key: cmdKey(s, idx), source: 'commander', eventId: ev.id, href: `/commander/${ev.id}`, adminHref: `/admin/commander/${ev.id}`,
        event: ev.name, game: 'commander', date: ev.start_date || ev.created_at, finished: ev.status === 'finished', public: !!ev.public,
        rank: s.rank, points: s.points, record: `${s.wins}-${s.losses}-${s.draws}`, w: s.wins, l: s.losses, d: s.draws,
        username: s.username, display: s.username || s.name, full: s.name, playerId: s.id, deck: s.deck,
      });
    }
  }
  return out;
}

function nameFor(list, admin, key) {
  const withUser = list.find(e => e.username);
  const full = (list.find(e => e.full && e.source === 'melee') || list.find(e => e.full) || {}).full;
  const nick = key ? (I.info(key) || {}).nick : null;
  if (admin || realNames()) return full || nick || (withUser && withUser.username) || '—';
  return nick || (withUser && (withUser.display || withUser.username)) || full || '—';
}

function overview(game) {
  const all = entries();
  const groups = new Map();
  for (const e of all) {
    if (!groups.has(e.key)) groups.set(e.key, []);
    groups.get(e.key).push(e);
  }
  const inactiveDays = parseInt(setting('inactive_days'), 10) || 30;
  const now = Date.now();
  const rows = [];
  for (const [key, list] of groups) {
    const games = [...new Set(list.map(e => e.game))];
    if (game && !games.includes(game)) continue;
    const dates = list.map(e => e.date).filter(Boolean).sort();
    const first = dates[0], last = dates[dates.length - 1];
    const daysSince = last ? Math.floor((now - new Date(last).getTime()) / 864e5) : null;
    rows.push({
      key, name: nameFor(list, true, key), username: (list.find(e => e.username) || {}).username || '',
      events: list.length, titles: list.filter(e => e.finished && e.rank === 1).length,
      first_seen: first, last_seen: last, games, daysSince,
      isNew: first && now - new Date(first).getTime() < inactiveDays * 864e5,
      inactive: list.length >= 2 && daysSince != null && daysSince > inactiveDays,
    });
  }
  return rows.sort((a, b) => b.events - a.events || String(b.last_seen).localeCompare(String(a.last_seen)));
}

function profile(key, { admin = false } = {}) {
  key = I.resolve(key);
  const list = entries().filter(e => e.key === key && (admin || e.source !== 'commander' || e.public))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!list.length) return null;
  const sum = k => list.reduce((s, e) => s + (e[k] || 0), 0);
  const byGame = new Map();
  for (const e of list) {
    const g = byGame.get(e.game) || { game: e.game, events: 0, w: 0, l: 0, d: 0, titles: 0, best: null };
    g.events++; g.w += e.w; g.l += e.l; g.d += e.d;
    if (e.finished && e.rank === 1) g.titles++;
    if (e.finished && e.rank && (g.best == null || e.rank < g.best)) g.best = e.rank;
    byGame.set(e.game, g);
  }
  // Rivales frecuentes (solo partidas 1 contra 1 de Melee)
  const rivals = new Map();
  const others = admin ? entries() : null;
  if (admin) {
    const keyOfTeam = new Map(others.filter(e => e.source === 'melee').map(e => [`${e.eventId}:${e.teamId}`, e]));
    for (const e of list.filter(x => x.source === 'melee')) {
      for (const m of db.prepare('SELECT * FROM matches WHERE tournament_id = ? AND has_result = 1 AND is_bye = 0 AND (team1 = ? OR team2 = ?)').all(e.eventId, e.teamId, e.teamId)) {
        const me1 = m.team1 === e.teamId;
        const opp = keyOfTeam.get(`${e.eventId}:${me1 ? m.team2 : m.team1}`);
        if (!opp) continue;
        const mine = me1 ? m.wins1 ?? 0 : m.wins2 ?? 0, theirs = me1 ? m.wins2 ?? 0 : m.wins1 ?? 0;
        const r = rivals.get(opp.key) || { key: opp.key, name: nameFor([opp], true, opp.key), w: 0, l: 0, d: 0 };
        if (mine > theirs) r.w++; else if (theirs > mine) r.l++; else r.d++;
        rivals.set(opp.key, r);
      }
    }
  }
  return {
    key, name: nameFor(list, admin, key), username: (list.find(e => e.username) || {}).username || '',
    entries: list, events: list.length, w: sum('w'), l: sum('l'), d: sum('d'),
    titles: list.filter(e => e.finished && e.rank === 1).length,
    top3: list.filter(e => e.finished && e.rank && e.rank <= 3).length,
    games: [...byGame.values()].sort((a, b) => b.events - a.events),
    rivals: [...rivals.values()].sort((a, b) => (b.w + b.l + b.d) - (a.w + a.l + a.d)).slice(0, 10),
  };
}

// Clave pública de persona para un jugador de un torneo de Melee o de Commander (para enlazar desde las clasificaciones)
function keyForMelee(p) { return meleeKey(p); }
function keyForCommander(p) { return cmdKey(p, nameIndex()); }

// ---------- Directorio de personas (para sugerencias y duplicados) ----------
// Incluye a cualquiera que aparezca en Melee o en Commander, haya jugado o no.
function directory() {
  const idx = nameIndex();
  const persons = new Map();
  const get = key => {
    if (!persons.has(key)) persons.set(key, { key, names: new Set(), usernames: new Set(), events: new Set(), games: new Set(), raw: new Set() });
    return persons.get(key);
  };
  for (const r of db.prepare(`SELECT p.username, p.user_key, p.full_name, p.display_name, p.tournament_id, t.game
      FROM players p JOIN tournaments t ON t.id = p.tournament_id WHERE t.hidden = 0 AND p.status != 0`).all()) {
    const raw = r.username ? 'u:' + low(r.username) : r.user_key;
    if (!raw) continue;
    const pr = get(I.resolve(raw));
    pr.raw.add(raw);
    if (r.full_name) pr.names.add(r.full_name);
    if (r.display_name && r.display_name !== r.username) pr.names.add(r.display_name);
    if (r.username) pr.usernames.add(r.username);
    pr.events.add('m' + r.tournament_id); pr.games.add(r.game);
  }
  for (const r of db.prepare('SELECT id, event_id, name, username, person_key FROM cmd_players').all()) {
    const raw = rawCmdKey(r, idx);
    const pr = get(I.resolve(raw));
    pr.raw.add(raw);
    if (!r.person_key && !r.username && raw !== 'n:' + low(r.name)) pr.raw.add('n:' + low(r.name));
    pr.names.add(r.name);
    if (r.username) pr.usernames.add(r.username);
    pr.events.add('c' + r.event_id); pr.games.add('commander');
  }
  const out = [];
  for (const pr of persons.values()) {
    const inf = I.info(pr.key);
    const extra = inf ? [inf.nick, ...(inf.aliases || '').split(',')].filter(Boolean).map(s => s.trim()) : [];
    const names = [...pr.names];
    out.push({
      key: pr.key, name: names[0] || [...pr.usernames][0] || pr.key.slice(2), names, usernames: [...pr.usernames],
      nick: inf && inf.nick, events: pr.events.size, games: [...pr.games], raw: [...pr.raw],
      variants: [...new Set([...names, ...pr.usernames, ...extra].map(I.norm).filter(Boolean))],
      handles: [...new Set([...pr.usernames, inf && inf.nick].filter(Boolean).map(s => I.norm(s).replace(/ /g, '')))],
    });
  }
  // Nombre principal: el de Melee si lo hay
  const full = new Map(db.prepare('SELECT lower(username) u, full_name FROM players WHERE username IS NOT NULL AND full_name IS NOT NULL').all().map(r => [r.u, r.full_name]));
  for (const p of out) if (p.key.startsWith('u:') && full.has(p.key.slice(2))) p.name = full.get(p.key.slice(2));
  return out;
}

const pubPerson = p => ({ key: p.key, name: p.name, usernames: p.usernames, nick: p.nick || null, events: p.events, games: p.games });

// Sugerencias para un nombre escrito a mano (autocompletar y «¿Es X?»)
function suggest(q, { limit = 8, dir } = {}) {
  const nq = I.norm(q);
  if (nq.length < 2) return [];
  const me = { variants: [nq], handles: [nq.replace(/ /g, '')] };
  const res = [];
  for (const p of dir || directory()) {
    let best = I.personScore(me, p);
    if (!best && p.variants.some(v => v.startsWith(nq) || v.split(' ').some(t => t.length >= 3 && t.startsWith(nq)))) best = { s: 0.5, why: 'empieza igual' };
    if (best) res.push({ ...pubPerson(p), score: best.s, why: best.why });
  }
  return res.sort((a, b) => b.score - a.score || b.events - a.events).slice(0, limit);
}

// Parejas que probablemente son la misma persona (no unidas y no marcadas como distintas)
function duplicates(dir) {
  dir = dir || directory();
  const buckets = new Map();
  dir.forEach((p, i) => {
    const toks = new Set();
    for (const v of p.variants) { v.split(' ').filter(t => t.length >= 3).forEach(t => toks.add(t)); toks.add('#' + v.replace(/ /g, '')); }
    for (const t of toks) { if (!buckets.has(t)) buckets.set(t, []); buckets.get(t).push(i); }
  });
  const seen = new Set(), out = [];
  for (const list of buckets.values()) {
    if (list.length < 2 || list.length > 60) continue;
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const a = dir[list[x]], b = dir[list[y]];
      const pk = I.pairKey(a.key, b.key);
      if (seen.has(pk)) continue;
      seen.add(pk);
      const r = I.personScore(a, b);
      if (!r || r.s < 0.75) continue;
      if (a.key.startsWith('u:') && b.key.startsWith('u:') && r.s < 0.95) continue; // dos cuentas de Melee: solo si coincide el nombre completo
      if (I.isNotSame(a.key, b.key)) continue;
      const [main, other] = principal(a, b);
      out.push({ a: pubPerson(main), b: pubPerson(other), score: r.s, why: r.why });
    }
  }
  return out.sort((p, q) => q.score - p.score);
}

// Cuál se queda como ficha principal: la de Melee; si no, la que tiene más torneos
function principal(a, b) {
  const ua = a.key.startsWith('u:'), ub = b.key.startsWith('u:');
  if (ua !== ub) return ua ? [a, b] : [b, a];
  return a.events >= b.events ? [a, b] : [b, a];
}
function merge(k1, k2, by) {
  const dir = directory();
  const a = dir.find(p => p.key === I.resolve(k1)), b = dir.find(p => p.key === I.resolve(k2));
  if (!a || !b || a.key === b.key) return null;
  const [main, other] = principal(a, b);
  I.link(other.key, main.key, { by, kind: 'manual' });
  // Lo que la ficha unida tenía en «ficha» (nick, alias, notas) se suma a la principal
  const oi = I.info(other.key);
  if (oi) {
    const mi = I.info(main.key) || {};
    I.saveInfo(main.key, { nick: mi.nick || oi.nick, aliases: [mi.aliases, oi.aliases].filter(Boolean).join(', '), notes: [mi.notes, oi.notes].filter(Boolean).join('\n') });
  }
  return main.key;
}

// Vínculos que hay ahora: los hechos a mano y los automáticos por nombre idéntico
function allLinks() {
  const dir = new Map(directory().map(p => [p.key, p]));
  const label = k => { const p = dir.get(I.resolve(k)); return p ? p.name : k.slice(2); };
  const manual = I.links().map(l => ({ ...l, srcLabel: l.src.slice(2), dstLabel: label(l.dst), dstKey: I.resolve(l.dst) }));
  const idx = nameIndex();
  const auto = new Map();
  for (const r of db.prepare('SELECT name, COUNT(DISTINCT event_id) n FROM cmd_players WHERE username IS NULL AND person_key IS NULL GROUP BY lower(name)').all()) {
    const n = 'n:' + low(r.name);
    if (I.resolve(n) !== n) continue;
    const u = autoMatch(r.name, idx);
    if (u) auto.set(n, { src: n, dst: u, kind: 'auto', srcLabel: r.name, dstLabel: label(u), dstKey: I.resolve(u), events: r.n });
  }
  return { manual, auto: [...auto.values()] };
}

// Deshace un vínculo. En los automáticos se recuerda que no son la misma persona.
function separate(src, dst, by) {
  const l = I.links().find(x => x.src === src);
  if (l && I.unlink(src)) { I.markNotSame(src, l.dst, by); return true; }
  if (src.startsWith('n:') && dst) { I.markNotSame(src, dst, by); return true; }
  return false;
}

module.exports = { entries, overview, profile, keyForMelee, keyForCommander, cmdKey, nameIndex, directory, suggest, duplicates, merge, allLinks, separate, principal };
