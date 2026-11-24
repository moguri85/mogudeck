'use strict';
// Scryfall falso para desarrollo (precios inventados)
const http = require('http');
const CARDS = {
  "atraxa, praetors' voice": [['2x2', '190', '9.80'], ['c16', '28', '12.50']],
  'sol ring': [['trc', '499', null], ['c21', '263', '1.20'], ['ncc', '379', '0.75']],
  'arcane signet': [['c21', '237', '0.40'], ['cmr', '297', '0.90']],
  forest: [['m21', '274', '0.02']],
  'fire // ice': [['mh2', '290', '0.16']],
  'brazen borrower // petty theft': [['eld', '39', '14.00'], ['soc', '190', '1.25']],
  'mana crypt': [['2xm', '270', '89.00']],
  'carta sin precio': [['xxx', '1', null]],
  'rhystic study': [['pcy', '45', '28.00']], 'cyclonic rift': [['rtr', '35', '18.00']], 'demonic tutor': [['uma', '93', '30.00']],
  'smothering tithe': [['rna', '22', '15.00']], armageddon: [['me4', '4', '20.00']], 'time warp': [['e02', '13', '6.00']],
  "thassa's oracle": [['thb', '73', '12.00']], 'demonic consultation': [['ice', '115', '20.00']], bosque: [['xxx', '9', '9.00']],
};
const RULES = {
  "atraxa, praetors' voice": ['Legendary Creature — Phyrexian Angel Horror', ['W', 'U', 'B', 'G']],
  forest: ['Basic Land — Forest', ['G']], 'fire // ice': ['Instant // Instant', ['U', 'R']], 'brazen borrower // petty theft': ['Legendary Creature — Faerie Rogue // Instant — Adventure', ['U']],
};
const GCS = ['rhystic study', 'cyclonic rift', 'demonic tutor', 'smothering tithe', "thassa's oracle"];
const card = (name, [set, cn, eur]) => ({ legalities: { commander: name === 'mana crypt' ? 'banned' : 'legal' }, game_changer: GCS.includes(name), type_line: (RULES[name] || ['Artifact'])[0], color_identity: (RULES[name] || ['', []])[1], oracle_text: '', keywords: [], object: 'card', id: `${set}-${cn}`, cardmarket_id: cmId(set, cn), name: name.replace(/(^|\s|\/\/\s)\S/g, m => m.toUpperCase()), set, collector_number: cn,
  set_name: set.toUpperCase() + ' set', prices: { eur, eur_foil: eur ? (parseFloat(eur) * 2).toFixed(2) : null },
  image_uris: { small: `https://example.invalid/${set}/${cn}.jpg`, art_crop: `http://localhost:4030/art/${set}-${cn}.svg` }, artist: 'Artista ' + set.toUpperCase(), scryfall_uri: `https://scryfall.com/card/${set}/${cn}` });
