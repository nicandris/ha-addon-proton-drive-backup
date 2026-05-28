# Changelog

## 0.1.6

- HumanVerification iframe now uses Proton's exact `postMessage` protocol
  (verified against the ProtonMail/WebClients `applications/verify` source):
  strict origin + same-iframe checks, `embed=true` so the iframe sends RESIZE
  events, and handling for `LOADED` / `RESIZE` / `HUMAN_VERIFICATION_SUCCESS` /
  `CLOSE` / `ERROR` envelopes.

## 0.1.5

- **Handle Proton's HumanVerification challenge (Code 9001).** When Proton asks
  for a one-time human verification (common for new accounts or unrecognized
  clients), the web UI now embeds `verify.proton.me` in an iframe, captures the
  solved token via `postMessage`, and retries the login with the
  `x-pm-human-verification-token` headers. Status `needs verification` appears
  in the UI; sync resumes automatically once the challenge is solved.
- Note: this does **not** unblock a hard `Code 2028` Sentinel block — that path
  needs a Proton support appeal.

## 0.1.4

- The `x-pm-appversion` version is now taken from `package.json` at build time,
  so it always matches the actual build instead of a stale hardcoded value.

## 0.1.3

- **Fix app identification.** The `x-pm-appversion` name was `home_assistant`,
  which misrepresented requests as coming from the Home Assistant project.
  Changed to `ha_addon_proton_drive_backup` (this third-party project's own
  name), per Proton's "identify your application honestly" rule.
- Login errors now report Proton's response **code, HTTP status, and any
  Details** (e.g. a human-verification challenge), not just the message — so a
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
