'use strict';
// Partidas casuales: salas compartidas del contador, liga casual (opcional) y «Busco mesa»
const express = require('express');
const { db, feature } = require('../db');
const config = require('../config');
const A = require('../accounts');
const people = require('../people');
const K = require('../casual');
const { html, raw, absUrl } = require('../views/html');
const { page, flash, back, need, off, commTabs, loginHint } = require('./comunidad').helpers;

const r = express.Router();
const js = express.json({ limit: '128kb' });
const hits = new Map();
function slow(req) {
  const now = Date.now();
  const l = (hits.get(req.ip) || []).filter(t => now - t < 60000);
  l.push(now); hits.set(req.ip, l);
  return l.length > 1500;
}
const fail = (res, e) => res.status(e instanceof K.CasualError ? 400 : 500).json({ error: e.message });
const qr = (req, p) => (config.basePath || '') + '/qr.svg?d=' + encodeURIComponent(absUrl(req, p));
const accName = id => { const a = A.get(id); return a ? people.publicName(A.personKey(a)) || A.shown(a) : '—'; };

// ---------- Salas del contador ----------
r.post('/vidas/sala', js, (req, res) => {
  if (slow(req)) return res.status(429).json({ error: 'Espera un momento' });
  try { const x = K.createRoom(req.body.state); res.json({ ...x, url: absUrl(req, '/vidas?sala=' + x.code), qr: qr(req, '/vidas?sala=' + x.code) }); } catch (e) { fail(res, e); }
});
r.get('/vidas/sala/:code.json', (req, res) => {
  try { res.set('Cache-Control', 'no-store').json(K.getRoom(req.params.code)); } catch (e) { res.status(404).json({ error: e.message }); }
});
r.get('/vidas/sala/:code/qr', (req, res) => {
  const code = K.normCode(req.params.code);
  res.json({ url: absUrl(req, '/vidas?sala=' + code), qr: qr(req, '/vidas?sala=' + code) });
});
r.post('/vidas/sala/:code', js, (req, res) => {
  if (slow(req)) return res.status(429).json({ error: 'Demasiados toques seguidos: espera un momento' });
  try { const x = K.saveRoom(req.params.code, req.body.state, req.body.base); res.status(x.conflict ? 409 : 200).json(x); } catch (e) { fail(res, e); }
});
r.get('/vidas/sala/:code/stream', (req, res) => {
  const code = K.normCode(req.params.code);
  try { K.getRoom(code); } catch (e) { return res.status(404).end(); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const on = (c, v) => { if (c === code) res.write(`data: ${v}\n\n`); };
  K.bus.on('room', on);
  const hb = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(hb); K.bus.off('room', on); });
});

