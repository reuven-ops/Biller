# Runbook

Written for whoever operates the server. Sections 5 to 7 are completed in Phase 5 and 6.

## 1. First deployment (one paste)

On a fresh Ubuntu 22.04 or 24.04 server (4 vCPU, 16 GB RAM, 200 GB disk), as root:

    ANTHROPIC_API_KEY=sk-ant-... \
    APP_HOSTNAME=advisor.example.com \
    ADMIN_EMAIL=you@example.com \
    ADMIN_PASSWORD='a long password 42' \
    BRANCH=claude/project-plan-phases-0-2-5yx01w \
    bash <(curl -fsSL https://raw.githubusercontent.com/reuven-ops/Biller/claude/project-plan-phases-0-2-5yx01w/deploy/bootstrap.sh)

Notes:

1. APP_HOSTNAME with a DNS name pointed at the server gets automatic HTTPS from Caddy. For a quick bare-IP test use APP_HOSTNAME=http://<server-ip>; do not run the team on plain http.
2. The app is up within minutes. The worker ingests the full corpus by itself (several hours) and fills embeddings as it goes; the Sources page shows progress. Answers work immediately and get stronger as sources land.
3. The models (embedding and reranker, about 500 MB) download once into a Docker volume on first start. Firewall note: outbound HTTPS to huggingface.co is needed for that first start only; the runtime allowlist is section 6.
4. Open the printed URL on any browser, including a phone. Invite the team from the Admin page; invite links are valid 7 days.

## 2. Restart the application

    cd /opt/advisor
    docker compose -f deploy/docker-compose.prod.yml --env-file .env restart app worker

A restart never duplicates courier runs (database job locks) and never loses answers (qa_log is in Postgres). A question in flight during a restart is lost; the asker sees ask again.

## 3. Update to a new version

    cd /opt/advisor
    git pull --ff-only
    docker compose -f deploy/docker-compose.prod.yml --env-file .env up -d --build
    docker compose -f deploy/docker-compose.prod.yml --env-file .env run --rm app pnpm db:migrate

## 4. Backup and restore

Nightly encrypted backups are Phase 5 work (deploy/backup.sh, BACKUP_TARGET in .env). Manual backup now:

    docker compose -f deploy/docker-compose.prod.yml --env-file .env exec db \
      pg_dump -U postgres -Fc advisor > advisor-$(date +%F).dump

Restore with deploy/restore.sh or pg_restore into an empty database created by the initdb roles script.

## 5. Rotate the Anthropic API key and the session secret

Edit /opt/advisor/.env (chmod 600), replace ANTHROPIC_API_KEY or SESSION_SECRET, then restart app and worker (section 2). Rotating SESSION_SECRET signs everyone out and invalidates unaccepted invite links.

## 6. Firewall egress allowlist

Outbound HTTPS only, to: api.anthropic.com and the publisher domains in config/egress.yaml (cms.gov and subdomains, federalregister.gov, govinfo.gov, oig.hhs.gov, configured MAC and payer domains), plus huggingface.co for the first model download only. Nothing else. Postgres is never exposed outside the compose network.

## 7. Fix a failed courier

The Sources page marks a failed source with error and shows the last error. An admin's Run now button queues it for the next scheduler pass (within 15 minutes). From the shell:

    docker compose -f deploy/docker-compose.prod.yml --env-file .env run --rm worker \
      pnpm exec tsx apps/cli/src/index.ts ingest <source_id>

CMS re-mints many URLs each quarter; couriers discover current URLs from the publisher pages, so a persistent failure usually means the publisher changed a page layout. docs/SOURCES.md records where each URL comes from.
