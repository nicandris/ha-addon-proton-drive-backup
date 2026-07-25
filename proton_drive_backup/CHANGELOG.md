# Changelog

## 0.4.7

- **The panel now opens instantly.** Opening it used to block on two Proton CLI
  calls plus two Supervisor calls before anything appeared — several seconds of
  "Loading…", and it could briefly flash **Connect to Proton Drive** at an
  already-connected user. The page is now served immediately with everything
  already known (settings, schedule, buttons) while the slow parts refresh in the
  background and fill themselves in, with a **spinner** on the connection badge,
  the statistics card and the backup list until they arrive. Measured with a
  deliberately slow CLI: first response **0.01 s instead of ~6–9 s**.
- The status cache is also warmed when the add-on starts, so the first visit after
  a restart is already populated.

## 0.4.6

- **Appearance selector: Auto / Light / Dark.** The panel followed your browser's
  light/dark setting with no way to override it. There is now an **Appearance**
  selector in the status card: *Auto* keeps matching Home Assistant, or you can
  force Light or Dark. The choice is remembered per browser and applied before the
  first paint, so there's no flash of the wrong theme. (Forcing Light correctly
  wins over a dark OS setting.)

## 0.4.5

### Changed

- **The panel now uses Home Assistant's own colour palette**, so it matches the
  rest of HA instead of its own ad-hoc colours: HA's stock light and dark values
  for backgrounds, cards, text, dividers and the semantic (error/success/info)
  colours, with HA's blue as the accent for buttons and progress. Cards also pick
  up HA's corner radius.

  *Note:* the panel runs in an ingress **iframe**, and CSS variables do not cross
  an iframe boundary — HA's theme variables are not visible inside this document,
  so they can't simply be inherited. The palette is therefore declared locally
  **using HA's own variable names**, which means following a *custom* theme later
  only requires supplying different values, not touching any styling.

## 0.4.4

### Fixed

- **The Web UI was stuck on "Loading…" (0.4.3).** A newline escape written inside
  the page template turned into a real line break in the browser's JavaScript, so
  the page failed to parse (`Uncaught SyntaxError`) and never rendered — no status,
  no statistics, no backup list. The buttons were drawn but nothing populated.
  Fixed, and the test suite now **compiles the rendered page's script** the way a
  browser would, so a syntax error inside the UI can no longer ship (checking the
  server file alone could never catch it).

## 0.4.3

Follow-ups from the code review (the remaining medium-severity items).

### Fixed

- **Retention could delete the wrong backup when Proton reported no timestamp.**
  Ordering fell back to "epoch 0" for any entry without a date, so "keep the newest
  N" silently became "keep whichever N were listed first". Dates are now taken from
  Home Assistant (authoritative — a re-upload rewrites the remote timestamp), and
  an entry whose date still can't be established is **never pruned**; it just
  occupies a keep slot, and a warning says how many were held back.
- **A non-English Home Assistant broke the automatic/app split.** Backups were
  classified by the literal prefix "Automatic backup", so on a localised install
  every scheduled backup landed in the *app* bucket and was pruned against
  `keep_app_*`. New **`automatic_name_prefix`** option (editable in the Web UI,
  default `Automatic backup`), and the sync now warns when no backup matches it.
- **Clean up local backups now reports what actually happened.** The counts came
  from the plan before deleting, and failures incremented nothing, so it could say
  "Deleted 3" when none succeeded. Deleted / failed / skipped are counted
  separately now, from one shared planner (so the numbers can't drift from the
  decision).
- **Only the last error was visible.** A sync with several failed uploads
  overwrote a single slot; a short error history is kept instead. **Clear** now
  also clears the listing and sign-in errors, which previously came straight back
  on the next poll and made the button look broken.
- **Long-running CLI output no longer grows without bound** — a multi-GB upload or
  a five-minute sign-in could accumulate unlimited progress output in memory; only
  the head and tail are kept.

## 0.4.2

