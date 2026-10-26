// PT-8 (spec §13): end-to-end API lifecycle test. Boots the real server with PP_DATA scratch + PP_NO_OPEN,
// opens a 127.0.0.1 target, polls for discovered hops, runs the export endpoints, exercises
// stop/start/clear/reset/delete, and verifies /api/quit really exits the process.
// Deliberately NOT re-covered here (owned by other files): settings validation/clamping and the invalid
// host / DNS-failure / invalid-port 400s (config-errors.test.js), the JSON export shape and CSV/TSV byte
// goldens (pt7-json-export.test.js), the TCP/UDP probe engine and mock helper (pt5 tests), the destination
// classifier (pt4 tests). Zero dependencies: node:test + node built-ins only.
// Platform guard: GitHub Windows runners may block ICMP. If the loopback target reports no replies on win32,
// the live-hop asserts are skipped (a warning is printed); the lifecycle and export-structure asserts still run.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), http = require('node:http');

const SERVER = path.join(__dirname, '..', 'app', 'server.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pt8-api-'));
let proc = null;
after(async () => {
  if (proc && proc.exitCode == null) await new Promise(r => { proc.once('exit', r); proc.kill(); setTimeout(r, 5000); });
  // Windows locks open files (history.db) until the process exits - retry the delete a while.
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch {}
});

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const req = (method, p, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const rq = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 8000, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, res => {
    let d = ''; res.setEncoding('utf8'); res.on('data', c => d += c);
    res.on('end', () => { let j = d; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body: j, text: d }); });
  });
  rq.on('error', reject); rq.on('timeout', () => rq.destroy(new Error('client timeout')));
  if (data) rq.write(data); rq.end();
});

