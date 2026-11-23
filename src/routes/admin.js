'use strict';
const express = require('express');
const { db, settings, setSetting, DEFAULT_SETTINGS, feature } = require('../db');
const auth = require('../auth');
const data = require('../data');
const stats = require('../stats');
const sync = require('../sync');
const melee = require('../melee');
const notify = require('../notify');
const {
  html, raw, json, fmtDate, fmtDay, money, toCents, gameBadge, statusBadge, absUrl, adminPage, head, cssUrl, gameArt,
} = require('../views/html');
const guide = require('../views/guide');
const C = require('../commander');
const people = require('../people');
const I = require('../identity');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config');
const backup = require('../backup');
const pricedb = require('../pricedb');
const decks = require('../decks');
const cardimg = require('../cardimg');
const GAME_SLOTS = [['StarWarsUnlimited', 'Star Wars: Unlimited'], ['CyberpunkTCG', 'Cyberpunk TCG'], ['MagicTheGathering', 'Magic'], ['Riftbound', 'Riftbound'], ['commander', 'Commander']];
const logoGlow = 'radial-gradient(120% 90% at 85% 0%, color-mix(in srgb, var(--g) 70%, transparent) 0, transparent 62%)';

const r = express.Router();
const send = (res, page) => res.send(String(page));
const back = (res, url, msg, err = false) => { const [u, h] = String(url).split('#'); res.redirect(u + (u.includes('?') ? '&' : '?') + (err ? 'err=' : 'ok=') + encodeURIComponent(msg) + (h ? '#' + h : '')); };
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

// ---------------- Login ----------------
r.get('/login', (req, res) => {
  const s = settings();
  send(res, html`${head('Entrar', s)}<body class="login"><form method="post" class="loginbox">
    <h1>${s.store_name}</h1><p class="muted">Gestión de torneos</p>
    ${req.query.err ? html`<div class="flash err">${req.query.err}</div>` : ''}
    <label>Usuario<input name="username" autocomplete="username" required autofocus></label>
    <label>Contraseña<input name="password" type="password" autocomplete="current-password" required></label>
    <input type="hidden" name="next" value="${req.query.next || '/admin'}">
    <button class="btn">Entrar</button></form></body></html>`);
});

r.post('/login', (req, res) => {
  const out = auth.login(req, res, req.body.username, req.body.password);
  if (out.error) return res.redirect('/admin/login?err=' + encodeURIComponent(out.error));
  const next = String(req.body.next || '/admin');
  res.redirect(next.startsWith('/admin') ? next : '/admin');
});

r.post('/logout', (req, res) => { auth.logout(req, res); res.redirect('/admin/login'); });

r.use(auth.requireUser);
const needs = name => (req, res, next) => (feature(name) ? next() : res.redirect('/admin?err=' + encodeURIComponent('Función desactivada. Actívala en Ajustes.')));
r.use(['/premios'], needs('prizes'));
r.use(['/caja'], needs('cash'));
r.use(/^\/torneos\/\d+\/premio/, needs('prizes'));

r.use('/commander', require('./commander-admin'));
r.use('/', require('./comunidad-admin'));

// ---------------- Inicio ----------------
r.get('/', (req, res) => {
  const live = data.liveTournaments();
  const cmdLive = db.prepare("SELECT * FROM cmd_events WHERE status = 'running'").all();
  const upcoming = data.upcomingTournaments(8);
  const drafts = db.prepare('SELECT * FROM tournaments WHERE status = 0 AND hidden = 0 ORDER BY id DESC LIMIT 5').all();
  const templates = db.prepare('SELECT * FROM templates ORDER BY sort, name').all();
  const st = sync.state();
  const lastLog = db.prepare("SELECT * FROM sync_log WHERE level = 'error' ORDER BY id DESC LIMIT 1").get();
  send(res, adminPage(req, 'Inicio', html`
    ${!st.configured ? html`<div class="flash err">Faltan las credenciales de Melee (MELEE_CLIENT_ID / MELEE_CLIENT_SECRET) en el .env.</div>` : ''}
    ${st.lastError ? html`<div class="flash err">Último error de sincronización: ${st.lastError}</div>` : ''}
    ${cmdLive.length ? html`<section class="panel live"><h2>Commander en juego</h2>${cmdLive.map(e => {
      const cur = C.currentRound(e.id);
      const pend = cur ? C.podsOfRound(cur.id).filter(p => !p.reported).length : 0;
      return html`<div class="liverow"><a href="/admin/commander/${e.id}"><strong>${e.name}</strong></a>
        <span>${cur ? (cur.kind === 'final' ? 'Mesa final' : `Ronda ${cur.number}/${C.roundLimit(e.id)}`) : ''}</span>
        <span class="${pend ? 'warn' : 'ok'}">${pend === 1 ? '1 mesa sin resultado' : `${pend} mesas sin resultado`}</span><a class="btn small" href="/tv/c${e.id}" target="_blank">TV</a></div>`;
    })}</section>` : ''}
    ${live.length ? html`<section class="panel live"><h2>En juego ahora</h2>${live.map(t => {
      const snap = data.liveSnapshot(t.id, true);
      return html`<div class="liverow"><a href="/admin/torneos/${t.id}"><strong>${t.name}</strong></a>
        <span>Ronda ${snap.round}/${snap.roundsTotal || '?'}</span>
        <span class="${snap.pending ? 'warn' : 'ok'}">${snap.pending === 1 ? '1 mesa sin resultado' : `${snap.pending} mesas sin resultado`}</span>
        <a class="btn small" href="/tv/${t.id}" target="_blank">TV</a></div>`;
    })}</section>` : ''}
    <section class="panel"><h2>Crear torneo desde plantilla</h2>
      ${templates.length ? html`<div class="tplgrid">${templates.map(t => html`
        <a class="tplbtn" style="--g:${melee.gameInfo(t.game).color}" href="${t.melee_template_id ? melee.urls(t.melee_template_id).edit : '/admin/plantillas'}" target="_blank" rel="noopener">
          <span>${gameBadge(t.game)}</span><strong>${t.name}</strong>
          <small>${t.melee_template_id ? 'Abrir plantilla en Melee → Duplicate' : 'Falta enlazar el torneo plantilla'}</small></a>`)}</div>
        <p class="small muted">Se abre la plantilla en Melee: pulsa <b>Duplicate</b>, ajusta fecha y nombre, y publica. Aquí aparecerá solo en unos minutos con su QR y cartel.</p>`
      : html`<p class="muted">Aún no hay plantillas. <a href="/admin/plantillas">Crea la primera</a>.</p>`}
    </section>
    <div class="cols">
      <section class="panel"><h2>Próximos</h2>${upcoming.length ? html`<ul class="list">${upcoming.map(t => html`
        <li><a href="/admin/torneos/${t.id}">${t.name}</a> ${gameBadge(t.game)}<br><small class="muted">${fmtDate(t.start_date)} · ${data.counts(t.id).total || 0} inscritos</small></li>`)}</ul>`
        : html`<p class="muted">Sin torneos con inscripción abierta.</p>`}</section>
      <section class="panel"><h2>Sin publicar en Melee</h2>${drafts.length ? html`<ul class="list">${drafts.map(t => html`
        <li><a href="/admin/torneos/${t.id}">${t.name}</a> ${gameBadge(t.game)}<br><small class="muted">Publícalo desde el controlador de Melee</small></li>`)}</ul>`
        : html`<p class="muted">Nada pendiente.</p>`}</section>
    </div>
    <p class="small muted">Última sincronización: ${st.lastListSync ? new Date(st.lastListSync).toLocaleTimeString('es-ES') : 'pendiente'}
      ${lastLog ? html` · Último error ${lastLog.at}: ${lastLog.msg}` : ''} · <a href="/admin/log">Ver registro</a></p>
    <form method="post" action="/admin/sync"><button class="btn ghost small">Sincronizar ahora</button></form>
  `));
});

r.post('/sync', async (req, res) => {
  try { await sync.syncList(); back(res, '/admin', 'Sincronizado'); } catch (e) { back(res, '/admin', e.message, true); }
});

r.get('/log', (req, res) => {
  const rows = db.prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 200').all();
  send(res, adminPage(req, 'Registro de sincronización', html`<div class="tablewrap"><table class="tbl"><tbody>${rows.map(l => html`
    <tr class="${l.level}"><td class="nowrap">${l.at}</td><td>${l.level}</td><td>${l.msg}</td></tr>`)}</tbody></table></div>`));
});

// ---------------- Torneos ----------------
r.get('/torneos', (req, res) => {
  const game = req.query.juego || '';
  const status = req.query.estado || '';
  let sql = 'SELECT * FROM tournaments WHERE 1=1';
  const args = [];
  if (game) { sql += ' AND game = ?'; args.push(game); }
  if (status !== '') { sql += ' AND status = ?'; args.push(Number(status)); }
  sql += ' ORDER BY COALESCE(start_date, last_pair, first_seen) DESC LIMIT 300';
  const ts = db.prepare(sql).all(...args);
  const games = db.prepare('SELECT game, COUNT(*) n FROM tournaments GROUP BY game ORDER BY n DESC').all();
  const total = games.reduce((a, g) => a + g.n, 0);
  const qs = (k, v) => { const p = new URLSearchParams({ juego: game, estado: status, [k]: v }); for (const [a, b] of [...p]) if (b === '') p.delete(a); const q = p.toString(); return q ? '?' + q : '/admin/torneos'; };
  const STATES = [[0, 'No publicado'], [1, 'Inscripción'], [2, 'En curso'], [4, 'Finalizado'], [3, 'Cancelado']];
  send(res, adminPage(req, 'Torneos', html`
    <nav class="chips gchips" aria-label="Filtrar por juego"><a href="${qs('juego', '')}" class="${!game ? 'on' : ''}">Todos <small>${total}</small></a>
      ${games.map(g => html`<a href="${qs('juego', g.game)}" class="${g.game === game ? 'on' : ''}" style="--g:${melee.gameInfo(g.game).color}"><i></i>${melee.gameInfo(g.game).short} <small>${g.n}</small></a>`)}</nav>
    <nav class="chips" aria-label="Filtrar por estado"><a href="${qs('estado', '')}" class="${status === '' ? 'on' : ''}">Todos los estados</a>
      ${STATES.map(([v, l]) => html`<a href="${qs('estado', String(v))}" class="${String(v) === status ? 'on' : ''}">${l}</a>`)}</nav>
    <div class="tablewrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Torneo</th><th>Juego</th><th>Estado</th><th class="num">Jugadores</th></tr></thead>
    <tbody>${ts.map(t => html`<tr class="${t.hidden ? 'dim' : ''}"><td class="nowrap">${fmtDay(t.start_date || t.last_pair)}</td>
      <td><a href="/admin/torneos/${t.id}">${t.name}</a>${t.hidden ? html` <small class="muted">(oculto)</small>` : ''}</td>
      <td>${gameBadge(t.game)}</td><td>${statusBadge(t, data.isLive(t))}</td><td class="num">${data.counts(t.id).total || 0}</td></tr>`)}</tbody></table></div>
    ${!ts.length ? html`<p class="muted">Aún no hay torneos sincronizados.</p>` : ''}`));
});

function loadT(req, res) {
  const t = data.tournament(Number(req.params.id));
  if (!t) { res.status(404).send('Torneo no encontrado'); return null; }
  return t;
}

