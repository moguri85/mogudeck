'use strict';
// Cuentas de jugadores: registro, entrada, mi cuenta, reclamar ficha, inscripción en Commander y mis mazos
const express = require('express');
const { db, feature } = require('../db');
const A = require('../accounts');
const C = require('../commander');
const people = require('../people');
const melee = require('../melee');
const I = require('../identity');
const { html, raw, publicPage, money, fmtDate } = require('../views/html');
const { notifyPromoted } = require('../waitnotify');

const r = express.Router();
const page = (title, body) => String(publicPage(title, html`<div class="acct">${body}</div>`));
const safeNext = n => (typeof n === 'string' && /^\/(?!\/)[^\s]*$/.test(n) ? n : '/cuenta');
const need = (req, res) => { if (req.account) return true; res.redirect('/entrar?next=' + encodeURIComponent(req.originalUrl)); return false; };
const flash = req => (req.query.ok ? html`<div class="aflash ok" role="status">${String(req.query.ok).slice(0, 200)}</div>` : req.query.err ? html`<div class="aflash err" role="alert">${String(req.query.err).slice(0, 200)}</div>` : '');
const back = (res, url, msg, err = false) => { const [u, h] = String(url).split('#'); res.redirect(u + (u.includes('?') ? '&' : '?') + (err ? 'err=' : 'ok=') + encodeURIComponent(msg) + (h ? '#' + h : '')); };

// ---------- Entrar / registrarse ----------
function loginForm(req, err, email = '') {
  return page('Entrar', html`
    <div class="authcard">
      <h1>Entra en tu cuenta</h1>
      <p class="muted">Para apuntarte a torneos, ver tu mesa sin buscarte y guardar tus mazos.</p>
      ${err ? html`<div class="aflash err" role="alert">${err}</div>` : flash(req)}
      <form method="post" action="/entrar" class="aform">
        <input type="hidden" name="next" value="${safeNext(req.query.next || req.body?.next)}">
        <label>Email<input type="email" name="email" value="${email}" autocomplete="email" required inputmode="email"></label>
        <label>Contraseña<input type="password" name="password" autocomplete="current-password" required></label>
        <button class="jbtn big">Entrar</button>
      </form>
      <p class="aalt">¿Aún no tienes cuenta? <a href="/registro${req.query.next ? `?next=${encodeURIComponent(safeNext(req.query.next))}` : ''}">Crear cuenta</a></p>
      <p class="small muted">¿Has olvidado la contraseña? Pide en la tienda un enlace para cambiarla.</p>
    </div>`);
}
r.get('/entrar', (req, res) => (req.account ? res.redirect(safeNext(req.query.next)) : res.send(loginForm(req))));
r.post('/entrar', (req, res) => {
  try { A.login(req, res, req.body); res.redirect(safeNext(req.body.next)); }
  catch (e) { res.status(400).send(loginForm(req, e.message, String(req.body.email || '').slice(0, 120))); }
});

