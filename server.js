/**
 * Vending machine verify mock server.
 *
 * - Every request the machine makes (any method, any path except the admin
 *   routes) is logged and answered with a configurable "success" or "fail"
 *   response. It never returns 404 to the machine.
 * - The response can be changed live from the /admin page (phone friendly).
 * - Diagnostics: every raw TCP connection and every broken/non-HTTP request
 *   (e.g. a TLS handshake sent to this plain-HTTP port) is recorded too.
 * - A customer test page + in-memory orders let you simulate "paid" flows.
 *
 * Only dependency: express. No database: logs live in memory (last 500) and
 * are appended to logs.ndjson; the response config is saved to config.json.
 * The server is plain HTTP and never redirects to HTTPS.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'config.json');
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'logs.ndjson');
const MAX_LOGS = 500;
const MAX_DIAG = 200; // connections / client errors kept in memory
const MAX_ORDERS = 200;
const BODY_LIMIT = 2 * 1024 * 1024; // 2 MB

// Admin token: from env, or a random one printed once at startup.
const TOKEN_FROM_ENV = Boolean(process.env.ADMIN_TOKEN);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(12).toString('hex');

// Keys used to guess interesting values in the request (case-insensitive,
// searched in nested objects). The first key in each list wins.
// The machine's QR URL looks like ?mid=<machine>&sid=<slot>&pid=<product>&pri=<price>.
const SCANNED_KEYS = ['code', 'qrcode', 'qr_code', 'pickCode', 'pickupCode', 'verifyCode',
  'orderNo', 'orderId', 'barcode', 'data', 'content', 'text', 'result'];
const SLOT_KEYS = ['sid', 'slotNo', 'slot', 'slot_no', 'aisle', 'channel', 'goodsId', 'productCode'];
const MACHINE_KEYS = ['mid', 'machineId', 'deviceId', 'deviceNo', 'imei', 'sn', 'mac'];
const PRODUCT_KEYS = ['pid', 'productId', 'goodsId', 'productCode'];
const AMOUNT_KEYS = ['pri', 'price', 'amount', 'money', 'totalFee', 'total_fee'];

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
    useOrderState: false, // when ON, machine replies follow the order's PAID/PENDING state
    protocol: true, // answer FunCode 1000/4000/5000 requests per the vendor protocol
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
    useOrderState: typeof c.useOrderState === 'boolean' ? c.useOrderState : Boolean(base.useOrderState),
    protocol: typeof c.protocol === 'boolean' ? c.protocol : base.protocol !== false,
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
// Request classification
// ---------------------------------------------------------------------------
const NOISE_PATHS = /^\/(favicon\.ico|robots\.txt|apple-touch-icon[\w.-]*\.png)$/i;

/**
 * Guess who sent a request:
 *  - "noise":    favicon / robots / apple-touch-icon
 *  - "test":     the admin page's "Send test" button
 *  - "bot":      crawlers and link previewers
 *  - "browser":  a real phone/desktop browser (not an in-app WebView)
 *  - "machine?": everything else (okhttp, Dalvik, Java, curl, WebView, odd or missing UA...)
 */
function classify(reqPath, headers) {
  const h = headers || {};
  const ua = String(h['user-agent'] || '');
  if (NOISE_PATHS.test(reqPath || '')) return 'noise';
  if (h['x-mock-test']) return 'test';
  if (/bot|crawler|claude-user|googlebot/i.test(ua)) return 'bot';
  const looksBrowser = /Mozilla\//.test(ua) && /(Chrome|Safari|Firefox)\//.test(ua);
  if (looksBrowser && h['accept-language'] && !/;\s*wv\)/.test(ua)) return 'browser';
  return 'machine?';
}

// ---------------------------------------------------------------------------
// Logs (memory + logs.ndjson)
// ---------------------------------------------------------------------------
let logs = [];
let nextId = 1;

// Reload the tail of logs.ndjson so a restart does not wipe the list.
try {
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-MAX_LOGS);
  for (const line of lines) {
    try {
      const l = JSON.parse(line);
      if (!l.source) l.source = classify(l.path, l.headers); // entries from older versions
      logs.push(l);
    } catch { /* skip broken line */ }
  }
  nextId = logs.reduce((max, l) => Math.max(max, Number(l.id) || 0), 0) + 1;
} catch { /* no log file yet */ }

