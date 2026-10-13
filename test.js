/**
 * Tests: start the server on a random port and exercise it over HTTP.
 * Run with `npm test`. Uses temp files so your real config.json / logs are untouched.
 */
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert');

// Must be set BEFORE requiring server.js.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vending-mock-'));
process.env.CONFIG_FILE = path.join(tmp, 'config.json');
process.env.LOG_FILE = path.join(tmp, 'logs.ndjson');
process.env.ADMIN_TOKEN = 'test-token';

const net = require('net');
const { start, classify } = require('./server');

let server;
let base;
const ADMIN = { 'x-admin-token': 'test-token', 'content-type': 'application/json' };

test.before(async () => {
  server = await start(0, { quiet: true }); // 0 = random free port
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Send a request and return { status, type, text, json }. */
async function call(method, urlPath, { body, type, headers } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { ...(type ? { 'content-type': type } : {}), ...headers },
    body,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, type: res.headers.get('content-type') || '', text, json };
}

const setMode = (mode) => call('POST', '/api/mode', { headers: ADMIN, body: JSON.stringify({ mode }) });
const putConfig = (cfg) => call('PUT', '/api/config', { headers: ADMIN, body: JSON.stringify(cfg) });
const lastLog = async () => (await call('GET', '/api/logs', { headers: ADMIN })).json.logs[0];

test('health and root', async () => {
  assert.strictEqual((await call('GET', '/health')).text, 'ok');
  const root = await call('GET', '/');
  assert.match(root.text, /\/admin/);
  assert.doesNotMatch(root.text, /test-token/);
});

test('GET returns default success', async () => {
  const r = await call('GET', '/WXdevelop/VerifyCode?code=Q1&slotNo=3');
  assert.strictEqual(r.status, 200);
  assert.match(r.type, /json/);
  assert.strictEqual(r.json.code, 0);
  assert.strictEqual(r.json.success, true);
  assert.strictEqual(r.json.data.code, 'Q1');
  assert.strictEqual(r.json.data.slotNo, '3');
});

test('JSON POST returns success and detects nested values', async () => {
  const r = await call('POST', '/WXdevelop/VerifyCode', {
    type: 'application/json',
    body: JSON.stringify({ deviceId: 'VM9', payload: { QRCode: 'ABC', SlotNo: 7 } }),
  });
  assert.strictEqual(r.json.success, true);
  assert.strictEqual(r.json.data.code, 'ABC');
  const log = await lastLog();
  assert.strictEqual(log.detected.scanned, 'ABC');
  assert.strictEqual(log.detected.slot, '7');
  assert.strictEqual(log.detected.machine, 'VM9');
  assert.strictEqual(log.bodyType, 'json');
});

test('urlencoded POST returns success', async () => {
  const r = await call('POST', '/any/path', {
    type: 'application/x-www-form-urlencoded', body: 'pickupCode=P55&aisle=2&imei=123',
  });
  assert.strictEqual(r.json.success, true);
  assert.strictEqual(r.json.data.code, 'P55');
  const log = await lastLog();
  assert.strictEqual(log.bodyType, 'urlencoded');
  assert.strictEqual(log.detected.machine, '123');
});

test('plain-text POST returns success and uses body as scanned code', async () => {
  const r = await call('POST', '/WXdevelop/VerifyCode', { type: 'text/plain', body: 'XYZ789' });
  assert.strictEqual(r.json.success, true);
  assert.strictEqual(r.json.data.code, 'XYZ789');
});

test('malformed JSON does not crash; unknown paths/methods never 404', async () => {
  const bad = await call('POST', '/WXdevelop/VerifyCode', { type: 'application/json', body: '{"code": "A1",,,' });
  assert.strictEqual(bad.status, 200);
  assert.strictEqual((await lastLog()).bodyType, 'text');
  const weird = await call('PATCH', '/some/random/path', { type: 'application/x-weird; charset=bogus', body: 'ÿ' });
  assert.strictEqual(weird.status, 200);
  assert.strictEqual((await call('GET', '/health')).text, 'ok'); // still alive
});

test('switching to fail changes the reply', async () => {
  assert.strictEqual((await setMode('fail')).json.mode, 'fail');
  const r = await call('GET', '/WXdevelop/VerifyCode?code=Q2');
  assert.strictEqual(r.json.success, false);
  assert.strictEqual(r.json.code, 1);
  await setMode('success');
  assert.strictEqual((await call('GET', '/x')).json.success, true);
});

test('templates: placeholders, JSON escaping, plain text', async () => {
  await putConfig({
    success: {
      status: 201,
      contentType: 'application/json',
      headers: { 'X-Mock': 'yes' },
      body: '{"c":"{{scanned}}","q":"{{query.extra}}","b":"{{body.a.b}}","m":"{{method}}","p":"{{path}}","t":{{timestamp}},"missing":"{{nope}}"}',
    },
  });
  const r = await call('POST', '/t/1?extra=hi', {
    type: 'application/json', body: JSON.stringify({ code: 'he said "x"', a: { b: 'deep' } }),
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.c, 'he said "x"'); // quotes were escaped, JSON still valid
  assert.strictEqual(r.json.q, 'hi');
  assert.strictEqual(r.json.b, 'deep');
  assert.strictEqual(r.json.m, 'POST');
  assert.strictEqual(r.json.p, '/t/1');
  assert.ok(Math.abs(r.json.t - Date.now() / 1000) < 60);
  assert.strictEqual(r.json.missing, '');

  await putConfig({ success: { status: 200, contentType: 'text/plain', headers: {}, body: 'OK {{scanned}}' } });
  const p = await call('GET', '/v?orderNo=N1');
  assert.strictEqual(p.text, 'OK N1');
  assert.match(p.type, /text\/plain/);
});

test('failCodes force the fail response', async () => {
  await putConfig({
    mode: 'success',
    failCodes: 'FAIL001, BAD2',
    success: { status: 200, contentType: 'text/plain', headers: {}, body: 'success' },
    fail: { status: 200, contentType: 'text/plain', headers: {}, body: 'fail' },
  });
  assert.strictEqual((await call('GET', '/v?code=GOOD')).text, 'success');
  assert.strictEqual((await call('GET', '/v?code=FAIL001')).text, 'fail');
  assert.strictEqual((await call('POST', '/v', { type: 'text/plain', body: 'bad2' })).text, 'fail');
  assert.strictEqual((await lastLog()).response.reason, 'failCode');
});

test('admin API rejects requests without a valid token', async () => {
  for (const [method, p] of [['GET', '/api/logs'], ['DELETE', '/api/logs'], ['GET', '/api/config'],
    ['PUT', '/api/config'], ['POST', '/api/mode'], ['POST', '/api/test'], ['GET', '/api/summary'], ['GET', '/api/diag']]) {
    assert.strictEqual((await call(method, p)).status, 401, `${method} ${p}`);
    assert.strictEqual((await call(method, p, { headers: { 'x-admin-token': 'wrong' } })).status, 401);
  }
  // With a token it works, including ?token=
  assert.strictEqual((await call('GET', '/api/config?token=test-token')).status, 200);
});

test('admin test endpoint simulates a machine call', async () => {
  const r = await call('POST', '/api/test', {
    headers: ADMIN, body: JSON.stringify({ method: 'POST', path: '/WXdevelop/VerifyCode', body: '{"code":"FAIL001"}' }),
  });
  assert.strictEqual(r.json.status, 200);
  assert.strictEqual(r.json.body, 'fail');
});

test('clear logs', async () => {
  assert.strictEqual((await call('DELETE', '/api/logs', { headers: ADMIN })).json.ok, true);
  assert.strictEqual((await call('GET', '/api/logs', { headers: ADMIN })).json.logs.length, 0);
});

// ---------------------------------------------------------------------------
// Diagnostics, classification, orders
// ---------------------------------------------------------------------------
const CHROME_UA = 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'SamsungBrowser/30.0 Chrome/143.0.0.0 Mobile Safari/537.36';
const WEBVIEW_UA = 'Mozilla/5.0 (Linux; Android 6.0; rk3288 Build/MRA58K; wv) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Version/4.0 Chrome/50.0.2661.86 Safari/537.36';
const BROWSER = { 'user-agent': CHROME_UA, 'accept-language': 'en-US,en', accept: 'text/html,application/xhtml+xml,*/*' };
const MACHINE = { 'user-agent': 'okhttp/3.12.0' };

test('source classification', async () => {
  assert.strictEqual(classify('/favicon.ico', {}), 'noise');
  assert.strictEqual(classify('/robots.txt', { 'user-agent': CHROME_UA }), 'noise');
  assert.strictEqual(classify('/x', { 'user-agent': 'Googlebot/2.1' }), 'bot');
  assert.strictEqual(classify('/x', { 'user-agent': 'Claude-User/1.0' }), 'bot');
  assert.strictEqual(classify('/x', { 'user-agent': CHROME_UA, 'accept-language': 'en' }), 'browser');
  // Browser-looking UA without Accept-Language, or an Android WebView: machine-like
  assert.strictEqual(classify('/x', { 'user-agent': CHROME_UA }), 'machine?');
  assert.strictEqual(classify('/x', { 'user-agent': WEBVIEW_UA, 'accept-language': 'zh-CN' }), 'machine?');
  assert.strictEqual(classify('/x', MACHINE), 'machine?');
  assert.strictEqual(classify('/x', { 'user-agent': 'Dalvik/2.1.0 (Linux; U; Android 6.0)' }), 'machine?');
  assert.strictEqual(classify('/x', {}), 'machine?');
  // ...and it is stored on the log entry
  await call('GET', '/WXdevelop/VerifyCode?mid=1', { headers: MACHINE });
  assert.strictEqual((await lastLog()).source, 'machine?');
  await call('GET', '/WXdevelop/VerifyCode', { headers: BROWSER });
  assert.strictEqual((await lastLog()).source, 'browser');
});

test('noise paths: favicon 204, robots "ok"', async () => {
  assert.strictEqual((await call('GET', '/favicon.ico')).status, 204);
  const robots = await call('GET', '/robots.txt');
  assert.strictEqual(robots.status, 200);
  assert.strictEqual(robots.text, 'ok');
  assert.strictEqual((await lastLog()).source, 'noise');
});

test('clientError: TLS bytes on the plain-HTTP port are recorded and answered 400', async () => {
  const port = server.address().port;
  const reply = await new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      // Start of a TLS ClientHello: 16 03 01 ...
      sock.write(Buffer.from('160301020001000200030301aabbccddeeff00112233', 'hex'));
    });
    let data = '';
    sock.on('data', (d) => { data += d.toString('latin1'); });
    sock.on('close', () => resolve(data));
    sock.on('error', reject);
    setTimeout(() => sock.destroy(), 3000);
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
  const diag = (await call('GET', '/api/diag', { headers: ADMIN })).json;
  const e = diag.clientErrors[0];
  assert.ok(e, 'client error recorded');
  assert.match(e.hex, /^1603/);
  assert.match(e.label, /TLS handshake/);
  assert.ok(diag.connections.length > 0, 'connections recorded');
  assert.strictEqual((await call('GET', '/health')).text, 'ok'); // still alive
});

