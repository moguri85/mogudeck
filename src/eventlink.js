'use strict';
// Torneos de Magic desde EventLink (lo que ven los jugadores en la app Companion). No es una API pública: se usa la misma que
// su web, con la sesión de la cuenta de la tienda. La sesión se renueva sola (cada renovación da una nueva y se guarda).
// Se guardan en las mismas tablas que los de Melee, con source = 'eventlink'.
const { db, setting, setSetting, log, feature } = require('./db');
const { STATUS } = require('./melee');
require('./riftbound'); // columnas source/ext_* y tabla ext_ids
const { localId } = require('./riftbound');

const GQL = 'https://api.tabletop.wizards.com/silverbeak-griffin-service/graphql';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const enabled = () => feature('eventlink') && !!setting('el_refresh');
const orgId = () => String(setting('el_org') || '').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Cabecera que manda su web (la versión sale de su config.js)
let client = null, clientAt = 0;
async function clientHeader() {
  if (client && Date.now() - clientAt < 6 * 3600e3) return client;
  let v = '00000000';
  try { const js = await (await fetch('https://eventlink.wizards.com/config.js', { headers: { 'User-Agent': UA } })).text(); v = (js.match(/SGW_VERSION\s*:\s*"([^"]+)"/) || [])[1] || v; } catch (e) { /* versión por defecto */ }
  client = `client:eventlink version:${v} platform:Linux/chrome/130`; clientAt = Date.now();
  return client;
}
async function raw(query, variables, token) {
  const r = await fetch(GQL, { method: 'POST', signal: AbortSignal.timeout(25000),
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'x-wotc-client': await clientHeader(), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }) });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch (e) { throw new Error(`EventLink: HTTP ${r.status}`); }
  return j;
}

// ---------- Sesión ----------
let access = null, accessUntil = 0, who = null, lastError = null;
async function token() {
  if (access && Date.now() < accessUntil - 60e3) return access;
  const rt = setting('el_refresh');
  if (!rt) throw new Error('Falta conectar la cuenta de EventLink');
  const j = await raw(`query refreshToken($refreshToken: String!, $provider: AuthProvider) {
    refreshToken(refreshToken: $refreshToken, provider: $provider) { access_token refresh_token expires_in persona_id display_name } }`,
  { refreshToken: rt, provider: setting('el_provider') || 'auth0' });
  const t = j.data && j.data.refreshToken;
  if (!t || !t.access_token) {
    setSetting('el_status', 'caducada');
    throw new Error('La sesión de EventLink ha caducado: vuelve a conectarla' + (j.errors ? ` (${j.errors.map(e => e.message).join(' | ').slice(0, 160)})` : ''));
  }
  if (t.refresh_token) setSetting('el_refresh', t.refresh_token); // la anterior ya no vale
  access = t.access_token; accessUntil = Date.now() + (Number(t.expires_in) || 900) * 1000; who = t.display_name || null;
  setSetting('el_status', 'ok'); if (who) setSetting('el_who', who);
  return access;
}
async function gql(query, variables) {
  const j = await raw(query, variables, await token());
  if (j.errors && j.errors.length && !j.data) {
    if (j.errors.some(e => /unauth|token|expired/i.test(e.message || ''))) { access = null; }
    throw new Error('EventLink: ' + j.errors.map(e => e.message).join(' | ').slice(0, 300));
  }
  return j.data;
}
function connect(refresh, provider) {
  const v = String(refresh || '').trim().replace(/^"|"$/g, '');
  if (v.length < 20) throw new Error('Eso no parece la cookie _refresh_EL');
  setSetting('el_refresh', decodeURIComponent(v));
  setSetting('el_provider', /legacy/i.test(provider || '') ? 'legacy' : 'auth0');
  access = null; accessUntil = 0;
}
function disconnect() { setSetting('el_refresh', ''); setSetting('el_status', ''); access = null; }

