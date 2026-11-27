'use strict';
// Calendario de la web de la tienda (jupiterjuegos.com/tiendas/<tienda>/): se lee la página del mes y la de cada actividad.
// No tienen API: si cambian el diseño de su web, aquí hay que ajustar la lectura.
const { db, setting, setSetting, log, feature, addColumn } = require('./db');
const config = require('./config');

db.exec(`
CREATE TABLE IF NOT EXISTS cal_events (aid INTEGER NOT NULL, day TEXT NOT NULL, time TEXT, title TEXT NOT NULL, game TEXT, seen_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (aid, day));
CREATE TABLE IF NOT EXISTS cal_acts (aid INTEGER PRIMARY KEY, title TEXT, price TEXT, price_cents INTEGER, img TEXT, info TEXT, signup TEXT, url TEXT, fetched_at INTEGER);
`);
// Lo que llega del calendario entra como borrador: solo se ve en la web si la tienda lo publica. El contenido siempre manda el calendario
addColumn('cal_acts', 'visible', 'INTEGER DEFAULT 0');
addColumn('cal_acts', 'first_seen', 'TEXT');
// Juego según su web (Commander se detecta por el título) y lo que la tienda ha cambiado a mano: { campo: { v: valor, base: valor de su web al editarlo } }
addColumn('cal_acts', 'game', 'TEXT');
addColumn('cal_acts', 'edits', 'TEXT');

const DEFAULT_URL = 'https://jupiterjuegos.com/tiendas/valencia/';
// La misma URL que «Enlace al calendario de la tienda» en Ajustes, si es una página de tienda de su web
const calUrl = () => { const u = (setting('calendar_url') || '').trim(); return (/\/tiendas\/[^/?#]+\/?$/.test(u) ? u : DEFAULT_URL).replace(/\/?$/, '/'); };
// Código de juego en su web (clase act_N) → juego en esta web
const GAME = { 2: 'MagicTheGathering', 9: 'OnePiece', 10: 'StarWarsUnlimited', 13: 'Riftbound', 14: 'CyberpunkTCG', 5: 'other' };
// En su web Commander va como Magic: lo separamos por el título
const gameOf = (g, title) => (g === 'MagicTheGathering' && /commander|\bedh\b/i.test(title || '') ? 'commander' : g);

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JupiterTorneos/1.0)', Accept: 'text/html' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} en ${url}`);
  return r.text();
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', euro: '€', laquo: '«', raquo: '»', iexcl: '¡', iquest: '¿' };
const decode = s => String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  const l = e.toLowerCase();
  if (ENT[l] != null) return ENT[l];
  const acc = { aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', ordm: 'º', ordf: 'ª' }[e];
  return acc || m;
});
const text = s => decode(String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim();

// Página del mes: columnas de días seguidos (la primera puede ser del mes anterior) con sus actividades
function parseMonth(html, year, month) {
  const heads = [...html.matchAll(/<div style="font-size:30px;margin-bottom:7px;">(\d{1,2})<\/div>/g)];
  if (!heads.length) return [];
  const first = Number(heads[0][1]);
  let d = new Date(Date.UTC(year, first > 20 && first !== 1 ? month - 2 : month - 1, first));
  const out = [];
  heads.forEach((h, i) => {
    if (i) d = new Date(d.getTime() + 864e5);
    if (d.getUTCDate() !== Number(h[1])) d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (Number(h[1]) < d.getUTCDate() ? 1 : 0), Number(h[1]))); // por si falta algún día
    const chunk = html.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : html.indexOf('data-cual', h.index) > 0 ? html.indexOf('data-cual', h.index) : undefined);
    const day = d.toISOString().slice(0, 10);
    for (const a of chunk.matchAll(/<a class="act_0 act_(\d+)" href="[^"]*\/actividad\/(\d+)\/"[\s\S]*?<div style="font-size:13px;">([\s\S]*?)<\/div>\s*<div style="font-size:12px;">([\s\S]*?)<\/div>/g)) {
      const tm = (a[4].match(/(\d{1,2}):(\d{2})/) || []);
      const title = text(a[3]);
      out.push({ aid: Number(a[2]), day, time: tm.length ? `${tm[1].padStart(2, '0')}:${tm[2]}` : null, title, game: gameOf(GAME[a[1]] || 'other', title) });
    }
  });
  return out;
}

