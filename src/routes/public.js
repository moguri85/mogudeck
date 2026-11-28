'use strict';
const express = require('express');
const config = require('../config');
const QRCode = require('qrcode');
const { db, settings } = require('../db');
const data = require('../data');
const stats = require('../stats');
const melee = require('../melee');
const C = require('../commander');
const people = require('../people');
const deckvalue = require('../deckvalue');
const pricedb = require('../pricedb');
const decks = require('../decks');
const cardimg = require('../cardimg');
const precons = require('../precons');
const { feature } = require('../db');
const { html, raw, json, cssUrl, gameArt, richText, artStyle, fmtDay, fmtDate, publicPage, gameBadge, statusBadge, money, absUrl, head, TROPHY } = require('../views/html');
const TR = raw(TROPHY);

const r = express.Router();

// Imagen del torneo; la del juego solo si está activada en Ajustes
function media(image, code) {
  if (image) return { cls: '', style: raw(`background-image:${cssUrl(image)}`) };
  return settings().show_game_img === '1' ? artStyle(code) : null;
}

function card({ href, color, label, image, art, badge, live, date, name, price, cta }) {
  const m = media(image, art);
  const badges = html`<div class="tcard-badges ${m ? '' : 'static'}"><span class="jbadge">${label}</span>${badge ? html`<span class="jbadge ${live ? 'live' : ''}">${badge}</span>` : ''}</div>`;
  return html`<a class="tcard ${m ? '' : 'nomedia'}" href="${href}" style="--g:${color}">
    ${m ? html`<div class="tcard-media ${m.cls}" style="${m.style}">
      ${m.cls === 'art' ? html`<span>${label}</span>` : ''}${badges}
    </div>` : badges}
    <div class="tcard-date">${date}</div>
    <div class="tcard-name">${name}</div>
    <div class="tcard-foot"><span class="tcard-price">${price || ''}</span><span class="jbtn">${cta}</span></div>
  </a>`;
}

const realImage = src => (src && !/blankbrandimage/i.test(src) ? src : null);

function tournamentCard(t) {
  const live = data.isLive(t);
  const g = melee.gameInfo(t.game);
  const badge = live ? '● En juego' : t.status === 4 ? 'Finalizado' : t.status === 3 ? 'Cancelado' : 'Inscripción abierta';
  return card({
    href: `/t/${t.id}`, color: g.color, label: g.short, image: realImage(t.brand_image), art: t.game, badge, live,
    date: fmtDate(t.start_date, { weekday: 'long', month: 'long' }), name: t.name,
    price: t.price_cents != null && t.status === 1 ? money(t.price_cents) : '',
    cta: live ? 'Ver en directo' : t.status === 4 ? 'Resultados' : 'Inscribirme',
  });
}

function cmdCard(e) {
  const badge = { setup: 'Próximamente', running: '● En juego', finished: 'Terminado' }[e.status];
  return card({
    href: `/commander/${e.id}`, color: '#7b5ea7', label: 'Commander', art: 'commander', badge, live: e.status === 'running',
    date: fmtDate(e.start_date, { weekday: 'long', month: 'long' }), name: e.name,
    price: e.price_cents != null && e.status === 'setup' ? money(e.price_cents) : '',
    cta: e.status === 'running' ? 'Ver mesas' : e.status === 'finished' ? 'Resultados' : 'Ver evento',
  });
}

function dateTile(iso) {
  if (!iso) return html`<div class="dtile"><span>Fecha</span><b>?</b><span>pronto</span></div>`;
  const d = new Date(iso);
  const o = k => d.toLocaleString('es-ES', { timeZone: config.tz, ...k });
  return html`<div class="dtile"><span>${o({ weekday: 'short' })}</span><b>${o({ day: 'numeric' })}</b><span>${o({ month: 'short' })}</span></div>`;
}
// Agenda: formatos en español, día local, etiqueta del día y fila
const FMT_ES = { constructed: 'Construido', sealed: 'Sellado', limited: 'Limitado', draft: 'Draft', 'booster draft': 'Draft', standard: 'Estándar', 'twin suns': 'Twin Suns', eternal: 'Eterno', premier: 'Premier', modern: 'Modern', pauper: 'Pauper', legacy: 'Legacy', pioneer: 'Pioneer', commander: 'Commander' };
const fmtEs = f => FMT_ES[String(f || '').trim().toLowerCase()] || f || '';
const normName = n => String(n || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const localDay = (iso, o = {}) => new Date(iso).toLocaleDateString('es-ES', { timeZone: config.tz, ...o });
const ymd = d => d.toLocaleDateString('sv-SE', { timeZone: config.tz });
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
function dayLabel(iso) {
  if (!iso) return 'Por confirmar';
  const d = ymd(new Date(iso)), today = ymd(new Date()), tomorrow = ymd(new Date(Date.now() + 864e5));
  return d === today ? 'Hoy' : d === tomorrow ? 'Mañana' : cap(localDay(iso, { weekday: 'long' }));
}
// Un bloque por día: la fecha a la izquierda (arriba en móvil) y sus torneos
function dayCard(d) {
  const iso = d.iso;
  return html`<div class="dcard"><div class="dcard-h">
      <span class="dh-rel">${d.label}</span>
      ${iso ? html`<b class="dh-num">${localDay(iso, { day: 'numeric' })}</b><span class="dh-mon">${localDay(iso, { month: 'short' }).replace('.', '')}</span>` : ''}</div>
    <div class="dcard-list">${d.rows.map(agendaRow)}</div></div>`;
}
// «5, 12 y 19 dic»: cada día enlaza a su torneo
function nextDates(list) {
  const shown = list.slice(0, 5);
  const parts = shown.map((m, i) => {
    const mon = localDay(m.date, { month: 'short' }).replace('.', ''), nextMon = shown[i + 1] ? localDay(shown[i + 1].date, { month: 'short' }).replace('.', '') : null;
    return html`<a href="${m.href}">${localDay(m.date, { day: 'numeric' })}${mon !== nextMon ? ` ${mon}` : ''}</a>`;
  });
  return html`${parts.map((p, i) => html`${i ? (i === parts.length - 1 && list.length <= 5 ? ' y ' : ', ') : ''}${p}`)}${list.length > 5 ? html` y ${list.length - 5} más` : ''}`;
}
function agendaRow(a) {
  const meta = a.calOnly ? 'Reserva en la tienda' : !a.players ? (a.places ? `${a.places} plazas` : 'Inscripción abierta') : a.places ? `${a.players} de ${a.places} plazas` : `${a.players} ${a.players === 1 ? 'apuntado' : 'apuntados'}`;
  const full = a.places && a.players >= a.places;
  return html`<article class="ev" style="--g:${a.g.color}">
    <div class="ev-time">${a.date && !a.noTime ? hour(a.date) : ''}</div>
    <div class="ev-main">
      <div class="ev-tags"><span class="ev-game">${a.g.short}</span>${a.fmt ? html`<span>${a.fmt}</span>` : ''}${a.budget ? html`<span class="ev-chip">Mazo máx. ${money(a.budget)}</span>` : ''}${a.bracket ? html`<span class="ev-chip">Bracket ≤ ${a.bracket === 2 ? '1-2' : a.bracket}</span>` : ''}</div>
      <h4 class="ev-name"><a class="a-link" href="${a.href}">${a.name}</a></h4>
      <p class="ev-meta"><span class="${full ? 'full' : ''}">${full ? 'Completo · lista de espera' : meta}</span>${a.places && !full ? html`<span class="ev-bar" aria-hidden="true"><i style="width:${Math.max(4, Math.min(100, Math.round((a.players || 0) / a.places * 100)))}%"></i></span>` : ''}</p>
      ${a.more.length ? html`<p class="ev-next">Cada ${localDay(a.date, { weekday: 'long' })}. También el ${nextDates(a.more)}</p>` : ''}
    </div>
    <div class="ev-side">${a.price != null ? html`<span class="ev-price">${a.price ? money(a.price).replace(',00', '') : 'Gratis'}</span>` : ''}<span class="ev-cta ${a.calOnly || a.cta === 'Ver' ? 'alt' : ''}">${a.cta}</span></div>
  </article>`;
}
const hour = iso => (iso ? new Date(iso).toLocaleTimeString('es-ES', { timeZone: config.tz, hour: '2-digit', minute: '2-digit' }) : '');

function liveTile({ href, color, label, name, round, roundsTotal, done, total, end, players, final }) {
  const pct = total ? Math.round(done * 100 / total) : 0;
  return html`<a class="ltile" href="${href}" style="--g:${color}">
    <div class="lt-top"><span class="jbadge">${label}</span><span class="jbadge live">● En directo</span><span class="lb-clock lt-clock" data-end="${end || ''}"></span></div>
    <div class="lt-name">${name}</div>
    <div class="lt-meta">${final ? 'Mesa final' : html`Ronda <b>${round || '–'}</b>${roundsTotal ? html` de ${roundsTotal}` : ''}`} · ${players} jugadores</div>
    <div class="lb-bar"><i style="width:${pct}%"></i></div>
    <div class="lt-foot"><span>${done}/${total} mesas con resultado</span><span class="jbtn">Buscar mi mesa →</span></div>
  </a>`;
}

r.get('/', (req, res) => {
  const game = req.query.juego || '';
  const live = data.liveTournaments().filter(t => !game || t.game === game);
  const cmdNow = game && game !== 'commander' ? [] : C.liveEvents();
  const games = [...new Set([...db.prepare('SELECT DISTINCT game FROM tournaments WHERE hidden = 0 AND status != 0').all().map(x => x.game),
    ...(feature('calendar') ? require('../jupcal').upcoming(300).map(e => e.game) : [])])].filter(g => g !== 'commander');
  const hasCmd = db.prepare('SELECT COUNT(*) c FROM cmd_events WHERE public = 1').get().c > 0 || (feature('calendar') && require('../jupcal').upcoming(300).some(e => e.game === 'commander'));
  // Agenda: torneos de Melee con inscripción + Commander por empezar
  const agenda = [
    ...(game === 'commander' ? [] : data.upcomingTournaments(400).filter(t => !game || t.game === game).map(t => ({
      href: `/t/${t.id}`, ref: `m:${t.id}`, date: t.start_date, g: melee.gameInfo(t.game), game: t.game, name: t.name, players: data.counts(t.id).total || 0,
      price: t.price_cents, cta: 'Inscribirme', fmt: fmtEs(JSON.parse(t.formats || '[]')[0] || ''),
    }))),
    ...(game && game !== 'commander' ? [] : db.prepare("SELECT * FROM cmd_events WHERE public = 1 AND status = 'setup' ORDER BY start_date").all().map(e => ({
      href: `/commander/${e.id}${e.self_signup ? '#apuntarse' : ''}`, date: e.start_date, g: { short: 'Commander', color: '#7b5ea7' }, game: 'commander', ref: `c:${e.id}`, name: e.name,
      players: C.activeCount(e.id), price: e.price_cents, cta: e.self_signup ? (e.max_players && C.activeCount(e.id) >= e.max_players ? 'Lista de espera' : 'Inscribirme') : 'Ver', fmt: 'Multijugador',
      places: e.max_players,
      budget: e.budget_cents, bracket: e.bracket_max,
    }))),
  ];
  // Eventos publicados del calendario de la web de la tienda: se juntan con su torneo si coincide (día y juego) o salen solos
  if (feature('calendar')) {
    const J = require('../jupcal');
    const cal = J.upcoming(300);
    const P = J.pairs();
    for (const a of agenda) {
      const k = P.byRef.get(a.ref), m = k && cal.find(e => `${e.aid}|${e.day}` === k);
      if (m) { a.cal = m; if (a.price == null && m.price_cents != null) a.price = m.price_cents; }
    }
    for (const e of cal) {
      if (P.byEvent.has(`${e.aid}|${e.day}`)) continue; // ya sale con su torneo
      if (game && e.game !== game) continue;
      agenda.push({ href: `/evento/${e.aid}?d=${e.day}`, date: e.iso, g: melee.gameInfo(e.game), game: e.game, name: e.title, players: null, price: e.price_cents, cta: 'Reservar', fmt: '', calOnly: true, noTime: !e.time });
    }
  }
  agenda.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  // Los semanales (mismo nombre, juego, día de la semana y hora) van en una sola fila con sus próximas fechas
  const rows = [], byKey = new Map();
  for (const a of agenda) {
    const k = a.date ? [a.g.short, normName(a.name), localDay(a.date, { weekday: 'long' }), hour(a.date)].join('|') : null;
    const r = k && byKey.get(k);
    if (r) r.more.push(a); else { const n = { ...a, more: [] }; rows.push(n); if (k) byKey.set(k, n); }
  }
  // Paginación de la agenda
  const PER = 8;
  const pages = Math.max(1, Math.ceil(rows.length / PER));
  const page = Math.min(Math.max(parseInt(req.query.pag, 10) || 1, 1), pages);
  const agendaPage = rows.slice((page - 1) * PER, page * PER);
  // Agrupada por días
  const days = [];
  for (const a of agendaPage) { const l = dayLabel(a.date); const d = days[days.length - 1]; if (d && d.label === l) d.rows.push(a); else days.push({ label: l, iso: a.date, rows: [a] }); }
  const pageHref = n => `/?${new URLSearchParams({ ...(game ? { juego: game } : {}), ...(n > 1 ? { pag: n } : {}) })}#proximos`;
  const results = [
    ...(game === 'commander' ? [] : data.recentTournaments(12).filter(t => !game || t.game === game).map(t => {
      const sm = data.summary(t);
      return { href: `/t/${t.id}`, date: t.start_date || t.last_pair, g: melee.gameInfo(t.game), name: t.name, players: sm.players, winner: sm.winner };
    })),
    ...(game && game !== 'commander' ? [] : db.prepare("SELECT * FROM cmd_events WHERE public = 1 AND status = 'finished' ORDER BY COALESCE(start_date, created_at) DESC LIMIT 6").all().map(e => {
      const st = C.standings(e.id);
      return { href: `/commander/${e.id}`, date: e.start_date || e.created_at, g: { short: 'Commander', color: '#7b5ea7' }, name: e.name, players: st.length, winner: st[0] ? C.pubName(st[0]) : null };
    })),
  ].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 10);

  res.send(String(publicPage('Torneos', html`
    <div class="chips gamechips"><a href="/" class="${!game ? 'on' : ''}">Todos</a>${games.map(gm => html`<a href="/?juego=${gm}" class="${game === gm ? 'on' : ''}" style="--g:${melee.gameInfo(gm).color}"><i></i>${melee.gameInfo(gm).short}</a>`)}
      ${hasCmd ? html`<a href="/?juego=commander" class="${game === 'commander' ? 'on' : ''}" style="--g:#7b5ea7"><i></i>Commander</a>` : ''}</div>
    ${live.length || cmdNow.length ? html`<section><h2 class="sec"><span class="dot-live"></span>En directo</h2><div class="ltiles">
      ${cmdNow.map(e => { const sn = C.snapshot(e.id); return liveTile({ href: `/commander/${e.id}`, color: '#7b5ea7', label: 'Commander', name: e.name, round: sn.round, roundsTotal: sn.roundsPlanned, done: sn.done, total: sn.pods.length, end: sn.timerEnd, players: sn.players, final: sn.roundKind === 'final' }); })}
      ${live.map(t => { const sm = data.summary(t); const g = melee.gameInfo(t.game); return liveTile({ href: `/t/${t.id}`, color: g.color, label: g.short, name: t.name, round: sm.round, roundsTotal: sm.roundsTotal, done: sm.done, total: sm.total, end: sm.timerEnd, players: sm.players }); })}
    </div></section>` : ''}
    ${(() => {
      const K = require('../community');
      const bs = feature('bounties') ? K.bounties({ status: 'active' }) : [];
      const live = (data.liveTournaments().length || C.liveEvents().length) && feature('porra');
      if (!bs.length && !live) return '';
      return html`<div class="commstrip">${bs.length ? html`<a class="cs-wanted" href="/recompensas"><b>Se busca</b><span>${bs.slice(0, 3).map(b => people.publicName(b.person_key)).join(', ')}${bs.length > 3 ? '…' : ''}</span><em>Recompensa: ${bs[0].reward}${bs.length > 1 ? ' y más' : ''}</em></a>` : ''}
        ${live ? html`<a class="cs-porra" href="/porra"><b>Porra</b><span>¿Quién gana cada mesa? Pronostica y suma puntos</span></a>` : ''}</div>`;
    })()}
    <section id="proximos"><div class="sec-row"><h2 class="sec">Próximos torneos</h2>${settings().calendar_url ? html`<a class="jbtn-outline" href="${settings().calendar_url}" rel="noopener">Calendario de la tienda →</a>` : ''}</div>
      ${agenda.length ? html`<div class="sched">${days.map(dayCard)}</div>
      ${pages > 1 ? html`<nav class="pager" aria-label="Páginas de próximos torneos">
        ${page > 1 ? html`<a class="jbtn-outline" href="${pageHref(page - 1)}" rel="prev">← Anteriores</a>` : html`<span></span>`}
        <span class="pg-n">${(page - 1) * PER + 1}–${Math.min(page * PER, rows.length)} de ${rows.length}</span>
        ${page < pages ? html`<a class="jbtn-outline" href="${pageHref(page + 1)}" rel="next">Siguientes →</a>` : html`<span></span>`}</nav>` : ''}`
      : html`<p class="muted">No hay torneos con inscripción abierta ahora mismo.</p>`}
    </section>
    ${results.length ? html`<section><h2 class="sec">Últimos resultados</h2><div class="results">${results.map(x => html`<a class="rrow" href="${x.href}" style="--g:${x.g.color}">
      <span class="r-date">${fmtDate(x.date, { weekday: undefined, hour: undefined, minute: undefined, day: 'numeric', month: 'short' })}</span>
      <span class="gchip"><i></i>${x.g.short}</span><span class="r-name">${x.name}</span>
      <span class="r-win">${x.winner ? html`${TR}<b>${x.winner}</b>` : ''}</span><span class="r-pl">${x.players} jug.</span><span class="r-go">→</span></a>`)}</div></section>` : ''}
    <script src="/static/ui.js"></script><script>setInterval(UI.tickClocks, 1000); UI.tickClocks();${raw(live.length || cmdNow.length ? ' setTimeout(() => location.reload(), 60000);' : '')}</script>
  `)));
});

