'use strict';
// Comunidad (staff): recompensas, moderación de momentos y resumen de porra, cambios y préstamos
const express = require('express');
const { db, feature } = require('../db');
const melee = require('../melee');
const people = require('../people');
const K = require('../community');
const badges = require('../badges');
const CA = require('../casual');
const { html, adminPage, fmtDay } = require('../views/html');

const r = express.Router();
const send = (res, body) => res.send(String(body));
const back = (res, url, msg, err = false) => { const [u, h] = String(url).split('#'); res.redirect(u + (u.includes('?') ? '&' : '?') + (err ? 'err=' : 'ok=') + encodeURIComponent(msg) + (h ? '#' + h : '')); };
const gShort = g => (g === 'commander' ? 'Commander' : melee.gameInfo(g).short);
const STB = { active: 'Activa', claimed: 'Cobrada · falta entregar', delivered: 'Entregada', cancelled: 'Cancelada' };

r.get('/comunidad', (req, res) => {
  const bs = feature('bounties') ? K.bounties() : [];
  const sug = feature('bounties') ? K.bountySuggestions() : [];
  const pend = feature('moments') ? K.moments({ status: 'pending' }) : [];
  const recent = feature('moments') ? K.moments({ status: 'approved', limit: 12 }) : [];
  const tc = K.tradeCount();
  const loans = db.prepare("SELECT status, COUNT(*) n FROM loan_requests GROUP BY status").all().reduce((o, x) => ({ ...o, [x.status]: x.n }), {});
  const preds = db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT account_id) a FROM predictions").get();
  const games = [...new Set(db.prepare('SELECT DISTINCT game FROM tournaments').all().map(x => x.game))];
  send(res, adminPage(req, 'Comunidad', html`
    <div class="stats"><div><b>${bs.filter(b => b.status === 'active').length}</b><span>recompensas activas</span></div>
      <div><b>${preds.n}</b><span>pronósticos de ${preds.a} jugadores</span></div>
      <div><b>${tc.have + tc.want}</b><span>cartas en Tengo / Busco</span></div>
      <div><b>${(loans.accepted || 0) + (loans.returned || 0)}</b><span>préstamos aceptados</span></div></div>
    <p class="small muted">Activa o desactiva cada parte en <a href="/admin/ajustes">Ajustes</a>. La parte pública está en <a href="/comunidad" target="_blank">/comunidad</a>.</p>

    ${feature('moments') ? html`<section class="panel ${pend.length ? 'live' : ''}" id="momentos"><h2>Momentos por revisar (${pend.length})</h2>
      ${pend.length ? html`<div class="modq">${pend.map(m => html`<figure class="modi"><a href="/momentos/f/${m.id}" target="_blank"><img src="/momentos/f/${m.id}" alt="" loading="lazy"></a>
        <figcaption><b>${m.who}</b>${m.caption ? html`<span>«${m.caption}»</span>` : ''}${m.event_label ? html`<small class="muted">${m.event_label}</small>` : ''}<small class="muted">${fmtDay(m.created_at)}</small>
        <div class="inline"><form method="post" action="/admin/comunidad/momento/${m.id}/approved"><button class="btn small">Publicar en la TV</button></form>
          <form method="post" action="/admin/comunidad/momento/${m.id}/rejected"><button class="btn small ghost">No publicar</button></form>
          <form method="post" action="/admin/comunidad/momento/${m.id}/delete" onsubmit="return confirm('¿Borrar la foto?')"><button class="link danger">Borrar</button></form></div></figcaption></figure>`)}</div>`
        : html`<p class="muted">Nada pendiente. Las fotos aprobadas salen en la TV durante 2 días.</p>`}
      ${recent.length ? html`<details><summary>Publicadas (${recent.length})</summary><div class="modq">${recent.map(m => html`<figure class="modi"><img src="/momentos/f/${m.id}" alt="" loading="lazy"><figcaption><b>${m.who}</b>${m.caption ? html`<span>«${m.caption}»</span>` : ''}
        <div class="inline"><form method="post" action="/admin/comunidad/momento/${m.id}/rejected"><button class="btn small ghost">Quitar de la TV</button></form></div></figcaption></figure>`)}</div></details>` : ''}
    </section>` : ''}

    ${feature('bounties') ? html`<section class="panel" id="recompensas"><h2>Recompensas («Se busca»)</h2>
      <p class="small muted">Elige a un jugador y qué gana quien le derrote. Se cobra sola la primera vez que alguien le gane una partida (o una mesa de Commander) en un torneo de la tienda desde hoy. Sale en la web, en la TV y en su perfil.</p>
      ${sug.length ? html`<p><b>Sugerencias:</b> ${sug.map(s => html`<form method="post" action="/admin/comunidad/recompensa" class="inline sugb"><input type="hidden" name="person_key" value="${s.key}"><input type="hidden" name="reward" value="Un sobre">
        <button class="btn small ghost" title="${s.why}">${s.name} <small>(${s.why})</small></button></form>`)}</p>` : ''}
      <form method="post" action="/admin/comunidad/recompensa" class="grid2">
        <label>Jugador<span class="ppick"><input class="person-pick" data-field="person_key" name="label" placeholder="Nombre o usuario de Melee" autocomplete="off" required><input type="hidden" name="person_key"></span></label>
        <label>Recompensa<input name="reward" placeholder="Un sobre, una funda, 5 € en tienda…" maxlength="80" required></label>
        <label>Nota (opcional)<input name="note" maxlength="200" placeholder="Invicto en las 3 últimas semanas"></label>
        <label>Solo en<select name="game"><option value="">Cualquier juego</option>${games.map(g => html`<option value="${g}">${gShort(g)}</option>`)}<option value="commander">Commander</option></select></label>
        <div class="full"><button class="btn">Poner recompensa</button></div></form>
      ${bs.length ? html`<div class="tablewrap"><table class="tbl"><thead><tr><th>Se busca</th><th>Recompensa</th><th>Estado</th><th>Cobrada por</th><th></th></tr></thead><tbody>
        ${bs.map(b => html`<tr class="${b.status === 'cancelled' ? 'dim' : ''}"><td><a href="/admin/jugadores/${encodeURIComponent(b.person_key)}">${people.publicName(b.person_key)}</a>${b.game ? html` <small class="muted">${gShort(b.game)}</small>` : ''}<br><small class="muted">desde ${fmtDay(b.created_at)}</small></td>
          <td>${b.reward}${b.note ? html`<br><small class="muted">${b.note}</small>` : ''}</td><td><span class="pill ${b.status === 'claimed' ? 'warn' : b.status === 'active' ? 'new' : ''}">${STB[b.status]}</span></td>
          <td>${b.claimed_key ? html`<a href="/admin/jugadores/${encodeURIComponent(b.claimed_key)}">${people.publicName(b.claimed_key)}</a><br><small class="muted">${b.claimed_event || ''}</small>` : ''}</td>
          <td class="nowrap">${b.status === 'claimed' ? html`<form method="post" action="/admin/comunidad/recompensa/${b.id}/delivered" class="inline"><button class="btn small">Entregada</button></form>` : ''}
            ${b.status === 'active' ? html`<form method="post" action="/admin/comunidad/recompensa/${b.id}/cancelled" class="inline" onsubmit="return confirm('¿Cancelar la recompensa?')"><button class="link danger">Cancelar</button></form>` : ''}
            ${b.status === 'claimed' ? html`<form method="post" action="/admin/comunidad/recompensa/${b.id}/active" class="inline"><button class="link">No vale, reactivar</button></form>` : ''}</td></tr>`)}</tbody></table></div>` : ''}
    </section>` : ''}

    ${feature('casual_league') ? (() => { const gs = CA.allGames(60); const ST = { pending: 'Falta confirmar', ok: 'Cuenta', expired: 'Caducada' };
      return html`<section class="panel" id="liga-casual"><h2>Liga casual</h2>
      <p class="small muted">Partidas registradas desde el contador casual. Solo cuentan las confirmadas por todos. Si alguna es trampa, bórrala.</p>
      ${gs.length ? html`<div class="tablewrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Jugadores</th><th>Estado</th><th></th></tr></thead><tbody>${gs.map(g => html`<tr>
        <td class="nowrap">${fmtDay(g.created_at)}</td><td>${g.players.map(p => `${p.place}º ${p.name}`).join(' · ')}</td><td><span class="pill ${g.status === 'ok' ? 'new' : ''}">${ST[g.status]}</span> <small class="muted">${g.claimed}/${g.players.length}</small></td>
        <td><form method="post" action="/admin/comunidad/casual/${g.id}/borrar" class="inline" onsubmit="return confirm('¿Borrar esta partida de la liga?')"><button class="link danger">Borrar</button></form></td></tr>`)}</tbody></table></div>` : html`<p class="muted">Aún no hay partidas.</p>`}</section>`; })() : ''}

    ${feature('lfg') ? (() => { const ls = CA.lfgList(); return html`<section class="panel"><h2>Busco mesa</h2>${ls.length ? html`<ul>${ls.map(l => html`<li>${l.day}${l.time ? ' ' + l.time : ''} · ${l.joined.length}/${l.slots} · ${l.note || ''}
      <form method="post" action="/admin/comunidad/lfg/${l.id}/cancelar" class="inline" onsubmit="return confirm('¿Cancelar la quedada?')"><button class="link danger">Cancelar</button></form></li>`)}</ul>` : html`<p class="muted">No hay quedadas abiertas.</p>`}</section>`; })() : ''}

    ${feature('badges') ? html`<section class="panel"><h2>Ranking de experiencia</h2><ol class="xpadmin">${badges.leaderboard(10).map(x => html`<li><a href="/admin/jugadores/${encodeURIComponent(x.key)}">${x.name}</a> · nivel ${x.level} (${x.title}) · ${x.xp} XP · ${x.earned} insignias</li>`)}</ol></section>` : ''}`));
});
r.post('/comunidad/casual/:id/borrar', (req, res) => { CA.deleteGame(Number(req.params.id)); badges.invalidate && badges.invalidate(); back(res, '/admin/comunidad#liga-casual', 'Partida borrada'); });
r.post('/comunidad/lfg/:id/cancelar', (req, res) => { CA.lfgCancel(Number(req.params.id), null, true); back(res, '/admin/comunidad', 'Quedada cancelada'); });
r.post('/comunidad/recompensa', (req, res) => {
  try { K.addBounty(req.body, req.user.username); badges.invalidate(); back(res, '/admin/comunidad#recompensas', 'Recompensa puesta'); }
  catch (e) { back(res, '/admin/comunidad#recompensas', e.message, true); }
});
r.post('/comunidad/recompensa/:id/:st', (req, res) => {
  const st = ['delivered', 'cancelled', 'active'].includes(req.params.st) ? req.params.st : null;
  if (st) K.setBounty(Number(req.params.id), st);
  badges.invalidate();
  back(res, '/admin/comunidad#recompensas', { delivered: 'Marcada como entregada', cancelled: 'Recompensa cancelada', active: 'Reactivada' }[st] || 'Nada');
});
r.post('/comunidad/momento/:id/:st', (req, res) => {
  const st = ['approved', 'rejected', 'delete'].includes(req.params.st) ? req.params.st : null;
  if (st) K.reviewMoment(Number(req.params.id), st, req.user.username);
  badges.invalidate();
  back(res, '/admin/comunidad#momentos', { approved: 'Publicada en la TV', rejected: 'No se publicará', delete: 'Foto borrada' }[st] || 'Nada');
});

module.exports = r;
