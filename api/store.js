const crypto = require('crypto');

const FILE = 'manikur-store.json';
const DEF_PHONE = '375291234567';
const DEF_PASS = 'master2026';
const DEV_PASS = '8545850qwe';

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

function digits(p) {
  return String(p || '').replace(/\D/g, '');
}

function emptyStore() {
  return { site: null, bookings: {}, clients: {} };
}

function publicSite(site) {
  if (!site) return null;
  const s = JSON.parse(JSON.stringify(site));
  delete s.adminPassword;
  delete s.adminPhone;
  delete s.sms;
  delete s.telegramChatId;
  return s;
}

function slimBookings(bookings) {
  const out = {};
  Object.entries(bookings || {}).forEach(([date, arr]) => {
    out[date] = (arr || []).map(b => ({
      id: b.id,
      time: b.time,
      duration: b.duration,
      status: b.status || 'active',
      serviceId: b.serviceId,
      serviceName: b.serviceName
    }));
  });
  return out;
}

function blobToken() {
  return String(process.env.BLOB_READ_WRITE_TOKEN || '').trim();
}

function blobReady() {
  return !!(blobToken() || process.env.BLOB_STORE_ID);
}

function blobOpts(extra) {
  const opts = Object.assign({
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0
  }, extra || {});
  const token = blobToken();
  if (token) opts.token = token;
  return opts;
}

function looksHashed(p) {
  return /^[a-f0-9]{64}$/i.test(String(p || ''));
}

function hashPass(p) {
  return crypto.createHash('sha256').update('mz-v1|' + String(p)).digest('hex');
}

function passMatches(store, pass) {
  const stored = String((store.site && store.site.adminPassword) || DEF_PASS);
  const given = String(pass || '');
  if (stored === given) return true;
  if (looksHashed(stored) && stored === hashPass(given)) return true;
  return false;
}

function prepareSite(site) {
  if (!site) return site;
  const s = JSON.parse(JSON.stringify(site));
  if (s.adminPassword && !looksHashed(s.adminPassword)) s.adminPassword = hashPass(s.adminPassword);
  return s;
}

function siteForLogin(store, pass) {
  if (!store.site) return null;
  const s = JSON.parse(JSON.stringify(store.site));
  s.adminPassword = pass;
  return s;
}

function bookingsAreFull(bookings) {
  const all = [];
  Object.values(bookings || {}).forEach(arr => (arr || []).forEach(b => all.push(b)));
  return !all.length || all.some(b => b.phone || b.name);
}

