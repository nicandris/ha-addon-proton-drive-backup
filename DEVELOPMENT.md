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
    icon.png                         ← store art (no logo.png: HA falls back to the icon)
    translations/en.yaml             ← option names/descriptions for the Configuration tab
    README.md / DOCS.md / CHANGELOG.md
    src/                             ← source, run directly (no build step)
      main.mjs
      protonCli.mjs
      orchestrator.mjs
      supervisor.mjs
      ingress.mjs
      ui.html                        ← the Web UI page (HTML + inline script)
      logger.mjs
    test/                            ← node:test tests
      orchestrator.test.mjs          ← pure decision functions
      orchestratorFlows.test.mjs     ← sync/prune/restore/scheduling flows (module mocks)
      protonCli.test.mjs
      supervisor.test.mjs            ← against a local node:http fixture server
      ingressApi.test.mjs            ← the JSON API over real HTTP
      ingressPage.test.mjs           ← the page's script parses; backup_exclude works
      logger.test.mjs                ← config.yaml <-> log-level contract
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
  │                           proton-drive-cli/  (CLI session —     │
  │                             excluded from HA backups)           │
  │                           backup-dates.json  (slug → HA date)   │
  │                         staging (temp .tar) — OUTSIDE /data:     │
  │                           $STAGING_DIR, else the container tmp   │
  └───────────────────────────────────────────────────────────────┘
