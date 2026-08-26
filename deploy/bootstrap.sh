#!/usr/bin/env bash
# One-paste server setup for CM Coding Advisor on a fresh Ubuntu 22.04/24.04 box.
# Run as root (or with sudo):
#
#   ANTHROPIC_API_KEY=sk-ant-... \
#   APP_HOSTNAME=advisor.example.com \
#   ADMIN_EMAIL=you@example.com \
#   ADMIN_PASSWORD='a long password 42' \
#   bash bootstrap.sh
#
# APP_HOSTNAME with a DNS name gets automatic HTTPS. For a quick bare-IP test use
# APP_HOSTNAME=http://<server-ip> (no TLS; fine for a look, not for real use).
# The worker ingests the full corpus on its own after boot (several hours); the
# app is usable immediately and answers improve as sources land.
set -euo pipefail

: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY}"
: "${APP_HOSTNAME:?set APP_HOSTNAME (DNS name, or http://<ip> for a test)}"
: "${ADMIN_EMAIL:?set ADMIN_EMAIL}"
: "${ADMIN_PASSWORD:?set ADMIN_PASSWORD (12+ chars with a letter and a digit)}"
REPO_URL="${REPO_URL:-https://github.com/reuven-ops/Biller.git}"
BRANCH="${BRANCH:-main}"
DIR="${DIR:-/opt/advisor}"

echo "== 1/5 Docker =="
if ! command -v docker > /dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 git openssl
  systemctl enable --now docker
fi

echo "== 2/5 Code =="
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch origin "$BRANCH" && git -C "$DIR" checkout "$BRANCH" && git -C "$DIR" pull --ff-only origin "$BRANCH"
else
  git clone -b "$BRANCH" "$REPO_URL" "$DIR"
fi
cd "$DIR"

echo "== 3/5 Environment =="
if [ ! -f .env ]; then
  cp .env.example .env
  set_env() { sed -i "s|^$1=.*|$1=$2|" .env; }
  set_env ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
  set_env SESSION_SECRET "$(openssl rand -hex 32)"
  set_env POSTGRES_SUPER_PASSWORD "$(openssl rand -hex 16)"
  set_env DB_MIGRATOR_PASSWORD "$(openssl rand -hex 16)"
  set_env DB_APP_PASSWORD "$(openssl rand -hex 16)"
  set_env APP_BASE_URL "$(case "$APP_HOSTNAME" in http*) echo "$APP_HOSTNAME" ;; *) echo "https://$APP_HOSTNAME" ;; esac)"
  set_env LLM_MODE live
  set_env MODELS_DIR /models
  echo "MODELS_ALLOW_DOWNLOAD=1" >> .env
  echo "APP_HOSTNAME=$APP_HOSTNAME" >> .env
  # Container database URLs are set by the compose file; the .env values below are
  # only used when running tools on the host and are rewritten to match.
  set_env DATABASE_URL "postgres://app:$(grep '^DB_APP_PASSWORD=' .env | cut -d= -f2)@127.0.0.1:5432/advisor"
  set_env MIGRATOR_DATABASE_URL "postgres://migrator:$(grep '^DB_MIGRATOR_PASSWORD=' .env | cut -d= -f2)@127.0.0.1:5432/advisor"
  chmod 600 .env
else
  echo ".env exists; keeping it."
fi

echo "== 4/5 Build and start (first build takes a few minutes) =="
docker compose -f deploy/docker-compose.prod.yml --env-file .env up -d --build

echo "== 5/5 Migrate and create the admin =="
docker compose -f deploy/docker-compose.prod.yml --env-file .env run --rm app pnpm db:migrate
docker compose -f deploy/docker-compose.prod.yml --env-file .env run --rm app \
  pnpm users add "$ADMIN_EMAIL" admin --password "$ADMIN_PASSWORD"

echo
echo "Done. Open: $(grep '^APP_BASE_URL=' .env | cut -d= -f2)"
echo "Sign in as $ADMIN_EMAIL. Invite the team from the Admin page."
echo "The worker is ingesting the corpus in the background; watch progress on the Sources page."