// ---------- Consultas ----------
const Q_EVENT = `query event($id: ID!) { event(id: $id) {
  id status title scheduledStartTime actualStartTime actualEndTime capacity numberOfPlayers hasTop8 pairingType description
  eventFormat(locale: "es") { id name } entryFee { amount currency }
  registeredPlayers { id personaId displayName firstName lastName status }
} }`;
const Q_STATE = `query st($eventId: ID!, $round: Int!) { gameStateV2AtRound(eventId: $eventId, round: $round) {
  eventId minRounds currentRoundNumber playoffRounds gamesToWin
  drops { teamId roundNumber }
  teams { teamId teamName tableNumber players { personaId displayName firstName lastName } }
  rounds { roundId roundNumber isFinalRound isPlayoff isCertified
    matches { matchId isBye teamIds tableNumber results { isBye wins losses draws teamId } }
    standings { teamId rank wins losses draws matchPoints gameWinPercent opponentGameWinPercent opponentMatchWinPercent } }
} }`;
// Eventos de la tienda (la primera página, sin filtro: el filtro no hace falta y no sabemos sus campos)
const Q_PAGE = `query page($organizationId: ID!) { eventPage(organizationId: $organizationId) { events { id title status scheduledStartTime } pageInfo { page pageSize totalResults } } }`;
const Q_LIVE = `query live($id: ID!) { eventsInProgress(organizationId: $id) { id title scheduledStartTime status round minimumRounds playoffRounds } }`;

const statusOf = s => (/NOT_STARTED|SCHEDULED|UPCOMING|REGISTRATION/i.test(s || '') ? STATUS.REGISTRATION : /RUNNING|IN_PROGRESS|PLAYING/i.test(s || '') ? STATUS.IN_PROGRESS : /ENDED|COMPLET|FINISH|CLOSED/i.test(s || '') ? STATUS.ENDED
  : /CANCEL/i.test(s || '') ? STATUS.CANCELLED : STATUS.REGISTRATION);
const STATUS_ES = { [STATUS.REGISTRATION]: 'Inscripción abierta', [STATUS.IN_PROGRESS]: 'En juego', [STATUS.ENDED]: 'Terminado', [STATUS.CANCELLED]: 'Cancelado' };
const nameOf = p => (p ? (p.displayName && p.displayName !== '[REDACTED]' ? p.displayName : [p.firstName, p.lastName].filter(Boolean).join(' ')) || 'Jugador' : 'Jugador');
const fullOf = p => (p ? [p.firstName, p.lastName].filter(Boolean).join(' ') || nameOf(p) : 'Jugador');

async function fetchAll(id) {
  const ev = (await gql(Q_EVENT, { id: String(id) })).event;
  if (!ev) throw new Error(`No existe el evento ${id} en EventLink`);
  const states = [];
  const first = (await gql(Q_STATE, { eventId: String(id), round: 1 }).catch(() => null))?.gameStateV2AtRound || null;
  if (first) {
    states.push(first);
    for (let r = 2; r <= (first.currentRoundNumber || 1); r++) { states.push((await gql(Q_STATE, { eventId: String(id), round: r })).gameStateV2AtRound); await sleep(300); }
  }
  return { ev, states };
}

