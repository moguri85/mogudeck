'use strict';
// Comunidad: recompensas («Se busca»), porra, tengo/busco, mazos de préstamo, momentos para la TV y precio del meta.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, addColumn } = require('./db');
const config = require('./config');
const data = require('./data');
const C = require('./commander');
const I = require('./identity');
const rivals = require('./rivals');

db.exec(`
CREATE TABLE IF NOT EXISTS bounties (
  id INTEGER PRIMARY KEY, person_key TEXT NOT NULL, reward TEXT NOT NULL, note TEXT, game TEXT,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')), created_by TEXT,
  claimed_key TEXT, claimed_at TEXT, claimed_event TEXT, claimed_href TEXT, delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source TEXT NOT NULL, event_id INTEGER NOT NULL, kind TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0, table_no INTEGER NOT NULL DEFAULT 0,
  pick INTEGER NOT NULL, pick_name TEXT, status TEXT NOT NULL DEFAULT 'open', points INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), resolved_at TEXT,
  UNIQUE (account_id, source, event_id, kind, round, table_no)
);
CREATE TABLE IF NOT EXISTS trade_items (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, game TEXT NOT NULL, card TEXT NOT NULL, norm TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1, note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trade_norm ON trade_items(game, norm);
CREATE TABLE IF NOT EXISTS loan_decks (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  game TEXT NOT NULL, name TEXT NOT NULL, description TEXT, list TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS loan_requests (
  id INTEGER PRIMARY KEY, deck_id INTEGER NOT NULL REFERENCES loan_decks(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, event_label TEXT, message TEXT,
  status TEXT NOT NULL DEFAULT 'pending', owner_note TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS moments (
  id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL, caption TEXT, event_label TEXT,
  file TEXT NOT NULL, mime TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')), reviewed_at TEXT, reviewed_by TEXT
);
CREATE TABLE IF NOT EXISTS badges_seen (account_id INTEGER NOT NULL, badge TEXT NOT NULL, tier INTEGER NOT NULL, seen_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (account_id, badge));
`);

const accName = a => (a ? (a.nick ? '@' + a.nick : a.name.split(' ')[0]) : '—');
const accById = id => db.prepare('SELECT id, name, nick FROM accounts WHERE id = ?').get(id);
const day = s => String(s || '').slice(0, 10);
// Fechas de SQLite («2026-11-23 20:00:00», en UTC) o ISO → milisegundos
const ts = s => { if (!s) return 0; const v = /^\d{4}-\d\d-\d\d \d/.test(s) ? Date.parse(s.replace(' ', 'T') + 'Z') : Date.parse(s); return Number.isFinite(v) ? v : 0; };

