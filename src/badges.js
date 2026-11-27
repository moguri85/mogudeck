'use strict';
// Gamificación: experiencia (XP), niveles e insignias con tres grados (bronce, plata, oro).
const { db } = require('./db');
const I = require('./identity');
const rivals = require('./rivals');

const BADGES = [
  { id: 'asiduo', name: 'Asiduo', desc: 'Torneos jugados', tiers: [5, 20, 50], unit: 'torneos' },
  { id: 'campeon', name: 'Campeón', desc: 'Torneos ganados', tiers: [1, 5, 15], unit: 'títulos' },
  { id: 'podio', name: 'Podio', desc: 'Veces entre los tres primeros', tiers: [3, 10, 30], unit: 'podios' },
  { id: 'racha', name: 'En racha', desc: 'Victorias seguidas (mejor racha)', tiers: [3, 5, 8], unit: 'seguidas' },
  { id: 'sociable', name: 'Sociable', desc: 'Rivales distintos', tiers: [10, 30, 60], unit: 'rivales' },
  { id: 'fiel', name: 'Fiel', desc: 'Semanas seguidas jugando en la tienda', tiers: [3, 6, 12], unit: 'semanas' },
  { id: 'poliglota', name: 'Políglota', desc: 'Juegos distintos jugados en torneo', tiers: [2, 3, 4], unit: 'juegos' },
  { id: 'milcaras', name: 'Mil caras', desc: 'Comandantes distintos en Commander', tiers: [3, 7, 15], unit: 'comandantes' },
  { id: 'conpoco', name: 'Con poco', desc: 'Mesas de Commander ganadas con un mazo de menos de 50 €', tiers: [1, 3, 10], unit: 'mesas' },
  { id: 'versatil', name: 'Versátil', desc: 'Comandantes distintos con los que has ganado una mesa', tiers: [2, 5, 10], unit: 'comandantes' },
  { id: 'remontada', name: 'Remontada', desc: 'Mesas ganadas acabando con 5 vidas o menos (contador de vidas)', tiers: [1, 3, 10], unit: 'remontadas' },
  { id: 'letal', name: 'Comandante letal', desc: 'Jugadores eliminados con 21 de daño de comandante', tiers: [1, 5, 15], unit: 'eliminaciones' },
  { id: 'venenoso', name: 'Venenoso', desc: 'Jugadores eliminados con veneno', tiers: [1, 3, 10], unit: 'eliminaciones' },
  { id: 'rayo', name: 'Rayo', desc: 'Mesas con turno medio de menos de minuto y medio («Pasar turno» en el contador)', tiers: [1, 5, 15], unit: 'mesas' },
  { id: 'casual', name: 'Liga casual', desc: 'Partidas casuales confirmadas para la liga', tiers: [3, 10, 30], unit: 'partidas' },
  { id: 'verdugo', name: 'Verdugo', desc: 'Jugadores eliminados en mesas de Commander (contador de vidas)', tiers: [5, 20, 50], unit: 'eliminaciones' },
  { id: 'matagigantes', name: 'Matagigantes', desc: 'Victorias contra jugadores que han ganado un torneo', tiers: [1, 5, 15], unit: 'victorias' },
  { id: 'cazador', name: 'Cazarrecompensas', desc: 'Recompensas cobradas', tiers: [1, 3, 5], unit: 'recompensas' },
  { id: 'sebusca', name: 'Se busca', desc: 'Veces con recompensa sobre tu cabeza', tiers: [1, 3, 5], unit: 'veces' },
  { id: 'adivino', name: 'Adivino', desc: 'Puntos en la porra', tiers: [10, 50, 150], unit: 'puntos' },
  { id: 'mecenas', name: 'Mecenas', desc: 'Mazos prestados y devueltos', tiers: [1, 3, 10], unit: 'préstamos' },
  { id: 'comerciante', name: 'Comerciante', desc: 'Cartas en tu Tengo / Busco', tiers: [10, 50, 150], unit: 'cartas' },
  { id: 'reportero', name: 'Reportero', desc: 'Fotos publicadas en la TV', tiers: [1, 5, 15], unit: 'fotos' },
  // Secretos: no se dice cómo se consiguen hasta tenerlos
  { id: 'maraton', name: 'Maratón', desc: 'Mesas de Commander de más de hora y media (contador de vidas)', tiers: [1, 3, 10], unit: 'mesas', secret: true },
  { id: 'expres', name: 'Exprés', desc: 'Mesas ganadas en menos de 25 minutos (contador de vidas)', tiers: [1, 3, 10], unit: 'mesas', secret: true },
  { id: 'pacifista', name: 'Pacifista', desc: 'Mesas ganadas sin eliminar tú a nadie', tiers: [1, 3, 10], unit: 'mesas', secret: true },
  { id: 'duo', name: 'Dúo dinámico', desc: 'Mesas jugadas con dos comandantes', tiers: [1, 5, 15], unit: 'mesas', secret: true },
  { id: 'trasnochador', name: 'Trasnochador', desc: 'Mesas terminadas pasada la medianoche', tiers: [1, 3, 10], unit: 'mesas', secret: true },
];
const TIER = ['', 'Bronce', 'Plata', 'Oro'];
const XP = { casual: 4, casualWin: 6, kill: 4, event: 10, matchWin: 5, podWin: 12, podium: 20, title: 60, porraPoint: 3, bounty: 50, loan: 25, moment: 10, trade: 1 };
const RANKS = [[1, 'Novato'], [3, 'Aprendiz'], [5, 'Habitual'], [8, 'Veterano'], [12, 'Maestro'], [17, 'Leyenda']];
const needFor = L => 25 * (L - 1) * L; // XP total para llegar al nivel L
function levelOf(xp) {
  let L = 1;
  while (xp >= needFor(L + 1)) L++;
  const from = needFor(L), to = needFor(L + 1);
  return { level: L, title: RANKS.filter(r => L >= r[0]).pop()[1], xp, from, to, pct: Math.round((xp - from) * 100 / (to - from)) };
}
const isoWeek = d => { const t = new Date(d); if (isNaN(t)) return null; const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3); const y = t.getUTCFullYear(); const f = new Date(Date.UTC(y, 0, 4)); return y * 100 + 1 + Math.round(((t - f) / 864e5 - 3 + ((f.getUTCDay() + 6) % 7)) / 7); };
const weekIndex = w => Math.floor(w / 100) * 53 + (w % 100);

