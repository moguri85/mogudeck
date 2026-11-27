'use strict';
const { settings } = require('../db');
const { gameInfo } = require('../melee');
const config = require('../config');

class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }

function esc(v) {
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function render(v) {
  if (v == null || v === false) return '';
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}
function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += render(vals[i]) + strings[i + 1];
  return new Safe(out);
}
const raw = s => new Safe(String(s));

// JSON seguro para incrustar en <script>
const json = obj => raw(JSON.stringify(obj).replace(/</g, '\\u003c'));

function fmtDate(iso, opts = {}) {
  if (!iso) return 'Fecha por confirmar';
  return new Date(iso).toLocaleString('es-ES', {
    timeZone: config.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...opts,
  });
}
function fmtDay(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-ES', { timeZone: config.tz, day: '2-digit', month: '2-digit', year: 'numeric' });
}
function money(cents) {
  if (cents == null) return '—';
  return (cents / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}
function toCents(v) {
  if (v == null || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? null : Math.round(n * 100);
}

// Imagen por juego: la configurada en Ajustes o la ilustración genérica incluida
const ART = ['StarWarsUnlimited', 'CyberpunkTCG', 'MagicTheGathering', 'Riftbound', 'commander'];
// Rutas locales («/uploads/…») se guardan sin prefijo y se completan con BASE_PATH al pintar
const local = u => (u && u.startsWith('/') && !u.startsWith('//') && !u.startsWith(config.basePath + '/') ? config.basePath + u : u);
function gameArt(code) {
  const custom = local(settings()['game_img_' + code]);
  if (custom) return custom;
  return `${config.basePath}/static/img/games/${ART.includes(code) ? code : 'generic'}.svg`;
}
const cssUrl = u => raw(`url('${String(u).replace(/['"()\\\s]/g, '')}')`);
// Fondo para tarjetas/cabeceras sin imagen propia: logo subido (centrado) o ilustración
function artStyle(code) {
  const s = settings();
  const custom = local(s['game_img_' + code]);
  if (custom && s['game_img_fit_' + code] !== 'cover') {
    return { cls: 'logo', style: raw(`background-image:${cssUrl(custom)}, radial-gradient(120% 90% at 85% 0%, color-mix(in srgb, var(--g) 70%, transparent) 0, transparent 62%)`) };
  }
  return { cls: custom ? 'cover' : 'art', style: raw(`background-image:${cssUrl(gameArt(code))}`) };
}

// Admite formato sencillo: **negrita**, *cursiva*, ## Título, - lista, 1. lista, [texto](https://…)
function richText(t) {
  if (!t) return '';
  return raw(`<div class="calhtml">${require('../../public/rich.js').richMd(t)}</div>`);
}

function gameBadge(code) {
  const g = gameInfo(code);
  return html`<span class="badge" style="--g:${g.color}">${g.short}</span>`;
}

function statusBadge(t, live) {
  if (live) return html`<span class="status live">● En juego</span>`;
  const cls = { 0: 'draft', 1: 'reg', 3: 'cancel', 4: 'done' }[t.status] || '';
  return html`<span class="status ${cls}">${t.status_desc || ''}</span>`;
}

function absUrl(req, path) {
  const base = (settings().base_url || '').replace(/\/$/, '');
  if (base) return base + path;
  return `${req.protocol}://${req.get('host')}${config.basePath}${path}`;
}

function head(title, s, extra = '') {
  return html`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${s.store_name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600&family=Roboto+Flex:opsz,wght@8..144,300..800&display=swap">
<link rel="stylesheet" href="/static/style.css">
<link rel="icon" type="image/png" sizes="32x32" href="/static/img/icon-32.png"><link rel="apple-touch-icon" href="/static/img/icon-180.png"><link rel="manifest" href="/static/manifest.webmanifest"><meta name="theme-color" content="#121212">
<style>:root{--accent:${s.accent && s.accent !== '#e4572e' ? s.accent : '#f47700'}}</style><script>window.__BASE=${json(config.basePath)};window.__ME=${json((() => { const a = require('../reqctx').get().account; return a ? { key: a.person, name: a.name } : null; })())}</script>${extra}</head>`;
}

const NAV = [
  ['/admin', 'Inicio', 'staff'],
  ['/admin/torneos', 'Torneos', 'staff'],
  ['/admin/commander', 'Commander', 'staff'],
  ['/admin/plantillas', 'Plantillas', 'staff'],
  ['/admin/qr', 'QR y mesas', 'staff'],
  ['/admin/premios', 'Premios y rondas', 'staff', 'prizes'],
  ['/admin/liga', 'Ligas', 'staff'],
  ['/admin/jugadores', 'Jugadores', 'staff', null, ['/admin/cuentas', '/admin/vincular', '/admin/usuarios']],
  ['/admin/meta', 'Meta', 'staff'],
  ['/admin/comunidad', 'Comunidad', 'staff'],
  ['/admin/calendario', 'Calendario', 'staff', 'calendar'],
  ['/admin/caja', 'Caja', 'staff', 'cash'],
  ['/admin/guia', 'Guía Melee', 'staff'],
  ['/admin/ajustes', 'Ajustes', 'admin'],
  ['/admin/copias', 'Copias de seguridad', 'admin'],
];

function adminPage(req, title, body, { extraHead = '', flash = null } = {}) {
  const s = settings();
  const user = req.user;
  const path = (req.baseUrl + (req.path === '/' ? '' : req.path)) || '/admin';
  const active = (href, also = []) => href === '/admin' ? path === '/admin' : [href, ...also].some(h => path.startsWith(h));
  const f = flash || req.query.ok || req.query.err;
  return html`${head(title, s, raw(extraHead))}<body class="admin">
<header class="topbar">
  <button class="navtoggle" aria-label="Menú" onclick="document.body.classList.toggle('navopen')">☰</button>
  <a class="brand" href="/admin"><img src="${s.logo_url || '/static/img/logo-jupiter.avif'}" alt="${s.store_name}" width="336" height="112"> <small>Torneos</small></a>
  <nav class="userbox"><a href="/" target="_blank">Web pública ↗</a><a href="/tv" target="_blank">TV ↗</a>
    <a href="/admin/cuenta">${user.username}</a>
    <form method="post" action="/admin/logout"><button class="link">Salir</button></form></nav>
</header>
<div class="shell">
<aside class="sidenav">${NAV.filter(n => (n[2] === 'staff' || user.role === 'admin') && (!n[3] || s['feature_' + n[3]] === '1')).map(([href, label, , , also]) =>
    html`<a href="${href}" class="${active(href, also) ? 'on' : ''}">${label}${href === '/admin/comunidad' ? (() => { const n = require('../db').feature('moments') ? require('../community').momentsPending() : 0; return n ? html` <span class="navbadge" title="Fotos por revisar">${n}</span>` : ''; })() : ''}${href === '/admin/jugadores' ? (() => { const n = require('../accounts').pendingCount(); return n ? html` <span class="navbadge" title="Solicitudes pendientes">${n}</span>` : ''; })() : ''}</a>`)}</aside>
<main class="content">
${f ? html`<div class="flash ${req.query.err ? 'err' : ''}">${f}</div>` : ''}
<h1>${title}</h1>
${body}
</main></div>
<script src="/static/app.js"></script>
<script src="/static/rich.js"></script>
</body></html>`;
}

// Icono de trofeo (sustituye a los emojis de medalla)
const TROPHY = '<svg class="ico-tr" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v3a4 4 0 0 1-8 0V4Z"/><path d="M8 5H5v1a3 3 0 0 0 3 3M16 5h3v1a3 3 0 0 1-3 3M12 11v4M9 20h6M10 15h4v5h-4z"/></svg>';

// Menú público: arriba en ordenador y como barra inferior con iconos en el móvil
const NAV_ICONS = {"comunidad": '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.2"/><circle cx="17" cy="9.5" r="2.5"/><path d="M3.5 19c.8-3.4 3-5 5.5-5s4.7 1.6 5.5 5M14.5 14.6c.8-.4 1.6-.6 2.5-.6 2 0 3.6 1.3 4.2 4"/></svg>', "torneos": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v3a4 4 0 0 1-8 0V4Z"/><path d="M8 5H5v1a3 3 0 0 0 3 3M16 5h3v1a3 3 0 0 1-3 3M12 11v4M9 20h6M10 15h4v5h-4z"/></svg>', "commander": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8l4 4 4-7 4 7 4-4-2 10H6L4 8Z"/><path d="M6 21h12"/></svg>', "ligas": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V11h4v9M10 20V5h4v15M16 20v-6h4v6M3 20h18"/></svg>', "meta": '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="11" height="15" rx="2"/><path d="M9 21h9a2 2 0 0 0 2-2V8"/></svg>', "valor": '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3" width="11" height="15" rx="2"/><circle cx="15" cy="15" r="4"/><path d="m18 18 3 3"/></svg>', "vidas": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20Z"/></svg>'};
function navLinks(s, icons) {
  const items = [['/', 'Torneos', 'torneos'], ['/?juego=commander', 'Commander', 'commander'], ['/liga', 'Ligas', 'ligas'],
    ...(s.feature_meta === '1' ? [['/meta', 'Meta', 'meta']] : []), ['/valor-mazo', icons ? 'Mazo' : 'Analizar mazo', 'valor'], ['/vidas', icons ? 'Vidas' : 'Contador de vidas', 'vidas'],
    ...(['badges', 'porra', 'bounties', 'trades', 'loans'].some(k => s['feature_' + k] === '1') ? [['/comunidad', icons ? 'Más' : 'Comunidad', 'comunidad']] : [])];
  return items.map(([href, label, ic]) => `<a href="${href}" data-nav="${href}">${icons ? NAV_ICONS[ic] : ''}<span>${label}</span></a>`).join('');
}

function publicPage(title, body, { extraHead = '', bodyClass = 'public' } = {}) {
  const s = settings();
  return html`${head(title, s, raw(extraHead))}<body class="${bodyClass}">
<header class="jhead">
  <a href="/" class="jlogo" aria-label="${s.store_name}: torneos"><img src="${s.logo_url || '/static/img/logo-jupiter.avif'}" alt="${s.store_name}" width="336" height="112"></a>
  <nav class="jnav" aria-label="Secciones">${raw(navLinks(s, false))}</nav>
  ${(() => { const acc = require('../reqctx').get().account; return html`<a class="jacc ${acc ? 'in' : ''}" href="${acc ? '/cuenta' : '/entrar'}" aria-label="${acc ? `Mi cuenta (${acc.name})` : 'Entrar o crear cuenta'}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.8 4-5.6 7.5-5.6s6.3 1.8 7.5 5.6"/></svg><span>${acc ? (acc.nick || acc.name.split(' ')[0]) : 'Entrar'}</span></a>`; })()}
  ${s.calendar_url ? html`<a class="jcal" href="${s.calendar_url}" rel="noopener" aria-label="Calendario de la tienda"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg><span>Calendario</span></a>` : ''}
</header>
<nav class="tabbar" aria-label="Secciones">${raw(navLinks(s, true))}</nav>
<main class="pub">${body}</main>
<footer class="jfoot"><div><b>${s.store_name}</b>${s.address ? html`<span>${s.address}</span>` : ''}</div>
  <div class="small">Inscripciones y resultados con <a href="https://melee.gg" rel="noopener">Melee.gg</a>${s.calendar_url ? html` · <a href="${s.calendar_url}" rel="noopener">Calendario de eventos</a>` : ''}</div></footer>
<script src="/static/app.js"></script>
</body></html>`;
}

module.exports = {
  html, raw, esc, json, Safe, gameArt, cssUrl, ART, richText, artStyle, fmtDate, fmtDay, money, toCents, gameBadge, statusBadge, absUrl,
  adminPage, publicPage, head, TROPHY,
};

// Botón «Traer el texto de la web de la tienda» bajo el textarea de información (si el torneo está unido a un evento del calendario)
function calTextButton(ref) {
  try {
    if (!require('../db').feature('calendar')) return '';
    const a = require('../jupcal').actFor(ref);
    if (!a || !a.infoText) return '';
    return html`<div class="full caltext"><button type="button" class="btn small ghost" data-caltext="${a.infoText}" onclick="var t=this.closest('form').querySelector('textarea[name=info]');if(t.value.trim()&&!confirm('¿Cambiar el texto actual por el de la web de la tienda?'))return;t.value=this.dataset.caltext;t.dispatchEvent(new Event('input'))">Traer el texto de la web de la tienda, con formato</button>
      <small class="muted">De «${a.title}». Revísalo y guarda.</small></div>`;
  } catch (e) { return ''; }
}
module.exports.calTextButton = calTextButton;
