// Comprueba páginas públicas de producción (sin sesión)
const B = 'https://www.moguri.es/jupiter';
for (const p of ['/t/900000001', '/t/900000002', '/healthz']) {
  const r = await fetch(B + p); const t = await r.text();
  const txt = t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  console.log(`##### ${p} ${r.status}\n` + txt.slice(0, 1500));
}