function addLog(entry) {
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
  fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', () => {}); // ignore write errors
  if (entry.idlePoll) {
    // FunCode 4000 polls arrive every ~3 s: keep the console readable.
    console.log(`[poll] #${entry.id} ${entry.time} machine=${entry.detected.machine || '-'} nothing to dispense`);
  } else {
    console.log('[request]', JSON.stringify(entry));
  }
}

// ---------------------------------------------------------------------------
// Diagnostics: raw TCP connections and client (parse) errors
// ---------------------------------------------------------------------------
let connections = [];
let clientErrors = [];
let nextConnId = 1;

function pushCapped(list, item) {
  list.push(item);
  return list.length > MAX_DIAG ? list.slice(-MAX_DIAG) : list;
}

/** Called for every TCP connection, even ones that never send valid HTTP. */
function onConnection(socket) {
  const c = {
    id: nextConnId++,
    time: new Date().toISOString(),
    remote: `${socket.remoteAddress}:${socket.remotePort}`,
    localPort: socket.localPort,
  };
  connections = pushCapped(connections, c);
  console.log(`[conn] #${c.id} ${c.remote} -> port ${c.localPort}`);
}

/**
 * Called when a client sends something Node cannot parse as HTTP. The most
 * useful case: bytes 0x16 0x03 = a TLS handshake, i.e. the machine is using
 * https:// for an address that points at this plain-HTTP port.
 */
