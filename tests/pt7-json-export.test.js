// PT-7: JSON results export + export metadata (spec §11). Integration-level: boots the real server against a
// scratch PP_DATA holding a fixture target (TCP/443, named config "fast", known samples incl. losses), then asserts
// that format=json returns the required metadata (app/version/exported-at/target incl. effective config/hops+stats),
// that default CSV/TSV bytes are byte-identical to the pre-PT-7 export code (embedded goldens captured from HEAD
// before this feature), and that ?meta=1 only prepends # metadata lines. Zero deps: node:test + node built-ins.
const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), http = require('node:http');

const SERVER = path.join(__dirname, '..', 'app', 'server.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pt7-export-'));
const procs = [];
after(() => {
  for (const p of procs) { try { p.kill(); } catch {} }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
// raw GET that keeps the body as text plus the content-type, so JSON and CSV assertions are exact
const raw = (port, p) => new Promise((resolve, reject) => {
  const rq = http.get({ host: '127.0.0.1', port, path: p, timeout: 8000 }, res => {
    let d = ''; res.setEncoding('utf8'); res.on('data', c => d += c);
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', text: d }));
  });
  rq.on('error', reject); rq.on('timeout', () => rq.destroy(new Error('client timeout')));
});

// fixture timestamps are fixed epochs, so every derived statistic is deterministic
const T0 = 1760000000000;
const FIXTURE = "{\n \"settings\": {\n  \"historyDays\": 30,\n  \"intervalMs\": 2500,\n  \"timeoutMs\": 2000,\n  \"packetSize\": 56,\n  \"maxHops\": 30,\n  \"maxSamples\": 20000,\n  \"alertRules\": [],\n  \"hostNames\": {\n   \"192.168.1.1\": \"Home Gateway\"\n  },\n  \"configs\": [\n   {\n    \"id\": \"fast\",\n    \"name\": \"Fast polling\",\n    \"intervalMs\": 500,\n    \"timeoutMs\": 800,\n    \"packetSize\": 64,\n    \"maxHops\": 16,\n    \"keepDays\": 7\n   }\n  ]\n },\n \"targets\": [\n  {\n   \"id\": 1,\n   \"host\": \"example.com\",\n   \"ip\": \"93.184.216.34\",\n   \"name\": \"Example\",\n   \"finalTtl\": 3,\n   \"count\": 4,\n   \"running\": false,\n   \"hidden\": [],\n   \"proto\": \"tcp\",\n   \"port\": 443,\n   \"configId\": \"fast\",\n   \"startedAt\": 1760000000000,\n   \"hops\": [\n    {\n     \"ttl\": 1,\n     \"ip\": \"192.168.1.1\",\n     \"name\": \"router.local\",\n     \"samples\": [\n      {\n       \"t\": 1760000000000,\n       \"ms\": 1.2\n      },\n      {\n       \"t\": 1760000005000,\n       \"ms\": 1.4\n      },\n      {\n       \"t\": 1760000010000,\n       \"ms\": null\n      },\n      {\n       \"t\": 1760000015000,\n       \"ms\": 1.1\n      }\n     ]\n    },\n    {\n     \"ttl\": 2,\n     \"ip\": \"10.0.0.1\",\n     \"name\": \"\",\n     \"samples\": [\n      {\n       \"t\": 1760000000000,\n       \"ms\": 8.0\n      },\n      {\n       \"t\": 1760000005000,\n       \"ms\": 8.5\n      },\n      {\n       \"t\": 1760000010000,\n       \"ms\": 8.2\n      }\n     ]\n    },\n    {\n     \"ttl\": 3,\n     \"ip\": \"93.184.216.34\",\n     \"name\": \"example.com\",\n     \"samples\": [\n      {\n       \"t\": 1760000000000,\n       \"ms\": 14.0\n      },\n      {\n       \"t\": 1760000005000,\n       \"ms\": 14.5\n      },\n      {\n       \"t\": 1760000010000,\n       \"ms\": null\n      },\n      {\n       \"t\": 1760000015000,\n       \"ms\": 14.2\n      }\n     ]\n    }\n   ]\n  }\n ],\n \"nextId\": 2,\n \"sessions\": []\n}";

async function boot(dataDir) {
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER, '--port=' + port], { env: { ...process.env, PP_NO_OPEN: '1', PP_DATA: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; proc.stderr.on('data', d => stderr += d); proc.stdout.resume();
  procs.push(proc);
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode != null) throw new Error('server exited early with code ' + proc.exitCode + '\n' + stderr);
    try { const r = await raw(port, '/api/info'); if (r.status === 200) return port; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not answer /api/info\n' + stderr);
}
const dir = path.join(TMP, 'data'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'state.json'), FIXTURE);
let portP = null;
const port = async () => portP || (portP = await boot(dir));

// Goldens captured from the export code at HEAD before PT-7 (same fixture). Existing CSV/TSV consumers must keep
// receiving these exact bytes when no meta flag is requested.
const GOLD = {
 "long": "Hop\tIP\tName\tCount\tLost\tLoss%\tAvg\tMin\tMax\tCur\tJitter\n1\t192.168.1.1\trouter.local\t4\t1\t25.0\t1.2\t1.1\t1.4\t1.1\t0.2\n2\t10.0.0.1\t\t3\t0\t0.0\t8.2\t8.0\t8.5\t8.2\t0.4\n3\t93.184.216.34\texample.com\t4\t1\t25.0\t14.2\t14.0\t14.5\t14.2\t0.4",
 "csv": "Hop,IP,Name,Count,Lost,Loss%,Avg,Min,Max,Cur,Jitter\n1,192.168.1.1,router.local,4,1,25.0,1.2,1.1,1.4,1.1,0.2\n2,10.0.0.1,,3,0,0.0,8.2,8.0,8.5,8.2,0.4\n3,93.184.216.34,example.com,4,1,25.0,14.2,14.0,14.5,14.2,0.4",
 "wide": "Hop\tIP\tName\tCount\tLost\tLoss%\tAvg\tMin\tMax\tCur\tJitter\n1\t192.168.1.1\trouter.local\t4\t1\t25.0\t1.2\t1.1\t1.4\t1.1\t0.2\n2\t10.0.0.1\t\t3\t0\t0.0\t8.2\t8.0\t8.5\t8.2\t0.4\n3\t93.184.216.34\texample.com\t4\t1\t25.0\t14.2\t14.0\t14.5\t14.2\t0.4",
 "long-all": "Time\tHop 1 (192.168.1.1)\tHop 2 (10.0.0.1)\tHop 3 (93.184.216.34)\n2025-10-09T08:53:20.000Z\t1.2\t8\t14\n2025-10-09T08:53:25.000Z\t1.4\t8.5\t14.5\n2025-10-09T08:53:30.000Z\t\t8.2\t\n2025-10-09T08:53:35.000Z\t1.1\t\t14.2",
 "csv-all": "Time,Hop 1 (192.168.1.1),Hop 2 (10.0.0.1),Hop 3 (93.184.216.34)\n2025-10-09T08:53:20.000Z,1.2,8,14\n2025-10-09T08:53:25.000Z,1.4,8.5,14.5\n2025-10-09T08:53:30.000Z,,8.2,\n2025-10-09T08:53:35.000Z,1.1,,14.2",
 "wide-all": "Hop\tIP\t2025-10-09T08:53:20.000Z\t2025-10-09T08:53:25.000Z\t2025-10-09T08:53:30.000Z\t2025-10-09T08:53:35.000Z\n1\t192.168.1.1\t1.2\t1.4\t\t1.1\n2\t10.0.0.1\t8\t8.5\t8.2\t\n3\t93.184.216.34\t14\t14.5\t\t14.2"
} ;

const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, m + ` (got ${a}, want ${b})`);

test('format=json returns valid JSON with the required metadata', async () => {
  const p = await port();
  const r = await raw(p, '/api/targets/1/export?format=json');
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/json/);
  assert.ok(!/"_c"/.test(r.text), 'non-enumerable stats cache must not leak into the export');
  const o = JSON.parse(r.text);
  assert.equal(o.app, 'PingTracer');
  assert.equal(o.version, JSON.parse((await raw(p, '/api/info')).text).version, 'envelope version matches the running app');
  assert.match(o['exported-at'], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(o['focus-ms'], null);
  assert.equal(o.target.host, 'example.com');
  assert.equal(o.target.ip, '93.184.216.34');
  assert.equal(o.target.proto, 'tcp');
  assert.equal(o.target.port, 443);
  assert.equal(o.target.finalTtl, 3);
  assert.equal(o.target.rounds, 4);
  assert.equal(o.target.startedAt, new Date(T0).toISOString());
  // effective configuration: the named config's values, not the Settings defaults
  assert.equal(o.target.config.id, 'fast');
  assert.equal(o.target.config.name, 'Fast polling');
  assert.deepEqual({ intervalMs: o.target.config.intervalMs, timeoutMs: o.target.config.timeoutMs, packetSize: o.target.config.packetSize, maxHops: o.target.config.maxHops, keepDays: o.target.config.keepDays },
    { intervalMs: 500, timeoutMs: 800, packetSize: 64, maxHops: 16, keepDays: 7 });
  assert.equal(o.hops.length, 3);
  const [h1, h2, h3] = o.hops;
  assert.deepEqual([h1.ttl, h2.ttl, h3.ttl], [1, 2, 3]);
  assert.equal(h1.ip, '192.168.1.1');
  assert.equal(h1.name, 'Home Gateway'); // Settings host-name override wins over the rDNS name
  assert.equal(h2.name, null);
  assert.equal(h1.stats.count, 4); assert.equal(h1.stats.lost, 1); assert.equal(h1.stats.lossPct, 25);
  near(h1.stats.avgMs, (1.2 + 1.4 + 1.1) / 3, 'hop1 avg'); near(h1.stats.jitterMs, (Math.abs(1.4 - 1.2) + Math.abs(1.1 - 1.4)) / 2, 'hop1 jitter');
  assert.equal(h1.stats.minMs, 1.1); assert.equal(h1.stats.maxMs, 1.4); assert.equal(h1.stats.curMs, 1.1);
  assert.equal(h3.stats.count, 4); assert.equal(h3.stats.lost, 1);
  assert.ok(!('samples' in h1), 'samples are omitted unless all=1');
});

test('format=json&all=1 includes raw samples with ISO timestamps and nulls preserved', async () => {
  const r = await raw(await port(), '/api/targets/1/export?format=json&all=1');
  const o = JSON.parse(r.text);
  assert.equal(o.hops[0].samples.length, 4);
  assert.deepEqual(o.hops[0].samples.map(s => s.ms), [1.2, 1.4, null, 1.1]);
  assert.equal(o.hops[0].samples[0].t, new Date(T0).toISOString());
});

test('default CSV/TSV/long/wide exports are byte-identical to the pre-PT-7 goldens', async () => {
  const p = await port();
  for (const fmt of ['long', 'csv', 'wide']) {
    for (const all of [0, 1]) {
      const r = await raw(p, `/api/targets/1/export?format=${fmt}&all=${all}`);
      assert.equal(r.status, 200);
      assert.match(r.type, /text\/plain/);
      assert.equal(r.text, GOLD[all ? fmt + '-all' : fmt], `${fmt} all=${all} bytes changed`);
    }
  }
});

test('?meta=1 prepends # metadata lines and leaves the table bytes unchanged', async () => {
  const p = await port();
  const r = await raw(p, '/api/targets/1/export?format=csv&all=1&meta=1');
  const lines = r.text.split('\n');
  assert.equal(lines[0], '# app PingTracer');
  assert.equal(lines[1], '# version ' + JSON.parse((await raw(p, '/api/info')).text).version, 'metadata header carries the running app version');
  assert.match(lines[2], /^# exported-at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(lines[3], '# target host=example.com ip=93.184.216.34 proto=tcp port=443');
  assert.equal(lines[4], '# config id=fast intervalMs=500 timeoutMs=800 packetSize=64 maxHops=16 keepDays=7');
  assert.equal(lines.slice(5).join('\n'), GOLD['csv-all'], 'table body after the metadata header must be unchanged');
});

test('cli export --format json writes parseable JSON; --meta adds the header to CSV', async () => {
  const p = await port();
  const run = (args) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [SERVER, 'cli', ...args, '--port=' + p], { env: { ...process.env, PP_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d);
    c.on('exit', code => code === 0 ? resolve(out) : reject(new Error('cli exit ' + code + ': ' + err)));
  });
  const jf = path.join(TMP, 'out.json');
  await run(['export', '1', '--format', 'json', '--out', jf]);
  const o = JSON.parse(fs.readFileSync(jf, 'utf8'));
  assert.equal(o.app, 'PingTracer');
  assert.equal(o.target.config.id, 'fast');
  assert.equal(o.hops.length, 3);
  const cf = path.join(TMP, 'out.csv');
  await run(['export', '1', '--format', 'csv', '--meta', '--out', cf]);
  const txt = fs.readFileSync(cf, 'utf8');
  assert.ok(txt.startsWith('# app PingTracer\n'), 'cli --meta must pass the metadata header through');
  assert.equal(txt.split('\n').slice(5).join('\n'), GOLD['csv-all']);
});
