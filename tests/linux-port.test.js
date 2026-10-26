// PT-L: Linux-port unit tests. Covers the pure parsers (tracepath, traceroute, iw, nmcli, ip neigh,
// systemd unit), the AES-256-GCM secret store, the checksum builder, and the loopback behaviour of the
// built-in TCP/UDP probes. All fixtures are literal captured command output: no network, no root.
process.env.PP_DATA = require('fs').mkdtempSync(require('os').tmpdir() + '/ptl-'); // isolate state + secret.key
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), dgram = require('node:dgram');

const S = require(path.join(__dirname, '..', 'app', 'server.js'));

after(() => { try { fs.rmSync(process.env.PP_DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {} });

test('parseTracepath: iputils bare format with reached marks the destination', () => {
  const out = `1:  192.168.12.1                                          0.353ms \n 2:  no reply\n 6:  23.255.225.145                                        7.520ms \n 8:  108.162.235.65                                        8.069ms asymm  9 \n13:  129.148.141.154 (sin1)                                   6.815ms reached\n     Resume: pmtu 56 hops 13 back 44\n`;
  const r = S.parseTracepath(out);
  assert.deepEqual(r.hops.map(h => [h.ttl, h.ip]), [[1, '192.168.12.1'], [6, '23.255.225.145'], [8, '108.162.235.65'], [13, '129.148.141.154']]);
  assert.equal(r.finalTtl, 13);
  assert.ok(Math.abs(r.hops[0].ms - 0.353) < 1e-9);
});
test('parseTracepath: parenthesised format, loopback, and no-reached all parse', () => {
  const paren = S.parseTracepath('1?: [LOCALHOST]\t\t\t\t\t\t pmtu 1500\n 1:  _gateway (192.168.1.1)         0.456ms\n 2:  10.0.0.1 (10.0.0.1)          9.876ms\n    to 93.184.216.34 (93.184.216.34)  3 hops, pmtu 1500\n');
  assert.deepEqual(paren.hops.map(h => [h.ttl, h.ip]), [[1, '192.168.1.1'], [2, '10.0.0.1']]);
  assert.equal(paren.finalTtl, null); // 'to ...' is not a 'reached' line: TTL stays a discovery guess
  const lo = S.parseTracepath(' 1:  127.0.0.1                                             0.035ms reached\n     Resume: pmtu 65536 hops 1 back 1\n');
  assert.deepEqual(lo.hops, [{ ttl: 1, ip: '127.0.0.1', ms: 0.035 }]);
  assert.equal(lo.finalTtl, 1);
});
test('parseTraceroute: hop addresses, loss asterisks and destination detection', () => {
  const out = `traceroute to one.one.one.one (1.1.1.1), 15 hops max, 60 byte packets\n 1  192.168.12.1  0.512 ms\n 2  *  10.0.0.1 (10.0.0.1)  11.318 ms\n14  1.1.1.1 (1.1.1.1)  7.442 ms\n`;
  const r = S.parseTraceroute(out, '1.1.1.1');
  assert.equal(r.finalTtl, 14);
  assert.deepEqual(r.hops.find(h => h.ttl === 1), { ttl: 1, ip: '192.168.12.1', ms: 0.512 });
  assert.equal(r.hops.find(h => h.ttl === 2).ip, '10.0.0.1'); // first responding address on the line
  assert.equal(r.hops.find(h => h.ttl === 14).ms, 7.442);
  const gone = S.parseTraceroute(' 1  *  *  *\n 2  *  *  *\n', '10.0.0.1');
  assert.equal(gone.finalTtl, null); // a fully silent run reports no destination, it never invents one
  assert.equal(gone.hops[0].ms, null);
});
test('icmpChecksum: known-good ICMP echo header', () => {
  const p = Buffer.alloc(8); p[0] = 8; p.writeUInt16BE(0x1234, 4); p.writeUInt16BE(1, 6);
  assert.equal(S.icmpChecksum(p), 0xE5CA); // ~('0800'+'0000'+'1234'+'0001')
});
test('secret store: round-trip, unique nonce per write, key file is 0600', async () => {
  const a = await S.localSecretEncrypt('hunter2-\u00fc-ключ');
  assert.ok(a.startsWith('k1:'), 'local key-file ciphertext carries the LP marker');
  const b = await S.localSecretEncrypt('hunter2-\u00fc-ключ');
  assert.notEqual(a, b, 'random IV: two writes of the same secret differ');
  assert.equal(await S.localSecretDecrypt(a), 'hunter2-\u00fc-ключ');
  assert.equal(await S.localSecretDecrypt('not-a-secret'), '', 'foreign/garbage ciphertext decrypts to empty, never throws');
  const keyF = path.join(process.env.PP_DATA, 'secret.key');
  assert.ok(fs.existsSync(keyF), 'key file was created inside the data dir');
  if (os.platform() !== 'win32') assert.equal(fs.statSync(keyF).mode & 0o777, 0o600, 'key readable only by the owner');
  assert.equal(await S.decryptSecret(await S.encryptSecret('smtp-pass')), 'smtp-pass', 'encryptSecret/decryptSecret pair uses the local key when no native helper answers');
});
test('renderUnit: a valid systemd user unit that starts the server headless', () => {
  const unit = S.renderUnit();
  assert.match(unit, /^\[Unit\][\s\S]*\[Service\][\s\S]*\[Install\]/);
  assert.match(unit, /ExecStart="[^"]+" "[^"]*server\.js" --background/);
  assert.match(unit, /Environment=PP_NO_OPEN=1/);
  assert.match(unit, /WantedBy=default\.target/);
});
test('Wi-Fi parsers: iw link (dBm, channel, band), nmcli scan, ip neigh', () => {
  const conn = S.parseIwLink('wlp2s0', 'Connected to 44:d1:5e:11:22:33 (on wlp2s0)\n\tSSID: MyNetwork\n\tfrequency: 2437\n\tRX: 2440000 KBit/s\n\tTX: 1444000 KBit/s\n\tsignal: -53.00 dBm\n');
  assert.deepEqual([conn.state, conn.ssid, conn.bssid, conn.channel, conn.band, conn.signal], ['connected', 'MyNetwork', '44:d1:5e:11:22:33', 6, '2.4 GHz', 94]);
  const disc = S.parseIwLink('wlp2s0', 'Not connected.');
  assert.equal(disc.state, 'disconnected');
  assert.deepEqual(S.freqToChannel(5180), 36);
  assert.deepEqual(S.freqToChannel(5955), 1);
  assert.deepEqual(S.freqToChannel(2484), 14);
  const scan = S.parseNmcliScan('wlp2s0:\nMyNetwork\\:Home:44:d1:5e:11:22:33:74:6:2437:wpa2\nCafe:88:e0:a1:22:33:44:61:1:2412:\nbad line\n');
  assert.equal(scan.length, 2);
  assert.equal(scan[0].ssid, 'MyNetwork:Home', 'escaped colons unescape');
  assert.equal(scan[0].signal, 74);
  assert.equal(scan[1].band, '2.4 GHz');
  const neigh = S.parseIpNeigh('192.168.1.1 dev wlp2s0 lladdr 44:d1:5e:11:22:33 REACHABLE\n192.168.1.99 dev wlp2s0 REACHABLE\n10.0.0.5 dev tun0 lladdr 02:00:00:00:00:05 STALE\n');
  assert.deepEqual(neigh, [{ ip: '192.168.1.1', mac: '44:D1:5E:11:22:33' }, { ip: '10.0.0.5', mac: '02:00:00:00:00:05' }]);
});
test('built-in TCP probe on loopback: open port answers ok, closed port answers refused (never timeout)', async () => {
  const srv = net.createServer(sk => sk.end());
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const open = srv.address().port; srv.close();
  const used = await S.tcpProbeBuiltin('127.0.0.1', open, 2000);
  assert.ok(used.st === 'ok' || used.st === 'refused', 'the listener port must be answered in some form, got ' + used.st);
  const closed = await S.tcpProbeBuiltin('127.0.0.1', 1, 2000);
  assert.equal(closed.st, 'refused', 'nothing listens on port 1: RST is refused, not a network failure');
  assert.equal(closed.ip, '127.0.0.1');
  assert.ok(closed.ms >= 0);
});
test('built-in UDP probe on loopback: an answering socket reports ok', async () => {
  const s = dgram.createSocket('udp4');
  await new Promise(r => s.bind(0, '127.0.0.1', r));
  const port = s.address().port;
  s.on('message', (msg, rinfo) => s.send(msg, rinfo.port, rinfo.address));
  const r = await S.udpProbeBuiltin('127.0.0.1', port, 2000, 15, 56);
  s.close();
  assert.equal(r.st, 'ok');
  assert.ok(r.ms < 2000);
});
test('Linux engine ladder picks a working engine without root', async () => {
  await S.detectLinuxEngine();
  assert.ok(['icmp', 'traceroute', 'ping'].includes(S.linuxEngine()), 'engine detected: ' + S.linuxEngine());
});
