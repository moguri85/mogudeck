'use strict';
// Contador de vidas de Commander por mesa: vidas, daño de comandante, veneno y quién elimina a quién.
// El estado vive en el servidor para que todos los móviles de la mesa (o uno en el centro) vean lo mismo.
const { db, addColumn } = require('./db');
const C = require('./commander');
const { EventEmitter } = require('events');
// Aviso al momento a todos los móviles que miran una mesa (Server-Sent Events)
const bus = new EventEmitter();
bus.setMaxListeners(500);

db.exec(`
CREATE TABLE IF NOT EXISTS cmd_life (
  pod_id INTEGER PRIMARY KEY REFERENCES cmd_pods(id) ON DELETE CASCADE,
  state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cmd_life_log (
  id INTEGER PRIMARY KEY, pod_id INTEGER NOT NULL REFERENCES cmd_pods(id) ON DELETE CASCADE, by_id INTEGER,
  kind TEXT NOT NULL, pid INTEGER, from_id INTEGER, delta INTEGER, before_v INTEGER, after_v INTEGER, life_after INTEGER,
  text TEXT, at INTEGER NOT NULL, updated_at INTEGER NOT NULL, undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_life_log_pod ON cmd_life_log(pod_id, id);
CREATE TABLE IF NOT EXISTS cmd_kills (
  pod_id INTEGER NOT NULL REFERENCES cmd_pods(id) ON DELETE CASCADE, victim_id INTEGER NOT NULL, killer_id INTEGER,
  how TEXT, ord INTEGER, at TEXT DEFAULT (datetime('now')), PRIMARY KEY (pod_id, victim_id)
);
`);
addColumn('cmd_events', 'life_auto', 'INTEGER DEFAULT 0');
addColumn('cmd_life_log', 'turn_pid', 'INTEGER');
addColumn('cmd_life_log', 'turn_n', 'INTEGER');
addColumn('cmd_life_log', 'data', 'TEXT'); // lo necesario para deshacer un «pasar turno»
addColumn('cmd_events', 'life_start', 'INTEGER DEFAULT 40');
addColumn('cmd_events', 'combo_lap', 'INTEGER DEFAULT 6');
// Combos: permitidos desde el turno combo_lap del jugador combo_seat de la vuelta (p. ej. turno 5 del 3º jugador) y con qué nombre se enseñan
addColumn('cmd_events', 'combo_seat', 'INTEGER');
addColumn('cmd_events', 'combo_label', 'TEXT');
db.prepare("UPDATE cmd_events SET combo_lap = CASE WHEN combo_lap = 6 THEN 5 ELSE combo_lap END, combo_seat = 3 WHERE combo_seat IS NULL").run();
addColumn('cmd_events', 'turn_warn', 'INTEGER DEFAULT 5');
addColumn('cmd_events', 'extra_turns', 'INTEGER DEFAULT 5');
addColumn('cmd_events', 'time_mode', 'TEXT'); // al acabar el tiempo: 'lap' (terminar la vuelta y muerte súbita, por defecto) o 'extra' (turnos extra) // turnos extra cuando se acaba el tiempo de ronda (0 = no contar)
// Llamadas a juez desde el contador
db.exec(`CREATE TABLE IF NOT EXISTS cmd_judge_calls (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, pod_id INTEGER NOT NULL, by_id INTEGER, note TEXT,
  at TEXT DEFAULT (datetime('now')), resolved_at TEXT, resolved_by TEXT)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_judge_open ON cmd_judge_calls(resolved_at, event_id)');
// Encuesta al acabar la mesa: ¿cada mazo era del bracket del torneo?
db.exec(`CREATE TABLE IF NOT EXISTS cmd_bracket_votes (pod_id INTEGER NOT NULL, voter_id INTEGER NOT NULL, target_id INTEGER NOT NULL, vote TEXT NOT NULL,
  at TEXT DEFAULT (datetime('now')), PRIMARY KEY (pod_id, voter_id, target_id))`); // minutos para avisar de un turno largo (0 = no avisar) // combos de 2 cartas prohibidos antes de esta vuelta (0 = sin límite)

class LifeError extends Error {}
const HOW = { dano: 'daño', comandante: 'daño de comandante', veneno: 'veneno', concede: 'se rindió', desempate: 'perdió el desempate', otro: 'otra forma' };

function podInfo(eventId, podId) {
  const pod = db.prepare(`SELECT pd.*, rd.number rnum, rd.event_id FROM cmd_pods pd JOIN cmd_rounds rd ON rd.id = pd.round_id WHERE pd.id = ?`).get(podId);
  if (!pod || pod.event_id !== eventId) throw new LifeError('Mesa no encontrada');
  const players = db.prepare(`SELECT s.seat, p.id, p.name, p.username, p.deck FROM cmd_seats s JOIN cmd_players p ON p.id = s.player_id WHERE s.pod_id = ? ORDER BY s.seat`).all(podId);
  return { pod, players };
}
function fresh(ev, players) {
  const start = [20, 25, 30, 40].includes(ev.life_start) ? ev.life_start : 40;
  return { start, players: players.map(p => ({ id: p.id, name: C.pubName(p), deck: p.deck || '', seat: p.seat, life: start, poison: 0, cmd: {}, out: false, killer: null, how: null, ord: null })), log: [], done: null, turn: null, tstats: {}, ot: null, monarch: null, init: null, day: null, startedAt: null };
}
function load(eventId, podId, create = true) {
  const ev = C.getEvent(eventId);
  if (!ev) throw new LifeError('Torneo no encontrado');
  const { pod, players } = podInfo(eventId, podId);
  pod.timer_end = (db.prepare('SELECT timer_end FROM cmd_rounds WHERE id = ?').get(pod.round_id) || {}).timer_end || null;
  let row = db.prepare('SELECT * FROM cmd_life WHERE pod_id = ?').get(podId);
  if (!row && create) {
    db.prepare('INSERT OR IGNORE INTO cmd_life (pod_id, state) VALUES (?, ?)').run(podId, JSON.stringify(fresh(ev, players)));
    row = db.prepare('SELECT * FROM cmd_life WHERE pod_id = ?').get(podId);
  }
  return { ev, pod, players, state: row ? JSON.parse(row.state) : null, version: row ? row.version : 0 };
}
function view(eventId, podId) {
  const x = load(eventId, podId);
  return { version: x.version, state: x.state, reported: !!x.pod.reported, proposed: !!x.pod.proposed_at, table: x.pod.table_number, round: x.pod.rnum, auto: !!x.ev.life_auto, now: Date.now(), timerEnd: x.pod.timer_end, comboLap: x.ev.combo_lap ?? 5, comboSeat: x.ev.combo_seat || 1, comboLabel: x.ev.combo_label || 'Combos de 3 o más cartas', turnWarn: x.ev.turn_warn ?? 5,
    extraTurns: x.ev.extra_turns ?? 5, timeMode: x.ev.time_mode || 'lap', judge: judgeOpen(podId), canUndo: !!undoable(podId), canRedo: !!redoable(podId) };
}
// Deshacer / rehacer: los cambios de vidas, veneno y comandante desde el último «pasar turno», y ese «pasar turno» (uno solo; más atrás no)
const CHG = "kind IN ('life','poison','cmd')";
const lastTurn = podId => db.prepare("SELECT id, undone, data FROM cmd_life_log WHERE pod_id = ? AND kind = 'turn' ORDER BY id DESC LIMIT 1").get(podId) || null;
function undoable(podId) {
  const t = lastTurn(podId);
  const c = db.prepare(`SELECT * FROM cmd_life_log WHERE pod_id = ? AND undone = 0 AND ${CHG} AND id > ? ORDER BY id DESC LIMIT 1`).get(podId, t ? t.id : 0);
  if (c) return c;
  return t && !t.undone && t.data ? db.prepare('SELECT * FROM cmd_life_log WHERE id = ?').get(t.id) : null;
}
function redoable(podId) {
  const t = lastTurn(podId), from = t ? t.id : 0;
  const inSet = `pod_id = ? AND id >= ? AND (${CHG} OR (kind = 'turn' AND id = ?))`;
  const lastOk = (db.prepare(`SELECT MAX(id) m FROM cmd_life_log WHERE ${inSet} AND undone = 0`).get(podId, from, from) || {}).m || 0;
  return db.prepare(`SELECT * FROM cmd_life_log WHERE ${inSet} AND undone = 1 AND id > ? ORDER BY id ASC LIMIT 1`).get(podId, from, from, lastOk) || null;
}
const cmdKey = fromId => (fromId < 0 ? `${-fromId}b` : String(fromId));
const EXK = { tax: 'impuesto de comandante', energy: 'energía', exp: 'experiencia' };
const HOLD = { monarch: 'el Monarca', init: 'la Iniciativa' };
const mmss = ms => { const x = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };
const dead = p => !p.out && (p.life <= 0 || p.poison >= 10 || Object.values(p.cmd).some(v => v >= 21));
// Quién parece haberle eliminado (para sugerirlo): daño de comandante letal, o el que más daño de comandante le ha hecho
function guess(p) {
  const lethal = Object.entries(p.cmd).find(([, v]) => v >= 21);
  if (lethal) return { killer: parseInt(lethal[0], 10), how: 'comandante' };
  if (p.poison >= 10) return { killer: null, how: 'veneno' };
  return { killer: null, how: 'dano' };
}

// ---------- Historial del contador ----------
// Los toques seguidos sobre el mismo contador se juntan en un solo apunte: si das 5 de daño y corriges 1, queda «−4».
// El apunte se cierra cuando se toca otro jugador u otro contador, o tras unos segundos sin tocar.
const MERGE_MS = 4000;
let curTurn = null; // turno en juego mientras se aplica un cambio (para el historial)
function trackChange(podId, byId, kind, pid, fromId, before, after, lifeAfter) {
  const d = after - before;
  if (!d) return;
  const now = Date.now();
  const last = db.prepare('SELECT * FROM cmd_life_log WHERE pod_id = ? ORDER BY id DESC LIMIT 1').get(podId);
  if (last && !last.undone && last.kind === kind && last.pid === pid && (last.from_id || null) === (fromId || null) && last.by_id === byId && now - last.updated_at <= MERGE_MS) {
    const nd = last.delta + d;
    if (nd === 0) db.prepare('DELETE FROM cmd_life_log WHERE id = ?').run(last.id);
    else db.prepare('UPDATE cmd_life_log SET delta = ?, after_v = ?, life_after = ?, updated_at = ? WHERE id = ?').run(nd, after, lifeAfter, now, last.id);
    return;
  }
  db.prepare('INSERT INTO cmd_life_log (pod_id, by_id, kind, pid, from_id, delta, before_v, after_v, life_after, at, updated_at, turn_pid, turn_n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(podId, byId, kind, pid, fromId || null, d, before, after, lifeAfter, now, now, curTurn ? curTurn.pid : null, curTurn ? (curTurn.lap || curTurn.n) : null);
}
function note(podId, byId, kind, pid, text) {
  const now = Date.now();
  return Number(db.prepare('INSERT INTO cmd_life_log (pod_id, by_id, kind, pid, text, at, updated_at, turn_pid, turn_n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(podId, byId, kind, pid || null, text, now, now, curTurn ? curTurn.pid : null, curTurn ? (curTurn.lap || curTurn.n) : null).lastInsertRowid);
}
function history(eventId, podId, limit = 300) {
  const x = load(eventId, podId, false);
  const names = new Map(x.players.map(p => [p.id, C.pubName(p)]));
  const nm = id => names.get(id) || '—';
  const sg = n => (n > 0 ? `+${n}` : `−${-n}`);
  const u = undoable(podId);
  return db.prepare('SELECT * FROM cmd_life_log WHERE pod_id = ? ORDER BY id DESC LIMIT ?').all(podId, limit).map(r => {
    let txt = r.text;
    if (r.kind === 'life') txt = `${nm(r.pid)}: ${sg(r.delta)} ${Math.abs(r.delta) === 1 ? 'vida' : 'vidas'} (${r.before_v} → ${r.after_v})`;
    else if (r.kind === 'poison') txt = `${nm(r.pid)}: ${sg(r.delta)} veneno (${r.before_v} → ${r.after_v})`;
    else if (r.kind === 'cmd') txt = `${nm(r.pid)}: ${sg(r.delta)} de comandante de ${nm(Math.abs(r.from_id))}${r.from_id < 0 ? ' (2º comandante)' : ''} (${r.before_v} → ${r.after_v}; vidas ${r.life_after})`;
    return { id: r.id, at: r.at, updated: r.updated_at, by: r.by_id ? nm(r.by_id) : '', kind: r.kind, txt, turn: r.turn_n && ['life', 'poison', 'cmd', 'kill'].includes(r.kind) ? `Vuelta ${r.turn_n} · turno de ${nm(r.turn_pid)}` : '', undone: !!r.undone, canUndo: !!u && r.id === u.id };
  });
}

function apply(eventId, podId, byId, body) {
  return db.transaction(() => {
    const x = load(eventId, podId);
    const { ev, pod, state } = x;
    if (ev.status !== 'running') throw new LifeError('El torneo no está en juego');
    if (pod.reported) throw new LifeError('Esta mesa ya tiene resultado');
    if (!x.players.some(p => p.id === byId)) throw new LifeError('Solo puede anotar alguien de la mesa');
    if (state.done && body.op !== 'reopen') throw new LifeError('La mesa ya está terminada');
    const P = id => { const p = state.players.find(q => q.id === Number(id)); if (!p) throw new LifeError('Ese jugador no está en la mesa'); return p; };
    const d = Math.max(-50, Math.min(50, Math.round(Number(body.d) || 0)));
    const nm = id => (state.players.find(q => q.id === Number(id)) || {}).name || '—';
    curTurn = state.turn || null;
    if (!state.startedAt) state.startedAt = Date.now();
    const log = (txt, kind = 'note', pid = null) => { state.log.unshift({ at: Date.now(), by: byId, txt }); state.log = state.log.slice(0, 40); return note(podId, byId, kind, pid, txt); };
    switch (body.op) {
      case 'life': {
        const p = P(body.pid); if (p.out) throw new LifeError(`${p.name} ya está eliminado`);
        const b = p.life; p.life = Math.max(-99, Math.min(999, p.life + d));
        trackChange(podId, byId, 'life', p.id, null, b, p.life, p.life);
        break;
      }
      case 'poison': {
        const p = P(body.pid); const b = p.poison; p.poison = Math.max(0, Math.min(99, p.poison + d));
        trackChange(podId, byId, 'poison', p.id, null, b, p.poison, p.life);
        break;
      }
      // Daño de comandante: uno por comandante (los mazos con compañero llevan dos: el 2º va en «<id>b»)
      case 'cmd': {
        const p = P(body.pid), f = P(body.from);
        if (p.id === f.id) throw new LifeError('El daño de comandante es de otro jugador');
        const slot = Number(body.slot) === 1 ? 1 : 0, key = slot ? `${f.id}b` : String(f.id);
        const cur = p.cmd[key] || 0, nv = Math.max(0, Math.min(99, cur + d));
        p.cmd[key] = nv; p.life = Math.max(-99, p.life - (nv - cur));
        trackChange(podId, byId, 'cmd', p.id, slot ? -f.id : f.id, cur, nv, p.life);
        break;
      }
      case 'dual': { const p = P(body.pid); p.dual = !!Number(body.on); log(p.dual ? `${p.name} juega con dos comandantes` : `${p.name} juega con un comandante`); break; }
      // Deshacer un apunte del historial (el último de vidas, veneno o comandante que no esté deshecho)
      case 'undo': {
        const r = undoable(podId);
        if (!r) throw new LifeError('No hay nada más que deshacer');
        if (body.id && Number(body.id) !== r.id) throw new LifeError('Solo se puede deshacer el último cambio');
        if (r.kind === 'turn') { // deshacer «pasar turno»: vuelve el turno de antes (y su tiempo sigue contando)
          const dt = JSON.parse(r.data);
          state.turn = dt.prevTurn ? { ...dt.prevTurn } : null;
          if (dt.stat) { const t = (state.tstats || {})[dt.stat.pid]; if (t) { t.n = Math.max(0, t.n - 1); t.ms = Math.max(0, t.ms - dt.stat.ms); } }
          state.ot = dt.prevOt || null;
          curTurn = state.turn;
          db.prepare('UPDATE cmd_life_log SET undone = 1 WHERE id = ?').run(r.id);
          log(`Deshecho: ${r.text}`, 'undo', null);
          break;
        }
        const p = P(r.pid);
        if (p.out) throw new LifeError(`${p.name} está eliminado: usa «Deshacer» en su panel primero`);
        if (r.kind === 'life') p.life -= r.delta;
        else if (r.kind === 'poison') p.poison = Math.max(0, p.poison - r.delta);
        else { const k = cmdKey(r.from_id); p.cmd[k] = Math.max(0, (p.cmd[k] || 0) - r.delta); p.life += r.delta; }
        db.prepare('UPDATE cmd_life_log SET undone = 1 WHERE id = ?').run(r.id);
        log(`Deshecho: ${history(eventId, podId, 400).find(h => h.id === r.id).txt}`, 'undo', p.id);
        break;
      }
      // Rehacer lo último que se deshizo (si después no se ha tocado nada ni se ha pasado turno)
      case 'redo': {
        const r = redoable(podId);
        if (!r) throw new LifeError('No hay nada que rehacer');
        if (r.kind === 'turn') {
          const dt = JSON.parse(r.data);
          state.turn = { ...dt.nextTurn, at: Date.now() };
          if (dt.stat) { state.tstats = state.tstats || {}; const t = state.tstats[dt.stat.pid] = state.tstats[dt.stat.pid] || { n: 0, ms: 0, max: 0 }; t.n++; t.ms += dt.stat.ms; }
          state.ot = dt.nextOt || null;
          curTurn = state.turn;
          db.prepare('UPDATE cmd_life_log SET undone = 0 WHERE id = ?').run(r.id);
          log(`Rehecho: ${r.text}`, 'redo', null);
          break;
        }
        const p = P(r.pid);
        if (p.out) throw new LifeError(`${p.name} está eliminado`);
        if (r.kind === 'life') p.life += r.delta;
        else if (r.kind === 'poison') p.poison = Math.max(0, p.poison + r.delta);
        else { const k = cmdKey(r.from_id); p.cmd[k] = Math.max(0, (p.cmd[k] || 0) + r.delta); p.life -= r.delta; }
        db.prepare('UPDATE cmd_life_log SET undone = 0 WHERE id = ?').run(r.id);
        log(`Rehecho: ${history(eventId, podId, 400).find(h => h.id === r.id).txt}`, 'redo', p.id);
        break;
      }
      case 'kill': {
        const p = P(body.pid);
        if (p.out) break;
        const killer = body.killer ? P(body.killer) : null;
        if (killer && killer.id === p.id) throw new LifeError('Para eliminarse a sí mismo, elige «Nadie / se rinde»');
        p.out = true; p.killer = killer ? killer.id : null;
        p.how = HOW[body.how] ? body.how : guess(p).how;
        p.ord = state.players.filter(q => q.out).length;
        db.prepare('INSERT OR REPLACE INTO cmd_kills (pod_id, victim_id, killer_id, how, ord) VALUES (?, ?, ?, ?, ?)').run(podId, p.id, p.killer, p.how, p.ord);
        log(killer ? `${killer.name} elimina a ${p.name}` : `${p.name} queda fuera (${HOW[p.how]})`, 'kill', p.id);
        break;
      }
      case 'revive': {
        const p = P(body.pid);
        if (!p.out) break;
        p.out = false; p.killer = null; p.how = null; p.ord = null;
        if (p.life <= 0) p.life = 1;
        db.prepare('DELETE FROM cmd_kills WHERE pod_id = ? AND victim_id = ?').run(podId, p.id);
        state.players.filter(q => q.out).sort((a, b) => a.ord - b.ord).forEach((q, i) => { q.ord = i + 1; db.prepare('UPDATE cmd_kills SET ord = ? WHERE pod_id = ? AND victim_id = ?').run(q.ord, podId, q.id); });
        log(`${p.name} vuelve a la partida`, 'revive', p.id);
        break;
      }
      case 'reset': {
        const n = fresh(ev, x.players);
        Object.assign(state, n);
        db.prepare('DELETE FROM cmd_kills WHERE pod_id = ?').run(podId);
        log('Contador reiniciado', 'reset');
        break;
      }
      case 'reopen': state.done = null; log('Mesa reabierta'); break;
      // Turnos: «Pasar turno» va al siguiente jugador vivo por orden de asiento; con pid, empieza o corrige el turno
      case 'turn': {
        // Turno: «Pasar turno» manda «to» (el siguiente en el sentido de las agujas del reloj tal y como está colocada la mesa en ese aparato);
        // sin «to», el siguiente por asiento. Con pid, empieza o corrige el turno.
        // Vuelta: sube cuando le toca a alguien que ya ha jugado en esta vuelta (los combos de 2 cartas no valen antes de la vuelta 6)
        const all = state.players.slice().sort((a, b) => a.seat - b.seat);
        if (!all.some(q => !q.out)) break;
        const prev = state.turn;
        let next;
        if (body.pid) next = P(body.pid);
        else if (body.to && prev) next = P(body.to);
        else if (!prev) next = all.find(q => !q.out);
        else { const i = all.findIndex(q => q.id === prev.pid); next = [...all.slice(i + 1), ...all.slice(0, i + 1)].find(q => !q.out); }
        if (next.out) throw new LifeError(`${next.name} está eliminado`);
        const now = Date.now();
        let txt = '', stat = null;
        const prevOt = state.ot || null;
        if (prev) {
          const ms = now - prev.at, pp = P(prev.pid);
          stat = { pid: prev.pid, ms };
          state.tstats = state.tstats || {};
          const t = state.tstats[prev.pid] = state.tstats[prev.pid] || { n: 0, ms: 0, max: 0 };
          t.n++; t.ms += ms; t.max = Math.max(t.max, ms);
          txt = ` (${pp.name} tardó ${mmss(ms)})`;
        }
        let lap = prev ? (prev.lap || 1) : 1, played = prev ? (prev.played || [prev.pid]) : [];
        if (prev && !body.pid && played.includes(next.id)) { lap++; played = [next.id]; }
        else if (!played.includes(next.id)) played = [...played, next.id];
        state.turn = { pid: next.id, n: prev ? prev.n + 1 : 1, lap, played, at: now };
        // Se acabó el tiempo de ronda: a partir de aquí se cuentan los turnos extra
        if (prev && !body.pid && !state.ot && pod.timer_end && new Date(pod.timer_end).getTime() <= now) { state.ot = { base: prev.n }; txt += ' · tiempo cumplido, empiezan los turnos extra'; }
        curTurn = state.turn;
        const lid = log(`Vuelta ${lap}: turno de ${next.name}${txt}`, 'turn', next.id);
        db.prepare('UPDATE cmd_life_log SET data = ? WHERE id = ?').run(JSON.stringify({ prevTurn: prev || null, prevOt, stat, nextTurn: state.turn, nextOt: state.ot || null }), lid);
        break;
      }
      case 'lap': { // corregir la vuelta a mano
        if (!state.turn) throw new LifeError('Primero empieza los turnos');
        state.turn.lap = Math.max(1, Math.min(99, Number(body.lap) || 1));
        curTurn = state.turn;
        log(`Vuelta corregida: ${state.turn.lap}`);
        break;
      }
      case 'turnoff': state.turn = null; state.ot = null; log('Sin turnos'); break;
      // Contadores extra: impuesto de comandante, energía, experiencia; Monarca e Iniciativa; día/noche
      case 'extra': {
        const k = body.key; if (!EXK[k]) throw new LifeError('Contador no válido');
        const p = P(body.pid); p.x = p.x || {};
        const b = p.x[k] || 0; p.x[k] = Math.max(0, Math.min(99, b + d));
        if (p.x[k] !== b) log(`${p.name}: ${EXK[k]} ${b} → ${p.x[k]}`, 'extra', p.id);
        break;
      }
      case 'holder': {
        const k = body.key; if (!HOLD[k]) throw new LifeError('No válido');
        const p = body.pid ? P(body.pid) : null;
        state[k] = p ? p.id : null;
        log(p ? `${p.name} tiene ${HOLD[k]}` : `Nadie tiene ${HOLD[k]}`, 'extra', p && p.id);
        break;
      }
      case 'day': state.day = ['day', 'night'].includes(body.v) ? body.v : null; log(state.day === 'day' ? 'Es de día' : state.day === 'night' ? 'Es de noche' : 'Sin día/noche'); break;
      case 'extras': state.ex = String(body.on || '').split(',').filter(k => EXK[k] || HOLD[k] || k === 'day'); break;
      // Muerte súbita (desempate por tiempo): cualquier daño de un rival elimina; perder vidas por uno mismo no
      case 'sudden':
        state.sudden = !!Number(body.on);
        // Al acabar el tiempo y terminar la vuelta: muerte súbita y se vuelve a elegir quién empieza
        if (state.sudden && Number(body.newturn)) { state.turn = null; state.ot = null; }
        log(state.sudden ? (Number(body.newturn) ? 'Muerte súbita: se vuelve a elegir quién empieza' : 'Muerte súbita') : 'Fin de la muerte súbita');
        break;
      case 'art': {
        const p = P(body.pid);
        if (p.id !== byId) throw new LifeError('Cada jugador cambia solo su propio fondo');
        p.art = body.art ? String(body.art).slice(0, 300) : null;
        p.artOff = !body.art;
        break;
      }
      default: throw new LifeError('Acción no válida');
    }
    db.prepare("UPDATE cmd_life SET state = ?, version = version + 1, updated_at = datetime('now') WHERE pod_id = ?").run(JSON.stringify(state), podId);
    const v = view(eventId, podId);
    setImmediate(() => bus.emit('change', podId, v.version));
    return v;
  })();
}

// Terminar la mesa: el que queda (o el elegido si se acaba el tiempo) gana; el resto, por orden inverso de eliminación
function finish(eventId, podId, byId, winnerId) {
  return db.transaction(() => {
    const x = load(eventId, podId);
    const { ev, pod, state } = x;
    if (ev.status !== 'running') throw new LifeError('El torneo no está en juego');
    if (pod.reported) throw new LifeError('Esta mesa ya tiene resultado');
    if (!x.players.some(p => p.id === byId)) throw new LifeError('Solo puede anotar alguien de la mesa');
    const alive = state.players.filter(p => !p.out);
    // Solo hay ganador cuando queda uno en pie (por daño, veneno, rendición o desempate): nunca por vidas
    if (alive.length !== 1) throw new LifeError(alive.length ? 'La mesa acaba cuando solo queda uno en pie. Si se acaba el tiempo, haced el desempate y marcad como eliminados a los que lo pierdan.' : 'No queda nadie en pie');
    const winner = alive[0];
    const out = state.players.filter(p => p.out).sort((a, b) => b.ord - a.ord);
    const order = [winner, ...out].map(p => p.id);
    if (ev.life_auto) {
      C.reportPod(podId, { order });
      C.clearProposal(podId);
    } else {
      db.prepare("UPDATE cmd_pods SET proposed_winner = ?, proposed_draw = 0, proposed_places = ?, proposed_by = ?, proposed_at = datetime('now') WHERE id = ?")
        .run(winner.id, JSON.stringify(order), byId, podId);
    }
    state.done = { winner: winner.id, order, at: Date.now(), auto: !!ev.life_auto };
    state.log.unshift({ at: Date.now(), by: byId, txt: `${winner.name} gana la mesa` });
    note(podId, byId, 'finish', winner.id, `${winner.name} gana la mesa · ${order.map((id, i) => `${i + 1}º ${state.players.find(p => p.id === id).name}`).join(', ')}`);
    db.prepare("UPDATE cmd_life SET state = ?, version = version + 1, updated_at = datetime('now') WHERE pod_id = ?").run(JSON.stringify(state), podId);
    const v = view(eventId, podId);
    setImmediate(() => bus.emit('change', podId, v.version));
    return v;
  })();
}

// ---------- Arte del comandante (Scryfall, una ilustración por impresión distinta) ----------
const API = (process.env.SCRYFALL_URL || 'https://api.scryfall.com').replace(/\/$/, '');
const artCache = new Map();
const cmdName = deck => String(deck || '').split(/\s+\+\s+|\s*\/\/\s*/)[0].trim();
async function artSearch(name) {
  const q = encodeURIComponent(`!"${name}"`);
  const r = await fetch(`${API}/cards/search?q=${q}&unique=art&order=released&dir=desc&include_extras=true`, { headers: { 'User-Agent': 'JupiterTorneos/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return { ok: r.status === 404, list: [] };
  const j = await r.json();
  return { ok: true, list: (j.data || []).map(x => {
    const iu = x.image_uris || (x.card_faces && x.card_faces[0] && x.card_faces[0].image_uris) || {};
    return iu.art_crop ? { url: iu.art_crop, set: x.set_name || x.set, artist: x.artist || '' } : null;
  }).filter(Boolean).slice(0, 30) };
}
// fuzzy: para el contador casual, donde el nombre se escribe a mano («atraxa» → «Atraxa, Praetors' Voice»)
async function arts(deck, { fuzzy = false } = {}) {
  let name = cmdName(deck);
  if (!name) return [];
  const k = (fuzzy ? '~' : '') + name.toLowerCase();
  const c = artCache.get(k);
  if (c && Date.now() - c.at < (c.list.length || c.ok ? 24 * 3600e3 : 10 * 60e3)) return c.list;
  let res = { ok: false, list: [] };
  try {
    res = await artSearch(name);
    if (!res.list.length && fuzzy) {
      const r = await fetch(`${API}/cards/named?fuzzy=${encodeURIComponent(name)}`, { headers: { 'User-Agent': 'JupiterTorneos/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      let full = null;
      const loc = cardCheckLocal(name);
      if (loc.name || loc.sug.length) full = loc.name || loc.sug[0].name;
      else if (r.ok) full = (await r.json()).name;
      else { // nombre ambiguo («atraxa»): el comandante más jugado que lo contenga
        const r2 = await fetch(`${API}/cards/search?q=${encodeURIComponent(`name:"${name}" is:commander`)}&order=edhrec`, { headers: { 'User-Agent': 'JupiterTorneos/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (r2.ok) { const j = await r2.json(); full = j.data && j.data[0] && j.data[0].name; }
      }
      if (full && full !== name) { name = full; res = await artSearch(name); }
    }
  } catch (e) { /* sin red: sin fondo, se reintenta en unos minutos */ }
  if (artCache.size > 800) artCache.delete(artCache.keys().next().value);
  artCache.set(k, { at: Date.now(), list: res.list, ok: res.ok, name });
  return res.list;
}
// ¿Existe la carta? Primero en la base de cartas local (exacta y luego «contiene»), si no en Scryfall
function cardCheckLocal(q, onlyCmd = false) {
  const P = require('./pricedb');
  const ex = P.lookup(q);
  if (ex && (!onlyCmd || ex.cmd === 1)) return { name: ex.name, cmd: ex.cmd === 1, sug: [] };
  const k = String(q || '').trim().toLowerCase().replace(/[%_]/g, '');
  if (k.length < 2) return { name: null, cmd: false, sug: [] };
  let rows = [];
  try { rows = db.prepare(`SELECT name, cmd FROM card_prices WHERE key LIKE ? ${onlyCmd ? 'AND cmd = 1' : ''} ORDER BY (key LIKE ?) DESC, cmd DESC, length(name) LIMIT 8`).all('%' + k + '%', k + '%'); } catch (e) { /* sin base local */ }
  return { name: ex && !onlyCmd ? ex.name : null, cmd: !!(ex && ex.cmd === 1), sug: rows.map(r => ({ name: r.name, cmd: r.cmd === 1 })) };
}
async function cardCheck(q, onlyCmd = false) {
  const loc = cardCheckLocal(q, onlyCmd);
  if (loc.name || loc.sug.length) return loc;
  if (require('./pricedb').count() > 1000) return loc; // con base local completa, si no está es que no existe
  try {
    const r = await fetch(`${API}/cards/named?fuzzy=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'JupiterTorneos/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const c = await r.json();
      const info = require('./pricedb').rulesInfo(c);
      if (!onlyCmd || info.cmd) return { name: c.name, cmd: !!info.cmd, sug: [] };
    }
  } catch (e) { /* sin red */ }
  return loc;
}
// Ilustración que ha salido de una búsqueda nuestra (para no aceptar cualquier enlace)
const knownArt = url => [...artCache.values()].some(c => c.list.some(a => a.url === url));
const artName = (deck, fuzzy) => { const c = artCache.get((fuzzy ? '~' : '') + (cmdName(deck) || '').toLowerCase()); return (c && c.name) || cmdName(deck); };

