'use strict';
// Servidor falso de Melee para desarrollo: imita los endpoints usados con datos inventados.
const http = require('http');

let seed = 42;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const pick = a => a[Math.floor(rnd() * a.length)];

const FIRST = ['Lucía', 'Marcos', 'Ana', 'Pablo', 'Irene', 'Sergio', 'Nuria', 'Javi', 'Elena', 'Raúl', 'Marta', 'Diego', 'Sara', 'Álvaro', 'Clara', 'Hugo', 'Paula', 'Iván', 'Laura', 'Óscar'];
const LAST = ['García', 'Martí', 'López', 'Navarro', 'Soler', 'Ferrer', 'Ruiz', 'Gil', 'Torres', 'Vidal'];
const PEOPLE = FIRST.map((f, i) => ({ first: f, last: LAST[i % LAST.length], user: (f.slice(0, 3) + LAST[i % LAST.length].slice(0, 3) + (i + 7)).normalize('NFD').replace(/[̀-ͯ]/g, ''), uid: `uid-${i}` }));
const DECKS = ['Sabine / Tarkintown', 'Darth Vader / Energy Conversion Lab', 'Han Solo / Lake Country', 'Boba Fett / Jedha', 'Leia / Echo Base', 'Grand Inquisitor / Maz Kanata'];

const now = Date.now();
const day = 864e5;
const T = [];
let teamSeq = 100000, guidSeq = 1;

