# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **For the full reference, read [`DEVELOPMENT.md`](./DEVELOPMENT.md)** — module-by-module breakdown, the complete auth flow and its sharp edges, the Proton SDK/Supervisor integrations, build/versioning/deploy details, Proton compliance status, and a troubleshooting map. This file is the quick summary; `DEVELOPMENT.md` is the long form.

> ⚠️ **Project status: alpha, blocked by Proton third-party auth gating.** Live testing showed brand-new accounts being blocked on the first SRP login with `HTTP 422 Code 2028` (Proton Sentinel — no `Details`, no CAPTCHA, no client-side fix). The SDK README states it is "not yet ready for third-party production use" and auth is out of its scope. `Code 9001` (HumanVerification) **is** handled (0.1.5+); `Code 2028` requires user action outside the app (appeal / wait / different IP). The repo's user-facing READMEs and `DOCS.md` carry a prominent warning. Do not assume "fix the auth code" can resolve a 2028 — it can't.

> 🔄 **Architecture change (0.2.0): now CLI-based, not SDK-based.** The SDK + hand-rolled SRP/2FA/crypto auth (blocked by the 2028 gating above) is **gone**. The add-on now shells out to Proton's official first-party `proton-drive` CLI (`src/protonCli.mjs`), which owns auth via a browser sign-in URL surfaced in the Web UI (no stored email/password/2FA, no session encryption; the CLI persists its session under `/data`). Backups are identified by **filename** (no metadata API). There is **no esbuild bundle step** — Node runs `src/` directly; the Dockerfile downloads the pinned CLI binary. **This CLAUDE.md, `DOCS.md`, `DEVELOPMENT.md`, and the READMEs below still describe the old SDK design — a full doc overhaul is a deferred follow-up.** Trust the code and `CHANGELOG.md` 0.2.0 over the prose in the rest of this file for now.

## What this is

A **Home Assistant add-on** (not a custom integration) that backs up Home Assistant to Proton Drive. It is a standalone Node.js app shipped as a Docker container managed by the HA Supervisor. There is no companion Python integration — the old `custom_components/` Python/subprocess-bridge approach was removed.

The repo is a HA *add-on repository*: `repository.yaml` at the root plus the add-on in `proton_drive_backup/`. The add-on folder name is the add-on slug.

## Commands

All commands run from `proton_drive_backup/`:

```bash
npm install            # install deps (only @protontech/* + esbuild)
npm run build          # esbuild bundle src/main.mjs -> dist/main.mjs
npm start              # run the built bundle (node dist/main.mjs)
```

There is **no test suite, linter, or formatter** configured. "Verifying" a change means: rebuild, then boot the bundle with env vars set and confirm it starts cleanly. Example smoke test (no real Proton calls — login fails fast and is caught):

```bash
PORT=8123 DATA_DIR=/tmp/x BACKUP_INTERVAL_HOURS=0 LOG_LEVEL=debug node dist/main.mjs
```

`dist/main.mjs` is a **build artifact** — gitignored, rebuilt inside the Docker image (`Dockerfile` runs `npm run build` then strips `node_modules`/`src`). Do not commit it.

## Critical build constraints (esbuild)

`build.mjs` has three workarounds that **must not be removed** — they were each found by trial and error and the bundle breaks without them:

1. `format: 'esm'` — a dependency calls `createRequire(import.meta.url)`, which is `undefined` in CJS output.
2. `banner.js` injecting `require`/`__filename`/`__dirname` — bundled CJS deps (e.g. `@noble/hashes`) call `require('node:crypto')` at runtime.
3. `alias: { 'openpgp/lightweight': 'openpgp' }` — `openpgp/lightweight` has no node export condition and won't resolve.

## Architecture

Single Node process. `src/main.mjs` wires it together: `setupCrypto()` → start ingress server → initial `runSync()` after 5s → optional `setInterval` scheduler.

```
HA Supervisor backup API  <--  add-on  -->  Proton Drive
   (supervisor.mjs)              |           (protonClient.mjs via official SDK)
                          orchestrator.mjs (sync + retention)
                          ingress.mjs (web UI)
                          protonAuth.mjs (login + session)
```

