// PT-8 (spec §13): unit tests for the pure functions app/server.js exports. The server only listens when run
// directly (require.main guard), so requiring it here starts nothing: no HTTP port, no helper/tray child, no
// timers (the two top-level intervals are unref'd). PP_DATA points at a scratch dir because module load, like
// any startup, ensures the data folder exists. Zero dependencies: node:test + node built-ins only.
// Scope note: the TCP/UDP status classifier and protocolFinalTtl are unit-tested in pt4-tcp-route-tracing.test.js;
// the JSON export shape and default CSV/TSV byte goldens are covered end-to-end in pt7-json-export.test.js.
process.env.PP_DATA = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'pt8-unit-'));
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'), path = require('node:path');
const S = require('../app/server.js');

after(() => { try { fs.rmSync(process.env.PP_DATA, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); } catch {} });

// snapshot/restore the live settings object so tests that mutate it can't leak into later ones
const settingsSnapshot = JSON.parse(JSON.stringify(S.settings));
function withSettings(patch, fn) {
  const keys = Object.keys(patch);
  for (const k of keys) S.settings[k] = patch[k];
  try { fn(); } finally {
    for (const k of keys) if (k in settingsSnapshot) S.settings[k] = settingsSnapshot[k]; else delete S.settings[k];
  }
}

// ---- validHost (used by every target-adding path) ----
test('validHost accepts hosts/IPs and rejects malformed input', () => {
  for (const h of ['127.0.0.1', '10.0.0.1', 'example.com', 'host.example.co.uk', 'a', 'a-b', 'up_to-9', 'xn--p1ai', '::1', 'fe80::1', 'a'.repeat(253)])
    assert.ok(S.validHost(h), 'should accept ' + JSON.stringify(h));
  for (const h of ['', ' ', 'bad host!', '-nope', 'nope-', 'h@st', 'h/st', 'h?st', 'g' + 'a'.repeat(252) + 'g', null, undefined])
    assert.ok(!S.validHost(h), 'should reject ' + JSON.stringify(h));
});

// ---- port validation (spec §12: clean rejection, never silent coercion) ----
test('portOf: null/empty mean no port; only whole 1-65535 numbers pass', () => {
  assert.equal(S.portOf(null), null);
  assert.equal(S.portOf(''), null);
  assert.equal(S.portOf(80), 80);
  assert.equal(S.portOf('443'), 443);
  assert.equal(S.portOf(1), 1);
  assert.equal(S.portOf(65535), 65535);
  for (const p of [0, -1, 65536, 80.5, '80x', 'abc', NaN, Infinity])
    assert.equal(S.portOf(p), undefined, 'should reject ' + String(p));
});

// ---- numeric clamping (spec §12 range tables) ----
test('clampNum clamps finite numbers and falls back on garbage', () => {
  assert.equal(S.clampNum('50', [1, 100], 7), 50);
  assert.equal(S.clampNum(-5, [1, 100], 7), 1);
  assert.equal(S.clampNum(999, [1, 100], 7), 100);
  for (const g of [null, undefined, true, {}, 'abc', NaN, Infinity])
    assert.equal(S.clampNum(g, [1, 100], 7), 7, 'garbage ' + String(g) + ' must fall back to the default');
});

test('clampCfg clamps overrides and drops garbage overrides (Settings fills in)', () => {
  const c = { intervalMs: 1, timeoutMs: 99999, maxHops: 999, keepDays: 99999, packetSize: 'abc' };
  S.clampCfg(c);
  assert.equal(c.intervalMs, 250);
  assert.equal(c.timeoutMs, 10000);
  assert.equal(c.maxHops, 64);
  assert.equal(c.keepDays, 3650);
  assert.ok(!('packetSize' in c), 'garbage override must be removed, not coerced');
});

