// Multi-target route tracer (ICMP/TCP/UDP): engine + REST API + static UI. Zero dependencies.
const http = require('http'), fs = require('fs'), path = require('path'), dns = require('dns'), os = require('os');
const { execFile, spawn } = require('child_process');
let sea = null; try { sea = require('node:sea'); if (!sea.isSea()) sea = null; } catch { sea = null; }
// static assets: embedded in the single-file exe, or read from disk in dev
const assetCache = new Map();
const asset = name => { // embedded in the exe (cached), or read from disk in development so edits show up immediately
  if (!sea) return fs.readFileSync(path.join(__dirname, name));
  let b = assetCache.get(name); if (!b) { b = Buffer.from(sea.getRawAsset(name)); assetCache.set(name, b); } return b;
};
const writeIfChanged = (file, buf) => { try { if (fs.existsSync(file) && fs.readFileSync(file).equals(buf)) return; } catch {} fs.writeFileSync(file, buf); };

const argv = process.argv.slice(2), argOf = k => (argv.find(a => a.startsWith(k + '=')) || '').slice(k.length + 1);
const AGENT = argv.includes('--agent'); // remote-agent mode: listens on the network, token-protected
const AGENT_TOKEN = argOf('--token') || process.env.PP_TOKEN || require('crypto').randomBytes(12).toString('hex');
const PORT = +argOf('--port') || +process.env.PORT || (AGENT ? 8766 : 8765);
const APP_VERSION = '1.1.2'; // keep in sync with git tags and CHANGELOG.md

