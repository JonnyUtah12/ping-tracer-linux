# Changelog

All notable changes to PingTracer are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.2] - 2026-10-16

Security-audit follow-up: CI/supply-chain hardening plus the published audit
report. The application itself is unchanged from 1.1.1.

### Added
- `SECURITY_AUDIT.md` — the full 2026-10-16 audit: reconnaissance, CVE
  analysis of the embedded Node runtime and build toolchain, source findings
  with confirmed / false-positive / needs-investigation classification,
  remediation log, verification evidence, and open follow-ups.

### Changed
- CI supply-chain hardening: every GitHub Action is now pinned to a full
  commit SHA with a version comment (`actions/checkout` v4.4.0,
  `actions/setup-node` v4.4.0, `actions/upload-artifact` v4.6.2,
  `Azure/artifact-signing-action` v2.0.0) instead of mutable major tags.
- `.github/dependabot.yml` added so those pins update through reviewable
  weekly PRs rather than a tag moving under the pipeline.
- `actions/checkout` no longer persists the job token into the runner's git
  config (`persist-credentials: false`); nothing in the job pushes via git.
- The optional Azure signing step is skipped on `pull_request` runs (the
  repo-variable gate it used was visible to fork PRs, where it would run
  with empty credentials and fail the build).

### Fixed
- The Defender release gate no longer degrades silently: on a `v*` tag a
  missing `MpCmdRun.exe` now fails the job instead of publishing an
  unscanned artifact. Non-release builds still skip with a warning.

### Security
- After publishing, the release step downloads the released zip back and
  re-verifies it against the released `SHA256SUMS.txt`, so a corrupted or
  swapped asset fails the job instead of going unnoticed.

## [1.1.1] - 2026-10-16

### Changed
- **Security hardening (audit 2026-10-16):** the state-changing target
  actions `start`, `stop`, `clear` and `retrace` now require `POST`
  (other methods get `405 Method Not Allowed`). The UI and the CLI already
  used `POST`; this closes the path where a read-only web user or a
  cross-site request could mutate state through a plain `GET`.

### Fixed
- **Security hardening (audit 2026-10-16):** bounded growth of long-lived
  in-memory structures: the reverse-DNS name cache is capped (5000
  entries, oldest evicted), comments per target are capped (1000, oldest
  trimmed) and custom grid columns per target are capped (50).

### Added
- Security regression suite (`tests/security.test.js`): POST-only
  enforcement, local-mode Host / Origin / Sec-Fetch-Site gates, static
  path-traversal rejection, argument-injection-safe host validation,
  oversized-body (413) handling, and the new growth caps.

## [1.1.0] - 2026-10-16

### Added
- Right-edge elevator scrollbar for the main view: a slim themed thumb that
  mirrors the page scroll, with drag, track-click paging, wheel, keyboard
  (arrows/PageUp/PageDown/Home/End) support, dynamic thumb sizing, and
  automatic hiding while the content fits. Screen-reader semantics
  (`role=scrollbar`, `aria-valuenow`, labelled, focusable).

### Fixed
- Main view could squash cards instead of scrolling when the window was
  shorter than the content (flex children were shrinkable); children now
  keep their natural height so the view scrolls and nothing is clipped.

## [1.0.0] - 2026-10-16

First PingTracer release — a rebrand and completion of the "Pong Plotter"
prototype into a portable Windows network monitor. Single-file portable exe
(Node SEA) with an embedded UI and native probe helper; zero npm dependencies;
no administrator rights and no installed runtime required.

### Added

- **Continuous multi-target route tracing** — up to 64 targets, per-target
  timers, probe spacing to avoid ICMP rate-limit artifacts, per-target
  start/stop/reset/re-trace plus Start all / Stop all.
- **Probe methods** — ICMP echo per hop; TTL-limited **TCP** and **UDP** route
  tracing (protocol probes discover the path length; destination state
  reported as open / refused / filtered / unreachable; intermediate hop
  addresses attributed via ICMP, documented limitation).
- **Native probe helper** (`pphelper.exe`, C#/.NET Framework, embedded in the
  exe): real RTTs for TTL-expired replies, TTL control for TCP/UDP probes,
  DPAPI secret protection, SMTP sending; automatic fallback to system `ping`.
- **Live UI** — hop table (avg/min/max/cur latency, loss %, lost count,
  jitter, MOS, sample count), per-hop time graph with overlay, graph panning
  and drag-to-select focus ranges, overview table/tiles for all targets,
  sortable columns, hide/rename hops, custom columns, timeline comments.
- **Statistics engine** — focus windows and fixed historical ranges backed by a
  local SQLite history database (retention 1–3650 days, default 30),
  allocation-free cached aggregation, E-model MOS estimate.
- **Route-change detection** with full history, diff-highlighted Routes view
  and graph markers.
- **Insights** — automatic diagnosis (where loss/latency begins, intermediate
  hop rate-limiting, jitter, route changes), event detection with sensitivity
  control, best/worst period ranking.
- **Alerts** — threshold rules (avg/loss/jitter/MOS, per hop or final,
  rolling window) with notify+sound, run-program, webhook and email actions,
  recovery events, alert log.
- **Exports** — statistics text, raw samples (long/wide/CSV), structured JSON
  results with target/config metadata, time-range export (raw samples or
  per-period aggregates, CSV/TSV), PNG snapshot, sample sets (`.pp.json`),
  target lists, workspaces.
- **Configuration** — settings with hard validation ranges, named trace
  configurations per target/summary, IP version preference, history retention,
  app-window vs browser mode, tray alerts, Start with Windows (HKCU Run).
- **Data handling** — portable data folder next to the exe (installed mode uses
  `%LOCALAPPDATA%\PingTracer`), graceful fallback when the data folder is not
  writable, stored sessions for closed targets, workspaces, corrupt-state
  recovery.
- **Remote agents** (`--agent`, token-protected) and **Remote…** targets traced
  through another instance; incremental sample feed.
- **Web access (HTTPS)** — optional network GUI with self-signed certificate,
  access token, named admin/viewer users, read-only LiveShare links with
  optional password/expiry, CSRF/DNS-rebinding protection, login throttling.
- **Wi-Fi monitoring** (signal/channel history, nearby networks via `netsh`)
  and **LAN device discovery** (ping sweep, ARP, rDNS, SSDP/mDNS, IEEE OUI
  vendor lookup).
- **Interpretation guides** in-app (editable on disk) and built-in REST API
  reference; **command-line automation** (`PingTracer.exe cli …`).
- **System tray integration** (hide console, balloons, Open/Pause/Quit menu).
- **Per-user installer** (`PingTracer-Setup.exe`, IExpress; no admin; migrates
  data from the legacy "Ping Plotter"/"Pong Plotter" names).
- **Automated tests** (`node --test`, zero dependencies: unit + API
  integration, Linux and Windows).
- **Release pipeline** — GitHub Actions on Windows: tests, SEA build, Defender
  artifact scan, optional Trusted Signing, smoke test, portable zip,
  `SHA256SUMS.txt`, GitHub Release on `v*` tags.
- Documentation: README (end-user), docs/DEVELOPMENT.md (developer), this
  changelog.

### Notes

- v1.0.0 artifacts are published **unsigned** unless a code-signing
  certificate is configured for the pipeline; verify `SHA256SUMS.txt` after
  download.
- The product was previously developed as "Pong Plotter"; 1.0.0 is the first
  version under the PingTracer name, and its version string, git tag and
  installer version are aligned.
