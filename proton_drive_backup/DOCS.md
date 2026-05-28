# Proton Drive Backup

> ⚠️ **Pre-release warning — risk of account blocks.** Proton's Drive SDK is
> in alpha and Proton has not opened third-party authentication. Brand-new
> Proton accounts have been blocked on the **first** login attempt with HTTP
> 422 `Code 2028` (Sentinel hard block — no CAPTCHA, no client-side fix).
> Clearing it requires waiting and/or appealing at
> [proton.me/support/appeal-abuse](https://proton.me/support/appeal-abuse).
> Use only with a Proton account you can afford to have temporarily blocked.
> Likely to improve once Proton officially releases the SDK for third-party
> use (~late 2026 / early 2027).

This app automatically backs up your Home Assistant instance to
[Proton Drive](https://proton.me/drive). It runs entirely inside a single
container: it asks the Supervisor to create backups, then uploads them to your
Proton Drive using the official Proton Drive SDK, on a schedule, with retention
limits and an ingress web UI.

## How it works

1. On a schedule (`backup_interval_hours`), the app calls the Supervisor
   backup API to create a backup of Home Assistant.
2. The resulting archive is uploaded to a folder in your Proton Drive.
3. Old backups are pruned from both Proton Drive and Home Assistant according to
   your retention settings.

Backups created by this app are named `Proton Drive Backup <timestamp>`.
Only backups with that name are pruned locally — any backups you create
manually or with other tools are left untouched.

## Configuration

| Option                  | Description                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proton_email`          | Your Proton account email address.                                                                                                                                   |
| `proton_password`       | Your Proton account password.                                                                                                                                        |
| `drive_folder`          | Folder name in Proton Drive where backups are stored. Created if it does not exist.                                                                                  |
| `backup_interval_hours` | How often, in hours, to create and upload a backup. Set to `0` to disable automatic backups (you can still trigger them manually from the web UI).                    |
| `backups_in_proton`     | How many backups to keep in Proton Drive. Older ones beyond this count are deleted.                                                                                  |
| `backups_in_ha`         | How many app backups to keep locally in Home Assistant.                                                                                                           |
| `full_backup`           | `true` for full backups, `false` for partial backups.                                                                                                                |
| `backup_password`       | Optional password to encrypt backups. Leave empty for unencrypted backups.                                                                                           |
| `log_level`             | Logging verbosity: `trace`, `debug`, `info`, `notice`, `warning`, `error`, or `fatal`.                                                                               |

### Two-factor authentication (2FA)

If your Proton account has 2FA enabled, the app logs in with your email and
password and then pauses for a one-time code. Open the **Web UI**: when a code
is needed, a **Two-factor authentication** box appears. Enter the current
6-digit code from your authenticator app and click **Connect**.

The app then stores the resulting session (not the code) and refreshes it
automatically, so it keeps working across restarts without asking again. You
will only need to re-enter a code if the session is fully invalidated (for
example, if you sign the session out from Proton or it expires after a long
period offline) — in that case the box reappears in the Web UI.

Notes:

- The app never stores your TOTP secret/seed — only a 6-digit code you type
  in at login, which cannot be reused.
- Only **app-based TOTP** two-factor is supported. Hardware/FIDO security keys
  cannot be used.
- Because login can require a manual code, fully unattended first-time startup
  is not possible on a 2FA account: open the Web UI once after starting the
  app (or after a session expiry) to enter the code.

## Web UI

Click **Open Web UI** (the ingress panel, also available in the sidebar as
"Proton Backup") to:

- View **status** — last backup time, next scheduled run, and connection state.
- **Enter a two-factor code** — when your account has 2FA enabled and the
  app needs to (re)connect (see "Two-factor authentication" above).
- **Back up now** — trigger an immediate backup and upload.
- **Restore** — restore Home Assistant from one of the backups in Proton Drive.
- **Delete** — remove a backup from Proton Drive.
- **Retry connection** — shown if login has halted (see below).

### If login fails

The app does **not** automatically retry a failed login. Repeatedly retrying
(for example on every restart) can make Proton flag the account for "unusual
activity" and temporarily lock it. Instead, after any login failure the app
**halts** and shows the error in the Web UI with a **Retry connection** button.
The halt persists across restarts, so nothing keeps hitting Proton in the
background.

Fix the underlying cause (wrong password, expired session, etc.), then click
**Retry connection**. If the message says Proton has *temporarily limited* the
account, sign in once at [account.proton.me](https://account.proton.me) from the
same network to verify it, wait for the limit to clear, then retry.

## Security

**What is protected:**

- Communication with Proton is over HTTPS.
- Backups are end-to-end encrypted client-side with your Proton keys (via the
  official SDK) before upload, so Proton never sees their contents. Optionally,
  `backup_password` also encrypts the backup archive before it leaves Home
  Assistant.
- The app never stores your TOTP/2FA secret or any one-time code — for 2FA
  accounts you type a single-use code into the Web UI at login.
- The Web UI is reachable only through Home Assistant ingress.

**What is *not* protected:**

- Your credentials are stored **unencrypted** on your HA host. App options
  (`proton_password`, `backup_password`) are saved in plaintext by the
  Supervisor — the `password` field type only masks the value in the UI, it does
  not encrypt it on disk — and the Proton session (tokens + derived key
  password) is written in plaintext to the app's `/data`. Anyone with
  file-level access to your host, or to an unencrypted backup of it, can read
  them. This is how all HA app secrets work, but you should know it.

**Recommendations:** keep your HA host secure (disk encryption, restricted file
access, encrypted off-site backups), consider a dedicated Proton account for
backups, and review the source before installing.

This is a **third-party, community app**, **not** affiliated with, endorsed
by, or supported by Proton AG, and it relies on a pre-release (alpha) build of
the Proton Drive SDK. Only install apps you trust.

## Caveat: upcoming Proton crypto migration

Proton has announced a new cryptographic model expected to roll out around late
2026 / 2027. When that lands, the authentication/encryption flow used by the
Proton Drive SDK may change. If logins begin to fail after that migration,
update the app to a version that supports the new model.