r.get('/torneos/:id', (req, res) => {
  const t = loadT(req, res); if (!t) return;
  const snap = data.liveSnapshot(t.id, true);
  const u = melee.urls(t.id);
  const pub = absUrl(req, '/t/' + t.id);
  const templates = db.prepare('SELECT * FROM templates ORDER BY name').all();
  const checklist = db.prepare('SELECT * FROM checklist_items WHERE tournament_id = ? ORDER BY sort, id').all(t.id);
  const prizes = db.prepare('SELECT * FROM prizes WHERE tournament_id = ? ORDER BY id').all(t.id);
  const pm = data.playersMap(t.id);
  const players = [...pm.values()].sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
  const price = t.price_cents ?? toCents(settings().default_price);
  const prizeTotal = prizes.reduce((s, p) => s + (p.amount_cents || 0), 0);
  const pending = snap.pairings.filter(p => !p.bye && !p.hasResult);
  const phases = { antes: 'Antes', durante: 'Durante', despues: 'Después' };

  send(res, adminPage(req, t.name, html`
    <p>${gameBadge(t.game)} ${statusBadge(t, snap.live)} · ${fmtDate(t.start_date)} · ${t.type_desc || ''}
      ${t.formats ? html` · ${JSON.parse(t.formats).join(', ')}` : ''}</p>
    <div class="actions">
      <a class="btn" href="${u.control}" target="_blank" rel="noopener">Controlador Melee ↗</a>
      <a class="btn ghost" href="${u.edit}" target="_blank" rel="noopener">Editar en Melee ↗</a>
      <a class="btn ghost" href="${u.view}" target="_blank" rel="noopener">Página Melee ↗</a>
      <a class="btn ghost" href="/t/${t.id}" target="_blank">Página pública</a>
      <a class="btn ghost" href="/tv/${t.id}" target="_blank">TV</a>
      <a class="btn ghost" href="/admin/torneos/${t.id}/cartel" target="_blank">Cartel + QR</a>
      <a class="btn ghost" href="/admin/torneos/${t.id}/imagen">Imagen resultados</a>
      ${feature('prizes') ? html`<a class="btn ghost" href="/admin/premios?players=${snap.players.total || ''}&price=${price != null ? price / 100 : ''}">Calcular premios</a>` : ''}
      <form method="post" action="/admin/torneos/${t.id}/sync"><button class="btn ghost">Sincronizar</button></form>
    </div>

    <div class="stats">
      <div><b>${snap.players.total || 0}</b><span>inscritos</span></div>
      <div><b>${snap.players.active || 0}</b><span>activos</span></div>
      <div><b>${snap.players.paid || 0}</b><span>pagados en Melee</span></div>
      <div><b>${snap.round || 0}/${t.rounds_total || '?'}</b><span>ronda</span></div>
      ${feature('cash') ? html`<div><b>${money((snap.players.total || 0) * (price || 0) - prizeTotal)}</b><span>caja neta</span></div>` : ''}
    </div>

    ${snap.live ? html`<section class="panel live"><h2>Ronda ${snap.round}: ${pending.length ? `${pending.length} mesas sin resultado` : 'todas con resultado ✔'}</h2>
      ${pending.length ? html`<div class="pending">${pending.map(p => html`<div class="pend"><b>Mesa ${p.table ?? '?'}</b> ${p.p1} <em>vs</em> ${p.p2}</div>`)}</div>` : ''}
      <p class="small muted">Se actualiza cada pocos segundos. <a href="">Recargar</a></p>
      <form method="post" action="/admin/torneos/${t.id}/notificar"><input type="hidden" name="que" value="ronda">
        <button class="btn small ghost" ${notify.enabled() ? '' : 'disabled'}>Enviar emparejamientos a Discord/Telegram</button></form>
    </section>` : ''}

    <div class="${feature('prizes') ? 'cols' : ''}">
      <section class="panel"><h2>Checklist</h2>
        ${Object.entries(phases).map(([k, label]) => html`<h3>${label}</h3><ul class="check">
          ${checklist.filter(c => c.phase === k).map(c => html`<li class="${c.done ? 'done' : ''}">
            <form method="post" action="/admin/torneos/${t.id}/check/${c.id}"><button class="tick" title="Marcar">${c.done ? '✔' : ''}</button></form>
            <span>${c.text}${c.done ? html` <small class="muted">${c.done_by}</small>` : ''}</span>
            <form method="post" action="/admin/torneos/${t.id}/check/${c.id}/borrar"><button class="x" title="Quitar">×</button></form></li>`)}</ul>`)}
        <form method="post" action="/admin/torneos/${t.id}/check" class="inline">
          <select name="phase">${Object.entries(phases).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select>
          <input name="text" placeholder="Añadir tarea" required><button class="btn small">Añadir</button></form>
      </section>

      ${feature('prizes') ? html`<section class="panel"><h2>Premios entregados</h2>
        ${prizes.length ? html`<table class="tbl"><tbody>${prizes.map(p => html`<tr><td>${p.team_id ? data.playerName(pm.get(p.team_id), true) : '—'}</td>
          <td>${p.label}</td><td>${p.kind}</td><td class="num">${money(p.amount_cents)}</td>
          <td><form method="post" action="/admin/torneos/${t.id}/premio/${p.id}/borrar"><button class="x">×</button></form></td></tr>`)}
          <tr><td colspan="3"><b>Total</b></td><td class="num"><b>${money(prizeTotal)}</b></td><td></td></tr></tbody></table>` : html`<p class="muted">Sin premios apuntados.</p>`}
        <form method="post" action="/admin/torneos/${t.id}/premio" class="stack">
          <select name="team_id"><option value="">Jugador (opcional)</option>${snap.standings.length
    ? snap.standings.map(s => html`<option value="${s.team_id}">${s.rank}. ${s.name}</option>`)
    : players.map(p => html`<option value="${p.team_id}">${data.playerName(p, true)}</option>`)}</select>
          <input name="label" placeholder="Concepto (p. ej. 6 sobres, crédito tienda)" required>
          <div class="inline"><select name="kind"><option>crédito</option><option>producto</option><option>efectivo</option><option>otro</option></select>
          <input name="amount" placeholder="Valor €" inputmode="decimal"><button class="btn small">Apuntar</button></div>
        </form>
      </section>` : ''}
    </div>

    <div class="cols">
      <section class="panel"><h2>Clasificación</h2>${snap.standings.length ? html`<table class="tbl"><thead><tr><th>#</th><th>Jugador</th><th class="num">Pts</th><th class="num">Récord</th><th class="num">PGO%</th><th class="num">JGE%</th><th class="num">JGO%</th></tr></thead>
        <tbody>${snap.standings.map(s => html`<tr><td>${s.rank}</td><td>${s.name}${s.dropped ? html` <small class="muted">(drop R${s.dropped})</small>` : ''}</td>
        <td class="num">${s.points}</td><td class="num">${s.match_record}</td><td class="num">${s.omw != null ? (s.omw * 100).toFixed(1) + '%' : ''}</td>
        <td class="num">${s.gw != null ? (s.gw * 100).toFixed(1) + '%' : ''}</td><td class="num">${s.ogw != null ? (s.ogw * 100).toFixed(1) + '%' : ''}</td></tr>`)}</tbody></table>`
    : html`<p class="muted">Sin clasificación todavía.</p>`}</section>

      <section class="panel"><h2>Inscritos (${players.length})</h2>${players.length ? html`<table class="tbl"><tbody>${players.map(p => html`<tr>
        <td><a href="/admin/jugadores/${encodeURIComponent(p.username ? 'u:' + p.username.toLowerCase() : p.user_key)}">${p.full_name || p.username}</a> <small class="muted">${p.username}</small></td>
        <td>${p.paid ? html`<span class="ok">pagado</span>` : ''}</td><td>${p.dropped_round ? `drop R${p.dropped_round}` : ''}</td></tr>`)}</tbody></table>`
    : html`<p class="muted">Nadie inscrito aún.</p>`}</section>
    </div>

    <section class="panel"><h2>Ajustes locales</h2>
      <form method="post" action="/admin/torneos/${t.id}" class="grid2">
        <label>Precio de inscripción (€)<input name="price" value="${t.price_cents != null ? (t.price_cents / 100).toFixed(2) : ''}" placeholder="${settings().default_price || 'p. ej. 5'}" inputmode="decimal"></label>
        <label>Plantilla<select name="template_id"><option value="">—</option>${templates.map(tp => html`<option value="${tp.id}" ${tp.id === t.template_id ? 'selected' : ''}>${tp.name}</option>`)}</select></label>
        <label>Fecha y hora${t.start_date_manual ? ' (puesta a mano)' : ' (de Melee)'}<input type="datetime-local" name="start_date" value="${isoToLocal(t.start_date)}">
          <small class="muted">${t.start_date ? 'Si la cambias, se queda la tuya y Melee ya no la sobrescribe.' : 'No se ha podido leer de Melee: ponla tú. '}${t.start_date_manual ? html` <button class="link" name="fecha_melee" value="1">Volver a la de Melee</button>` : ''} <a href="/admin/torneos/${t.id}/fecha">Diagnóstico</a></small></label>
        <label class="full">Información para la página pública (premios, reglas, formato, horario…)<textarea name="info" rows="4" placeholder="Premios: 1 sobre por victoria&#10;Formato Premier, 4 rondas de 50 min">${t.info || ''}</textarea></label>
        <label class="full">Notas internas<textarea name="notes" rows="2">${t.notes || ''}</textarea></label>
        <label class="check-inline"><input type="checkbox" name="hidden" value="1" ${t.hidden ? 'checked' : ''}> Ocultar en la web pública, TV y estadísticas</label>
        <div class="full"><button class="btn">Guardar</button></div>
      </form>
      <p class="small muted">Enlace público: <a href="${pub}" target="_blank">${pub}</a></p>
      ${t.status === 4 ? html`<form method="post" action="/admin/torneos/${t.id}/notificar"><input type="hidden" name="que" value="final">
        <button class="btn small ghost" ${notify.enabled() ? '' : 'disabled'}>Enviar resultados a Discord/Telegram</button></form>` : ''}
    </section>
    ${snap.live ? raw('<script>setTimeout(()=>{if(!document.activeElement||document.activeElement===document.body)location.reload()},30000)</script>') : ''}
  `));
});

