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
Milestone M4.4: remit importer per Appendix B: validation, identifier column rejection, aggregation to remit_behavior, raw file deletion, remit_imports bookkeeping. Code labels come from the D14 gloss pipeline, not source 20 (X12 license declined 2026-08-25): the cms_remit_guides courier, a code_glosses table with evidence ids and draft or approved status, the grounded gloss drafting job through the composer and verifier, the lead review queue, and re-review flags on cited document changes. Codes without public evidence display the bare number with an ask-the-advisor link.
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

## Phase 0 report (2026-08-25)

a. What works, with commands to reproduce.

1. pnpm install, pnpm lint (ESLint, Prettier, strict tsc), and pnpm test all pass from a clean checkout. 15 tests: migration file integrity, config registry integrity, egress allowlist matching, CLI help coverage, and 5 database integration tests.
2. docker compose -f deploy/docker-compose.yml up -d brings up db (pgvector/pgvector:pg16), app, and worker. The db bootstrap creates the migrator and app roles and the advisor database and installs pgvector. Verified: all three containers up, db healthy.
3. pnpm db:migrate applies the 7 migrations covering every table in brief section 5, with indexes for hybrid retrieval (HNSW on embeddings, GIN on tsvector and codes_mentioned, date-window btrees). A second run is a no-op (verified: 0 applied, 7 already applied). A checksum mismatch on an applied migration aborts.
4. Append-only enforcement by database grants, proven by tests: the app role can INSERT and SELECT but not UPDATE, DELETE, or TRUNCATE on qa_log, qa_feedback, change_events, call_note_history, cannot run DDL, and cannot write schema_migrations. GET /healthz on the app reports database connectivity and applied migration count ({"ok":true,"db":{"ok":true,"migrations":7}} verified).
5. The worker starts, syncs the 20-source registry from config/sources.yaml into the sources table, and idles until the Phase 1 scheduler. pnpm freshness prints the freshness table (all sources STALE, never run, which is true). CLI help covers every command in CLAUDE.md; unimplemented commands say which phase they arrive in.
6. GitHub Actions CI: install, lint, role bootstrap, migrate, full test suite with RUN_INTEGRATION=1 against a pgvector service container, dependency audit.

b. What is stubbed or blocked, and why.

1. ANTHROPIC_API_KEY is not present in this environment. Everything model-facing is planned behind one client wrapper with a deterministic stub mode (docs/DECISIONS.md D1); no model calls exist yet in Phase 0.
2. Couriers, retrieval, and the agent loop are Phase 1 and Phase 2 work; the CLI says so instead of pretending.
3. Caddy, backups on a schedule, and production hardening are Phase 5; backup.sh and restore.sh exist and run by hand.

c. Row counts by table and eval results by gate.

1. sources: 20 rows (registry sync from config/sources.yaml). All other tables: 0 rows, nothing ingested yet.
2. Eval harness does not exist yet (Phase 2); no eval results to report.

d. Open risks.

1. The build environment inspects outbound TLS; Docker image builds need the optional CA build argument (D5). Production servers are unaffected.
2. pgvector in the pinned image is not marked trusted; handled at bootstrap (D6).
3. TypeScript resolves to 7.x by default now; pinned to 5.9 for typescript-eslint compatibility. Revisit when typescript-eslint supports 7.

e. Start conditions for Phase 1.

1. Nothing needed from Reuven. Phase 1 begins immediately: discover real publisher URLs, build the couriers with committed fixtures, run full local ingestion, and complete docs/SOURCES.md.

## Phase 1 report (2026-08-25)

a. What works, with commands to reproduce.

1. Couriers for sources 1 through 13 with committed real-file fixtures and 57 passing unit tests (pnpm test). Every URL was discovered live on 2026-08-25 and recorded in docs/SOURCES.md; URLs live in config/sources.yaml. Run any courier with pnpm ingest <source_id> [--limit N]; pnpm freshness shows the dashboard.
2. Full local ingestion completed against the compose database. Every enabled Phase 1 source succeeded. Loads are transactional per document (a failure mid-load rolls back and retries next run), idempotent, and resumable; job locks with heartbeats guard concurrent runs.
3. The scheduler runs in the worker from cadence_days with database job locks (docker compose up -d).
4. The NCCI PTP and MCD couriers perform the CMS end-user license attestations through the publisher's own mechanisms, recorded per run (DECISIONS.md D7, D11), with the CMS_LICENSE_ATTESTATION=refuse kill switch.