test('clampSettings repairs every corrupt field a hand-edited state.json can carry', () => {
  const keys = ['intervalMs', 'maxHops', 'alertRules', 'hostNames', 'ipVersion', 'web', 'smtp'];
  const saved = {}; for (const k of keys) saved[k] = S.settings[k];
  try {
    S.settings.intervalMs = 'abc';
    S.settings.maxHops = 999;
    S.settings.alertRules = 'nope';
    S.settings.hostNames = 7;
    S.settings.ipVersion = '5';
    S.settings.web = { port: 99 };
    S.settings.smtp = { port: 999999 };
    S.clampSettings();
    assert.equal(S.settings.intervalMs, S.SETTINGS_DEFAULTS.intervalMs, 'non-numeric falls back to default');
    assert.equal(S.settings.maxHops, 64, 'out-of-range clamps');
    assert.deepEqual(S.settings.alertRules, []);
    assert.deepEqual(S.settings.hostNames, {});
    assert.ok(!('ipVersion' in S.settings), 'invalid ipVersion must be dropped, not kept');
    assert.equal(S.settings.web.port, 1024);
    assert.equal(S.settings.smtp.port, 65535);
  } finally {
    for (const k of keys) if (k in saved) S.settings[k] = saved[k]; else delete S.settings[k];
  }
});

// ---- effective probe configuration ----
test('cfgOf: defaults without a config; named config overrides only its fields', () => {
  withSettings({ configs: [{ id: 'c1', intervalMs: 500, maxHops: 8 }] }, () => {
    const d = S.SETTINGS_DEFAULTS;
    const base = S.cfgOf({});
    assert.deepEqual(base, { intervalMs: d.intervalMs, timeoutMs: d.timeoutMs, packetSize: d.packetSize, maxHops: d.maxHops, keepDays: d.historyDays });
    assert.deepEqual(S.cfgOf({ configId: 'missing' }), base, 'unknown config id falls back to defaults');
    const eff = S.cfgOf({ configId: 'c1' });
    assert.equal(eff.intervalMs, 500);
    assert.equal(eff.maxHops, 8);
    assert.equal(eff.timeoutMs, d.timeoutMs, 'fields the config does not set keep the defaults');
  });
});

// ---- alert-rule / display-name sanitizers (whitelist every field) ----
test('sanitizeRules whitelists and bounds every rule field', () => {
  assert.deepEqual(S.sanitizeRules('nope'), []);
  const [r] = S.sanitizeRules([{ id: 'a b!', enabled: true, metric: 'bogus', threshold: '150', windowSec: 1, hop: 'final', action: 'email', command: 'x'.repeat(600), sound: 'be!ep' }]);
  assert.equal(r.id, 'ab', 'id is stripped to word characters');
  assert.equal(r.enabled, true);
  assert.equal(r.metric, 'avg', 'unknown metric falls back');
  assert.equal(r.threshold, 150, 'numeric strings coerce');
  assert.equal(r.windowSec, 5, 'window clamps to the 5s floor');
  assert.equal(r.hop, 'final');
  assert.equal(r.action, 'email');
  assert.equal(r.command.length, 500, 'command is capped');
  assert.equal(r.sound, 'beep');
  const [r2] = S.sanitizeRules([{ metric: 'jitter', action: 'explode', hop: 99 }]);
  assert.equal(r2.metric, 'jitter');
  assert.equal(r2.action, 'notify', 'unknown action falls back');
  assert.equal(r2.hop, 64, 'hop clamps to the 64 ceiling');
  assert.equal(S.sanitizeRules(Array.from({ length: 60 }, () => ({}))).length, 50, 'rule list is capped');
});

test('sanitizeNames keeps only IP-like keys with string values, capped', () => {
  const out = S.sanitizeNames({ '10.0.0.1': 'Home Gateway', 'bad key!': 'x', '10.0.0.2': 5, '10.0.0.3': 'y'.repeat(200), 'fe80::1': 'v6' });
  assert.deepEqual(Object.keys(out).sort(), ['10.0.0.1', '10.0.0.3', 'fe80::1']);
  assert.equal(out['10.0.0.1'], 'Home Gateway');
  assert.equal(out['10.0.0.3'].length, 100, 'name length capped');
  assert.deepEqual(S.sanitizeNames(null), {});
  assert.deepEqual(S.sanitizeNames('nope'), {});
});