// QR en SVG para cualquier texto (carteles, mesas)
r.get('/qr.svg', async (req, res) => {
  const text = String(req.query.d || '').slice(0, 800);
  if (!text) return res.status(400).send('Falta d');
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000', light: '#fff' } });
  res.set('Cache-Control', 'public, max-age=86400').type('image/svg+xml').send(svg);
});

function publicTournament(id) {
  const t = data.tournament(id);
  if (!t || t.hidden || t.status === 0) return null;
  return t;
}

r.get('/evento/:aid', (req, res) => {
  const J = require('../jupcal');
  const a = feature('calendar') ? J.act(Number(req.params.aid)) : null;
  if (!a || !a.visible) return res.status(404).send(String(publicPage('No encontrado', html`<p>Evento no encontrado.</p><p><a href="/">← Próximos torneos</a></p>`)));
  const dates = J.datesOf(a.aid);
  const g = melee.gameInfo(a.game);
  const dl = d => { const t = new Date(d.day + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }); return t.charAt(0).toUpperCase() + t.slice(1) + (d.time ? ` · ${d.time}` : ''); };
  const sel = String(req.query.d || '');
  res.send(String(publicPage(a.title, html`
    <div class="thead nomedia" style="--g:${g.color}"><div class="thead-info">
      <div class="tcard-badges static"><span class="jbadge">${g.label}</span></div>
      <h1>${a.title}</h1>
      ${dates.length ? html`<p class="tdate">${dl(dates.find(d => d.day === sel) || dates[0])}</p>` : html`<p class="tdate">Sin fechas próximas</p>`}
      <div class="thead-cta">${a.price ? html`<span class="tcard-price big">${a.price_cents === 0 ? 'Gratis' : a.price}</span>` : ''}
        ${a.signup ? html`<a class="jbtn big" href="${a.signup}" rel="noopener" target="_blank">Reservar plaza en la tienda</a>` : ''}</div></div></div>
    ${dates.length > 1 ? html`<section class="infobox"><h2>Próximas fechas</h2><ul class="caldates">${dates.slice(0, 12).map(d => html`<li class="${d.day === sel ? 'on' : ''}">${dl(d)}</li>`)}</ul></section>` : ''}
    ${a.infoHtml ? html`<section class="infobox"><h2>Información</h2><div class="calhtml">${raw(a.infoHtml)}</div></section>` : ''}
    ${a.img ? html`<p class="calimg"><img src="${a.img}" alt="Cartel de ${a.title}" loading="lazy"></p>` : ''}
    <p class="small muted">Información de <a href="${a.url}" rel="noopener" target="_blank">jupiterjuegos.com</a>. La inscripción y el pago se hacen en su web o en la tienda.</p>
    <p><a href="/">← Próximos torneos</a></p>`)));
});
// Información del evento en la web de la tienda (si está publicado en el calendario y coincide en día y juego)
// Si el torneo ya tiene su propia información, del calendario solo se muestran precio y botones (si no, sale repetido)
// Información del torneo: si es el mismo texto que el de la web de la tienda (pegado sin formato), se muestra el de su web, con formato
function infoHtml(ref, own) {
  if (feature('calendar')) {
    const J = require('../jupcal');
    const m = J.match({ ref }), a = m && J.act(m.aid);
    if (a && a.infoHtml && J.sameText(own, a.infoText)) return html`<div class="calhtml">${raw(a.infoHtml)}</div>`;
  }
  return richText(own);
}
function calBox(ref, ownInfo) {
  if (!feature('calendar')) return '';
  const J = require('../jupcal');
  const m = J.match({ ref });
  if (!m) return '';
  const a = J.act(m.aid) || {};
  return html`<section class="infobox calbox"><h2>En la web de la tienda</h2>
    <div class="calbox-top">${a.price ? html`<span class="tcard-price big">${a.price_cents === 0 ? 'Gratis' : a.price}</span>` : ''}
      ${a.signup ? html`<a class="jbtn" href="${a.signup}" rel="noopener" target="_blank">Reservar plaza en la tienda</a>` : ''}
      ${a.url ? html`<a class="jbtn-outline" href="${a.url}" rel="noopener" target="_blank">Ver en jupiterjuegos.com</a>` : ''}</div>
    ${a.infoHtml && !ownInfo ? html`<details class="calinfo"><summary>Reglas, premios y más información</summary><div class="calhtml">${raw(a.infoHtml)}</div></details>` : ''}</section>`;
}
r.get('/t/:id', (req, res) => {
  const t = publicTournament(Number(req.params.id));
  if (!t) return res.status(404).send(String(publicPage('No encontrado', html`<p>Torneo no encontrado.</p>`)));
  const snap = { ...data.liveSnapshot(t.id), profiles: feature('profiles'), tg: require('../tgbot').enabled() };
  const u = melee.urlsFor(t);
  const price = t.price_cents;
  res.send(String(publicPage(t.name, html`
    <div class="thead ${snap.live ? 'is-live' : ''} ${media(realImage(t.brand_image), t.game) ? '' : 'nomedia'}" style="--g:${melee.gameInfo(t.game).color}">
      ${(() => { const m = media(realImage(t.brand_image), t.game); return m ? html`<div class="thead-media ${m.cls}" style="${m.style}">${m.cls === 'art' ? html`<span>${melee.gameInfo(t.game).short}</span>` : ''}</div>` : ''; })()}
      <div class="thead-info">
        <div class="tcard-badges static"><span class="jbadge">${melee.gameInfo(t.game).label}</span>
          <span class="jbadge ${snap.live ? 'live' : ''}">${snap.live ? '● En juego' : t.status_desc}</span></div>
        <h1>${t.name}</h1>
        <p class="tdate">${fmtDate(t.start_date, { weekday: 'long', month: 'long' })}</p>
        <p class="tmeta">${snap.players.total ? html`${snap.players.total} jugadores` : ''}${t.rounds_total ? html` · ${t.rounds_total} rondas` : ''}</p>
        <div class="thead-cta">${price != null && t.status === 1 ? html`<span class="tcard-price big">${money(price)}</span>` : ''}
          ${t.status === 1 ? html`<a class="jbtn big" href="${u.view}" rel="noopener">Inscribirme en ${u.name}</a>` : html`<a class="jbtn-outline" href="${u.view}" rel="noopener">Ver en ${u.name} →</a>`}</div>
      </div>
    </div>
    ${t.info && !snap.live ? html`<section class="infobox"><h2>Información</h2>${infoHtml(`m:${t.id}`, t.info)}</section>` : ''}
    ${!snap.live ? calBox(`m:${t.id}`, !!t.info) : ''}
    <div id="live" data-id="${t.id}"></div>
    ${t.info && snap.live ? html`<section class="infobox after"><h2>Información</h2>${infoHtml(`m:${t.id}`, t.info)}</section>` : ''}
    ${snap.live ? html`<p class="melee-out"><a class="jbtn-outline" href="${u.view}" rel="noopener">Ver este torneo en ${u.name}</a></p>` : ''}
    <script>window.__SNAP = ${json(snap)};</script>
    <script src="/static/ui.js"></script><script src="/static/tournament.js"></script>
  `)));
});

