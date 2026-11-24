'use strict';
const { db, setting, log } = require('./db');
const melee = require('./melee');
const data = require('./data');
const notify = require('./notify');
const config = require('./config');

const { STATUS } = melee;
let running = false;
let lastListSync = 0, lastRecheck = 0;
let lastError = null;

const state = () => ({ running, lastListSync, lastRecheck, lastError, configured: melee.configured() });

function userKey(p) {
  if (p.UserIdentity) return p.UserIdentity;
  return 'u:' + String(p.Username || p.DisplayName || p.ID).toLowerCase();
}

const upsertTournament = db.prepare(`
INSERT INTO tournaments (id, guid, name, game, status, status_desc, type_desc, formats, org_name, brand_image,
  last_pair, timer_state, timer_end, current_phase_id, rounds_total, synced_at)
VALUES (@id, @guid, @name, @game, @status, @status_desc, @type_desc, @formats, @org_name, @brand_image,
  @last_pair, @timer_state, @timer_end, @current_phase_id, @rounds_total, datetime('now'))
ON CONFLICT(id) DO UPDATE SET guid=excluded.guid, name=excluded.name, game=excluded.game, status=excluded.status,
  status_desc=excluded.status_desc, type_desc=excluded.type_desc, formats=excluded.formats, org_name=excluded.org_name,
  brand_image=excluded.brand_image, last_pair=excluded.last_pair, timer_state=excluded.timer_state,
  timer_end=excluded.timer_end, current_phase_id=excluded.current_phase_id, rounds_total=excluded.rounds_total,
  synced_at=datetime('now')`);

function saveTournament(t) {
  const phases = t.Phases || [];
  const roundsTotal = phases.reduce((n, p) => n + (p.Rounds || []).length, 0);
  upsertTournament.run({
    id: t.ID, guid: t.Guid, name: t.Name, game: t.Game, status: t.Status, status_desc: t.StatusDescription,
    type_desc: t.TournamentTypeDescription, formats: JSON.stringify(t.Formats || []), org_name: t.OrganizationName,
    brand_image: t.BrandImageSource, last_pair: t.LastPairDateTime, timer_state: t.TimerState,
    timer_end: t.TimerEnd, current_phase_id: t.CurrentPhaseId, rounds_total: roundsTotal,
  });
  const ins = db.prepare(`INSERT OR REPLACE INTO rounds (id, tournament_id, phase_id, phase_name, phase_sort, name, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const p of phases) for (const r of p.Rounds || []) ins.run(r.ID, t.ID, p.ID, p.Name, p.SortOrder, r.Name, r.SortOrder);
}

const saveMatches = db.transaction((tid, list, replace) => {
  if (replace) db.prepare('DELETE FROM matches WHERE tournament_id = ?').run(tid);
  const ins = db.prepare(`INSERT OR REPLACE INTO matches (guid, tournament_id, round_id, round_number, phase_sort, table_number,
    published, has_result, is_bye, team1, team2, wins1, wins2, draws, result_string, created_at)
    VALUES (@guid, @tid, @round_id, @round_number, @phase_sort, @table_number, @published, @has_result, @is_bye,
    @team1, @team2, @wins1, @wins2, @draws, @result_string, @created_at)`);
  for (const m of list) {
    const comps = [...(m.Competitors || [])].sort((a, b) => (a.SortOrder ?? 0) - (b.SortOrder ?? 0));
    const c1 = comps[0] || {};
    const c2 = comps[1] || null;
    ins.run({
      guid: m.Guid, tid, round_id: m.RoundId, round_number: m.RoundNumber, phase_sort: m.PhaseSortOrder,
      table_number: m.TableNumber, published: m.MatchesPublished === false ? 0 : 1, has_result: m.HasResult ? 1 : 0,
      is_bye: !c2 || m.ByeReason != null ? 1 : 0,
      team1: c1.TeamId ?? c1.Team?.ID ?? null, team2: c2 ? (c2.TeamId ?? c2.Team?.ID ?? null) : null,
      wins1: c1.GameWins ?? null, wins2: c2 ? (c2.GameWins ?? null) : null, draws: m.GameDraws ?? 0,
      result_string: m.ResultString, created_at: m.DateCreated,
    });
  }
});

const savePlayers = db.transaction((tid, list) => {
  db.prepare('DELETE FROM players WHERE tournament_id = ?').run(tid);
  const ins = db.prepare(`INSERT OR REPLACE INTO players (team_id, tournament_id, player_id, user_key, username, display_name,
    full_name, status, status_desc, dropped_round, paid, checked_in, registered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const p of list) {
    ins.run(p.TeamId, tid, p.ID, userKey(p), p.Username, p.DisplayName, p.PlayerName || p.Name, p.Status,
      p.StatusDescription, p.RoundDroppedNumber ?? null, p.Paid ? 1 : 0, p.IsCheckedIn ? 1 : 0, p.RegistrationDate);
  }
});

