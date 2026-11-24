'use strict';
const express = require('express');
const { db } = require('../db');
const C = require('../commander');
const melee = require('../melee');
const notify = require('../notify');
const deckvalue = require('../deckvalue');
const people = require('../people');
const I = require('../identity');
const { setting, log, feature } = require('../db');
const { html, raw, json, fmtDate, money, toCents, adminPage, absUrl, head } = require('../views/html');

const r = express.Router();
const send = (res, page) => res.send(String(page));
const back = (res, url, msg, err = false) => { const [u, h] = String(url).split('#'); res.redirect(u + (u.includes('?') ? '&' : '?') + (err ? 'err=' : 'ok=') + encodeURIComponent(msg) + (h ? '#' + h : '')); };

function loadEv(req, res) {
  const ev = C.getEvent(Number(req.params.id));
  if (!ev) { res.status(404).send('Evento no encontrado'); return null; }
  return ev;
}
const base = ev => `/admin/commander/${ev.id}`;
// Fechas de SQLite (UTC) a hora local
const localAt = at => (at ? new Date(String(at).replace(' ', 'T') + 'Z').toLocaleString('es-ES', { timeZone: require('../config').tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

// ---------- Avisos ----------
// Aviso privado por Telegram a cada jugador apuntado: su mesa, su turno y sus rivales
async function personalRound(req, ev) {
  const tg = require('../tgbot');
  if (!tg.enabled()) return;
  const last = C.currentRound(ev.id);
  if (!last) return;
  const tag = `${last.kind}:${last.number}:${last.id}`;
  if (ev.tg_round === tag) return;
  db.prepare('UPDATE cmd_events SET tg_round = ? WHERE id = ?').run(tag, ev.id);
  const idx = people.nameIndex();
  const url = absUrl(req, '/commander/' + ev.id);
  const title = last.kind === 'final' ? 'Mesa final' : `Ronda ${last.number}`;
  const msgs = new Map();
  for (const pod of C.podsOfRound(last.id)) {
    for (const x of pod.players) {
      const raw = db.prepare('SELECT * FROM cmd_players WHERE id = ?').get(x.id);
      const turn = x.seat === 1 ? 'empiezas tú' : `juegas ${x.seat}º`;
      const others = pod.players.filter(o => o.id !== x.id).map(o => `${o.seat}º ${C.pubName(o)}`).join(', ');
      msgs.set(people.cmdKey(raw, idx), `🃏 ${ev.name} — ${title}
Mesa ${pod.table_number} · ${turn}
Con: ${others}
${url}`);
    }
  }
  await tg.notifyPeople(msgs);
}

const { notifyPromoted } = require('../waitnotify');
async function notifyRound(req, ev) {
  try { await personalRound(req, ev); } catch (e) { log('warn', 'Avisos personales: ' + e.message); }
  if (!notify.enabled() || setting('notify_rounds') !== '1' || !ev.public) return;
  const last = C.currentRound(ev.id);
  if (!last) return;
  const pods = C.podsOfRound(last.id);
  const title = last.kind === 'final' ? 'Mesa final' : `Ronda ${last.number}`;
  const lines = pods.map(p => `Mesa ${p.table_number} (${p.size}) · ${p.players.map(x => `${x.seat}º ${C.pubName(x)}`).join(' · ')}`);
  await notify.send(`🃏 **${ev.name} — ${title}**\n${lines.join('\n')}\n\nBusca tu mesa: ${absUrl(req, '/commander/' + ev.id)}`);
  db.prepare('UPDATE cmd_events SET notified_round = ? WHERE id = ?').run(last.number, ev.id);
}
async function notifyFinal(req, ev) {
  if (!notify.enabled() || setting('notify_final') !== '1' || !ev.public) return;
  const st = C.standings(ev.id).slice(0, 8);
  const medals = ['🥇', '🥈', '🥉'];
  await notify.send(`🏆 **Resultados — ${ev.name}**\n${st.map((p, i) => `${medals[i] || `${p.rank}.`} ${C.pubName(p)} (${p.points} pts)`).join('\n')}\n\n${absUrl(req, '/commander/' + ev.id)}`);
}

// ---------- Formulario de evento ----------
function eventForm(ev, action) {
  const sel = (v, opts) => opts.map(([k, l]) => html`<option value="${k}" ${String(k) === String(v) ? 'selected' : ''}>${l}</option>`);
  const dt = ev.start_date ? new Date(ev.start_date) : null;
  const local = dt ? new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
  return html`<form method="post" action="${action}" class="grid2">
    <label>Nombre<input name="name" value="${ev.name || ''}" required placeholder="Commander de los viernes"></label>
    <label>Fecha y hora<input type="datetime-local" name="start_date" value="${local}"></label>
    <label>Torneo de Melee para inscripciones (ID, opcional)<input name="melee_tournament_id" value="${ev.melee_tournament_id || ''}" inputmode="numeric" placeholder="p. ej. 496459"></label>
    <label>Precio (€)<input name="price" value="${ev.price_cents != null ? (ev.price_cents / 100).toFixed(2) : ''}" inputmode="decimal"></label>
    <label>Presupuesto máximo del mazo (€, opcional)<input name="budget" value="${ev.budget_cents != null ? (ev.budget_cents / 100).toFixed(0) : ''}" inputmode="decimal" placeholder="p. ej. 150"></label>
    <div class="full budgetrules"><b>Reglas del presupuesto</b> <small class="muted">(precio de la versión más barata de cada carta en Cardmarket)</small>
      <span class="small muted">Las tierras básicas no cuentan nunca (en cualquier idioma).</span>
      <label class="check-inline"><input type="checkbox" name="budget_ex_commander" value="1" ${ev.budget_ex_commander ? 'checked' : ''}> No cuenta el comandante</label>
      <label class="check-inline"><input type="checkbox" name="budget_lock" value="1" ${ev.budget_lock ?? 1 ? 'checked' : ''}> El mazo queda cerrado al empezar el torneo</label></div>
    <label>Bracket máximo<select name="bracket_max">${sel(ev.bracket_max || '', [['', 'Sin límite'], ['2', '1-2 · Exhibition / Core'], ['3', '3 · Upgraded'], ['4', '4 · Optimized']])}</select>
      <small class="muted">Se estima al validar cada mazo (Game Changers, destrucción masiva de tierras, turnos extra y combos de dos cartas).</small></label>
    <label class="check-inline"><input type="checkbox" name="legal_check" value="1" ${ev.legal_check ? 'checked' : ''}> Exigir mazo legal: 100 cartas, una copia de cada, sin prohibidas y dentro de los colores del comandante</label>
    <label>Rondas previstas (se pueden jugar menos; nunca más de las que da el suizo)<input type="number" name="rounds_planned" min="1" max="6" value="${ev.rounds_planned || 4}"></label>
    <label>Minutos por ronda<input type="number" name="round_minutes" min="10" max="240" value="${ev.round_minutes || 75}"></label>
    <fieldset class="full scoring" data-scoring>
      <legend>Puntos</legend>
      <label>Patrón<select name="scoring_preset" data-preset>
        <option value="">— Elige un patrón para rellenar —</option>
        <option value="places|3,2,1,0">Por puestos 3-2-1-0</option>
        <option value="places|4,3,2,1">Por puestos 4-3-2-1</option>
        <option value="places|5,3,1,0">Por puestos 5-3-1-0</option>
        <option value="size|4|3|0">Solo el ganador: 4 en mesa de 4, 3 en mesa de 3</option>
        <option value="size|3|3|0">Solo el ganador: 3 puntos siempre</option></select></label>
      <label>Cómo se puntúa<select name="scoring" data-mode>${sel(ev.scoring || (ev.id ? 'size' : 'places'), [['places', 'Por puestos (1º, 2º, 3º, 4º)'], ['size', 'Solo cuenta el ganador']])}</select></label>
      <div class="sc-size">
        <label>Ganar en mesa de 4<input type="number" name="pts_win4" min="0" max="20" value="${ev.pts_win4 ?? 4}"></label>
        <label>Ganar en mesa de 3<input type="number" name="pts_win3" min="0" max="20" value="${ev.pts_win3 ?? 3}"></label>
        <label>Perder<input type="number" name="pts_loss" min="0" max="20" value="${ev.pts_loss ?? 0}"></label></div>
      <div class="sc-places"><label>Puntos por puesto (1º, 2º, 3º, 4º)<input name="pts_places" value="${ev.pts_places || '3,2,1,0'}" placeholder="3,2,1,0" pattern="[0-9 ,;]+"></label>
        <small class="muted">En una mesa de 3 se usan los tres primeros valores.</small></div>
      <small class="muted full">No hay empates en las mesas: si una partida no acaba, el puesto se decide por desempate (o con un dado).</small>
      <small class="muted full">Cambiar los puntos con rondas ya jugadas recalcula la clasificación (no rehace emparejamientos).</small>
    </fieldset>
    <label>Mesas de 3<select name="three_pods">${sel(ev.three_pods || 'bottom', [['bottom', 'Al final de la clasificación'], ['top', 'Arriba de la clasificación']])}</select></label>
    <label class="check-inline"><input type="checkbox" name="final_top4" value="1" ${ev.final_top4 ? 'checked' : ''}> Opcional: mesa final con el Top 4 al acabar el suizo</label>
    <fieldset class="full signupset"><legend>Inscripciones</legend>
      <label class="check-inline"><input type="checkbox" name="self_signup" value="1" ${ev.self_signup ? 'checked' : ''}> Los jugadores se pueden apuntar desde la web con su cuenta</label>
      <label>Plazas (opcional)<input type="number" name="max_players" min="3" max="500" value="${ev.max_players || ''}" placeholder="Sin límite"></label>
      <small class="muted full">Si se llenan las plazas, los siguientes quedan en lista de espera y suben solos cuando alguien se borra. Con precio, quedan «sin pagar» hasta que lo marques en la tienda.</small>
    </fieldset>
    <label class="check-inline"><input type="checkbox" name="public" value="1" ${ev.public ?? 1 ? 'checked' : ''}> Visible en la web pública y la TV</label>
    <label class="check-inline"><input type="checkbox" name="self_report" value="1" ${ev.self_report ?? 1 ? 'checked' : ''}> Los jugadores pueden reportar el resultado desde el móvil (la tienda lo confirma)</label>
    <fieldset class="full"><legend>Contador de vidas</legend>
      <p class="small muted">Los jugadores abren el contador desde su mesa en el móvil: llevan vidas, daño de comandante y veneno, y al eliminar a alguien anotan quién lo ha hecho. Al quedar uno, envía el resultado con los puestos.</p>
      <label>Vidas iniciales<select name="life_start">${[40, 30, 25, 20].map(n => html`<option value="${n}" ${(ev.life_start || 40) === n ? 'selected' : ''}>${n}</option>`)}</select></label>
      <label class="check-inline"><input type="checkbox" name="life_auto" value="1" ${ev.life_auto ? 'checked' : ''}> Los resultados del contador se anotan solos, sin confirmarlos la tienda</label>
    </fieldset>
    <label class="full">Información para la página pública (premios, reglas, horario…)<textarea name="info" rows="4">${ev.info || ''}</textarea></label>
    <div class="full"><button class="btn">Guardar</button></div></form>
    <script>(function(){var f=document.currentScript.previousElementSibling.querySelector('[data-scoring]');if(!f)return;
      var mode=f.querySelector('[data-mode]');function show(){f.dataset.mode=mode.value}mode.onchange=show;show();
      f.querySelector('[data-preset]').onchange=function(){var v=this.value.split('|');if(!v[0])return;mode.value=v[0];
        if(v[0]==='size'){f.querySelector('[name=pts_win4]').value=v[1];f.querySelector('[name=pts_win3]').value=v[2];f.querySelector('[name=pts_loss]').value=v[3]}
        else{f.querySelector('[name=pts_places]').value=v[1]}show()}})();</script>`;
}
function eventParams(b) {
  const d = b.start_date ? new Date(b.start_date) : null;
  return [String(b.name || 'Commander').slice(0, 120), d && !isNaN(d) ? d.toISOString() : null, Number(b.melee_tournament_id) || null,
    Math.min(Math.max(Number(b.rounds_planned) || 4, 1), 15), Math.min(Math.max(Number(b.round_minutes) || 75, 10), 240),
    ptsN(b.draw_points, 1), b.three_pods === 'top' ? 'top' : 'bottom', 'points',
    b.final_top4 ? 1 : 0, toCents(b.price), b.public ? 1 : 0, String(b.info || '').slice(0, 4000) || null, b.self_report ? 1 : 0, toCents(b.budget),
    1, b.budget_ex_commander ? 1 : 0, b.budget_lock ? 1 : 0,
    b.scoring === 'places' ? 'places' : 'size', ptsN(b.pts_win4, 4), ptsN(b.pts_win3, 3), ptsN(b.pts_loss, 0),
    (String(b.pts_places || '').split(/[,;\s]+/).map(Number).filter(n => Number.isFinite(n) && n >= 0).slice(0, 5).join(',')) || '3,2,1,0',
    [2, 3, 4].includes(Number(b.bracket_max)) ? Number(b.bracket_max) : null, b.legal_check ? 1 : 0,
    b.self_signup ? 1 : 0, Number(b.max_players) > 0 ? Math.min(Math.round(Number(b.max_players)), 500) : null];
}
function saveLife(id, b) {
  require('../life');
  db.prepare('UPDATE cmd_events SET life_auto = ?, life_start = ? WHERE id = ?').run(b.life_auto ? 1 : 0, [20, 25, 30, 40].includes(Number(b.life_start)) ? Number(b.life_start) : 40, id);
}
const ptsN = (v, d) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Math.min(Math.max(Math.round(Number(v)), 0), 20));

// Bracket estimado de un mazo, con los motivos
const BR_NAMES = { 2: 'Core (o Exhibition)', 3: 'Upgraded', 4: 'Optimized', 5: 'cEDH' };
function bracketBox(b, max) {
  if (b.unknown || b.n == null) return html`<section class="panel brbox"><div class="brn"><span>Bracket estimado</span><b>?</b></div><div><p>No se pudo calcular${b.error ? ` (${b.error})` : ''}. Guarda la lista otra vez o usa «Recalcular todos los mazos».</p></div></section>`;
  const over = max && b.n > Math.max(max, 2);
  return html`<section class="panel brbox ${over ? 'over' : ''}"><div class="brn"><span>Bracket estimado</span><b>${b.n === 2 ? '1-2' : b.n}</b><small>${BR_NAMES[b.n] || ''}</small></div>
    <div><ul>${b.reasons.length ? b.reasons.map(r => html`<li>${r.why}${r.info ? '' : ` → bracket ${r.to}`}</li>`) : html`<li>Sin Game Changers, sin destrucción masiva de tierras, sin combos de dos cartas y sin cadenas de turnos extra.</li>`}</ul>
      ${b.gc && b.gc.length ? html`<p class="small"><b>Game Changers:</b> ${b.gc.join(', ')}</p>` : ''}
      ${b.tutors && b.tutors.length ? html`<p class="small muted">Tutores: ${b.tutors.join(', ')}</p>` : ''}
      ${over ? html`<p class="warn">Por encima del bracket máximo del torneo (${max === 2 ? '1-2' : max}).</p>` : ''}
      <p class="small muted">Estimación automática (${b.source && b.source.includes('spellbook') ? 'Game Changers de Scryfall y combos de Commander Spellbook' : 'Game Changers de Scryfall'}). El 1 y el 5 dependen de la intención del mazo y no se deducen solos.</p></div></section>`;
}

// ---------- Lista ----------
r.get('/', (req, res) => {
  const events = db.prepare('SELECT * FROM cmd_events ORDER BY COALESCE(start_date, created_at) DESC').all();
  const label = { setup: 'Preparando', running: 'En curso', finished: 'Terminado' };
  const count = st => events.filter(e => e.status === st).length;
  const players = db.prepare('SELECT COUNT(*) c FROM cmd_players WHERE event_id = ?');
  send(res, adminPage(req, 'Commander', html`
    <div class="listbar">
      <div class="stfilter" role="group" aria-label="Mostrar por estado">
        ${[['setup', 'Preparando'], ['running', 'En curso'], ['finished', 'Terminados']].map(([k, l]) => html`<button type="button" class="stpill on" data-st="${k}" aria-pressed="true">${l} <span>${count(k)}</span></button>`)}
      </div>
      <a class="btn" href="/admin/commander/nuevo">+ Nuevo torneo</a>
    </div>
    ${events.length ? html`<div class="evlist">${events.map(e => html`
      <div class="evrow" data-st="${e.status}">
        <a class="evmain" href="/admin/commander/${e.id}"><b>${e.name}</b><small>${fmtDate(e.start_date)} · ${players.get(e.id).c} jugadores</small></a>
        <span class="stchip st-${e.status}">${label[e.status]}</span>
        <div class="evact">
          <a class="btn ghost small" href="/admin/commander/${e.id}/editar">Editar</a>
          <form method="post" action="/admin/commander/${e.id}/borrar" onsubmit="return confirm('¿Borrar «${e.name}» con sus jugadores, rondas y resultados? No se puede deshacer.')"><button class="btn danger-ghost small">Borrar</button></form>
        </div>
      </div>`)}
      <p class="muted evempty" hidden>No hay torneos con los estados elegidos.</p></div>`
    : html`<div class="panel"><p>Aún no hay torneos de Commander.</p><a class="btn" href="/admin/commander/nuevo">Crear el primero</a></div>`}
    <p class="small muted">Torneos multijugador gestionados aquí: mesas de 4 y 3 (nunca de 2), suizo y clasificación solo por puntos.</p>
    <script>(function(){var K='mt_cmd_hide',h;try{h=JSON.parse(localStorage.getItem(K)||'[]')}catch(e){h=[]}
      function apply(){var any=false;document.querySelectorAll('.stpill').forEach(function(b){var off=h.indexOf(b.dataset.st)>=0;b.classList.toggle('on',!off);b.setAttribute('aria-pressed',String(!off))});
        document.querySelectorAll('.evrow').forEach(function(r){var off=h.indexOf(r.dataset.st)>=0;r.hidden=off;if(!off)any=true});
        var em=document.querySelector('.evempty');if(em)em.hidden=any}
      document.querySelectorAll('.stpill').forEach(function(b){b.onclick=function(){var i=h.indexOf(b.dataset.st);if(i>=0)h.splice(i,1);else h.push(b.dataset.st);try{localStorage.setItem(K,JSON.stringify(h))}catch(e){}apply()}});apply()})();</script>`));
});

r.get('/nuevo', (req, res) => {
  send(res, adminPage(req, 'Nuevo torneo de Commander', html`
    <p><a href="/admin/commander">← Volver a la lista</a></p>
    <section class="panel">${eventForm({}, '/admin/commander')}</section>`));
});

r.get('/:id/editar', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  send(res, adminPage(req, `Editar · ${ev.name}`, html`
    <p><a href="/admin/commander">← Volver a la lista</a> · <a href="${base(ev)}">Ir al panel del torneo</a></p>
    <section class="panel">${eventForm(ev, `${base(ev)}/ajustes?volver=lista`)}</section>`));
});

r.post('/', (req, res) => {
  const id = db.prepare(`INSERT INTO cmd_events (name, start_date, melee_tournament_id, rounds_planned, round_minutes, draw_points,
    three_pods, tiebreak, final_top4, price_cents, public, info, self_report, budget_cents, budget_ex_basics, budget_ex_commander, budget_lock,
    scoring, pts_win4, pts_win3, pts_loss, pts_places, bracket_max, legal_check, self_signup, max_players)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...eventParams(req.body)).lastInsertRowid;
  saveLife(id, req.body);
  back(res, `/admin/commander/${id}`, 'Evento creado');
});

// ---------- Panel del evento ----------
function podCard(ev, pod, { editable = true, swappable = false } = {}) {
  const winner = pod.winner_id;
  const byPlaces = ev.scoring === 'places';
  const nameOf = id => (pod.players.find(x => x.id === id) || {}).name || '?';
  const order = pod.proposed_places ? JSON.parse(pod.proposed_places) : null;
  const said = pod.proposed_draw ? 'empate' : order ? order.map((id, i) => `${i + 1}º ${nameOf(id)}`).join(' · ') : `ganó ${nameOf(pod.proposed_winner)}`;
  const proposal = pod.proposed_at && !pod.reported ? html`<div class="proposal">📱 ${nameOf(pod.proposed_by)} dice: <b>${said}</b>
    <form method="post" action="${base(ev)}/mesa/${pod.id}/propuesta" class="inline"><button name="accion" value="confirmar" class="btn small">Confirmar</button>
    <button name="accion" value="rechazar" class="btn small ghost">Rechazar</button></form></div>` : '';
  const kl = require('../life').killsOf(pod.id);
  const lifeOn = db.prepare('SELECT 1 FROM cmd_life WHERE pod_id = ?').get(pod.id);
  const kills = kl.length || lifeOn ? html`<div class="podkills small">${lifeOn ? html`<a class="pill" href="${base(ev)}/mesa/${pod.id}/historial">Contador de vidas · historial</a> ` : ''}${kl.map(k => html`<span>${k.killer_id ? html`<b>${nameOf(k.killer_id)}</b> eliminó a ${nameOf(k.victim_id)}` : html`${nameOf(k.victim_id)} quedó fuera`}</span>`)}</div>` : '';
  const pts = p => (pod.reported ? C.pointsFor(ev, pod, p.place || (winner === p.id ? 1 : null)) : null);
  const head = byPlaces ? `${pod.size} jugadores · ${C.placesList(ev).slice(0, pod.size).join('-')} pts`
    : `${pod.size} jugadores · ganador ${pod.size >= 4 ? ev.pts_win4 ?? 4 : ev.pts_win3 ?? 3} pts`;
  if (byPlaces) {
    const opts = p => [html`<option value="">—</option>`, ...Array.from({ length: pod.size }, (_, i) => html`<option value="${i + 1}" ${p.place === i + 1 && pod.reported && !pod.is_draw ? 'selected' : ''}>${i + 1}º</option>`)];
    return html`<div class="pod ${pod.reported ? 'reported' : ''} ${proposal ? 'proposed' : ''}" id="pod-${pod.id}">${proposal}${kills}
      <div class="pod-head"><b>Mesa ${pod.table_number}</b><span class="muted">${head}</span>
        ${pod.reported ? html`<span class="ok">${pod.is_draw ? 'Empate' : '✔'}</span>` : html`<span class="warn">pendiente</span>`}</div>
      <form method="post" action="${base(ev)}/mesa/${pod.id}" class="pod-form places" data-places>
        ${pod.players.map(p => html`<div class="seat seatp ${pod.reported && !pod.is_draw && p.place === 1 ? 'win' : ''}" data-seat>
          <span class="seatn">${p.seat}º</span><span>${p.name}${pod.reported && !pod.is_draw && p.place === 1 ? ' 🏆' : ''}${p.deck ? html`<small class="deck">${p.deck}</small>` : ''}</span>
          ${pod.reported ? html`<em class="ptsgot">+${pts(p)}</em>` : ''}
          <select name="place_${p.id}" ${editable ? '' : 'disabled'} aria-label="Puesto de ${p.name}">${opts(p)}</select></div>`)}
        ${editable ? html`<div class="pod-actions"><button name="result" value="places" class="btn small">Guardar puestos</button>
          ${pod.reported ? html`<button name="result" value="clear" class="btn small ghost">Quitar resultado</button>` : ''}</div>
          <small class="muted">Toca los nombres por orden de llegada (1º, 2º…) o elige el puesto. Sin empates: se decide siempre (dado si hace falta).</small>` : ''}
      </form></div>`;
  }
  return html`<div class="pod ${pod.reported ? 'reported' : ''} ${proposal ? 'proposed' : ''}" id="pod-${pod.id}">${proposal}${kills}
    <div class="pod-head"><b>Mesa ${pod.table_number}</b><span class="muted">${head}</span>
      ${pod.reported ? html`<span class="ok">${pod.is_draw ? 'Empate' : '✔'}</span>` : html`<span class="warn">pendiente</span>`}</div>
    <form method="post" action="${base(ev)}/mesa/${pod.id}" class="pod-form">
      ${pod.players.map(p => html`<button name="result" value="${p.id}" class="seat ${winner === p.id ? 'win' : ''}" ${editable ? '' : 'disabled'}
        title="Marcar como ganador"><span class="seatn">${p.seat}º</span><span>${p.name}${winner === p.id ? ' 🏆' : ''}${p.deck ? html`<small class="deck">${p.deck}</small>` : ''}</span>
        ${pod.reported ? html`<em class="ptsgot">+${pts(p)}</em>` : ''}</button>`)}
      ${editable ? html`<div class="pod-actions">
        ${pod.reported ? html`<button name="result" value="clear" class="btn small ghost">Quitar resultado</button>` : ''}</div>` : ''}
    </form>${swappable ? '' : ''}</div>`;
}

function prizesPanel(ev, st) {
  const prizes = db.prepare('SELECT * FROM prizes WHERE cmd_event_id = ? ORDER BY id').all(ev.id);
  const total = prizes.reduce((s, p) => s + (p.amount_cents || 0), 0);
  const nameOf = id => (st.find(p => p.id === id) || {}).name || '—';
  return html`<section class="panel"><h2>Premios entregados</h2>
    ${prizes.length ? html`<table class="tbl"><tbody>${prizes.map(p => html`<tr><td>${p.cmd_player_id ? nameOf(p.cmd_player_id) : '—'}</td><td>${p.label}</td><td>${p.kind}</td>
      <td class="num">${money(p.amount_cents)}</td><td><form method="post" action="${base(ev)}/premio/${p.id}/borrar"><button class="x">×</button></form></td></tr>`)}
      <tr><td colspan="3"><b>Total</b></td><td class="num"><b>${money(total)}</b></td><td></td></tr></tbody></table>` : html`<p class="muted">Sin premios apuntados.</p>`}
    <form method="post" action="${base(ev)}/premio" class="inline" style="margin-top:10px">
      <select name="player"><option value="">Jugador (opcional)</option>${st.map(p => html`<option value="${p.id}">${p.rank}. ${p.name}</option>`)}</select>
      <input name="label" placeholder="Concepto" required><select name="kind"><option>crédito</option><option>producto</option><option>efectivo</option><option>otro</option></select>
      <input name="amount" placeholder="Valor €" inputmode="decimal" style="width:7em"><button class="btn small">Apuntar</button></form></section>`;
}

r.get('/:id', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const ps = C.players(ev.id);
  const idx = people.nameIndex();
  const pk = new Map(ps.map(p => [p.id, people.cmdKey(p, idx)]));
  const evKeys = new Set(pk.values());
  const acts = C.recentActivity(ev.id);
  const uname = u => (db.prepare('SELECT username FROM players WHERE lower(username) = ? LIMIT 1').get(u) || { username: u }).username;
  const evDups = ps.length ? people.duplicates().filter(d => evKeys.has(d.a.key) || evKeys.has(d.b.key)) : [];
  const active = ps.filter(p => p.dropped_round == null);
  const rounds = C.rounds(ev.id);
  const last = rounds[rounds.length - 1] || null;
  const pods = last ? C.podsOfRound(last.id) : [];
  const complete = last ? C.roundComplete(last.id) : true;
  const st = C.standings(ev.id);
  const seated = new Set(db.prepare(`SELECT DISTINCT s.player_id id FROM cmd_seats s JOIN cmd_pods pd ON pd.id = s.pod_id
    JOIN cmd_rounds r ON r.id = pd.round_id WHERE r.event_id = ?`).all(ev.id).map(x => x.id));
  const sizes = C.podSizes(active.length);
  const swissDone = rounds.filter(x => x.kind === 'swiss').length;
  const finalExists = rounds.some(x => x.kind === 'final');
  const limit = C.roundLimit(ev.id);
  const maxR = C.maxSwissRounds(ev.id);
  const budget = C.budgetCheck(ev.id);
  const pay = C.paymentStats(ev.id);
  const waiting = C.waitlisted(ev.id);
  const canPair = ev.status !== 'finished' && complete && !finalExists && active.length >= 3;
  const canNext = canPair && swissDone < limit;
  const swissOver = swissDone >= limit;
  const nextLabel = `Emparejar ronda ${swissDone + 1} de ${limit}`;
  const statusLabel = { setup: 'Preparando', running: 'En juego', finished: 'Terminado' }[ev.status];
  const pub = absUrl(req, '/commander/' + ev.id);

  const savedPod = req.query.guardada ? db.prepare(`SELECT pd.id, pd.table_number AS table_no FROM cmd_pods pd JOIN cmd_rounds r ON r.id = pd.round_id WHERE pd.id = ? AND r.event_id = ? AND pd.reported = 1`).get(Number(req.query.guardada), ev.id) : null;
  send(res, adminPage(req, ev.name, html`
    ${savedPod ? html`<form method="post" action="${base(ev)}/mesa/${savedPod.id}" class="undo-toast" role="status"><span>Resultado guardado · mesa ${savedPod.table_no}</span><button name="result" value="clear">Deshacer</button><a href="${base(ev)}" aria-label="Cerrar">×</a></form>` : ''}
    <p><span class="badge" style="--g:#7b5ea7">Commander</span> <span class="status ${ev.status === 'running' ? 'live' : ''}">${statusLabel}</span>
      · ${fmtDate(ev.start_date)} ${ev.price_cents != null ? html`· ${money(ev.price_cents)}` : ''}</p>
    <div class="stats">
      <div><b>${active.length}</b><span>activos (${ps.length} inscritos)</span></div>
      <div><b>${swissDone}/${limit}</b><span>rondas · máximo por suizo ${maxR}</span></div>
      <div><b>${sizes ? sizes.join('+') : '—'}</b><span>mesas próxima ronda</span></div>
      ${pay ? html`<div><b>${money(pay.collected)}</b><span>cobrado (${pay.paid.length} ${pay.paid.length === 1 ? 'pagado' : 'pagados'})</span></div>
        <div class="${pay.unpaid.length ? 'warnstat' : ''}"><b>${money(pay.pending)}</b><span>pendiente (${pay.unpaid.length} sin pagar)</span></div>` : ''}
      ${ev.max_players ? html`<div><b>${active.length}/${ev.max_players}</b><span>plazas${waiting.length ? ` · ${waiting.length} en espera` : ''}</span></div>` : ''}
    </div>
    ${pay && ev.status !== 'finished' && (swissDone === 0 || pay.unpaid.length) ? html`<section class="panel paypanel ${pay.unpaid.length ? 'warnp' : 'okp'}" id="pagos"><h2>Pagos · ${money(pay.price)} por jugador</h2>
      ${pay.unpaid.length ? html`<p>${pay.unpaid.length === 1 ? 'Falta 1 jugador por pagar' : `Faltan ${pay.unpaid.length} jugadores por pagar`}${swissDone === 0 ? ': antes de emparejar la ronda 1 te avisará.' : '.'}</p>
        <div class="paylist">${pay.unpaid.map(p => html`<div class="payrow"><span>${p.name}${p.signed_via === 'web' ? html` <small class="pill" title="Se apuntó desde la web con su cuenta">web</small>` : ''}</span>
          <form method="post" action="${base(ev)}/jugadores/${p.id}/pago" class="paybtns"><input type="hidden" name="paid" value="1">
            <button class="btn small" name="method" value="efectivo">Efectivo</button><button class="btn small ghost" name="method" value="tarjeta">Tarjeta</button><button class="btn small ghost" name="method" value="bizum">Bizum</button></form></div>`)}</div>`
      : html`<p class="ok">Todos los jugadores han pagado.</p>`}
      ${Object.keys(pay.byMethod).length ? html`<p class="small muted">Cobrado: ${Object.entries(pay.byMethod).map(([k, v]) => `${v} ${k}`).join(' · ')}</p>` : ''}
    </section>` : ''}
    ${budget ? html`<section class="panel budgetpanel ${budget.missing.length || budget.over.length ? 'warnp' : 'okp'}"><h2>Mazos: ${[budget.budget ? `presupuesto ${money(budget.budget)}` : '', budget.bracketMax ? `bracket máximo ${budget.bracketMax === 2 ? '1-2' : budget.bracketMax}` : '', budget.legalCheck ? 'mazo legal' : ''].filter(Boolean).join(' · ')}</h2>
      <div class="stats"><div><b>${budget.ok}</b><span>mazos válidos</span></div>${budget.budget ? html`<div><b>${budget.overBudget.length}</b><span>por encima del presupuesto</span></div>` : ''}
        ${budget.bracketMax ? html`<div><b>${budget.overBracket.length}</b><span>por encima del bracket</span></div>` : ''}
        ${budget.legalCheck ? html`<div><b>${budget.illegal.length}</b><span>no legales</span></div>` : ''}
        <div><b>${budget.missing.length}</b><span>sin validar</span></div>${budget.wrongSize.length ? html`<div><b>${budget.wrongSize.length}</b><span>sin 100 cartas</span></div>` : ''}</div>
      ${budget.overBudget.length ? html`<p><b class="warn">Por encima del presupuesto:</b> ${budget.overBudget.map((p, i) => html`${i ? ', ' : ''}<a href="${base(ev)}/jugadores/${p.id}/mazo-detalle">${p.name}</a> (${money(p.deck_value_cents)})`)}</p>` : ''}
      ${budget.illegal.length ? html`<p><b class="warn">No legales:</b> ${budget.illegal.map((p, i) => html`${i ? ', ' : ''}<a href="${base(ev)}/jugadores/${p.id}/mazo-detalle">${p.name}</a>`)}</p>` : ''}
      ${budget.overBracket.length ? html`<p><b class="warn">Por encima del bracket:</b> ${budget.overBracket.map((p, i) => html`${i ? ', ' : ''}<a href="${base(ev)}/jugadores/${p.id}/mazo-detalle">${p.name}</a> (bracket ${p.deck_bracket})`)}</p>` : ''}
      ${budget.missing.length ? html`<p><b>Sin validar:</b> ${budget.missing.map((p, i) => html`${i ? ', ' : ''}<a href="${base(ev)}/jugadores/${p.id}/mazo-detalle">${p.name}</a>`)}</p>` : ''}
      ${budget.wrongSize.length ? html`<p class="small muted">Sin 100 cartas: ${budget.wrongSize.map(p => p.name).join(', ')}</p>` : ''}
      ${ev.status !== 'finished' ? html`<form method="post" action="${base(ev)}/recalcular-mazos" class="inline" onsubmit="return confirm('¿Recalcular todos los mazos guardados con los precios de hoy?')">
        <button class="btn ghost small">Recalcular todos los mazos con precios de hoy</button></form>` : ''}
      <p class="small muted">Los jugadores validan su mazo en <a href="/valor-mazo?evento=${ev.id}" target="_blank">/valor-mazo?evento=${ev.id}</a>. También puedes pegar la lista tú desde «ver mazo».
        No cuentan las tierras básicas. ${ev.budget_ex_commander ? 'No cuenta el comandante. ' : ''}${ev.budget_lock ? 'Se cierra al empezar.' : ''}</p></section>` : ''}
    ${ev.rounds_planned > maxR && ev.status !== 'finished' ? html`<div class="flash">Previstas ${ev.rounds_planned} rondas, pero con estos jugadores el suizo da como máximo ${maxR}: se jugarán ${maxR}.</div>` : ''}
    ${canPair && swissOver ? html`<div class="flash">Suizo completado (${limit} rondas). ${ev.final_top4 ? 'Crea la mesa final o termina el torneo.' : 'Ya puedes terminar el torneo.'}</div>` : ''}
    ${sizes && sizes[0] === 5 ? html`<div class="flash err">Con 5 jugadores no se pueden hacer mesas de 3 y 4: se hará una mesa de 5.</div>` : ''}
    <div class="actions">
      ${canNext ? html`<form method="post" action="${base(ev)}/emparejar" class="inline"><button class="btn">${nextLabel}</button>
        ${budget && swissDone === 0 && (budget.missing.length || budget.over.length) ? html`<label class="check-inline small"><input type="checkbox" name="force" value="1"> Emparejar aunque haya mazos sin validar o por encima</label>` : ''}
        ${pay && swissDone === 0 && pay.unpaid.length ? html`<label class="check-inline small warn"><input type="checkbox" name="force_pay" value="1"> Empezar aunque haya ${pay.unpaid.length} sin pagar</label>` : ''}</form>` : ''}
      ${ev.final_top4 && canPair && swissOver && active.length >= 4 ? html`<form method="post" action="${base(ev)}/final"><button class="btn">Crear mesa final (Top 4)</button></form>` : ''}
      ${ev.status !== 'finished' && rounds.length && complete ? html`<form method="post" action="${base(ev)}/terminar" onsubmit="return confirm('¿Dar el torneo por terminado?')"><button class="btn ghost">Terminar torneo</button></form>` : ''}
      ${ev.status === 'finished' ? html`<form method="post" action="${base(ev)}/reabrir"><button class="btn ghost">Reabrir</button></form>` : ''}
      ${last && !pods.some(p => p.reported) ? html`<form method="post" action="${base(ev)}/deshacer" class="push-end" onsubmit="return confirm('¿Deshacer la ronda ${last.number}? Se borran sus emparejamientos.')"><button class="btn danger-ghost">Deshacer ronda ${last.number}</button></form>` : ''}
    </div>
    <nav class="actions-links" aria-label="Enlaces del evento">
      <a href="/commander/${ev.id}" target="_blank">Página pública</a>
      <a href="/tv/c${ev.id}" target="_blank">TV</a>
      <a href="${base(ev)}/imprimir" target="_blank">Imprimir mesas</a>
      ${ev.status === 'setup' ? html`<a href="${base(ev)}/checkin-qr" target="_blank">QR de check-in</a>` : ''}
      <a href="/qr.svg?d=${encodeURIComponent(pub)}" target="_blank">QR</a>
    </nav>

    ${!last && ev.status === 'setup' ? (() => { const ck = C.checkinStats(ev.id); return html`<section class="panel checkinpanel">
      <h2>Check-in: ${ck.in} de ${ck.total} han llegado</h2>
      <div class="ck-bar"><i style="width:${ck.total ? Math.round(ck.in * 100 / ck.total) : 0}%"></i></div>
      ${ck.used && ck.missing.length ? html`<p>Faltan: ${ck.missing.map(p => p.name).join(', ')}</p>
        <form method="post" action="${base(ev)}/checkin/drop" class="inline" onsubmit="return confirm('¿Dar drop a los ${ck.missing.length} que no han hecho check-in?')"><button class="btn small">Drop a los ${ck.missing.length} que no han llegado</button></form>` : ''}
      <p class="small muted">Cada jugador escanea el <a href="${base(ev)}/checkin-qr" target="_blank">QR de check-in</a> al llegar (o márcalo tú en ⋯). Antes de emparejar la ronda 1 puedes dar drop a quien no haya llegado.</p>
    </section>`; })() : ''}
    ${last ? html`<section class="panel ${complete ? '' : 'live'}">
      <div class="round-head"><h2>${last.kind === 'final' ? 'Mesa final' : `Ronda ${last.number}`} · ${pods.filter(p => !p.reported).length ? `${pods.filter(p => !p.reported).length} mesas pendientes` : 'todas con resultado ✔'}</h2>
        <div class="inline"><span id="ctimer" data-end="${last.timer_end || ''}" class="timer"></span>
        <form method="post" action="${base(ev)}/timer" class="inline"><input name="minutes" type="number" value="${ev.round_minutes}" style="width:5em"> min
          <button class="btn small">${last.timer_end ? 'Reiniciar reloj' : 'Iniciar reloj'}</button></form>
        ${last.timer_end ? html`<form method="post" action="${base(ev)}/timer"><input type="hidden" name="stop" value="1"><button class="btn small ghost">Parar</button></form>` : ''}</div></div>
      <p class="small muted">Pulsa el nombre del ganador de cada mesa. El número indica el orden de turno: empieza quien va 1º.</p>
      ${pods.filter(p => p.proposed_at && !p.reported).length ? html`<form method="post" action="${base(ev)}/confirmar-todas" class="inline"><button class="btn">Confirmar los ${pods.filter(p => p.proposed_at && !p.reported).length} resultados enviados desde el móvil</button></form>` : ''}
      <div class="pods">${pods.map(p => podCard(ev, p))}</div>
      ${pods.some(p => !p.reported) && pods.length > 1 ? html`<form method="post" action="${base(ev)}/cambiar" class="inline swapform">
        <span class="small muted">Cambiar de mesa:</span>
        <select name="a">${pods.filter(p => !p.reported).flatMap(p => p.players.map(x => html`<option value="${x.id}">M${p.table_number} · ${x.name}</option>`))}</select>
        <span>⇄</span>
        <select name="b">${pods.filter(p => !p.reported).flatMap(p => p.players.map(x => html`<option value="${x.id}">M${p.table_number} · ${x.name}</option>`))}</select>
        <input type="hidden" name="round" value="${last.id}"><button class="btn small ghost">Intercambiar</button></form>` : ''}
    </section>` : html`<section class="panel"><p>Añade jugadores (o impórtalos de Melee) y pulsa <b>Emparejar ronda 1</b>.</p></section>`}

    <div class="cols">
      <section class="panel"><h2>Clasificación</h2>${st.some(p => p.played) ? html`<div class="tablewrap"><table class="tbl cmdst"><thead><tr><th>#</th><th>Jugador</th><th class="num">Pts</th><th class="num">V-D-E</th>
        <th class="num">Mesas</th></tr></thead><tbody>
        ${st.map(p => html`<tr class="${p.dropped != null ? 'dim' : ''}"><td>${p.rank}${p.champion ? ' 🏆' : ''}</td><td>${p.name}${p.dropped != null ? html` <small>(drop)</small>` : ''}</td>
          <td class="num strong">${p.points}</td><td class="num">${p.wins}-${p.losses}-${p.draws}</td><td class="num">${p.played}</td></tr>`)}</tbody></table></div>
        <p class="small muted">Clasificación solo por puntos; los empatados comparten puesto. Para emparejar y para el corte de la mesa final, los empates a puntos se resuelven por sorteo.</p>`
    : html`<p class="muted">Aún no hay resultados.</p>`}</section>

      <section class="panel"><h2>Jugadores (${ps.length})</h2>
        ${ev.melee_tournament_id ? html`<form method="post" action="${base(ev)}/importar"><button class="btn small">Importar inscritos de Melee (#${ev.melee_tournament_id})</button></form>` : ''}
        ${evDups.length ? html`<div class="notice small"><b>${evDups.length} posible${evDups.length > 1 ? 's' : ''} duplicado${evDups.length > 1 ? 's' : ''}</b> con jugadores de este evento: ${evDups.slice(0, 3).map((d, i) => html`${i ? ', ' : ''}${d.a.name} ⇄ ${d.b.name}`)}${evDups.length > 3 ? '…' : ''} <a href="/admin/vincular">Revisar</a></div>` : ''}
        <table class="tbl"><tbody>${ps.map(p => html`<tr class="${p.dropped_round != null ? 'dim' : ''}"><td><a href="/admin/jugadores/${encodeURIComponent(pk.get(p.id))}" class="plain">${p.name}</a> ${p.username ? html`<small class="muted">${p.username}</small>` : ''}
          ${!p.username && pk.get(p.id).startsWith('u:') ? html`<small class="pill" title="Unido a su ficha de Melee">↔ @${uname(pk.get(p.id).slice(2))}</small>` : ''}
          ${p.deck_legal === 0 ? html`<a href="${base(ev)}/jugadores/${p.id}/mazo-detalle" class="pill warn" title="El mazo no es legal en Commander">⚠ no legal</a> ` : ''}
          ${p.deck_bracket != null ? html`<a href="${base(ev)}/jugadores/${p.id}/mazo-detalle" class="pill ${ev.bracket_max && p.deck_bracket > Math.max(ev.bracket_max, 2) ? 'warn' : ''}" title="Bracket estimado">B${p.deck_bracket === 2 ? '1-2' : p.deck_bracket}</a> ` : ''}
          ${p.deck_value_cents != null ? html`<a href="${base(ev)}/jugadores/${p.id}/mazo-detalle" class="pill ${ev.budget_cents && p.deck_value_cents > ev.budget_cents ? 'warn' : 'new'}" title="Valor del mazo para el presupuesto">💶 ${money(p.deck_value_cents)}</a>`
    : html`<a href="${base(ev)}/jugadores/${p.id}/mazo-detalle" class="pill" title="Añadir la lista del mazo (también desde un preconstruido)">${ev.budget_cents ? 'sin validar' : '📋 añadir lista'}</a>`}
          <form method="post" action="${base(ev)}/jugadores/${p.id}/mazo" class="deckform"><input name="deck" value="${p.deck || ''}" placeholder="Comandante"><button class="link">Guardar</button></form></td>
          <td class="nowrap">${pay ? html`<form method="post" action="${base(ev)}/jugadores/${p.id}/pago" class="inline"><input type="hidden" name="paid" value="${p.paid ? 0 : 1}"><button class="paypill ${p.paid ? 'on' : ''}" title="${p.paid ? `Pagado${p.paid_method ? ' · ' + p.paid_method : ''} · ${localAt(p.paid_at)} · pulsa para desmarcar` : 'Sin pagar · pulsa para marcar como pagado'}">${p.paid ? 'Pagado' : 'Sin pagar'}</button></form> ` : ''}${p.account_id ? html`<span class="pill" title="Tiene cuenta en la web">cuenta</span> ` : ''}${p.checked_in_at ? html`<span class="pill new" title="Llegó ${localAt(p.checked_in_at)}">✓ aquí</span> ` : ''}${p.phone_locked ? html`<span class="pill warn" title="No puede hacer cambios desde el móvil">🔒</span> ` : p.claim_hash ? html`<span class="pill" title="Usado desde un móvil (${localAt(p.claim_at)})">📱</span> ` : ''}
          <details class="pmenu"><summary title="Editar, móvil y mazo">⋯</summary><div>
            <form method="post" action="${base(ev)}/jugadores/${p.id}/datos" class="stack"><label>Nombre<input name="name" value="${p.name}" maxlength="80" required></label>
              <label>Nick / usuario<input name="username" value="${p.username || ''}" maxlength="40" placeholder="Opcional"></label>
              ${ev.price_cents != null ? html`<label>Pago<select name="pay"><option value="no" ${!p.paid ? 'selected' : ''}>Sin pagar</option>${['efectivo', 'tarjeta', 'bizum', 'otro'].map(m => html`<option value="${m}" ${p.paid && (p.paid_method || 'otro') === m ? 'selected' : ''}>Pagado · ${m}</option>`)}</select></label>` : ''}
              <button class="btn small">Guardar</button></form>
            ${p.claim_hash ? html`<form method="post" action="${base(ev)}/jugadores/${p.id}/liberar"><button class="link">Liberar móvil</button><small class="muted">Usado desde un móvil (${localAt(p.claim_at)}). El siguiente que lo use se queda con él.</small></form>`
    : html`<small class="muted">Ningún móvil lo ha usado aún.</small>`}
            ${p.deck || p.deck_value_cents != null ? html`<form method="post" action="${base(ev)}/jugadores/${p.id}/limpiar" onsubmit="return confirm('¿Borrar el comandante, el valor del mazo y los resultados que envió sin confirmar?')"><button class="link danger">Borrar comandante y mazo</button></form>` : ''}
            <form method="post" action="${base(ev)}/jugadores/${p.id}/llegada"><button class="link">${p.checked_in_at ? 'Quitar check-in' : 'Marcar que ha llegado'}</button></form>
            <form method="post" action="${base(ev)}/jugadores/${p.id}/bloquear"><button class="link">${p.phone_locked ? 'Desbloquear móvil' : 'Bloquear cambios desde el móvil'}</button></form>
            ${p.claim_hash || p.deck || p.deck_value_cents != null ? html`<form method="post" action="${base(ev)}/jugadores/${p.id}/resetear" onsubmit="return confirm('¿Liberar el móvil y borrar todo lo que ha puesto?')"><button class="btn small ghost">Liberar y borrar todo</button></form>` : ''}
          </div></details>
          <form method="post" action="${base(ev)}/jugadores/${p.id}/drop" class="inline"><button class="link">${p.dropped_round != null ? 'Volver a meter' : 'Drop'}</button></form>
          ${!seated.has(p.id) ? html` · <form method="post" action="${base(ev)}/jugadores/${p.id}/borrar" class="inline"><button class="link danger">Quitar</button></form>` : ''}</td></tr>`)}</tbody></table>
        ${waiting.length ? html`<div class="waitbox"><h3>Lista de espera (${waiting.length})</h3>${waiting.map((w, i) => html`<div class="payrow"><span>${i + 1}. ${w.name} <small class="muted">${localAt(w.signed_at)}</small></span>
          <span><form method="post" action="${base(ev)}/espera/${w.id}/subir" class="inline"><button class="btn small ghost">Pasar a jugador</button></form>
          <form method="post" action="${base(ev)}/espera/${w.id}/quitar" class="inline" onsubmit="return confirm('¿Quitar a ${w.name} de la lista de espera?')"><button class="link danger">Quitar</button></form></span></div>`)}</div>` : ''}
        <form method="post" action="${base(ev)}/jugador" class="addone" style="margin-top:12px">
          <span class="ppick"><input class="person-pick" data-field="person_key" data-free="1" name="name" placeholder="Añadir jugador: nombre, apellido o nick" autocomplete="off" maxlength="80"><input type="hidden" name="person_key"></span>
          <button class="btn small">Añadir</button></form>
        <details class="small"><summary>Añadir varios de golpe</summary>
          <form method="post" action="${base(ev)}/jugadores" class="stack" style="margin-top:8px">
            <label>Uno por línea (mientras escribes te sugiere fichas existentes)<span class="ppick"><textarea name="names" rows="5" class="person-pick-multi" placeholder="Nombre Apellido" autocomplete="off" spellcheck="false"></textarea><input type="hidden" name="picks" value="{}"></span></label>
            <button class="btn small">Añadir</button></form>
          <p class="muted">Elige con ↑ ↓ y Enter, Tab para la primera, o con el ratón. Los nombres idénticos a una ficha existente se unen solos; los parecidos que no elijas aparecen en «Posibles duplicados».</p></details>
        <p class="small muted">Se pueden añadir jugadores con el torneo empezado: entran en la siguiente ronda con 0 puntos.</p>
        <p class="small muted">📱 = ya lo usa un móvil: solo ese móvil puede enviar resultados o cambiar su mazo. Si alguien se hace pasar por otro jugador, en ⋯ puedes liberar el móvil, borrar lo que puso o bloquearlo.</p>
        ${acts.length ? html`<details class="small" style="margin-top:10px"><summary>Actividad desde móviles (${acts.length})</summary><table class="tbl acttbl"><tbody>
          ${acts.map(a => html`<tr><td class="nowrap muted">${localAt(a.at)}</td><td>${a.name || '—'}</td><td>${a.action}</td><td class="muted">${a.detail || ''}</td><td class="muted small" title="${a.ua || ''}">${a.ip || ''}</td></tr>`)}
        </tbody></table></details>` : ''}
      </section>
    </div>

    ${rounds.length > 1 ? html`<section class="panel"><h2>Rondas anteriores</h2>${rounds.slice(0, -1).reverse().map(rd => html`<details><summary>${rd.kind === 'final' ? 'Mesa final' : `Ronda ${rd.number}`}</summary>
      <div class="pods">${C.podsOfRound(rd.id).map(p => podCard(ev, p))}</div>
      <p class="small muted">Cambiar un resultado antiguo recalcula la clasificación, pero no vuelve a emparejar rondas ya hechas.</p></details>`)}</section>` : ''}

    ${feature('prizes') ? prizesPanel(ev, st) : ''}
    <details class="panel fold" ${ev.status === 'running' ? '' : 'open'}><summary><h2>Duplicar evento</h2></summary><form method="post" action="${base(ev)}/duplicar" class="inline">
      <label class="check-inline"><input type="checkbox" name="players" value="1"> Copiar también los jugadores (sin drops)</label>
      <button class="btn ghost small">Crear copia para la semana siguiente</button></form></details>
    <p class="small muted">Valor de mazos: los jugadores lo calculan en <a href="/valor-mazo?evento=${ev.id}" target="_blank">/valor-mazo</a> y lo guardan en su ficha${ev.budget_cents ? ` · presupuesto ${money(ev.budget_cents)}` : ''}.</p>
    <details class="panel fold" ${ev.status === 'running' ? '' : 'open'}><summary><h2>Configuración</h2>${ev.status === 'running' ? html`<span class="small muted">plegada mientras se juega</span>` : ''}</summary>${eventForm(ev, `${base(ev)}/ajustes`)}</details>
    <section class="panel danger-zone"><h2>Borrar evento</h2><p class="small muted">Se borran jugadores, rondas y resultados. No se puede deshacer.</p>
      <form method="post" action="${base(ev)}/borrar" onsubmit="return confirm('¿Borrar el evento y todos sus datos? No se puede deshacer.')"><button class="btn danger-ghost small">Borrar evento</button></form></section>
    <script>(function(){var el=document.getElementById('ctimer');if(!el||!el.dataset.end)return;var end=new Date(el.dataset.end);
      function t(){var ms=end-Date.now(),n=ms<0,a=Math.abs(ms),m=Math.floor(a/60000),s=Math.floor(a/1000)%60;el.textContent=(n?'+':'')+m+':'+String(s).padStart(2,'0');el.classList.toggle('over',n)}t();setInterval(t,1000)})();</script>
  `));
});

r.post('/:id/ajustes', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  db.prepare(`UPDATE cmd_events SET name=?, start_date=?, melee_tournament_id=?, rounds_planned=?, round_minutes=?, draw_points=?,
    three_pods=?, tiebreak=?, final_top4=?, price_cents=?, public=?, info=?, self_report=?, budget_cents=?, budget_ex_basics=?, budget_ex_commander=?, budget_lock=?,
    scoring=?, pts_win4=?, pts_win3=?, pts_loss=?, pts_places=?, bracket_max=?, legal_check=?, self_signup=?, max_players=? WHERE id = ?`).run(...eventParams(req.body), ev.id);
  saveLife(ev.id, req.body);
  const up = C.promoteWaitlist(ev.id);
  if (up.length) notifyPromoted(req, C.getEvent(ev.id), up);
  back(res, req.query.volver === 'lista' ? '/admin/commander' : base(ev), 'Guardado');
});

r.post('/:id/jugadores', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const names = String(req.body.names || '').split('\n').map(s => s.trim().replace(/\s+/g, ' ').slice(0, 80)).filter(Boolean).slice(0, 200);
  // Líneas elegidas del autocompletar: nombre → ficha
  let picks = {};
  try { picks = JSON.parse(req.body.picks || '{}') || {}; } catch { picks = {}; }
  const idx = people.nameIndex();
  const ins = db.prepare('INSERT INTO cmd_players (event_id, name) VALUES (?, ?)');
  const taken = new Set(C.players(ev.id).map(p => people.cmdKey(p, idx)));
  let added = 0;
  const skipped = [];
  for (const n of names) {
    const key = typeof picks[n] === 'string' ? I.resolve(picks[n]) : null;
    if (key && taken.has(key)) { skipped.push(n); continue; }
    const row = db.prepare('SELECT * FROM cmd_players WHERE id = ?').get(ins.run(ev.id, n).lastInsertRowid);
    if (key && people.cmdKey(row, idx) !== key) I.link('n:' + n.toLowerCase(), key, { by: req.user.username, kind: 'manual', reason: 'elegido al apuntar' });
    taken.add(people.cmdKey(row, idx));
    added++;
  }
  back(res, base(ev), `${added} jugador(es) añadido(s)${skipped.length ? ` · ya estaban: ${skipped.join(', ')}` : ''}`);
});

// Alta de un jugador con comprobación de fichas parecidas («¿Es X?»)
r.post('/:id/jugador', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!name) return back(res, base(ev), 'Escribe un nombre', true);
  const idx = people.nameIndex();
  const inEvent = key => C.players(ev.id).find(p => people.cmdKey(p, idx) === key);
  const by = req.user.username;
  const add = (key, { personKey = null, kind = 'manual', reason = 'confirmado al apuntar' } = {}) => {
    if (key && inEvent(I.resolve(key))) return back(res, base(ev), `${inEvent(I.resolve(key)).name} ya está apuntado`, true);
    const id = db.prepare('INSERT INTO cmd_players (event_id, name, person_key) VALUES (?, ?, ?)').run(ev.id, name, personKey).lastInsertRowid;
    const row = db.prepare('SELECT * FROM cmd_players WHERE id = ?').get(id);
    // Si el nombre escrito no lleva ya a esa ficha, se crea el vínculo (visible y reversible en Vincular)
    if (key && !personKey && people.cmdKey(row, idx) !== I.resolve(key)) I.link('n:' + name.toLowerCase(), key, { by, kind, reason });
    return back(res, base(ev), `${name} añadido`);
  };

  // Elegido de la lista o confirmado «Sí, es X»
  if (req.body.person_key) return add(String(req.body.person_key));

  // «No, es otra persona»
  if (req.body.confirm === 'new') {
    const cands = String(req.body.cands || '').split('|').filter(Boolean);
    const own = I.resolve('n:' + name.toLowerCase());
    for (const c of cands) if (I.resolve(c) !== own) I.markNotSame('n:' + name.toLowerCase(), c, by);
    // Mismo nombre exacto que otra persona: se le da una ficha propia
    const clash = cands.some(c => I.resolve(c) === own) || cands.some(c => people.cmdKey({ name }, idx) === I.resolve(c));
    return add(null, { personKey: clash ? 'p:' + Math.random().toString(36).slice(2, 10) : null });
  }

  const sug = people.suggest(name, { limit: 5 }).filter(x => x.score >= 0.75);
  const exact = sug.filter(x => x.score === 1);
  if (!sug.length) return add(null);
  if (exact.length === 1 && sug.length === 1) return add(exact[0].key, { kind: 'auto', reason: null }); // nombre idéntico a una sola ficha: se une solo
  // Hay parecidos: preguntar
  const gname = g => (g === 'commander' ? 'Commander' : melee.gameInfo(g).short);
  send(res, adminPage(req, `¿Quién es «${name}»?`, html`
    <p class="muted">Ya hay ${sug.length === 1 ? 'una ficha parecida' : 'fichas parecidas'}. Si es la misma persona, su historial y su liga quedan juntos.</p>
    <div class="askwho">${sug.map(x => html`<form method="post" action="${base(ev)}/jugador" class="whoopt">
      <input type="hidden" name="name" value="${name}"><input type="hidden" name="person_key" value="${x.key}">
      <div><b>${x.name}</b>${x.usernames.length ? html` <small class="muted">${x.usernames.map(u => '@' + u).join(' ')}</small>` : ''}
        <small class="muted">${x.events} evento${x.events === 1 ? '' : 's'} · ${x.games.map(gname).join(', ')} · ${x.why}</small></div>
      <button class="btn">Sí, es ${x.name}</button></form>`)}
      <form method="post" action="${base(ev)}/jugador" class="whoopt new"><input type="hidden" name="name" value="${name}"><input type="hidden" name="confirm" value="new">
        <input type="hidden" name="cands" value="${sug.map(x => x.key).join('|')}">
        <div><b>${name}</b> <small class="muted">jugador nuevo</small></div><button class="btn ghost">No, es otra persona</button></form></div>
    <p><a href="${base(ev)}">← Volver sin añadir</a></p>`));
});

r.post('/:id/importar', async (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  if (!ev.melee_tournament_id) return back(res, base(ev), 'Falta el ID del torneo de Melee', true);
  let list = [];
  try {
    const api = await melee.api.players(ev.melee_tournament_id);
    list = api.filter(p => p.Status !== 0 && !p.RemovalReason).map(p => ({
      name: p.PlayerName || p.DisplayName || p.Username, username: p.Username,
      key: p.UserIdentity || 'u:' + String(p.Username || '').toLowerCase(),
    }));
  } catch (e) {
    log('warn', `Importar Commander ${ev.id}: ${e.message}`);
    list = db.prepare('SELECT * FROM players WHERE tournament_id = ? AND status != 0').all(ev.melee_tournament_id)
      .map(p => ({ name: p.full_name || p.display_name || p.username, username: p.username, key: p.user_key }));
    if (!list.length) return back(res, base(ev), 'No se pudo leer Melee: ' + e.message, true);
  }
  const have = new Set(C.players(ev.id).map(p => p.user_key).filter(Boolean));
  const ins = db.prepare('INSERT INTO cmd_players (event_id, name, username, user_key) VALUES (?, ?, ?, ?)');
  let added = 0;
  for (const p of list) if (!have.has(p.key)) { ins.run(ev.id, p.name, p.username, p.key); added++; }
  back(res, base(ev), `Importados ${added} jugador(es) nuevos de ${list.length} inscritos en Melee`);
  // (los posibles duplicados con fichas hechas a mano se avisan en la lista de jugadores)
});

r.post('/:id/jugadores/:pid/drop', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const p = db.prepare('SELECT * FROM cmd_players WHERE id = ? AND event_id = ?').get(Number(req.params.pid), ev.id);
  if (!p) return back(res, base(ev), 'Jugador no encontrado', true);
  const cur = C.currentRound(ev.id);
  db.prepare('UPDATE cmd_players SET dropped_round = ? WHERE id = ?').run(p.dropped_round != null ? null : (cur ? cur.number : 0), p.id);
  if (ev.status === 'setup' && p.dropped_round == null) { const up = C.promoteWaitlist(ev.id); if (up.length) notifyPromoted(req, ev, up).catch(() => {}); }
  back(res, base(ev), p.dropped_round != null ? `${p.name} vuelve a jugar` : `${p.name} hace drop (no se le emparejará más)`);
});

// Móvil del jugador (por si alguien se hace pasar por otro)
const loadP = (req, ev) => db.prepare('SELECT * FROM cmd_players WHERE id = ? AND event_id = ?').get(Number(req.params.pid), ev.id);
r.post('/:id/jugadores/:pid/liberar', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const p = loadP(req, ev); if (!p) return back(res, base(ev), 'Jugador no encontrado', true);
  C.releasePhone(ev.id, p.id); C.activity(ev.id, p.id, 'tienda', `móvil liberado por ${req.user.username}`, null);
  back(res, base(ev), `Móvil de ${p.name} liberado: el siguiente móvil que lo use se queda con él`);
});
r.post('/:id/jugadores/:pid/limpiar', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const p = loadP(req, ev); if (!p) return back(res, base(ev), 'Jugador no encontrado', true);
  C.clearPlayerData(ev.id, p.id); C.activity(ev.id, p.id, 'tienda', `comandante y mazo borrados por ${req.user.username}`, null);
  back(res, base(ev), `Borrados el comandante y el mazo de ${p.name}`);
});
r.post('/:id/jugadores/:pid/resetear', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const p = loadP(req, ev); if (!p) return back(res, base(ev), 'Jugador no encontrado', true);
  C.releasePhone(ev.id, p.id); C.clearPlayerData(ev.id, p.id);
  C.activity(ev.id, p.id, 'tienda', `móvil liberado y datos borrados por ${req.user.username}`, null);
  back(res, base(ev), `${p.name}: móvil liberado y datos borrados`);
});
r.post('/:id/jugadores/:pid/llegada', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const p = loadP(req, ev); if (!p) return back(res, base(ev), 'Jugador no encontrado', true);
  C.setCheckin(ev.id, p.id, !p.checked_in_at);
  back(res, base(ev), p.checked_in_at ? `${p.name}: check-in quitado` : `${p.name} ha llegado ✓`);
});
r.post('/:id/checkin/drop', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  try { const n = C.dropAbsent(ev.id); back(res, base(ev), `${n} jugador(es) sin check-in pasan a drop`); } catch (e) { back(res, base(ev), e.message, true); }
});
r.get('/:id/checkin-qr', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const url = absUrl(req, `/commander/${ev.id}/checkin?c=${C.checkinCode(ev.id)}`);
  send(res, html`${head('Check-in ' + ev.name, require('../db').settings())}<body class="printsheet checkin-print">
    <div class="noprint bar"><button class="btn" onclick="print()">Imprimir</button></div>
    <div class="ckp"><p class="ckp-k">Check-in</p><h1>${ev.name}</h1><p class="ckp-s">Escanea al llegar a la tienda</p>
      <img src="/qr.svg?d=${encodeURIComponent(url)}" alt="QR de check-in"><p class="ckp-u">${url}</p>
      <p class="ckp-f">Elige tu nombre y pulsa «Estoy aquí». Sin check-in no entras en la ronda 1.</p></div></body></html>`);
});

r.post('/:id/jugadores/:pid/bloquear', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const p = loadP(req, ev); if (!p) return back(res, base(ev), 'Jugador no encontrado', true);
  C.setPhoneLock(ev.id, p.id, !p.phone_locked);
  C.activity(ev.id, p.id, 'tienda', `${p.phone_locked ? 'desbloqueado' : 'bloqueado'} por ${req.user.username}`, null);
  back(res, base(ev), p.phone_locked ? `${p.name} puede volver a usar el móvil` : `${p.name} ya no puede hacer cambios desde el móvil`);
});

r.post('/:id/jugadores/:pid/borrar', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const used = db.prepare('SELECT 1 FROM cmd_seats WHERE player_id = ?').get(Number(req.params.pid));
  if (used) return back(res, base(ev), 'Ya ha jugado: usa Drop', true);
  db.prepare('DELETE FROM cmd_players WHERE id = ? AND event_id = ?').run(Number(req.params.pid), ev.id);
  if (ev.status === 'setup') { const up = C.promoteWaitlist(ev.id); if (up.length) notifyPromoted(req, ev, up).catch(() => {}); }
  back(res, base(ev), 'Jugador quitado');
});

r.post('/:id/jugadores/:pid/datos', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const p = db.prepare('SELECT * FROM cmd_players WHERE id = ? AND event_id = ?').get(Number(req.params.pid), ev.id);
  if (!p) return back(res, base(ev), 'Jugador no encontrado', true);
  const name = String(req.body.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) return back(res, base(ev), 'El nombre no puede estar vacío', true);
  // La ficha no cambia al editar el nombre o el nick: se fija antes la que tenía
  const keep = p.person_key || people.cmdKey(p);
  db.prepare('UPDATE cmd_players SET name = ?, username = ?, person_key = ? WHERE id = ?').run(name, String(req.body.username || '').trim().slice(0, 40) || null, keep, p.id);
  if (req.body.pay) C.setPaid(ev.id, p.id, req.body.pay !== 'no', req.body.pay === 'no' ? null : req.body.pay, req.user && req.user.username);
  back(res, base(ev), `${name}: guardado`);
});
r.post('/:id/jugadores/:pid/pago', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const on = req.body.paid === '1';
  const method = ['efectivo', 'tarjeta', 'bizum', 'otro'].includes(req.body.method) ? req.body.method : null;
  C.setPaid(ev.id, Number(req.params.pid), on, method, req.user && req.user.username);
  const p = db.prepare('SELECT name FROM cmd_players WHERE id = ?').get(Number(req.params.pid));
  back(res, base(ev) + '#pagos', p ? `${p.name}: ${on ? `pagado${method ? ' (' + method + ')' : ''}` : 'sin pagar'}` : 'Hecho');
});
r.post('/:id/espera/:pid/subir', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const p = db.prepare('SELECT * FROM cmd_players WHERE id = ? AND event_id = ? AND waitlist = 1').get(Number(req.params.pid), ev.id);
  if (!p) return back(res, base(ev), 'No está en la lista de espera', true);
  db.prepare('UPDATE cmd_players SET waitlist = 0, dropped_round = NULL WHERE id = ?').run(p.id);
  notifyPromoted(req, ev, [p]).catch(() => {});
  back(res, base(ev), `${p.name} pasa a jugador`);
});
r.post('/:id/espera/:pid/quitar', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  db.prepare('DELETE FROM cmd_players WHERE id = ? AND event_id = ? AND waitlist = 1').run(Number(req.params.pid), ev.id);
  back(res, base(ev), 'Quitado de la lista de espera');
});

r.post('/:id/emparejar', async (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const pay = C.paymentStats(ev.id);
  if (pay && pay.unpaid.length && !C.currentRound(ev.id) && !req.body.force_pay) {
    return back(res, base(ev), `Hay ${pay.unpaid.length} ${pay.unpaid.length === 1 ? 'jugador' : 'jugadores'} sin pagar: ${pay.unpaid.slice(0, 8).map(p => p.name).join(', ')}${pay.unpaid.length > 8 ? '…' : ''}. Márcalos como pagados, dales de baja o marca «Empezar aunque haya jugadores sin pagar».`, true);
  }
  const bc = C.budgetCheck(ev.id);
  if (bc && !C.currentRound(ev.id) && (bc.missing.length || bc.over.length) && !req.body.force) {
    return back(res, base(ev), `Antes de empezar: ${[bc.overBudget.length ? `${bc.overBudget.length} mazos por encima del presupuesto` : '', bc.overBracket.length ? `${bc.overBracket.length} por encima del bracket` : '', bc.illegal.length ? `${bc.illegal.length} no legales` : '', bc.missing.length ? `${bc.missing.length} sin validar` : ''].filter(Boolean).join(', ')}. Revísalo o marca «Emparejar aunque…».`, true);
  }
  try {
    const out = C.pairNextRound(ev.id);
    await notifyRound(req, C.getEvent(ev.id));
    back(res, base(ev), `Ronda ${out.round}: ${out.pods} mesas${out.repeats ? ` (${out.repeats} parejas repiten rival: se prioriza juntar por puntos)` : ', sin repetir rivales'}`);
  } catch (e) { back(res, base(ev), e.message, true); }
});

r.post('/:id/final', async (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  if (!ev.final_top4) return back(res, base(ev), 'Este torneo no tiene mesa final (actívala en Configuración si la quieres)', true);
  try { C.pairFinal(ev.id); await notifyRound(req, C.getEvent(ev.id)); back(res, base(ev), 'Mesa final creada'); }
  catch (e) { back(res, base(ev), e.message, true); }
});

r.post('/:id/deshacer', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  try { C.undoLastRound(ev.id); back(res, base(ev), 'Ronda deshecha'); } catch (e) { back(res, base(ev), e.message, true); }
});

// Historial completo del contador de vidas de una mesa (para resolver dudas)
r.get('/:id/mesa/:pod/historial', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const L = require('../life');
  let items;
  try { items = L.history(ev.id, Number(req.params.pod), 2000); } catch (e) { return res.redirect(base(ev) + '?err=' + encodeURIComponent(e.message)); }
  const t = ms => new Date(ms).toLocaleString('es-ES', { timeZone: require('../config').tz, hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit' });
  const pod = db.prepare('SELECT table_number FROM cmd_pods WHERE id = ?').get(Number(req.params.pod));
  res.send(String(adminPage(req, `Historial · mesa ${pod ? pod.table_number : ''}`, html`
    <p><a href="${base(ev)}#pod-${Number(req.params.pod)}">← Volver al torneo</a> · <a href="/commander/${ev.id}/vidas?mesa=${Number(req.params.pod)}" target="_blank">Abrir el contador</a></p>
    <p class="small muted">Cada fila es un apunte: los toques seguidos de una misma persona sobre el mismo contador se juntan (si daban 5 y quitaban 1, queda −4). Lo tachado se deshizo. Hora de la última modificación de cada apunte; «quién» es el móvil que lo anotó.</p>
    ${items.length ? html`<div class="tablewrap"><table class="tbl"><thead><tr><th>Hora</th><th>Cambio</th><th class="num">Anotado por</th></tr></thead><tbody>
      ${items.map(h => html`<tr class="${h.undone ? 'dim' : ''}"><td class="nowrap small">${t(h.updated || h.at)}</td><td>${h.undone ? html`<s>${h.txt}</s>` : h.kind === 'kill' || h.kind === 'finish' ? html`<b>${h.txt}</b>` : h.txt}</td><td class="small muted num">${h.by}</td></tr>`)}
    </tbody></table></div>` : html`<p class="muted">Sin cambios todavía.</p>`}`)));
});

r.post('/:id/mesa/:pod', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const pod = db.prepare(`SELECT pd.id FROM cmd_pods pd JOIN cmd_rounds r ON r.id = pd.round_id WHERE pd.id = ? AND r.event_id = ?`).get(Number(req.params.pod), ev.id);
  if (!pod) return back(res, base(ev), 'Mesa no encontrada', true);
  let result = String(req.body.result || '');
  if (result === 'places') {
    const places = {};
    for (const [k, v] of Object.entries(req.body)) if (k.startsWith('place_')) places[Number(k.slice(6))] = v ? Number(v) : null;
    result = { places };
  }
  try { C.reportPod(pod.id, result); res.redirect(result === 'clear' ? `${base(ev)}#pod-${pod.id}` : `${base(ev)}?guardada=${pod.id}#pod-${pod.id}`); } catch (e) { back(res, base(ev), e.message, true); }
});

r.post('/:id/mesa/:pod/propuesta', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const pod = db.prepare(`SELECT pd.id FROM cmd_pods pd JOIN cmd_rounds r ON r.id = pd.round_id WHERE pd.id = ? AND r.event_id = ?`).get(Number(req.params.pod), ev.id);
  if (!pod) return back(res, base(ev), 'Mesa no encontrada', true);
  try {
    if (req.body.accion === 'confirmar') C.confirmProposal(pod.id); else C.clearProposal(pod.id);
    res.redirect(base(ev));
  } catch (e) { back(res, base(ev), e.message, true); }
});

r.post('/:id/confirmar-todas', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const cur = C.currentRound(ev.id);
  const list = cur ? db.prepare('SELECT id FROM cmd_pods WHERE round_id = ? AND reported = 0 AND proposed_at IS NOT NULL').all(cur.id) : [];
  for (const p of list) C.confirmProposal(p.id);
  back(res, base(ev), `${list.length} resultados confirmados`);
});