// ---- statistics math (loss, jitter, windows) ----
test('stats: avg/min/max/cur/loss/jitter over a known sample set', () => {
  const T0 = Date.now() - 60000;
  const h = { ttl: 1, ip: '10.0.0.1', samples: [{ t: T0, ms: 10 }, { t: T0 + 5000, ms: null }, { t: T0 + 10000, ms: 20 }, { t: T0 + 15000, ms: 30 }] };
  const s = S.stats(h, 0);
  assert.equal(s.count, 4);
  assert.equal(s.lost, 1);
  assert.equal(s.lossPct, 25);
  assert.equal(s.avg, 20);
  assert.equal(s.min, 10);
  assert.equal(s.max, 30);
  assert.equal(s.cur, 30);
  assert.equal(s.jitter, 10, 'mean |delta| between consecutive answered samples (nulls skipped): (10+10)/2');
  assert.ok(s.mos >= 1 && s.mos <= 4.5, 'mos in ITU range');
});

test('stats: empty hop is all-null, not a crash; focus window excludes old samples', () => {
  const empty = S.stats({ ttl: 1, samples: [] }, 0);
  assert.deepEqual({ c: empty.count, l: empty.lost, p: empty.lossPct, a: empty.avg, j: empty.jitter, m: empty.mos }, { c: 0, l: 0, p: 0, a: null, j: null, m: null });
  const now = Date.now();
  const h = { ttl: 1, samples: [{ t: now - 100000, ms: 5 }, { t: now - 1000, ms: 7 }] };
  assert.equal(S.stats(h, 0).count, 2, 'no window = everything');
  const w = S.stats(h, 50000);
  assert.equal(w.count, 1, '50s focus window keeps only the recent sample');
  assert.equal(w.avg, 7);
  // cache must invalidate when a new sample arrives
  h.samples.push({ t: now + 1, ms: 9 });
  assert.equal(S.stats(h, 0).count, 3, 'stats cache invalidates on new samples');
});

test('mos: null without data; degrades with loss', () => {
  assert.equal(S.mos(null, 0, 0), null);
  const good = S.mos(20, 5, 0), bad = S.mos(20, 5, 0.5);
  assert.ok(good > bad, '50% loss must score worse than none');
  assert.ok(bad >= 1, 'floor at 1');
});

// ---- route-change tracking ----
test('trackRoute records the first route, ignores silent-hop fills, records real changes', () => {
  const t = { finalTtl: 2, hops: [{ ip: '10.0.0.1' }, { ip: '' }] };
  S.trackRoute(t, 1000);
  assert.equal(t.routes.length, 1);
  assert.deepEqual(t.routes[0].hops, [{ ttl: 1, ip: '10.0.0.1' }, { ttl: 2, ip: '' }]);
  S.trackRoute(t, 2000);
  assert.equal(t.routes.length, 1, 'identical path is not a change');
  t.hops[1].ip = '10.0.0.2';
  S.trackRoute(t, 3000);
  assert.equal(t.routes.length, 1, 'a previously silent hop answering is not a route change');
  assert.equal(t.routes[0].hops[1].ip, '10.0.0.2', 'the recorded route is backfilled');
  t.hops[0].ip = '10.0.0.9';
  S.trackRoute(t, 4000);
  assert.equal(t.routes.length, 2, 'same position answering from a different address is a change');
  assert.deepEqual(t.routes[1].hops, [{ ttl: 1, ip: '10.0.0.9' }, { ttl: 2, ip: '10.0.0.2' }]);
  t.hops.push({ ip: '10.0.0.3' });
  S.trackRoute(t, 5000);
  assert.equal(t.routes.length, 3, 'path length change is a change');
  const noPath = { finalTtl: null, hops: [{ ip: '1.1.1.1' }] };
  S.trackRoute(noPath, 6000);
  assert.ok(!noPath.routes || noPath.routes.length === 0, 'no route recorded before the path is known');
});

// ---- text exports (the JSON shape and byte goldens live in pt7-json-export.test.js) ----
const T0 = 1760000000000;
const iso = t => new Date(t).toISOString();
function fixtureTarget() {
  return { id: 7, host: 'test.local', ip: '10.1.2.3', name: 'Test', proto: 'tcp', port: 80, configId: null, finalTtl: 2, count: 3, startedAt: T0, hops: [
    { ttl: 1, ip: '10.0.0.1', name: 'gw', samples: [{ t: T0, ms: 1.0 }, { t: T0 + 5000, ms: 3.0 }, { t: T0 + 10000, ms: null }] },
    { ttl: 2, ip: '10.0.0.2', name: '', samples: [{ t: T0, ms: 9.5 }, { t: T0 + 5000, ms: null }, { t: T0 + 10000, ms: 10.5 }] }] };
}