function makeTournament({ id, name, game, status, start, nPlayers, rounds, playedRounds, live, decks }) {
  const players = [...PEOPLE].sort(() => rnd() - .5).slice(0, nPlayers).map(p => ({ ...p, team: teamSeq++, pid: teamSeq + 500000 }));
  const phaseId = id * 10;
  const roundsArr = Array.from({ length: rounds }, (_, i) => ({ ID: id * 100 + i + 1, Guid: `r-${id}-${i}`, Name: `Ronda ${i + 1}`, SortOrder: i + 1 }));
  const pts = new Map(players.map(p => [p.team, { w: 0, l: 0, d: 0, gw: 0, gl: 0, pts: 0 }]));
  const matches = [];
  for (let r = 1; r <= playedRounds; r++) {
    const order = [...players].sort((a, b) => pts.get(b.team).pts - pts.get(a.team).pts || rnd() - .5);
    let table = 1;
    for (let i = 0; i < order.length; i += 2) {
      const a = order[i], b = order[i + 1];
      const finished = !(live && r === playedRounds && rnd() < 0.45);
      const comp = (p, w, sort) => ({ Team: { ID: p.team, Players: [{ ID: p.pid, TeamId: p.team, Username: p.user, DisplayName: p.user, Name: `${p.first} ${p.last}` }] }, TeamId: p.team, SortOrder: sort, GameWins: finished ? w : null, GameByes: null });
      if (!b) {
        matches.push({ Guid: `m-${guidSeq++}`, Competitors: [comp(a, null, 0)], ByeReason: 0, RoundNumber: r, RoundId: roundsArr[r - 1].ID, TableNumber: null, HasResult: true, MatchesPublished: true, PhaseSortOrder: 1, GameDraws: 0, ResultString: `a ${a.user} se le asignó un bye`, DateCreated: new Date().toISOString() });
        const s = pts.get(a.team); s.w++; s.pts += 3;
        continue;
      }
      const draw = rnd() < 0.08;
      const aw = draw ? 1 : rnd() < 0.5 ? 2 : pick([0, 1]);
      const bw = draw ? 1 : aw === 2 ? pick([0, 1]) : 2;
      matches.push({ Guid: `m-${guidSeq++}`, Competitors: [comp(a, aw, 0), comp(b, bw, 1)], ByeReason: null, RoundNumber: r, RoundId: roundsArr[r - 1].ID, TableNumber: table++, HasResult: finished, MatchesPublished: true, PhaseSortOrder: 1, GameDraws: draw ? 1 : 0, ResultString: finished ? (aw === bw ? 'Empate 1-1-1' : `${aw > bw ? a.user : b.user} ganó ${Math.max(aw, bw)}-${Math.min(aw, bw)}-0`) : null, DateCreated: new Date().toISOString() });
      if (finished) {
        const sa = pts.get(a.team), sb = pts.get(b.team);
        if (aw > bw) { sa.w++; sb.l++; sa.pts += 3; } else if (bw > aw) { sb.w++; sa.l++; sb.pts += 3; } else { sa.d++; sb.d++; sa.pts++; sb.pts++; }
      }
    }
  }
  const ranked = [...players].sort((a, b) => pts.get(b.team).pts - pts.get(a.team).pts || rnd() - .5);
  const standings = playedRounds ? ranked.map((p, i) => {
    const s = pts.get(p.team);
    return { TeamId: p.team, Rank: i + 1, Points: s.pts, MatchRecord: `${s.w}-${s.l}-${s.d}`, GameRecord: '', OpponentMatchWinPercentage: 0.33 + rnd() * 0.4, TeamGameWinPercentage: 0.5, OpponentGameWinPercentage: 0.5, RoundNumber: playedRounds, StandingsPublished: true };
  }) : [];
  const playerList = players.map((p, i) => ({ ID: p.pid, TeamId: p.team, UserIdentity: p.uid, Username: p.user, DisplayName: p.user, PlayerName: `${p.first} ${p.last}`, Status: 2, StatusDescription: 'Activo', RoundDroppedNumber: i === 3 && playedRounds > 2 ? 2 : null, Paid: rnd() < 0.6, IsCheckedIn: true, RegistrationDate: new Date(start - 2 * day).toISOString() }));
  // Formato real de Melee: Records con n (nombre), s (subtítulo), q (copias) y c (0 mazo, 9 leyendas, 99 sideboard)
  const POOL = [['Mantis Blades', null], ['Peace Offering', null], ['Meredith Stout', 'Stone Cold Corpo'], ['Trust No One', null], ['Chrome Reverie', null], ['Towerfall', null], ['Floor It', null]];
  const LEG = [['Royce', 'Psycho on the Edge'], ['Adam Smasher', 'Ender of Legends'], ['Judy Álvarez', 'Braindance Maestro'], ['Panam Palmer', null]];
  const recs = i => [
    ...POOL.filter((_, k) => (i + k) % 3).map(([n, sub], k) => ({ l: n.toLowerCase().replace(/\W/g, ''), n, s: sub, q: 1 + ((i + k) % 3), c: 0, t: 'Deck' })),
    ...LEG.filter((_, k) => k !== i % 4).map(([n, sub]) => ({ l: n.toLowerCase().replace(/\W/g, ''), n, s: sub, q: 1, c: 9, t: 'Deck' })),
    { l: 'floorit', n: 'Floor It', s: null, q: 2, c: 99, t: 'Deck' },
  ];
  const decklists = decks ? players.map((p, i) => ({ ID: `d-${id}-${i}`, TeamId: p.team, Name: pick(DECKS), FormatName: 'Premier', Records: recs(i) })) : [];
  const t = {
    ID: id, Guid: `g-${id}`, Name: name, CurrentPhaseId: phaseId, Formats: ['Premier'], OrganizationId: 1, OrganizationName: 'Tienda Demo',
    SearchTags: [], BrandImageSource: '', TimerState: live ? 1 : null, TimerStateDescription: null,
    TimerEnd: live ? new Date(now + 25 * 60e3).toISOString() : null, Game: game, TournamentType: 4, TournamentTypeDescription: 'Tabletop',
    Status: status, StatusDescription: { 0: 'No publicado', 1: 'Registro', 2: 'En curso', 3: 'Cancelado', 4: 'Finalizado' }[status],
    LastPairDateTime: playedRounds ? new Date(live ? now - 20 * 60e3 : start + 2 * 3600e3).toISOString() : null,
    Phases: [{ ID: phaseId, Guid: `p-${id}`, Name: 'Fase suiza', Format: 'Premier', SortOrder: 1, Rounds: roundsArr }],
  };
  T.push({ t, start, matches, standings, playerList, decklists });
}

makeTournament({ id: 9001, name: 'SWU Semanal #12', game: 'StarWarsUnlimited', status: 4, start: now - 30 * day, nPlayers: 8, rounds: 3, playedRounds: 3, decks: true });
makeTournament({ id: 9002, name: 'Night City Brawl', game: 'CyberpunkTCG', status: 4, start: now - 10 * day, nPlayers: 10, rounds: 4, playedRounds: 4 });
makeTournament({ id: 9006, name: 'Store Showdown SWU', game: 'StarWarsUnlimited', status: 4, start: now - 3 * day, nPlayers: 14, rounds: 4, playedRounds: 4, decks: true });
makeTournament({ id: 9003, name: 'SWU Semanal #13', game: 'StarWarsUnlimited', status: 2, start: now - 60 * 60e3, nPlayers: 11, rounds: 4, playedRounds: 2, live: true, decks: true });
makeTournament({ id: 9004, name: 'Cyberpunk: Choom Cup', game: 'CyberpunkTCG', status: 1, start: now + 3 * day, nPlayers: 5, rounds: 4, playedRounds: 0 });
makeTournament({ id: 9005, name: 'PLANTILLA SWU semanal', game: 'StarWarsUnlimited', status: 0, start: now + 30 * day, nPlayers: 0, rounds: 4, playedRounds: 0 });

