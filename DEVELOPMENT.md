# Developer guide

Deep reference for working on this project. `CLAUDE.md` is the short version
loaded into every Claude session; this file is the long form. User-facing docs
are `README.md` (repo root) and `proton_drive_backup/{README,DOCS,CHANGELOG}.md`.

---

## 1. What this is

A **Home Assistant app** (the term HA uses since 2026.2; technically still an
"add-on") that backs up Home Assistant to **Proton Drive**. It is a single
self-contained Node.js process shipped as a Docker container the HA Supervisor
runs. It talks to:

- the **Supervisor backup API** (to create/list/download/upload/restore/delete
  Home Assistant backups), and
- **Proton Drive** via the official `@protontech/drive-sdk` (to upload/list/
  download/delete the backup archives in the cloud).

There is **no companion Python integration**. An earlier design used a Python
custom integration driving a Node subprocess; it was removed because Node can't
run inside HA Core's Python container. An app ships its own container, so Node
is available — hence the standalone-app architecture.

**Runs only on HA OS / Supervised** (apps/the Supervisor don't exist on Core or
Container installs).

---

## 2. Repository layout

```
ha-addon-proton-drive-backup/        ← the app *repository* (added to HA)
  repository.yaml                    ← declares the repo to HA
  README.md                          ← user-facing repo readme
  CLAUDE.md                          ← short dev guide (always in Claude context)
  DEVELOPMENT.md                     ← this file
  .gitattributes                     ← forces LF (critical for run.sh)
  .gitignore
  proton_drive_backup/               ← the app itself; folder name = the slug
    config.yaml                      ← app manifest (options, schema, perms)
    Dockerfile                       ← builds the image (and the JS bundle)
    run.sh                           ← bashio entrypoint: config -> env -> node
    package.json                     ← deps + version (single source of version)
    build.mjs                        ← esbuild config
    icon.png / logo.png              ← store art
    README.md / DOCS.md / CHANGELOG.md
    src/                             ← source (bundled into dist/ at image build)
      main.mjs
      cryptoSetup.mjs
      httpClient.mjs
      account.mjs
      protonClient.mjs
      protonAuth.mjs
      supervisor.mjs
      orchestrator.mjs
      ingress.mjs
    dist/main.mjs                    ← build artifact; gitignored, built in Docker
```

The repo is an **app repository** (can host multiple apps); each app is a
subfolder whose name is the slug. That is why the repo name and the
`proton_drive_backup/` folder name differ — by design, not by accident.

---

## 3. Runtime architecture & data flow

```
                Home Assistant host (HA OS / Supervised)
  ┌───────────────────────────────────────────────────────────────┐
  │  Supervisor          this app's container (Node 20, single proc)│
  │  ┌────────────┐      ┌─────────────────────────────────────┐   │
  │  │ backup API │◄────►│ supervisor.mjs                       │   │
  │  └────────────┘      │   ▲                                  │   │
  │                      │   │ orchestrator.mjs (sync+retention)│   │
  │                      │   │   ├─ protonAuth.mjs (login/sess) │   │
  │                      │   │   └─ protonClient.mjs (SDK ops)  │───┼──► Proton Drive
  │                      │   │ ingress.mjs (web UI + JSON API)  │   │   (drive-api.proton.me)
  │  HA ingress  ───────►│   │ main.mjs (boot, scheduler)       │   │
  │  (auth'd UI)         └─────────────────────────────────────┘   │   account-api.proton.me
  │                         persistent /data: session.json,        │   (auth/core, our code)
  │                         auth_halt.json, tmp/                    │
  └───────────────────────────────────────────────────────────────┘
```

**Backup (sync) flow** (`orchestrator.runSync`):
1. `ensureSession()` — make sure we're logged into Proton (see §5).
2. If automatic backups are enabled, ask the Supervisor to create a new HA
   backup named `Proton Drive Backup <ISO timestamp>`.
3. `syncBackupsToProton()` — list HA backups + Proton backups; for any HA backup
   whose `slug` isn't already present in Proton (matched via stored metadata),
   download it from the Supervisor to `/data/tmp/<slug>.tar` and upload it to
   Proton Drive, then delete the temp file.