function registerForm(req, err, v = {}) {
  return page('Crear cuenta', html`
    <div class="authcard">
      <h1>Crea tu cuenta</h1>
      <p class="muted">Gratis. Con ella te apuntas a los torneos de Commander desde aquí, la web te reconoce en tus torneos y puedes guardar tus mazos.</p>
      ${err ? html`<div class="aflash err" role="alert">${err}</div>` : ''}
      <form method="post" action="/registro" class="aform">
        <input type="hidden" name="next" value="${safeNext(req.query.next || req.body?.next)}">
        <label>Nombre y apellido<input name="name" value="${v.name || ''}" autocomplete="name" required maxlength="60" placeholder="Como te conocen en la tienda"><small class="muted">Es el nombre que verán los demás en las mesas.</small></label>
        <label>Nick (opcional)<input name="nick" value="${v.nick || ''}" maxlength="24" autocomplete="nickname" autocapitalize="none" placeholder="p. ej. ElDeLosGoblins"><small class="muted">Sin espacios. Si la tienda muestra nicks en las mesas, saldrá este.</small></label>
        <label>Email<input type="email" name="email" value="${v.email || ''}" autocomplete="email" required inputmode="email"></label>
        <label>Contraseña<input type="password" name="password" autocomplete="new-password" required minlength="8"><small class="muted">Mínimo 8 caracteres.</small></label>
        <label class="check-inline"><input type="checkbox" name="ok" value="1" required> Acepto que la tienda guarde mi nombre y email para gestionar los torneos. Puedo borrar la cuenta cuando quiera.</label>
        <button class="jbtn big">Crear cuenta</button>
      </form>
      <p class="aalt">¿Ya tienes cuenta? <a href="/entrar">Entrar</a></p>
    </div>`);
}
r.get('/registro', (req, res) => (req.account ? res.redirect('/cuenta') : res.send(registerForm(req))));
r.post('/registro', (req, res) => {
  try {
    if (!req.body.ok) throw new A.AccountError('Tienes que aceptar el uso de tus datos para crear la cuenta.');
    A.register(req, res, req.body);
    const n = safeNext(req.body.next);
    res.redirect(n === '/cuenta' ? '/cuenta?bienvenida=1' : n);
  } catch (e) { res.status(400).send(registerForm(req, e.message, { name: String(req.body.name || '').slice(0, 60), nick: String(req.body.nick || '').slice(0, 24), email: String(req.body.email || '').slice(0, 120) })); }
});
r.post('/salir', (req, res) => { A.logout(req, res); res.redirect('/'); });

// Cambiar la contraseña con el enlace que da la tienda
r.get('/cuenta/nueva-clave/:t', (req, res) => {
  const acc = A.byResetToken(req.params.t);
  res.send(page('Nueva contraseña', html`<div class="authcard"><h1>Nueva contraseña</h1>
    ${acc ? html`<p class="muted">Cuenta de ${acc.name} (${acc.email}).</p>
      <form method="post" action="/cuenta/nueva-clave/${req.params.t}" class="aform"><label>Contraseña nueva<input type="password" name="password" autocomplete="new-password" minlength="8" required></label><button class="jbtn big">Guardar y entrar</button></form>`
    : html`<p>El enlace ha caducado o ya se usó. Pide otro en la tienda.</p>`}</div>`));
});
r.post('/cuenta/nueva-clave/:t', (req, res) => {
  try { A.useReset(req, res, req.params.t, req.body.password); back(res, '/cuenta', 'Contraseña cambiada'); }
  catch (e) { back(res, `/cuenta/nueva-clave/${req.params.t}`, e.message, true); }
});

// ---------- Mi cuenta ----------
function myEvents(acc) {
  const evs = db.prepare("SELECT * FROM cmd_events WHERE public = 1 AND status != 'finished' ORDER BY COALESCE(start_date, created_at)").all();
  return evs.map(ev => ({ ev, me: C.entryOf(ev.id, acc, acc.person) }))
    .filter(x => (x.me && x.me.dropped_round == null) || (x.ev.self_signup && x.ev.status === 'setup'));
}
function waitPos(eventId, playerId) {
  return C.waitlisted(eventId).findIndex(w => w.id === playerId) + 1;
}