```

**Scheduling** (`orchestrator.scheduleNextSync`): one chained `setTimeout` —
`main` arms it for 5 s after boot, and every sync re-arms it
`backup_interval_hours` after it *finished* (nothing when that is 0). The delay is
clamped to setTimeout's 2^31−1 ms limit (596 h; deliberately NOT a schema cap —
that would stop an existing install with a larger value from starting),
and a panel change of the interval re-arms it at once.

**Backup (sync) flow** (`orchestrator.runSync()`, under the operation lock):
1. `ensureSession()` — probe `cli.isConnected()` to confirm we're signed in
   (see §5). If not, set `needsLogin`, record a friendly `lastError`, and stop —
   the UI drives sign-in; sync never auto-logs-in.
2. `syncBackupsToProton()` — list **all** HA backups (automatic + manual) + the
   Drive folder's contents (**`cli.listStrict`** — a failed listing must abort, not
   read as "empty"); dedup by the HA backup **slug** (parsed out of each Proton
   filename) **and by size** (`mirroredSlugs`, so a truncated remote copy is
   re-uploaded). Each item carries `sizeBytes`, and a `statfs` free-space check
   precedes the download. Backups retention would prune straight away are
   dropped first (`selectUploadsWithinRetention` — otherwise they were uploaded and
   trashed again every sync). For any remaining HA backup not already in Proton,
   download it from the Supervisor to the **staging dir** (`tmpDir()` — see §6:
   `STAGING_DIR` or the container's tmp dir, deliberately **outside `/data`**)
   under its final `<name> (<slug>).tar`, upload it, then delete the temp file. A
   backup that HA lists but `404`s on download (a stale/phantom entry) is
   **skipped** with a warning, not treated as a hard error.
3. `pruneProton()` — trash mirrored backups beyond retention, enforced in **two
   independent buckets** (automatic vs app, classified by `isAutomaticBackup(name)`):
   `keep_automatic_in_proton` and `keep_app_in_proton`, oldest by date first
   within each bucket. Dates are the HA backup's (`withResolvedDates`: live HA
   listing, else `/data/backup-dates.json`, only then the Proton upload time), and
   copies that fail size verification don't count (`retentionEntries`).
   `selectProtonToPrune(entries, keepAutomatic, keepApp)` is the pure decision fn;
   `keep<=0` for a bucket keeps all of it, so an app-backup burst can never evict
   the automatic bucket. A failed HA listing aborts the prune.
4. `lastSync` is set only if steps 2–3 had **no** errors, and a Home Assistant
   persistent notification is raised (failure / `needsLogin`) or dismissed
   (`updateAlert`, via the Core API — `homeassistant_api: true`).

There is **no HA-side pruning in the sync path.** Deleting local backups happens
only via `pruneHALocalNow()` (the manual **Clean up local backups** button, §8),
which never deletes a backup that isn't already mirrored in Proton — the safety
invariant holds independently in each bucket (`planHALocalPrune(haBackups,
protonSlugs, keepAutomatic, keepApp).toDelete`).

While a sync runs, `orchestrator` publishes a live `activity` string and
`progress` `{index,total}` (via `setActivity`) that surface through
`/api/status` and drive the Web UI's Syncing… badge and progress bar (§8).

**Restore flow** (`orchestrator.restoreToHA(remoteName)`): validate the name
(`isValidRemoteName` — path-traversal guard), take the **same operation lock as a
sync**, remove any same-named leftover staging file, then download the archive from Proton into the staging dir (`tmpDir()`,
outside `/data`), stream it to the Supervisor, and trigger a full restore —
publishing `activity` at each step and clearing the lock in `finally`.
`POST /api/restore` is **fire-and-forget**: it answers immediately (409 if the
lock is taken) and the UI follows progress/errors via `/api/status`.

Backup archives are never streamed through a third party — they go
Supervisor → this container → Proton (and back for restore), all in-process.

**Everything is matched by filename + size.** The CLI has **no metadata API**, so the
app derives identity from the name: the remote file is
`<sanitizedName> (<slug>).tar`, where `slug` is the HA backup's stable, unique
id. A name match alone is **not** proof of a good copy — `mirroredSlugs` also
requires the remote size to match the HA backup's size (§6). Dedup parses that slug back out (`slugFromRemoteName`); retention sorts by
the HA backup's date (see step 3), since the names aren't timestamp-sortable.

---

## 4. Module reference

| File | Responsibility |
| --- | --- |
| `main.mjs` | Boot: import `logger.mjs` first (patches `console`), read config **only** via `orchestrator.getRuntimeConfig()` (single source; never carries the backup password), `cleanStagingDir()` to reclaim archives left by a stop mid-transfer, start ingress, arm the scheduler (`scheduleNextSync(5000)`), handle SIGTERM/SIGINT. No crypto/login setup — the CLI owns auth. The legacy `/data/tmp` mkdir was removed in 0.4.1; staging is `orchestrator.tmpDir()`, **outside `/data`** (§6). |
| `protonCli.mjs` | Thin wrapper around the `proton-drive` binary. See §5. |
| `orchestrator.mjs` | `runSync`, `createBackupNow`, `restoreToHA`, `deleteProtonBackup`, `listProtonBackups`, `pruneHALocalNow` (manual HA clean-up), `scheduleNextSync`, `applySettings`, `ensureSession`, `getStatus`/`setActivity` live-status state, and the **pure decision functions** (§6). Resilient: per-backup errors are caught into `state.lastError`; `runSync` never throws out. Every operation runs under one lock (`exclusively`); staging is outside `/data`; a download `404` is skipped (`isNotFoundError`). `describeError` surfaces `err.cause`. |
| `supervisor.mjs` | HA Supervisor backup API client (`http://supervisor`, `SUPERVISOR_TOKEN`). §7. |
| `ingress.mjs` | `node:http` server: serves `ui.html` + the JSON API, to HA's ingress proxy only. §8. |
| `logger.mjs` | Patches `console.{log,debug,warn,error}` once on import to add ISO timestamps and level filtering (`error`/`warning`/`info`/`debug`). HA's extra `config.yaml` levels are aliased (`trace`→debug, `notice`→info, `fatal`→error). **`setLogLevel` never throws** (unknown → warning + `info`) since it runs at boot; `setLogLevelStrict` throws and is used only by `POST /api/log-level` (→ 400; that route also saves the level as the `log_level` option). `logLevels()` feeds the UI dropdown; `test/logger.test.mjs` asserts the `config.yaml` contract. |

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
  container (see §5 auth below). Since 0.4.1 the child gets a **filtered** env, not
  `process.env`: `PATH`, `HOME`, `TMPDIR`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, every
  `PROTON_DRIVE_*` (and `FAKE_*` for the test fixture) — so the third-party binary
  never sees `BACKUP_PASSWORD` or `SUPERVISOR_TOKEN`.

### `run(args, {timeoutMs, cwd})`
- Spawns the CLI and **never rejects on a nonzero exit** — it resolves
  `{code, stdout, stderr}` so callers decide what an error means. (It *does*
  reject on a spawn `error` — a missing/non-executable binary is a real failure.)
- `timeoutMs` defaults to 120 s; `<= 0` disables the timer. Uploads/downloads
  pass `TRANSFER_TIMEOUT_MS` (12 h) — finite, so a hung transfer can't hold the
  lock forever. On timeout the child is `SIGKILL`ed and the result is
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
  `{ok:false, error}` with the sign-in URL redacted. Default timeout 300 s.
- `logout()` — `auth logout` (drops the persisted session).
- `ensureFolder(remotePath)` — creates each missing segment under `/my-files`
  with `filesystem create-folder`, treating an "already exists"/conflict as
  success, then verifies with `filesystem info`. Returns the full remote path.
  (`isExistsConflict` is narrow on purpose: a bare `/exist/` match also matched
  "does **not** exist" / "no such file", turning a real failure into a silent
  success — fixed 0.4.1.)
