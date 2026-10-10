/**
 * Vending machine verify mock server.
 *
 * - Every request the machine makes (any method, any path except the admin
 *   routes) is logged and answered with a configurable "success" or "fail"
 *   response. It never returns 404 to the machine.
 * - The response can be changed live from the /admin page (phone friendly).
 *
 * Only dependency: express. No database: logs live in memory (last 500) and
 * are appended to logs.ndjson; the response config is saved to config.json.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'config.json');
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'logs.ndjson');
const MAX_LOGS = 500;
const BODY_LIMIT = 2 * 1024 * 1024; // 2 MB

// Admin token: from env, or a random one printed once at startup.
const TOKEN_FROM_ENV = Boolean(process.env.ADMIN_TOKEN);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(12).toString('hex');

// Keys used to guess interesting values in the request (case-insensitive,
// searched in nested objects). The first key in each list wins.
const SCANNED_KEYS = ['code', 'qrcode', 'qr_code', 'pickCode', 'pickupCode', 'verifyCode',
  'orderNo', 'orderId', 'barcode', 'data', 'content', 'text', 'result'];
const SLOT_KEYS = ['slotNo', 'slot', 'slot_no', 'aisle', 'channel', 'goodsId', 'productCode'];
const MACHINE_KEYS = ['deviceId', 'machineId', 'deviceNo', 'imei', 'sn', 'mac'];

// ---------------------------------------------------------------------------
// Response config (persisted to config.json)
// ---------------------------------------------------------------------------
const DEFAULT_SUCCESS_BODY = JSON.stringify({
  code: 0, status: 1, success: true, result: 'success', ret: 0, errcode: 0, errno: 0, error: 0,
  msg: 'success', message: 'success', errmsg: 'ok',
  data: { code: '{{scanned}}', slotNo: '{{slot}}', num: 1, orderNo: '{{scanned}}' },
});
const DEFAULT_FAIL_BODY = JSON.stringify({
  code: 1, status: 0, success: false, result: 'fail', ret: 1, errcode: 1, errno: 1, error: 1,
  msg: 'fail', message: 'fail', errmsg: 'fail',
  data: { code: '{{scanned}}', slotNo: '{{slot}}', num: 0, orderNo: '{{scanned}}' },
});

function defaultConfig() {
  return {
    mode: 'success',
    delayMs: 0,
    failCodes: [],
    success: { status: 200, contentType: 'application/json', headers: {}, body: DEFAULT_SUCCESS_BODY },
    fail: { status: 200, contentType: 'application/json', headers: {}, body: DEFAULT_FAIL_BODY },
  };
}

/** Clean up a response block coming from the admin page or config file. */
function normalizeResponse(input, fallback) {
  const r = input && typeof input === 'object' ? input : {};
  const status = parseInt(r.status, 10);
  let headers = r.headers;
  if (typeof headers === 'string') {
    try { headers = headers.trim() ? JSON.parse(headers) : {}; } catch { headers = fallback.headers; }
  }
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) headers = {};
  return {
    status: status >= 100 && status <= 599 ? status : fallback.status,
    contentType: typeof r.contentType === 'string' ? r.contentType.trim() : fallback.contentType,
    headers,
    body: typeof r.body === 'string' ? r.body : fallback.body,
  };
}

/** Merge a (partial) config object on top of `base`, validating every field. */
function normalizeConfig(input, base) {
  const c = input && typeof input === 'object' ? input : {};
  let failCodes = c.failCodes !== undefined ? c.failCodes : base.failCodes;
  if (typeof failCodes === 'string') failCodes = failCodes.split(/[\s,;]+/);
  if (!Array.isArray(failCodes)) failCodes = [];
  const delay = parseInt(c.delayMs, 10);
  return {
    mode: c.mode === 'fail' || c.mode === 'success' ? c.mode : base.mode,
    delayMs: delay >= 0 ? Math.min(delay, 60000) : base.delayMs,
    failCodes: failCodes.map(String).map((s) => s.trim()).filter(Boolean),
    success: normalizeResponse(c.success || base.success, base.success),
    fail: normalizeResponse(c.fail || base.fail, base.fail),
  };
}

function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')), defaultConfig());
  } catch {
    return defaultConfig(); // missing or broken file: start from defaults
  }
}

function saveConfig() {
  fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), () => {}); // best effort
}

let config = loadConfig();

// ---------------------------------------------------------------------------
// Logs (memory + logs.ndjson)
// ---------------------------------------------------------------------------
let logs = [];
let nextId = 1;

// Reload the tail of logs.ndjson so a restart does not wipe the list.
try {
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-MAX_LOGS);
  for (const line of lines) {
    try { logs.push(JSON.parse(line)); } catch { /* skip broken line */ }
  }
  nextId = logs.reduce((max, l) => Math.max(max, Number(l.id) || 0), 0) + 1;
} catch { /* no log file yet */ }

