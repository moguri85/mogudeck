// Segunda ronda: vuelca las respuestas de las consultas públicas de playriftbound.com que sirven
const T = process.argv[2] || '117557998796655771';
const ORG = '01a0c36f-9b35-7de2-816e-1ff2d84aebdc'; // Júpiter Juegos Valencia
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(u, h = {}) { const r = await fetch(u, { headers: { 'User-Agent': UA, ...h } }); return { status: r.status, text: await r.text() }; }
const page = await get(`https://events.playriftbound.com/en-US/events/${T}`);
const ops = new Map(), seen = new Set(), queue = [...page.text.matchAll(/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g)].map(m => m[1]);
while (queue.length && seen.size < 120) {
  const c = queue.shift(); if (seen.has(c)) continue; seen.add(c);
  const r = await get(`https://events.playriftbound.com/_next/static/chunks/${c}`);
  for (const m of r.text.matchAll(/"id"\s*:\s*"([0-9a-f]{64})"\s*,\s*"name"\s*:\s*"(\w+)"/g)) ops.set(m[2], m[1]);
  for (const m of r.text.matchAll(/"name"\s*:\s*"(\w+)"\s*,\s*"id"\s*:\s*"([0-9a-f]{64})"/g)) ops.set(m[1], m[2]);
  // Texto de las consultas que nos interesan (para ver los campos)
  for (const name of ['GetCompeteTournamentForRiftboundPlayer', 'GetOrganizerTournaments', 'OrganizerSummary', 'GetCompeteRbRefreshPoller', 'GetCompeteTournaments']) {
    const i = r.text.indexOf(`query ${name}`);
    if (i >= 0) console.log(`\n##### QUERY ${name}\n` + r.text.slice(i, i + 4000).replace(/\\n/g, '\n'));
  }
  for (const m of r.text.matchAll(/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g)) if (!seen.has(m[1])) queue.push(m[1]);
}
const H = { Accept: 'application/json', 'apollo-require-preflight': 'true', 'apollographql-client-name': 'Esports Web', 'apollographql-client-version': '1.0.0' };
async function gql(name, vars) {
  const u = `https://events.playriftbound.com/api/gql?` + new URLSearchParams({ operationName: name, variables: JSON.stringify(vars), extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: ops.get(name) } }) });
  const r = await get(u, H); await sleep(800);
  return r;
}
const dump = (t, r, n = 12000) => console.log(`\n##### ${t} -> ${r.status} (${r.text.length} bytes)\n` + r.text.slice(0, n));
dump('torneo de hoy', await gql('GetCompeteTournamentForRiftboundPlayer', { tournamentId: T }), 40000);
for (const v of [{ includeUpcoming: true, includePast: true }, { includeUpcoming: true, includePast: true, organizerId: ORG }, { includeUpcoming: true, includePast: true, id: ORG }])
  dump('GetOrganizerTournaments ' + JSON.stringify(v), await gql('GetOrganizerTournaments', v), 3000);
dump('OrganizerSummary', await gql('OrganizerSummary', { id: ORG }), 3000);
for (const v of [{}, { tournamentId: T }, { esportsTournamentId: T }]) dump('GetCompeteRbRefreshPoller ' + JSON.stringify(v), await gql('GetCompeteRbRefreshPoller', v), 3000);
// Torneos pasados de Júpiter (para ver una clasificación final)
const s = await gql('CompeteTournamentSearch', { sport: 'rb', first: 100, filter: { rb: { coords: { latitude: 39.4699, longitude: -0.3763 }, distanceMeters: 15000, includePast: true } }, sortBy: { rb: 'DATE' } });
dump('busqueda con includePast', s, 1500);
