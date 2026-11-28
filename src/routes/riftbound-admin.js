'use strict';
// Riftbound: estado de la lectura desde playriftbound.com, leer ahora y añadir un torneo por su enlace
const express = require('express');
const { db, feature, setting, setSetting } = require('../db');
const RB = require('../riftbound');
const { html, adminPage } = require('../views/html');
const config = require('../config');

const r = express.Router();
const back = (res, msg, err = false) => res.redirect('/admin/riftbound?' + (err ? 'err=' : 'ok=') + encodeURIComponent(msg));
const when = iso => (iso ? new Date(iso).toLocaleString('es-ES', { timeZone: config.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

r.get('/riftbound', (req, res) => {
  const st = RB.state();
  let org = null; try { org = JSON.parse(setting('rb_org_cache') || 'null'); } catch (e) { org = null; }
  const ts = db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM players p WHERE p.tournament_id = t.id) players FROM tournaments t
    WHERE t.source = 'riftbound' ORDER BY COALESCE(t.start_date, t.first_seen) DESC LIMIT 60`).all();
  res.send(String(adminPage(req, 'Riftbound', html`
    ${!feature('riftbound') ? html`<p class="aflash err">Está desactivado en Ajustes.</p>` : ''}
    <section class="panel">
      <p>Los torneos de Riftbound de la tienda se leen de <a href="https://playriftbound.com" target="_blank" rel="noopener">playriftbound.com</a>: los próximos cada 15 minutos y los que están en juego cada 45 segundos.
        Salen en la agenda, en directo (web, TV y QR de mesas), en resultados y cuentan para el ranking, los perfiles y las insignias, igual que los de Melee.
        Se gestionan como siempre en <a href="https://rgn.playriftbound.com" target="_blank" rel="noopener">RGN</a>.</p>
      <p class="small muted">Tienda: <b>${org ? org.name : st.org}</b> · ${st.lastList ? `Última lectura: ${when(new Date(st.lastList).toISOString())}` : 'Aún no se ha leído'}${st.running ? ' · leyendo ahora…' : ''}</p>
      ${st.lastError ? html`<p class="aflash err">Último error: ${st.lastError}</p>` : ''}
      <form method="post" action="/admin/riftbound/leer" class="inline"><button class="btn small">Leer ahora</button></form>
      <form method="post" action="/admin/riftbound/anadir" class="aform inline2"><label>¿Falta alguno? Pega su enlace de playriftbound.com<input name="url" placeholder="https://playriftbound.com/es-ES/events/117557998796655771"></label><button class="btn">Añadir</button></form>
      <details><summary class="small">Otra tienda</summary>
        <form method="post" action="/admin/riftbound/tienda" class="aform inline2"><label>Identificador de la tienda en playriftbound.com<input name="org" value="${setting('rb_organizer') || RB.DEFAULT_ORG}"></label><button class="btn ghost">Guardar</button></form></details>
    </section>
    <section class="panel"><h2>Torneos (${ts.length})</h2>
      ${ts.length ? html`<div class="tablewrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Torneo</th><th>Estado</th><th class="num">Jugadores</th><th></th></tr></thead><tbody>
        ${ts.map(t => html`<tr class="${t.hidden ? 'dim' : ''}"><td class="nowrap">${when(t.start_date)}</td><td><a href="/admin/torneos/${t.id}">${t.name}</a></td>
          <td>${t.status_desc || ''}${t.status === 2 && t.current_round ? ` · ronda ${t.current_round}` : ''}</td><td class="num">${t.players}</td>
          <td class="nowrap"><a class="small" href="/t/${t.id}" target="_blank">ver ↗</a> <a class="small" href="${t.ext_url}" target="_blank" rel="noopener">en su web ↗</a></td></tr>`)}
      </tbody></table></div>` : html`<p class="muted">Todavía no hay ninguno.</p>`}</section>`)));
});
r.post('/riftbound/leer', (req, res) => { RB.syncAll(); back(res, 'Leyendo playriftbound.com: recarga en un minuto'); });
r.post('/riftbound/anadir', async (req, res) => {
  try { const tid = await RB.addByUrl(req.body.url); res.redirect(`/admin/torneos/${tid}?ok=` + encodeURIComponent('Añadido')); } catch (e) { back(res, e.message, true); }
});
r.post('/riftbound/tienda', (req, res) => {
  const v = String(req.body.org || '').trim();
  if (v && !/^[0-9a-f-]{36}$/i.test(v)) return back(res, 'Ese identificador no tiene el formato de playriftbound.com', true);
  setSetting('rb_organizer', v); setSetting('rb_org_cache', '');
  back(res, 'Guardado');
});

module.exports = r;