b. What is stubbed or blocked, and why.

1. x12_carc_rarc (source 20) is disabled: the X12 Website Terms of Use prohibit scraping and AI use of the lists. Reuven: license the X12 External Code List at ecommerce.x12.org or request written permission (DECISIONS.md D10). Until then remit_behavior (Phase 4) will show raw CARC and RARC codes without labels.
2. Conversion factors before 2026 are not loaded: the per-row column only exists from the 2026 RVU layout on (docs/SOURCES.md section 6). Payment estimates for earlier DOS will say the factor is unavailable.
3. Three IOM chapter revision stamps parse as unknown (clm104c01, c05, c30 use a different title layout); the chapters themselves are fully ingested and chunked.
4. mac_sites, payer_policies, uploads, call notes, and remit import are Phase 4 by design.

c. Row counts by table and eval results by gate.

1. ncci_ptp 2,633,128 (CMS states 2,633,389; the delta is duplicate keys in the published files, deduplicated keeping the row in force, verified by inspection). mue 15,162 (matches the file exactly). mpfs 152,462 across 8 quarterly releases (2024 Q4 to 2026 Q3). codes 71,319 HCPCS rows across 8 quarters. icd10cm 294,173 across FY2025 to FY2027. gpci 327. conversion_factor 3 (2026 Q1 to Q3). telehealth_services 283 (CY 2026). therapy_thresholds 1 (CY 2026: KX $2,480, MR $3,000). documents 5,221 and chunks 15,734 covering the NCCI manual (2026 edition), 6 IOM chapters, 993 transmittals with MLN article PDFs, 477 Federal Register rules (11 PFS rules in full text), 379 active OIG work plan items, ICD-10-CM guidelines, and 3,346 MCD documents (3,001 LCDs and Articles across the 39 configured MAC states plus 345 NCDs).
2. Acceptance checks: 10 of 10 known NCCI PTP pairs match the published file (including the active 98940/97140 edit with modifier indicator 1); 5 of 5 LCD and Article documents verified against the MCD site by external_id and effective date; re-running four couriers wrote 0 rows with identical table totals before and after.
3. Eval harness is Phase 2; no eval results yet.

d. Open risks.

1. Licensing: the X12 block above; the CMS attestations are recorded and reversible; CPT descriptors are dropped everywhere (fixtures redact them).
2. Terms of use: cms.gov robots disallows query-string URLs, so MLN backfills through the explicitly allowed sitemap; federalregister.gov bot mitigation is treated as a hard stop if it ever reaches the API.
3. Parser fragility: CMS re-mints URLs each quarter (scraped, never templated); the PPRRVU layout changed in 2026 (handled dynamically); the therapy page carries amounts only as prose anchored by phrasing; the OIG browse page is labeled Beta.
4. Cost: zero model spend so far. Server capacity: full ingestion wrote roughly 3.5 GB of database and artifacts; well inside the 200 GB production sizing.

e. Start conditions for Phase 2.

1. Nothing needed from Reuven for the engine build. ANTHROPIC_API_KEY is needed to run the live eval gates at Phase 2 exit; without it the harness runs end to end in stub mode and the gates are reported as blocked on the key (D1).

## Phase 2 report (2026-08-25)

a. What works, with commands to reproduce.

