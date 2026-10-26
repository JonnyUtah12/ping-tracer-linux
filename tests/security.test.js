// Security regression tests (audit 2026-10-16). Integration-level on purpose: each guard is exercised against a
// real booted server, not a mock. Zero dependencies: node:test + node built-ins only.
// Covers: POST-only state-changing actions, local-mode Host/Origin/Sec-Fetch-Site gates, static path traversal,
// argument-injection-safe host validation, request body cap, unbounded-growth caps (comments, custom columns).
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), http = require('http');

const SERVER = path.join(__dirname, '..', 'app', 'server.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-sec-'));
const procs = [];
after(async () => {
  const exits = procs.filter(p => p.exitCode == null).map(p => new Promise(r => { p.once('exit', r); p.kill(); setTimeout(r, 5000); }));
  await Promise.all(exits);
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch {}
});

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
// req with optional extra headers (Host/Origin/sec-fetch-site overrides) and optional raw body
const req = (port, method, p, body, headers) => new Promise((resolve, reject) => {
  const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  const h = { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(headers || {}) };
  const rq = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 8000, headers: h }, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => { let j = d; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: j, raw: d, headers: res.headers }); });
  });
  rq.on('error', reject); rq.on('timeout', () => rq.destroy(new Error('client timeout')));
  if (data) rq.write(data); rq.end();
});

async function boot(name) {
  const dir = path.join(TMP, name); fs.mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER, '--port=' + port], { env: { ...process.env, PP_NO_OPEN: '1', PP_DATA: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.resume(); proc.stdout.resume(); procs.push(proc);
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode != null) throw new Error('server exited early with code ' + proc.exitCode);
    try { const r = await req(port, 'GET', '/api/info'); if (r.status === 200) return port; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not answer /api/info');
}

let port, tid;
test('setup: boot server and open a loopback target', async () => {
  port = await boot('base');
  const r = await req(port, 'POST', '/api/targets', { host: '127.0.0.1' });
  assert.equal(r.status, 200); tid = r.body.id;
});

// ---- finding SEC-01: state-changing actions must not be reachable by GET ----
test('GET on state-changing target actions is rejected with 405; POST still works', async () => {
  for (const act of ['start', 'stop', 'clear', 'retrace']) {
    const g = await req(port, 'GET', `/api/targets/${tid}/${act}`);
    assert.equal(g.status, 405, `GET /${act} must be 405, got ${g.status}`);
  }
  // the target is untouched by the rejected GETs: still running
  let t = (await req(port, 'GET', '/api/targets/' + tid)).body;
  assert.equal(t.running, true, 'rejected GETs must not stop the target');
  // POST path unchanged (this is exactly what the UI and CLI use)
  assert.equal((await req(port, 'POST', `/api/targets/${tid}/stop`, {})).status, 200);
  t = (await req(port, 'GET', '/api/targets/' + tid)).body;
  assert.equal(t.running, false, 'POST stop still works');
  assert.equal((await req(port, 'POST', `/api/targets/${tid}/start`, {})).status, 200);
  // GET reads remain allowed
  assert.equal((await req(port, 'GET', `/api/targets/${tid}/raw`)).status, 200);
  assert.equal((await req(port, 'GET', `/api/targets/${tid}/samples`)).status, 200);
});

// ---- local-mode origin/Host gates (CSRF + DNS-rebinding defense) ----
test('local API rejects foreign Host, foreign Origin and cross-site requests', async () => {
  const h = await req(port, 'GET', '/api/info', null, { Host: 'evil.example.com' });
  assert.equal(h.status, 403, 'foreign Host header must be refused (DNS rebinding)');
  const o = await req(port, 'POST', '/api/targets', { host: '127.0.0.1' }, { Origin: 'http://evil.example' });
  assert.equal(o.status, 403, 'cross-site Origin must be refused');
  const s = await req(port, 'GET', '/api/targets', null, { 'sec-fetch-site': 'cross-site' });
  assert.equal(s.status, 403, 'cross-site navigation must be refused');
  const ok = await req(port, 'GET', '/api/info', null, { Host: '127.0.0.1:' + port });
  assert.equal(ok.status, 200, 'normal loopback request still works');
});

// ---- static file serving: no path traversal out of public/ ----
test('static serving cannot escape the public/ asset root', async () => {
  const a = await req(port, 'GET', '/../server.js');
  assert.ok(a.status === 403 || a.status === 404, 'dot-dot path must not serve a file: ' + a.status);
  assert.ok(!a.raw.includes('APP_VERSION'), 'server.js source must not be served');
  const b = await req(port, 'GET', '/%2e%2e/server.js');
  assert.ok(b.status === 403 || b.status === 404, 'encoded dot-dot must not serve a file: ' + b.status);
  const c = await req(port, 'GET', '/public/../server.js');
  assert.ok(c.status === 403 || c.status === 404, 'mixed traversal must not serve a file: ' + c.status);
  const idx = await req(port, 'GET', '/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers['content-security-policy'] || '', /default-src 'self'/, 'HTML must carry the CSP');
  assert.equal(idx.headers['x-content-type-options'], 'nosniff');
});

// ---- host validation blocks argument injection into ping.exe / the helper ----
test('hosts that could look like command flags or carry separators are rejected', async () => {
  for (const host of ['-f', '-n', '--help', 'a b', 'a;b', 'a|b', 'a b -n 1', 'a\nb', '']) {
    const r = await req(port, 'POST', '/api/targets', { host });
    assert.equal(r.status, 400, `host ${JSON.stringify(host)} must be rejected`);
  }
  const ok = await req(port, 'POST', '/api/targets', { host: '127.0.0.2' });
  assert.equal(ok.status, 200, 'a normal IP is still accepted');
  await req(port, 'DELETE', '/api/targets/' + ok.body.id);
});

// ---- request body cap ----
test('oversized request body is answered with 413, not absorbed', async () => {
  const big = 'x'.repeat(33 * 1024 * 1024);
  const r = await req(port, 'POST', '/api/targets', big, { 'content-type': 'application/json' });
  assert.equal(r.status, 413);
});

// ---- unbounded growth caps ----
test('comments per target are capped', async () => {
  for (let i = 0; i < 1002; i++) {
    const r = await req(port, 'POST', `/api/targets/${tid}/comments`, { text: 'c' + i });
    if (i >= 1001) assert.equal(r.status, 200);
  }
  const l = await req(port, 'GET', `/api/targets/${tid}/comments`);
  assert.ok(Array.isArray(l.body) && l.body.length <= 1000, 'comments must be capped at 1000, got ' + (l.body || []).length);
});

test('custom columns per target are capped', async () => {
  let rejected = false;
  for (let i = 0; i < 55; i++) {
    const r = await req(port, 'POST', `/api/targets/${tid}/column`, { name: 'col' + i, hop: 1, value: 'v' });
    if (r.status === 400) { rejected = true; break; }
    assert.equal(r.status, 200);
  }
  assert.ok(rejected, 'the 51st new custom column must be rejected');
});