function addLog(entry) {
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
  fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', () => {}); // ignore write errors
  console.log('[machine]', JSON.stringify(entry));
}

// ---------------------------------------------------------------------------
// Helpers: body parsing, value detection, templates
// ---------------------------------------------------------------------------

/**
 * Read the raw body as text for ANY content-type (we do it by hand so a weird
 * content-type, charset or encoding can never make Express reject the call).
 * Bytes past the 2 MB limit are dropped instead of failing the request.
 */
function readRawBody(req, res, next) {
  const chunks = [];
  let size = 0;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    req.rawBody = Buffer.concat(chunks).toString('utf8');
    next();
  };
  req.on('data', (chunk) => {
    if (size + chunk.length <= BODY_LIMIT) chunks.push(chunk);
    size += chunk.length;
  });
  req.on('end', finish);
  req.on('error', finish);
}

/** Try JSON, then urlencoded, else keep the raw text. Never throws. */
function parseBody(raw) {
  const text = (raw || '').trim();
  if (!text) return { type: 'empty', value: null };
  try {
    return { type: 'json', value: JSON.parse(text) };
  } catch { /* not JSON */ }
  // Looks like a=1&b=2 (no spaces/newlines, every part has a key)?
  if (/^[^\s=&]+=[^\s]*$/.test(text)) {
    try {
      const obj = {};
      for (const [k, v] of new URLSearchParams(text)) {
        if (k in obj) obj[k] = [].concat(obj[k], v); // repeated key -> array
        else obj[k] = v;
      }
      return { type: 'urlencoded', value: obj };
    } catch { /* fall through */ }
  }
  return { type: 'text', value: raw };
}

/** Find the value of `key` (case-insensitive) anywhere inside obj (breadth first). */
function deepFind(obj, key) {
  const want = key.toLowerCase();
  const queue = [obj];
  const seen = new Set();
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    for (const [k, v] of Object.entries(cur)) {
      const isValue = v !== null && v !== undefined && typeof v !== 'object' && String(v).trim() !== '';
      if (k.toLowerCase() === want && isValue) return String(v);
    }
    for (const v of Object.values(cur)) if (v && typeof v === 'object') queue.push(v);
  }
  return '';
}

/** First non-empty value among `keys`, searching each source in order. */
function detect(sources, keys) {
  for (const key of keys) {
    for (const src of sources) {
      const v = deepFind(src, key);
      if (v) return v;
    }
  }
  return '';
}

/** Read a dot path like "a.b.0.c" from an object. */
function getPath(obj, dotPath) {
  let cur = obj;
  for (const part of dotPath.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Replace {{placeholders}} in a response body. Missing values become "".
 * When the response is JSON, values are JSON-escaped so quotes etc. are safe.
 */
function renderTemplate(template, ctx, isJson) {
  return template.replace(/\{\{\s*([\w.\-]+)\s*\}\}/g, (_, name) => {
    let v;
    if (name.startsWith('query.')) v = getPath(ctx.query, name.slice(6));
    else if (name.startsWith('body.')) v = getPath(ctx.body, name.slice(5));
    else v = ctx.vars[name];
    if (v === null || v === undefined) v = '';
    if (typeof v === 'object') v = JSON.stringify(v);
    v = String(v);
    return isJson ? JSON.stringify(v).slice(1, -1) : v;
  });
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.ip || req.socket.remoteAddress || '';
}

// ---------------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------------
function requireToken(req, res, next) {
  const given = String(req.get('x-admin-token') || req.query.token || '');
  const a = Buffer.from(given);
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'unauthorized: missing or wrong admin token' });
}

