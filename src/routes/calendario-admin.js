'use strict';
// Calendario de la web de la tienda: lo que llega entra como borrador y aquí se publica y se retoca.
// Por defecto manda su web; un campo editado aguanta hasta que allí cambie, salvo que esté fijado
const express = require('express');
const { feature } = require('../db');
const melee = require('../melee');
const J = require('../jupcal');
const { html, adminPage, money } = require('../views/html');

const r = express.Router();
const back = (res, msg, err = false, to = '/admin/calendario') => res.redirect(to + (to.includes('?') ? '&' : '?') + (err ? 'err=' : 'ok=') + encodeURIComponent(msg));
const dd = d => new Date(d.day + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
const GAMES = ['commander', 'MagicTheGathering', 'StarWarsUnlimited', 'CyberpunkTCG', 'OnePiece', 'Riftbound', 'other'];
const LABEL = { title: 'Título', game: 'Juego', price: 'Precio', info: 'Texto', img: 'Imagen del cartel (URL)', signup: 'Enlace para reservar plaza' };
const priceOf = a => (a.price_cents != null ? (a.price_cents ? money(a.price_cents) : 'Gratis') : a.price || '—');

r.get('/calendario', (req, res) => {
  const st = J.status();
  const acts = J.activities();
  const pub = acts.filter(a => a.visible), draft = acts.filter(a => !a.visible);
  const row = a => { const g = melee.gameInfo(a.game || 'other'); return html`<tr class="${a.visible ? '' : 'dim'}">
    <td><span class="gchip" style="--g:${g.color}"><i></i>${g.short}</span></td>
    <td><a href="/admin/calendario/${a.aid}"><b>${a.title}</b></a>
      ${a.locked.length ? html` <span class="pill">${a.locked.length === 1 ? '1 campo fijado' : `${a.locked.length} campos fijados`}</span>` : a.edited.length ? html` <span class="pill">editado</span>` : ''}
      ${a.changed.length ? html` <span class="pill warn">ha cambiado en su web</span>` : ''}
      <br><small class="muted">${a.dates.slice(0, 6).map(d => `${dd(d)}${d.time ? ' ' + d.time : ''}`).join(' · ')}${a.dates.length > 6 ? ` y ${a.dates.length - 6} más` : ''}</small></td>
    <td class="num">${priceOf(a)}</td>
    <td class="nowrap"><a class="btn small ghost" href="/admin/calendario/${a.aid}">Editar</a>
      <form method="post" action="/admin/calendario/${a.aid}/${a.visible ? 'ocultar' : 'publicar'}" class="inline"><button class="btn small ${a.visible ? 'ghost' : ''}">${a.visible ? 'Ocultar' : 'Publicar'}</button></form></td></tr>`; };
  const table = list => html`<div class="tablewrap"><table class="tbl"><thead><tr><th>Juego</th><th>Evento y próximas fechas</th><th class="num">Precio</th><th></th></tr></thead><tbody>${list.map(row)}</tbody></table></div>`;
  res.send(String(adminPage(req, 'Calendario de la tienda', html`
    ${!feature('calendar') ? html`<p class="aflash err">Está desactivado en Ajustes.</p>` : ''}
    <section class="panel"><p>Se lee de <a href="${st.url}" target="_blank" rel="noopener">${st.url}</a> cada 3 horas (este mes y el siguiente). Lo nuevo entra como <b>borrador</b>: solo sale en la web cuando lo publicas.</p>
      <p>Puedes editar cada evento. Por defecto manda su web: lo que cambies aquí se mantiene hasta que ese campo cambie allí. Si marcas <b>Fijar</b> en un campo, se queda el tuyo aunque cambie en su web.</p>
      <p class="small muted">${st.at ? `Última lectura: ${new Date(st.at).toLocaleString('es-ES', { timeZone: require('../config').tz })} · ${st.count} fechas` : 'Aún no se ha leído.'}${st.running ? ' · leyendo ahora…' : ''}</p>
      ${st.lastError ? html`<p class="aflash err">Último error: ${st.lastError}</p>` : ''}
      <form method="post" action="/admin/calendario/leer" class="inline"><button class="btn small">Leer ahora</button></form>
      ${draft.length ? html`<form method="post" action="/admin/calendario/publicar-todo" class="inline"><button class="btn small ghost">Publicar todos los borradores (${draft.length})</button></form>` : ''}</section>
    <section class="panel"><h2>Publicados (${pub.length})</h2>${pub.length ? table(pub) : html`<p class="muted">Aún no has publicado ninguno.</p>`}
      <p class="small muted">Si un evento publicado coincide en día y juego con un torneo de Melee o de Commander de esta web, se muestran juntos: el torneo con el precio, la información y el botón de reserva de la tienda.</p></section>
    <section class="panel"><h2>Borradores (${draft.length})</h2>${draft.length ? table(draft) : html`<p class="muted">No hay borradores.</p>`}</section>`)));
});

r.get('/calendario/:aid(\\d+)', (req, res) => {
  const a = J.act(Number(req.params.aid));
  if (!a) return back(res, 'Ese evento no existe', true);
  const dates = J.datesOf(a.aid);
  const val = f => (f === 'info' ? a.infoText : f === 'game' ? a.game : a[f]) || '';
  const input = f => f === 'game'
    ? html`<select name="game">${GAMES.map(g => html`<option value="${g}" ${val(f) === g ? 'selected' : ''}>${melee.gameInfo(g).label}</option>`)}</select>`
    : f === 'info' ? html`<textarea name="info" rows="12">${val(f)}</textarea>`
      : html`<input name="${f}" value="${val(f)}" maxlength="300">`;
  const srcShow = f => (f === 'game' ? melee.gameInfo(a.src.game).label : a.src[f]) || '(vacío)';
  const field = f => {
    const locked = a.locked.includes(f), edited = a.edited.includes(f), changed = a.changed.includes(f);
    return html`<div class="calfield ${edited ? 'edited' : ''}">
      <label>${LABEL[f]}${input(f)}</label>
      <label class="check-inline"><input type="checkbox" name="lock_${f}" value="1" ${locked ? 'checked' : ''}> Fijar: que no se actualice desde su web</label>
      ${changed ? html`<p class="aflash err small">Ha cambiado en su web desde que lo fijaste. Allí pone: <i>${String(srcShow(f)).slice(0, 300)}</i>
        <button class="btn small" form="rs-${f}">Usar el de su web</button> <button class="btn small ghost" form="ok-${f}">Quedarme con el mío</button></p>`
        : edited ? html`<p class="small muted">${locked ? 'Fijado.' : 'Editado: se mantiene hasta que cambie en su web.'} ${f === 'info' ? '' : html`En su web: <i>${String(srcShow(f)).slice(0, 200)}</i>`} <button class="linkbtn" form="rs-${f}">Volver al de su web</button></p>` : ''}
    </div>`;
  };
  res.send(String(adminPage(req, a.title, html`
    <p><a href="/admin/calendario">← Calendario</a></p>
    <section class="panel">
      <p>${a.visible ? html`<b>Publicado</b>: sale en la web.` : html`<b>Borrador</b>: no sale en la web.`}
        <form method="post" action="/admin/calendario/${a.aid}/${a.visible ? 'ocultar' : 'publicar'}?volver=1" class="inline"><button class="btn small ${a.visible ? 'ghost' : ''}">${a.visible ? 'Ocultar' : 'Publicar'}</button></form>
        ${a.url ? html` <a class="small" href="${a.url}" target="_blank" rel="noopener">ver en su web ↗</a>` : ''} ${a.visible ? html` <a class="small" href="/evento/${a.aid}" target="_blank">ver aquí ↗</a>` : ''}</p>
      <p class="small muted">Fechas: ${dates.length ? dates.map(d => `${dd(d)}${d.time ? ' ' + d.time : ''}`).join(' · ') : 'ninguna próxima'} (las fechas siempre vienen de su web)</p>
      <form method="post" action="/admin/calendario/${a.aid}/editar" class="aform">
        ${J.FIELDS.map(field)}
        <button class="jbtn">Guardar</button></form>
      ${J.FIELDS.map(f => html`<form id="rs-${f}" method="post" action="/admin/calendario/${a.aid}/restaurar/${f}"></form><form id="ok-${f}" method="post" action="/admin/calendario/${a.aid}/mantener/${f}"></form>`)}
    </section>`)));
});
r.post('/calendario/leer', (req, res) => { J.sync({ force: true }); back(res, 'Leyendo el calendario: recarga en unos segundos'); });
r.post('/calendario/publicar-todo', (req, res) => { for (const a of J.activities().filter(a => !a.visible)) J.setVisible(a.aid, true); back(res, 'Publicados'); });
r.post('/calendario/:aid(\\d+)/editar', (req, res) => {
  const aid = Number(req.params.aid);
  try { J.setEdits(aid, req.body || {}); back(res, 'Guardado', false, `/admin/calendario/${aid}`); } catch (e) { back(res, e.message, true, `/admin/calendario/${aid}`); }
});
r.post('/calendario/:aid(\\d+)/:op(restaurar|mantener)/:f', (req, res) => {
  const aid = Number(req.params.aid);
  if (J.FIELDS.includes(req.params.f)) J.resetField(aid, req.params.f, req.params.op === 'mantener');
  back(res, req.params.op === 'mantener' ? 'Se queda el tuyo' : 'Vuelve a mandar su web', false, `/admin/calendario/${aid}`);
});
r.post('/calendario/:aid(\\d+)/:act(publicar|ocultar)', (req, res) => {
  const aid = Number(req.params.aid), on = req.params.act === 'publicar';
  J.setVisible(aid, on);
  back(res, on ? 'Publicado: ya sale en la web' : 'Oculto', false, req.query.volver ? `/admin/calendario/${aid}` : '/admin/calendario');
});

module.exports = r;
