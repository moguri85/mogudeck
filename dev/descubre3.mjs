// EventLink: consultas que usa su web y cómo inicia sesión (sin contraseñas)
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const get = async u => (await fetch(u, { headers: { 'User-Agent': UA } })).text();
const home = await get('https://eventlink.wizards.com/');
const scripts = [...home.matchAll(/src="([^"]+\.js)"/g)].map(m => new URL(m[1], 'https://eventlink.wizards.com/').href);
const cfg = [...home.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
console.log('##### HTML inline scripts\n' + cfg.slice(0, 3000));
for (const s of scripts) {
  const js = await get(s);
  console.log(`\n##### ${s} (${js.length})`);
  const names = new Set([...js.matchAll(/\b(query|mutation|subscription)\s+([A-Za-z0-9_]+)\s*[({]/g)].map(m => `${m[1]} ${m[2]}`));
  console.log([...names].sort().join('\n'));
  for (const k of ['AUTH0_TENANT_DOMAIN', 'AUTH0_CLIENT_ID', 'PLATFORM_URL', 'ACCOUNTS_URL', 'oauth/token', 'grant_type', 'refresh_token', 'clientAuth', 'offline_access', 'audience'])
    for (const m of js.matchAll(new RegExp(`.{0,160}${k.replace('/', '\\/')}.{0,200}`, 'g'))) console.log(`[${k}]`, m[0].replace(/\s+/g, ' '));
  // Texto de consultas de eventos de una tienda
  for (const q of ['query getEventsByOrganization', 'query eventsByOrganization', 'query myEvents', 'query getOrganizationEvents', 'query searchEvents', 'query getEventsForOrganization']) {
    const i = js.indexOf(q); if (i >= 0) console.log(`\n##### ${q}\n` + js.slice(i, i + 1500).replace(/\\n/g, '\n'));
  }
  for (const m of js.matchAll(/query\s+(\w*[Ee]vents?\w*)\s*\(([^)]{0,300})\)\s*\{\s*(\w+)\s*\(/g)) console.log('[EVQ]', m[1], '(', m[2].replace(/\s+/g, ' '), ') ->', m[3]);
}
