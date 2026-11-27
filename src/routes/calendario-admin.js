'use strict';
// Calendario de la web de la tienda: lo que llega entra como borrador y aquí se publica (el contenido lo manda siempre el calendario)
const express = require('express');
const { feature } = require('../db');
const melee = require('../melee');
const J = require('../jupcal');
const { html, adminPage, money } = require('../views/html');

const r = express.Router();
const back = (res, msg, err = false) => res.redirect('/admin/calendario?' + (err ? 'err=' : 'ok=') + encodeURIComponent(msg));
const dd = d => new Date(d.day + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });

r.get('/calendario', (req, res) => {
  const st = J.status();
  const acts = J.activities();
  const pub = acts.filter(a => a.visible), draft = acts.filter(a => !a.visible);
  const row = a => { const g = melee.gameInfo(a.game || 'other'); return html`<tr class="${a.visible ? '' : 'dim'}">
    <td><span class="gchip" style="--g:${g.color}"><i></i>${g.short}</span></td>
    <td><b>${a.title}</b>${a.url ? html` <a class="small" href="${a.url}" target="_blank" rel="noopener">ver en su web ↗</a>` : ''}<br><small class="muted">${a.dates.slice(0, 6).map(d => `${dd(d)}${d.time ? ' ' + d.time : ''}`).join(' · ')}${a.dates.length > 6 ? ` y ${a.dates.length - 6} más` : ''}</small></td>
    <td class="num">${a.price_cents != null ? (a.price_cents ? money(a.price_cents) : 'Gratis') : a.price || '—'}</td>
    <td class="nowrap"><form method="post" action="/admin/calendario/${a.aid}/${a.visible ? 'ocultar' : 'publicar'}" class="inline"><button class="btn small ${a.visible ? 'ghost' : ''}">${a.visible ? 'Ocultar' : 'Publicar'}</button></form></td></tr>`; };
  const table = list => html`<div class="tablewrap"><table class="tbl"><thead><tr><th>Juego</th><th>Evento y próximas fechas</th><th class="num">Precio</th><th></th></tr></thead><tbody>${list.map(row)}</tbody></table></div>`;
  res.send(String(adminPage(req, 'Calendario de la tienda', html`
    ${!feature('calendar') ? html`<p class="aflash err">Está desactivado en Ajustes.</p>` : ''}
    <section class="panel"><p>Se lee de <a href="${st.url}" target="_blank" rel="noopener">${st.url}</a> cada 3 horas (este mes y el siguiente). Lo nuevo entra como <b>borrador</b>: solo sale en la web cuando lo publicas.
      El texto, el precio, las fechas y la imagen los manda siempre el calendario: si allí cambian, aquí se actualizan solos, esté publicado o no.</p>
      <p class="small muted">${st.at ? `Última lectura: ${new Date(st.at).toLocaleString('es-ES', { timeZone: require('../config').tz })} · ${st.count} fechas` : 'Aún no se ha leído.'}${st.running ? ' · leyendo ahora…' : ''}</p>
      ${st.lastError ? html`<p class="aflash err">Último error: ${st.lastError}</p>` : ''}
      <form method="post" action="/admin/calendario/leer" class="inline"><button class="btn small">Leer ahora</button></form>
      ${draft.length ? html`<form method="post" action="/admin/calendario/publicar-todo" class="inline" onsubmit="return confirm('¿Publicar los ${draft.length} borradores?')"><button class="btn small ghost">Publicar todos los borradores</button></form>` : ''}</section>
    <section class="panel"><h2>Publicados (${pub.length})</h2>${pub.length ? table(pub) : html`<p class="muted">Aún no has publicado ninguno.</p>`}
      <p class="small muted">Si un evento publicado coincide en día y juego con un torneo de Melee o de Commander de esta web, se muestran juntos: el torneo con el precio, la información y el botón de inscripción de la tienda.</p></section>
    <section class="panel"><h2>Borradores (${draft.length})</h2>${draft.length ? table(draft) : html`<p class="muted">No hay borradores.</p>`}</section>`)));
});
r.post('/calendario/leer', (req, res) => { J.sync({ force: true }); back(res, 'Leyendo el calendario: recarga en unos segundos'); });
r.post('/calendario/publicar-todo', (req, res) => { for (const a of J.activities().filter(a => !a.visible)) J.setVisible(a.aid, true); back(res, 'Publicados'); });
r.post('/calendario/:aid/:act', (req, res) => {
  const on = req.params.act === 'publicar';
  J.setVisible(Number(req.params.aid), on);
  back(res, on ? 'Publicado: ya sale en la web' : 'Oculto');
});

module.exports = r;