function save({ ev, states }) {
  const tid = localId('el', ev.id);
  const prev = db.prepare('SELECT id, ext_updated FROM tournaments WHERE id = ?').get(tid);
  let status = statusOf(ev.status);
  // Si en EventLink no lo cierran, pero ya pasó y se jugó, se da por terminado
  const startMs = Date.parse(ev.actualStartTime || ev.scheduledStartTime || '');
  if (status !== STATUS.ENDED && status !== STATUS.CANCELLED && !isNaN(startMs) && Date.now() - startMs > 14 * 3600e3 && states.length) status = STATUS.ENDED;
  const last = states[states.length - 1] || null;
  // Rondas: de cada estado, la ronda de ese número (así sale con sus resultados finales)
  const rounds = [];
  states.forEach((s, i) => { const rd = (s.rounds || []).find(x => x.roundNumber === i + 1) || (s.rounds || [])[i]; if (rd) rounds.push(rd); });
  if (last) for (const rd of last.rounds || []) if (!rounds.some(x => x.roundNumber === rd.roundNumber)) rounds.push(rd);
  rounds.sort((a, b) => a.roundNumber - b.roundNumber);
  const teams = new Map();
  for (const s of states) for (const t of s.teams || []) teams.set(t.teamId, t);
  const teamId = ext => localId('elteam', `${ev.id}:${ext}`);
  const total = last ? (last.minRounds || 0) + (last.playoffRounds || 0) : null;
  const fee = ev.entryFee && ev.entryFee.amount != null ? Math.round(Number(ev.entryFee.amount) * (Number(ev.entryFee.amount) % 1 ? 100 : (Number(ev.entryFee.amount) > 100 ? 1 : 100))) : null;

  db.transaction(() => {
    db.prepare(`INSERT INTO tournaments (id, guid, name, game, status, status_desc, type_desc, formats, start_date, last_pair, rounds_total, current_round,
        synced_at, details_synced_at, source, ext_id, ext_url, price_cents, final_synced)
      VALUES (@id, @guid, @name, 'MagicTheGathering', @status, @sd, @type, @formats, @start, @lp, @total, @cur, datetime('now'), datetime('now'), 'eventlink', @ext, @url, @price, @final)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, status = excluded.status, status_desc = excluded.status_desc, type_desc = excluded.type_desc,
        formats = excluded.formats, start_date = CASE WHEN tournaments.start_date_manual = 1 THEN tournaments.start_date ELSE excluded.start_date END,
        last_pair = excluded.last_pair, rounds_total = excluded.rounds_total, current_round = excluded.current_round, synced_at = datetime('now'),
        details_synced_at = datetime('now'), ext_url = excluded.ext_url, price_cents = COALESCE(tournaments.price_cents, excluded.price_cents), final_synced = excluded.final_synced`)
      .run({ id: tid, guid: `el:${ev.id}`, name: ev.title, status, sd: STATUS_ES[status] + (/NOT_STARTED|SCHEDULED|UPCOMING|REGISTRATION|RUNNING|IN_PROGRESS|PLAYING|ENDED|COMPLET|FINISH|CLOSED|CANCEL/i.test(ev.status || '') ? '' : ` (${ev.status})`), type: ev.pairingType || null,
        formats: JSON.stringify(ev.eventFormat && ev.eventFormat.name ? [ev.eventFormat.name] : []), start: ev.actualStartTime || ev.scheduledStartTime || null,
        lp: status === STATUS.IN_PROGRESS ? new Date().toISOString() : ev.actualEndTime || null, total: total || null, cur: rounds.length,
        ext: String(ev.id), url: orgId() ? `https://eventlink.wizards.com/stores/${orgId()}/events/${ev.id}` : 'https://eventlink.wizards.com/', price: fee,
        final: status === STATUS.ENDED ? 1 : 0 });
    // Al traerlo por primera vez, se ocultan los que no son torneos (rol, juego libre) y los de Commander que ya llevamos aquí
    if (!prev || prev.ext_updated !== 'h1') {
      db.prepare("UPDATE tournaments SET ext_updated = 'h1' WHERE id = ?").run(tid);
      const fmt = `${ev.eventFormat && ev.eventFormat.name || ''} ${ev.title || ''}`;
      const day = !isNaN(startMs) ? new Date(startMs).toLocaleDateString('sv-SE', { timeZone: require('./config').tz }) : null;
      // Commander de EventLink el mismo día que un Commander de aquí: es el mismo evento, se unen (sale el de aquí)
      const cmd = day && /commander/i.test(fmt) ? db.prepare('SELECT id, start_date FROM cmd_events WHERE start_date IS NOT NULL').all()
        .filter(e => new Date(e.start_date).toLocaleDateString('sv-SE', { timeZone: require('./config').tz }) === day)
        .sort((x, y) => Math.abs(Date.parse(x.start_date) - startMs) - Math.abs(Date.parse(y.start_date) - startMs))[0] : null;
      if (cmd) db.prepare('UPDATE tournaments SET hidden = 1, linked_ref = ? WHERE id = ?').run(`c:${cmd.id}`, tid);
      else if (/dungeons|d&d|\brol\b/i.test(fmt) || (/\bother\b/i.test(ev.eventFormat && ev.eventFormat.name || '') && /play|libre|abierto/i.test(ev.title || '')))
        db.prepare('UPDATE tournaments SET hidden = 1 WHERE id = ?').run(tid);
    }
    if (!prev) db.prepare('UPDATE tournaments SET notified_new = 1, notified_round = CASE WHEN status = 4 THEN 999 ELSE 0 END, notified_final = CASE WHEN status = 4 THEN 1 ELSE 0 END WHERE id = ?').run(tid);

    db.prepare('DELETE FROM rounds WHERE tournament_id = ?').run(tid);
    const insR = db.prepare('INSERT OR REPLACE INTO rounds (id, tournament_id, phase_id, phase_name, phase_sort, name, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const rd of rounds) insR.run(localId('elround', `${ev.id}:${rd.roundNumber}`), tid, rd.isPlayoff ? 2 : 1, rd.isPlayoff ? 'Top' : 'Suizo', rd.isPlayoff ? 2 : 1,
      rd.isPlayoff ? (rd.isFinalRound ? 'Final' : `Top · ronda ${rd.roundNumber}`) : `Ronda ${rd.roundNumber}`, rd.roundNumber);

    // Jugadores: los equipos del torneo (uno por jugador en 1 contra 1); antes de empezar, los inscritos
    db.prepare('DELETE FROM players WHERE tournament_id = ?').run(tid);
    const insP = db.prepare(`INSERT OR REPLACE INTO players (team_id, tournament_id, player_id, user_key, username, display_name, full_name, status, status_desc,
      dropped_round, paid, checked_in, registered_at) VALUES (?, ?, NULL, ?, NULL, ?, ?, 1, ?, ?, 0, 1, NULL)`);
    const drops = new Map((last && last.drops || []).map(d => [d.teamId, d.roundNumber]));
    if (teams.size) {
      for (const t of teams.values()) {
        const p = (t.players || [])[0];
        insP.run(teamId(t.teamId), tid, p && p.personaId ? `mtg:${p.personaId}` : `n:${(t.teamName || nameOf(p)).toLowerCase()}`, t.teamName && (t.players || []).length > 1 ? t.teamName : nameOf(p),
          (t.players || []).length > 1 ? (t.players || []).map(fullOf).join(' / ') : fullOf(p), 'ACTIVE', drops.get(t.teamId) ?? null);
      }
    } else {
      for (const p of (ev.registeredPlayers || []).filter(p => !/CANCEL|WITHDRAW|REMOVED/i.test(p.status || ''))) {
        insP.run(localId('elteam', `${ev.id}:reg:${p.personaId || p.id}`), tid, p.personaId ? `mtg:${p.personaId}` : `n:${nameOf(p).toLowerCase()}`, nameOf(p), fullOf(p), p.status || null, null);
      }
    }

    db.prepare('DELETE FROM matches WHERE tournament_id = ?').run(tid);
    const insM = db.prepare(`INSERT OR REPLACE INTO matches (guid, tournament_id, round_id, round_number, phase_sort, table_number, published, has_result, is_bye,
      team1, team2, wins1, wins2, draws, result_string, created_at) VALUES (@guid, @tid, @rid, @n, @ps, @table, 1, @has, @bye, @t1, @t2, @w1, @w2, @d, @res, NULL)`);
    for (const rd of rounds) {
      const rid = localId('elround', `${ev.id}:${rd.roundNumber}`);
      for (const m of rd.matches || []) {
        const [a, b] = m.teamIds || [];
        const ra = (m.results || []).find(x => x.teamId === a), rb = (m.results || []).find(x => x.teamId === b);
        const bye = !!m.isBye || !b;
        const has = bye || !!(ra || rb);
        const w1 = ra ? ra.wins : bye ? 2 : null, w2 = rb ? rb.wins : ra ? ra.losses : null, d = ra ? ra.draws || 0 : 0;
        insM.run({ guid: `el:${m.matchId}`, tid, rid, n: rd.roundNumber, ps: rd.isPlayoff ? 2 : 1, table: m.tableNumber ?? null, has: has ? 1 : 0, bye: bye ? 1 : 0,
          t1: a ? teamId(a) : null, t2: bye ? null : teamId(b), w1, w2, d, res: bye ? 'Bye' : has ? `${w1}-${w2}${d ? `-${d}` : ''}` : null });
      }
    }

    db.prepare('DELETE FROM standings WHERE tournament_id = ?').run(tid);
    const withSt = rounds.filter(rd => (rd.standings || []).length);
    const st = withSt[withSt.length - 1];
    if (st) {
      const insS = db.prepare(`INSERT OR REPLACE INTO standings (tournament_id, team_id, rank, points, match_record, game_record, omw, gw, ogw, round_number)
        VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?)`);
      const pct = v => (v == null ? null : v > 1 ? v / 100 : v);
      for (const s of st.standings) insS.run(tid, teamId(s.teamId), s.rank, s.matchPoints ?? null, `${s.wins ?? 0}-${s.losses ?? 0}-${s.draws ?? 0}`,
        pct(s.opponentMatchWinPercent), pct(s.gameWinPercent), pct(s.opponentGameWinPercent), st.roundNumber);
    }
  })();
  return tid;
}

