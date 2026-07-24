# Proton Drive Backup for Home Assistant

A Home Assistant **app** that automatically backs up your Home Assistant
instance to [Proton Drive](https://proton.me/drive). It shells out to Proton's
official first-party [`proton-drive`](https://proton.me/support/proton-drive-cli)
command-line tool (MIT-licensed) for all Drive operations and for sign-in, so
**no Proton credentials are ever entered into or stored by this app** — you sign
in through Proton's own login in a browser.

> This is an **app**, not a custom integration. It runs as its own container
> alongside Home Assistant and therefore requires Home Assistant OS or
> Supervised. It is **not** available on Home Assistant Core or Container
> installations (which have no Supervisor / app system).
>
> *"Apps" is Home Assistant's term, as of release 2026.2, for what were
> previously called "add-ons" — the same thing, renamed in the UI.*

## What it does

- Creates Home Assistant backups via the Supervisor backup API.
- Uploads each backup to a folder in your Proton Drive using the official
  `proton-drive` CLI.
- Runs on a configurable schedule, with retention limits for both Proton Drive
  and local Home Assistant backups.
- Provides an ingress web UI to connect/disconnect, view status, trigger
  backups, restore, and delete backups.

Everything — the scheduler, the Supervisor API client, the `proton-drive` CLI,
and the web UI — runs in a single Node.js container. There is no companion
custom integration to install.

## Requirements

- Home Assistant **OS** or **Supervised** (apps are unavailable on Core /
  Container).
- Architecture **amd64** or **aarch64**. Proton ships no `armv7`/`i386` build of
  the CLI, so the app cannot be installed on those platforms.
- A Proton account. You sign in through Proton's own browser login (including
  your normal two-factor, if enabled) — see [Authentication](#authentication).

## Installation

1. In Home Assistant, go to **Settings → Apps → App store**.
2. Click the **⋮** menu (top right) → **Repositories**.
3. Add this repository's URL and click **Add**, then close the dialog.
4. Find **Proton Drive Backup** in the store and click **Install**.
5. Open the **Configuration** tab, adjust the options below, and **Save**.
6. **Start** the app, then open the **Web UI** and click **Connect to Proton
   Drive** to sign in. Optionally enable "Start on boot" and "Watchdog".

## Configuration

| Option                  | Type     | Default                  | Description                                                                                                          |
| ----------------------- | -------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `drive_folder`          | string   | `Home Assistant Backups` | Folder path under your Proton Drive **My files** where backups are stored (created if missing).                      |
| `backup_interval_hours` | int      | `24`                     | Hours between automatic backups. `0` = never auto-create a backup (upload-only: the app still uploads/prunes existing backups). |
| `backups_in_proton`     | int      | `10`                     | How many of this app's backups to keep in Proton Drive. `0` = keep all.                                             |
| `backups_in_ha`         | int      | `4`                      | How many of this app's backups to keep locally in Home Assistant. `0` = keep all.                                  |
| `full_backup`           | bool     | `true`                   | `true` for full backups, `false` for partial (Home Assistant only).                                                 |
| `backup_password`       | password | (empty)                  | Optional password to encrypt the backup archive itself. Leave empty for unencrypted.                                |
| `log_level`             | list     | `info`                   | One of `trace`, `debug`, `info`, `notice`, `warning`, `error`, `fatal`.                                              |

There is **no email / password / 2FA option** — authentication is handled by
Proton's browser sign-in (see below).

Only backups named `Proton Drive Backup <timestamp>` (those created by this
app) are pruned by the retention settings; your other backups are left alone.

## Web UI

The app exposes an ingress web UI (the **Proton Backup** sidebar panel, or
**Open Web UI** on the app page) where you can:

- **Connect to Proton Drive** / **Disconnect** — sign in or out (see below).
- View **status** — connection state, schedule, last/next sync, and any last error.
- **Back up now** — trigger an immediate backup and upload.
- **Restore** — restore Home Assistant from one of the backups in Proton Drive.
- **Delete** — remove a backup from Proton Drive.
- Change the **log level** at runtime.

## Authentication

You never type Proton credentials into this app. Sign-in is a browser flow
driven entirely by Proton's own login:

1. In the Web UI, click **Connect to Proton Drive**. The app runs
   `proton-drive auth login`, which prints a Proton sign-in URL.
2. The UI shows that URL as a link. Open it **on any device** (phone or PC) and
   complete sign-in there — this is where your password and, if enabled, your
   normal **two-factor** are handled, by Proton's own login page.
3. Once you finish, the page switches to **Connected** automatically. The CLI
   persists its session under the app's `/data` directory, so it survives
   restarts. There is no code to type into this app and no credential to store.

To sign out, click **Disconnect** (which runs `proton-drive auth logout` and
drops the persisted session).

## How it works

```
Home Assistant Supervisor  <--  app (Node.js)  -->  Proton Drive
        (backup API)                 |            (proton-drive CLI)
                                 scheduler
                                 ingress web UI
```

The app is granted `hassio_api` with the `manager` role so it can drive the
Supervisor backup API. On its schedule (or when you click **Back up now**) it:

1. Asks the Supervisor to create a backup named
   `Proton Drive Backup <ISO timestamp>` (only when `backup_interval_hours > 0`).
2. Lists both sides, downloads any of its backups not yet in Proton from the
   Supervisor, and uploads them to the Drive folder as `<name>.tar`.
3. Prunes each side down to its retention count — only ever touching backups
   this app created.

**Restore** downloads the chosen backup from Proton Drive and hands it to the
Supervisor, which performs the restore.

The CLI has no metadata API, so backups are identified purely by **filename**.
The timestamped name sorts chronologically, which is how retention decides what
to prune.

## Security

**What is protected:**

- **Encrypted in transit.** All communication with Proton happens over HTTPS.
- **End-to-end encrypted at rest in Proton Drive.** Backups are encrypted
  client-side by Proton (via the `proton-drive` CLI) before upload, so Proton's
  servers never see their contents. You can additionally set `backup_password`
  to have the Supervisor encrypt the backup archive itself before it ever leaves
  Home Assistant.
- **No Proton password stored.** This app never receives or stores your Proton
  password or two-factor secrets — sign-in happens entirely in Proton's browser
  login. This is a significant improvement over the previous design.
- **UI is gated by Home Assistant.** The web UI is served only through HA
  ingress, so it's reachable only by users already authenticated to Home
  Assistant.

**What to be aware of:**

- The CLI's **session token** is written to the app's `/data` directory
  (Supervisor-managed storage) using the CLI's `unsafe_file` credentials store —
  the container has no OS keyring, so the session lives as a plain file there.
  Anyone with file-level access to your HA host, or to an unencrypted
  backup/snapshot of it, could read that session. Keep your HA host secure
  (full-disk encryption, restricted SSH/file access, encrypted off-site backups),
  and use **Disconnect** to revoke the session when needed.

## Third-party disclaimer

This is a **third-party, community** app. It is **not** affiliated with,
endorsed by, or supported by Proton AG. It uses Proton's official, MIT-licensed
`proton-drive` CLI. Install only if you trust this app.

## Known limitations

- **Early software.** This app is new and bundles a pinned, early build of the
  CLI (`proton-drive` v0.6.0).
- **`filesystem list --json` output shape.** The exact JSON shape the CLI emits
  is still being validated against real accounts; the app parses it defensively
  and logs the raw output at debug level.
- **Long-running session refresh.** Whether the CLI's session refreshes cleanly
  in a container that runs for a very long time is not yet confirmed. If the
  session ever expires, just click **Connect to Proton Drive** again.