test('exportText csv: header + per-hop statistics with fixed formatting', () => {
  const out = S.exportText(fixtureTarget(), 'csv', 0, false);
  assert.equal(out, [
    'Hop,IP,Name,Count,Lost,Loss%,Avg,Min,Max,Cur,Jitter',
    '1,10.0.0.1,gw,3,1,33.3,2.0,1.0,3.0,,2.0',
    '2,10.0.0.2,,3,1,33.3,10.0,9.5,10.5,10.5,1.0',
  ].join('\n'), 'lossPct one decimal, ms one decimal, missing values empty');
});

test('exportText long/wide: sample grids with ISO timestamps, nulls blank', () => {
  const t = fixtureTarget();
  const long = S.exportText(t, 'long', 0, true).split('\n');
  assert.equal(long[0], ['Time', 'Hop 1 (10.0.0.1)', 'Hop 2 (10.0.0.2)'].join('\t'));
  assert.equal(long[1], [iso(T0), '1', '9.5'].join('\t'));
  assert.equal(long[2], [iso(T0 + 5000), '3', ''].join('\t'));
  assert.equal(long[3], [iso(T0 + 10000), '', '10.5'].join('\t'));
  const wide = S.exportText(t, 'wide', 0, true).split('\n');
  assert.equal(wide[0], ['Hop', 'IP', iso(T0), iso(T0 + 5000), iso(T0 + 10000)].join('\t'));
  assert.equal(wide[1], ['1', '10.0.0.1', '1', '3', ''].join('\t'));
  assert.equal(wide[2], ['2', '10.0.0.2', '9.5', '', '10.5'].join('\t'));
});

test('exportText meta=1 prepends the metadata header; default output has none', () => {
  const t = fixtureTarget();
  const plain = S.exportText(t, 'csv', 0, false);
  assert.ok(!plain.startsWith('#'));
  const meta = S.exportText(t, 'csv', 0, false, true);
  assert.ok(meta.startsWith('# app PingTracer\n# version ' + S.APP_VERSION + '\n# exported-at '));
  assert.ok(meta.includes('# target host=test.local ip=10.1.2.3 proto=tcp port=80'));
  const d = S.SETTINGS_DEFAULTS;
  assert.ok(meta.includes('# config id=default intervalMs=' + d.intervalMs + ' timeoutMs=' + d.timeoutMs + ' packetSize=' + d.packetSize + ' maxHops=' + d.maxHops + ' keepDays=' + d.historyDays));
  assert.equal(meta.slice(meta.indexOf(plain.split('\n')[0])), plain, 'everything after the header is the unchanged default export');
});

test('exportJson: spec §11 envelope with effective config (shape goldens are pt7\'s job)', () => {
  withSettings({ configs: [{ id: 'c1', name: 'Fast', intervalMs: 500 }] }, () => {
    const t = fixtureTarget(); t.configId = 'c1';
    const o = JSON.parse(S.exportJson(t, 0, false));
    assert.equal(o.app, 'PingTracer');
    assert.equal(o.version, S.APP_VERSION);
    assert.ok(!Number.isNaN(Date.parse(o['exported-at'])), 'exported-at is an ISO timestamp');
    assert.equal(o.target.host, 'test.local');
    assert.equal(o.target.proto, 'tcp');
    assert.equal(o.target.port, 80);
    assert.equal(o.target.config.id, 'c1');
    assert.equal(o.target.config.name, 'Fast');
    assert.equal(o.target.config.intervalMs, 500, 'effective (overridden) value is exported');
    assert.equal(o.target.config.timeoutMs, S.SETTINGS_DEFAULTS.timeoutMs);
    assert.equal(o.hops.length, 2);
    assert.equal(o.hops[0].stats.count, 3);
    assert.equal(o.hops[0].stats.lost, 1);
    assert.ok(!('samples' in o.hops[0]), 'samples are opt-in');
    const withSamples = JSON.parse(S.exportJson(t, 0, true));
    assert.equal(withSamples.hops[0].samples.length, 3);
  });
});
