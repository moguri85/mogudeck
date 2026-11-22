'use strict';
const { setting, log } = require('./db');

function chunk(text, max) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + '\n' + line).length > max) { if (cur) out.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

async function discord(text) {
  const url = setting('discord_webhook');
  if (!url) return;
  for (const part of chunk(text, 1900)) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: part, allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) throw new Error(`Discord respondió ${res.status}`);
  }
}

async function telegram(text) {
  const token = setting('telegram_token');
  const chat = setting('telegram_chat');
  if (!token || !chat) return;
  for (const part of chunk(text.replace(/\*\*/g, ''), 4000)) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: part, disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`Telegram respondió ${res.status}`);
  }
}

async function send(text) {
  const errors = [];
  for (const [name, fn] of [['Discord', discord], ['Telegram', telegram]]) {
    try { await fn(text); } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  if (errors.length) log('error', 'Notificación fallida: ' + errors.join(' | '));
  return errors;
}

function enabled() {
  return Boolean(setting('discord_webhook') || (setting('telegram_token') && setting('telegram_chat')));
}

module.exports = { send, enabled };