r.post('/:id/jugadores/:pid/mazo', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  C.setDeck(ev.id, Number(req.params.pid), req.body.deck);
  res.redirect(base(ev));
});

r.get('/:id/jugadores/:pid/mazo-detalle', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const p = db.prepare('SELECT * FROM cmd_players WHERE id = ? AND event_id = ?').get(Number(req.params.pid), ev.id);
  if (!p) return res.status(404).send('Jugador no encontrado');
  let d = null; try { d = JSON.parse(p.deck_detail || 'null'); } catch { d = null; }
  const over = ev.budget_cents && p.deck_value_cents != null && p.deck_value_cents > ev.budget_cents;
  const eur = v => (v == null ? '—' : (v).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' }));
  send(res, adminPage(req, `Mazo de ${p.name}`, html`
    <p><a href="${base(ev)}">← ${ev.name}</a></p>
    ${d ? html`<div class="stats"><div><b class="${over ? 'warn' : 'ok'}">${eur(d.counted)}</b><span>cuenta para el presupuesto${ev.budget_cents ? ` (${money(ev.budget_cents)})` : ''}</span></div>
      <div><b>${eur(d.total)}</b><span>valor total</span></div><div><b class="${d.cards === 100 ? '' : 'warn'}">${d.cards}</b><span>cartas</span></div>
      <div><b>${d.commander || '—'}</b><span>comandante</span></div></div>
      ${d.legality ? html`<div class="flash ${d.legality.ok ? '' : 'err'}">${d.legality.ok ? html`✔ Mazo legal en Commander` : html`<b>Mazo no legal:</b><ul class="legal">${d.legality.problems.map(p => html`<li>${p.msg}</li>`)}</ul>`}</div>` : ''}
      ${d.bracket ? bracketBox(d.bracket, ev.bracket_max) : ''}
      ${d.commanderHow === 'deducido' ? html`<div class="flash ${d.commanderSure ? '' : 'err'}">Comandante deducido por colores y posición: <b>${d.commander}</b>${d.commanderSure ? '' : ' (no es seguro)'}. Si no es, escribe «Commander» encima de su línea y guarda otra vez.</div>` : ''}
      ${d.notes && d.notes.length ? html`<div class="flash">${d.notes.map((n, i) => html`${i ? html`<br>` : ''}${n}`)}</div>` : ''}
      ${d.missing && d.missing.length ? html`<div class="flash err">Cartas no encontradas: ${d.missing.join(', ')}</div>` : ''}
      ${d.noPrice && d.noPrice.length ? html`<div class="flash">Sin precio en euros: ${d.noPrice.join(', ')}</div>` : ''}
      <p class="small muted">Validado ${p.deck_value_at}. Precio de la versión más barata de cada carta.</p>
      <div class="tablewrap"><table class="tbl"><thead><tr><th class="num">Cant.</th><th>Carta</th><th>Edición</th><th class="num">Precio</th><th class="num">Total</th></tr></thead><tbody>
        ${d.lines.map(l => html`<tr class="${l.c ? 'cmdrow' : ''}"><td class="num">${l.q}</td><td>${l.n}${l.c ? html` <span class="pill">comandante</span>` : ''}</td><td class="muted">${(l.s || '').toUpperCase()}</td>
          <td class="num">${eur(l.u)}</td><td class="num">${eur(l.t)}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">Este jugador aún no ha validado su mazo.</p>`}
    <section class="panel"><h2>${d ? 'Cambiar la lista del mazo' : 'Añadir la lista del mazo'}</h2>
      <p class="small muted">Elige un mazo preconstruido y cambia lo que haga falta, o pega la lista. Al guardar se calcula su valor${ev.budget_cents ? ' y se compara con el presupuesto' : ''}.</p>
      <form method="post" action="${base(ev)}/jugadores/${p.id}/mazo-detalle" class="stack">
        <div class="precon" data-precons="deck-list"></div>
        <textarea name="list" id="deck-list" rows="12" placeholder="Pega aquí la lista del jugador">${p.deck_list || ''}</textarea>
        <button class="btn">Guardar lista</button><small class="muted">Puede tardar unos segundos la primera vez.</small></form></section>
    <script src="/static/precons.js"></script>`));
});

r.post('/:id/jugadores/:pid/mazo-detalle', async (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const p = db.prepare('SELECT * FROM cmd_players WHERE id = ? AND event_id = ?').get(Number(req.params.pid), ev.id);
  if (!p) return res.status(404).send('Jugador no encontrado');
  const url = `${base(ev)}/jugadores/${p.id}/mazo-detalle`;
  try {
    const result = await deckvalue.value(String(req.body.list || ''));
    const counted = C.setDeckValue(ev.id, p.id, result, req.body.list);
    const eur = counted.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
    back(res, url, ev.budget_cents ? `Lista guardada: ${eur} para el presupuesto` : `Lista guardada (valor ${eur})`);
  } catch (e) { back(res, url, e.message, true); }
});

r.post('/:id/recalcular-mazos', async (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const list = db.prepare("SELECT * FROM cmd_players WHERE event_id = ? AND deck_list IS NOT NULL AND deck_list != ''").all(ev.id);
  let n = 0, errors = 0;
  for (const p of list) {
    try { C.setDeckValue(ev.id, p.id, await deckvalue.value(p.deck_list), p.deck_list); n++; } catch { errors++; }
  }
  back(res, base(ev), `${n} mazos recalculados con los precios de hoy${errors ? ` (${errors} con error)` : ''}`, errors > 0 && n === 0);
});

r.post('/:id/duplicar', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const id = C.duplicateEvent(ev.id, !!req.body.players);
  back(res, `/admin/commander/${id}`, 'Evento duplicado: revisa fecha y nombre');
});

r.post('/:id/premio', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  if (!feature('prizes')) return back(res, base(ev), 'Función de premios desactivada', true);
  db.prepare('INSERT INTO prizes (tournament_id, cmd_event_id, cmd_player_id, label, kind, amount_cents) VALUES (0, ?, ?, ?, ?, ?)')
    .run(ev.id, Number(req.body.player) || null, String(req.body.label || '').slice(0, 200), req.body.kind || 'otro', toCents(req.body.amount) || 0);
  res.redirect(base(ev));
});
r.post('/:id/premio/:pid/borrar', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  db.prepare('DELETE FROM prizes WHERE id = ? AND cmd_event_id = ?').run(Number(req.params.pid), ev.id);
  res.redirect(base(ev));
});

r.post('/:id/cambiar', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const rd = db.prepare('SELECT * FROM cmd_rounds WHERE id = ? AND event_id = ?').get(Number(req.body.round), ev.id);
  if (!rd) return back(res, base(ev), 'Ronda no encontrada', true);
  try { C.swapPlayers(rd.id, Number(req.body.a), Number(req.body.b)); back(res, base(ev), 'Jugadores intercambiados'); }
  catch (e) { back(res, base(ev), e.message, true); }
});

r.post('/:id/timer', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const cur = C.currentRound(ev.id);
  if (!cur) return back(res, base(ev), 'No hay ronda', true);
  if (!req.body.stop && (ev.status === 'finished' || C.roundComplete(cur.id))) return back(res, base(ev), 'La ronda ya está terminada', true);
  const end = req.body.stop ? null : new Date(Date.now() + (Math.min(Math.max(Number(req.body.minutes) || ev.round_minutes, 1), 300)) * 60000).toISOString();
  db.prepare('UPDATE cmd_rounds SET timer_end = ? WHERE id = ?').run(end, cur.id);
  res.redirect(base(ev));
});

r.post('/:id/terminar', async (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const cur = C.currentRound(ev.id);
  if (cur && !C.roundComplete(cur.id)) return back(res, base(ev), 'Faltan resultados', true);
  C.finishEvent(ev.id);
  await notifyFinal(req, ev);
  back(res, base(ev), 'Torneo terminado');
});
r.post('/:id/reabrir', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  db.prepare("UPDATE cmd_events SET status = ? WHERE id = ?").run(C.currentRound(ev.id) ? 'running' : 'setup', ev.id);
  back(res, base(ev), 'Reabierto');
});
r.post('/:id/borrar', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  db.prepare('DELETE FROM cmd_events WHERE id = ?').run(ev.id);
  back(res, '/admin/commander', 'Evento borrado');
});

// Hoja imprimible de mesas de la ronda actual (y clasificación)
r.get('/:id/imprimir', (req, res) => {
  const ev = loadEv(req, res); if (!ev) return;
  const cur = C.currentRound(ev.id);
  const pods = cur ? C.podsOfRound(cur.id) : [];
  const byName = pods.flatMap(p => p.players.map(x => ({ name: x.name, table: p.table_number, seat: x.seat }))).sort((a, b) => a.name.localeCompare(b.name));
  send(res, html`${head('Mesas ' + ev.name, require('../db').settings())}<body class="printsheet">
    <div class="noprint bar"><button class="btn" onclick="print()">Imprimir</button></div>
    <div class="ps"><h1>${ev.name} · ${cur ? (cur.kind === 'final' ? 'Mesa final' : `Ronda ${cur.number}`) : 'sin rondas'}</h1>
    <h2>Por mesa</h2><div class="ps-pods">${pods.map(p => html`<div class="ps-pod"><b>Mesa ${p.table_number}</b>${p.players.map(x => html`<div>${x.seat}º ${x.name}</div>`)}</div>`)}</div>
    <h2>Por nombre</h2><table class="ps-names">${byName.map(x => html`<tr><td>${x.name}</td><td>Mesa ${x.table}</td><td>${x.seat === 1 ? 'Empieza' : `Juega ${x.seat}º`}</td></tr>`)}</table></div></body></html>`);
});

module.exports = r;