r.get('/t/:id/estado.json', (req, res) => {
  const t = publicTournament(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'no encontrado' });
  res.set('Cache-Control', 'no-store').json({ ...data.liveSnapshot(t.id), profiles: feature('profiles'), tg: require('../tgbot').enabled() });
});

// Apuntarse a los avisos personales por Telegram (redirige al bot con un código de un solo uso por persona)
r.get('/avisos/:key', async (req, res) => {
  const tg = require('../tgbot');
  const key = String(req.params.key || '').slice(0, 200);
  if (!tg.enabled() || !/^(u|n|p|a):/.test(key)) return res.status(404).send(String(publicPage('No disponible', html`<p>Los avisos por Telegram no están activados.</p>`)));
  const url = await tg.link(key, String(req.query.n || '').slice(0, 60)).catch(() => null);
  if (!url) return res.status(503).send(String(publicPage('No disponible', html`<p>No se puede conectar con Telegram ahora mismo. Prueba en un rato.</p>`)));
  res.redirect(url);
});

// QR de mesa: muestra la partida que se juega en esa mesa en cualquier torneo en directo
r.get('/mesa/:n', (req, res) => {
  const n = Number(req.params.n);
  const live = data.liveTournaments();
  const blocks = live.map(t => {
    const round = data.currentRound(t.id);
    const m = data.pairings(t.id, round).find(p => p.table === n);
    return { t, round, m };
  }).filter(b => b.m);
  res.send(String(publicPage(`Mesa ${n}`, html`
    <h1 class="center">Mesa ${n}</h1>
    ${blocks.length ? blocks.map(({ t, round, m }) => html`
      <div class="mesa-card">
        <div class="muted">${t.name} · Ronda ${round}</div>
        <div class="vs"><span>${m.p1}</span><em>vs</em><span>${m.p2 || 'BYE'}</span></div>
        ${m.hasResult ? html`<div class="ok">Resultado: ${m.result}</div>` : html`<div class="muted">Pendiente de resultado · repórtalo en ${melee.urlsFor(t).app}</div>`}
        <a class="btn ghost" href="/t/${t.id}">Ver emparejamientos y clasificación</a>
      </div>`) : html`<p class="center muted">Ahora mismo no hay ninguna partida en esta mesa.</p>
      ${live.length ? html`<p class="center">${live.map(t => html`<a class="btn ghost" href="/t/${t.id}">${t.name}</a> `)}</p>` : ''}`}
    <script>setTimeout(()=>location.reload(), 30000)</script>
  `)));
});

// Liga pública
r.get('/liga', (req, res) => {
  const seasons = db.prepare('SELECT * FROM seasons WHERE public = 1 ORDER BY end_date DESC').all();
  res.send(String(publicPage('Ligas', html`<h1>Ligas de la tienda</h1>
    ${seasons.length ? html`<div class="grid">${seasons.map(s => card({ href: `/liga/${s.id}`, color: melee.gameInfo(s.game).color,
      label: melee.gameInfo(s.game).short, art: s.game, date: `${s.start_date} → ${s.end_date}`, name: s.name, cta: 'Ver clasificación' }))}</div>` : html`<p class="muted">Todavía no hay ligas publicadas.</p>`}`)));
});