1. Local inference: bge-base-en-v1.5 embeddings (768 dimensions, DECISIONS.md D12) and the bge-reranker-base cross encoder run in process from MODELS_DIR with no network calls. The embedding backfill runs as a worker job and resumes where it left off.
2. Hybrid retrieval over the real corpus: pgvector cosine top 60 plus full text and code-match top 60, fused with reciprocal rank fusion, filtered by date of service, jurisdiction, payer, tier, and client scope, then reranked to 12. Spot checks against the live corpus: a KX threshold question returns the tier 1 Federal Register PFS rules containing the KX Modifier Thresholds sections; a chiropractic AT modifier question returns Article A56616 and IOM 100-02 chapter 15 section 240.1.3; a psychotherapy telehealth question returns psychiatry Articles and NCCI manual chapter XI.
3. The full answer path behind pnpm ask "question" [--dos ...]: normalize, PHI screen (regex plus light model), composer with 13 structured lookup and retrieval tools (14 tool call cap, forced submit_answer at the cap), zod-validated answer schema, verifier (deterministic code checks plus model verdicts; unsupported statements stripped; unsupported core elements force abstention), rendered answer with tiered citations, and an append-only qa_log write. Temperature 0, prompts versioned in packages/core/prompts, model IDs and daily cost cap from env.
4. Hard rule enforcement is tested: 19 core unit and integration tests (pnpm test) cover the happy path, fabricated citation abstention, strip and abstain policy, PHI refusal without persistence, client scope stripping in retrieval and re-checking in the verifier, and date of service filtering in every structured tool.
5. The eval harness: pnpm eval runs every Phase 2 item of the 28-item golden set (evals/golden.jsonl, Appendix A), including the stale-corpus scenario for A22, the dual date of service run for A23, and the retrieval ablation for A14 and A17, then prints the section 16 gates with honest statuses and writes evals/results-<ts>.json. pnpm report prints the daily qa_log and qa_feedback rollup.

b. What is stubbed or blocked, and why.

1. ANTHROPIC_API_KEY is absent, so LLM_MODE=stub (DECISIONS.md D1). The stub client exercises the full loop deterministically; it cannot grade answer quality, so gates 1 through 6 and 10 report BLOCKED, never PASS. Reuven: provide the key and run pnpm eval to get the live gate results.
2. Gates 8 and 9 (tier integrity across payer intelligence, client isolation on uploads) need Phase 4 data and report PHASE4.
3. The embedding backfill over the 15,734 chunks is still running at the time of this report (CPU only, about 3 hours end to end); retrieval already works because the text and code arm covers unembedded chunks and the vector arm covers the embedded portion. The worker finishes the backfill unattended.
4. CPT descriptors remain excluded everywhere (CPT_LICENSE_MODE=none); answers show bare codes.

c. Row counts by table and eval results by gate.

1. Corpus unchanged from the Phase 1 report: documents 5,221, chunks 15,734, ncci_ptp 2,633,128, mue 15,162, mpfs 152,462, codes 71,319, icd10cm 294,173, gpci 327, conversion_factor 3, telehealth_services 283, therapy_thresholds 1. New: qa_log rows from harness runs (append only).
2. Gates from the stub run (evals/results-1787655849747.json): gate 1 citation validity BLOCKED; gate 2 groundedness BLOCKED; gate 3 expected evidence BLOCKED; gate 4 abstention BLOCKED (the abstain cases do abstain in stub mode; the answerable side needs live answers); gate 5 ablation BLOCKED (plumbing verified, vacuous under stub); gate 6 date of service awareness BLOCKED; gate 7 PHI refusal PASS (refused and the question text was not persisted); gate 8 PHASE4; gate 9 PHASE4; gate 10 cost and latency BLOCKED (stub numbers are not meaningful).
3. No gate is reported passed on the stub where a pass needs a live model. The single PASS, gate 7, is graded on behavior the stub does not influence.

d. Open risks.

1. Latency: the CPU cross encoder costs about 33 seconds per query after warm-up (71 seconds cold). The section 16 target is p50 under 30 seconds excluding model time; rerank is local model time, but if the all-in feel matters, options are a smaller reranker, fewer rerank candidates, or keeping the worker warm. Flagged for the Phase 3 UI.
2. Anthropic API spend starts at the first live run; the daily cap (COST_DAILY_CAP_USD) is enforced in the loop before each call.
3. The golden set encodes payer1 as UnitedHealthcare and payer2 as Aetna from the hypothesis config; if the real payer list differs, evals/golden.jsonl and config/payers.yaml change together.
4. Unpushed work: all Phase 1 and 2 commits are local until the GitHub secret-scanning unblock link is approved (the redacted Mapbox token in an MLN fixture).

