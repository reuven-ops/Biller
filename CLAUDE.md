# CLAUDE.md

Project: CM Coding Advisor, a self-hosted coding and billing question-and-answer tool for ClinicMind billers (chiropractic, behavioral health, physical therapy). Full specification: docs/BRIEF.md (v2, standalone). Read it in full before any work.

## Stack

pnpm workspaces, TypeScript strict, Node 20 or later, Postgres 16 with pgvector, local open-source embedding and reranker models baked into Docker images, Anthropic TypeScript SDK (the only external service at runtime), server-rendered web app, Docker Compose with Caddy, vitest.

## Commands

- pnpm install
- docker compose up -d (local: db, app, worker)
- pnpm db:migrate
- pnpm ingest <source_id> [--limit N]
- pnpm ask "question" [--dos YYYY-MM-DD] [--payer] [--jurisdiction] [--provider] [--client]
- pnpm eval
- pnpm report
- pnpm freshness
- pnpm users add <email> <role>
- pnpm backup | pnpm restore <file>
- pnpm test
- pnpm lint

## Hard rules

1. No answer without evidence_ids retrieved in the current run. Unsupported statements are stripped. Unsupported core elements (bottom line, codes, modifiers) force an abstention.
2. Model memory is never a source for rules, numbers, dates, descriptors, or edit pairs.
3. Tier integrity: published_rules and codes cite tiers 1 to 4 only; contract_terms tier 5 only; our_experience tiers 6 and 7 only; Copy for appeal uses tiers 1 to 4 only.
4. Date-of-service filtering on every structured lookup and every retrieval. Call notes must be unexpired. Remit cells must meet REMIT_MIN_N.
5. CPT_LICENSE_MODE=none means no CPT descriptors are stored or shown anywhere.
6. PHI_MODE=deny means refuse questions and notes containing PHI and do not persist the text. The remit importer rejects files with patient identifier columns and keeps aggregates only.
7. qa_log, qa_feedback, change_events, and call_note_history are append-only, enforced by database grants.
8. Client-scoped evidence is retrievable only by users assigned to that client, enforced in retrieval and re-checked in the verifier.
9. No external services at runtime except api.anthropic.com and the publisher domains in config/egress.yaml. No Slack, no Base44, no SaaS databases, no hosted embeddings.
10. Temperature 0. Model IDs from env. Prompts versioned in packages/core/prompts.
11. Never circumvent access controls or terms of use. Flag and stop.
12. Never fabricate data, URLs, row counts, eval results, or test results.

## Conventions

- Conventional commits, one per milestone. Main branch stays runnable and deployable.
- Committed fixtures and unit tests for every courier, parser, and importer. Integration tests only when RUN_INTEGRATION=1.
- Discovered source URLs go in docs/SOURCES.md with retrieval dates. URLs live in config, not code.
- Decisions and tradeoffs go in docs/DECISIONS.md.
- Docs, Help page, and UI copy: plain, numbered prose written for billers. No em dashes. No emoji.

## Working mode

Write docs/PLAN.md first, then execute the phases in docs/BRIEF.md in order. Do not wait for approval between Phase 0 and Phase 2. Ask only for credentials, the server, the CPT license decision, the payer and jurisdiction lists, the client list, or the remit export. Report at the end of each phase using section 19 of the brief.