test('order state: browser page creates order, machine gets fail until PAID', async () => {
  await putConfig({
    useOrderState: true,
    failCodes: [],
    success: { status: 200, contentType: 'text/plain', headers: {}, body: 'PAID {{machine}} {{slot}} {{product}} {{amount}}' },
    fail: { status: 200, contentType: 'text/plain', headers: {}, body: 'UNPAID' },
  });
  const page = await call('GET', '/WXdevelop/VerifyCode?mid=M77&sid=5&pid=5&pri=30.00', { headers: BROWSER });
  assert.match(page.type, /text\/html/);
  assert.match(page.text, /Simulate payment/);
  const orderId = page.text.match(/data-order="([a-f0-9]+)"/)[1];
  assert.ok(orderId.length >= 12);

  assert.strictEqual((await call('GET', '/WXdevelop/VerifyCode?mid=M77&sid=5', { headers: MACHINE })).text, 'UNPAID');
  const paid = await call('POST', `/api/pay/${orderId}`); // no admin token needed
  assert.strictEqual(paid.json.status, 'PAID');
  assert.strictEqual((await call('GET', '/WXdevelop/VerifyCode?mid=M77&sid=5&pid=5&pri=30.00', { headers: MACHINE })).text,
    'PAID M77 5 5 30.00');
  // A machine with no order falls back to the normal mode (success)
  assert.match((await call('GET', '/v?mid=OTHER', { headers: MACHINE })).text, /^PAID OTHER/);

  // Switch OFF: back to the normal behaviour even for an unpaid order
  await call('GET', '/WXdevelop/VerifyCode?mid=M88&sid=1', { headers: BROWSER });
  await putConfig({ useOrderState: false });
  assert.match((await call('GET', '/v?mid=M88&sid=1', { headers: MACHINE })).text, /^PAID/);
  assert.strictEqual((await call('POST', '/api/pay/nope')).status, 404);
});

