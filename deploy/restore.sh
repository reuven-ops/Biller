#!/bin/bash
# Restore a backup produced by backup.sh. Tested once as a Phase 5 acceptance check.
#   MIGRATOR_DATABASE_URL=... ./deploy/restore.sh <file>
set -euo pipefail

: "${MIGRATOR_DATABASE_URL:?MIGRATOR_DATABASE_URL is required}"
file="${1:?usage: restore.sh <backup file>}"

src="${file}"
if [[ "${file}" == *.enc ]]; then
  : "${BACKUP_ENCRYPT_KEY_FILE:?BACKUP_ENCRYPT_KEY_FILE is required for encrypted backups}"
  src="${file%.enc}.decrypted"
  openssl enc -d -aes-256-cbc -pbkdf2 \
    -pass "file:${BACKUP_ENCRYPT_KEY_FILE}" \
    -in "${file}" -out "${src}"
fi

pg_restore --clean --if-exists --no-owner --dbname="${MIGRATOR_DATABASE_URL}" "${src}"

if [[ "${src}" != "${file}" ]]; then
  rm -f "${src}"
fi
echo "restore complete from ${file}"