// ISO en UTC → «2026-11-28T14:30» en hora de la tienda (para el campo de fecha)
function isoToLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: config.tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = k => p.find(x => x.type === k).value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}
// «2026-11-28T14:30» en hora de la tienda → ISO en UTC
function localToIso(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  // desfase de la zona de la tienda en ese momento
  const part = new Intl.DateTimeFormat('en-US', { timeZone: config.tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const g = k => Number(part.find(p => p.type === k).value);
  const asLocal = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
  return new Date(guess - (asLocal - guess)).toISOString();
}
r.get('/torneos/:id/fecha', async (req, res) => {
  const t = loadT(req, res); if (!t) return;
  const d = await melee.debugStartDate(t.id).catch(e => ({ error: e.message }));
  send(res, adminPage(req, `Fecha · ${t.name}`, html`<p><a href="/admin/torneos/${t.id}">← Volver al torneo</a></p>
    <section class="panel"><h2>De dónde sale la fecha</h2>
      <p>Guardada ahora: <b>${t.start_date ? fmtDate(t.start_date) : 'ninguna'}</b>${t.start_date_manual ? ' (puesta a mano)' : ''}</p>
      <h3>API de Melee</h3><p>${d.apiError ? html`<span class="warn">${d.apiError}</span>` : d.api ? html`Fecha encontrada: <b>${fmtDate(d.api)}</b>` : 'La API no trae la fecha.'}</p>
      ${d.apiKeys && d.apiKeys.length ? html`<pre class="small">${d.apiKeys.join('\n')}</pre>` : ''}
      <h3>Página pública de Melee</h3><p>${d.pageError ? html`<span class="warn">${d.pageError}</span>` : d.page ? html`Fecha encontrada: <b>${fmtDate(d.page)}</b>` : html`Se descargó la página (${d.pageLength} caracteres, título «${d.pageTitle || '—'}») pero no aparece la fecha.`}</p>
      ${d.pageSnippet ? html`<pre class="small">${d.pageSnippet}</pre>` : ''}
      <p class="small muted">Si la página da 403, Cloudflare de Melee está bloqueando al servidor: pon la fecha a mano en el torneo.</p>
      <form method="post" action="/admin/torneos/${t.id}/fecha"><button class="btn small">Volver a leerla ahora</button></form></section>`));
});
r.post('/torneos/:id/fecha', async (req, res) => {
  const t = loadT(req, res); if (!t) return;
  db.prepare('UPDATE tournaments SET start_date_manual = 0 WHERE id = ?').run(t.id);
  try { const d = await melee.scrapeStartDate(t.id); if (d) db.prepare('UPDATE tournaments SET start_date = ? WHERE id = ?').run(d, t.id); back(res, `/admin/torneos/${t.id}/fecha`, d ? 'Fecha leída de Melee' : 'Melee no devolvió la fecha', !d); }
  catch (e) { back(res, `/admin/torneos/${t.id}/fecha`, e.message, true); }
});

r.post('/torneos/:id', (req, res) => {
  const t = loadT(req, res); if (!t) return;
  const tplId = req.body.template_id ? Number(req.body.template_id) : null;
  db.prepare('UPDATE tournaments SET price_cents = ?, template_id = ?, notes = ?, info = ?, hidden = ? WHERE id = ?')
    .run(toCents(req.body.price), tplId, req.body.notes || null, String(req.body.info || '').slice(0, 4000) || null, req.body.hidden ? 1 : 0, t.id);
  // Fecha: a mano si la cambian (el navegador manda la hora local de la tienda)
  if (req.body.fecha_melee) {
    db.prepare('UPDATE tournaments SET start_date_manual = 0 WHERE id = ?').run(t.id);
    sync.refreshStartDate && sync.refreshStartDate(t.id).catch(() => {});
  } else if (req.body.start_date && req.body.start_date !== isoToLocal(t.start_date)) {
    const d = localToIso(req.body.start_date);
    if (d) db.prepare('UPDATE tournaments SET start_date = ?, start_date_manual = 1 WHERE id = ?').run(d, t.id);
  }
  if (tplId && tplId !== t.template_id) {
    const tpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(tplId);
    if (tpl && tpl.price_cents != null && req.body.price === '') db.prepare('UPDATE tournaments SET price_cents = ? WHERE id = ?').run(tpl.price_cents, t.id);
    const doneCount = db.prepare('SELECT COUNT(*) c FROM checklist_items WHERE tournament_id = ? AND done = 1').get(t.id).c;
    if (tpl && tpl.checklist && !doneCount) {
      db.prepare('DELETE FROM checklist_items WHERE tournament_id = ?').run(t.id);
      sync.seedChecklist(t.id, tpl.checklist);
    }
  }
  back(res, `/admin/torneos/${t.id}`, 'Guardado');
});

r.post('/torneos/:id/sync', async (req, res) => {
  const t = loadT(req, res); if (!t) return;
  try { await sync.forceTournament(t.id); back(res, `/admin/torneos/${t.id}`, 'Sincronizado'); }
  catch (e) { back(res, `/admin/torneos/${t.id}`, e.message, true); }
});

r.post('/torneos/:id/notificar', async (req, res) => {
  const t = loadT(req, res); if (!t) return;
  const link = absUrl(req, '/t/' + t.id);
  let text;
  if (req.body.que === 'final') {
    const st = data.standings(t.id).slice(0, 8);
    text = `🏆 **Resultados — ${t.name}**\n${st.map(s => `${s.rank}. ${s.name} (${s.match_record || ''})`).join('\n')}\n\n${link}`;
  } else {
    const round = data.currentRound(t.id);
    const pr = data.pairings(t.id, round);
    text = `⚔️ **${t.name} — Ronda ${round}**\n${pr.map(p => p.bye ? `BYE · ${p.p1}` : `Mesa ${p.table ?? '?'} · ${p.p1} vs ${p.p2}`).join('\n')}\n\nBusca tu mesa: ${link}`;
  }
  const errors = await notify.send(text);
  errors.length ? back(res, `/admin/torneos/${t.id}`, errors.join(' | '), true) : back(res, `/admin/torneos/${t.id}`, 'Enviado');
});

r.post('/torneos/:id/check', (req, res) => {
  const t = loadT(req, res); if (!t) return;
  const max = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM checklist_items WHERE tournament_id = ?').get(t.id).m;
  db.prepare('INSERT INTO checklist_items (tournament_id, phase, text, sort) VALUES (?, ?, ?, ?)')
    .run(t.id, ['antes', 'durante', 'despues'].includes(req.body.phase) ? req.body.phase : 'antes', String(req.body.text || '').slice(0, 300), max + 1);
  res.redirect(`/admin/torneos/${t.id}`);
});
r.post('/torneos/:id/check/:cid', (req, res) => {
  db.prepare(`UPDATE checklist_items SET done = 1 - done, done_by = CASE WHEN done = 0 THEN ? ELSE NULL END,
    done_at = datetime('now') WHERE id = ? AND tournament_id = ?`).run(req.user.username, Number(req.params.cid), Number(req.params.id));
  res.redirect(`/admin/torneos/${req.params.id}`);
});
r.post('/torneos/:id/check/:cid/borrar', (req, res) => {
  db.prepare('DELETE FROM checklist_items WHERE id = ? AND tournament_id = ?').run(Number(req.params.cid), Number(req.params.id));
  res.redirect(`/admin/torneos/${req.params.id}`);
});
r.post('/torneos/:id/premio', (req, res) => {
  const t = loadT(req, res); if (!t) return;
  db.prepare('INSERT INTO prizes (tournament_id, team_id, label, kind, amount_cents) VALUES (?, ?, ?, ?, ?)')
    .run(t.id, req.body.team_id ? Number(req.body.team_id) : null, String(req.body.label || '').slice(0, 200), req.body.kind || 'otro', toCents(req.body.amount) || 0);
  res.redirect(`/admin/torneos/${t.id}`);
});
r.post('/torneos/:id/premio/:pid/borrar', (req, res) => {
  db.prepare('DELETE FROM prizes WHERE id = ? AND tournament_id = ?').run(Number(req.params.pid), Number(req.params.id));
  res.redirect(`/admin/torneos/${req.params.id}`);
});

// Cartel imprimible
r.get('/torneos/:id/cartel', (req, res) => {
  const t = loadT(req, res); if (!t) return;
  const s = settings();
  const g = melee.gameInfo(t.game);
  const target = req.query.directo ? melee.urls(t.id).view : absUrl(req, '/t/' + t.id);
  const price = t.price_cents ?? toCents(s.default_price);
  send(res, html`${head('Cartel ' + t.name, s)}<body class="poster" style="--g:${g.color}">
    <div class="noprint bar"><button onclick="print()" class="btn">Imprimir / PDF</button>
      <a class="btn ghost" href="?${req.query.directo ? '' : 'directo=1'}">${req.query.directo ? 'QR a la web de la tienda' : 'QR directo a Melee'}</a>
      <a class="btn ghost" href="/qr.svg?d=${encodeURIComponent(target)}" download="qr-${t.id}.svg">Descargar QR</a></div>
    <div class="sheet">
      <div class="p-store">${s.logo_url ? html`<img src="${s.logo_url}" alt="">` : ''}${s.store_name}</div>
      <div class="p-game">${g.label}</div>
      <h1 class="p-name">${t.name}</h1>
      <div class="p-date">${fmtDate(t.start_date, { weekday: 'long', month: 'long' })}</div>
      ${price ? html`<div class="p-price">Inscripción ${money(price)}</div>` : ''}
      <img class="p-qr" src="/qr.svg?d=${encodeURIComponent(target)}" alt="QR">
      <div class="p-cta">Escanea para inscribirte${req.query.directo ? '' : ' y seguir el torneo en directo'}</div>
      ${s.address ? html`<div class="p-addr">${s.address}</div>` : ''}
    </div></body></html>`);
});

// Imagen de resultados para redes
r.get('/torneos/:id/imagen', (req, res) => {
  const t = loadT(req, res); if (!t) return;
  const s = settings();
  const st = data.standings(t.id).slice(0, 8).map(x => ({ rank: x.rank, name: x.name, record: x.match_record }));
  const g = melee.gameInfo(t.game);
  send(res, adminPage(req, 'Imagen de resultados', html`
    <p class="muted">Imagen 1080×1350 lista para Instagram. Elige cuántos puestos mostrar y descárgala.</p>
    <div class="inline"><label>Puestos <select id="topn"><option>4</option><option selected>8</option><option>3</option><option>1</option></select></label>
      <label>Nombres <select id="names"><option value="user">Usuario Melee</option><option value="real">Nombre real</option></select></label>
      <button class="btn" id="dl">Descargar PNG</button></div>
    <canvas id="cv" width="1080" height="1350" class="preview"></canvas>
    <script>window.__IMG = ${json({
    store: s.store_name, accent: s.accent, name: t.name, game: g.label, color: g.color,
    date: fmtDate(t.start_date, { weekday: 'long', month: 'long', hour: undefined, minute: undefined }),
    players: data.counts(t.id).total || 0, standings: st,
    real: data.standings(t.id, true).slice(0, 8).map(x => x.name),
  })};</script>
    <script src="/static/results-image.js"></script>`));
});

// ---------------- Plantillas ----------------
r.get('/plantillas', (req, res) => {
  const list = db.prepare('SELECT * FROM templates ORDER BY sort, name').all();
  const edit = req.query.editar ? db.prepare('SELECT * FROM templates WHERE id = ?').get(Number(req.query.editar)) : null;
  const tp = edit || { game: 'StarWarsUnlimited', checklist: sync.DEFAULT_CHECKLIST, prize_pct: settings().default_prize_pct };
  const candidates = db.prepare('SELECT id, name, game, status_desc FROM tournaments ORDER BY id DESC LIMIT 100').all();
  send(res, adminPage(req, 'Plantillas', html`
    <section class="panel"><h2>Cómo funciona</h2>
      <ol class="small"><li>En Melee crea un torneo por cada tipo de evento con todo configurado (formato, rondas, precio, descripción, imagen) y <b>no lo publiques</b>. Llámalo p. ej. «PLANTILLA SWU semanal».</li>
      <li>Aquí crea la plantilla y elige ese torneo. Quedará oculto de la web.</li>
      <li>Desde Inicio, un clic abre la plantilla en Melee: <b>Duplicate</b>, cambia fecha/nombre y publica.</li>
      <li>Para eventos semanales, en Melee usa además «Set as Recurring» desde el Organization Dashboard.</li></ol></section>
    ${list.length ? html`<div class="tablewrap"><table class="tbl"><thead><tr><th>Plantilla</th><th>Juego</th><th>Torneo Melee</th><th class="num">Precio</th><th></th></tr></thead><tbody>
      ${list.map(x => html`<tr><td><b>${x.name}</b></td><td>${gameBadge(x.game)}</td>
        <td>${x.melee_template_id ? html`<a href="${melee.urls(x.melee_template_id).edit}" target="_blank">#${x.melee_template_id} ↗</a>` : html`<span class="warn">sin enlazar</span>`}</td>
        <td class="num">${money(x.price_cents)}</td>
        <td class="nowrap"><a href="?editar=${x.id}">Editar</a>
          <form method="post" action="/admin/plantillas/${x.id}/borrar" class="inline" onsubmit="return confirm('¿Borrar plantilla?')"><button class="link">Borrar</button></form></td></tr>`)}
    </tbody></table></div>` : ''}
    <section class="panel"><h2>${edit ? 'Editar plantilla' : 'Nueva plantilla'}</h2>
      <form method="post" action="/admin/plantillas${edit ? '/' + edit.id : ''}" class="grid2">
        <label>Nombre<input name="name" value="${tp.name || ''}" required placeholder="SWU semanal"></label>
        <label>Juego<select name="game">${Object.entries(melee.GAMES).map(([k, g]) => html`<option value="${k}" ${k === tp.game ? 'selected' : ''}>${g.label}</option>`)}</select></label>
        <label>Torneo plantilla en Melee<select name="melee_template_id"><option value="">— elegir —</option>
          ${candidates.map(c => html`<option value="${c.id}" ${c.id === tp.melee_template_id ? 'selected' : ''}>#${c.id} · ${c.name} (${c.status_desc})</option>`)}</select>
          <small class="muted">O escribe el ID: <input name="melee_template_id_manual" placeholder="ID" style="width:8em" inputmode="numeric"></small></label>
        <label>Precio (€)<input name="price" value="${tp.price_cents != null ? (tp.price_cents / 100).toFixed(2) : ''}" inputmode="decimal"></label>
        <label>Máx. jugadores<input name="player_cap" value="${tp.player_cap || ''}" inputmode="numeric"></label>
        <label>% a premios<input name="prize_pct" value="${tp.prize_pct || ''}" inputmode="numeric"></label>
        <label class="full">Descripción / recordatorio (texto para redes)<textarea name="description" rows="3">${tp.description || ''}</textarea></label>
        <label class="full">Checklist (una tarea por línea, formato <code>antes|texto</code>, <code>durante|texto</code> o <code>despues|texto</code>)
          <textarea name="checklist" rows="8">${tp.checklist || ''}</textarea></label>
        <div class="full"><button class="btn">${edit ? 'Guardar' : 'Crear plantilla'}</button> ${edit ? html`<a href="/admin/plantillas">Cancelar</a>` : ''}</div>
      </form></section>`));
});

function tplParams(b) {
  return [
    String(b.name || '').slice(0, 120), b.game, Number(b.melee_template_id_manual) || Number(b.melee_template_id) || null,
    toCents(b.price), Number(b.player_cap) || null, Number(b.prize_pct) || null, b.description || null, b.checklist || null,
  ];
}
function hideTemplates() {
  db.prepare('UPDATE tournaments SET hidden = 1 WHERE id IN (SELECT melee_template_id FROM templates WHERE melee_template_id IS NOT NULL)').run();
}
r.post('/plantillas', (req, res) => {
  db.prepare('INSERT INTO templates (name, game, melee_template_id, price_cents, player_cap, prize_pct, description, checklist) VALUES (?,?,?,?,?,?,?,?)').run(...tplParams(req.body));
  hideTemplates();
  back(res, '/admin/plantillas', 'Plantilla creada');
});
r.post('/plantillas/:id', (req, res) => {
  db.prepare('UPDATE templates SET name=?, game=?, melee_template_id=?, price_cents=?, player_cap=?, prize_pct=?, description=?, checklist=? WHERE id = ?')
    .run(...tplParams(req.body), Number(req.params.id));
  hideTemplates();
  back(res, '/admin/plantillas', 'Plantilla guardada');
});
r.post('/plantillas/:id/borrar', (req, res) => {
  db.prepare('DELETE FROM templates WHERE id = ?').run(Number(req.params.id));
  back(res, '/admin/plantillas', 'Plantilla borrada');
});

// ---------------- QR y mesas ----------------
r.get('/qr', (req, res) => {
  const url = String(req.query.url || '');
  const tables = Math.min(Math.max(parseInt(req.query.mesas, 10) || 0, 0), 100);
  const upcoming = data.upcomingTournaments(20);
  send(res, adminPage(req, 'QR y mesas', html`
    <section class="panel"><h2>QR de cualquier enlace</h2>
      <form method="get" class="inline"><input name="url" value="${url}" placeholder="Pega la URL (p. ej. del torneo en Melee)" class="grow" required><button class="btn">Generar</button></form>
      ${url ? html`<div class="qrout"><img src="/qr.svg?d=${encodeURIComponent(url)}" alt="QR"><div><p class="small">${url}</p>
        <a class="btn ghost small" href="/qr.svg?d=${encodeURIComponent(url)}" download="qr.svg">Descargar SVG</a></div></div>` : ''}
    </section>
    <section class="panel"><h2>QR de próximos torneos</h2>${upcoming.length ? html`<div class="qrgrid">${upcoming.map(t => html`
      <div class="qritem"><img src="/qr.svg?d=${encodeURIComponent(absUrl(req, '/t/' + t.id))}" alt=""><b>${t.name}</b><small>${fmtDate(t.start_date)}</small>
      <a href="/admin/torneos/${t.id}/cartel" target="_blank">Cartel</a></div>`)}</div>` : html`<p class="muted">No hay torneos próximos.</p>`}</section>
    <section class="panel"><h2>QR para las mesas</h2>
      <p class="small muted">Imprímelos una vez y déjalos pegados: cada QR muestra la partida que se juega en esa mesa en el torneo que esté en curso.</p>
      <form method="get" class="inline"><label>Nº de mesas <input name="mesas" value="${tables || 12}" inputmode="numeric" style="width:6em"></label><button class="btn">Ver hoja</button></form>
      ${tables ? html`<p><a class="btn ghost" href="/admin/qr/mesas?n=${tables}" target="_blank">Abrir hoja imprimible (${tables} mesas)</a></p>` : ''}
    </section>`));
});

r.get('/qr/mesas', (req, res) => {
  const s = settings();
  const n = Math.min(Math.max(parseInt(req.query.n, 10) || 12, 1), 100);
  send(res, html`${head('QR mesas', s)}<body class="tableqr">
    <div class="noprint bar"><button class="btn" onclick="print()">Imprimir</button></div>
    <div class="tqgrid">${Array.from({ length: n }, (_, i) => i + 1).map(i => html`<div class="tq">
      <div class="tq-n">Mesa ${i}</div><img src="/qr.svg?d=${encodeURIComponent(absUrl(req, '/mesa/' + i))}" alt="">
      <div class="tq-s">${s.store_name} · Escanea para ver tu partida</div></div>`)}</div></body></html>`);
});

// ---------------- Premios y rondas ----------------
r.get('/premios', (req, res) => {
  send(res, adminPage(req, 'Calculadora de premios y rondas', html`
    <section class="panel"><form id="calc" class="grid2">
      <label>Jugadores<input name="players" type="number" min="2" value="${req.query.players || 8}"></label>
      <label>Inscripción (€)<input name="price" type="number" step="0.5" min="0" value="${req.query.price || settings().default_price || 5}"></label>
      <label>% de la recaudación a premios<input name="pct" type="number" min="0" max="200" value="${settings().default_prize_pct || 50}"></label>
      <label>Valor de un sobre / unidad de premio (€, opcional)<input name="unit" type="number" step="0.5" min="0" value=""></label>
      <label>Reparto<select name="mode"><option value="auto">Automático según jugadores</option><option value="1">Solo ganador</option>
        <option value="4">Top 4</option><option value="8">Top 8</option><option value="flat">Igual para todos (participación)</option></select></label>
      <label>Bote extra de la tienda (€)<input name="extra" type="number" step="1" min="0" value="0"></label>
    </form></section>
    <div class="cols"><section class="panel"><h2>Estructura recomendada</h2><div id="structure"></div></section>
    <section class="panel"><h2>Reparto</h2><div id="split"></div></section></div>
    <p class="small muted">Orientativo (suizo estándar: rondas ≈ log₂ jugadores). Revisa siempre las reglas del programa oficial del evento (Store Showdown, etc.).</p>
    <script src="/static/prizes.js"></script>`));
});

// ---------------- Guía ----------------
r.get('/guia', (req, res) => send(res, adminPage(req, 'Guía rápida de Melee', guide())));

// ---------------- Liga ----------------
r.get('/liga', (req, res) => {
  const seasons = db.prepare('SELECT * FROM seasons ORDER BY end_date DESC').all();
  const y = new Date().getFullYear();
  send(res, adminPage(req, 'Liga', html`
    ${seasons.length ? html`<div class="tablewrap"><table class="tbl"><thead><tr><th>Liga</th><th>Juego</th><th>Fechas</th><th>Pública</th><th></th></tr></thead><tbody>
      ${seasons.map(s => html`<tr><td><a href="/admin/liga/${s.id}"><b>${s.name}</b></a></td><td>${gameBadge(s.game)}</td><td>${s.start_date} → ${s.end_date}</td>
      <td>${s.public ? html`<a href="/liga/${s.id}" target="_blank">sí ↗</a>` : 'no'}</td><td><a href="/admin/liga/${s.id}">Ver</a></td></tr>`)}</tbody></table></div>` : ''}
    <section class="panel"><h2>Nueva liga / temporada</h2>${seasonForm({ name: '', game: 'StarWarsUnlimited', start_date: `${y}-01-01`, end_date: `${y}-12-31`, pts_win: 3, pts_draw: 1, pts_loss: 0, pts_attend: 1, pts_bonus: '3,2,1,1', public: 1 }, '/admin/liga')}</section>`));
});

function seasonForm(s, action) {
  return html`<form method="post" action="${action}" class="grid2">
    <label>Nombre<input name="name" value="${s.name}" required placeholder="Liga SWU invierno"></label>
    <label>Juego<select name="game">${Object.entries(melee.GAMES).map(([k, g]) => html`<option value="${k}" ${k === s.game ? 'selected' : ''}>${g.label}</option>`)}
      <option value="commander" ${s.game === 'commander' ? 'selected' : ''}>Commander (eventos de esta web)</option></select>
      <small class="muted">En Commander se suman los puntos del evento (4 o 3 por victoria) + asistencia + bonus por puesto.</small></label>
    <label>Desde<input type="date" name="start_date" value="${s.start_date}" required></label>
    <label>Hasta<input type="date" name="end_date" value="${s.end_date}" required></label>
    <label>Puntos por victoria (o bye)<input name="pts_win" type="number" value="${s.pts_win}"></label>
    <label>Puntos por empate<input name="pts_draw" type="number" value="${s.pts_draw}"></label>
    <label>Puntos por derrota<input name="pts_loss" type="number" value="${s.pts_loss}"></label>
    <label>Puntos por asistir<input name="pts_attend" type="number" value="${s.pts_attend}"></label>
    <label>Bonus por puesto final (1º,2º,3º…)<input name="pts_bonus" value="${s.pts_bonus}" placeholder="3,2,1,1"></label>
    <label class="check-inline"><input type="checkbox" name="public" value="1" ${s.public ? 'checked' : ''}> Visible en la web pública</label>
    <div class="full"><button class="btn">Guardar</button></div></form>`;
}
function seasonParams(b) {
  return [String(b.name || '').slice(0, 120), b.game, b.start_date, b.end_date, Number(b.pts_win) || 0, Number(b.pts_draw) || 0,
    Number(b.pts_loss) || 0, Number(b.pts_attend) || 0, String(b.pts_bonus || '').replace(/[^0-9,]/g, ''), b.public ? 1 : 0];
}
r.post('/liga', (req, res) => {
  const info = db.prepare('INSERT INTO seasons (name, game, start_date, end_date, pts_win, pts_draw, pts_loss, pts_attend, pts_bonus, public) VALUES (?,?,?,?,?,?,?,?,?,?)').run(...seasonParams(req.body));
  back(res, `/admin/liga/${info.lastInsertRowid}`, 'Liga creada');
});
r.get('/liga/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM seasons WHERE id = ?').get(Number(req.params.id));
  if (!s) return res.status(404).send('No encontrada');
  const all = stats.seasonTournaments(s);
  const { rows } = stats.leagueTable(s, true);
  send(res, adminPage(req, s.name, html`
    <p>${gameBadge(s.game)} ${s.start_date} → ${s.end_date} ${s.public ? html`· <a href="/liga/${s.id}" target="_blank">Ver pública ↗</a>` : ''}</p>
    <div class="cols"><section class="panel"><h2>Clasificación</h2>${rows.length ? html`<table class="tbl"><thead><tr><th>#</th><th>Jugador</th><th class="num">Pts</th><th class="num">Torneos</th><th class="num">V-D-E</th><th class="num">1º</th></tr></thead>
      <tbody>${rows.map(r => html`<tr><td>${r.pos}</td><td><a href="/admin/jugadores/${encodeURIComponent(r.key)}">${r.name}</a></td><td class="num strong">${r.points}</td><td class="num">${r.events}</td><td class="num">${r.w}-${r.l}-${r.d}</td><td class="num">${r.wins || ''}</td></tr>`)}</tbody></table>`
    : html`<p class="muted">Sin torneos finalizados en estas fechas.</p>`}</section>
    <section class="panel"><h2>Torneos que cuentan</h2>${all.length ? html`<ul class="list">${all.map(t => html`<li class="${t.excluded ? 'dim' : ''}">
      <form method="post" action="/admin/liga/${s.id}/toggle/${t.id}" class="inline"><button class="tick">${t.excluded ? '' : '✔'}</button></form>
      <a href="${t.cmdId ? `/admin/commander/${t.cmdId}` : `/admin/torneos/${t.id}`}">${t.name}</a> <small class="muted">${fmtDay(t.start_date || t.last_pair)}</small></li>`)}</ul>` : html`<p class="muted">Ninguno aún.</p>`}
      <p class="small muted">Desmarca un torneo para excluirlo de la liga.</p></section></div>
    <section class="panel"><h2>Configuración</h2>${seasonForm(s, `/admin/liga/${s.id}/editar`)}
      <form method="post" action="/admin/liga/${s.id}/borrar" onsubmit="return confirm('¿Borrar esta liga?')"><button class="link danger">Borrar liga</button></form></section>`));
});
r.post('/liga/:id/editar', (req, res) => {
  db.prepare('UPDATE seasons SET name=?, game=?, start_date=?, end_date=?, pts_win=?, pts_draw=?, pts_loss=?, pts_attend=?, pts_bonus=?, public=? WHERE id = ?')
    .run(...seasonParams(req.body), Number(req.params.id));
  back(res, `/admin/liga/${req.params.id}`, 'Guardado');
});
r.post('/liga/:id/toggle/:tid', (req, res) => {
  const sid = Number(req.params.id), tid = Number(req.params.tid);
  const ex = db.prepare('SELECT 1 FROM season_excluded WHERE season_id = ? AND tournament_id = ?').get(sid, tid);
  if (ex) db.prepare('DELETE FROM season_excluded WHERE season_id = ? AND tournament_id = ?').run(sid, tid);
  else db.prepare('INSERT INTO season_excluded (season_id, tournament_id) VALUES (?, ?)').run(sid, tid);
  res.redirect(`/admin/liga/${sid}`);
});
r.post('/liga/:id/borrar', (req, res) => {
  db.prepare('DELETE FROM seasons WHERE id = ?').run(Number(req.params.id));
  back(res, '/admin/liga', 'Liga borrada');
});

// ---------------- Jugadores ----------------
const gameShort = g => (g === 'commander' ? 'Commander' : melee.gameInfo(g).short);
const gameColor = g => (g === 'commander' ? '#7b5ea7' : melee.gameInfo(g).color);
const gBadge = g => html`<span class="badge" style="--g:${gameColor(g)}">${gameShort(g)}</span>`;

// Pestañas comunes de Jugadores · Cuentas web · Vincular · Staff
function peopleTabs(req, cur) {
  const nPend = A.pendingCount(), nDup = people.duplicates().length;
  const t = [['/admin/jugadores', 'Fichas', 'fichas'], ['/admin/cuentas', 'Cuentas', 'cuentas', nPend], ['/admin/vincular', 'Duplicados', 'vincular', nDup],
    ...(req.user.role === 'admin' ? [['/admin/usuarios', 'Staff', 'staff']] : [])];
  return html`<nav class="tabs ptabs" aria-label="Jugadores">${t.map(([h, l, k, n]) => html`<a href="${h}" class="${cur === k ? 'on' : ''}">${l}${n ? html` <span class="navbadge">${n}</span>` : ''}</a>`)}</nav>`;
}
// Ficha (clave canónica) → cuenta web que la tiene
const accountsByPerson = () => new Map(A.list().filter(a => a.linked).map(a => [a.person, a]));

r.get('/jugadores', (req, res) => {
  const game = req.query.juego || '';
  const filter = req.query.ver || 'todos';
  let rows = people.overview(game || null);
  const total = rows.length;
  const nNew = rows.filter(x => x.isNew).length;
  const nInactive = rows.filter(x => x.inactive).length;
  if (filter === 'nuevos') rows = rows.filter(x => x.isNew);
  if (filter === 'inactivos') rows = rows.filter(x => x.inactive);
  const accBy = accountsByPerson();
  const nAcc = rows.filter(x => accBy.has(x.key)).length;
  if (filter === 'cuenta') rows = rows.filter(x => accBy.has(x.key));
  if (filter === 'sincuenta') rows = rows.filter(x => !accBy.has(x.key));
  const qs = String(req.query.q || '').trim().toLowerCase();
  if (qs) rows = rows.filter(x => { const a = accBy.get(x.key); return [x.name, x.username, a && a.name, a && a.nick, a && a.email].join(' ').toLowerCase().includes(qs); });
  const games = db.prepare('SELECT DISTINCT game FROM tournaments').all().map(x => x.game);
  if (db.prepare('SELECT COUNT(*) c FROM cmd_events').get().c) games.push('commander');
  const q = (k, v) => `?juego=${k === 'juego' ? v : game}&ver=${k === 'ver' ? v : filter}${qs ? '&q=' + encodeURIComponent(qs) : ''}`;
  const nPend = A.pendingCount();
  send(res, adminPage(req, 'Jugadores', html`${peopleTabs(req, 'fichas')}
    ${nPend ? html`<div class="notice"><b>${nPend} solicitud${nPend > 1 ? 'es' : ''}</b> para unir una cuenta web a su ficha. <a class="btn small" href="/admin/cuentas">Revisar</a></div>` : ''}
    <div class="stats"><div><b>${total}</b><span>jugadores</span></div><div><b>${nAcc}</b><span>con cuenta web</span></div><div><b>${nNew}</b><span>nuevos (${settings().inactive_days} días)</span></div>
      <div><b>${nInactive}</b><span>sin venir +${settings().inactive_days} días</span></div></div>
    <form method="get" class="filters"><input type="hidden" name="juego" value="${game}"><input type="hidden" name="ver" value="${filter}"><input name="q" value="${qs}" placeholder="Buscar por nombre, usuario de Melee, nick o email"><button class="btn small ghost">Buscar</button></form>
    <div class="chips"><a href="${q('juego', '')}" class="${!game ? 'on' : ''}">Todos</a>${games.map(g => html`<a href="${q('juego', g)}" class="${g === game ? 'on' : ''}">${gameShort(g)}</a>`)}
      <span class="sep"></span>${[['todos', 'Todos'], ['nuevos', 'Nuevos'], ['inactivos', 'Inactivos'], ['cuenta', 'Con cuenta web'], ['sincuenta', 'Sin cuenta']].map(([k, l]) => html`<a href="${q('ver', k)}" class="${filter === k ? 'on' : ''}">${l}</a>`)}</div>
    <div class="tablewrap"><table class="tbl"><thead><tr><th>Jugador</th><th>Usuario</th><th>Cuenta web</th><th class="num">Eventos</th><th class="num">1º</th><th>Primera vez</th><th>Última vez</th><th>Juegos</th></tr></thead>
    <tbody>${rows.map(p => html`<tr><td><a href="/admin/jugadores/${encodeURIComponent(p.key)}">${p.name}</a>
      ${p.isNew ? html` <span class="pill new">nuevo</span>` : ''}${p.inactive ? html` <span class="pill warn">${p.daysSince} días</span>` : ''}</td>
      <td class="muted">${p.username}</td><td>${(a => a ? html`<a class="pill acc" href="/admin/cuentas/${a.id}" title="${a.email}">${a.nick ? '@' + a.nick : a.name}</a>` : '')(accBy.get(p.key))}</td><td class="num">${p.events}</td><td class="num">${p.titles || ''}</td><td>${fmtDay(p.first_seen)}</td><td>${fmtDay(p.last_seen)}</td>
      <td>${p.games.map(gBadge)}</td></tr>`)}</tbody></table></div>
    ${rows.length ? '' : html`<p class="muted">Nadie coincide con ese filtro.</p>`}
    <p class="small muted">Cada jugador tiene una sola ficha aunque juegue a varios juegos, con su cuenta web si la tiene. Los apuntados a mano en Commander se unen solos a su ficha de Melee si el nombre es idéntico; el resto se une (o se separa) en <a href="/admin/vincular">Duplicados</a>.</p>`));
});

r.get('/jugadores/:key', (req, res) => {
  const canon = I.resolve(req.params.key);
  if (canon !== req.params.key) return res.redirect(`/admin/jugadores/${encodeURIComponent(canon)}`);
  const p = people.profile(req.params.key, { admin: true });
  if (!p) return res.status(404).send('Jugador no encontrado');
  const inf = I.info(p.key) || {};
  const L = people.allLinks();
  const mine = [...L.manual.filter(l => l.dstKey === p.key), ...L.auto.filter(l => l.dstKey === p.key)];
  const dir = people.directory();
  const me = dir.find(x => x.key === p.key);
  const acc = A.ownerOf(p.key);
  const freeAccs = acc ? [] : A.list().filter(a => !a.linked);
  send(res, adminPage(req, p.name, html`${peopleTabs(req, 'fichas')}
    <p class="muted">${p.username} ${inf.nick ? html`· nick <b>${inf.nick}</b>` : ''} ${feature('profiles') ? html`· <a href="/jugador/${encodeURIComponent(p.key)}" target="_blank">Ver perfil público ↗</a>` : ''}</p>
    <div class="stats"><div><b>${p.events}</b><span>eventos</span></div><div><b>${p.w}-${p.l}-${p.d}</b><span>V-D-E</span></div>
      <div><b>${p.titles}</b><span>torneos ganados</span></div><div><b>${p.top3}</b><span>podios</span></div></div>
    <div class="cols"><section class="panel"><h2>Historial</h2><table class="tbl"><tbody>${p.entries.map(e => html`<tr>
      <td class="nowrap">${fmtDay(e.date)}</td><td><a href="${e.adminHref}">${e.event}</a>${e.deck ? html` <small class="muted">${e.deck}</small>` : ''}
        ${e.full && e.full !== p.name && e.source === 'commander' ? html` <small class="muted">como «${e.full}»</small>` : ''}</td>
      <td>${gBadge(e.game)}</td><td class="num">${e.rank ? `${e.rank}º` : ''}</td><td class="num">${e.record || ''}</td></tr>`)}</tbody></table></section>
    <section class="panel"><h2>Por juego</h2><table class="tbl"><tbody>${p.games.map(g => html`<tr><td>${gBadge(g.game)}</td><td class="num">${g.events} eventos</td>
      <td class="num">${g.w}-${g.l}-${g.d}</td><td class="num">${g.titles ? `${g.titles} 🏆` : ''}</td></tr>`)}</tbody></table>
      <h2 style="margin-top:18px">Rivales frecuentes</h2>${p.rivals.length ? html`<table class="tbl"><tbody>${p.rivals.map(x => html`<tr>
      <td><a href="/admin/jugadores/${encodeURIComponent(x.key)}">${x.name}</a></td><td class="num">${x.w}-${x.l}-${x.d}</td></tr>`)}</tbody></table>` : html`<p class="muted">—</p>`}</section></div>

    <div class="cols">
      <section class="panel"><h2>Ficha</h2>
        <form method="post" action="/admin/jugadores/${encodeURIComponent(p.key)}/ficha" class="stack">
          <label>Nick (se muestra en la web pública en lugar del usuario)<input name="nick" value="${inf.nick || ''}" maxlength="40"></label>
          <label>Otros nombres con los que se apunta (separados por comas; ayudan a reconocerlo)<input name="aliases" value="${inf.aliases || ''}" maxlength="300" placeholder="Juanma, JM"></label>
          <label>Notas internas<textarea name="notes" rows="2" maxlength="1000">${inf.notes || ''}</textarea></label>
          <button class="btn small">Guardar ficha</button></form>
        <h2 style="margin-top:18px">Cuenta web</h2>
        ${acc ? html`<p><a href="/admin/cuentas/${acc.id}"><b>${acc.name}</b></a>${acc.nick ? html` <small class="muted">@${acc.nick}</small>` : ''} <small class="muted">${acc.email}</small></p>
          <p class="actions"><a class="btn small ghost" href="/admin/cuentas/${acc.id}">Editar cuenta</a>
          <form method="post" action="/admin/cuentas/${acc.id}/desunir" class="inline" onsubmit="return confirm('¿Quitar el vínculo? La cuenta deja de tener este historial.')"><input type="hidden" name="back" value="/admin/jugadores/${encodeURIComponent(p.key)}"><button class="btn small danger-ghost">Quitar vínculo</button></form></p>`
    : freeAccs.length ? html`<form method="post" action="/admin/jugadores/${encodeURIComponent(p.key)}/cuenta" class="addone"><select name="account_id" required><option value="">Unir a una cuenta sin ficha…</option>${freeAccs.map(a => html`<option value="${a.id}">${a.name}${a.nick ? ' @' + a.nick : ''} · ${a.email}</option>`)}</select><button class="btn small">Unir</button></form>`
    : html`<p class="muted small">Sin cuenta web. Cuando se registre en la web podrá pedir esta ficha y te llegará a Cuentas web.</p>`}
        ${me && me.names.length + me.usernames.length > 1 ? html`<p class="small muted">Aparece como: ${[...me.usernames.map(u => '@' + u), ...me.names].join(' · ')}</p>` : ''}
      </section>
      <section class="panel"><h2>Fichas unidas</h2>
        ${mine.length ? html`<table class="tbl"><tbody>${mine.map(l => linkRow(l, `/admin/jugadores/${encodeURIComponent(p.key)}`))}</tbody></table>`
    : html`<p class="muted">Ninguna: todo lo de esta ficha viene de un solo nombre o usuario.</p>`}
        <form method="post" action="/admin/vincular/unir" class="stack" style="margin-top:12px">
          <input type="hidden" name="a" value="${p.key}"><input type="hidden" name="back" value="/admin/jugadores/${encodeURIComponent(p.key)}">
          <label>Unir con otra ficha<span class="ppick"><input class="person-pick" data-field="b" data-exclude="${p.key}" placeholder="Busca por nombre o usuario" autocomplete="off"><input type="hidden" name="b"></span></label>
          <button class="btn small">Unir</button></form>
      </section>
    </div>`));
});

r.post('/jugadores/:key/cuenta', (req, res) => {
  const key = I.resolve(req.params.key);
  const to = `/admin/jugadores/${encodeURIComponent(key)}`;
  const acc = A.get(Number(req.body.account_id));
  if (!acc) return back(res, to, 'Elige una cuenta', true);
  try {
    A.requestClaim(acc, key, null, 'Unida por el staff');
    const c = db.prepare("SELECT id FROM account_claims WHERE account_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(acc.id);
    A.approveClaim(c.id, req.user.username);
    back(res, to, `${acc.name}: cuenta unida a la ficha`);
  } catch (e) { back(res, to, e.message, true); }
});
r.post('/jugadores/:key/ficha', (req, res) => {
  const key = I.resolve(req.params.key);
  I.saveInfo(key, { nick: String(req.body.nick || '').slice(0, 40), aliases: String(req.body.aliases || '').slice(0, 300), notes: String(req.body.notes || '').slice(0, 1000) });
  back(res, `/admin/jugadores/${encodeURIComponent(key)}`, 'Ficha guardada');
});

// ---------------- Vincular ----------------
const kindLabel = l => (l.kind === 'auto' ? 'automático (mismo nombre)' : l.reason || 'a mano');
function rawLabel(k) {
  if (k.startsWith('u:')) {
    const r = db.prepare('SELECT username, full_name FROM players WHERE lower(username) = ? LIMIT 1').get(k.slice(2));
    return r ? `${r.full_name || r.username} (@${r.username})` : '@' + k.slice(2);
  }
  if (k.startsWith('n:')) {
    const r = db.prepare('SELECT name FROM cmd_players WHERE lower(name) = ? LIMIT 1').get(k.slice(2));
    return r ? r.name : k.slice(2);
  }
  const r = db.prepare('SELECT name FROM cmd_players WHERE person_key = ? LIMIT 1').get(k);
  return r ? `${r.name} (otra persona)` : k;
}
function linkRow(l, backUrl) {
  return html`<tr><td>${l.created_at ? rawLabel(l.src) : l.srcLabel}</td><td class="muted">→</td>
    <td><a href="/admin/jugadores/${encodeURIComponent(l.dstKey)}">${l.dstLabel}</a></td>
    <td class="small muted">${kindLabel(l)}${l.created_by ? ` · ${l.created_by}` : ''}${l.created_at ? ` · ${fmtDay(l.created_at)}` : ''}</td>
    <td><form method="post" action="/admin/vincular/separar" class="inline"><input type="hidden" name="src" value="${l.src}"><input type="hidden" name="dst" value="${l.dst}">
      <input type="hidden" name="back" value="${backUrl}"><button class="link danger">Separar</button></form></td></tr>`;
}
const personCell = p => html`<div class="pcell"><a href="/admin/jugadores/${encodeURIComponent(p.key)}"><b>${p.name}</b></a>
  ${p.usernames.length ? html`<small class="muted">${p.usernames.map(u => '@' + u).join(' ')}</small>` : html`<small class="muted">sin cuenta de Melee</small>`}
  <span>${p.games.map(gBadge)} <small class="muted">${p.events} evento${p.events === 1 ? '' : 's'}</small></span></div>`;

// ---------- Cuentas de jugadores ----------
const A = require('../accounts');
const localAt = at => (at ? new Date(String(at).replace(' ', 'T') + 'Z').toLocaleString('es-ES', { timeZone: config.tz, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
r.get('/cuentas', (req, res) => {
  const pend = A.pendingClaims();
  const dir = people.directory();
  const byKey = new Map(dir.map(p => [p.key, p]));
  const accs = A.list();
  const q = String(req.query.q || '').trim().toLowerCase();
  const shown = q ? accs.filter(a => (a.name + ' ' + (a.nick || '') + ' ' + a.email).toLowerCase().includes(q)) : accs;
  const fichaOf = key => byKey.get(I.resolve(key));
  const reset = req.query.reset ? String(req.query.reset) : null;
  send(res, adminPage(req, 'Jugadores', html`${peopleTabs(req, 'cuentas')}
    ${reset ? html`<div class="flash"><b>Enlace para cambiar la contraseña</b> (válido 48 h, un solo uso). Pásaselo al jugador por WhatsApp o Telegram:<br><code class="copyable">${absUrl(req, reset)}</code></div>` : ''}
    <section class="panel ${pend.length ? 'live' : ''}"><h2>Solicitudes para unir fichas (${pend.length})</h2>
      ${pend.length ? html`<p class="small muted">Comprueba que la persona es quien dice (por ejemplo, que te lo confirme en la tienda) antes de aprobar: al aprobar, su cuenta pasa a tener todo el historial de esa ficha.</p>
        <div class="claims">${pend.map(c => { const f = fichaOf(c.person_key); return html`<div class="claim">
          <div><b>${c.aname}</b> <small class="muted">${c.email}</small><br>dice que es <b>${f ? f.name : c.label || c.person_key}</b>
            <small class="muted">${f ? `${[...(f.usernames || [])].slice(0, 2).map(u => '@' + u).join(' ')} · ${f.events} eventos` : ''} · pedido ${localAt(c.created_at)}</small>${c.note ? html`<br><small>«${c.note}»</small>` : ''}</div>
          <div class="claimbtns"><a class="btn small ghost" href="/admin/jugadores/${encodeURIComponent(I.resolve(c.person_key))}" target="_blank">Ver ficha</a>
            <form method="post" action="/admin/cuentas/solicitud/${c.id}/aprobar"><button class="btn small">Aprobar</button></form>
            <form method="post" action="/admin/cuentas/solicitud/${c.id}/rechazar" onsubmit="return confirm('¿Rechazar la solicitud?')"><button class="btn small danger-ghost">Rechazar</button></form></div></div>`; })}</div>`
      : html`<p class="muted">No hay solicitudes pendientes.</p>`}
    </section>
    <section class="panel"><h2>Cuentas (${accs.length})</h2>
      <form method="get" class="filters"><input name="q" value="${req.query.q || ''}" placeholder="Buscar por nombre, nick o email"><button class="btn small ghost">Buscar</button></form>
      ${shown.length ? html`<div class="tablewrap"><table class="tbl"><thead><tr><th>Jugador</th><th>Email</th><th>Ficha</th><th>Alta</th><th>Último acceso</th><th></th></tr></thead><tbody>
        ${shown.map(a => { const f = fichaOf(a.person); return html`<tr><td><a href="/admin/cuentas/${a.id}"><b>${a.name}</b></a>${a.nick ? html` <small class="muted">@${a.nick}</small>` : ''}</td><td class="small">${a.email}</td>
          <td>${a.linked ? html`<a href="/admin/jugadores/${encodeURIComponent(a.person)}">${f ? f.name : a.person}</a>` : html`<span class="muted small">sin unir</span>`}</td>
          <td class="nowrap small">${localAt(a.created_at)}</td><td class="nowrap small">${localAt(a.last_login)}</td>
          <td class="nowrap"><a class="btn small ghost" href="/admin/cuentas/${a.id}">Editar</a></td></tr>`; })}</tbody></table></div>` : html`<p class="muted">${q ? 'No hay cuentas con esa búsqueda.' : 'Aún no se ha registrado nadie. Los jugadores crean su cuenta en la web (botón «Entrar» arriba a la derecha).'}</p>`}
    </section>`));
});
r.post('/cuentas/solicitud/:id/aprobar', (req, res) => {
  try { const acc = A.approveClaim(Number(req.params.id), req.user.username); back(res, '/admin/cuentas', `${acc.name}: ficha unida a su cuenta`); }
  catch (e) { back(res, '/admin/cuentas', e.message, true); }
});
r.post('/cuentas/solicitud/:id/rechazar', (req, res) => { A.rejectClaim(Number(req.params.id), req.user.username, req.body.reason); back(res, '/admin/cuentas', 'Solicitud rechazada'); });
r.post('/cuentas/:id/clave', (req, res) => res.redirect(`/admin/cuentas/${Number(req.params.id)}?reset=` + encodeURIComponent(A.resetLink(Number(req.params.id)))));
r.post('/cuentas/:id/desunir', (req, res) => { A.unlinkAccount(Number(req.params.id)); back(res, safeBack(req.body.back, `/admin/cuentas/${Number(req.params.id)}`), 'Vínculo quitado'); });
r.post('/cuentas/:id/unir', (req, res) => {
  const acc = A.get(Number(req.params.id));
  const key = String(req.body.person_key || '');
  if (!acc || !key) return back(res, `/admin/cuentas/${Number(req.params.id)}`, 'Elige una ficha de la lista', true);
  try {
    A.requestClaim(acc, key, req.body.label, 'Unida por el staff');
    const c = db.prepare("SELECT id FROM account_claims WHERE account_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1").get(acc.id);
    A.approveClaim(c.id, req.user.username);
    back(res, `/admin/cuentas/${acc.id}`, `${acc.name}: ficha unida`);
  } catch (e) { back(res, `/admin/cuentas/${acc.id}`, e.message, true); }
});
r.post('/cuentas/:id/borrar', (req, res) => { A.remove(Number(req.params.id)); back(res, '/admin/cuentas', 'Cuenta borrada'); });

// Ficha de una cuenta: el staff puede cambiarlo todo
r.get('/cuentas/:id', (req, res) => {
  const acc = A.get(Number(req.params.id));
  if (!acc) return back(res, '/admin/cuentas', 'Cuenta no encontrada', true);
  const key = A.keyOf(acc), person = A.personKey(acc), linked = person !== key;
  const ficha = people.directory().find(p => p.key === person);
  const claims = A.allClaims(acc.id);
  const entries = db.prepare(`SELECT p.*, e.name ename, e.status estatus, e.price_cents, e.start_date FROM cmd_players p JOIN cmd_events e ON e.id = p.event_id
    WHERE p.account_id = ? ORDER BY COALESCE(e.start_date, e.created_at) DESC`).all(acc.id);
  const myDecks = A.decks(acc.id);
  const reset = req.query.reset ? String(req.query.reset) : null;
  const st = { pending: 'Pendiente', approved: 'Aprobada', rejected: 'Rechazada' };
  send(res, adminPage(req, `Cuenta · ${acc.name}`, html`${peopleTabs(req, 'cuentas')}
    <p><a href="/admin/cuentas">← Todas las cuentas</a></p>
    ${reset ? html`<div class="flash"><b>Enlace para cambiar la contraseña</b> (válido 48 h, un solo uso). Pásaselo al jugador:<br><code class="copyable">${absUrl(req, reset)}</code></div>` : ''}
    <div class="stats"><div><b>${entries.filter(e => e.dropped_round == null && !e.waitlist).length}</b><span>torneos apuntado</span></div><div><b>${myDecks.length}</b><span>mazos guardados</span></div>
      <div><b>${A.sessions(acc.id)}</b><span>sesiones abiertas</span></div><div><b>${localAt(acc.last_login) || '—'}</b><span>último acceso</span></div></div>
    <div class="cols">
      <section class="panel"><h2>Datos</h2>
        <form method="post" action="/admin/cuentas/${acc.id}/datos" class="stack">
          <label>Nombre<input name="name" value="${acc.name}" maxlength="60" required></label>
          <label>Nick<input name="nick" value="${acc.nick || ''}" maxlength="24" placeholder="Opcional, sin espacios"></label>
          <label>Email (con el que entra)<input type="email" name="email" value="${acc.email}" required></label>
          <label>Notas internas (solo las ve el staff)<textarea name="notes" rows="3" maxlength="1000">${acc.notes || ''}</textarea></label>
          <div><button class="btn">Guardar</button></div>
          <small class="muted">El nombre y el nick nuevos se aplican también en sus torneos sin terminar. Alta: ${localAt(acc.created_at)}.</small></form>
      </section>
      <section class="panel"><h2>Contraseña y acceso</h2>
        <form method="post" action="/admin/cuentas/${acc.id}/nueva-clave" class="stack"><label>Poner una contraseña nueva<input type="text" name="password" minlength="8" autocomplete="off" placeholder="Mínimo 8 caracteres"></label>
          <div><button class="btn small">Cambiar contraseña</button></div><small class="muted">Cierra sus sesiones abiertas. Díselo en persona.</small></form>
        <form method="post" action="/admin/cuentas/${acc.id}/clave" style="margin-top:12px"><button class="btn small ghost">O generar un enlace para que la cambie él</button></form>
        <form method="post" action="/admin/cuentas/${acc.id}/sesiones" style="margin-top:8px"><button class="btn small ghost">Cerrar todas sus sesiones</button></form>
      </section>
    </div>
    <section class="panel"><h2>Ficha de jugador</h2>
      ${linked ? html`<p>Unida a <a href="/admin/jugadores/${encodeURIComponent(person)}"><b>${ficha ? ficha.name : person}</b></a>${ficha ? html` <small class="muted">${[...(ficha.usernames || [])].slice(0, 2).map(u => '@' + u).join(' ')} · ${ficha.events} eventos</small>` : ''}</p>
        <form method="post" action="/admin/cuentas/${acc.id}/desunir" class="inline" onsubmit="return confirm('¿Quitar el vínculo con la ficha? Su historial deja de estar en la cuenta.')"><button class="btn small danger-ghost">Quitar vínculo</button></form>`
      : html`<p class="muted">Sin unir a ninguna ficha: lo que juegue con la cuenta queda en una ficha nueva a su nombre.</p>`}
      <form method="post" action="/admin/cuentas/${acc.id}/unir" class="addone" style="margin-top:12px"><span class="ppick"><input class="person-pick" data-field="person_key" name="label" placeholder="${linked ? 'Unir también otra ficha…' : 'Unir a una ficha: nombre, apellido o usuario de Melee'}" autocomplete="off"><input type="hidden" name="person_key"></span><button class="btn small">Unir</button></form>
      ${claims.length ? html`<h3>Solicitudes</h3><table class="tbl"><tbody>${claims.map(c => html`<tr><td>${c.label || c.person_key}</td><td><span class="pill ${c.status === 'approved' ? 'new' : c.status === 'rejected' ? 'warn' : ''}">${st[c.status] || c.status}</span></td>
        <td class="small muted">${localAt(c.created_at)}${c.decided_by ? ` · ${c.decided_by} ${localAt(c.decided_at)}` : ''}${c.reason ? ` · ${c.reason}` : ''}</td>
        <td>${c.status === 'pending' ? html`<form method="post" action="/admin/cuentas/solicitud/${c.id}/aprobar" class="inline"><button class="link">Aprobar</button></form> · <form method="post" action="/admin/cuentas/solicitud/${c.id}/rechazar" class="inline"><button class="link danger">Rechazar</button></form>` : ''}</td></tr>`)}</tbody></table>` : ''}
    </section>
    <section class="panel"><h2>Torneos de Commander</h2>
      ${entries.length ? html`<table class="tbl"><tbody>${entries.map(e => html`<tr><td><a href="/admin/commander/${e.event_id}">${e.ename}</a> <small class="muted">${fmtDate(e.start_date)}</small></td>
        <td>${e.waitlist ? html`<span class="pill">en espera</span>` : e.dropped_round != null ? html`<span class="pill">baja</span>` : html`<span class="pill new">apuntado</span>`}</td>
        <td>${e.price_cents != null && !e.waitlist ? html`<form method="post" action="/admin/commander/${e.event_id}/jugadores/${e.id}/pago" class="inline"><input type="hidden" name="paid" value="${e.paid ? 0 : 1}"><button class="paypill ${e.paid ? 'on' : ''}">${e.paid ? `Pagado${e.paid_method ? ' · ' + e.paid_method : ''}` : 'Sin pagar'}</button></form>` : ''}</td>
        <td class="small muted">${e.deck || ''}</td></tr>`)}</tbody></table>` : html`<p class="muted">No se ha apuntado a ningún torneo con la cuenta.</p>`}
    </section>
    <section class="panel"><h2>Mazos guardados (${myDecks.length})</h2>
      ${myDecks.length ? myDecks.map(d => html`<details class="deckitem"><summary><b>${d.name}</b> <small class="muted">${[d.commander && d.commander !== d.name ? d.commander : '', d.value_cents != null ? money(d.value_cents) : '', d.bracket ? `bracket ${d.bracket === 2 ? '1-2' : d.bracket}` : '', localAt(d.updated_at)].filter(Boolean).join(' · ')}</small></summary>
        <form method="post" action="/admin/cuentas/${acc.id}/mazos/${d.id}" class="stack"><label>Nombre<input name="name" value="${d.name}" maxlength="80"></label><label>Lista<textarea name="list" rows="10" spellcheck="false">${d.list}</textarea></label>
          <div class="inline"><button class="btn small">Guardar</button><button class="btn small danger-ghost" name="borrar" value="1" onclick="return confirm('¿Borrar el mazo?')">Borrar</button></div></form></details>`) : html`<p class="muted">No tiene mazos guardados.</p>`}
    </section>
    <section class="panel danger-zone"><h2>Borrar la cuenta</h2><p class="small muted">Se borran la cuenta y sus mazos. Sus torneos siguen en su ficha.</p>
      <form method="post" action="/admin/cuentas/${acc.id}/borrar" onsubmit="return confirm('¿Borrar la cuenta de ${acc.name}?')"><button class="btn small danger-ghost">Borrar cuenta</button></form></section>`));
});
r.post('/cuentas/:id/datos', (req, res) => {
  const id = Number(req.params.id);
  try { A.update(id, req.body, { admin: true }); back(res, `/admin/cuentas/${id}`, 'Guardado'); } catch (e) { back(res, `/admin/cuentas/${id}`, e.message, true); }
});
r.post('/cuentas/:id/nueva-clave', (req, res) => {
  const id = Number(req.params.id);
  try { A.setPassword(id, req.body.password); back(res, `/admin/cuentas/${id}`, 'Contraseña cambiada y sesiones cerradas'); } catch (e) { back(res, `/admin/cuentas/${id}`, e.message, true); }
});
r.post('/cuentas/:id/sesiones', (req, res) => { A.closeSessions(Number(req.params.id)); back(res, `/admin/cuentas/${Number(req.params.id)}`, 'Sesiones cerradas'); });
r.post('/cuentas/:id/mazos/:did', (req, res) => {
  const id = Number(req.params.id), did = Number(req.params.did);
  if (req.body.borrar) { A.deleteDeck(id, did); return back(res, `/admin/cuentas/${id}`, 'Mazo borrado'); }
  const d = A.deck(id, did);
  if (!d) return back(res, `/admin/cuentas/${id}`, 'Mazo no encontrado', true);
  try { A.saveDeck(id, { ...d, id: did, name: req.body.name, list: req.body.list }); back(res, `/admin/cuentas/${id}`, 'Mazo guardado'); } catch (e) { back(res, `/admin/cuentas/${id}`, e.message, true); }
});

r.get('/vincular', (req, res) => {
  const dups = people.duplicates();
  const L = people.allLinks();
  const notsame = db.prepare('SELECT * FROM person_notsame ORDER BY created_at DESC LIMIT 100').all();
  send(res, adminPage(req, 'Jugadores', html`${peopleTabs(req, 'vincular')}
    <p class="muted">Une las fichas que son la misma persona (por ejemplo, alguien apuntado a mano en Commander y su cuenta de Melee). Unir no borra nada y se puede deshacer en «Desvincular».
      Si una de las dos es de Melee, se queda como ficha principal.</p>

    <section class="panel"><h2>Posibles duplicados ${dups.length ? html`<span class="pill warn">${dups.length}</span>` : ''}</h2>
      ${dups.length ? html`<div class="duplist">${dups.slice(0, 60).map(d => html`<div class="dup">
        ${personCell(d.a)}<div class="dupwhy"><span>⇄</span><small>${d.why}</small></div>${personCell(d.b)}
        <div class="dupbtns"><form method="post" action="/admin/vincular/unir"><input type="hidden" name="a" value="${d.a.key}"><input type="hidden" name="b" value="${d.b.key}"><button class="btn small">Unir</button></form>
          <form method="post" action="/admin/vincular/no"><input type="hidden" name="a" value="${d.a.key}"><input type="hidden" name="b" value="${d.b.key}"><button class="btn small ghost">No son la misma persona</button></form></div>
      </div>`)}</div>` : html`<p class="muted">No hay nada pendiente.</p>`}
    </section>

    <section class="panel"><h2>Unir a mano</h2>
      <form method="post" action="/admin/vincular/unir" class="joinform">
        <span class="ppick"><input class="person-pick" data-field="a" placeholder="Jugador 1" autocomplete="off"><input type="hidden" name="a"></span>
        <span class="muted">+</span>
        <span class="ppick"><input class="person-pick" data-field="b" placeholder="Jugador 2" autocomplete="off"><input type="hidden" name="b"></span>
        <button class="btn">Unir</button></form>
    </section>

    <section class="panel"><h2>Desvincular</h2>
      ${L.manual.length || L.auto.length ? html`<div class="tablewrap"><table class="tbl"><thead><tr><th>Ficha</th><th></th><th>Unida a</th><th>Cómo</th><th></th></tr></thead><tbody>
        ${L.manual.map(l => linkRow(l, '/admin/vincular'))}${L.auto.map(l => linkRow(l, '/admin/vincular'))}</tbody></table></div>
        <p class="small muted">«Separar» devuelve la ficha a su estado anterior y recuerda que no son la misma persona (no se volverá a proponer).</p>`
    : html`<p class="muted">Aún no hay fichas unidas.</p>`}
    </section>

    ${notsame.length ? html`<section class="panel"><details><summary>Marcadas como personas distintas (${notsame.length})</summary><table class="tbl"><tbody>
      ${notsame.map(n => html`<tr><td>${rawLabel(n.a)}</td><td class="muted">≠</td><td>${rawLabel(n.b)}</td><td class="small muted">${n.created_by || ''}</td>
        <td><form method="post" action="/admin/vincular/olvidar" class="inline"><input type="hidden" name="a" value="${n.a}"><input type="hidden" name="b" value="${n.b}"><button class="link">Olvidar</button></form></td></tr>`)}
    </tbody></table></details></section>` : ''}`));
});

const safeBack = (v, d = '/admin/vincular') => (typeof v === 'string' && /^\/admin\/[\w\-/%.:]*$/.test(v) ? v : d);
r.post('/vincular/unir', (req, res) => {
  const { a, b } = req.body;
  const to = safeBack(req.body.back);
  if (!a || !b) return back(res, to, 'Elige los dos jugadores de la lista', true);
  if (I.resolve(a) === I.resolve(b)) return back(res, to, 'Ya son la misma ficha', true);
  const main = people.merge(a, b, req.user.username);
  if (!main) return back(res, to, 'No se encontró alguno de los jugadores', true);
  back(res, to.startsWith('/admin/jugadores/') ? `/admin/jugadores/${encodeURIComponent(main)}` : to, 'Fichas unidas');
});
r.post('/vincular/no', (req, res) => {
  if (req.body.a && req.body.b) I.markNotSame(I.resolve(req.body.a), I.resolve(req.body.b), req.user.username);
  back(res, safeBack(req.body.back), 'Anotado: no son la misma persona');
});
r.post('/vincular/separar', (req, res) => {
  const ok = people.separate(String(req.body.src || ''), String(req.body.dst || ''), req.user.username);
  back(res, safeBack(req.body.back), ok ? 'Fichas separadas' : 'Ese vínculo ya no existe', !ok);
});
r.post('/vincular/olvidar', (req, res) => {
  I.forgetNotSame(String(req.body.a || ''), String(req.body.b || ''));
  back(res, '/admin/vincular', 'Olvidado: se podrá volver a proponer');
});
r.get('/api/personas', (req, res) => {
  res.json(people.suggest(String(req.query.q || '').slice(0, 60), { limit: 8 }).filter(p => p.key !== req.query.excluir));
});

// ---------------- Meta ----------------
r.get('/meta', (req, res) => {
  const games = db.prepare('SELECT DISTINCT game FROM tournaments').all().map(x => x.game);
  const hasCmd = db.prepare('SELECT COUNT(*) c FROM cmd_events').get().c > 0;
  const game = req.query.juego || games.find(g => g === 'StarWarsUnlimited') || games[0] || (hasCmd ? 'commander' : 'StarWarsUnlimited');
  const from = req.query.desde || daysAgo(90);
  const to = req.query.hasta || today();
  const filters = html`<form class="filters" method="get"><select name="juego">${games.map(g => html`<option value="${g}" ${g === game ? 'selected' : ''}>${melee.gameInfo(g).label}</option>`)}
      ${hasCmd ? html`<option value="commander" ${game === 'commander' ? 'selected' : ''}>Commander</option>` : ''}</select>
      <input type="date" name="desde" value="${from}"><input type="date" name="hasta" value="${to}"><input type="hidden" name="ver" value="${req.query.ver || ''}"><button class="btn small">Ver</button></form>`;
  if (game === 'commander' && req.query.ver !== 'comandantes') {
    const cm = C.cardMeta(from, to);
    const wrC = req.query.ver === 'winrate';
    const tabsC = html`<div class="chips"><a href="?juego=commander&desde=${from}&hasta=${to}" class="${wrC ? '' : 'on'}">Cartas</a><a href="?juego=commander&desde=${from}&hasta=${to}&ver=winrate" class="${wrC ? 'on' : ''}">Win rate</a><a href="?juego=commander&desde=${from}&hasta=${to}&ver=comandantes">Comandantes</a></div>`;
    return send(res, adminPage(req, 'Meta de la tienda', html`${filters}${tabsC}
      ${cm.decks ? html`<div class="stats"><div><b>${cm.decks}</b><span>mazos validados</span></div><div><b>${cm.rows.length}</b><span>cartas distintas</span></div></div>
        ${wrC ? html`<p class="small muted">Mesas ganadas entre mesas jugadas por los mazos que llevan la carta. En mesas de 4 lo esperado es un 25 % y en mesas de 3 un 33 %. Solo cartas con al menos 2 mazos y ${cm.minGames} mesas.</p>` : ''}
        ${(wrC ? cm.wrRows : cm.rows).length ? html`<div class="tablewrap"><table class="tbl"><thead><tr><th>Carta</th><th class="num">Mazos</th><th class="num">% mazos</th><th class="num">Mesas jugadas</th><th class="num">Mesas ganadas</th><th class="num">Win rate</th><th class="num">Campeón</th></tr></thead>
        <tbody>${(wrC ? cm.wrRows : cm.rows).slice(0, 300).map(c => html`<tr><td><b>${c.name}</b></td><td class="num">${c.decks}</td><td class="num"><span class="bar" style="--w:${c.pct}%">${c.pct}%</span></td>
          <td class="num">${c.played || ''}</td><td class="num">${c.wins || ''}</td><td class="num">${c.winrate != null ? `${c.winrate}%` : '—'}</td><td class="num">${c.champs || ''}</td></tr>`)}</tbody></table></div>`
        : html`<p class="muted">Aún no hay cartas con mesas suficientes para calcular el win rate.</p>`}
        <p class="small muted">Sale de los mazos validados en «Analizar mazo» (sin tierras básicas). «Mesas ganadas» = mesas que ganaron los jugadores que la llevaban.</p>`
    : html`<div class="panel"><p>Aún no hay mazos validados en este periodo.</p><p class="small muted">Las cartas salen de las listas que los jugadores suben en «Analizar mazo». Los comandantes los tienes en la pestaña Comandantes.</p></div>`}`));
  }
  if (game === 'commander') {
    const rows = C.deckMeta(from, to);
    const total = rows.reduce((s, x) => s + x.copies, 0);
    return send(res, adminPage(req, 'Meta de la tienda', html`${filters}
      ${rows.length ? html`<div class="tablewrap"><table class="tbl"><thead><tr><th>Comandante</th><th class="num">Veces jugado</th><th class="num">% meta</th><th class="num">Eventos</th><th class="num">Mesas jugadas</th><th class="num">Mesas ganadas</th><th class="num">Win rate</th><th class="num">Campeón</th></tr></thead>
        <tbody>${rows.map(m => html`<tr><td>${m.name}</td><td class="num">${m.copies}</td><td class="num"><span class="bar" style="--w:${Math.round(m.copies * 100 / total)}%">${Math.round(m.copies * 100 / total)}%</span></td>
        <td class="num">${m.events}</td><td class="num">${m.played || ''}</td><td class="num">${m.wins}</td><td class="num">${m.winrate != null ? `${m.winrate}%` : '—'}</td><td class="num">${m.champs || ''}</td></tr>`)}</tbody></table></div>
        <p class="small muted">Win rate = mesas ganadas entre mesas jugadas. En mesas de 4 lo esperado es un 25 % y en mesas de 3 un 33 %.</p>`
      : html`<div class="panel"><p>Aún no hay comandantes apuntados en este periodo.</p><p class="small muted">Los jugadores lo ponen en la página pública del evento («Tu comandante») o el staff en la lista de jugadores.</p></div>`}`));
  }
  const view = req.query.ver === 'mazos' ? 'mazos' : req.query.ver === 'winrate' ? 'winrate' : 'cartas';
  const qs = (k, v) => `?juego=${encodeURIComponent(game)}&desde=${from}&hasta=${to}&ver=${k === 'ver' ? v : view}`;
  const tabs = html`<div class="chips"><a href="${qs('ver', 'cartas')}" class="${view === 'cartas' ? 'on' : ''}">Cartas</a><a href="${qs('ver', 'winrate')}" class="${view === 'winrate' ? 'on' : ''}">Win rate</a><a href="${qs('ver', 'mazos')}" class="${view === 'mazos' ? 'on' : ''}">Barajas</a></div>`;
  if (view === 'winrate') {
    const baraja = String(req.query.baraja || '').slice(0, 120);
    const cm = decks.cardMeta(game, from, to, { deck: baraja });
    const dwAll = decks.deckWinrate(game, from, to);
    const sel = html`<form class="filters" method="get"><input type="hidden" name="juego" value="${game}"><input type="hidden" name="desde" value="${from}"><input type="hidden" name="hasta" value="${to}"><input type="hidden" name="ver" value="winrate">
      <select name="baraja" onchange="this.form.submit()"><option value="">Todas las barajas</option>${[...dwAll.rows, ...dwAll.few].sort((a, b) => b.decks - a.decks || a.name.localeCompare(b.name)).map(x => html`<option value="${x.name}" ${decks.deckKey(x.name) === decks.deckKey(baraja) ? 'selected' : ''}>${x.name} (${x.decks})</option>`)}</select></form>`;
    const table = rows => html`<div class="tablewrap"><table class="tbl"><thead><tr><th>Carta</th><th class="num">Win rate</th><th class="num">vs. media</th>${baraja ? html`<th class="num">Sin la carta</th>` : ''}<th class="num">V-D-E</th><th class="num">Partidas</th><th class="num">Mazos</th><th class="num">% mazos</th><th class="num">En Top 4</th></tr></thead>
      <tbody>${rows.slice(0, 300).map(c => { const diff = cm.baseWinrate != null ? c.winrate - cm.baseWinrate : 0; return html`<tr><td><b>${c.name}</b>${c.type ? html` <small class="muted">${c.type}</small>` : ''}</td>
        <td class="num"><span class="bar" style="--w:${c.winrate}%">${c.winrate}%</span></td><td class="num ${diff >= 5 ? 'ok' : diff <= -5 ? 'warn' : ''}">${diff > 0 ? '+' : ''}${diff}</td>
        ${baraja ? html`<td class="num">${c.wo.winrate != null ? `${c.wo.winrate}% (${c.wo.games})` : 'todos la llevan'}</td>` : ''}
        <td class="num">${c.w}-${c.l}-${c.d}</td><td class="num">${c.games}</td><td class="num">${c.decks}</td><td class="num">${c.pct}%</td><td class="num">${c.top4 || ''}</td></tr>`; })}</tbody></table></div>`;
    return send(res, adminPage(req, 'Meta de la tienda', html`${filters}${tabs}${sel}
      ${cm.decks ? html`<div class="stats"><div><b>${cm.baseWinrate ?? '—'}%</b><span>win rate medio${baraja ? ' de la baraja' : ''}</span></div><div><b>${cm.games}</b><span>partidas (sin byes)</span></div><div><b>${cm.decks}</b><span>listas</span></div></div>
        <p class="small muted">Partidas ganadas por los mazos que llevan cada carta, sin contar byes. Solo cartas con al menos 2 mazos y ${cm.minGames} partidas; con pocas partidas puede ser casualidad.</p>
        ${cm.wrGroups.length ? cm.wrGroups.map(g => html`<section class="panel"><h2>${g.label}</h2>${table(g.rows)}</section>`) : html`<div class="panel"><p>Aún no hay cartas con partidas suficientes. Prueba con un periodo más largo.</p></div>`}`
      : html`<div class="panel"><p>No hay listas con cartas en este periodo.</p></div>`}`));
  }
  if (view === 'cartas') {
    const ds = decks.status();
    const cm = decks.cardMeta(game, from, to);
    const pctBar = v => html`<span class="bar" style="--w:${v}%">${v}%</span>`;
    const table = rows => html`<div class="tablewrap"><table class="tbl cardmeta"><thead><tr><th>Carta</th><th class="num">Mazos</th><th class="num">% mazos</th><th class="num">Copias media</th>
      <th class="num">En Top 4</th><th class="num">% del Top 4</th><th class="num">Ganadores</th><th class="num">% victorias</th><th class="num">Puesto medio</th></tr></thead>
      <tbody>${rows.slice(0, 300).map(c => html`<tr><td>${cardimg.cardUrl(game, c.name) ? html`<a href="${cardimg.cardUrl(game, c.name)}" target="_blank" rel="noopener" data-card="${cardimg.hasImages(game) ? `${config.basePath}/carta/${encodeURIComponent(game)}/${encodeURIComponent(c.name)}` : ''}"><b>${c.name}</b></a>` : html`<b>${c.name}</b>`}${c.type ? html` <small class="muted">${c.type}</small>` : ''}</td>
        <td class="num">${c.decks}</td><td class="num">${pctBar(c.pct)}</td><td class="num">${c.avg}</td><td class="num">${c.top4 || ''}</td>
        <td class="num">${c.top4 ? `${c.top4pct}%` : ''}</td><td class="num">${c.wins || ''}</td>
        <td class="num ${c.winrate != null && c.games >= 6 ? (c.winrate >= 55 ? 'ok' : c.winrate <= 45 ? 'warn' : '') : ''}">${c.winrate != null ? `${c.winrate}%` : '—'}</td><td class="num">${c.avgRank ?? ''}</td></tr>`)}</tbody></table></div>`;
    return send(res, adminPage(req, 'Meta de la tienda', html`${filters}${tabs}
      ${cm.decks ? html`
        <div class="stats"><div><b>${cm.decks}</b><span>listas con cartas</span></div><div><b>${cm.rows.length}</b><span>cartas distintas</span></div>
          <div><b>${cm.top4Decks}</b><span>listas en Top 4</span></div></div>
        ${cm.groups.length > 1 ? html`<div class="chips">${cm.groups.map(g => html`<a href="#g-${g.kind}">${g.label} (${g.rows.length})</a>`)}</div>` : ''}
        ${cm.groups.map(g => html`<section class="panel" id="g-${g.kind}"><h2>${g.label}</h2>${table(g.rows)}</section>`)}
        ${game === 'CyberpunkTCG' ? (() => { const cs = cardimg.status(); return html`<p class="small muted">Base de cartas de Cyberpunk (cyberpunktcg.com / Netdeck): ${cs.count} cartas${cs.updatedAt ? `, actualizada ${fmtDay(cs.updatedAt)}` : ''}.
          ${cs.lastError ? html`<span class="warn">Error: ${cs.lastError}</span>` : ''}
          <form method="post" action="/admin/meta/cartas-cyberpunk" class="inline"><button class="link">Actualizar ahora</button></form></p>`; })() : ''}
        ${cm.groups.length === 1 ? html`<p class="small muted">Melee no indica en estas listas qué cartas van al sideboard. <a href="/admin/meta/debug">Ver qué devuelve Melee</a>.</p>` : ''}
        <div id="cardtip" class="cardtip" hidden><img alt=""></div>
        <p class="small muted">«% victorias» = partidas ganadas por los mazos que llevan la carta (en verde si pasa del 55 %, con al menos 6 partidas). «% del Top 4» = de los mazos que acabaron en el Top 4, cuántos la llevaban.
          ${feature('meta') ? html` Versión pública: <a href="/meta?juego=${encodeURIComponent(game)}" target="_blank">/meta</a>.` : ''}</p>`
    : html`<div class="panel"><p>No hay cartas de decklists en este periodo.</p>
        <p class="small muted">Se leen de Melee (${ds.withCards} de ${ds.total} listas con cartas leídas${ds.busy ? ', leyendo ahora…' : ''}).
          Hace falta que el torneo pida decklist en Melee.${ds.lastError ? html` Último error: ${ds.lastError}.` : ''}</p>
        <form method="post" action="/admin/meta/leer" class="inline"><button class="btn small">Leer cartas ahora</button></form>
        ${ds.tried ? html` <a class="small" href="/admin/meta/debug">Ver qué devuelve Melee</a>` : ''}</div>`}`));
  }
  const rows = stats.meta(game, from, to);
  const total = rows.reduce((s, x) => s + x.copies, 0);
  const dw = decks.deckWinrate(game, from, to);
  const wr = new Map([...dw.rows, ...dw.few].map(x => [x.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''), x]));
  const wrOf = name => wr.get(String(name || '').replace(/\s+/g, ' ').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  send(res, adminPage(req, 'Meta de la tienda', html`${filters}${tabs}
    ${rows.length ? html`<div class="stats"><div><b>${dw.baseWinrate ?? '—'}%</b><span>win rate medio</span></div><div><b>${dw.games}</b><span>partidas (sin byes)</span></div></div>
      <div class="tablewrap"><table class="tbl"><thead><tr><th>Baraja (nombre del mazo)</th><th class="num">Copias</th><th class="num">% meta</th><th class="num">V-D-E</th><th class="num">Win rate</th><th class="num">vs. media</th><th class="num">Torneos</th><th class="num">Victorias</th><th class="num">Top 4</th><th class="num">Puesto medio</th></tr></thead>
      <tbody>${rows.map(m => { const x = wrOf(m.name); const ok = x && x.decks >= 2 && x.games >= dw.minGames; const diff = ok && dw.baseWinrate != null ? x.winrate - dw.baseWinrate : null;
        return html`<tr><td>${m.name}</td><td class="num">${m.copies}</td><td class="num"><span class="bar" style="--w:${Math.round(m.copies * 100 / total)}%">${Math.round(m.copies * 100 / total)}%</span></td>
      <td class="num">${x ? `${x.w}-${x.l}-${x.d}` : ''}</td><td class="num ${ok ? '' : 'dim'}">${x && x.winrate != null ? `${x.winrate}%` : '—'}</td><td class="num ${diff == null ? '' : diff >= 5 ? 'ok' : diff <= -5 ? 'warn' : ''}">${diff == null ? '' : `${diff > 0 ? '+' : ''}${diff}`}</td>
      <td class="num">${m.events}</td><td class="num">${m.wins}</td><td class="num">${m.top4}</td><td class="num">${m.avg_rank ?? ''}</td></tr>`; })}</tbody></table></div>
      <p class="small muted">Win rate = partidas ganadas sin contar byes. En gris, las barajas con menos de 2 jugadores o ${dw.minGames} partidas (poca muestra).</p>
      <p class="small muted">Es el nombre que el jugador pone a su lista en Melee (a veces Melee lo genera solo, como «RYY»). Para ver lo que de verdad se juega, mira la pestaña Cartas.</p>`
    : html`<div class="panel"><p>No hay listas de mazos en este periodo.</p><p class="small muted">Para que funcione, activa en Melee que los jugadores registren su lista (Decklist) al inscribirse.</p></div>`}`));
});

r.post('/meta/leer', async (req, res) => {
  const r0 = await decks.ensureCards({ limit: 80 }).catch(e => ({ error: e.message }));
  back(res, '/admin/meta', r0.error ? `Error: ${r0.error}` : `Leídas ${r0.found} listas (${r0.fetched} consultas a Melee)`, !!r0.error);
});

r.post('/meta/cartas-cyberpunk', async (req, res) => {
  try { await cardimg.refreshCyberpunk({ force: true }); back(res, '/admin/meta?juego=CyberpunkTCG', `Base de cartas actualizada: ${cardimg.status().count} cartas`); }
  catch (e) { back(res, '/admin/meta?juego=CyberpunkTCG', 'No se pudo descargar la base de cartas: ' + e.message, true); }
});

r.get('/meta/debug', auth.requireAdmin, (req, res) => {
  const d = db.prepare('SELECT d.id, d.name, d.raw, f.cards, f.source, f.error, f.raw detail FROM decklists d LEFT JOIN decklist_fetch f ON f.id = d.id ORDER BY f.fetched_at DESC LIMIT 1').get();
  if (!d) return res.status(404).send('Sin decklists');
  res.type('text/plain; charset=utf-8').send(`Decklist ${d.id} «${d.name}» · cartas leídas: ${d.cards ?? '—'} (${d.source || '—'})${d.error ? ' · error: ' + d.error : ''}\n\n== Lista del torneo ==\n${d.raw}\n\n== Detalle ==\n${d.detail || '(no se pidió)'}\n`);
});

// ---------------- Caja ----------------
r.get('/caja', (req, res) => {
  const from = req.query.desde || daysAgo(30);
  const to = req.query.hasta || today();
  const rows = stats.cash(from, to);
  if (req.query.csv) {
    const head = 'fecha;torneo;juego;jugadores;pagados_melee;precio;ingresos;premios;neto';
    const fmt = c => (c / 100).toFixed(2).replace('.', ',');
    const lines = rows.map(x => [fmtDay(x.date), `"${x.name.replace(/"/g, '""')}"`, x.game, x.players, x.paidMelee, fmt(x.price), fmt(x.income), fmt(x.prizes), fmt(x.net)].join(';'));
    res.set('Content-Disposition', `attachment; filename="caja-${from}-${to}.csv"`);
    return res.type('text/csv; charset=utf-8').send('﻿' + [head, ...lines].join('\n'));
  }
  const sum = k => rows.reduce((s, x) => s + x[k], 0);
  send(res, adminPage(req, 'Caja de torneos', html`
    <form class="filters" method="get"><input type="date" name="desde" value="${from}"><input type="date" name="hasta" value="${to}">
      <button class="btn small">Ver</button><a class="btn ghost small" href="?desde=${from}&hasta=${to}&csv=1">Exportar CSV</a></form>
    <div class="stats"><div><b>${sum('players')}</b><span>inscripciones</span></div><div><b>${money(sum('income'))}</b><span>ingresos estimados</span></div>
      <div><b>${money(sum('prizes'))}</b><span>premios</span></div><div><b>${money(sum('net'))}</b><span>neto</span></div></div>
    <div class="tablewrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Torneo</th><th class="num">Jugadores</th><th class="num" title="En Melee, los que pagaron allí; en Commander, los marcados como pagados en la tienda">Pagados</th><th class="num">Precio</th><th class="num">Ingresos</th><th class="num">Premios</th><th class="num">Neto</th></tr></thead>
    <tbody>${rows.map(x => html`<tr><td>${fmtDay(x.date)}</td><td><a href="${x.cmd ? `/admin/commander/${x.id}` : `/admin/torneos/${x.id}`}">${x.name}</a>${x.cmd ? html` <small class="muted">Commander</small>` : ''}</td><td class="num">${x.players}</td><td class="num">${x.paidMelee}</td>
      <td class="num">${money(x.price)}</td><td class="num">${money(x.income)}</td><td class="num">${money(x.prizes)}</td><td class="num strong">${money(x.net)}</td></tr>`)}</tbody></table></div>
    <p class="small muted">Ingresos = inscritos × precio (precio del torneo o el general de Ajustes). Los premios son los apuntados en cada torneo.</p>`));
});

// ---------------- Cuenta, ajustes y usuarios ----------------
r.get('/cuenta', (req, res) => {
  send(res, adminPage(req, 'Mi cuenta', html`<section class="panel"><h2>Cambiar contraseña</h2>
    <form method="post" class="stack narrow"><label>Contraseña actual<input type="password" name="current" required autocomplete="current-password"></label>
    <label>Nueva contraseña<input type="password" name="password" minlength="8" required autocomplete="new-password"></label>
    <button class="btn">Cambiar</button></form></section>`));
});
r.post('/cuenta', (req, res) => {
  const bcrypt = require('bcryptjs');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(req.body.current || ''), u.pass_hash)) return back(res, '/admin/cuenta', 'La contraseña actual no es correcta', true);
  if (String(req.body.password || '').length < 8) return back(res, '/admin/cuenta', 'Mínimo 8 caracteres', true);
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(auth.hashPassword(req.body.password), u.id);
  back(res, '/admin/cuenta', 'Contraseña cambiada');
});

