# Changelog

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