r.get('/cuenta', (req, res) => {
  if (!need(req, res)) return;
  const acc = req.account;
  const linked = A.linked(acc);
  const prof = people.profile(acc.person);
  const claims = A.claims(acc.id);
  const pending = claims.filter(c => c.status === 'pending');
  const sug = !linked && !pending.length ? people.suggest(acc.name, { limit: 5 }).filter(p => !p.key.startsWith('a:') && !A.ownerOf(p.key)) : [];
  const evs = myEvents(acc);
  const mine = evs.filter(x => x.me && x.me.dropped_round == null);
  const open = evs.filter(x => !(x.me && x.me.dropped_round == null));
  const myDecks = A.decks(acc.id);
  const tg = require('../tgbot').enabled();
  res.send(page('Mi cuenta', html`
    ${req.query.bienvenida ? html`<div class="aflash ok" role="status">¡Cuenta creada! Si ya has jugado en la tienda, dinos cuál es tu ficha para juntar tu historial.</div>` : flash(req)}
    <div class="ahead"><div class="avatar">${acc.name.slice(0, 1).toUpperCase()}</div><div><h1>${acc.name}</h1><p class="muted">${acc.nick ? html`@${acc.nick} · ` : ''}${acc.email}</p></div></div>
    ${(() => {
      const K = require('../community'), B = require('../badges'), CM = require('./comunidad');
      const nw = feature('badges') ? B.fresh(acc.id, acc.person) : [];
      const st = feature('badges') ? B.of(acc.person) : null;
      const pend = feature('loans') ? K.loanPending(acc.id) : 0;
      const tm = feature('trades') ? K.tradeMatches(acc.id).length : 0;
      const pr = feature('porra') ? K.porraStats(acc.id) : null;
      const R = require('../rivals').rivals(acc.person);
      const links = [
        pend ? html`<a class="qchip hot" href="/prestamos">${pend} ${pend === 1 ? 'solicitud' : 'solicitudes'} de préstamo</a>` : '',
        tm ? html`<a class="qchip" href="/cambios">${tm} ${tm === 1 ? 'cruce' : 'cruces'} en Tengo / Busco</a>` : '',
        pr && pr.total ? html`<a class="qchip" href="/porra#ranking">Porra: ${pr.pts} pts</a>` : '',
        st && st.loyalty && st.loyalty.weekStreak >= 2 ? html`<a class="qchip ${st.loyalty.playedThisWeek ? '' : 'hot'}" href="/">Racha: ${st.loyalty.weekStreak} semanas seguidas${st.loyalty.playedThisWeek ? '' : ' · juega esta semana para no perderla'}</a>` : '',
        st && st.loyalty && st.loyalty.last && Date.now() - Date.parse(st.loyalty.last) > 21 * 864e5 ? html`<a class="qchip hot" href="/">Hace ${Math.floor((Date.now() - Date.parse(st.loyalty.last)) / 864e5)} días de tu último torneo: ¡te esperamos!</a>` : '',
        R.nemesis ? html`<a class="qchip" href="/vs/${encodeURIComponent(acc.person)}/${encodeURIComponent(R.nemesis.key)}">Tu némesis: ${people.publicName(R.nemesis.key)}</a>` : '',
      ].filter(Boolean);
      return html`${nw.length ? html`<div class="newbadges" role="status"><b>¡Nuevo logro!</b>${nw.map(b => html`<span>${CM.medal(b, 40)}${b.name} · ${b.tierName}</span>`)}</div>` : ''}
        ${st ? html`${CM.featuredChips(acc.person)}<a class="lvlwrap" href="/logros">${CM.levelCard(st, { compact: true })}</a>` : ''}
        ${links.length ? html`<div class="qchips">${links}</div>` : ''}`;
    })()}

    <section class="acard"><h2>Tus torneos</h2>
      ${mine.length ? html`<div class="evlist">${mine.map(({ ev, me }) => html`<div class="myev">
        <a href="/commander/${ev.id}"><b>${ev.name}</b><small>${fmtDate(ev.start_date)}${ev.status === 'running' ? ' · en juego' : ''}</small></a>
        <span class="mystate">${me.waitlist ? html`<span class="stchip st-wait">En espera · puesto ${waitPos(ev.id, me.id)}</span>` : html`<span class="stchip st-setup">Apuntado</span>`}
          ${ev.price_cents != null && !me.waitlist ? (me.paid ? html`<span class="stchip st-paid">Pagado</span>` : html`<span class="stchip st-unpaid">Pago pendiente · ${money(ev.price_cents)}</span>`) : ''}
          ${!me.waitlist && ev.status === 'setup' ? (me.deck_value_cents != null || me.deck_list ? html`<a class="stchip st-setup" href="/valor-mazo?evento=${ev.id}">Mazo: ${me.deck || 'registrado'}</a>` : html`<a class="stchip st-unpaid" href="/commander/${ev.id}#apuntarse">Falta registrar el mazo</a>`) : ''}</span>
        ${ev.status === 'setup' && !me.paid ? html`<form method="post" action="/commander/${ev.id}/borrarme" onsubmit="return confirm('¿Borrarte de ${ev.name}?')"><button class="linkbtn">Borrarme</button></form>` : ''}
      </div>`)}</div>` : html`<p class="muted">No estás apuntado a ningún torneo ahora mismo.</p>`}
      ${open.length ? html`<h3>Inscripción abierta</h3><div class="evlist">${open.map(({ ev }) => {
        const n = C.activeCount(ev.id), full = ev.max_players && n >= ev.max_players;
        return html`<div class="myev"><a href="/commander/${ev.id}"><b>${ev.name}</b><small>${fmtDate(ev.start_date)}${ev.price_cents != null ? ` · ${money(ev.price_cents)}` : ''} · ${ev.max_players ? `${n}/${ev.max_players} plazas` : `${n} apuntados`}</small></a>
          <form method="post" action="/commander/${ev.id}/apuntarme"><input type="hidden" name="next" value="/cuenta"><button class="jbtn">${full ? 'Lista de espera' : 'Apuntarme'}</button></form></div>`;
      })}</div>` : ''}
    </section>

    <section class="acard" id="ficha"><h2>Tu ficha de jugador</h2>
      ${linked || (prof && prof.events) ? html`<p>Tu cuenta está unida a <b>${prof ? prof.name : acc.name}</b>${prof ? html`: ${prof.events} ${prof.events === 1 ? 'evento' : 'eventos'}, ${prof.w}-${prof.l}-${prof.d}${prof.titles ? `, ${prof.titles} ${prof.titles === 1 ? 'torneo ganado' : 'torneos ganados'}` : ''}` : ''}.</p>
        ${prof && feature('profiles') ? html`<a class="jbtn-outline" href="/jugador/${encodeURIComponent(acc.person)}">Ver mi historial</a>` : ''}` : ''}
      ${pending.length ? html`<div class="claimlist">${pending.map(c => html`<div class="payrow"><span>Has pedido unir la ficha <b>${c.label || c.person_key}</b> · falta que la tienda lo confirme</span>
        <form method="post" action="/cuenta/reclamar/${c.id}/cancelar"><button class="linkbtn">Cancelar</button></form></div>`)}</div>` : ''}
      ${!linked ? html`
        <p class="muted">Si has jugado torneos en la tienda (en Melee o en Commander), busca tu ficha y la tienda confirmará que eres tú. Así tu historial y tus puntos quedan en tu cuenta.</p>
        ${sug.length ? html`<p><b>¿Eres alguno de estos?</b></p><div class="sugs">${sug.map(p => claimBtn(p))}</div>` : ''}
        <form class="claimsearch" method="get" action="/cuenta/buscar-ficha"><label for="cq">Buscar mi ficha</label><div class="who-row"><input id="cq" name="q" placeholder="Tu nombre, apellido o usuario de Melee" minlength="2" required><button class="jbtn">Buscar</button></div></form>`
      : html`<p class="small muted">¿Hay otra ficha tuya con otro nombre? <a href="/cuenta/buscar-ficha">Búscala</a> y la tienda la une.</p>`}
    </section>

    ${tg ? html`<section class="acard"><h2>Avisos por Telegram</h2><p class="muted">Te escribimos cuando salgan tus mesas y si consigues plaza desde la lista de espera.</p>
      <a class="tgbtn" href="/avisos/${encodeURIComponent(acc.person)}?n=${encodeURIComponent(acc.name)}" target="_blank" rel="noopener">${raw('<svg class="ico-tg" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 4 3 11l6 2 2 6 3-4 5 4 2-15Z"/><path d="m9 13 9-6"/></svg>')}Activar avisos en Telegram</a></section>` : ''}

    <section class="acard"><h2>Mis mazos</h2>
      ${myDecks.length ? html`<div class="evlist">${myDecks.map(d => html`<div class="myev"><a href="/valor-mazo?mazo=${d.id}"><b>${d.name}</b><small>${[d.commander && d.commander !== d.name ? d.commander : '', d.value_cents != null ? money(d.value_cents) : '', d.bracket ? `bracket ${d.bracket === 2 ? '1-2' : d.bracket}` : '', d.legal === 0 ? 'no legal' : ''].filter(Boolean).join(' · ')}</small></a>
        <form method="post" action="/cuenta/mazos/${d.id}/borrar" onsubmit="return confirm('¿Borrar ${d.name}?')"><button class="linkbtn">Borrar</button></form></div>`)}</div>`
      : html`<p class="muted">Aún no has guardado ningún mazo. En <a href="/valor-mazo">Analizar mazo</a>, tras analizar una lista, pulsa «Guardar en mis mazos».</p>`}
    </section>

    <section class="acard"><h2>Datos de la cuenta</h2>
      <form method="post" action="/cuenta/datos" class="aform two"><label>Nombre<input name="name" value="${acc.name}" maxlength="60" required></label>
        <label>Nick<input name="nick" value="${acc.nick || ''}" maxlength="24" autocapitalize="none" placeholder="Opcional"></label><button class="jbtn-outline">Guardar</button></form>
      <details><summary>Cambiar contraseña</summary><form method="post" action="/cuenta/clave" class="aform">
        <label>Contraseña actual<input type="password" name="current" autocomplete="current-password" required></label>
        <label>Contraseña nueva<input type="password" name="next" autocomplete="new-password" minlength="8" required></label><button class="jbtn-outline">Cambiar</button></form></details>
      <div class="arow2"><form method="post" action="/salir"><button class="jbtn-outline">Cerrar sesión</button></form>
        <details class="dangerz"><summary>Borrar mi cuenta</summary><p class="small muted">Se borra tu cuenta con tus mazos guardados, tu Tengo / Busco, tus mazos para prestar y tus pronósticos. Tu historial de torneos sigue en la tienda, pero ya no estará unido a ti.</p>
          <form method="post" action="/cuenta/borrar" onsubmit="return confirm('¿Borrar tu cuenta? No se puede deshacer.')"><button class="btn danger-ghost small">Borrar mi cuenta</button></form></details></div>
    </section>`));
});

