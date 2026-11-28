'use strict';
// Auditoría del contador de vidas: qué se tocó, quién, desde qué aparato y el valor antes y después
const express = require('express');
const AU = require('../lifeaudit');
const { html, adminPage } = require('../views/html');
const config = require('../config');

const r = express.Router();
const when = ms => new Date(ms).toLocaleString('es-ES', { timeZone: config.tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const filters = q => ({ eventId: Number(q.evento) || null, podId: Number(q.mesa) || null, q: String(q.q || '').trim().slice(0, 60), op: AU.OPS[q.op] ? q.op : '', errors: q.errores === '1', before: Number(q.antes) || null });
const chg = c => `${c.who}: ${c.field} ${c.from ?? '—'} → ${c.to ?? '—'}`;
const prm = p => Object.entries(p).map(([k, v]) => `${k}=${v}`).join(' ');

// Acciones del admin y de los jugadores (lo principal)
const AA = require('../audit');
const KIND = { staff: 'Staff', cuenta: 'Jugador con cuenta', 'anónimo': 'Sin cuenta' };
const tabsA = on => html`<div class="chips audtabs"><a href="/admin/auditoria" class="${on === 'acc' ? 'on' : ''}">Acciones</a><a href="/admin/auditoria/contador" class="${on === 'life' ? 'on' : ''}">Contador de vidas</a></div>`;
r.get('/auditoria', (req, res) => {
  const f = { q: String(req.query.q || '').trim().slice(0, 60), area: String(req.query.area || ''), kind: KIND[req.query.quien] ? req.query.quien : '', before: Number(req.query.antes) || null };
  const rows = AA.list({ ...f, limit: 200 });
  const qs = o => '?' + new URLSearchParams(Object.entries({ q: f.q, area: f.area, quien: f.kind, ...o }).filter(([, v]) => v !== '' && v != null)).toString();
  res.send(String(adminPage(req, 'Auditoría', html`${tabsA('acc')}
    <section class="panel"><p class="small muted">Lo que se hace en el admin y lo que hacen los jugadores en la web (apuntarse, borrarse, mazos, check-in, reportar…):
      quién lo hizo, desde qué aparato, y el valor de antes y el de después de lo que cambió. Las contraseñas y claves nunca se guardan.</p>
      <form method="get" class="aform audfil">
        <label>Zona<select name="area"><option value="">Todas</option>${AA.areas().map(a => html`<option ${f.area === a ? 'selected' : ''}>${a}</option>`)}</select></label>
        <label>Quién<select name="quien"><option value="">Todos</option>${Object.entries(KIND).map(([k, v]) => html`<option value="${k}" ${f.kind === k ? 'selected' : ''}>${v}</option>`)}</select></label>
        <label>Buscar (persona, torneo, valor…)<input name="q" value="${f.q}"></label>
        <button class="btn">Filtrar</button> <a class="btn ghost" href="/admin/auditoria/acciones.csv${qs({})}">Descargar CSV</a></form></section>
    <section class="panel">${rows.length ? html`<div class="tablewrap"><table class="tbl aud"><thead><tr><th>Cuándo</th><th>Quién</th><th>Zona · acción</th><th>Antes → después</th></tr></thead><tbody>
      ${rows.map(x => html`<tr class="${x.status >= 400 ? 'err' : ''}"><td class="nowrap">${when(x.at)}</td>
        <td>${x.actor}<br><small class="muted">${KIND[x.actor_kind] || x.actor_kind} · ${x.device || ''}</small></td>
        <td>${x.area} · <b>${x.action}</b>${x.target ? html`<br><small>${x.target}</small>` : ''}</td>
        <td>${x.changes.length ? html`<ul class="audch">${x.changes.map(c => html`<li>${c.who ? html`<b>${c.who}</b> · ` : ''}${c.field}: <s>${c.from ?? '—'}</s> → <b>${c.to ?? '—'}</b></li>`)}</ul>`
          : x.status >= 400 ? html`<span class="warn">No se hizo (error ${x.status})</span>` : html`<span class="muted">sin cambios guardados</span>`}</td></tr>`)}
      </tbody></table></div>
      ${rows.length === 200 ? html`<p><a class="btn ghost" href="${qs({ antes: rows[rows.length - 1].id })}">Más antiguas →</a></p>` : ''}` : html`<p class="muted">Todavía no hay acciones con esos filtros.</p>`}</section>`)));
});
r.get('/auditoria/acciones.csv', (req, res) => {
  const rows = AA.list({ q: String(req.query.q || ''), area: String(req.query.area || ''), kind: String(req.query.quien || ''), limit: 50000 });
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['fecha', 'quien', 'tipo', 'aparato', 'zona', 'accion', 'objetivo', 'cambios', 'estado'].join(';')]
    .concat(rows.map(x => [new Date(x.at).toISOString(), x.actor, KIND[x.actor_kind] || x.actor_kind, x.device, x.area, x.action, x.target,
      x.changes.map(c => `${c.who ? c.who + ': ' : ''}${c.field} ${c.from ?? '—'} → ${c.to ?? '—'}`).join(' | '), x.status].map(cell).join(';')));
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="auditoria.csv"').send('\ufeff' + lines.join('\n'));
});

r.get('/auditoria/contador', (req, res) => {
  const f = filters(req.query);
  const rows = AU.list({ ...f, limit: 200 });
  const evs = AU.events();
  const qs = o => '?' + new URLSearchParams(Object.entries({ evento: f.eventId || '', mesa: f.podId || '', q: f.q, op: f.op, errores: f.errors ? '1' : '', ...o }).filter(([, v]) => v !== '' && v != null)).toString();
  res.send(String(adminPage(req, 'Auditoría', html`${tabsA('life')}
    <section class="panel"><p class="small muted">Cada acción del contador de vidas de los torneos tal cual llega, sin juntar toques: quién la hace (el jugador que se identificó en ese móvil y, si había entrado, su cuenta),
      desde qué aparato y qué cambió, con el valor de antes y el de después. También salen las que se rechazaron.</p>
      <form method="get" class="aform audfil">
        <label>Evento<select name="evento"><option value="">Todos</option>${evs.map(e => html`<option value="${e.id}" ${f.eventId === e.id ? 'selected' : ''}>${e.name}</option>`)}</select></label>
        <label>Mesa (id)<input name="mesa" value="${f.podId || ''}" inputmode="numeric"></label>
        <label>Acción<select name="op"><option value="">Todas</option>${Object.entries(AU.OPS).map(([k, v]) => html`<option value="${k}" ${f.op === k ? 'selected' : ''}>${v}</option>`)}</select></label>
        <label>Jugador o texto<input name="q" value="${f.q}"></label>
        <label class="check-inline"><input type="checkbox" name="errores" value="1" ${f.errors ? 'checked' : ''}> Solo rechazadas</label>
        <button class="btn">Filtrar</button> <a class="btn ghost" href="/admin/auditoria/contador.csv${qs({})}">Descargar CSV</a></form></section>
    <section class="panel">${rows.length ? html`<div class="tablewrap"><table class="tbl aud"><thead><tr><th>Cuándo</th><th>Evento · mesa</th><th>Quién</th><th>Acción</th><th>Antes → después</th></tr></thead><tbody>
      ${rows.map(x => html`<tr class="${x.ok ? '' : 'err'}"><td class="nowrap">${when(x.at)}</td>
        <td>${x.ev_name || `#${x.event_id}`}<br><small class="muted"><a href="${qs({ evento: x.event_id, mesa: x.pod_id, antes: '' })}">mesa ${x.table_no ?? '?'}</a>${x.round_no ? ` · ronda ${x.round_no}` : ''}</small></td>
        <td>${x.by_name || '—'}${x.account_name ? html`<br><small>cuenta: ${x.account_name}</small>` : ''}<br><small class="muted">${x.device || ''}</small></td>
        <td>${AU.OPS[x.op] || x.op}<br><small class="muted">${prm(x.params)}</small></td>
        <td>${x.ok ? (x.changes.length ? html`<ul class="audch">${x.changes.map(c => html`<li><b>${c.who}</b> · ${c.field}: <s>${c.from ?? '—'}</s> → <b>${c.to ?? '—'}</b></li>`)}</ul>` : html`<span class="muted">sin cambios</span>`)
          : html`<span class="warn">Rechazada: ${x.error}</span>`}</td></tr>`)}
      </tbody></table></div>
      ${rows.length === 200 ? html`<p><a class="btn ghost" href="${qs({ antes: rows[rows.length - 1].id })}">Más antiguas →</a></p>` : ''}` : html`<p class="muted">No hay acciones con esos filtros.</p>`}</section>`)));
});
r.get('/auditoria/contador.csv', (req, res) => {
  const rows = AU.list({ ...filters(req.query), limit: 20000 });
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['fecha', 'evento', 'mesa', 'ronda', 'jugador', 'cuenta', 'aparato', 'accion', 'parametros', 'cambios', 'ok', 'error'].join(';')]
    .concat(rows.map(x => [new Date(x.at).toISOString(), x.ev_name || x.event_id, x.table_no, x.round_no, x.by_name, x.account_name, x.device, AU.OPS[x.op] || x.op, prm(x.params),
      x.changes.map(chg).join(' | '), x.ok ? 'sí' : 'no', x.error].map(cell).join(';')));
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="auditoria-contador.csv"').send('﻿' + lines.join('\n'));
});

module.exports = r;