r.get('/ajustes', auth.requireAdmin, (req, res) => {
  const s = settings();
  const f = (k, label, extra = '') => html`<label>${label}<input name="${k}" value="${s[k]}" ${raw(extra)}></label>`;
  const cb = (k, label) => html`<label class="check-inline"><input type="checkbox" name="${k}" value="1" ${s[k] === '1' ? 'checked' : ''}> ${label}</label>`;
  send(res, adminPage(req, 'Ajustes', html`<form method="post" class="grid2">
    <h2 class="full">Tienda</h2>
    ${f('store_name', 'Nombre de la tienda')}${f('base_url', 'URL pública de esta web', 'placeholder="https://torneos.mitienda.es"')}
    ${f('address', 'Dirección (para los carteles)')}${f('calendar_url', 'Enlace al calendario de la tienda', 'placeholder="https://jupiterjuegos.com/tiendas/valencia/"')}${f('logo_url', 'URL del logo (opcional)')}
    <label>Color principal<input type="color" name="accent" value="${s.accent}"></label>
    ${f('default_price', 'Precio de inscripción por defecto (€)', 'inputmode="decimal"')}
    ${f('default_prize_pct', '% a premios por defecto', 'inputmode="numeric"')}
    ${f('inactive_days', 'Días para considerar inactivo a un jugador', 'inputmode="numeric"')}
    ${f('tv_page_seconds', 'Segundos por pantalla en la TV', 'inputmode="numeric"')}
    ${cb('show_real_names', 'Mostrar nombre real en la web pública y la TV (si no, usuario de Melee)')}
    <h2 class="full">Funciones opcionales</h2>
    ${cb('feature_prizes', 'Premios: calculadora de premios y registro de premios entregados')}
    ${cb('feature_cash', 'Caja: recaudación y neto por torneo (y exportar CSV)')}
    ${cb('feature_profiles', 'Perfiles públicos de jugadores (historial al pulsar su nombre)')}
    ${cb('feature_meta', 'Meta público por cartas (/meta), con imágenes de Cyberpunk TCG')}
    <h2 class="full">Comunidad</h2>
    ${cb('feature_badges', 'Logros: XP, niveles e insignias en el perfil y en Mi cuenta')}
    ${cb('feature_porra', 'Porra: los jugadores pronostican quién gana cada mesa (solo puntos)')}
    ${cb('feature_bounties', 'Se busca: recompensas sobre jugadores (web y TV)')}
    ${cb('feature_trades', 'Tengo / Busco: listas de cambio de cartas de todos los juegos')}
    ${cb('feature_loans', 'Mazos de préstamo: los jugadores prestan y piden mazos')}
    ${cb('feature_moments', 'Momentos: fotos de los jugadores en la TV (con revisión del staff antes de salir)')}
    ${cb('show_game_img', 'Imagen o logo del juego en las tarjetas de torneo (si está desactivado, solo se ve la imagen propia del torneo en Melee)')}
    <h2 class="full">Avisos automáticos</h2>
    <label class="full">Webhook de Discord<input name="discord_webhook" value="${s.discord_webhook}" placeholder="https://discord.com/api/webhooks/…"></label>
    ${f('telegram_token', 'Token del bot de Telegram')}${f('telegram_chat', 'Chat ID de Telegram (grupo o canal)')}
    <p class="full small muted">Con el token del bot, los jugadores también pueden apuntarse a avisos personales («Avísame de mi mesa por Telegram» en la página del torneo): reciben su mesa y rival en cada ronda por privado.
      ${(() => { const st = require('../tgbot').stats(); return st.bot ? html`Bot: <b>@${st.bot}</b> · ${st.subs} jugador(es) apuntados.` : ''; })()}</p>
    ${cb('notify_new', 'Avisar de torneos nuevos con inscripción abierta')}
    ${cb('notify_rounds', 'Publicar emparejamientos de cada ronda')}
    ${cb('notify_final', 'Publicar resultados al terminar')}
    <div class="full"><button class="btn">Guardar ajustes</button></div></form>
    <form method="post" action="/admin/ajustes/probar"><button class="btn ghost">Enviar mensaje de prueba</button></form>
    ${(() => { const ps = pricedb.status(); return html`<section class="panel"><h2>Precios de cartas (valor de mazos)</h2>
      <p>${ps.count ? html`<b>${ps.count.toLocaleString('es-ES')}</b> cartas con precio · actualizado ${ps.updatedAt ? new Date(ps.updatedAt).toLocaleString('es-ES', { timeZone: config.tz }) : '—'}`
    : html`<span class="warn">Aún no hay base local de precios</span> (mientras tanto se consulta Scryfall carta a carta)`}
        ${ps.running ? html` · <b>descargando…</b>` : ''}${ps.lastError ? html`<br><span class="warn">Último error: ${ps.lastError}</span>` : ''}</p>
      <p>Precio usado: <b>${ps.sourceLabel}</b>${ps.guide && ps.guide.createdAt ? html` · guía de Cardmarket del ${new Date(ps.guide.createdAt).toLocaleString('es-ES', { timeZone: config.tz })} (${ps.guide.used.toLocaleString('es-ES')} impresiones con su precio)` : ''}
        ${ps.wanted !== ps.source ? html`<br><span class="warn">Has elegido «${pricedb.SOURCES[ps.wanted]}», pero ${ps.guide && ps.guide.error ? `no se pudo descargar la guía de Cardmarket (${ps.guide.error})` : 'aún no se ha aplicado'}: se usa el de Scryfall.</span>` : ''}</p>
      <form method="post" action="/admin/precios/fuente" class="inline"><label>Qué precio de Cardmarket usar<select name="source">${Object.entries(pricedb.SOURCES).map(([k, l]) => html`<option value="${k}" ${k === ps.wanted ? 'selected' : ''}>${l}</option>`)}</select></label>
        <button class="btn small">Guardar y recalcular</button></form>
      <p class="small muted">Cada día se descarga el fichero de cartas de Scryfall y la guía de precios pública de Cardmarket, y para cada carta se guarda el precio de su impresión más barata (normal o foil). Si la guía de Cardmarket no se puede descargar, se usa el precio que publica Scryfall.</p>
      <form method="post" action="/admin/precios/actualizar"><button class="btn ghost small" ${ps.running ? 'disabled' : ''}>Actualizar ahora</button></form>
      ${(() => { const ns = require('../cardnames').status(); return html`<h3>Nombres en otros idiomas</h3>
        <p>${ns.count ? html`<b>${ns.count.toLocaleString('es-ES')}</b> nombres traducidos · actualizado ${ns.updatedAt ? new Date(ns.updatedAt).toLocaleString('es-ES', { timeZone: config.tz }) : '—'}` : html`<span class="warn">Aún no descargados</span>`}
          ${ns.running ? html` · <b>descargando…</b>` : ''}${ns.lastError ? html`<br><span class="warn">Último error: ${ns.lastError}</span>` : ''}</p>
        <p class="small muted">Una vez a la semana se lee el fichero de Scryfall con todas las impresiones en todos los idiomas (unos 2 GB, sin guardarlo) para reconocer listas escritas en castellano, francés, japonés…</p>
        <form method="post" action="/admin/nombres/actualizar"><button class="btn ghost small" ${ns.running ? 'disabled' : ''}>Actualizar ahora</button></form>`; })()}</section>`; })()}
    <section class="panel"><h2>Imagen por juego</h2>
      <p class="small muted">Se usa cuando el torneo no tiene imagen propia en Melee. Sube aquí los logos oficiales de cada juego (PNG con fondo transparente queda mejor).
        Si no subes nada, se usa la ilustración incluida.</p>
      <div class="gimgs">${GAME_SLOTS.map(([k, l]) => html`<form method="post" action="/admin/ajustes/imagen/${k}" enctype="multipart/form-data" class="gimg">
        <div class="gimg-prev ${s['game_img_' + k] && s['game_img_fit_' + k] !== 'cover' ? 'logo' : ''}" style="--g:${melee.gameInfo(k).color};background-image:${cssUrl(gameArt(k))}${s['game_img_' + k] && s['game_img_fit_' + k] !== 'cover' ? raw(', ' + logoGlow) : ''}"></div>
        <b>${l}</b>
        <input type="file" name="file" accept="image/png,image/jpeg,image/webp,image/avif,image/gif">
        <input name="url" placeholder="…o pega una URL" value="${s['game_img_' + k] && !String(s['game_img_' + k]).includes('/uploads/') ? s['game_img_' + k] : ''}">
        <select name="fit"><option value="logo" ${s['game_img_fit_' + k] !== 'cover' ? 'selected' : ''}>Logo centrado sobre fondo oscuro</option>
          <option value="cover" ${s['game_img_fit_' + k] === 'cover' ? 'selected' : ''}>Imagen a sangre (portada)</option></select>
        <div class="inline"><button class="btn small">Guardar</button>${s['game_img_' + k] ? html`<button class="link danger" name="quitar" value="1">Volver a la ilustración</button>` : ''}</div>
      </form>`)}</div></section>
    <section class="panel"><h2>Melee</h2><p>Credenciales: ${melee.configured() ? html`<span class="ok">configuradas en el servidor</span>` : html`<span class="warn">faltan en el .env</span>`}.
      Por seguridad no se guardan ni se muestran aquí.</p></section>`));
});
r.post('/ajustes', auth.requireAdmin, (req, res) => {
  const checks = ['show_real_names', 'notify_new', 'notify_rounds', 'notify_final', 'feature_prizes', 'feature_cash', 'feature_profiles', 'feature_meta', 'show_game_img',
    'feature_badges', 'feature_porra', 'feature_bounties', 'feature_trades', 'feature_loans', 'feature_moments'];
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (checks.includes(k)) setSetting(k, req.body[k] ? '1' : '0');
    else if (k in req.body) setSetting(k, String(req.body[k]).trim());
  }
  back(res, '/admin/ajustes', 'Ajustes guardados');
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpeg|webp|avif|gif)$/.test(file.mimetype)),
});
r.post('/ajustes/imagen/:game', auth.requireAdmin, upload.single('file'), (req, res) => {
  const k = req.params.game;
  if (!GAME_SLOTS.some(([g]) => g === k)) return back(res, '/admin/ajustes', 'Juego no válido', true);
  const dir = path.join(config.dataDir, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.startsWith(`game-${k}.`) && (req.file || req.body.quitar)) fs.unlinkSync(path.join(dir, f));
  if (req.body.quitar) { setSetting('game_img_' + k, ''); return back(res, '/admin/ajustes', 'Imagen quitada'); }
  setSetting('game_img_fit_' + k, req.body.fit === 'cover' ? 'cover' : 'logo');
  if (req.file) {
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif' }[req.file.mimetype];
    fs.writeFileSync(path.join(dir, `game-${k}.${ext}`), req.file.buffer);
    setSetting('game_img_' + k, `/uploads/game-${k}.${ext}?v=${Date.now()}`);
  } else if (req.body.url && /^https?:\/\//.test(req.body.url)) {
    setSetting('game_img_' + k, String(req.body.url).trim());
  }
  back(res, '/admin/ajustes', 'Imagen guardada');
});

