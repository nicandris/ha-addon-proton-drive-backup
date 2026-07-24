# Developer guide

Deep reference for working on this project. `CLAUDE.md` is the short version
loaded into every Claude session; this file is the long form. User-facing docs
are `README.md` (repo root) and `proton_drive_backup/{README,DOCS,CHANGELOG}.md`.

---

## 1. What this is

A **Home Assistant app** (the term HA uses since 2026.2; technically still an
"add-on") that **mirrors Home Assistant's own backups to Proton Drive** (like the
Google Drive backup add-on). It does **not** create backups — it uploads whatever
backups already exist in HA (automatic + manual). It is a single self-contained
Node.js process shipped as a Docker container the HA Supervisor runs. It talks
to:

- the **Supervisor backup API** (to list/download/upload/restore/delete Home
  Assistant backups — it never *creates* them), and
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
  │                         staging (temp .tar) — OUTSIDE /data:     │
  │                           $STAGING_DIR, else the container tmp   │
  └───────────────────────────────────────────────────────────────┘
```

**Backup (sync) flow** (`orchestrator.runSync(force)`):
1. `ensureSession()` — probe `cli.isConnected()` to confirm we're signed in
   (see §5). If not, set `needsLogin`, record a friendly `lastError`, and stop —
   the UI drives sign-in; sync never auto-logs-in.
2. `syncBackupsToProton()` — list **all** HA backups (automatic + manual) + the
   Drive folder's contents; dedup by the HA backup **slug** (parsed out of each
   Proton filename). For any HA backup whose slug isn't already in Proton,
   download it from the Supervisor to the **staging dir** (`tmpDir()` — see §6:
   `STAGING_DIR` or the container's tmp dir, deliberately **outside `/data`**)
   under its final `<name> (<slug>).tar`, upload it, then delete the temp file. A
   backup that HA lists but `404`s on download (a stale/phantom entry) is
   **skipped** with a warning, not treated as a hard error.
3. `pruneProton()` — trash mirrored backups beyond retention, enforced in **two
   independent buckets** (automatic vs app, classified by `isAutomaticBackup(name)`):
   `keep_automatic_in_proton` and `keep_app_in_proton`, oldest by date first
   within each bucket (from the Proton entry's `date`). `selectProtonToPrune(entries,
   keepAutomatic, keepApp)` is the pure decision fn; `keep<=0` for a bucket keeps
   all of it, so an app-backup burst can never evict the automatic bucket.

There is **no HA-side pruning in the sync path.** Deleting local backups happens
only via `pruneHALocalNow()` (the manual **Clean up local backups** button, §8),
which never deletes a backup that isn't already mirrored in Proton — the safety
invariant holds independently in each bucket (`selectHALocalToPrune(haBackups,
protonSlugs, keepAutomatic, keepApp)`). `force` is
accepted for API symmetry (the "Sync now" button passes `true`); since the app no
longer creates backups there is no due-time gate to override.

While a sync runs, `orchestrator` publishes a live `activity` string and
`progress` `{index,total}` (via `setActivity`) that surface through
`/api/status` and drive the Web UI's Syncing… badge and progress bar (§8).

**Restore flow** (`orchestrator.restoreToHA(remoteName)`): download the archive
from Proton into the staging dir (`tmpDir()`, outside `/data`), upload it to the
Supervisor, then trigger a full restore.

Backup archives are never streamed through a third party — they go
Supervisor → this container → Proton (and back for restore), all in-process.

**Everything is matched by filename.** The CLI has **no metadata API**, so the
app derives identity from the name: the remote file is
`<sanitizedName> (<slug>).tar`, where `slug` is the HA backup's stable, unique
id. Dedup parses that slug back out (`slugFromRemoteName`); retention sorts by
each Proton entry's `date` (from `modificationTime`/`creationTime`), since the
names are no longer timestamp-sortable.

---

## 4. Module reference

| File | Responsibility |
| --- | --- |
| `main.mjs` | Boot: import `logger.mjs` first (patches `console`), read config from env, start ingress, run an initial sync ~5s after start, schedule recurring syncs if `BACKUP_INTERVAL_HOURS > 0`, handle SIGTERM/SIGINT. No crypto/login setup — the CLI owns auth. (It still `mkdir`s a legacy `/data/tmp`, but the actual archive staging is `orchestrator.tmpDir()`, **outside `/data`** — §6.) |
| `protonCli.mjs` | Thin wrapper around the `proton-drive` binary. See §5. |
| `orchestrator.mjs` | `runSync(force)`, `restoreToHA`, `deleteProtonBackup`, `listProtonBackups`, `pruneHALocalNow` (manual HA clean-up), `ensureSession`, `getStatus`/`setActivity` live-status state, and the **pure decision functions** (§6). Resilient: per-backup errors are caught into `state.lastError`; `runSync` never throws out. A `syncing` guard prevents overlapping syncs; staging is outside `/data`; a download `404` is skipped (`isNotFoundError`). `describeError` surfaces `err.cause`. |
| `supervisor.mjs` | HA Supervisor backup API client (`http://supervisor`, `SUPERVISOR_TOKEN`). §7. |
| `ingress.mjs` | `node:http` server: self-contained HTML UI + JSON API. §8. |
| `logger.mjs` | Patches `console.{log,debug,warn,error}` once on import to add ISO timestamps and level filtering (`error`/`warning`/`info`/`debug`). `setLogLevel`/`getLogLevel` allow changing the level at runtime from the UI. |

