'use strict';
// Copias de seguridad diarias de la base de datos SQLite (consistentes, sin parar la web)
const fs = require('fs');
const path = require('path');
const { db, setting, log } = require('./db');
const config = require('./config');

const dir = path.join(config.dataDir, 'backups');

function list() {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^tienda-.*\.sqlite$/.test(f)).sort().reverse()
    .map(f => ({ name: f, size: fs.statSync(path.join(dir, f)).size, date: fs.statSync(path.join(dir, f)).mtime }));
}

async function run() {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = path.join(dir, `tienda-${stamp}.sqlite`);
  await db.backup(file);
  const keep = Math.max(parseInt(setting('backup_keep'), 10) || 14, 1);
  for (const old of list().slice(keep)) fs.unlinkSync(path.join(dir, old.name));
  log('info', `Copia de seguridad creada: ${path.basename(file)}`);
  return path.basename(file);
}

function start() {
  const due = () => {
    const last = list()[0];
    return !last || Date.now() - new Date(last.date).getTime() > 23 * 3600e3;
  };
  const tick = () => { if (due()) run().catch(e => log('error', 'Copia de seguridad: ' + e.message)); };
  setTimeout(tick, 60e3);
  setInterval(tick, 3600e3);
}

function filePath(name) {
  if (!/^tienda-[0-9-]+\.sqlite$/.test(name)) return null;
  const p = path.join(dir, name);
  return fs.existsSync(p) ? p : null;
}

module.exports = { run, start, list, filePath, dir };