r.post('/nombres/actualizar', auth.requireAdmin, (req, res) => {
  require('../cardnames').refresh({ force: true });
  back(res, '/admin/ajustes', 'Descargando los nombres en otros idiomas (tarda unos minutos)');
});
r.post('/precios/fuente', auth.requireAdmin, (req, res) => {
  const v = String(req.body.source || '');
  if (!pricedb.SOURCES[v]) return back(res, '/admin/ajustes', 'Fuente no válida', true);
  setSetting('price_source', v);
  pricedb.refresh({ force: true }).catch(() => {});
  back(res, '/admin/ajustes', `Precio elegido: ${pricedb.SOURCES[v]}. Recalculando la base de precios (1–3 minutos); después usa «Recalcular todos los mazos» en cada torneo si quieres aplicarlo a mazos ya validados.`);
});
r.post('/precios/actualizar', auth.requireAdmin, (req, res) => {
  pricedb.refresh({ force: true }).catch(() => {});
  back(res, '/admin/ajustes', 'Descargando precios en segundo plano (1–3 minutos). Recarga para ver el estado.');
});

// Copias de seguridad
r.get('/copias', auth.requireAdmin, (req, res) => {
  const files = backup.list();
  send(res, adminPage(req, 'Copias de seguridad', html`
    <p class="muted">Se hace una copia automática de la base de datos cada día y se guardan las últimas ${settings().backup_keep}. Están en la carpeta <code>data/backups</code> del servidor.</p>
    <form method="post" action="/admin/copias" class="inline"><button class="btn">Hacer copia ahora</button></form>
    <div class="tablewrap" style="margin-top:14px"><table class="tbl"><thead><tr><th>Copia</th><th>Fecha</th><th class="num">Tamaño</th><th></th></tr></thead><tbody>
    ${files.map(f => html`<tr><td>${f.name}</td><td>${f.date.toLocaleString('es-ES', { timeZone: config.tz })}</td><td class="num">${(f.size / 1024).toFixed(0)} KB</td>
      <td><a href="/admin/copias/${f.name}">Descargar</a></td></tr>`)}</tbody></table></div>
    ${!files.length ? html`<p class="muted">Todavía no hay copias.</p>` : ''}
    <p class="small muted">Para restaurar: para el contenedor, sustituye <code>data/tienda.sqlite</code> por la copia (renombrándola) y arráncalo.</p>`));
});
r.post('/copias', auth.requireAdmin, async (req, res) => {
  try { const f = await backup.run(); back(res, '/admin/copias', `Copia creada: ${f}`); } catch (e) { back(res, '/admin/copias', e.message, true); }
});
r.get('/copias/:name', auth.requireAdmin, (req, res) => {
  const p = backup.filePath(req.params.name);
  if (!p) return res.status(404).send('No existe');
  res.download(p);
});