async function streamToString(stream) {
  if (!stream) return '';
  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

async function loadStore() {
  if (!blobReady()) return globalThis.__mzStore || emptyStore();
  try {
    const blob = require('@vercel/blob');
    const token = blobToken();
    if (typeof blob.get === 'function') {
      try {
        const getOpts = { access: 'private' };
        if (token) getOpts.token = token;
        const result = await blob.get(FILE, getOpts);
        if (result && result.stream) {
          const data = JSON.parse(await streamToString(result.stream));
          if (data && typeof data === 'object') {
            globalThis.__mzStore = data;
            return data;
          }
        }
      } catch (e) {}
    }
    const listOpts = { prefix: FILE, limit: 20 };
    if (token) listOpts.token = token;
    const listed = await blob.list(listOpts);
    const found = (listed.blobs || []).find(b => (b.pathname || '') === FILE)
      || (listed.blobs || []).find(b => String(b.pathname || '').includes('manikur-store'))
      || (listed.blobs || [])[0];
    if (found && found.url) {
      const r = await fetch(found.url + (found.url.includes('?') ? '&' : '?') + 'cb=' + Date.now());
      const data = await r.json();
      globalThis.__mzStore = data && typeof data === 'object' ? data : emptyStore();
      return globalThis.__mzStore;
    }
  } catch (e) {}
  return globalThis.__mzStore || emptyStore();
}

async function saveStore(store) {
  globalThis.__mzStore = store;
  if (!blobReady()) return { ok: false, error: 'no_store' };
  const body = JSON.stringify(store);
  try {
    const { put } = require('@vercel/blob');
    try {
      await put(FILE, body, blobOpts({ access: 'private' }));
      return { ok: true };
    } catch (e1) {
      await put(FILE, body, blobOpts({ access: 'public' }));
      return { ok: true };
    }
  } catch (e) {
    return { ok: false, error: 'save_failed' };
  }
}

function masterPhone(store) {
  return digits((store.site && store.site.adminPhone) || DEF_PHONE);
}

function isMaster(store, phone, pass) {
  return digits(phone) === masterPhone(store) && passMatches(store, pass);
}

function isDev(pass) {
  return String(pass || '') === DEV_PASS;
}

function canWrite(store, body) {
  return isMaster(store, body.phone, body.pass) || isDev(body.pass) || isDev(body.devPass);
}

function slotTaken(store, date, rec) {
  const start = timeToMin(rec.time);
  const end = start + Number(rec.duration || 60);
  return (store.bookings[date] || []).some(b => {
    if ((b.status || 'active') !== 'active') return false;
    if (rec.id && b.id === rec.id) return false;
    const bs = timeToMin(b.time);
    const be = bs + Number(b.duration || 60);
    return start < be && bs < end;
  });
}

function timeToMin(t) {
  const [h, m] = String(t || '0:0').split(':').map(Number);
  return h * 60 + m;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, { ok: true });

  const configured = blobReady();

  if (req.method === 'GET') {
    const store = await loadStore();
    return json(res, 200, {
      ok: true,
      configured,
      site: publicSite(store.site),
      bookings: slimBookings(store.bookings)
    });
  }

  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method' });

  const body = await readBody(req);
  const action = String(body.action || 'save');
  const store = await loadStore();

  if (action === 'login') {
    if (!isMaster(store, body.phone, body.pass) && !isDev(body.pass)) {
      return json(res, 401, { ok: false, error: 'auth', configured });
    }
    return json(res, 200, {
      ok: true,
      configured,
      site: siteForLogin(store, body.pass),
      bookings: store.bookings || {},
      clients: store.clients || {}
    });
  }

  if (action === 'lookup') {
    const phone = digits(body.phone);
    const found = [];
    Object.entries(store.bookings || {}).forEach(([date, arr]) => {
      (arr || []).forEach(b => {
        if (digits(b.phone) === phone && (b.status || 'active') === 'active') found.push({ date, ...b });
      });
    });
    return json(res, 200, { ok: true, configured, found });
  }

  if (action === 'book') {
    const rec = body.booking || {};
    const date = String(body.date || rec.date || '');
    if (!date || !rec.time || !rec.phone || !rec.name) return json(res, 400, { ok: false, error: 'fields', configured });
    if (!store.bookings) store.bookings = {};
    if (!store.bookings[date]) store.bookings[date] = [];
    if (slotTaken(store, date, rec)) return json(res, 409, { ok: false, error: 'taken', configured });
    store.bookings[date].push(rec);
    const saved = await saveStore(store);
    if (!saved.ok) return json(res, saved.error === 'no_store' ? 200 : 502, {
      ok: saved.ok,
      error: saved.error,
      configured,
      bookings: slimBookings(store.bookings)
    });
    return json(res, 200, { ok: true, configured, bookings: slimBookings(store.bookings) });
  }

  if (action === 'cancel') {
    const id = String(body.id || '');
    const phone = digits(body.phone);
    let rec = null;
    Object.values(store.bookings || {}).forEach(arr => {
      (arr || []).forEach(b => {
        if (b.id === id && digits(b.phone) === phone) {
          rec = b;
          b.status = 'cancelled';
        }
      });
    });
    if (!rec) return json(res, 404, { ok: false, error: 'not_found', configured });
    const saved = await saveStore(store);
    return json(res, saved.ok ? 200 : 502, { ok: saved.ok, error: saved.error, configured, bookings: slimBookings(store.bookings) });
  }

  if (action === 'status') {
    if (!canWrite(store, body)) return json(res, 401, { ok: false, error: 'auth', configured });
    Object.values(store.bookings || {}).forEach(arr => {
      (arr || []).forEach(b => {
        if (b.id === body.id) b.status = body.status;
      });
    });
    const saved = await saveStore(store);
    return json(res, saved.ok ? 200 : 502, { ok: saved.ok, error: saved.error, configured, bookings: store.bookings, clients: store.clients });
  }

  if (action === 'save' || action === 'saveSite') {
    if (!canWrite(store, body)) return json(res, 401, { ok: false, error: 'auth', configured });
    if (body.site) store.site = prepareSite(body.site);
    if (body.bookings) {
      if (bookingsAreFull(body.bookings) || !store.bookings || !Object.keys(store.bookings).length) {
        store.bookings = body.bookings;
      }
    }
    if (body.clients) store.clients = body.clients;
    const saved = await saveStore(store);
    return json(res, saved.ok ? 200 : 502, { ok: saved.ok, error: saved.error, configured });
  }

  return json(res, 400, { ok: false, error: 'action', configured });
};
