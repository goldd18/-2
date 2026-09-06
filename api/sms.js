const crypto = require('crypto');

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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

function toMsisdn(phone) {
  let n = String(phone || '').replace(/\D/g, '');
  if (n.startsWith('80') && n.length === 11) n = '375' + n.slice(2);
  if (n.startsWith('0') && n.length === 10) n = '375' + n.slice(1);
  if (!n.startsWith('375') && n.length === 9) n = '375' + n;
  return n;
}

function formBody(obj) {
  return new URLSearchParams(obj).toString();
}

function md5(s) {
  return crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
}

function rocketPass(p) {
  const s = String(p || '');
  if (/^[a-f0-9]{32}$/i.test(s)) return s.toLowerCase();
  return md5(s);
}

async function sendRocketSms(login, password, phone, text) {
  const r = await fetch('https://api.rocketsms.by/simple/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: formBody({
      username: login,
      password: rocketPass(password),
      phone,
      text
    })
  });
  return r.json().catch(() => ({}));
}

async function sendSmscByCabinet(user, apikey, phone, text) {
  const r = await fetch('https://cabinet.smsc.by/api/send/sms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: formBody({
      user,
      apikey,
      msisdn: phone,
      text
    })
  });
  return r.json().catch(() => ({}));
}

async function sendSmscByClassic(login, password, phone, text) {
  const r = await fetch('https://smsc.by/sys/send.php', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: formBody({
      login,
      psw: password,
      phones: phone,
      mes: text,
      charset: 'utf-8',
      fmt: '3'
    })
  });
  return r.json().catch(() => ({}));
}

async function sendAssistent(login, password, phone, text) {
  const r = await fetch('https://userarea.sms-assistent.by/api/v1/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      login,
      password,
      command: 'sms_send',
      message: {
        msg: [{ recipient: '+' + phone, sms_text: text }]
      }
    })
  });
  return r.json().catch(() => ({}));
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, { ok: true });
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method' });

  const body = await readBody(req);
  const phone = toMsisdn(body.phone);
  const text = String(body.text || '').trim();
  if (!phone.startsWith('375') || phone.length !== 12 || !text) {
    return json(res, 400, { ok: false, error: 'phone_or_text' });
  }

  const provider = String(body.provider || process.env.SMS_PROVIDER || 'smscby').toLowerCase();
  const apiId = String(body.apiId || process.env.SMSC_APIKEY || process.env.SMSRU_API_ID || process.env.SMS_API_ID || '').trim();
  const login = String(body.login || process.env.SMSC_LOGIN || process.env.ROCKETSMS_USER || process.env.SMSASSISTENT_LOGIN || '').trim();
  const password = String(body.password || process.env.SMSC_PASSWORD || process.env.ROCKETSMS_PASSWORD || process.env.SMSASSISTENT_PASSWORD || '').trim();

  try {
    if (provider === 'rocketsms') {
      if (!login || !password) return json(res, 400, { ok: false, error: 'no_smsc_keys' });
      const data = await sendRocketSms(login, password, phone, text);
      const ok = !!(data && data.id && !data.error);
      return json(res, ok ? 200 : 502, { ok, provider: 'rocketsms', data });
    }

    if (provider === 'smsassistent' || provider === 'assistent') {
      if (!login || !password) return json(res, 400, { ok: false, error: 'no_smsc_keys' });
      const data = await sendAssistent(login, password, phone, text);
      const ok = !!(data && !data.error && (data.message || data.status || data.sms_id || (data.message && data.message.msg)));
      return json(res, ok ? 200 : 502, { ok, provider: 'smsassistent', data });
    }

    if (!login || !(apiId || password)) return json(res, 400, { ok: false, error: 'no_smsc_keys' });
    if (apiId) {
      const data = await sendSmscByCabinet(login, apiId, phone, text);
      const ok = !!(data && (data.status === true || data.message_id) && !data.error);
      return json(res, ok ? 200 : 502, { ok, provider: 'smscby', data });
    }
    const data = await sendSmscByClassic(login, password, phone, text);
    const ok = !!(data && (data.id || data.cnt) && !data.error && !data.error_code);
    return json(res, ok ? 200 : 502, { ok, provider: 'smscby', data });
  } catch (e) {
    return json(res, 500, { ok: false, error: 'send_failed' });
  }
};