r.post('/ajustes/probar', auth.requireAdmin, async (req, res) => {
  if (!notify.enabled()) return back(res, '/admin/ajustes', 'No hay Discord ni Telegram configurado', true);
  const errors = await notify.send(`✅ Prueba de avisos de ${settings().store_name}`);
  errors.length ? back(res, '/admin/ajustes', errors.join(' | '), true) : back(res, '/admin/ajustes', 'Mensaje enviado');
});

r.get('/usuarios', auth.requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, role, created_at FROM users ORDER BY username').all();
  send(res, adminPage(req, 'Jugadores', html`${peopleTabs(req, 'staff')}
    <p class="muted">Quién puede entrar a este panel. No son jugadores: los jugadores tienen su ficha y, si quieren, su cuenta web.</p>
    <div class="tablewrap"><table class="tbl"><thead><tr><th>Usuario</th><th>Rol</th><th>Creado</th><th></th></tr></thead><tbody>
    ${users.map(u => html`<tr><td>${u.username}</td><td>${u.role === 'admin' ? 'Administrador' : 'Staff'}</td><td>${u.created_at}</td><td class="nowrap">
      <form method="post" action="/admin/usuarios/${u.id}/clave" class="inline"><input name="password" type="password" placeholder="Nueva contraseña" minlength="8" required><button class="btn small ghost">Cambiar</button></form>
      ${u.id !== req.user.id ? html`<form method="post" action="/admin/usuarios/${u.id}/borrar" class="inline" onsubmit="return confirm('¿Borrar usuario?')"><button class="link danger">Borrar</button></form>` : ''}</td></tr>`)}
    </tbody></table></div>
    <section class="panel"><h2>Nuevo usuario</h2><form method="post" action="/admin/usuarios" class="grid2">
      <label>Usuario<input name="username" required></label><label>Contraseña<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
      <label>Rol<select name="role"><option value="staff">Staff (torneos, sin ajustes ni usuarios)</option><option value="admin">Administrador</option></select></label>
      <div class="full"><button class="btn">Crear</button></div></form></section>`));
});
r.post('/usuarios', auth.requireAdmin, (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 8) return back(res, '/admin/usuarios', 'Mínimo 8 caracteres', true);
  try { auth.createUser(req.body.username, pw, req.body.role); back(res, '/admin/usuarios', 'Usuario creado'); }
  catch { back(res, '/admin/usuarios', 'Ese usuario ya existe', true); }
});
r.post('/usuarios/:id/clave', auth.requireAdmin, (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 8) return back(res, '/admin/usuarios', 'Mínimo 8 caracteres', true);
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(auth.hashPassword(pw), Number(req.params.id));
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(req.params.id));
  back(res, '/admin/usuarios', 'Contraseña cambiada');
});
r.post('/usuarios/:id/borrar', auth.requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.user.id) return back(res, '/admin/usuarios', 'No puedes borrarte a ti mismo', true);
  db.prepare('DELETE FROM users WHERE id = ?').run(Number(req.params.id));
  back(res, '/admin/usuarios', 'Usuario borrado');
});

module.exports = r;
