'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const auth = require('./auth');
const sync = require('./sync');

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});
// Publicación bajo una subruta (BASE_PATH): nginx quita el prefijo y aquí se añade a enlaces y redirecciones
if (config.basePath) {
  const B = config.basePath;
  const rewrite = s => s.replace(/(\s(?:href|src|action)=")\/(?!\/)/g, `$1${B}/`);
  app.use((req, res, next) => {
    const redirect = res.redirect.bind(res);
    res.redirect = (a, b) => {
      const fix = u => (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') ? B + u : u);
      return b === undefined ? redirect(fix(a)) : redirect(a, fix(b));
    };
    const send = res.send.bind(res);
    res.send = body => {
      if (typeof body === 'string' && /^\s*<!doctype html/i.test(body)) body = rewrite(body);
      return send(body);
    };
    next();
  });
}
app.use('/uploads', express.static(path.join(config.dataDir, 'uploads'), { maxAge: '7d' }));
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', setHeaders: (res, f) => { if (f.endsWith('.avif')) res.setHeader('Content-Type', 'image/avif'); } }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));
app.use(auth.sessionMiddleware);
const accounts = require('./accounts');
app.use(accounts.middleware);
app.use((req, res, next) => require('./reqctx').run({ account: req.account }, next));
app.use(auth.sameOrigin);

app.get('/healthz', (req, res) => res.json({ ok: true, sync: sync.state() }));
app.use('/admin', require('./routes/admin'));
app.use('/', require('./routes/cuenta'));
app.use('/', require('./routes/comunidad').router);
app.use('/', require('./routes/public'));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Error interno');
});

auth.ensureAdmin();
app.listen(config.port, process.env.HOST || '0.0.0.0', () => {
  console.log(`Torneos escuchando en http://localhost:${config.port}`);
  sync.start();
  require('./backup').start();
  require('./pricedb').start();
  require('./decks').start();
  require('./cardimg').start();
  require('./precons').start();
  require('./cardnames').start();
  require('./tgbot').start();
});
