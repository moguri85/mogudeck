// EventLink: cómo canjea y renueva la sesión su web
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const get = async u => (await fetch(u, { headers: { 'User-Agent': UA } })).text();
const home = await get('https://eventlink.wizards.com/');
const s = [...home.matchAll(/src="([^"]+\.js)"/g)].map(m => new URL(m[1], 'https://eventlink.wizards.com/').href).find(u => /index-/.test(u));
const js = await get(s);
const show = (re, n = 700, max = 8) => { let k = 0; for (const m of js.matchAll(re)) { console.log(`\n--- ${re} @${m.index}\n` + js.slice(Math.max(0, m.index - n), m.index + n)); if (++k >= max) break; } };
show(/REFRESH_TOKEN/g, 600, 6);
show(/PLATFORM_URL/g, 500, 6);
show(/\/auth\/oauth\/token|\/oauth\/token|\/auth\/token|token\/refresh|refreshToken/g, 600, 8);
show(/auth\/authorize/g, 800, 3);
show(/CLIENT_AUTH/g, 300, 4);
