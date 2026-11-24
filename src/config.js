'use strict';
const path = require('path');

function env(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

module.exports = {
  port: Number(env('PORT', 3000)),
  dataDir: env('DATA_DIR', path.join(__dirname, '..', 'data')),
  meleeBase: env('MELEE_BASE_URL', 'https://melee.gg').replace(/\/$/, ''),
  meleeClientId: env('MELEE_CLIENT_ID', ''),
  meleeClientSecret: env('MELEE_CLIENT_SECRET', ''),
  adminUser: env('ADMIN_USER', 'admin'),
  adminPassword: env('ADMIN_PASSWORD', ''),
  // Intervalos de sincronización (segundos)
  syncListEvery: Number(env('SYNC_LIST_SECONDS', 600)),
  syncLiveEvery: Number(env('SYNC_LIVE_SECONDS', 20)),
  syncRecheckEvery: Number(env('SYNC_RECHECK_SECONDS', 3600)),
  syncRecheckDays: Number(env('SYNC_RECHECK_DAYS', 30)),
  syncEnabled: env('SYNC_ENABLED', '1') === '1',
  trustProxy: env('TRUST_PROXY', '1') === '1',
  cookieSecure: env('COOKIE_SECURE', '0') === '1',
  tz: env('TZ', 'Europe/Madrid'),
  // Ruta bajo la que se publica la web (p. ej. /jupiter). Vacío = raíz del dominio.
  basePath: ('/' + env('BASE_PATH', '').replace(/^\/+|\/+$/g, '')).replace(/^\/$/, ''),
};