function onClientError(err, socket) {
  try {
    const raw = err && err.rawPacket ? Buffer.from(err.rawPacket).subarray(0, 64) : Buffer.alloc(0);
    const isTls = raw.length >= 2 && raw[0] === 0x16 && raw[1] === 0x03;
    const e = {
      time: new Date().toISOString(),
      remote: `${socket.remoteAddress}:${socket.remotePort}`,
      code: (err && err.code) || 'UNKNOWN',
      message: (err && err.message) || '',
      hex: raw.toString('hex'),
      label: isTls ? 'TLS handshake sent to plain-HTTP port (machine is using https:// for this address)' : '',
    };
    clientErrors = pushCapped(clientErrors, e);
    console.log(`[client-error] ${e.remote} ${e.code} ${e.label || ''} hex=${e.hex}`);
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    } else {
      socket.destroy();
    }
  } catch {
    try { socket.destroy(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Orders (in memory) for the customer test page
// ---------------------------------------------------------------------------
// Order life cycle: PENDING -> PAID -> DISPATCHED (sent to the machine in a
// FunCode 4000 poll reply) -> DELIVERED / DELIVERY_FAILED (FunCode 5000 report).
let orders = []; // oldest first
const PAID_STATES = ['PAID', 'DISPATCHED', 'DELIVERED', 'DELIVERY_FAILED'];

/**
 * Order number in the vendor's style: 17-digit timestamp yyyyMMddHHmmssSSS
 * (like the protocol example "20170609123523569") + 3 random digits.
 */
function newTradeNo() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  let id;
  do {
    id = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}` +
      `${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}${p(crypto.randomInt(1000), 3)}`;
  } while (orders.some((o) => o.orderId === id));
  return id;
}

function createOrder({ mid, sid, pid, amount, status = 'PENDING', source = 'page' }) {
  const order = {
    orderId: newTradeNo(), // 20 digits
    mid, sid, pid, amount,
    status,
    source, // "page" (customer page) or "manual" (admin "Dispense now")
    createdAt: new Date().toISOString(),
    paidAt: status === 'PAID' ? new Date().toISOString() : null,
    dispatchedAt: null,
    deliveredAt: null,
    delivery: null, // the FunCode 5000 report, when it arrives
  };
  orders.push(order);
  if (orders.length > MAX_ORDERS) orders = orders.slice(-MAX_ORDERS);
  return order;
}

/** Latest order for this machine (and slot, if given). */
function findLatestOrder(mid, sid) {
  if (!mid) return null;
  for (let i = orders.length - 1; i >= 0; i--) {
    const o = orders[i];
    if (o.mid === mid && (!sid || o.sid === sid)) return o;
  }
  return null;
}

/** Oldest PAID (not yet dispatched) order for this machine. Orders without a mid match any machine. */
function nextOrderToDispatch(machineId) {
  return orders.find((o) => o.status === 'PAID' && (!o.mid || o.mid === machineId)) || null;
}

// ---------------------------------------------------------------------------
// Vendor protocol ("Protocol of Payment Channel Connection")
// The machine calls the Request Address URL with a FunCode:
//   1000 = slot/commodity loading report  -> we acknowledge
//   4000 = polling every ~3 s             -> we tell it what to dispense (once)
//   5000 = delivery result report         -> we record it on the order
// Every reply is JSON; "Status":"0" means success, anything else = failed.
// ---------------------------------------------------------------------------
function handleProtocol(funCode, sources) {
  const get = (...keys) => detect(sources, keys);
  const machineId = get('MachineID', 'mid');
  const tradeNo = get('TradeNo');
  const slotNo = get('SlotNo', 'sid');

  if (funCode === '1000') {
    return {
      reason: `FunCode 1000 loading report slot ${slotNo || '-'}`,
      reply: { Status: '0', SlotNo: slotNo, TradeNo: tradeNo, Err: 'success', ImageUrl: '', ImageDetailUrl: '' },
    };
  }

  if (funCode === '4000') {
    const order = nextOrderToDispatch(machineId);
    if (!order) {
      return {
        idle: true,
        reason: 'FunCode 4000 poll: nothing to dispense',
        reply: { Status: '1', MsgType: '0', TradeNo: '', SlotNo: '', ProductID: '', Err: 'no order' },
      };
    }
    // Dispatch exactly once: the next poll must not drop the item again.
    order.status = 'DISPATCHED';
    order.dispatchedAt = new Date().toISOString();
    if (!order.mid) order.mid = machineId;
    console.log(`[order] ${order.orderId} DISPATCHED to machine ${machineId} slot ${order.sid}`);
    return {
      orderId: order.orderId,
      reason: `FunCode 4000 poll: DISPENSE order ${order.orderId} slot ${order.sid}`,
      reply: {
        Status: '0', MsgType: '0', TradeNo: order.orderId,
        SlotNo: String(order.sid || ''), ProductID: String(order.pid || ''), Err: 'success',
      },
    };
  }

  if (funCode === '5000') {
    const status = get('Status');
    const order = orders.find((o) => o.orderId === tradeNo);
    if (order) {
      order.status = status === '0' || status === '2' ? 'DELIVERED' : 'DELIVERY_FAILED';
      order.deliveredAt = new Date().toISOString();
      order.delivery = {
        status, payType: get('PayType'), time: get('Time'), amount: get('Amount'),
        productId: get('ProductID'), name: get('Name'),
      };
      console.log(`[order] ${order.orderId} ${order.status} (machine status ${status})`);
    }
    return {
      orderId: order ? order.orderId : undefined,
      reason: `FunCode 5000 delivery report status ${status || '-'}${order ? '' : ' (unknown TradeNo)'}`,
      reply: { Status: '0', TradeNo: tradeNo, SlotNo: slotNo, Err: 'success' },
    };
  }

  // Unknown FunCode: acknowledge so the machine does not retry forever.
  return { reason: `FunCode ${funCode} (unknown)`, reply: { Status: '0', Err: 'success' } };
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

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Mobile-friendly customer page with a "Simulate payment" button (no external libraries). */
function paymentPage(order) {
  const row = (k, v) => `<tr><th>${k}</th><td>${escHtml(v || '-')}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Pay for your item</title>
<style>
  body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#f4f5f7;color:#1d2330}
  main{max-width:420px;margin:0 auto;padding:20px 16px}
  .card{background:#fff;border-radius:14px;padding:18px;border:1px solid #dde1e7}
  h1{font-size:20px;margin:0 0 12px} table{width:100%;border-collapse:collapse}
  th{text-align:left;color:#6b7280;font-weight:500;padding:6px 0} td{text-align:right;font-weight:600}
  .amt{font-size:32px;font-weight:800;text-align:center;margin:16px 0}
  button{width:100%;padding:18px;font-size:20px;font-weight:700;border:0;border-radius:12px;background:#16a34a;color:#fff}
  #msg{text-align:center;margin-top:12px;font-weight:600} .muted{color:#6b7280;font-size:12px;text-align:center}
</style></head><body><main><div class="card">
<h1>Vending machine order</h1>
<table>${row('Machine', order.mid)}${row('Slot', order.sid)}${row('Product', order.pid)}${row('Order', order.orderId)}</table>
<div class="amt">${escHtml(order.amount || '-')}</div>
<button id="pay" data-order="${escHtml(order.orderId)}">Simulate payment (PAID)</button>
<div id="msg"></div>
<p class="muted">Test page from the mock server. No real money moves.</p>
</div></main>
<script>
document.getElementById('pay').onclick = async function () {
  var btn = this, msg = document.getElementById('msg');
  btn.disabled = true;
  try {
    var r = await fetch('/api/pay/' + encodeURIComponent(btn.dataset.order), { method: 'POST' });
    var d = await r.json();
    msg.textContent = r.ok ? 'PAID ✓ (order ' + d.orderId + ')' : 'Error: ' + (d.error || r.status);
    if (r.ok) { btn.textContent = 'PAID'; btn.style.background = '#2563eb'; } else btn.disabled = false;
  } catch (e) { msg.textContent = 'Network error: ' + e.message; btn.disabled = false; }
};
</script></body></html>`;
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

/** Newest first, by id. */
const byIdDesc = (a, b) => b.id - a.id;

/** One-line text summary of a log entry (for /api/summary). */
function oneLine(l) {
  const d = l.detected || {};
  const r = l.response || {};
  return `#${l.id} ${l.time} [${l.source}] ${l.method} ${l.url} -> ${r.status} ${r.mode}` +
    ` | mid=${d.machine || '-'} sid=${d.slot || '-'} amt=${d.amount || '-'} scanned=${d.scanned || '-'}` +
    ` | ua=${(l.headers && l.headers['user-agent']) || '-'}`;
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

// Nothing under /api may be cached (phones love to cache).
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Customer page button: mark an order PAID. Public on purpose (no token):
// the customer's phone calls it.
app.post('/api/pay/:orderId', (req, res) => {
  const order = orders.find((o) => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ error: 'unknown order' });
  // Only PENDING -> PAID. Paying twice must never queue a second dispense.
  if (order.status !== 'PENDING') return res.json(order);
  order.status = 'PAID';
  order.paidAt = new Date().toISOString();
  console.log(`[order] ${order.orderId} PAID (mid=${order.mid} sid=${order.sid} amount=${order.amount})`);
  res.json(order);
});

// --- Admin API ---
const api = express.Router();
api.use(requireToken);

// Logs newer than ?since=ID, newest first. Also returns the current mode so
// the page stays in sync if the mode is changed from another phone.
api.get('/logs', (req, res) => {
  const since = Number(req.query.since) || 0;
  const items = logs.filter((l) => l.id > since).sort(byIdDesc);
  res.json({ logs: items, lastId: nextId - 1, mode: config.mode });
});

api.delete('/logs', (req, res) => {
  logs = [];
  fs.writeFile(LOG_FILE, '', () => {});
  res.json({ ok: true });
});

// Counts per source, the last machine-like request and the last 15 entries.
api.get('/summary', (req, res) => {
  const counts = {};
  for (const l of logs) counts[l.source] = (counts[l.source] || 0) + 1;
  const sorted = logs.slice().sort(byIdDesc);
  const m = sorted.find((l) => l.source === 'machine?');
  res.json({
    counts,
    total: logs.length,
    lastMachine: m ? {
      id: m.id, time: m.time, method: m.method, url: m.url,
      ua: (m.headers && m.headers['user-agent']) || '', body: m.rawBody,
    } : null,
    last15: sorted.slice(0, 15).map(oneLine),
    connections: connections.length,
    clientErrors: clientErrors.length,
  });
});

// Raw TCP connections, client errors and orders, newest first.
api.get('/diag', (req, res) => {
  res.json({
    connections: connections.slice(-50).reverse(),
    clientErrors: clientErrors.slice(-50).reverse(),
    orders: orders.slice().reverse(),
    useOrderState: config.useOrderState,
    protocol: config.protocol,
  });
});

api.delete('/diag', (req, res) => {
  connections = [];
  clientErrors = [];
  res.json({ ok: true });
});

// "Dispense now": queue a PAID order so the machine's next FunCode 4000 poll
// dispenses it. mid is optional (empty = whichever machine polls first).
api.post('/dispense', (req, res) => {
  const b = adminJson(req) || {};
  const sid = String(b.sid || '').trim();
  if (!sid) return res.status(400).json({ error: 'sid (slot number) is required' });
  const order = createOrder({
    mid: String(b.mid || '').trim(), sid, pid: String(b.pid || sid).trim(),
    amount: String(b.amount || ''), status: 'PAID', source: 'manual',
  });
  console.log(`[order] ${order.orderId} queued manually: slot ${sid} for machine ${order.mid || '(any)'}`);
  res.json(order);
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

// Simulate a machine call against this same server and return what it got,
// plus the log entry it produced (so you can check method/body/detection).
api.post('/test', async (req, res) => {
  const t = adminJson(req) || {};
  const method = String(t.method || 'POST').toUpperCase();
  let reqPath = String(t.path || '/WXdevelop/VerifyCode');
  if (!reqPath.startsWith('/')) reqPath = '/' + reqPath;
  const port = req.socket.localPort;
  const hasBody = !['GET', 'HEAD'].includes(method) && t.body !== undefined && t.body !== '';
  const before = nextId;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${reqPath}`, {
      method,
      headers: {
        'content-type': t.contentType || 'application/json',
        'user-agent': 'admin-test',
        'x-mock-test': '1', // classified as source "test", not "machine?"
      },
      body: hasBody ? String(t.body) : undefined,
      redirect: 'manual', // a redirect would silently turn POST into GET
    });
    const body = await r.text();
    const entry = logs.filter((l) => l.id >= before && l.source === 'test').sort(byIdDesc)[0] || null;
    res.json({ status: r.status, headers: Object.fromEntries(r.headers.entries()), body, sentMethod: method, entry });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

api.use((req, res) => res.status(404).json({ error: 'unknown admin API route' }));
app.use('/api', api);

// --- Machine-facing catch-all: every other method + path ---
app.use(async (req, res) => {
  const now = new Date();
  const source = classify(req.path, req.headers);
  const query = req.query || {};
  const parsed = parseBody(req.rawBody);
  const bodyObj = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};

  // Best-effort detection of the scanned code, slot, machine, product, amount.
  let scanned = detect([bodyObj, query], SCANNED_KEYS);
  if (!scanned && parsed.type === 'text' && parsed.value.length <= 200) {
    scanned = parsed.value.trim(); // plain-text body: the body IS probably the code
  }
  const detected = {
    scanned,
    slot: detect([bodyObj, query], SLOT_KEYS),
    machine: detect([bodyObj, query, req.headers], MACHINE_KEYS),
    product: detect([bodyObj, query], PRODUCT_KEYS),
    amount: detect([bodyObj, query], AMOUNT_KEYS),
  };

  const entry = {
    id: nextId++,
    time: now.toISOString(),
    source,
    method: req.method,
    url: `${req.protocol}://${req.get('host') || ''}${req.originalUrl}`,
    path: req.path,
    query,
    headers: req.headers,
    rawBody: req.rawBody,
    bodyType: parsed.type,
    parsedBody: parsed.value,
    ip: clientIp(req),
    detected,
  };

  // 1) Noise: answer cheaply, still log (hidden by default in admin).
  if (source === 'noise') {
    const isRobots = /robots\.txt$/i.test(req.path);
    entry.response = { mode: 'noise', reason: 'noise', status: isRobots ? 200 : 204,
      contentType: isRobots ? 'text/plain' : '', headers: {}, delayMs: 0, body: isRobots ? 'ok' : '' };
    addLog(entry);
    return isRobots ? res.type('text/plain').send('ok') : res.status(204).end();
  }

  // 2) A phone browser opening the machine's QR link: show the customer test page.
  const wantsHtml = /text\/html/i.test(String(req.headers.accept || ''));
  if (req.method === 'GET' && source === 'browser' && wantsHtml && query.mid && query.sid) {
    const order = createOrder({ mid: detected.machine, sid: detected.slot, pid: detected.product, amount: detected.amount });
    entry.orderId = order.orderId;
    entry.response = { mode: 'page', reason: 'customer page', status: 200, contentType: 'text/html',
      headers: {}, delayMs: 0, body: `(customer payment page, order ${order.orderId})` };
    addLog(entry);
    return res.status(200).type('text/html').send(paymentPage(order));
  }

  // 3) Vendor protocol: requests carrying a FunCode get the protocol JSON reply.
  const funCode = detect([bodyObj, query], ['FunCode']);
  if (config.protocol && funCode) {
    const p = handleProtocol(funCode, [bodyObj, query]);
    const body = JSON.stringify(p.reply);
    entry.funCode = funCode;
    if (p.idle) entry.idlePoll = true;
    if (p.orderId) entry.orderId = p.orderId;
    entry.response = { mode: 'protocol', reason: p.reason, status: 200, contentType: 'application/json',
      headers: {}, delayMs: 0, body };
    addLog(entry);
    return res.status(200).type('application/json').send(body);
  }

  // 4) Everything else gets the configured success / fail response.
  let mode = config.mode;
  let reason = 'config';
  const isFailCode = scanned &&
    config.failCodes.some((c) => c.toLowerCase() === scanned.trim().toLowerCase());
  const order = config.useOrderState ? findLatestOrder(detected.machine, detected.slot) : null;
  if (isFailCode) {
    mode = 'fail';
    reason = 'failCode';
  } else if (order) {
    mode = PAID_STATES.includes(order.status) ? 'success' : 'fail';
    reason = `order ${order.orderId} ${order.status}`;
    entry.orderId = order.orderId;
  }
  const tpl = config[mode];

  const ctx = {
    query,
    body: bodyObj,
    vars: {
      ...detected,
      timestamp: Math.floor(now.getTime() / 1000),
      timestampMs: now.getTime(),
      iso: now.toISOString(),
      method: req.method,
      path: req.path,
    },
  };
  const isJson = /json/i.test(tpl.contentType);
  const body = renderTemplate(tpl.body, ctx, isJson);

  entry.response = {
    mode,
    reason,
    status: tpl.status,
    contentType: tpl.contentType,
    headers: tpl.headers,
    delayMs: config.delayMs,
    body,
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

/** Non-internal IPv4 addresses of this PC (Wi-Fi, Ethernet, hotspot...). */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ name, address: a.address });
    }
  }
  // Real Wi-Fi first; VirtualBox/VMware/Hyper-V adapters (e.g. 192.168.56.1) last.
  const isVirtual = (x) => /virtual|vmware|vbox|vethernet|hyper-v|wsl|docker/i.test(x.name) || /^192\.168\.56\./.test(x.address);
  const score = (x) => (isVirtual(x) ? 2 : /wi-?fi|wlan|wireless/i.test(x.name) ? 0 : 1);
  return out.map((x) => ({ ...x, virtual: isVirtual(x) })).sort((a, b) => score(a) - score(b));
}

function printBanner(port) {
  const line = '-'.repeat(70);
  console.log(line);
  console.log(`Vending verify mock: plain HTTP on port ${port} (all interfaces)`);
  const ips = lanAddresses();
  if (ips.length) {
    console.log('Type ONE of these into BOTH machine address fields (same Wi-Fi/hotspot):');
    for (const { name, address, virtual } of ips) {
      const note = virtual ? `${name}, virtual adapter: probably NOT this one` : name;
      console.log(`  http://${address}:${port}/WXdevelop/VerifyCode    (${note})`);
    }
  } else {
    console.log('No LAN IPv4 address found: connect this PC to the same network as the machine.');
  }
  const host = ips.length ? ips[0].address : 'localhost';
  console.log(`Admin page: http://${host}:${port}/admin?token=${ADMIN_TOKEN}`);
  if (!TOKEN_FROM_ENV) console.log('(random admin token: set ADMIN_TOKEN to keep it fixed)');
  console.log('Windows Firewall must allow Node.js on PRIVATE networks, or the machine cannot connect.');
  console.log(line);
}

function start(port = PORT, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const server = app.listen(port, '0.0.0.0', () => {
      if (!quiet) printBanner(server.address().port);
      resolve(server);
    });
    server.on('connection', onConnection);
    server.on('clientError', onClientError);
  });
}

/**
 * Keep-alive: free hosts (Render) put the app to sleep after ~15 min without
 * incoming traffic. We ping our own PUBLIC URL every few minutes; the ping
 * goes through the host's proxy, so it counts as traffic and the app stays awake.
 * Render sets RENDER_EXTERNAL_URL automatically. Set KEEP_ALIVE=off to disable.
 */
function startKeepAlive() {
  const baseUrl = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL;
  if (!baseUrl || process.env.KEEP_ALIVE === 'off') return;
  const minutes = Number(process.env.KEEP_ALIVE_MINUTES) || 10;
  const url = baseUrl.replace(/\/+$/, '') + '/health';
  setInterval(() => {
    fetch(url).catch((err) => console.log('[keep-alive] ping failed:', err.message));
  }, minutes * 60 * 1000);
  console.log(`Keep-alive: pinging ${url} every ${minutes} min`);
}

if (require.main === module) start().then(startKeepAlive);

module.exports = { app, start, classify, ADMIN_TOKEN };
