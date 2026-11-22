'use strict';
// Telegram falso para desarrollo: getMe, getUpdates (con mensajes inyectados en /inject) y sendMessage (se guardan en /sent)
const http = require('http');
const queue = [], sent = [];
let id = 1;
http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    const send = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/inject') { const j = JSON.parse(body); queue.push({ update_id: id++, message: { chat: { id: j.chat, type: 'private' }, text: j.text } }); return send({ ok: true }); }
    if (url.pathname === '/sent') return send(sent);
    const m = url.pathname.match(/\/bot[^/]+\/(\w+)$/);
    if (!m) return send({ ok: false, description: 'no' });
    const j = body ? JSON.parse(body) : {};
    if (m[1] === 'getMe') return send({ ok: true, result: { username: 'JupiterTorneosBot' } });
    if (m[1] === 'sendMessage') { sent.push(j); return send({ ok: true, result: {} }); }
    if (m[1] === 'getUpdates') {
      const out = queue.filter(u => u.update_id >= (j.offset || 0));
      if (out.length) return send({ ok: true, result: out });
      return setTimeout(() => send({ ok: true, result: queue.filter(u => u.update_id >= (j.offset || 0)) }), 1000);
    }
    send({ ok: false, description: 'método no soportado' });
  });
}).listen(4050, () => console.log('Mock Telegram en http://localhost:4050'));
