# Proton Drive Backup

Automatically back up Home Assistant to [Proton Drive](https://proton.me/drive)
using the official Proton Drive SDK.

This is a self-contained Home Assistant app (Node.js). It calls the
Supervisor backup API to create backups and uploads them to your Proton Drive on
a schedule, with retention limits and an ingress web UI. There is no companion
custom integration.

## Quick start

1. Add this repository to your app store (Settings → Apps → App store →
   ⋮ → Repositories).
2. Install **Proton Drive Backup**.
3. Enter your Proton email and password, then start the app.
4. Open the web UI to view status and trigger backups. If your account uses 2FA,
   enter a one-time 6-digit code there when prompted to connect.

See [DOCS.md](DOCS.md) for full configuration details.

## Security note

This is a third-party, community app and is not affiliated with Proton AG.
Backups are end-to-end encrypted client-side before upload, and the app never
stores your TOTP/2FA secret. However, your Proton credentials and session are
stored **unencrypted** on your Home Assistant host (as with all HA app
secrets). See [DOCS.md](DOCS.md#security) for the full picture and
recommendations.
