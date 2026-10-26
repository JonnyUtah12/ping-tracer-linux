// PT-5 + PT-7: end-to-end tests for TTL-limited TCP/UDP route tracing and the JSON export.
// The engine runs against tests/mock-helper.js through the PP_HELPER hook, so the protocol-probe path
// (finalTtl discovery, destination-state classification, result merge) is exercised on any OS.
// The real C# helper's behaviour on Windows is covered by the helper smoke-test step in windows-release.yml.
// Zero dependencies: node:test + node built-ins only.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), http = require('node:http');

const SERVER = path.join(__dirname, '..', 'app', 'server.js');
const MOCK = path.join(__dirname, 'mock-helper.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pt5-proto-'));
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

async function boot() {
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER, '--port=' + port], { env: { ...process.env, PP_NO_OPEN: '1', PP_DATA: fs.mkdtempSync(TMP + '/d-'), PP_HELPER: MOCK }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; proc.stderr.on('data', d => stderr += d); proc.stdout.resume();
  procs.push(proc);
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode != null) throw new Error('server exited early with code ' + proc.exitCode + '\n' + stderr);
    try { const r = await req(port, 'GET', '/api/info'); if (r.status === 200) return { port, proc }; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not answer /api/info\n' + stderr);
}

// poll the target view until the predicate holds (or fail with the last state)
async function until(port, id, pred, what) {
  let last;
  for (let i = 0; i < 50; i++) {
    last = (await req(port, 'GET', '/api/targets/' + id)).body;
    if (pred(last)) return last;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`timeout waiting for ${what}; last state: finalTtl=${last.finalTtl} destState=${last.destState} hops=${(last.hops || []).length}`);
}

test('helper is active through the PP_HELPER hook (packettypes report tcp/udp available)', async () => {
  const { port } = await boot();
  const pt = (await req(port, 'GET', '/api/packettypes')).body;
  assert.ok(pt.find(x => x.id === 'tcp').available, 'tcp must be available with the helper running');
  assert.ok(pt.find(x => x.id === 'udp').available, 'udp must be available with the helper running');
});

test('TCP route trace: open port -> finalTtl discovered, destState open, protocol RTT recorded', async () => {
  const { port } = await boot();
  const id = (await req(port, 'POST', '/api/targets', { host: '127.0.0.1', proto: 'tcp', port: 18765, adhoc: true })).body.id;
  const t = await until(port, id, x => x.finalTtl === 3 && x.destState === 'open' && x.count >= 1, 'finalTtl 3 + destState open + a persisted round');
  const fin = t.hops.find(h => h.ttl === 3);
  assert.ok(fin && fin.stats.count >= 1, 'final hop must carry samples');
  assert.ok(fin.stats.min > 0, 'final hop latency must come from the protocol probe');
});

test('TCP route trace: closed port (RST) -> reached at hop 1, destState refused, host not called offline', async () => {
  const { port } = await boot();
  const id = (await req(port, 'POST', '/api/targets', { host: '127.0.0.1', proto: 'tcp', port: 18766, adhoc: true })).body.id;
  const t = await until(port, id, x => x.finalTtl === 1 && x.destState === 'refused' && x.count >= 1, 'finalTtl 1 + destState refused + a persisted round');
  const fin = t.hops.find(h => h.ttl === 1);
  assert.ok(fin && fin.ip === '127.0.0.1', 'the RST proves the destination address; it must be shown, not hidden');
});

test('UDP route trace: no answer -> destState filtered (never offline); port unreachable -> refused', async () => {
  const { port } = await boot();
  const a = (await req(port, 'POST', '/api/targets', { host: '127.0.0.1', proto: 'udp', port: 18767, adhoc: true })).body.id;
  const ta = await until(port, a, x => x.destState === 'filtered' && x.finalTtl === 3 && x.count >= 1, 'udp filtered at finalTtl 3 with a persisted round');
  assert.ok(ta.hops.find(h => h.ttl === 3).ip === '127.0.0.1', 'ICMP attribution still shows the destination hop');
  const b = (await req(port, 'POST', '/api/targets', { host: '127.0.0.1', proto: 'udp', port: 18768, adhoc: true })).body.id;
  await until(port, b, x => x.destState === 'refused', 'udp port-unreachable refused');
});

test('JSON export carries destination, probe method, timestamp, configuration and per-hop statistics', async () => {
  const { port } = await boot();
  const id = (await req(port, 'POST', '/api/targets', { host: '127.0.0.1', proto: 'tcp', port: 18765, adhoc: true })).body.id;
  await until(port, id, x => x.finalTtl === 3 && x.destState === 'open' && x.count >= 1, 'trace to settle (round persisted)');
  const r = await req(port, 'GET', '/api/targets/' + id + '/export?format=json');
  assert.strictEqual(r.status, 200);
  const e = r.body;
  assert.strictEqual(e.app, 'PingTracer');
  assert.ok(/^\d+\.\d+\.\d+$/.test(e.version), 'export must carry the app version');
  assert.ok(!Number.isNaN(Date.parse(e['exported-at'])), 'export must carry an export timestamp');
  assert.strictEqual(e.target.host, '127.0.0.1');
  assert.strictEqual(e.target.proto, 'tcp');
  assert.strictEqual(e.target.port, 18765);
  assert.strictEqual(e.target.destState, 'open');
  assert.ok(e.target.config && typeof e.target.config.timeoutMs === 'number' && typeof e.target.config.maxHops === 'number', 'configuration block required');
  const fin = e.hops.find(h => h.ttl === 3);
  assert.ok(fin && fin.stats.count >= 1 && typeof fin.stats.avgMs === 'number' && typeof fin.stats.lossPct === 'number', 'per-hop statistics required');
  // samples only with all=1
  const e2 = (await req(port, 'GET', '/api/targets/' + id + '/export?format=json&all=1')).body;
  assert.ok(Array.isArray(e2.hops.find(h => h.ttl === 3).samples) && e2.hops.find(h => h.ttl === 3).samples.length >= 1);
});