// ======================= Recompensas =======================
// Tipos: «beat» ganarle una partida o mesa, «kill» eliminarle tú en el contador de vidas (Commander), «times» ganarle N veces.
// Puede ser solo para un cazador concreto (hunter_key), caducar (expires_at) y ponerla un jugador (poster_account, la revisa la tienda)
addColumn('bounties', 'kind', "TEXT DEFAULT 'beat'");
addColumn('bounties', 'times', 'INTEGER DEFAULT 1');
addColumn('bounties', 'hunter_key', 'TEXT');
addColumn('bounties', 'expires_at', 'TEXT');
addColumn('bounties', 'poster_account', 'INTEGER');
const BKIND = { beat: 'Gánale una partida o una mesa', kill: 'Elimínale tú en una mesa de Commander (contador de vidas)', times: 'Gánale varias veces' };
function bountyHow(b) {
  const people = require('./people');
  const parts = [b.kind === 'times' ? `Gánale ${b.times || 2} veces` : BKIND[b.kind || 'beat'] || BKIND.beat];
  if (b.hunter_key) parts.push(`solo la puede cobrar ${people.publicName(b.hunter_key)}`);
  if (b.expires_at) parts.push(`hasta el ${new Date(b.expires_at.replace(' ', 'T') + 'Z').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}`);
  return parts.join(' · ');
}
function bounties({ status } = {}) {
  check();
  const rows = db.prepare(`SELECT * FROM bounties ${status ? 'WHERE status = ?' : ''} ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 WHEN 'claimed' THEN 2 ELSE 3 END, id DESC`).all(...(status ? [status] : []));
  return rows.map(b => ({ ...b, how: bountyHow(b) }));
}
function addBounty({ person_key, reward, note, game, kind, times, hunter_key, days }, by, { posterAccount = null } = {}) {
  const key = I.resolve(String(person_key || ''));
  if (!key) throw new Error('Elige a un jugador');
  if (!String(reward || '').trim()) throw new Error('Pon la recompensa (p. ej. «un sobre»)');
  const k = BKIND[kind] ? kind : 'beat';
  const hunter = hunter_key ? I.resolve(String(hunter_key)) : null;
  if (hunter && hunter === key) throw new Error('El cazador no puede ser la misma persona');
  if (posterAccount) {
    const acc = require('./accounts').get(posterAccount);
    if (acc && require('./accounts').personKey(acc) === key) throw new Error('No puedes poner precio a tu propia cabeza');
    if (db.prepare("SELECT COUNT(*) c FROM bounties WHERE poster_account = ? AND status IN ('pending','active')").get(posterAccount).c >= 3) throw new Error('Ya tienes 3 cazas abiertas');
  }
  const d = Math.min(Math.max(Number(days) || 0, 0), 90);
  rivals.invalidate();
  return db.prepare(`INSERT INTO bounties (person_key, reward, note, game, created_by, kind, times, hunter_key, expires_at, poster_account, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${d ? `datetime('now', '+${d} days')` : 'NULL'}, ?, ?)`)
    .run(key, String(reward).trim().slice(0, 80), String(note || '').trim().slice(0, 200) || null, (k === 'kill' ? 'commander' : game) || null, by || null,
      k, k === 'times' ? Math.min(Math.max(Number(times) || 2, 2), 10) : 1, hunter, posterAccount, posterAccount ? 'pending' : 'active').lastInsertRowid;
}
function setBounty(id, status) {
  if (status === 'delivered') db.prepare("UPDATE bounties SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?").run(id);
  else if (status === 'cancelled') db.prepare("UPDATE bounties SET status = 'cancelled' WHERE id = ?").run(id);
  else if (status === 'approve') db.prepare("UPDATE bounties SET status = 'active', created_at = datetime('now') WHERE id = ? AND status = 'pending'").run(id);
  else if (status === 'active') db.prepare("UPDATE bounties SET status = 'active', claimed_key = NULL, claimed_at = NULL, claimed_event = NULL, claimed_href = NULL WHERE id = ?").run(id);
}
// Se cobra la primera vez que se cumple desde que se puso (partida 1 contra 1, mesa de Commander ganada, eliminación en el contador…)
function check() {
  const claim = (b, key, ev, href) => db.prepare("UPDATE bounties SET status = 'claimed', claimed_key = ?, claimed_at = datetime('now'), claimed_event = ?, claimed_href = ? WHERE id = ?").run(key, ev, href, b.id);
  db.prepare("UPDATE bounties SET status = 'expired' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < datetime('now')").run();
  let killList = null;
  for (const b of db.prepare("SELECT * FROM bounties WHERE status = 'active'").all()) {
    const okHunter = k => !b.hunter_key || I.resolve(b.hunter_key) === k;
    if (b.kind === 'kill') {
      if (!killList) {
        const people = require('./people'); const idx = people.nameIndex();
        killList = db.prepare(`SELECT k.at, k.pod_id, v.name vn, v.username vu, v.person_key vp, kk.name kn, kk.username ku, kk.person_key kp, e.id eid, e.name ename, rd.number rn
          FROM cmd_kills k JOIN cmd_players v ON v.id = k.victim_id JOIN cmd_players kk ON kk.id = k.killer_id JOIN cmd_pods pd ON pd.id = k.pod_id JOIN cmd_rounds rd ON rd.id = pd.round_id JOIN cmd_events e ON e.id = rd.event_id
          WHERE e.public = 1 ORDER BY k.at`).all().map(r => ({ at: r.at, victim: people.cmdKey({ name: r.vn, username: r.vu, person_key: r.vp }, idx), killer: people.cmdKey({ name: r.kn, username: r.ku, person_key: r.kp }, idx), event: `${r.ename} · ronda ${r.rn}`, href: `/commander/${r.eid}` }));
      }
      const hit = killList.find(k => k.victim === b.person_key && ts(k.at) >= ts(b.created_at) && okHunter(k.killer));
      if (hit) claim(b, hit.killer, hit.event, hit.href);
      continue;
    }
    const losses = rivals.of(b.person_key)
      .filter(e => e.r === 'L' && ts(e.at || e.date) >= ts(b.created_at) && (!b.game || e.game === b.game) && okHunter(e.opp))
      .sort((x, y) => ts(x.at || x.date) - ts(y.at || y.date) || (x.round || 0) - (y.round || 0));
    const need = b.kind === 'times' ? Math.max(2, b.times || 2) : 1;
    const count = new Map();
    for (const l of losses) {
      count.set(l.opp, (count.get(l.opp) || 0) + 1);
      if (count.get(l.opp) >= need) { claim(b, l.opp, `${l.event}${l.round ? ` · ronda ${l.round}` : ''}`, l.href); break; }
    }
  }
}
// Sugerencias: campeones de los torneos de los últimos 14 días sin recompensa activa
function bountySuggestions() {
  const people = require('./people');
  const out = [];
  const active = new Set(db.prepare("SELECT person_key FROM bounties WHERE status IN ('active','pending')").all().map(r => r.person_key));
  // El líder del ranking de experiencia y quien lleva la mejor racha
  try {
    const B = require('./badges');
    const lead = B.leaderboard(1)[0];
    if (lead && !active.has(lead.key)) out.push({ key: lead.key, name: lead.name, why: 'Líder del ranking de experiencia', game: null });
  } catch (e) { /* sin ranking */ }
  for (const t of data.recentTournaments(8)) {
    if (day(t.start_date || t.last_pair) < day(new Date(Date.now() - 14 * 864e5).toISOString())) continue;
    const st = data.standings(t.id, true)[0];
    if (!st) continue;
    const p = data.playersMap(t.id).get(st.team_id);
    if (!p) continue;
    const key = I.resolve(p.username ? 'u:' + p.username.toLowerCase() : p.user_key);
    if (active.has(key) || out.some(o => o.key === key)) continue;
    out.push({ key, name: people.publicName(key), why: `Ganó ${t.name}`, game: t.game });
  }
  for (const e of db.prepare("SELECT * FROM cmd_events WHERE status = 'finished' AND public = 1 ORDER BY COALESCE(start_date, created_at) DESC LIMIT 4").all()) {
    if (day(e.start_date || e.created_at) < day(new Date(Date.now() - 14 * 864e5).toISOString())) continue;
    const ch = C.standings(e.id).find(p => p.rank === 1);
    if (!ch) continue;
    const key = people.keyForCommander(ch);
    if (active.has(key) || out.some(o => o.key === key)) continue;
    out.push({ key, name: people.publicName(key), why: `Ganó ${e.name}`, game: 'commander' });
  }
  return out.slice(0, 6);
}