// Resumen de vidas por mesa (para la TV y la página del torneo)
function summary(podIds) {
  if (!podIds.length) return new Map();
  const rows = db.prepare(`SELECT pod_id, state FROM cmd_life WHERE pod_id IN (${podIds.map(() => '?').join(',')})`).all(...podIds);
  return new Map(rows.map(r => { const s = JSON.parse(r.state); return [r.pod_id, Object.fromEntries(s.players.map(p => [p.id, { life: p.life, out: p.out, poison: p.poison }]))]; }));
}
function killsByPod() {
  const m = new Map();
  for (const k of db.prepare('SELECT * FROM cmd_kills').all()) { if (!m.has(k.pod_id)) m.set(k.pod_id, []); m.get(k.pod_id).push(k); }
  return m;
}
// ---------- Llamar a un juez ----------
function judgeOpen(podId) {
  const r = db.prepare('SELECT id, at FROM cmd_judge_calls WHERE pod_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1').get(podId);
  return r ? { id: r.id, at: r.at } : null;
}
function callJudge(eventId, podId, byId, on, note) {
  const x = load(eventId, podId);
  if (x.ev.status !== 'running') throw new LifeError('El torneo no está en juego');
  if (!x.players.some(p => p.id === byId)) throw new LifeError('Solo puede llamar alguien de la mesa');
  const open = judgeOpen(podId);
  if (on && !open) db.prepare('INSERT INTO cmd_judge_calls (event_id, pod_id, by_id, note) VALUES (?, ?, ?, ?)').run(eventId, podId, byId, note ? String(note).slice(0, 140) : null);
  if (!on && open) db.prepare("UPDATE cmd_judge_calls SET resolved_at = datetime('now'), resolved_by = 'mesa' WHERE id = ?").run(open.id);
  db.prepare("UPDATE cmd_life SET version = version + 1 WHERE pod_id = ?").run(podId);
  const v = view(eventId, podId);
  setImmediate(() => bus.emit('change', podId, v.version));
  return v;
}
function resolveJudge(id, who) {
  const r = db.prepare('SELECT pod_id FROM cmd_judge_calls WHERE id = ?').get(id);
  db.prepare("UPDATE cmd_judge_calls SET resolved_at = datetime('now'), resolved_by = ? WHERE id = ? AND resolved_at IS NULL").run(who || 'tienda', id);
  if (r) { db.prepare("UPDATE cmd_life SET version = version + 1 WHERE pod_id = ?").run(r.pod_id); const v = db.prepare('SELECT version FROM cmd_life WHERE pod_id = ?').get(r.pod_id); if (v) setImmediate(() => bus.emit('change', r.pod_id, v.version)); }
}
const judgeCalls = (eventId, open = true) => db.prepare(`SELECT j.*, pd.table_number tn, p.name bn FROM cmd_judge_calls j JOIN cmd_pods pd ON pd.id = j.pod_id LEFT JOIN cmd_players p ON p.id = j.by_id
  WHERE ${eventId ? 'j.event_id = ? AND' : ''} ${open ? 'j.resolved_at IS NULL' : '1'} ORDER BY j.id DESC`).all(...(eventId ? [eventId] : []));
