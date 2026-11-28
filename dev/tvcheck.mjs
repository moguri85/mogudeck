// Mira lo que recibe la TV de un torneo
const id = process.argv[2] || '900000005';
const j = await (await fetch(`https://www.moguri.es/jupiter/tv.json?id=${id}`)).json();
const t = (j.live || j.tournaments || [])[0] || j;
console.log(Object.keys(j));
const L = (j.live || [])[0];
if (L) {
  console.log('round', L.round, 'pairings', L.pairings.length, 'roster', L.roster.length, 'players', JSON.stringify(L.players));
  console.log(L.pairings.map(p => `${p.table}:${p.p1} vs ${p.p2} ${p.bye ? 'BYE' : ''} ${p.hasResult ? p.result : ''}`).join('\n'));
  const inP = new Set(L.pairings.flatMap(p => [p.p1, p.p2]));
  console.log('sin mesa:', L.roster.filter(r => !inP.has(r.name)).map(r => r.name + (r.dropped ? ' (drop ' + r.dropped + ')' : '')).join(', '));
}
