# PingTracer

Continuous traceroute & ping monitor for Windows. Trace several targets at once,
watch every hop on the route in real time, keep months of history, and find out
*where* a network problem starts — not just that the internet is "slow".

PingTracer is a **portable single-file Windows app**: download a zip, extract
it, double-click `PingTracer.exe`. No installer, no administrator rights, and
**no Python, Node.js, npm, SDK or runtime to install** — everything needed is
inside the one executable.

- Repository: <https://github.com/JonnyUtah12/ping-tracer>
- Downloads (portable zip + `SHA256SUMS.txt`): <https://github.com/JonnyUtah12/ping-tracer/releases>
- Issues / bug reports: <https://github.com/JonnyUtah12/ping-tracer/issues>
- Changelog: [CHANGELOG.md](CHANGELOG.md) · Developer guide: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)

---

## Table of contents

1. [Quick start](#quick-start)
2. [Supported Windows versions & system requirements](#supported-windows-versions--system-requirements)
3. [Features](#features)
4. [Monitoring multiple targets](#monitoring-multiple-targets)
5. [Probe methods: ICMP, TCP and UDP](#probe-methods-icmp-tcp-and-udp)
6. [Configuration](#configuration)
7. [Understanding hop results](#understanding-hop-results)
8. [How latency and packet loss are calculated](#how-latency-and-packet-loss-are-calculated)
9. [Exports: CSV, JSON and more](#exports-csv-json-and-more)
10. [History and where your data lives](#history-and-where-your-data-lives)
11. [Alerts](#alerts)
12. [Network behavior](#network-behavior)
13. [Permissions and firewall](#permissions-and-firewall)
14. [Security & privacy](#security--privacy)
15. [Antivirus false positives & SmartScreen](#antivirus-false-positives--smartscreen)
16. [Verifying your download (checksums & signing)](#verifying-your-download-checksums--signing)
17. [Command line](#command-line)
18. [Troubleshooting](#troubleshooting)
19. [Known limitations](#known-limitations)
20. [Bug reports](#bug-reports)

---

## Quick start

1. Download the portable zip from the
   [latest release](https://github.com/JonnyUtah12/ping-tracer/releases).
2. Extract it anywhere you like — your desktop, a folder, a USB stick.
3. Double-click `PingTracer.exe`.

A small app window opens (PingTracer runs its own interface and shows a system
tray icon; it can also open in your default browser — see
[Configuration](#configuration)). Type a hostname or IP address, press
**Trace**, and PingTracer discovers the route and starts probing every hop
continuously.

Nothing else is installed: no services, no registry entries (unless you enable
"Start with Windows"), no runtime. Quitting from the tray menu or File ▸ Quit
stops everything; your collected data stays in the `data` folder next to the
exe.

If you prefer a Start-menu entry instead of a portable folder, the same source
can build `PingTracer-Setup.exe`, a per-user installer (still no administrator
rights needed; see the [developer guide](docs/DEVELOPMENT.md)). It installs
the same exe to `%LOCALAPPDATA%\Programs\PingTracer`, adds shortcuts, and
keeps your data in `%LOCALAPPDATA%\PingTracer` so upgrades and uninstalls
never touch it.

## Supported Windows versions & system requirements

- **Designed for 64-bit Windows 11 and Windows Server 2022.** The bundled
  runtime runs on any 64-bit Windows 10 or later. The automated build and test
  pipeline runs on GitHub-hosted `windows-latest`, which currently resolves to
  a Windows Server 2025 image; Windows 11, Server 2022, and older builds are
  expected to work but are not individually verified.
- 64-bit (x64) Windows with the in-box .NET Framework 4.x (present on every
  supported Windows version — nothing to install).
- No administrator rights. No installer. No Python/Node/npm/SDK.
- Free disk space: the single executable is self-contained (it bundles the
  Node.js runtime, so expect a download of tens of MB and a larger extracted
  file), plus a history database whose size grows with the number of targets ×
  probe frequency × retention (default 30 days; retention is configurable from
  1 day to 10 years).
- Network access for the targets you choose to trace (see
  [Network behavior](#network-behavior) — PingTracer contacts nothing else
  unless you turn a feature on).

The probe engine uses Windows' own ICMP implementation through a small native
helper that is embedded in the exe and extracted automatically; if it cannot
run, PingTracer falls back to the built-in `ping.exe` (per-hop timings become
approximate — the About dialog shows which engine is active).

## Features

- **Continuous multi-target tracing** — every hop of every route probed on a
  fixed interval (250 ms to 1 hour), up to 64 targets at once.
- **ICMP, TCP and UDP route tracing** with per-hop latency, packet loss,
  jitter and a MOS voice-quality estimate.
- **Time graph per hop** with overlay mode, graph panning through history, and
  drag-to-select time ranges; long ranges are served from the history database
  as min/max bands.
- **Long-term history** in a local SQLite database (retention configurable,
  default 30 days) with historical focus windows and per-period statistics.
- **Route-change detection** — every change of the responding hop sequence is
  recorded with timestamps and highlighted in the Routes view and on the graph.
- **Insights** — automatic diagnosis for a time range: where loss or latency
  begins, detected outage/loss/latency events with severity, and the best and
  worst periods.
- **Alerts** — threshold rules (latency, loss, jitter, MOS) that notify, play
  a sound, run a program, POST a webhook or send email, with recovery events.
- **Exports** — statistics or raw samples as text/CSV, structured JSON with
  full metadata, time-range exports (raw or aggregated per period), PNG
  snapshots, saved sample sets (`.pp.json`), target lists, workspaces.
- **Timeline comments** and custom grid columns for your own notes.
- **Stored sessions & workspaces** — closing a target keeps its data; switch
  between saved sets of targets.
- **Remote agents** — run the same exe on another machine with `--agent` and
  trace from there through this UI; **Web access (HTTPS)** lets others view or
  control the GUI from other devices, with users, read-only viewers and
  password-protected read-only LiveShare links.
- **Wi-Fi monitoring** (signal/channel history via Windows' WLAN service) and
  **LAN device discovery** (ping sweep, ARP, reverse DNS, SSDP/mDNS, MAC
  vendor lookup).
- **Interpretation guides** built in (Help ▸ Interpreting results), editable
  on disk; a built-in REST API reference (Help ▸ REST API reference).
- **Command-line automation** — `PingTracer.exe cli …` drives the running
  instance (see [Command line](#command-line)).

## Monitoring multiple targets

Type a host and press **Trace** to add a target; each target gets a tab. The
**All Targets** overview shows final-hop statistics for everything at a glance
(sortable table or tiles with sparklines).

- **Summaries** (＋ Summary tab) are named groups of targets — or of individual
  hops — with their own overview, target list and LiveShare link.
- **Workspaces** (File ▸ Workspaces) save and switch whole sets of open
  targets and summaries.
- **Target lists** (File ▸ Import/Export target list) start many targets from a
  plain text file, one host per line.
- **Start all / Stop all** control every target at once; per-target Pause,
  Clear, Re-trace, Reset are on the toolbar.
- Closing a target (✕ on its tab) keeps its data as a **stored session**
  (File ▸ Stored sessions) which you can reopen later, paused.
- **Remote…** traces a target from another machine running
  `PingTracer.exe --agent` (the agent prints its URL and token on start).
- One unresponsive target never blocks the others: each target runs on its own
  timer, and a target's probes within a round are spaced out instead of fired
  as a burst (home routers rate-limit ICMP replies; bursts showed up as false
  loss on the first hops).

## Probe methods: ICMP, TCP and UDP

The dropdown next to the target box selects the probe method:

- **ICMP** (default) — classic traceroute behavior: TTL-limited echo requests
  discover the route, then every hop is pinged continuously.
- **TCP** — TTL-limited TCP connection attempts to the port you choose (default
  443). The protocol itself discovers the path length: the smallest TTL at
  which the destination answers — a completed handshake **or** a refusal (RST)
  — is the protocol-level route. In steady state only the destination is
  probed with TCP; the destination's real RTT comes from the protocol probe.
- **UDP** — the same, with UDP datagrams (default port 53). A reply or the
  ICMP Port Unreachable proves the destination; **no reply never means
  "offline"** — UDP is commonly firewalled — it is recorded as filtered.

For TCP/UDP targets the header shows the **destination state**: *reached, port
open* · *reached, port closed* · *no response (filtered)* · *network
unreachable*. A filtered port is never reported as an offline destination.

Two honest restrictions of TCP/UDP tracing on Windows:

- Windows user-mode TCP/UDP sockets cannot report *which router* sent an ICMP
  Time Exceeded, so intermediate hop **addresses** are attributed with the
  engine's ICMP probes while the protocol probes prove reachability at each
  TTL.
- TCP/UDP tracing needs the native helper (bundled). If it is unavailable,
  such targets fall back to ICMP.

## Configuration

Settings (gear icon) covers:

- **Tracing** — interval (250 ms – 1 h), probe timeout (200 ms – 10 s), packet
  size (0 – 1400 bytes), max hops (1 – 64), and IP version preference for
  hostnames (auto/IPv4/IPv6).
- **Trace configurations** — named presets of interval/timeout/size/max-hops/
  history-retention that you assign per target (Config box) or per summary.
- **History** — samples kept in the live view and days kept in the history
  database (1 – 3650, default 30).
- **Application** — open in its own app window (Edge/Chrome app mode) or a
  browser tab; tray alert balloons; **Start with Windows** (per-user Run key,
  starts hidden in the tray).
- **Web access (HTTPS)** — optional GUI for other devices on your network,
  with an access token, named users (admin/viewer) and LiveShare links. Uses a
  self-signed certificate, so browsers show a one-time warning.
- **Email (SMTP)** — server, account and sender/recipient for alert emails and
  the File ▸ "Send report by email" action. The password is stored encrypted
  with Windows data protection (DPAPI), readable only by your Windows account.

Every numeric setting has hard bounds; a hand-edited or corrupt settings file
is clamped or falls back to defaults rather than breaking the engine.

## Understanding hop results

The trace table shows, per hop, over the selected **Focus** window: average /
minimum / maximum / current latency, packet-loss %, lost-probe count, jitter,
MOS and sample count. Click a row to graph that hop; right-click to hide it;
double-click a name to rename it; drag across the graph to focus statistics on
a time range; ◀ ▶ pan through history.

The built-in guides (Help ▸ Interpreting results, and `cli guidance`) explain
the classic patterns:

- **Loss on one middle hop only** is usually harmless — routers deprioritise
  replies to probes aimed at themselves. Look at the hops after it.
- **Loss that starts at a hop and continues to the destination** is real; the
  problem is at or just after that hop. Loss at hop 1–2 is inside your own
  network.
- **A single large latency jump** marks a long link (e.g. an ocean crossing)
  or a congested one; only latency that persists to the destination affects
  you.
- **Jitter** above ~30 ms makes voice/video stutter.

**Insights** does this analysis automatically for a chosen period, lists
detected events (outages, sustained loss, latency spikes) with severity, and
ranks the best/worst periods. The **Routes** view records every route change
with the hops that differ highlighted.

## How latency and packet loss are calculated

All statistics are computed over the selected focus window (or a fixed time
range you selected) from the raw per-probe samples:

- **Latency (avg/min/max/cur)** — the measured round-trip time of each probe
  that received a reply; averages are over successful replies only. With the
  native helper, TTL-expired ("Time exceeded") replies carry their real RTT.
  (In the `ping.exe` fallback, per-hop RTTs are estimated from wall time minus
  a calibrated process overhead, so they are approximate.)
- **Packet loss %** — probes with no reply ÷ probes sent, within the window.
  A gap in the graph marks each lost probe.
- **Jitter** — the mean absolute difference in latency between consecutive
  successful replies (RFC 3550 "one-way active" style interarrival metric
  computed on RTT samples).
- **MOS** — an E-model approximation from latency, jitter and loss on a
  1.0 (bad) – 4.5 (excellent) scale: an effective-latency R-value is reduced
  by loss and mapped to MOS. Above 4.0 is good, below ~3.1 callers complain.

The same formulas are used by the UI, the REST API, the exports and the alert
rules, so an alert threshold and the table always agree.

## Exports: CSV, JSON and more

File menu (all exports honor the current focus window unless noted):

| Export | Content |
|---|---|
| Export text (statistics) | one row per hop: avg/min/max/cur, loss, jitter… |
| Export all samples (long / wide / CSV) | every probe: long = one row per sample, wide = one column per sample |
| Export results (JSON) | structured results with metadata: app + version, export timestamp, target (host, IP, protocol, port, destination state, start time, rounds, final TTL), the effective configuration (interval, timeout, packet size, max hops), and per-hop statistics — raw samples included via the API (`all=1`) |
| Export time range | any past range as CSV/TSV: every sample (one row per round, one column per hop) or statistics aggregated per period (5 min – 1 day) |
| Sample set (`.pp.json`) | full history of targets, re-openable in PingTracer |
| Target list, workspace, PNG, clipboard | plain text lists, workspace files, graph+table snapshot images |

The same data is available from the REST API
(`/api/targets/:id/export?format=csv|long|wide|json`,
`/api/targets/:id/exportrange`) and from the [command line](#command-line).

## History and where your data lives

- **Portable exe:** everything is in a `data` folder **next to the exe** —
  copy the folder to move your whole setup.
- **Installed (via `PingTracer-Setup.exe`):** data lives in
  `%LOCALAPPDATA%\PingTracer` so upgrades and uninstalls never touch it.
- If the data folder is not writable (write-protected share, permissions),
  PingTracer falls back to `%LOCALAPPDATA%\PingTracer` and then to the temp
  folder instead of failing to start.

Inside the data folder: `state.json` (targets, settings, sessions),
`history.db` (SQLite history, pruned to your retention setting), `sets/`,
`workspaces/`, `guidance/`, `extensions/`, and the extracted native helpers.
Closing a target archives it as a stored session (up to 500) with its history.

## Alerts

Alerts (bell icon) are rules like *"final-hop loss > 2% over 120 s"* or
*"hop 3 avg > 150 ms"*, evaluated per target on a rolling window:

- Actions: desktop notification + sound (several synthesized tones), run a
  program (the message is passed as one argument), POST JSON to a webhook, or
  send email via the configured SMTP account.
- Recovery events are logged when a condition clears; the alert log keeps the
  last 500 events.
- Over the network (web users), rules that launch programs or webhooks can
  only be managed locally.

## Network behavior

PingTracer is local-first. Here is **every** network activity it can perform:

**Always (because it is a tracer):**
- DNS lookups for the hostnames you enter, and reverse DNS for hop addresses.
- ICMP echo probes — and/or TTL-limited TCP/UDP probes to the ports you
  choose — to the targets you add.

**Listens (loopback only, unless you enable more):**
- `127.0.0.1:8765` — the local GUI/API. It only accepts same-origin requests
  addressed to a loopback host, so web pages you visit cannot reach it.
- `0.0.0.0:8767` (HTTPS) — **only if you enable Web access**; protected by
  token/user sign-in, TLS 1.2+.
- `0.0.0.0:8766` (HTTP) — **only in `--agent` mode**, protected by the agent
  token; traffic is plain HTTP, use it on a network you trust.

**Only if you turn the feature on:**
- LAN device discovery (you click *Scan*): a ping sweep of your own subnet,
  ARP, reverse DNS, and SSDP/mDNS discovery packets (local subnet only).
- SMTP connections for alert emails / reports.
- Webhook POSTs from alert rules.
- One download of the public IEEE MAC-vendor list (≈6 MB) when you click
  "Update vendor database" in the LAN panel.
- SSDP/mDNS discovery packets during a LAN scan (local subnet only).
- Connections to another PingTracer agent you added (Remote…).
- The browser UI itself polls the local API; nothing leaves the machine.

No telemetry, no phone-home, no cloud account, no update-checker.

## Permissions and firewall

- **No administrator rights** anywhere: the portable exe, the per-user
  installer, autostart (HKCU Run key) and the certificate for Web access
  (current-user store) all work without elevation.
- Probes use normal user-mode sockets; no raw-socket driver, no packet-capture
  library, no service.
- Windows Firewall does not prompt for the default loopback GUI. If you enable
  **Web access** or run an **agent**, Windows may show its usual allow/block
  prompt for incoming connections on those ports — that is expected and
  optional; outbound probes are not blocked by the default Windows firewall
  profile.
- Some networks block ICMP entirely; see [Troubleshooting](#troubleshooting).

## Security & privacy

- **Zero npm dependencies.** The app is plain Node.js built-ins plus two small
  C# helpers compiled from source in this repo. No packers, no obfuscation,
  no hidden payloads. The full dependency chain is below.
- All your data stays on your machine (see
  [History](#history-and-where-your-data-lives)).
- The local API rejects cross-site requests and non-loopback Host headers
  (CSRF / DNS-rebinding protection — relevant because alert rules can launch
  programs).
- Web access: scrypt-hashed passwords, signed HttpOnly cookies, constant-time
  token comparison, per-IP sign-in throttling, read-only viewer and LiveShare
  roles, CSP and anti-sniffing headers on every page.
- The SMTP password is encrypted at rest with Windows DPAPI (bound to your
  Windows account) and is never sent back to the browser.
- Extensions (`data/extensions/*.js`) run in a restricted sandbox without
  `require`/`process`/`fs` — but only install extensions you trust.
- **No security bypasses anywhere in the code:** no TLS-certificate overrides
  (no `rejectUnauthorized: false`, no `NODE_TLS_REJECT_UNAUTHORIZED`), the
  optional web server enforces TLS 1.2+, tokens are compared in constant
  time, and nothing listens on the network unless you enable Web access or
  agent mode.

### What's inside the download (dependencies)

| Component | Where it comes from | License | Shipped? |
|---|---|---|---|
| Node.js 22 runtime | Embedded into `PingTracer.exe` by Node's official Single Executable Applications mechanism (pinned to Node 22 in the release workflow) | MIT — Node's own `LICENSE` also covers its bundled third-party parts (OpenSSL Apache-2.0, V8 BSD, SQLite public domain, ICU Unicode terms) | Yes, inside the exe |
| PingTracer app code | This repository (`app/server.js`, `app/public/*`) | source in this repo (no LICENSE file yet) | Yes, inside the exe |
| `pphelper.exe`, `pptray.exe` | C# source in this repo, compiled at build time with the `csc.exe` that ships inside Windows | source in this repo (no LICENSE file yet) | Yes, embedded and extracted to the data folder on first run |
| .NET Framework 4.x | Already part of Windows 11 / Server 2022 — the helpers run on the in-box framework | Microsoft (in-box OS component) | Nothing to install or ship |
| postject 1.0.0-alpha.6 | Build-time tool only, pinned and fetched via `npx` during the build; it injects the app blob into the exe | MIT | No — not part of the shipped artifact |

There is no `package.json` and no `node_modules` anywhere in this project:
`server.js` only `require`s Node built-ins (`http`, `https`, `net`, `dgram`,
`dns`, `fs`, `path`, `os`, `crypto`, `vm`, `zlib`, `child_process`,
`node:sea`, `node:sqlite`). The test suite uses the built-in `node:test`
runner. The "self-contained exe" is Node's standard SEA packaging of this
repo's own source — the only thing embedded is the app itself, which is why
antivirus heuristics sometimes react to it (see next section).

## Antivirus false positives & SmartScreen

A single large self-contained executable that embeds a JavaScript runtime and
opens network sockets is exactly the profile antivirus heuristics sometimes
flag, especially while it is unsigned and freshly built:

- **SmartScreen** ("unknown publisher") on first launch: click *More info →
  Run anyway*, or use the installer. This is a reputation prompt, not a
  detection.
- **Smart App Control** (some Windows 11 installs) only runs signed,
  Microsoft-trusted apps; an unsigned build like v1.0.0 can be blocked there.
  Verify the checksum below first; then either keep Smart App Control off or
  wait for a signed release.
- **Antivirus/EDR detections:** if your AV quarantines `PingTracer.exe`,
  verify the SHA-256 against the release, then allow/exclude the file or
  folder. You can also submit the file to a multi-engine scanner such as
  VirusTotal before running it. Each release build is additionally scanned
  by Microsoft Defender in the CI pipeline, and an unexplained detection
  *blocks publication* — the scan result for the build you downloaded is in
  that release's CI job summary.
- The native helpers (`pphelper.exe`, `pptray.exe`) are extracted into the
  data folder at first run; exclude that folder if a scanner is aggressive.

## Verifying your download (checksums & signing)

Every release publishes `SHA256SUMS.txt` next to the zip; the checksum covers
the zip file itself. Verify **before extracting** (PowerShell):

```powershell
Get-FileHash .\PingTracer-windows-x64-portable.zip -Algorithm SHA256
# compare the printed hash with the one in SHA256SUMS.txt
```

(cmd.exe: `certutil -hashfile PingTracer-windows-x64-portable.zip SHA256`)

The zip contains a single `PingTracer` folder with `PingTracer.exe` and this
README — extract it wherever you like.

**Signing status, stated honestly:** v1.0.0 builds are published **unsigned**
— no code-signing certificate is configured for this repository yet. The
release pipeline already supports [Azure Trusted
Signing](https://learn.microsoft.com/azure/trusted-signing/) (via
`Azure/artifact-signing-action`); it activates automatically once the
signing account variables and Azure credentials are set up, and signing
will then be announced in the release notes. Until then the SHA-256
checksums are the integrity guarantee — compare them over a channel you
trust (the release page) before running the exe.

## Command line

`PingTracer.exe cli <command>` talks to the running instance and is meant for
scripts and scheduled tasks:

```
PingTracer.exe cli status                 engine status
PingTracer.exe cli list                   open targets
PingTracer.exe cli start HOST [--proto tcp|udp --port N --config ID]
PingTracer.exe cli stats ID               statistics for every hop
PingTracer.exe cli export ID --out FILE [--format csv|long|wide|json]
PingTracer.exe cli pause|resume|close|reset|reresolve ID|all
PingTracer.exe cli load-list FILE         start targets from a text file
PingTracer.exe cli guidance               print the interpretation guides
```

Run `PingTracer.exe cli` with no arguments for the full help. Other launch
switches: `--agent` (remote agent mode), `--background` (start hidden in the
tray), `--port N`, `--token X` (agent token), `PP_DATA=DIR` (alternate data
folder).

## Troubleshooting

| Symptom | What to check |
|---|---|
| Window doesn't open after double-click | Another instance may own the port — the second instance normally just opens the UI of the first; check the tray icon. If the console said "Port in use", close the other instance. |
| Everything times out, no hops | Your network blocks ICMP (common on corporate/cellular networks). Try a TCP target (e.g. port 443). Also check third-party firewalls that block outbound ICMP. |
| First hops show loss, later hops don't | Router ICMP rate limiting — see the guides; it is not real loss. Probe spacing already mitigates the worst of it. |
| TCP/UDP option unavailable or target behaves like ICMP | The native helper couldn't start (it is extracted to the data folder on first run — antivirus sometimes blocks that). Allow it, or check About → engine. |
| "data folder is not writable" in console | The exe sits somewhere write-protected; PingTracer automatically falls back to `%LOCALAPPDATA%\PingTracer` (the message shows the path it chose). |
| History/graph of old data is empty | History retention (Settings ▸ History) or the history database was unavailable at start (About shows engine/data path; the console logs "history database unavailable"). |
| Wi-Fi panel shows an error | Wi-Fi monitoring uses Windows' `netsh wlan` and English-locale output; it is unavailable on machines without a WLAN interface or on non-English Windows. |
| Browser warns about the certificate (Web access) | Expected: the certificate is self-signed. Add an exception or use the machine on your LAN. |
| Antivirus removed the exe | See [Antivirus false positives](#antivirus-false-positives--smartscreen), verify the checksum, then restore/exclude. |

## Known limitations

- TCP/UDP route tracing attributes intermediate hop addresses via ICMP probes
  (Windows user-mode sockets cannot see the ICMP Time Exceeded source), and
  falls back to ICMP when the native helper is unavailable.
- Statistics are RTT-based; PingTracer does not measure one-way latency,
  bandwidth or throughput.
- Wi-Fi monitoring requires Windows' WLAN service with English-locale output.
- Agent mode between two instances is plain HTTP with a token — use it on a
  trusted network (or front it with your own TLS).
- Web access uses a self-signed certificate (one-time browser warning).
- Up to 64 open targets; history retention is bounded by your settings
  (default 30 days, max 3650).
- The app is Windows-first; running `node app/server.js` on Linux/macOS works
  for development (system `ping` fallback, no tray/Wi-Fi/DPAPI features).

## Bug reports

Please open an issue at
<https://github.com/JonnyUtah12/ping-tracer/issues> with:

- what you expected vs what happened, and the exact steps;
- the version shown in the title bar / About dialog, and the engine it reports;
- whether it reproduces with a fresh empty data folder (`PP_DATA` pointing at
  an empty directory isolates data problems);
- for crashes: the console output (run the exe from a terminal to see it).

---

*Developer documentation (build, tests, packaging, signing, CI, Defender
scans): [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) · Release history:
[CHANGELOG.md](CHANGELOG.md)*
