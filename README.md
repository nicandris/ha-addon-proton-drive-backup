# Proton Drive Backup for Home Assistant

A Home Assistant **add-on** that automatically backs up your Home Assistant
instance to [Proton Drive](https://proton.me/drive) using the official Proton
Drive SDK.

> This is an **add-on**, not a custom integration. It runs as its own container
> alongside Home Assistant and therefore requires Home Assistant OS or
> Supervised. It is **not** available on Home Assistant Core or Container
> installations (which have no Supervisor / add-on system).

## What it does

- Creates Home Assistant backups via the Supervisor backup API.
- Uploads each backup to a folder in your Proton Drive using the official Proton
  Drive SDK.
- Runs on a configurable schedule, with retention limits for both Proton Drive
  and local Home Assistant backups.
- Provides an ingress web UI to view status, trigger backups, restore, and
  delete backups.

Everything — the scheduler, the Supervisor API client, the Proton Drive SDK,
and the web UI — runs in a single Node.js container. There is no companion
custom integration to install.

## Requirements

- Home Assistant **OS** or **Supervised** (add-ons are unavailable on Core /
  Container).
- A Proton account. If the account uses two-factor authentication, you enter a
  one-time 6-digit code in the add-on's web UI the first time it connects (and
  again only if the session is later invalidated) — see below.

## Installation

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**.
2. Click the **⋮** menu (top right) → **Repositories**.
3. Add this repository's URL and click **Add**, then close the dialog.
4. Find **Proton Drive Backup** in the store and click **Install**.
5. Open the **Configuration** tab, fill in the options below, and **Save**.
6. **Start** the add-on. Optionally enable "Start on boot" and "Watchdog".

## Configuration

| Option                  | Type     | Default                  | Description                                                                                                          |
| ----------------------- | -------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `proton_email`          | string   | —                        | Proton account email.                                                                                                |
| `proton_password`       | password | —                        | Proton account password.                                                                                             |
| `drive_folder`          | string   | `Home Assistant Backups` | Proton Drive folder for backups (created if missing).                                                                |
| `backup_interval_hours` | int      | `24`                     | Hours between automatic backups. `0` disables automatic backups.                                                     |
| `backups_in_proton`     | int      | `10`                     | Number of backups to retain in Proton Drive.                                                                         |
| `backups_in_ha`         | int      | `4`                      | Number of add-on backups to retain locally in Home Assistant.                                                        |
| `full_backup`           | bool     | `true`                   | `true` for full backups, `false` for partial.                                                                        |
| `backup_password`       | password | (empty)                  | Optional password to encrypt backups.                                                                                |
| `log_level`             | list     | `info`                   | One of `trace`, `debug`, `info`, `notice`, `warning`, `error`, `fatal`.                                              |

Only backups named `Proton Drive Backup <timestamp>` (those created by this
add-on) are pruned by the retention settings; your other backups are left alone.

## Web UI

The add-on exposes an ingress web UI (the **Proton Backup** sidebar panel, or
**Open Web UI** on the add-on page) where you can view status (last/next backup,
connection state), **Back up now**, **Restore** from a Proton Drive backup, and
**Delete** backups.

### Two-factor authentication

If your Proton account has 2FA enabled, the add-on logs in with your email and
password and then waits for a one-time code. Open the web UI: a **Two-factor
authentication** box appears — enter the current 6-digit code from your
authenticator app and click **Connect**. The add-on stores the resulting
session (never the code or the TOTP seed) and refreshes it automatically, so it
keeps working across restarts. You'll only be asked again if that session is
fully invalidated. Only app-based TOTP is supported — not hardware/FIDO keys.

## How it works

```
Home Assistant Supervisor  <--  add-on (Node.js)  -->  Proton Drive
        (backup API)                 |                  (official SDK)
                                 scheduler
                                 ingress web UI
```

The add-on is granted `hassio_api` with the `manager` role so it can drive the
Supervisor backup API. On its schedule it creates a backup, downloads it from
the Supervisor, and uploads it to Proton Drive via the official Proton Drive
SDK. Retention pruning then runs on both sides.

### Authentication

The Proton Drive SDK does **not** handle login — it only performs Drive
operations once it's given an authenticated session and your decrypted keys. So
the add-on does authentication itself:

1. **SRP login (automatic).** Using your configured email and password, the
   add-on runs Proton's SRP handshake (`/auth/v4/info` → `/auth/v4`) and
   receives a session (`UID`, access token, refresh token). No interaction
   needed.
2. **Two-factor gate (only if 2FA is enabled).** The session starts with
   limited scope. The add-on pauses and the web UI shows a code box; you enter a
   live 6-digit code from your authenticator app, which is sent to `/auth/v4/2fa`
   to unlock full access. The code is single-use — neither it nor your TOTP
   seed is ever stored.
3. **Key unlock.** The add-on fetches your key salts, derives the key password
   from your account password, and uses it to decrypt your address keys. These
   keys are what the SDK uses for all Drive encryption/decryption.
4. **Session persistence & refresh.** The session (tokens + derived key
   password, but **not** your password, code, or seed) is saved to the add-on's
   local data. Expired access tokens are refreshed automatically and the rotated
   tokens re-saved, so the add-on keeps running across restarts. You're only
   asked for a new 2FA code if the session is fully invalidated.

## Security

A realistic picture of what is and isn't protected — please read it before
trusting the add-on with your Proton account.

**What is protected:**

- **Encrypted in transit.** All communication with Proton happens over HTTPS to
  Proton's API endpoints.
- **End-to-end encrypted at rest in Proton Drive.** Backups are encrypted
  client-side with your Proton keys (via the official Proton Drive SDK) before
  upload, so Proton's servers never see their contents. You can additionally set
  `backup_password` to have the Supervisor encrypt the backup archive itself
  before it ever leaves Home Assistant.
- **Minimal secrets at rest.** The add-on never stores your TOTP/2FA secret or
  any one-time code — for 2FA accounts you type a single-use code into the web
  UI at login (see [Authentication](#authentication)).
- **UI is gated by Home Assistant.** The web UI is served only through HA
  ingress, so it's reachable only by users already authenticated to Home
  Assistant.

**What is *not* protected (important):**

- **Your credentials are stored unencrypted on your HA host.** Add-on options
  such as `proton_password` (and `backup_password`) are saved in plaintext by
  the Home Assistant Supervisor — the `password` field type only hides the value
  in the UI, it does **not** encrypt it on disk. Likewise the Proton session
  (tokens and the derived key password) is written in plaintext to the add-on's
  `/data`. Anyone with file-level access to your HA host — or to an unencrypted
  backup/snapshot of it — can read your Proton password and session. This is how
  **all** Home Assistant add-on secrets work; it is not unique to this add-on,
  but you should be aware of it.

**Recommendations:**

- Keep your Home Assistant host itself secure (full-disk encryption, restricted
  SSH/file access, encrypted off-site backups).
- Consider a **dedicated Proton account** for backups rather than your primary
  account, to limit blast radius if the host is compromised.
- Review the source before installing.

### Third-party disclaimer

This is a **third-party, community** add-on. It is **not** affiliated with,
endorsed by, or supported by Proton AG, and it relies on a pre-release
(alpha) build of the Proton Drive SDK. Install only if you trust this add-on.

## Caveat: upcoming Proton crypto migration

Proton has announced a new cryptographic model expected around late 2026 / 2027.
When that migration ships, the authentication/encryption flow used by the Proton
Drive SDK may change and could break logins. If that happens, rebuild or update
the add-on to a version that supports the new crypto model.