// ---------- Encuesta de bracket ----------
function vote(eventId, podId, byId, votes) {
  const x = load(eventId, podId, false);
  if (!x.players.some(p => p.id === byId)) throw new LifeError('Solo vota alguien de la mesa');
  const ins = db.prepare('INSERT OR REPLACE INTO cmd_bracket_votes (pod_id, voter_id, target_id, vote) VALUES (?, ?, ?, ?)');
  for (const [t, v] of Object.entries(votes || {})) {
    if (Number(t) === byId || !x.players.some(p => p.id === Number(t)) || !['ok', 'up', 'down'].includes(v)) continue;
    ins.run(podId, byId, Number(t), v);
  }
  return { ok: true };
}
// Por jugador del evento: cuántos dijeron que su mazo iba más fuerte o más flojo
function bracketVotes(eventId) {
  return db.prepare(`SELECT v.target_id id, p.name, p.deck, p.deck_bracket,
      SUM(v.vote = 'up') up, SUM(v.vote = 'down') down, SUM(v.vote = 'ok') ok, COUNT(*) n
    FROM cmd_bracket_votes v JOIN cmd_pods pd ON pd.id = v.pod_id JOIN cmd_rounds rd ON rd.id = pd.round_id JOIN cmd_players p ON p.id = v.target_id
    WHERE rd.event_id = ? GROUP BY v.target_id ORDER BY up DESC, down DESC`).all(eventId);
}
// Turnos que pasan del aviso (para la pantalla de la tienda)
function slowTurns() {
  const now = Date.now();
  return db.prepare(`SELECT l.pod_id, l.state, pd.table_number tn, e.turn_warn FROM cmd_life l JOIN cmd_pods pd ON pd.id = l.pod_id JOIN cmd_rounds rd ON rd.id = pd.round_id
    JOIN cmd_events e ON e.id = rd.event_id WHERE e.status = 'running' AND e.public = 1 AND pd.reported = 0 AND e.turn_warn > 0`).all().flatMap(r => {
    const s = JSON.parse(r.state); const t = s.turn;
    if (!t || s.done || now - t.at < r.turn_warn * 60000) return [];
    const p = s.players.find(q => q.id === t.pid);
    return p && !p.out ? [{ id: `${r.pod_id}-${t.n}`, table: r.tn, name: p.name, lap: t.lap || 1, ms: now - t.at }] : [];
  });
}
// Tiempo de turno de cada jugador en todo el torneo
function turnStats(eventId) {
  const out = new Map();
  for (const r of db.prepare('SELECT l.state FROM cmd_life l JOIN cmd_pods pd ON pd.id = l.pod_id JOIN cmd_rounds rd ON rd.id = pd.round_id WHERE rd.event_id = ?').all(eventId)) {
    const s = JSON.parse(r.state);
    for (const [pid, t] of Object.entries(s.tstats || {})) {
      const p = s.players.find(q => q.id === Number(pid));
      const o = out.get(Number(pid)) || { id: Number(pid), name: p ? p.name : '—', n: 0, ms: 0, max: 0 };
      o.n += t.n; o.ms += t.ms; o.max = Math.max(o.max, t.max); out.set(o.id, o);
    }
  }
  return [...out.values()].filter(o => o.n).map(o => ({ ...o, avg: o.ms / o.n })).sort((a, b) => b.avg - a.avg);
}
const killsOf = podId => db.prepare('SELECT * FROM cmd_kills WHERE pod_id = ? ORDER BY ord').all(podId);

module.exports = { vote, bracketVotes, EXK, HOLD, callJudge, resolveJudge, judgeCalls, judgeOpen, cardCheck, knownArt, artName, mmss, slowTurns, turnStats, history, bus, arts, cmdName, LifeError, HOW, view, apply, finish, summary, killsByPod, killsOf, dead, guess };
