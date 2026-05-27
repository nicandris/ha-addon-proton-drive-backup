#!/usr/bin/with-contenv bashio
export PROTON_EMAIL="$(bashio::config 'proton_email')"
export PROTON_PASSWORD="$(bashio::config 'proton_password')"
export DRIVE_FOLDER="$(bashio::config 'drive_folder')"
export BACKUP_INTERVAL_HOURS="$(bashio::config 'backup_interval_hours')"
export BACKUPS_IN_PROTON="$(bashio::config 'backups_in_proton')"
export BACKUPS_IN_HA="$(bashio::config 'backups_in_ha')"
export FULL_BACKUP="$(bashio::config 'full_backup')"
if bashio::config.has_value 'backup_password'; then
    export BACKUP_PASSWORD="$(bashio::config 'backup_password')"
else
    export BACKUP_PASSWORD=""
fi
export LOG_LEVEL="$(bashio::config 'log_level')"
export PORT=8099
export DATA_DIR=/data
bashio::log.info "Starting Proton Drive Backup..."
exec node /app/dist/main.mjs
