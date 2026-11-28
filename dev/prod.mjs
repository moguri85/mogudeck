// Comprueba páginas públicas de producción (sin sesión): portada y torneos traídos de fuera
const B = 'https://www.moguri.es/jupiter';
const txt = t => t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const home = await (await fetch(B + '/')).text();
const i = txt(home).indexOf('En directo'); console.log('##### portada\n' + txt(home).slice(Math.max(0, i), i + 1500));
const ids = [...new Set([...home.matchAll(/\/t\/(9\d{8})/g)].map(m => m[1]))];
console.log('ids', ids.join(' '));
for (const id of ids.slice(0, 8)) { const t = await (await fetch(`${B}/t/${id}`)).text(); console.log(`##### /t/${id}\n` + txt(t).slice(0, 900)); }
const api = await fetch(`${B}/api/live`).catch(() => null); if (api) console.log('##### /api/live', api.status, (await api.text()).slice(0, 1500));