---

## 5. The CLI wrapper (`protonCli.mjs`) — where the sharp edges are

The `proton-drive` CLI owns **authentication and all Drive I/O**. This module
only spawns the binary and interprets its output. (`list` also surfaces each
entry's `date` — `modificationTime`, else `creationTime`, both plain ISO strings —
which Proton retention sorts by.)

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
- `list(remotePath)` — `filesystem list <path> -j`. Returns
  `[{name, type?, uid?, size?, date?}]` (`date` = `modificationTime` else
  `creationTime`, plain ISO strings). **The CLI's `list -j` schema (the sharp
  edge — fixed in 0.2.4):**
  - The top level is a **bare JSON array** of `NodeEntity` objects (there is no
    wrapping object). The parser still tolerates a wrapping object with a nested
    array under `items`/`entries`/`data`/`children` (or the first array value
    found), for resilience across CLI releases.
  - Each entry's **`name` is a `Result` object** — `{ ok: true, value: "<file>.tar" }`
    — **not a plain string.** The parser reads `name.value` (and still tolerates
    a bare string or a capitalised `Name`/`fileName`). Missing this was the root
    cause of both "No backups in Proton Drive" (nothing matched → blind dedup →
    duplicate re-uploads) and the earlier `name.startsWith is not a function`
    crash.
  - **Size** lives at `activeRevision.value.claimedSize` (where `activeRevision`
    is itself a `Result`); it is absent for folders. Falls back to a flat
    `size`/`Size` if present.
  - **`type`** is a lowercase string enum (`file` / `folder`).
  - Returns `[]` on any nonzero exit or parse failure, and drops nameless
    entries. The raw output (truncated) is still logged at debug level.
- `uploadFile(local, remoteParent, {conflictStrategy})` — `filesystem upload
  -c <strategy> <local> <remoteParent>`, no timeout; throws with stderr on
  failure. Default strategy `replace`. (The upload derives the remote name from
  the local basename, so the orchestrator stages the temp file under its final
  `<name> (<slug>).tar`.)
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
  scheduler, post-login, and "Sync now"). A module-level `syncing` flag makes a
  second concurrent trigger skip — overlapping runs race on retention and
  re-upload the same backup.
- **Staging outside `/data`.** `tmpDir()` returns `process.env.STAGING_DIR` or
  `join(os.tmpdir(), 'proton-drive-backup')` — deliberately **not** under
  `/data`. HA full-backups include the add-on's `/data` volume, so a temp `.tar`
  staged there gets swallowed into the next backup (observed: a 4.87 GB backup
  ballooning to 9.74 GB). The container tmp dir is ephemeral and never part of an
  HA backup. Both `syncBackupsToProton` and `restoreToHA` stage here.
- **Download-404 skip.** `supervisor.downloadBackup` attaches the HTTP `status`
  to its error; `isNotFoundError(err)` (`err.status === 404`) marks a backup HA
  lists but no longer serves (stale/phantom). `syncBackupsToProton` **skips** it
  with a warning (counted as `skipped`) instead of writing a hard `lastError`
  that would dominate the UI on every sync.
- **Live status.** `setActivity(activity, progress?)` updates `state.activity`
  (a human step like `Uploading 2 of 3: <name>`) and `state.progress`
  (`{index,total}`); `getStatus()` returns those plus `syncing`, `lastSync`,
  `lastError`, `nextSyncEpoch`, `needsLogin`. `runSync` clears them (`null`) in
  its `finally`. The UI (§8) renders them.