test('no-store on /api and /admin', async () => {
  for (const p of ['/admin', '/api/config', '/api/logs', '/api/summary']) {
    const res = await fetch(base + p, { headers: ADMIN });
    assert.strictEqual(res.headers.get('cache-control'), 'no-store', p);
  }
  assert.strictEqual((await fetch(base + '/api/logs')).headers.get('cache-control'), 'no-store');
});

test('summary endpoint and logs ?since', async () => {
  await call('POST', '/WXdevelop/VerifyCode', { headers: MACHINE, type: 'application/json', body: '{"code":"S1"}' });
  const s = (await call('GET', '/api/summary', { headers: ADMIN })).json;
  assert.ok(s.counts['machine?'] >= 1);
  assert.strictEqual(s.lastMachine.method, 'POST');
  assert.strictEqual(s.lastMachine.ua, 'okhttp/3.12.0');
  assert.strictEqual(s.lastMachine.body, '{"code":"S1"}');
  assert.ok(s.last15.length >= 1 && s.last15.length <= 15);
  assert.match(s.last15[0], /POST/);

  const all = (await call('GET', '/api/logs', { headers: ADMIN })).json;
  const ids = all.logs.map((l) => l.id);
  assert.deepStrictEqual(ids, ids.slice().sort((a, b) => b - a)); // newest first
  const since = (await call('GET', `/api/logs?since=${ids[1]}`, { headers: ADMIN })).json;
  assert.deepStrictEqual(since.logs.map((l) => l.id), [ids[0]]);
});