// ======================= Porra =======================
const PTS = { melee: 1, commander: 2, winner: 5 };
// Mesas abiertas a pronóstico ahora mismo y torneos con «¿quién gana?» abierto
function porraBoard(accountId) {
  resolvePredictions();
  const mine = accountId ? db.prepare("SELECT * FROM predictions WHERE account_id = ?").all(accountId) : [];
  const pickOf = (source, eventId, kind, round, table) => mine.find(p => p.source === source && p.event_id === eventId && p.kind === kind && p.round === round && p.table_no === table) || null;
  const events = [];
  for (const t of data.liveTournaments().concat(data.upcomingTournaments(10).filter(t => t.start_date && new Date(t.start_date) - Date.now() < 3 * 864e5))) {
    if (events.some(e => e.source === 'melee' && e.id === t.id)) continue;
    const round = data.currentRound(t.id);
    const pm = data.playersMap(t.id);
    const tables = round ? data.pairings(t.id, round).filter(p => !p.bye && p.p2).map(p => ({
      table: p.table, round, locked: p.hasResult,
      options: [{ id: p.t1, name: p.p1 }, { id: p.t2, name: p.p2 }], pick: pickOf('melee', t.id, 'table', round, p.table),
    })) : [];
    const roster = [...pm.values()].filter(p => p.status !== 0).map(p => ({ id: p.team_id, name: data.playerName(p) })).sort((a, b) => a.name.localeCompare(b.name));
    events.push({ source: 'melee', id: t.id, name: t.name, game: t.game, href: `/t/${t.id}`, round, tables,
      winnerOpen: round <= 1 && roster.length >= 4, roster, winnerPick: pickOf('melee', t.id, 'winner', 0, 0) });
  }
  for (const e of C.liveEvents().concat(db.prepare("SELECT * FROM cmd_events WHERE public = 1 AND status = 'setup' AND start_date IS NOT NULL AND start_date <= datetime('now', '+3 days')").all())) {
    if (events.some(x => x.source === 'commander' && x.id === e.id)) continue;
    const rd = C.currentRound(e.id);
    const tables = rd ? C.podsOfRound(rd.id).map(p => ({
      table: p.table_number, round: rd.number, locked: !!p.reported || !!p.proposed_at,
      options: p.players.map(x => ({ id: x.id, name: C.pubName(x) })), pick: pickOf('commander', e.id, 'table', rd.number, p.table_number),
    })) : [];
    const roster = C.players(e.id).map(p => ({ id: p.id, name: C.pubName(p) })).sort((a, b) => a.name.localeCompare(b.name));
    events.push({ source: 'commander', id: e.id, name: e.name, game: 'commander', href: `/commander/${e.id}`, round: rd ? rd.number : 0, tables,
      winnerOpen: (!rd || rd.number <= 1) && roster.length >= 4, roster, winnerPick: pickOf('commander', e.id, 'winner', 0, 0) });
  }
  return events;
}
function predict(accountId, { source, event, kind, round, table, pick }) {
  const board = porraBoard(accountId);
  const ev = board.find(e => e.source === source && e.id === Number(event));
  if (!ev) throw new Error('Ese torneo ya no admite pronósticos');
  let name;
  if (kind === 'winner') {
    if (!ev.winnerOpen) throw new Error('El «¿quién gana?» se cierra al empezar la ronda 2');
    const o = ev.roster.find(x => x.id === Number(pick));
    if (!o) throw new Error('Elige un jugador');
    name = o.name; round = 0; table = 0;
  } else {
    const tb = ev.tables.find(x => x.round === Number(round) && x.table === Number(table));
    if (!tb) throw new Error('Esa mesa ya no está en juego');
    if (tb.locked) throw new Error('Esa mesa ya tiene resultado');
    const o = tb.options.find(x => x.id === Number(pick));
    if (!o) throw new Error('Elige a quién crees que gana');
    name = o.name;
  }
  db.prepare(`INSERT INTO predictions (account_id, source, event_id, kind, round, table_no, pick, pick_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, source, event_id, kind, round, table_no) DO UPDATE SET pick = excluded.pick, pick_name = excluded.pick_name, updated_at = datetime('now')`)
    .run(accountId, source, ev.id, kind, Number(round) || 0, Number(table) || 0, Number(pick), name);
  return name;
}
function resolvePredictions() {
  const open = db.prepare("SELECT * FROM predictions WHERE status = 'open'").all();
  if (!open.length) return;
  const set = db.prepare("UPDATE predictions SET status = ?, points = ?, resolved_at = datetime('now') WHERE id = ?");
  for (const p of open) {
    let winner, done = false, draw = false;
    if (p.source === 'melee') {
      const t = data.tournament(p.event_id);
      if (!t) { set.run('void', 0, p.id); continue; }
      if (p.kind === 'winner') {
        if (t.status === 4) { done = true; const s = data.standings(t.id, true)[0]; winner = s && s.team_id; }
        else if (t.status === 3) { set.run('void', 0, p.id); continue; }
      } else {
        const m = db.prepare('SELECT * FROM matches WHERE tournament_id = ? AND round_number = ? AND table_number = ? AND published = 1').get(p.event_id, p.round, p.table_no);
        if (m && m.has_result) { done = true; const w1 = m.wins1 ?? 0, w2 = m.wins2 ?? 0; if (w1 === w2) draw = true; else winner = w1 > w2 ? m.team1 : m.team2; }
      }
    } else {
      const e = C.getEvent(p.event_id);
      if (!e) { set.run('void', 0, p.id); continue; }
      if (p.kind === 'winner') {
        if (e.status === 'finished') { done = true; const ch = C.standings(e.id).find(x => x.rank === 1); winner = ch && ch.id; }
      } else {
        const pod = db.prepare(`SELECT pd.* FROM cmd_pods pd JOIN cmd_rounds rd ON rd.id = pd.round_id WHERE rd.event_id = ? AND rd.number = ? AND pd.table_number = ?`).get(p.event_id, p.round, p.table_no);
        if (!pod) { set.run('void', 0, p.id); continue; }
        if (pod.reported) { done = true; if (pod.is_draw) draw = true; else winner = pod.winner_id; }
      }
    }
    if (!done) continue;
    if (draw || winner == null) { set.run('void', 0, p.id); continue; }
    const ok = Number(winner) === p.pick;
    set.run(ok ? 'win' : 'lose', ok ? (p.kind === 'winner' ? PTS.winner : PTS[p.source]) : 0, p.id);
  }
}
function porraRanking({ month } = {}) {
  resolvePredictions();
  const where = month ? "AND strftime('%Y-%m', COALESCE(p.resolved_at, p.created_at)) = ?" : '';
  return db.prepare(`SELECT a.id, a.name, a.nick, SUM(p.points) pts, SUM(p.status = 'win') ok, SUM(p.status IN ('win','lose')) total
    FROM predictions p JOIN accounts a ON a.id = p.account_id WHERE p.status IN ('win','lose') ${where}
    GROUP BY a.id HAVING total > 0 ORDER BY pts DESC, ok DESC, total ASC LIMIT 50`).all(...(month ? [month] : []))
    .map((r, i) => ({ ...r, pos: i + 1, who: accName(r), pct: Math.round(r.ok * 100 / r.total) }));
}
function porraStats(accountId) {
  resolvePredictions();
  const r = db.prepare(`SELECT COALESCE(SUM(points),0) pts, SUM(status = 'win') ok, SUM(status IN ('win','lose')) total, SUM(status = 'open') open FROM predictions WHERE account_id = ?`).get(accountId);
  return { pts: r.pts || 0, ok: r.ok || 0, total: r.total || 0, open: r.open || 0 };
}