const saveStandings = db.transaction((tid, list) => {
  db.prepare('DELETE FROM standings WHERE tournament_id = ?').run(tid);
  const ins = db.prepare(`INSERT OR REPLACE INTO standings (tournament_id, team_id, rank, points, match_record, game_record,
    omw, gw, ogw, round_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const s of list) {
    if (s.StandingsPublished === false) continue;
    ins.run(tid, s.TeamId, s.Rank, s.Points, s.MatchRecord, s.GameRecord, s.OpponentMatchWinPercentage,
      s.TeamGameWinPercentage, s.OpponentGameWinPercentage, s.RoundNumber);
  }
});

const saveDecklists = db.transaction((tid, list) => {
  db.prepare('DELETE FROM decklists WHERE tournament_id = ?').run(tid);
  const ins = db.prepare('INSERT OR REPLACE INTO decklists (id, tournament_id, team_id, name, format, raw) VALUES (?, ?, ?, ?, ?, ?)');
  for (const d of list) {
    const id = String(d.ID ?? d.Guid ?? d.DecklistId ?? Math.random());
    ins.run(id, tid, d.TeamId ?? null, d.Name || d.DecklistName || d.DeckName || 'Sin nombre',
      d.FormatName || d.Format || d.FormatDescription || null, JSON.stringify(d).slice(0, 20000));
  }
});

async function syncDetails(tid, { full = true } = {}) {
  const t = await melee.api.tournament(tid);
  saveTournament(t);
  const [players, matches, standingsList] = await Promise.all([
    melee.api.players(tid),
    full ? melee.api.matches(tid) : melee.api.currentMatches(tid),
    melee.api.standings(tid),
  ]);
  savePlayers(tid, players);
  saveMatches(tid, matches, full);
  saveStandings(tid, standingsList);
  if (full) {
    try { saveDecklists(tid, await melee.api.decklists(tid)); } catch (e) { log('warn', `Decklists ${tid}: ${e.message}`); }
    require('./decks').ensureCards({ tournamentId: tid, limit: 40 }).catch(e => log('warn', `Cartas ${tid}: ${e.message}`));
  }
  const cur = data.currentRound(tid);
  db.prepare(`UPDATE tournaments SET current_round = ?, details_synced_at = datetime('now'),
    final_synced = CASE WHEN status IN (3,4) THEN 1 ELSE 0 END WHERE id = ?`).run(cur, tid);
}

let scrapeBlockedUntil = 0;
async function refreshStartDate(tid, apiObj) {
  const t = data.tournament(tid);
  if (t && t.start_date_manual) return; // fecha puesta a mano por el staff
  const fromApi = melee.apiStartDate(apiObj);
  if (fromApi) { db.prepare('UPDATE tournaments SET start_date = ? WHERE id = ?').run(fromApi, tid); return; }
  if (Date.now() < scrapeBlockedUntil) return; // si Cloudflare bloquea, no insistir en cada vuelta
  try {
    const d = await melee.scrapeStartDate(tid);
    if (d) db.prepare('UPDATE tournaments SET start_date = ? WHERE id = ?').run(d, tid);
  } catch (e) {
    if (/403/.test(e.message)) scrapeBlockedUntil = Date.now() + 30 * 60e3;
    log('warn', `No se pudo leer la fecha del torneo ${tid}: ${e.message}`);
  }
}

function templateIds() {
  return new Set(db.prepare('SELECT melee_template_id id FROM templates WHERE melee_template_id IS NOT NULL').all().map(r => r.id));
}

async function syncList() {
  const bootstrap = db.prepare('SELECT COUNT(*) c FROM tournaments').get().c === 0;
  const from = new Date(Date.now() - 2 * 365 * 864e5).toISOString().slice(0, 10);
  const list = await melee.api.listTournaments(from);
  const known = new Set(db.prepare('SELECT id FROM tournaments').all().map(r => r.id));
  const tpl = templateIds();
  for (const t of list) {
    const isNew = !known.has(t.ID);
    saveTournament(t);
    if (tpl.has(t.ID)) db.prepare('UPDATE tournaments SET hidden = 1 WHERE id = ?').run(t.ID);
    const row = data.tournament(t.ID);
    if (isNew) {
      log('info', `Torneo detectado: ${t.Name} (${t.ID})`);
      if (bootstrap || [STATUS.ENDED, STATUS.CANCELLED].includes(t.Status)) {
        db.prepare('UPDATE tournaments SET notified_new = 1, notified_round = 999, notified_final = 1 WHERE id = ?').run(t.ID);
      }
      seedChecklist(t.ID);
    }
    if (!row.start_date || [STATUS.UNPUBLISHED, STATUS.REGISTRATION].includes(t.Status)) await refreshStartDate(t.ID, t);
    const needsDetails = t.Status === STATUS.REGISTRATION || t.Status === STATUS.IN_PROGRESS
      || (t.Status === STATUS.ENDED && !row.final_synced) || data.isLive(data.tournament(t.ID));
    if (needsDetails) {
      try { await syncDetails(t.ID); } catch (e) { log('error', `Detalle ${t.ID}: ${e.message}`); }
    }
    await runNotifications(t.ID);
  }
  lastListSync = Date.now();
}

async function syncLive() {
  for (const t of data.liveTournaments()) {
    try {
      await syncDetails(t.id, { full: false });
      await runNotifications(t.id);
    } catch (e) {
      log('error', `Directo ${t.id}: ${e.message}`);
    }
  }
}

// Torneos ya acabados: se vuelven a leer de vez en cuando por si en Melee corrigen un resultado o la clasificación
async function syncRecheck() {
  const since = new Date(Date.now() - config.syncRecheckDays * 864e5).toISOString().slice(0, 10);
  const ts = db.prepare(`SELECT id, name FROM tournaments WHERE status = ? AND hidden = 0
    AND substr(COALESCE(start_date, last_pair, first_seen), 1, 10) >= ? ORDER BY COALESCE(start_date, last_pair) DESC`).all(STATUS.ENDED, since);
  let n = 0;
  for (const t of ts) {
    try { await syncDetails(t.id); n++; } catch (e) { log('warn', `Revisión de ${t.name} (${t.id}): ${e.message}`); }
    await new Promise(r => setTimeout(r, 1500)); // sin agobiar a la API de Melee
  }
  lastRecheck = Date.now();
  if (n) log('info', `Revisados ${n} torneos acabados de los últimos ${config.syncRecheckDays} días`);
  try { require('./rivals').invalidate(); require('./badges').invalidate(); } catch (e) { /* módulos opcionales */ }
}

function publicUrl(path) {
  const base = setting('base_url').replace(/\/$/, '');
  return base ? base + path : '';
}

function fmtDate(iso) {
  if (!iso) return 'fecha por confirmar';
  return new Date(iso).toLocaleString('es-ES', { timeZone: config.tz, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

// Aviso privado por Telegram a cada jugador apuntado: su mesa y su rival
async function personalRound(tid) {
  const tg = require('./tgbot');
  if (!tg.enabled()) return;
  const t = data.tournament(tid);
  if (!t || t.hidden || t.status === STATUS.ENDED) return;
  const round = data.currentRound(tid);
  if (!round || round <= (t.tg_round || 0)) return;
  db.prepare('UPDATE tournaments SET tg_round = ? WHERE id = ?').run(round, tid);
  const link = publicUrl(`/t/${t.id}`) || melee.urls(t.id).view;
  const msgs = new Map();
  const key = u => (u ? require('./identity').resolve('u:' + u.toLowerCase()) : null);
  for (const p of data.pairings(tid, round)) {
    const head = `⚔️ ${t.name} — Ronda ${round}`;
    if (p.bye) { if (key(p.u1)) msgs.set(key(p.u1), `${head}
Tienes BYE esta ronda.
${link}`); continue; }
    if (key(p.u1)) msgs.set(key(p.u1), `${head}
Mesa ${p.table ?? '?'} contra ${p.p2}
${link}`);
    if (key(p.u2)) msgs.set(key(p.u2), `${head}
Mesa ${p.table ?? '?'} contra ${p.p1}
${link}`);
  }
  const n = await tg.notifyPeople(msgs);
  if (n) log('info', `Telegram: ${n} aviso(s) de mesa enviados (${t.name}, ronda ${round})`);
}

async function runNotifications(tid) {
  try { await personalRound(tid); } catch (e) { log('warn', 'Avisos personales: ' + e.message); }
  if (!notify.enabled()) return;
  const t = data.tournament(tid);
  if (!t || t.hidden) return;
  const g = melee.gameInfo(t.game);
  const link = publicUrl(`/t/${t.id}`) || melee.urls(t.id).view;

  if (!t.notified_new && t.status === STATUS.REGISTRATION && setting('notify_new') === '1') {
    db.prepare('UPDATE tournaments SET notified_new = 1 WHERE id = ?').run(tid);
    await notify.send(`📅 **Nuevo torneo de ${g.short}: ${t.name}**\n${fmtDate(t.start_date)}\nInscripción: ${melee.urls(t.id).view}`);
  }

  const round = data.currentRound(tid);
  if (round > (t.notified_round || 0) && setting('notify_rounds') === '1' && t.status !== STATUS.ENDED) {
    db.prepare('UPDATE tournaments SET notified_round = ? WHERE id = ?').run(round, tid);
    const pr = data.pairings(tid, round);
    const lines = pr.map(p => p.bye ? `BYE · ${p.p1}` : `Mesa ${p.table ?? '?'} · ${p.p1} vs ${p.p2}`);
    await notify.send(`⚔️ **${t.name} — Ronda ${round}**\n${lines.join('\n')}\n\nBusca tu mesa: ${link}`);
  } else if (round > (t.notified_round || 0)) {
    db.prepare('UPDATE tournaments SET notified_round = ? WHERE id = ?').run(round, tid);
  }

  if (!t.notified_final && t.status === STATUS.ENDED && setting('notify_final') === '1') {
    db.prepare('UPDATE tournaments SET notified_final = 1 WHERE id = ?').run(tid);
    const st = data.standings(tid).slice(0, 8);
    if (st.length) {
      const medals = ['🥇', '🥈', '🥉'];
      const lines = st.map((s, i) => `${medals[i] || `${s.rank}.`} ${s.name} (${s.match_record || ''})`);
      await notify.send(`🏆 **Resultados — ${t.name}**\n${lines.join('\n')}\n\n${link}`);
    }
  }
}

// Checklist inicial desde la plantilla asignada o la genérica
const DEFAULT_CHECKLIST = `antes|Publicar el torneo en Melee
antes|Compartir cartel y QR en redes
antes|Preparar premios y kits del evento
antes|Imprimir QR de mesas / encender la TV
durante|Comprobar inscritos y pagos
durante|Arrancar ronda 1 y temporizador
durante|Revisar mesas sin resultado antes de emparejar
despues|Cerrar el torneo en Melee
despues|Entregar premios y apuntarlos aquí
despues|Publicar imagen de resultados`;

function seedChecklist(tid, templateText) {
  const has = db.prepare('SELECT COUNT(*) c FROM checklist_items WHERE tournament_id = ?').get(tid).c;
  if (has) return;
  const text = templateText || DEFAULT_CHECKLIST;
  const ins = db.prepare('INSERT INTO checklist_items (tournament_id, phase, text, sort) VALUES (?, ?, ?, ?)');
  text.split('\n').map(l => l.trim()).filter(Boolean).forEach((line, i) => {
    let [phase, ...rest] = line.split('|');
    let txt = rest.join('|');
    if (!txt) { txt = phase; phase = 'antes'; }
    phase = ['antes', 'durante', 'despues'].includes(phase.trim()) ? phase.trim() : 'antes';
    ins.run(tid, phase, txt.trim(), i);
  });
}

async function tick(kind) {
  if (running || !melee.configured()) return;
  running = true;
  try {
    if (kind === 'list') await syncList(); else if (kind === 'recheck') await syncRecheck(); else await syncLive();
    lastError = null;
  } catch (e) {
    lastError = e.message;
    log('error', e.message);
  } finally {
    running = false;
  }
}

function start() {
  if (!config.syncEnabled) return;
  if (!melee.configured()) {
    log('warn', 'Faltan MELEE_CLIENT_ID / MELEE_CLIENT_SECRET: sincronización desactivada');
    return;
  }
  setTimeout(() => tick('list'), 2000);
  setInterval(() => tick('list'), config.syncListEvery * 1000);
  setInterval(() => { if (data.liveTournaments().length) tick('live'); }, config.syncLiveEvery * 1000);
  // Revisión de los acabados: si coincide con otra sincronización, se reintenta al minuto
  const recheck = () => (running ? setTimeout(recheck, 60e3) : tick('recheck'));
  setTimeout(recheck, 5 * 60e3);
  setInterval(recheck, config.syncRecheckEvery * 1000);
}

async function forceTournament(tid) {
  await refreshStartDate(tid);
  await syncDetails(tid);
  await runNotifications(tid);
}

module.exports = { start, tick, syncList, forceTournament, state, seedChecklist, DEFAULT_CHECKLIST, fmtDate, refreshStartDate };