- `list(remotePath)` — `filesystem list <path> -j`. Returns
  `[{name, type?, uid?, size?, date?}]` (`date` = `modificationTime` else
  `creationTime`, plain ISO strings). **The CLI's `list -j` schema (the sharp
  edge — fixed in 0.2.4):**
  - The top level is a **bare JSON array** of `NodeEntity` objects (there is no
    wrapping object). The **lenient** parser still tolerates a wrapping object
    with a nested array under `items`/`entries`/`data`/`children` (or the first
    array value found) and bare strings; **strict** mode accepts only the bare
    array of objects (0.5.0) — a guessed shape could read as a false-empty folder.
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
  - **Two failure modes (0.4.1).** Lenient (default) resolves `[]` on a nonzero
    exit / parse failure / unrecognisable shape — display only. **`listStrict(path)`
    (or `list(path,{strict:true})`) throws instead, and the sync + retention paths
    must use it**: treating a failed listing as an empty folder made
    `selectToUpload` re-upload every backup with `-f replace` (tens of GB) *and*
    reset every Proton `modificationTime`, which retention sorts by. Nameless
    entries are still dropped. Only the mapped fields (count + names/sizes) are
    logged — never Proton's raw `NodeEntity` payload, which carries node/revision
    ids and hashes (logs get pasted into public issues).
- `uploadFile(local, remoteParent, {conflictStrategy, timeoutMs})` — `filesystem upload
  -f <strategy> <local> <remoteParent>`, killed after `TRANSFER_TIMEOUT_MS` (12 h); throws with stderr on
  failure. Default strategy `replace`. (The upload derives the remote name from
  the local basename, so the orchestrator stages the temp file under its final
  `<name> (<slug>).tar`.)
- `downloadPath(remotePath, localFolder)` — `filesystem download` into a folder
  (keeps the remote filename), killed after `TRANSFER_TIMEOUT_MS`; throws on failure.
- `trash(remotePath)` — `filesystem trash`; throws on failure.
- `trashedUids(name)` / `deleteFromTrash(name, {keep})` — the trash is flat, so
  same-named nodes are addressed by UID. `removeRemote` records the UIDs already
  trashed under that name, trashes, then purges all **but** those — only the node
  it just trashed (`permanently_delete`).

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
- **One operation lock.** `exclusively(fn)` holds the module-level `syncing`
  flag for `runSync`, `createBackupNow`, `restoreToHA`, `deleteProtonBackup` and
  `pruneHALocalNow` — overlapping runs race on retention, re-upload the same
  backup or stage into the same tmp dir. A taken lock throws an error with
  `busy: true` (the routes answer 409); `runSync`/`createBackupNow` just skip.
- **Staging outside `/data`.** `tmpDir()` returns `process.env.STAGING_DIR` or
  `join(os.tmpdir(), 'proton-drive-backup')` — deliberately **not** under
  `/data`. HA full-backups include the add-on's `/data` volume, so a temp `.tar`
  staged there gets swallowed into the next backup (observed: a 4.87 GB backup
  ballooning to 9.74 GB). The container tmp dir is ephemeral and never part of an
  HA backup. Both `syncBackupsToProton` and `restoreToHA` stage here.
  `STAGING_DIR` is an **advanced env-only override** — no `config.yaml` option and
  nothing in `run.sh` (an add-on can only reach paths its manifest `map:`s), so the
  docs/UI say exactly that rather than implying it's configurable.
- **Staging housekeeping + free space (0.4.1).** SIGTERM `process.exit(0)`s
  immediately, so a stop mid-upload left a multi-GB `.tar` behind that survived
  restarts and accumulated. `cleanStagingDir()` (called from `main` at boot) unlinks
  stale `*.tar` and logs what it reclaimed, and `syncBackupsToProton` checks
  `statfs(tmpDir())` against the HA-reported size before each download, skipping that
  item with a clear `lastError` instead of filling the host disk.
- **Download-404 skip.** `supervisor.downloadBackup` attaches the HTTP `status`
  to its error; `isNotFoundError(err)` (`err.status === 404`) marks a backup HA
  lists but no longer serves (stale/phantom). `syncBackupsToProton` **skips** it
  with a warning (counted as `skipped`) instead of writing a hard `lastError`
  that would dominate the UI on every sync.
