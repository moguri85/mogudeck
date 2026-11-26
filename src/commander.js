'use strict';
// Torneos multijugador (Commander) gestionados en esta web: mesas de 3/4, suizo y desempates.
const { db, setting } = require('./db');

// Nombre público: usuario de Melee salvo que en Ajustes se permita el nombre real
const pubName = p => (setting('show_real_names') === '1' || !p.username ? p.name : p.username);

db.exec(`
CREATE TABLE IF NOT EXISTS cmd_events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT,
  melee_tournament_id INTEGER,
  rounds_planned INTEGER DEFAULT 4,
  round_minutes INTEGER DEFAULT 75,
  draw_points INTEGER DEFAULT 1,
  three_pods TEXT DEFAULT 'bottom',
  tiebreak TEXT DEFAULT 'points',
  final_top4 INTEGER DEFAULT 0,
  status TEXT DEFAULT 'setup',
  price_cents INTEGER,
  public INTEGER DEFAULT 1,
  notified_round INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cmd_players (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES cmd_events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  username TEXT,
  user_key TEXT,
  dropped_round INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cmdp_event ON cmd_players(event_id);
CREATE TABLE IF NOT EXISTS cmd_rounds (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES cmd_events(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'swiss',
  timer_end TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cmd_pods (
  id INTEGER PRIMARY KEY,
  round_id INTEGER NOT NULL REFERENCES cmd_rounds(id) ON DELETE CASCADE,
  table_number INTEGER NOT NULL,
  size INTEGER NOT NULL,
  winner_id INTEGER,
  is_draw INTEGER DEFAULT 0,
  reported INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cmd_seats (
  pod_id INTEGER NOT NULL REFERENCES cmd_pods(id) ON DELETE CASCADE,
  player_id INTEGER NOT NULL REFERENCES cmd_players(id) ON DELETE CASCADE,
  seat INTEGER NOT NULL,
  PRIMARY KEY (pod_id, player_id)
);
`);

const { addColumn } = require('./db');
addColumn('cmd_pods', 'proposed_winner', 'INTEGER');
addColumn('cmd_pods', 'proposed_draw', 'INTEGER DEFAULT 0');
addColumn('cmd_pods', 'proposed_by', 'INTEGER');
addColumn('cmd_pods', 'proposed_at', 'TEXT');
addColumn('cmd_players', 'deck', 'TEXT');
addColumn('cmd_events', 'info', 'TEXT');
addColumn('cmd_events', 'self_report', 'INTEGER DEFAULT 1');
addColumn('cmd_events', 'budget_cents', 'INTEGER');
addColumn('cmd_players', 'deck_value_cents', 'INTEGER');
addColumn('cmd_players', 'deck_value_at', 'TEXT');
addColumn('cmd_players', 'deck_list', 'TEXT');
addColumn('cmd_players', 'deck_detail', 'TEXT');
addColumn('cmd_events', 'budget_ex_basics', 'INTEGER DEFAULT 1');
addColumn('cmd_events', 'budget_ex_commander', 'INTEGER DEFAULT 0');
addColumn('cmd_events', 'budget_lock', 'INTEGER DEFAULT 1');
addColumn('cmd_players', 'person_key', 'TEXT');
// Puntuación configurable: 'size' (el ganador suma según el tamaño de la mesa) o 'places' (puntos por puesto: 1º, 2º, 3º, 4º)
addColumn('cmd_events', 'scoring', "TEXT DEFAULT 'size'");
addColumn('cmd_events', 'pts_win4', 'INTEGER DEFAULT 4');
addColumn('cmd_events', 'pts_win3', 'INTEGER DEFAULT 3');
addColumn('cmd_events', 'pts_loss', 'INTEGER DEFAULT 0');
addColumn('cmd_events', 'pts_places', "TEXT DEFAULT '3,2,1,0'");
addColumn('cmd_seats', 'place', 'INTEGER');
addColumn('cmd_events', 'bracket_max', 'INTEGER');
addColumn('cmd_players', 'deck_bracket', 'INTEGER');
addColumn('cmd_events', 'avoid_regulars', 'INTEGER DEFAULT 1');
addColumn('cmd_pods', 'reported_at', 'TEXT');
addColumn('cmd_events', 'finished_at', 'TEXT');
addColumn('cmd_events', 'balance_bracket', 'INTEGER DEFAULT 1');
addColumn('cmd_players', 'deck_legal', 'INTEGER');
addColumn('cmd_events', 'legal_check', 'INTEGER DEFAULT 0');
addColumn('cmd_events', 'checkin_code', 'TEXT');
addColumn('cmd_players', 'checked_in_at', 'TEXT');
addColumn('cmd_pods', 'proposed_places', 'TEXT');
addColumn('cmd_players', 'claim_hash', 'TEXT');
addColumn('cmd_players', 'claim_at', 'TEXT');
addColumn('cmd_players', 'phone_locked', 'INTEGER DEFAULT 0');
// Cuentas, inscripción desde la web, lista de espera y pagos
addColumn('cmd_players', 'account_id', 'INTEGER');
addColumn('cmd_players', 'paid', 'INTEGER DEFAULT 0');
addColumn('cmd_players', 'paid_at', 'TEXT');
addColumn('cmd_players', 'paid_method', 'TEXT');
addColumn('cmd_players', 'paid_by', 'TEXT');
addColumn('cmd_players', 'waitlist', 'INTEGER DEFAULT 0');
addColumn('cmd_players', 'signed_via', 'TEXT');
addColumn('cmd_players', 'signed_at', 'TEXT');
addColumn('cmd_events', 'self_signup', 'INTEGER DEFAULT 0');
addColumn('cmd_events', 'max_players', 'INTEGER');
db.exec(`CREATE TABLE IF NOT EXISTS cmd_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER, player_id INTEGER, action TEXT, detail TEXT, ip TEXT, ua TEXT, at TEXT DEFAULT (datetime('now'))
)`);

// ---------- Utilidades ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

// Tamaños de mesa: solo 4 y 3, el máximo número de mesas de 4. Nunca mesas de 2.
// 5 jugadores es el único caso imposible: se devuelve una mesa de 5.
function podSizes(n) {
  if (n < 3) return null;
  if (n === 5) return [5];
  const threes = (4 - (n % 4)) % 4;
  const fours = (n - 3 * threes) / 4;
  return [...Array(fours).fill(4), ...Array(threes).fill(3)];
}

// Rondas de suizo según jugadores: es también el máximo permitido (se pueden jugar menos)
function recommendedRounds(n) {
  if (n <= 8) return 3;
  if (n <= 16) return 4;
  if (n <= 32) return 5;
  return 6;
}

