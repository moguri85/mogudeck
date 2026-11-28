'use strict';
// Torneos de Riftbound desde la web de Riot (playriftbound.com). No tienen API pública: se usa la misma que su web,
// que solo admite consultas ya conocidas (cada una con un código que cambia cuando actualizan su web; se vuelve a buscar solo).
// Se guardan en las mismas tablas que los de Melee, con source = 'riftbound', así salen en la agenda, el directo, el ranking…
const { db, setting, setSetting, log, feature, addColumn } = require('./db');
const { STATUS } = require('./melee');

addColumn('tournaments', 'source', "TEXT DEFAULT 'melee'");
addColumn('tournaments', 'ext_id', 'TEXT');
addColumn('tournaments', 'ext_url', 'TEXT');
addColumn('tournaments', 'ext_updated', 'TEXT');
addColumn('tournaments', 'linked_ref', 'TEXT'); // el mismo evento llevado aquí (p. ej. 'c:4', un Commander): no sale repetido
db.exec(`CREATE TABLE IF NOT EXISTS ext_ids (kind TEXT NOT NULL, ext TEXT NOT NULL, id INTEGER PRIMARY KEY AUTOINCREMENT, UNIQUE (kind, ext));
INSERT OR IGNORE INTO sqlite_sequence (name, seq) SELECT 'ext_ids', 900000000 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'ext_ids');`);

// Id local (número) para un id externo: los de Riot no caben en un número de JavaScript
function localId(kind, ext) {
  const k = String(ext);
  const r = db.prepare('SELECT id FROM ext_ids WHERE kind = ? AND ext = ?').get(kind, k);
  if (r) return r.id;
  return Number(db.prepare('INSERT INTO ext_ids (kind, ext) VALUES (?, ?)').run(kind, k).lastInsertRowid);
}