let PORT = 0;
async function boot() {
  PORT = await freePort();
  proc = spawn(process.execPath, [SERVER, '--port=' + PORT], { env: { ...process.env, PP_NO_OPEN: '1', PP_DATA: TMP }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; proc.stderr.on('data', d => stderr += d); proc.stdout.resume();
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode != null) throw new Error('server exited early with code ' + proc.exitCode + '\n' + stderr);
    try { const r = await req('GET', '/api/info'); if (r.status === 200) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not answer /api/info\n' + stderr);
}

let tid = null;      // loopback target id
let live = false;    // did the probe path actually answer? (guarded on win32)

test('boot: /api/info reports the engine, platform and version', async () => {
  await boot();
  const r = await req('GET', '/api/info');
  assert.equal(r.status, 200);
  assert.match(r.body.version, /^\d+\.\d+\.\d+$/, 'version is a semver string (never assert a literal: it drifts on every release)');
  assert.equal(r.body.platform, os.platform());
  assert.equal(r.body.data, TMP);
});

test('add 127.0.0.1 target and poll until the loopback path is discovered', async () => {
  const add = await req('POST', '/api/targets', { host: '127.0.0.1' });
  assert.equal(add.status, 200);
  tid = add.body.id;
  assert.equal(add.body.running, true);
  assert.equal(add.body.proto, 'icmp');
  // the first round sweeps TTLs 1..maxHops; loopback answers at every TTL, so finalTtl must settle at 1.
  // Wait for a recorded sample, not just an IP: runRound sets the hop IP before its sample lands (rdns await).
  let t = null;
  for (let i = 0; i < 30; i++) {
    t = (await req('GET', '/api/targets/' + tid)).body;
    if (t.hops.some(h => h.ip && h.stats.count >= 1)) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  live = t.hops.some(h => h.ip && h.stats.count >= 1);
  if (!live) {
    if (process.platform === 'win32') { console.warn('PT8: no ICMP replies from the loopback target on this Windows runner; skipping live-hop asserts'); return; }
    assert.ok(live, 'loopback ICMP must answer on Linux/macOS runners');
  }
  assert.equal(t.finalTtl, 1, 'loopback is one hop');
  assert.equal(t.hops.length, 1);
  assert.equal(t.hops[0].ip, '127.0.0.1');
  assert.ok(t.hops[0].stats.count >= 1, 'at least one round of samples');
  assert.ok(t.hops[0].stats.lossPct < 100, 'loopback must not report total loss');
  assert.ok(t.hops[0].stats.avg >= 0, 'RTT recorded');
  const list = await req('GET', '/api/targets');
  assert.ok(list.body.some(x => x.id === tid), 'target appears in the list');
});

test('exports: csv rows, json envelope, meta=1 header', async () => {
  assert.ok(tid, 'previous test left a target');
  const csv = await req('GET', '/api/targets/' + tid + '/export?format=csv');
  assert.equal(csv.status, 200);
  assert.match(csv.type, /text\/plain/);
  assert.equal(csv.text.split('\n')[0], 'Hop,IP,Name,Count,Lost,Loss%,Avg,Min,Max,Cur,Jitter');
  if (live) {
    assert.match(csv.text.split('\n')[1], /^1,127\.0\.0\.1,/, 'a data row for the loopback hop');
  }
  const js = await req('GET', '/api/targets/' + tid + '/export?format=json');
  assert.equal(js.status, 200);
  assert.match(js.type, /application\/json/);
  const o = js.body;
  assert.equal(o.app, 'PingTracer');
  assert.equal(o.version, (await req('GET', '/api/info')).body.version, 'export envelope carries the running app version');
  assert.ok(!Number.isNaN(Date.parse(o['exported-at'])));
  assert.equal(o.target.host, '127.0.0.1');
  assert.equal(o.target.proto, 'icmp');
  assert.ok(Array.isArray(o.hops));
  if (live) assert.equal(o.hops.length, 1, 'one loopback hop');
  const meta = await req('GET', '/api/targets/' + tid + '/export?format=csv&meta=1');
  assert.equal(meta.status, 200);
  assert.ok(meta.text.startsWith('# app PingTracer\n# version ' + (await req('GET', '/api/info')).body.version + '\n'), 'opt-in metadata header');
  assert.ok(meta.text.includes('# target host=127.0.0.1'));
});

test('lifecycle: stop, start, clear, reset', async () => {
  let t = (await req('GET', '/api/targets/' + tid)).body;
  assert.equal(t.running, true);
  assert.equal((await req('POST', '/api/targets/' + tid + '/stop')).status, 200);
  t = (await req('GET', '/api/targets/' + tid)).body;
  assert.equal(t.running, false, 'stopped');
  // a round already in flight when stop lands still finishes and records; wait it out before clearing
  await new Promise(r => setTimeout(r, 1500));
  assert.equal((await req('POST', '/api/targets/' + tid + '/clear')).status, 200);
  t = (await req('GET', '/api/targets/' + tid)).body;
  for (const h of t.hops) assert.equal(h.stats.count, 0, 'clear drops all samples');
  // reset while stopped: nothing can repopulate the hop table, so the cleared state is observable
  assert.equal((await req('POST', '/api/targets/' + tid + '/reset')).status, 200);
  t = (await req('GET', '/api/targets/' + tid)).body;
  assert.deepEqual(t.hops, [], 'reset drops the hop table');
  assert.equal(t.finalTtl, null, 'reset clears the discovered path');
  assert.equal(t.running, false, 'a stopped target stays stopped across reset');
  assert.equal((await req('POST', '/api/targets/' + tid + '/start')).status, 200);
  t = (await req('GET', '/api/targets/' + tid)).body;
  assert.equal(t.running, true, 'started again');
});

test('delete removes the target', async () => {
  assert.equal((await req('DELETE', '/api/targets/' + tid)).status, 200);
  const list = await req('GET', '/api/targets');
  assert.ok(!list.body.some(x => x.id === tid), 'gone from the list');
  assert.equal((await req('GET', '/api/targets/' + tid)).status, 404);
});

test('quit: /api/quit saves state and exits the process', async () => {
  const q = await req('POST', '/api/quit');
  assert.equal(q.status, 200);
  const code = await new Promise((resolve, reject) => {
    proc.once('exit', resolve); proc.once('error', reject);
    setTimeout(() => reject(new Error('server did not exit within 5s of /api/quit')), 5000);
  });
  assert.equal(code, 0, 'clean exit');
  assert.ok(fs.existsSync(path.join(TMP, 'state.json')), 'state was saved on quit');
});