- **Settings are now editable from the Web UI.** The Settings card became a small
  form — drive folder, sync interval, the automatic-name prefix and the four
  keep-counts — with a **Save settings** button. Changes are written to the add-on's
  own configuration through the Supervisor (so they survive a restart and match
  what the Configuration tab shows) *and* applied to the running process
  immediately, so **no restart is needed**. Invalid values are rejected with a
  message instead of being applied. `backup_password` stays out of the panel by
  design — change it in the Configuration tab.

## 0.4.1

Reliability, safety and security fixes from a full code review. No option changes.

### Fixed

- **Restoring a large backup could get the app killed.** The archive was read into
  memory before being handed to Home Assistant (a 4.9 GB backup allocated ~5 GB and
  was OOM-killed); it is now streamed, so memory stays flat regardless of size
  (measured: 103 MB peak on a 3 GB backup).
- **Picking `notice`, `trace` or `fatal` as the log level crash-looped the app.**
  The Configuration dropdown offers Home Assistant's seven log levels, but only
  four were implemented and anything else threw during start-up. The extra values
  now map onto the four (`trace`→debug, `notice`→info, `fatal`→error), and an
  unrecognised value logs a warning and falls back to `info` instead of exiting.
- **A failed Proton listing no longer looks like "your Drive folder is empty".**
  If `filesystem list` failed (expired session, transient error, unparseable
  output) the sync treated it as an empty folder and re-uploaded **every** backup
  with "replace" — tens of GB, and it reset every remote timestamp, which is what
  Proton retention sorts by. The sync and retention paths now fail loudly and stop.
- **A partial upload can no longer be mistaken for a good backup.** A remote file
  was trusted purely because its name contained the backup's `(slug)`. An upload
  interrupted after the file appeared therefore counted as "safely offsite": the
  next sync skipped it, and **Clean up local backups** could delete the last good
  local copy. A remote copy is now only accepted when its **size** matches the
  Home Assistant backup's size; a mismatch (or a missing size on either side) is
  re-uploaded and is **never** accepted as a reason to delete a local backup.
- **"Backup creation failed: fetch failed" on a backup that actually succeeded.**
  Create-backup and restore calls hit Node's fixed ~5-minute HTTP header timeout
  while Home Assistant was still working, so a multi-GB backup reported failure
  (and its upload to Proton was skipped) even though HA completed it. Those two
  calls now wait as long as HA needs.
- **The Web UI showed "Idle" during a restore.** A restore now takes the same
  single-operation lock as a sync and reports its step ("Restoring … downloading
  from Proton Drive"), so it can't overlap with a sync and is visible while it
  runs. Starting a restore returns immediately and progress/errors appear in the
  status card (as for **Sync now**) instead of the browser waiting minutes.
- **Leftover staged archives are cleaned up on start.** Stopping the app
  mid-transfer left a multi-GB temp `.tar` behind forever; those are now deleted at
  start-up (with a log line saying how much was reclaimed). Before each download
  the app also checks there is enough free space and skips that backup with a clear
  error instead of filling the disk. The unused legacy `/data/tmp` directory is no
  longer created.
- **A Proton "does not exist" error is no longer read as success** when creating
  the Drive folder.
- **A port conflict now logs a clear message** instead of an unhandled crash.

### Security

- **Stored cross-site-scripting in the Web UI.** Backup names, error text and
  statistics were injected into the page without escaping, so a backup named like
  an HTML tag could execute script in the ingress panel. All server-provided text
  is now escaped.
- **Path traversal via the backup name.** The delete and restore endpoints passed
  the supplied name straight into a Drive path and a local file path, so a crafted
  `../…` name could act outside the Drive folder and delete files inside the
  container. Only plain `*.tar` filenames are accepted now (rejected with a 400).
- **The Proton CLI no longer receives the app's whole environment** (which
  includes your `backup_password` and the Supervisor token) — only the variables
  the CLI itself needs.
- **Proton's raw listing payload is no longer logged.** Debug logs contained
  internal node/revision ids and hashes; they now log only the file names and
  sizes the app actually uses.

### Changed

- **The Web UI is much cheaper to leave open.** Status is served from a 30-second
  cache instead of spawning the Proton CLI twice per poll per browser tab, and the
  page polls adaptively (5 s while something is happening, 20 s idle, 60 s when the
  tab is hidden).