// ---------------------------------------------------------------------------
// Vendor protocol (FunCode 1000 / 4000 / 5000)
// ---------------------------------------------------------------------------
const funcall = (fields, asForm) => call('POST', '/WXdevelop/VerifyCode', {
  headers: MACHINE,
  type: asForm ? 'application/x-www-form-urlencoded' : 'application/json',
  body: asForm ? new URLSearchParams(fields).toString() : JSON.stringify(fields),
});

test('protocol: FunCode 1000 loading report is acknowledged', async () => {
  const r = await funcall({ FunCode: '1000', MachineID: 'VM1', TradeNo: 'T123', SlotNo: '22', Price: '1.5' });
  assert.deepStrictEqual(r.json, { Status: '0', SlotNo: '22', TradeNo: 'T123', Err: 'success', ImageUrl: '', ImageDetailUrl: '' });
});

test('protocol: paid order is dispensed exactly once via FunCode 4000, then 5000 marks it delivered', async () => {
  // Nothing paid yet: Status "1" (= do not dispense), logged as an idle poll
  let poll = await funcall({ FunCode: '4000', MachineID: 'P1' }, true);
  assert.strictEqual(poll.json.Status, '1');
  assert.strictEqual((await lastLog()).idlePoll, true);

  // Customer opens the QR link and pays
  const page = await call('GET', '/WXdevelop/VerifyCode?mid=P1&sid=14&pid=14&pri=500.0', { headers: BROWSER });
  const orderId = page.text.match(/data-order="(\d+)"/)[1];
  assert.match(orderId, /^\d{20}$/);
  assert.strictEqual((await funcall({ FunCode: '4000', MachineID: 'P1' })).json.Status, '1'); // still PENDING
  await call('POST', `/api/pay/${orderId}`);
  await call('POST', `/api/pay/${orderId}`); // paying twice must not queue a second dispense

  // Another machine's poll must not take it
  assert.strictEqual((await funcall({ FunCode: '4000', MachineID: 'OTHER' })).json.Status, '1');

  poll = await funcall({ FunCode: '4000', MachineID: 'P1' });
  assert.deepStrictEqual(poll.json, { Status: '0', MsgType: '0', TradeNo: orderId, SlotNo: '14', ProductID: '14', Err: 'success' });
  // Next poll: nothing again (dispatched once)
  assert.strictEqual((await funcall({ FunCode: '4000', MachineID: 'P1' })).json.Status, '1');

  const fb = await funcall({ FunCode: '5000', MachineID: 'P1', PayType: 1, TradeNo: orderId, SlotNo: '14', Status: 0,
    Time: '2026-10-13 18:00:00', Amount: '500.0', ProductID: '14', Name: 'Water' });
  assert.deepStrictEqual(fb.json, { Status: '0', TradeNo: orderId, SlotNo: '14', Err: 'success' });
  const order = (await call('GET', '/api/diag', { headers: ADMIN })).json.orders.find((o) => o.orderId === orderId);
  assert.strictEqual(order.status, 'DELIVERED');
});

