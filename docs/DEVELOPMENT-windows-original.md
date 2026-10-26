# PingTracer — developer guide

How to build, test, package, sign and release PingTracer. The end-user
documentation lives in [README.md](../README.md).

## Repository layout

```
app/
  server.js            engine + REST API + static server (Node built-ins only, zero npm deps)
  sea-config.json      Node SEA build config (embeds public/* and helper/*.exe as assets)
  public/index.html    the GUI (single file, no framework)
  public/docs.html     REST API reference served at /docs.html
  helper/pphelper.cs   probe helper: ICMP + TTL-limited TCP/UDP, DPAPI, SMTP (C#, .NET Framework)
  helper/pptray.cs     system-tray helper (WinForms)
  helper/*.exe         prebuilt helpers (build.ps1 recompiles them from source)
  build.ps1            builds dist\PingTracer.exe (SEA)
  build-installer.ps1  builds dist\PingTracer-Setup.exe (IExpress, Windows built-in)
  installer/           per-user install/uninstall scripts used by the setup package
  start.bat            dev shortcut: run server.js + open the browser
tests/                 node:test suites (zero dependencies)
docs/                  this guide
```

Design decisions (from the source inspection that started this repo): keep the
architecture of the original "Pong Plotter" — a single Node.js server file
using only built-in modules, a C# helper compiled with the in-box .NET
Framework compiler, and Node SEA single-file packaging. No npm dependencies,
no packers, no obfuscation.

## Development setup

- Any OS with **Node.js 22.5 or newer** recommended (the history database uses
  the built-in `node:sqlite`; on older Node the app runs but history
  degrades gracefully — the server logs `history database unavailable`).
- No `npm install` — there are no dependencies, ever. If a change ever needs
  one, that is a design change to discuss first.

Run the app in development mode:

```bash
node app/server.js        # then open http://127.0.0.1:8765
```

In dev mode (not a SEA exe) static assets are read from disk, so UI edits show
up on reload, and the data folder is `app/data/`. Useful environment variables
and switches (all optional):

| Variable / switch | Effect |
|---|---|
| `PP_DATA=DIR` | alternate data folder (tests use a scratch dir) |
| `PP_NO_OPEN=1` | never open a browser window |
| `PP_OPEN=1` | open the browser even outside the exe |
| `PP_TRAY=1` | try the tray helper outside the exe (Windows) |
| `PP_TOKEN=…` | agent token in `--agent` mode |
| `PORT=…` / `--port N` | override the local port (default 8765; agent 8766) |

On Linux/macOS the app runs with the system `ping` fallback (no native helper,
no tray, no Wi-Fi panel, no DPAPI — SMTP passwords stay plain in `state.json`
there).

## Build dependencies (Windows)

Everything needed to build the Windows product ships with Windows plus Node:

- **Node.js 20+** on `PATH` (the SEA runtime is copied from your `node.exe`;
  CI uses the runner's Node). `--experimental-sea-config` is used by
  `build.ps1`.
- **`csc.exe`** from `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319` — the
  .NET Framework compiler that ships with Windows. No SDK, no Visual Studio.
- **`npx postject@1.0.0-alpha.6`** — the only network fetch in the build, and
  it is version-pinned.
- **IExpress** (`%WINDIR%\System32\iexpress.exe`) for the optional setup
  package — built into Windows.

## Building the exe

```powershell
cd app
.\build.ps1            # -> dist\PingTracer.exe
```

What it does: compiles both helpers with in-box `csc`, runs
`node --experimental-sea-config sea-config.json` to produce the blob, copies
`node.exe` to `dist\PingTracer.exe`, and injects the blob + assets
(`public/*`, `helper/*.exe`) with postject. The exe embeds the UI and the
helpers; on first run it extracts the helpers into the data folder.

Optional per-user installer:

```powershell
.\build-installer.ps1  # -> dist\PingTracer-Setup.exe (IExpress; run build.ps1 first)
```

The installer stages `installed.flag` next to the exe — that flag is what
switches the app from portable data (next to the exe) to
`%LOCALAPPDATA%\PingTracer`, and it migrates data from the legacy product
names ("Ping Plotter", "Pong Plotter").

## Tests

Zero-dependency suites using the built-in `node:test` runner:

```bash
node --test tests/
```

- Unit tests extract the pure functions (stats math, host/port validation,
  sanitizers, route tracking, export formats, TCP/UDP destination classifiers)
  directly from `app/server.js` so they always exercise shipped code.
- Integration tests spawn the server with `PP_DATA` pointed at a scratch
  folder and `PP_NO_OPEN=1`, then drive the real API (add target, samples,
  exports, settings validation, error paths, quit).
- Platform notes baked into the tests: GitHub's Windows runners block ICMP
  (live-ICMP asserts are skipped there), and a Windows TCP connect to a closed
  port may drop the SYN instead of replying RST (the classifier is unit-tested
  instead). Keep new tests green on **both** Linux and Windows.

## CI and releases

Releases are produced by the GitHub Actions pipeline (`.github/workflows/`,
added for v1.0.0). Pushing a `v*` tag runs, on `windows-latest`:

1. `node --test tests/` on Windows;
2. compile the helpers with in-box `csc` and build the SEA exe (`build.ps1`,
   pinned postject);
3. scan the final artifact with Microsoft Defender
   (`MpCmdRun -Scan -ScanType 3 -File <exe> -DisableRemediation`); the raw
   log and result are written to the job summary. Any detection must have a
   matching entry (threat name + explanation) in
   `packaging/defender-allowlist.json`, otherwise the release is blocked;
4. optional code signing with Azure Trusted Signing when the signing
   variables/secrets are configured (the build is published unsigned
   otherwise — the README and release notes must say so honestly);
5. smoke-test the frozen exe (start it, hit the API and static UI, add a
   target, export, quit);
6. zip the portable folder (`PingTracer-windows-x64-portable.zip`, containing
   a `PingTracer/` folder with the exe and README), generate
   `SHA256SUMS.txt` (covering the zip), and publish a GitHub Release with
   the zip, the checksums and this CHANGELOG as the notes.

Releases are tagged `v*` (the current release line is `v1.0.0`) at
<https://github.com/JonnyUtah12/ping-tracer/releases>.

**Version discipline:** `APP_VERSION` in `app/server.js`, the git tag, the
`$version` in `build-installer.ps1` and the CHANGELOG entry must always match.
The UI shows the version from `/api/info`.

## Defender / antivirus testing

- CI scans every published artifact with Defender (step 3 above); record the
  scan date and result in the release notes.
- Locally, after building:
  `"%ProgramFiles%\Microsoft Defender\MpCmdRun.exe" -Scan -ScanType 3 -File dist\PingTracer.exe`
  (path may be under `Program Files\Windows Defender` on some installs), or
  just right-click → Scan with Windows Security.
- Expect SmartScreen "unknown publisher" while unsigned, and treat heuristic
  flags on the SEA exe as false positives only after the checksum and a
  Defender scan agree — see the README's AV guidance for the user-facing
  wording.

## Conventions

- Keep `app/server.js` dependency-free; new capabilities extend the engine or
  the C# helper rather than pulling in packages.
- Every numeric setting needs a hard range in the clamp tables
  (`NUM_RANGE` / `CFG_RANGE`) — corrupt state must never crash the engine.
- API changes go into `app/public/docs.html` (the in-app REST reference) in
  the same commit.
- User-visible behavior changes get a CHANGELOG entry; end-user-facing
  behavior in the README must match the code as shipped.
