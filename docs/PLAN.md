# CM Coding Advisor: Build Plan

This plan maps every phase in docs/BRIEF.md section 17 to milestones, tasks, and acceptance checks. One conventional commit per milestone. Phase reports are appended to the end of this file in the format of brief section 19.7 as each phase completes.

Build environment for Phases 0 to 2: a Linux container with Node 22, pnpm 10, Docker with Compose, Postgres 16 with pgvector, and outbound network access to cms.gov, federalregister.gov, govinfo.gov, oig.hhs.gov, and huggingface.co. ANTHROPIC_API_KEY is not present in this environment; everything that needs a live model call is built complete and runnable, exercised in tests through a deterministic stub client behind an env flag, and verified live once the key is supplied. See docs/DECISIONS.md D1.

## Phase 0. Scaffold (days 1 to 2)

Milestone M0.1: repo and workspace scaffold.

1. pnpm workspace with packages/db, packages/ingest, packages/core, apps/web, apps/cli, evals.
2. TypeScript strict mode in a shared tsconfig base; Node 20 or later engines field; ES modules.
3. ESLint and Prettier configured at the root; pnpm lint runs both.
4. vitest at the root; pnpm test runs all workspace tests.
5. Root scripts per CLAUDE.md: db:migrate, ingest, ask, eval, report, freshness, users, backup, restore, test, lint.
6. .env.example with every variable from brief section 18; .gitignore excludes .env and artifacts.

Acceptance checks:

1. pnpm install completes from a clean checkout.
2. pnpm lint passes.
3. pnpm test runs and passes with the initial test suite.

Milestone M0.2: database migrations and roles.

1. SQL migrations for every table in brief section 5, in dependency order, with indexes for retrieval (pgvector index on chunks.embedding, GIN on chunks.tsv, GIN on chunks.codes_mentioned, btree on effective and deletion dates for structured tables).
2. Roles: migrator (DDL owner) and app. App role gets INSERT and SELECT only on qa_log, qa_feedback, change_events, call_note_history; full DML elsewhere; no DDL.
3. Migration runner in packages/db (plain SQL files, ordered, recorded in a schema_migrations table) using MIGRATOR_DATABASE_URL.
4. Vector dimension parameterized at migration time from EMBEDDING_DIM so the Phase 2 model choice sets the column type.
5. Generated TypeScript types for table rows in packages/db.

Acceptance checks:

1. Migrations apply cleanly to an empty Postgres 16 database with pgvector.
2. A second run of pnpm db:migrate is a no-op.
3. An automated test proves the app role cannot UPDATE or DELETE on the four append-only tables and cannot run DDL.

Milestone M0.3: Docker Compose for local development and CI.

1. deploy/docker-compose.yml with db (pgvector/pgvector:pg16), app, worker; volumes for data, artifacts, and backups; Postgres not published outside the compose network except a localhost dev port.
2. Dockerfile.app and Dockerfile.worker building the workspace; caddy service definition prepared for Phase 5 but not required locally.
3. GitHub Actions CI: install, lint, typecheck, test with a Postgres 16 pgvector service container, dependency audit.
4. Docs skeleton: docs/SOURCES.md, docs/DECISIONS.md, docs/RUNBOOK.md, docs/HELP.md placeholders with intended structure.
5. apps/cli entry with help text for every subcommand, wired to real implementations as they land.

Acceptance checks (brief Phase 0 gate):

1. docker compose up -d brings up db and app locally.
2. pnpm db:migrate applies cleanly against the compose database.
3. pnpm test green.
4. CI configuration runs the same checks on push.

## Phase 1. Federal spine (weeks 1 to 2)

Couriers for sources 1 through 13 and 20 from brief section 6, each with committed fixtures and parser unit tests, plus the scheduler. Real download URLs are discovered at build time and recorded in docs/SOURCES.md with retrieval dates; URLs live in config/sources.yaml, never in code.

Milestone M1.1: ingestion framework.

1. Fetch layer with egress allowlist enforcement from config/egress.yaml, retries with backoff, conditional requests where the publisher supports them, and raw artifact storage with SHA-256 under the artifacts volume.
2. Document store: document rows per external_id and version_hash; supersession; change_events on new, revised, retired.
3. Chunker for narrative documents per brief section 8.4: heading split, 500 to 1,000 token target, 80 token overlap, section_path, codes_mentioned extraction.
4. PDF extractor on pdfjs with heading heuristics and a quality flag that skips garbled documents.
5. Structured loaders write SQL tables directly, never embeddings.
6. Scheduler in the worker: node-cron driven by cadence_days, database job locks with heartbeats, dead lock takeover after 30 minutes, idempotent resume.
7. ingest_runs bookkeeping and pnpm ingest <source_id> [--limit N].

Acceptance checks:

1. Unit tests green for fetcher (allowlist, hashing), chunker (section paths, overlap, code extraction), and the job lock protocol under simulated contention.
2. Re-running any courier against unchanged fixtures writes zero new rows.

Milestone M1.2: structured code-set couriers: cms_ncci_ptp, cms_ncci_mue, cms_hcpcs, cms_mpfs, cms_icd10cm, cms_telehealth_list, x12_carc_rarc.

1. One courier per source: discover current URL, download, parse, load with per-row effective and deletion dates and file_version.
2. MPFS loader also fills conversion_factor and gpci; CPT descriptors from the RVU file are dropped unless CPT_LICENSE_MODE=licensed.
3. HCPCS loader fills codes(code_set=HCPCS); ICD-10-CM loader fills icd10cm and codes(code_set=ICD10CM).
4. Committed fixture excerpts for every file format under evals/fixtures; parser tests assert row shapes, date semantics, and known values from the fixture.

Acceptance checks:

1. Each parser test green against fixtures.
2. Full local ingestion loads each table; row counts logged in ingest_runs and sanity-checked against counts stated by the publisher where available.
3. 10 known code pairs spot-checked in ncci_ptp against the published file.

Milestone M1.3: narrative couriers: cms_mcd, cms_ncci_manual, cms_iom, cms_mln, cms_therapy, fedreg, oig_workplan.

1. cms_mcd: full MCD database download, filtered to configured MACs and states from config/jurisdictions.yaml, with revision history and per-document effective and retirement dates; the keyless Coverage API is the fallback.
2. cms_iom: the chapters listed in brief section 6.8, hash-checked PDFs, chunked with section paths.
3. cms_mln: article and transmittal index with a three year backfill.
4. cms_therapy: therapy threshold page, KX amounts by calendar year, prior years backfilled from MLN.
5. fedreg: Federal Register keyless API, agency CMS, PFS and related rules, backfill from 2019, full text, tagged by topic.
6. oig_workplan: active items with added dates.
7. Fixtures and parser tests for every format.

Acceptance checks (brief Phase 1 gate, checked across M1.2 and M1.3):

1. Row counts logged per table and sanity-checked against each source's stated counts where available.
2. 10 known code pairs spot-checked in ncci_ptp.
3. 5 LCDs or Articles for the configured MACs verified against the MCD website by external_id and effective date.
4. A re-run of the full ingestion produces zero duplicate rows.
5. docs/SOURCES.md complete with discovered URLs and retrieval dates.

## Phase 2. Engine (weeks 2 to 4)

Milestone M2.1: local inference.

1. Choose the embedding model and cross-encoder reranker from the brief's candidates after confirming availability; record the choice and vector dimension in docs/DECISIONS.md.
2. Embedding and rerank inference in the worker and app via @huggingface/transformers with model files baked into the Docker images at build time; no network calls at runtime.
3. Embedding backfill job for chunks; batch size tuned for CPU.

Acceptance checks:

1. Deterministic unit test: same text yields the same vector; cosine self-similarity 1.0.
2. Model files load from the local path with the network blocked.

Milestone M2.2: retrieval and agent tools.

1. Hybrid retrieval per brief section 9: pgvector cosine top 60, tsvector top 60 with exact code matching, reciprocal rank fusion, DOS window filter, jurisdiction, payer, doc_type, tier, client visibility, cross-encoder rerank to top 12, evidence objects.
2. The 13 tools from brief section 9 as Claude tool definitions backed by SQL and retrieval, every result carrying evidence_ids and tiers.
3. Evidence registry per run: the composer can cite only evidence_ids issued during the run.

Acceptance checks:

1. Retrieval unit tests: DOS filtering includes and excludes versions correctly; client-scoped chunks invisible to unassigned users; code match boosts the right chunk.
2. Tool tests against seeded fixture data for every tool.

Milestone M2.3: agent loop, composer, verifier.

1. Loop per brief section 10: normalize, PHI screen, composer with tools (maximum 14 calls), submit_answer schema validation, verifier, renderer, qa_log.
2. Prompts versioned at packages/core/prompts: composer.md, verifier.md, phi_screen.md.
3. Verifier per brief section 11, with the citation and client checks performed in code.
4. Anthropic client wrapper: temperature 0, model IDs from env, prompt caching, 40K token evidence cap, cost accounting against DAILY_COST_CAP_USD, and a deterministic stub implementation behind LLM_MODE=stub for tests and for building without a key.
5. CLI ask with the flags from CLAUDE.md; renderer prints tier-ordered sections with citations and freshness warnings.

Acceptance checks:

1. Schema validation rejects malformed answers; unsupported statements are stripped; unsupported core elements force abstention (unit tests with the stub client).
2. qa_log rows contain evidence, verifier output, models, prompt versions, tokens, cost, latency.

Milestone M2.4: eval harness and gates.

