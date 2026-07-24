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
- **Proton Drive** via Proton's official first-party
  [`proton-drive`](https://proton.me/support/proton-drive-cli) CLI (MIT-licensed),
  which the app shells out to for every Drive operation **and** for sign-in.

There is **no companion Python integration**. An earlier design used a Python
custom integration driving a Node subprocess; it was removed because Node can't
run inside HA Core's Python container. An app ships its own container, so Node
(and the bundled CLI binary) are available — hence the standalone-app
architecture.

**Runs only on HA OS / Supervised** (apps/the Supervisor don't exist on Core or
Container installs), on **amd64** or **aarch64** (Proton ships no `armv7`/`i386`
CLI build).

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
    config.yaml                      ← app manifest (options, schema, perms, arch)
    Dockerfile                       ← builds the image (downloads the CLI binary)
    run.sh                           ← bashio entrypoint: config -> env -> node
    package.json                     ← npm scripts only (start/test); no deps, no version
    icon.png / logo.png              ← store art
    README.md / DOCS.md / CHANGELOG.md
    src/                             ← source, run directly (no build step)
      main.mjs
      protonCli.mjs
      orchestrator.mjs
      supervisor.mjs
      ingress.mjs
      logger.mjs
    test/                            ← node:test unit tests
      orchestrator.test.mjs
      protonCli.test.mjs
      fixtures/fake-proton-drive.mjs
```

The repo is an **app repository** (can host multiple apps); each app is a
subfolder whose name is the slug. That is why the repo name and the
`proton_drive_backup/` folder name differ — by design, not by accident.

---

## 3. Runtime architecture & data flow

```
                Home Assistant host (HA OS / Supervised)
  ┌───────────────────────────────────────────────────────────────┐
  │  Supervisor          this app's container (Node + proton-drive) │
  │  ┌────────────┐      ┌─────────────────────────────────────┐   │
  │  │ backup API │◄────►│ supervisor.mjs                       │   │
  │  └────────────┘      │   ▲                                  │   │
  │                      │   │ orchestrator.mjs (sync+retention)│   │
  │                      │   │   └─ protonCli.mjs ──────────────┼───┼──► proton-drive CLI
  │                      │   │ ingress.mjs (web UI + JSON API)  │   │     ──► Proton Drive
  │  HA ingress  ───────►│   │ main.mjs (boot, scheduler)       │   │
  │  (auth'd UI)         │   │ logger.mjs (runtime log level)   │   │
  │                      └─────────────────────────────────────┘   │
  │                         persistent /data:                       │
  │                           proton-drive-cli/  (CLI session)      │
  │                           tmp/               (staging)          │
  └───────────────────────────────────────────────────────────────┘
```

**Backup (sync) flow** (`orchestrator.runSync`):
1. `ensureSession()` — probe `cli.isConnected()` to confirm we're signed in
   (see §5). If not, set `needsLogin`, record a friendly `lastError`, and stop —
   the UI drives sign-in; sync never auto-logs-in.
2. If automatic backups are enabled (`BACKUP_INTERVAL_HOURS > 0`), ask the
   Supervisor to create a new HA backup named `Proton Drive Backup <ISO
   timestamp>`.
3. `syncBackupsToProton()` — list HA backups + the Drive folder's contents; for
   any of *our* HA backups whose `<name>.tar` isn't already present in Proton,
   download it from the Supervisor to `/data/tmp/<name>.tar` and upload it, then
   delete the temp file.
4. `pruneProton()` then `pruneHA()` — enforce retention counts.

**Restore flow** (`orchestrator.restoreToHA(remoteName)`): download the archive
from Proton to `/data/tmp/<remoteName>`, upload it to the Supervisor, then
trigger a full restore.

Backup archives are never streamed through a third party — they go
Supervisor → this container → Proton (and back for restore), all in-process.

**Everything is matched by filename.** The CLI has **no metadata API**, so the
app derives identity from the name: our HA backups are named `Proton Drive Backup
<ISO>` and the remote file is `<name>.tar`. Because the name embeds an ISO
timestamp, a lexical sort is chronological, which is what retention relies on.

---

## 4. Module reference

| File | Responsibility |
| --- | --- |
| `main.mjs` | Boot: import `logger.mjs` first (patches `console`), read config from env, ensure `/data/tmp`, start ingress, run an initial sync ~5s after start, schedule recurring syncs if `BACKUP_INTERVAL_HOURS > 0`, handle SIGTERM/SIGINT. No crypto/login setup — the CLI owns auth. |
| `protonCli.mjs` | Thin wrapper around the `proton-drive` binary. See §5. |
| `orchestrator.mjs` | `runSync`, `restoreToHA`, `deleteProtonBackup`, `listProtonBackups`, `ensureSession`, status state, and the **pure decision functions** (§6). Resilient: per-backup errors are caught into `state.lastError`; `runSync` never throws out. A `syncing` guard prevents overlapping syncs. `describeError` surfaces `err.cause`. |
| `supervisor.mjs` | HA Supervisor backup API client (`http://supervisor`, `SUPERVISOR_TOKEN`). §7. |
| `ingress.mjs` | `node:http` server: self-contained HTML UI + JSON API. §8. |
| `logger.mjs` | Patches `console.{log,debug,warn,error}` once on import to add ISO timestamps and level filtering (`error`/`warning`/`info`/`debug`). `setLogLevel`/`getLogLevel` allow changing the level at runtime from the UI. |

---

## 5. The CLI wrapper (`protonCli.mjs`) — where the sharp edges are

The `proton-drive` CLI owns **authentication and all Drive I/O**. This module
only spawns the binary and interprets its output.

### Binary & environment
- Binary path: `$PROTON_DRIVE_BIN` (set to `/usr/local/bin/proton-drive` by
  `run.sh`), else bare `proton-drive` on `$PATH`. Read **once at import**, so
  tests must set the env before importing the module.
- `run.sh` also exports the two env vars the CLI needs for a keyring-less
  container (see §5 auth below); `run()` always inherits `process.env`.

### `run(args, {timeoutMs, cwd})`
- Spawns the CLI and **never rejects on a nonzero exit** — it resolves
  `{code, stdout, stderr}` so callers decide what an error means. (It *does*
  reject on a spawn `error` — a missing/non-executable binary is a real failure.)
- `timeoutMs` defaults to 120 s; `<= 0` disables the timer (used for large
  uploads/downloads). On timeout the child is `SIGKILL`ed and the result is
  `code: 124` with a timeout note appended to stderr.

### Failure detection is by EXIT CODE + stderr, never JSON
The CLI signals errors via **exit code (1) + plain-text stderr even with
`-j`/`--json`**. So we never rely on JSON to detect a failure — only exit code
+ stderr text.

### Functions
- `isConnected()` — `filesystem info /my-files`; `true` iff exit 0. This is the
  cheap session probe the orchestrator/UI use.
- `login({onUrl, timeoutMs})` — spawns `auth login`, which prints a Proton
  sign-in URL and blocks until the user completes sign-in in a browser (any
  device). `onUrl` fires once, with the URL scraped from stdout/stderr via
  `/https:\/\/account\.proton\.me\/\S+/`. Resolves `{ok:true}` on exit 0, else
  `{ok:false, error}`. Default timeout 300 s.
- `logout()` — `auth logout` (drops the persisted session).
- `ensureFolder(remotePath)` — creates each missing segment under `/my-files`
  with `filesystem create-folder`, treating an "already exists"/conflict as
  success, then verifies with `filesystem info`. Returns the full remote path.
- `list(remotePath)` — `filesystem list <path> -j`. **Parses defensively**
  (the JSON shape is unverified against a live account — see §11): tolerates a
  bare array or an object with a nested array under `items`/`entries`/`data`/
  `children` (or the first array value found), tolerates bare-string entries and
  capitalised field names, coerces `name` to a string, drops nameless entries,
  and returns `[]` on any nonzero exit or parse failure. The raw output
  (truncated) is logged at debug level so the real shape can be locked down.
- `uploadFile(local, remoteParent, {conflictStrategy})` — `filesystem upload
  -c <strategy> <local> <remoteParent>`, no timeout; throws with stderr on
  failure. Default strategy `replace`. (The upload derives the remote name from
  the local basename, so the orchestrator stages the temp file under its final
  `<name>.tar`.)
- `downloadPath(remotePath, localFolder)` — `filesystem download` into a folder
  (keeps the remote filename), no timeout; throws on failure.
- `trash(remotePath)` — `filesystem trash`; throws on failure.

### Authentication — owned entirely by the CLI
There is **no** login/2FA/session/crypto code in this app any more. Sign-in is:
`auth login` → the CLI prints a URL → the Web UI surfaces it as a link → the
user completes sign-in with Proton (password + their normal two-factor, on any
device) → the CLI persists the session itself. `run.sh` configures where:

- `PROTON_DRIVE_CREDENTIALS_STORE=unsafe_file` — avoids the OS keyring (absent
  in the bare Alpine container); the session is stored as a plain file.
- `XDG_DATA_HOME=/data` — puts that file under HA's persistent `/data`
  (`$XDG_DATA_HOME/proton-drive-cli/`) so it survives restarts.

Because the CLI owns auth, there is no email/password/2FA option, no session
encryption to manage, and no halt-on-failure logic — `ensureSession` just
reports `needsLogin` and the UI drives `auth login`.

---

## 6. Orchestration & retention (`orchestrator.mjs`)

- `runSync` wraps everything in try/catch and **never throws out** (so it can't
  crash the scheduler/UI); failures go to `state.lastError` via `describeError`.
- **Overlap guard.** `runSync` is triggered from several places (startup, the
  scheduler, post-login, and "back up now"). A module-level `syncing` flag makes
  a second concurrent trigger skip — two at once made HA reject the second
  `createBackup` with `system is not running - freeze` and race on retention.
- **Pure decision functions** (no I/O, unit-tested in
  `test/orchestrator.test.mjs`):
  - `selectToUpload(haBackups, remoteEntries)` — our HA backups whose
    `<name>.tar` isn't already present remotely (dedup by remote filename).
  - `selectProtonToPrune(entries, keep)` — our remote files beyond `keep`,
    oldest first (lexical sort on the timestamped name). `keep <= 0` = keep all.
  - `selectHAToPrune(haBackups, keep)` — our HA backups beyond `keep`, oldest
    first by `date`. `keep <= 0` = keep all.
  - Helpers `isOurRemoteFile` / `isOurHABackup` / `remoteNameFor` /
    `dateFromRemoteName` are type-guarded (a non-string `name` must not crash
    retention — regression covered by tests).
- Retention only ever touches backups named with the `Proton Drive Backup`
  prefix — backups you made by other means are never pruned.

---

## 7. Supervisor API (`supervisor.mjs`)

Base `http://supervisor`, bearer `SUPERVISOR_TOKEN`. Every response is
`{result:'ok'|'error', data, message}` — we check `result` and unwrap `data`.
Granted `hassio_api: true` + `hassio_role: manager` in `config.yaml`.

- `listBackups` → `GET /backups` (`data.backups`).
- `getBackupInfo(slug)` → `GET /backups/{slug}/info`.
- `createBackup({name,password,full})` → full: `POST /backups/new/full`;
  partial: `POST /backups/new/partial` with `homeassistant:true`. `compressed:
  true`, `background: false`. Returns the slug.
- `downloadBackup(slug, dest)` → streams `GET /backups/{slug}/download` to a file.
- `uploadBackup(src)` → multipart `POST /backups/new/upload` (field `file`).
- `restoreBackup(slug, password)` → `POST /backups/{slug}/restore/full`.
- `deleteBackup(slug)` → `DELETE /backups/{slug}`.

---

## 8. Ingress web UI (`ingress.mjs`)

Unauthenticated `node:http` server (HA ingress provides auth). Serves one
self-contained HTML page plus JSON endpoints. Endpoints:

- `GET /` — the page.
- `GET /api/status` — connection state (via `cli.isConnected()`), the current
  sign-in URL if a login is in progress, schedule summary, last/next sync,
  `lastError`, log level, and the list of our Proton backups.
- `POST /api/connect` — starts `cli.login` in the **background**. The sign-in URL
  surfaces via `/api/status` (`loginUrl`) as soon as the CLI prints it; on
  success the state flips to connected and a post-login `runSync` kicks off.
- `POST /api/disconnect` — `cli.logout()` and clear the UI login state.
- `POST /api/backup-now` — fire `orchestrator.runSync()` (doesn't block on
  completion).
- `POST /api/restore` — `orchestrator.restoreToHA(body.name)`.
- `POST /api/delete` — `orchestrator.deleteProtonBackup(body.name)`.
- `GET`/`POST /api/log-level` — read/set the runtime log level.

The page polls `/api/status` every 5 s and renders Connect/Connected cards, a
status card, a "Back up now" button, and a table of Proton backups with
Restore/Delete actions.

---

## 9. Build & tests

There is **no build step and no bundler** — Node runs `src/*.mjs` directly, and
the app has **no runtime npm dependencies** (`package.json` declares only the
`start`/`test` scripts and `type: module`).

- `npm start` → `node src/main.mjs`.
- `npm test` → `node --test` (Node's built-in test runner).

Tests exercise the **real** code paths, not mocks:
- `test/orchestrator.test.mjs` — the pure decision/identity functions (§6), the
  highest-risk part of the filename-based design.
- `test/protonCli.test.mjs` — points `PROTON_DRIVE_BIN` at
  `test/fixtures/fake-proton-drive.mjs` (a tiny Node script whose behaviour is
  driven by `FAKE_*` env vars) so the real spawn/parse code runs: nonzero-exit
  handling, timeout → 124, `isConnected`, `login` URL capture, the defensive
  `list` JSON parsing, and upload/download/trash throw-on-failure.

Manual smoke test (no real Proton calls — `isConnected()` fails fast, sync skips):

```bash
PORT=8123 DATA_DIR=/tmp/x BACKUP_INTERVAL_HOURS=0 LOG_LEVEL=debug node src/main.mjs
```

---

## 10. Configuration, versioning & deploy

### Config plumbing
`config.yaml` `options:`/`schema:` → `run.sh` (bashio) exports each as an env var
→ code reads `process.env`. To add an option you touch **four** places:
`config.yaml` (both `options` and `schema`), `run.sh` (export, guarding optional
values with `bashio::config.has_value` to avoid the literal string `null`), and
the reader (`main.mjs` / `orchestrator.mjs`). `ingress_port: 8099` in
`config.yaml` must equal `export PORT=8099` in `run.sh`.

Env vars: `DRIVE_FOLDER`, `BACKUP_INTERVAL_HOURS`, `BACKUPS_IN_PROTON`,
`BACKUPS_IN_HA`, `FULL_BACKUP`, `BACKUP_PASSWORD`, `LOG_LEVEL`, plus `PORT`,
`DATA_DIR`, `SUPERVISOR_TOKEN` (HA-provided), and the CLI's
`PROTON_DRIVE_CREDENTIALS_STORE` / `XDG_DATA_HOME` / `PROTON_DRIVE_BIN`
(set in `run.sh`).

### Versioning
The version lives in exactly one place: `proton_drive_backup/config.yaml`'s
`version:` field. `package.json` has no `version`; the `Dockerfile` has no
version LABEL. To release: edit `config.yaml`'s `version:`, add a `CHANGELOG.md`
entry, commit, push.

⚠️ **HA only offers an update when the version increases.** Going *backwards*
means HA won't show an update — the user must uninstall/reinstall or use
**Rebuild**. Always bump *up*.

### Deploy
`Dockerfile`: `FROM ghcr.io/home-assistant/base:3.21` (explicit — the
`BUILD_FROM` arg is no longer auto-provided by recent Supervisor versions),
`apk add nodejs`, then **download the pinned `proton-drive` binary** for the
`BUILD_ARCH` (`amd64` → `linux-x64-musl`, `aarch64` → `linux-arm64-musl`) and
verify it with `sha256sum -c` (any other arch fails the build explicitly). Copy
`src/`, then `CMD ["/run.sh"]` → `node /app/src/main.mjs`. There is no
`npm install` / build in the image. LF endings are enforced by `.gitattributes`
(CRLF would break the `#!/usr/bin/with-contenv bashio` shebang).

Push is over HTTPS to `github.com/nicandris/ha-addon-proton-drive-backup`.

---

## 11. Known limitations & gotchas

- **CLI is early (`proton-drive` v0.6.0, pinned).** Pinned by URL + SHA-256 in
  the Dockerfile. Bumping the CLI means updating both the URL and the hashes for
  each arch.
- **`filesystem list --json` shape unverified.** The exact JSON the CLI emits
  hasn't been confirmed against a real account, so `list()` parses defensively
  and logs the raw output at debug level. Lock the parser down once the shape is
  known.
- **Long-running session refresh unconfirmed.** Whether the CLI refreshes its
  session cleanly in a very long-lived container isn't yet verified. If the
  session expires, the user re-runs **Connect** (`auth login`).
- **Failure detection must stay exit-code-based**, never JSON (§5).
- **"Back up now" with automatic backups disabled** (`BACKUP_INTERVAL_HOURS=0`)
  is upload-only: `runSync` syncs/prunes existing backups but does not *create* a
  new HA backup. (Candidate improvement: an explicit "create" flag from
  `/api/backup-now`.)
- **Line endings must be LF** (`run.sh` shebang); enforced by `.gitattributes`.
- **Session token at rest.** The CLI session lives in `/data`
  (`unsafe_file` store) as a plain file — no OS keyring in the container. Backups
  are E2E-encrypted client-side and no Proton password is stored, but don't
  overstate the at-rest posture in user docs.

---

## 12. Troubleshooting quick map

| Symptom | Meaning / action |
| --- | --- |
| Status `disconnected` / `needsLogin` | No usable CLI session. Click **Connect to Proton Drive** and complete the browser sign-in. |
| `Connect` shows a URL but never connects | Open the URL on any device and finish Proton sign-in; the page flips to Connected automatically. Sign-in times out after 5 min → click Connect again. |
| `Sync failed: ... name.startsWith is not a function` | A `list` entry had a non-string `name`. Guarded now (`isOurRemoteFile`/`list` coerce); if it recurs, inspect the debug-logged raw `list` JSON. |
| Second backup rejected with `system is not running - freeze` | Two syncs overlapped. The `syncing` guard prevents this; check for a code path bypassing `runSync`. |
| `upload/download/trash ... failed: <stderr>` | The CLI returned nonzero. The stderr text is surfaced in `lastError`; check quota/connectivity/session. |
| Docker build: `unsupported arch` | Only `amd64`/`aarch64` have a CLI build; the app can't run on `armv7`/`i386`. |
| App won't pick up a new version | Version didn't increase, or use **Rebuild** (§10). |