// ======================= Tengo / Busco =======================
const TRADE_GAMES = [['MagicTheGathering', 'Magic'], ['StarWarsUnlimited', 'SWU'], ['CyberpunkTCG', 'Cyberpunk'], ['Riftbound', 'Riftbound'], ['other', 'Otros']];
const tradeGame = g => (TRADE_GAMES.find(x => x[0] === g) || TRADE_GAMES[4]);
const normCard = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function parseCardLines(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/).slice(0, 200)) {
    let line = raw.trim();
    if (!line) continue;
    let qty = 1;
    let m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (m) { qty = parseInt(m[1], 10); line = m[2]; } else if ((m = line.match(/^(.+?)\s+x\s*(\d+)$/i))) { qty = parseInt(m[2], 10); line = m[1]; }
    line = line.replace(/\s+\([A-Za-z0-9]{2,6}\)(\s+[\w★-]+)?$/, '').trim().slice(0, 120);
    if (line && qty > 0 && qty < 100) out.push({ card: line, qty });
  }
  return out;
}
function addTrades(accountId, kind, game, text, note) {
  if (!['have', 'want'].includes(kind)) throw new Error('Tipo no válido');
  game = tradeGame(game)[0];
  const lines = parseCardLines(text);
  if (!lines.length) throw new Error('Escribe al menos una carta');
  const count = db.prepare('SELECT COUNT(*) c FROM trade_items WHERE account_id = ?').get(accountId).c;
  if (count + lines.length > 500) throw new Error('Como mucho 500 cartas entre las dos listas');
  const ins = db.prepare('INSERT INTO trade_items (account_id, kind, game, card, norm, qty, note) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const upd = db.prepare('UPDATE trade_items SET qty = ? WHERE id = ?');
  db.transaction(() => {
    for (const l of lines) {
      const n = normCard(l.card);
      const ex = db.prepare('SELECT id FROM trade_items WHERE account_id = ? AND kind = ? AND game = ? AND norm = ?').get(accountId, kind, game, n);
      if (ex) upd.run(l.qty, ex.id); else ins.run(accountId, kind, game, l.card, n, l.qty, String(note || '').slice(0, 120) || null);
    }
  })();
  return lines.length;
}
const myTrades = accountId => db.prepare('SELECT * FROM trade_items WHERE account_id = ? ORDER BY kind, game, card COLLATE NOCASE').all(accountId);
const delTrade = (accountId, id) => db.prepare('DELETE FROM trade_items WHERE id = ? AND account_id = ?').run(id, accountId);
const clearTrades = (accountId, kind) => db.prepare('DELETE FROM trade_items WHERE account_id = ? AND kind = ?').run(accountId, kind);
// Cuándo vuelve por la tienda (próximo torneo al que está apuntado)
function nextVisit(acc) {
  const cmd = db.prepare(`SELECT e.name, e.start_date FROM cmd_players p JOIN cmd_events e ON e.id = p.event_id
    WHERE p.account_id = ? AND e.status != 'finished' AND p.dropped_round IS NULL AND p.waitlist = 0 ORDER BY e.start_date LIMIT 1`).get(acc.id);
  const person = I.resolve('a:' + acc.id);
  let melee = null;
  for (const t of data.upcomingTournaments(30).concat(data.liveTournaments())) {
    for (const p of data.playersMap(t.id).values()) {
      if (p.status === 0) continue;
      if (I.resolve(p.username ? 'u:' + p.username.toLowerCase() : p.user_key) === person) { melee = { name: t.name, start_date: t.start_date }; break; }
    }
    if (melee) break;
  }
  return [cmd, melee].filter(Boolean).sort((a, b) => String(a.start_date || '9').localeCompare(String(b.start_date || '9')))[0] || null;
}
// Cruces: quién tiene lo que busco y quién busca lo que tengo
function tradeMatches(accountId) {
  const rows = db.prepare(`SELECT o.*, m.kind mykind, m.card mycard FROM trade_items m JOIN trade_items o
    ON o.game = m.game AND o.norm = m.norm AND o.kind != m.kind AND o.account_id != m.account_id WHERE m.account_id = ?`).all(accountId);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.account_id)) by.set(r.account_id, { acc: accById(r.account_id), theyHave: [], theyWant: [] });
    const g = by.get(r.account_id);
    (r.kind === 'have' ? g.theyHave : g.theyWant).push({ card: r.card, qty: r.qty, game: r.game });
  }
  return [...by.values()].filter(x => x.acc).map(x => ({ ...x, who: accName(x.acc), next: nextVisit(x.acc), score: x.theyHave.length * 2 + x.theyWant.length + (x.theyHave.length && x.theyWant.length ? 5 : 0) }))
    .sort((a, b) => b.score - a.score);
}
function tradeBrowse({ q, game, kind } = {}) {
  const args = [], where = [];
  if (q) { where.push('t.norm LIKE ?'); args.push('%' + normCard(q) + '%'); }
  if (game) { where.push('t.game = ?'); args.push(game); }
  if (kind) { where.push('t.kind = ?'); args.push(kind); }
  return db.prepare(`SELECT t.*, a.name aname, a.nick anick FROM trade_items t JOIN accounts a ON a.id = t.account_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.created_at DESC LIMIT 200`).all(...args).map(r => ({ ...r, who: accName({ name: r.aname, nick: r.anick }) }));
}
const tradeCount = () => db.prepare('SELECT kind, COUNT(*) c FROM trade_items GROUP BY kind').all().reduce((o, r) => ({ ...o, [r.kind]: r.c }), { have: 0, want: 0 });

