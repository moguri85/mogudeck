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
addColumn('cmd_events', 'life_start', 'INTEGER DEFAULT 40');
addColumn('cmd_events', 'combo_lap', 'INTEGER DEFAULT 6'); // combos de 2 cartas prohibidos antes de esta vuelta (0 = sin límite)

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
  return { start, players: players.map(p => ({ id: p.id, name: C.pubName(p), deck: p.deck || '', seat: p.seat, life: start, poison: 0, cmd: {}, out: false, killer: null, how: null, ord: null })), log: [], done: null, turn: null, tstats: {} };
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
  return { version: x.version, state: x.state, reported: !!x.pod.reported, proposed: !!x.pod.proposed_at, table: x.pod.table_number, round: x.pod.rnum, auto: !!x.ev.life_auto, now: Date.now(), timerEnd: x.pod.timer_end, comboLap: x.ev.combo_lap ?? 6 };
}
const mmss = ms => { const x = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };
const dead = p => !p.out && (p.life <= 0 || p.poison >= 10 || Object.values(p.cmd).some(v => v >= 21));
// Quién parece haberle eliminado (para sugerirlo): daño de comandante letal, o el que más daño de comandante le ha hecho
function guess(p) {
  const lethal = Object.entries(p.cmd).find(([, v]) => v >= 21);
  if (lethal) return { killer: Number(lethal[0]), how: 'comandante' };
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
  db.prepare('INSERT INTO cmd_life_log (pod_id, by_id, kind, pid, text, at, updated_at, turn_pid, turn_n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(podId, byId, kind, pid || null, text, now, now, curTurn ? curTurn.pid : null, curTurn ? (curTurn.lap || curTurn.n) : null);
}
function history(eventId, podId, limit = 300) {
  const x = load(eventId, podId, false);
  const names = new Map(x.players.map(p => [p.id, C.pubName(p)]));
  const nm = id => names.get(id) || '—';
  const sg = n => (n > 0 ? `+${n}` : `−${-n}`);
  return db.prepare('SELECT * FROM cmd_life_log WHERE pod_id = ? ORDER BY id DESC LIMIT ?').all(podId, limit).map(r => {
    let txt = r.text;
    if (r.kind === 'life') txt = `${nm(r.pid)}: ${sg(r.delta)} ${Math.abs(r.delta) === 1 ? 'vida' : 'vidas'} (${r.before_v} → ${r.after_v})`;
    else if (r.kind === 'poison') txt = `${nm(r.pid)}: ${sg(r.delta)} veneno (${r.before_v} → ${r.after_v})`;
    else if (r.kind === 'cmd') txt = `${nm(r.pid)}: ${sg(r.delta)} de comandante de ${nm(r.from_id)} (${r.before_v} → ${r.after_v}; vidas ${r.life_after})`;
    return { id: r.id, at: r.at, updated: r.updated_at, by: r.by_id ? nm(r.by_id) : '', kind: r.kind, txt, turn: r.turn_n && ['life', 'poison', 'cmd', 'kill'].includes(r.kind) ? `Vuelta ${r.turn_n} · turno de ${nm(r.turn_pid)}` : '', undone: !!r.undone, canUndo: ['life', 'poison', 'cmd'].includes(r.kind) && !r.undone };
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
    const log = (txt, kind = 'note', pid = null) => { state.log.unshift({ at: Date.now(), by: byId, txt }); state.log = state.log.slice(0, 40); note(podId, byId, kind, pid, txt); };
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
      case 'cmd': {
        const p = P(body.pid), f = P(body.from);
        if (p.id === f.id) throw new LifeError('El daño de comandante es de otro jugador');
        const cur = p.cmd[f.id] || 0, nv = Math.max(0, Math.min(99, cur + d));
        p.cmd[f.id] = nv; p.life = Math.max(-99, p.life - (nv - cur));
        trackChange(podId, byId, 'cmd', p.id, f.id, cur, nv, p.life);
        break;
      }
      // Deshacer un apunte del historial (el último de vidas, veneno o comandante que no esté deshecho)
      case 'undo': {
        const r = db.prepare("SELECT * FROM cmd_life_log WHERE pod_id = ? AND undone = 0 AND kind IN ('life','poison','cmd') ORDER BY id DESC LIMIT 1").get(podId);
        if (!r) throw new LifeError('No hay nada que deshacer');
        if (body.id && Number(body.id) !== r.id) throw new LifeError('Solo se puede deshacer el último cambio de vidas');
        const p = P(r.pid);
        if (p.out) throw new LifeError(`${p.name} está eliminado: usa «Deshacer» en su panel primero`);
        if (r.kind === 'life') p.life -= r.delta;
        else if (r.kind === 'poison') p.poison = Math.max(0, p.poison - r.delta);
        else { p.cmd[r.from_id] = Math.max(0, (p.cmd[r.from_id] || 0) - r.delta); p.life += r.delta; }
        db.prepare('UPDATE cmd_life_log SET undone = 1 WHERE id = ?').run(r.id);
        log(`Deshecho: ${history(eventId, podId, 400).find(h => h.id === r.id).txt}`, 'undo', p.id);
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
        // Turno: «Pasar turno» va al siguiente vivo por orden de asiento; con pid, empieza o corrige.
        // Vuelta: sube cada vez que el turno vuelve a pasar por quien empezó (los combos de 2 cartas no valen antes de la vuelta 6)
        const all = state.players.slice().sort((a, b) => a.seat - b.seat);
        if (!all.some(q => !q.out)) break;
        const prev = state.turn;
        let next;
        if (body.pid) next = P(body.pid);
        else if (!prev) next = all.find(q => !q.out);
        else { const i = all.findIndex(q => q.id === prev.pid); next = [...all.slice(i + 1), ...all.slice(0, i + 1)].find(q => !q.out); }
        if (next.out) throw new LifeError(`${next.name} está eliminado`);
        const now = Date.now();
        let txt = '';
        if (prev) {
          const ms = now - prev.at, pp = P(prev.pid);
          state.tstats = state.tstats || {};
          const t = state.tstats[prev.pid] = state.tstats[prev.pid] || { n: 0, ms: 0, max: 0 };
          t.n++; t.ms += ms; t.max = Math.max(t.max, ms);
          txt = ` (${pp.name} tardó ${mmss(ms)})`;
        }
        const first = prev && prev.first ? prev.first : next.id;
        const rel = id => { const s0 = all.findIndex(q => q.id === first); return (all.findIndex(q => q.id === id) - s0 + all.length) % all.length; };
        let lap = prev ? (prev.lap || 1) : 1;
        if (prev && !body.pid && rel(next.id) <= rel(prev.pid)) lap++;
        state.turn = { pid: next.id, n: prev ? prev.n + 1 : 1, lap, first, at: now };
        curTurn = state.turn;
        log(`Vuelta ${lap}: turno de ${next.name}${txt}`, 'turn', next.id);
        break;
      }
      case 'lap': { // corregir la vuelta a mano
        if (!state.turn) throw new LifeError('Primero empieza los turnos');
        state.turn.lap = Math.max(1, Math.min(99, Number(body.lap) || 1));
        curTurn = state.turn;
        log(`Vuelta corregida: ${state.turn.lap}`);
        break;
      }
      case 'turnoff': state.turn = null; log('Sin turnos'); break;
      // Muerte súbita (desempate por tiempo): cualquier daño de un rival elimina; perder vidas por uno mismo no
      case 'sudden': state.sudden = !!Number(body.on); log(state.sudden ? 'Muerte súbita' : 'Fin de la muerte súbita'); break;
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
async function arts(deck) {
  const name = cmdName(deck);
  if (!name) return [];
  const k = name.toLowerCase();
  const c = artCache.get(k);
  if (c && Date.now() - c.at < 24 * 3600e3) return c.list;
  let list = [];
  try {
    const q = encodeURIComponent(`!"${name}"`);
    const r = await fetch(`${API}/cards/search?q=${q}&unique=art&order=released&dir=desc&include_extras=true`, { headers: { 'User-Agent': 'JupiterTorneos/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const j = await r.json();
      list = (j.data || []).map(x => {
        const iu = x.image_uris || (x.card_faces && x.card_faces[0] && x.card_faces[0].image_uris) || {};
        return iu.art_crop ? { url: iu.art_crop, set: x.set_name || x.set, artist: x.artist || '' } : null;
      }).filter(Boolean).slice(0, 30);
    }
  } catch (e) { /* sin red: sin fondo */ }
  artCache.set(k, { at: Date.now(), list });
  return list;
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

module.exports = { history, bus, arts, cmdName, LifeError, HOW, view, apply, finish, summary, killsByPod, killsOf, dead, guess };
