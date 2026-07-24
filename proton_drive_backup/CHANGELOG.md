# Changelog

## 0.2.5

- **Backup statistics panel.** The Web UI now shows counts and total sizes for
  backups in Home Assistant and in Proton Drive, host disk free, and the last /
  next backup times. (Proton account quota and email are not shown — the CLI
  exposes no account/usage command.)
- **Dark mode.** The UI follows your system/browser theme via
  `prefers-color-scheme`, so it matches a dark Home Assistant.
- **Graceful handling when Home Assistant is busy.** A backup-creation attempt
  rejected with `system is not running` / `freeze` / `blocked from execution`
  (e.g. right after a restart, or while another backup runs) is now a logged
  skip for that cycle instead of a red error; existing backups still sync.

## 0.2.4

- **Fix "No backups in Proton Drive" (and duplicate re-uploads).** Proton's CLI
  serialises each entry's `name` as a `Result` object
  (`{ ok: true, value: "<file>.tar" }`), not a plain string — so the listing
  parser matched nothing, the UI showed no backups, and dedup was blind (it
  re-uploaded a fresh copy every sync). `list` now reads the name from
  `name.value` and the size from `activeRevision.value.claimedSize`, matching
  the CLI's actual schema. This was the root cause of the earlier
  `name.startsWith is not a function` crash too.

## 0.2.3

- **Live status indicator in the Web UI.** The status card now shows a
  connection badge plus a live sync state — an animated **Syncing…** badge with
  the current step (e.g. *"Uploading 2 of 3: &lt;name&gt;"*) and a progress bar,
  so the long multi-minute uploads no longer look frozen. "Back up now" shows
  "Syncing…" and is disabled while a sync runs. Idle shows a plain badge.

## 0.2.2

- **Stage backup downloads outside `/data`.** Temp `.tar` files were staged in
  `/data/tmp`, but HA includes the add-on's `/data` in full backups — so a
  backup created while a temp file was present swallowed it (a 4.87 GB backup
  ballooned to 9.74 GB). Downloads now stage in the container's ephemeral tmp
  dir (override with `STAGING_DIR`), which is never part of an HA backup.
- **Skip backups Home Assistant no longer serves.** If the Supervisor lists a
  backup but returns `404` on download (a stale/phantom entry), the sync now
  skips it with a warning instead of raising a hard error every run. Delete the
  entry in HA to silence the warning.

## 0.2.1

- **Fix `Sync failed: name.startsWith is not a function`.** `filesystem list`
  entries whose `name` wasn't a plain string crashed retention. `list` now
  coerces names (tolerating bare-string entries) and `isOurRemoteFile` is
  type-guarded. The raw `list` JSON is logged at debug level to validate
  Proton's real output shape.
- **Prevent overlapping syncs.** `runSync` is triggered from startup, the
  scheduler, post-login, and "back up now"; two at once made Home Assistant
  reject the second backup with `system is not running - freeze` and race on
  retention. A guard now ensures only one sync runs at a time.

## 0.2.0

- **Switched to Proton's official first-party `proton-drive` CLI.** The previous
  releases used the pre-release Drive SDK plus a hand-rolled login/2FA/crypto
  flow against Proton's account API — a path Proton permanently blocks for
  third-party clients (a hard `HTTP 422` account block with no client-side
  workaround). The add-on now shells out to the official CLI, which resolves
  that gating.
- **Auth is now a browser sign-in.** Click **Connect** in the Web UI; the app
  shows a Proton sign-in URL you open on any device (phone or PC). No email,
  password, or 2FA code is entered into or stored by the add-on, and there is no
  session encryption to manage — the CLI persists its own session under `/data`,
  so it survives restarts.
- **Removed** the account email / password options and all 2FA / verification
  UI and endpoints.
- **Backups are now identified by filename** (`Proton Drive Backup <ISO>.tar`),
  since the CLI has no metadata API. Retention sorts by that timestamped name.
- **Architecture limited to `amd64` and `aarch64`** — Proton ships no
  armv7/i386 musl build of the CLI.

## 0.1.11

- **Auth correctness fixes** verified against ProtonMail/WebClients and Proton's
  crypto library:
  - Match `KeySalt` to the primary address key by ID (was: first salt entry —
    multi-address accounts could derive the wrong key password).
  - FIDO2-only 2FA accounts now show a clear "enable TOTP" error instead of an
    unfillable code prompt.
  - Login-handshake module wired correctly for the SDK's sharing paths (passes
    username, fetches modulus from `/core/v4/auth/modulus`, returns `modulusId`).
  - 30 s timeout on all auth API + token-refresh calls.
  - `getAuthVersionWithFallback` loop for legacy Version=0 accounts.
  - Token-refresh failure now resets `connected` so the UI no longer shows
    "connected" while Drive calls fail.
  - Verification-challenge `ExpiresAt` surfaced with an inline expiry hint.
  - Canonical `/core/v4/auth/...` endpoint paths (vs the `auth/v4` aliases).
  - `Intent: "Proton"` + `PersistentCookies: 0` added to auth bodies;
    `RedirectURI` updated from `protonmail.ch` to `proton.me` on refresh.
