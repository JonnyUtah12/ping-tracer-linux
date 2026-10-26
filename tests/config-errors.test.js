// PT-9: configuration & error-handling tests (spec §12). Integration-level on purpose: each scenario spawns the real
// server against a scratch PP_DATA so corrupt state files, unwritable data dirs, invalid ports/hosts and out-of-range
// settings are exercised end-to-end. Zero dependencies: node:test + node built-ins only.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), http = require('node:http');

const SERVER = path.join(__dirname, '..', 'app', 'server.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pt9-config-'));
const procs = [];
after(async () => {
  // Windows locks open files (history.db) until the process exits - wait for exit before deleting.
  const exits = procs.filter(p => p.exitCode == null).map(p => new Promise(r => { p.once('exit', r); p.kill(); setTimeout(r, 5000); }));
  await Promise.all(exits);
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch {}
});

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const req = (port, method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const rq = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 8000, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, res => {
    let d = ''; res.on('data', c => d += c);
    res.on('end', () => { let j = d; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: j }); });
  });
  rq.on('error', reject); rq.on('timeout', () => rq.destroy(new Error('client timeout')));
  if (data) rq.write(data); rq.end();
});

// start a server with a scratch data dir; resolves once /api/info answers. `expectExit` allows a process that exits
// early (used for the fatal cases) instead of failing the boot.
async function boot(dataDir) {
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER, '--port=' + port], { env: { ...process.env, PP_NO_OPEN: '1', PP_DATA: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; proc.stderr.on('data', d => stderr += d); proc.stdout.resume();
  procs.push(proc);
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode != null) throw Object.assign(new Error('server exited early with code ' + proc.exitCode + '\n' + stderr), { stderr });
    try { const r = await req(port, 'GET', '/api/info'); if (r.status === 200) return { port, proc, stderrOf: () => stderr }; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not answer /api/info\n' + stderr);
}
const scratch = name => { const d = path.join(TMP, name); fs.mkdirSync(d, { recursive: true }); return d; };

// ---- corrupt state.json starts with defaults ----
test('corrupt state.json starts with defaults', async () => {
  const dir = scratch('corrupt');
  fs.writeFileSync(path.join(dir, 'state.json'), '{ "settings": {intervalMs: 2500,,, broken ]');
  const { port } = await boot(dir);
  const r = await req(port, 'GET', '/api/settings');
  assert.equal(r.status, 200);
  assert.equal(r.body.intervalMs, 2500);
  assert.equal(r.body.historyDays, 30);
  assert.equal(r.body.maxHops, 30);
  assert.equal(r.body.timeoutMs, 2000);
  const t = await req(port, 'GET', '/api/targets');
  assert.equal(t.status, 200); assert.deepEqual(t.body, []); // corrupt targets section must not resurrect anything
});

test('state.json unreadable (directory in its place) starts with defaults', async () => {
  const dir = scratch('unreadable');
  fs.mkdirSync(path.join(dir, 'state.json')); // EISDIR on read: cross-platform stand-in for access-denied
  const { port } = await boot(dir);
  const r = await req(port, 'GET', '/api/settings');
  assert.equal(r.status, 200);
  assert.equal(r.body.intervalMs, 2500);
});

// ---- out-of-range settings clamped (from state.json and from the API) ----
test('out-of-range settings in state.json are clamped on load', async () => {
  const dir = scratch('clamp-file');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    settings: { historyDays: 99999, intervalMs: 1, timeoutMs: 1, packetSize: 99999, maxHops: 999, maxSamples: 1 },
    targets: [], nextId: 1, sessions: []
  }));
  const { port } = await boot(dir);
  const r = await req(port, 'GET', '/api/settings');
  assert.equal(r.status, 200);
  assert.equal(r.body.historyDays, 3650);
  assert.equal(r.body.intervalMs, 250);
  assert.equal(r.body.timeoutMs, 200);
  assert.equal(r.body.packetSize, 1400);
  assert.equal(r.body.maxHops, 64);
  assert.equal(r.body.maxSamples, 100);
});

test('non-numeric settings in state.json fall back to defaults', async () => {
  const dir = scratch('garbage-types');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    settings: { intervalMs: 'abc', historyDays: null, maxHops: {}, alertRules: 'nope', hostNames: 7, configs: 'nope' },
    targets: 'nope', nextId: 'x', sessions: 'nope'
  }));
  const { port } = await boot(dir);
  const r = await req(port, 'GET', '/api/settings');
  assert.equal(r.status, 200);
  assert.equal(r.body.intervalMs, 2500);
  assert.equal(r.body.historyDays, 30);
  assert.equal(r.body.maxHops, 30);
  assert.deepEqual(r.body.alertRules, []);
  const t = await req(port, 'GET', '/api/targets'); // garbage targets/sessions must not crash any path
  assert.equal(t.status, 200); assert.deepEqual(t.body, []);
  const s = await req(port, 'GET', '/api/sessions');
  assert.equal(s.status, 200); assert.deepEqual(s.body, []);
});