// ---- command-line automation: "PingTracer.exe cli <command> ..." drives a running instance through its local API ----
if (argv[0] === 'cli') {
  const args = argv.slice(1), cmd = args[0], flags = {}, pos = [];
  for (let i = 1; i < args.length; i++) { if (args[i].startsWith('--')) { flags[args[i].slice(2)] = (args[i + 1] && !args[i + 1].startsWith('--')) ? args[++i] : true; } else pos.push(args[i]); }
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}, timeout: 15000 }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => { let j = d; try { j = JSON.parse(d); } catch {} r.statusCode >= 400 ? reject(new Error((j && j.error) || 'HTTP ' + r.statusCode)) : resolve(j); });
    });
    rq.on('error', e => reject(new Error('cannot reach PingTracer on port ' + PORT + ' (is it running?) – ' + e.message))); if (data) rq.write(data); rq.end();
  });
  const out = v => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  const HELP = `PingTracer command line (talks to the running instance)
  cli status                       engine status
  cli list                         open targets
  cli start HOST [--proto tcp|udp --port N --config ID]
  cli get ID [--focus MS]          final-hop statistics
  cli stats ID [--focus MS]        statistics for every hop
  cli timeline ID [--hop N --window MS]
  cli pause|resume|close|reset|reresolve ID|all
  cli export ID --out FILE [--format csv|long|wide|json] [--meta]
  cli routes ID | cli route ID [--at MS]
  cli comments ID | cli comment ID "text" [--hop N]
  cli summaries | cli sessions | cli workspaces | cli configs | cli packettypes | cli interfaces
  cli load-list FILE               start targets from a text file (one per line)
  cli export-list                  print the current target list
  cli guidance                     print the interpretation guides`;
  (async () => {
    const ids = async a => a === 'all' ? (await call('GET', '/api/targets')).map(t => t.id) : [+a];
    switch (cmd) {
      case 'status': out(await call('GET', '/api/info')); break;
      case 'list': out((await call('GET', '/api/targets')).map(t => ({ id: t.id, host: t.host, running: t.running, hops: t.hops.length, proto: t.proto }))); break;
      case 'start': { const pt = flags.port === undefined ? undefined : +flags.port; if (pt !== undefined && !(Number.isInteger(pt) && pt >= 1 && pt <= 65535)) { console.error('error: --port must be a whole number between 1 and 65535'); process.exit(1); } out(await call('POST', '/api/targets', { host: pos[0], proto: flags.proto, port: pt, configId: flags.config })); break; }
      case 'get': { const t = await call('GET', '/api/targets/' + pos[0] + '?focus=' + (flags.focus || 600000)); out({ id: t.id, host: t.host, running: t.running, finalHop: t.hops[t.hops.length - 1] }); break; }
      case 'stats': { const t = await call('GET', '/api/targets/' + pos[0] + '?focus=' + (flags.focus || 600000)); console.log('hop ip name avg min max cur loss% jitter'.split(' ').join('\t')); t.hops.forEach(h => console.log([h.ttl, h.ip || '*', h.name || '', ...['avg', 'min', 'max', 'cur'].map(k => h.stats[k] == null ? '' : h.stats[k].toFixed(1)), h.stats.lossPct.toFixed(1), h.stats.jitter == null ? '' : h.stats.jitter.toFixed(1)].join('\t'))); break; }
      case 'timeline': out(await call('GET', '/api/targets/' + pos[0] + '/samples?hop=' + (flags.hop || '') + '&window=' + (flags.window || 600000))); break;
      case 'pause': case 'resume': case 'close': case 'reset': case 'reresolve':
        for (const id of await ids(pos[0])) await call(cmd === 'close' ? 'DELETE' : 'POST', '/api/targets/' + id + (cmd === 'close' ? '' : '/' + (cmd === 'pause' ? 'stop' : cmd === 'resume' ? 'start' : cmd)), cmd === 'close' ? undefined : {});
        out('ok'); break;
      case 'export': { let txt = await call('GET', '/api/targets/' + pos[0] + '/export?all=1&format=' + (flags.format || 'csv') + (flags.meta ? '&meta=1' : '')); if (typeof txt !== 'string') txt = JSON.stringify(txt, null, 2); if (flags.out) { fs.writeFileSync(flags.out, txt); out('wrote ' + flags.out); } else out(txt); break; }
      case 'routes': out(await call('GET', '/api/targets/' + pos[0] + '/routes')); break;
      case 'route': out(await call('GET', '/api/targets/' + pos[0] + '/route' + (flags.at ? '?at=' + flags.at : ''))); break;
      case 'comments': out(await call('GET', '/api/targets/' + pos[0] + '/comments')); break;
      case 'comment': out(await call('POST', '/api/targets/' + pos[0] + '/comments', { text: pos[1], hop: flags.hop && +flags.hop })); break;
      case 'summaries': out(await call('GET', '/api/summaries')); break;
      case 'sessions': out(await call('GET', '/api/sessions')); break;
      case 'workspaces': out(await call('GET', '/api/workspaces')); break;
      case 'configs': out(await call('GET', '/api/configs')); break;
      case 'packettypes': out(await call('GET', '/api/packettypes')); break;
      case 'interfaces': out(await call('GET', '/api/interfaces')); break;
      case 'load-list': out(await call('POST', '/api/targetlist', { text: fs.readFileSync(pos[0], 'utf8') })); break;
      case 'export-list': out(await call('GET', '/api/targetlist')); break;
      case 'guidance': (await call('GET', '/api/guidance')).forEach(g => console.log('## ' + g.title + '\n' + g.body + '\n')); break;
      default: out(HELP);
    }
  })().then(() => process.exit(0), e => { console.error('error: ' + e.message); process.exit(1); });
  return; // never start the server in CLI mode
}
const BASE = sea ? path.dirname(process.execPath) : __dirname;
// When installed by the setup program (installed.flag next to the exe) user data lives in %LOCALAPPDATA%\PingTracer so upgrades and
// uninstalls never touch it; a portable exe keeps its data folder next to itself.
const INSTALLED = !!sea && fs.existsSync(path.join(BASE, 'installed.flag'));
const WIN = os.platform() === 'win32';
let DATA_DIR = process.env.PP_DATA || (INSTALLED && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'PingTracer', AGENT ? 'data-agent' : 'data') : path.join(BASE, AGENT ? 'data-agent' : 'data'));
let STATE_FILE = path.join(DATA_DIR, 'state.json');
const BACKGROUND = argv.includes('--background'); // started by Windows at logon: stay in the tray, don't open a window
const OPEN = !AGENT && !BACKGROUND && (sea || process.env.PP_OPEN) && !process.env.PP_NO_OPEN; // open the browser when run as the exe
// Spec §12: an unwritable data location (portable exe on a write-protected share, access-denied) must not crash the app.
// Fall back to the per-user local folder, then the temp folder; only exit with a clear message if nothing is writable.
(function ensureDataDir() {
  const local = process.env.LOCALAPPDATA || (WIN ? path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local') : path.join(os.homedir(), '.local', 'share'));
  const tries = [...new Set([DATA_DIR, path.join(local, 'PingTracer', AGENT ? 'data-agent' : 'data'), path.join(os.tmpdir(), 'PingTracer', AGENT ? 'data-agent' : 'data')])];
  for (const d of tries) {
    try { fs.mkdirSync(d, { recursive: true }); if (d !== DATA_DIR) { DATA_DIR = d; STATE_FILE = path.join(d, 'state.json'); console.error('data folder is not writable; using ' + d); } return; } catch {}
  }
  console.error('PingTracer cannot create its data folder (' + DATA_DIR + '). Check folder permissions and start again.');
  process.exit(1);
})();

// ---- settings validation (spec §12): every numeric setting has a hard range. A corrupt or hand-edited state.json
// must never leave the engine in an invalid state, so these bounds are applied when state.json loads and again
// before every save. Out-of-range values clamp; non-numeric values fall back to the built-in default. ----
const SETTINGS_DEFAULTS = { historyDays: 30, intervalMs: 2500, timeoutMs: 2000, packetSize: 56, maxHops: 30, maxSamples: 20000 };
const settings = { ...SETTINGS_DEFAULTS, alertRules: [], hostNames: {} };
const NUM_RANGE = { historyDays: [1, 3650], intervalMs: [250, 3600000], timeoutMs: [200, 10000], packetSize: [0, 1400], maxHops: [1, 64], maxSamples: [100, 200000] };
const CFG_RANGE = { intervalMs: [250, 3600000], timeoutMs: [200, 10000], packetSize: [0, 1400], maxHops: [1, 64], keepDays: [1, 3650] };
// null, booleans, objects and non-numeric strings are "not a number" (fall back to the default); real numbers clamp
const toNum = v => (v == null || typeof v === 'boolean' || typeof v === 'object') ? NaN : +v;
const clampNum = (v, [lo, hi], dflt) => { const n = toNum(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
function clampCfg(c) { // named configurations may override only some fields; a garbage override is dropped (falls back to Settings)
  for (const [k, r] of Object.entries(CFG_RANGE)) { if (c[k] == null || c[k] === '') continue; const n = toNum(c[k]); if (Number.isFinite(n)) c[k] = Math.max(r[0], Math.min(r[1], n)); else delete c[k]; } }
function clampSettings() {
  for (const [k, r] of Object.entries(NUM_RANGE)) settings[k] = clampNum(settings[k], r, SETTINGS_DEFAULTS[k]);
  settings.alertRules = Array.isArray(settings.alertRules) ? sanitizeRules(settings.alertRules) : [];
  settings.hostNames = sanitizeNames(settings.hostNames);
  if (!['auto', '4', '6'].includes(String(settings.ipVersion))) delete settings.ipVersion;
  if (settings.openMode !== 'app' && settings.openMode !== 'browser') delete settings.openMode;
  if (settings.configs != null) { settings.configs = (Array.isArray(settings.configs) ? settings.configs : []).filter(c => c && typeof c === 'object'); for (const c of settings.configs) clampCfg(c); }
  if (settings.web != null) { if (typeof settings.web !== 'object') delete settings.web; else if (settings.web.port != null) settings.web.port = clampNum(settings.web.port, [1024, 65535], 8767); }
  if (settings.smtp != null) { if (typeof settings.smtp !== 'object') delete settings.smtp; else if (settings.smtp.port != null) settings.smtp.port = clampNum(settings.smtp.port, [1, 65535], 25); }
  for (const k of ['summaries', 'liveShares', 'webUsers']) if (settings[k] != null && !Array.isArray(settings[k])) delete settings[k];
}
let targets = []; // {id,host,ip,name,hops:[{ttl,ip,name,samples:[{t,ms|null}]}],finalTtl,running,count,startedAt,hidden:[]}
let nextId = 1;

// ---- long-term history in SQLite (node:sqlite). Memory keeps the recent samples; the DB keeps everything for historyDays. ----
let db = null, dbIns = null; const dbQueue = []; const dbCache = new Map();
function openDb() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(path.join(DATA_DIR, 'history.db'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS samples(tid INTEGER NOT NULL, ttl INTEGER NOT NULL, t INTEGER NOT NULL, ms REAL); CREATE INDEX IF NOT EXISTS samples_i ON samples(tid, ttl, t);');
    dbIns = db.prepare('INSERT INTO samples(tid,ttl,t,ms) VALUES(?,?,?,?)');
    setInterval(dbFlush, 2000); setInterval(dbPurge, 3600000); dbPurge();
  } catch (e) { db = null; console.error('history database unavailable:', e.message); }
}
const histAdd = (tid, ttl, t, ms) => { if (db) dbQueue.push([tid, ttl, t, ms]); };
function dbFlush() {
  if (!db || !dbQueue.length) return;
  try { db.exec('BEGIN'); for (const r of dbQueue.splice(0)) dbIns.run(r[0], r[1], r[2], r[3]); db.exec('COMMIT'); } catch { try { db.exec('ROLLBACK'); } catch {} }
}
function dbPurge() {
  if (!db) return;
  try {
    const del = db.prepare('DELETE FROM samples WHERE t < ?'); del.run(Date.now() - (settings.historyDays || 30) * 86400000);
    const per = db.prepare('DELETE FROM samples WHERE tid = ? AND t < ?'); // a configuration can keep less history than the default
    for (const t of targets) { const k = cfgOf(t).keepDays; if (k && k < (settings.historyDays || 30)) per.run(t.id, Date.now() - k * 86400000); }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // keep the write-ahead log from growing
  } catch {}
}
const dbDelete = tid => { if (db) { dbFlush(); try { db.prepare('DELETE FROM samples WHERE tid = ?').run(tid); } catch {} dbCache.clear(); } };
function dbHydrate(t) { // reload recent samples after a restart
  if (!db) return;
  try {
    const rows = db.prepare('SELECT ttl,t,ms FROM samples WHERE tid=? AND t>=? ORDER BY t').all(t.id, Date.now() - 86400000);
    if (!rows.length) return;
    const by = new Map(t.hops.map(h => [h.ttl, h])); for (const h of t.hops) h.samples = [];
    for (const r of rows) { let h = by.get(r.ttl); if (!h) { h = { ttl: r.ttl, ip: '', name: '', samples: [] }; by.set(r.ttl, h); t.hops.push(h); } h.samples.push({ t: r.t, ms: r.ms }); }
    t.hops.sort((a, b) => a.ttl - b.ttl); for (const h of t.hops) if (h.samples.length > settings.maxSamples) h.samples.splice(0, h.samples.length - settings.maxSamples);
  } catch {}
}
function dbBuckets(tid, ttl, from, to, n) {
  dbFlush(); const step = Math.max(1000, Math.ceil((to - from) / n));
  const rows = db.prepare('SELECT CAST((t-?)/? AS INTEGER) b, COUNT(*) n, SUM(ms IS NULL) lost, AVG(ms) a, MIN(ms) mn, MAX(ms) mx FROM samples WHERE tid=? AND ttl=? AND t>=? AND t<=? GROUP BY b ORDER BY b').all(from, step, tid, ttl, from, to);
  return { step, buckets: rows.map(r => ({ t: from + r.b * step + step / 2, n: r.n, lost: r.lost, avg: r.a, min: r.mn, max: r.mx })) };
}
function dbStats(tid, ttl, since) { // cached aggregate over [since, now] for focus ranges longer than the in-memory window
  const key = tid + ':' + ttl + ':' + since, c = dbCache.get(key); if (c && Date.now() - c.at < 30000) return c.v;
  dbFlush(); let v = null;
  try { const r = db.prepare('SELECT COUNT(*) n, SUM(ms IS NULL) lost, AVG(ms) a, MIN(ms) mn, MAX(ms) mx FROM samples WHERE tid=? AND ttl=? AND t>=?').get(tid, ttl, Date.now() - since); if (r.n) v = r; } catch {}
  dbCache.set(key, { at: Date.now(), v }); if (dbCache.size > 5000) dbCache.clear(); return v;
}
const PERSIST_SAMPLES = 500; // state.json keeps only a short tail per hop when the DB holds the full history
let sessions = []; // closed targets kept as stored sessions (their samples stay in the history DB)
const stateObj = () => ({ settings, nextId, sessions, targets: persistable() });
const persistable = () => targets.filter(t => !t.adhoc).map(({ timer, busy, agentError, ...t }) => db ? { ...t, hops: t.hops.map(h => ({ ttl: h.ttl, ip: h.ip, name: h.name, samples: h.samples.slice(-PERSIST_SAMPLES) })) } : t);

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    Object.assign(settings, s.settings || {});
    clampSettings(); // a corrupt or hand-edited state.json can never leave the engine in an invalid state (spec §12)
    // restored targets must be structurally sane: bad hosts/ids would crash later paths (sessions, summaries, views)
    targets = (Array.isArray(s.targets) ? s.targets : []).filter(t => t && typeof t === 'object' && validHost(t.host) && Number.isFinite(+t.id) && +t.id > 0)
      .map(t => ({ ...t, id: Math.floor(+t.id), hops: (Array.isArray(t.hops) ? t.hops : []).filter(h => h && typeof h === 'object').map(h => ({ ...h, samples: Array.isArray(h.samples) ? h.samples : [] })), running: false, timer: null }));
    nextId = Number.isFinite(+s.nextId) && +s.nextId > 0 ? Math.floor(+s.nextId) : 1;
    for (const t of targets) if (t.id >= nextId) nextId = t.id + 1;
    sessions = Array.isArray(s.sessions) ? s.sessions : [];
    // restored targets start at staggered times so their rounds don't all fire in the same instant
    targets.forEach((t, i) => { dbHydrate(t); if (t.autostart) setTimeout(() => { if (targets.includes(t)) start(t); }, i * Math.floor(cfgOf(t).intervalMs / Math.max(1, targets.length))); });
  } catch { /* first run */ }
}
let lastSaved = '', saveErrorShown = false;
function save() { const j = JSON.stringify(stateObj()); if (j === lastSaved) return; lastSaved = j; fs.writeFile(STATE_FILE, j, e => { if (e && !saveErrorShown) { saveErrorShown = true; console.error('cannot write ' + STATE_FILE + ': ' + e.message); } else if (!e) saveErrorShown = false; }); } // access-denied is logged once, never crashes the app
setInterval(save, 10000).unref(); // autosave; unref so requiring this module (tests) doesn't hold the event loop open
process.on('SIGINT', () => { saveSync(); process.exit(); });
function saveSync() { try { dbFlush(); fs.writeFileSync(STATE_FILE, JSON.stringify(stateObj())); } catch {} }

// ---- probe engine ----
// Preferred: persistent C# helper (real RTTs for TTL-expired replies). Fallback: system ping.
let helper = null, helperReady = false, hid = 0, hbuf = '';
const hpending = new Map();
function startHelper() {
  const custom = process.env.PP_HELPER; // test/dev hook: swap in another helper; a .js file runs under this node binary
  if (!WIN && !custom) return;
  try {
    let exe = path.join(BASE, 'helper', 'pphelper.exe'), args = [];
    if (custom) { if (custom.endsWith('.js')) { args = [custom]; exe = process.execPath; } else exe = custom; }
    else if (sea) { exe = path.join(DATA_DIR, 'pphelper.exe'); writeIfChanged(exe, asset('helper/pphelper.exe')); }
    if (!fs.existsSync(exe)) return;
    helper = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    helper.stdout.on('data', d => {
      hbuf += d; let i;
      while ((i = hbuf.indexOf('\n')) >= 0) {
        const parts = hbuf.slice(0, i).trim().split(' '); hbuf = hbuf.slice(i + 1);
        if (parts[0] === 'S') { // DPAPI reply: S <id> <base64> | S <id> !
          const cb = hpending.get('S' + parts[1]); if (cb) { hpending.delete('S' + parts[1]); cb(parts[2] && parts[2] !== '!' ? parts[2] : null); }
          continue;
        }
        if (parts[0] === 'M') { // mail reply: M <id> ok | M <id> err <b64 message>
          const cb = hpending.get('M' + parts[1]); if (cb) { hpending.delete('M' + parts[1]); cb({ ok: parts[2] === 'ok', error: parts[3] ? Buffer.from(parts[3], 'base64').toString() : '' }); }
          continue;
        }
        const [id, st, ip, ms] = parts;
        const cb = hpending.get(id); if (cb) { hpending.delete(id); cb({ st, ip: ip === '-' ? null : ip, ms: +ms }); }
      }
    });
    helper.on('exit', () => { helper = null; helperReady = false; for (const cb of hpending.values()) cb(null); hpending.clear(); });
    helper.stdin.on('error', () => {});
    helperReady = true;
  } catch { helperReady = false; }
}
function helperProbe(host, ttl, timeoutMs, size) {
  return new Promise(resolve => {
    const id = String(++hid); hpending.set(id, resolve);
    helper.stdin.write(`${id} ${host} ${ttl} ${timeoutMs} ${size ?? settings.packetSize}\n`);
    setTimeout(() => { if (hpending.delete(id)) resolve(null); }, timeoutMs + 3000);
  });
}
// ---- email (SMTP via the helper's .NET client) ----
// Secrets at rest: the SMTP password is encrypted with Windows DPAPI (bound to this user account) through the native helper.
function dpapi(op, base64) { // op 'E' encrypts, 'X' decrypts; resolves to base64 text or null
  if (!helperReady) return Promise.resolve(null);
  return new Promise(resolve => { const id = String(++hid); hpending.set('S' + id, resolve); helper.stdin.write(op + ' ' + id + ' ' + base64 + '\n'); setTimeout(() => { if (hpending.delete('S' + id)) resolve(null); }, 8000); });
}
const encryptSecret = async text => text ? dpapi('E', Buffer.from(text, 'utf8').toString('base64')) : null;
const decryptSecret = async enc => { const r = enc ? await dpapi('X', enc) : null; return r ? Buffer.from(r, 'base64').toString('utf8') : ''; };
async function migrateSecrets() { // a password saved by an earlier version in plain text gets encrypted on first start
  const m = settings.smtp; if (!m || !m.pass || m.passEnc) return;
  const enc = await encryptSecret(m.pass); if (enc) { m.passEnc = enc; m.pass = ''; save(); }
}
async function sendMail(subject, body) {
  const s = settings.smtp || {};
  if (!helperReady) return { ok: false, error: 'email needs the native helper (Windows)' };
  if (!s.host || !s.to || !s.from) return { ok: false, error: 'SMTP host, from and to must be set in Settings' };
  const pw = s.passEnc ? await decryptSecret(s.passEnc) : (s.pass || '');
  const b = x => Buffer.from(String(x ?? ''), 'utf8').toString('base64');
  return new Promise(resolve => {
    const id = String(++hid);
    hpending.set('M' + id, resolve);
    helper.stdin.write(`M ${id} ${b(s.host)} ${b(s.port || 25)} ${b(s.ssl ? '1' : '0')} ${b(s.user)} ${b(pw)} ${b(s.from)} ${b(s.to)} ${b(subject)} ${b(body)}\n`);
    setTimeout(() => { if (hpending.delete('M' + id)) resolve({ ok: false, error: 'timeout' }); }, 30000);
  });
}

// ---- start with Windows: per-user Run key (no admin needed). Only meaningful for the packaged exe. ----
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const regRun = args => new Promise(r => execFile('reg', args, { windowsHide: true, timeout: 10000 }, (e, so) => r({ ok: !e, out: String(so || '') })));
async function autostartState() { if (!WIN || !sea) return false; const r = await regRun(['query', RUN_KEY, '/v', 'PingTracer']); return r.ok && r.out.includes(process.execPath); }
async function setAutostart(on) {
  if (!WIN) return 'only available on Windows';
  if (!sea) return 'only available in the packaged PingTracer.exe';
  const r = on ? await regRun(['add', RUN_KEY, '/v', 'PingTracer', '/t', 'REG_SZ', '/d', `"${process.execPath}" --background`, '/f']) : await regRun(['delete', RUN_KEY, '/v', 'PingTracer', '/f']);
  return r.ok || !on ? null : 'could not write the Run registry key';
}

// ---- open the GUI: its own app window (Edge/Chrome --app mode, no tabs or address bar) or the default browser ----
function openUi(done) {
  const url = `http://127.0.0.1:${PORT}`, cb = done || (() => {});
  if (settings.openMode !== 'browser' && WIN) {
    const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    const cands = pf.flatMap(b => [path.join(b, 'Microsoft/Edge/Application/msedge.exe'), path.join(b, 'Google/Chrome/Application/chrome.exe')]);
    const exe = cands.find(f => fs.existsSync(f));
    if (exe) {
      try { // dedicated profile so this is a separate window/process and never touches the user's browser sessions
        const c = spawn(exe, [`--app=${url}`, `--user-data-dir=${path.join(DATA_DIR, 'window-profile')}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,820'], { detached: true, stdio: 'ignore', windowsHide: false });
        c.unref(); return cb();
      } catch {}
    }
  }
  execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => cb());
}

// ---- system tray (Windows exe): hides the console, shows alerts as balloons, menu Open/Pause/Quit ----
let tray = null, lastApiHit = Date.now();
function startTray() {
  if (!WIN || AGENT || !(sea || process.env.PP_TRAY)) return;
  try {
    let exe = path.join(BASE, 'helper', 'pptray.exe');
    if (sea) { exe = path.join(DATA_DIR, 'pptray.exe'); writeIfChanged(exe, asset('helper/pptray.exe')); }
    if (!fs.existsSync(exe)) return;
    tray = spawn(exe, [String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    tray.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const ev = buf.slice(0, i).trim(); buf = buf.slice(i + 1); trayEvent(ev); } });
    tray.stdin.on('error', () => {});
    tray.on('exit', () => { tray = null; });
    setInterval(updateTrayTip, 5000);
  } catch { tray = null; }
}
function trayEvent(ev) {
  if (ev === 'open') openUi();
  else if (ev === 'pause') targets.forEach(stop);
  else if (ev === 'resume') targets.forEach(start);
  else if (ev === 'quit') { saveSync(); process.exit(0); }
}
function trayWrite(s) { try { tray && tray.stdin.write(s.replace(/[\r\n]+/g, ' ') + '\n'); } catch {} }
function updateTrayTip() {
  const running = targets.filter(t => t.running).length;
  const worst = targets.map(t => t.hops[t.hops.length - 1]).filter(Boolean).map(h => stats(h, 60000)).sort((a, b) => b.lossPct - a.lossPct)[0];
  trayWrite(`tip PingTracer: ${running}/${targets.length} running` + (worst && worst.avg != null ? `, ${worst.avg.toFixed(0)}ms ${worst.lossPct.toFixed(0)}% loss` : ''));
}

function helperProto(kind, host, port, timeoutMs, size, ttl) {
  return new Promise(resolve => {
    const id = String(++hid); hpending.set(id, resolve);
    helper.stdin.write(`${kind === 'tcp' ? 'T' : 'U'} ${id} ${host} ${port} ${timeoutMs} ${ttl} ${size ?? settings.packetSize}\n`);
    setTimeout(() => { if (hpending.delete(id)) resolve(null); }, timeoutMs + 3000);
  });
}
async function probe(host, ttl, timeoutMs, size) {
  if (helperReady) {
    const r = await helperProbe(host, ttl, timeoutMs, size);
    if (r) return r.st === 'ok' || r.st === 'ttl' ? { ip: r.ip, ms: r.ms, final: r.st === 'ok' } : { ip: null, ms: null, final: false };
  }
  return pingProbe(host, ttl, timeoutMs);
}
function pingProbe(host, ttl, timeoutMs) {
  const args = WIN ? ['-n', '1', '-w', String(timeoutMs), '-i', String(ttl), host]
                   : ['-n', '-c', '1', '-W', String(Math.ceil(timeoutMs / 1000)), '-t', String(ttl), host];
  return new Promise(resolve => {
    const t0 = process.hrtime.bigint();
    execFile('ping', args, { timeout: timeoutMs + 3000, windowsHide: true }, (err, stdout) => {
      const wall = Number(process.hrtime.bigint() - t0) / 1e6;
      const out = String(stdout || '');
      const from = out.match(/(?:Reply from|From)\s+(\d{1,3}(?:\.\d{1,3}){3})/i) || out.match(/from\s+(\d{1,3}(?:\.\d{1,3}){3})/i);
      if (!from) return resolve({ ip: null, ms: null, final: false });
      const tm = out.match(/time[=<]\s*([\d.]+)\s*ms/i);
      const expired = /TTL expired|Time to live exceeded/i.test(out);
      const unreach = /unreachable/i.test(out);
      let ms = tm ? (/time</i.test(out) && !/time=/i.test(out) ? 0.5 : parseFloat(tm[1])) : (expired || unreach ? Math.max(0.5, Math.round((wall - overhead) * 10) / 10) : null);
      resolve({ ip: from[1], ms, final: !expired && !unreach && !!tm });
    });
  });
}
// ping.exe gives no RTT for TTL-expired replies, so wall time is used minus measured process overhead (loopback calibration)
let overhead = 40;
async function calibrate() {
  const args = WIN ? ['-n', '1', '-w', '500', '127.0.0.1'] : ['-n', '-c', '1', '-W', '1', '127.0.0.1'];
  const t0 = process.hrtime.bigint();
  await new Promise(r => execFile('ping', args, { windowsHide: true }, () => r()));
  const w = Number(process.hrtime.bigint() - t0) / 1e6;
  overhead = overhead * 0.7 + w * 0.3;
}
const nameCache = new Map();
function rdns(ip) {
  if (!ip) return Promise.resolve('');
  if (settings.hostNames[ip]) return Promise.resolve(settings.hostNames[ip]);
  if (nameCache.has(ip)) return Promise.resolve(nameCache.get(ip));
  return new Promise(r => dns.reverse(ip, (e, n) => { const v = e || !n.length ? '' : n[0]; nameCache.set(ip, v); if (nameCache.size > 5000) nameCache.delete(nameCache.keys().next().value); r(v); })); // bounded: a LAN scan or hostile target set must not grow it without limit
}

// ---- configurations: named presets (interval, timeout, packet size, max hops, history retention). Targets without one use the defaults in Settings. ----
function cfgOf(t) {
  const base = { intervalMs: settings.intervalMs, timeoutMs: settings.timeoutMs, packetSize: settings.packetSize, maxHops: settings.maxHops, keepDays: settings.historyDays };
  const c = (settings.configs || []).find(x => x.id === t.configId);
  if (c) for (const k of Object.keys(base)) if (c[k] != null && c[k] !== '') base[k] = c[k];
  return base;
}
// ---- route change tracking: remembers each time the sequence of responding hops changes ----
function trackRoute(t, now) {
  if (!t.finalTtl) return;
  const sig = t.hops.map(h => h.ip || '');
  const last = t.routes && t.routes[t.routes.length - 1];
  if (!last) { (t.routes = t.routes || []).push({ t: now, hops: sig.map((ip, i) => ({ ttl: i + 1, ip })) }); return; }
  const prev = last.hops.map(h => h.ip);
  // a change = a hop position answered from a different address, or the path length changed; silent hops are not changes
  const changed = prev.length !== sig.length || sig.some((ip, i) => ip && prev[i] && ip !== prev[i]);
  if (changed) { t.routes.push({ t: now, hops: sig.map((ip, i) => ({ ttl: i + 1, ip: ip || (prev[i] || '') })) }); if (t.routes.length > 300) t.routes.shift(); }
  else sig.forEach((ip, i) => { if (ip && !prev[i]) last.hops[i].ip = ip; });
}
// ---- TCP/UDP route-tracing classifiers (pure functions; unit-tested in tests/pt4-tcp-route-tracing.test.js) ----
// Protocol-level path length: the smallest TTL at which the destination itself answers the protocol. A completed
// TCP handshake ('ok' = port open) and an RST ('refused' = port closed) both prove the probe reached the
// destination within that TTL; timeouts at lower TTLs are ICMP Time Exceeded en route (invisible to user-mode
// sockets) or a filtered port, and never prove anything about the destination.
function protocolFinalTtl(prs) {
  const reached = prs.filter(x => x.r && (x.r.st === 'ok' || x.r.st === 'refused'));
  return reached.length ? Math.min(...reached.map(x => x.ttl)) : null;
}
// Destination state from the protocol probe at the final TTL: open vs refused (RST) vs filtered (no response)
// vs network unreachable. A filtered port is never reported as "offline" - it only proves the port does not answer.
function classifyDestState(r) {
  if (!r) return 'unknown';
  if (r.st === 'ok') return 'open';
  if (r.st === 'refused') return 'refused';
  if (r.st === 'unreach') return 'unreachable';
  if (r.st === 'timeout') return 'filtered';
  return 'error';
}
async function runRound(t) {
  if (t.busy) return;
  t.busy = true;
  const cfg = cfgOf(t);
  const upto = t.finalTtl ? t.finalTtl : cfg.maxHops;
  let ttls = t.mode === 'final' && t.finalTtl ? [t.finalTtl] : Array.from({ length: upto }, (_, i) => i + 1);
  if (!helperReady) await calibrate();
  // TCP/UDP route tracing: TTL-limited protocol probes determine the path length and the destination state
  // (connection succeeded / connection refused / no response). While the path is unknown the protocol probes run
  // at every TTL; once the final TTL is known only the destination is probed with the protocol. Intermediate hop
  // addresses are attributed with the ICMP probes: Windows user-mode TCP/UDP sockets cannot report which router
  // sent an ICMP Time Exceeded. Needs the native helper; without it these targets fall back to ICMP.
  const px = (t.proto === 'tcp' || t.proto === 'udp') && helperReady;
  const pxTtl = px ? (t.finalTtl ? [t.finalTtl] : ttls) : [];
  const pxP = pxTtl.map(ttl => ({ ttl, p: helperProto(t.proto, t.ip || t.host, t.port || (t.proto === 'tcp' ? 443 : 53), cfg.timeoutMs, cfg.packetSize, ttl) }));
  // Spread the round's probes out (up to 20 ms apart, within 40% of the interval) instead of firing every hop at once:
  // home routers rate-limit ICMP replies, and simultaneous bursts showed up as false packet loss on the first hops.
  const spacing = Math.min(20, Math.floor(cfg.intervalMs * 0.4 / Math.max(1, ttls.length)));
  const results = await Promise.all(ttls.map(async (ttl, i) => {
    if (i && spacing) await new Promise(r => setTimeout(r, i * spacing));
    return { ttl, r: await probe(t.ip || t.host, ttl, cfg.timeoutMs, cfg.packetSize) };
  }));
  if (px) {
    const prs = []; for (const x of pxP) prs.push({ ttl: x.ttl, r: await x.p });
    // the smallest TTL at which the destination answers the protocol is the protocol-level path length
    const finProto = protocolFinalTtl(prs);
    const at = finProto != null ? finProto : t.finalTtl;
    const dest = at != null ? prs.find(x => x.ttl === at) : null;
    t.destState = classifyDestState(dest && dest.r);
    if (at != null) {
      const hit = prs.find(x => x.ttl === at && x.r && (x.r.st === 'ok' || x.r.st === 'refused'));
      if (hit) { // the protocol probe carries the real destination RTT; ICMP results only attribute the hop
        const i = results.findIndex(x => x.ttl === at), fr = { ip: t.ip || t.host, ms: hit.r.ms, final: true };
        if (i >= 0) results[i].r = { ...results[i].r, ...fr }; else results.push({ ttl: at, r: fr });
      }
    }
  }
  const now = Date.now();
  let fin = t.finalTtl;
  for (const { ttl, r } of results.sort((a, b) => a.ttl - b.ttl)) {
    if (r.final && (!fin || ttl < fin)) fin = ttl;
  }
  // when discovering, drop hops beyond final
  if (fin) t.finalTtl = fin;
  for (const { ttl, r } of results) {
    if (t.finalTtl && ttl > t.finalTtl) continue;
    let h = t.hops.find(h => h.ttl === ttl);
    if (!h) { h = { ttl, ip: '', name: '', samples: [] }; t.hops.push(h); t.hops.sort((a, b) => a.ttl - b.ttl); }
    if (r.ip && r.ip !== h.ip) { h.ip = r.ip; h.name = await rdns(r.ip); }
    h.samples.push({ t: now, ms: r.ms }); histAdd(t.id, ttl, now, r.ms);
    if (h.samples.length > settings.maxSamples) h.samples.shift();
  }
  if (t.finalTtl) t.hops = t.hops.filter(h => h.ttl <= t.finalTtl);
  trackRoute(t, now);
  t.count = (t.count || 0) + 1;
  t.busy = false;
  checkAlerts(t);
}

// ---- remote agents: a target with t.agent {url,token,rid} is traced by another instance running in --agent mode ----
function agentFetch(t, p, method = 'GET', body) {
  const a = t.agent, url = new URL(a.url.replace(/\/+$/, '') + p);
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? require('https') : http;
    const data = body ? JSON.stringify(body) : null;
    const rq = lib.request(url, { method, timeout: 8000, headers: { 'x-pp-token': a.token || '', ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { let j; try { j = JSON.parse(d); } catch { j = d; } r.statusCode >= 400 ? reject(new Error((j && j.error) || 'agent error ' + r.statusCode)) : resolve(j); });
    });
    rq.on('error', reject); rq.on('timeout', () => rq.destroy(new Error('agent timeout')));
    if (data) rq.write(data); rq.end();
  });
}
async function pullAgent(t) {
  if (!t.agent.rid) {
    const c = await agentFetch(t, '/api/targets', 'POST', { host: t.host, proto: t.proto, port: t.port });
    t.agent.rid = c.id; t.agent.since = 0;
  }
  const raw = await agentFetch(t, `/api/targets/${t.agent.rid}/raw?since=${t.agent.since || 0}`);
  for (const rh of raw.hops) {
    let h = t.hops.find(x => x.ttl === rh.ttl);
    if (!h) { h = { ttl: rh.ttl, ip: '', name: '', samples: [] }; t.hops.push(h); t.hops.sort((a, b) => a.ttl - b.ttl); }
    h.ip = rh.ip; h.name = rh.name;
    for (const s of rh.samples) { h.samples.push({ t: +s.t, ms: s.ms == null ? null : +s.ms }); histAdd(t.id, rh.ttl, +s.t, s.ms == null ? null : +s.ms); t.agent.since = Math.max(t.agent.since || 0, +s.t); }
    if (h.samples.length > settings.maxSamples) h.samples.splice(0, h.samples.length - settings.maxSamples);
  }
  t.finalTtl = raw.finalTtl; t.count = raw.count; t.ip = raw.ip || t.ip;
  if (t.finalTtl) t.hops = t.hops.filter(h => h.ttl <= t.finalTtl);
  t.agentError = null;
  checkAlerts(t);
}

function start(t) {
  if (t.running) return;
  t.running = true; t.autostart = true;
  if (!t.startedAt) t.startedAt = Date.now();
  const tick = async () => {
    if (!t.running) return;
    const t0 = Date.now();
    try { t.agent ? await pullAgent(t) : await runRound(t); } catch (e) { t.busy = false; if (t.agent) t.agentError = String(e.message || e); }
    t.timer = setTimeout(tick, Math.max(50, cfgOf(t).intervalMs - (Date.now() - t0)));
  };
  tick();
}
function stop(t) { t.running = false; t.autostart = false; clearTimeout(t.timer); }

// ---- stats ----
function stats(h, sinceMs) {
  // One allocation-free pass over the samples (sorted by time) with a binary search for the window start, cached per hop+window
  // until a new sample arrives. (The old version copied arrays and spread them into Math.min/max, which could throw on big histories.)
  const S = h.samples, len = S.length, lastT = len ? S[len - 1].t : 0, now = Date.now();
  if (!h._c) Object.defineProperty(h, '_c', { value: new Map(), writable: true, enumerable: false, configurable: true }); // never serialized
  const cache = h._c, key = sinceMs || 0, ent = cache.get(key);
  if (ent && ent.n === len && ent.l === lastT && (!sinceMs || now - ent.at < 1000)) return ent.v;
  let i0 = 0;
  if (sinceMs) { const lim = now - sinceMs; let lo = 0, hi = len; while (lo < hi) { const mid = (lo + hi) >> 1; if (S[mid].t >= lim) hi = mid; else lo = mid + 1; } i0 = lo; }
  const n = len - i0; let okc = 0, sum = 0, mn = Infinity, mx = -Infinity, jsum = 0, prev = null;
  for (let i = i0; i < len; i++) { const v = S[i].ms; if (v == null) continue; okc++; sum += v; if (v < mn) mn = v; if (v > mx) mx = v; if (prev != null) jsum += Math.abs(v - prev); prev = v; }
  const lost = n - okc, avg = okc ? sum / okc : null, jitter = okc > 1 ? jsum / (okc - 1) : null;
  const v = { count: n, lost, lossPct: n ? lost / n * 100 : 0, avg, min: okc ? mn : null, max: okc ? mx : null, cur: n ? S[len - 1].ms : null, jitter, mos: mos(avg, jitter, n ? lost / n : 0) };
  cache.set(key, { n: len, l: lastT, at: now, v }); if (cache.size > 8) cache.delete(cache.keys().next().value);
  return v;
}
function mos(avg, jitter, loss) { // E-model approximation
  if (avg == null) return null;
  const eff = avg + (jitter || 0) * 2 + 10;
  let R = eff < 160 ? 93.2 - eff / 40 : 93.2 - (eff - 120) / 10;
  R -= loss * 250;
  R = Math.max(0, Math.min(100, R));
  return Math.max(1, Math.min(4.5, 1 + 0.035 * R + R * (R - 60) * (100 - R) * 7e-6));
}
function view(t, focusMs, rng) {
  return { id: t.id, host: t.host, ip: t.ip, name: t.name, running: !!t.running, count: t.count || 0, finalTtl: t.finalTtl || null, startedAt: t.startedAt,
    agent: t.agent ? { url: t.agent.url, error: t.agentError || null } : null, proto: t.proto || 'icmp', port: t.port || null, destState: t.destState || null, configId: t.configId || null, adhoc: !!t.adhoc, followIp: !!t.followIp, routeChanges: Math.max(0, (t.routes || []).length - 1), comments: (t.comments || []).length, customCols: t.customCols || {},
    hops: t.hops.map(h => {
      let st = rng ? statsRange(t, h, rng.from, rng.to) : stats(h, focusMs);
      if (!rng && db && focusMs && h.samples.length && h.samples[0].t > Date.now() - focusMs + 5000) { // focus window longer than what memory holds: use the history DB
        const d = dbStats(t.id, h.ttl, focusMs);
        if (d && d.n > st.count) { const lost = d.lost || 0; st = { ...st, count: d.n, lost, lossPct: lost / d.n * 100, avg: d.a, min: d.mn, max: d.mx, mos: mos(d.a, st.jitter, lost / d.n) }; }
      }
      return { ttl: h.ttl, ip: h.ip, name: settings.hostNames[h.ip] || h.name, stats: st, hidden: (t.hidden || []).includes(h.ttl), ext: extColumns(h, st) }; }) };
}

// ---- extensions: DATA_DIR/extensions/*.js, run in a vm sandbox (no require/process/fs). Each defines
// module.exports = { name, columns:[{id,title,fn(stats,hop)->string|number}], onAlert(event) }
const extensions = [];
function loadExtensions() {
  const dir = path.join(DATA_DIR, 'extensions'); fs.mkdirSync(dir, { recursive: true });
  const sample = path.join(dir, 'example-quality.js');
  if (!fs.readdirSync(dir).length) fs.writeFileSync(sample, `// Example extension: adds a "Quality" column. Only install extensions you trust.
module.exports = {
  name: 'Quality grade',
  columns: [{ id: 'quality', title: 'Quality', fn: (s) => s.avg == null ? '-' : s.lossPct > 5 || s.avg > 200 ? 'Poor' : s.lossPct > 1 || s.avg > 100 ? 'Fair' : 'Good' }],
  onAlert: (ev) => { /* called when an alert fires; return value ignored */ }
};\n`);
  extensions.length = 0;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    try {
      const sb = { module: { exports: {} }, console: { log() {} }, Math, JSON, Date, Number, String, Array, Object };
      require('vm').runInNewContext(fs.readFileSync(path.join(dir, f), 'utf8'), sb, { timeout: 500, filename: f });
      const e = sb.module.exports; if (e && typeof e === 'object') extensions.push({ file: f, name: String(e.name || f), columns: (e.columns || []).filter(c => c && c.id && typeof c.fn === 'function'), onAlert: typeof e.onAlert === 'function' ? e.onAlert : null, error: null });
    } catch (err) { extensions.push({ file: f, name: f, columns: [], onAlert: null, error: String(err.message || err) }); }
  }
}
function extColumns(h, st) {
  const out = {};
  for (const e of extensions) for (const c of e.columns) {
    try { const v = c.fn(JSON.parse(JSON.stringify(st)), { ttl: h.ttl, ip: h.ip, name: h.name }); out[c.id] = v == null ? '' : String(v).slice(0, 40); } catch { out[c.id] = 'err'; }
  }
  return out;
}

// ---- alerts ----
const alertLog = [];
const alertState = new Map();
function checkAlerts(t) {
  for (const rule of settings.alertRules) {
    if (!rule.enabled) continue;
    if (rule.target && rule.target !== t.id && rule.target !== 'all') continue;
    const h = rule.hop === 'final' || !rule.hop ? t.hops[t.hops.length - 1] : t.hops.find(h => h.ttl === +rule.hop);
    if (!h) continue;
    const s = stats(h, (rule.windowSec || 60) * 1000);
    const val = rule.metric === 'loss' ? s.lossPct : rule.metric === 'jitter' ? s.jitter : rule.metric === 'mos' ? s.mos : s.avg;
    if (val == null) continue;
    const hit = rule.metric === 'mos' ? val < rule.threshold : val > rule.threshold;
    const key = rule.id + ':' + t.id, was = alertState.get(key);
    if (hit && !was) {
      alertState.set(key, true);
      const ev = { t: Date.now(), rule: rule.id, target: t.host, message: `${t.host} hop ${h.ttl}: ${rule.metric} ${val.toFixed(1)} ${rule.metric === 'mos' ? '<' : '>'} ${rule.threshold}`, action: rule.action, sound: String(rule.sound || 'beep').slice(0, 20) };
      alertLog.push(ev); if (alertLog.length > 500) alertLog.shift();
      if (rule.action === 'command' && rule.command) execFile(rule.command, [ev.message], { windowsHide: true }, () => {});
      if (settings.trayAlerts !== false) trayWrite('balloon ' + ev.message);
      if (rule.action === 'email') sendMail('[PingTracer] ' + ev.message, `${ev.message}\n\nTime: ${new Date(ev.t).toISOString()}\nTarget: ${t.host}`).then(r => { if (!r.ok) alertLog.push({ t: Date.now(), rule: rule.id, target: t.host, message: 'email failed: ' + r.error, action: 'error' }); });
      if (rule.action === 'webhook' && /^https?:\/\//i.test(rule.command || '')) {
        try { const u = new URL(rule.command), d = JSON.stringify(ev); (u.protocol === 'https:' ? require('https') : http).request(u, { method: 'POST', timeout: 5000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(d) } }, r => r.resume()).on('error', () => {}).end(d); } catch {}
      }
      for (const e of extensions) if (e.onAlert) { try { e.onAlert(JSON.parse(JSON.stringify(ev))); } catch {} }
    } else if (!hit && was) {
      alertState.set(key, false);
      alertLog.push({ t: Date.now(), rule: rule.id, target: t.host, message: `${t.host} recovered`, action: 'recovered' });
    }
  }
}

// ---- export ----
// JSON results export (spec §11): destination, probe method, timestamp and the effective probe configuration.
// Hop stats caches (_c) are non-enumerable, so JSON.stringify never serialises them.
function exportJson(t, focusMs, all) {
  const cfg = cfgOf(t), named = (settings.configs || []).find(c => c.id === t.configId);
  const o = {
    app: 'PingTracer', version: APP_VERSION, 'exported-at': new Date().toISOString(), 'focus-ms': +focusMs || null,
    target: { id: t.id, host: t.host, ip: t.ip || null, name: t.name || t.host, proto: t.proto || 'icmp', port: t.port || null,
      destState: t.destState || null, startedAt: t.startedAt ? new Date(t.startedAt).toISOString() : null, rounds: t.count || 0, finalTtl: t.finalTtl || null,
      config: { id: t.configId || 'default', name: named ? named.name : 'Default', intervalMs: cfg.intervalMs, timeoutMs: cfg.timeoutMs, packetSize: cfg.packetSize, maxHops: cfg.maxHops, keepDays: cfg.keepDays } },
    hops: t.hops.map(h => { const s = stats(h, focusMs);
      const x = { ttl: h.ttl, ip: h.ip || null, name: settings.hostNames[h.ip] || h.name || null,
        stats: { count: s.count, lost: s.lost, lossPct: +s.lossPct.toFixed(2), avgMs: s.avg, minMs: s.min, maxMs: s.max, curMs: s.cur, jitterMs: s.jitter, mos: s.mos } };
      if (all) x.samples = h.samples.map(y => ({ t: new Date(y.t).toISOString(), ms: y.ms }));
      return x; })
  };
  return JSON.stringify(o, null, 2);
}
// Opt-in (#) metadata header for CSV/TSV exports (?meta=1): app, version, export time, destination and effective config.
function exportMeta(t) {
  const cfg = cfgOf(t);
  return ['# app PingTracer', '# version ' + APP_VERSION, '# exported-at ' + new Date().toISOString(),
    '# target host=' + t.host + ' ip=' + (t.ip || '') + ' proto=' + (t.proto || 'icmp') + ' port=' + (t.port || ''),
    '# config id=' + (t.configId || 'default') + ' intervalMs=' + cfg.intervalMs + ' timeoutMs=' + cfg.timeoutMs + ' packetSize=' + cfg.packetSize + ' maxHops=' + cfg.maxHops + ' keepDays=' + cfg.keepDays].join('\n') + '\n';
}
// Without meta the text exports are byte-identical to previous releases (existing consumers parse them).
function exportText(t, fmt, focusMs, all, meta) { const body = exportRows(t, fmt, focusMs, all); return meta ? exportMeta(t) + body : body; }
function exportRows(t, fmt, focusMs, all) {
  const sep = fmt === 'csv' ? ',' : '\t';
  const hops = t.hops;
  if (!all) {
    const rows = [['Hop', 'IP', 'Name', 'Count', 'Lost', 'Loss%', 'Avg', 'Min', 'Max', 'Cur', 'Jitter'].join(sep)];
    for (const h of hops) { const s = stats(h, focusMs); rows.push([h.ttl, h.ip || '*', h.name, s.count, s.lost, s.lossPct.toFixed(1), f(s.avg), f(s.min), f(s.max), f(s.cur), f(s.jitter)].join(sep)); }
    return rows.join('\n');
  }
  const times = [...new Set(hops.flatMap(h => h.samples.map(s => s.t)))].sort();
  const g = (h, tm) => { const s = h.samples.find(x => x.t === tm); return s ? (s.ms == null ? '' : s.ms) : ''; };
  if (fmt === 'wide') { // row per hop, column per sample
    const rows = [['Hop', 'IP', ...times.map(x => new Date(x).toISOString())].join(sep)];
    for (const h of hops) rows.push([h.ttl, h.ip, ...times.map(x => g(h, x))].join(sep));
    return rows.join('\n');
  }
  const rows = [['Time', ...hops.map(h => `Hop ${h.ttl} (${h.ip || '*'})`)].join(sep)];
  for (const x of times) rows.push([new Date(x).toISOString(), ...hops.map(h => g(h, x))].join(sep));
  return rows.join('\n');
}
const f = v => v == null ? '' : (+v).toFixed(1);

// ---- http ----
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin' };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const send = (res, code, body, type = 'application/json') => {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const h = { 'Content-Type': type + (/^(text\/|application\/json)/.test(type) ? '; charset=utf-8' : ''), 'Cache-Control': 'no-store', ...SEC_HEADERS };
  if (type.startsWith('text/html')) h['Content-Security-Policy'] = CSP;
  if (buf.length > 2048 && /\bgzip\b/.test((res.req && res.req.headers['accept-encoding']) || '') && /^(text\/|application\/json|image\/svg)/.test(type)) { buf = require('zlib').gzipSync(buf, { level: 5 }); h['Content-Encoding'] = 'gzip'; h.Vary = 'Accept-Encoding'; }
  h['Content-Length'] = buf.length; res.writeHead(code, h); res.end(buf);
};
const MAX_BODY = 32 * 1024 * 1024, MAX_TARGETS = 64; // request bodies are capped; a sane ceiling on open targets keeps probe load bounded
const readBody = req => new Promise(r => { const chunks = []; let n = 0; req.on('data', c => { n += c.length; if (n > MAX_BODY) { req.destroy(); r({}); } else chunks.push(c); }); req.on('end', () => { try { r(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { r({}); } }); req.on('error', () => r({})); });
const METRICS = ['avg', 'loss', 'jitter', 'mos'], ACTIONS = ['notify', 'command', 'webhook', 'email'];
function sanitizeRules(arr) { // alert rules arrive from the browser: whitelist every field
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 50).map(r => ({ id: String((r && r.id) || newId()).replace(/[^\w\-]/g, '').slice(0, 40) || newId(), enabled: !!(r && r.enabled), metric: METRICS.includes(r && r.metric) ? r.metric : 'avg',
    threshold: Number.isFinite(+(r && r.threshold)) ? +r.threshold : 0, windowSec: Math.max(5, Math.min(86400, +(r && r.windowSec) || 60)),
    hop: (!r || r.hop === undefined || r.hop === '' || r.hop === 'final') ? 'final' : Math.max(1, Math.min(64, (+r.hop) | 0)), action: ACTIONS.includes(r && r.action) ? r.action : 'notify',
    command: String((r && r.command) || '').slice(0, 500), sound: String((r && r.sound) || 'beep').replace(/[^\w]/g, '').slice(0, 20) || 'beep' }));
}
function sanitizeNames(o) { // hop display names: keys must look like IP addresses
  const out = {}; if (!o || typeof o !== 'object') return out; let n = 0;
  for (const [k, v] of Object.entries(o)) { if (n >= 2000) break; if (!/^[0-9a-fA-F:.]{2,45}$/.test(k) || typeof v !== 'string') continue; out[k] = v.slice(0, 100); n++; }
  return out;
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
function importSet(b) { // whitelist fields; imported sets are history only (never agents/running)
  let n = 0;
  for (const t of Array.isArray(b && b.targets) ? b.targets : []) {
    if (!validHost(t.host) || !Array.isArray(t.hops)) continue;
    const hops = t.hops.slice(0, 64).map(h => ({ ttl: +h.ttl | 0, ip: String(h.ip || '').slice(0, 45), name: String(h.name || '').slice(0, 253),
      samples: (Array.isArray(h.samples) ? h.samples : []).slice(-settings.maxSamples).map(s => ({ t: +s.t || 0, ms: s.ms == null ? null : +s.ms })) })).filter(h => h.ttl > 0);
    const nt = { id: nextId++, host: t.host, ip: String(t.ip || t.host), name: String(t.name || t.host).slice(0, 253), hops, finalTtl: +t.finalTtl || null, count: +t.count || 0, running: false, hidden: [] };
    targets.push(nt); for (const h of hops) for (const s of h.samples) histAdd(nt.id, h.ttl, s.t, s.ms);
    n++;
  }
  return n;
}
// resolve a hostname honoring Settings > IP version (auto prefers IPv4, falls back to IPv6)
const lookupIp = host => new Promise(r => {
  if (require('net').isIP(host)) return r(host);
  const fam = settings.ipVersion === '6' ? 6 : settings.ipVersion === '4' ? 4 : 0;
  dns.lookup(host, { family: fam, verbatim: false }, (e, a) => r(e ? null : a));
});
const validHost =h => /^[a-zA-Z0-9]([a-zA-Z0-9.\-_]{0,251}[a-zA-Z0-9])?$/.test(h || '') || /^[0-9a-fA-F:]+$/.test(h || '');
// ports arrive from the UI/CLI: reject anything that isn't a whole number in 1-65535 with a clean 400 instead of
// silently coercing it (spec §12). null/'' means "no port given" (ICMP, or the protocol default); undefined means invalid.
const portOf = v => { if (v == null || v === '') return null; const n = +v; return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined; };
const PORT_ERR = 'invalid port: enter a whole number between 1 and 65535';

// ---- Wi-Fi monitoring (netsh wlan; English-locale output) ----
const kv = text => text.split(/\r?\n/).map(l => /^\s*([^:]+?)\s+:\s(.*)$/.exec(l)).filter(Boolean).map(m => [m[1].trim(), m[2].trim()]);
function parseWlanInterfaces(text) { // -> [{name, state, ssid, bssid, signal, channel, radio, rx, tx, auth, ...}]
  const out = []; let cur = null;
  for (const [k, v] of kv(text)) {
    if (k === 'Name') { cur = { name: v }; out.push(cur); continue; }
    if (!cur) continue;
    const map = { Description: 'description', State: 'state', SSID: 'ssid', BSSID: 'bssid', 'Radio type': 'radio', Authentication: 'auth', Channel: 'channel', Band: 'band', Profile: 'profile' };
    if (map[k]) cur[map[k]] = v;
    else if (k === 'Signal') cur.signal = parseInt(v, 10);
    else if (k.startsWith('Receive rate')) cur.rx = parseFloat(v);
    else if (k.startsWith('Transmit rate')) cur.tx = parseFloat(v);
  }
  return out;
}
function parseWlanNetworks(text) { // -> [{ssid, auth, bssid, signal, radio, band, channel}] one row per BSSID
  const out = []; let ssid = '', auth = '', cur = null;
  for (const [k, v] of kv(text)) {
    if (/^SSID \d+$/.test(k)) { ssid = v; auth = ''; cur = null; }
    else if (k === 'Authentication') auth = v;
    else if (/^BSSID \d+$/.test(k)) { cur = { ssid, auth, bssid: v }; out.push(cur); }
    else if (cur && k === 'Signal') cur.signal = parseInt(v, 10);
    else if (cur && k === 'Radio type') cur.radio = v;
    else if (cur && k === 'Band') cur.band = v;
    else if (cur && k === 'Channel') cur.channel = parseInt(v, 10);
  }
  return out;
}
const wifi = { timer: null, history: [], current: null, error: null, neighbors: [], scanAt: 0 };
const netsh = args => new Promise(r => execFile('netsh', args, { windowsHide: true, timeout: 15000 }, (e, so, se) => r({ err: e ? String(so || se || e.message).trim() : null, out: String(so || '') })));
async function wifiPoll() {
  const r = await netsh(['wlan', 'show', 'interfaces']);
  if (r.err) { wifi.error = r.err.split('\n')[0]; wifi.current = null; return; }
  wifi.error = null;
  const ifc = parseWlanInterfaces(r.out); wifi.current = ifc.find(i => /connected/i.test(i.state || '') && !/dis/i.test(i.state)) || ifc[0] || null;
  if (!ifc.length) wifi.error = 'No wireless interface found';
  if (wifi.current && wifi.current.signal != null) { wifi.history.push({ t: Date.now(), signal: wifi.current.signal, rx: wifi.current.rx || null, tx: wifi.current.tx || null, ssid: wifi.current.ssid || '' }); if (wifi.history.length > 5000) wifi.history.shift(); }
}
function wifiStart() { if (wifi.timer || !WIN) return; wifiPoll(); wifi.timer = setInterval(wifiPoll, 5000); }
function wifiStop() { clearInterval(wifi.timer); wifi.timer = null; }
async function wifiScan() {
  if (Date.now() - wifi.scanAt < 8000) return;
  wifi.scanAt = Date.now(); const r = await netsh(['wlan', 'show', 'networks', 'mode=bssid']);
  if (!r.err) wifi.neighbors = parseWlanNetworks(r.out).sort((a, b) => (b.signal || 0) - (a.signal || 0));
}

// ---- LAN device discovery: ping sweep + ARP table + reverse DNS + SSDP + mDNS, MAC vendor from data/oui.csv ----
const lan = { state: 'idle', progress: 0, started: 0, subnet: '', devices: [], error: null };
let oui = null;
function loadOui() {
  oui = new Map(); const f = path.join(DATA_DIR, 'oui.csv'); if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/).slice(1)) { // IEEE format: Registry,Assignment,"Organization Name","Address"
    const m = /^[^,]*,([0-9A-Fa-f]{6}),("([^"]*)"|[^,]*)/.exec(line); if (m) oui.set(m[1].toUpperCase(), m[3] !== undefined ? m[3] : m[2]);
  }
}
const vendorOf = mac => { if (!oui) loadOui(); const hex = mac.replace(/[^0-9a-f]/gi, '').toUpperCase(); if (parseInt(hex.slice(0, 2), 16) & 2) return '(private / randomized address)'; return oui.get(hex.slice(0, 6)) || (oui.size ? '' : '(vendor database not installed)'); };
function updateOui() { // user-initiated from Settings: fetch the public IEEE registry
  return new Promise((resolve, reject) => require('https').get('https://standards-oui.ieee.org/oui/oui.csv', { timeout: 30000, headers: { 'user-agent': 'PingTracer' } }, r => {
    if (r.statusCode !== 200) { r.resume(); return reject(new Error('IEEE returned HTTP ' + r.statusCode)); }
    const chunks = []; let n = 0; r.on('data', c => { n += c.length; if (n > 20e6) r.destroy(new Error('too large')); else chunks.push(c); });
    r.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); if (!/^Registry,Assignment/.test(t)) return reject(new Error('unexpected file format')); fs.writeFileSync(path.join(DATA_DIR, 'oui.csv'), t); loadOui(); resolve(oui.size); });
  }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); }));
}
const ip2n = ip => ip.split('.').reduce((a, b) => (a * 256 + +b), 0), n2ip = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
function dnsName(buf, off) { // DNS name with compression -> [name, nextOffset]
  const parts = []; let next = -1, jumps = 0;
  while (off < buf.length && jumps < 20) {
    const l = buf[off];
    if (l === 0) { off++; break; }
    if ((l & 0xc0) === 0xc0) { if (next < 0) next = off + 2; off = ((l & 0x3f) << 8) | buf[off + 1]; jumps++; continue; }
    parts.push(buf.toString('utf8', off + 1, off + 1 + l)); off += 1 + l;
  }
  return [parts.join('.'), next < 0 ? off : next];
}
function mdnsPtrNames(buf) {
  const out = []; try {
    const qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10); let off = 12;
    for (let i = 0; i < qd; i++) { off = dnsName(buf, off)[1] + 4; }
    for (let i = 0; i < an && off < buf.length; i++) {
      const [, o2] = dnsName(buf, off); const type = buf.readUInt16BE(o2), rdlen = buf.readUInt16BE(o2 + 8), rd = o2 + 10;
      if (type === 12) out.push(dnsName(buf, rd)[0]);
      off = rd + rdlen;
    }
  } catch {} return out;
}
function listen3s(sendFn, onMsg, ms = 3000) {
  return new Promise(resolve => { const s = require('dgram').createSocket({ type: 'udp4', reuseAddr: true }); s.on('message', onMsg); s.on('error', () => resolve());
    s.bind(0, () => { try { sendFn(s); } catch {} setTimeout(() => { try { s.close(); } catch {} resolve(); }, ms); }); });
}
async function lanScan() {
  if (lan.state === 'scanning') return;
  Object.assign(lan, { state: 'scanning', progress: 0, started: Date.now(), devices: [], error: null });
  try {
    const ifc = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'));
    if (!ifc) throw new Error('no active IPv4 network interface');
    const mask = ip2n(ifc.netmask), me = ip2n(ifc.address); let net = (me & mask) >>> 0, size = (~mask >>> 0) + 1;
    if (size > 1024) { net = (me & 0xffffff00) >>> 0; size = 256; } // clamp huge subnets to the local /24
    lan.subnet = `${n2ip(net)}/${32 - Math.log2(size)}`;
    const ips = []; for (let i = 1; i < size - 1; i++) { const a = n2ip(net + i); if (a !== ifc.address) ips.push(a); }
    const found = new Map(); let done = 0; const side = [];
    side.push(listen3s(s => s.send(Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n'), 1900, '239.255.255.250'),
      (msg, r) => { const h = {}; msg.toString().split(/\r?\n/).forEach(l => { const m = /^([A-Za-z\-]+):\s*(.*)$/.exec(l); if (m) h[m[1].toLowerCase()] = m[2]; }); const d = found.get(r.address) || (found.set(r.address, { ip: r.address }), found.get(r.address));
        d.ssdp = { server: h.server || d.ssdp?.server || '', st: h.st || '', location: h.location || d.ssdp?.location || '' }; }, 4000));
    const q = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), ...'_services._dns-sd._udp.local'.split('.').map(p => Buffer.concat([Buffer.from([p.length]), Buffer.from(p)])), Buffer.from([0, 0, 12, 0x80, 1])]);
    side.push(listen3s(s => s.send(q, 5353, '224.0.0.251'), (msg, r) => { const names = mdnsPtrNames(msg); if (!names.length) return; const d = found.get(r.address) || (found.set(r.address, { ip: r.address }), found.get(r.address)); d.mdns = [...new Set([...(d.mdns || []), ...names])]; }, 4000));
    const cc = 48; let idx = 0; // ping sweep (also fills the ARP cache)
    await Promise.all(Array.from({ length: cc }, async () => {
      while (idx < ips.length) { const ip = ips[idx++]; const r = await probe(ip, 64, 500); if (r && r.ms != null && r.ip === ip) { const d = found.get(ip) || (found.set(ip, { ip }), found.get(ip)); d.rtt = r.ms; } lan.progress = Math.round(++done / ips.length * 85); }
    }));
    await Promise.all(side);
    const arp = await new Promise(r => execFile('arp', ['-a'], { windowsHide: true, timeout: 10000 }, (e, so) => r(String(so || ''))));
    for (const l of arp.split(/\r?\n/)) { const m = /^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s+(dynamic|static)/i.exec(l); if (!m) continue; const n = ip2n(m[1]); if (n <= net || n >= net + size - 1) continue; if (/^(ff-ff|01-00-5e)/i.test(m[2])) continue; const d = found.get(m[1]) || (found.set(m[1], { ip: m[1] }), found.get(m[1])); d.mac = m[2].toUpperCase().replace(/-/g, ':'); }
    const devs = [...found.values()].filter(d => ip2n(d.ip) > net && ip2n(d.ip) < net + size - 1 && (d.mac || d.rtt != null));
    await Promise.all(devs.map(d => new Promise(r => { const t = setTimeout(r, 1500); dns.reverse(d.ip, (e, n) => { clearTimeout(t); if (!e && n && n.length) d.name = n[0]; r(); }); })));
    devs.forEach(d => { d.vendor = d.mac ? vendorOf(d.mac) : ''; });
    lan.devices = devs.sort((a, b) => ip2n(a.ip) - ip2n(b.ip)); lan.progress = 100; lan.state = 'done';
  } catch (e) { lan.error = String(e.message || e); lan.state = 'error'; }
}

// ---- fixed time ranges (historical focus), range export and Insights ----
function sliceRange(S, from, to) { // samples are sorted by time
  const bs = x => { let lo = 0, hi = S.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (S[mid].t >= x) hi = mid; else lo = mid + 1; } return lo; };
  return S.slice(bs(from), bs(to + 1));
}
function rangeRows(t, ttl, from, to, limit = 400000) { // [{ttl,t,ms}] from memory when it covers the range, otherwise from the history DB
  const covers = h => h.samples.length && h.samples[0].t <= from;
  if (ttl != null) {
    const h = t.hops.find(x => x.ttl === ttl);
    if (h && (covers(h) || !db)) return sliceRange(h.samples, from, to).map(s => ({ ttl, t: s.t, ms: s.ms }));
    if (!db) return [];
    dbFlush(); return db.prepare('SELECT ttl,t,ms FROM samples WHERE tid=? AND ttl=? AND t>=? AND t<=? ORDER BY t LIMIT ?').all(t.id, ttl, from, to, limit);
  }
  if (!db || t.hops.every(covers)) return t.hops.flatMap(h => sliceRange(h.samples, from, to).map(s => ({ ttl: h.ttl, t: s.t, ms: s.ms }))).sort((a, b) => a.t - b.t);
  dbFlush(); return db.prepare('SELECT ttl,t,ms FROM samples WHERE tid=? AND t>=? AND t<=? ORDER BY t LIMIT ?').all(t.id, from, to, limit);
}
function aggRows(rows) { // same shape as stats()
  const n = rows.length; let okc = 0, sum = 0, mn = Infinity, mx = -Infinity, jsum = 0, prev = null;
  for (const r of rows) { const v = r.ms; if (v == null) continue; okc++; sum += v; if (v < mn) mn = v; if (v > mx) mx = v; if (prev != null) jsum += Math.abs(v - prev); prev = v; }
  const lost = n - okc, avg = okc ? sum / okc : null, jitter = okc > 1 ? jsum / (okc - 1) : null;
  return { count: n, lost, lossPct: n ? lost / n * 100 : 0, avg, min: okc ? mn : null, max: okc ? mx : null, cur: n ? rows[n - 1].ms : null, jitter, mos: mos(avg, jitter, n ? lost / n : 0) };
}
const rangeCache = new Map();
function statsRange(t, h, from, to) {
  const key = t.id + ':' + h.ttl + ':' + from + ':' + to + ':' + (t.epoch || 0), c = rangeCache.get(key), now = Date.now();
  if (c && now - c.at < (to < now - 60000 ? 60000 : 3000)) return c.v; // past ranges change rarely; ranges ending near "now" refresh quickly
  const v = aggRows(rangeRows(t, h.ttl, from, to, 200000));
  rangeCache.set(key, { at: now, v }); if (rangeCache.size > 3000) rangeCache.clear();
  return v;
}
const fmtLocal = ms => { const d = new Date(ms), p = x => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
function exportRange(t, from, to, mode, period, sep) {
  const rows = rangeRows(t, null, from, to), names = new Map(t.hops.map(h => [h.ttl, h]));
  const q = v => (v == null ? '' : String(v).includes(sep) || String(v).includes('"') ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  const out = [];
  if (mode === 'periods') { // "Aggregate and export data over time": statistics per hop per period (minimum 5 minutes)
    period = Math.max(300000, +period || 300000);
    out.push(['Period start', 'Period end', 'Hop', 'IP', 'Name', 'Samples', 'Lost', 'Loss %', 'Avg ms', 'Min ms', 'Max ms', 'Jitter ms'].join(sep));
    const groups = new Map();
    for (const r of rows) { const b = Math.floor((r.t - from) / period), k = b + ':' + r.ttl; let g = groups.get(k); if (!g) groups.set(k, g = { b, ttl: r.ttl, rows: [] }); g.rows.push(r); }
    for (const g of [...groups.values()].sort((a, b) => a.b - b.b || a.ttl - b.ttl)) {
      const s = aggRows(g.rows), h = names.get(g.ttl) || {}, ps = from + g.b * period;
      out.push([fmtLocal(ps), fmtLocal(Math.min(to, ps + period)), g.ttl, q(h.ip), q(settings.hostNames[h.ip] || h.name), s.count, s.lost, s.lossPct.toFixed(2), f(s.avg), f(s.min), f(s.max), f(s.jitter)].join(sep));
    }
  } else { // every sample: one row per probe round, one column per hop
    const ttls = [...new Set(rows.map(r => r.ttl))].sort((a, b) => a - b), byT = new Map();
    for (const r of rows) { let m = byT.get(r.t); if (!m) byT.set(r.t, m = {}); m[r.ttl] = r.ms; }
    out.push(['Time', ...ttls.map(x => q(`Hop ${x} (${(names.get(x) || {}).ip || '*'})`))].join(sep));
    for (const [tm, m] of [...byT.entries()].sort((a, b) => a[0] - b[0])) out.push([fmtLocal(tm), ...ttls.map(x => m[x] == null ? '' : m[x])].join(sep));
  }
  return out.join('\r\n');
}
// Insights: diagnosis of where problems start, detected events, and the best / worst periods of a time range.
const SENS_LOSS = [25, 15, 10, 7, 5, 3, 2, 1.5, 1, 0.5], SENS_MUL = [3, 2.6, 2.2, 1.9, 1.7, 1.5, 1.4, 1.3, 1.2, 1.1], SENS_ADD = [80, 60, 45, 35, 25, 20, 15, 10, 8, 5];
function insights(t, from, to, sens) {
  sens = Math.max(1, Math.min(10, sens | 0 || 5));
  const hops = t.hops.map(h => ({ ttl: h.ttl, ip: h.ip, name: settings.hostNames[h.ip] || h.name, s: statsRange(t, h, from, to) }));
  const fin = hops[hops.length - 1];
  if (!fin || !fin.s.count) return { from, to, empty: true, findings: [], events: [], best: [], worst: [] };
  const label = h => `#${h.ttl}${h.ip ? ' (' + (h.name || h.ip) + ')' : ''}`, F = [];
  const finLoss = fin.s.lossPct;
  if (finLoss >= 1) {
    let k = hops.length - 1;
    for (let i = hops.length - 2; i >= 0; i--) { if (hops[i].s.count && hops[i].s.lossPct >= Math.max(0.5, finLoss * 0.5)) k = i; else break; }
    F.push({ level: finLoss >= 5 ? 'bad' : 'warn', title: 'Packet loss', hop: hops[k].ttl, text: k === hops.length - 1
      ? `The destination lost ${finLoss.toFixed(1)}% of probes while the hops before it did not. The destination itself (or a firewall in front of it) is dropping or limiting traffic.`
      : `Packet loss that is degrading network performance appears to begin at hop ${label(hops[k])} and continues to the destination (${finLoss.toFixed(1)}% there).` + (k <= 1 ? ' That is inside your own network (router, Wi-Fi or cabling).' : '') });
  }
  const limited = hops.slice(0, -1).filter(h => h.s.count && h.s.lossPct >= 2 && h.s.lossPct > finLoss * 2 + 1);
  if (limited.length) F.push({ level: 'info', title: 'Loss at intermediate hops only', text: `Hop${limited.length > 1 ? 's' : ''} ${limited.map(label).join(', ')} show loss that does not continue to the destination. Those routers are limiting replies to probes aimed at them; this does not affect your traffic.` });
  let jump = null;
  for (let i = 1; i < hops.length; i++) { const a = hops[i - 1].s.avg, b = hops[i].s.avg; if (a == null || b == null) continue; const d = b - a;
    if (d > 25 && hops.slice(i).every(h => h.s.avg == null || h.s.avg >= b * 0.8) && (!jump || d > jump.d)) jump = { i, d }; }
  if (jump) { const h = hops[jump.i], steady = (h.s.jitter || 0) < Math.max(5, h.s.avg * 0.1);
    F.push({ level: jump.d > 100 && !steady ? 'warn' : 'info', title: 'Latency increase', hop: h.ttl, text: `Latency rises by about ${jump.d.toFixed(0)} ms at hop ${label(h)} and stays higher to the destination. ` + (steady ? 'This indicates that the latency increase is likely due to distance (a long link) rather than congestion.' : 'The values vary a lot there, which points to congestion on that link.') }); }
  if (fin.s.jitter != null && fin.s.jitter > 30) F.push({ level: 'warn', title: 'High jitter', text: `Latency at the destination varies by ${fin.s.jitter.toFixed(0)} ms between samples on average; voice and video calls will stutter.` });
  const rc = (t.routes || []).slice(1).filter(r => r.t >= from && r.t <= to).length;
  if (rc) F.push({ level: rc > 3 ? 'warn' : 'info', title: 'Route changes', text: `The route changed ${rc} time${rc > 1 ? 's' : ''} in this period. See Routes for details.` });
  if (!F.some(x => x.level === 'bad' || x.level === 'warn')) F.unshift({ level: 'ok', title: 'No significant problems', text: `The destination answered ${(100 - finLoss).toFixed(1)}% of probes with an average of ${f(fin.s.avg)} ms` + (fin.s.mos ? ` (MOS ${fin.s.mos.toFixed(2)}).` : '.') });
  // events on the destination hop
  const rows = rangeRows(t, fin.ttl, from, to), span = Math.max(1, to - from), step = Math.max(60000, Math.ceil(span / 240 / 60000) * 60000);
  const bk = new Map(); for (const r of rows) { const b = Math.floor((r.t - from) / step); let g = bk.get(b); if (!g) bk.set(b, g = []); g.push(r); }
  const buckets = [...bk.entries()].sort((a, b) => a[0] - b[0]).map(([b, rs]) => ({ t0: from + b * step, t1: Math.min(to, from + (b + 1) * step), s: aggRows(rs) }));
  const avgs = buckets.map(b => b.s.avg).filter(x => x != null).sort((a, b) => a - b), base = avgs.length ? avgs[Math.floor(avgs.length / 2)] : null;
  const lossThr = SENS_LOSS[sens - 1], latThr = base == null ? Infinity : base * SENS_MUL[sens - 1] + SENS_ADD[sens - 1];
  const events = []; let cur = null;
  for (const b of buckets) {
    const kind = b.s.lossPct >= 90 ? 'outage' : b.s.lossPct >= lossThr ? 'loss' : (b.s.avg != null && b.s.avg >= latThr) ? 'latency' : null;
    const fam = kind === 'latency' ? 'latency' : kind ? 'loss' : null;
    if (cur && fam === cur.fam && b.t0 <= cur.end + step) { cur.end = b.t1; cur.peakLoss = Math.max(cur.peakLoss, b.s.lossPct); cur.peakAvg = Math.max(cur.peakAvg, b.s.avg || 0); if (kind === 'outage') cur.outage = true; continue; }
    if (cur) events.push(cur); cur = fam ? { fam, start: b.t0, end: b.t1, peakLoss: b.s.lossPct, peakAvg: b.s.avg || 0, outage: kind === 'outage' } : null;
  }
  if (cur) events.push(cur);
  for (const e of events) { const min = (e.end - e.start) / 60000;
    e.type = e.outage ? 'Outage' : e.fam === 'latency' ? 'Latency spike' : min >= 5 ? 'Sustained packet loss' : 'Packet loss';
    e.minutes = +min.toFixed(1); e.severity = +(min * (e.peakLoss / 5 + Math.max(0, e.peakAvg - (base || 0)) / 20)).toFixed(2); delete e.fam; delete e.outage; }
  events.sort((a, b) => b.severity - a.severity);
  // best and worst periods
  const pstep = Math.max(300000, Math.ceil(span / 24 / 300000) * 300000), pk = new Map();
  for (const r of rows) { const b = Math.floor((r.t - from) / pstep); let g = pk.get(b); if (!g) pk.set(b, g = []); g.push(r); }
  const periods = [...pk.entries()].map(([b, rs]) => ({ start: from + b * pstep, end: Math.min(to, from + (b + 1) * pstep), ...aggRows(rs) })).filter(p => p.count >= 3 && p.mos != null);
  const rank = periods.slice().sort((a, b) => b.mos - a.mos || a.avg - b.avg);
  const pick = p => ({ start: p.start, end: p.end, avg: p.avg, lossPct: p.lossPct, jitter: p.jitter, mos: p.mos });
  return { from, to, sensitivity: sens, finalTtl: fin.ttl, baseline: base, step, findings: F, events: events.slice(0, 50), best: rank.length >= 3 ? rank.slice(0, 3).map(pick) : [], worst: rank.length >= 3 ? rank.slice(-3).reverse().map(pick) : [],
    hops: hops.map(h => ({ ttl: h.ttl, ip: h.ip, name: h.name, avg: h.s.avg, lossPct: h.s.lossPct, count: h.s.count })) };
}

// ---- web users (signed sessions, scrypt password hashes) and LiveShare read-only links ----
const cryptoM = require('crypto');
const hashPw = (pw, salt) => cryptoM.scryptSync(String(pw), salt, 32).toString('hex');
const webSecret = () => { const w = settings.web || (settings.web = {}); if (!w.secret) { w.secret = cryptoM.randomBytes(32).toString('hex'); save(); } return w.secret; };
const sign = s => cryptoM.createHmac('sha256', webSecret()).update(s).digest('base64url');
const cookieOf = (req, name) => { for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); } return null; };
function authCookie(user) { // user=null means the shared access token (admin)
  const pl = Buffer.from(JSON.stringify({ u: user ? user.name : '', v: user ? user.v : 0, e: Date.now() + 30 * 86400000 })).toString('base64url');
  return `pp_auth=${pl}.${sign(pl)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`;
}
function authFromCookie(req) {
  const c = cookieOf(req, 'pp_auth'); if (!c) return null; const [pl, mac] = c.split('.');
  if (!pl || !mac || !safeEq(mac, sign(pl))) return null;
  let o; try { o = JSON.parse(Buffer.from(pl, 'base64url').toString('utf8')); } catch { return null; }
  if (!o || !(o.e > Date.now())) return null;
  if (!o.u) return { role: 'admin', user: 'token' };
  const usr = (settings.webUsers || []).find(x => x.name === o.u); if (!usr || usr.v !== o.v) return null; // password change / deletion ends sessions
  return { role: usr.role, user: usr.name };
}
const shareCookie = sh => `pp_share=${sh.id}.${sign('share:' + sh.id + ':' + (sh.v || 0))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
function shareFromCookie(req) {
  const c = cookieOf(req, 'pp_share'); if (!c) return null; const [id, mac] = c.split('.');
  const sh = (settings.liveShares || []).find(x => x.id === id);
  if (!sh || !mac || !safeEq(mac, sign('share:' + id + ':' + (sh.v || 0)))) return null;
  if (sh.expires && sh.expires < Date.now()) return null;
  return sh;
}
function shareTids(sh) { const s = new Set(sh.tids || []); const sm = sh.summaryId && (settings.summaries || []).find(x => x.id === sh.summaryId); if (sm) for (const m of sm.members) s.add(m.tid); return s; }
function shareView(sh) { const w = settings.web || {}; return { id: sh.id, name: sh.name, tids: sh.tids || [], summaryId: sh.summaryId || null, hasPassword: !!sh.passHash, expires: sh.expires || null, created: sh.created,
  urls: w.enabled ? lanIps().map(ip => `https://${ip}:${w.port || 8767}/share/${sh.id}`) : [] }; }
function accessAllowed(ctx, p, m) { // what a non-admin session may do
  if (ctx.role === 'admin') return true;
  const write = !(m === 'GET' || m === 'HEAD');
  if (ctx.role === 'viewer') return !write || p === '/api/closed' || p === '/api/me/password';
  // LiveShare: read-only access to the shared targets only
  if (write) return p === '/api/closed';
  if (!p.startsWith('/api/')) return true;
  return /^\/api\/(info|whoami|settings|alerts|extensions|guidance|summaries|summary-data|targets)$/.test(p) || /^\/api\/targets\/\d+(\/(samples|history|routes|route|comments|insights))?$/.test(p);
}

// Follow IP changes: hostnames are looked up again every 5 minutes; a new address restarts route discovery and is noted on the timeline.
async function checkIpChanges(only) {
  for (const t of only ? [only] : targets) {
    if (!t.followIp || t.agent || require('net').isIP(t.host) || (!only && !t.running)) continue;
    // only a real move counts: hosts with several addresses (round-robin DNS, CDNs) keep their current one while it is still listed
    const fam = settings.ipVersion === '6' ? 6 : settings.ipVersion === '4' ? 4 : 0;
    const all = await new Promise(r => dns.lookup(t.host, { all: true, family: fam, verbatim: false }, (e, a) => r(e ? [] : a.map(x => x.address))));
    const ip = all.includes(t.ip) ? t.ip : all[0];
    if (ip && ip !== t.ip) { (t.comments = t.comments || []).push({ id: newId(), t: Date.now(), text: 'IP address changed: ' + t.ip + ' -> ' + ip, hop: null }); t.ip = ip; t.finalTtl = null; t.epoch = (t.epoch || 0) + 1; save(); }
  }
}
if (!AGENT) setInterval(() => checkIpChanges().catch(() => {}), 300000).unref(); // unref: see autosave note above

// ---- stored sessions, workspaces, summaries, guidance ----
const skeleton = t => { const { timer, busy, agentError, ...r } = t; return { ...r, hops: (t.hops || []).map(h => ({ ttl: h.ttl, ip: h.ip, name: h.name, samples: [] })) }; };
const runtimeTarget = sk => ({ ...sk, running: false, timer: null, busy: false });
function archiveTarget(t) { // closing a target keeps it as a stored session (ad hoc targets are discarded)
  stop(t); dbFlush();
  if (t.adhoc) { dbDelete(t.id); targets = targets.filter(x => x !== t); for (const sm of settings.summaries || []) sm.members = sm.members.filter(m => m.tid !== t.id); return; }
  sessions.unshift({ sid: t.id, closedAt: Date.now(), meta: skeleton(t) });
  if (sessions.length > 500) { const old = sessions.pop(); dbDelete(old.sid); }
  targets = targets.filter(x => x !== t);
  for (const sm of settings.summaries || []) sm.members = sm.members.filter(m => m.tid !== t.id);
}
function sessionInfo(se) {
  let count = 0, first = null, last = null;
  if (db) try { const r = db.prepare('SELECT COUNT(*) n, MIN(t) a, MAX(t) b FROM samples WHERE tid = ?').get(se.sid); count = r.n; first = r.a; last = r.b; } catch {}
  return { sid: se.sid, host: se.meta.host, ip: se.meta.ip, proto: se.meta.proto || 'icmp', port: se.meta.port || null, closedAt: se.closedAt, samples: count, first, last, hops: (se.meta.hops || []).length };
}
const wsDir = () => { const d = path.join(DATA_DIR, 'workspaces'); fs.mkdirSync(d, { recursive: true }); return d; };
const wsName = n => { n = String(n || '').trim(); return /^[\w][\w .\-]{0,59}$/.test(n) && !/\.\./.test(n) ? n : null; };
const wsFile = n => path.join(wsDir(), n + '.json');
function wsSaveCurrent() { const n = settings.workspace || 'Default'; try { dbFlush(); fs.writeFileSync(wsFile(n), JSON.stringify({ name: n, savedAt: Date.now(), targets: targets.filter(t => !t.adhoc).map(t => { const k = skeleton(t); k.autostart = !!t.running; return k; }), summaries: settings.summaries || [] })); } catch {} }
function wsLoad(data) {
  for (const t of targets.splice(0)) stop(t);
  targets = (data.targets || []).filter(t => validHost(t.host)).map(runtimeTarget);
  settings.summaries = Array.isArray(data.summaries) ? data.summaries : [];
  for (const t of targets) { if (t.id >= nextId) nextId = t.id + 1; dbHydrate(t); }
  targets.forEach(t => { if (t.autostart && !t.agent) start(t); else if (t.autostart) start(t); });
}
const DEFAULT_GUIDES = {
  'packet-loss': ['Packet loss', 'Loss on **one middle hop only** is usually harmless: routers deprioritise replies to probes aimed at themselves (ICMP rate limiting). Look at the hops after it.\n\nLoss that **starts at a hop and continues to every hop after it, including the destination**, is real and the problem is at or just after that hop.\n\nLoss only at the **final hop** can be the destination rate-limiting probes or a firewall. If your application works normally, ignore it.'],
  'latency': ['High latency', 'Latency normally rises step by step along the route; a single large jump between two hops marks a long link (for example an ocean crossing) or a congested one.\n\nA hop that is slow but whose later hops are fast is usually a router slow to answer probes, not a slow path. Only latency that **persists to the destination** affects you.'],
  'jitter': ['Jitter', 'Jitter is how much latency varies from one sample to the next. Voice and video stay smooth below roughly 30 ms of jitter; above that you will hear glitches. Jitter that appears at every hop from your own router on points to your local network or Wi-Fi.'],
  'route-changes': ['Route changes', 'A route change means traffic started taking a different path. It is normal on the internet, but frequent flapping between paths often comes with latency steps and brief loss. Use the Route changes list to line the times up with the graph.'],
  'local-network': ['Problems at hop 1 or 2', 'Loss or high latency already on the first hops is inside your own network: Wi-Fi interference, a congested router, or a bad cable. Test with a wired connection and check the Wi-Fi panel signal and channel.'],
  'mos': ['MOS score', 'MOS estimates call quality from latency, jitter and loss on a 1 (bad) to 4.5 (excellent) scale. Above 4.0 is good, 3.6–4.0 acceptable, below 3.1 callers will complain.']
};
function guides() {
  const out = Object.entries(DEFAULT_GUIDES).map(([topic, [title, body]]) => ({ topic, title, body, custom: false }));
  const dir = path.join(DATA_DIR, 'guidance');
  try { for (const f of fs.readdirSync(dir)) { if (!f.endsWith('.md') || f.endsWith('.default.md')) continue; const topic = f.slice(0, -3), txt = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 20000), tm = /^#\s+(.+)$/m.exec(txt);
    const g = { topic, title: tm ? tm[1] : topic, body: txt.replace(/^#\s+.+\n?/m, ''), custom: true }; const i = out.findIndex(x => x.topic === topic); if (i >= 0) out[i] = g; else out.push(g); } } catch {}
  return out;
}
function exportGuides() { const dir = path.join(DATA_DIR, 'guidance'); fs.mkdirSync(dir, { recursive: true }); for (const [topic, [title, body]] of Object.entries(DEFAULT_GUIDES)) fs.writeFileSync(path.join(dir, topic + '.default.md'), '# ' + title + '\n\n' + body + '\n'); return dir; }
const newId = () => 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
async function addTarget(host, o = {}) { // shared by list import / summaries
  if (!validHost(host) || targets.length >= MAX_TARGETS) return null;
  const ip = await lookupIp(host); if (!ip) return null;
  const t = { id: nextId++, host, ip, name: host, hops: [], count: 0, running: false, hidden: [], proto: ['tcp', 'udp'].includes(o.proto) ? o.proto : 'icmp', port: o.port || null, configId: o.configId || null };
  targets.push(t); start(t); return t;
}

// ---- optional network web GUI over HTTPS (self-signed cert, token login). `remote` requests get extra restrictions. ----
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && require('crypto').timingSafeEqual(x, y); };
const loginFails = new Map(); // per client address, so one attacker can't lock everyone else out
const PAGE = (title, body) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:15px system-ui,Segoe UI,sans-serif;max-width:380px;margin:14vh auto;padding:0 18px;color:#0f172a;background:#f3f5f8}h2{margin:0 0 4px}p.s{color:#64748b;margin:0 0 18px}input{width:100%;box-sizing:border-box;padding:9px 10px;margin:0 0 10px;border:1px solid #cbd5e1;border-radius:6px;font:inherit}button{padding:9px 16px;border:0;border-radius:6px;background:#2563eb;color:#fff;font:inherit;font-weight:600;cursor:pointer}.e{color:#dc2626}@media(prefers-color-scheme:dark){body{background:#0a0e14;color:#e5ecf6}input{background:#111827;color:#e5ecf6;border-color:#2c3a50}p.s{color:#8b9ab0}}</style><body>${body}`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOGIN_PAGE = (msg) => PAGE('PingTracer sign in', `<h2>PingTracer</h2><p class=s>Sign in with your web user name and password, or leave the user name empty and enter the access token from Settings.</p><form method=post action=/login><input name=user placeholder="User name (empty for access token)" autocomplete=username autofocus><input name=password type=password placeholder="Password or access token" autocomplete=current-password><button>Sign in</button></form><p class=e>${esc(msg)}</p>`);
const SHARE_PAGE = (id, msg) => PAGE('PingTracer LiveShare', `<h2>PingTracer LiveShare</h2><p class=s>This read-only link is protected by a password.</p><form method=post action="/share/${esc(id)}"><input name=password type=password placeholder=Password autofocus><button>Open</button></form><p class=e>${esc(msg)}</p>`);
function readForm(req) { return new Promise(r => { let d = ''; req.on('data', c => { d += c; if (d.length > 4096) req.destroy(); }); req.on('end', () => r(new URLSearchParams(d))); req.on('error', () => r(new URLSearchParams())); }); }
function throttled(req) { // per-client failed-attempt limiter shared by sign-in and LiveShare passwords
  const ip = req.socket.remoteAddress || '?', now = Date.now();
  const fails = (loginFails.get(ip) || []).filter(t => now - t < 60000); loginFails.set(ip, fails);
  if (loginFails.size > 1000) for (const [k, v] of loginFails) if (!v.some(t => now - t < 60000)) loginFails.delete(k);
  return { blocked: fails.length >= 5, fail: () => fails.push(now) };
}
async function remoteGate(req, res, u) { // returns the session context, or null when the response was already sent
  const p = u.pathname, m = req.method;
  if (m !== 'GET' && m !== 'HEAD' && req.headers.origin && req.headers.origin !== `https://${req.headers.host}`) { send(res, 403, { error: 'forbidden' }); return null; }
  if (p === '/logout') { res.writeHead(302, { 'Set-Cookie': ['pp_auth=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict', 'pp_share=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax', 'pp_token=; Max-Age=0; Path=/; Secure; HttpOnly'], Location: '/login' }); res.end(); return null; }
  const sm = p.match(/^\/share\/([\w-]{10,64})$/);
  if (sm) { // LiveShare entry point
    const sh = (settings.liveShares || []).find(x => x.id === sm[1]);
    if (!sh || (sh.expires && sh.expires < Date.now())) { send(res, 404, PAGE('LiveShare', '<h2>LiveShare</h2><p class=e>Sorry, the LiveShare link you\'re using is either invalid or expired.</p>'), 'text/html'); return null; }
    if (sh.passHash) {
      if (m !== 'POST') { send(res, 200, SHARE_PAGE(sh.id, ''), 'text/html'); return null; }
      const th = throttled(req); if (th.blocked) { send(res, 429, SHARE_PAGE(sh.id, 'Too many attempts, wait a minute.'), 'text/html'); return null; }
      const f = await readForm(req);
      if (!safeEq(hashPw(f.get('password') || '', sh.passSalt), sh.passHash)) { th.fail(); send(res, 401, SHARE_PAGE(sh.id, 'Wrong password.'), 'text/html'); return null; }
    }
    res.writeHead(302, { 'Set-Cookie': shareCookie(sh), Location: '/' }); res.end(); return null;
  }
  if (p === '/login') {
    if (m === 'POST') {
      const th = throttled(req); if (th.blocked) { send(res, 429, LOGIN_PAGE('Too many attempts, wait a minute.'), 'text/html'); return null; }
      const f = await readForm(req), name = (f.get('user') || '').trim(), pw = f.get('password') || f.get('token') || '';
      if (!name && settings.web && settings.web.token && safeEq(pw, settings.web.token)) { res.writeHead(302, { 'Set-Cookie': authCookie(null), Location: '/' }); res.end(); return null; }
      const usr = name && (settings.webUsers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
      if (usr && safeEq(hashPw(pw, usr.salt), usr.hash)) { res.writeHead(302, { 'Set-Cookie': authCookie(usr), Location: '/' }); res.end(); return null; }
      th.fail(); send(res, 401, LOGIN_PAGE(name ? 'Wrong user name or password.' : 'Wrong token.'), 'text/html'); return null;
    }
    send(res, 200, LOGIN_PAGE(''), 'text/html'); return null;
  }
  const tok = req.headers['x-pp-token'];
  if (tok && settings.web && settings.web.token && safeEq(String(tok), settings.web.token)) return { role: 'admin', user: 'token' };
  const a = authFromCookie(req); if (a) return a;
  const sh = shareFromCookie(req); if (sh) return { role: 'share', share: sh };
  if (p.startsWith('/api/')) send(res, 401, { error: 'login required' }); else { res.writeHead(302, { Location: '/login' }); res.end(); }
  return null;
}
let webSrv = null;
function ensureCert() {
  const pfx = path.join(DATA_DIR, 'web.pfx'), pwf = path.join(DATA_DIR, 'web.pass');
  if (fs.existsSync(pfx) && fs.existsSync(pwf)) return Promise.resolve({ pfx: fs.readFileSync(pfx), passphrase: fs.readFileSync(pwf, 'utf8') });
  const pw = require('crypto').randomBytes(16).toString('hex');
  const ps = `$ErrorActionPreference='Stop';$c=New-SelfSignedCertificate -DnsName 'localhost',$env:COMPUTERNAME -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddYears(5) -KeyAlgorithm RSA -KeyLength 2048;` +
    `try{Export-PfxCertificate -Cert $c -FilePath $env:PP_PFX -Password (ConvertTo-SecureString $env:PP_PW -AsPlainText -Force)|Out-Null}finally{Remove-Item $c.PSPath -ErrorAction SilentlyContinue}`;
  return new Promise((resolve, reject) => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, PP_PW: pw, PP_PFX: pfx }, windowsHide: true, timeout: 60000 }, err => {
    if (err || !fs.existsSync(pfx)) return reject(new Error('could not create TLS certificate: ' + (err ? err.message : 'unknown')));
    fs.writeFileSync(pwf, pw); resolve({ pfx: fs.readFileSync(pfx), passphrase: pw });
  }));
}
let webError = null;
async function applyWeb() {
  if (webSrv) { try { webSrv.close(); webSrv.closeAllConnections && webSrv.closeAllConnections(); } catch {} webSrv = null; }
  webError = null;
  const w = settings.web; if (AGENT || !w || !w.enabled) return;
  if (!w.token) { w.token = require('crypto').randomBytes(18).toString('base64url'); save(); }
  try {
    const cert = await ensureCert();
    webSrv = require('https').createServer({ ...cert, minVersion: 'TLSv1.2' }, (q, s) => handle(q, s, true));
    webSrv.on('error', e => { webError = e.code === 'EADDRINUSE' ? `port ${w.port} is in use` : e.message; webSrv = null; });
    webSrv.listen(w.port || 8767, '0.0.0.0');
  } catch (e) { webError = e.message; }
}
const lanIps = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);

const handle = async (req, res, remote = false) => {
  let u; try { u = new URL(req.url, 'http://x'); } catch { return send(res, 400, { error: 'bad request' }); } // a malformed request line must answer, not crash the process
  const p = u.pathname; const m = req.method;
  const focus = +u.searchParams.get('focus') || 0;
  // Access control. Local mode: only same-origin requests to a loopback Host (blocks CSRF and DNS rebinding
  // from web pages, since alert rules can launch programs). Agent mode: shared-token auth on /api.
  if ((m === 'POST' || m === 'PUT') && +req.headers['content-length'] > MAX_BODY) { res.setHeader('Connection', 'close'); return send(res, 413, { error: 'request too large' }); } // answer cleanly instead of dropping the connection
  let ctx = { role: 'admin', user: null };
  if (remote) { ctx = await remoteGate(req, res, u); if (!ctx) return; if (!accessAllowed(ctx, p, m)) return send(res, 403, { error: ctx.role === 'share' ? 'this LiveShare link is read-only' : 'your account is read-only' }); }
  else if (AGENT) {
    if (p.startsWith('/api/')) {
      const tok = String(req.headers['x-pp-token'] || '');
      const a = Buffer.from(tok), b = Buffer.from(AGENT_TOKEN);
      if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) return send(res, 401, { error: 'bad agent token' });
    }
  } else {
    const hostOk = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host || '');
    const org = req.headers.origin;
    if (!hostOk || (org && org !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'forbidden' });
  }
  if (p.startsWith('/api/') && p !== '/api/closed') lastApiHit = Date.now();
  try {
    const visible = t => !ctx.share || shareTids(ctx.share).has(t.id);
    const rng = (() => { const a = +u.searchParams.get('from'), b = +u.searchParams.get('to'); return a > 0 && b > a ? { from: a, to: b } : null; })();
    if (p === '/api/whoami') return send(res, 200, { role: ctx.role, user: ctx.user || null, local: !remote, share: ctx.share ? { name: ctx.share.name } : null });
    if (ctx.share && p === '/api/settings') return send(res, 200, { intervalMs: settings.intervalMs, hostNames: {}, alertRules: [] });
    if (ctx.share && p === '/api/alerts') return send(res, 200, []);
    if (ctx.share && p === '/api/summaries') return send(res, 200, (settings.summaries || []).filter(s => s.id === ctx.share.summaryId));
    // ---- web users (admin only) ----
    if (p === '/api/webusers' || p.startsWith('/api/webusers/')) {
      if (ctx.role !== 'admin') return send(res, 403, { error: 'admin only' });
      settings.webUsers = settings.webUsers || [];
      const listU = () => settings.webUsers.map(x => ({ name: x.name, role: x.role }));
      if (p === '/api/webusers' && m === 'GET') return send(res, 200, listU());
      if (p === '/api/webusers' && m === 'POST') {
        const b = await readBody(req), name = String(b.name || '').trim();
        if (!/^[\w.@-]{1,40}$/.test(name)) return send(res, 400, { error: 'user names may use letters, digits and . _ - @ (up to 40)' });
        if (settings.webUsers.some(x => x.name.toLowerCase() === name.toLowerCase())) return send(res, 400, { error: 'that user already exists' });
        if (String(b.password || '').length < 8) return send(res, 400, { error: 'passwords need at least 8 characters' });
        if (settings.webUsers.length >= 100) return send(res, 400, { error: 'too many users' });
        const salt = cryptoM.randomBytes(16).toString('hex');
        settings.webUsers.push({ name, salt, hash: hashPw(b.password, salt), role: b.role === 'admin' ? 'admin' : 'viewer', v: 1 }); save(); return send(res, 200, listU());
      }
      const mu = p.match(/^\/api\/webusers\/([^/]+)$/), usr = mu && settings.webUsers.find(x => x.name === decodeURIComponent(mu[1]));
      if (!usr) return send(res, 404, { error: 'not found' });
      if (m === 'DELETE') { settings.webUsers = settings.webUsers.filter(x => x !== usr); save(); return send(res, 200, listU()); }
      if (m === 'PUT') {
        const b = await readBody(req);
        if (b.password != null) { if (String(b.password).length < 8) return send(res, 400, { error: 'passwords need at least 8 characters' }); usr.salt = cryptoM.randomBytes(16).toString('hex'); usr.hash = hashPw(b.password, usr.salt); usr.v = (usr.v || 0) + 1; }
        if (b.role) usr.role = b.role === 'admin' ? 'admin' : 'viewer';
        save(); return send(res, 200, listU());
      }
    }
    if (p === '/api/me/password' && m === 'POST') { // a signed-in web user changes their own password
      const usr = remote && ctx.user && ctx.user !== 'token' && (settings.webUsers || []).find(x => x.name === ctx.user);
      if (!usr) return send(res, 400, { error: 'only web users can change their password here' });
      const b = await readBody(req);
      if (!safeEq(hashPw(b.current || '', usr.salt), usr.hash)) return send(res, 403, { error: 'the current password is wrong' });
      if (String(b.next || '').length < 8) return send(res, 400, { error: 'passwords need at least 8 characters' });
      usr.salt = cryptoM.randomBytes(16).toString('hex'); usr.hash = hashPw(b.next, usr.salt); usr.v = (usr.v || 0) + 1; save();
      res.setHeader('Set-Cookie', authCookie(usr)); return send(res, 200, { ok: true });
    }
    // ---- LiveShare links (admin only) ----
    if (p === '/api/liveshares' || p.startsWith('/api/liveshares/')) {
      if (ctx.role !== 'admin') return send(res, 403, { error: 'admin only' });
      settings.liveShares = settings.liveShares || [];
      const all = () => settings.liveShares.map(shareView);
      const setPw = (sh, pw) => { if (pw) { sh.passSalt = cryptoM.randomBytes(16).toString('hex'); sh.passHash = hashPw(pw, sh.passSalt); } else { delete sh.passSalt; delete sh.passHash; } sh.v = (sh.v || 0) + 1; };
      if (p === '/api/liveshares' && m === 'GET') return send(res, 200, all());
      if (p === '/api/liveshares' && m === 'POST') {
        const b = await readBody(req);
        const tids = (Array.isArray(b.tids) ? b.tids : []).map(Number).filter(id => targets.some(t => t.id === id));
        const summaryId = b.summaryId && (settings.summaries || []).some(s => s.id === b.summaryId) ? String(b.summaryId) : null;
        if (!tids.length && !summaryId) return send(res, 400, { error: 'choose at least one target or a summary to share' });
        if (settings.liveShares.length >= 200) return send(res, 400, { error: 'too many LiveShare links' });
        const sh = { id: cryptoM.randomBytes(15).toString('base64url'), name: String(b.name || 'LiveShare').slice(0, 80), tids, summaryId, expires: +b.expires > Date.now() ? +b.expires : null, created: Date.now(), v: 0 };
        if (b.password) setPw(sh, String(b.password)); settings.liveShares.push(sh); save(); return send(res, 200, shareView(sh));
      }
      const ml = p.match(/^\/api\/liveshares\/([\w-]+)$/), sh = ml && settings.liveShares.find(x => x.id === ml[1]);
      if (!sh) return send(res, 404, { error: 'not found' });
      if (m === 'DELETE') { settings.liveShares = settings.liveShares.filter(x => x !== sh); save(); return send(res, 200, all()); }
      if (m === 'PUT') {
        const b = await readBody(req);
        if (b.name) sh.name = String(b.name).slice(0, 80);
        if (b.expires !== undefined) sh.expires = +b.expires > Date.now() ? +b.expires : null;
        if (b.password !== undefined) setPw(sh, String(b.password || ''));
        save(); return send(res, 200, shareView(sh));
      }
    }
    if (p === '/api/targets' && m === 'GET') return send(res, 200, targets.filter(visible).map(t => view(t, focus, rng)));
    if (p === '/api/targets' && m === 'POST') {
      const b = await readBody(req); const host = String(b.host || '').trim();
      if (!validHost(host)) return send(res, 400, { error: 'InvalidTraceTarget: enter a valid hostname or IP' });
      if (targets.length >= MAX_TARGETS) return send(res, 400, { error: 'limit of ' + MAX_TARGETS + ' open targets reached' });
      if (b.agent && b.agent.url) { // trace from a remote agent
        if (remote) return send(res, 403, { error: 'not allowed over the network' });
        if (targets.length >= MAX_TARGETS) return send(res, 400, { error: 'limit of ' + MAX_TARGETS + ' open targets reached' });
        if (AGENT) return send(res, 400, { error: 'agents cannot chain to other agents' });
        if (!/^https?:\/\/[^\s/]+/i.test(b.agent.url)) return send(res, 400, { error: 'invalid agent URL' });
        const port = portOf(b.port); if (port === undefined) return send(res, 400, { error: PORT_ERR });
        const t = { id: nextId++, host, ip: host, name: b.name || host, hops: [], count: 0, running: false, hidden: [], proto: ['tcp', 'udp'].includes(b.proto) ? b.proto : 'icmp', port, agent: { url: String(b.agent.url), token: String(b.agent.token || '') } };
        targets.push(t); start(t); save(); return send(res, 200, view(t, focus));
      }
      const port = portOf(b.port); if (port === undefined) return send(res, 400, { error: PORT_ERR }); // validate before any network work
      const ip = await lookupIp(host);
      if (!ip) return send(res, 400, { error: 'DNS lookup failed for ' + host });
      const t = { id: nextId++, host, ip, name: b.name || host, hops: [], count: 0, running: false, hidden: [], proto: ['tcp', 'udp'].includes(b.proto) ? b.proto : 'icmp', port,
        adhoc: !!b.adhoc, followIp: b.followIp !== false && !require('net').isIP(host), configId: (b.configId && (settings.configs || []).some(c => c.id === b.configId)) ? String(b.configId) : null };
      const smJ = b.summaryId && (settings.summaries || []).find(x => x.id === b.summaryId); // start the target straight into a summary
      if (smJ) { if (!t.configId && smJ.configId) t.configId = smJ.configId; smJ.members.push({ tid: t.id, ttl: null }); }
      targets.push(t); start(t); save(); return send(res, 200, view(t, focus));
    }
    if (p === '/api/closed' && m === 'POST') { // UI page unloaded: if no UI request follows (i.e. not a reload), tell the user once that we keep running in the tray
      if (tray && !settings.trayNoticeShown) setTimeout(() => {        if (Date.now() - lastApiHit > 3500 && !settings.trayNoticeShown) { settings.trayNoticeShown = true; save(); trayWrite('balloon PingTracer is still running in the system tray. Right-click the tray icon to open it again or quit.'); }
      }, 4000);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/quit' && remote) return send(res, 403, { error: 'not allowed over the network' });
    if (p === '/api/quit' && m === 'POST' && !AGENT) { send(res, 200, { ok: true }); setTimeout(() => { saveSync(); process.exit(0); }, 200); return; }
    if (p === '/api/extensions') { if (m === 'POST') loadExtensions(); return send(res, 200, extensions.map(e => ({ file: e.file, name: e.name, columns: e.columns.map(c => ({ id: c.id, title: c.title || c.id })), error: e.error }))); }
    let mt = p.match(/^\/api\/targets\/(\d+)(?:\/(\w+))?$/);
    if (mt) {
      const t = targets.find(x => x.id === +mt[1]); if (!t || !visible(t)) return send(res, 404, { error: 'not found' });
      const act = mt[2];
      // state-changing actions must not be reachable by GET: a read-only role (viewer/LiveShare) is defined as
      // GET/HEAD-only in accessAllowed, and cross-site simple requests (img/script tags) must never mutate state.
      if (act && ['start', 'stop', 'clear', 'retrace'].includes(act) && m !== 'POST') return send(res, 405, { error: 'use POST for this action' });
      if (!act && m === 'GET') return send(res, 200, view(t, focus, rng));
      if (act === 'raw') { // incremental sample feed used by controllers pulling from this agent
        const since = +u.searchParams.get('since') || 0;
        return send(res, 200, { ip: t.ip, finalTtl: t.finalTtl || null, count: t.count || 0, hops: t.hops.map(h => ({ ttl: h.ttl, ip: h.ip, name: h.name, samples: h.samples.filter(s => s.t > since) })) });
      }
      if (!act && m === 'DELETE') { if (t.agent && t.agent.rid) agentFetch(t, '/api/targets/' + t.agent.rid, 'DELETE').catch(() => {}); archiveTarget(t); save(); return send(res, 200, { ok: true }); }
      if (act === 'start') { start(t); return send(res, 200, { ok: true }); }
      if (act === 'stop') { stop(t); return send(res, 200, { ok: true }); }
      if (act === 'clear') { t.hops.forEach(h => { h.samples = []; h._c = null; }); t.count = 0; t.epoch = (t.epoch || 0) + 1; dbDelete(t.id); return send(res, 200, { ok: true }); }
      if (act === 'history') { // aggregated long-range series for one hop
        if (!db) return send(res, 200, { step: 0, buckets: [], note: 'history database unavailable' });
        const ttl = +u.searchParams.get('hop') || t.finalTtl || 1, to = +u.searchParams.get('to') || Date.now(), from = +u.searchParams.get('from') || to - 86400000;
        return send(res, 200, { ttl, from, to, ...dbBuckets(t.id, ttl, from, to, Math.min(1000, +u.searchParams.get('buckets') || 400)) });
      }
      if (act === 'mode' && m === 'POST') { const b = await readBody(req); t.mode = b.mode === 'final' ? 'final' : 'full'; return send(res, 200, { ok: true }); }
      if (act === 'routes') return send(res, 200, (t.routes || []).slice().reverse());
      if (act === 'route') { const at = +u.searchParams.get('at') || Date.now(); const r = (t.routes || []).filter(x => x.t <= at).pop() || (t.routes || [])[0]; return send(res, 200, r || { t: null, hops: [] }); }
      if (act === 'comments') {
        if (m === 'GET') { const from = +u.searchParams.get('start') || 0, to = +u.searchParams.get('end') || Infinity; return send(res, 200, (t.comments || []).filter(c => c.t >= from && c.t < to)); }
        const b = await readBody(req); t.comments = t.comments || [];
        if (m === 'POST') { const text = String(b.text || '').trim().slice(0, 2000); if (!text) return send(res, 400, { error: 'empty comment' }); const c = { id: newId(), t: +b.t || Date.now(), text, hop: b.hop ? +b.hop : null }; t.comments.push(c); if (t.comments.length > 1000) t.comments.splice(0, t.comments.length - 1000); save(); return send(res, 200, c); }
        if (m === 'PUT') { const c = t.comments.find(x => x.id === b.id); if (!c) return send(res, 404, { error: 'not found' }); if (b.text != null) c.text = String(b.text).slice(0, 2000); save(); return send(res, 200, c); }
        if (m === 'DELETE') { t.comments = t.comments.filter(x => x.id !== b.id); save(); return send(res, 200, { ok: true }); }
      }
      if (act === 'column' && m === 'POST') { // custom grid column: {name, hop, value} (empty value clears the cell; clear:true drops the column)
        const b = await readBody(req), name = String(b.name || '').trim().slice(0, 30); if (!name || ['__proto__', 'constructor', 'prototype'].includes(name)) return send(res, 400, { error: 'invalid column name' }); t.customCols = t.customCols || {};
        if (b.clear) delete t.customCols[name]; else { const col = t.customCols[name] = t.customCols[name] || {}; if (!Object.keys(col).length && Object.keys(t.customCols).length > 50) { delete t.customCols[name]; return send(res, 400, { error: 'too many custom columns' }); } const v = String(b.value ?? '').slice(0, 200); if (b.hop != null) { if (v) col[b.hop] = v; else delete col[b.hop]; } }
        save(); return send(res, 200, { ok: true, customCols: t.customCols });
      }
      if (act === 'reresolve' && m === 'POST') { const b = await readBody(req); await checkIpChanges(t); for (const h of t.hops) { if (b.hop && +b.hop !== h.ttl) continue; if (!h.ip) continue; nameCache.delete(h.ip); h.name = await rdns(h.ip); } return send(res, 200, { ok: true }); }
      if (act === 'reset' && m === 'POST') { const was = t.running; stop(t); t.epoch = (t.epoch || 0) + 1; t.hops = []; t.finalTtl = null; t.count = 0; t.routes = []; t.destState = null; dbDelete(t.id); if (was) start(t); return send(res, 200, { ok: true }); }
      if (act === 'rename' && m === 'POST') { const b = await readBody(req), name = String(b.name || '').trim().slice(0, 100); if (b.hop) { const h = t.hops.find(x => x.ttl === +b.hop); if (h && h.ip) { if (name) settings.hostNames[h.ip] = name; else delete settings.hostNames[h.ip]; } } else if (name) t.name = name; save(); return send(res, 200, { ok: true }); }
      if (act === 'update' && m === 'POST') { const b = await readBody(req);
        if (b.configId !== undefined) t.configId = (b.configId && b.configId !== 'default' && (settings.configs || []).some(c => c.id === b.configId)) ? b.configId : null;
        if (b.proto) { t.proto = ['tcp', 'udp'].includes(b.proto) ? b.proto : 'icmp'; t.finalTtl = t.agent ? t.finalTtl : t.finalTtl; }
        if (b.port != null && b.port !== '') { const pt = portOf(b.port); if (pt === undefined) return send(res, 400, { error: PORT_ERR }); t.port = pt; }
        if (b.name) t.name = String(b.name).slice(0, 100);
        if (b.persistence) t.adhoc = b.persistence === 'adhoc'; if (b.followIp != null) t.followIp = !!b.followIp && !require('net').isIP(t.host);
        save(); return send(res, 200, view(t, focus)); }
      if (act === 'retrace') { t.finalTtl = null; t.hops = []; t.epoch = (t.epoch || 0) + 1; t.destState = null; if (t.agent) t.agent.since = 0; return send(res, 200, { ok: true }); }
      if (act === 'hide' && m === 'POST') { const b = await readBody(req); t.hidden = b.hidden || []; return send(res, 200, { ok: true }); }
      if (act === 'samples') {
        const ttl = +u.searchParams.get('hop') || t.finalTtl || (t.hops.length ? t.hops[t.hops.length - 1].ttl : 1);
        const since = Date.now() - (+u.searchParams.get('window') || 600000);
        const h = t.hops.find(h => h.ttl === ttl);
        const qFrom = +u.searchParams.get('from'), qTo = +u.searchParams.get('to');
        if (qFrom > 0 && qTo > qFrom) { // a fixed historical window (graph panned away from "live")
          let rows = rangeRows(t, ttl, qFrom, qTo, 100000); if (rows.length > 20000) { const k = Math.ceil(rows.length / 20000); rows = rows.filter((r, i) => i % k === 0 || r.ms == null); }
          return send(res, 200, { ttl, epoch: t.epoch || 0, samples: rows.map(r => ({ t: r.t, ms: r.ms })) });
        }
        const after = +u.searchParams.get('since') || 0; // incremental polling: only samples newer than this
        let out = []; if (h) { const S = h.samples; let lo = 0, hi = S.length, lim = Math.max(since, after + 1); while (lo < hi) { const mid = (lo + hi) >> 1; if (S[mid].t >= lim) hi = mid; else lo = mid + 1; } out = S.slice(lo); }
        return send(res, 200, { ttl, epoch: t.epoch || 0, samples: out });
      }
      if (act === 'insights') { const to = +u.searchParams.get('to') || Date.now(), from = +u.searchParams.get('from') || to - 3600000; return send(res, 200, insights(t, from, Math.max(from + 1000, to), +u.searchParams.get('sensitivity') || 5)); }
      if (act === 'exportrange') {
        const to = +u.searchParams.get('to') || Date.now(), from = +u.searchParams.get('from') || to - 3600000;
        if (!(to > from) || to - from > 366 * 86400000) return send(res, 400, { error: 'choose a range of up to one year' });
        return send(res, 200, exportRange(t, from, to, u.searchParams.get('mode') === 'periods' ? 'periods' : 'samples', +u.searchParams.get('period'), u.searchParams.get('format') === 'tsv' ? '\t' : ','), 'text/plain');
      }
      if (act === 'export') {
        const fmt = u.searchParams.get('format') || 'long', all = u.searchParams.get('all') === '1';
        if (fmt === 'json') return send(res, 200, exportJson(t, focus, all), 'application/json');
        return send(res, 200, exportText(t, fmt, focus, all, u.searchParams.get('meta') === '1'), 'text/plain');
      }
    }
    if (p === '/api/settings') {
      const pub = () => ({ ...settings, smtp: { ...(settings.smtp || {}), pass: '', passEnc: undefined, passSet: !!(settings.smtp && (settings.smtp.pass || settings.smtp.passEnc)) } }); // never send the SMTP password (or its ciphertext) back
      // remote sessions never see the web token / SMTP secrets and cannot create program-launching alert rules
      let startError = null, asNow = remote ? false : await autostartState();
      const pub2 = () => { const o = pub(); o.startWithWindows = asNow; o.startError = startError; delete o.webUsers; delete o.liveShares; if (remote) { delete o.web; delete o.smtp; } else { o.web = { enabled: !!(settings.web && settings.web.enabled), port: (settings.web && settings.web.port) || 8767, token: (settings.web && settings.web.token) || '', error: webError, urls: (settings.web && settings.web.enabled) ? lanIps().map(ip => `https://${ip}:${(settings.web && settings.web.port) || 8767}`) : [] }; } return o; };
      if (m === 'GET') return send(res, 200, pub2());
      const b = await readBody(req);
      if (remote) { delete b.web; delete b.smtp; if (Array.isArray(b.alertRules)) { const risky = r => r.action === 'command' || r.action === 'webhook'; const keep = settings.alertRules.filter(risky); b.alertRules = [...sanitizeRules(b.alertRules).filter(r => !risky(r)), ...keep]; } }
      else if (b.web && typeof b.web === 'object') {
        const w = settings.web || (settings.web = {}); const was = !!w.enabled;
        w.enabled = !!b.web.enabled; w.port = Math.max(1024, Math.min(65535, +b.web.port || 8767));
        if (b.web.newToken || !w.token) { w.token = require('crypto').randomBytes(18).toString('base64url'); w.secret = require('crypto').randomBytes(32).toString('hex'); }
        await applyWeb();
      }
      if (b.smtp && typeof b.smtp === 'object') {
        const o = settings.smtp || {};
        let pass = o.pass || '', passEnc = o.passEnc;
        if (b.smtp.pass) { const plain = String(b.smtp.pass).slice(0, 500), enc = await encryptSecret(plain); if (enc) { passEnc = enc; pass = ''; } else { passEnc = undefined; pass = plain; } } // plain only if DPAPI is unavailable (non-Windows)
        settings.smtp = { host: String(b.smtp.host || '').slice(0, 253), port: Math.max(1, Math.min(65535, +b.smtp.port || 25)), ssl: !!b.smtp.ssl, user: String(b.smtp.user || '').slice(0, 253),
          pass, passEnc, from: String(b.smtp.from || '').slice(0, 253), to: String(b.smtp.to || '').slice(0, 500) };
      }
      if (b.trayAlerts != null) settings.trayAlerts = !!b.trayAlerts;
      // accept only parseable numbers (an empty form field leaves the current value alone); clampSettings bounds them
      for (const k of Object.keys(NUM_RANGE)) { const n = toNum(b[k]); if (b[k] != null && b[k] !== '' && Number.isFinite(n)) settings[k] = n; }
      if (b.startWithWindows != null && !remote) { const want = !!b.startWithWindows; if (asNow !== want) { startError = await setAutostart(want); if (!startError) asNow = want; } }
      if (['auto', '4', '6'].includes(String(b.ipVersion))) settings.ipVersion = String(b.ipVersion);
      if (b.openMode === 'app' || b.openMode === 'browser') settings.openMode = b.openMode;
      if (Array.isArray(b.alertRules)) settings.alertRules = sanitizeRules(b.alertRules);
      if (b.hostNames) settings.hostNames = sanitizeNames(b.hostNames);
      clampSettings(); // re-apply every range before persisting, so no path can save an out-of-range setting
      save(); return send(res, 200, pub2());
    }
    if (p === '/api/alerts') return send(res, 200, alertLog.slice(-200));
    if (p === '/api/targetlist') { // export / import target list file
      if (m === 'GET') return send(res, 200, targets.map(t => t.host).join('\n'), 'text/plain');
      const b = await readBody(req); const added = [];
      for (const host of String(b.text || '').split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean)) {
        if (targets.length >= MAX_TARGETS) break;
        if (!validHost(host) || targets.some(t => t.host === host)) continue;
        const ip = await lookupIp(host);
        if (!ip) continue;
        const t = { id: nextId++, host, ip, name: host, hops: [], count: 0, running: false, hidden: [] };
        targets.push(t); start(t); added.push(host);
      }
      save(); return send(res, 200, { added });
    }
    if (p === '/api/sampleset') { // export / import full sample set (.pp.json)
      if (m === 'GET') return send(res, 200, { version: 1, exported: Date.now(), targets: targets.map(t => ({ host: t.host, ip: t.ip, name: t.name, finalTtl: t.finalTtl || null, count: t.count || 0, hops: t.hops })) });
      const n = importSet(await readBody(req));
      save(); return send(res, 200, { ok: true, imported: n });
    }
    // saved sample sets in DATA_DIR/sets (File > Save sample set / Open recent)
    const setsDir = path.join(DATA_DIR, 'sets');
    const setName = s => { s = String(s || '').trim(); return /^[\w][\w .\-]{0,59}$/.test(s) && !/\.\./.test(s) ? s : null; };
    if (p === '/api/sets' && m === 'GET') {
      fs.mkdirSync(setsDir, { recursive: true });
      return send(res, 200, fs.readdirSync(setsDir).filter(f => f.endsWith('.pp.json')).map(f => { const st = fs.statSync(path.join(setsDir, f)); return { name: f.slice(0, -8), size: st.size, mtime: st.mtimeMs }; }).sort((a, b) => b.mtime - a.mtime));
    }
    if (p === '/api/sets' && m === 'POST') {
      const b = await readBody(req), name = setName(b.name); if (!name) return send(res, 400, { error: 'invalid set name' });
      const t = targets.find(x => x.id === +b.targetId);
      const data = { version: 1, exported: Date.now(), targets: (t ? [t] : targets).map(x => ({ host: x.host, ip: x.ip, name: x.name, finalTtl: x.finalTtl || null, count: x.count || 0, hops: x.hops })) };
      fs.mkdirSync(setsDir, { recursive: true }); fs.writeFileSync(path.join(setsDir, name + '.pp.json'), JSON.stringify(data));
      return send(res, 200, { ok: true, name });
    }
    const ms = p.match(/^\/api\/sets\/([^/]+)$/);
    if (ms) {
      const name = setName(decodeURIComponent(ms[1])), file = name && path.join(setsDir, name + '.pp.json');
      if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
      if (m === 'DELETE') { fs.unlinkSync(file); return send(res, 200, { ok: true }); }
      const n = importSet(JSON.parse(fs.readFileSync(file, 'utf8'))); save(); return send(res, 200, { ok: true, imported: n });
    }
    // email: test message and "send report"
    if (p === '/api/email/test' && m === 'POST') return send(res, 200, await sendMail('[PingTracer] test message', 'This is a test message from PingTracer.'));
    if (p === '/api/email/report' && m === 'POST') {
      const b = await readBody(req), t = targets.find(x => x.id === +b.targetId); if (!t) return send(res, 404, { error: 'not found' });
      return send(res, 200, await sendMail(`[PingTracer] report for ${t.host}`, `PingTracer report for ${t.host} (${t.ip})\nGenerated ${new Date().toISOString()}\n\n` + exportText(t, 'long', +b.focus || 0, false)));
    }
    // ---- configurations ----
    if (p === '/api/configs') {
      settings.configs = settings.configs || [];
      if (m === 'GET') return send(res, 200, [{ id: 'default', name: 'Default', intervalMs: settings.intervalMs, timeoutMs: settings.timeoutMs, packetSize: settings.packetSize, maxHops: settings.maxHops, keepDays: settings.historyDays, builtin: true }, ...settings.configs]);
      const b = await readBody(req); const src = b.copyOf && (b.copyOf === 'default' ? { intervalMs: settings.intervalMs, timeoutMs: settings.timeoutMs, packetSize: settings.packetSize, maxHops: settings.maxHops, keepDays: settings.historyDays } : settings.configs.find(c => c.id === b.copyOf)) || {};
      const c = { id: newId(), name: String(b.name || (src.name ? src.name + ' copy' : 'New configuration')).slice(0, 60), intervalMs: +b.intervalMs || src.intervalMs || settings.intervalMs, timeoutMs: +b.timeoutMs || src.timeoutMs || settings.timeoutMs, packetSize: b.packetSize != null ? +b.packetSize : (src.packetSize ?? settings.packetSize), maxHops: +b.maxHops || src.maxHops || settings.maxHops, keepDays: +b.keepDays || src.keepDays || settings.historyDays };
      clampCfg(c); // same ranges as Settings (spec §12)
      settings.configs.push(c); save(); return send(res, 200, c);
    }
    let mc = p.match(/^\/api\/configs\/([\w]+)(?:\/(move))?$/);
    if (mc) {
      settings.configs = settings.configs || []; const i = settings.configs.findIndex(c => c.id === mc[1]);
      if (mc[1] === 'default' && m === 'POST' && !mc[2]) return send(res, 400, { error: 'the default configuration is edited in Settings' });
      if (i < 0) return send(res, 404, { error: 'not found' });
      if (mc[2] === 'move' && m === 'POST') { const b = await readBody(req), j = i + (b.dir === 'up' ? -1 : 1); if (j >= 0 && j < settings.configs.length) { const [c] = settings.configs.splice(i, 1); settings.configs.splice(j, 0, c); } save(); return send(res, 200, { ok: true }); }
      if (m === 'DELETE') { settings.configs.splice(i, 1); targets.forEach(t => { if (t.configId === mc[1]) t.configId = null; }); for (const sm of settings.summaries || []) if (sm.configId === mc[1]) sm.configId = null; save(); return send(res, 200, { ok: true }); }
      if (m === 'PUT' || m === 'POST') { const b = await readBody(req), c = settings.configs[i];
        if (b.name != null) c.name = String(b.name).slice(0, 60); if (b.intervalMs) c.intervalMs = b.intervalMs; if (b.timeoutMs) c.timeoutMs = b.timeoutMs;
        if (b.packetSize != null) c.packetSize = b.packetSize; if (b.maxHops) c.maxHops = b.maxHops; if (b.keepDays) c.keepDays = b.keepDays;
        clampCfg(c); // one range table for every numeric override (spec §12)
        save(); return send(res, 200, c); }
    }
    if (p === '/api/packettypes') return send(res, 200, [{ id: 'icmp', name: 'ICMP Echo', port: false, available: true }, { id: 'tcp', name: 'TCP route trace (TTL-limited)', port: true, available: helperReady }, { id: 'udp', name: 'UDP route trace (TTL-limited)', port: true, available: helperReady }]);
    if (p === '/api/interfaces') return send(res, 200, Object.entries(os.networkInterfaces()).map(([name, a]) => ({ name, addresses: (a || []).map(x => ({ address: x.address, family: x.family, internal: x.internal, mac: x.mac })) })));
    // ---- summaries (named groups of targets / hops; "All Targets" is the Overview) ----
    if (p === '/api/summaries') {
      settings.summaries = settings.summaries || [];
      if (m === 'GET') return send(res, 200, [{ id: 'all', name: 'All Targets', builtin: true, members: targets.map(t => ({ tid: t.id, ttl: null })) }, ...settings.summaries]);
      const b = await readBody(req); const sm = { id: newId(), name: String(b.name || 'Summary').slice(0, 60), members: [], configId: null };
      for (const mm of Array.isArray(b.members) ? b.members : []) if (targets.some(t => t.id === +mm.tid)) sm.members.push({ tid: +mm.tid, ttl: mm.ttl ? +mm.ttl : null });
      settings.summaries.push(sm); save(); return send(res, 200, sm);
    }
    let msu = p.match(/^\/api\/summaries\/(\w+)(?:\/(\w+))?$/);
    if (msu) {
      const sm = (settings.summaries || []).find(x => x.id === msu[1]), act = msu[2];
      if (!sm) return send(res, 404, { error: 'not found' });
      if (!act && m === 'DELETE') { settings.summaries = settings.summaries.filter(x => x !== sm); save(); return send(res, 200, { ok: true }); }
      if (!act && (m === 'PUT' || m === 'POST')) { const b = await readBody(req); if (b.name) sm.name = String(b.name).slice(0, 60); save(); return send(res, 200, sm); }
      if (act === 'add' || act === 'remove') { const b = await readBody(req); for (const mm of Array.isArray(b.members) ? b.members : []) { const tid = +mm.tid, ttl = mm.ttl ? +mm.ttl : null;
          if (act === 'add' && targets.some(t => t.id === tid) && !sm.members.some(x => x.tid === tid && x.ttl === ttl)) sm.members.push({ tid, ttl });
          if (act === 'remove') sm.members = sm.members.filter(x => !(x.tid === tid && x.ttl === ttl)); } save(); return send(res, 200, sm); }
      if (act === 'config') { const b = await readBody(req); sm.configId = (b.configId && b.configId !== 'default') ? String(b.configId) : null; save(); return send(res, 200, sm); }
      if (act === 'loadlist') { const b = await readBody(req), added = []; for (const host of String(b.text || '').split(/[\r\n,;]+/).map(x => x.trim()).filter(Boolean)) { const t = await addTarget(host, { configId: sm.configId }); if (t) { sm.members.push({ tid: t.id, ttl: null }); added.push(host); } } save(); return send(res, 200, { added }); }
      if (act === 'list') return send(res, 200, sm.members.map(mm => (targets.find(t => t.id === mm.tid) || {}).host).filter(Boolean).join('\n'), 'text/plain');
    }
    if (p === '/api/summary-data') { // rows for a summary (or all targets); one row per member
      const sm = u.searchParams.get('id') === 'all' || !u.searchParams.get('id') ? null : (settings.summaries || []).find(x => x.id === u.searchParams.get('id'));
      const members = sm ? sm.members : targets.map(t => ({ tid: t.id, ttl: null }));
      return send(res, 200, members.map(mm => { const t = targets.find(x => x.id === mm.tid); if (!t) return null; const h = mm.ttl ? t.hops.find(x => x.ttl === mm.ttl) : t.hops[t.hops.length - 1];
        return { tid: t.id, host: t.host, running: !!t.running, ttl: h ? h.ttl : mm.ttl, hopIp: h ? h.ip : '', hopName: h ? (settings.hostNames[h.ip] || h.name) : '', stats: h ? (rng ? statsRange(t, h, rng.from, rng.to) : stats(h, focus)) : null, hops: t.hops.length, proto: t.proto || 'icmp' }; }).filter(r => r && (!ctx.share || shareTids(ctx.share).has(r.tid))));
    }
    // ---- stored sessions ----
    if (p === '/api/sessions' && m === 'GET') return send(res, 200, sessions.map(sessionInfo));
    let mse = p.match(/^\/api\/sessions\/(\d+)(?:\/(open))?$/);
    if (mse) {
      const i = sessions.findIndex(x => x.sid === +mse[1]); if (i < 0) return send(res, 404, { error: 'not found' });
      if (m === 'DELETE') { dbDelete(sessions[i].sid); sessions.splice(i, 1); save(); return send(res, 200, { ok: true }); }
      if (mse[2] === 'open' && m === 'POST') { const se = sessions[i]; if (targets.some(t => t.id === se.sid)) return send(res, 409, { error: 'already open' });
        const t = runtimeTarget(se.meta); t.autostart = false; t.running = false; targets.push(t); dbHydrate(t); sessions.splice(i, 1); save(); return send(res, 200, view(t, focus)); }
    }
    // ---- workspaces ----
    if (p === '/api/workspaces' && m === 'GET') { wsSaveCurrent(); return send(res, 200, { active: settings.workspace || 'Default', list: fs.readdirSync(wsDir()).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)) }); }
    if (p === '/api/workspaces' && m === 'POST') { // body: {action:'new'|'open'|'rename'|'delete'|'clear'|'export'|'import', name, to, data, history}
      const b = await readBody(req), act = b.action, cur = settings.workspace || 'Default';
      if (act === 'new') { const n = wsName(b.name); if (!n || fs.existsSync(wsFile(n))) return send(res, 400, { error: 'invalid or existing workspace name' }); wsSaveCurrent(); wsLoad({ targets: [], summaries: [] }); settings.workspace = n; wsSaveCurrent(); save(); return send(res, 200, { ok: true }); }
      if (act === 'open') { const n = wsName(b.name); if (!n || !fs.existsSync(wsFile(n))) return send(res, 404, { error: 'not found' }); wsSaveCurrent(); wsLoad(JSON.parse(fs.readFileSync(wsFile(n), 'utf8'))); settings.workspace = n; save(); return send(res, 200, { ok: true }); }
      if (act === 'rename') { const from = wsName(b.name || cur), to = wsName(b.to); if (!from || !to || fs.existsSync(wsFile(to))) return send(res, 400, { error: 'invalid or existing name' }); wsSaveCurrent(); if (fs.existsSync(wsFile(from))) fs.renameSync(wsFile(from), wsFile(to)); if (from === cur) settings.workspace = to; save(); return send(res, 200, { ok: true }); }
      if (act === 'delete') { const n = wsName(b.name); if (!n || n === cur) return send(res, 400, { error: 'cannot delete the current workspace' }); try { fs.unlinkSync(wsFile(n)); } catch {} return send(res, 200, { ok: true }); }
      if (act === 'clear') { for (const t of [...targets]) archiveTarget(t); settings.summaries = []; save(); return send(res, 200, { ok: true }); }
      if (act === 'export') { wsSaveCurrent(); const data = JSON.parse(fs.readFileSync(wsFile(cur), 'utf8')); data.targets.forEach((k, i) => { const t = targets[i]; if (t) k.hops.forEach(h => { const live = t.hops.find(x => x.ttl === h.ttl); h.samples = live ? live.samples : []; }); }); return send(res, 200, data); }
      if (act === 'import') { const d = b.data; if (!d || !Array.isArray(d.targets)) return send(res, 400, { error: 'not a workspace export' }); const n = wsName(b.name || d.name || 'Imported'); if (!n || fs.existsSync(wsFile(n))) return send(res, 400, { error: 'invalid or existing workspace name' });
        wsSaveCurrent(); const idMap = new Map(); const tg = []; // imported targets get new ids; samples go to the history DB only when History is requested
        for (const k of d.targets) { if (!validHost(k.host)) continue; const nid = nextId++; idMap.set(k.id, nid); const t = { ...k, id: nid, agent: undefined, autostart: false, running: false };
          t.hops = (Array.isArray(k.hops) ? k.hops : []).slice(0, 64).map(h => ({ ttl: +h.ttl | 0, ip: String(h.ip || ''), name: String(h.name || ''), samples: [] })).filter(h => h.ttl > 0);
          if (b.history) for (const h of Array.isArray(k.hops) ? k.hops : []) for (const sa of Array.isArray(h.samples) ? h.samples : []) histAdd(nid, +h.ttl | 0, +sa.t || 0, sa.ms == null ? null : +sa.ms);
          tg.push(t); }
        const sums = (Array.isArray(d.summaries) ? d.summaries : []).map(sm => ({ id: newId(), name: String(sm.name || 'Summary'), configId: null, members: (sm.members || []).filter(x => idMap.has(x.tid)).map(x => ({ tid: idMap.get(x.tid), ttl: x.ttl || null })) }));
        wsLoad({ targets: tg, summaries: sums }); settings.workspace = n; wsSaveCurrent(); save(); return send(res, 200, { ok: true, name: n }); }
      return send(res, 400, { error: 'unknown action' });
    }
    // ---- guidance ----
    if (p === '/api/guidance' && m === 'GET') return send(res, 200, guides());
    if (p === '/api/guidance/export' && m === 'POST') return send(res, 200, { ok: true, dir: exportGuides() });
    if (p === '/api/lan') {
      if (m === 'POST') { lanScan(); }
      return send(res, 200, { ...lan, devices: lan.devices, ouiLoaded: !!(oui && oui.size) || fs.existsSync(path.join(DATA_DIR, 'oui.csv')) });
    }
    if (p === '/api/lan/oui' && m === 'POST') { if (remote) return send(res, 403, { error: 'not allowed over the network' }); try { return send(res, 200, { ok: true, entries: await updateOui() }); } catch (e) { return send(res, 502, { error: 'vendor database download failed: ' + e.message }); } }
    if (p === '/api/wifi') {
      if (m === 'POST') { const b = await readBody(req); if (b.enabled) { settings.wifiMonitor = true; wifiStart(); } else { settings.wifiMonitor = false; wifiStop(); } save(); }
      else if (u.searchParams.get('scan') === '1') { if (!wifi.timer) await wifiPoll(); await wifiScan(); }
      const win = +u.searchParams.get('window') || 3600000;
      return send(res, 200, { supported: WIN, enabled: !!wifi.timer, error: wifi.error, current: wifi.current, history: wifi.history.filter(h => h.t >= Date.now() - win), neighbors: wifi.neighbors });
    }
    if (p === '/api/info') return send(res, 200, { engine: helperReady ? 'helper' : 'ping.exe', platform: os.platform(), version: APP_VERSION, data: DATA_DIR, tray: !!tray, agent: AGENT });
    if (p === '/api/dashboard') return send(res, 200, targets.map(t => { const h = t.hops[t.hops.length - 1]; return { id: t.id, host: t.host, running: !!t.running, hops: t.hops.length, final: h ? stats(h, focus) : null }; }));
    // static (embedded in the exe, or ./public in dev)
    const name = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    if (name.includes('..')) return send(res, 403, 'no');
    let d; try { d = asset('public/' + name); } catch { return send(res, 404, 'not found', 'text/plain'); }
    return send(res, 200, d, MIME[path.extname(name)] || 'application/octet-stream');
  } catch (e) { send(res, 500, { error: remote ? 'internal error' : String(e.message || e) }); }
};
// PT-8 (spec §13): the pure engine/API helpers are exported so unit tests can require() this file without
// starting the server. Everything with side effects (listen, helper/tray processes, DB, timers) stays below
// the require.main guard, so `node app/server.js` behaves exactly as before and `require('app/server.js')`
// only defines functions (it still creates the data dir, like any startup — point PP_DATA at a scratch dir).
module.exports = {
  APP_VERSION, SETTINGS_DEFAULTS, settings,
  validHost, portOf, PORT_ERR,
  clampNum, clampCfg, clampSettings, cfgOf,
  sanitizeRules, sanitizeNames,
  stats, statsRange, mos,
  trackRoute, protocolFinalTtl, classifyDestState,
  exportText, exportJson, exportMeta,
};

if (require.main === module) {
  http.createServer((q, s) => handle(q, s, false)).listen(PORT, AGENT ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(AGENT ? `PingTracer AGENT listening on 0.0.0.0:${PORT}\n  Agent token: ${AGENT_TOKEN}\n  (add this machine from a controller with URL http://<this-ip>:${PORT} and the token; traffic is plain HTTP, use a trusted network)`
                      : `PingTracer running at http://127.0.0.1:${PORT}`);
    startHelper(); startTray(); try { loadExtensions(); } catch (e) { extensions.length = 0; console.error('extensions unavailable:', e.message); } openDb(); load(); migrateSecrets(); applyWeb(); if (settings.wifiMonitor && !AGENT) wifiStart(); // an unreadable extensions folder must not stop startup (spec §12)
    if (OPEN) openUi();
  }).on('error', e => { if (e.code === 'EADDRINUSE') { if (OPEN) { openUi(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); } else { console.error('Port in use'); process.exit(1); } } });
  process.on('exit', () => { try { helper && helper.kill(); tray && tray.kill(); } catch {} });
}