- Container base image updated (Alpine 3.24) with the **Node major pinned to 24**.
- Dead code removed (unused backup-info call, unused config fields, a duplicated
  config reader) and the developer docs corrected.

## 0.4.0

- **Split retention into two independent buckets: AUTOMATIC vs APP.** Home
  Assistant makes big scheduled "Automatic backup" archives *and* many small
  per-add-on "app" backups (created before add-on updates). Previously a single
  total limit per side meant a burst of app backups could evict the important
  Automatic ones. Retention is now enforced **per bucket**, so the two never
  compete. Backups are classified **by name**: anything whose name starts with
  "Automatic backup" is *automatic*; everything else is *app*. This works on both
  an HA backup name and a Proton remote filename.
- **Clear error button.** A "Clear" button next to *Last error* dismisses a
  stale error without waiting for the next successful sync.
- **Config migration — action may be needed.** The two old options were
  **replaced** by four new ones:
  - `backups_in_proton` → **`keep_automatic_in_proton`** (default `10`) +
    **`keep_app_in_proton`** (default `10`)
  - `backups_in_ha` → **`keep_automatic_in_ha`** (default `0`) +
    **`keep_app_in_ha`** (default `0`)

  As before, `0` means "keep all" for the Proton limits, and `0` disables that
  bucket's manual HA clean-up. Proton retention still runs automatically each
  sync (per bucket now); HA clean-up stays manual-only via **Clean up local
  backups** and still **never** deletes a backup that isn't already in Proton —
  the safety invariant now holds independently in each bucket.
- **Settings shown in the Web UI.** A new **Settings** card (in the responsive
  2-column grid) shows the effective configuration read-only: drive folder, sync
  interval, the four keep-counts, whether a backup password is set (boolean
  only — the password is never exposed), and the staging dir if overridden. The
  statistics card now also splits the counts by bucket ("N automatic, M app").
- **Clean up local backups** hint/confirm now reflect the two HA limits and the
  button is disabled only when **both** are `0`.

## 0.3.1

- **Manual "Create backup" button.** Creates a new full Home Assistant backup on
  demand and immediately uploads it to Proton. On-demand only — there is still no
  automatic/scheduled creation. "Sync now" continues to only upload existing
  backups. If Home Assistant is busy, the button reports it and does nothing.

## 0.3.0

- **New model: mirror Home Assistant's own backups to Proton Drive** (like the
  Google Drive backup add-on). The add-on **no longer creates backups**. It
  uploads **every** backup that already exists in Home Assistant — automatic and
  manual alike — that isn't already in Proton Drive. Make backups however you
  like in Home Assistant (the built-in automatic backup, manual snapshots, other
  add-ons); this add-on copies them offsite.
- **Dedup by the HA backup slug.** Each backup is stored remotely as
  `<name> (<slug>).tar` (e.g. `Automatic backup 2026.7.3 (a1b2c3d4).tar`); the
  `(slug)` suffix is the backup's stable, unique id, so re-syncing never
  re-uploads a backup that's already there.
- **"Sync now"** (renamed from "Back up now") uploads any existing HA backups
  not yet in Proton. It also runs on boot and on the `backup_interval_hours`
  check interval.
- **"Clean up local backups"** (new, manual-only button). Deletes local Home
  Assistant backups beyond the newest `backups_in_ha`, but **only** ones already
  copied to Proton — it will **never** delete a backup that isn't safely offsite.
  Reports how many were deleted and how many were skipped (not yet mirrored).
  Local clean-up is never automatic.
- **Proton retention** (`backups_in_proton`) still runs automatically each sync,
  now sorting by each Proton entry's date (the filenames are no longer
  timestamp-sortable).
- **Two-column Web UI** on wide screens (status + statistics side by side,
  collapsing to one column on narrow screens) to cut wasted whitespace; dark
  mode preserved. Statistics now read "In Home Assistant" (all backups) and "In
  Proton Drive" (mirrored).
- **Removed** the `full_backup` option (the add-on no longer creates backups, so
  full-vs-partial is decided by whatever creates the backup in Home Assistant).
  `backup_password` is now used only to decrypt encrypted backups on **restore**.

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
