'use strict';
// Cliente de la API de Melee.gg (solo lectura) + lectura de la fecha de inicio desde la página pública
const config = require('./config');

const GAMES = {
  StarWarsUnlimited: { label: 'Star Wars: Unlimited', short: 'SWU', color: '#d4a017' },
  CyberpunkTCG: { label: 'Cyberpunk TCG', short: 'Cyberpunk', color: '#ff2e88' },
  MagicTheGathering: { label: 'Magic: The Gathering', short: 'Magic', color: '#7b5ea7' },
  Riftbound: { label: 'Riftbound', short: 'Riftbound', color: '#2a9df4' },
};
function gameInfo(code) {
  if (code === 'commander') return { label: 'Commander', short: 'Commander', color: '#7b5ea7' };
  return GAMES[code] || { label: code || 'Otro', short: code || 'Otro', color: '#6b7280' };
}

// Estados de torneo en Melee
const STATUS = { UNPUBLISHED: 0, REGISTRATION: 1, IN_PROGRESS: 2, CANCELLED: 3, ENDED: 4 };

function authHeader() {
  const raw = `${config.meleeClientId}:${config.meleeClientSecret}`;
  return 'Basic ' + Buffer.from(raw).toString('base64');
}

function configured() {
  return Boolean(config.meleeClientId && config.meleeClientSecret);
}

async function request(path, { auth = true, accept = 'application/json', retries = 2, browser = false } = {}) {
  const url = config.meleeBase + path;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      const headers = browser
        ? { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }
        : { Accept: accept, 'User-Agent': 'TiendaTorneos/1.0' };
      if (auth) headers.Authorization = authHeader();
      const res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(timer);
      if (auth && (res.status === 401 || res.status === 403)) {
        throw Object.assign(new Error(`Melee rechazó las credenciales (${res.status}) en ${path}`), { fatal: true });
      }
      if (!auth && res.status === 403) throw Object.assign(new Error(`Melee (Cloudflare) bloqueó la lectura de la página (403) en ${path}`), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status} en ${path}`);
      return accept === 'application/json' ? await res.json() : await res.text();
    } catch (e) {
      lastErr = e;
      if (e.fatal) throw e;
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

// Recorre todas las páginas de un endpoint paginado
async function paged(path, pageSize = 200) {
  const out = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1; page < 100; page++) {
    const body = await request(`${path}${sep}variables.page=${page}&variables.pageSize=${pageSize}`);
    const content = (body && body.Content) || [];
    out.push(...content);
    if (!body.HasMore || content.length === 0) break;
  }
  return out;
}

const api = {
  listTournaments(fromDate) {
    return paged(`/api/tournament/list?startDateFrom=${encodeURIComponent(fromDate)}`, 100);
  },
  tournament(id) { return request(`/api/tournament/${id}`); },
  matches(id) { return paged(`/api/match/list/${id}`, 500); },
  currentMatches(id) { return paged(`/api/match/list/current/${id}`, 500); },
  players(id) { return paged(`/api/player/list/${id}`, 500); },
  standings(id) { return paged(`/api/standing/list/current/${id}`, 500); },
  decklists(id) { return paged(`/api/decklist/list/${id}`, 500); },
  decklist(id) { return request(`/api/decklist/${encodeURIComponent(id)}`, { retries: 1 }); },
};

// Fecha de inicio: primero en los datos de la API (si los trae); si no, en la página pública del torneo
const DATE_KEYS = ['StartDate', 'StartDateTime', 'StartDateUtc', 'StartTime', 'StartsAt', 'EventDate', 'Date'];
function apiStartDate(t) {
  for (const k of DATE_KEYS) {
    if (!t || !t[k]) continue;
    const d = new Date(t[k]);
    if (!isNaN(d) && d.getFullYear() > 2000) return d.toISOString();
  }
  return null;
}
function parseStartDate(html) {
  const m = html.match(/id="tournament-headline-start-date-field"[\s\S]{0,600}?data-value="([^"]+)"/)
    || html.match(/id="tournament-headline-countdown"[^>]*data-value="([^"]+)"/)
    || html.match(/"startDate"\s*:\s*"([^"]+)"/);
  if (!m) return null;
  const d = new Date(m[1]);
  return isNaN(d) ? null : d.toISOString();
}
async function scrapeStartDate(id) {
  const html = await request(`/Tournament/View/${id}`, { auth: false, accept: 'text/html', browser: true, retries: 1 });
  return parseStartDate(html);
}
// Para el diagnóstico de Ajustes: qué devuelve cada vía
async function debugStartDate(id) {
  const out = { id };
  try {
    const t = await request(`/api/tournament/${id}`);
    out.apiKeys = Object.keys(t || {}).filter(k => /date|time|start/i.test(k)).map(k => `${k}: ${JSON.stringify(t[k])}`);
    out.api = apiStartDate(t);
  } catch (e) { out.apiError = e.message; }
  try {
    const html = await request(`/Tournament/View/${id}`, { auth: false, accept: 'text/html', browser: true, retries: 0 });
    out.pageLength = html.length;
    out.pageTitle = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || null;
    out.page = parseStartDate(html);
    if (!out.page) out.pageSnippet = html.slice(0, 300);
  } catch (e) { out.pageError = e.message; }
  return out;
}

function urls(id) {
  const b = config.meleeBase;
  return {
    view: `${b}/Tournament/View/${id}`,
    edit: `${b}/Tournament/Edit/${id}`,
    control: `${b}/Tournament/Control/${id}`,
  };
}

module.exports = { api, scrapeStartDate, apiStartDate, debugStartDate, configured, gameInfo, GAMES, STATUS, urls };
