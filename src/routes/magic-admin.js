'use strict';
// Magic (EventLink): conectar la cuenta de la tienda, estado y añadir eventos por su enlace
const express = require('express');
const { db, feature, setting, setSetting } = require('../db');
const EL = require('../eventlink');
const { html, adminPage } = require('../views/html');
const config = require('../config');

const r = express.Router();
const back = (res, msg, err = false) => res.redirect('/admin/magic?' + (err ? 'err=' : 'ok=') + encodeURIComponent(msg));
const when = iso => (iso ? new Date(iso).toLocaleString('es-ES', { timeZone: config.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

r.get('/magic', (req, res) => {
  const st = EL.state();
  const ts = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM players p WHERE p.tournament_id = t.id) players FROM tournaments t
    WHERE t.source = 'eventlink' ORDER BY COALESCE(t.start_date, t.first_seen) DESC LIMIT 60`).all();
  res.send(String(adminPage(req, 'Magic (EventLink)', html`
    ${!feature('eventlink') ? html`<p class="aflash err">Está desactivado en Ajustes.</p>` : ''}
    <section class="panel">
      <p>Los torneos de Magic que se llevan en EventLink (los que ven los jugadores en Companion) se leen con la cuenta de la tienda: los que están en juego cada minuto
        y el resto cada 5 minutos. Salen en directo (web, TV y QR de mesas), en resultados y cuentan para el ranking, los perfiles y las insignias.</p>
      ${st.connected
        ? html`<p>${st.status === 'caducada' ? html`<b class="warn">La sesión ha caducado: vuelve a conectarla.</b>` : html`Conectada${st.who ? html` como <b>${st.who}</b>` : ''}.`}
          ${st.lastList ? ` Última lectura: ${when(new Date(st.lastList).toISOString())}${st.pageInfo ? ` (${st.pageInfo})` : ''}.` : ''}${st.running ? ' Leyendo ahora…' : ''}</p>
          ${st.lastError ? html`<p class="aflash err">Último error: ${st.lastError}</p>` : ''}
          <form method="post" action="/admin/magic/leer" class="inline"><button class="btn small">Leer ahora</button></form>
          <form method="post" action="/admin/magic/desconectar" class="inline"><button class="btn small ghost">Desconectar</button></form>`
        : html`<p><b>Sin conectar.</b></p>`}
    </section>
    <section class="panel"><h2>${st.connected ? 'Volver a conectar' : 'Conectar la cuenta de la tienda'}</h2>
      <ol class="small">
        <li>En el ordenador, abre una <b>ventana de incógnito</b> y entra en <a href="https://eventlink.wizards.com" target="_blank" rel="noopener">eventlink.wizards.com</a> con la cuenta de la tienda.</li>
        <li>Pulsa F12 › pestaña <b>Application</b> (Aplicación) › <b>Cookies</b> › eventlink.wizards.com.</li>
        <li>Copia el valor de la cookie <b>_refresh_EL</b> y pégalo aquí.</li>
        <li>Cierra la ventana de incógnito <b>sin cerrar sesión</b> (si cierras sesión, deja de valer).</li>
      </ol>
      <form method="post" action="/admin/magic/conectar" class="aform"><label>Cookie _refresh_EL<input type="password" name="refresh" autocomplete="off" required></label>
        <label>Identificador de la tienda (el número que sale en la dirección: …/stores/12345/…)<input name="org" value="${st.org}" inputmode="numeric"></label>
        <button class="jbtn">Conectar</button></form>
      <p class="small muted">No se guarda la contraseña: solo esa sesión, que se renueva sola. Si algún día caduca, aquí lo verás.</p></section>
    ${st.connected ? html`<section class="panel"><form method="post" action="/admin/magic/anadir" class="aform inline2"><label>¿Falta alguno? Pega su enlace de EventLink<input name="url" placeholder="https://eventlink.wizards.com/stores/…/events/…"></label><button class="btn">Añadir</button></form></section>` : ''}
    <section class="panel"><h2>Torneos (${ts.length})</h2>
      ${ts.length ? html`<div class="tablewrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Torneo</th><th>Estado</th><th class="num">Jugadores</th><th></th></tr></thead><tbody>
        ${ts.map(t => html`<tr class="${t.hidden ? 'dim' : ''}"><td class="nowrap">${when(t.start_date)}</td><td><a href="/admin/torneos/${t.id}">${t.name}</a></td>
          <td>${t.status_desc || ''}${t.status === 2 && t.current_round ? ` · ronda ${t.current_round}` : ''}</td><td class="num">${t.players}</td>
          <td class="nowrap"><a class="small" href="/t/${t.id}" target="_blank">ver ↗</a></td></tr>`)}
      </tbody></table></div>` : html`<p class="muted">Todavía no hay ninguno.</p>`}</section>`)));
});
r.post('/magic/conectar', async (req, res) => {
  try {
    const org = String(req.body.org || '').trim();
    if (org && !/^\d+$/.test(org)) throw new Error('El identificador de la tienda es un número');
    if (org) setSetting('el_org', org);
    EL.connect(req.body.refresh, 'auth0');
    await EL.token();
    EL.syncAll();
    back(res, 'Conectada');
  } catch (e) { back(res, e.message, true); }
});
r.post('/magic/desconectar', (req, res) => { EL.disconnect(); back(res, 'Desconectada'); });
r.post('/magic/leer', (req, res) => { EL.syncAll(); back(res, 'Leyendo EventLink: recarga en un minuto'); });
r.post('/magic/anadir', async (req, res) => {
  try { const tid = await EL.addByUrl(req.body.url); res.redirect(`/admin/torneos/${tid}?ok=` + encodeURIComponent('Añadido')); } catch (e) { back(res, e.message, true); }
});

module.exports = r;
