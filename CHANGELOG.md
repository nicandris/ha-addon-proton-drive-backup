# Changelog

> The authoritative, Home Assistant-displayed changelog is
> [`proton_drive_backup/CHANGELOG.md`](proton_drive_backup/CHANGELOG.md) — that
> is the source of truth with the full per-release history. This root file is a
> convenience pointer with the latest release highlights only.

## Latest release highlights

- **0.2.4** — Fixed "No backups in Proton Drive" and duplicate re-uploads: the
  CLI serialises each `filesystem list` entry's `name` as a `Result` object
  (`{ ok, value }`) and the size at `activeRevision.value.claimedSize`; the
  listing parser now reads those. Also the root cause of the earlier
  `name.startsWith is not a function` crash.
- **0.2.3** — Live status indicator in the Web UI: a connection badge plus an
  animated **Syncing…** badge showing the current step (e.g. *"Uploading 2 of
  3: &lt;name&gt;"*) and a progress bar; "Back up now" shows "Syncing…" and is
  disabled while a sync runs.
- **0.2.2** — Temp downloads now stage **outside `/data`** (HA full-backups
  include `/data`, which let a backup swallow a staged temp and roughly double
  in size); override with the `STAGING_DIR` env var. Backups that HA lists but
  `404`s on download are skipped with a warning instead of erroring every sync.
- **0.2.1** — Type-guarded listing and an **overlapping-sync guard** (only one
  sync runs at a time; extra triggers are skipped); raw `list` JSON is logged at
  debug level.
- **0.2.0** — Switched to Proton's official first-party `proton-drive` CLI, with
  browser sign-in (no Proton credentials entered into or stored by the app);
  backups identified by filename; `amd64`/`aarch64` only.