// ======================= Mazos de préstamo =======================
const loanStatus = { pending: 'Pendiente', accepted: 'Aceptada', rejected: 'Rechazada', returned: 'Devuelto', cancelled: 'Cancelada' };
function addLoanDeck(accountId, { game, name, description, list }) {
  name = String(name || '').trim().slice(0, 80);
  if (!name) throw new Error('Ponle nombre al mazo');
  if (db.prepare('SELECT COUNT(*) c FROM loan_decks WHERE account_id = ? AND active = 1').get(accountId).c >= 12) throw new Error('Como mucho 12 mazos para prestar');
  return db.prepare('INSERT INTO loan_decks (account_id, game, name, description, list) VALUES (?, ?, ?, ?, ?)')
    .run(accountId, tradeGame(game)[0], name, String(description || '').trim().slice(0, 400) || null, String(list || '').slice(0, 20000) || null).lastInsertRowid;
}
const removeLoanDeck = (accountId, id) => db.prepare('UPDATE loan_decks SET active = 0 WHERE id = ? AND account_id = ?').run(id, accountId);
function loanDecks({ game } = {}) {
  return db.prepare(`SELECT d.*, a.name aname, a.nick anick,
      (SELECT COUNT(*) FROM loan_requests r WHERE r.deck_id = d.id AND r.status = 'accepted') busy,
      (SELECT COUNT(*) FROM loan_requests r WHERE r.deck_id = d.id AND r.status = 'returned') lent
    FROM loan_decks d JOIN accounts a ON a.id = d.account_id WHERE d.active = 1 ${game ? 'AND d.game = ?' : ''} ORDER BY d.created_at DESC`).all(...(game ? [game] : []))
    .map(d => ({ ...d, who: accName({ name: d.aname, nick: d.anick }) }));
}
const loanDeck = id => db.prepare('SELECT d.*, a.name aname, a.nick anick FROM loan_decks d JOIN accounts a ON a.id = d.account_id WHERE d.id = ?').get(id);
function requestLoan(accountId, deckId, { event_label, message }) {
  const d = loanDeck(deckId);
  if (!d || !d.active) throw new Error('Ese mazo ya no está disponible');
  if (d.account_id === accountId) throw new Error('Es tu propio mazo');
  if (db.prepare("SELECT 1 FROM loan_requests WHERE deck_id = ? AND account_id = ? AND status IN ('pending','accepted')").get(deckId, accountId)) throw new Error('Ya tienes una solicitud para este mazo');
  const ev = String(event_label || '').trim().slice(0, 120);
  if (!ev) throw new Error('Dinos para qué torneo o día lo quieres');
  db.prepare('INSERT INTO loan_requests (deck_id, account_id, event_label, message) VALUES (?, ?, ?, ?)').run(deckId, accountId, ev, String(message || '').trim().slice(0, 300) || null);
}
function loanAction(accountId, reqId, action, note) {
  const r = db.prepare('SELECT r.*, d.account_id owner FROM loan_requests r JOIN loan_decks d ON d.id = r.deck_id WHERE r.id = ?').get(reqId);
  if (!r) throw new Error('Solicitud no encontrada');
  const owner = r.owner === accountId, asker = r.account_id === accountId;
  const allowed = { accept: owner && r.status === 'pending', reject: owner && ['pending', 'accepted'].includes(r.status), returned: owner && r.status === 'accepted', cancel: asker && ['pending', 'accepted'].includes(r.status) };
  if (!allowed[action]) throw new Error('No puedes hacer eso con esta solicitud');
  const st = { accept: 'accepted', reject: 'rejected', returned: 'returned', cancel: 'cancelled' }[action];
  db.prepare("UPDATE loan_requests SET status = ?, owner_note = COALESCE(?, owner_note), updated_at = datetime('now') WHERE id = ?").run(st, String(note || '').trim().slice(0, 200) || null, reqId);
  return st;
}
function myLoans(accountId) {
  const decks = db.prepare('SELECT * FROM loan_decks WHERE account_id = ? AND active = 1 ORDER BY created_at DESC').all(accountId);
  const incoming = db.prepare(`SELECT r.*, d.name dname, a.name aname, a.nick anick FROM loan_requests r JOIN loan_decks d ON d.id = r.deck_id JOIN accounts a ON a.id = r.account_id
    WHERE d.account_id = ? ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END, r.created_at DESC LIMIT 40`).all(accountId).map(r => ({ ...r, who: accName({ name: r.aname, nick: r.anick }) }));
  const outgoing = db.prepare(`SELECT r.*, d.name dname, a.name aname, a.nick anick FROM loan_requests r JOIN loan_decks d ON d.id = r.deck_id JOIN accounts a ON a.id = d.account_id
    WHERE r.account_id = ? ORDER BY r.created_at DESC LIMIT 40`).all(accountId).map(r => ({ ...r, who: accName({ name: r.aname, nick: r.anick }) }));
  return { decks, incoming, outgoing };
}
const loanPending = accountId => db.prepare(`SELECT COUNT(*) c FROM loan_requests r JOIN loan_decks d ON d.id = r.deck_id WHERE d.account_id = ? AND r.status = 'pending'`).get(accountId).c;