4. `pruneProton()` then `pruneHA()` — enforce retention counts.

**Restore flow** (`orchestrator.restoreToHA(linkId)`): download the archive from
Proton to `/data/tmp/restore.tar`, upload it to the Supervisor, then trigger a
full restore.

Backup archives are never streamed through a third party — they go
Supervisor → this container → Proton (and back for restore), all in-process.

---

## 4. Module reference

| File | Responsibility |
| --- | --- |
| `main.mjs` | Boot: install timestamped logging at the configured level, `setupCrypto()`, ensure `/data/tmp`, start ingress, run an initial sync ~5s after start, schedule recurring syncs if `BACKUP_INTERVAL_HOURS > 0`, handle SIGTERM/SIGINT. |
| `cryptoSetup.mjs` | One-time init of Proton's `CryptoProxy` for Node: imports `@protontech/crypto/polyfill`, sets `globalThis.crypto`, `CryptoApi.init({})`, `CryptoProxy.setEndpoint(new CryptoApi())`. **Must** run before any crypto/Drive call. Note the `.ts` in the import `@protontech/crypto/proxy/endpoint/api.ts`. |
| `httpClient.mjs` | (a) `HttpClient` implements the SDK's `ProtonDriveHTTPClient` (`fetchJson`/`fetchBlob`) and adds Proton auth headers + 401 refresh for Drive calls; also `authGet`/`authPost` for the account/core API. (b) `srpAuth()` — the SRP login the SDK does **not** provide. Holds `APP_VERSION`, hosts, `USER_AGENT`, and `formatProtonError`. |
| `account.mjs` | `buildAccount()` fetches `core/v4/addresses`, imports each enabled address's private keys with the key password (`CryptoProxy.importPrivateKey`), and returns the SDK's `ProtonDriveAccount`. |
| `protonClient.mjs` | Wraps `ProtonDriveClient`: `initClient`, `resolveFolder` (walks/creates a `/`-separated folder path), `listBackups`, `uploadBackup`, `downloadBackup`, `deleteBackup`. |
| `protonAuth.mjs` | Session lifecycle: `ensureSession`, `beginAuth` (SRP → maybe 2FA), `submitTwoFactorCode`, `restorePersistedSession`, `retryNow`, `getAuthState`. Owns session encryption-at-rest and the halt-on-failure logic. |
| `supervisor.mjs` | HA Supervisor backup API client (`http://supervisor`, `SUPERVISOR_TOKEN`). |
| `orchestrator.mjs` | `runSync`, `restoreToHA`, `pruneProton`, `pruneHA`, status state, `describeError` (surfaces `err.cause`). |
| `ingress.mjs` | `node:http` server: self-contained HTML UI + JSON API (`/api/status`, `/api/backup-now`, `/api/restore`, `/api/delete`, `/api/2fa`, `/api/retry`). |

---

## 5. Authentication (the part with all the sharp edges)

**The SDK does NOT do authentication.** Its README explicitly lists
"Authentication or login flows", "Session management", and "User address
provider" as out of scope — official Proton clients wire those in. So all of
this is our own code in `httpClient.mjs` + `protonAuth.mjs`.

