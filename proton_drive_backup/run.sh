#!/usr/bin/with-contenv bashio
export DRIVE_FOLDER="$(bashio::config 'drive_folder')"
export BACKUP_INTERVAL_HOURS="$(bashio::config 'backup_interval_hours')"
export BACKUPS_IN_PROTON="$(bashio::config 'backups_in_proton')"
export BACKUPS_IN_HA="$(bashio::config 'backups_in_ha')"
if bashio::config.has_value 'backup_password'; then
    export BACKUP_PASSWORD="$(bashio::config 'backup_password')"
else
    export BACKUP_PASSWORD=""
fi
export LOG_LEVEL="$(bashio::config 'log_level')"
export PORT=8099
export DATA_DIR=/data
# proton-drive CLI configuration:
#  - unsafe_file store avoids the OS keyring (absent in a bare Alpine container).
#  - XDG_DATA_HOME points at HA's persistent /data so the session survives restarts
#    (written under $XDG_DATA_HOME/proton-drive-cli/).
export PROTON_DRIVE_CREDENTIALS_STORE=unsafe_file
export XDG_DATA_HOME="${DATA_DIR:-/data}"
export PROTON_DRIVE_BIN=/usr/local/bin/proton-drive
bashio::log.info "Starting Proton Drive Backup..."
exec node /app/src/main.mjs
