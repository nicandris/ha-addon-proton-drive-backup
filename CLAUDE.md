# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **For the full reference, read [`DEVELOPMENT.md`](./DEVELOPMENT.md)** — module-by-module breakdown, the CLI integration and its sharp edges, the Supervisor API, build/versioning/deploy details, and a troubleshooting map. This file is the quick summary; `DEVELOPMENT.md` is the long form.

## What this is

A **Home Assistant add-on** (not a custom integration) that backs up Home Assistant to Proton Drive. It is a standalone Node.js app shipped as a Docker container managed by the HA Supervisor. There is no companion Python integration.

All Proton Drive operations — and authentication — go through Proton's official first-party [`proton-drive`](https://proton.me/support/proton-drive-cli) CLI (MIT-licensed), which the add-on shells out to (`src/protonCli.mjs`). The add-on never handles Proton credentials: `auth login` prints a browser sign-in URL that the Web UI surfaces as a link; the CLI owns 2FA/passwords and persists its own session under `/data`. Backups are identified by **filename** (the CLI has no metadata API). There is **no build/bundle step** — Node runs `src/` directly; the Dockerfile downloads the pinned CLI binary per arch with SHA-256 verification.

The repo is a HA *add-on repository*: `repository.yaml` at the root plus the add-on in `proton_drive_backup/`. The add-on folder name is the add-on slug.

## Commands

All commands run from `proton_drive_backup/`:

```bash
npm start              # run the add-on (node src/main.mjs)
npm test               # run the unit tests (node --test)
```

There is **no build step and no bundler**. The unit tests cover the pure decision
logic in `orchestrator.mjs` and the CLI-output parsing in `protonCli.mjs` (using a
fake `proton-drive` in `test/fixtures/`). A quick manual smoke test (no real
Proton calls — `isConnected()` fails fast and sync skips when not signed in):

```bash
PORT=8123 DATA_DIR=/tmp/x BACKUP_INTERVAL_HOURS=0 LOG_LEVEL=debug node src/main.mjs
```

## Architecture

Single Node process. `src/main.mjs` wires it together: start the ingress server → initial `runSync()` after 5s → optional `setInterval` scheduler. No crypto/login setup — the CLI owns auth.

```
HA Supervisor backup API  <--  add-on  -->  Proton Drive
   (supervisor.mjs)              |          (protonCli.mjs → proton-drive CLI)
                          orchestrator.mjs (sync + retention)
                          ingress.mjs (web UI + connect/disconnect)
                          main.mjs (boot, scheduler)
                          logger.mjs (runtime log level)
```

- **`protonCli.mjs`** — wraps the `proton-drive` binary (`$PROTON_DRIVE_BIN`, default on `$PATH`). `run()` spawns the CLI and **never rejects on a nonzero exit** — it resolves `{code, stdout, stderr}` so callers decide what an error means. Failure detection is by **exit code + stderr text**, never by JSON (the CLI signals errors via exit code even with `-j`). Exposes `isConnected`, `login` (browser sign-in; calls back with the URL scraped from stdout), `logout`, `ensureFolder`, `list`, `uploadFile`, `downloadPath`, `trash`. `list` parses the CLI's real `filesystem list -j` schema (fixed in 0.2.4): a bare array of entries whose **`name` is a `Result` object** (`{ok, value}`, not a string), size at `activeRevision.value.claimedSize`, lowercase `type` enum — read `name.value`, still defensively.
- **`orchestrator.mjs`** — `runSync()` (create HA backup → upload new ones to Proton → prune both sides), `restoreToHA()`, `deleteProtonBackup()`, `listProtonBackups()`, `ensureSession()`, `getStatus()`/`setActivity()`. Retention/upload decisions are **pure, unit-tested functions**: `selectToUpload`, `selectProtonToPrune`, `selectHAToPrune`. A module-level `syncing` guard prevents overlapping syncs (two at once make HA reject the second `createBackup` with "system is not running - freeze"). Archive staging is `tmpDir()` = `STAGING_DIR` or the container tmp dir — **outside `/data`** (HA full-backups include `/data`, so a temp `.tar` there gets swallowed). A download `404` (backup HA lists but no longer serves) is **skipped** via `isNotFoundError`, not a hard error. `setActivity`/`getStatus` expose live `syncing`/`activity`/`progress` for the UI. Resilient: per-backup errors are caught into `lastError`; `runSync` never throws out.
- **`supervisor.mjs`** — HA Supervisor client (`http://supervisor`, `SUPERVISOR_TOKEN`). Create/list/download/upload/delete/restore backups. Granted `hassio_role: manager` in `config.yaml`. `downloadBackup` attaches the HTTP `status` to its error so a `404` can be skipped.
- **`ingress.mjs`** — unauthenticated `node:http` server (HA ingress provides auth). Serves a self-contained HTML page + JSON endpoints (`/api/status`, `/api/connect`, `/api/disconnect`, `/api/backup-now`, `/api/restore`, `/api/delete`, `/api/log-level`). `/api/connect` starts `cli.login` in the background and surfaces the sign-in URL via `/api/status`. `/api/status` also carries the live `syncing`/`activity`/`progress` fields; the page renders a connection badge plus an animated **Syncing…** badge and progress bar, and disables "Back up now" while a sync runs.
- **`logger.mjs`** — patches `console` once for timestamped, level-filtered logging; level is adjustable at runtime from the UI.
- **`main.mjs`** — boot, scheduler, SIGTERM/SIGINT (still `mkdir`s a legacy `/data/tmp`, but real staging is `orchestrator.tmpDir()` outside `/data`).

