#!/bin/bash
# Runs once when the Postgres data volume first initializes (docker-entrypoint-initdb.d).
# Creates the two database roles from brief section 5 and the advisor database owned by
# the migrator. Passwords come from the container environment (.env via compose).
set -euo pipefail

: "${DB_MIGRATOR_PASSWORD:?DB_MIGRATOR_PASSWORD is required}"
: "${DB_APP_PASSWORD:?DB_APP_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
  CREATE ROLE migrator LOGIN PASSWORD '${DB_MIGRATOR_PASSWORD}';
  CREATE ROLE app LOGIN PASSWORD '${DB_APP_PASSWORD}';
  CREATE DATABASE advisor OWNER migrator;
EOSQL

# pgvector is not marked trusted in every build, so the non-superuser migrator cannot
# CREATE EXTENSION. Install it in template1 so every database created later (including
# test scratch databases) inherits it; migration 0001 is then IF NOT EXISTS.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname template1 \
  -c 'CREATE EXTENSION IF NOT EXISTS vector;'
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname advisor \
  -c 'CREATE EXTENSION IF NOT EXISTS vector;'