function cmId(set, cn) { let h = 7; for (const ch of set + cn) h = (h * 31 + ch.charCodeAt(0)) % 900000; return 100000 + h; }
const find = n => Object.keys(CARDS).find(k => k === n.toLowerCase() || k.split(' // ')[0] === n.toLowerCase());
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (c, b) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
  // Commander Spellbook (prueba): estimación de bracket
  if (url.pathname === '/estimate-bracket' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const d = JSON.parse(body || '{}');
      const names = [...(d.commanders || []), ...(d.main || [])].map(c => c.card);
      const GC = ['Rhystic Study', 'Cyclonic Rift', 'Demonic Tutor', 'Smothering Tithe', "Thassa's Oracle"];
      const cards = names.map(n => ({ card: { name: n }, quantity: 1, banned: false, gameChanger: GC.includes(n), massLandDenial: n === 'Armageddon', extraTurn: n === 'Time Warp' }));
      const combos = names.includes("Thassa's Oracle") && names.includes('Demonic Consultation')
        ? [{ combo: { uses: [{ card: { name: "Thassa's Oracle" } }, { card: { name: 'Demonic Consultation' } }] }, relevant: true, definitelyTwoCard: true, arguablyTwoCard: true, speed: 5 }] : [];
      send(200, { bracketTag: 'C', cards, combos });
    });
    return;
  }
  // MTGJSON (prueba): lista de mazos y un mazo
  if (url.pathname === '/api/v5/DeckList.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ meta: {}, data: [
      { code: 'C21', fileName: 'LoreholdLegacies_C21', name: 'Lorehold Legacies', releaseDate: '2021-04-23', type: 'Commander Deck' },
      { code: 'MOC', fileName: 'CallforBackup_MOC', name: 'Call for Backup', releaseDate: '2023-04-21', type: 'Commander Deck' },
      { code: 'DSC', fileName: 'DeathToll_DSC', name: 'Death Toll', releaseDate: '2024-09-27', type: 'Commander Deck' },
      { code: 'NEO', fileName: 'Starter_NEO', name: 'Starter Kit', releaseDate: '2022-02-18', type: 'Starter Deck' },
    ] }));
  }
  if (url.pathname.startsWith('/api/v5/decks/')) {
    const main = [{ name: 'Sol Ring', count: 1 }, { name: 'Arcane Signet', count: 1 }, { name: 'Mountain', count: 30 }, { name: 'Plains', count: 30 }, { name: 'Fire // Ice', count: 1 }, { name: 'Command Tower', count: 36 }];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ meta: {}, data: { name: 'Mazo', commander: [{ name: 'Osgir, the Reconstructor', count: 1, colorIdentity: ['R', 'W'] }], mainBoard: main, sideBoard: [] } }));
  }
  // Netdeck (prueba): base de cartas de Cyberpunk e imágenes
  if (url.pathname === '/api/cards/cyberpunk') {
    const all = [['Royce', 'Psycho on the Edge', 'Legend'], ['Royce', "Don't Call Me Simon", 'Unit'], ['Adam Smasher', 'Ender of Legends', 'Legend'], ['Adam Smasher', 'Corpo Muscle', 'Unit'],
      ['Judy Álvarez', 'Braindance Maestro', 'Legend'], ['Peace Offering', null, 'Program'], ['Trust No One', null, 'Program'], ['Chrome Reverie', null, 'Program'], ['Towerfall', null, 'Program'], ['Floor It', null, 'Program'],
      ['Johnny Silverhand', 'Rocking Renegade', 'Legend'], ['Panam Palmer', null, 'Legend'], ['Judy Alvarez', null, 'Legend'], ['Netrunner Hack', null, 'Program'],
      ['Mantis Blades', null, 'Gear'], ['Kiroshi Optics', null, 'Gear'], ['Sandevistan', null, 'Gear'], ['Militech Crusher', null, 'Gear'], ['Arasaka Guard', null, 'Unit'],
      ['Ripperdoc Visit', null, 'Program'], ['Braindance', null, 'Program'], ['Corpo Takeover', null, 'Program'], ['Street Cred', null, 'Program'], ['Night City Run', null, 'Program'],
      ['Cyberpsychosis', null, 'Program'], ['Trauma Team', null, 'Unit']].map(([n, sub, t]) => ({ name: n, subname: sub, display_name: sub ? `${n}: ${sub}` : n,
      canonical_name: sub ? `${n} — ${sub}` : n, slug: (sub ? `${n} ${sub}` : n).toLowerCase().replace(/[^a-z0-9]+/g, '-'), card_type: t, color: 'Red' }));
    const off = Number(url.searchParams.get('offset')) || 0, lim = Number(url.searchParams.get('limit')) || 60;
    const q = (url.searchParams.get('q') || '').toLowerCase();
    // Una carta solo aparece buscando (para probar la búsqueda por nombre)
    const hidden = { name: 'Meredith Stout', subname: 'Stone Cold Corpo', display_name: 'Meredith Stout: Stone Cold Corpo', canonical_name: 'Meredith Stout — Stone Cold Corpo', slug: 'meredith-stout-stone-cold-corpo', card_type: 'Unit', color: 'Blue' };
    const list = q ? [...all, hidden].filter(c => c.display_name.toLowerCase().includes(q)) : all;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ items: list.slice(off, off + lim), total: list.length, limit: lim, offset: off }));
  }
  if (/^\/api\/cards\/cyberpunk\/[^/]+\/image$/.test(url.pathname)) {
    res.writeHead(302, { Location: '/img/x.png' }); return res.end();
  }
  // Web de cartas de Cyberpunk (prueba): página con og:image y la imagen
  if (url.pathname.startsWith('/cards/') && !/^\/cards\/(search|named|collection)$/.test(url.pathname)) {
    const slug = url.pathname.slice(7);
    if (slug === 'no-existe') { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(`<html><head><meta property="og:image" content="http://localhost:4030/img/${slug}.png?Expires=1&amp;Signature=x"></head></html>`);
  }
  // Arte de prueba: degradado distinto por impresión
  if (url.pathname.startsWith('/art/')) {
    let h = 0; for (const ch of url.pathname) h = (h * 31 + ch.charCodeAt(0)) % 360;
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="626" height="457"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},70%,45%)"/><stop offset="1" stop-color="hsl(${(h + 120) % 360},60%,25%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="420" cy="160" r="110" fill="hsl(${(h + 60) % 360},80%,70%)" opacity=".6"/><path d="M0 380 L200 250 L330 330 L626 180 L626 457 L0 457Z" fill="#0008"/></svg>`);
  }
  if (url.pathname.startsWith('/img/')) {
    const png = require('fs').readFileSync(process.env.MOCK_CARD_PNG || __filename);
    res.writeHead(200, { 'Content-Type': 'image/png' });
    return res.end(png);
  }
  if (url.pathname === '/bulk-data') {
    return send(200, { object: 'list', data: [{ type: 'default_cards', updated_at: '2026-11-05T00:00:00Z', jsonl_download_uri: 'http://localhost:4030/bulk.jsonl.gz' },
      { type: 'all_cards', updated_at: '2026-11-05T00:00:00Z', jsonl_download_uri: 'http://localhost:4030/all.jsonl.gz' }] });
  }
  if (url.pathname === '/all.jsonl.gz') {
    const foreign = [['Anillo solar', 'Sol Ring', 'es'], ['Atraxa, voz de los pretores', "Atraxa, Praetors' Voice", 'es'], ['Sceau arcanique', 'Arcane Signet', 'fr'],
      ['Estudio rístico', 'Rhystic Study', 'es'], ['Grieta ciclónica', 'Cyclonic Rift', 'es'], ['ソル・リング', 'Sol Ring', 'ja']];
    const lines = ['[', ...foreign.map(([p, n, l]) => JSON.stringify({ object: 'card', name: n, printed_name: p, lang: l }) + ','),
      JSON.stringify({ object: 'card', name: 'Sol Ring', lang: 'en' }), ']'];
    res.writeHead(200, { 'Content-Type': 'application/gzip' });
    return res.end(require('zlib').gzipSync(lines.join('\n')));
  }
  if (url.pathname === '/bulk.jsonl.gz') {
    const lines = Object.entries(CARDS).flatMap(([k, prints]) => prints.map(p => JSON.stringify({ ...card(k, p), games: ['paper'], set_type: 'expansion', layout: 'normal' })));
    lines.push(JSON.stringify({ ...card('mana crypt', ['wc97', '1', '0.50']), games: ['paper'], set_type: 'memorabilia', layout: 'normal' }));
    res.writeHead(200, { 'Content-Type': 'application/gzip' });
    return res.end(require('zlib').gzipSync(lines.join('\n')));
  }
  // Guía de precios de Cardmarket (prueba): avg = 80 % del precio de Scryfall, trend = el mismo, low = 50 %
  if (url.pathname === '/cm/price_guide_1.json') {
    const guides = Object.values(CARDS).flatMap(prints => prints.filter(p => p[2]).map(([set, cn, eur]) => {
      const e = parseFloat(eur);
      return { idProduct: cmId(set, cn), avg: +(e * 0.8).toFixed(2), low: +(e * 0.5).toFixed(2), trend: e, avg1: +(e * 0.9).toFixed(2), avg7: +(e * 0.85).toFixed(2), avg30: +(e * 0.82).toFixed(2), 'avg-foil': +(e * 1.6).toFixed(2), 'low-foil': e, 'trend-foil': e * 2 };
    }));
    return send(200, { version: 1, createdAt: '2026-11-22T02:00:00+0100', priceGuides: guides });
  }
  if (url.pathname === '/cards/search') {
    const m = url.searchParams.get('q').match(/!"([^"]+)"/);
    const k = m && find(m[1]);
    if (!k) return send(404, { object: 'error' });
    const prints = CARDS[k].filter(p => p[2]).sort((a, b) => a[2] - b[2]);
    return prints.length ? send(200, { object: 'list', data: prints.map(p => card(k, p)) }) : send(404, { object: 'error' });
  }
  if (url.pathname === '/cards/named') {
    const k = find(url.searchParams.get('fuzzy') || '');
    return k ? send(200, card(k, CARDS[k][0])) : send(404, { object: 'error' });
  }
  if (url.pathname === '/cards/collection') {
    let body = ''; req.on('data', d => (body += d)); req.on('end', () => {
      const ids = JSON.parse(body).identifiers; const data = [], nf = [];
      for (const i of ids) {
        const k = Object.keys(CARDS).find(k => CARDS[k].some(p => (i.id ? `${p[0]}-${p[1]}` === i.id : p[0] === i.set && p[1] === i.collector_number)));
        if (k) data.push(card(k, CARDS[k].find(p => (i.id ? `${p[0]}-${p[1]}` === i.id : p[0] === i.set && p[1] === i.collector_number)))); else nf.push(i);
      }
      send(200, { object: 'list', not_found: nf, data });
    }); return;
  }
  send(404, {});
}).listen(4030, () => console.log('Mock Scryfall en http://localhost:4030'));