function claimBtn(p) {
  return html`<form method="post" action="/cuenta/reclamar" class="sug"><input type="hidden" name="key" value="${p.key}"><input type="hidden" name="label" value="${p.name}">
    <span><b>${p.name}</b><small>${[p.usernames && p.usernames.length ? '@' + p.usernames[0] : '', `${p.events} ${p.events === 1 ? 'evento' : 'eventos'}`, (p.games || []).map(g => g === 'commander' ? 'Commander' : melee.gameInfo(g).short).join(', ')].filter(Boolean).join(' · ')}</small></span>
    <button class="jbtn-outline">Soy yo</button></form>`;
}

r.get('/cuenta/buscar-ficha', (req, res) => {
  if (!need(req, res)) return;
  const q = String(req.query.q || '').slice(0, 60);
  const found = q.length >= 2 ? people.suggest(q, { limit: 12 }).filter(p => !p.key.startsWith('a:') && I.resolve(p.key) !== req.account.person) : [];
  res.send(page('Buscar mi ficha', html`<p><a href="/cuenta#ficha">← Mi cuenta</a></p><h1>Buscar mi ficha</h1>
    <p class="muted">Elige tu ficha y la tienda confirmará que eres tú. Mientras tanto puedes usar la cuenta con normalidad.</p>
    <form method="get" action="/cuenta/buscar-ficha" class="claimsearch"><div class="who-row"><input name="q" value="${q}" placeholder="Tu nombre, apellido o usuario de Melee" minlength="2" required autofocus><button class="jbtn">Buscar</button></div></form>
    ${q.length >= 2 ? (found.length ? html`<div class="sugs">${found.map(p => A.ownerOf(p.key) ? html`<div class="sug taken"><span><b>${p.name}</b><small>Ya está unida a otra cuenta. Si es tuya, habla con la tienda.</small></span></div>` : claimBtn(p))}</div>`
      : html`<p>No encuentro a nadie con «${q}». Prueba con tu usuario de Melee o solo el apellido. Si nunca has jugado en la tienda no tienes ficha todavía: se crea sola al apuntarte.</p>`) : ''}`));
});
r.post('/cuenta/reclamar', (req, res) => {
  if (!need(req, res)) return;
  try { A.requestClaim(req.account, req.body.key, req.body.label, req.body.note); back(res, '/cuenta#ficha', 'Solicitud enviada: la tienda la revisará'); }
  catch (e) { back(res, '/cuenta#ficha', e.message, true); }
});
r.post('/cuenta/reclamar/:id/cancelar', (req, res) => {
  if (!need(req, res)) return;
  A.cancelClaim(req.account, Number(req.params.id));
  back(res, '/cuenta#ficha', 'Solicitud cancelada');
});
r.post('/cuenta/datos', (req, res) => {
  if (!need(req, res)) return;
  try { A.update(req.account.id, { name: req.body.name, nick: req.body.nick }); back(res, '/cuenta', 'Guardado'); } catch (e) { back(res, '/cuenta', e.message, true); }
});
r.post('/cuenta/clave', (req, res) => {
  if (!need(req, res)) return;
  try { A.changePassword(req.account, req.body.current, req.body.next); back(res, '/cuenta', 'Contraseña cambiada'); } catch (e) { back(res, '/cuenta', e.message, true); }
});
r.post('/cuenta/borrar', (req, res) => {
  if (!need(req, res)) return;
  A.logout(req, res); A.remove(req.account.id);
  res.redirect('/?ok=' + encodeURIComponent('Cuenta borrada'));
});