- **Live status.** `setActivity(activity, progress?)` updates `state.activity`
  (a human step like `Uploading 2 of 3: <name>`) and `state.progress`
  (`{index,total}`); `getStatus()` returns those plus `syncing`, `lastSync`,
  `lastError`, `nextSyncEpoch`, `needsLogin`. `exclusively` clears them (`null`)
  in its `finally`. The UI (§8) renders them.
- **Pure decision functions** (no I/O, unit-tested in
  `test/orchestrator.test.mjs`):
  - `mirroredSlugs(haBackups, remoteEntries, {tolerance})` — the slugs that are
    **verifiably** offsite: the Proton entry must exist *and* its size must match the
    HA backup's. **Units:** the Supervisor reports `size` in **MB**
    (`st_size/1048576`, 2 dp) plus `size_bytes` on recent versions; Proton reports
    bytes (`activeRevision.value.claimedSize`). `haBackupSizeBytes` normalises to
    bytes (`size_bytes` if present, else `size * 1048576`), so the only intrinsic
    error is HA's 2-dp rounding (±~5 KiB); `sizesMatch` allows
    64 KiB (HA's MB rounding; no relative slack since 0.5.0). A missing size on **either** side = NOT verified (fail
    closed: re-upload, never delete locally). Before 0.4.1 a filename match alone
    counted as mirrored, so an upload interrupted after the node appeared was both
    skipped by the next sync and accepted as grounds to delete the last local copy.
  - `selectToUpload(haBackups, remoteEntries)` — **all** HA backups (automatic +
    manual) not in `mirroredSlugs` (i.e. absent *or* size-mismatched). Items carry
    `{slug, name, remoteName, sizeBytes}`.
  - `isValidRemoteName(name)` — a bare `*.tar` filename: no `/` or `\\`, no control
    chars, not `.`/`..`, `basename(name) === name`, ≤255 chars. Enforced **inside**
    `deleteProtonBackup`/`restoreToHA` (and again in the routes, as a 400) because
    `body.name` is interpolated into a Drive path *and* a local staging path — a
    `../../` payload escaped both, and the restore `finally` `rm()` ran even on
    failure (arbitrary in-container file deletion).
  - `isAutomaticBackup(name)` — case-insensitive "starts with
    `automatic_name_prefix`" (default `Automatic backup`); splits backups
    into the **automatic** bucket (HA's scheduled full backups) vs the **app**
    bucket (per-add-on backups, manual snapshots). Works on both an HA backup
    `name` and a Proton remote filename (the trailing ` (slug).tar` can't affect a
    `^`-anchored match; `sanitizeName` preserves the leading text).
  - `selectProtonToPrune(entries, keepAutomatic, keepApp)` — partitions our
    `(slug).tar` entries into the two buckets by `isAutomaticBackup`; within each,
    sorts by `date` (newest kept) and returns everything beyond that bucket's keep.
    `keep <= 0` for a bucket = keep all of it, so an app-backup burst can never
    evict the automatic bucket. Undated entries are never pruned and take **no**
    keep slot (they used to, which trashed the just-uploaded backup).
  - `withResolvedDates(entries, haBackups, knownDates)` / `retentionEntries` /
    `selectUploadsWithinRetention` — the date resolution, the "unverified copies
    don't count" filter, and the "don't upload what would be pruned" filter (§3).
  - `planHALocalPrune(haBackups, protonSlugs, keepAutomatic, keepApp)` — same
    two-bucket partition; per bucket, HA backups beyond the newest `keep`, oldest
    first by `date` (an unparseable date sorts as newest), **`toDelete` filtered
    to slugs confirmed present in `protonSlugs`**.
    `keep <= 0` for a bucket = delete nothing there. **SAFETY: it can never return
    a slug that isn't in `protonSlugs`, in either bucket** — an un-mirrored backup
    is never selected for deletion, no matter its age. Accepts a `Set` or array.
    **Callers must pass `mirroredSlugs(...)` (size-verified)** — never a set built
    from filenames alone. Don't loosen either half of this pair.
  - `getConfig()` — the effective config for the UI Settings card; the backup
    password is **never** exposed, only `backupPasswordSet: boolean`.
    `getRuntimeConfig()` = that plus `logLevel`/`port`/`effectiveStagingDir`, and is
    the **only** config reader `main.mjs` uses (the duplicated `readConfig` there was
    removed in 0.4.1). Because it omits the password value, `main` can safely dump
    the whole object at debug level.
  - Helpers `isOurRemoteFile` (a `(slug).tar` name whose slug is a Supervisor
    slug — 8 lowercase hex, `sha1(...)[:8]` in `backups/utils.py` — or a slug we
    know from HA/`backup-dates.json`; the user's other `.tar` files, even
    `Holiday photos (2023).tar`, are not ours) / `sanitizeName`
    / `remoteNameFor` / `slugFromRemoteName` are type-guarded (a non-string
    `name` must not crash — regression covered by tests).
- `pruneHALocalNow()` wraps `planHALocalPrune` with I/O (under the lock): it lists
  both sides, deletes the selected slugs, and returns `{deleted, failed, skippedNotInProton}` (the
  skipped count = per-bucket candidates beyond `keep` that aren't yet in Proton).
  It is **manual only** (the "Clean up local backups" button) and never runs in a
  sync.
- Proton retention runs automatically each sync; **HA-local deletion is manual
  and only ever removes backups already mirrored to Proton.**

---

## 7. Supervisor API (`supervisor.mjs`)

Base `http://supervisor`, bearer `SUPERVISOR_TOKEN`. Every response is
`{result:'ok'|'error', data, message}` — we check `result` and unwrap `data`.
Granted `hassio_api: true` + `hassio_role: backup` in `config.yaml` (enough for
every call below — see "Deliberate decisions"), plus `homeassistant_api: true`
for the two Core service calls.

Base URL is `$SUPERVISOR_URL` if set (the tests point it at a local fixture
server), else `http://supervisor`. `unwrapEnvelope` is the single place that
decides what "failed" means, shared by both transports.

- `listBackups` → `GET /backups` (`data.backups`) — all HA backups, each with a
  `slug`, `name`, `date`, and `size` (**MB**, 2 dp; recent Supervisors also send
  `size_bytes`). `orchestrator.haBackupSizeBytes` normalises this (§6).
- `hostInfo()` → `GET /host/info` (disk stats for the UI).
- `createBackup({name, password})` → `POST /backups/new/full` with
  `background:false` — **over `node:http`** (see below). Returns the new slug.
- `downloadBackup(slug, dest)` → streams `GET /backups/{slug}/download` to a file.
- `uploadBackup(src)` → multipart `POST /backups/new/upload` (field `file`),
  **streamed** with hand-written framing: an earlier `readFile`/Blob version
  allocated the whole archive and got the add-on OOM-killed (3 GB file: 103 MB peak
  RSS now vs 3183 MB before).
- `restoreBackup(slug, password)` → `POST /backups/{slug}/restore/full` with
  `background:false` — **over `node:http`**.
- `deleteBackup(slug)` → `DELETE /backups/{slug}`.
- `selfInfo()` / `setSelfOptions(changes)` → `GET /addons/self/info`, then
  `POST /addons/self/options` with the change merged over the current options
  (the Supervisor replaces them wholesale). Always `self`, never the slug.
- `notify(id, title, message)` / `dismissNotification(id)` →
  `POST /core/api/services/persistent_notification/{create,dismiss}` (Core's own
  JSON, not the envelope — only the HTTP status counts).

**Why `node:http` for the two long calls.** Node's global `fetch` (undici) applies
a ~300 s **headers** timeout that can't be raised per request, and a
`background:false` backup/restore blocks until HA finishes. On a multi-GB instance
the call rejected with `UND_ERR_HEADERS_TIMEOUT` — the UI said "Backup creation
failed: fetch failed" for a backup HA had actually completed, and `createBackupNow`
skipped the mirror step. `node:http` has no default timeout, so the long calls
(and the restore upload) get a 6 h socket-idle one, `LONG_CALL_TIMEOUT_MS` — a
Supervisor that never answers must not hold the sync lock forever. Short calls keep using
`fetch`. (There is no `getBackupInfo` — it was unused and removed in 0.4.1.)

---

## 8. Ingress web UI (`ingress.mjs`)

`node:http` server with no auth of its own: HA ingress authenticates the user,
and the server answers **only** HA's ingress proxy (`172.30.32.2`, plus
loopback) — every other container on the hassio network gets 403
(`isAllowedClient`, 0.5.0). Request bodies are capped at 64 KiB (413). Serves
`src/ui.html` (read once; the dark palette is spliced in at its two
`/* DARK_PALETTE */` markers) plus JSON endpoints:

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
- `POST /api/sync-now` — fire `orchestrator.runSync()` (doesn't block on
  completion). Uploads existing HA backups not yet in Proton.
- `POST /api/prune-ha` — `await orchestrator.pruneHALocalNow()`; returns
  `{ok, deleted, failed, skippedNotInProton}` (awaited so the UI can report the
  result); 409 while another operation runs.
- `POST /api/restore` — validates `body.name` (`isValidRemoteName` → 400) then
  fires `orchestrator.restoreToHA(name)` **fire-and-forget** (a restore blocks for
  minutes; progress/errors surface via `/api/status`, like `/api/sync-now`); 409
  while another operation runs.
- `POST /api/delete` — same name validation, then
  `orchestrator.deleteProtonBackup(name)` (awaited; 409 while busy).
- `POST /api/settings` — `orchestrator.applySettings` (validated patch, saved via
  `setSelfOptions`, applied to `process.env`, scheduler re-armed if the interval
  changed).
- `POST /api/log-level` — set the runtime log level with `setLogLevelStrict`
  (garbage is a 400; boot stays non-throwing) and save it as the `log_level`
  option (best-effort, `persisted` in the reply).
- `POST /api/clear-error` — clear `lastError`/`errors` and the login error.

`/api/status` also carries `settings` (`orchestrator.getConfig()` — the effective
config with the password exposed only as the boolean `backupPasswordSet`) so the UI
can render the editable **Settings** card (folder, interval, the four keep-counts,
prefix, `permanently_delete`) and disable **Clean up local backups**
(and word the confirm) when **both** `keepAutomaticInHA` and `keepAppInHA` are 0.
It also carries `stats` (mirror model: `haCount`/`haSizeBytes` = all HA backups;
`protonCount`/`protonSizeBytes` = mirrored; plus per-bucket
`haAutomaticCount`/`haAppCount` and `protonAutomaticCount`/`protonAppCount`).

**`/api/status` is served from a 30 s TTL snapshot** (`getSnapshot` /
`buildSnapshot` / `invalidateSnapshot`): the expensive parts (`cli.isConnected()`,
the Proton listing, the Supervisor stats) used to run on **every** poll of **every**
open tab — two ~110 MB CLI spawns plus two Supervisor calls every 5 s, competing with
running uploads and risking Proton rate-limiting. In-flight polls are deduped, the
live `syncing`/`activity`/`progress`/`lastError` still come straight from memory,
and every action invalidates the cache. It also carries `logLevels` (the four
internal levels) for the dropdown.

**XSS: escape everything (0.4.1).** The page builds markup with `innerHTML`, and
backup names, `lastError` (raw CLI stderr) and exception text are all
attacker-influencable — a backup named `<img src=x onerror=…>` executed in the
ingress iframe on every poll. The page script has one `esc()` helper
(`&`/`<`/`>`/`"`/`'`) and **every** interpolation of server-provided text goes
through it. Keep that up when adding markup. `server.on('error')` logs
EADDRINUSE/EACCES clearly instead of dying with a bare stack.

The page polls adaptively — 5 s while syncing/awaiting sign-in, 20 s idle, 60 s when
the tab is hidden (plus an immediate refresh on `visibilitychange`). The **status**,
**statistics**, and
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
- `npm test` → `node --experimental-test-module-mocks --test` (Node's built-in
  test runner; the flag is for `orchestratorFlows.test.mjs`).

Tests exercise the **real** code paths; only `orchestratorFlows.test.mjs` swaps
`supervisor.mjs`/`protonCli.mjs` for in-memory doubles (`mock.module`) to drive
the sync/prune/restore/lock/scheduling flows (with `mock.timers`):
- `test/orchestrator.test.mjs` — the pure decision/identity functions (§6), the
  highest-risk part of the filename-based design: dedup, both retention buckets, the
  never-delete-an-un-mirrored-backup invariant, the size-verification helpers
  (`haBackupSizeBytes`/`sizesMatch`/`mirroredSlugs`) and `isValidRemoteName`
  against traversal payloads.
- `test/supervisor.test.mjs` — the Supervisor client against a real local
  `node:http` fixture server (via `SUPERVISOR_URL`): envelope unwrapping, the
  long-running `createBackup`/`restoreBackup` bodies, non-JSON responses, and the
  streamed `uploadBackup`. Note the fixture must **not** `JSON.parse` a multipart
  body, and `after()` must `globalAgent.destroy()` + `closeAllConnections()` or
  keep-alive sockets hang the run.
- `test/logger.test.mjs` — the `config.yaml` ↔ logger **contract**: every
  `log_level` the manifest advertises must be accepted without throwing (the 0.4.1
  boot crash-loop), aliases map correctly, and only the API path validates strictly.
- `test/protonCli.test.mjs` — points `PROTON_DRIVE_BIN` at
  `test/fixtures/fake-proton-drive.mjs` (a tiny Node script whose behaviour is
  driven by `FAKE_*` env vars) so the real spawn/parse code runs: nonzero-exit
  handling, timeout → 124, `isConnected`, `login` URL capture, the defensive
  `list` JSON parsing, and upload/download/trash throw-on-failure.
- `test/ingressApi.test.mjs` — the server on port 0 over real HTTP: routes,
  validation, the caller check, the body cap. `test/ingressPage.test.mjs` — the
  page's script compiles (`vm.Script`), the palette rules, and that
  `backup_exclude` really matches the Supervisor's path (a `PurePath.match`
  port).

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
the reader (`main.mjs` / `orchestrator.mjs`) — plus `translations/en.yaml`, and
`EDITABLE_SETTINGS` if the panel may change it. HA's default ingress port (8099;
`config.yaml` sets no `ingress_port`) must equal `export PORT=8099` in `run.sh`.