e. Start conditions for Phase 3.

1. Nothing needed from Reuven to start the web app. Needed to close Phase 2 fully: ANTHROPIC_API_KEY for the live gates, and the push unblock click.

## Phase 3 report (2026-08-25)

a. What works, with commands to reproduce.

1. The web application (apps/web) on node:http with no web framework: escaped-by-default server rendering, session cookie auth with scrypt hashes, lockout after five failures, single-use invite links, CSRF on every authenticated POST, role guards for biller, lead, and admin, security headers, and the 30 questions per user per hour limit counted from qa_log. Run with APP_PORT=3100 pnpm --filter @advisor/web start; manage users with pnpm users add|invite|list.
2. Ask: the full section 13.1 rendering contract. The form posts, the agent loop runs in the background, a self-refreshing page shows progress, and the answer renders in tier order with expandable citations (passage text, effective date, retrieval date, source link), Copy for appeal from tiers 1 to 4 only, Correct, Incorrect, Partial feedback writing qa_feedback, Request source on abstentions, and the similar past questions panel from team history. Client-scoped answers are hidden from unassigned users in both the answer view and history.
3. History with mine and team scopes and text and payer search; Help rendered from docs/HELP.md (content written for billers); Sources with per-source freshness, the change digest, the source requests queue, and admin run now, which queues the source for the worker's next scheduler pass (migration 0011); Admin with users, roles, invites, disable, client assignments, cost today and month against the daily cap, and model and prompt versions. Every admin action is written to the append-only admin_audit table (migration 0010).
4. Browser acceptance: apps/web/e2e/ui-drive.mts drives login, ask, and the rendered answer in headless Chromium and saves screenshots; shoot-pages.mts tours the other pages. The 98940 with 97140 question was answered end to end in the browser with correct NCCI citations ($0.37, about 4 minutes under heavy CPU contention).
5. The first live eval pass hardened the verifier: verdict JSON parsing takes the outermost braces with one retry, a failed verdict pass in live mode withholds the answer (fail closed, hard rule 1), and citation metadata is always rewritten from the evidence registry so a model-mislabeled tier cannot pass the tier checks (hard rule 2). 104 tests pass; lint and the dependency audit are clean in CI.

b. What is stubbed or blocked, and why.

1. The live eval run stopped at 22 of 24 items: the Anthropic account ran out of API credits (about $14 spent). Reuven: add credits in the console under Plans and Billing, then pnpm eval reruns the full gate table. Salvaged results from the completed items: gate 1 citation validity PASS (zero invalid citations), gate 7 PHI refusal PASS; gates 2 and 3 were mismeasured by the two verifier bugs fixed above and need the rerun; gates 5 and 6 did not run.
2. Google OIDC stays behind AUTH_GOOGLE_ENABLED=0. Call notes, uploads, remit import, and eval run management in the Admin page are Phase 4 by design.
3. The Phase 3 acceptance item "10 golden questions answered in the UI" is partially evidenced: golden questions ran live through the same ask() path as the UI, and one ran fully in the browser; a full 10-question browser pass waits for the credit top-up.

c. Row counts by table and eval results by gate.

1. New tables: admin_audit (append only, enforced by grants), sources.run_requested_at. Users: 1 admin (Reuven, local dev password to be changed at deploy). qa_log now holds the live eval answers plus browser and CLI asks, about $14 total model spend, all under the $25 daily cap.
2. Live gates so far: 1 PASS, 7 PASS, 2 and 3 remeasure after the verifier fix, 4 FAIL pending diagnosis (five must-answer items abstained: A2, A4, A10, A18, A19; some may trace to the fixed verifier bug, some may be honest corpus gaps), 5 and 6 not run, 8 and 9 Phase 4, 10 FAIL as measured (max cost $1.43 vs the $0.25 target; p50 latency about 200 seconds vs the 30 second target, measured while the embedding backfill saturated the CPU).

d. Open risks.

