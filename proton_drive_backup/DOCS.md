# Proton Drive Backup

This app automatically backs up your Home Assistant instance to
[Proton Drive](https://proton.me/drive). It runs entirely inside a single
container: it asks the Supervisor to create backups, then uploads them to your
Proton Drive using Proton's official first-party `proton-drive` CLI, on a
schedule, with retention limits and an ingress web UI.

**No Proton credentials are ever entered into or stored by the app** — you sign
in through Proton's own browser login (see [Authentication](#authentication)).

Requires Home Assistant **OS** or **Supervised** on **amd64** or **aarch64**
(Proton ships no CLI build for other architectures).

## How it works

1. On a schedule (`backup_interval_hours`), the app calls the Supervisor
   backup API to create a backup of Home Assistant, named
   `Proton Drive Backup <ISO timestamp>`.
2. Any of the app's backups not yet in Proton Drive are uploaded to the
   configured folder as `<name>.tar`.
3. Old backups are pruned from both Proton Drive and Home Assistant according to
   your retention settings.

The CLI has no metadata API, so backups are identified purely by **filename**.
Only backups named `Proton Drive Backup <timestamp>` (those created by this app)
are pruned — any backups you create manually or with other tools are left
untouched.

## Configuration

Set these on the app's **Configuration** tab, then **Save** and restart the app.

| Option                  | Default                  | Description                                                                                                                                                          |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drive_folder`          | `Home Assistant Backups` | Folder path under your Proton Drive **My files** where backups are stored. Created if it does not exist.                                                             |
| `backup_interval_hours` | `24`                     | How often, in hours, to create and upload a backup. Set to `0` to never auto-create a backup — the app still uploads and prunes existing backups (upload-only mode). |
| `backups_in_proton`     | `10`                     | How many of the app's backups to keep in Proton Drive. Older ones beyond this count are trashed. `0` keeps all.                                                     |
| `backups_in_ha`         | `4`                      | How many of the app's backups to keep locally in Home Assistant. `0` keeps all.                                                                                     |
| `full_backup`           | `true`                   | `true` for full backups, `false` for partial (Home Assistant only) backups.                                                                                          |
| `backup_password`       | (empty)                  | Optional password to encrypt the backup archive itself. Leave empty for unencrypted backups.                                                                         |
| `log_level`             | `info`                   | Logging verbosity: one of `trace`, `debug`, `info`, `notice`, `warning`, `error`, or `fatal`. Can also be changed at runtime from the Web UI.                        |

There is **no email / password / 2FA option** — authentication is handled by
Proton's browser sign-in.

### Optional: `STAGING_DIR` environment override

When uploading or restoring, the app stages each backup archive as a temporary
`.tar` file. It stages this **outside `/data`** by default (in the container's
ephemeral tmp dir), because Home Assistant full-backups include the app's
`/data` volume — a multi-GB temp file left there would get swallowed into the
next backup and roughly double its size. You normally never need to change this.

If you do need to relocate the staging area, set the `STAGING_DIR` environment
variable to an absolute path. It is an environment override (not a
Configuration-tab option); just make sure the path you choose is **not** part of
any Home Assistant backup.

## Authentication

You never type Proton credentials into this app. Sign-in is a browser flow
driven by Proton's own login:

1. In the **Web UI**, click **Connect to Proton Drive**. The app runs
   `proton-drive auth login`, which prints a Proton sign-in URL.
2. The UI shows that URL as a link. Open it **on any device** (phone or PC) and
   complete sign-in there. This is where your password and, if enabled, your
   normal **two-factor** are handled — by Proton's own login page, not by this app.
3. When you finish, the page switches to **Connected** automatically. The CLI
   persists its session under the app's `/data` directory, so it survives
   restarts without asking you to sign in again.

To sign out, click **Disconnect**, which runs `proton-drive auth logout` and
drops the persisted session.

If the session ever expires (see [Known limitations](#known-limitations)), just
click **Connect to Proton Drive** again.

## Web UI

Click **Open Web UI** (the ingress panel, also available in the sidebar as
"Proton Backup") to:

- **Connect to Proton Drive** / **Disconnect** — sign in or out (see
  [Authentication](#authentication)).
- View **status** — a connection badge, schedule, last backup time, next
  scheduled run, and any last error.
- Watch the **live status indicator** — while a sync is running the status card
  shows an animated **Syncing…** badge with the current step (for example
  *"Uploading 2 of 3: &lt;name&gt;"*) and a progress bar, so a long multi-minute
  upload never looks frozen. When idle it shows a plain badge.
- **Back up now** — trigger an immediate backup and upload. The button shows
  "Syncing…" and is disabled while a sync is already in progress.
- **Restore** — restore Home Assistant from one of the backups in Proton Drive.
  The app downloads the chosen archive from Proton, hands it to the Supervisor,
  and starts a full restore.
- **Delete** — remove a backup from Proton Drive (moves it to the Drive trash).
- Change the **log level** at runtime.

## Security

**What is protected:**

- Communication with Proton is over HTTPS.
- Backups are end-to-end encrypted client-side by Proton (via the `proton-drive`
  CLI) before upload, so Proton never sees their contents. Optionally,
  `backup_password` also encrypts the backup archive before it leaves Home
  Assistant.
- **The app never stores your Proton password** or two-factor secrets — sign-in
  happens entirely in Proton's browser login. This is a significant improvement
  over the app's previous design.
- The Web UI is reachable only through Home Assistant ingress.

**What to be aware of:**

- The CLI's **session token** is written to the app's `/data` directory
  (Supervisor-managed storage) via the CLI's `unsafe_file` credentials store —
  the container has no OS keyring, so the session lives as a plain file there.
  Anyone with file-level access to your host, or to an unencrypted backup of it,
  could read that session. This is how HA app storage works generally; be aware
  of it.

**Recommendations:** keep your HA host secure (disk encryption, restricted file
access, encrypted off-site backups), and use **Disconnect** to revoke the
session when you no longer need it.

This is a **third-party, community app**, **not** affiliated with, endorsed
by, or supported by Proton AG. It uses Proton's official, MIT-licensed
`proton-drive` CLI. Only install apps you trust.

## Known limitations

- **Early software.** This app is new and bundles a pinned, early build of the
  CLI (`proton-drive` v0.6.0). The `filesystem list --json` output shape it emits
  is still evolving between CLI releases; the app parses it defensively (as of
  0.2.4 it reads the CLI's `Result`-wrapped `name` and the size at
  `activeRevision.value.claimedSize`) and logs the raw output at debug level.
- **Session persists in `/data`.** The CLI session is stored as a plain file in
  the app's `/data` directory via the CLI's `unsafe_file` credentials store (the
  container has no OS keyring) — see [Security](#security).
- **Per-sync skip of un-servable backups.** If Home Assistant lists a backup but
  returns `404` when the app tries to download it (a stale/phantom entry), that
  backup is skipped with a warning on **every** sync until you delete the entry
  in Home Assistant.
- **Long-running session refresh.** Whether the CLI's session refreshes cleanly
  in a container that runs for a very long time is not yet confirmed. If the
  session ever expires, click **Connect to Proton Drive** again to re-establish it.
