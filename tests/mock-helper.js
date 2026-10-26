// Mock of helper/pphelper.exe for engine tests on non-Windows dev machines (PP_HELPER_CMD hook).
// Speaks the same line protocol:
//   ICMP:  "id host ttl timeoutMs size"        -> "id status ip rttMs"
//   TCP:   "T id host port timeoutMs ttl size" -> "id ok|refused|timeout ip ms"
//   UDP:   "U id host port timeoutMs ttl size" -> "id ok|refused|timeout ip ms"
// Canned loopback behaviour: ICMP answers ttl-expired below 3 and echo-reply at 3+; TCP 18765 completes
// the handshake at ttl 3+, TCP 18766 answers RST at every ttl, UDP 18767 never answers (filtered).
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', line => {
  const p = line.split(' ');
  if ((p[0] === 'T' || p[0] === 'U') && p.length >= 6) {
    const [id, host, port, ttl] = [p[1], p[2], +p[3], +p[5]];
    let out = `${id} timeout - 0`;
    if (host === '127.0.0.1') {
      if (p[0] === 'T' && port === 18765 && ttl >= 3) out = `${id} ok 127.0.0.1 3.4`;
      else if (p[0] === 'T' && port === 18766) out = `${id} refused 127.0.0.1 1.2`;
      else if (p[0] === 'U' && port === 18768) out = `${id} refused 127.0.0.1 1.1`;
    }
    process.stdout.write(out + '\n');
    return;
  }
  if (p.length >= 4 && !Number.isNaN(+p[0])) {
    const [id, ttl] = [p[0], +p[2]];
    process.stdout.write(ttl < 3 ? `${id} ttl 10.0.0.${ttl} 1.5\n` : `${id} ok 127.0.0.1 0.6\n`);
  }
});