/** Admin API bodies are JSON; tolerate empty or broken JSON. */
function adminJson(req) {
  try { return req.rawBody ? JSON.parse(req.rawBody) : {}; } catch { return null; }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(readRawBody);

// --- Simple public routes ---
app.get('/', (req, res) => {
  res.type('text/plain').send(
    'Vending verify mock server is running.\n' +
    'Open /admin?token=YOUR_ADMIN_TOKEN to see requests and change the response.\n'
  );
});
app.get('/health', (req, res) => res.type('text/plain').send('ok'));

// --- Admin page (static HTML; the API calls it makes need the token) ---
app.get(['/admin', '/admin/'], (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// --- Admin API ---
const api = express.Router();
api.use(requireToken);

// Logs newer than ?since=ID, newest first. Also returns the current mode so
// the page stays in sync if the mode is changed from another phone.
api.get('/logs', (req, res) => {
  const since = Number(req.query.since) || 0;
  const items = logs.filter((l) => l.id > since).reverse();
  res.json({ logs: items, lastId: nextId - 1, mode: config.mode });
});

api.delete('/logs', (req, res) => {
  logs = [];
  fs.writeFile(LOG_FILE, '', () => {});
  res.json({ ok: true });
});

api.get('/config', (req, res) => res.json(config));

api.put('/config', (req, res) => {
  const body = adminJson(req);
  if (!body) return res.status(400).json({ error: 'body must be JSON' });
  config = normalizeConfig(body, config);
  saveConfig();
  res.json(config);
});

api.post('/mode', (req, res) => {
  const body = adminJson(req) || {};
  if (body.mode !== 'success' && body.mode !== 'fail') {
    return res.status(400).json({ error: 'mode must be "success" or "fail"' });
  }
  config.mode = body.mode;
  saveConfig();
  res.json({ mode: config.mode });
});

// Simulate a machine call against this same server and return what it got.
api.post('/test', async (req, res) => {
  const t = adminJson(req) || {};
  const method = String(t.method || 'POST').toUpperCase();
  let reqPath = String(t.path || '/WXdevelop/VerifyCode');
  if (!reqPath.startsWith('/')) reqPath = '/' + reqPath;
  const port = req.socket.localPort;
  const hasBody = !['GET', 'HEAD'].includes(method) && t.body;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${reqPath}`, {
      method,
      headers: { 'content-type': t.contentType || 'application/json', 'user-agent': 'admin-test' },
      body: hasBody ? String(t.body) : undefined,
    });
    res.json({
      status: r.status,
      headers: Object.fromEntries(r.headers.entries()),
      body: await r.text(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.use((req, res) => res.status(404).json({ error: 'unknown admin API route' }));
app.use('/api', api);

// --- Machine-facing catch-all: every other method + path ---
app.use(async (req, res) => {
  const parsed = parseBody(req.rawBody);
  const bodyObj = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};
  const query = req.query || {};

  // Best-effort detection of the scanned code, slot and machine id.
  let scanned = detect([bodyObj, query], SCANNED_KEYS);
  if (!scanned && parsed.type === 'text' && parsed.value.length <= 200) {
    scanned = parsed.value.trim(); // plain-text body: the body IS probably the code
  }
  const slot = detect([bodyObj, query], SLOT_KEYS);
  const machine = detect([bodyObj, query, req.headers], MACHINE_KEYS);

  // Pick success or fail.
  const isFailCode = scanned &&
    config.failCodes.some((c) => c.toLowerCase() === scanned.trim().toLowerCase());
  const mode = isFailCode ? 'fail' : config.mode;
  const tpl = config[mode];

  const now = new Date();
  const ctx = {
    query,
    body: bodyObj,
    vars: {
      scanned, slot, machine,
      timestamp: Math.floor(now.getTime() / 1000),
      timestampMs: now.getTime(),
      iso: now.toISOString(),
      method: req.method,
      path: req.path,
    },
  };
  const isJson = /json/i.test(tpl.contentType);
  const body = renderTemplate(tpl.body, ctx, isJson);

  const entry = {
    id: nextId++,
    time: now.toISOString(),
    method: req.method,
    url: `${req.protocol}://${req.get('host') || ''}${req.originalUrl}`,
    path: req.path,
    query,
    headers: req.headers,
    rawBody: req.rawBody,
    bodyType: parsed.type,
    parsedBody: parsed.value,
    ip: clientIp(req),
    detected: { scanned, slot, machine },
    response: {
      mode,
      reason: isFailCode ? 'failCode' : 'config',
      status: tpl.status,
      contentType: tpl.contentType,
      headers: tpl.headers,
      delayMs: config.delayMs,
      body,
    },
  };
  addLog(entry);

  if (config.delayMs > 0) await new Promise((r) => setTimeout(r, config.delayMs));

  // Extra headers first; a bad header name/value is skipped, never fatal.
  for (const [k, v] of Object.entries(tpl.headers || {})) {
    try { res.set(k, String(v)); } catch { /* skip invalid header */ }
  }
  if (tpl.contentType) {
    try { res.set('Content-Type', tpl.contentType); } catch { /* ignore */ }
  }
  res.status(tpl.status).send(Buffer.from(body, 'utf8'));
});

// Last-resort error handler: still answer the machine with something sane.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err && err.message);
  if (!res.headersSent) res.status(200).type('application/json').send(DEFAULT_SUCCESS_BODY);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
function start(port = PORT) {
  return new Promise((resolve) => {
    const server = app.listen(port, '0.0.0.0', () => {
      const p = server.address().port;
      console.log(`Vending verify mock listening on http://0.0.0.0:${p}`);
      if (TOKEN_FROM_ENV) {
        console.log('Admin token: taken from ADMIN_TOKEN env var.');
      } else {
        console.log(`Admin token (random, set ADMIN_TOKEN to fix it): ${ADMIN_TOKEN}`);
        console.log(`Admin page: http://localhost:${p}/admin?token=${ADMIN_TOKEN}`);
      }
      resolve(server);
    });
  });
}

if (require.main === module) start();

module.exports = { app, start, ADMIN_TOKEN };