let cache = null, cacheAt = 0;
function build() {
  const people = require('./people');
  const all = people.entries().filter(e => e.source !== 'commander' || e.public);
  const byKey = new Map();
  for (const e of all) { if (!byKey.has(e.key)) byKey.set(e.key, []); byKey.get(e.key).push(e); }
  const champions = new Set(all.filter(e => e.finished && e.rank === 1).map(e => e.key));
  const podWin = new Map(db.prepare('SELECT winner_id id, COUNT(*) n FROM cmd_pods WHERE reported = 1 AND is_draw = 0 AND winner_id IS NOT NULL GROUP BY winner_id').all().map(r => [r.id, r.n]));
  const cheapWin = new Map(db.prepare(`SELECT pd.winner_id id, COUNT(*) n FROM cmd_pods pd JOIN cmd_players p ON p.id = pd.winner_id
    WHERE pd.reported = 1 AND pd.is_draw = 0 AND p.deck_value_cents IS NOT NULL AND p.deck_value_cents < 5000 GROUP BY pd.winner_id`).all().map(r => [r.id, r.n]));
  // Encuentros por persona y resultado por partida (en Commander, una mesa = una partida)
  const enc = new Map();
  for (const e of rivals.all()) {
    for (const [me, opp, r] of [[e.a, e.b, e.ra], [e.b, e.a, { W: 'L', L: 'W', D: 'D', N: 'N' }[e.ra]]]) {
      if (!enc.has(me)) enc.set(me, []);
      enc.get(me).push({ ...e, opp, r });
    }
  }
  const killsBy = new Map(db.prepare('SELECT p.id, COUNT(*) n FROM cmd_kills k JOIN cmd_players p ON p.id = k.killer_id GROUP BY p.id').all().map(r => [r.id, r.n]));
  const bountyClaims = new Map(db.prepare("SELECT claimed_key k, COUNT(*) n FROM bounties WHERE status IN ('claimed','delivered') GROUP BY claimed_key").all().map(r => [r.k, r.n]));
  const bountyOn = new Map(db.prepare("SELECT person_key k, COUNT(*) n FROM bounties WHERE status != 'cancelled' GROUP BY person_key").all().map(r => [r.k, r.n]));
  const accRows = db.prepare('SELECT id, name, nick FROM accounts').all();
  const accOf = new Map(accRows.map(a => [I.resolve('a:' + a.id), a]));
  const porra = new Map(db.prepare("SELECT account_id id, SUM(points) pts FROM predictions WHERE status = 'win' GROUP BY account_id").all().map(r => [r.id, r.pts]));
  const loans = new Map(db.prepare("SELECT d.account_id id, COUNT(*) n FROM loan_requests r JOIN loan_decks d ON d.id = r.deck_id WHERE r.status = 'returned' GROUP BY d.account_id").all().map(r => [r.id, r.n]));
  const trades = new Map(db.prepare('SELECT account_id id, COUNT(*) n FROM trade_items GROUP BY account_id').all().map(r => [r.id, r.n]));
  const moms = new Map(db.prepare("SELECT account_id id, COUNT(*) n FROM moments WHERE status = 'approved' GROUP BY account_id").all().map(r => [r.id, r.n]));

  let facts = new Map();
  try { facts = require('./cmdstats').factsByKey(); } catch (e) { facts = new Map(); }
  const out = new Map();
  let spKeys = [];
  try { spKeys = [...require('./specials').byKey().keys()]; } catch (e) { spKeys = []; }
  const keys = new Set([...byKey.keys(), ...accOf.keys(), ...facts.keys(), ...spKeys]);
  for (const key of keys) {
    const list = byKey.get(key) || [];
    const acc = accOf.get(key) || null;
    const es = enc.get(key) || [];
    // Partidas en orden: Melee una por emparejamiento; Commander una por mesa
    const games = new Map();
    for (const e of es) {
      const id = `${e.source}:${e.eventId}:${e.round}:${e.table}`;
      const g = games.get(id) || { date: e.date, round: e.round || 0, rs: [] };
      g.rs.push(e.r); games.set(id, g);
    }
    const seq = [...games.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.round - b.round)
      .map(g => (g.rs.includes('D') ? 'D' : g.rs.includes('L') ? 'L' : g.rs.includes('W') ? 'W' : 'L'));
    let best = 0, cur = 0;
    for (const r of seq) { cur = r === 'W' ? cur + 1 : 0; best = Math.max(best, cur); }
    const weeks = [...new Set(list.map(e => isoWeek(e.date)).filter(Boolean).map(weekIndex))].sort((a, b) => a - b);
    let wrun = weeks.length ? 1 : 0, wbest = wrun;
    for (let i = 1; i < weeks.length; i++) { wrun = weeks[i] === weeks[i - 1] + 1 ? wrun + 1 : 1; wbest = Math.max(wbest, wrun); }
    const cmdList = list.filter(e => e.source === 'commander');
    const podWins = cmdList.reduce((s, e) => s + (podWin.get(e.playerId) || 0), 0);
    const matchWins = list.filter(e => e.source === 'melee').reduce((s, e) => s + (e.w || 0), 0);
    const titles = list.filter(e => e.finished && e.rank === 1).length;
    const podiums = list.filter(e => e.finished && e.rank && e.rank <= 3).length;
    const v = {
      asiduo: list.length, campeon: titles, podio: podiums, racha: best,
      sociable: new Set(es.map(e => e.opp)).size, fiel: wbest,
      poliglota: new Set(list.map(e => e.game)).size,
      milcaras: new Set(cmdList.map(e => String(e.deck || '').trim().toLowerCase()).filter(Boolean)).size,
      conpoco: cmdList.reduce((s, e) => s + (cheapWin.get(e.playerId) || 0), 0),
      verdugo: cmdList.reduce((s, e) => s + (killsBy.get(e.playerId) || 0), 0),
      matagigantes: es.filter(e => e.r === 'W' && champions.has(e.opp) && e.opp !== key).length,
      cazador: bountyClaims.get(key) || 0, sebusca: bountyOn.get(key) || 0,
      adivino: acc ? porra.get(acc.id) || 0 : 0, mecenas: acc ? loans.get(acc.id) || 0 : 0,
      comerciante: acc ? trades.get(acc.id) || 0 : 0, reportero: acc ? moms.get(acc.id) || 0 : 0,
    };
    const f = facts.get(key);
    if (f) {
      v.milcaras = Math.max(v.milcaras, f.commanders);
      Object.assign(v, { versatil: f.winCommanders, remontada: f.comebacks, letal: f.killsCmd, venenoso: f.killsPoison, rayo: f.fastPods, casual: f.casualGames,
        maraton: f.marathons, expres: f.expressWins, pacifista: f.pacifist, duo: f.partnerGames, trasnochador: f.lateNights });
    }
    const specials = (() => { try { return require('./specials').of(key); } catch (e) { return []; } })();
    const xp = specials.reduce((n, s) => n + (s.xp || 0), 0) + v.verdugo * XP.kill + list.length * XP.event + matchWins * XP.matchWin + podWins * XP.podWin + podiums * XP.podium + titles * XP.title
      + (f ? f.casualGames * XP.casual + f.casualWins * XP.casualWin : 0)
      + v.adivino * XP.porraPoint + v.cazador * XP.bounty + v.mecenas * XP.loan + v.reportero * XP.moment + Math.min(v.comerciante, 50) * XP.trade;
    const badges = BADGES.map(b => {
      const val = v[b.id] || 0;
      const tier = b.tiers.filter(t => val >= t).length;
      return { ...b, value: val, tier, tierName: TIER[tier], next: b.tiers[tier] ?? null, pct: tier >= 3 ? 100 : Math.min(100, Math.round(val * 100 / b.tiers[tier])) };
    });
    out.set(key, { key, account: acc, xp, ...levelOf(xp), badges, earned: badges.filter(b => b.tier).length, values: v, specials });
  }
  return out;
}
function allStats() {
  if (!cache || Date.now() - cacheAt > 90e3) { cache = build(); cacheAt = Date.now(); }
  return cache;
}
function invalidate() { cache = null; }
function of(key) {
  const k = I.resolve(key);
  return allStats().get(k) || { key: k, xp: 0, ...levelOf(0), badges: BADGES.map(b => ({ ...b, value: 0, tier: 0, tierName: '', next: b.tiers[0], pct: 0 })), earned: 0, values: {}, specials: [] };
}
function leaderboard(limit = 50) {
  const people = require('./people');
  return [...allStats().values()].filter(s => s.xp > 0).sort((a, b) => b.xp - a.xp || b.earned - a.earned).slice(0, limit)
    .map((s, i) => ({ ...s, pos: i + 1, name: people.publicName(s.key) }));
}
// Insignias nuevas desde la última visita de la cuenta (para avisar una vez)
function fresh(accountId, key) {
  const st = of(key);
  const seen = new Map(db.prepare('SELECT badge, tier FROM badges_seen WHERE account_id = ?').all(accountId).map(r => [r.badge, r.tier]));
  const first = seen.size === 0;
  const nw = st.badges.filter(b => b.tier > (seen.get(b.id) || 0));
  const up = db.prepare('INSERT INTO badges_seen (account_id, badge, tier) VALUES (?, ?, ?) ON CONFLICT(account_id, badge) DO UPDATE SET tier = excluded.tier, seen_at = datetime(\'now\')');
  db.transaction(() => { if (first) up.run(accountId, '_init', 0); for (const b of nw) up.run(accountId, b.id, b.tier); })();
  return first ? [] : nw; // la primera vez no se avisa de todo de golpe
}

module.exports = { BADGES, TIER, XP, levelOf, of, leaderboard, fresh, invalidate };
