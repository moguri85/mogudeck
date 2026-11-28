// EventLink: nombres de las cookies de sesión y texto de las consultas de eventos de la tienda
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const get = async u => (await fetch(u, { headers: { 'User-Agent': UA } })).text();
const home = await get('https://eventlink.wizards.com/');
const s = [...home.matchAll(/src="([^"]+\.js)"/g)].map(m => new URL(m[1], 'https://eventlink.wizards.com/').href).find(u => /index-/.test(u));
const js = await get(s);
const at = (i, a = 200, b = 600) => js.slice(Math.max(0, i - a), i + b);
for (const m of js.matchAll(/REFRESH_TOKEN\s*=\s*"|REFRESH_TOKEN:"|\.REFRESH_TOKEN="/g)) console.log('\n--- MN\n' + at(m.index, 400, 400));
for (const m of js.matchAll(/CLIENT_AUTH\s*=\s*"|CLIENT_AUTH:"|\.CLIENT_AUTH="/g)) console.log('\n--- MN2\n' + at(m.index, 400, 400));
for (const q of ['query getStoreEvents', 'query getEventPage', 'query eventsInProgress', 'query getWpnEventLookup']) {
  const i = js.indexOf(q); if (i >= 0) console.log(`\n##### ${q}\n` + js.slice(i, i + 2500));
}
// Fragmentos que usan esas consultas
for (const f of ['fragment EventFields', 'fragment EventListFields', 'fragment StoreEventFields']) { const i = js.indexOf(f); if (i >= 0) console.log(`\n##### ${f}\n` + js.slice(i, i + 1800)); }
for (const m of js.matchAll(/AdvancedEventFilter|EventFilter\b/g)) { console.log('\n--- filtro\n' + at(m.index, 300, 300)); }