// ---------- Liga casual ----------
r.post('/vidas/liga', js, (req, res) => {
  if (!feature('casual_league')) return res.status(404).json({ error: 'La liga casual no está activada' });
  if (slow(req)) return res.status(429).json({ error: 'Espera un momento' });
  try { const g = K.registerGame(req.body.state, req.body.room); const p = '/liga-casual/p/' + g.token; res.json({ token: g.token, url: absUrl(req, p), qr: qr(req, p) }); } catch (e) { fail(res, e); }
});
const month = () => new Date().toLocaleDateString('sv-SE', { timeZone: config.tz }).slice(0, 7);
const MES = m => new Date(m + '-15').toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
r.get('/liga-casual', (req, res) => {
  if (!feature('casual_league')) return off(res, 'La liga casual');
  const m = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : req.query.mes === 'todo' ? null : month();
  const st = K.standings(m);
  const mine = req.account ? K.gamesOf(req.account.id).slice(0, 8) : [];
  res.send(page('Liga casual', html`<h1>Liga casual</h1>${commTabs('ligacasual')}${flash(req)}
    <p class="lead">Partidas sueltas jugadas con el <a href="/vidas">contador de vidas</a>. Al acabar, «Registrar para la liga» y cada jugador lo confirma con su cuenta. Cuenta cuando lo han confirmado todos: 3 puntos por ganar y 1 por jugar.</p>
    <nav class="chips" aria-label="Periodo"><a href="?mes=${month()}" class="${m === month() ? 'on' : ''}">Este mes</a><a href="?mes=todo" class="${!m ? 'on' : ''}">Siempre</a></nav>
    <h2>${m ? MES(m) : 'Clasificación de siempre'}</h2>
    ${st.length ? html`<div class="tablewrap"><table class="tbl"><thead><tr><th>#</th><th>Jugador</th><th class="num">Puntos</th><th class="num">Partidas</th><th class="num">Victorias</th><th class="num">Comandantes</th></tr></thead><tbody>
      ${st.map((x, i) => html`<tr><td>${i + 1}</td><td>${accName(x.account)}</td><td class="num strong">${x.pts}</td><td class="num">${x.games}</td><td class="num">${x.wins}</td><td class="num">${x.cmds}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">Aún no hay partidas confirmadas ${m ? 'este mes' : ''}.</p>`}
    ${mine.length ? html`<h2>Tus últimas partidas</h2><ul class="clist">${mine.map(g => html`<li><b>${g.me.place}º</b> con ${g.me.deck || 'sin comandante'} · ${g.players.map(p => p.name).join(', ')}</li>`)}</ul>` : ''}`));
});
r.get('/liga-casual/p/:token', (req, res) => {
  if (!feature('casual_league')) return off(res, 'La liga casual');
  const g = K.game(req.params.token);
  if (!g) return res.status(404).send(page('No encontrada', html`<h1>Partida no encontrada</h1>`));
  const me = req.account ? g.players.find(p => p.account === req.account.id) : null;
  const done = g.status === 'ok';
  res.send(page('Confirmar partida', html`<h1>Confirmar partida casual</h1>${flash(req)}
    <p class="lead">${done ? 'Confirmada por todos: ya cuenta para la liga.' : g.status === 'expired' ? 'Caducó sin que la confirmasen todos.' : 'Cada jugador entra con su cuenta y pulsa «Soy yo» en su nombre. Cuenta cuando están todos.'}</p>
    ${!req.account && !done ? loginHint(req, 'Entra con tu cuenta para confirmar que jugaste esta partida.') : ''}
    <ol class="cconf">${g.players.map(p => html`<li class="${p.account ? 'ok' : ''}"><span><b>${p.place}º ${p.name}</b>${p.deck ? html`<small>${p.deck}</small>` : ''}${p.killer ? html`<small>eliminado por ${p.killer}</small>` : ''}</span>
      ${p.account ? html`<em>✓ ${accName(p.account)}</em>` : req.account && !me && g.status === 'pending' ? html`<form method="post" action="/liga-casual/p/${g.token}/soy"><input type="hidden" name="slot" value="${p.slot}"><button class="jbtn">Soy yo</button></form>` : html`<em class="muted">sin confirmar</em>`}</li>`)}</ol>
    ${me && g.status === 'pending' ? html`<form method="post" action="/liga-casual/p/${g.token}/no"><button class="jbtn-outline">No era yo (quitar mi confirmación)</button></form>` : ''}
    <p><a href="/liga-casual">← Liga casual</a></p>`));
});
r.post('/liga-casual/p/:token/soy', (req, res) => {
  if (!feature('casual_league')) return off(res, 'La liga casual');
  if (!need(req, res)) return;
  try { const g = K.claimSlot(req.params.token, req.body.slot, req.account.id); back(res, `/liga-casual/p/${req.params.token}`, g.status === 'ok' ? 'Confirmada por todos: ya cuenta para la liga' : 'Confirmado. Falta el resto de la mesa.'); }
  catch (e) { back(res, `/liga-casual/p/${req.params.token}`, e.message, true); }
});
r.post('/liga-casual/p/:token/no', (req, res) => {
  if (!need(req, res)) return;
  K.unclaim(req.params.token, req.account.id);
  back(res, `/liga-casual/p/${req.params.token}`, 'Quitada tu confirmación');
});

// ---------- Busco mesa ----------
const BRL = [['any', 'Cualquier bracket'], ['1', 'Bracket 1'], ['2', 'Bracket 2'], ['3', 'Bracket 3'], ['4', 'Bracket 4'], ['5', 'Bracket 5']];
const BR = Object.fromEntries(BRL);
const dayLabel = d => { const t = new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }); return t.charAt(0).toUpperCase() + t.slice(1); };
r.get('/busco-mesa', (req, res) => {
  if (!feature('lfg')) return off(res, 'Busco mesa');
  const list = K.lfgList();
  const me = req.account && req.account.id;
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: config.tz });
  res.send(page('Busco mesa', html`<h1>Busco mesa</h1>${commTabs('buscomesa')}${flash(req)}
    <p class="lead">Queda para jugar casual en la tienda: pon día, hora y bracket, y que se apunte quien quiera.</p>
    ${list.length ? html`<div class="lfg">${list.map(l => {
      const full = l.joined.length >= l.slots, inn = me && l.joined.includes(me), own = me === l.account_id;
      return html`<article class="lfgc ${full ? 'full' : ''}"><header><b>${dayLabel(l.day)}${l.time ? ` · ${l.time}` : ''}</b><span class="pill">${BR[l.bracket] || l.bracket}</span></header>
        ${l.note ? html`<p>${l.note}</p>` : ''}
        <p class="small">${l.joined.length} de ${l.slots}: ${l.joined.map(accName).join(', ')}</p>
        ${!me ? '' : own ? html`<form method="post" action="/busco-mesa/${l.id}/cancelar"><button class="jbtn-outline">Cancelar la quedada</button></form>`
          : inn ? html`<form method="post" action="/busco-mesa/${l.id}/salir"><button class="jbtn-outline">Ya no voy</button></form>`
          : full ? html`<em class="muted">Completa</em>` : html`<form method="post" action="/busco-mesa/${l.id}/apuntar"><button class="jbtn">Me apunto</button></form>`}</article>`;
    })}</div>` : html`<p class="muted">No hay quedadas. ¡Crea la primera!</p>`}
    <h2>Crear quedada</h2>
    ${me ? html`<form method="post" action="/busco-mesa" class="lfgform">
      <label>Día<input type="date" name="day" required min="${today}" value="${today}"></label>
      <label>Hora<input type="time" name="time" value="18:00"></label>
      <label>Bracket<select name="bracket">${BRL.map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
      <label>Plazas<select name="slots">${[3, 4, 5, 6].map(n => html`<option ${n === 4 ? 'selected' : ''}>${n}</option>`)}</select></label>
      <label class="wide">Nota (opcional)<input name="note" maxlength="200" placeholder="Por ejemplo: traigo mazos para prestar"></label>
      <button class="jbtn">Crear</button></form>` : loginHint(req, 'Entra con tu cuenta para crear una quedada o apuntarte.')}`));
});
const lfgAct = fn => (req, res) => {
  if (!feature('lfg')) return off(res, 'Busco mesa');
  if (!need(req, res)) return;
  try { const msg = fn(req); back(res, '/busco-mesa', msg); } catch (e) { back(res, '/busco-mesa', e.message, true); }
};
r.post('/busco-mesa', lfgAct(req => { K.lfgCreate(req.account.id, req.body); return 'Quedada creada'; }));
r.post('/busco-mesa/:id/apuntar', lfgAct(req => { K.lfgJoin(Number(req.params.id), req.account.id, true); return 'Apuntado'; }));
r.post('/busco-mesa/:id/salir', lfgAct(req => { K.lfgJoin(Number(req.params.id), req.account.id, false); return 'Te has desapuntado'; }));
r.post('/busco-mesa/:id/cancelar', lfgAct(req => { K.lfgCancel(Number(req.params.id), req.account.id); return 'Quedada cancelada'; }));

// ---------- Avisos en el móvil ----------
const path = require('path');
r.get('/sw.js', (req, res) => {
  res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': (config.basePath || '') + '/' });
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'sw.js'));
});
r.get('/push/key', (req, res) => res.json({ key: require('../push').publicKey() }));
r.post('/push/alta', js, (req, res) => {
  if (slow(req)) return res.status(429).json({ error: 'Espera un momento' });
  const C = require('../commander');
  const ev = C.getEvent(Number(req.body.event));
  const pid = Number(req.body.player);
  if (!ev || !ev.public || !db.prepare('SELECT 1 FROM cmd_players WHERE id = ? AND event_id = ?').get(pid, ev.id)) return res.status(404).json({ error: 'Jugador no encontrado' });
  try { require('../push').subscribe(req.body.sub, ev.id, pid); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});
r.post('/push/baja', js, (req, res) => { require('../push').unsubscribe(req.body.endpoint); res.json({ ok: true }); });

// ---------- Ranking de comandantes de la tienda ----------
r.get('/comandantes', (req, res) => {
  const X = require('../cmdstats');
  const src = ['torneo', 'casual'].includes(req.query.de) ? req.query.de : null;
  const list = X.byCommander({ source: src });
  const mm = ms => (ms == null ? '—' : `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`);
  res.send(page('Comandantes', html`<h1>Comandantes de la tienda</h1>${commTabs('comandantes')}
    <p class="lead">Cómo les va a los comandantes en las mesas de la tienda: victorias, eliminaciones (del contador de vidas) y lo que tarda cada turno.</p>
    <nav class="chips" aria-label="Partidas"><a href="?" class="${!src ? 'on' : ''}">Todas</a><a href="?de=torneo" class="${src === 'torneo' ? 'on' : ''}">Torneos</a>${feature('casual_league') ? html`<a href="?de=casual" class="${src === 'casual' ? 'on' : ''}">Liga casual</a>` : ''}</nav>
    ${list.length ? html`<div class="tablewrap"><table class="tbl cmdrank"><thead><tr><th>#</th><th>Comandante</th><th class="num">Mesas</th><th class="num">Victorias</th><th class="num">% victorias</th><th class="num">Eliminaciones</th><th class="num">Jugadores</th><th class="num">Turno medio</th></tr></thead><tbody>
      ${list.map((c, i) => html`<tr><td>${i + 1}</td><td><b>${c.name}</b></td><td class="num">${c.games}</td><td class="num strong">${c.wins}</td><td class="num">${Math.round(c.rate * 100)}%</td><td class="num">${c.kills}</td><td class="num">${c.players}</td><td class="num">${mm(c.avgTurn)}</td></tr>`)}</tbody></table></div>
      <p class="small muted">Solo cuentan mesas con resultado y el comandante que cada jugador puso en el torneo. El turno medio sale de «Pasar turno» en el contador.</p>`
    : html`<p class="muted">Aún no hay mesas con comandante y resultado.</p>`}`));
});

module.exports = r;
module.exports.accName = accName;
