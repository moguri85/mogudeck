'use strict';
// Contador de vidas de Commander por mesa: vidas, daño de comandante, veneno y quién elimina a quién.
// El estado vive en el servidor para que todos los móviles de la mesa (o uno en el centro) vean lo mismo.
const { db, addColumn } = require('./db');
const C = require('./commander');

db.exec(`
CREATE TABLE IF NOT EXISTS cmd_life (
  pod_id INTEGER PRIMARY KEY REFERENCES cmd_pods(id) ON DELETE CASCADE,
  state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cmd_kills (
  pod_id INTEGER NOT NULL REFERENCES cmd_pods(id) ON DELETE CASCADE, victim_id INTEGER NOT NULL, killer_id INTEGER,
  how TEXT, ord INTEGER, at TEXT DEFAULT (datetime('now')), PRIMARY KEY (pod_id, victim_id)
);
`);
addColumn('cmd_events', 'life_auto', 'INTEGER DEFAULT 0');
addColumn('cmd_events', 'life_start', 'INTEGER DEFAULT 40');

class LifeError extends Error {}
const HOW = { dano: 'daño', comandante: 'daño de comandante', veneno: 'veneno', concede: 'se rindió', otro: 'otra forma' };

function podInfo(eventId, podId) {
  const pod = db.prepare(`SELECT pd.*, rd.number rnum, rd.event_id FROM cmd_pods pd JOIN cmd_rounds rd ON rd.id = pd.round_id WHERE pd.id = ?`).get(podId);
  if (!pod || pod.event_id !== eventId) throw new LifeError('Mesa no encontrada');
  const players = db.prepare(`SELECT s.seat, p.id, p.name, p.username, p.deck FROM cmd_seats s JOIN cmd_players p ON p.id = s.player_id WHERE s.pod_id = ? ORDER BY s.seat`).all(podId);
  return { pod, players };
}
function fresh(ev, players) {
  const start = [20, 25, 30, 40].includes(ev.life_start) ? ev.life_start : 40;
  return { start, players: players.map(p => ({ id: p.id, name: C.pubName(p), deck: p.deck || '', seat: p.seat, life: start, poison: 0, cmd: {}, out: false, killer: null, how: null, ord: null })), log: [], done: null };
}
function load(eventId, podId, create = true) {
  const ev = C.getEvent(eventId);
  if (!ev) throw new LifeError('Torneo no encontrado');
  const { pod, players } = podInfo(eventId, podId);
  let row = db.prepare('SELECT * FROM cmd_life WHERE pod_id = ?').get(podId);
  if (!row && create) {
    db.prepare('INSERT OR IGNORE INTO cmd_life (pod_id, state) VALUES (?, ?)').run(podId, JSON.stringify(fresh(ev, players)));
    row = db.prepare('SELECT * FROM cmd_life WHERE pod_id = ?').get(podId);
  }
  return { ev, pod, players, state: row ? JSON.parse(row.state) : null, version: row ? row.version : 0 };
}
function view(eventId, podId) {
  const x = load(eventId, podId);
  return { version: x.version, state: x.state, reported: !!x.pod.reported, proposed: !!x.pod.proposed_at, table: x.pod.table_number, round: x.pod.rnum, auto: !!x.ev.life_auto };
}
const dead = p => !p.out && (p.life <= 0 || p.poison >= 10 || Object.values(p.cmd).some(v => v >= 21));
// Quién parece haberle eliminado (para sugerirlo): daño de comandante letal, o el que más daño de comandante le ha hecho
function guess(p) {
  const lethal = Object.entries(p.cmd).find(([, v]) => v >= 21);
  if (lethal) return { killer: Number(lethal[0]), how: 'comandante' };
  if (p.poison >= 10) return { killer: null, how: 'veneno' };
  return { killer: null, how: 'dano' };
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
    const log = txt => { state.log.unshift({ at: Date.now(), by: byId, txt }); state.log = state.log.slice(0, 40); };
    switch (body.op) {
      case 'life': { const p = P(body.pid); if (p.out) throw new LifeError(`${p.name} ya está eliminado`); p.life = Math.max(-99, Math.min(999, p.life + d)); break; }
      case 'poison': { const p = P(body.pid); p.poison = Math.max(0, Math.min(99, p.poison + d)); break; }
      case 'cmd': {
        const p = P(body.pid), f = P(body.from);
        if (p.id === f.id) throw new LifeError('El daño de comandante es de otro jugador');
        const cur = p.cmd[f.id] || 0, nv = Math.max(0, Math.min(99, cur + d));
        p.cmd[f.id] = nv; p.life = Math.max(-99, p.life - (nv - cur));
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
        log(killer ? `${killer.name} elimina a ${p.name}` : `${p.name} queda fuera (${HOW[p.how]})`);
        break;
      }
      case 'revive': {
        const p = P(body.pid);
        if (!p.out) break;
        p.out = false; p.killer = null; p.how = null; p.ord = null;
        if (p.life <= 0) p.life = 1;
        db.prepare('DELETE FROM cmd_kills WHERE pod_id = ? AND victim_id = ?').run(podId, p.id);
        state.players.filter(q => q.out).sort((a, b) => a.ord - b.ord).forEach((q, i) => { q.ord = i + 1; db.prepare('UPDATE cmd_kills SET ord = ? WHERE pod_id = ? AND victim_id = ?').run(q.ord, podId, q.id); });
        log(`${p.name} vuelve a la partida`);
        break;
      }
      case 'reset': {
        const n = fresh(ev, x.players);
        Object.assign(state, n);
        db.prepare('DELETE FROM cmd_kills WHERE pod_id = ?').run(podId);
        log('Contador reiniciado');
        break;
      }
      case 'reopen': state.done = null; log('Mesa reabierta'); break;
      default: throw new LifeError('Acción no válida');
    }
    db.prepare("UPDATE cmd_life SET state = ?, version = version + 1, updated_at = datetime('now') WHERE pod_id = ?").run(JSON.stringify(state), podId);
    return view(eventId, podId);
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
    let winner;
    if (alive.length === 1) winner = alive[0];
    else {
      winner = alive.find(p => p.id === Number(winnerId));
      if (!winner) throw new LifeError(alive.length ? 'Elige quién gana la mesa' : 'No queda nadie en pie');
    }
    const rest = alive.filter(p => p.id !== winner.id).sort((a, b) => b.life - a.life);
    const out = state.players.filter(p => p.out).sort((a, b) => b.ord - a.ord);
    const order = [winner, ...rest, ...out].map(p => p.id);
    if (ev.life_auto) {
      C.reportPod(podId, { order });
      C.clearProposal(podId);
    } else {
      db.prepare("UPDATE cmd_pods SET proposed_winner = ?, proposed_draw = 0, proposed_places = ?, proposed_by = ?, proposed_at = datetime('now') WHERE id = ?")
        .run(winner.id, JSON.stringify(order), byId, podId);
    }
    state.done = { winner: winner.id, order, at: Date.now(), auto: !!ev.life_auto };
    state.log.unshift({ at: Date.now(), by: byId, txt: `${winner.name} gana la mesa` });
    db.prepare("UPDATE cmd_life SET state = ?, version = version + 1, updated_at = datetime('now') WHERE pod_id = ?").run(JSON.stringify(state), podId);
    return view(eventId, podId);
  })();
}

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
const killsOf = podId => db.prepare('SELECT * FROM cmd_kills WHERE pod_id = ? ORDER BY ord').all(podId);

module.exports = { LifeError, HOW, view, apply, finish, summary, killsByPod, killsOf, dead, guess };
