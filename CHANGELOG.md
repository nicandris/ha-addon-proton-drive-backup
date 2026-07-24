# Changelog

> The authoritative, Home Assistant-displayed changelog is
> [`proton_drive_backup/CHANGELOG.md`](proton_drive_backup/CHANGELOG.md) — that
> is the source of truth with the full per-release history. This root file is a
> convenience pointer with the latest release highlights only.

## Latest release highlights

- **0.4.0** — **Split retention into two independent buckets: automatic vs app**,
  classified **by name** (a name starting with "Automatic backup" is *automatic*;
  everything else is *app*). Previously a single total per side let a burst of
  small per-add-on "app" backups evict the important scheduled "Automatic backup"
  ones. **Config migration:** `backups_in_proton` → `keep_automatic_in_proton` +
  `keep_app_in_proton` (both default `10`); `backups_in_ha` → `keep_automatic_in_ha`
  + `keep_app_in_ha` (both default `0`). The HA-clean-up safety invariant (never
  delete an un-mirrored backup) now holds independently in each bucket. The Web UI
  gains a read-only **Settings** card (password shown only as a boolean) and
  per-bucket counts in the statistics card.
- **0.3.0** — **New mirror model.** The add-on no longer creates backups; it now
  **mirrors Home Assistant's own backups** (automatic + manual) to Proton Drive,
  deduping by the HA backup slug (remote name `<name> (<slug>).tar`). "Back up
  now" became **Sync now**; a new **Clean up local backups** button deletes local
  HA backups beyond the newest `backups_in_ha` **only if already copied to
  Proton** (never deletes an un-mirrored backup). Proton retention now sorts by
  the Proton entry's date. Two-column Web UI (status + stats side by side) with
  dark mode preserved. The `full_backup` option was removed.
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