- **`supervisor.mjs`** — HA Supervisor client (`http://supervisor`, `SUPERVISOR_TOKEN`). Create/list/download/upload/delete/restore backups. Granted `hassio_role: manager` in `config.yaml`.
- **`protonClient.mjs`** — wraps the official `@protontech/drive-sdk` `ProtonDriveClient` for list/upload/download/delete. HA backup metadata round-trips via the SDK's `additionalMetadata` under a `HomeAssistant` key (the top-level `Common` key is reserved by the SDK).
- **`orchestrator.mjs`** — `runSync()` (create HA backup → upload new ones to Proton → prune both sides) and `restoreToHA()`. Resilient: per-backup errors are caught into `lastError`; `runSync` never throws out. Retention pruning of *local* HA backups only ever touches backups named with the `Proton Drive Backup` prefix.
- **`ingress.mjs`** — unauthenticated `node:http` server (HA ingress provides auth). Serves a self-contained HTML page + JSON endpoints (`/api/status`, `/api/backup-now`, `/api/restore`, `/api/delete`, `/api/2fa`).
- **`protonAuth.mjs`** + **`httpClient.mjs`** + **`account.mjs`** — authentication (see below).
- **`cryptoSetup.mjs`** — one-time `CryptoProxy` init for Node (`CryptoApi.init({})` then `setEndpoint`). Must run before any Drive/crypto call. Note the `.ts` in the import specifier `@protontech/crypto/proxy/endpoint/api.ts` — keep it.

### Authentication — the SDK does NOT do this

The Proton Drive SDK only performs Drive operations once handed an authenticated `httpClient` + an `account` with decrypted keys. **Login, SRP, 2FA, and session management are all our own code** in `httpClient.mjs` (`srpAuth`) and `protonAuth.mjs`. Flow:

1. SRP login from `PROTON_EMAIL`/`PROTON_PASSWORD` (`/auth/v4/info` → `/auth/v4`).
2. If the account has 2FA, `beginAuth()` throws `NEEDS_2FA` and holds the partial session; the user submits a **live 6-digit code** via the web UI → `submitTwoFactorCode()` → `/auth/v4/2fa`. The TOTP seed is never stored (this was a deliberate change away from storing the seed; there is no `otplib` dependency).
3. `completeLogin()` derives the key password (`computeKeyPassword`), builds the account (imports address keys), and inits the client.
4. Session persisted to `${DATA_DIR}/session.json`, **encrypted at rest** with AES-256-GCM. The key is derived (scrypt) from the Proton password at runtime and never written to disk. `loadPersistedSession` transparently migrates a legacy plaintext file. Token refresh on 401 rotates and re-persists tokens, so restarts don't re-prompt for 2FA.

`x-pm-appversion` is `external-drive-ha_addon_proton_drive_backup@<version>-alpha`, where `<version>` is read from `config.yaml` at build time (the single source of truth — see §12). The `{name}` must identify *this* third-party project — not `home_assistant` (impersonates the HA project) and not anything implying Proton. Must not spoof first-party apps.

## Gotchas

- **Line endings must be LF.** `run.sh` uses `#!/usr/bin/with-contenv bashio`; CRLF breaks the shebang inside the Linux container. `.gitattributes` enforces `eol=lf` — keep it.
- **Config flows env → app.** `run.sh` (bashio) maps each `config.yaml` option to an env var (e.g. `proton_email` → `PROTON_EMAIL`). Adding an option means editing `config.yaml` (both `options:` and `schema:`), `run.sh`, and reading it in `main.mjs`/`orchestrator.mjs`.
- **`ingress_port: 8099`** in `config.yaml` must match `export PORT=8099` in `run.sh`.
- **SDK is pre-release (alpha).** Proton has a crypto migration targeted ~late 2026/2027 that may break the auth/encryption flow; logins failing afterward likely means the SDK needs updating.
- **Security posture is documented honestly in `README.md`/`DOCS.md`:** traffic is HTTPS and backups are E2E-encrypted client-side, but credentials live in HA's `options.json` in plaintext (platform limitation). Don't overstate security in docs.

## Deploy target

HA **OS or Supervised only** (add-ons don't exist on Core/Container). `Dockerfile` uses an explicit `FROM ghcr.io/home-assistant/base:<ver>` (the `BUILD_FROM` arg is no longer auto-provided by recent Supervisor versions).