test('protocol: admin "Dispense now" queues a PAID order for any machine', async () => {
  const q = await call('POST', '/api/dispense', { headers: ADMIN, body: JSON.stringify({ sid: '28' }) });
  assert.strictEqual(q.json.status, 'PAID');
  const poll = await funcall({ FunCode: '4000', MachineID: 'ANY1' });
  assert.strictEqual(poll.json.Status, '0');
  assert.strictEqual(poll.json.SlotNo, '28');
  assert.strictEqual(poll.json.TradeNo, q.json.orderId);
  assert.strictEqual((await call('POST', '/api/dispense', { headers: ADMIN, body: '{}' })).status, 400);
});

test('protocol switch OFF falls back to the configured response', async () => {
  await putConfig({ protocol: false });
  const r = await funcall({ FunCode: '4000', MachineID: 'P1' });
  assert.strictEqual(r.json, null); // plain-text success body from the earlier test config
  assert.match(r.text, /^PAID/);
  await putConfig({ protocol: true });
});

test('admin "Send test" sends the chosen method and body', async () => {
  const r = await call('POST', '/api/test', {
    headers: ADMIN,
    body: JSON.stringify({ method: 'POST', path: '/WXdevelop/VerifyCode', contentType: 'application/json',
      body: '{"code":"ABC123","slotNo":"5"}' }),
  });
  assert.strictEqual(r.json.sentMethod, 'POST');
  assert.strictEqual(r.json.entry.method, 'POST');
  assert.strictEqual(r.json.entry.rawBody, '{"code":"ABC123","slotNo":"5"}');
  assert.strictEqual(r.json.entry.detected.scanned, 'ABC123');
  assert.strictEqual(r.json.entry.detected.slot, '5');
  assert.strictEqual(r.json.entry.source, 'test');
});