// ---------- Mis mazos ----------
r.get('/cuenta/mazos.json', (req, res) => {
  if (!req.account) return res.status(401).json({ error: 'Entra en tu cuenta' });
  res.json(A.decks(req.account.id).map(d => ({ id: d.id, name: d.name, commander: d.commander, value: d.value_cents, bracket: d.bracket, legal: d.legal, updated: d.updated_at })));
});
r.get('/cuenta/mazos/:id.json', (req, res) => {
  if (!req.account) return res.status(401).json({ error: 'Entra en tu cuenta' });
  const d = A.deck(req.account.id, Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'No encontrado' });
  res.json({ id: d.id, name: d.name, list: d.list });
});
r.post('/cuenta/mazos', (req, res) => {
  if (!req.account) return res.status(401).json({ error: 'Entra en tu cuenta para guardar mazos' });
  try {
    const n = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    const id = A.saveDeck(req.account.id, { id: Number(req.body.id) || null, name: req.body.name, commander: String(req.body.commander || '').slice(0, 120), list: req.body.list,
      value_cents: n(req.body.value), bracket: n(req.body.bracket), legal: req.body.legal === '' || req.body.legal == null ? null : Number(req.body.legal) ? 1 : 0 });
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
r.post('/cuenta/mazos/:id/borrar', (req, res) => {
  if (!need(req, res)) return;
  A.deleteDeck(req.account.id, Number(req.params.id));
  back(res, '/cuenta', 'Mazo borrado');
});

// ---------- Inscripción en Commander ----------
r.post('/commander/:id/apuntarme', (req, res) => {
  const id = Number(req.params.id);
  if (!req.account) return res.redirect('/entrar?next=' + encodeURIComponent(`/commander/${id}#apuntarse`));
  const next = req.body.next === '/cuenta' ? '/cuenta' : `/commander/${id}`;
  try {
    const out = C.signup(id, req.account, req.account.key, req.account.name, req.account.nick);
    const ev = C.getEvent(id);
    back(res, next, out.already ? 'Ya estabas apuntado' : out.waitlist ? `Estás en la lista de espera: si alguien se borra, entras solo${require('../tgbot').enabled() ? ' y te avisamos por Telegram si lo tienes activado' : ' (lo verás en Mi cuenta)'}` : `¡Apuntado!${ev.price_cents != null ? ` Paga la inscripción (${money(ev.price_cents)}) en la tienda antes de empezar.` : ''}`);
  } catch (e) { back(res, next, e.message, true); }
});
r.post('/commander/:id/borrarme', (req, res) => {
  const id = Number(req.params.id);
  if (!need(req, res)) return;
  try {
    const up = C.withdraw(id, req.account, req.account.person);
    if (up && up.length) notifyPromoted(req, C.getEvent(id), up).catch(() => {});
    back(res, req.get('referer') && /\/cuenta/.test(req.get('referer')) ? '/cuenta' : `/commander/${id}`, 'Te has borrado del torneo');
  } catch (e) { back(res, `/commander/${id}`, e.message, true); }
});

module.exports = r;