1. Cost and latency versus the section 16 targets is the biggest open question. Levers: verify prompt cache hits, cap composer tool calls harder, rerank fewer candidates, a smaller reranker or a GPU at deploy; or revisit the targets. Decide after a clean rerun on an idle machine.
2. NCCI manual section labels: some lettered headings (A, E, F, R, S) are missed by the section splitter, so a few chunks carry the previous section's label (the text itself is correct). Fix queued: widen the heading match and re-ingest the manual.
3. The in-memory pending-answer registry loses in-flight questions on an app restart (the page then says ask again). Acceptable for v1; a jobs table would survive restarts.
4. Sandbox-only: the dev password for reuven@espoc.com is local; production accounts arrive by invite link at deploy.

e. Start conditions for Phase 4.

1. Anthropic credits for the eval rerun (blocks the Phase 2/3 gate table, not Phase 4 work).
2. For Phase 4 proper: the real payer list confirmation (payers.yaml is hypothesis), the client list, and a de-identified remit CSV export per Appendix B when available.

## Live gate status addendum (2026-08-25, after three live runs)

Three live runs on 2026-08-25 (full run, full run after verifier hardening, targeted rerun of flipped items) with about $40 of model spend. Statuses below are the current position, with every claim reproducible from qa_log and the evals results files.

