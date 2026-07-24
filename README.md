# Proton Drive Backup for Home Assistant

A Home Assistant **app** that automatically **mirrors your Home Assistant
backups** to [Proton Drive](https://proton.me/drive) — like the Google Drive
backup add-on. It does not create backups itself; it copies the ones you already
make in Home Assistant offsite. It shells out to Proton's
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

- **Mirrors your Home Assistant backups to Proton Drive** — like the Google
  Drive backup add-on. It does **not** create backups; you make them however you
  like in Home Assistant (built-in automatic backup, manual snapshots, other
  add-ons).
- Uploads **all** Home Assistant backups (automatic and manual) not yet present
  to a folder in your Proton Drive using the official `proton-drive` CLI,
  deduping by the backup's slug (remote name `<name> (<slug>).tar`).
- Syncs on boot, on a configurable check interval, and on demand (**Sync now**).
- Prunes Proton Drive automatically using **two independent retention buckets**
  — *automatic* (backups named "Automatic backup") vs *app* (everything else) —
  so a burst of small per-add-on backups can never evict the important scheduled
  ones. Local Home Assistant clean-up is **manual only** and never deletes a
  backup that isn't already in Proton.
- Provides an ingress web UI to connect/disconnect, view status and statistics,
  sync now, clean up local backups, restore, and delete backups.

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
| `backup_interval_hours` | int      | `24`                     | Hours between checks for new Home Assistant backups to upload. The app also syncs on boot and via **Sync now**. `0` = boot + manual only. |
| `keep_automatic_in_proton` | int   | `10`                     | Newest **automatic** backups (name starts with "Automatic backup") to keep in Proton Drive (older ones trashed automatically each sync). `0` = keep all. |
| `keep_app_in_proton`    | int      | `10`                     | Newest **app** backups (everything else — per-add-on backups, manual snapshots) to keep in Proton Drive. `0` = keep all. Independent bucket, so an app-backup burst can't evict automatic backups. |
| `keep_automatic_in_ha`  | int      | `0`                      | Newest local **automatic** backups to keep in HA. Used **only** by the manual **Clean up local backups** button. `0` = keep all (no clean-up of that bucket). |
| `keep_app_in_ha`        | int      | `0`                      | Newest local **app** backups to keep in HA. Used **only** by the manual **Clean up local backups** button. `0` = keep all (no clean-up of that bucket). |
| `backup_password`       | password | (empty)                  | Password to **decrypt** your backups on **restore**, if your Home Assistant backups are encrypted. Leave empty otherwise. |
| `log_level`             | list     | `info`                   | One of `trace`, `debug`, `info`, `notice`, `warning`, `error`, `fatal`.                                              |

There is **no email / password / 2FA option** — authentication is handled by
Proton's browser sign-in (see below).

The app mirrors **all** your Home Assistant backups. Proton retention runs
automatically; local clean-up is manual and only ever removes backups already
copied to Proton (it never deletes an un-mirrored backup).

## Web UI

The app exposes an ingress web UI (the **Proton Backup** sidebar panel, or
**Open Web UI** on the app page) where you can:

- **Connect to Proton Drive** / **Disconnect** — sign in or out (see below).
- View **status**, **statistics**, and **settings** — a connection badge,
  schedule, last/next sync, backups-in-HA vs mirrored-in-Proton counts split by
  bucket ("N automatic, M app") and sizes, host disk free, any last error, a
  read-only **Settings** card (drive folder, sync interval, the four keep-counts,
  whether a backup password is set — boolean only — and the staging dir if
  overridden), plus a **live sync indicator**: while a sync runs, an animated
  **Syncing…** badge shows the current step (e.g. *"Uploading 2 of 3:
  &lt;name&gt;"*) with a progress bar. On wide screens the cards sit side by side.
- **Sync now** — upload any existing Home Assistant backups not yet in Proton. It
  shows "Syncing…" and is disabled while a sync is already running.
- **Clean up local backups** — manually delete local Home Assistant backups
  beyond the newest `keep_automatic_in_ha` automatic / `keep_app_in_ha` app, but
  only ones already copied to Proton (never an un-mirrored backup, in either
  bucket). Reports how many were deleted vs skipped.
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
Supervisor backup API. On boot, on the check interval, or when you click **Sync
now** it:

1. Lists **all** Home Assistant backups (automatic + manual) and everything in
   the Proton Drive folder.
2. Downloads any HA backup whose slug isn't already in Proton from the Supervisor
   (staged in a temp dir **outside `/data`** — see below) and uploads it to the
   Drive folder as `<name> (<slug>).tar`. A backup that HA lists but can no
   longer serve (a `404` on download — a stale/phantom entry) is skipped with a
   warning rather than failing the whole sync.
3. Prunes Proton Drive in two independent buckets — `keep_automatic_in_proton`
   for "Automatic backup" archives and `keep_app_in_proton` for the rest (oldest
   by date within each). Local Home Assistant clean-up is **not** part of the
   sync — it happens only when you press **Clean up local backups**, and only for
   backups already in Proton.

Downloads are staged in the container's ephemeral tmp dir, **not** under
`/data`, because HA full-backups include the app's `/data` volume — staging a
multi-GB `.tar` there would let a backup swallow it. Override the staging
location with the optional **`STAGING_DIR`** environment variable if you need to
point it elsewhere.

**Restore** downloads the chosen backup from Proton Drive and hands it to the
Supervisor, which performs the restore.

The CLI has no metadata API, so remote backups are identified by **filename**.
The `(slug)` suffix is the HA backup's stable, unique id, used to deduplicate
uploads; retention sorts by each Proton entry's date.

## Security

**What is protected:**

- **Encrypted in transit.** All communication with Proton happens over HTTPS.
- **End-to-end encrypted at rest in Proton Drive.** Backups are encrypted
  client-side by Proton (via the `proton-drive` CLI) before upload, so Proton's
  servers never see their contents. If your Home Assistant backups are themselves
  encrypted, set `backup_password` so the app can decrypt them when restoring.
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
  CLI (`proton-drive` v0.6.0). The `filesystem list --json` output shape it emits
  is still being nailed down between CLI releases; the app parses it defensively
  (as of 0.2.4 it reads the CLI's `Result`-wrapped `name` and the size at
  `activeRevision.value.claimedSize`) and logs the raw output at debug level.
- **Per-sync skip of un-servable backups.** If HA lists a backup but returns a
  `404` when the app tries to download it (a stale/phantom entry), that backup is
  skipped with a warning each sync. Delete the entry in HA to silence it.
- **Long-running session refresh.** Whether the CLI's session refreshes cleanly
  in a container that runs for a very long time is not yet confirmed. If the
  session ever expires, just click **Connect to Proton Drive** again.