// Máximo de rondas suizas del evento: según los jugadores que han empezado (o los apuntados si aún no empezó)
function maxSwissRounds(eventId) {
  const started = db.prepare(`SELECT COUNT(DISTINCT s.player_id) c FROM cmd_seats s JOIN cmd_pods pd ON pd.id = s.pod_id
    JOIN cmd_rounds r ON r.id = pd.round_id WHERE r.event_id = ? AND r.kind = 'swiss'`).get(eventId).c;
  const n = started || db.prepare('SELECT COUNT(*) c FROM cmd_players WHERE event_id = ? AND dropped_round IS NULL AND COALESCE(waitlist, 0) = 0').get(eventId).c;
  return recommendedRounds(n);
}
function roundLimit(eventId) {
  const ev = getEvent(eventId);
  return Math.min(ev.rounds_planned || 99, maxSwissRounds(eventId));
}

// Limpieza al terminar o al completar una ronda: sin relojes activos
function stopTimers(eventId, roundId = null) {
  if (roundId) db.prepare('UPDATE cmd_rounds SET timer_end = NULL WHERE id = ?').run(roundId);
  else db.prepare('UPDATE cmd_rounds SET timer_end = NULL WHERE event_id = ?').run(eventId);
}

function finishEvent(eventId) {
  db.transaction(() => {
    stopTimers(eventId);
    db.prepare("UPDATE cmd_events SET status = 'finished', finished_at = datetime('now') WHERE id = ?").run(eventId);
  })();
}

// ---------- Lecturas ----------
const getEvent = id => db.prepare('SELECT * FROM cmd_events WHERE id = ?').get(id);
const players = id => db.prepare('SELECT * FROM cmd_players WHERE event_id = ? AND COALESCE(waitlist, 0) = 0 ORDER BY name COLLATE NOCASE').all(id);
const waitlisted = id => db.prepare('SELECT * FROM cmd_players WHERE event_id = ? AND waitlist = 1 ORDER BY signed_at, id').all(id);
const rounds = id => db.prepare('SELECT * FROM cmd_rounds WHERE event_id = ? ORDER BY number').all(id);

function podsOfRound(roundId) {
  const pods = db.prepare('SELECT * FROM cmd_pods WHERE round_id = ? ORDER BY table_number').all(roundId);
  const seatQ = db.prepare(`SELECT s.seat, s.place, p.id, p.name, p.username, p.deck FROM cmd_seats s JOIN cmd_players p ON p.id = s.player_id
    WHERE s.pod_id = ? ORDER BY s.seat`);
  return pods.map(p => ({ ...p, players: seatQ.all(p.id) }));
}

function currentRound(eventId) {
  return db.prepare('SELECT * FROM cmd_rounds WHERE event_id = ? ORDER BY number DESC LIMIT 1').get(eventId) || null;
}

function roundComplete(roundId) {
  return db.prepare('SELECT COUNT(*) c FROM cmd_pods WHERE round_id = ? AND reported = 0').get(roundId).c === 0;
}

// ---------- Puntuación ----------
function placesList(ev) {
  return String(ev.pts_places || '3,2,1,0').split(/[,;\s]+/).map(Number).filter(n => Number.isFinite(n));
}
// Puntos de un jugador en una mesa con resultado. place: su puesto (1 = ganador) o null
function pointsFor(ev, pod, place) {
  if (pod.is_draw) return ev.draw_points ?? 1;
  if (ev.scoring === 'places') {
    if (!place) return ev.pts_loss ?? 0;
    const l = placesList(ev);
    return l[place - 1] ?? l[l.length - 1] ?? 0;
  }
  if (place === 1) return pod.size >= 4 ? ev.pts_win4 ?? 4 : ev.pts_win3 ?? 3;
  return ev.pts_loss ?? 0;
}
// Texto corto con el sistema de puntos del evento
function scoringText(ev) {
  if (ev.scoring === 'places') {
    const l = placesList(ev);
    return `por puestos: ${l.map((v, i) => `${i + 1}º ${v}`).join(' · ')} pts · sin empates (se desempata siempre)`;
  }
  const w4 = ev.pts_win4 ?? 4, w3 = ev.pts_win3 ?? 3, lo = ev.pts_loss ?? 0;
  return `ganador ${w4} pts en mesa de 4 y ${w3} en mesa de 3 · resto ${lo} · sin empates (se desempata siempre)`;
}

// ---------- Clasificación ----------
// Solo por puntos: el ganador suma tantos puntos como jugadores había en su mesa (4 o 3); empate: draw_points a cada uno.
// Empatados a puntos comparten puesto. Para emparejar y para el corte de la mesa final se ordena por sorteo fijo.
function sharedRanks(list, offset = 0) {
  list.forEach(p => { p.rank = offset + 1 + list.filter(o => o.points > p.points).length; });
}

function standings(eventId, { includeFinal = true } = {}) {
  const ev = getEvent(eventId);
  const list = players(eventId);
  const st = new Map(list.map(p => [p.id, {
    id: p.id, name: p.name, username: p.username, user_key: p.user_key, person_key: p.person_key, deck: p.deck, deckValue: p.deck_value_cents, deckBracket: p.deck_bracket, deckLegal: p.deck_legal, checkedIn: p.checked_in_at, dropped: p.dropped_round,
    points: 0, wins: 0, draws: 0, losses: 0, played: 0, threes: 0, seat1: 0,
  }]));
  const swissPods = db.prepare(`SELECT pd.* FROM cmd_pods pd JOIN cmd_rounds r ON r.id = pd.round_id
    WHERE r.event_id = ? AND r.kind = 'swiss' ORDER BY r.number, pd.table_number`).all(eventId);
  const seatQ = db.prepare('SELECT player_id, seat, place FROM cmd_seats WHERE pod_id = ?');
  for (const pod of swissPods) {
    for (const s of seatQ.all(pod.id)) {
      const p = st.get(s.player_id);
      if (!p) continue;
      if (pod.size === 3) p.threes++;
      if (s.seat === 1) p.seat1++;
      if (!pod.reported) continue;
      p.played++;
      const place = s.place || (pod.winner_id === s.player_id ? 1 : null);
      p.points += pointsFor(ev, pod, place);
      if (pod.is_draw) p.draws++;
      else if (place === 1) p.wins++;
      else p.losses++;
      if (place) p['p' + place] = (p['p' + place] || 0) + 1;
    }
  }
  const all = [...st.values()];
  const rand = rng(eventId * 7919);
  for (const p of all) p.rnd = rand();
  all.sort((a, b) => b.points - a.points || a.rnd - b.rnd);
  sharedRanks(all);

  // Mesa final (Top 4): manda el resultado de la mesa (puestos, o ganador y el resto en su orden del suizo)
  if (includeFinal) {
    const fin = db.prepare(`SELECT pd.* FROM cmd_pods pd JOIN cmd_rounds r ON r.id = pd.round_id
      WHERE r.event_id = ? AND r.kind = 'final' LIMIT 1`).get(eventId);
    if (fin) {
      const ids = new Set(seatQ.all(fin.id).map(s => s.player_id));
      const finalists = all.filter(p => ids.has(p.id));
      const rest = all.filter(p => !ids.has(p.id));
      const fplace = new Map(seatQ.all(fin.id).map(s => [s.player_id, s.place]));
      if (fin.reported && !fin.is_draw && [...fplace.values()].some(Boolean)) {
        finalists.sort((a, b) => (fplace.get(a.id) || 99) - (fplace.get(b.id) || 99));
      } else if (fin.reported && !fin.is_draw && fin.winner_id) {
        finalists.sort((a, b) => (b.id === fin.winner_id) - (a.id === fin.winner_id));
      }
      finalists.forEach(p => { p.finalist = true; p.champion = fin.reported && !fin.is_draw && p.id === fin.winner_id; });
      const champ = finalists.filter(p => p.champion);
      champ.forEach(p => { p.rank = 1; });
      if (fin.reported && [...fplace.values()].some(Boolean)) {
        const maxPl = Math.max(...finalists.map(p => fplace.get(p.id) || 0));
        const unplaced = finalists.filter(p => !fplace.get(p.id));
        finalists.filter(p => !p.champion).forEach(p => { p.rank = fplace.get(p.id) || maxPl + 1 + unplaced.indexOf(p); });
      } else sharedRanks(finalists.filter(p => !p.champion), champ.length);
      sharedRanks(rest, finalists.length);
      return [...finalists, ...rest];
    }
  }
  return all;
}