1. evals/golden.jsonl seeded from Appendix A with reviewer fields empty until the lead coder review.
2. evals/run.ts implements gates 1 to 10 from brief section 16; pnpm eval prints per-gate results and writes them to the database.
3. Ablation support: a harness mode that removes therapy threshold documents and conversion_factor rows in a transaction, runs A14 and A17, and restores.
4. pnpm report and pnpm freshness wired.

Acceptance checks (brief Phase 2 gate):

1. Gates 1 to 7 and 10 in section 16 pass. Gates that require live composer and verifier calls run once ANTHROPIC_API_KEY is present; until then the harness runs end to end under LLM_MODE=stub to prove plumbing, and the gate results are reported as blocked on the key, never as passed.

## Phase 3. Web application (weeks 4 to 5)

Milestone M3.1: auth and shell. Local accounts, invites, sessions, password policy, lockout, roles, CSRF, rate limit 30 questions per user per hour.
Milestone M3.2: Ask page with the full answer rendering contract from brief section 13.1, feedback buttons, request source, add call note shortcut.
Milestone M3.3: History, Help (rendered from docs/HELP.md), Similar past questions.
Milestone M3.4: Sources page: freshness, run now, change digest, source requests queue.

Acceptance checks (brief Phase 3 gate):

1. End-to-end in a browser; 10 golden questions answered in the UI with citations.
2. Feedback rows written; rate limit and PHI refusal visible in the UI.

## Phase 4. Payer intelligence (weeks 5 to 6)

Blocked on Reuven for: Jeremy's Pareto payer list, the MAC and state footprint, the client list and user assignments, and the Appendix B remit export. Until supplied, the payers.yaml and jurisdictions.yaml hypothesis defaults from brief section 18 stand.

Milestone M4.1: payer policy couriers for the top 5 payers in payers.yaml with hash diff and PDF extraction; portal PDF upload for leads.
Milestone M4.2: client contract uploads with client_id isolation; client_fee_schedule parsing when machine-readable.
Milestone M4.3: call notes: Appendix C form, PHI screen, unverified citable, lead approve, retire, reconfirm, expiry, call_note_history, corpus chunking at tier 6.
Milestone M4.4: remit importer per Appendix B: validation, identifier column rejection, aggregation to remit_behavior, CARC and RARC labels from source 20, raw file deletion, remit_imports bookkeeping.
Milestone M4.5: weekly digest, Copy for appeal (tiers 1 to 4 only), next_action call scripts.

Acceptance checks (brief Phase 4 gate):

1. 5 payers ingested with effective dates.
2. A simulated policy revision produces a change event and appears in the digest.
3. Call note round trip: add, cite as unverified, approve, cite as approved, expire, excluded.
4. A sample remit CSV produces cells and A26 passes.
5. Gates 8 and 9 in section 16 pass.

## Phase 5. Production deployment (week 6)

Blocked on Reuven for: the Linux VM with Docker and SSH access, the hostname, and the backup target.

Milestone M5.1: production compose with caddy; HTTPS with automatic certificates or internal CA; .env on the server only.
Milestone M5.2: nightly encrypted backups, restore.sh, log rotation, health endpoint, cost cap alert at 80 percent.
Milestone M5.3: docs/RUNBOOK.md: restart, backup and restore, key rotation, adding a payer source, fixing a failed courier; egress allowlist documented for the firewall.

Acceptance checks (brief Phase 5 gate):

1. Fresh server from SETUP_FOR_REUVEN.md to running app in under one hour of hands-on time.
2. Restore test passes.
3. All containers restart cleanly after a reboot.

## Phase 6. Day-1 readiness (week 7)

Blocked on Reuven for: pilot user names and emails; the lead coder's review of Appendix A.

Milestone M6.1: full ingestion on the production server; freshness dashboard green for every enabled source.
Milestone M6.2: eval run on production passes all section 16 gates; lead coder golden-set review recorded in evals/golden.jsonl.
Milestone M6.3: pilot users created; docs/HELP.md finalized; first 10 Appendix A questions verified in the UI.
Milestone M6.4: five business day pilot with three billers; feedback review; rollout checklist in docs/RUNBOOK.md.

Acceptance checks (brief Phase 6 gate):

1. The day-1 definition in brief section 1 is met, then the pilot definition of done.

## Phase 7. CPT licensed content (when the AMA agreement is amended)

Blocked on Reuven for: the amended AMA agreement and the CPT Standard Data File path.

Milestone M7.1: loader for the AMA data file at CPT_DATA_FILE_PATH; descriptors populate codes; CPT_LICENSE_MODE=licensed enables display.
Milestone M7.2: evals re-run.

Acceptance checks (brief Phase 7 gate):

1. Section 16 gates still pass with descriptors enabled.

---

# Phase reports

Phase reports are appended below as each phase completes, in the format of brief section 19.7.