### Hosts (learned the hard way)
- Account/auth + core API: **`https://account-api.proton.me`** (`AUTH_API`).
- Drive API: **`drive-api.proton.me`** (`DRIVE_HOST`; the SDK's default).
- ⚠️ **`api.proton.me` does NOT exist (NXDOMAIN).** It was the original auth base
  URL and caused every login to fail with `fetch failed (cause: ENOTFOUND)`.
  Proton's hosts follow the `<service>-api.proton.me` pattern.

### Flow
1. **SRP login** (`srpAuth`): `POST /auth/v4/info` (gets modulus/salt/ephemeral)
   → `getSrp(...)` from `@protontech/crypto/srp` → `POST /auth/v4` → verify
   server proof. Returns `{ session: {uid,accessToken,refreshToken}, twoFactor }`.
   Uses `PROTON_EMAIL` / `PROTON_PASSWORD`.
2. **2FA gate** (`beginAuth`): if `twoFactor.Enabled`, set `needsTwoFactor`, keep
   the partial session, throw `NEEDS_2FA`. The UI shows a code box; the user's
   live 6-digit code goes to `submitTwoFactorCode` → `POST auth/v4/2fa`. **The
   TOTP seed is never stored** — only a single-use code the user types in.
3. **Key unlock** (`completeLogin`): `GET core/v4/keys/salts` →
   `computeKeyPassword(password, salt)` → `buildAccount` imports the address
   private keys → `initClient`.
4. **Persistence + refresh**: session saved to `${DATA_DIR}/session.json`,
   **encrypted** (see §6). 401s trigger `POST auth/v4/refresh`, rotating tokens
   that are re-persisted via `onRefresh`. On restart, `restorePersistedSession`
   rebuilds from disk and verifies with a cheap `listBackups`; only if that
   fails do we re-run SRP.

### App identification (Proton requires this)
`x-pm-appversion: external-drive-ha_addon_proton_drive_backup@<version>-alpha`,
sent on every request. Rules from the SDK README:
- Shape: `external-drive-{name}@{semver}-{channel}` (`{name}` lowercase +
  underscores; `{channel}` ∈ stable|beta|alpha).
- Must identify **this** project honestly. It is **not** `home_assistant`
  (that impersonates the HA project) and must not imply Proton.
- The version is **injected from `package.json` at build time** (`build.mjs`
  `define: __APP_VERSION__`), so it can't drift from the real build.
Also send an honest `User-Agent`. Do **not** spoof first-party Proton clients.

### Halt-on-failure (no auto-retry)
We do **not** automatically retry failed logins — repeated SRP attempts (e.g. on
every restart) can trip Proton's abuse protection and lock the account.
- On any login failure, `haltOnAuthFailure` writes `${DATA_DIR}/auth_halt.json`
  (`{halted, hardStop, lastError}`) and we stop attempting. The halt **persists
  across restarts**, so a watchdog/restart loop can't keep hitting Proton.
- `NEEDS_2FA` is **not** a failure (no halt) — the app stays up so the user can
  enter a code. While `needsTwoFactor` is set, `ensureSession` short-circuits so
  sync ticks don't re-run SRP.
- `isRateLimited(err)` flags 429 / "unusual activity" / "temporarily limited"
  responses as `hardStop`, which the UI surfaces with a "verify at
  account.proton.me" hint.
- The user clears a halt with **Retry connection** (`/api/retry` → `retryNow`).

### Error detail
`formatProtonError` includes the endpoint, Proton `Code`, HTTP status, and any
`Details` in the thrown message, so logs/UI show e.g.
`… [auth/v4 Code=9001 HTTP=422] Details={…}`. `Code 9001` = human verification
(CAPTCHA) required; `8002`/`10013` = invalid credentials.

---

## 6. Session encryption at rest

`session.json` (uid, tokens, derived key password, email) is encrypted with
**AES-256-GCM**. The key is `scrypt(PROTON_PASSWORD, randomSalt, 32)`, derived at
runtime and **never written to disk**. The on-disk envelope is
`{v,alg,salt,iv,tag,ct}` (all base64). `loadPersistedSession` transparently
migrates a legacy plaintext file (re-encrypted on next write).

**Honest caveat:** this is defense-in-depth, not a strong boundary. The Proton
password lives in HA's `options.json` in **plaintext** (Supervisor storage we
don't control), so anyone with full host access can re-derive the key. Don't
overstate this in user docs.

---

## 7. Proton Drive SDK integration

`initClient` constructs `ProtonDriveClient` with: `httpClient`, `account`,
`entitiesCache` + `cryptoCache` (`new MemoryCache()`),
`openPGPCryptoModule: new OpenPGPCryptoWithCryptoProxy(CryptoProxy)`, an
`srpModule` adapter over `@protontech/crypto/srp`, and `NullFeatureFlagProvider`.

- **Folder resolution** (`resolveFolder`): start at `getMyFilesRootFolder`, split
  `drive_folder` on `/`, and for each segment find a child folder via
  `iterateFolderChildren(uid, {type: NodeType.Folder})` or create it.
- **Metadata round-trip**: HA backup metadata is stored under
  `additionalMetadata: { HomeAssistant: {...} }` on upload and read from
  `node.activeRevision.claimedAdditionalMetadata.HomeAssistant`. The top-level
  `Common` key is **reserved by the SDK** — always nest under our own key.
- **Upload**: `getFileUploader(folderUid, name, {mediaType, expectedSize,
  additionalMetadata})` → `uploadFromStream(ReadableStream, [])` →
  `controller.completion()` → `{nodeUid}`.
- **Download**: `getFileDownloader(linkId)` → `downloadToStream(WritableStream)`
  → `controller.completion()`.
- **Delete**: `trashNodes([linkId])` (async generator).
- **MaybeNode** = `{ok:true,value}|{ok:false,error}`; use `getUid()` for uids.

---

## 8. Supervisor API (`supervisor.mjs`)

Base `http://supervisor`, bearer `SUPERVISOR_TOKEN`. Every response is
`{result:'ok'|'error', data, message}` — we check `result` and unwrap `data`.
Granted `hassio_api: true` + `hassio_role: manager` in `config.yaml`.

- `listBackups` → `GET /backups` (`data.backups`).
- `createBackup({name,password,full})` → full: `POST /backups/new/full`;
  partial: `POST /backups/new/partial` with `homeassistant:true`. Returns slug.
- `downloadBackup(slug, dest)` → streams `GET /backups/{slug}/download` to a file.
- `uploadBackup(src)` → multipart `POST /backups/new/upload` (field `file`).
- `restoreBackup(slug, password)` → `POST /backups/{slug}/restore/full`.
- `deleteBackup(slug)` → `DELETE /backups/{slug}`.

---

## 9. Orchestration & retention

- `runSync` wraps everything in try/catch and **never throws out** (so it can't
  crash the scheduler/UI); failures go to `state.lastError` via `describeError`.
- Retention: `backups_in_proton` / `backups_in_ha` (0 = don't prune). Sorted
  oldest-first by metadata date; excess deleted.
- `pruneHA` only ever deletes backups whose name starts with
  `Proton Drive Backup` — backups you made by other means are never touched.

---

## 10. Build system

`npm run build` → esbuild bundles `src/main.mjs` → `dist/main.mjs`. **Three
workarounds in `build.mjs` are mandatory** (each was found by trial and error):
1. `format: 'esm'` — a dep calls `createRequire(import.meta.url)`, undefined in CJS.
2. `banner.js` injecting `require`/`__filename`/`__dirname` — bundled CJS deps
   (e.g. `@noble/hashes`) call `require('node:crypto')`.
3. `alias: { 'openpgp/lightweight': 'openpgp' }` — lightweight has no node export
   condition.
Plus `define: { __APP_VERSION__: ... }` injecting the app version from
`package.json` (§5).

`dist/` is **gitignored** — the Docker image rebuilds it (`Dockerfile` runs
`npm install && npm run build`, then `rm -rf node_modules src`). Don't commit it.
There is **no test suite / linter**; "verifying" means rebuild + boot the bundle
with env vars and confirm it starts cleanly (login fails fast without creds and
is caught; the ingress server stays up).

---

## 11. Configuration plumbing

`config.yaml` `options:`/`schema:` → `run.sh` (bashio) exports each as an env var
→ code reads `process.env`. To add an option you touch **four** places:
`config.yaml` (both `options` and `schema`), `run.sh` (export, guarding optional
values with `bashio::config.has_value` to avoid the literal string `null`), and
the reader (`main.mjs` / `orchestrator.mjs`). `ingress_port: 8099` in
`config.yaml` must equal `export PORT=8099` in `run.sh`.

Env vars: `PROTON_EMAIL`, `PROTON_PASSWORD`, `DRIVE_FOLDER`,
`BACKUP_INTERVAL_HOURS`, `BACKUPS_IN_PROTON`, `BACKUPS_IN_HA`, `FULL_BACKUP`,
`BACKUP_PASSWORD`, `LOG_LEVEL`, plus `PORT`, `DATA_DIR`, and `SUPERVISOR_TOKEN`
(provided by HA).

---

## 12. Versioning & release

`package.json` `version` is the **single source of truth** (the appversion
derives from it). On each release bump it in lockstep in three places:
`config.yaml` `version:`, `Dockerfile` `io.hassio.version`, and `package.json`,
add a `CHANGELOG.md` entry, rebuild, commit, push.

⚠️ **HA only offers an update when the version increases.** Going *backwards*
(we once went 1.0.0 → 0.1.0) means HA won't show an update — the user must
uninstall/reinstall or use **Rebuild**. Always bump *up*.

---

## 13. Deployment

`Dockerfile`: `FROM ghcr.io/home-assistant/base:3.21` (explicit — the
`BUILD_FROM` arg is no longer auto-provided by recent Supervisor versions),
`apk add nodejs npm`, copy + build, strip `node_modules`/`src`, run `run.sh`.
LF endings are enforced by `.gitattributes` (CRLF would break the
`#!/usr/bin/with-contenv bashio` shebang).

Push is over HTTPS to `github.com/nicandris/ha-addon-proton-drive-backup` (SSH
auth wasn't configured in the dev environment; Git's Windows credential helper
handles HTTPS).

---

## 14. Compliance with Proton's SDK guidelines

The SDK README imposes rules on third-party clients; non-compliant clients
"may be rate-limited or blocked." Status here:
- ✅ Identify the app honestly via `x-pm-appversion` (§5).
- ✅ Use official endpoints only; don't proxy/modify domains.
- ✅ No Proton branding; disclose third-party status when collecting credentials
  (see the security sections in the user docs).
- ⚠️ **Event-based sync, no polling/recursive traversal** — *not yet met.* The UI
  polls `/api/status` every 10s and we re-`resolveFolder` + `listBackups` on each
  status/sync, which is recursive folder traversal. This risks rate-limiting and
  should move to Drive events + caching. **Known gap.**
- ⚠️ Auth is hand-rolled and out of SDK scope; Proton may gate third-party auth
  (see §15).

---

## 15. Known limitations & gotchas

- **Proton "unusual activity" block on first login.** Seen on a brand-new
  account, first attempt — i.e. not retry volume. Likely IP reputation, new-
  account human verification, or Proton gating third-party auth. Check the
  `Code` in the error: `9001` = human verification (would need a CAPTCHA flow in
  the UI — not yet built); a hard abuse code likely needs Proton's appeal or
  means third-party auth isn't open yet. The SDK is explicitly "not ready for
  third-party production use."
- **"Back up now" with automatic backups disabled.** `runSync` only *creates* a
  new HA backup when `BACKUP_INTERVAL_HOURS > 0`; with auto disabled it just
  syncs/prunes existing backups. Triggering a fresh backup from the UI while
  disabled does not currently create one. (Candidate fix: pass an explicit
  "create" flag from `/api/backup-now`.)
- **Upcoming Proton crypto migration** (~end 2026/early 2027) will change the
  auth/encryption model and break older clients until updated.
- **Polling/recursion** (§14) — rate-limit risk until event-based sync lands.
- **Secrets at rest** — credentials live in HA `options.json` in plaintext (§6).

---

## 16. Troubleshooting quick map

| Symptom | Meaning / action |
| --- | --- |
| `fetch failed (cause: ENOTFOUND)` | DNS — usually a wrong host. Auth host must be `account-api.proton.me` (not `api.proton.me`). |
| `fetch failed (cause: ECONNREFUSED/ETIMEDOUT)` | Network/firewall/IPv6 from the container. |
| `… unusual activity … temporarily limited …` | Proton abuse/verification. Verify at account.proton.me, wait, then **Retry connection**. Check the `Code`. |
| `Invalid credentials` (`8002`/`10013`) | Wrong email/password. |
| Status `halted` | A prior login failed; the app stopped auto-retrying. Fix cause, click **Retry connection**. |
| Status `needs 2FA` | Enter the 6-digit code in the UI. |
| App won't pick up new code | Version didn't increase, or use **Rebuild** (§12). |
