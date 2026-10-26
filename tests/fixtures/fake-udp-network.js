#!/usr/bin/env node
// PT-5 test fixture: a fake probe helper that speaks the pphelper protocol line-for-line and
// simulates one fixed network, so the engine's UDP route tracing can be tested on any platform.
//
// Simulated network for target 192.0.2.1:
//   - ICMP probes: routers at 198.51.100.1/2 answer TTL-exceeded at TTL 1-2; the destination is
//     silent to ICMP at every TTL (a common firewall config).
//   - UDP probes: in mode "reachable" the destination answers with ICMP Port Unreachable
//     (status "refused") only when the probe's TTL reaches 3; below that, no answer.
//     So the path length (3) can only be discovered by the UDP probe itself.
//   - Mode is re-read from the file in PP_FAKE_MODE_FILE on every probe: writing "filtered"
//     makes the destination stop answering UDP too - the engine must record that as loss and
//     destState "filtered", never treat the target as offline or stop tracing.
// Every UDP probe line is appended as JSON to PP_FAKE_LOG so tests can assert which TTLs were
// probed when (discovery sweep vs steady-state final-TTL-only probing).
const fs = require('fs'), readline = require('readline');
const modeFile = process.env.PP_FAKE_MODE_FILE || '', logFile = process.env.PP_FAKE_LOG || '';
const mode = () => { try { if (modeFile) return fs.readFileSync(modeFile, 'utf8').trim(); } catch {} return process.env.PP_FAKE_MODE || 'reachable'; };
const out = s => process.stdout.write(s + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const p = line.trim().split(/\s+/); if (!p[0]) return;
  if (p[0] === 'U' || p[0] === 'T') { // T|U id host port timeoutMs ttl [size]
    const [, id, host, port, , ttl, size] = p;
    if (p[0] === 'U' && logFile) fs.appendFileSync(logFile, JSON.stringify({ host, port: +port, ttl: +ttl, size: +(size || 0) }) + '\n');
    if (mode() === 'reachable' && +ttl >= 3) out(`${id} refused 198.51.100.7 6.5`); else out(`${id} timeout - 0`);
    return;
  }
  if (p[0] === 'E' || p[0] === 'X' || p[0] === 'M') return; // not exercised by these tests
  const [id, , ttl] = p; // ICMP: id host ttl timeoutMs [size]
  if (+ttl < 3) out(`${id} ttl 198.51.100.${ttl} 4.2`); else out(`${id} timeout - 0`);
});
