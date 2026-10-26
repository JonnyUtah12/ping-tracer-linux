// PT-5: UDP route tracing with TTL-limited probes — end-to-end engine test.
// Drives the real probe engine in app/server.js (runRound, path-length discovery, destination
// state) against the fake helper in tests/fixtures/fake-udp-network.js, which simulates a network
// where the destination is ICMP-silent and answers UDP with ICMP Port Unreachable ("refused")
// only at TTL >= 3. The path length therefore can only be discovered by the UDP probe itself.
// Zero dependencies: node:test + global fetch. Runs on any platform — PP_HELPER swaps in the
// fake helper, so the protocol-probe path is exercised without Windows or the native helper.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');

const APP = path.join(__dirname, '..', 'app', 'server.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-udp-network.js');

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function api(port, method, p, body) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${p} -> HTTP ${r.status}: ${j && j.error}`);
  return j;
}
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await new Promise(r => setTimeout(r, 100));
  }
}

test('UDP target: path length discovered via port-unreachable; steady state probes only the final TTL; a filtered destination is loss, not offline', async () => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt5-udp-'));
  const logFile = path.join(dataDir, 'udp-probes.jsonl'), modeFile = path.join(dataDir, 'mode');
  fs.writeFileSync(modeFile, 'reachable');
  const srv = spawn(process.execPath, [APP, `--port=${port}`], {
    env: { ...process.env, PP_DATA: dataDir, PP_NO_OPEN: '1', PP_HELPER: FIXTURE, PP_FAKE_LOG: logFile, PP_FAKE_MODE_FILE: modeFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = ''; srv.stderr.on('data', d => stderr += d);
  try {
    await waitFor(() => api(port, 'GET', '/api/info').catch(() => null), 10000, 'server to start');
    // fast rounds, a small discovery window, and fixed hop names so no reverse DNS is attempted
    await api(port, 'POST', '/api/settings', { intervalMs: 250, timeoutMs: 200, maxHops: 8, hostNames: { '198.51.100.1': 'r1.example', '198.51.100.2': 'r2.example' } });
    const t0 = await api(port, 'POST', '/api/targets', { host: '192.0.2.1', proto: 'udp', port: 9999 });
    const get = () => api(port, 'GET', `/api/targets/${t0.id}?focus=60000`);

    // 1) path length: the UDP probe itself finds it (ICMP never answers at the destination).
    // Wait for the destination sample too, not just finalTtl: runRound sets finalTtl before the hop's
    // sample is recorded (the rdns await for the destination IP sits between the two), so polling on
    // finalTtl alone can observe the hop table one await early.
    const t = await waitFor(async () => { const x = await get(); return x.finalTtl === 3 && x.hops[2] && x.hops[2].stats.count >= 1 ? x : null; }, 15000, 'finalTtl 3 via UDP port-unreachable, destination sample recorded');
    assert.strictEqual(t.proto, 'udp');
    assert.deepStrictEqual(t.hops.map(h => h.ttl), [1, 2, 3], 'hops beyond the discovered final TTL are dropped');
    assert.strictEqual(t.hops[0].ip, '198.51.100.1'); // intermediate hops attributed via ICMP (Windows socket limitation, documented)
    assert.strictEqual(t.hops[1].ip, '198.51.100.2');
    assert.strictEqual(t.hops[2].ip, '192.0.2.1');

    // 2) destination state: reachable with a closed port — "refused", never "offline"
    assert.strictEqual(t.destState, 'refused');
    assert.strictEqual(t.running, true);
    assert.ok(t.hops[2].stats.avg > 0, 'the protocol probe carries the destination RTT');
    assert.strictEqual(t.hops[2].stats.lost, 0, 'a port-unreachable answer is not packet loss');

    // 3) TTL usage: discovery swept TTLs 1..maxHops once; steady state probes only the final TTL
    await waitFor(async () => {
      const n = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(l => JSON.parse(l).ttl === 3).length;
      return n >= 4 ? true : null;
    }, 15000, 'four steady-state rounds of final-TTL UDP probes');
    const probes = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(probes.every(p => p.host === '192.0.2.1' && p.port === 9999 && p.size === 56), 'UDP probe lines carry host/port/packet size (wire format: U id host port timeoutMs ttl size)');
    const byTtl = {}; for (const p of probes) byTtl[p.ttl] = (byTtl[p.ttl] || 0) + 1;
    for (const ttl of [1, 2, 4, 5, 6, 7, 8]) assert.strictEqual(byTtl[ttl] || 0, 1, `TTL ${ttl} must be probed only during the discovery sweep`);
    assert.ok(byTtl[3] >= 4, 'the final TTL keeps being probed in steady state');

    // 4) filtered destination = loss, not offline: flip the simulated port to filtered mid-run
    fs.writeFileSync(modeFile, 'filtered');
    const t2 = await waitFor(async () => { const x = await get(); return x.destState === 'filtered' && x.hops[2] && x.hops[2].stats.lost > 0 ? x : null; }, 15000, 'destState filtered + loss samples on the final hop');
    assert.strictEqual(t2.running, true, 'an unanswered probe never stops or marks the target offline');
    assert.strictEqual(t2.finalTtl, 3, 'route knowledge is kept while the destination is filtered');
    assert.ok(t2.hops[2].stats.lossPct > 0, 'unanswered probes count as loss');
    assert.ok(t2.hops[0].stats.avg > 0, 'intermediate hops keep being measured normally');

    await api(port, 'POST', '/api/quit', {});
  } catch (e) {
    if (stderr) console.error('server stderr:\n' + stderr);
    throw e;
  } finally {
    // Windows keeps history.db locked until the server process is really gone - wait for exit, then retry the delete.
    await new Promise(r => { srv.once('exit', r); srv.kill(); setTimeout(r, 5000); });
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