Env vars: `DRIVE_FOLDER`, `BACKUP_INTERVAL_HOURS`, `KEEP_AUTOMATIC_IN_PROTON`,
`KEEP_APP_IN_PROTON`, `KEEP_AUTOMATIC_IN_HA`, `KEEP_APP_IN_HA`,
`PERMANENTLY_DELETE`, `AUTOMATIC_NAME_PREFIX`, `BACKUP_PASSWORD`, `LOG_LEVEL`, plus `PORT`,
`DATA_DIR` (where `backup-dates.json` lives), `SUPERVISOR_TOKEN` (HA-provided), `SUPERVISOR_URL` (test override), and the CLI's
`PROTON_DRIVE_CREDENTIALS_STORE` / `XDG_DATA_HOME` / `PROTON_DRIVE_BIN`
(set in `run.sh`). `STAGING_DIR` is an **optional** override (not a `config.yaml`
option and not exported by `run.sh`) read directly by `orchestrator.tmpDir()` —
it relocates the temp-`.tar` staging dir (§6); unset, it defaults to the
container tmp dir.

### Versioning
The version lives in exactly one place: `proton_drive_backup/config.yaml`'s
`version:` field. `package.json` has no `version`; the `Dockerfile` has no
version LABEL. To release: edit `config.yaml`'s `version:`, add a `CHANGELOG.md`
entry (CI's `changelog` job fails a PR without one), merge. Once **CI is green**
on that main commit, `release.yml` (a `workflow_run` of CI) tags `v<version>`,
creates the release and pushes `ghcr.io/<owner>/{amd64,aarch64}-proton-drive-backup:<version>`.
`config.yaml`'s `image:` stays commented until those images exist and are public.

⚠️ **HA only offers an update when the version increases.** Going *backwards*
means HA won't show an update — the user must uninstall/reinstall or use
**Rebuild**. Always bump *up*.

### Deploy
`Dockerfile`: `FROM ghcr.io/home-assistant/base:3.24@sha256:…` (pinned by digest; explicit — the
`BUILD_FROM` arg is no longer auto-provided by recent Supervisor versions),
`apk add --no-cache 'nodejs~=24'` (**pin the Node major** — Alpine 3.23+ ships Node
24 and an unpinned `nodejs` would follow the base image to a new major; the suite is
verified on Node 24), then **download the pinned `proton-drive` binary** for the
`BUILD_ARCH` (`amd64` → `linux-x64-musl`, `aarch64` → `linux-arm64-musl`) and
verify it with `sha512sum -c` against **Proton's published** SHA-512 from
`https://proton.me/download/drive/cli/version.json` (any other arch fails the
build explicitly). A hash mismatch at an unchanged CLI version means Proton's
file changed under a published version — an incident to investigate, never a
hash to just update. Copy
`src/`, then `CMD ["/run.sh"]` → `node /app/src/main.mjs`. There is no
`npm install` / build in the image. LF endings are enforced by `.gitattributes`
(CRLF would break the `#!/usr/bin/with-contenv bashio` shebang).

Push is over HTTPS to `github.com/nicandris/ha-addon-proton-drive-backup`.

---

## 11. Known limitations & gotchas

- **CLI is early (`proton-drive` v0.9.0, pinned).** Pinned by URL + Proton's
  published SHA-512 in the Dockerfile. Bumping the CLI means updating both the
  URL and the hashes for each arch, copied from Proton's `version.json`.
- **`filesystem list --json` schema (fixed in 0.2.4).** The CLI emits a bare
  array of `NodeEntity` objects whose `name` is a `Result` (`{ok, value}`), not a
  string, with size at `activeRevision.value.claimedSize` and a lowercase
  `type` enum (`file`/`folder`). `list()` reads those (see §5) and still parses
  defensively, but logs only the mapped names/sizes — never the raw payload.
- **A failed listing must never read as "empty".** Use `listStrict` anywhere the
  result drives uploads or deletions; only display code may use lenient `list`.
- **Size-verify before trusting a remote copy.** `mirroredSlugs` is the only
  legitimate source for `planHALocalPrune`'s `protonSlugs`; a filename-only set
  reopens the data-loss path (§6).
- **The long Supervisor calls must not go through `fetch`** — undici's ~300 s
  headers timeout breaks multi-GB `background:false` backup/restore calls (§7).
- **`backup_exclude` is matched against the Supervisor's path**
  (`/data/addons/data/<slug>/…`) with `PurePath.match`, so its patterns must be
  relative. The 0.4.9 `/data/proton-drive-cli/*` never matched (fixed 0.5.0).
- **Escape all server-provided text in the ingress page** (`esc()`, §8).
- **Staging must stay outside `/data`.** HA full-backups include the add-on's
  `/data`; staging temp `.tar` files there let a backup swallow them. `tmpDir()`
  stages in `STAGING_DIR` or the container tmp dir instead — don't move staging
  back under `/data`. (The legacy `/data/tmp` mkdir was removed in 0.4.1.)
- **Long-running session refresh unconfirmed.** Whether the CLI refreshes its
  session cleanly in a very long-lived container isn't yet verified. If the
  session expires, the user re-runs **Connect** (`auth login`).
- **Failure detection must stay exit-code-based**, never JSON (§5).
- **The app never creates backups** (mirror model, 0.3.0). `runSync` only uploads
  existing HA backups and prunes Proton; make backups in Home Assistant itself.
  `BACKUP_INTERVAL_HOURS` is just how often to *check* for new ones to upload.
- **HA-local deletion is manual and safety-gated.** Only `pruneHALocalNow` (the
  "Clean up local backups" button) deletes local backups, and only ones already
  in Proton — `planHALocalPrune` can never return an un-mirrored slug. Don't
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
| Add-on crash-loops at start with an "Unknown log level" fatal | Pre-0.4.1 behaviour with `log_level: notice/trace/fatal`. `setLogLevel` now aliases + falls back to `info` (§4). |
| Every backup re-uploads each sync / Proton dates all reset | A lenient `list` returned `[]` on a CLI failure and dedup saw nothing mirrored. Sync/prune use `listStrict` since 0.4.1 (§5). |
| "Backup creation failed: fetch failed" but HA shows the backup | undici's 300 s headers timeout on `background:false`; those calls use `node:http` now (§7). |
| Staging dir grows / host disk fills | Archives left by a stop mid-transfer. `cleanStagingDir()` sweeps them at boot; a free-space check precedes each download (§6). |
| Web UI shows "Idle" during a restore | Pre-0.4.1: `restoreToHA` took no guard and published no activity (§3, §6). |

## Deliberate decisions (reviewed, not oversights)

### `hassio_role: backup` is enough — don't widen it to `manager`
Checked against the Supervisor's `api/middleware/security.py` (unchanged since at
least 2023.01): the `backup` role allows `/backups.*` and every `/.+/info` path,
and `/addons/self/<anything but security|update>` bypasses role checks for every
add-on.