## Authentication — owned by the CLI

The add-on does **no** login handshake, 2FA, or session management of its own. `proton-drive auth login` prints a Proton sign-in URL and blocks until the user completes sign-in in a browser (on any device); the CLI then persists the session itself. Key env (set by `run.sh`):

- `PROTON_DRIVE_CREDENTIALS_STORE=unsafe_file` — avoids the OS keyring (absent in the bare Alpine container).
- `XDG_DATA_HOME=/data` — persists the CLI session under HA's `/data` so it survives restarts (written under `$XDG_DATA_HOME/proton-drive-cli/`).

`orchestrator.ensureSession()` probes `cli.isConnected()` (a cheap `filesystem info /my-files`) and sets `needsLogin`; the UI drives the actual sign-in. There is no stored email/password/2FA and no session encryption to manage.

## Gotchas

- **Line endings must be LF.** `run.sh` uses `#!/usr/bin/with-contenv bashio`; CRLF breaks the shebang inside the Linux container. `.gitattributes` enforces `eol=lf` — keep it.
- **Config flows env → app.** `run.sh` (bashio) maps each `config.yaml` option to an env var (e.g. `drive_folder` → `DRIVE_FOLDER`). Adding an option means editing `config.yaml` (both `options:` and `schema:`), `run.sh`, and reading it in `main.mjs`/`orchestrator.mjs`.
- **`ingress_port: 8099`** in `config.yaml` must match `export PORT=8099` in `run.sh`.
- **`arch` is `amd64`/`aarch64` only** in `config.yaml` — Proton ships no `armv7`/`i386` CLI build. The Dockerfile fails the build on any other arch.
- **CLI failure detection is by exit code + stderr, not JSON.** Never trust `-j` output to detect errors. `list` parses JSON only to read entries and returns `[]` on any parse failure. The `filesystem list -j` schema is now known (0.2.4): entry `name` is a `Result` `{ok,value}` and size is at `activeRevision.value.claimedSize`; `list` reads those but stays defensive as the early CLI's shape may still shift.
- **Staging stays outside `/data`.** `orchestrator.tmpDir()` (`STAGING_DIR` or the container tmp dir) — never stage temp `.tar` files under `/data`, which HA full-backups include (`main.mjs` still creates a legacy, now-unused `/data/tmp`).
- **Security posture is documented honestly in `README.md`/`DOCS.md`:** traffic is HTTPS and backups are E2E-encrypted client-side; the add-on stores **no** Proton password, but the CLI's session token lives in `/data` (`unsafe_file` store) in plaintext. Don't overstate security in docs.

## Deploy target

HA **OS or Supervised only** (add-ons don't exist on Core/Container). `Dockerfile` uses an explicit `FROM ghcr.io/home-assistant/base:<ver>`, installs `nodejs`, downloads the pinned per-arch `proton-drive` binary (SHA-256 verified), copies `src/`, and runs `node /app/src/main.mjs` via `run.sh`. No build step.