const BASE = 'https://events.playriftbound.com';
const PUBLIC = 'https://playriftbound.com/es-ES/events/';
// Si cambia cómo se guardan, se vuelven a guardar todos aunque en su web no haya cambios
const SAVE_V = 3;
const SEED = ['117557998796655771']; // Valencia Rift Cup (28/11/2026), en juego al estrenar la integración
const DEFAULT_ORG = '01a0c36f-9b35-7de2-816e-1ff2d84aebdc'; // Júpiter Juegos Valencia
const UA = 'Mozilla/5.0 (compatible; JupiterTorneos/1.0; +https://www.moguri.es/jupiter)';
const HEAD = { Accept: 'application/json', 'User-Agent': UA, 'apollo-require-preflight': 'true', 'apollographql-client-name': 'Esports Web', 'apollographql-client-version': '1.0.0' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const orgId = () => (setting('rb_organizer') || DEFAULT_ORG).trim();
const enabled = () => feature('riftbound');

// ---------- Códigos de las consultas (están en los ficheros JS de su web) ----------
let ops = null;
function loadOps() { if (!ops) { try { ops = JSON.parse(setting('rb_ops') || '{}'); } catch (e) { ops = {}; } } return ops; }
async function discoverOps() {
  const get = async u => { const r = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) }); return r.ok ? r.text() : ''; };
  const page = await get(`${BASE}/en-US/events`);
  const found = {}, seen = new Set(), queue = [...page.matchAll(/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g)].map(m => m[1]);
  while (queue.length && seen.size < 150) {
    const c = queue.shift(); if (seen.has(c)) continue; seen.add(c);
    const js = await get(`${BASE}/_next/static/chunks/${c}`); await sleep(120);
    for (const m of js.matchAll(/"id"\s*:\s*"([0-9a-f]{64})"\s*,\s*"name"\s*:\s*"(\w+)"/g)) found[m[2]] = m[1];
    for (const m of js.matchAll(/"name"\s*:\s*"(\w+)"\s*,\s*"id"\s*:\s*"([0-9a-f]{64})"/g)) found[m[1]] = m[2];
    if (found.GetCompeteTournamentForRiftboundPlayer && found.CompeteTournamentSearch && found.GetCompeteRbRefreshPoller) break;
    for (const m of js.matchAll(/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g)) if (!seen.has(m[1])) queue.push(m[1]);
  }
  if (!found.GetCompeteTournamentForRiftboundPlayer) throw new Error('No se encuentran las consultas en su web (¿han cambiado la web?)');
  ops = found; setSetting('rb_ops', JSON.stringify(found));
  log('info', `Riftbound: ${Object.keys(found).length} consultas de su web localizadas`);
  return found;
}
async function gql(name, variables, retry = true) {
  const o = loadOps();
  if (!o[name]) { await discoverOps(); return gql(name, variables, false); }
  const u = `${BASE}/api/gql?` + new URLSearchParams({ operationName: name, variables: JSON.stringify(variables), extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: o[name] } }) });
  const r = await fetch(u, { headers: HEAD, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch (e) { throw new Error(`Riftbound ${name}: HTTP ${r.status}`); }
  const errs = j.errors || [];
  if (errs.some(e => /persisted/i.test(e.message || '') || /PERSISTED_QUERY/.test(e.extensions?.code || ''))) {
    if (!retry) throw new Error(`Riftbound ${name}: la consulta ya no existe en su web`);
    await discoverOps(); return gql(name, variables, false);
  }
  if (!j.data && errs.length) throw new Error(`Riftbound ${name}: ${errs.map(e => e.message).join(' | ')}`);
  return j.data;
}

// ---------- Leer ----------
// Torneos próximos y en juego de la tienda (el buscador de su web va por distancia: se busca alrededor de la tienda)
async function listOrganizer() {
  let at = null;
  try { at = JSON.parse(setting('rb_org_cache') || 'null'); } catch (e) { at = null; }
  if (!at || at.id !== orgId()) {
    const d = await gql('OrganizerSummary', { id: orgId() });
    const o = d.organizerSummary;
    if (!o) throw new Error('No se encuentra la tienda en playriftbound.com');
    at = { id: o.id, name: o.name, lat: o.physicalAddress?.latitude, lng: o.physicalAddress?.longitude };
    setSetting('rb_org_cache', JSON.stringify(at));
  }
  const out = [];
  let after = null;
  for (let page = 0; page < 5; page++) {
    const v = { sport: 'rb', first: 100, filter: { rb: { coords: { latitude: at.lat, longitude: at.lng }, distanceMeters: 2000 } }, sortBy: { rb: 'DATE' } };
    if (after) v.after = after;
    const c = (await gql('CompeteTournamentSearch', v)).competeTournamentSearch;
    for (const e of c?.edges || []) if (e.node.organizer?.id === at.id) out.push(e.node.tournament);
    if (!c?.pageInfo?.hasNextPage) break;
    after = c.pageInfo.endCursor; await sleep(800);
  }
  return { org: at, tournaments: out };
}
const fetchTournament = async ext => ((await gql('GetCompeteTournamentForRiftboundPlayer', { tournamentId: String(ext) })).competeTournaments || [])[0] || null;
const updatedAt = async ext => (await gql('GetCompeteRbRefreshPoller', { tournamentId: String(ext) })).t?.u || null;

// ---------- Guardar en las tablas de torneos ----------
const statusOf = s => (/NOT_STARTED|UPCOMING|SCHEDULED|REGISTRATION|DRAFT|PUBLISHED/i.test(s || '') ? STATUS.REGISTRATION : /IN_PROGRESS|RUNNING/i.test(s || '') ? STATUS.IN_PROGRESS : /COMPLET|FINISH|ENDED|CLOSED|DONE/i.test(s || '') ? STATUS.ENDED
  : /CANCEL/i.test(s || '') ? STATUS.CANCELLED : STATUS.REGISTRATION);
const STATUS_ES = { [STATUS.REGISTRATION]: 'Inscripción abierta', [STATUS.IN_PROGRESS]: 'En juego', [STATUS.ENDED]: 'Terminado', [STATUS.CANCELLED]: 'Cancelado' };
const FORMAT = { CONSTRUCTED: 'Constructed', SEALED: 'Sealed', DRAFT: 'Draft', LIMITED: 'Limited' };
const done = s => /COMPLET|FINISH|ENDED|DONE|FINAL/i.test(s || '');
const elimName = n => (n === 1 ? 'Final' : n === 2 ? 'Semifinales' : n === 4 ? 'Cuartos' : n === 8 ? 'Octavos' : `Top ${n * 2}`);

function save(t) {
  const tid = localId('rb', t.id);
  const prev = db.prepare('SELECT id, price_cents FROM tournaments WHERE id = ?').get(tid);
  const cfg = t.config || {};
  const status = statusOf(t.status);
  // Rondas en orden: suizo y luego la eliminatoria
  const rounds = [];
  (t.stages || []).forEach((st, si) => (st.sections || []).forEach(sec => (sec.rounds || []).forEach(rd => rounds.push({ st, si, sec, rd }))));
  rounds.forEach((x, i) => { x.n = i + 1; });
  const elimRounds = cfg.finalBracketStage?.participantCount ? Math.ceil(Math.log2(cfg.finalBracketStage.participantCount)) : 0;
  const total = Math.max(rounds.length, (cfg.roundCount || 0) + elimRounds);
  const live = rounds.filter(x => /PROGRESS/i.test(x.rd.status || '')).pop();
  const timerEnd = live && live.rd.startedAt && live.rd.roundDuration ? new Date(new Date(live.rd.startedAt).getTime() + live.rd.roundDuration * 60e3).toISOString() : null;
  const teamId = ext => localId('rbteam', `${t.id}:${ext}`);
  const need = Math.ceil((Number(String(cfg.matchFormat || 'BO3').replace(/\D/g, '')) || 3) / 2);

  db.transaction(() => {
    db.prepare(`INSERT INTO tournaments (id, guid, name, game, status, status_desc, type_desc, formats, org_name, start_date, last_pair, timer_state, timer_end,
        rounds_total, current_round, synced_at, details_synced_at, source, ext_id, ext_url, ext_updated, price_cents, final_synced)
      VALUES (@id, @guid, @name, 'Riftbound', @status, @status_desc, @type_desc, @formats, @org_name, @start, @last_pair, @timer_state, @timer_end,
        @total, @cur, datetime('now'), datetime('now'), 'riftbound', @ext, @url, @upd, @price, @final)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status, status_desc = excluded.status_desc, type_desc = excluded.type_desc,
        formats = excluded.formats, org_name = excluded.org_name, start_date = CASE WHEN tournaments.start_date_manual = 1 THEN tournaments.start_date ELSE excluded.start_date END,
        last_pair = excluded.last_pair, timer_state = excluded.timer_state, timer_end = excluded.timer_end, rounds_total = excluded.rounds_total,
        current_round = excluded.current_round, synced_at = datetime('now'), details_synced_at = datetime('now'), ext_url = excluded.ext_url,
        ext_updated = excluded.ext_updated, price_cents = COALESCE(tournaments.price_cents, excluded.price_cents), final_synced = excluded.final_synced`)
      .run({ id: tid, guid: `rb:${t.id}`, name: t.name, status, status_desc: STATUS_ES[status], type_desc: t.tournamentProgram?.programName || cfg.tournamentType || null,
        formats: JSON.stringify(cfg.format ? [FORMAT[cfg.format] || cfg.format] : []), org_name: t.organizer?.name || null, start: t.startsAt || null,
        last_pair: live ? live.rd.startedAt : rounds.length ? rounds[rounds.length - 1].rd.startedAt || null : null, timer_state: timerEnd ? 1 : 0, timer_end: timerEnd,
        total: total || null, cur: rounds.length, ext: String(t.id), url: PUBLIC + t.id, upd: t.updatedAt ? `${t.updatedAt}#${SAVE_V}` : null,
        price: t.entryFee?.minorUnits != null ? t.entryFee.minorUnits : (t.pricing === 'FREE' ? 0 : null), final: status === STATUS.ENDED ? 1 : 0 });
    if (!prev) db.prepare('UPDATE tournaments SET notified_new = CASE WHEN status IN (3,4) THEN 1 ELSE 0 END WHERE id = ?').run(tid);

    // Rondas
    db.prepare('DELETE FROM rounds WHERE tournament_id = ?').run(tid);
    const insR = db.prepare('INSERT OR REPLACE INTO rounds (id, tournament_id, phase_id, phase_name, phase_sort, name, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const x of rounds) {
      const swiss = /SWISS/i.test(x.sec.type || '');
      insR.run(localId('rbround', `${t.id}:${x.sec.esportsSectionId}:${x.rd.roundNumber}`), tid, x.si + 1, swiss ? 'Suizo' : 'Eliminatoria', x.si + 1,
        swiss ? `Ronda ${x.rd.roundNumber}` : elimName((x.rd.matches || []).length || 1), x.n);
    }

    // Jugadores: los que juegan (con su equipo del torneo) y, antes de empezar, los inscritos
    db.prepare('DELETE FROM players WHERE tournament_id = ?').run(tid);
    const insP = db.prepare(`INSERT OR REPLACE INTO players (team_id, tournament_id, player_id, user_key, username, display_name, full_name, status, status_desc,
      dropped_round, paid, checked_in, registered_at) VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, 0, ?, ?)`);
    const checked = new Map((t.tournamentRegistrants || []).map(r => [r.player?.id, r]));
    const parts = t.tournamentParticipants || [];
    if (parts.length) {
      for (const p of parts) {
        const r = checked.get(p.player?.id);
        const dropped = /DROP/i.test(p.status || '');
        insP.run(teamId(p.esportsTeamId), tid, `rb:${p.player.id}`, p.player.displayName, p.player.displayName, 1, p.status || null,
          dropped ? rounds.length || 1 : null, r && r.checkedIn ? 1 : 0, r ? r.acceptedTermsAt : null);
      }
    } else {
      for (const r of (t.tournamentRegistrants || []).filter(r => /REGISTER/i.test(r.status || ''))) {
        insP.run(localId('rbteam', `${t.id}:reg:${r.team?.id || r.player.id}`), tid, `rb:${r.player.id}`, r.player.displayName, r.player.displayName, 1, r.status,
          null, r.checkedIn ? 1 : 0, r.acceptedTermsAt || null);
      }
    }

    // Partidas
    db.prepare('DELETE FROM matches WHERE tournament_id = ?').run(tid);
    const insM = db.prepare(`INSERT OR REPLACE INTO matches (guid, tournament_id, round_id, round_number, phase_sort, table_number, published, has_result, is_bye,
      team1, team2, wins1, wins2, draws, result_string, created_at) VALUES (@guid, @tid, @rid, @n, @ps, @table, 1, @has, @bye, @t1, @t2, @w1, @w2, @d, @res, @at)`);
    for (const x of rounds) {
      const rid = localId('rbround', `${t.id}:${x.sec.esportsSectionId}:${x.rd.roundNumber}`);
      for (const m of x.rd.matches || []) {
        const [a, b] = m.teams || [];
        const games = (m.games || []).filter(g => g.teamOutcomes);
        const res = ext => ({ w: games.filter(g => g.teamOutcomes.some(o => o.esportsTeamId === ext && o.outcome === 'WIN')).length });
        const draws = games.filter(g => g.teamOutcomes.every(o => o.outcome === 'DRAW' || o.outcome === 'TIE')).length;
        const w1 = a ? res(a.esportsTeamId).w : 0, w2 = b ? res(b.esportsTeamId).w : 0;
        // Se da por jugada cuando su web la cierra o cuando alguien ya ha ganado las partidas necesarias (2 en un Bo3)
        const has = done(m.status) || Math.max(w1, w2) >= need || (!!m.teamOutcomes && !/PROGRESS|PENDING|SCHEDULED|NOT_STARTED/i.test(m.status || ''));
        insM.run({ guid: `rb:${m.esportsMatchId}`, tid, rid, n: x.n, ps: x.si + 1, table: m.tableNumber ?? null, has: has ? 1 : 0, bye: b ? 0 : 1,
          t1: a ? teamId(a.esportsTeamId) : null, t2: b ? teamId(b.esportsTeamId) : null, w1, w2, d: draws,
          res: has ? `${w1}-${w2}${draws ? `-${draws}` : ''}` : null, at: x.rd.startedAt || null });
      }
      for (const bye of x.rd.byeTeamIds || []) {
        insM.run({ guid: `rb:bye:${x.rd.roundNumber}:${x.sec.esportsSectionId}:${bye}`, tid, rid, n: x.n, ps: x.si + 1, table: null, has: 1, bye: 1,
          t1: teamId(bye), t2: null, w1: 2, w2: 0, d: 0, res: 'Bye', at: x.rd.startedAt || null });
      }
    }

    // Clasificación: la del último suizo con clasificación y, si hay eliminatoria, el top manda
    db.prepare('DELETE FROM standings WHERE tournament_id = ?').run(tid);
    const withSt = rounds.filter(x => (x.rd.endOfRoundStandings || []).length);
    const lastSt = withSt[withSt.length - 1];
    if (lastSt) {
      const swissRank = new Map(lastSt.rd.endOfRoundStandings.map(s => [s.esportsTeamId, s.rank]));
      const final = new Map(); // equipo → puesto final por la eliminatoria
      const elim = rounds.filter(x => !/SWISS/i.test(x.sec.type || ''));
      if (elim.length) {
        let place = 1;
        const lastRound = elim[elim.length - 1];
        const fm = (lastRound.rd.matches || [])[0];
        if (fm && done(fm.status) && fm.teamOutcomes) {
          const win = fm.teamOutcomes.find(o => o.outcome === 'WIN');
          const lose = fm.teamOutcomes.find(o => o.outcome !== 'WIN');
          if (win) final.set(win.esportsTeamId, place++);
          if (lose) final.set(lose.esportsTeamId, place++);
        }
        // Perdedores de cada ronda anterior de la eliminatoria, de la última a la primera, ordenados por su puesto en el suizo
        for (let i = elim.length - 2; i >= 0; i--) {
          const losers = (elim[i].rd.matches || []).flatMap(m => (m.teamOutcomes || []).filter(o => o.outcome !== 'WIN').map(o => o.esportsTeamId))
            .filter(e => !final.has(e)).sort((x, y) => (swissRank.get(x) || 999) - (swissRank.get(y) || 999));
          const base = Math.max(place, (elim[i].rd.matches || []).length + 1);
          losers.forEach((e, k) => final.set(e, base + k));
          place = base + losers.length;
        }
      }
      const insS = db.prepare(`INSERT OR REPLACE INTO standings (tournament_id, team_id, rank, points, match_record, game_record, omw, gw, ogw, round_number)
        VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)`);
      const pct = v => (v == null ? null : v > 1 ? v / 100 : v);
      const rows = lastSt.rd.endOfRoundStandings.map(s => ({ s, rank: final.get(s.esportsTeamId) || (final.size ? Math.max(final.size, 0) + s.rank : s.rank) }));
      // Los del top van primero; el resto, por su puesto en el suizo detrás
      const topN = final.size;
      const rest = rows.filter(r => !final.has(r.s.esportsTeamId)).sort((x, y) => x.s.rank - y.s.rank);
      rest.forEach((r, i) => { r.rank = topN + i + 1; });
      for (const r of rows) {
        const s = r.s;
        insS.run(tid, teamId(s.esportsTeamId), r.rank, s.matchPoints ?? null, `${s.matchWins ?? 0}-${s.matchLosses ?? 0}-${s.matchDraws ?? 0}`,
          pct(s.opponentMatchWinPercentage), pct(s.gameWinPercentage), pct(s.opponentGameWinPercentage), lastSt.n);
      }
    }
  })();
  return tid;
}

// ---------- Sincronización ----------
let running = false, lastError = null, lastList = 0;
const state = () => ({ running, lastError, lastList, org: orgId(), ops: Object.keys(loadOps()).length });

async function syncOne(ext, { force = false } = {}) {
  const row = db.prepare("SELECT id, ext_updated FROM tournaments WHERE source = 'riftbound' AND ext_id = ?").get(String(ext));
  if (row && !force) {
    const u = await updatedAt(ext);
    if (u && `${u}#${SAVE_V}` === row.ext_updated) return row.id; // sin cambios desde la última vez
  }
  const t = await fetchTournament(ext);
  if (!t) throw new Error(`No existe el torneo ${ext} en playriftbound.com`);
  const tid = save(t);
  try { await require('./sync').runNotifications(tid); } catch (e) { /* avisos opcionales */ }
  return tid;
}
// Lista de la tienda + los que siguen abiertos o en juego aunque ya no salgan en el buscador
async function syncAll() {
  if (running || !enabled()) return;
  running = true;
  try {
    const { tournaments } = await listOrganizer();
    const ids = new Set(tournaments.map(t => String(t.id)));
    // El buscador de su web no devuelve los que ya han empezado: estos se siguen porque se vieron antes. Los que ya estaban en marcha al estrenar esto, a mano
    for (const ext of SEED) if (!db.prepare("SELECT 1 FROM tournaments WHERE source = 'riftbound' AND ext_id = ?").get(ext)) ids.add(ext);
    for (const r of db.prepare("SELECT ext_id FROM tournaments WHERE source = 'riftbound' AND status IN (1, 2) AND hidden = 0").all()) ids.add(r.ext_id);
    for (const ext of ids) { try { await syncOne(ext); } catch (e) { log('warn', e.message); } await sleep(900); }
    lastList = Date.now(); lastError = null;
    try { require('./badges').invalidate(); require('./rivals').invalidate(); } catch (e) { /* opcionales */ }
  } catch (e) { lastError = e.message; log('warn', `Riftbound: ${e.message}`); } finally { running = false; }
}
// En directo: solo los que están en juego, cada poco (primero pregunta si ha cambiado algo)
async function syncLive() {
  if (running || !enabled()) return;
  const live = db.prepare("SELECT ext_id FROM tournaments WHERE source = 'riftbound' AND status = 2 AND hidden = 0").all();
  if (!live.length) return;
  running = true;
  try { for (const r of live) { try { await syncOne(r.ext_id); } catch (e) { log('warn', e.message); } } lastError = null; }
  catch (e) { lastError = e.message; } finally { running = false; }
}
function start() {
  setTimeout(syncAll, 25e3);
  setInterval(syncAll, 15 * 60e3);
  setInterval(syncLive, 45e3);
}
// Añadir a mano uno que no sale en el buscador (por su enlace o su número)
async function addByUrl(u) {
  const m = String(u || '').match(/(\d{15,22})/);
  if (!m) throw new Error('Pega el enlace del torneo de playriftbound.com');
  return syncOne(m[1], { force: true });
}

module.exports = { start, syncAll, syncLive, syncOne, addByUrl, state, discoverOps, save, localId, DEFAULT_ORG, PUBLIC };
