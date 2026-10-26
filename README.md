# PingTracer (Linux)

Continuous traceroute & ping monitor for **Ubuntu and other Linux distributions**. Trace
several targets at once, watch every hop on the route in real time, keep months of
history, and find out *where* a network problem starts — not just that the internet is
"slow".

This is the Linux port of [PingTracer for Windows](https://github.com/JonnyUtah12/ping-tracer).
It is a plain Node.js application: no root, no daemon, no firewall rules, no administrator
rights, and nothing is written outside your own home directory (unless you install the
`.deb`). The original Windows README is kept as
[README-windows-original.md](README-windows-original.md).

- Linux repository: <https://github.com/JonnyUtah12/ping-tracer-linux>
- Windows original: <https://github.com/JonnyUtah12/ping-tracer> · releases: <https://github.com/JonnyUtah12/ping-tracer/releases>
- Changelog: [CHANGELOG.md](CHANGELOG.md) · Developer guide: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- In-app guide: `http://127.0.0.1:8765/docs.html`

---

## Table of contents

1. [Quick start](#quick-start)
2. [System requirements](#system-requirements)
3. [Install](#install)
4. [Running it, and start at login](#running-it-and-start-at-login)
5. [Probe engines on Linux: what you get, and why](#probe-engines-on-linux-what-you-get-and-why)
6. [Features](#features)
7. [Where your data lives](#where-your-data-lives)
8. [Command line](#command-line)
9. [Sharing over your network (HTTPS)](#sharing-over-your-network-https)
10. [Permissions and firewall](#permissions-and-firewall)
11. [Linux specifics: how Windows features were replaced](#linux-specifics-how-windows-features-were-replaced)
12. [Building a .deb, and verifying it](#building-a-deb-and-verifying-it)
13. [Troubleshooting](#troubleshooting)
14. [Known limitations](#known-limitations)
15. [Testing](#testing)
16. [Bug reports](#bug-reports)

---

## Quick start

```bash
git clone https://github.com/JonnyUtah12/ping-tracer-linux.git
cd ping-tracer-linux
scripts/check-deps.sh          # tells you what is present and what is missing
node app/server.js             # opens http://127.0.0.1:8765
```

Type a hostname, press **Trace**, and PingTracer discovers the route and starts probing
every hop continuously.

To install it as a normal per-user application (launcher, menu entry, optional
start-at-login, data in `~/.local/share/PingTracer`):

```bash
scripts/install-linux.sh                 # add --autostart to also enable the login service
~/.local/bin/pingtracer
```

`scripts/check-deps.sh` never runs anything as root and never asks for a password: it
prints the `sudo apt install …` command for anything that is missing. A tool that is not
installed is always reported as **not installed** — the app never dresses a missing
binary up as a network failure, so a red hop means a real network problem.

## System requirements

| Needs | Why | Ubuntu package |
|---|---|---|
| **Node.js ≥ 22.5** | runs the app, and stores history with `node:sqlite` (stable from 22.5) | see below |
| `ping` (iputils) | destination probes | `iputils-ping` |
| `tracepath` (iputils) | hop-address discovery in the fallback engine | `iputils-tracepath` / `iputils-ping` |
| `ip` (iproute2) | routes, neighbour/ARP table, interfaces (replaces Windows `arp -a`) | `iproute2` |
| `openssl` | self-signed certificate for HTTPS sharing (replaces the Windows certificate store) | `openssl` |
| `traceroute` *(recommended)* | the best per-hop engine; without it hop addresses come from `tracepath` and the destination is polled with `ping` | `traceroute` |
| `xdg-open` *(optional)* | open the interface in your browser | `xdg-utils` |
| `systemd` *(optional)* | start-at-login as a *user* service | present by default on Ubuntu |
| `jq`, `dpkg-deb` *(optional)* | prettier CLI output / building a `.deb` | `jq`, `dpkg` |

**Node.js version.** Ubuntu's own `nodejs` apt package is older than 22.5 on 22.04 and
24.04, so install a current LTS from the official NodeSource repository (or your distro's
newer snap/module):

```bash
# Node.js 22 LTS from NodeSource (Ubuntu 22.04 / 24.04)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version    # v22.x
```

`scripts/check-deps.sh` checks all of it at once.

## Install

### 1. Run from the source tree (no install step)

```bash
node app/server.js                    # interface: http://127.0.0.1:8765
PP_DATA=~/ppdata node app/server.js   # keep your data somewhere else
PORT=8800 node app/server.js          # use a different port
```

Data goes to `./app/data` next to the code, or to `~/.local/share/PingTracer/data` when
that folder is not writable.

### 2. Per-user install (recommended)

```bash
scripts/install-linux.sh [--prefix ~/.local] [--port N] [--autostart] [--no-desktop]
```

| Path | What |
|---|---|
| `~/.local/share/pingtracer/` | the app (`server.js`, `public/`) |
| `~/.local/bin/pingtracer` | launcher; `pingtracer cli …` drives a running instance |
| `~/.local/share/applications/pingtracer.desktop` | menu entry (validated with `desktop-file-validate`) |
| `~/.config/systemd/user/pingtracer-linux.service` | only with `--autostart` |
| `~/.local/share/PingTracer/data` | your targets, history, settings |

No root, no system service, no registry. `~/.local/bin` must be in your `PATH` (the
installer tells you if it is not).

### 3. System-wide `.deb`

```bash
scripts/build-deb.sh dist/
sudo apt install ./dist/pingtracer_1.1.2-1_all.deb
pingtracer                # data stays per-user in ~/.local/share/PingTracer/data
pingtracer check-deps
```

The package declares `Depends: nodejs (>= 22.5), iputils-ping, iproute2, openssl` and
`Recommends: traceroute, xdg-utils`; `dpkg-deb --info` on the built file shows exactly
that. The versioned `nodejs` dependency is satisfied by NodeSource, not by Ubuntu's own
`nodejs` package (see [System requirements](#system-requirements)).

Uninstall: `scripts/uninstall-linux.sh` (keeps your history; `--data` removes it), or
`sudo apt remove pingtracer` for the package.

## Running it, and start at login

- **Launcher:** `~/.local/bin/pingtracer`
- **Menu entry:** "PingTracer" under Network / System
- **Start at login:** the `--autostart` install option, or Settings ▸ *Start at login*,
  writes a **systemd user unit** `~/.config/systemd/user/pingtracer-linux.service` and
  enables it with `systemctl --user enable pingtracer-linux`. Inspect it with
  `systemctl --user status pingtracer-linux`, read its log with
  `journalctl --user -u pingtracer-linux`. Nothing is installed for other users and no
  root privilege is involved — this unit is what replaces the Windows "Run" registry key.

## Probe engines on Linux: what you get, and why

Linux does not let an ordinary program send raw ICMP with a chosen TTL the way the
Windows build does, so PingTracer picks the best available engine at startup and tells
you which one it is using (in the window, and in `GET /api/info`). In order of preference:

1. **ICMP ping socket (no root).** Exact per-hop RTT, the same behaviour as Windows.
   Needs an unprivileged ICMP ping socket — `net.ipv4.ping_group_range` must include your
   group (Ubuntu's default `0 2147483647` allows every user) — **and** Node.js below 24:
   Node 24 removed the raw-socket datagram API, so on Node 24+ this engine is unavailable.
2. **`traceroute` (recommended).** Continuous per-hop tracing as a subprocess, parsed
   line by line. `sudo apt install traceroute` — this is the engine most Ubuntu users
   should use.
3. **`tracepath` + `ping` (last resort, no extra packages).** `tracepath` discovers the
   hop addresses, `ping` keeps probing the destination. `tracepath` has no per-probe
   timeout, so the **first** round on a silent path can take tens of seconds (a 9-hop
   route discovers in roughly a minute); hops appear **as they answer** rather than all at
   once. After discovery the destination is polled at your interval and the routers keep
   their discovery latency. `/api/info` reports
   `tracepath + ping (traceroute not installed)`.

TCP and UDP targets use built-in Node.js probes: the protocol probe determines the path
length, and the destination state (`open` / `refused` / `filtered` / `unreachable`) comes
from the socket's own error; router addresses for those targets are attributed with the
ICMP engine above.

What "no data" means, deliberately:

- an engine that cannot run → the app says so in words (`traceroute: not installed — …
  sudo apt install traceroute`) and **never** paints the hop red as packet loss;
- a router that does not answer → that is a real silent hop, shown as loss.

## Features

**Targets and monitoring:** many targets at once, ICMP / TCP / UDP probes, per-hop
latency, loss and jitter, MOS estimate, live hop chart, focus windows (5 min → 90 days),
target sets, workspaces, per-hop notes, and route-change detection (the route text is
recorded, so a path change is visible instead of silently merged into one graph).

**Analysis:** summary sessions, CSV / JSON / wide / long exports, sample timeline export,
CLI control, and interpretation guides built into the app (`docs.html`).

**Network maps:** LAN device discovery (ping sweep + neighbour table from `ip -4 neigh` +
reverse DNS + SSDP/mDNS, with MAC vendor names — the IEEE vendor list is downloaded on
demand from Settings, ~40,000 entries, needs internet) and Wi-Fi monitoring (`iw` /
`nmcli`; on a machine with no Wi-Fi hardware it reports "not available" instead of
guessing).

**Alerting:** alert rules with e-mail (SMTP) notification and per-rule webhooks.

**Sharing:** read-only HTTPS shares for phones and colleagues
([below](#sharing-over-your-network-https)), and remote **agents** — run
`node app/server.js --agent` on another machine and trace through it (listens on 8766;
plain HTTP, so use it on a trusted network).

## Where your data lives

| File | Contents |
|---|---|
| `state.json` | targets, settings, workspaces — written `0600` |
| `history.db` (+ `-wal`, `-shm`) | SQLite sample history (`node:sqlite`; no native module to build) |
| `secret.key` | key for the encrypted secrets (SMTP password, agent tokens), mode `0600`, AES-256-GCM |
| `secrets.json` | the encrypted secrets |
| `oui.csv` | downloaded MAC vendor list |
| `web.key`, `web.cert` | self-signed TLS pair, key mode `0600` |
| `extensions/` | your extension scripts |

Default location: `~/.local/share/PingTracer/data` (installer) or `./app/data` (source
run); `PP_DATA=/path` overrides it. Copying that folder to another machine moves your
history. Nothing is written outside it, and nothing is uploaded: the outbound traffic is
your own probes, the SMTP/webhook calls you configure, the IEEE vendor-list download you
click, and version checks.

## Command line

`pingtracer cli …` (installed) or `node app/server.js cli …` drives the running instance:

```
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
cli guidance                     print the interpretation guides
```

Output is JSON — pipe it to `jq` (optional) for prettier output.

## Sharing over your network (HTTPS)

Settings ▸ *Share over the network* starts an HTTPS listener (default port 8767) on your
LAN addresses. On Linux the self-signed certificate pair is generated with `openssl` into
your data folder (`web.key`, mode `0600`) and TLS 1.2 is the minimum. Shares are
read-only and token/login protected: without a token the API answers `401 login
required`. The app lists the URLs to use (e.g. `https://192.168.12.50:8797`); a browser
will warn that the certificate is self-signed, which is expected for a local private
certificate.

## Permissions and firewall

No firewall rule, capability, setuid binary, `sudo`, or system service is required.
Probes use unprivileged ICMP ping sockets (kernel setting `net.ipv4.ping_group_range`,
open to all users on Ubuntu by default) or ordinary `ping` / `tracepath` / `traceroute`
subprocesses. The only port that listens by default is `127.0.0.1:8765` (the interface,
not reachable from the network); `8767` and `8766` listen **only if you turn on** sharing
or agent mode.

## Linux specifics: how Windows features were replaced

| Windows | Linux port |
|---|---|
| `PingTracer.exe` (single file, Node embedded) | `node app/server.js`, a `~/.local/bin/pingtracer` launcher, or the `.deb` |
| System tray icon (`pptray.exe`) | menu entry + browser interface; `/api/info` reports `tray: false` |
| `pphelper.exe` (elevated C# helper for TTL-limited TCP/UDP probes) | built-in Node.js TCP/UDP probes, no elevation (a user-mode socket cannot set TTL, so hop attribution uses the ICMP engine) |
| Raw ICMP with a chosen TTL | unprivileged ping socket → `traceroute` → `tracepath` + `ping` |
| Registry `Run` key for start-at-login | systemd **user** unit `pingtracer-linux.service` |
| DPAPI-protected secrets | AES-256-GCM with a `0600` `secret.key` in the data folder |
| `New-SelfSignedCertificate` + PFX in the certificate store | `openssl req -x509 …` into `web.key` / `web.cert` |
| `arp -a` | `ip -4 neigh show` |
| `netsh wlan` Wi-Fi | `iw` / `nmcli` |
| PowerShell for registry / Wi-Fi / certificates | `execFile` with argument arrays (no shell string interpolation) |
| Antivirus false positives & SmartScreen | not applicable |

## Building a .deb, and verifying it

```bash
scripts/build-deb.sh dist/
sha256sum dist/pingtracer_1.1.2-1_all.deb
dpkg-deb --info dist/pingtracer_1.1.2-1_all.deb      # what it will require
dpkg-deb --contents dist/pingtracer_1.1.2-1_all.deb  # every file it will install
```

The package is **not signed**, and this repository has no `LICENSE` file yet, so the
`.deb` is a convenience build: check the SHA-256 of what you downloaded against the one
published with it, and read `usr/share/doc/pingtracer/copyright` inside.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `PingTracer: traceroute: not installed — … falling back to tracepath + ping` | a tooling message, not a network problem. `sudo apt install traceroute` for per-hop tracing |
| First round of a new target takes 20–60 s, hops arrive one at a time | you are on the `tracepath` engine; install `traceroute` for fast continuous per-hop data |
| Destination hop gets a value every interval, middle hops do not | expected on `tracepath + ping`: the destination is polled continuously, routers keep their discovery latency |
| No hops at all, target "silent" | run `scripts/check-deps.sh`, then `ping <host>` and `tracepath <host>` yourself. A VPN, a host firewall that drops ICMP, or an ISP that filters TTL probes can silence a path |
| `Cannot find module 'node:sqlite'` or a `node:sqlite` start-up error | Node.js is older than 22.5 — install a current LTS ([System requirements](#system-requirements)) |
| `Port in use` at start-up | another instance is running: `pingtracer cli status`, or start with `PORT=8800` |
| Menu entry does not appear | run `update-desktop-database ~/.local/share/applications`, and check that `~/.local/share/applications` is in your desktop search path |
| MAC vendor names missing | Settings ▸ download the vendor list (needs internet, writes `oui.csv`) |
| Wi-Fi panel says not available | no Wi-Fi interface; `iw` / `nmcli` need Wi-Fi hardware |
| Start-at-login does nothing | `systemctl --user status pingtracer-linux`; on a headless machine enable lingering with `loginctl enable-linger $USER` |

## Known limitations

- On the `tracepath + ping` engine, router latency is measured during discovery, not every
  interval; install `traceroute` for continuous per-hop data.
- TCP/UDP probes from user-mode sockets cannot set a TTL, so for TCP/UDP targets the hop
  *addresses* come from the ICMP engine while the protocol probes determine the path
  length and the destination state.
- The ICMP socket engine needs Node.js < 24 (Node 24 removed the API); the engine ladder
  covers that with `traceroute`.
- No system tray on Linux.
- Only Debian/Ubuntu packaging (`.deb`); no RPM, Snap or Flatpak.
- Wi-Fi monitoring needs `iw`/`nmcli` and Wi-Fi hardware; the MAC vendor list is a
  download, not bundled.
- No `LICENSE` file in the repository yet (same as the Windows original).

## Testing

Pure-Node test suite, no external dependencies; the engine tests do not need network
access:

```bash
node --test --test-concurrency=1 "tests/**/*.test.js"
```

71 tests cover the engine ladder and its parsers, ICMP/TCP/UDP probes on loopback, the
secret store, `tracepath`/`traceroute` output parsing, systemd unit rendering, Wi-Fi and
neighbour parsers, target lifecycle, configuration clamping, TCP/UDP route tracing, the
JSON export envelope, and the security tests (path traversal, token handling, share
scoping). `scripts/check-deps.sh` is the runtime-side check.

## Bug reports

Open an issue: <https://github.com/JonnyUtah12/ping-tracer-linux/issues>. Please include
the output of `scripts/check-deps.sh`, the engine string from `pingtracer cli status`,
what you expected, and what you saw. A screenshot of the hop chart plus the target's
host, protocol and port helps a lot.
