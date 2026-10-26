// PT-4: unit tests for the TCP route-tracing classifiers in app/server.js.
// Zero dependencies, node:test. server.js starts an HTTP server and timers when required, so the pure
// classifier functions are extracted from the production source by brace-matching and evaluated here —
// the tests always exercise the exact shipped code, no duplicated copy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'app', 'server.js'), 'utf8');
function extract(name) {
  const start = SRC.indexOf('function ' + name + '(');
  assert.notStrictEqual(start, -1, `function ${name} not found in app/server.js`);
  let depth = 0;
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}
const protocolFinalTtl = eval('(' + extract('protocolFinalTtl') + ')');
const classifyDestState = eval('(' + extract('classifyDestState') + ')');

// helper probe reply shapes: { st: ok|refused|timeout|unreach|err, ip, ms } or null (helper gave up)
const ok = ttl => ({ ttl, r: { st: 'ok', ip: '203.0.113.9', ms: 12.3 } });
const refused = ttl => ({ ttl, r: { st: 'refused', ip: '203.0.113.9', ms: 9.8 } });
const timeout = ttl => ({ ttl, r: { st: 'timeout', ip: '-', ms: 0 } });

test('protocolFinalTtl: no destination answer means the path length is still unknown', () => {
  assert.strictEqual(protocolFinalTtl([]), null);
  assert.strictEqual(protocolFinalTtl([timeout(1), timeout(2), timeout(3)]), null);
  assert.strictEqual(protocolFinalTtl([{ ttl: 1, r: null }, { ttl: 2, r: null }]), null);
});

test('protocolFinalTtl: a completed handshake at TTL 7 discovers finalTtl 7', () => {
  const prs = [timeout(1), timeout(2), timeout(3), timeout(4), timeout(5), timeout(6), ok(7)];
  assert.strictEqual(protocolFinalTtl(prs), 7);
});

test('protocolFinalTtl: an RST (refused) also proves the destination was reached', () => {
  const prs = [timeout(1), timeout(2), refused(3)];
  assert.strictEqual(protocolFinalTtl(prs), 3);
});

test('protocolFinalTtl: the smallest answering TTL wins (out-of-order / overlapping rounds)', () => {
  const prs = [refused(5), ok(9), timeout(4), ok(7)];
  assert.strictEqual(protocolFinalTtl(prs), 5);
});

test('protocolFinalTtl: non-destination statuses never count as reached', () => {
  const prs = [{ ttl: 2, r: { st: 'err' } }, { ttl: 3, r: { st: 'unreach' } }, { ttl: 4, r: { st: 'ttl' } }, ok(6)];
  assert.strictEqual(protocolFinalTtl(prs), 6);
});

test('classifyDestState: open vs refused vs filtered vs unreachable are distinguished', () => {
  assert.strictEqual(classifyDestState({ st: 'ok', ip: '203.0.113.9', ms: 12 }), 'open');
  assert.strictEqual(classifyDestState({ st: 'refused', ip: '203.0.113.9', ms: 9 }), 'refused');
  assert.strictEqual(classifyDestState({ st: 'timeout' }), 'filtered');
  assert.strictEqual(classifyDestState({ st: 'unreach' }), 'unreachable');
});

test('classifyDestState: missing or failed probes are not silently called offline', () => {
  assert.strictEqual(classifyDestState(null), 'unknown');
  assert.strictEqual(classifyDestState(undefined), 'unknown');
  assert.strictEqual(classifyDestState({ st: 'err' }), 'error');
  assert.strictEqual(classifyDestState({ st: 'something-new' }), 'error');
});

test('steady state: with finalTtl known only that TTL is probed, and its answer drives destState', () => {
  // mirrors the runRound wiring: prs holds exactly the final-TTL probe once the path is discovered
  const prs = [refused(7)];
  const at = protocolFinalTtl(prs);
  assert.strictEqual(at, 7);
  assert.strictEqual(classifyDestState(prs.find(x => x.ttl === at).r), 'refused');
  // a port that stops answering flips to filtered, never to "offline"
  const prs2 = [timeout(7)];
  assert.strictEqual(protocolFinalTtl(prs2), null); // discovery would re-widen; engine keeps t.finalTtl
  assert.strictEqual(classifyDestState(prs2.find(x => x.ttl === 7).r), 'filtered');
});
