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

const { start } = require('./server');

let server;
let base;
const ADMIN = { 'x-admin-token': 'test-token', 'content-type': 'application/json' };

test.before(async () => {
  server = await start(0); // 0 = random free port
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
  assert.deepStrictEqual(log.detected, { scanned: 'ABC', slot: '7', machine: 'VM9' });
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
    ['PUT', '/api/config'], ['POST', '/api/mode'], ['POST', '/api/test']]) {
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
