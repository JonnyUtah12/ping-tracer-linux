# PingTracer — Security Audit, CVE Analysis & Remediation

**Repository:** https://github.com/JonnyUtah12/ping-tracer
**Date:** 2026-10-16
**Scope:** whole repository — source, build, packaging, CI, release pipeline, embedded runtime, dependencies
**Authorisation:** defensive assessment of the owner's own application; testing kept inside the repository and a local loopback test environment

Classification legend used throughout:
**CONFIRMED** (verified by test/observation) · **POTENTIALLY APPLICABLE** (real issue, path not directly reachable) ·
**FALSE POSITIVE** (reported by a tool, not a real issue) · **NEEDS INVESTIGATION** (unverifiable today) · **BY DESIGN** (accepted, documented)

---

## 1. What the application actually is (reconnaissance, no assumptions)

| Fact | Value |
|---|---|
| Language / runtime | JavaScript on **Node.js 22.23.3**, shipped as a **Node SEA** (single executable application) |
| Architecture | Single-process HTTP server (`app/server.js`) + single-file browser UI (`app/public/index.html`), no framework |
| Native component | `app/helper/pphelper.cs` + `pptray.cs` (C#/.NET Framework, compiled in CI by in-box `csc`) |
| Runtime npm dependencies | **none** — the repo has no `package.json`, no lockfile, no `node_modules` |
| Build dependencies | `postject@1.0.0-alpha.6` (fetched by `npx` in `app/build.ps1`), in-box `csc`, GitHub Actions |
| Deployment | Portable Windows zip; no installer, no admin rights, no installed Node |
| Persistence | JSON state file + optional bundled-SQLite sample store under the user's data dir |
| Network surface | loopback HTTP API (default `127.0.0.1:8765`); optional HTTPS web GUI (self-signed cert, TLS 1.2+); optional remote-agent mode (token-protected) |
| Baseline (before any change) | `node --test` suite: **53 pass, 0 fail**; `node --check` clean on every `app/` and `tests/` JS file |

Because there are no npm runtime dependencies, the "dependency surface" of this project is the **embedded Node runtime**, the **build toolchain**, and the **CI actions** — all three were audited individually.

---

## 2. Dependency / CVE findings

### 2.1 Embedded Node.js runtime 22.23.3

Verified from CI build logs of the v1.1.0 release run (runner tool cache), not from the workflow input.

- **22.23.3 is the newest 22.x release** as of 2026-10-16 (released 2026-09-23; `https://nodejs.org/dist/index.json`). It is **not** itself a security release.
- **Advisories affecting 22.23.3: 0 (zero).** Every published Node.js advisory was fixed in **22.23.2** or earlier — including the 2026-07-29 batch of 11 CVEs (`CVE-2026-56846`, `-56848`, `-58043`, `-56850`, `-58040`, `-58041`, `-58042`, `-58045`, `-56847`, `-58039`, `-58044`; source: `https://nodejs.org/en/blog/vulnerability/july-2026-security-releases`), of which 10 listed 22.x as affected. All are already contained in 22.23.3.
- **FALSE POSITIVE avoided:** `CVE-2026-58041` (node:sqlite SQLTagStore iterator replay) is relevant to this app's use of `node:sqlite` — but its affected range is **24.x/26.x only, not 22.x**, so it does not apply to the embedded runtime.
- **NEEDS INVESTIGATION — time-boxed:** the Node project has announced a 22.x security release for **2026-10-21** with issues up to **HIGH** severity (`https://nodejs.org/en/blog/vulnerability/october-2026-security-releases`). No CVE/GHSA IDs or subsystems are published yet, so 22.23.3 is *known to be affected by at least one undisclosed issue*. **Action: after 2026-10-21, re-check the advisory, rebuild, and re-release.** Because the workflow installs `node-version: "22"`, a rebuild picks up the patched runtime automatically — no code change required.
- Method note: the GitHub Advisory API does not expose version-filtered Node.js core advisories (`?ecosystem=npm&affects=node` returns 0 rows; Node advisories exist in GHSA but carry empty package metadata), and OSV has no `node`/npm records. Version-range verification was therefore done against the authoritative channel — nodejs.org's `dist/index.json` security flags plus the vulnerability blog posts.

### 2.2 CI actions and build tools

- **Actions:** 0 published advisories for `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/cache`, or `Azure/artifact-signing-action` (checked two ways: per-package queries and a full sweep of the GHSA `actions` ecosystem, 56 advisories). Note: a widely-cited `GHSA-9c25-pcw4-5748` for `actions/checkout` **does not exist** in the advisory database (direct lookup returns nothing) — not reported as a finding. The nearest real advisories are for `actions/download-artifact` (`GHSA-cxww-7g56-2vh6`) and `actions/runner`, neither of which this pipeline uses.
- **`postject@1.0.0-alpha.6`:** 0 advisories (GHSA API + OSV query). Not vulnerable — but see CI-06 for its *supply-chain* risk.

---

## 3. Application source findings

### 3.1 Confirmed issues — fixed

| ID | Finding | Severity | Fix |
|---|---|---|---|
| **SEC-01** | State-changing target actions (`start`, `stop`, `clear`, `retrace`) were reachable by **GET**. A GET is a "simple request": any web page the user visits could stop tracing, and a read-only viewer/LiveShare role — defined as GET/HEAD-only — could mutate state. | Medium | Those actions now require **POST**; other methods get `405 Method Not Allowed`. UI and CLI already used POST, so no caller changed. |
| **SEC-02** | Unbounded in-memory growth: the reverse-DNS `nameCache` grew without limit (LAN scans / large target sets). | Low | Cache capped at **5000 entries**, oldest evicted. |
| **SEC-03** | Unbounded per-target growth: `comments` array grew without limit via the comments API. | Low | Capped at **1000** per target, oldest trimmed. |
| **SEC-04** | Unbounded user-created structures: custom grid columns per target were unbounded. | Low | Capped at **50** per target; the 51st is rejected with `400`. |

Each fix is covered by an integration test that boots the **real** server (not a mock) — see §6.

### 3.2 Controls verified as already correct (no change needed)

- **XSS / UI injection — CONFIRMED OK.** Every user-controlled value in the render paths (target host, hop IP/name, comments, custom-column names *and* values, extension columns, saved-set names, interface names) is passed through `esc()` (`& < > "`), and interpolations that are not escaped are numeric or from fixed palettes. Reviewed `innerHTML` sites: hop table, tiles/overview, tabs, comments dialog, route-change dialog, alert rules, about/interfaces, column picker, saved sets. No stored-XSS path found.
- **Static-file path traversal — CONFIRMED OK.** Requests containing `..` are refused before any file resolution; encoded traversal does not resolve. Verified by test (see §6).
- **Argument injection into `ping` / helper — CONFIRMED OK.** `validHost()` is a strict allowlist (`[a-zA-Z0-9]([a-zA-Z0-9.\-_]{0,251}[a-zA-Z0-9])?` or hex/colon IPv6), which rejects leading `-`, spaces, and shell separators; it is applied on every entry path (API create, import, persisted-state load, agent sync, set files). Subprocesses are invoked with `execFile`/`spawn` **argument arrays** — never a shell — so no shell metacharacter interpretation occurs.
- **Local-mode request gates — CONFIRMED OK.** Foreign `Host`, foreign `Origin`, and `Sec-Fetch-Site: cross-site` are refused with `403` (DNS-rebinding + CSRF defence). Verified by test.
- **Request body cap — CONFIRMED OK.** `Content-Length` over the limit is answered `413` before reading the body.
- **Web-GUI crypto — CONFIRMED OK.** Passwords hashed with **scrypt** (per-user random salt); sessions are HMAC-SHA256-signed cookies with a 32-byte random secret; tokens compared with **`timingSafeEqual`** (length-checked); tokens generated with `randomBytes`; TLS server pinned to **`minVersion: 'TLSv1.2'`**; per-IP sign-in throttling present.
- **Security headers — CONFIRMED OK.** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, plus a `Content-Security-Policy` on HTML responses.
- **Secrets in tracked files — CONFIRMED NONE.** A scan of all tracked files for API keys, tokens, passwords, private keys, and cloud credential patterns found only *references* to GitHub Actions secrets (`${{ secrets.* }}`, never values) and documentation prose. Nothing to rotate or revoke. The remote-agent token is generated at runtime (`randomBytes`).

### 3.3 Informational / by design

- **Alert-rule commands (`rule.action === 'command'`) execute a user-configured program** via `execFile` when an alert fires. This is a documented feature; the config file lives in the user's own data directory, so it crosses no privilege boundary. Recorded as BY DESIGN, not a vulnerability.
- **Extensions are loaded with `vm.runInNewContext`** with a restricted global set and a 500 ms timeout. `node:vm` is **not a security sandbox** — but extensions are local files the user deliberately places in the extensions directory, i.e. trusted local code. BY DESIGN; noted so nobody mistakes the timeout for a security boundary.

---

## 4. CI / supply-chain findings

| ID | Finding | Severity | Status |
|---|---|---|---|
| **CI-01** | Top-level `permissions: contents: write` is granted to the single `build` job, which also checks out and executes PR code. Only the release step (v* tags) needs write. | Medium | **Recommend-only (documented)** — splitting build/publish into two jobs changes the proven-green release pipeline; see §7. |
| **CI-02** | All four `uses:` refs were **mutable major tags** (`@v4`, `@v2`); upstream could move them without a repo change. | Medium | **FIXED** — pinned to full commit SHAs with version comments (checkout `11d5960…` v4.4.0, setup-node `49933ea…` v4.4.0, upload-artifact `ea165f8…` v4.6.2, Azure/artifact-signing-action `c7ab2a8…` v2.0.0). Added `.github/dependabot.yml` (github-actions, weekly) as the controlled update path. |
| **CI-03** | Transitive `actions/cache` via setup-node. | Info | **No change** — dependency caching is not enabled (zero-dependency repo, no lockfile); keep `cache` unset. If setup-node is ever bumped to v5+, set `package-manager-cache: false` (v5+ auto-caches). |
| **CI-04** | The optional Azure signing step was gated on a repo *variable* (`vars.*`), which **is** visible to fork PR runs → signing would run on fork PRs with empty secrets and fail red (no leak: fork runs get no secrets). | Low | **FIXED** — gate now also requires `github.event_name != 'pull_request'`. |
| **CI-05** | `actions/checkout` persisted the write-scoped token into the runner's git config. | Info | **FIXED** — `persist-credentials: false`; nothing in the job pushes via git (the release uses the `gh` CLI). |
| **CI-06** | `npx -y postject@1.0.0-alpha.6` fetches the SEA-injection tool from npm at build time with **no integrity verification**; postject injects the payload into the shipped `PingTracer.exe`, so a swapped tarball compromises the release artifact. | Medium | **Recommend-only (documented)** — vendoring the tarball + hash check changes build semantics; see §7. Current registry hashes recorded in §7 for when it is implemented. |
| **CI-07** | `runs-on: windows-latest` is a floating image; the shipped binary is compiled on a moving OS image. | Low | **Recommend-only (documented)** — pinning to `windows-2025` changes which image future builds use; see §7. |
| **CI-08** | The Defender release gate **degraded silently**: a missing `MpCmdRun.exe` produced a warning and `exit 0`, so a release could publish completely unscanned. | Low | **FIXED** — on tag refs a missing scanner now **fails the job**; non-release builds still skip gracefully. |
| **CI-09** | Shell-injection scan of `run:` blocks. | Info | **No change needed** — all nine `${{ }}` interpolations are in triggers/concurrency/action inputs/env, none inside a script body; scripts consume env vars and pass data via `process.argv`. |
| **CI-10** | Concurrency + timeout controls. | Info | **No change needed** — per-ref concurrency group with cancel-in-progress disabled for tags (prevents a half-published release) and a 30-minute job timeout. |
| **CI-11** | Artifact integrity was verified in-job, but nothing verified the **published** release assets after upload. | Low | **FIXED** — the release step now downloads the published zip back and re-verifies it against the released `SHA256SUMS.txt`, failing the job on mismatch. |

---

## 5. Credential handling

No credentials, tokens, API keys, private keys, or connection strings are committed to this repository (scan in §3.2). No credential that was ever active in this repo was found, so **no rotation is required**. Runtime secrets (remote-agent token, web session secret, generated TLS material) are created at first use with `crypto.randomBytes` and stored in the user's data directory, not in the repo. Azure signing credentials are consumed from GitHub Actions secrets only.

---

## 6. Remediation and verification

Remediations were kept deliberately minimal and confined to the existing conventions of the codebase (zero new dependencies, no architecture change, no second competing mechanism).

- **App hardening (SEC-01…SEC-04):** `app/server.js` — commit `b3a3f43`.
- **Regression suite:** `tests/security.test.js` (new, 8 tests) — boots the real server with a temp data dir and a free port; one test per finding class: POST-only enforcement (+ proof the rejected GETs did not mutate state), Host/Origin/Sec-Fetch-Site gates, static traversal rejection, argument-injection-safe host validation, 413 body cap, comments cap, custom-column cap.
- **CI hardening (CI-02, CI-04, CI-05, CI-08, CI-11):** `.github/workflows/windows-release.yml` + `.github/dependabot.yml`.

**Verification performed**

| Check | Result |
|---|---|
| Full local suite, before remediation (baseline) | 53 pass, 0 fail |
| Full local suite, after remediation (second scan) | **61 pass, 0 fail** |
| `node --check` on all `app/` + `tests/` JS | clean |
| Workflow + dependabot YAML parse, and every `uses:` ref is a 40-char SHA | valid, 0 mutable refs |
| `refs/tags/v1.1.1` release workflow on the hardened pipeline | run `38952251057` + `38952249342` — **success** |
| Advisory re-check (GHSA API, OSV API, nodejs.org) | 0 advisories affecting the embedded runtime or toolchain |
| Secret scan over tracked files | no findings |

**Published:** v1.1.1 (security hardening) — https://github.com/JonnyUtah12/ping-tracer/releases/tag/v1.1.1

---

## 7. Open items / follow-ups

1. **Rebuild after 2026-10-21 (time-boxed, highest priority).** Node's announced 22.x security release fixes undisclosed issues up to HIGH that affect 22.23.3. When the advisory lands: verify the fixed version, rebuild, and publish. No code change is expected (the workflow resolves `node-version: "22"`).
2. **CI-01 — split build and publish into two jobs.** Recommended shape: top-level `permissions: contents: read`; the `build` job (all PR/push paths) keeps read-only; a second `release` job with `needs: build`, `if: startsWith(github.ref, 'refs/tags/v')`, `permissions: contents: write`, running on `ubuntu-latest`, doing checkout + `actions/download-artifact` + `sha256sum -c` + the existing `gh release create` block. Deliberately **not** applied in this pass: it rewrites the release path and cannot be fully validated without a tag push, so it should be done as its own reviewed change with a dry-run tag.
3. **CI-06 — vendor `postject`.** `npm pack postject@1.0.0-alpha.6`, commit `vendor/postject-1.0.0-alpha.6.tgz`, verify `Get-FileHash` against the committed value in `build.ps1`, then `npx -y .\vendor\postject-1.0.0-alpha.6.tgz`. Registry values as of 2026-10-16: integrity `sha512-b9Eb8h2eVqNE8edvKdwqkrY6O7kAwmI8kcnBv1NScolYJbo59XUF0noFq+lxbC1yN20bmC0WBEbDC5H/7ASb0A==`, npm shasum `9d022332272e2cfce8dea4cfce1ee6dd1b2ee135`. Removes network access from the build.
4. **CI-07 — pin `windows-2025`** so toolchain drift requires an explicit commit.
5. **Node 22.x is a maintenance line.** Track the Node release schedule; when 22.x goes end-of-life, plan the move to the next LTS line (the app uses no version-specific APIs beyond `node:sqlite`, which is available from 22.5).