1. Gate 1 citation validity: PASS across all runs. Zero fabricated or unresolvable citations in every live answer.
2. Gate 2 groundedness: OPEN, the main quality workstream for Phase 6. Verifier-graded support runs 50 to 100 percent per answer. The verified failure mode is transcription slips on structured facts (one answer stated an NCCI edit's column order backwards; the verifier caught it). Mitigations landed: partial bottom lines ship at low confidence with the verifier's note; next: composer discipline for copying structured tool output verbatim, and a revise-once loop on partial verdicts.
3. Gate 3 expected evidence: remeasure at the next full run; the prior number was dominated by the abstention miscalibration below.
4. Gate 4 abstention: largely closed. Every must-abstain case abstains. The 13 wrong abstentions traced to one policy bug (partial verdicts treated as unsupported); after the fix, 9 of 11 flipped to answers. Remaining two: one oversized answer whose verdict pass failed twice (budget doubled to 16384 tokens since), one composite question the composer should answer for its Medicare half.
5. Gate 5 ablation: PASS with the corrected check. After removing the therapy source the engine re-grounded the KX amounts in the Federal Register PFS rule; the earlier FAIL label penalized redundancy in the corpus.
6. Gate 6 DOS awareness: PASS. The same KX question for DOS 2025 vs 2026 returned $2,410 vs $2,480, each cited to its own year's source.
7. Gate 7 PHI refusal: PASS in every run, sub-second, nothing persisted.
8. Gates 8 and 9: Phase 4 data required.
9. Gate 10 cost and latency: FAIL against the section 16 targets ($0.25, 30s p50). Measured live: $0.05 to $1.49 per answer, p50 around 170s on 4 CPU cores. Options for the decision with Reuven: GPU at deploy, smaller reranker, tighter tool budget, or revised targets.

## Phase 4 report (2026-08-25)

a. What works, with commands to reproduce.

1. Remit importer per Appendix B (packages/ingest/src/remit-importer.ts). Validates the 23 required columns, rejects any file carrying a patient identifier column and any row matching SSN, email, or phone patterns, aggregates in memory to payer, LOB, state, CPT, modifiers, and year cells, writes remit_behavior and a remit_imports bookkeeping row, and never stores the raw file. Live run: the 24-row synthetic fixture produced 5 cells with 0 rejects. Reproduce: upload evals/fixtures/remit/synthetic_remit.csv on the Admin page, or run the unit tests (pnpm vitest run packages/ingest/test/remit-importer.test.ts).
2. The D14 gloss pipeline end to end. The cms_remit_guides courier ingested the MLN remittance booklet and the CCIIO RARC guidance (17 chunks, tier 2). The drafting job found 12 codes in remit_behavior needing glosses and, over live retrieval and the glosser prompt, drafted 3 (group codes CO, OA, PR, each with evidence ids and quotes, status draft) and skipped 9 honestly: for CARCs 16, 50, 97, 119, 197 and RARCs M76, N115, N19, N54 the public corpus holds no defining text, so they render as the bare code number with no published description on file. Nothing was drafted from model memory. Approve or retire drafts on the Admin page; reproduce drafting with the Draft missing glosses button there.
3. Call notes (Phase 4 acceptance item 3): the Appendix C form on the Notes page, PHI screen on the rule text and attachments (a PHI hit persists nothing), unverified-citable on creation, lead approve, retire, reconfirm with a fresh 365-day expiry, append-only call_note_history, and tier 6 corpus chunks whose retired_date tracks expiry. Integration tests cover the round trip at the store and corpus level (pnpm vitest run apps/web/test/integration.notes.test.ts with RUN_INTEGRATION=1).
4. Client contracts and fee schedules: lead uploads on the Admin page chunk PDF, DOCX, CSV, or XLSX contracts as tier 5 with client_id isolation; machine-readable fee schedules also fill client_fee_schedule. Payer policies upload on the Sources page as tier 4 with the portal path as the citation URL. Re-uploading a revised document under the same title supersedes the old version and records a revised change event (Phase 4 acceptance item 2, verified by integration test: pnpm vitest run apps/web/test/integration.contracts.test.ts).
5. The weekly digest (document changes by source and payer, call notes expiring within 30 days, remit cells that crossed REMIT_MIN_N) renders on the Ask and Sources pages. Copy for appeal (tiers 1 to 4 only) and next_action scripts have been in the answer contract since Phases 2 and 3.
6. Payer discovery: all seven hypothesis payers' public libraries verified by live fetch with sample policies and effective dates (docs/SOURCES.md section 22); payers.yaml carries the verified domains. Lint, the dependency audit, and 124 tests pass.

b. What is stubbed or blocked, and why.

1. Automated payer couriers are blocked by payer terms of use, not by engineering (DECISIONS.md D16). All six commercial payers publish public, robots-permitted libraries, and each one's site terms expressly prohibit scraping or systematic downloading. Per hard rule 11 the couriers were not built; leads upload policies instead, which satisfies the same evidence path at tier 4. Florida Medicaid (AHCA) is the exception: public state rulemaking with a robots content signal permitting reference use, so its courier is queued as a fast follow once the payer list is confirmed. Reuven can unblock any commercial payer by obtaining written permission; the discovery record documents each library's mechanics so a courier is quick to build.
2. Phase 4 acceptance item 1 (5 payers ingested with effective dates) is therefore reinterpreted per rule 19.2: seven libraries verified with effective dates visible, ingestion arrives by lead upload rather than courier. The upload path is tested; no real payer policy has been uploaded yet.
3. Real data from Reuven is still pending: the Pareto payer list, the client list with user assignments, and a de-identified remit export per Appendix B. Everything above ran on the synthetic fixture; remit cells therefore sit below REMIT_MIN_N (30), so A26 and gates 8 and 9 wait for real volume.
4. mac_sites (jurisdiction-specific MAC content) waits on the MAC and state footprint decision.

c. Row counts by table.

1. remit_behavior 5 cells from 1 import (24 rows in, 0 rejected, raw file discarded). code_glosses 3 drafts, each with evidence ids and quotes. cms_remit_guides 2 documents, 17 chunks. payer_call_notes 0 in the dev database (integration tests use scratch databases). Corpus total: 5,226 documents, 15,986 chunks.
2. New tables this phase: code_glosses, client_fee_schedule (migration 0012).

d. Open risks.

1. Gloss coverage is thin by design: 3 of 12 codes have public defining text. Coverage grows as payer policies, MAC articles, and appeal templates enter the corpus and mention codes; the honest-gap rendering keeps the product truthful meanwhile. The X12 license (D10) remains the complete fix.
2. The Humana counsel flag from D16: policy PDFs bar storage in a retrieval system, which arguably reaches lead uploads. Counsel should advise before Humana policies are uploaded.
3. Cost and latency versus section 16 targets is unchanged from the Phase 3 addendum and remains the main open decision.

e. Start conditions for Phase 5 (production deployment).

1. The server. deploy/bootstrap.sh is a one-paste Ubuntu setup; docs/RUNBOOK.md covers operations. Nothing else blocks deployment.
2. Nice to have before pilot: Jeremy's payer list, the client list, and the real remit export so gates 8 and 9 can run.