// ---------- Sincronización ----------
let running = false, lastList = 0, pageInfo = '';
const state = () => ({ running, lastError, lastList, pageInfo, org: orgId(), connected: !!setting('el_refresh'), status: setting('el_status') || '', who: setting('el_who') || '' });
async function syncOne(id) {
  const tid = save(await fetchAll(id));
  try { await require('./sync').runNotifications(tid); } catch (e) { /* avisos opcionales */ }
  return tid;
}
async function syncAll({ liveOnly = false } = {}) {
  if (running || !enabled()) return;
  running = true;
  try {
    const ids = new Set();
    if (!liveOnly && orgId()) {
      for (const e of (await gql(Q_LIVE, { id: orgId() })).eventsInProgress || []) ids.add(String(e.id));
      // Los de la tienda de 2 días atrás a 3 semanas vista (los demás, si hacen falta, se añaden por su enlace)
      try {
        const evs = ((await gql(Q_PAGE, { organizationId: orgId() })).eventPage || {}).events || [];
        const from = Date.now() - 2 * 864e5, to = Date.now() + 21 * 864e5;
        for (const e of evs) { const t = Date.parse(e.scheduledStartTime || ''); if (!isNaN(t) && t >= from && t <= to && !/CANCEL/i.test(e.status || '')) ids.add(String(e.id)); }
        pageInfo = `${evs.length} eventos en su lista`;
      } catch (e) { pageInfo = e.message; log('warn', `EventLink lista: ${e.message}`); }
    }
    for (const r of db.prepare(`SELECT ext_id FROM tournaments WHERE source = 'eventlink' AND hidden = 0 AND (status = 2 ${liveOnly ? '' : 'OR status = 1 OR (status = 4 AND final_synced = 0)'})`).all()) ids.add(r.ext_id);
    for (const id of ids) { try { await syncOne(id); } catch (e) { log('warn', e.message); } await sleep(700); }
    if (!liveOnly) lastList = Date.now();
    lastError = null;
    try { require('./badges').invalidate(); require('./rivals').invalidate(); } catch (e) { /* opcionales */ }
  } catch (e) { lastError = e.message; log('warn', e.message); } finally { running = false; }
}
function start() {
  setTimeout(() => syncAll(), 35e3);
  setInterval(() => syncAll(), 5 * 60e3);
  setInterval(() => syncAll({ liveOnly: true }), 60e3);
}
// Añadir por su enlace de EventLink (…/stores/<tienda>/events/<evento>) o por el número del evento
async function addByUrl(u) {
  const s = String(u || '');
  const org = (s.match(/stores\/(\d+)/) || [])[1];
  const ev = (s.match(/events\/(\d+)/) || [])[1] || (s.match(/^\s*(\d{5,})\s*$/) || [])[1];
  if (org && !orgId()) setSetting('el_org', org);
  if (!ev) throw new Error('Pega el enlace del evento de EventLink');
  return syncOne(ev);
}

module.exports = { start, syncAll, syncOne, addByUrl, connect, disconnect, state, token, save };
