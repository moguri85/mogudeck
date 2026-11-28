// Descubre cómo leer playriftbound.com y EventLink. No usa contraseñas. Guarda todo en /tmp/disc
import fs from 'node:fs';
const OUT = '/tmp/disc'; fs.mkdirSync(OUT, { recursive: true });
const T = process.argv[2] || '117557998796655771';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(`${OUT}/resumen.txt`, s + '\n'); };
fs.writeFileSync(`${OUT}/resumen.txt`, '');
async function get(u, h = {}) { try { const r = await fetch(u, { headers: { 'User-Agent': UA, ...h } }); return { status: r.status, text: await r.text() }; } catch (e) { return { status: 0, text: String(e) }; } }

// ---------- Riftbound ----------
log('=== RIFTBOUND ===');
const page = await get(`https://events.playriftbound.com/en-US/events/${T}`);
log('pagina', page.status, page.text.length);
fs.writeFileSync(`${OUT}/rb-page.html`, page.text);
const ops = new Map();
const seen = new Set(), queue = [...page.text.matchAll(/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g)].map(m => m[1]);
let n = 0;
while (queue.length && n < 120) {
  const c = queue.shift(); if (seen.has(c)) continue; seen.add(c); n++;
  const r = await get(`https://events.playriftbound.com/_next/static/chunks/${c}`); await sleep(150);
  for (const m of r.text.matchAll(/"id"\s*:\s*"([0-9a-f]{64})"\s*,\s*"name"\s*:\s*"(\w+)"/g)) ops.set(m[2], m[1]);
  for (const m of r.text.matchAll(/"name"\s*:\s*"(\w+)"\s*,\s*"id"\s*:\s*"([0-9a-f]{64})"/g)) ops.set(m[1], m[2]);
  if (/[0-9a-f]{64}/.test(r.text) && /CompeteTournament/.test(r.text)) fs.writeFileSync(`${OUT}/rb-chunk-${c}`, r.text);
  for (const m of r.text.matchAll(/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g)) if (!seen.has(m[1])) queue.push(m[1]);
}
log('chunks', n, 'operaciones', ops.size);
log('ops:', [...ops.keys()].sort().join(' '));
fs.writeFileSync(`${OUT}/rb-ops.json`, JSON.stringify(Object.fromEntries(ops), null, 1));
const H = { Accept: 'application/json', 'apollo-require-preflight': 'true', 'apollographql-client-name': 'Esports Web', 'apollographql-client-version': '1.0.0' };
async function gql(name, vars) {
  const u = `https://events.playriftbound.com/api/gql?` + new URLSearchParams({ operationName: name, variables: JSON.stringify(vars), extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: ops.get(name) } }) });
  const r = await get(u, H); await sleep(700);
  let j = null; try { j = JSON.parse(r.text); } catch (e) { }
  return { status: r.status, j, text: r.text };
}
if (ops.has('CompeteTournamentSearch')) {
  const r = await gql('CompeteTournamentSearch', { sport: 'rb', first: 100, filter: { rb: { coords: { latitude: 39.4699, longitude: -0.3763 }, distanceMeters: 15000 } }, sortBy: { rb: 'DATE' } });
  fs.writeFileSync(`${OUT}/rb-search.json`, r.text);
  const edges = r.j?.data?.competeTournamentSearch?.edges || [];
  log('busqueda Valencia', r.status, edges.length, 'torneos', r.j?.errors ? JSON.stringify(r.j.errors).slice(0, 300) : '');
  const orgs = new Map(); for (const e of edges) orgs.set(e.node.organizer?.id, e.node.organizer?.name);
  for (const [id, nm] of orgs) log('  org', id, nm);
  for (const e of edges.filter(e => /j[uú]piter/i.test(e.node.organizer?.name || '')).slice(0, 8)) log('  jupiter:', e.node.tournament.id, e.node.tournament.startsAt, e.node.tournament.name);
}
// Para cada operación interesante: qué variables pide y si responde con el torneo de hoy
const want = [...ops.keys()].filter(k => /Tournament|Pairing|Standing|Round|Roster|Registr|Match|Organizer|Event|Player|Phase|Bracket/i.test(k) && !/Search|Mutation|Create|Update|Delete|Submit|Set|Add|Remove|Start|End|Report|Drop|Favorite|Check/i.test(k));
log('probando', want.length, 'operaciones:', want.join(' '));
for (const name of want) {
  const tries = [{}, { id: T }, { tournamentId: T }, { sport: 'rb', id: T }, { sport: 'rb', tournamentId: T }];
  for (const v of tries) {
    const r = await gql(name, v);
    const err = r.j?.errors?.map(e => e.message).join(' | ');
    if (r.j?.data && !r.j.errors) { fs.writeFileSync(`${OUT}/rb-op-${name}.json`, r.text); log(`  OK ${name} ${JSON.stringify(v)} -> ${Object.keys(r.j.data).join(',')} (${r.text.length} bytes)`); break; }
    log(`  ${name} ${JSON.stringify(v)} -> ${r.status} ${(err || r.text).slice(0, 220)}`);
    if (err && /persisted/i.test(err)) break;
  }
}

// ---------- EventLink (sin iniciar sesión: solo cómo se conecta la web) ----------
log('=== EVENTLINK ===');
const el = await get('https://eventlink.wizards.com/');
log('eventlink', el.status, el.text.length);
const scripts = [...el.text.matchAll(/src="([^"]+\.js)"/g)].map(m => new URL(m[1], 'https://eventlink.wizards.com/').href);
log('scripts', scripts.length);
for (const s of scripts.slice(0, 30)) {
  const r = await get(s); await sleep(150);
  const hits = [...r.text.matchAll(/.{0,80}(api\.platform\.wizards\.com|CLIENT_ID|clientId|client_id|SGW_VERSION|oauth\/token|silverbeak|ACCOUNTS_)[^,;]{0,120}/g)].map(m => m[0]);
  if (hits.length) { log('--', s); for (const h of [...new Set(hits)].slice(0, 15)) log('   ', h.replace(/\s+/g, ' ')); }
}
log('=== FIN: ficheros en /tmp/disc ===');
