# PingTracer (Linux) — developer guide

How to run, test, package and release the **Linux** port. End-user documentation lives in
[README.md](../README.md); the Windows developer guide is kept as
[DEVELOPMENT-windows-original.md](DEVELOPMENT-windows-original.md).

## Repository layout

```
app/
  server.js            engine + REST API + static server (Node built-ins only, zero npm deps)
  public/index.html    the GUI (single file, no framework)
  public/docs.html     REST API reference, served at /docs.html
  data/                runtime data when run from the source tree (git-ignored)
  sea-config.json      Windows SEA build config — unused on Linux, kept for diff parity
scripts/
  check-deps.sh        dependency report; names the apt package for anything missing
  install-linux.sh     per-user install: launcher, menu entry, optional systemd user unit
  uninstall-linux.sh   removes what the installer created (--data also removes history)
  build-deb.sh         builds dist/pingtracer_<version>-1_all.deb and inspects it
tests/                 node:test suites (zero dependencies)
docs/                  this guide
.github/workflows/     linux-ci.yml (tests on Node 22.5 / 22.x / 24.x + .deb job)
```

There is **no `package.json`**: the app runs on Node built-ins only (`node:sqlite`,
`node:crypto`, `node:dgram`, `node:child_process`, …), so there is nothing to install and
no dependency tree to audit. Run it with `node app/server.js`.

## Running and testing

```bash
node app/server.js                                  # http://127.0.0.1:8765
PP_DATA=/tmp/pp PORT=8800 PP_NO_OPEN=1 node app/server.js   # scratch data, other port, no browser
node app/server.js cli status                       # talk to the running instance
node --test --test-concurrency=1 "tests/**/*.test.js"       # the whole suite
node --test tests/linux-port.test.js                        # one file
```

Test-suite conventions learned the hard way:

- Always pass `--test-concurrency=1`. The suites boot real servers on fixed ports
  (8765/8767); in parallel they collide.
- Every test that starts the app must set `PP_DATA` to a fresh `mkdtemp` directory — the
  module creates its data folder at `require()` time.
- A probe promise must settle on **every** path. A `throw` inside a dgram callback leaves
  the promise pending, and `node --test` then reports
  *"Promise resolution is still pending but the event loop has already resolved"* and
  stalls for minutes on that file. The UDP probe hit exactly this.
- The engine tests must pass with **no** network access and no root: they use loopback
  sockets, an echo server, and closed ports.

## The probe engine (Linux)

`runRound()` is the per-target round. Linux-relevant parts, in order:

| Function | Role |
|---|---|
| `run(cmd, args, opts)` | the only `execFile` wrapper: argument arrays (never a shell string), a timeout, `ENOENT` → `{ missing: true, err: "<cmd>: not installed" }` |
| `runStream(cmd, args, onLine, opts)` | streaming sibling: consumes stdout line by line, kills at the cap and resolves with what it got |
| `icmpProbeBuiltin(host, ttl, timeoutMs)` | unprivileged ICMP ping socket; on Node ≥ 24 `dgram.createSocket({type:'ipv4',protocol:'ICMP'})` throws `ERR_SOCKET_BAD_TYPE`, so this reports `unpriv` |
| `tcpProbeBuiltin` / `udpProbeBuiltin` | built-in protocol probes; destination state comes from the socket error (`ok` / `refused` / `timeout` / `unreachable`) |
| `protoProbe(proto, …)` | dispatch for TCP/UDP targets |
| `tracepathProbe(host, maxHops, timeoutMs, onHop)` | hop discovery, **streamed**: hops are reported as each TTL answers |
| `parseTracepathLine` / `parseTracepath` | `tracepath -n` line/output parsers (`no reply` = silent hop, `reached` = final TTL) |
| `tracerouteProbe` / `parseTraceroute` | `traceroute -n -q 1 -m N -w S -z 15` engine |
| `pingProbe(host, ttl, …)` | iputils `ping`; **no TTL option on Linux**, so it is used for destination-only probes |
| `detectLinuxEngine()` / `LINUX_ENGINE` | the ladder: `icmp` → `traceroute` → `ping`, decided once at startup, reported by `GET /api/info` |
| `probe()` | the generic TTL probe used by the Windows/ICMP paths; on Node ≥ 24 it returns `null` on Linux, which is why the `ping` engine branch calls `pingProbe` directly |

Two invariants that must survive future edits:

1. **Never present a tooling problem as a network one (spec §4).** A probe that cannot
   run returns `null`/`missing` and the UI says so in words; it must not push a `null`
   sample that the charts would draw as 100 % loss.