// Solo dejamos etiquetas sencillas y sin atributos (salvo href de enlaces http)
function cleanHtml(h) {
  const ok = new Set(['p', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'b', 'em', 'i', 'br', 'a']);
  return String(h || '').replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(\/?)([a-z0-9]+)([^>]*)>/gi, (m, sl, tag, attrs) => {
      tag = tag.toLowerCase();
      if (!ok.has(tag)) return tag === 'h1' || tag === 'h2' ? `<${sl}h3>` : '';
      if (tag === 'a' && !sl) { const href = (attrs.match(/href="(https?:\/\/[^"]+)"/i) || [])[1]; return href ? `<a href="${href.replace(/"/g, '')}" rel="noopener" target="_blank">` : '<a>'; }
      return `<${sl}${tag}>`;
    }).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000);
}
function parseAct(html, aid, url) {
  const title = text((html.match(/<h1 class="tablas_titulares">([\s\S]*?)<\/h1>/) || [])[1] || '').replace(/\s+-\s+Júpiter.*$/i, '');
  const price = text((html.match(/Precio:<\/span>([\s\S]*?)<\/div>/) || [])[1] || '');
  const pm = price.match(/(\d+(?:[.,]\d{1,2})?)\s*€/);
  const info = (html.match(/<div class="max_img_100"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<div class="col-xl-6">/) || html.match(/<div class="max_img_100"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '';
  const img = (html.match(/src="(https?:\/\/[^"]*\/archivos\/actividades\/[^"]+)"/) || [])[1] || null;
  const signup = (html.match(/href="(https?:\/\/[^"]*\/actividad-pagar\/\d+\/?)"/) || [])[1] || null;
  return { aid, title, price: price || null, price_cents: pm ? Math.round(Number(pm[1].replace(',', '.')) * 100) : (/gratis|gratuit|free/i.test(price) ? 0 : null), img, info: cleanHtml(info), signup, url };
}

let running = false, lastError = null;
async function sync({ force = false } = {}) {
  if (running || !feature('calendar')) return;
  running = true;
  try {
    const base = calUrl().replace(/\?.*$/, '');
    const now = new Date();
    const months = [0, 1].map(k => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1)); return [d.getUTCFullYear(), d.getUTCMonth() + 1]; });
    const all = [];
    for (const [y, m] of months) {
      const html = await get(`${base}?fecha=01-${String(m).padStart(2, '0')}-${y}`);
      all.push(...parseMonth(html, y, m));
      await new Promise(r => setTimeout(r, 800));
    }
    if (!all.length) throw new Error('No se ha encontrado ningún evento: puede que hayan cambiado el diseño de su web');
    const days = [...new Set(all.map(e => e.day))].sort();
    db.transaction(() => {
      db.prepare('DELETE FROM cal_events WHERE day BETWEEN ? AND ?').run(days[0], days[days.length - 1]);
      const ins = db.prepare('INSERT OR REPLACE INTO cal_events (aid, day, time, title, game) VALUES (?, ?, ?, ?, ?)');
      for (const e of all) ins.run(e.aid, e.day, e.time, e.title, e.game);
      // Cada actividad nueva entra como borrador; el título se actualiza siempre (manda el calendario)
      const seen = db.prepare("INSERT INTO cal_acts (aid, title, game, visible, first_seen) VALUES (?, ?, ?, 0, datetime('now')) ON CONFLICT(aid) DO UPDATE SET title = excluded.title, game = excluded.game");
      for (const e of all) seen.run(e.aid, e.title, e.game);
    })();
    // Detalle de cada actividad (cada 12 horas como mucho)
    const origin = new URL(base).origin;
    for (const aid of [...new Set(all.map(e => e.aid))]) {
      const c = db.prepare('SELECT fetched_at FROM cal_acts WHERE aid = ?').get(aid);
      if (!force && c && c.fetched_at && Date.now() - c.fetched_at < 3 * 3600e3) continue;
      try {
        const url = `${origin}/tiendas/actividad/${aid}/`;
        const a = parseAct(await get(url), aid, url);
        db.prepare('UPDATE cal_acts SET title = COALESCE(NULLIF(?, \'\'), title), price = ?, price_cents = ?, img = ?, info = ?, signup = ?, url = ?, fetched_at = ? WHERE aid = ?')
          .run(a.title, a.price, a.price_cents, a.img, a.info, a.signup, a.url, Date.now(), aid);
      } catch (e) { log('warn', `Calendario: actividad ${aid}: ${e.message}`); }
      await new Promise(r => setTimeout(r, 500));
    }
    lastError = null;
    setSetting('cal_synced_at', new Date().toISOString());
    setSetting('cal_count', String(all.length));
  } catch (e) {
    lastError = e.message;
    log('warn', `Calendario de la tienda: ${e.message}`);
  } finally { running = false; }
}
function start() {
  setTimeout(sync, 40e3);
  setInterval(sync, 3 * 3600e3);
}
const status = () => ({ url: calUrl(), at: setting('cal_synced_at') || null, count: Number(setting('cal_count') || 0), running, lastError });

// Fecha y hora de Madrid → ISO (para ordenar junto a los torneos de Melee)
function localISO(day, time) {
  const [y, mo, d] = day.split('-').map(Number), [h, mi] = (time || '00:00').split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(guess));
  const g = Object.fromEntries(p.map(x => [x.type, x.value]));
  const asLocal = Date.UTC(Number(g.year), Number(g.month) - 1, Number(g.day), Number(g.hour) % 24, Number(g.minute));
  return new Date(guess - (asLocal - guess)).toISOString();
}
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: config.tz });
// --- Cambios a mano. Por defecto manda su web: lo editado dura hasta que allí cambie ese campo.
// Si el campo está fijado (lock), se queda lo nuestro aunque su web cambie ---
const FIELDS = ['title', 'game', 'price', 'info', 'img', 'signup'];
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// HTML de su web → texto para editar
const htmlToText = h => decode(String(h || '').replace(/<li[^>]*>/gi, '- ').replace(/<\/(p|li|h3|h4|ul|ol)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
// Texto editado → HTML sencillo (párrafos, saltos y enlaces)
const textToHtml = t => esc(String(t || '').trim()).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" rel="noopener" target="_blank">$1</a>')
  .split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
const cents = p => { const m = String(p || '').match(/(\d+(?:[.,]\d{1,2})?)/); return m ? Math.round(Number(m[1].replace(',', '.')) * 100) : (/gratis|gratuit|free/i.test(p || '') ? 0 : null); };
const srcGame = a => a.game || (db.prepare('SELECT game FROM cal_events WHERE aid = ? ORDER BY day DESC LIMIT 1').get(a.aid) || {}).game || 'other';
// Valor de su web de cada campo (como se edita)
function source(a) {
  return { title: a.title || '', game: gameOf(srcGame(a), a.title), price: a.price || '', info: htmlToText(a.info), img: a.img || '', signup: a.signup || '' };
}
const editsOf = a => { try { return JSON.parse(a.edits || '{}') || {}; } catch (e) { return {}; } };
// La ficha tal como se muestra: lo de su web con lo editado encima
function eff(a) {
  if (!a) return null;
  const src = source(a), all = editsOf(a), ed = {};
  const o = { ...a, src, edited: [], locked: [], changed: [] };
  for (const f of FIELDS) {
    if (!all[f]) continue;
    const moved = String(all[f].base) !== String(src[f]);
    if (moved && !all[f].lock) continue; // su web ha cambiado ese campo: gana su web
    ed[f] = all[f]; o.edited.push(f);
    if (all[f].lock) { o.locked.push(f); if (moved) o.changed.push(f); }
  }
  if (ed.title) o.title = ed.title.v;
  if (ed.price) { o.price = ed.price.v || null; o.price_cents = cents(ed.price.v); }
  for (const f of ['img', 'signup']) if (ed[f]) o[f] = ed[f].v || null;
  o.game = ed.game ? ed.game.v : src.game;
  o.infoText = ed.info ? ed.info.v : src.info;
  o.infoHtml = ed.info ? textToHtml(ed.info.v) : (a.info || '');
  return o;
}
function setEdits(aid, body) {
  const a = db.prepare('SELECT * FROM cal_acts WHERE aid = ?').get(aid);
  if (!a) throw new Error('Ese evento no existe');
  const src = source(a), ed = editsOf(a);
  for (const f of FIELDS) {
    if (body[f] == null) continue;
    let v = String(body[f]).replace(/\r/g, '').trim().slice(0, f === 'info' ? 20000 : 300);
    if ((f === 'img' || f === 'signup') && v && !/^https?:\/\//i.test(v)) throw new Error('Los enlaces tienen que empezar por http');
    if (f === 'title' && !v) v = src.title;
    const lock = !!body['lock_' + f];
    const same = v === String(src[f]).trim();
    if (same && !lock) { delete ed[f]; continue; }
    // Si ya estaba fijado y no se ha tocado, se mantiene su base (para seguir avisando si su web cambió)
    if (ed[f] && ed[f].v === v && ed[f].lock === lock && (lock || String(ed[f].base) === String(src[f]))) continue;
    ed[f] = { v, base: src[f], lock };
  }
  db.prepare('UPDATE cal_acts SET edits = ? WHERE aid = ?').run(Object.keys(ed).length ? JSON.stringify(ed) : null, aid);
}
// Quitar lo editado de un campo (vuelve a mandar su web) o aceptar que se queda aunque su web haya cambiado
function resetField(aid, f, keep = false) {
  const a = db.prepare('SELECT * FROM cal_acts WHERE aid = ?').get(aid);
  if (!a) return;
  const ed = editsOf(a);
  if (!ed[f]) return;
  if (keep) ed[f].base = source(a)[f]; else delete ed[f];
  db.prepare('UPDATE cal_acts SET edits = ? WHERE aid = ?').run(Object.keys(ed).length ? JSON.stringify(ed) : null, aid);
}

// Fechas con la ficha ya combinada
function events(where, params) {
  const acts = new Map();
  return db.prepare(`SELECT e.aid, e.day, e.time FROM cal_events e JOIN cal_acts a ON a.aid = e.aid WHERE ${where} ORDER BY e.day, e.time`).all(...params).map(e => {
    if (!acts.has(e.aid)) acts.set(e.aid, eff(db.prepare('SELECT * FROM cal_acts WHERE aid = ?').get(e.aid)));
    const a = acts.get(e.aid);
    return { ...e, title: a.title, game: a.game, price: a.price, price_cents: a.price_cents, img: a.img, signup: a.signup, url: a.url, infoHtml: a.infoHtml, visible: a.visible, iso: localISO(e.day, e.time) };
  });
}
// Próximos eventos del calendario (solo publicados salvo all)
const upcoming = (limit = 200, { all = false } = {}) => events(`e.day >= ? ${all ? '' : 'AND a.visible = 1'}`, [today()]).slice(0, limit);
// Para el admin: actividades con sus próximas fechas
function activities() {
  const ds = db.prepare('SELECT day, time FROM cal_events WHERE aid = ? AND day >= ? ORDER BY day');
  return db.prepare('SELECT * FROM cal_acts').all().map(a => ({ ...eff(a), dates: ds.all(a.aid, today()) }))
    .filter(a => a.dates.length || a.visible).sort((x, y) => ((x.dates[0] || {}).day || '9').localeCompare((y.dates[0] || {}).day || '9'));
}
const setVisible = (aid, on) => db.prepare('UPDATE cal_acts SET visible = ? WHERE aid = ?').run(on ? 1 : 0, aid);
const act = aid => eff(db.prepare('SELECT * FROM cal_acts WHERE aid = ?').get(aid));
const datesOf = aid => db.prepare('SELECT day, time FROM cal_events WHERE aid = ? AND day >= ? ORDER BY day').all(aid, today());

// ¿Este torneo nuestro (Melee o Commander) es un evento del calendario? Mismo día y juego; si hay varios, el de nombre más parecido
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ');
const words = s => new Set(norm(s).split(/\s+/).filter(w => w.length > 2 && !['jupiter', 'valencia', 'torneo', 'commander'].includes(w)));
function match({ iso, game, name }, list) {
  if (!iso) return null;
  const day = new Date(iso).toLocaleDateString('sv-SE', { timeZone: config.tz });
  const cands = (list || events('e.day = ? AND a.visible = 1', [day])).filter(e => e.day === day && e.game === game);
  if (!cands.length) return null;
  const w = words(name);
  const score = e => { let n = 0; for (const x of words(e.title)) if (w.has(x)) n++; return n; };
  const best = cands.map(e => ({ e, s: score(e) })).sort((a, b) => b.s - a.s)[0];
  return best.s > 0 || cands.length === 1 ? best.e : null;
}

module.exports = { FIELDS, setEdits, resetField, activities, setVisible, sync, start, status, upcoming, act, datesOf, match, localISO, GAME, parseMonth, parseAct, DEFAULT_URL };
