'use strict';
// Comunidad (parte pública): cara a cara, recompensas, porra, tengo/busco, préstamos, logros y momentos para la TV
const express = require('express');
const multer = require('multer');
const { db, feature } = require('../db');
const melee = require('../melee');
const people = require('../people');
const rivals = require('../rivals');
const badges = require('../badges');
const K = require('../community');
const I = require('../identity');
const { html, raw, publicPage, fmtDate, money, TROPHY } = require('../views/html');

const r = express.Router();
const TR = raw(TROPHY);
const page = (title, body, cls = '') => String(publicPage(title, html`<div class="comm ${cls}">${body}</div>`));
const flash = req => (req.query.ok ? html`<div class="aflash ok" role="status">${String(req.query.ok).slice(0, 200)}</div>` : req.query.err ? html`<div class="aflash err" role="alert">${String(req.query.err).slice(0, 200)}</div>` : '');
const back = (res, url, msg, err = false) => { const [u, h] = String(url).split('#'); res.redirect(u + (u.includes('?') ? '&' : '?') + (err ? 'err=' : 'ok=') + encodeURIComponent(msg) + (h ? '#' + h : '')); };
const need = (req, res) => { if (req.account) return true; res.redirect('/entrar?next=' + encodeURIComponent(req.originalUrl)); return false; };
const off = (res, what) => res.status(404).send(page('No disponible', html`<h1>No disponible</h1><p>${what} no está activado en esta tienda.</p><p><a href="/comunidad">← Comunidad</a></p>`));
const gShort = g => (g === 'commander' ? 'Commander' : g === 'other' ? 'Otros' : melee.gameInfo(g).short);
const gColor = g => (g === 'commander' ? '#7b5ea7' : g === 'other' ? '#6b7280' : melee.gameInfo(g).color);
const gchip = g => html`<span class="gchip" style="--g:${gColor(g)}"><i></i>${gShort(g)}</span>`;
const pname = k => people.publicName(k);
const plink = k => (feature('profiles') ? html`<a href="/jugador/${encodeURIComponent(k)}">${pname(k)}</a>` : pname(k));
const shortDate = d => fmtDate(d, { weekday: undefined, hour: undefined, minute: undefined, day: 'numeric', month: 'short' });
const loginHint = (req, what) => html`<div class="loginhint"><p>${what}</p><a class="jbtn" href="/entrar?next=${encodeURIComponent(req.originalUrl)}">Entrar</a> <a class="jbtn-outline" href="/registro?next=${encodeURIComponent(req.originalUrl)}">Crear cuenta</a></div>`;
const commTabs = cur => {
  const t = [['/comunidad', 'Inicio', 'inicio', true], ['/logros', 'Logros', 'logros', feature('badges')], ['/porra', 'Porra', 'porra', feature('porra')], ['/recompensas', 'Se busca', 'recompensas', feature('bounties')],
    ['/cambios', 'Tengo / Busco', 'cambios', feature('trades')], ['/prestamos', 'Préstamos', 'prestamos', feature('loans')],
    ['/busco-mesa', 'Busco mesa', 'buscomesa', feature('lfg')], ['/liga-casual', 'Liga casual', 'ligacasual', feature('casual_league')], ['/comandantes', 'Comandantes', 'comandantes', true]].filter(x => x[3]);
  return html`<nav class="chips commtabs" aria-label="Comunidad">${t.map(([h, l, k]) => html`<a href="${h}" class="${cur === k ? 'on' : ''}" ${cur === k ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>`;
};

// Icono de insignia: medallón con el grado (bronce, plata, oro) y la inicial
const MEDAL = { 0: ['#e4e4e4', '#9a9a9a'], 1: ['#e7b98a', '#8a4b14'], 2: ['#e3e6ea', '#5b6470'], 3: ['#ffd66b', '#7a5200'] };
function medal(b, size = 56) {
  const [bg, ink] = MEDAL[b.tier];
  return raw(`<svg class="medal t${b.tier}" width="${size}" height="${size}" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="25" fill="${bg}" stroke="${ink}" stroke-width="3"/>
    ${b.tier ? `<circle cx="28" cy="28" r="19" fill="none" stroke="${ink}" stroke-width="1.5" stroke-dasharray="2 3"/>` : ''}
    <text x="28" y="35" text-anchor="middle" font-size="20" font-weight="800" fill="${ink}" font-family="system-ui, sans-serif">${b.name.slice(0, 1)}</text>
    ${b.tier ? Array.from({ length: b.tier }, (_, i) => `<circle cx="${28 + (i - (b.tier - 1) / 2) * 9}" cy="50" r="3" fill="${ink}"/>`).join('') : ''}</svg>`);
}
function levelCard(st, { compact = false } = {}) {
  return html`<div class="lvl ${compact ? 'compact' : ''}"><div class="lvl-n"><b>${st.level}</b><span>nivel</span></div>
    <div class="lvl-main"><div class="lvl-t"><b>${st.title}</b><span>${st.xp.toLocaleString('es-ES')} XP</span></div>
      <div class="lvl-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${st.pct}" aria-label="Progreso al nivel ${st.level + 1}"><i style="width:${st.pct}%"></i></div>
      <small>${(st.to - st.xp).toLocaleString('es-ES')} XP para el nivel ${st.level + 1} · ${st.earned} de ${badges.BADGES.length} insignias</small></div></div>`;
}
// Insignias especiales (las da la tienda): medallón con su color e icono
function spMedal(s, size = 56) {
  return raw(`<svg class="medal sp" width="${size}" height="${size}" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="25" fill="${s.color}" stroke="#111" stroke-width="3"/>
    <circle cx="28" cy="28" r="19" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1.5"/>
    <text x="28" y="36" text-anchor="middle" font-size="22" font-weight="800" fill="#fff" font-family="system-ui, sans-serif">${String(s.icon || s.name.slice(0, 1)).replace(/[<>&"]/g, '')}</text></svg>`);
}
function specialGrid(list) {
  return list.length ? html`<div class="bgrid">${list.map(s => html`<div class="ach got special" title="${s.descr || ''}">${spMedal(s)}<div><b>${s.name} <small>Especial</small></b><span>${s.descr || ''}</span>${s.note ? html`<small>${s.note}</small>` : ''}</div></div>`)}</div>` : '';
}
// Las destacadas, junto al nombre (perfil y rankings)
function featuredChips(key, { small = false } = {}) {
  let list = [];
  try { list = require('../specials').featured(key); } catch (e) { list = []; }
  return list.length ? html`<span class="spchips ${small ? 'sm' : ''}">${list.map(s => html`<span class="spchip" style="--c:${s.color}" title="${s.descr || s.name}"><i>${s.icon || s.name.slice(0, 1)}</i>${small ? '' : s.name}</span>`)}</span>` : '';
}
function badgeGrid(st, { all = true } = {}) {
  const list = (all ? st.badges : st.badges.filter(b => b.tier)).slice().sort((x, y) => y.tier - x.tier || (x.secret ? 1 : 0) - (y.secret ? 1 : 0) || y.pct - x.pct);
  return html`<div class="bgrid">${list.map(b => b.secret && !b.tier ? html`<div class="ach lock secret" title="Logro secreto"><svg class="medal" width="56" height="56" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="25" fill="#e4e4e4" stroke="#9a9a9a" stroke-width="3" stroke-dasharray="4 3"/><text x="28" y="36" text-anchor="middle" font-size="22" font-weight="800" fill="#9a9a9a" font-family="system-ui, sans-serif">?</text></svg>
    <div><b>Logro secreto</b><span>Sigue jugando para descubrirlo</span></div></div>` : html`<div class="ach ${b.tier ? 'got' : 'lock'}" title="${b.desc}">
    ${medal(b)}<div><b>${b.name}${b.tier ? html` <small>${b.tierName}${b.secret ? ' · secreto' : ''}</small>` : ''}</b><span>${b.desc}</span>
    ${b.tier < 3 ? html`<div class="bbar"><i style="width:${b.pct}%"></i></div><small>${b.value} / ${b.next} ${b.unit}</small>` : html`<small>${b.value} ${b.unit} · ¡completa!</small>`}</div></div>`)}</div>`;
}
module.exports.levelCard = levelCard;
module.exports.badgeGrid = badgeGrid;
module.exports.medal = medal;
module.exports.specialGrid = specialGrid;
module.exports.featuredChips = featuredChips;
module.exports.spMedal = spMedal;

// ---------- Hub ----------
r.get('/comunidad', (req, res) => {
  const acc = req.account;
  const st = acc && feature('badges') ? badges.of(acc.person) : null;
  const bnt = feature('bounties') ? K.bounties({ status: 'active' }) : [];
  const tc = feature('trades') ? K.tradeCount() : null;
  const ld = feature('loans') ? K.loanDecks().length : 0;
  const board = feature('porra') ? K.porraBoard(acc && acc.id) : [];
  const openTables = board.reduce((s, e) => s + e.tables.filter(t => !t.locked).length + (e.winnerOpen ? 1 : 0), 0);
  const tile = (href, title, text, extra) => html`<a class="ctile" href="${href}"><b>${title}</b><span>${text}</span>${extra ? html`<em>${extra}</em>` : ''}</a>`;
  res.send(page('Comunidad', html`
    <h1>Comunidad</h1>${commTabs('inicio')}
    ${st ? html`<a class="lvlwrap" href="/logros">${levelCard(st)}</a>` : acc ? '' : html`<p class="muted">Sube de nivel jugando, acierta en la porra, caza recompensas y presta mazos. <a href="/registro">Crea tu cuenta</a> para guardarlo todo.</p>`}
    <div class="ctiles">
      ${feature('badges') ? tile('/logros', 'Logros y niveles', 'Insignias de bronce, plata y oro por jugar, ganar y participar.', 'Ranking de XP') : ''}
      ${feature('porra') ? tile('/porra', 'Porra', 'Pronostica quién gana cada mesa y cada torneo. Solo puntos, sin dinero.', openTables ? `${openTables} pronósticos abiertos` : '') : ''}
      ${feature('bounties') ? tile('/recompensas', 'Se busca', 'La tienda pone recompensa a algunos jugadores. Gánales y es tuya.', bnt.length ? `${bnt.length} ${bnt.length === 1 ? 'recompensa activa' : 'recompensas activas'}` : '') : ''}
      ${feature('trades') ? tile('/cambios', 'Tengo / Busco', 'Apunta tus cartas para cambio y las que buscas: te decimos quién las tiene.', tc ? `${tc.have} en Tengo · ${tc.want} en Busco` : '') : ''}
      ${feature('loans') ? tile('/prestamos', 'Mazos de préstamo', 'Presta tus mazos a quien empieza o pide uno para el próximo torneo.', ld ? `${ld} mazos disponibles` : '') : ''}
      ${feature('profiles') ? tile('/vs', 'Cara a cara', 'Compara el historial entre dos jugadores: quién gana a quién.') : ''}
      ${feature('moments') ? tile('/momentos/subir', 'Momentos', 'Sube una foto o una jugada épica y saldrá en la TV de la tienda.') : ''}
    </div>`));
});

// ---------- Cara a cara ----------
r.get('/vs', (req, res) => {
  if (!feature('profiles')) return off(res, 'El cara a cara');
  const a = req.query.a, b = req.query.b;
  if (a && b) return res.redirect(`/vs/${encodeURIComponent(a)}/${encodeURIComponent(b)}`);
  const me = req.account ? req.account.person : '';
  res.send(page('Cara a cara', html`<h1>Cara a cara</h1>${commTabs('')}
    <p class="muted">Elige a dos jugadores para ver todos sus enfrentamientos en la tienda: partidas de Melee y mesas de Commander.</p>
    <form class="vsform" method="get" action="/vs">
      <span class="ppick pubpick"><input class="pub-pick" data-field="a" placeholder="Jugador 1" autocomplete="off" value="${me ? pname(me) : ''}"><input type="hidden" name="a" value="${me}"></span>
      <b class="vsx">vs</b>
      <span class="ppick pubpick"><input class="pub-pick" data-field="b" placeholder="Jugador 2" autocomplete="off"><input type="hidden" name="b"></span>
      <button class="jbtn">Comparar</button></form>
    <script src="/static/ui.js"></script><script src="/static/community.js"></script>`));
});
r.get('/vs/:a/:b', (req, res) => {
  if (!feature('profiles')) return off(res, 'El cara a cara');
  const a = I.resolve(req.params.a), b = I.resolve(req.params.b);
  if (a !== req.params.a || b !== req.params.b) return res.redirect(`/vs/${encodeURIComponent(a)}/${encodeURIComponent(b)}`);
  const h = rivals.h2h(a, b);
  const na = pname(a), nb = pname(b);
  const dec = h.w + h.l + h.d;
  const ra = rivals.rivals(a), rb = rivals.rivals(b);
  const tag = (ra.nemesis && ra.nemesis.key === b) ? html`<b>${nb}</b> es la némesis de ${na}` : (rb.nemesis && rb.nemesis.key === a) ? html`<b>${na}</b> es la némesis de ${nb}` : '';
  const RES = { W: ['gana', 'win'], L: ['pierde', 'loss'], D: ['empate', 'draw'], N: ['ganó otro', 'other'] };
  res.send(page(`${na} vs ${nb}`, html`
    <p><a href="/vs">← Cara a cara</a></p>
    <div class="vshead"><div class="vsp">${plink(a)}<b>${h.w}</b></div><div class="vsmid"><span>vs</span>${h.d ? html`<small>${h.d} ${h.d === 1 ? 'empate' : 'empates'}</small>` : ''}</div><div class="vsp r">${plink(b)}<b>${h.l}</b></div></div>
    ${dec ? html`<div class="vsbar" aria-hidden="true"><i style="flex:${h.w || 0.0001}"></i><span style="flex:${h.d || 0.0001}"></span><em style="flex:${h.l || 0.0001}"></em></div>` : ''}
    ${tag ? html`<p class="nemtag">${tag}</p>` : ''}
    ${h.list.length ? html`<section><h2 class="sec">Enfrentamientos (${h.list.length})</h2><div class="results">${h.list.map(e => html`<a class="rrow vsrow" href="${e.href}" style="--g:${gColor(e.game)}">
      <span class="r-date">${shortDate(e.date)}</span>${gchip(e.game)}<span class="r-name">${e.event}<small class="muted"> · ${e.round ? `ronda ${e.round}` : ''}${e.table ? ` · mesa ${e.table}` : ''}${e.podSize ? ` · mesa de ${e.podSize}` : ''}</small></span>
      <span class="vsres ${RES[e.r][1]}">${e.kill ? (e.r === 'W' ? `${na.split(' ')[0]} elimina a ${nb.split(' ')[0]}` : `${nb.split(' ')[0]} elimina a ${na.split(' ')[0]}`) : e.r === 'N' ? (e.podKills ? 'Sin cruce directo' : 'Ganó otro') : `${na.split(' ')[0]} ${RES[e.r][0]}`}${e.score ? ` ${e.score}` : ''}</span><span class="r-go">→</span></a>`)}</div></section>`
      : html`<p class="muted">Todavía no se han enfrentado en un torneo de la tienda.</p>`}`));
});

// ---------- Recompensas ----------
r.get('/recompensas', (req, res) => {
  if (!feature('bounties')) return off(res, 'Se busca');
  const all = K.bounties();
  const act = all.filter(b => b.status === 'active');
  const done = all.filter(b => ['claimed', 'delivered'].includes(b.status)).slice(0, 20);
  res.send(page('Se busca', html`<h1>Se busca</h1>${commTabs('recompensas')}
    <p class="muted">La tienda pone recompensa a algunos jugadores. El primero que les gane una partida (o una mesa de Commander) en un torneo de la tienda se la lleva: pásate por el mostrador a recogerla.</p>
    ${act.length ? html`<div class="wanted">${act.map(b => html`<article class="poster">
      <span class="p-top">Se busca</span><div class="p-face">${pname(b.person_key).slice(0, 1).toUpperCase()}</div>
      <h2>${plink(b.person_key)}</h2>${b.note ? html`<p class="p-note">${b.note}</p>` : ''}
      <div class="p-reward"><small>Recompensa</small><b>${b.reward}</b></div>
      <small class="p-foot">${b.game ? html`Solo en ${gShort(b.game)} · ` : ''}desde el ${shortDate(b.created_at)}</small></article>`)}</div>`
      : html`<p class="empty">Ahora mismo no hay nadie en busca y captura.</p>`}
    ${done.length ? html`<section><h2 class="sec">Recompensas cobradas</h2><div class="results">${done.map(b => html`<a class="rrow brow" href="${b.claimed_href || '#'}">
      <span class="r-date">${shortDate(b.claimed_at)}</span><span class="r-name"><b>${pname(b.claimed_key)}</b> ganó a ${pname(b.person_key)}<small class="muted"> · ${b.claimed_event || ''}</small></span>
      <span class="r-win">${b.reward}</span><span class="r-go">→</span></a>`)}</div></section>` : ''}`));
});

// ---------- Porra ----------
r.get('/porra', (req, res) => {
  if (!feature('porra')) return off(res, 'La porra');
  const acc = req.account;
  const board = K.porraBoard(acc && acc.id);
  const month = new Date().toISOString().slice(0, 7);
  const rank = K.porraRanking({ month });
  const me = acc ? K.porraStats(acc.id) : null;
  const opt = (ev, kind, t, o) => html`<button name="pick" value="${o.id}" class="pk ${t.pick && t.pick.pick === o.id ? 'on' : ''}" ${t.locked || !acc ? 'disabled' : ''}>${o.name}</button>`;
  const statusOf = p => (!p ? '' : p.status === 'win' ? html`<span class="pst win">+${p.points}</span>` : p.status === 'lose' ? html`<span class="pst lose">fallo</span>` : p.status === 'void' ? html`<span class="pst">nula</span>` : '');
  res.send(page('Porra', html`<h1>Porra</h1>${commTabs('porra')}${flash(req)}
    <p class="muted">Pronostica quién gana cada mesa: ${K.PTS.melee} punto en partidas 1 contra 1, ${K.PTS.commander} en mesas de Commander y ${K.PTS.winner} si aciertas el ganador del torneo (se cierra al empezar la ronda 2). Solo puntos, sin dinero. Cada mesa se cierra en cuanto tiene resultado.</p>
    ${me ? html`<div class="ptiles small3"><div><b>${me.pts}</b><span>tus puntos</span></div><div><b>${me.ok}/${me.total}</b><span>aciertos</span></div><div><b>${me.open}</b><span>pendientes</span></div></div>` : loginHint(req, 'Entra en tu cuenta para hacer tus pronósticos.')}
    ${board.length ? board.map(ev => html`<section class="pevent" style="--g:${gColor(ev.game)}"><div class="sec-row"><h2 class="sec">${gchip(ev.game)} ${ev.name}</h2><a href="${ev.href}" class="small">Ver torneo →</a></div>
      ${ev.winnerOpen ? html`<form method="post" action="/porra" class="pwin"><input type="hidden" name="source" value="${ev.source}"><input type="hidden" name="event" value="${ev.id}"><input type="hidden" name="kind" value="winner">
        <label for="w-${ev.source}-${ev.id}"><b>¿Quién gana el torneo?</b> <small class="muted">${K.PTS.winner} puntos</small></label>
        <div class="who-row"><select id="w-${ev.source}-${ev.id}" name="pick" ${acc ? '' : 'disabled'}><option value="">Elige jugador…</option>${ev.roster.map(o => html`<option value="${o.id}" ${ev.winnerPick && ev.winnerPick.pick === o.id ? 'selected' : ''}>${o.name}</option>`)}</select>
        <button class="jbtn" ${acc ? '' : 'disabled'}>${ev.winnerPick ? 'Cambiar' : 'Apostar'}</button></div>${ev.winnerPick ? html`<small class="muted">Tu pronóstico: <b>${ev.winnerPick.pick_name}</b></small>` : ''}</form>` : ev.winnerPick ? html`<p class="small">Tu ganador: <b>${ev.winnerPick.pick_name}</b> ${statusOf(ev.winnerPick)}</p>` : ''}
      ${ev.tables.length ? html`<h3 class="ph3">Ronda ${ev.round}</h3><div class="ptables">${ev.tables.map(t => html`<form method="post" action="/porra#${ev.source}-${ev.id}-${t.table}" id="${ev.source}-${ev.id}-${t.table}" class="ptable ${t.locked ? 'locked' : ''}">
        <input type="hidden" name="source" value="${ev.source}"><input type="hidden" name="event" value="${ev.id}"><input type="hidden" name="kind" value="table"><input type="hidden" name="round" value="${t.round}"><input type="hidden" name="table" value="${t.table}">
        <div class="pt-h"><b>Mesa ${t.table}</b>${t.locked ? html`<small>cerrada</small>` : ''}${statusOf(t.pick)}</div>
        <div class="pk-row">${t.options.map(o => opt(ev, 'table', t, o))}</div></form>`)}</div>`
        : html`<p class="muted small">Las mesas salen aquí en cuanto se publique la ronda.</p>`}
    </section>`) : html`<p class="empty">No hay torneos en juego ni a punto de empezar. Vuelve el día del torneo.</p>`}
    <section id="ranking"><h2 class="sec">Ranking de ${new Date().toLocaleDateString('es-ES', { month: 'long' })}</h2>
      ${rank.length ? html`<ol class="prank">${rank.map(x => html`<li class="${acc && x.id === acc.id ? 'me' : ''}"><span class="pos">${x.pos}</span><b>${x.who}</b><span class="muted small">${x.ok}/${x.total} · ${x.pct}%</span><em>${x.pts} pts</em></li>`)}</ol>`
        : html`<p class="muted">Aún no hay pronósticos resueltos este mes.</p>`}</section>`));
});
r.post('/porra', (req, res) => {
  if (!feature('porra')) return off(res, 'La porra');
  if (!need(req, res)) return;
  try {
    const n = K.predict(req.account.id, { source: req.body.source === 'commander' ? 'commander' : 'melee', event: req.body.event, kind: req.body.kind === 'winner' ? 'winner' : 'table', round: req.body.round, table: req.body.table, pick: req.body.pick });
    back(res, '/porra' + (req.body.kind === 'table' ? `#${req.body.source}-${req.body.event}-${req.body.table}` : ''), `Apostado por ${n}`);
  } catch (e) { back(res, '/porra', e.message, true); }
});

// ---------- Logros ----------
r.get('/logros', (req, res) => {
  if (!feature('badges')) return off(res, 'Los logros');
  const acc = req.account;
  const st = acc ? badges.of(acc.person) : null;
  const top = badges.leaderboard(50);
  res.send(page('Logros', html`<h1>Logros y niveles</h1>${commTabs('logros')}
    ${st ? html`${levelCard(st)}${st.specials && st.specials.length ? html`<h2 class="sec">Tus insignias especiales</h2>${specialGrid(st.specials)}` : ''}<h2 class="sec">Tus insignias</h2>${badgeGrid(st)}` : loginHint(req, 'Entra en tu cuenta para ver tu nivel y tus insignias. Si ya has jugado en la tienda, une tu ficha y contarán todos tus torneos.')}
    <details class="xphelp"><summary>Cómo se gana experiencia</summary><ul>
      <li>Cada torneo jugado: <b>${badges.XP.event} XP</b>. Cada partida ganada: <b>${badges.XP.matchWin}</b>. Cada mesa de Commander ganada: <b>${badges.XP.podWin}</b>. Cada jugador que eliminas (contador de vidas): <b>${badges.XP.kill}</b>.</li>
      <li>Podio: <b>${badges.XP.podium} XP</b>. Torneo ganado: <b>${badges.XP.title} XP</b>.</li>
      <li>Punto de porra: <b>${badges.XP.porraPoint} XP</b>. Recompensa cobrada: <b>${badges.XP.bounty} XP</b>. Mazo prestado y devuelto: <b>${badges.XP.loan} XP</b>. Foto publicada en la TV: <b>${badges.XP.moment} XP</b>. Cartas en Tengo / Busco: <b>${badges.XP.trade} XP</b> cada una (hasta 50).</li>
      ${feature('casual_league') ? html`<li>Partida de la liga casual confirmada: <b>${badges.XP.casual} XP</b> (y <b>${badges.XP.casualWin}</b> más si ganas).</li>` : ''}</ul></details>
    ${(() => { const vis = require('../specials').list().filter(s => !s.hidden); return vis.length ? html`<section><h2 class="sec">Insignias especiales</h2><p class="small muted">Las da la tienda. Hay alguna más que no sale aquí…</p>
      <div class="bgrid">${vis.map(s => html`<div class="ach got special" title="${s.descr || ''}">${spMedal(s, 48)}<div><b>${s.name}</b><span>${s.descr || ''}</span><small>${s.holders} ${s.holders === 1 ? 'jugador la tiene' : 'jugadores la tienen'}</small></div></div>`)}</div></section>` : ''; })()}
    <section><h2 class="sec">Ranking de experiencia</h2>
      ${top.length ? html`<ol class="prank xprank">${top.map(x => html`<li class="${st && x.key === st.key ? 'me' : ''}"><span class="pos">${x.pos}</span>
        <b>${feature('profiles') ? html`<a href="/jugador/${encodeURIComponent(x.key)}">${x.name}</a>` : x.name} ${featuredChips(x.key, { small: true })}</b><span class="muted small">Nivel ${x.level} · ${x.title} · ${x.earned} insignias</span><em>${x.xp.toLocaleString('es-ES')} XP</em></li>`)}</ol>`
        : html`<p class="muted">Aún no hay nadie en el ranking.</p>`}</section>`));
});

// ---------- Tengo / Busco ----------
r.get('/cambios', (req, res) => {
  if (!feature('trades')) return off(res, 'Tengo / Busco');
  const acc = req.account;
  const q = String(req.query.q || '').slice(0, 60), game = K.TRADE_GAMES.some(g => g[0] === req.query.juego) ? req.query.juego : '';
  const mine = acc ? K.myTrades(acc.id) : [];
  const matches = acc ? K.tradeMatches(acc.id) : [];
  const browse = K.tradeBrowse({ q, game });
  const list = kind => mine.filter(t => t.kind === kind);
  const gsel = (name, val) => html`<select name="${name}">${K.TRADE_GAMES.map(([k, l]) => html`<option value="${k}" ${k === val ? 'selected' : ''}>${l}</option>`)}</select>`;
  const box = (kind, title, hint) => html`<div class="tbox"><h3>${title} <small class="muted">${list(kind).length}</small></h3>
    ${list(kind).length ? html`<ul class="tlist">${list(kind).map(t => html`<li>${gchip(t.game)}<span>${t.qty > 1 ? html`<b>${t.qty}×</b> ` : ''}${t.card}</span>
      <form method="post" action="/cambios/${t.id}/borrar"><button class="linkbtn" aria-label="Quitar ${t.card}">Quitar</button></form></li>`)}</ul>` : html`<p class="muted small">${hint}</p>`}
    <form method="post" action="/cambios" class="aform tadd"><input type="hidden" name="kind" value="${kind}">
      <label>Juego${gsel('game', (list(kind)[0] || {}).game || 'MagicTheGathering')}</label>
      <label>Cartas (una por línea, con cantidad si quieres)<textarea name="cards" rows="4" placeholder="2 Sol Ring&#10;Luke Skywalker x1" required></textarea></label>
      <button class="jbtn-outline">Añadir a ${title}</button></form>
    ${list(kind).length ? html`<form method="post" action="/cambios/vaciar" onsubmit="return confirm('¿Vaciar la lista ${title}?')"><input type="hidden" name="kind" value="${kind}"><button class="linkbtn danger">Vaciar ${title}</button></form>` : ''}</div>`;
  res.send(page('Tengo / Busco', html`<h1>Tengo / Busco</h1>${commTabs('cambios')}${flash(req)}
    <p class="muted">Apunta las cartas que tienes para cambiar y las que buscas, de cualquier juego. Te decimos quién tiene lo que buscas y quién busca lo que tienes, y cuándo vuelve por la tienda. Los cambios se hacen en persona.</p>
    ${acc ? html`
      ${matches.length ? html`<section><h2 class="sec">Cruces para ti</h2><div class="tmatches">${matches.slice(0, 20).map(m => html`<div class="tmatch">
        <div class="tm-h"><b>${m.who}</b>${m.next ? html`<span class="stchip st-setup">Viene: ${m.next.name}${m.next.start_date ? ` · ${shortDate(m.next.start_date)}` : ''}</span>` : ''}</div>
        ${m.theyHave.length ? html`<p><span class="tk have">Tiene lo que buscas</span> ${m.theyHave.map(c => c.card).join(', ')}</p>` : ''}
        ${m.theyWant.length ? html`<p><span class="tk want">Busca lo que tienes</span> ${m.theyWant.map(c => c.card).join(', ')}</p>` : ''}</div>`)}</div></section>`
        : mine.length ? html`<p class="muted">Todavía no hay cruces con tus listas. Cuanta más gente apunte cartas, más saldrán.</p>` : ''}
      <div class="tboxes">${box('have', 'Tengo', 'Aún no has apuntado cartas para cambiar.')}${box('want', 'Busco', 'Aún no has apuntado cartas que buscas.')}</div>`
      : loginHint(req, 'Entra en tu cuenta para apuntar tus cartas y ver los cruces.')}
    <section id="todas"><h2 class="sec">Lo que hay en la tienda</h2>
      <form method="get" action="/cambios#todas" class="filters tfil"><input name="q" value="${q}" placeholder="Buscar carta"><select name="juego"><option value="">Todos los juegos</option>${K.TRADE_GAMES.map(([k, l]) => html`<option value="${k}" ${k === game ? 'selected' : ''}>${l}</option>`)}</select><button class="jbtn-outline">Buscar</button></form>
      ${browse.length ? html`<div class="tbrowse">${browse.map(t => html`<div class="trow"><span class="tk ${t.kind}">${t.kind === 'have' ? 'Tiene' : 'Busca'}</span>${gchip(t.game)}<span class="tc">${t.qty > 1 ? `${t.qty}× ` : ''}${t.card}</span><span class="muted small">${t.who}</span></div>`)}</div>`
        : html`<p class="muted">${q ? `Nadie ha apuntado «${q}».` : 'Aún no hay cartas apuntadas.'}</p>`}</section>`));
});
r.post('/cambios', (req, res) => {
  if (!feature('trades')) return off(res, 'Tengo / Busco');
  if (!need(req, res)) return;
  try { const n = K.addTrades(req.account.id, req.body.kind, req.body.game, req.body.cards); badges.invalidate(); back(res, '/cambios', `${n} ${n === 1 ? 'carta añadida' : 'cartas añadidas'}`); }
  catch (e) { back(res, '/cambios', e.message, true); }
});
r.post('/cambios/:id/borrar', (req, res) => { if (!need(req, res)) return; K.delTrade(req.account.id, Number(req.params.id)); back(res, '/cambios', 'Quitada'); });
r.post('/cambios/vaciar', (req, res) => { if (!need(req, res)) return; K.clearTrades(req.account.id, req.body.kind === 'want' ? 'want' : 'have'); back(res, '/cambios', 'Lista vaciada'); });

// ---------- Mazos de préstamo ----------
r.get('/prestamos', (req, res) => {
  if (!feature('loans')) return off(res, 'Los préstamos');
  const acc = req.account;
  const game = K.TRADE_GAMES.some(g => g[0] === req.query.juego) ? req.query.juego : '';
  const all = K.loanDecks({ game });
  const mine = acc ? K.myLoans(acc.id) : null;
  const myDecks = acc ? require('../accounts').decks(acc.id) : [];
  const stc = s => html`<span class="stchip st-${s}">${K.loanStatus[s]}</span>`;
  res.send(page('Mazos de préstamo', html`<h1>Mazos de préstamo</h1>${commTabs('prestamos')}${flash(req)}
    <p class="muted">Jugadores que prestan sus mazos para que otros prueben un juego o jueguen un torneo. Pide uno, el dueño acepta y os veis en la tienda el día del torneo. Cuídalo como si fuera tuyo.</p>
    ${mine && (mine.incoming.length || mine.outgoing.length) ? html`<section class="acard"><h2>Tus solicitudes</h2>
      ${mine.incoming.length ? html`<h3>Te piden</h3><div class="evlist">${mine.incoming.map(q => html`<div class="myev lreq"><div><b>${q.who}</b> pide <b>${q.dname}</b><small>${q.event_label}${q.message ? ` · «${q.message}»` : ''}</small></div>
        <span class="mystate">${stc(q.status)}</span><div class="lbtns">
        ${q.status === 'pending' ? html`<form method="post" action="/prestamos/solicitud/${q.id}/accept"><button class="jbtn small">Aceptar</button></form><form method="post" action="/prestamos/solicitud/${q.id}/reject"><button class="linkbtn">Rechazar</button></form>` : ''}
        ${q.status === 'accepted' ? html`<form method="post" action="/prestamos/solicitud/${q.id}/returned"><button class="jbtn-outline small">Ya me lo ha devuelto</button></form>` : ''}</div></div>`)}</div>` : ''}
      ${mine.outgoing.length ? html`<h3>Has pedido</h3><div class="evlist">${mine.outgoing.map(q => html`<div class="myev lreq"><div><b>${q.dname}</b> de ${q.who}<small>${q.event_label}${q.owner_note ? ` · ${q.owner_note}` : ''}</small></div>
        <span class="mystate">${stc(q.status)}</span>${['pending', 'accepted'].includes(q.status) ? html`<form method="post" action="/prestamos/solicitud/${q.id}/cancel"><button class="linkbtn">Cancelar</button></form>` : ''}</div>`)}</div>` : ''}
    </section>` : ''}
    <div class="chips">${[['', 'Todos'], ...K.TRADE_GAMES].map(([k, l]) => html`<a href="/prestamos${k ? `?juego=${k}` : ''}" class="${k === game ? 'on' : ''}">${l}</a>`)}</div>
    ${all.length ? html`<div class="ldecks">${all.map(d => html`<article class="ldeck" style="--g:${gColor(d.game)}">
      <div class="ld-h">${gchip(d.game)}${d.busy ? html`<span class="stchip st-accepted">Prestado</span>` : ''}</div>
      <h3>${d.name}</h3><p class="muted small">De ${d.who}${d.lent ? ` · prestado ${d.lent} ${d.lent === 1 ? 'vez' : 'veces'}` : ''}</p>
      ${d.description ? html`<p>${d.description}</p>` : ''}
      ${d.list ? html`<details><summary>Ver lista</summary><pre class="dlist">${d.list}</pre></details>` : ''}
      ${acc && acc.id !== d.account_id ? html`<details class="lask"><summary class="jbtn-outline">Pedirlo</summary><form method="post" action="/prestamos/${d.id}/pedir" class="aform">
        <label>¿Para qué torneo o día?<input name="event_label" required maxlength="120" placeholder="p. ej. Commander del viernes 28"></label>
        <label>Mensaje (opcional)<input name="message" maxlength="300" placeholder="Nunca he jugado a este juego…"></label><button class="jbtn">Enviar solicitud</button></form></details>`
        : acc ? html`<form method="post" action="/prestamos/${d.id}/quitar" onsubmit="return confirm('¿Dejar de prestar ${d.name}?')"><button class="linkbtn">Dejar de prestarlo</button></form>` : ''}
    </article>`)}</div>` : html`<p class="empty">Todavía nadie presta mazos${game ? ' de este juego' : ''}. ¡Sé el primero!</p>`}
    ${acc ? html`<section class="acard" id="nuevo"><h2>Prestar un mazo</h2>
      <form method="post" action="/prestamos" class="aform">
        ${myDecks.length ? html`<label>Usar uno de mis mazos guardados (opcional)<select name="from_deck"><option value="">—</option>${myDecks.map(d => html`<option value="${d.id}">${d.name}</option>`)}</select></label>` : ''}
        <label>Juego<select name="game">${K.TRADE_GAMES.map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select></label>
        <label>Nombre del mazo<input name="name" maxlength="80" placeholder="p. ej. Precon de Atraxa mejorado"></label>
        <label>Descripción<textarea name="description" rows="2" maxlength="400" placeholder="Nivel, cómo se juega, si va con fundas…"></textarea></label>
        <label>Lista (opcional)<textarea name="list" rows="4" spellcheck="false"></textarea></label>
        <button class="jbtn">Ponerlo para prestar</button></form></section>`
      : loginHint(req, 'Entra en tu cuenta para pedir un mazo o poner los tuyos para prestar.')}`));
});
r.post('/prestamos', (req, res) => {
  if (!feature('loans')) return off(res, 'Los préstamos');
  if (!need(req, res)) return;
  try {
    const b = { ...req.body };
    if (b.from_deck) {
      const d = require('../accounts').deck(req.account.id, Number(b.from_deck));
      if (d) { b.name = b.name || d.name; b.list = b.list || d.list; if (!b.game || b.game === 'other') b.game = 'MagicTheGathering'; }
    }
    K.addLoanDeck(req.account.id, b); back(res, '/prestamos', 'Mazo puesto para prestar');
  } catch (e) { back(res, '/prestamos#nuevo', e.message, true); }
});
r.post('/prestamos/:id/pedir', (req, res) => {
  if (!need(req, res)) return;
  try { K.requestLoan(req.account.id, Number(req.params.id), req.body); back(res, '/prestamos', 'Solicitud enviada: el dueño la verá en Préstamos y en su cuenta'); }
  catch (e) { back(res, '/prestamos', e.message, true); }
});
r.post('/prestamos/:id/quitar', (req, res) => { if (!need(req, res)) return; K.removeLoanDeck(req.account.id, Number(req.params.id)); back(res, '/prestamos', 'Ya no está para prestar'); });
r.post('/prestamos/solicitud/:id/:action', (req, res) => {
  if (!need(req, res)) return;
  try {
    const st = K.loanAction(req.account.id, Number(req.params.id), String(req.params.action), req.body.note);
    if (st === 'returned') badges.invalidate();
    back(res, '/prestamos', { accepted: 'Aceptada: quedad en la tienda', rejected: 'Rechazada', returned: '¡Gracias por prestarlo!', cancelled: 'Cancelada' }[st]);
  } catch (e) { back(res, '/prestamos', e.message, true); }
});

// ---------- Momentos ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 1 } });
r.get('/momentos/subir', (req, res) => {
  if (!feature('moments')) return off(res, 'Los momentos');
  if (!need(req, res)) return;
  const mine = K.moments({ limit: 50 }).filter(m => m.account_id === req.account.id).slice(0, 6);
  const st = { pending: 'Esperando revisión', approved: 'En la TV', rejected: 'No publicada' };
  res.send(page('Subir un momento', html`<h1>Momentos</h1>${flash(req)}
    <p class="muted">Sube una foto de una jugada épica, de tu mesa o del torneo. La tienda la revisa antes de que salga en la TV. No subas fotos de gente que no quiera salir.</p>
    <form method="post" action="/momentos" enctype="multipart/form-data" class="aform momform" id="momform">
      <label>Foto<input type="file" name="photo" accept="image/*" required id="momfile"></label>
      <img id="momprev" alt="" hidden>
      <label>Texto (opcional)<input name="caption" maxlength="120" placeholder="¡Combo de 40 de daño en la mesa 3!"></label>
      <label>Torneo (opcional)<input name="event_label" maxlength="120" placeholder="Commander del viernes"></label>
      <button class="jbtn big">Enviar a la TV</button></form>
    ${mine.length ? html`<h2 class="sec">Tus fotos</h2><div class="momgrid">${mine.map(m => html`<figure><img src="/momentos/f/${m.id}" alt="" loading="lazy"><figcaption>${st[m.status]}</figcaption></figure>`)}</div>` : ''}
    <script src="/static/community.js"></script>`));
});
r.post('/momentos', upload.single('photo'), (req, res) => {
  if (!feature('moments')) return off(res, 'Los momentos');
  if (!need(req, res)) return;
  try { K.addMoment(req.account.id, req.file, req.body); back(res, '/momentos/subir', 'Recibida: saldrá en la TV cuando la tienda la apruebe'); }
  catch (e) { back(res, '/momentos/subir', e.message, true); }
});
r.get('/momentos/f/:id', (req, res) => {
  const m = K.moment(Number(req.params.id));
  if (!m) return res.status(404).end();
  const allowed = m.status === 'approved' || req.user || (req.account && req.account.id === m.account_id);
  if (!allowed) return res.status(404).end();
  res.set('Cache-Control', m.status === 'approved' ? 'public, max-age=86400' : 'private, no-store').type(m.mime).sendFile(K.momentPath(m), err => { if (err && !res.headersSent) res.status(404).end(); });
});

// Sugerencias de jugadores para el cara a cara (solo nombre público)
r.get('/personas.json', (req, res) => {
  if (!feature('profiles')) return res.json([]);
  res.json(people.suggest(String(req.query.q || '').slice(0, 60), { limit: 8 }).filter(p => !p.key.startsWith('a:') || true).map(p => ({ key: p.key, name: pname(p.key) })));
});

module.exports.router = r;
module.exports.helpers = { page, flash, back, need, off, commTabs, loginHint, plink, pname, shortDate };
