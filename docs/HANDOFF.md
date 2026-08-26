# Developer handoff guide

This guide is for a development team receiving this codebase to run or integrate it with another back end. Read CLAUDE.md and docs/BRIEF.md before changing anything; the hard rules there are product requirements, not style preferences.

## 1. What this system is

CM Coding Advisor is a complete, self-contained back end: a coding and billing question and answer service for billers, grounded only in retrieved evidence. It is a pnpm workspace in strict TypeScript on Node 22, with Postgres 16 plus pgvector as the only database, local ONNX models for embeddings and reranking, and the Anthropic API as the only external runtime service. The web app is server rendered with no front end framework. Everything ships as Docker containers behind Caddy.

## 2. What is in this archive

1. The archive is the tracked source tree at the commit named in the archive filename. The canonical source is the GitHub repository reuven-ops/Biller, branch claude/project-plan-phases-0-2-5yx01w (pull request 1). Prefer pulling from git over passing archives around, so you get history and future fixes.
2. Not included, on purpose: .env (holds the Anthropic API key; never commit it), the models directory (about 1.5 GB, downloaded at image build), the artifacts directory (courier downloads, rebuilt by ingestion), node_modules, and any database contents.

## 3. Repository layout

1. packages/db: migrations (schema, roles, append-only grants) and the migration runner. The schema is the contract; every table the product depends on is created here.
2. packages/core: the engine. Retrieval (hybrid vector, text, exact code and modifier arms, cross-encoder rerank), the composer and verifier agent loop with the revise-once pass, the evidence registry, the PHI screen, the denial code gloss pipeline, prompts (versioned in packages/core/prompts), local inference, and configuration loaders for the files in config/.
3. packages/ingest: source couriers (CMS manuals, NCCI, MPFS, MCD, Federal Register, and the rest), document and chunk storage with revision detection, the remit CSV importer, and file format helpers.
4. apps/web: the server rendered web app (auth, Ask, History, Notes, Sources, Admin) and the background worker (courier scheduler and embedding backfill).
5. config/: sources.yaml, payers.yaml, jurisdictions.yaml, egress.yaml, provider_types.yaml. URLs and payer lists live here, not in code.
6. deploy/: production docker compose, Dockerfiles, Caddy, backup and restore scripts, and bootstrap.sh, which takes a fresh Ubuntu server from nothing to a signed-in admin in one paste.
7. docs/: BRIEF.md (the specification), PLAN.md (build log and phase reports), DECISIONS.md (why things are the way they are, including licensing decisions D10, D14, D16), SOURCES.md (every source URL with verification dates), RUNBOOK.md (operations), HELP.md (end user help).
8. evals/: the golden question set and the gate runner (pnpm eval).

## 4. Fastest path to running it

1. One-paste server install: follow SETUP_FOR_REUVEN.md, which drives deploy/bootstrap.sh on a fresh Ubuntu server.
2. Local development: pnpm install; docker compose up -d (Postgres with pgvector); copy .env.example values (see section 6); pnpm db:migrate; pnpm --filter @advisor/web start. The worker runs ingestion and embedding backfill; first full ingestion takes hours and the corpus is rebuilt from public sources, not shipped.
3. Tests: pnpm test (unit), and with RUN_INTEGRATION=1 plus the TEST_ variables (see any integration test file header) the scratch-database suites run too. pnpm lint runs eslint, prettier, and the typecheck.

## 5. Integrating with your existing back end

The recommended integration is to run this system unchanged as a service and integrate over HTTP, because the value is in the pipeline (retrieval, composition, verification, ingestion, licensing compliance), and that pipeline needs Postgres with pgvector, local model files, and a long-running worker. Three options, in order of least work:

1. Sidecar service. Deploy as shipped (deploy/docker-compose.prod.yml) and have your application link users to it, or proxy to it. Nothing to port. Single sign on can be added at the reverse proxy or by extending apps/web/src/auth.ts.
2. Library reuse in a Node back end. packages/core, packages/ingest, and packages/db are ordinary workspace packages. A Node service can import ask() from @advisor/core and run the same engine in-process, provided it supplies the same environment (Postgres with pgvector, MODELS_DIR, migrations applied) and keeps the worker running for ingestion. This is the copy and paste path for a Node or NestJS back end.
3. Port to another language or framework. Treat packages as the specification and port module by module, keeping the invariants in section 7. This is the most work and the easiest way to silently lose a safety property; if you port, keep pnpm eval green against your port before trusting it.

There is no JSON API today; the web app is server rendered and browser facing. If your front end needs JSON endpoints (ask, answer status, history), that is a small additive layer over the existing ask() pipeline; ask for it rather than scraping the HTML.

## 6. Environment variables

Required: DATABASE_URL (app role), MIGRATOR_DATABASE_URL (migrations), SESSION_SECRET, ANTHROPIC_API_KEY (live answers; without it LLM_MODE falls back to stub and no real answers compose), MODELS_DIR (embedding and reranker ONNX files).

Behavioral, with defaults: LLM_MODE (live or stub), MODEL_COMPOSER, MODEL_VERIFIER, MODEL_LIGHT (model ids), CPT_LICENSE_MODE (none; do not change without the AMA license, see brief), PHI_MODE (deny), REMIT_MIN_N (30), DAILY_COST_CAP_USD (25), EMBED_INTERVAL_MINUTES (10), EMBEDDING_DIM (768), APP_PORT, APP_BASE_URL, ARTIFACTS_DIR, DEFAULT_PAYER, DEFAULT_TZ, CMS_LICENSE_ATTESTATION, MODELS_ALLOW_DOWNLOAD, MODEL_PRICES_JSON.

## 7. Invariants any integration must preserve

These come from CLAUDE.md and are enforced in code today; an integration that bypasses them ships a different, less safe product.

1. No answer without evidence retrieved in the same run; the verifier strips unsupported statements and withholds answers with unsupported core elements. Never expose the composer output without the verifier.
2. Model memory is never a source for rules, numbers, dates, descriptors, or edit pairs.
3. Tier integrity and date of service filtering on every lookup; client-scoped evidence only for assigned users, enforced in retrieval and re-checked in the verifier.
4. CPT_LICENSE_MODE=none means no CPT descriptors stored or shown. PHI_MODE=deny means PHI questions are refused and never persisted.
5. qa_log, qa_feedback, change_events, and call_note_history are append only, enforced by database grants; keep using the app database role so the grants apply.
6. Runtime egress only to api.anthropic.com and the domains in config/egress.yaml. No payer site scraping: the payer terms of use findings and the lead-upload design are in DECISIONS.md D16.
7. Temperature is never raised; prompts are versioned files; model ids come from env.

## 8. Getting help

The phase reports in docs/PLAN.md record what works, how to reproduce it, and what is stubbed or blocked. DECISIONS.md explains every non-obvious choice. If something in the code seems arbitrary, check those two files before changing it.