- **Pure decision functions** (no I/O, unit-tested in
  `test/orchestrator.test.mjs`):
  - `selectToUpload(haBackups, remoteEntries)` — **all** HA backups (automatic +
    manual) whose slug isn't already present in Proton (dedup by slug; the slug
    set is parsed from the Proton filenames via `slugFromRemoteName`).
  - `isAutomaticBackup(name)` — `/^Automatic backup/i.test(name)`; splits backups
    into the **automatic** bucket (HA's scheduled full backups) vs the **app**
    bucket (per-add-on backups, manual snapshots). Works on both an HA backup
    `name` and a Proton remote filename (the trailing ` (slug).tar` can't affect a
    `^`-anchored match; `sanitizeName` preserves the leading text).
  - `selectProtonToPrune(entries, keepAutomatic, keepApp)` — partitions the `.tar`
    entries into the two buckets by `isAutomaticBackup`; within each, sorts by the
    Proton entry's `date` (newest kept) and returns everything beyond that bucket's
    keep. `keep <= 0` for a bucket = keep all of it, so an app-backup burst can
    never evict the automatic bucket.
  - `selectHALocalToPrune(haBackups, protonSlugs, keepAutomatic, keepApp)` — same
    two-bucket partition; per bucket, HA backups beyond the newest `keep`, oldest
    first by `date`, **filtered to slugs confirmed present in `protonSlugs`**.
    `keep <= 0` for a bucket = delete nothing there. **SAFETY: it can never return
    a slug that isn't in `protonSlugs`, in either bucket** — an un-mirrored backup
    is never selected for deletion, no matter its age. Accepts a `Set` or array.
  - `getConfig()` — the effective config for the UI Settings card; the backup
    password is **never** exposed, only `backupPasswordSet: boolean`.
  - Helpers `isOurRemoteFile` (now just `name.endsWith('.tar')`) / `sanitizeName`
    / `remoteNameFor` / `slugFromRemoteName` are type-guarded (a non-string
    `name` must not crash — regression covered by tests).
- `pruneHALocalNow()` wraps `selectHALocalToPrune` with I/O: it lists both sides,
  deletes the selected slugs, and returns `{deleted, skippedNotInProton}` (the
  skipped count = per-bucket candidates beyond `keep` that aren't yet in Proton).
  It is **manual only** (the "Clean up local backups" button) and never runs in a
  sync.
- Proton retention runs automatically each sync; **HA-local deletion is manual
  and only ever removes backups already mirrored to Proton.**

---

## 7. Supervisor API (`supervisor.mjs`)

Base `http://supervisor`, bearer `SUPERVISOR_TOKEN`. Every response is
`{result:'ok'|'error', data, message}` — we check `result` and unwrap `data`.
Granted `hassio_api: true` + `hassio_role: manager` in `config.yaml`.

- `listBackups` → `GET /backups` (`data.backups`) — all HA backups, each with a
  `slug`, `name`, `date`, and `size` (MB).
- `getBackupInfo(slug)` → `GET /backups/{slug}/info`.
- `hostInfo()` → `GET /host/info` (disk stats for the UI).
- `downloadBackup(slug, dest)` → streams `GET /backups/{slug}/download` to a file.
- `uploadBackup(src)` → multipart `POST /backups/new/upload` (field `file`).
- `restoreBackup(slug, password)` → `POST /backups/{slug}/restore/full`.
- `deleteBackup(slug)` → `DELETE /backups/{slug}`.

---

## 8. Ingress web UI (`ingress.mjs`)

Unauthenticated `node:http` server (HA ingress provides auth). Serves one
self-contained HTML page plus JSON endpoints. Endpoints:

- `GET /` — the page.
- `GET /api/status` — connection state (via `cli.isConnected()`), a `status`
  label (`connected`/`awaiting sign-in`/`disconnected`), the current sign-in URL
  if a login is in progress, schedule summary, last/next sync, `lastError`, log
  level, the list of our Proton backups, **and the live-sync fields from
  `orchestrator.getStatus()`**: `syncing` (bool), `activity` (current step
  string), and `progress` (`{index,total}`).
- `POST /api/connect` — starts `cli.login` in the **background**. The sign-in URL
  surfaces via `/api/status` (`loginUrl`) as soon as the CLI prints it; on
  success the state flips to connected and a post-login `runSync` kicks off.
- `POST /api/disconnect` — `cli.logout()` and clear the UI login state.
- `POST /api/sync-now` — fire `orchestrator.runSync(true)` (doesn't block on
  completion). Uploads existing HA backups not yet in Proton.
- `POST /api/prune-ha` — `await orchestrator.pruneHALocalNow()`; returns
  `{ok, deleted, skippedNotInProton}` (awaited so the UI can report the result).
- `POST /api/restore` — `orchestrator.restoreToHA(body.name)`.
- `POST /api/delete` — `orchestrator.deleteProtonBackup(body.name)`.
- `GET`/`POST /api/log-level` — read/set the runtime log level.

`/api/status` also carries `settings` (`orchestrator.getConfig()` — the effective
config with the password exposed only as the boolean `backupPasswordSet`) so the UI
can render the read-only **Settings** card and disable **Clean up local backups**
(and word the confirm) when **both** `keepAutomaticInHA` and `keepAppInHA` are 0.
It also carries `stats` (mirror model: `haCount`/`haSizeBytes` = all HA backups;
`protonCount`/`protonSizeBytes` = mirrored; plus per-bucket
`haAutomaticCount`/`haAppCount` and `protonAutomaticCount`/`protonAppCount`).

The page polls `/api/status` every 5 s. The **status**, **statistics**, and
**settings** cards sit in a responsive `.grid` (two columns ≥720px, one below); the
rest of the page is the Connect/Connected cards, a **Sync now** + **Clean up local
backups** card,
and a table of Proton backups (sorted by `date`) with Restore/Delete actions. The
status card shows a connection badge plus a live **Syncing…** badge (animated
spinner + the `activity` step) and a progress bar (determinate from `progress`,
else indeterminate) whenever `syncing` is true; "Sync now" is disabled and
relabelled "Syncing…" while a sync runs. Dark mode is via `prefers-color-scheme`.

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

Env vars: `DRIVE_FOLDER`, `BACKUP_INTERVAL_HOURS`, `KEEP_AUTOMATIC_IN_PROTON`,
`KEEP_APP_IN_PROTON`, `KEEP_AUTOMATIC_IN_HA`, `KEEP_APP_IN_HA`,
`BACKUP_PASSWORD`, `LOG_LEVEL`, plus `PORT`,
`DATA_DIR`, `SUPERVISOR_TOKEN` (HA-provided), and the CLI's
`PROTON_DRIVE_CREDENTIALS_STORE` / `XDG_DATA_HOME` / `PROTON_DRIVE_BIN`
(set in `run.sh`). `STAGING_DIR` is an **optional** override (not a `config.yaml`
option and not exported by `run.sh`) read directly by `orchestrator.tmpDir()` —
it relocates the temp-`.tar` staging dir (§6); unset, it defaults to the
container tmp dir.

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
- **`filesystem list --json` schema (fixed in 0.2.4).** The CLI emits a bare
  array of `NodeEntity` objects whose `name` is a `Result` (`{ok, value}`), not a
  string, with size at `activeRevision.value.claimedSize` and a lowercase
  `type` enum (`file`/`folder`). `list()` reads those (see §5) and still parses
  defensively + logs the raw output at debug level, since the CLI is early and
  the shape may still shift between releases.
- **Staging must stay outside `/data`.** HA full-backups include the add-on's
  `/data`; staging temp `.tar` files there let a backup swallow them. `tmpDir()`
  stages in `STAGING_DIR` or the container tmp dir instead — don't move staging
  back under `/data`. (Note `main.mjs` still creates a now-unused `/data/tmp`.)
- **Long-running session refresh unconfirmed.** Whether the CLI refreshes its
  session cleanly in a very long-lived container isn't yet verified. If the
  session expires, the user re-runs **Connect** (`auth login`).
- **Failure detection must stay exit-code-based**, never JSON (§5).
- **The app never creates backups** (mirror model, 0.3.0). `runSync` only uploads
  existing HA backups and prunes Proton; make backups in Home Assistant itself.
  `BACKUP_INTERVAL_HOURS` is just how often to *check* for new ones to upload.
- **HA-local deletion is manual and safety-gated.** Only `pruneHALocalNow` (the
  "Clean up local backups" button) deletes local backups, and only ones already
  in Proton — `selectHALocalToPrune` can never return an un-mirrored slug. Don't
  wire it into the automatic sync path.
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
| `Sync failed: ... name.startsWith is not a function` | A `list` entry's `name` was a `Result` object, not a string. Fixed in 0.2.4 (`list` reads `name.value`; §5); if it recurs, inspect the debug-logged raw `list` JSON. |
| UI shows "No backups in Proton Drive" although backups exist / duplicates re-upload each sync | Same 0.2.4 root cause: the parser wasn't reading the `Result`-wrapped `name`, so nothing matched `isOurRemoteFile` and dedup was blind. Fixed in `list` (§5). |
| Second backup rejected with `system is not running - freeze` | Two syncs overlapped. The `syncing` guard prevents this; check for a code path bypassing `runSync`. |
| Log warns "HA no longer serves this backup (404)" every sync | HA lists a backup it can't serve (stale/phantom). `syncBackupsToProton` skips it (`isNotFoundError`); delete the entry in HA to silence it. |
| An HA backup roughly doubled in size | A temp `.tar` was staged under `/data` and got included in a backup. Staging is now outside `/data` via `tmpDir()`; ensure `STAGING_DIR` (if set) isn't inside any backup. |
| `upload/download/trash ... failed: <stderr>` | The CLI returned nonzero. The stderr text is surfaced in `lastError`; check quota/connectivity/session. |
| Docker build: `unsupported arch` | Only `amd64`/`aarch64` have a CLI build; the app can't run on `armv7`/`i386`. |
| App won't pick up a new version | Version didn't increase, or use **Rebuild** (§10). |