| Endpoint | Allowed by |
| --- | --- |
| `GET /backups`, `POST /backups/new/full`, `GET /backups/{slug}/download`, `POST /backups/new/upload`, `DELETE /backups/{slug}`, `POST /backups/{slug}/restore/full` | `backup` role (`/backups.*`) |
| `GET /host/info`, `GET /addons/self/info` | `backup` role (`/.+/info`) |
| `POST /addons/self/options` | API bypass (`/addons/self/…`) |
| `POST /core/api/services/persistent_notification/*` | `homeassistant_api: true` (not a role) |

So never address the add-on by slug (`/addons/<slug>/…` needs `manager`; the
old `setSelfOptions` fallback did, and was removed in 0.5.0). Re-check this
table when adding a Supervisor call.

### The CLI timeout kills the process, not the process group
`protonCli.run()` uses `child.kill('SIGKILL')` on timeout. Killing a whole process
*group* would require spawning with `detached: true`, which makes the child survive
the add-on's own exit — trading a theoretical orphan for a guaranteed one on every
stop. `proton-drive` is a single statically-linked binary that doesn't fork worker
processes, so the group kill buys nothing here. Revisit only if the CLI starts
spawning children.

### `STAGING_DIR` is an env-only override, not a `config.yaml` option
An add-on cannot `map:` an arbitrary host path, so surfacing it in the HA UI would
only invite values that can't work. It stays an advanced escape hatch, and the
panel shows it read-only when set.