// ======================= Momentos (fotos para la TV, con moderación) =======================
const MOM_DIR = path.join(config.dataDir, 'moments');
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ['image/jpeg', 'jpg'];
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ['image/png', 'png'];
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return ['image/webp', 'webp'];
  return null;
}
function addMoment(accountId, file, { caption, event_label }) {
  if (!file || !file.buffer) throw new Error('Elige una foto');
  const t = sniff(file.buffer);
  if (!t) throw new Error('La foto tiene que ser JPG, PNG o WebP');
  const today = db.prepare("SELECT COUNT(*) c FROM moments WHERE account_id = ? AND created_at >= datetime('now', '-1 day')").get(accountId).c;
  if (today >= 5) throw new Error('Como mucho 5 fotos al día');
  if (db.prepare("SELECT COUNT(*) c FROM moments WHERE account_id = ? AND status = 'pending'").get(accountId).c >= 3) throw new Error('Tienes 3 fotos esperando revisión: espera a que la tienda las mire');
  fs.mkdirSync(MOM_DIR, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${t[1]}`;
  fs.writeFileSync(path.join(MOM_DIR, name), file.buffer);
  return db.prepare('INSERT INTO moments (account_id, caption, event_label, file, mime) VALUES (?, ?, ?, ?, ?)')
    .run(accountId, String(caption || '').trim().slice(0, 120) || null, String(event_label || '').trim().slice(0, 120) || null, name, t[0]).lastInsertRowid;
}
const moment = id => db.prepare('SELECT * FROM moments WHERE id = ?').get(id);
const momentPath = m => path.join(MOM_DIR, path.basename(m.file));
function moments({ status, since, limit = 100 } = {}) {
  const where = [], args = [];
  if (status) { where.push('m.status = ?'); args.push(status); }
  if (since) { where.push("m.created_at >= datetime('now', ?)"); args.push(since); }
  return db.prepare(`SELECT m.*, a.name aname, a.nick anick FROM moments m LEFT JOIN accounts a ON a.id = m.account_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.created_at DESC LIMIT ?`)
    .all(...args, limit).map(m => ({ ...m, who: accName(m.aname ? { name: m.aname, nick: m.anick } : null) }));
}
function reviewMoment(id, status, by) {
  if (status === 'delete') {
    const m = moment(id);
    if (m) { try { fs.unlinkSync(momentPath(m)); } catch (e) { /* ya no estaba */ } db.prepare('DELETE FROM moments WHERE id = ?').run(id); }
    return;
  }
  db.prepare("UPDATE moments SET status = ?, reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?").run(status, by, id);
}
const momentsPending = () => db.prepare("SELECT COUNT(*) c FROM moments WHERE status = 'pending'").get().c;

// ======================= Precio del meta (Commander) =======================
function metaPrice(days = 30) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT p.id, p.name, p.username, p.deck, p.deck_value_cents v, p.deck_bracket b, e.id eid, e.name ename, e.status estatus, e.start_date, e.created_at
    FROM cmd_players p JOIN cmd_events e ON e.id = p.event_id
    WHERE e.public = 1 AND e.status IN ('running','finished') AND p.deck_value_cents IS NOT NULL AND p.waitlist = 0
      AND substr(COALESCE(e.start_date, e.created_at), 1, 10) >= ?`).all(since);
  if (!rows.length) return { decks: 0, days };
  const vals = rows.map(r => r.v).sort((a, b) => a - b);
  const median = vals.length % 2 ? vals[(vals.length - 1) / 2] : Math.round((vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2);
  const avg = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
  // Mesas ganadas por cada jugador
  const podWins = new Map(db.prepare(`SELECT pd.winner_id id, COUNT(*) n FROM cmd_pods pd WHERE pd.reported = 1 AND pd.is_draw = 0 AND pd.winner_id IS NOT NULL GROUP BY pd.winner_id`).all().map(r => [r.id, r.n]));
  const champs = new Set();
  for (const eid of [...new Set(rows.filter(r => r.estatus === 'finished').map(r => r.eid))]) for (const s of C.standings(eid)) if (s.rank === 1) champs.add(s.id);
  const label = r => ({ name: C.pubName(r), deck: r.deck, v: r.v, event: r.ename, href: `/commander/${r.eid}`, bracket: r.b, pods: podWins.get(r.id) || 0, champion: champs.has(r.id) });
  const winners = rows.filter(r => podWins.get(r.id));
  const cheapWinners = winners.slice().sort((a, b) => a.v - b.v).slice(0, 5).map(label);
  const winAvg = winners.length ? Math.round(winners.reduce((s, r) => s + r.v, 0) / winners.length) : null;
  const champRows = rows.filter(r => champs.has(r.id));
  const byBracket = [1, 2, 3, 4, 5].map(b => { const l = rows.filter(r => (b === 2 ? r.b <= 2 && r.b >= 1 : r.b === b)); return { b, n: l.length, avg: l.length ? Math.round(l.reduce((s, r) => s + r.v, 0) / l.length) : null }; })
    .filter(x => x.n && x.b !== 1);
  // Valor y victorias: ¿gana más quien gasta más? (mitad barata vs. mitad cara)
  const cut = median;
  const half = list => { const ids = new Set(list.map(r => r.id)); const n = list.length; const w = [...ids].reduce((s, id) => s + (podWins.get(id) || 0), 0); return { n, w }; };
  const cheapHalf = half(rows.filter(r => r.v <= cut)), dearHalf = half(rows.filter(r => r.v > cut));
  return {
    days, decks: rows.length, avg, median, min: label(rows.find(r => r.v === vals[0])), max: label(rows.find(r => r.v === vals[vals.length - 1])),
    winAvg, cheapWinners, champions: champRows.sort((a, b) => a.v - b.v).map(label), byBracket,
    halves: { cut, cheap: cheapHalf, dear: dearHalf },
  };
}

module.exports = {
  accName, bounties, addBounty, setBounty, checkBounties: check, bountySuggestions, bountyHow, BKIND,
  porraBoard, predict, resolvePredictions, porraRanking, porraStats, PTS,
  TRADE_GAMES, tradeGame, addTrades, myTrades, delTrade, clearTrades, tradeMatches, tradeBrowse, tradeCount, parseCardLines,
  loanStatus, addLoanDeck, removeLoanDeck, loanDecks, loanDeck, requestLoan, loanAction, myLoans, loanPending,
  addMoment, moment, momentPath, moments, reviewMoment, momentsPending,
  metaPrice,
};
