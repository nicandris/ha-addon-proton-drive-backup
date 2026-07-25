# Proton Drive Backup

This app **mirrors your Home Assistant backups** to
[Proton Drive](https://proton.me/drive) — much like the Google Drive backup
add-on. It does **not** create backups itself. You make backups however you like
in Home Assistant (the built-in automatic backup, manual snapshots, other
add-ons), and this app copies every one of them offsite to your Proton Drive
using Proton's official first-party `proton-drive` CLI — on boot, on a check
interval, and on demand — with retention limits and an ingress web UI.

**No Proton credentials are ever entered into or stored by the app** — you sign
in through Proton's own browser login (see [Authentication](#authentication)).

Requires Home Assistant **OS** or **Supervised** on **amd64** or **aarch64**
(Proton ships no CLI build for other architectures).

## How it works

1. On boot, on the `backup_interval_hours` check interval, and when you click
   **Sync now**, the app lists **all** Home Assistant backups (automatic and
   manual) and everything already in the Proton Drive folder.
2. Any HA backup not yet in Proton Drive is uploaded to the configured folder as
   `<name> (<slug>).tar` (e.g. `Automatic backup 2026.7.3 (a1b2c3d4).tar`). A
   backup counts as already there only if the remote file's **size** matches too,
   so an upload that was interrupted half-way is uploaded again rather than
   trusted. If the Proton folder can't be listed at all, the sync stops with an
   error instead of assuming it is empty.
3. Proton Drive is pruned automatically, in **two independent buckets**:
   `keep_automatic_in_proton` for the scheduled "Automatic backup" archives and
   `keep_app_in_proton` for everything else ("app" backups). Within each bucket
   the oldest (by date) beyond the keep-count are trashed, so a burst of small
   app backups can never evict the important automatic ones. Local Home Assistant
   backups are **only** cleaned up when you press **Clean up local backups**, and
   only when they are already in Proton (see below).

Backups are sorted into the **automatic** vs **app** bucket **by name**: any name
that starts with "Automatic backup" (Home Assistant's own scheduled backups) is
*automatic*; everything else — per-add-on backups, manual snapshots — is *app*.

The CLI has no metadata API, so remote backups are identified by **filename**
plus size. The `(slug)` suffix is the Home Assistant backup's stable, unique id —
it drives deduplication (a backup already in Proton, with a matching size, is
never re-uploaded) and lets restore map a Proton file back to a backup.

## Configuration

Set these on the app's **Configuration** tab, then **Save** and restart the app.

| Option                  | Default                  | Description                                                                                                                                                          |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drive_folder`          | `Home Assistant Backups` | Folder path under your Proton Drive **My files** where backups are stored. Created if it does not exist.                                                             |
| `backup_interval_hours` | `24`                     | How often, in hours, to **check** Home Assistant for new backups to upload. The app also syncs on boot and whenever you click **Sync now**. `0` = check on boot and manually only. |
| `keep_automatic_in_proton` | `10`                  | How many **automatic** backups (name starts with "Automatic backup") to keep in Proton Drive. Older ones beyond this, by date, are trashed automatically each sync. `0` keeps all. |
| `keep_app_in_proton`    | `10`                     | How many **app** backups (everything not named "Automatic backup" — per-add-on backups, manual snapshots) to keep in Proton Drive. `0` keeps all. Independent of the automatic bucket, so an app-backup burst can't evict automatic backups. |
| `keep_automatic_in_ha`  | `0`                      | Newest **automatic** backups to keep locally in Home Assistant. Used **only** by the manual **Clean up local backups** button — never automatically. `0` = keep all automatic (no local clean-up of that bucket). |
| `keep_app_in_ha`        | `0`                      | Newest **app** backups to keep locally in Home Assistant. Used **only** by the manual **Clean up local backups** button. `0` = keep all app backups (no local clean-up of that bucket). |
| `backup_password`       | (empty)                  | Password used to **decrypt** your backups on **restore**, if your Home Assistant backups are encrypted. Leave empty if they are not.                                 |
| `log_level`             | `info`                   | Logging verbosity: one of `trace`, `debug`, `info`, `notice`, `warning`, `error`, or `fatal`. Four levels exist internally, so `trace` behaves as `debug`, `notice` as `info` and `fatal` as `error`. Can also be changed at runtime from the Web UI (which offers the four internal levels).  |

There is **no email / password / 2FA option** — authentication is handled by
Proton's browser sign-in.

### Staging area (and the advanced `STAGING_DIR` override)

When uploading or restoring, the app stages each backup archive as a temporary
`.tar` file. It stages this **outside `/data`** (in the container's ephemeral tmp
dir), because Home Assistant full-backups include the app's `/data` volume — a
multi-GB temp file left there would get swallowed into the next backup and roughly
double its size.

Housekeeping is automatic: any archive left behind by a stop or crash mid-transfer
is deleted the next time the app starts (it logs how much space that reclaimed),
and before downloading a backup the app checks there is enough free space, skipping
that backup with a clear error rather than filling the disk.

`STAGING_DIR` is an **advanced, environment-only override** of that location —
deliberately *not* a Configuration-tab option, since an app can only reach paths its
manifest maps in. Leave it unset unless you know you need it; if you do set it (to
an absolute path), make sure that path is **not** part of any Home Assistant
backup. When it is set, the Web UI's Settings card shows it.

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
- See **statistics** — how many backups are in Home Assistant vs mirrored in
  Proton Drive, split by bucket ("N automatic, M app") with total sizes, host
  disk free, and last-backup / next-sync times.
- See **Settings** — a read-only card showing the effective configuration: drive
  folder, sync interval, the four keep-counts (automatic/app for Proton and HA),
  whether a backup password is set (a boolean — the password itself is never
  shown), and the staging dir if `STAGING_DIR` is set. The status, statistics,
  and settings cards sit **side by side** on wide screens.
- **Sync now** — upload any existing Home Assistant backups not yet in Proton
  Drive. The button shows "Syncing…" and is disabled while a sync is already in
  progress.
- **Clean up local backups** — manually delete local Home Assistant backups
  beyond the newest `keep_automatic_in_ha` automatic / `keep_app_in_ha` app, but
  **only** ones already copied to Proton Drive **and verified there by size** (a
  partial or interrupted upload never counts as offsite). It asks for confirmation
  and then reports how many were deleted and how many were skipped because they
  aren't mirrored yet. This is the **only** way the app deletes local backups — it
  never does so automatically, and it will never delete a backup that isn't safely
  offsite (in either bucket). Disabled when **both** HA keep-counts are `0`.
- **Restore** — restore Home Assistant from one of the backups in Proton Drive.
  The app downloads the chosen archive from Proton, hands it to the Supervisor,
  and starts a full restore. This runs **in the background**: the button returns
  straight away and the status card shows the current step ("Restoring … downloading
  from Proton Drive", then "Home Assistant is restoring…"), so a multi-GB restore
  never looks idle. A restore and a sync can never run at the same time.
- **Delete** — remove a backup from Proton Drive (moves it to the Drive trash).
- Change the **log level** at runtime.

## Security

> **A Home Assistant backup contains your Proton session.** The Proton CLI keeps
> its sign-in session in the add-on's `/data` directory, and Home Assistant's
> *full* backups include add-on data — so any full backup (including the copies
> this add-on uploads) carries a **usable Proton Drive session token**. Treat those
> archives as sensitive: set a `backup_password` so they are encrypted, and be
> careful where you copy them. If an archive leaks, use **Disconnect** in the
> panel (or sign the session out from your Proton account) to invalidate it.


**What is protected:**

- Communication with Proton is over HTTPS.
- Backups are end-to-end encrypted client-side by Proton (via the `proton-drive`
  CLI) before upload, so Proton never sees their contents. If your Home Assistant
  backups are themselves encrypted, set `backup_password` so the app can decrypt
  them when restoring.
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
  `activeRevision.value.claimedSize`). Debug logs list only the file names and
  sizes the app actually uses — not Proton's raw payload, which carries internal
  node/revision ids.
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