- **Runtime log-level control.** New log-level dropdown in the status card
  (`error` / `warning` / `info` / `debug`), `GET`/`POST /api/log-level`
  endpoint, and verbose debug tracing across login, token refresh, key import,
  Drive folder resolution, upload/download/prune, Supervisor calls, and
  ingress routing.

## 0.1.10

- **Add prominent warning** at the top of the repo README, app README, and
  DOCS about the risk of Proton blocking third-party authentication — most
  likely until Proton officially releases the Drive SDK for third-party use.

## 0.1.9

- **Honest halt messages.** Previously the halt message always said "sign in
  at account.proton.me to verify it" even when Proton returned a hard account
  block (`HTTP 422`), which has no in-web verification. The web UI's halt card
  now shows the underlying Proton error on one line and a code-specific action
  line on the next: for the hard block it advises waiting / different network /
  the appeal form; for other rate-limit responses it points at the web sign-in
  verification step; for everything else it just says "fix the issue".

## 0.1.8

- **Fix Docker build failure (`ENOENT /app/config.yaml`)** introduced in 0.1.7:
  `build.mjs` reads the version from `config.yaml`, but the Dockerfile wasn't
  copying that file into the build context. Added `config.yaml` to the COPY
  line so HA can rebuild the image.

## 0.1.7

- The version now lives in **one place**: `config.yaml`. `build.mjs` reads it
  from there to inject into `x-pm-appversion`. Removed the redundant copies in
  `package.json` and the `Dockerfile` LABEL. To bump the version, edit only
  `config.yaml`.

## 0.1.6

- Human-check iframe now uses Proton's exact `postMessage` protocol
  (verified against the ProtonMail/WebClients `applications/verify` source):
  strict origin + same-iframe checks, `embed=true` so the iframe sends resize
  events, and handling for the load / resize / success / close / error envelopes.

## 0.1.5

- **Handle Proton's human-check challenge (Code 9001).** When Proton asks
  for a one-time human check (common for new accounts or unrecognized
  clients), the web UI now embeds `verify.proton.me` in an iframe, captures the
  solved token via `postMessage`, and retries the login with the appropriate
  verification-token headers. Status `needs verification` appears
  in the UI; sync resumes automatically once the challenge is solved.
- Note: this does **not** unblock a hard account block — that path needs a
  Proton support appeal.

## 0.1.4

- The `x-pm-appversion` version is now taken from `package.json` at build time,
  so it always matches the actual build instead of a stale hardcoded value.

## 0.1.3

- **Fix app identification.** The `x-pm-appversion` name was `home_assistant`,
  which misrepresented requests as coming from the Home Assistant project.
  Changed to `ha_addon_proton_drive_backup` (this third-party project's own
  name), per Proton's "identify your application honestly" rule.
- Login errors now report Proton's response **code, HTTP status, and any
  Details** (e.g. a verification challenge), not just the message — so a
  block can be diagnosed from the log/UI.
- Send an honest `User-Agent` header on all requests.

## 0.1.2

- **Stop auto-retrying after a login failure.** Repeated automatic logins could
  trip Proton's abuse protection and temporarily lock the account. Now, after
  any login failure the app **halts** and stops attempting until you click
  **Retry connection** in the web UI. The halt persists across restarts, so a
  restart/watchdog loop can't keep hammering Proton.
- Rate-limit / "unusual activity" responses are flagged specifically, with a
  prompt to verify the account at account.proton.me before retrying.

## 0.1.1

- **Fix: logins failed with `fetch failed (cause: ENOTFOUND)`.** The auth/core
  API host was `api.proton.me`, which has no DNS record. Switched to
  `account-api.proton.me` (Proton's real account API host). Logins now reach
  Proton instead of failing at DNS resolution.

## 0.1.0

Initial release.

- Back up Home Assistant to Proton Drive using the official Proton Drive SDK.
- Creates backups via the Supervisor backup API, uploads them to a Proton Drive
  folder, on a configurable schedule.
- Retention limits for both Proton Drive and local Home Assistant backups; only
  backups this app created (`Proton Drive Backup <timestamp>`) are pruned.
- Ingress web UI: status, back up now, restore, and delete.
- **Interactive two-factor authentication** — for 2FA accounts you enter a
  one-time 6-digit code in the web UI; the TOTP seed is never stored.
- **Session encrypted at rest** (AES-256-GCM) in the app's local data.
- Clear network error messages (the underlying cause is surfaced, not just
  "fetch failed").
- App icon.

> Note: an early build briefly carried the version `1.0.0`; it was corrected to
> `0.1.0` to reflect pre-release (alpha) status before any stable release.