2. **`tracepath` must stay streamed.** iputils block-buffers stdout when it is a pipe:
   `execFile` plus a timeout that fires mid-discovery returns **zero bytes** (verified on
   Ubuntu), which historically produced targets with no hops at all. `stdbuf -oL` plus
   `runStream()` is the fix; `run()` alone is a regression.

Engine behaviour on a stock Ubuntu 24.04 (no `traceroute`, Node ≥ 24):
`/api/info` → `tracepath + ping (traceroute not installed)`, a startup line
`PingTracer: traceroute: not installed — … sudo apt install traceroute`, hop addresses
appearing during the first round, then the destination probed every interval.

## Linux substitutions

| Windows mechanism | Linux implementation |
|---|---|
| `pphelper.exe` (C#, elevated) | built-in Node TCP/UDP probes; hop attribution falls back to the ICMP engine because a user-mode socket cannot set TTL |
| Raw ICMP socket with chosen TTL | `dgram` ICMP ping socket (Node < 24, `net.ipv4.ping_group_range`) → `traceroute` → `tracepath` + `ping` |
| Registry `Run` key | `renderUnit()` → `~/.config/systemd/user/pingtracer-linux.service`, `systemctl --user` (unit-tested, `LINUX_ENGINE`-independent) |
| DPAPI-protected secrets | `localSecretEncrypt/Decrypt`: AES-256-GCM, key in `secret.key` mode `0600`; foreign (e.g. Windows DPAPI) ciphertext decrypts to `''`, never throws |
| `New-SelfSignedCertificate` + PFX | `ensureCert()`: `openssl req -x509 … -addext subjectAltName=…`, `web.key` chmod 600, TLS ≥ 1.2 in `applyWeb()` |
| `arp -a` | `ip -4 neigh show` (`parseIpNeigh`) |
| `netsh wlan` | `iw` / `nmcli` (`parseIwLink`, `parseNmcliScan`, `wifiLinuxDev`) |
| tray icon (`pptray.exe`) | not available on Linux; `/api/info` reports `tray: false` |

All of these are reached through `LINUX`/`WIN` branches in the same file as the Windows
code, so a single `server.js` stays diff-able against the Windows original — keep it that
way when you port fixes upstream.

## Packaging

```bash
bash scripts/check-deps.sh
bash scripts/install-linux.sh --prefix ~/.local --autostart
bash scripts/uninstall-linux.sh --prefix ~/.local
bash scripts/build-deb.sh dist
```

The installer writes, per user: `~/.local/share/pingtracer/{server.js,public}`,
`~/.local/bin/pingtracer`, `~/.local/share/applications/pingtracer.desktop` (validated
with `desktop-file-validate`), and with `--autostart` the systemd user unit. Data lives in
`~/.local/share/PingTracer/data` (`PP_DATA` overrides); the source tree keeps
`app/data/`.

`.deb` contents: `/usr/share/pingtracer/{server.js,public,scripts/check-deps.sh}`,
`/usr/bin/pingtracer`, desktop entry, `usr/share/doc/pingtracer/{README.md,changelog.gz,
changelog.Debian.gz,copyright}`, `DEBIAN/{control,postinst,postrm}`. Control declares
`Depends: nodejs (>= 22.5), iputils-ping, iproute2, openssl` and
`Recommends: traceroute, xdg-utils` — the versioned Node dependency is not satisfied by
Ubuntu's own `nodejs` package, which the README states plainly. The package is unsigned
and the repository has no `LICENSE` file, so the copyright file says redistribution
requires asking upstream.

## Releasing

1. Bump `APP_VERSION` in `app/server.js` (line ~17) and add a `CHANGELOG.md` section.
2. `node --test --test-concurrency=1 "tests/**/*.test.js"` must be green.
3. `bash scripts/build-deb.sh dist` → publish `dist/*.deb` plus `SHA256SUMS.txt`
   (`sha256sum dist/*.deb > dist/SHA256SUMS.txt`) as a GitHub release.
4. Tag `v<version>`, keeping the tag in sync with `APP_VERSION`.
5. `.github/workflows/linux-ci.yml` runs the same tests on Node 22.5 / 22.x / 24.x and
   builds the `.deb` with the same scripts, so CI and a local build must agree.

## Notes for upstream sync with the Windows repository

- `app/public/*` and the REST API are shared; Linux-only code sits in `LINUX` branches.
- Files that exist only upstream and are not ported: `app/helper/*.cs`, `app/build.ps1`,
  `app/build-installer.ps1`, `app/installer/`, `app/start.bat`, `packaging/`,
  `app/sea-config.json` (kept, unused).
- The Windows release workflow signs binaries; on Linux the equivalent step is the
  published `SHA256SUMS.txt`, because nothing here is compiled and nothing is signed.
