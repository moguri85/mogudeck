'use strict';
// Bracket estimado de un mazo de Commander (sistema oficial de brackets 1-5), como hace Archidekt:
// cuenta Game Changers, destrucción masiva de tierras, turnos extra y combos de dos cartas.
// Los datos salen de Commander Spellbook (combos y clasificación de cartas); si no responde, de la base local.
const { log } = require('./db');
const API = (process.env.SPELLBOOK_URL || 'https://backend.commanderspellbook.com').replace(/\/$/, '');

const NAMES = {
  1: ['Exhibition', 'Exhibición'], 2: ['Core', 'Básico'], 3: ['Upgraded', 'Mejorado'], 4: ['Optimized', 'Optimizado'], 5: ['cEDH', 'Competitivo'],
};
const label = n => (NAMES[n] ? `${n} · ${NAMES[n][0]}` : String(n));

// Destrucción masiva de tierras (lista oficial y cartas de efecto equivalente), por si Spellbook no responde
const MLD = new Set([
  'armageddon', 'ravages of war', 'catastrophe', 'decree of annihilation', 'jokulhaups', 'obliterate', 'ruination', 'wildfire', 'sunder',
  'impending disaster', 'devastation', 'global ruin', 'boom // bust', 'destructive force', 'winter orb', 'static orb', 'rising waters',
  'hokori, dust drinker', 'back to basics', 'blood moon', 'magus of the moon', 'epicenter', 'keldon firebombers', 'thoughts of ruin',
  'tectonic break', 'worldfire', 'contamination', 'infernal darkness', 'acid rain', 'tsunami', 'flashfires', 'choking sands', 'boil',
]);

async function post(body, type) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${API}/estimate-bracket`, {
      method: 'POST', signal: ctrl.signal, body,
      headers: { 'Content-Type': type, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; JupiterTorneos/1.0)' },
    });
    if (!r.ok) throw new Error(`Commander Spellbook respondió ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j.cards)) throw new Error('Respuesta inesperada de Commander Spellbook');
    return j;
  } catch (e) {
    throw e.name === 'AbortError' ? new Error('Commander Spellbook no responde') : e;
  } finally { clearTimeout(t); }
}
async function spellbook(commanders, main) {
  try {
    return await post(JSON.stringify({ commanders: commanders.map(c => ({ card: c, quantity: 1 })), main: main.map(m => ({ card: m.name, quantity: m.qty })) }), 'application/json');
  } catch (e) {
    // Segundo intento con la lista en texto (el mismo formato que acepta su web)
    const text = ['Commander', ...commanders.map(c => `1 ${c}`), '', 'Deck', ...main.map(m => `${m.qty} ${m.name}`)].join('\n');
    try { return await post(text, 'text/plain'); } catch { throw e; }
  }
}

// lines: [{ name, qty, commander, info: { gc, et, tut } }]
async function estimate(lines) {
  const commanders = lines.filter(l => l.commander).map(l => l.name);
  const main = lines.filter(l => !l.commander);
  const out = { gc: [], mld: [], et: [], combos: [], banned: [], tutors: [], source: null, error: null };
  const addU = (arr, n) => { if (!arr.some(x => x.toLowerCase() === n.toLowerCase())) arr.push(n); };
  // 1) Datos propios (base de Scryfall): Game Changers oficiales, turnos extra y destrucción masiva de tierras
  const known = lines.filter(l => l.info && l.info.gc != null);
  for (const l of lines) {
    const i = l.info || {};
    if (i.gc) addU(out.gc, l.name);
    if (i.et) addU(out.et, l.name);
    if (MLD.has(l.name.toLowerCase())) addU(out.mld, l.name);
  }
  if (known.length) out.source = 'scryfall';
  // 2) Commander Spellbook: su clasificación de cartas y los combos de dos cartas
  try {
    const sb = await spellbook(commanders, main);
    out.source = out.source ? 'scryfall+spellbook' : 'spellbook';
    for (const c of sb.cards) {
      const n = c.card && c.card.name;
      if (!n) continue;
      if (c.gameChanger) addU(out.gc, n);
      if (c.massLandDenial) addU(out.mld, n);
      if (c.extraTurn) addU(out.et, n);
      if (c.banned) addU(out.banned, n);
    }
    for (const v of sb.combos || []) {
      if (!v.relevant || !(v.definitelyTwoCard || v.arguablyTwoCard)) continue;
      const cards = ((v.combo && v.combo.uses) || []).map(u => u.card && u.card.name).filter(Boolean);
      out.combos.push({ cards, speed: v.speed || 0, definite: !!v.definitelyTwoCard });
    }
  } catch (e) {
    out.error = e.message;
    log('warn', 'Bracket (Commander Spellbook): ' + e.message);
  }
  // Sin ninguna fuente no se puede saber: mejor decirlo que dar un 1-2 falso
  if (!out.source) return { n: null, label: '?', unknown: true, maybeOne: false, reasons: [], ...out };
  for (const l of lines) if (l.info && l.info.tut) out.tutors.push(l.name);

  // Reglas de los brackets (actualización de octubre de 2025):
  //  2 (o 1): sin Game Changers, sin destrucción masiva de tierras, sin combos de dos cartas, turnos extra solo de forma puntual.
  //  3: hasta 3 Game Changers, sin destrucción masiva de tierras, sin combos de dos cartas tempranos, sin encadenar turnos extra.
  //  4: lo demás. El 5 (cEDH) depende de la intención y el 1 del tema del mazo: no se deducen solos.
  const reasons = [];
  let n = 2;
  const up = (to, why) => { reasons.push({ to, why }); n = Math.max(n, to); };
  if (out.gc.length > 3) up(4, `${out.gc.length} Game Changers (más de 3)`);
  else if (out.gc.length) up(3, `${out.gc.length} Game Changer${out.gc.length > 1 ? 's' : ''}`);
  if (out.mld.length) up(4, `destrucción masiva de tierras (${out.mld.join(', ')})`);
  const early = out.combos.filter(c => c.definite && c.speed >= 4);
  if (early.length) up(4, `combo${early.length > 1 ? 's' : ''} de dos cartas rápido${early.length > 1 ? 's' : ''}: ${early.map(c => c.cards.join(' + ')).join('; ')}`);
  else if (out.combos.length) up(3, `combo${out.combos.length > 1 ? 's' : ''} de dos cartas: ${out.combos.map(c => c.cards.join(' + ')).join('; ')}`);
  if (out.et.length >= 3) up(4, `${out.et.length} cartas de turnos extra (se pueden encadenar)`);
  else if (out.et.length === 2) up(3, `2 cartas de turnos extra`);
  if (out.banned.length) reasons.push({ info: true, to: n, why: `cartas prohibidas en Commander: ${out.banned.join(', ')}` });
  if (!out.source.includes('spellbook')) reasons.push({ info: true, to: n, why: 'sin datos de combos (Commander Spellbook no ha respondido): el bracket podría ser mayor' });
  return { n, label: label(n), maybeOne: n === 2, reasons, ...out };
}

module.exports = { estimate, label, NAMES };
