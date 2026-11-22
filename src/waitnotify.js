'use strict';
// Aviso por Telegram a quien sube de la lista de espera a jugador
const { resolve } = require('./identity');
const { absUrl } = require('./views/html');
async function notifyPromoted(req, ev, list) {
  const tg = require('./tgbot');
  if (!tg.enabled() || !list || !list.length) return 0;
  const msgs = new Map();
  for (const p of list) if (p.person_key) msgs.set(resolve(p.person_key), `✅ Ya tienes plaza en «${ev.name}»: has salido de la lista de espera.${ev.price_cents != null ? ' Recuerda pagar la inscripción en la tienda antes de empezar.' : ''}\n${absUrl(req, '/commander/' + ev.id)}`);
  try { return await tg.notifyPeople(msgs); } catch { return 0; }
}
module.exports = { notifyPromoted };
