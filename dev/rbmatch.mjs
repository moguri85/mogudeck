// Riftbound: cómo vienen las partidas (empates incluidos) de un torneo
const T = process.argv[2] || '117557998796655771';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const get = async (u, h = {}) => (await fetch(u, { headers: { 'User-Agent': UA, ...h } })).text();
const page = await get(`https://events.playriftbound.com/en-US/events/${T}`);
let hash = null; const seen = new Set(), q = [...page.matchAll(/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g)].map(m => m[1]);
while (q.length && !hash && seen.size < 150) { const c = q.shift(); if (seen.has(c)) continue; seen.add(c); const js = await get(`https://events.playriftbound.com/_next/static/chunks/${c}`);
  hash = (js.match(/"id"\s*:\s*"([0-9a-f]{64})"\s*,\s*"name"\s*:\s*"GetCompeteTournamentForRiftboundPlayer"/) || [])[1]; for (const m of js.matchAll(/static\/chunks\/([A-Za-z0-9_.-]+\.js)/g)) q.push(m[1]); }
const u = 'https://events.playriftbound.com/api/gql?' + new URLSearchParams({ operationName: 'GetCompeteTournamentForRiftboundPlayer', variables: JSON.stringify({ tournamentId: T }), extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: hash } }) });
const j = JSON.parse(await get(u, { Accept: 'application/json', 'apollo-require-preflight': 'true', 'apollographql-client-name': 'Esports Web', 'apollographql-client-version': '1.0.0' }));
const t = j.data.competeTournaments[0];
console.log('status', t.status);
for (const st of t.stages) { console.log('STAGE', st.esportsStageId, st.name, st.status, 'sections', st.sections.length);
  for (const sec of st.sections) console.log('  SECTION', sec.esportsSectionId, sec.type, 'rounds', (sec.rounds || []).length, 'columns', JSON.stringify(sec.columns || null).slice(0, 1500), 'seeding', JSON.stringify(sec.seeding || null).slice(0, 300)); }
for (const st of t.stages) for (const sec of st.sections) for (const rd of sec.rounds) {
  console.log(`== ronda ${rd.roundNumber} ${rd.status} matches ${rd.matches.length} byes ${JSON.stringify(rd.byeTeamIds)} standings ${(rd.endOfRoundStandings || []).length}`);
  for (const m of rd.matches) {
    const g = (m.games || []).map(x => x.teamOutcomes ? x.teamOutcomes.map(o => o.outcome[0]).join('') : '-').join(' ');
    console.log(`  mesa ${m.tableNumber} ${m.status} ${m.strategy} match=${m.teamOutcomes ? m.teamOutcomes.map(o => o.outcome).join('/') : 'null'} games=[${g}]`);
  }
}