// ---------- Emparejamiento ----------
function history(eventId) {
  const pairs = new Map();
  const rows = db.prepare(`SELECT s.pod_id, s.player_id FROM cmd_seats s JOIN cmd_pods pd ON pd.id = s.pod_id
    JOIN cmd_rounds r ON r.id = pd.round_id WHERE r.event_id = ?`).all(eventId);
  const byPod = new Map();
  for (const r of rows) { if (!byPod.has(r.pod_id)) byPod.set(r.pod_id, []); byPod.get(r.pod_id).push(r.player_id); }
  for (const ids of byPod.values()) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = pairKey(ids[i], ids[j]);
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
  }
  return pairs;
}

// Prioridad absoluta: mesas por orden de puntos (los de más puntos juntos, en las primeras mesas).
// Repetir rival y repetir mesa de 3 solo se evitan intercambiando jugadores con los mismos puntos
// Además (opcionales): no juntar a los que ya coincidieron en torneos anteriores y equilibrar el bracket de los mazos
const W_REPEAT = 10, W_SPREAD = 1000, W_THREE = 3, W_REGULAR = 2, W_BRACKET = 4;

function podCost(pod, size, info, pairs, ctx) {
  let c = 0;
  for (let i = 0; i < pod.length; i++) for (let j = i + 1; j < pod.length; j++) {
    const k = pairKey(pod[i], pod[j]);
    c += (pairs.get(k) || 0) * W_REPEAT;
    if (ctx && ctx.prior) c += Math.min(3, ctx.prior.get(k) || 0) * W_REGULAR;
  }
  if (ctx && ctx.bracket) {
    const bs = pod.map(id => info.get(id).deckBracket).filter(b => b != null);
    if (bs.length >= 2) c += (Math.max(...bs) - Math.min(...bs)) * W_BRACKET;
  }
  const pts = pod.map(id => info.get(id).points);
  c += (Math.max(...pts) - Math.min(...pts)) * W_SPREAD;
  if (size === 3) for (const id of pod) c += info.get(id).threes * W_THREE;
  return c;
}

