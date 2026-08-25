#!/bin/bash
# Nightly database backup. Dumps with the migrator role and encrypts with a key file.
# Hardened and scheduled in Phase 5; usable by hand before that:
#   MIGRATOR_DATABASE_URL=... BACKUP_TARGET=/backups ./deploy/backup.sh
set -euo pipefail

: "${MIGRATOR_DATABASE_URL:?MIGRATOR_DATABASE_URL is required}"
: "${BACKUP_TARGET:?BACKUP_TARGET is required}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="${BACKUP_TARGET%/}/advisor-${stamp}.dump"

mkdir -p "${BACKUP_TARGET}"
pg_dump --format=custom --no-owner --dbname="${MIGRATOR_DATABASE_URL}" --file="${out}"

if [[ -n "${BACKUP_ENCRYPT_KEY_FILE:-}" ]]; then
  openssl enc -aes-256-cbc -pbkdf2 -salt \
    -pass "file:${BACKUP_ENCRYPT_KEY_FILE}" \
    -in "${out}" -out "${out}.enc"
  rm -f "${out}"
  echo "backup written: ${out}.enc"
else
  echo "backup written (unencrypted; set BACKUP_ENCRYPT_KEY_FILE for production): ${out}"
fi