r.get('/liga/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM seasons WHERE id = ? AND public = 1').get(Number(req.params.id));
  if (!s) return res.status(404).send(String(publicPage('No encontrado', html`<p>Liga no encontrada.</p>`)));
  const { rows } = stats.leagueTable(s);
  const all = stats.seasonTournaments(s);
  const cmd = s.game === 'commander';
  const g = melee.gameInfo(s.game);
  // Torneos ya jugados de la liga (con ganador) y próximos que puntuarán
  const played = all.slice().reverse().map(t => {
    if (cmd) {
      const st = C.standings(t.cmdId);
      return { href: `/commander/${t.cmdId}`, name: t.name, date: t.start_date, players: st.filter(p => p.played).length, winner: st[0] ? C.pubName(st[0]) : null, excluded: t.excluded };
    }
    const sm = data.summary(t);
    return { href: `/t/${t.id}`, name: t.name, date: t.start_date || t.last_pair, players: sm.players, winner: sm.winner, excluded: t.excluded };
  });
  const upcoming = cmd
    ? db.prepare(`SELECT * FROM cmd_events WHERE public = 1 AND status IN ('setup','running')
        AND (start_date IS NULL OR date(start_date) <= date(?)) ORDER BY start_date`).all(s.end_date)
      .map(e => ({ href: `/commander/${e.id}`, name: e.name, date: e.start_date, live: e.status === 'running' }))
    : db.prepare(`SELECT * FROM tournaments WHERE game = ? AND hidden = 0 AND status IN (1,2)
        AND (start_date IS NULL OR date(start_date) <= date(?)) ORDER BY start_date`).all(s.game, s.end_date)
      .map(t => ({ href: `/t/${t.id}`, name: t.name, date: t.start_date, live: data.isLive(t) }));
  const today = new Date().toISOString().slice(0, 10);
  const ended = today > s.end_date;
  const link = r => (feature('profiles') && r.key ? html`<a class="plink" href="/jugador/${encodeURIComponent(r.key)}">${r.name}</a>` : r.name);

  res.send(String(publicPage(s.name, html`
    <div class="lhead" style="--g:${g.color}">
      <div><span class="gchip"><i></i>${g.short}</span><h1>${s.name}</h1>
        <p class="muted">${fmtDay(s.start_date)} → ${fmtDay(s.end_date)}${ended ? ' · terminada' : ''}</p></div>
      <div class="lrules">${cmd
    ? html`<span><b>Puntos del evento</b> 4 o 3 por mesa ganada</span>`
    : html`<span><b>${s.pts_win}</b> victoria</span><span><b>${s.pts_draw}</b> empate</span>`}
        <span><b>${s.pts_attend}</b> por asistir</span>${s.pts_bonus ? html`<span><b>${s.pts_bonus}</b> bonus 1º, 2º…</span>` : ''}</div>
    </div>
    <div class="lgrid">
      <section class="lmain">
        ${rows.length >= 3 ? html`<div class="podium">${rows.slice(0, 3).map((r, i) => html`<div class="pod-${i + 1}"><span class="pm">${i + 1}º</span><b>${link(r)}</b><small>${r.points} pts · ${r.events} torneos</small></div>`)}</div>` : ''}
        ${rows.length ? html`<div class="tablewrap"><table class="tbl stand"><thead><tr><th>#</th><th>Jugador</th><th class="num">Pts</th><th class="num">Torneos</th><th class="num">V-D-E</th><th class="num">1º</th></tr></thead>
          <tbody>${rows.map(r => html`<tr><td class="rk">${r.pos}</td><td>${link(r)}</td><td class="num strong">${r.points}</td><td class="num">${r.events}</td><td class="num">${r.w}-${r.l}-${r.d}</td><td class="num">${r.wins || ''}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">La clasificación aparecerá cuando termine el primer torneo de la liga.</p>`}
      </section>
      <aside class="lside">
        ${!ended ? html`<div class="lbox"><h3>Próximos torneos</h3>${upcoming.length ? upcoming.map(u => html`<a class="lrow" href="${u.href}">
          ${dateTile(u.date)}<span class="lname">${u.name}${u.live ? html` <span class="chip live sm">En juego</span>` : ''}</span><span class="r-go">→</span></a>`)
    : html`<p class="muted small">No hay torneos anunciados todavía.</p>`}</div>` : ''}
        <div class="lbox"><h3>Torneos de la liga (${played.filter(p => !p.excluded).length})</h3>${played.length ? played.map(p => html`<a class="lrow ${p.excluded ? 'dim' : ''}" href="${p.href}">
          ${dateTile(p.date)}<span class="lname">${p.name}<small>${p.winner ? html`Ganó ${p.winner} · ` : ''}${p.players} jug.${p.excluded ? ' · no puntúa' : ''}</small></span><span class="r-go">→</span></a>`)
    : html`<p class="muted small">Aún no se ha jugado ninguno.</p>`}</div>
      </aside>
    </div>`)));
});

// Snapshot de Commander con la clave de persona (para enlazar al perfil)
function cmdSnap(id) {
  const snap = C.snapshot(id);
  const idx = people.nameIndex();
  const raw = new Map(C.players(id).map(p => [p.id, p]));
  const k = pid => (raw.get(pid) ? people.cmdKey(raw.get(pid), idx) : null);
  snap.standings.forEach(s => { s.pkey = k(s.id); });
  snap.roster.forEach(s => { s.pkey = k(s.id); });
  snap.profiles = feature('profiles');
  snap.tg = require('../tgbot').enabled();
  const lives = require('../life').summary((snap.pods || []).map(p => p.id));
  for (const pod of snap.pods || []) pod.life = lives.get(pod.id) || null;
  return snap;
}

// Perfil público de jugador
r.get('/jugador/:key', (req, res) => {
  if (!feature('profiles')) return res.status(404).send(String(publicPage('No disponible', html`<p>Los perfiles no están activados.</p>`)));
  const canon = require('../identity').resolve(req.params.key);
  if (canon !== req.params.key) return res.redirect(`/jugador/${encodeURIComponent(canon)}`);
  const p = people.profile(req.params.key);
  if (!p) return res.status(404).send(String(publicPage('No encontrado', html`<p>Jugador no encontrado.</p>`)));
  const gName = g => melee.gameInfo(g).short;
  const pct = p.w + p.l + p.d ? Math.round(p.w * 100 / (p.w + p.l + p.d)) : 0;
  res.send(String(publicPage(p.name, html`
    <div class="phead"><div class="avatar">${p.name.slice(0, 1).toUpperCase()}</div>
      <div><h1>${p.name}</h1>${feature('badges') ? require('./comunidad').featuredChips(p.key) : ''}<p class="muted">${p.games.map(g => html`<span class="gchip" style="--g:${melee.gameInfo(g.game).color}"><i></i>${gName(g.game)}</span> `)}</p></div></div>
    <div class="ptiles"><div><b>${p.events}</b><span>eventos</span></div><div><b>${p.titles}</b><span>torneos ganados</span></div>
      <div><b>${p.top3}</b><span>podios</span></div><div><b>${p.w}-${p.l}-${p.d}</b><span>V-D-E</span></div><div><b>${pct}%</b><span>victorias</span></div>
      ${(() => { const lo = feature('badges') ? (require('../badges').of(p.key).loyalty || null) : null; if (!lo || !lo.since) return '';
        const since = new Date(lo.since + 'T12:00:00').toLocaleDateString('es-ES', { month: 'short', year: 'numeric' });
        return html`<div><b>${since}</b><span>jugando en la tienda</span></div>${lo.weekStreak >= 2 ? html`<div><b>${lo.weekStreak}</b><span>semanas seguidas</span></div>` : ''}`; })()}</div>
    ${(() => { if (!feature('badges')) return ''; const CM = require('./comunidad'); const st = require('../badges').of(p.key); return html`<section><div class="sec-row"><h2 class="sec">Nivel e insignias</h2><a class="small" href="/logros">Cómo funciona</a></div>
      ${CM.levelCard(st)}${CM.specialGrid(st.specials || [])}${st.earned ? CM.badgeGrid(st, { all: false }) : (st.specials || []).length ? '' : html`<p class="muted small">Aún sin insignias.</p>`}</section>`; })()}
    ${(() => {
      const R = require('../rivals').rivals(p.key);
      if (!R.list.length) return '';
      const nm = k => people.publicName(k);
      const vs = k => `/vs/${encodeURIComponent(p.key)}/${encodeURIComponent(k)}`;
      return html`<section><h2 class="sec">Rivales</h2>
        ${R.nemesis || R.victim ? html`<div class="nemcards">
          ${R.nemesis ? html`<a class="nemcard nem" href="${vs(R.nemesis.key)}"><small>Su némesis</small><b>${nm(R.nemesis.key)}</b><span>le ha ganado ${R.nemesis.l} ${R.nemesis.l === 1 ? 'vez' : 'veces'} (${R.nemesis.w}-${R.nemesis.l}${R.nemesis.d ? `-${R.nemesis.d}` : ''})</span></a>` : ''}
          ${R.victim ? html`<a class="nemcard vic" href="${vs(R.victim.key)}"><small>Su víctima favorita</small><b>${nm(R.victim.key)}</b><span>le ha ganado ${R.victim.w} ${R.victim.w === 1 ? 'vez' : 'veces'} (${R.victim.w}-${R.victim.l}${R.victim.d ? `-${R.victim.d}` : ''})</span></a>` : ''}</div>` : ''}
        <div class="results">${R.list.slice(0, 8).map(x => html`<a class="rrow rivrow" href="${vs(x.key)}"><span class="r-name"><b>${nm(x.key)}</b></span><span class="r-pl">${x.games} ${x.games === 1 ? 'duelo' : 'duelos'}</span><span class="r-win">${x.w}-${x.l}${x.d ? `-${x.d}` : ''}</span><span class="r-go">→</span></a>`)}</div></section>`;
    })()}
    ${(() => { const cs = require('../cmdstats').byPerson(p.key); if (!cs.length) return '';
      return html`<section><div class="sec-row"><h2 class="sec">Comandantes</h2><a class="small" href="/comandantes">Ranking de la tienda</a></div>
        <p class="small muted">${cs.length} ${cs.length === 1 ? 'comandante distinto' : 'comandantes distintos'} · ${cs.reduce((n, c) => n + c.games, 0)} mesas</p>
        <div class="results">${cs.slice(0, 12).map(c => html`<div class="rrow cmdrow"><span class="r-name"><b>${c.name}</b></span><span class="r-pl">${c.games} ${c.games === 1 ? 'mesa' : 'mesas'}${c.kills ? ` · ${c.kills} elim.` : ''}</span><span class="r-win">${c.wins} ${c.wins === 1 ? 'victoria' : 'victorias'} · ${Math.round(c.rate * 100)}%</span></div>`)}</div></section>`; })()}
    ${p.games.length > 1 ? html`<section><h2 class="sec">Por juego</h2><div class="pgames">${p.games.map(g => html`<div style="--g:${melee.gameInfo(g.game).color}">
      <span class="gchip"><i></i>${gName(g.game)}</span><b>${g.events}</b><small>eventos · ${g.w}-${g.l}-${g.d}${g.titles ? ` · ${g.titles} ${g.titles === 1 ? 'título' : 'títulos'}` : ''}${g.best ? ` · mejor ${g.best}º` : ''}</small></div>`)}</div></section>` : ''}
    <section><h2 class="sec">Historial</h2><div class="results">${p.entries.map(e => html`<a class="rrow" href="${e.href}" style="--g:${melee.gameInfo(e.game).color}">
      <span class="r-date">${fmtDate(e.date, { weekday: undefined, hour: undefined, minute: undefined, day: 'numeric', month: 'short' })}</span>
      <span class="gchip"><i></i>${gName(e.game)}</span><span class="r-name">${e.event}${e.deck ? html` <small class="muted">· ${e.deck}</small>` : ''}</span>
      <span class="r-win">${e.rank ? html`${e.rank === 1 && e.finished ? TR : ''}<b>${e.rank}º</b>` : ''}</span><span class="r-pl">${e.record}</span><span class="r-go">→</span></a>`)}</div></section>`)));
});

// Mazos preconstruidos de Commander (para rellenar la lista en «Valor de mazo»)
r.get('/precons.json', async (req, res) => {
  if (!precons.status().count) await precons.refresh().catch(() => {});
  res.set('Cache-Control', 'public, max-age=900').json(precons.list().map(p => ({
    f: p.file, n: p.name, c: p.code, y: (p.release || '').slice(0, 4), k: p.commander || null, col: p.colors || null,
  })));
});
r.get('/precons/:file', async (req, res) => {
  try {
    const t = await precons.text(String(req.params.file).slice(0, 200));
    res.set('Cache-Control', 'public, max-age=86400').json({ text: t.text, commander: t.commander, cards: t.cards });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// Meta público por cartas
r.get('/meta', (req, res) => {
  if (!feature('meta')) return res.status(404).send(String(publicPage('No disponible', html`<p>El meta no está activado.</p>`)));
  // Todos los juegos con torneos en la tienda (aunque aún no haya listas con cartas)
  const withCards = decks.gamesWithCards().map(g => g.game);
  const games = [...new Set([...withCards, ...db.prepare("SELECT DISTINCT game FROM tournaments WHERE hidden = 0 AND game IS NOT NULL AND game != ''").all().map(x => x.game)])];
  const hasCmdMeta = db.prepare("SELECT 1 FROM cmd_players p JOIN cmd_events e ON e.id = p.event_id WHERE e.public = 1 AND p.deck_value_cents IS NOT NULL LIMIT 1").get();
  if (req.query.juego === 'commander' && hasCmdMeta) return res.send(metaCommander(req, games));
  const game = games.includes(req.query.juego) ? req.query.juego : withCards.includes('CyberpunkTCG') ? 'CyberpunkTCG' : withCards[0] || games[0];
  const typeEs = t => ({ Legend: 'Leyenda', Unit: 'Unidad', Gear: 'Equipo', Program: 'Programa' }[t] || t || '');
  const days = [30, 90, 365].includes(Number(req.query.dias)) ? Number(req.query.dias) : 90;
  const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10), to = new Date().toISOString().slice(0, 10);
  const baraja = req.query.ver === 'winrate' && req.query.baraja ? String(req.query.baraja).slice(0, 120) : '';
  const cm = game ? decks.cardMeta(game, from, to, { deck: baraja }) : { decks: 0, groups: [], rows: [] };
  const g = game ? melee.gameInfo(game) : null;
  const imgs = game && cardimg.hasImages(game);
  const view = ['winrate', 'barajas'].includes(req.query.ver) ? req.query.ver : 'uso';
  const q = (k, v) => { const vv = k === 'ver' ? v : view; const bj = k === 'baraja' ? v : k === 'juego' || k === 'ver' ? '' : baraja;
    return `/meta?juego=${encodeURIComponent(k === 'juego' ? v : game)}&dias=${k === 'dias' ? v : days}${vv !== 'uso' ? `&ver=${vv}` : ''}${bj ? `&baraja=${encodeURIComponent(bj)}` : ''}`; };
  const dwAll = game && (view === 'barajas' || view === 'winrate') ? decks.deckWinrate(game, from, to) : null;
  const dw = view === 'barajas' ? dwAll : null;
  const deckRow = (c, i) => {
    const diff = dw.baseWinrate != null ? c.winrate - dw.baseWinrate : 0;
    return html`<div class="mrow wr">
      <span class="m-pos">${i + 1}</span>
      <div class="m-name"><a class="m-deck" href="${q('baraja', c.name).replace('ver=barajas', 'ver=winrate')}">${c.name}</a><small>${c.w}-${c.l}${c.d ? `-${c.d}` : ''} en ${c.games} partidas · ${c.decks} ${c.decks === 1 ? 'jugador' : 'jugadores'} (${c.pct}% del meta)${c.top4 ? ` · ${c.top4} en Top 4` : ''}${c.champs ? ` · ${c.champs} ${c.champs === 1 ? 'torneo ganado' : 'torneos ganados'}` : ''}</small></div>
      <div class="m-bar wrbar ${diff >= 5 ? 'up' : diff <= -5 ? 'down' : ''}"><span style="width:${c.winrate}%"></span>${dw.baseWinrate != null ? html`<i style="left:${dw.baseWinrate}%" title="Media: ${dw.baseWinrate}%"></i>` : ''}<b>${c.winrate}%</b><small>de victorias</small></div>
      <div class="m-top"><b class="${diff > 0 ? 'pos' : diff < 0 ? 'neg' : ''}">${diff > 0 ? '+' : ''}${diff}</b><small>vs. media</small></div></div>`;
  };
  const row = (c, i) => view === 'winrate' ? wrRow(c, i) : useRow(c, i);
  const cardName = c => {
    const url = cardimg.cardUrl(game, c.name);
    const imgPath = imgs ? `/carta/${encodeURIComponent(game)}/${encodeURIComponent(c.name)}` : '';
    const img = imgs ? config.basePath + imgPath : '';
    return { url, imgPath, img, name: url ? html`<a href="${url}" target="_blank" rel="noopener" ${img ? raw(`data-card="${img}"`) : ''}>${c.name}</a>` : c.name };
  };
  const wrRow = (c, i) => {
    const { url, imgPath, img, name } = cardName(c);
    const diff = cm.baseWinrate != null ? c.winrate - cm.baseWinrate : 0;
    return html`<div class="mrow wr">
      <span class="m-pos">${i + 1}</span>
      ${imgs ? html`<a class="m-img" ${url ? raw(`href="${url}" target="_blank" rel="noopener"`) : ''} data-card="${img}"><img src="${imgPath}" alt="" loading="lazy" onerror="this.parentNode.classList.add('noimg');this.parentNode.removeAttribute('data-card');this.remove()"></a>` : ''}
      <div class="m-name">${name}<small>${c.w}-${c.l}${c.d ? `-${c.d}` : ''} en ${c.games} partidas · ${baraja ? `en ${c.decks} de ${cm.decks} mazos de la baraja (${c.pct}%)${c.wo && c.wo.winrate != null ? ` · sin ella: ${c.wo.winrate}% en ${c.wo.games}` : ' · la llevan todos'}` : `${c.decks} mazos (${c.pct}% del meta)`}</small></div>
      <div class="m-bar wrbar ${diff >= 5 ? 'up' : diff <= -5 ? 'down' : ''}"><span style="width:${c.winrate}%"></span>${cm.baseWinrate != null ? html`<i style="left:${cm.baseWinrate}%" title="Media: ${cm.baseWinrate}%"></i>` : ''}<b>${c.winrate}%</b><small>de victorias</small></div>
      <div class="m-top"><b class="${diff > 0 ? 'pos' : diff < 0 ? 'neg' : ''}">${diff > 0 ? '+' : ''}${diff}</b><small>vs. media</small></div></div>`;
  };
  const useRow = (c, i) => {
    const url = cardimg.cardUrl(game, c.name);
    const imgPath = imgs ? `/carta/${encodeURIComponent(game)}/${encodeURIComponent(c.name)}` : '';
    const img = imgs ? config.basePath + imgPath : ''; // para el JS (los src/href ya llevan el prefijo al servir)
    const name = url ? html`<a href="${url}" target="_blank" rel="noopener" ${img ? raw(`data-card="${img}"`) : ''}>${c.name}</a>` : c.name;
    return html`<div class="mrow">
      <span class="m-pos">${i + 1}</span>
      ${imgs ? html`<a class="m-img" ${url ? raw(`href="${url}" target="_blank" rel="noopener"`) : ''} data-card="${img}"><img src="${imgPath}" alt="" loading="lazy" onerror="this.parentNode.classList.add('noimg');this.parentNode.removeAttribute('data-card');this.remove()"></a>` : ''}
      <div class="m-name">${name}<small>${[c.type && c.kind !== 'legend' ? typeEs(c.type) : '', c.kind === 'legend' ? '' : c.avg === 1 ? '1 copia de media' : `${String(c.avg).replace('.', ',')} copias de media`, c.winrate != null && c.games >= 6 ? `${c.winrate}% victorias` : ''].filter(Boolean).join(' · ')}</small></div>
      <div class="m-bar"><span style="width:${c.pct}%"></span><b>${c.pct}%</b><small>de los mazos</small></div>
      <div class="m-top">${c.top4 ? html`<b>${c.top4pct}%</b><small>del Top 4</small>` : html`<small class="muted">—</small>`}</div></div>`;
  };
  res.send(String(publicPage('Meta', html`
    <h1>Meta de la tienda</h1>
    <p class="muted">${view === 'barajas' ? 'Las barajas (combinación del mazo) que más ganan' : view === 'winrate' ? 'Las cartas cuyos mazos más ganan' : 'Las cartas más jugadas'} en los torneos de la tienda, según las listas registradas en Melee.</p>
    ${games.length ? html`<div class="chips gamechips">${games.map(x => html`<a href="${q('juego', x)}" class="${x === game ? 'on' : ''}" style="--g:${melee.gameInfo(x).color}"><i></i>${melee.gameInfo(x).short}</a>`)}${hasCmdMeta ? html`<a href="/meta?juego=commander" style="--g:#7b5ea7"><i></i>Commander</a>` : ''}</div>` : ''}
    <div class="chips">${[[30, 'Último mes'], [90, 'Últimos 3 meses'], [365, 'Último año']].map(([d, l]) => html`<a href="${q('dias', d)}" class="${d === days ? 'on' : ''}">${l}</a>`)}</div>
    ${(() => {
      const tabs = html`<div class="tabs metatabs" role="tablist"><a role="tab" href="${q('ver', 'uso')}" class="${view === 'uso' ? 'on' : ''}">Más jugadas</a><a role="tab" href="${q('ver', 'winrate')}" class="${view === 'winrate' ? 'on' : ''}">Win rate de cartas</a><a role="tab" href="${q('ver', 'barajas')}" class="${view === 'barajas' ? 'on' : ''}">Win rate de barajas</a></div>`;
      if (view === 'barajas') return dw && dw.decks ? html`<p class="metasum" style="--g:${g.color}"><b>${dw.decks}</b> mazos de ${g.label} · <b>${dw.games}</b> partidas · media <b>${dw.baseWinrate ?? '—'}%</b></p>${tabs}
        <p class="small muted wrnote">Partidas ganadas por cada baraja: la combinación del mazo, tal como sale en el nombre de la lista en Melee. Sin contar byes. Solo barajas con al menos 2 jugadores y ${dw.minGames} partidas. Toca una baraja para ver el win rate de cada carta dentro de ella.</p>
        ${dw.rows.length ? html`<div class="mlist">${dw.rows.slice(0, 60).map(deckRow)}</div>` : html`<p class="muted">Todavía no hay barajas con partidas suficientes en este periodo. Prueba con un periodo más largo.</p>`}
        ${dw.few.length ? html`<details class="wrfew"><summary>Con pocas partidas todavía (${dw.few.length})</summary><p class="small muted">${dw.few.slice(0, 80).map(c => `${c.name} (${c.w}-${c.l}${c.d ? `-${c.d}` : ''})`).join(' · ')}</p></details>` : ''}`
        : html`${tabs}<p class="muted">Todavía no hay listas de ${g ? g.label : 'este juego'} en este periodo.</p>`;
      return cm.decks ? html`<p class="metasum" style="--g:${g.color}">${baraja ? html`<b>${cm.decks}</b> mazos de <b>${baraja}</b> · media <b>${cm.baseWinrate ?? '—'}%</b> · <a href="${q('baraja', '')}">ver todas</a>` : html`<b>${cm.decks}</b> mazos de ${g.label} · <b>${cm.top4Decks}</b> en el Top 4`}</p>${tabs}
      ${view === 'winrate' ? html`
        ${dwAll && dwAll.rows.length + dwAll.few.length ? html`<form class="barsel" method="get" action="/meta"><input type="hidden" name="juego" value="${game}"><input type="hidden" name="dias" value="${days}"><input type="hidden" name="ver" value="winrate">
          <label for="bj">Baraja</label><select id="bj" name="baraja" onchange="this.form.submit()"><option value="">Todas las barajas</option>
          ${[...dwAll.rows, ...dwAll.few].sort((a, b) => b.decks - a.decks || a.name.localeCompare(b.name)).map(x => html`<option value="${x.name}" ${decks.deckKey(x.name) === decks.deckKey(baraja) ? 'selected' : ''}>${x.name} (${x.decks})</option>`)}</select>
          <noscript><button class="jbtn-outline">Ver</button></noscript></form>` : ''}
        <p class="small muted wrnote">${baraja
          ? html`Win rate de cada carta dentro de <b>${baraja}</b>: partidas ganadas por los mazos de esta baraja que la llevan, comparado con la media de la baraja (${cm.baseWinrate ?? '—'}%) y con los que no la llevan. Solo cartas en al menos 2 mazos y ${cm.minGames} partidas.`
          : html`Porcentaje de partidas ganadas por los mazos que llevan cada carta (sin contar byes). Solo salen cartas con al menos 2 mazos y ${cm.minGames} partidas. La media de todos los mazos es ${cm.baseWinrate ?? '—'}%: una carta muy por encima en pocas partidas puede ser casualidad.`}</p>` : ''}
      ${(() => { const gs = view === 'winrate' ? cm.wrGroups : cm.groups; return gs.length ? html`
        ${gs.length > 1 ? html`<div class="chips">${gs.map(x => html`<a href="#m-${x.kind}">${x.label}</a>`)}</div>` : ''}
        ${gs.map(x => html`<section class="msec" id="m-${x.kind}"><h2 class="sec">${x.label}</h2><div class="mlist">${x.rows.slice(0, x.kind === 'main' ? 60 : 30).map(row)}</div></section>`)}`
        : html`<p class="muted">Todavía no hay cartas con partidas suficientes para calcular el win rate en este periodo. Prueba con un periodo más largo.</p>`; })()}
      ${imgs ? html`<p class="small muted">Imágenes y fichas de las cartas: <a href="https://cyberpunktcg.com/cards" rel="noopener">cyberpunktcg.com</a>.</p>` : ''}`
    : html`${tabs}<p class="muted">${baraja ? html`No hay listas con cartas de «${baraja}» en este periodo. <a href="${q('baraja', '')}">Ver todas las barajas</a>.` : html`Todavía no hay listas con cartas de ${g ? g.label : 'este juego'} en este periodo. Salen de los torneos de Melee que piden decklist.`}</p>`;
    })()}
    <div id="cardtip" class="cardtip" hidden><img alt=""></div>`)));
});

// Precio del meta en Commander: cuánto cuestan los mazos que se juegan y los que ganan
function metaCommander(req, games) {
  const days = [30, 90, 365].includes(Number(req.query.dias)) ? Number(req.query.dias) : 30;
  const mp = require('../community').metaPrice(days);
  const eur = c => money(c);
  const row = (x, i) => html`<a class="rrow mprow" href="${x.href}"><span class="r-date">${i + 1}</span><span class="r-name"><b>${x.deck || 'Sin nombre'}</b><small class="muted"> · ${x.name} · ${x.event}</small></span>
    <span class="r-win">${x.champion ? html`${TR} campeón` : `${x.pods} ${x.pods === 1 ? 'mesa ganada' : 'mesas ganadas'}`}</span><span class="r-pl"><b>${eur(x.v)}</b></span></a>`;
  const share = h => (h.n ? Math.round(h.w * 100 / h.n) / 100 : 0);
  return String(publicPage('Precio del meta', html`
    <h1>Meta de la tienda</h1>
    <p class="muted">Cuánto cuestan los mazos de Commander que se juegan en la tienda y los que ganan, según el valor validado en «Analizar mazo».</p>
    <div class="chips gamechips">${games.map(x => html`<a href="/meta?juego=${encodeURIComponent(x)}" style="--g:${melee.gameInfo(x).color}"><i></i>${melee.gameInfo(x).short}</a>`)}<a href="/meta?juego=commander" class="on" style="--g:#7b5ea7"><i></i>Commander</a></div>
    <div class="chips">${[[30, 'Último mes'], [90, 'Últimos 3 meses'], [365, 'Último año']].map(([d, l]) => html`<a href="/meta?juego=commander&dias=${d}" class="${d === days ? 'on' : ''}">${l}</a>`)}</div>
    ${mp.decks ? html`
      <div class="ptiles"><div><b>${eur(mp.avg)}</b><span>mazo medio</span></div><div><b>${eur(mp.median)}</b><span>mediana</span></div>
        <div><b>${mp.winAvg != null ? eur(mp.winAvg) : '—'}</b><span>media de los que ganan mesa</span></div><div><b>${mp.decks}</b><span>mazos validados</span></div></div>
      <div class="mpcmp"><div><small>El más barato</small><b>${eur(mp.min.v)}</b><span>${mp.min.deck || ''} · ${mp.min.name}</span></div><div><small>El más caro</small><b>${eur(mp.max.v)}</b><span>${mp.max.deck || ''} · ${mp.max.name}</span></div></div>
      ${mp.halves.cheap.n && mp.halves.dear.n ? html`<p class="mpnote">¿Gana más quien gasta más? Los mazos de hasta <b>${eur(mp.halves.cut)}</b> ganan <b>${String(share(mp.halves.cheap)).replace('.', ',')}</b> mesas por jugador; los más caros, <b>${String(share(mp.halves.dear)).replace('.', ',')}</b>.</p>` : ''}
      ${mp.cheapWinners.length ? html`<section><h2 class="sec">Los ganadores más baratos</h2><div class="results">${mp.cheapWinners.map(row)}</div></section>` : ''}
      ${mp.champions.length ? html`<section><h2 class="sec">Mazos campeones</h2><div class="results">${mp.champions.map(row)}</div></section>` : ''}
      ${mp.byBracket.length ? html`<section><h2 class="sec">Por bracket</h2><div class="ptiles">${mp.byBracket.map(b => html`<div><b>${eur(b.avg)}</b><span>bracket ${b.b === 2 ? '1-2' : b.b} · ${b.n} mazos</span></div>`)}</div></section>` : ''}
      <p class="small muted">Precio de cada carta: su impresión más barata en Cardmarket, sin tierras básicas. Solo mazos validados en torneos públicos de la tienda.</p>`
    : html`<p class="muted">Todavía no hay mazos validados en este periodo.</p>`}`));
}

r.get('/carta/:game/:name', async (req, res) => {
  try {
    const f = await cardimg.getImage(req.params.game, String(req.params.name).slice(0, 120));
    if (!f) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=604800').sendFile(f);
  } catch { res.status(404).end(); }
});

// Estado del mazo de un jugador apuntado y cómo registrarlo (desde una lista o desde sus mazos guardados)
function deckLine(ev, me, acc) {
  const v = me.deck_value_cents;
  const has = v != null || me.deck_list;
  const overB = ev.budget_cents && v != null && v > ev.budget_cents;
  const overBr = ev.bracket_max && me.deck_bracket != null && me.deck_bracket > Math.max(ev.bracket_max, 2);
  const bad = ev.legal_check && me.deck_legal === 0;
  const saved = acc ? require('../accounts').decks(acc.id) : [];
  const url = `/valor-mazo?evento=${ev.id}`;
  return html`<div class="sb-deck">
    ${has ? html`<p><b>Tu mazo:</b> ${me.deck || 'registrado'}${v != null ? html` · ${money(v)}` : ''}${me.deck_bracket != null ? ` · bracket ${me.deck_bracket === 2 ? '1-2' : me.deck_bracket}` : ''}
      ${overB || overBr || bad ? html` <span class="stchip st-unpaid">${overB ? 'Supera el presupuesto' : overBr ? 'Supera el bracket' : 'No es legal'}</span>` : (ev.budget_cents || ev.bracket_max || ev.legal_check) && v != null ? html` <span class="stchip st-paid">Válido</span>` : ''}</p>`
    : html`<p><b>Tu mazo:</b> aún no lo has registrado.${ev.budget_cents || ev.bracket_max || ev.legal_check ? ' Hay que validarlo antes de empezar.' : ''}</p>`}
    <div class="sb-deckact"><a class="jbtn${has ? '-outline' : ''}" href="${url}">${has ? 'Cambiar mi mazo' : 'Registrar mi mazo'}</a>
      ${saved.length ? html`<form method="get" action="/valor-mazo" class="sb-pick"><input type="hidden" name="evento" value="${ev.id}"><input type="hidden" name="guardar" value="1">
        <select name="mazo" aria-label="Usar uno de mis mazos" onchange="this.form.submit()"><option value="">o usar uno de mis mazos…</option>${saved.map(d => html`<option value="${d.id}">${d.name}${d.value_cents != null ? ` · ${money(d.value_cents)}` : ''}</option>`)}</select>
        <noscript><button class="jbtn-outline">Usar</button></noscript></form>` : ''}</div></div>`;
}

// Inscripción desde la web (con cuenta)
function signupBox(req, ev) {
  if (!ev.self_signup || ev.status !== 'setup') return '';
  const acc = req.account;
  const n = C.activeCount(ev.id), full = ev.max_players && n >= ev.max_players;
  const wait = C.waitlisted(ev.id).length;
  const me = acc ? C.entryOf(ev.id, acc, acc.person) : null;
  const active = me && me.dropped_round == null;
  const ok = req.query.ok ? String(req.query.ok).slice(0, 200) : null, err = req.query.err ? String(req.query.err).slice(0, 200) : null;
  const places = ev.max_players ? html`<b>${n}</b>/${ev.max_players} plazas${wait ? ` · ${wait} en espera` : ''}` : html`<b>${n}</b> apuntados`;
  return html`<section class="signbox ${active ? 'is-in' : ''}" id="apuntarse">
    ${ok ? html`<div class="aflash ok" role="status">${ok}</div>` : ''}${err ? html`<div class="aflash err" role="alert">${err}</div>` : ''}
    <div class="sb-main">
      <div class="sb-info"><h2>${active ? (me.waitlist ? 'Estás en la lista de espera' : 'Estás apuntado') : full ? 'Plazas completas' : 'Inscripción abierta'}</h2>
        <p>${places}${ev.price_cents != null ? html` · ${money(ev.price_cents)} (se paga en la tienda)` : ''}</p>
        ${active && !me.waitlist && ev.price_cents != null ? html`<p>${me.paid ? html`<span class="stchip st-paid">Pagado</span>` : html`<span class="stchip st-unpaid">Pago pendiente</span> Paga en la tienda antes de la ronda 1.`}</p>` : ''}
        ${active && !me.waitlist ? deckLine(ev, me, acc) : ''}
        ${active && me.waitlist ? html`<p>Vas el ${C.waitlisted(ev.id).findIndex(w => w.id === me.id) + 1}º. Si alguien se borra, entras solo${require('../tgbot').enabled() ? ' y te avisamos por Telegram si lo tienes activado' : ''}.</p>` : ''}
      </div>
      <div class="sb-act">${!acc ? html`<a class="jbtn big" href="/entrar?next=${encodeURIComponent(`/commander/${ev.id}#apuntarse`)}">${full ? 'Entra para la lista de espera' : 'Entra para apuntarte'}</a><small><a href="/registro?next=${encodeURIComponent(`/commander/${ev.id}#apuntarse`)}">Crear cuenta</a> · es gratis</small>`
        : active ? (me.paid ? html`<small class="muted">Para borrarte, habla con la tienda (ya has pagado).</small>` : html`<form method="post" action="/commander/${ev.id}/borrarme" onsubmit="return confirm('¿Borrarte del torneo?')"><button class="jbtn-outline">Borrarme</button></form>`)
        : html`<form method="post" action="/commander/${ev.id}/apuntarme"><button class="jbtn big">${full ? 'Apuntarme a la lista de espera' : 'Apuntarme'}</button></form><small class="muted">Como ${acc.name}</small>`}</div>
    </div></section>`;
}

// Recuadro de requisitos del mazo (presupuesto y/o bracket) en la página pública del evento
const BR_PUB = { 2: '1-2 · Exhibition / Core', 3: '3 · Upgraded', 4: '4 · Optimized' };
function budgetBox(ev) {
  const all = C.players(ev.id).filter(p => p.dropped_round == null);
  const fits = p => p.deck_value_cents != null && (!ev.budget_cents || p.deck_value_cents <= ev.budget_cents)
    && (!ev.bracket_max || p.deck_bracket == null || p.deck_bracket <= Math.max(ev.bracket_max, 2));
  const ok = all.filter(fits).length;
  const at = pricedb.status().updatedAt;
  const open = ev.status === 'setup';
  return html`<section class="budgetbox" id="presupuesto">
    <div class="bb-amount">${ev.budget_cents ? html`<span>Presupuesto máximo del mazo</span><b>${money(ev.budget_cents)}</b>` : ''}
      ${ev.bracket_max ? html`<span>Bracket máximo</span><b class="${ev.budget_cents ? 'bb-sub' : ''}">${BR_PUB[ev.bracket_max] || ev.bracket_max}</b>` : ''}
      ${all.length ? html`<small>${ok} de ${all.length} mazos validados</small>` : ''}</div>
    <div class="bb-rules"><h2>Cómo se calcula</h2><ul>
      ${ev.budget_cents ? html`<li>Se suma el precio de <b>la impresión más barata</b> de cada carta en Cardmarket (${pricedb.status().source === 'scryfall' ? 'el que publica Scryfall' : { avg: 'precio medio de venta', trend: 'precio de tendencia', low: 'precio más bajo', avg7: 'media de 7 días', avg30: 'media de 30 días' }[pricedb.status().source]})${at ? `, con precios del ${fmtDay(at)}` : ''}. Da igual la edición que tengas.</li>
      <li>Las <b>tierras básicas no cuentan nunca</b>, estén en el idioma que estén.</li>
      <li>${ev.budget_ex_commander ? html`El <b>comandante no cuenta</b>.` : html`El comandante <b>sí cuenta</b>.`}</li>` : ''}
      ${ev.legal_check ? html`<li>El mazo debe ser <b>legal en Commander</b>: 100 cartas con el comandante, una copia de cada, sin prohibidas y dentro de sus colores.</li>` : ''}
      ${ev.bracket_max ? html`<li>El <b>bracket</b> se estima con el sistema oficial de brackets de Commander: Game Changers, destrucción masiva de tierras, turnos extra encadenados y combos de dos cartas.</li>` : ''}
      <li>${open ? html`Valida tu mazo <b>antes de que empiece el torneo</b>: elige un preconstruido, pega la lista o sube el CSV de ManaBox y guárdalo en tu ficha.${ev.budget_lock ? ' Una vez empezado ya no se puede cambiar.' : ''}`
    : html`Los mazos se validaron antes de empezar el torneo.`}</li>
    </ul>
    ${open ? html`<a class="jbtn" href="/valor-mazo?evento=${ev.id}">Validar mi mazo</a>` : ''}</div>
  </section>`;
}

// Commander
r.get('/commander/:id', (req, res) => {
  const ev = C.getEvent(Number(req.params.id));
  if (!ev || !ev.public) return res.status(404).send(String(publicPage('No encontrado', html`<p>Evento no encontrado.</p>`)));
  const snap = cmdSnap(ev.id);
  res.send(String(publicPage(ev.name, html`
    <div class="thead ${ev.status === 'running' ? 'is-live' : ''} ${media(null, 'commander') ? '' : 'nomedia'}" style="--g:#7b5ea7">
      ${(() => { const m = media(null, 'commander'); return m ? html`<div class="thead-media ${m.cls}" style="${m.style}">${m.cls === 'art' ? html`<span>Commander</span>` : ''}</div>` : ''; })()}
      <div class="thead-info">
        <div class="tcard-badges static"><span class="jbadge">Commander</span>${ev.status === 'running' ? html`<span class="jbadge live">● En juego</span>` : ev.status === 'finished' ? html`<span class="jbadge">Terminado</span>` : ''}</div>
        <h1>${ev.name}</h1>
        <p class="tdate">${fmtDate(ev.start_date, { weekday: 'long', month: 'long' })}</p>
        <p class="tmeta">${snap.players} jugadores · mesas de 4 y 3 · en cada mesa empieza quien aparece 1º</p>
        <p class="tmeta">Puntos: ${snap.scoringText}</p>
        ${ev.budget_cents || ev.bracket_max ? html`<p class="budgetline">${ev.budget_cents ? html`Mazo de máximo <b>${money(ev.budget_cents)}</b>` : ''}${ev.budget_cents && ev.bracket_max ? ' · ' : ''}${ev.bracket_max ? html`Bracket máximo <b>${ev.bracket_max === 2 ? '1-2' : ev.bracket_max}</b>` : ''} · <a href="#presupuesto">cómo se calcula</a></p>` : ''}
        <div class="thead-cta">${ev.price_cents != null && ev.status === 'setup' ? html`<span class="tcard-price big">${money(ev.price_cents)}</span>` : ''}
          ${ev.self_signup && ev.status === 'setup' ? html`<a class="jbtn big" href="#apuntarse">Inscripción</a>` : ''}
          ${ev.melee_tournament_id && ev.status === 'setup' ? html`<a class="jbtn big" href="${melee.urls(ev.melee_tournament_id).view}" rel="noopener">Inscribirme en Melee</a>` : ''}</div>
      </div>
    </div>
    ${signupBox(req, ev)}
    ${(ev.budget_cents || ev.bracket_max || ev.legal_check) && ev.status === 'setup' ? budgetBox(ev) : ''}
    ${ev.info && ev.status !== 'running' ? html`<section class="infobox"><h2>Información</h2>${infoHtml(`c:${ev.id}`, ev.info)}</section>` : ''}
    ${ev.status === 'setup' ? calBox(`c:${ev.id}`, !!ev.info) : ''}
    <div id="cmd" data-id="${ev.id}"></div>
    ${ev.info && ev.status === 'running' ? html`<section class="infobox after"><h2>Información</h2>${infoHtml(`c:${ev.id}`, ev.info)}</section>` : ''}
    ${(ev.budget_cents || ev.bracket_max || ev.legal_check) && ev.status !== 'setup' ? budgetBox(ev) : ''}
    <script>window.__CSNAP = ${json(snap)};</script>
    <script src="/static/ui.js"></script><script src="/static/commander.js"></script><script src="/static/cmdac.js"></script>`)));
});

// Check-in del jugador al llegar (QR impreso en la tienda, con código secreto)
r.get('/commander/:id/checkin', (req, res) => {
  const ev = C.getEvent(Number(req.params.id));
  if (!ev || !ev.public) return res.status(404).send(String(publicPage('No encontrado', html`<p>Evento no encontrado.</p>`)));
  const ok = ev.checkin_code && req.query.c === ev.checkin_code;
  res.send(String(publicPage('Check-in · ' + ev.name, html`
    <section class="ckin" data-id="${ev.id}" data-code="${ok ? req.query.c : ''}">
      <p class="ckin-k">Check-in</p><h1>${ev.name}</h1>
      ${!ok ? html`<p class="warn">Este enlace no es válido: escanea el QR que hay en la tienda.</p>`
    : ev.status !== 'setup' ? html`<p>El torneo ya ha empezado. Habla con el staff.</p>`
    : html`<div id="ckin-box"></div>`}
      <p><a href="/commander/${ev.id}">Ver el evento →</a></p>
    </section>
    <script>window.__CSNAP = ${json(cmdSnap(ev.id))};</script>
    <script src="/static/ui.js"></script><script src="/static/checkin.js"></script>`)));
});
r.post('/commander/:id/checkin', (req, res) => {
  if (slowDown(req)) return res.status(429).json({ error: 'Demasiadas peticiones, espera un momento' });
  const ev = C.getEvent(Number(req.params.id));
  if (!ev || !ev.public || !ev.checkin_code || req.body.c !== ev.checkin_code) return res.status(400).json({ error: 'Código de check-in no válido' });
  if (ev.status !== 'setup') return res.status(400).json({ error: 'El torneo ya ha empezado' });
  const p = db.prepare('SELECT * FROM cmd_players WHERE id = ? AND event_id = ?').get(Number(req.body.by), ev.id);
  if (!p) return res.status(400).json({ error: 'Jugador no encontrado' });
  if (p.dropped_round != null) return res.status(400).json({ error: 'Estás como drop: habla con el staff' });
  let tok;
  try { tok = claimFor(req, res, ev.id, p.id); } catch (e) { return res.status(403).json({ error: e.message }); }
  C.setCheckin(ev.id, p.id, true);
  C.activity(ev.id, p.id, 'check-in', null, req);
  res.json({ ok: true, tok });
});

r.get('/commander/:id/estado.json', (req, res) => {
  const ev = C.getEvent(Number(req.params.id));
  if (!ev || !ev.public) return res.status(404).json({ error: 'no encontrado' });
  res.set('Cache-Control', 'no-store').json(cmdSnap(ev.id));
});

// Acciones de jugadores en Commander (sin cuenta: la tienda confirma los resultados)
const hits = new Map();
// Código del móvil de cada jugador: va en el almacenamiento del navegador y también en una cookie (por si falla uno de los dos)
const tokName = (eid, pid) => `ct${eid}_${pid}`;
function readTok(req, eid, pid) {
  if (req.body.tok) return String(req.body.tok);
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${tokName(eid, pid)}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
// ¿El jugador del evento es de la cuenta con sesión? (apuntado con ella o con su ficha)
function ownerAccountOf(p) {
  if (p.account_id) return p.account_id;
  const o = require('../accounts').ownerOf(people.cmdKey(p));
  return o ? o.id : null;
}
function claimFor(req, res, eid, pid) {
  const p = db.prepare('SELECT * FROM cmd_players WHERE id = ? AND event_id = ?').get(pid, eid);
  if (!p) throw new C.ClaimError('Jugador no encontrado');
  const owner = ownerAccountOf(p);
  if (owner) {
    if (!req.account || req.account.id !== owner) throw new C.ClaimError('Este jugador tiene cuenta en la web: entra con ella para hacer cambios.');
    if (p.phone_locked) throw new C.ClaimError('La tienda ha bloqueado los cambios para este jugador. Habla con el staff.');
    return null; // con la cuenta basta, no hace falta el código del móvil
  }
  const tok = C.claim(eid, pid, readTok(req, eid, pid));
  res.append('Set-Cookie', `${tokName(eid, pid)}=${encodeURIComponent(tok)}; Path=${config.basePath || '/'}; HttpOnly; SameSite=Lax; Max-Age=${60 * 86400}${config.cookieSecure ? '; Secure' : ''}`);
  return tok;
}
function slowDown(req) {
  const now = Date.now();
  const list = (hits.get(req.ip) || []).filter(t => now - t < 60000);
  list.push(now); hits.set(req.ip, list);
  return list.length > 20;
}
r.post('/commander/:id/reportar', (req, res) => {
  if (slowDown(req)) return res.status(429).json({ error: 'Demasiadas peticiones, espera un momento' });
  const ev = C.getEvent(Number(req.params.id));
  if (!ev || !ev.public) return res.status(404).json({ error: 'no encontrado' });
  try {
    const tok = claimFor(req, res, ev.id, Number(req.body.by));
    C.proposeResult(ev.id, Number(req.body.pod), Number(req.body.by), String(req.body.result || ''));
    C.activity(ev.id, Number(req.body.by), 'resultado', `mesa ${req.body.pod}: ${req.body.result}`, req);
    res.json({ ok: true, tok });
  } catch (e) { res.status(e instanceof C.ClaimError ? 403 : 400).json({ error: e.message }); }
});
// ---------- Contador de vidas de la mesa ----------
const L = require('../life');
const lifeHits = new Map();
function lifeSlow(req) {
  const now = Date.now();
  const list = (lifeHits.get(req.ip) || []).filter(t => now - t < 60000);
  list.push(now); lifeHits.set(req.ip, list);
  return list.length > 1200; // en la tienda todos salen por la misma IP
}
r.get('/commander/:id/vidas', (req, res) => {
  const ev = C.getEvent(Number(req.params.id));
  if (!ev || !ev.public) return res.status(404).send(String(publicPage('No encontrado', html`<p>Torneo no encontrado.</p>`)));
  const snap = cmdSnap(ev.id);
  res.send(String(html`${head('Contador de vidas', settings(), raw('<meta name="theme-color" content="#0d0d0d"><link rel="manifest" href="vidas.webmanifest"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black"><meta name="apple-mobile-web-app-title" content="Vidas">'))}<body class="lifep">
    <div id="life" data-id="${ev.id}"></div>
    <script>window.__LSNAP = ${json({ id: ev.id, name: ev.name, status: ev.status, round: snap.round, pods: snap.pods.map(p => ({ id: p.id, table: p.table, reported: p.reported, players: p.players.map(x => ({ id: x.id, name: x.name, deck: x.deck, seat: x.seat })) })), roster: snap.roster.map(x => ({ id: x.id, name: x.name, username: x.username, pkey: x.pkey })), pod: Number(req.query.mesa) || null })};</script>
    <script src="/static/ui.js"></script><script src="/static/life.js"></script></body></html>`));
});
// Contador de vidas casual: sin torneo ni resultados, todo se guarda en el propio aparato
r.get('/vidas', (req, res) => {
  res.send(String(html`${head('Contador de vidas', settings(), raw('<meta name="theme-color" content="#0d0d0d"><link rel="manifest" href="vidas.webmanifest"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black"><meta name="apple-mobile-web-app-title" content="Vidas">'))}<body class="lifep">
    <div id="life"></div>
    <script>window.__LSNAP = ${json({ casual: true, league: feature('casual_league') })}; window.__STORE = ${json(settings().store_name || '')};</script>
    <script src="/static/ui.js"></script><script src="/static/life.js"></script></body></html>`));
});
r.get('/vidas.webmanifest', (req, res) => {
  res.type('application/manifest+json').send(JSON.stringify({ name: 'Contador de vidas', short_name: 'Vidas', start_url: 'vidas', scope: './', display: 'fullscreen', orientation: 'landscape', background_color: '#0d0d0d', theme_color: '#0d0d0d',
    icons: [{ src: 'static/img/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'static/img/icon-512.png', sizes: '512x512', type: 'image/png' }] }));
});
// Comprobar una carta (comandante del contador casual y sugerencias mientras se escribe)
r.get('/vidas/carta.json', async (req, res) => {
  if (lifeSlow(req)) return res.status(429).json({ error: 'Demasiadas peticiones' });
  const q = String(req.query.q || '').slice(0, 120).trim();
  if (q.length < 2) return res.json({ name: null, sug: [] });
  res.set('Cache-Control', 'no-store').json(await L.cardCheck(q, req.query.cmd === '1'));
});
r.get('/vidas/artes.json', async (req, res) => {
  if (lifeSlow(req)) return res.status(429).json({ error: 'Demasiadas peticiones' });
  const q = String(req.query.q || '').slice(0, 120).trim();
  try { const all = q ? await L.arts(q, { fuzzy: true }) : []; res.set('Cache-Control', 'no-store').json({ name: L.artName(q, true), all }); }
  catch (e) { res.json({ name: q, all: [] }); }
});
// Para instalar el contador como app (pantalla completa, sin barra del navegador). Rutas relativas: valen con BASE_PATH
r.get('/commander/:id/vidas.webmanifest', (req, res) => {
  const ev = C.getEvent(Number(req.params.id));
  if (!ev || !ev.public) return res.status(404).end();
  res.type('application/manifest+json').send(JSON.stringify({ name: `Vidas · ${ev.name}`, short_name: 'Vidas', start_url: 'vidas', scope: './', display: 'fullscreen', orientation: 'landscape', background_color: '#0d0d0d', theme_color: '#0d0d0d',
    icons: [{ src: '../../static/img/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '../../static/img/icon-512.png', sizes: '512x512', type: 'image/png' }] }));
});
r.get('/commander/:id/vidas/:pod.json', (req, res) => {
  try { res.set('Cache-Control', 'no-store').json(L.view(Number(req.params.id), Number(req.params.pod))); }
  catch (e) { res.status(e instanceof L.LifeError ? 400 : 500).json({ error: e.message }); }
});
// Fondos: arte del comandante de cada jugador (y todas las ilustraciones del propio, para elegir)
r.get('/commander/:id/vidas/:pod/artes.json', async (req, res) => {
  try {
    const v = L.view(Number(req.params.id), Number(req.params.pod));
    const ps = db.prepare('SELECT p.id, p.deck FROM cmd_seats s JOIN cmd_players p ON p.id = s.player_id WHERE s.pod_id = ?').all(Number(req.params.pod));
    const out = {};
    for (const p of ps) { const l = await L.arts(p.deck); out[p.id] = { name: L.cmdName(p.deck), def: l[0] ? l[0].url : null, ...(Number(req.query.pid) === p.id ? { all: l } : {}) }; }
    res.set('Cache-Control', 'no-store').json({ version: v.version, arts: out });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Historial de la mesa (cada cambio de vidas, veneno y comandante, eliminaciones…)
r.get('/commander/:id/vidas/:pod/historial.json', (req, res) => {
  try { res.set('Cache-Control', 'no-store').json({ items: L.history(Number(req.params.id), Number(req.params.pod)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// Cambios al momento (sin esperar al refresco)
r.get('/commander/:id/vidas/:pod/stream', (req, res) => {
  const pod = Number(req.params.pod);
  try { L.view(Number(req.params.id), pod); } catch (e) { return res.status(404).end(); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const on = (pid, version) => { if (pid === pod) res.write(`data: ${version}\n\n`); };
  L.bus.on('change', on);
  const hb = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(hb); L.bus.off('change', on); });
});
r.post('/commander/:id/vidas/:pod', async (req, res) => {
  if (lifeSlow(req)) return res.status(429).json({ error: 'Demasiados toques seguidos: espera un momento' });
  const ev = C.getEvent(Number(req.params.id));
  if (!ev || !ev.public) return res.status(404).json({ error: 'no encontrado' });
  // Auditoría: estado antes de la acción y quién la hace
  const AU = require('../lifeaudit'), podN = Number(req.params.pod), opA = String(req.body.op || ''), byA = Number(req.body.by) || null;
  let view0 = null; try { view0 = L.view(ev.id, podN); } catch (e) { view0 = null; }
  const byName = view0 && byA ? ((view0.state.players || []).find(p => p.id === byA) || {}).name || null : null;
  try {
    const by = Number(req.body.by);
    const tok = claimFor(req, res, ev.id, by);
    const op = String(req.body.op || '');
    if (op === 'art' && req.body.art) {
      const p = db.prepare('SELECT deck FROM cmd_players WHERE id = ? AND event_id = ?').get(by, ev.id);
      const list = await L.arts(p && p.deck);
      if (!list.some(a => a.url === req.body.art) && !L.knownArt(req.body.art)) throw new L.LifeError('Esa ilustración no vale');
    }
    if (op === 'vote') {
      let votes = {}; try { votes = JSON.parse(req.body.votes || '{}'); } catch (e) { /* nada */ }
      return res.json({ ...L.vote(ev.id, Number(req.params.pod), by, votes), tok });
    }
    if (op === 'judge') {
      const out = L.callJudge(ev.id, Number(req.params.pod), by, Number(req.body.on), req.body.note);
      if (Number(req.body.on)) { C.activity(ev.id, by, 'juez', `mesa ${out.table}`, req); { const N = require('../notify'); if (N.enabled()) N.send(`${ev.name}: la mesa ${out.table} llama a un juez`).catch(() => {}); } }
      return res.json({ ...out, tok });
    }
    const out = op === 'finish' ? L.finish(ev.id, Number(req.params.pod), by, req.body.winner) : L.apply(ev.id, Number(req.params.pod), by, { ...req.body, op });
    AU.record({ req, ev, podId: podN, view0, out, byId: by, byName, op, body: req.body });
    if (['kill', 'revive', 'finish', 'reset'].includes(op)) { C.activity(ev.id, by, 'contador', `mesa ${out.table}: ${op}${req.body.pid ? ' ' + req.body.pid : ''}`, req); require('../rivals').invalidate(); }
    res.json({ ...out, tok });
  } catch (e) {
    AU.record({ req, ev, podId: podN, view0, out: null, byId: byA, byName, op: opA, body: req.body, error: e.message });
    res.status(e instanceof C.ClaimError ? 403 : e instanceof L.LifeError ? 400 : 500).json({ error: e.message });
  }
});

r.post('/commander/:id/mazo', (req, res) => {
  if (slowDown(req)) return res.status(429).json({ error: 'Demasiadas peticiones, espera un momento' });
  const ev = C.getEvent(Number(req.params.id));
  if (!ev || !ev.public || ev.status === 'finished') return res.status(400).json({ error: 'No se puede cambiar ahora' });
  if ((ev.budget_cents || ev.bracket_max || ev.legal_check) && C.deckLocked(ev)) return res.status(400).json({ error: 'El torneo ya ha empezado: el mazo no se puede cambiar' });
  const p = db.prepare('SELECT id FROM cmd_players WHERE id = ? AND event_id = ?').get(Number(req.body.by), ev.id);
  if (!p) return res.status(400).json({ error: 'Jugador no encontrado' });
  let tok;
  try { tok = claimFor(req, res, ev.id, p.id); } catch (e) { return res.status(403).json({ error: e.message }); }
  C.setDeck(ev.id, p.id, req.body.deck);
  C.activity(ev.id, p.id, 'comandante', req.body.deck, req);
  res.json({ ok: true, tok });
});

// Valor de mazo (precio más barato en Cardmarket vía Scryfall)
r.get('/valor-mazo', (req, res) => {
  res.send(String(publicPage('Analizar mazo', html`
    <div class="vhead"><h1>Analiza tu mazo</h1>
      <p class="muted">Pega tu lista (Moxfield, Archidekt, ManaBox, MTGA…) o sube el CSV de ManaBox. Te dice cuánto cuesta (impresión más barata de cada carta en Cardmarket), si es legal en Commander y su bracket estimado.</p></div>
    <div class="vgrid">
      <section class="vform">
        <div class="precon" data-precons="deck"></div>
        <textarea id="deck" rows="16" placeholder="1 Atraxa, Praetors' Voice&#10;1 Sol Ring&#10;1 Arcane Signet&#10;…" spellcheck="false"></textarea>
        <div class="vactions"><label class="jbtn-outline vfile">Subir archivo (.txt / .csv)<input type="file" id="file" accept=".txt,.csv,.dec,.dek,text/plain,text/csv" hidden></label>
          <button class="jbtn big" id="go">Calcular valor</button></div>
        <p class="small muted">Precios de Cardmarket: ${(() => { const ps = pricedb.status(); return ps.source === 'scryfall' ? html`los que publica <a href="https://scryfall.com" rel="noopener">Scryfall</a>` : html`${{ avg: 'precio medio de venta', trend: 'precio de tendencia', low: 'precio más bajo', avg7: 'media de los últimos 7 días', avg30: 'media de los últimos 30 días' }[ps.source]}, de la guía de precios diaria`; })()}. Orientativo.</p>
      </section>
      <section id="vres" class="vres"></section>
    </div>
    <script>window.__VM = ${json({ event: Number(req.query.evento) || null })};</script>
    <script src="/static/ui.js"></script><script src="/static/precons.js"></script><script src="/static/deckvalue.js"></script>`)));
});

const vmHits = new Map();
r.post('/valor-mazo', (req, res) => {
  const now = Date.now();
  const list = (vmHits.get(req.ip) || []).filter(t => now - t < 60000);
  if (list.length >= 6) return res.status(429).json({ error: 'Demasiadas consultas seguidas, espera un minuto' });
  list.push(now); vmHits.set(req.ip, list);
  const text = String(req.body.text || '');
  if (!text.trim()) return res.status(400).json({ error: 'Pega una lista de cartas' });
  if (text.length > 60000) return res.status(400).json({ error: 'La lista es demasiado larga' });
  res.json({ job: deckvalue.startJob(text) });
});

r.get('/valor-mazo/estado/:job', (req, res) => {
  const j = deckvalue.getJob(req.params.job);
  if (!j) return res.status(404).json({ error: 'Consulta caducada, vuelve a calcular' });
  res.set('Cache-Control', 'no-store').json({ status: j.status, done: j.done, total: j.total, result: j.result, error: j.error });
});

// Guardar el valor calculado en la ficha del jugador de un evento de Commander
r.post('/commander/:id/valor', (req, res) => {
  const ev = C.getEvent(Number(req.params.id));
  if (!ev || !ev.public) return res.status(404).json({ error: 'no encontrado' });
  if (C.deckLocked(ev)) return res.status(400).json({ error: 'El torneo ya ha empezado: el mazo no se puede cambiar' });
  const p = db.prepare('SELECT id FROM cmd_players WHERE id = ? AND event_id = ?').get(Number(req.body.by), ev.id);
  const j = deckvalue.getJob(String(req.body.job || ''));
  if (!p || !j || j.status !== 'done') return res.status(400).json({ error: 'Calcula el valor antes de guardarlo' });
  let tok;
  try { tok = claimFor(req, res, ev.id, p.id); } catch (e) { return res.status(403).json({ error: e.message }); }
  const counted = C.setDeckValue(ev.id, p.id, j.result, j.text);
  C.activity(ev.id, p.id, 'mazo', `${j.result.commander || ''} · ${counted.toFixed(2)} €`, req);
  const br = j.result.bracket ? j.result.bracket.n : null;
  res.json({ ok: true, tok, counted, bracket: br, illegal: !!(ev.legal_check && j.result.legality && !j.result.legality.ok), over: ev.budget_cents ? Math.round(counted * 100) > ev.budget_cents : false,
    overBracket: !!(ev.bracket_max && br && br > Math.max(ev.bracket_max, 2)) });
});

// Pantalla de TV
r.get(['/tv', '/tv/:id'], (req, res) => {
  const s = settings();
  res.send(String(html`${head('TV', s)}<body class="tv">
    <div id="tv" data-id="${req.params.id || ''}" data-seconds="${parseInt(s.tv_page_seconds, 10) || 8}"></div>
    <script>window.__STORE = ${json({ name: s.store_name, logo: s.logo_url })};</script>
    <script src="/static/tv.js"></script></body></html>`));
});

r.get('/tv.json', (req, res) => {
  const raw = String(req.query.id || '');
  const cid = raw.startsWith('c') ? Number(raw.slice(1)) : null;
  const id = cid ? null : Number(raw) || null;
  let live = cid ? [] : id ? [data.tournament(id)].filter(t => t && !t.hidden) : data.liveTournaments();
  const cmd = (cid ? [C.getEvent(cid)].filter(Boolean) : id ? [] : C.tvEvents()).map(e => ({
    ...C.snapshot(e.id), color: '#7b5ea7', gameLabel: 'Commander',
    qr: config.basePath + '/qr.svg?d=' + encodeURIComponent(absUrl(req, '/commander/' + e.id)),
  }));
  for (const t of cmd) { const lv = require('../life').summary((t.pods || []).map(p => p.id)); for (const pod of t.pods || []) pod.life = lv.get(pod.id) || null; }
  for (const t of cmd) if (t.status === 'finished') { try { t.night = require('../cmdstats').nightSummary(t.id); } catch (e) { t.night = null; } }
  const cmdIds = new Set(cmd.map(t => t.id));
  const judge = require('../life').judgeCalls(null, true).filter(j => cmdIds.has(j.event_id)).map(j => ({ id: j.id, table: j.tn }));
  const upcoming = data.upcomingTournaments(6).map(t => ({
    id: t.id, name: t.name, game: t.game, gameLabel: melee.gameInfo(t.game).short, color: melee.gameInfo(t.game).color,
    date: fmtDate(t.start_date), qr: config.basePath + '/qr.svg?d=' + encodeURIComponent(absUrl(req, '/t/' + t.id)),
  }));
  const liveOut = live.map(t => ({ ...data.liveSnapshot(t.id), color: melee.gameInfo(t.game).color, gameLabel: melee.gameInfo(t.game).short,
    qr: config.basePath + '/qr.svg?d=' + encodeURIComponent(absUrl(req, '/t/' + t.id)) })).concat(cmd);
  // Comunidad en la TV: revanchas, «Se busca» y momentos
  const K = require('../community');
  const R = require('../rivals');
  const bnt = feature('bounties') ? K.bounties() : [];
  const wanted = new Map(bnt.filter(b => b.status === 'active').map(b => [b.person_key, b]));
  const idx = people.nameIndex();
  for (const t of liveOut) {
    try {
      if (t.kind === 'commander') {
        const keyOf = new Map(C.players(t.id).map(p => [p.id, people.cmdKey(p, idx)]));
        for (const pod of t.pods || []) {
          const ks = pod.players.map(x => ({ id: x.id, name: x.name, key: keyOf.get(x.id) }));
          pod.wanted = ks.filter(x => wanted.has(x.key)).map(x => ({ name: x.name, reward: wanted.get(x.key).reward }));
          pod.rematch = null;
          for (let i = 0; i < ks.length && !pod.rematch; i++) for (let j = i + 1; j < ks.length; j++) {
            const rm = R.rematch(ks[i].key, ks[j].key, { id: t.id, source: 'commander' });
            if (rm && rm.nemesis) { pod.rematch = { a: ks[i].name, b: ks[j].name, w: rm.w, l: rm.l, d: rm.d, nemesis: rm.nemesis }; break; }
          }
        }
      } else {
        const pm = data.playersMap(t.id);
        const keyOf = team => { const p = pm.get(team); return p ? require('../identity').resolve(p.username ? 'u:' + p.username.toLowerCase() : p.user_key) : null; };
        for (const p of t.pairings || []) {
          if (p.bye || !p.t2) continue;
          const k1 = keyOf(p.t1), k2 = keyOf(p.t2);
          p.wanted = [[k1, p.p1], [k2, p.p2]].filter(([k]) => wanted.has(k)).map(([k, n]) => ({ name: n, reward: wanted.get(k).reward }));
          const rm = R.rematch(k1, k2, { id: t.id, source: 'melee' });
          p.rematch = rm ? { w: rm.w, l: rm.l, d: rm.d, nemesis: rm.nemesis } : null;
        }
      }
    } catch (e) { /* la TV sigue aunque falle esto */ }
  }
  const moments = feature('moments') ? K.moments({ status: 'approved', since: '-2 days', limit: 6 }).map(m => ({ id: m.id, src: config.basePath + '/momentos/f/' + m.id, caption: m.caption, who: m.who, event: m.event_label })) : [];
  res.set('Cache-Control', 'no-store').json({
    now: new Date().toISOString(),
    live: liveOut,
    upcoming,
    bounties: bnt.filter(b => b.status === 'active').slice(0, 3).map(b => ({ id: b.id, name: people.publicName(b.person_key), reward: b.reward, note: b.note, how: b.how })),
    claimed: bnt.filter(b => ['claimed', 'delivered'].includes(b.status) && b.claimed_at && Date.now() - new Date(b.claimed_at.replace(' ', 'T') + 'Z') < 3 * 3600e3)
      .map(b => ({ id: b.id, winner: people.publicName(b.claimed_key), target: people.publicName(b.person_key), reward: b.reward })),
    moments,
    kills: db.prepare(`SELECT k.pod_id, k.victim_id, k.killer_id, k.how, k.at, pd.table_number tn, v.name vn, v.username vu, kk.name kn, kk.username ku FROM cmd_kills k
      JOIN cmd_pods pd ON pd.id = k.pod_id JOIN cmd_players v ON v.id = k.victim_id LEFT JOIN cmd_players kk ON kk.id = k.killer_id
      WHERE k.at >= datetime('now', '-10 minutes') ORDER BY k.at`).all().map(k => ({ id: `${k.pod_id}-${k.victim_id}`, table: k.tn, victim: C.pubName({ name: k.vn, username: k.vu }), killer: k.kn ? C.pubName({ name: k.kn, username: k.ku }) : null, how: k.how })),
    judge,
    lfg: feature('lfg') ? require('../casual').lfgToday().map(l => ({ time: l.time, bracket: l.bracket, n: l.joined.length, slots: l.slots, note: l.note })) : [],
    lfgQr: feature('lfg') ? config.basePath + '/qr.svg?d=' + encodeURIComponent(absUrl(req, '/busco-mesa')) : null,
    slow: L.slowTurns().map(x => ({ ...x, mins: Math.floor(x.ms / 60000) })),
    momentsQr: feature('moments') ? config.basePath + '/qr.svg?d=' + encodeURIComponent(absUrl(req, '/momentos/subir')) : null,
    bountiesQr: bnt.length ? config.basePath + '/qr.svg?d=' + encodeURIComponent(absUrl(req, '/recompensas')) : null,
  });
});

module.exports = r;
