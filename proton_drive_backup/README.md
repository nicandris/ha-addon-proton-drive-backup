# Proton Drive Backup

Automatically back up Home Assistant to [Proton Drive](https://proton.me/drive)
using Proton's official first-party `proton-drive` CLI.

This is a self-contained Home Assistant app (Node.js). It calls the
Supervisor backup API to create backups and uploads them to your Proton Drive on
a schedule, with retention limits and an ingress web UI. **No Proton credentials
are entered into or stored by the app** — you sign in through Proton's own
browser login. There is no companion custom integration.

Requires Home Assistant OS or Supervised, on **amd64** or **aarch64** (Proton
ships no CLI build for other architectures).

## Quick start

1. Add this repository to your app store (Settings → Apps → App store →
   ⋮ → Repositories).
2. Install **Proton Drive Backup** and **Start** it.
3. Open the **Web UI** and click **Connect to Proton Drive**. Open the sign-in
   link it shows on any device (phone or PC) and complete sign-in with Proton
   (including your normal two-factor, if enabled).
4. The app then creates and uploads backups on the configured schedule.

See [DOCS.md](DOCS.md) for full configuration and usage details.

## Security note

This is a third-party, community app and is not affiliated with Proton AG. It
uses Proton's official, MIT-licensed `proton-drive` CLI. Backups are end-to-end
encrypted client-side before upload, and **the app never stores your Proton
password**. The CLI's session token is written to the app's `/data` directory
(as with all HA app storage). See [DOCS.md](DOCS.md#security) for the full
picture and recommendations.