test('settings API clamps out-of-range values', async () => {
  const { port } = await boot(scratch('clamp-api'));
  const r = await req(port, 'PUT', '/api/settings', { intervalMs: 1, maxHops: 999, historyDays: 0, timeoutMs: 99999, packetSize: -5 });
  assert.equal(r.status, 200);
  assert.equal(r.body.intervalMs, 250);
  assert.equal(r.body.maxHops, 64);
  assert.equal(r.body.historyDays, 1);
  assert.equal(r.body.timeoutMs, 10000);
  assert.equal(r.body.packetSize, 0);
});

test('named configuration overrides are clamped too', async () => {
  const { port } = await boot(scratch('clamp-cfg'));
  const c = await req(port, 'POST', '/api/configs', { name: 'wild', intervalMs: 1, timeoutMs: 99999, maxHops: 999, keepDays: 99999 });
  assert.equal(c.status, 200);
  assert.equal(c.body.intervalMs, 250);
  assert.equal(c.body.timeoutMs, 10000);
  assert.equal(c.body.maxHops, 64);
  assert.equal(c.body.keepDays, 3650);
});

// ---- invalid host / DNS failure / invalid port return clean structured 400s ----
test('invalid host returns a clean 400', async () => {
  const { port } = await boot(scratch('bad-host'));
  for (const host of ['bad host!', '-nope', 'a'.repeat(300), '']) {
    const r = await req(port, 'POST', '/api/targets', { host });
    assert.equal(r.status, 400, 'host ' + JSON.stringify(host));
    assert.ok(typeof r.body.error === 'string' && r.body.error.length > 0);
  }
});

test('DNS lookup failure returns a clean 400', async () => {
  const { port } = await boot(scratch('dns-fail'));
  const r = await req(port, 'POST', '/api/targets', { host: 'no-such-host.invalid' }); // RFC 2606: guaranteed NXDOMAIN
  assert.equal(r.status, 400);
  assert.match(r.body.error, /DNS lookup failed/);
});

test('invalid port returns a clean 400; valid or absent port is accepted', async () => {
  const { port } = await boot(scratch('bad-port'));
  for (const p of [0, -1, 99999, 80.5, 'abc', '80x']) {
    const r = await req(port, 'POST', '/api/targets', { host: '127.0.0.1', proto: 'tcp', port: p });
    assert.equal(r.status, 400, 'port ' + JSON.stringify(p));
    assert.match(r.body.error, /invalid port/);
  }
  const ok = await req(port, 'POST', '/api/targets', { host: '127.0.0.1', proto: 'tcp', port: 65535 });
  assert.equal(ok.status, 200); assert.equal(ok.body.port, 65535);
  const none = await req(port, 'POST', '/api/targets', { host: '127.0.0.1', proto: 'tcp' }); // no port: protocol default, not port 1
  assert.equal(none.status, 200); assert.equal(none.body.port, null);
  const upd = await req(port, 'POST', '/api/targets/' + none.body.id + '/update', { port: 99999 });
  assert.equal(upd.status, 400); assert.match(upd.body.error, /invalid port/);
});

// ---- access-denied on the data dir: fall back, don't crash ----
test('unwritable data dir falls back instead of crashing', async () => {
  const blocker = path.join(TMP, 'blocked-parent');
  fs.writeFileSync(blocker, 'a file where a directory should be');
  const wanted = path.join(blocker, 'data');
  const { port, stderrOf } = await boot(wanted);
  const info = await req(port, 'GET', '/api/info');
  assert.equal(info.status, 200);
  assert.notEqual(info.body.data, wanted); // server moved its data elsewhere and kept running
  assert.match(stderrOf(), /not writable/);
  const s = await req(port, 'GET', '/api/settings'); // and the API still works from the fallback dir
  assert.equal(s.status, 200);
});

// ---- CLI front-end validates the port locally before calling the API ----
test('cli start rejects an invalid --port with a clear error', async () => {
  const { port } = await boot(scratch('cli-port'));
  const run = (args) => new Promise(r => {
    const p = spawn(process.execPath, [SERVER, 'cli', ...args, '--port=' + port], { env: { ...process.env, PP_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('exit', c => r({ code: c, out, err }));
  });
  const bad = await run(['start', '127.0.0.1', '--proto', 'tcp', '--port', 'abc']);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--port must be a whole number/);
  const good = await run(['start', '127.0.0.1', '--proto', 'tcp', '--port', '80']);
  assert.equal(good.code, 0);
  const t = await req(port, 'GET', '/api/targets');
  const tcp = t.body.find(x => x.proto === 'tcp');
  assert.ok(tcp && tcp.port === 80);
});

// ---- settings written back are valid: a save after clamping persists the clamped values ----
test('clamped settings persist to state.json (round-trip)', async () => {
  const dir = scratch('roundtrip');
  const { port } = await boot(dir);
  await req(port, 'PUT', '/api/settings', { maxHops: 999 });
  await req(port, 'POST', '/api/quit'); // saveSync on quit
  await new Promise(r => setTimeout(r, 300));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(saved.settings.maxHops, 64);
});
