const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8865598647:AAHXOI4izw-9qnpFO8S6wPkiAOyZh4VtW1k';
const API = 'https://api.telegram.org/bot' + TOKEN;
const SITE = process.env.SITE_URL || (process.env.VERCEL_URL ? ('https://' + process.env.VERCEL_URL) : '');
const fs = require('fs');
const TMP = '/tmp/manikur-tg-chat.json';

function mem() {
  if (!globalThis.__nailBot) globalThis.__nailBot = { chatId: process.env.MASTER_CHAT_ID || '' };
  return globalThis.__nailBot;
}

async function tg(method, payload) {
  const r = await fetch(API + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  return r.json().catch(() => ({}));
}

function digits(v) {
  const s = String(v || '').trim();
  const d = s.replace(/[^\d-]/g, '');
  return d || s;
}

async function remember(chatId) {
  const id = digits(chatId);
  if (!id) return '';
  mem().chatId = id;
  try { fs.writeFileSync(TMP, JSON.stringify({ chatId: id })); } catch (e) {}
  await tg('setMyShortDescription', { short_description: 'CID:' + id });
  return id;
}

async function loadChat() {
  if (mem().chatId) return mem().chatId;
  if (process.env.MASTER_CHAT_ID) return digits(process.env.MASTER_CHAT_ID);
  try {
    const j = JSON.parse(fs.readFileSync(TMP, 'utf8'));
    if (j.chatId) return digits(j.chatId);
  } catch (e) {}
  try {
    const info = await tg('getMyShortDescription', {});
    const desc = (info.result && info.result.short_description) || '';
    const m = String(desc).match(/CID:(-?\d+)/);
    if (m) return m[1];
  } catch (e) {}
  return '';
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

async function handleStart(chatId) {
  await remember(chatId);
  await tg('sendMessage', {
    chat_id: chatId,
    text: 'Бот подключён.\n\nВаш код:\n' + chatId + '\n\nДальше: кабинет мастера → Профиль → вставьте это число → Сохранить код.\nПосле записи клиента сюда придёт уведомление.'
  });
}

async function handleNotify(body) {
  const chatId = (await loadChat()) || digits(body.chatId);
  if (!chatId) return { ok: false, error: 'no-chat' };
  await remember(chatId);
  const text = [
    'Новая запись',
    '',
    (body.service || 'Услуга') + ' — ' + (body.date || '') + ' в ' + (body.time || ''),
    'Клиент: ' + (body.name || ''),
    'Телефон: ' + (body.phone || ''),
    body.note ? ('Комментарий: ' + body.note) : ''
  ].filter(Boolean).join('\n');
  const sent = await tg('sendMessage', { chat_id: chatId, text });
  return { ok: !!(sent && sent.ok), sent, chatId };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  if (req.method === 'GET') {
    const chatId = await loadChat();
    const me = await tg('getMe', {});
    return json(res, 200, {
      ok: true,
      username: me.result && me.result.username,
      bound: !!chatId
    });
  }

  const body = await readBody(req);

  if (body.message && body.message.chat) {
    const text = String(body.message.text || '');
    if (text.startsWith('/start') || text.startsWith('/code')) await handleStart(body.message.chat.id);
    return json(res, 200, { ok: true });
  }

  if (body.action === 'bind') {
    const chatId = await remember(body.code);
    if (!chatId) return json(res, 400, { ok: false, error: 'Нет кода' });
    if (SITE) await tg('setWebhook', { url: SITE.replace(/\/$/, '') + '/api/telegram' });
    const sent = await tg('sendMessage', { chat_id: chatId, text: 'Готово. Теперь при новой записи сюда придёт уведомление.' });
    return json(res, 200, { ok: !!(sent && sent.ok) });
  }

  if (body.action === 'notify' || body.action === 'test') {
    const result = await handleNotify(body.action === 'test' ? { service: 'Проверка бота', date: '', time: '', name: 'Мастер', phone: '' } : body);
    return json(res, result.ok ? 200 : 400, result);
  }

  return json(res, 200, { ok: true });
};