const page = (list, url) => {
  const ps = Number(url.searchParams.get('variables.pageSize')) || 25;
  const p = Number(url.searchParams.get('variables.page')) || 1;
  const content = list.slice((p - 1) * ps, p * ps);
  return { StatusCode: 200, Page: p, PageSize: ps, RecordsTotal: list.length, RecordsFiltered: list.length, Content: content, HasMore: p * ps < list.length };
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
  let m = url.pathname.match(/^\/Tournament\/View\/(\d+)/);
  if (m) {
    // Como Cloudflare: sin un navegador «de verdad» responde 403
    if (!/Mozilla/.test(req.headers['user-agent'] || '')) return send(403, '<html><title>Just a moment...</title></html>', 'text/html');
    const x = T.find(e => e.t.ID === Number(m[1]));
    if (!x) return send(404, 'no', 'text/html');
    return send(200, `<html><body><h1>${x.t.Name}</h1><p id="tournament-headline-start-date-field">
      <i class="fa fa-calendar-alt mr-1"></i><span data-toggle="datetime" data-value="${new Date(x.start).toISOString()}"></span></p></body></html>`, 'text/html');
  }
  if (!url.pathname.startsWith('/api/')) return send(404, { message: 'no' });
  const expected = 'Basic ' + Buffer.from('demo:demo').toString('base64');
  if (req.headers.authorization !== expected) return send(401, { message: 'Authorization has been denied for this request.' });
  if (url.pathname === '/api/tournament/list') return send(200, page(T.map(e => e.t), url));
  // Detalle de una decklist (formato de prueba: Records con cantidad y nombre)
  const dm = url.pathname.match(/^\/api\/decklist\/(d-\d+-\d+)$/);
  if (dm) {
    const seed = [...dm[1]].reduce((a, c) => a + c.charCodeAt(0), 0);
    const pool = ['Johnny Silverhand', 'Panam Palmer', 'Judy Alvarez', 'Netrunner Hack', 'Mantis Blades', 'Kiroshi Optics', 'Sandevistan', 'Militech Crusher',
      'Arasaka Guard', 'Ripperdoc Visit', 'Braindance', 'Corpo Takeover', 'Street Cred', 'Night City Run', 'Cyberpsychosis', 'Trauma Team', 'Meredith Stout'];
    const pickN = (n, off) => Array.from({ length: n }, (_, i) => pool[(seed * (i + 3) + off) % pool.length]).filter((v, i, a) => a.indexOf(v) === i);
    return send(200, { ID: dm[1], Name: 'Lista', Records: [
      ...pickN(3, 1).map(n => ({ Quantity: 1, Name: n === 'Johnny Silverhand' ? 'Johnny Silverhand: Rocking Renegade' : n })),
      ...pickN(10, 5).map((n, i) => ({ Quantity: 1 + ((seed + i) % 3), Name: n, Category: 'Main' })),
      ...pickN(3, 9).map(n => ({ Quantity: 1, Name: n, Category: 'Sideboard' })),
    ] });
  }
  m = url.pathname.match(/^\/api\/(tournament|match\/list\/current|match\/list|player\/list|standing\/list\/current|decklist\/list|team\/list)\/(\d+)$/);
  if (!m) return send(404, { message: 'no' });
  const x = T.find(e => e.t.ID === Number(m[2]));
  if (!x) return send(404, { message: 'no' });
  switch (m[1]) {
    case 'tournament': return send(200, x.t);
    case 'match/list': return send(200, page(x.matches, url));
    case 'match/list/current': { const r = Math.max(0, ...x.matches.map(mm => mm.RoundNumber)); return send(200, page(x.matches.filter(mm => mm.RoundNumber === r), url)); }
    case 'player/list': return send(200, page(x.playerList, url));
    case 'standing/list/current': return send(200, page(x.standings, url));
    case 'decklist/list': return send(200, page(x.decklists, url));
    default: return send(500, { message: 'An error has occurred.' });
  }
}).listen(4010, () => console.log('Mock Melee en http://localhost:4010 (credenciales demo:demo)'));