// Devuelve [[playerId,...], ...] con los tamaños indicados (sin tocar la base de datos)
function buildPods(order, sizes, info, pairs, ctx) {
  const pods = [];
  let k = 0;
  for (const s of sizes) { pods.push(order.slice(k, k + s)); k += s; }
  const cost = pods.map((p, i) => podCost(p, sizes[i], info, pairs, ctx));
  for (let pass = 0; pass < 60; pass++) {
    let improved = false;
    for (let i = 0; i < pods.length; i++) for (let j = i + 1; j < pods.length; j++) {
      for (let a = 0; a < pods[i].length; a++) for (let b = 0; b < pods[j].length; b++) {
        // Solo se intercambian jugadores con los mismos puntos: la agrupación por puntos nunca se rompe
        if (info.get(pods[i][a]).points !== info.get(pods[j][b]).points) continue;
        const pi = [...pods[i]], pj = [...pods[j]];
        [pi[a], pj[b]] = [pj[b], pi[a]];
        const ci = podCost(pi, sizes[i], info, pairs, ctx), cj = podCost(pj, sizes[j], info, pairs, ctx);
        if (ci + cj < cost[i] + cost[j] - 1e-9) {
          pods[i] = pi; pods[j] = pj; cost[i] = ci; cost[j] = cj; improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return { pods, repeats: pods.reduce((n, p) => {
    for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) n += pairs.get(pairKey(p[i], p[j])) ? 1 : 0;
    return n;
  }, 0) };
}

// Veces que dos jugadores han coincidido en mesas de Commander de otros torneos (últimos 120 días), por id de jugador de este evento
function priorPairs(eventId, active) {
  const people = require('./people');
  const idx = people.nameIndex();
  const keyOf = new Map(active.map(p => [p.id, people.cmdKey(p, idx)]));
  const byKey = new Map();
  for (const [id, k] of keyOf) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(id); }
  const out = new Map();
  for (const e of require('./rivals').all()) {
    if (e.source !== 'commander' || e.eventId === eventId) continue;
    if (e.date && Date.now() - new Date(String(e.date).replace(' ', 'T')) > 120 * 864e5) continue;
    const A = byKey.get(e.a), Bs = byKey.get(e.b);
    if (!A || !Bs) continue;
    for (const a of A) for (const b of Bs) { const k = pairKey(a, b); out.set(k, (out.get(k) || 0) + 1); }
  }
  return out;
}
function seatPod(pod, info, rand) {
  // Turno 1º (empieza) para quien menos veces lo ha tenido; el resto al azar
  const sorted = shuffle(pod, rand).sort((a, b) => info.get(a).seat1 - info.get(b).seat1);
  return [sorted[0], ...shuffle(sorted.slice(1), rand)];
}

function insertRound(eventId, kind, podLists) {
  return db.transaction(() => {
    const num = (db.prepare('SELECT COALESCE(MAX(number),0) n FROM cmd_rounds WHERE event_id = ?').get(eventId).n) + 1;
    const rid = db.prepare('INSERT INTO cmd_rounds (event_id, number, kind) VALUES (?, ?, ?)').run(eventId, num, kind).lastInsertRowid;
    const insPod = db.prepare('INSERT INTO cmd_pods (round_id, table_number, size) VALUES (?, ?, ?)');
    const insSeat = db.prepare('INSERT INTO cmd_seats (pod_id, player_id, seat) VALUES (?, ?, ?)');
    podLists.forEach((pod, i) => {
      const pid = insPod.run(rid, i + 1, pod.length).lastInsertRowid;
      pod.forEach((playerId, s) => insSeat.run(pid, playerId, s + 1));
    });
    db.prepare("UPDATE cmd_events SET status = 'running' WHERE id = ?").run(eventId);
    return num;
  })();
}

function pairNextRound(eventId) {
  const ev = getEvent(eventId);
  if (!ev) throw new Error('Evento no encontrado');
  if (ev.status === 'finished') throw new Error('El evento está terminado');
  const last = currentRound(eventId);
  if (last && last.kind === 'final') throw new Error('Ya se ha jugado la mesa final');
  if (last && !roundComplete(last.id)) throw new Error(`Faltan resultados de la ronda ${last.number}`);
  const swissDone = db.prepare("SELECT COUNT(*) c FROM cmd_rounds WHERE event_id = ? AND kind = 'swiss'").get(eventId).c;
  const limit = roundLimit(eventId);
  if (swissDone >= limit) throw new Error(`Ya se han jugado las ${limit} rondas de suizo de este torneo`);
  const st = standings(eventId, { includeFinal: false });
  const active = st.filter(p => p.dropped == null);
  const sizes = podSizes(active.length);
  if (!sizes) throw new Error('Hacen falta al menos 3 jugadores activos');
  const roundNo = (last ? last.number : 0) + 1;
  const rand = rng(eventId * 1000 + roundNo);
  const info = new Map(st.map(p => [p.id, p]));
  // Ronda 1 al azar; después por clasificación
  const ordered = ev.three_pods === 'top' ? [...sizes].reverse() : sizes;
  const pairs = history(eventId);
  const ctx = { prior: ev.avoid_regulars ?? 1 ? priorPairs(eventId, active) : null, bracket: !!(ev.balance_bracket ?? 1) };
  // Varios intentos (orden de clasificación y variantes barajando empatados a puntos); se queda el de menor coste
  let best = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    let order;
    if (roundNo === 1) order = shuffle(active.map(p => p.id), rand);
    else if (attempt === 0) order = active.map(p => p.id);
    else {
      // Mismo orden por puntos, barajando solo a los empatados
      order = active.map(p => ({ id: p.id, k: p.points, r: rand() }))
        .sort((a, b) => b.k - a.k || a.r - b.r).map(x => x.id);
    }
    const res = buildPods(order, ordered, info, pairs, ctx);
    const total = res.pods.reduce((s, p, i) => s + podCost(p, ordered[i], info, pairs, ctx), 0);
    if (!best || total < best.total) best = { ...res, total };
    if (roundNo === 1) break;
  }
  const { pods, repeats } = best;
  const seated = pods.map(p => seatPod(p, info, rand));
  insertRound(eventId, 'swiss', seated);
  return { round: roundNo, pods: seated.length, repeats };
}

function pairFinal(eventId) {
  const last = currentRound(eventId);
  if (!last) throw new Error('Todavía no hay rondas');
  if (last.kind === 'final') throw new Error('La mesa final ya existe');
  if (!roundComplete(last.id)) throw new Error(`Faltan resultados de la ronda ${last.number}`);
  const top = standings(eventId, { includeFinal: false }).filter(p => p.dropped == null).slice(0, 4);
  if (top.length < 3) throw new Error('No hay suficientes jugadores para la mesa final');
  insertRound(eventId, 'final', [top.map(p => p.id)]);
}

function undoLastRound(eventId) {
  const last = currentRound(eventId);
  if (!last) throw new Error('No hay rondas');
  const reported = db.prepare('SELECT COUNT(*) c FROM cmd_pods WHERE round_id = ? AND reported = 1').get(last.id).c;
  if (reported) throw new Error('La ronda ya tiene resultados: bórralos antes de deshacerla');
  db.prepare('DELETE FROM cmd_rounds WHERE id = ?').run(last.id);
  const left = db.prepare('SELECT COUNT(*) c FROM cmd_rounds WHERE event_id = ?').get(eventId).c;
  db.prepare("UPDATE cmd_events SET status = ?, notified_round = MIN(notified_round, ?) WHERE id = ?")
    .run(left ? 'running' : 'setup', left, eventId);
}

// result: 'clear' | 'draw' | id del ganador | { places: { idJugador: puesto } } | { order: [ids del 1º al último] }
function reportPod(podId, result) {
  const pod = db.prepare('SELECT * FROM cmd_pods WHERE id = ?').get(podId);
  if (!pod) throw new Error('Mesa no encontrada');
  const clearPlaces = () => db.prepare('UPDATE cmd_seats SET place = NULL WHERE pod_id = ?').run(podId);
  if (result && typeof result === 'object') {
    const seated = db.prepare('SELECT player_id FROM cmd_seats WHERE pod_id = ?').all(podId).map(r => r.player_id);
    let places = {};
    if (Array.isArray(result.order)) result.order.forEach((id, i) => { places[Number(id)] = i + 1; });
    else places = Object.fromEntries(Object.entries(result.places || {}).map(([k, v]) => [Number(k), Number(v) || null]));
    for (const id of Object.keys(places)) if (!seated.includes(Number(id))) throw new Error('Ese jugador no está en la mesa');
    for (const v of Object.values(places)) if (v != null && (v < 1 || v > pod.size)) throw new Error(`Los puestos van del 1º al ${pod.size}º`);
    // Sin empates: cada puesto una sola vez; si solo falta uno, se le pone el que queda
    const given = seated.map(id => places[id]).filter(Boolean);
    if (new Set(given).size !== given.length) throw new Error('No puede haber dos jugadores en el mismo puesto: no hay empates, desempatad (con un dado si hace falta)');
    const missing = seated.filter(id => !places[id]);
    if (missing.length === 1) { const used = new Set(given); places[missing[0]] = [...Array(pod.size).keys()].map(i => i + 1).find(n => !used.has(n)); }
    else if (missing.length > 1) throw new Error('Falta el puesto de algún jugador');
    const firsts = seated.filter(id => places[id] === 1);
    if (!firsts.length) throw new Error('Falta el 1º puesto');
    db.transaction(() => {
      const up = db.prepare('UPDATE cmd_seats SET place = ? WHERE pod_id = ? AND player_id = ?');
      for (const id of seated) up.run(places[id] || null, podId, id);
      db.prepare('UPDATE cmd_pods SET winner_id = ?, is_draw = 0, reported = 1 WHERE id = ?').run(firsts[0], podId);
    })();
  } else if (result === 'clear') {
    clearPlaces();
    db.prepare('UPDATE cmd_pods SET winner_id = NULL, is_draw = 0, reported = 0 WHERE id = ?').run(podId);
  } else if (result === 'draw') {
    throw new Error('No hay empates: decidid el resultado con el desempate (o con un dado)');
  } else if (result === 'draw-legacy') {
    clearPlaces();
    db.prepare('UPDATE cmd_pods SET winner_id = NULL, is_draw = 1, reported = 1 WHERE id = ?').run(podId);
  } else {
    const pid = Number(result);
    const seated = db.prepare('SELECT 1 FROM cmd_seats WHERE pod_id = ? AND player_id = ?').get(podId, pid);
    if (!seated) throw new Error('Ese jugador no está en la mesa');
    clearPlaces();
    db.prepare('UPDATE cmd_seats SET place = 1 WHERE pod_id = ? AND player_id = ?').run(podId, pid);
    db.prepare('UPDATE cmd_pods SET winner_id = ?, is_draw = 0, reported = 1 WHERE id = ?').run(pid, podId);
  }
  db.prepare("UPDATE cmd_pods SET reported_at = CASE WHEN reported = 1 THEN COALESCE(reported_at, datetime('now')) ELSE NULL END WHERE id = ?").run(podId);
  // Con todas las mesas terminadas, el reloj de la ronda ya no tiene sentido
  if (result !== 'clear' && roundComplete(pod.round_id)) stopTimers(null, pod.round_id);
  if (result !== 'clear') clearProposal(podId);
  return pod;
}

// Intercambia dos jugadores entre mesas de una ronda sin resultados en esas mesas
function swapPlayers(roundId, a, b) {
  const sa = db.prepare(`SELECT s.*, pd.reported FROM cmd_seats s JOIN cmd_pods pd ON pd.id = s.pod_id WHERE pd.round_id = ? AND s.player_id = ?`).get(roundId, a);
  const sb = db.prepare(`SELECT s.*, pd.reported FROM cmd_seats s JOIN cmd_pods pd ON pd.id = s.pod_id WHERE pd.round_id = ? AND s.player_id = ?`).get(roundId, b);
  if (!sa || !sb) throw new Error('Jugador no encontrado en esta ronda');
  if (sa.reported || sb.reported) throw new Error('Una de las mesas ya tiene resultado');
  if (sa.pod_id === sb.pod_id) return;
  db.transaction(() => {
    db.prepare('DELETE FROM cmd_seats WHERE pod_id IN (?, ?) AND player_id IN (?, ?)').run(sa.pod_id, sb.pod_id, a, b);
    db.prepare('INSERT INTO cmd_seats (pod_id, player_id, seat) VALUES (?, ?, ?)').run(sa.pod_id, b, sa.seat);
    db.prepare('INSERT INTO cmd_seats (pod_id, player_id, seat) VALUES (?, ?, ?)').run(sb.pod_id, a, sb.seat);
  })();
}

// Snapshot para la web pública y la TV
function snapshot(eventId) {
  const ev = getEvent(eventId);
  if (!ev) return null;
  const rds = rounds(eventId);
  const last = rds[rds.length - 1] || null;
  const st = standings(eventId);
  const pts = new Map(st.map(p => [p.id, p.points]));
  // Puntos acumulados antes de cada ronda y forma por jugador
  const before = new Map();
  const form = new Map(st.map(p => [p.id, []]));
  const placeOf = (p, x) => x.place || (p.winner_id === x.id ? 1 : null);
  const shapePods = rd => podsOfRound(rd.id).map(p => {
    const out = {
      id: p.id, table: p.table_number, size: p.size, reported: !!p.reported, draw: !!p.is_draw, winner: p.winner_id,
      proposed: !!p.proposed_at && !p.reported, proposedWinner: p.proposed_winner, proposedDraw: !!p.proposed_draw,
      proposedOrder: p.proposed_places ? JSON.parse(p.proposed_places) : null,
      players: p.players.map(x => ({ id: x.id, seat: x.seat, name: pubName(x), username: x.username || '', deck: x.deck || '', pts: before.get(x.id) || 0,
        place: p.reported && !p.is_draw ? placeOf(p, x) : null, got: p.reported ? pointsFor(ev, p, placeOf(p, x)) : null })),
    };
    for (const x of p.players) {
      const pl = placeOf(p, x);
      const res = !p.reported ? '?' : p.is_draw ? 'D' : pl === 1 ? 'W' : 'L';
      if (rd.kind === 'swiss') form.get(x.id)?.push({ r: rd.number, res, size: p.size, place: p.reported && !p.is_draw ? pl : null, got: p.reported ? pointsFor(ev, p, pl) : null });
    }
    return out;
  });
  const roundsOut = [];
  for (const rd of rds) {
    const pods = shapePods(rd);
    roundsOut.push({ round: rd.number, kind: rd.kind, pods });
    if (rd.kind === 'swiss') for (const pod of pods) for (const x of pod.players) {
      before.set(x.id, (before.get(x.id) || 0) + (pod.reported ? x.got : 0));
    }
  }
  const cur = roundsOut[roundsOut.length - 1];
  return {
    id: ev.id, kind: 'commander', name: ev.name, status: ev.status, scoring: ev.scoring === 'places' ? 'places' : 'size', scoringText: scoringText(ev),
    pts: { win4: ev.pts_win4 ?? 4, win3: ev.pts_win3 ?? 3, loss: ev.pts_loss ?? 0, draw: ev.draw_points ?? 1, places: placesList(ev) }, startDate: ev.start_date, selfReport: !!ev.self_report, budget: ev.budget_cents, bracketMax: ev.bracket_max || null, legalCheck: !!ev.legal_check, budgetExBasics: true, budgetExCommander: !!ev.budget_ex_commander, deckLocked: deckLocked(ev),
    round: last ? last.number : 0, roundKind: last ? last.kind : null, roundsPlanned: roundLimit(eventId),
    timerEnd: last && ev.status !== 'finished' ? last.timer_end : null,
    pods: cur ? cur.pods : [],
    pending: cur ? cur.pods.filter(p => !p.reported).length : 0,
    done: cur ? cur.pods.filter(p => p.reported).length : 0,
    rounds: roundsOut,
    standings: st.map(p => ({
      id: p.id, rank: p.rank, name: pubName(p), username: p.username || '', points: p.points, record: `${p.wins}-${p.losses}-${p.draws}`,
      deck: p.deck || '', wins: p.wins, played: p.played, dropped: p.dropped, finalist: !!p.finalist, champion: !!p.champion, form: form.get(p.id) || [],
    })).filter(p => p.played || ev.status === 'setup' || p.form.length),
    roster: st.map(p => ({ id: p.id, name: pubName(p), username: p.username || '', deck: p.deck || '', value: p.deckValue ?? null, bracket: p.deckBracket ?? null, legal: p.deckLegal ?? null, here: !!p.checkedIn, points: pts.get(p.id) || 0 })).sort((a, b) => a.name.localeCompare(b.name)),
    players: st.length,
  };
}

// ---------- Resultados propuestos por los jugadores ----------
function proposeResult(eventId, podId, byId, result) {
  const ev = getEvent(eventId);
  if (!ev || ev.status !== 'running') throw new Error('El torneo no está en juego');
  if (!ev.self_report) throw new Error('En este torneo los resultados los anota la tienda');
  const cur = currentRound(eventId);
  const pod = db.prepare('SELECT * FROM cmd_pods WHERE id = ? AND round_id = ?').get(podId, cur ? cur.id : -1);
  if (!pod) throw new Error('Esa mesa no es de la ronda actual');
  if (pod.reported) throw new Error('Esta mesa ya tiene resultado');
  const seated = new Set(db.prepare('SELECT player_id FROM cmd_seats WHERE pod_id = ?').all(podId).map(r => r.player_id));
  if (!seated.has(byId)) throw new Error('Solo puede reportar alguien de la mesa');
  if (result === 'draw') throw new Error('No hay empates: decidid el resultado con el desempate (o con un dado)');
  const draw = false;
  let order = null;
  if (String(result).startsWith('order:')) {
    order = String(result).slice(6).split(',').map(Number).filter(Boolean);
    if (!order.length || order.some(id => !seated.has(id)) || new Set(order).size !== order.length) throw new Error('Orden no válido');
  }
  const winner = draw ? null : order ? order[0] : Number(result);
  if (!draw && !seated.has(winner)) throw new Error('Ese jugador no está en la mesa');
  db.prepare("UPDATE cmd_pods SET proposed_winner = ?, proposed_draw = ?, proposed_places = ?, proposed_by = ?, proposed_at = datetime('now') WHERE id = ?")
    .run(winner, draw ? 1 : 0, order ? JSON.stringify(order) : null, byId, podId);
}
function clearProposal(podId) {
  db.prepare('UPDATE cmd_pods SET proposed_winner = NULL, proposed_draw = 0, proposed_places = NULL, proposed_by = NULL, proposed_at = NULL WHERE id = ?').run(podId);
}
function confirmProposal(podId) {
  const pod = db.prepare('SELECT * FROM cmd_pods WHERE id = ?').get(podId);
  if (!pod || !pod.proposed_at) throw new Error('No hay propuesta');
  reportPod(podId, pod.proposed_draw ? 'draw' : pod.proposed_places ? { order: JSON.parse(pod.proposed_places) } : String(pod.proposed_winner));
  clearProposal(podId);
}

// Guarda el mazo validado: valor para el presupuesto (según reglas del evento), lista y desglose
function setDeckValue(eventId, playerId, result, listText) {
  const ev = getEvent(eventId);
  const { budgetValue } = require('./deckvalue');
  const counted = budgetValue(result, { exCommander: !!ev.budget_ex_commander });
  const br = result.bracket || null;
  const detail = { total: result.total, counted, cards: result.cards, commander: result.commander, missing: result.missing, noPrice: result.noPrice,
    legality: result.legality || null,
    bracket: br ? { n: br.n, unknown: !!br.unknown, error: br.error || null, maybeOne: br.maybeOne, reasons: br.reasons, gc: br.gc, mld: br.mld, et: br.et, combos: br.combos, tutors: br.tutors, source: br.source } : null,
    commanderHow: result.commanderHow || null, commanderSure: result.commanderSure !== false, notes: result.notes || [],
    lines: result.lines.map(l => ({ q: l.qty, n: l.name, s: l.set, u: l.unit, t: l.total, c: l.commander ? 1 : 0 })), at: result.at };
  db.prepare(`UPDATE cmd_players SET deck_value_cents = ?, deck_value_at = datetime('now'), deck = COALESCE(?, deck), deck_list = ?, deck_detail = ?, deck_bracket = ?, deck_legal = ?
    WHERE id = ? AND event_id = ?`).run(Math.round(counted * 100), result.commander ? String(result.commander).slice(0, 80) : null,
    String(listText || '').slice(0, 60000), JSON.stringify(detail), br ? br.n : null, result.legality ? (result.legality.ok ? 1 : 0) : null, playerId, eventId);
  return counted;
}

// Estado del control de presupuesto de un evento
// Comprobación de mazos de un evento con presupuesto o bracket máximo
function budgetCheck(eventId) {
  const ev = getEvent(eventId);
  if (!ev.budget_cents && !ev.bracket_max && !ev.legal_check) return null;
  const ps = players(eventId).filter(p => p.dropped_round == null);
  const missing = ps.filter(p => p.deck_value_cents == null);
  const overBudget = ev.budget_cents ? ps.filter(p => p.deck_value_cents != null && p.deck_value_cents > ev.budget_cents) : [];
  const overBracket = ev.bracket_max ? ps.filter(p => p.deck_value_cents != null && p.deck_bracket != null && p.deck_bracket > Math.max(ev.bracket_max, 2)) : [];
  const illegal = ev.legal_check ? ps.filter(p => p.deck_value_cents != null && p.deck_legal === 0) : [];
  const over = [...new Set([...overBudget, ...overBracket, ...illegal])];
  const wrongSize = ps.filter(p => { try { const d = JSON.parse(p.deck_detail || 'null'); return d && d.cards !== 100; } catch { return false; } });
  return { budget: ev.budget_cents, bracketMax: ev.bracket_max || null, total: ps.length, ok: ps.length - missing.length - over.length, missing, over, overBudget, overBracket, illegal, legalCheck: !!ev.legal_check, wrongSize };
}

function deckLocked(ev) {
  return ev.status === 'finished' || (ev.budget_lock && ev.status !== 'setup');
}

function setDeck(eventId, playerId, deck) {
  db.prepare('UPDATE cmd_players SET deck = ? WHERE id = ? AND event_id = ?').run(String(deck || '').trim().slice(0, 80) || null, playerId, eventId);
}

function duplicateEvent(eventId, withPlayers) {
  const ev = getEvent(eventId);
  const next = ev.start_date ? new Date(new Date(ev.start_date).getTime() + 7 * 864e5).toISOString() : null;
  return db.transaction(() => {
    const id = db.prepare(`INSERT INTO cmd_events (name, start_date, melee_tournament_id, rounds_planned, round_minutes, draw_points, three_pods,
      tiebreak, final_top4, price_cents, public, info, self_report, budget_cents, budget_ex_basics, budget_ex_commander, budget_lock,
      scoring, pts_win4, pts_win3, pts_loss, pts_places, bracket_max, legal_check)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(ev.name, next, null, ev.rounds_planned, ev.round_minutes, ev.draw_points, ev.three_pods, ev.tiebreak, ev.final_top4,
        ev.price_cents, ev.public, ev.info, ev.self_report, ev.budget_cents, ev.budget_ex_basics, ev.budget_ex_commander, ev.budget_lock,
        ev.scoring, ev.pts_win4, ev.pts_win3, ev.pts_loss, ev.pts_places, ev.bracket_max, ev.legal_check).lastInsertRowid;
    if (withPlayers) {
      db.prepare(`INSERT INTO cmd_players (event_id, name, username, user_key, deck, person_key)
        SELECT ?, name, username, user_key, deck, person_key FROM cmd_players WHERE event_id = ? AND dropped_round IS NULL`).run(id, eventId);
    }
    return id;
  })();
}

// Meta de comandantes: copias, eventos, mesas ganadas y campeones
function deckMeta(from, to) {
  const rows = db.prepare(`SELECT p.id, p.deck, p.event_id FROM cmd_players p JOIN cmd_events e ON e.id = p.event_id
    WHERE p.deck IS NOT NULL AND p.deck != '' AND e.status != 'setup' AND date(COALESCE(e.start_date, e.created_at)) BETWEEN date(?) AND date(?)`).all(from, to);
  const wins = db.prepare('SELECT COUNT(*) c FROM cmd_pods WHERE winner_id = ?');
  const played = db.prepare('SELECT COUNT(*) c FROM cmd_seats s JOIN cmd_pods pd ON pd.id = s.pod_id WHERE s.player_id = ? AND pd.reported = 1');
  const champs = new Map();
  for (const e of new Set(rows.map(r => r.event_id))) {
    const ev = getEvent(e);
    if (ev.status !== 'finished') continue;
    const st = standings(e);
    if (st[0]) champs.set(st[0].id, true);
  }
  const by = new Map();
  for (const r of rows) {
    const k = r.deck.trim();
    const key = k.toLowerCase();
    if (!by.has(key)) by.set(key, { name: k, copies: 0, events: new Set(), wins: 0, played: 0, champs: 0 });
    const m = by.get(key);
    m.copies++; m.events.add(r.event_id); m.wins += wins.get(r.id).c; m.played += played.get(r.id).c; if (champs.has(r.id)) m.champs++;
  }
  return [...by.values()].map(m => ({ ...m, events: m.events.size, winrate: m.played ? Math.round(m.wins * 100 / m.played) : null }))
    .sort((a, b) => b.copies - a.copies || b.wins - a.wins);
}

// ---------- Inscripción desde la web (con cuenta) ----------
class SignupError extends Error {}
const activeCount = id => db.prepare('SELECT COUNT(*) c FROM cmd_players WHERE event_id = ? AND dropped_round IS NULL AND COALESCE(waitlist, 0) = 0').get(id).c;
// Inscripción de la cuenta en el evento (activa o en lista de espera), o null
function entryOf(eventId, acc, personKey) {
  const r = db.prepare('SELECT * FROM cmd_players WHERE event_id = ? AND account_id = ?').get(eventId, acc.id);
  if (r) return r;
  if (!personKey) return null;
  const { resolve } = require('./identity');
  // Apuntado por el staff con la ficha de la cuenta
  return db.prepare('SELECT * FROM cmd_players WHERE event_id = ? AND person_key IS NOT NULL').all(eventId).find(p => resolve(p.person_key) === personKey) || null;
}
function signup(eventId, acc, personKey, displayName, nick = null) {
  const ev = getEvent(eventId);
  if (!ev || !ev.public) throw new SignupError('Evento no encontrado');
  if (!ev.self_signup) throw new SignupError('Este torneo no admite inscripción desde la web: apúntate en la tienda.');
  if (ev.status !== 'setup') throw new SignupError('Las inscripciones están cerradas: el torneo ya ha empezado.');
  const prev = entryOf(eventId, acc, require('./identity').resolve(personKey));
  if (prev && prev.dropped_round == null) return { player: prev, waitlist: !!prev.waitlist, already: true };
  return db.transaction(() => {
    const full = ev.max_players && activeCount(eventId) >= ev.max_players;
    if (prev) {
      db.prepare("UPDATE cmd_players SET dropped_round = NULL, waitlist = ?, account_id = ?, signed_at = datetime('now') WHERE id = ?").run(full ? 1 : 0, acc.id, prev.id);
      return { player: db.prepare('SELECT * FROM cmd_players WHERE id = ?').get(prev.id), waitlist: !!full };
    }
    const id = db.prepare(`INSERT INTO cmd_players (event_id, name, username, person_key, account_id, waitlist, signed_via, signed_at, paid)
      VALUES (?, ?, ?, ?, ?, ?, 'web', datetime('now'), 0)`).run(eventId, displayName, nick || null, personKey, acc.id, full ? 1 : 0).lastInsertRowid;
    return { player: db.prepare('SELECT * FROM cmd_players WHERE id = ?').get(id), waitlist: !!full };
  })();
}
// Borrarse antes de empezar. Si deja hueco, sube el primero de la lista de espera (se devuelve para avisarle)
function withdraw(eventId, acc, personKey) {
  const ev = getEvent(eventId);
  const p = entryOf(eventId, acc, personKey);
  if (!p) throw new SignupError('No estás apuntado a este torneo.');
  if (ev.status !== 'setup') throw new SignupError('El torneo ya ha empezado: avisa al staff si te vas.');
  if (p.paid) throw new SignupError('Ya has pagado la inscripción: habla con la tienda para borrarte.');
  return db.transaction(() => {
    const seated = db.prepare('SELECT 1 FROM cmd_seats WHERE player_id = ?').get(p.id);
    if (seated) db.prepare('UPDATE cmd_players SET dropped_round = 0 WHERE id = ?').run(p.id);
    else db.prepare('DELETE FROM cmd_players WHERE id = ?').run(p.id);
    return p.waitlist ? null : promoteWaitlist(eventId);
  })();
}
// Si hay plazas libres, pasa a jugadores a los primeros de la lista de espera
function promoteWaitlist(eventId) {
  const ev = getEvent(eventId);
  const out = [];
  for (const w of waitlisted(eventId)) {
    if (ev.max_players && activeCount(eventId) >= ev.max_players) break;
    db.prepare('UPDATE cmd_players SET waitlist = 0 WHERE id = ?').run(w.id);
    out.push(w);
  }
  return out;
}

// ---------- Pagos ----------
function setPaid(eventId, playerId, paid, method, by) {
  db.prepare(`UPDATE cmd_players SET paid = ?, paid_at = ${paid ? "datetime('now')" : 'NULL'}, paid_method = ?, paid_by = ? WHERE id = ? AND event_id = ?`)
    .run(paid ? 1 : 0, paid ? (method || null) : null, paid ? (by || null) : null, playerId, eventId);
}
function paymentStats(eventId) {
  const ev = getEvent(eventId);
  if (ev.price_cents == null) return null;
  const ps = players(eventId).filter(p => p.dropped_round == null);
  const paid = ps.filter(p => p.paid);
  const unpaid = ps.filter(p => !p.paid);
  return { price: ev.price_cents, paid, unpaid, collected: paid.length * ev.price_cents, pending: unpaid.length * ev.price_cents,
    byMethod: paid.reduce((m, p) => { const k = p.paid_method || 'sin indicar'; m[k] = (m[k] || 0) + 1; return m; }, {}) };
}

function liveEvents() {
  return db.prepare("SELECT * FROM cmd_events WHERE status = 'running' AND public = 1 ORDER BY id").all();
}
// Para la TV: también los que acaban de terminar (resumen de la noche durante 3 horas)
const tvEvents = () => db.prepare("SELECT * FROM cmd_events WHERE public = 1 AND (status = 'running' OR (status = 'finished' AND finished_at >= datetime('now', '-3 hours'))) ORDER BY id").all();

// ---------- Móviles de los jugadores (sin cuentas) ----------
// El primer móvil que actúa como un jugador recibe un código; desde entonces solo ese móvil puede actuar como él,
// salvo que la tienda lo libere. La tienda también puede bloquear los cambios desde el móvil a un jugador.
const crypto = require('crypto');
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
class ClaimError extends Error {}
function claim(eventId, playerId, tok) {
  const p = db.prepare('SELECT * FROM cmd_players WHERE id = ? AND event_id = ?').get(playerId, eventId);
  if (!p) throw new ClaimError('Jugador no encontrado');
  if (p.phone_locked) throw new ClaimError('La tienda ha bloqueado los cambios desde el móvil para este jugador. Habla con el staff.');
  if (p.claim_hash) {
    if (!tok || sha(tok) !== p.claim_hash) throw new ClaimError('Este jugador ya se está usando desde otro móvil. Si eres tú, pide al staff que lo libere.');
    return tok;
  }
  const t = crypto.randomBytes(18).toString('base64url');
  db.prepare("UPDATE cmd_players SET claim_hash = ?, claim_at = datetime('now') WHERE id = ?").run(sha(t), p.id);
  return t;
}
function activity(eventId, playerId, action, detail, req) {
  db.prepare('INSERT INTO cmd_activity (event_id, player_id, action, detail, ip, ua) VALUES (?, ?, ?, ?, ?, ?)')
    .run(eventId, playerId, action, detail == null ? null : String(detail).slice(0, 200), req ? req.ip : null, req ? String(req.get('user-agent') || '').slice(0, 160) : null);
}
function recentActivity(eventId, limit = 40) {
  return db.prepare(`SELECT a.*, p.name FROM cmd_activity a LEFT JOIN cmd_players p ON p.id = a.player_id
    WHERE a.event_id = ? ORDER BY a.id DESC LIMIT ?`).all(eventId, limit);
}
function releasePhone(eventId, playerId) {
  db.prepare('UPDATE cmd_players SET claim_hash = NULL, claim_at = NULL WHERE id = ? AND event_id = ?').run(playerId, eventId);
}
function setPhoneLock(eventId, playerId, on) {
  db.prepare('UPDATE cmd_players SET phone_locked = ? WHERE id = ? AND event_id = ?').run(on ? 1 : 0, playerId, eventId);
}
// Quita lo que el jugador haya puesto desde el móvil: comandante, valor y lista del mazo, y resultados enviados sin confirmar
function clearPlayerData(eventId, playerId) {
  db.prepare('UPDATE cmd_players SET deck = NULL, deck_value_cents = NULL, deck_value_at = NULL, deck_list = NULL, deck_detail = NULL WHERE id = ? AND event_id = ?').run(playerId, eventId);
  db.prepare(`UPDATE cmd_pods SET proposed_winner = NULL, proposed_draw = 0, proposed_places = NULL, proposed_by = NULL, proposed_at = NULL
    WHERE proposed_by = ? AND reported = 0 AND round_id IN (SELECT id FROM cmd_rounds WHERE event_id = ?)`).run(playerId, eventId);
}

// Meta de cartas de Commander a partir de los mazos validados (sin tierras básicas)
function cardMeta(from, to) {
  const BASIC = /^(snow-covered\s+)?(plains|island|swamp|mountain|forest|wastes)$/i;
  const evs = db.prepare(`SELECT * FROM cmd_events WHERE status != 'setup' AND date(COALESCE(start_date, created_at)) BETWEEN date(?) AND date(?)`).all(from, to);
  const cards = new Map();
  let decks = 0;
  for (const ev of evs) {
    const st = new Map(standings(ev.id).map(p => [p.id, p]));
    for (const p of players(ev.id)) {
      let d = null; try { d = JSON.parse(p.deck_detail || 'null'); } catch { d = null; }
      if (!d || !d.lines || !d.lines.length) continue;
      decks++;
      const s = st.get(p.id) || {};
      for (const l of d.lines) {
        if (BASIC.test(l.n)) continue;
        const k = l.n.toLowerCase();
        const x = cards.get(k) || { name: l.n, decks: 0, wins: 0, played: 0, champs: 0 };
        x.decks++; x.wins += s.wins || 0; x.played += s.played || 0; if (s.rank === 1 && ev.status === 'finished') x.champs++;
        cards.set(k, x);
      }
    }
  }
  const rows = [...cards.values()].map(x => ({ ...x, pct: decks ? Math.round(x.decks * 100 / decks) : 0, winrate: x.played ? Math.round(x.wins * 100 / x.played) : null }))
    .sort((a, b) => b.decks - a.decks || b.wins - a.wins || a.name.localeCompare(b.name));
  // Win rate en multijugador = mesas ganadas / mesas jugadas (lo esperado es ~25-33 %)
  const minGames = 6;
  const wrRows = rows.filter(r => r.decks >= 2 && r.played >= minGames).sort((a, b) => b.winrate - a.winrate || b.played - a.played || a.name.localeCompare(b.name));
  return { decks, rows, wrRows, minGames };
}

// ---------- Check-in (llegada a la tienda) ----------
function checkinCode(eventId) {
  const ev = getEvent(eventId);
  if (ev.checkin_code) return ev.checkin_code;
  const code = require('crypto').randomBytes(6).toString('base64url');
  db.prepare('UPDATE cmd_events SET checkin_code = ? WHERE id = ?').run(code, eventId);
  return code;
}
function setCheckin(eventId, playerId, on) {
  db.prepare(`UPDATE cmd_players SET checked_in_at = ${on ? "datetime('now')" : 'NULL'} WHERE id = ? AND event_id = ?`).run(playerId, eventId);
}
function checkinStats(eventId) {
  const ps = players(eventId).filter(p => p.dropped_round == null);
  const inn = ps.filter(p => p.checked_in_at);
  return { total: ps.length, in: inn.length, missing: ps.filter(p => !p.checked_in_at), used: inn.length > 0 };
}
// Antes de la ronda 1: drop a quien no ha hecho check-in
function dropAbsent(eventId) {
  if (currentRound(eventId)) throw new Error('El torneo ya ha empezado');
  const r = db.prepare('UPDATE cmd_players SET dropped_round = 0 WHERE event_id = ? AND dropped_round IS NULL AND checked_in_at IS NULL').run(eventId);
  return r.changes;
}

module.exports = {
  tvEvents,
  checkinCode, setCheckin, checkinStats, dropAbsent,
  cardMeta, pointsFor, scoringText, placesList, waitlisted, signup, withdraw, promoteWaitlist, entryOf, SignupError, activeCount, setPaid, paymentStats,
  claim, ClaimError, activity, recentActivity, releasePhone, setPhoneLock, clearPlayerData,
  podSizes, recommendedRounds, maxSwissRounds, roundLimit, finishEvent, stopTimers, getEvent, players, rounds, podsOfRound, currentRound, roundComplete, standings,
  proposeResult, clearProposal, confirmProposal, setDeck, setDeckValue, budgetCheck, deckLocked, duplicateEvent, deckMeta,
  pubName, pairNextRound, pairFinal, undoLastRound, reportPod, swapPlayers, snapshot, liveEvents, buildPods, rng, shuffle,
};
