# CM Coding Advisor: Build Brief for Claude Code (v2, standalone)

Version 2.0, 2026-08-24. Owner: Reuven Lirov, COO, ClinicMind. Supersedes v1. Changes: self-hosted standalone deployment with one external dependency (the Anthropic API); web application for billers replaces Slack and Base44; payer intelligence layer (call notes, client contracts, remittance behavior) with evidence authority tiers; deployment and day-1 readiness phases so the finished build is usable by billers the day it ships.

Place this file at docs/BRIEF.md and CLAUDE.md at the repo root.

## How to start

Paste this as the first message in Claude Code, from the repo folder containing the two files:

> Read CLAUDE.md and docs/BRIEF.md in full. Write docs/PLAN.md mapping every phase in the brief to milestones, tasks, and acceptance checks. Then start Phase 0 immediately and continue through Phase 2 without waiting for me. Do not ask questions the brief already answers. If a credential, server, or licensed file is missing, stub it behind an env flag, record it in docs/SOURCES.md or docs/DECISIONS.md, and keep going. Report using the format in section 19 at the end of each phase.

## 1. Mission and definition of day-1 usable

Build an internal question-and-answer tool that behaves like a senior CPC and biller for chiropractic, behavioral health, and physical therapy, and that:

1. Answers only from a governed corpus stored on a server ClinicMind controls. Model memory is never a source for rules, numbers, dates, edit pairs, or descriptors.
2. Cites every statement to a specific document, section, effective date, retrieval date, and link, and labels the authority tier of every citation.
3. Is date-of-service aware: the answer reflects the version in force on the DOS.
4. Stays current through scheduled couriers that download from official publishers, with a freshness SLO surfaced in every answer.
5. Captures what payers do not publish: client contracts, call notes with reference numbers, and remittance behavior mined from ClinicMind's own claims data, all labeled as lower-tier evidence.
6. Abstains when the corpus does not support an answer and tells the user which source or call would resolve it.
7. Runs as a web application with logins, roles, and an append-only audit log, with no external service other than the Anthropic API and public document downloads.

Day-1 usable means all of the following are true on the day pilot billers receive logins:

1. Full ingestion of sources 1 through 13 has completed on the production server and the freshness dashboard shows every enabled source green.
2. All eval gates in section 16 pass on the production server.
3. Pilot user accounts exist, the Help page is written, and the first 10 questions from Appendix A answer correctly in the UI with citations.
4. Backups run nightly and a restore has been tested once.
5. docs/RUNBOOK.md covers restart, backup and restore, key rotation, adding a payer source, and fixing a failed courier.

Definition of done for the pilot: Jeremy's lead coder runs the golden questions in Appendix A through the UI and rates at least 26 of 28 as "I would act on this," with zero uncited assertions found in review; three pilot billers use the tool for five business days with at least 85 percent of feedback marked correct or partial.

## 2. Non-negotiables

1. No citation, no claim. Every rule, threshold, dollar amount, time requirement, modifier, code status, or edit pair in an answer must map to an evidence record retrieved during that run. Unsupported statements are stripped. If a core element (bottom line, code, modifier) is unsupported, the agent abstains.
2. No memorized rules. The composer prompt forbids it, the verifier enforces it, and the ablation test in section 16 proves it.
3. Tier integrity. A statement about what Medicare or a payer requires may only be supported by tier 1 to 4 evidence. Tier 5 to 7 evidence supports statements framed as contract terms or ClinicMind experience, and appeal text uses tiers 1 to 4 only.
4. DOS filtering on every structured lookup and every policy retrieval.
5. CPT gating. CPT_LICENSE_MODE=none by default: CPT codes appear by number only; descriptors are never generated, stored, or displayed. Descriptors load only from the AMA data file path when CPT_LICENSE_MODE=licensed.
6. PHI gating. PHI_MODE=deny by default: questions or notes that appear to contain PHI are refused with de-identification instructions and the text is not persisted. The remittance importer rejects files that contain patient identifier columns and persists aggregates only.
7. Append-only logs. qa_log, qa_feedback, change_events, and call_note_history accept INSERT and SELECT only for the application database role.
8. No external services at runtime other than api.anthropic.com and document downloads from the allowlisted publisher domains in config/egress.yaml. Model files for local embeddings and reranking are baked into the Docker image at build time.
9. Never circumvent a source's access controls, robots directives, or terms of use. If a source blocks automation, stop and flag it.
10. Pinned and versioned: model IDs from env, prompt files versioned, source document version hashes stored with each answer. Temperature 0 for composer and verifier.

## 3. Users, scope, defaults

Users and roles:

1. biller: ask questions, view own history, search team history, add call notes.
2. lead: everything a biller can do, plus approve or retire call notes, review feedback flagged incorrect, request sources, upload payer policies.
3. admin: everything, plus users, client assignments, contract uploads, source configuration, remittance imports, eval runs, cost caps.

Initial users: Reuven (admin), Jeremy (admin), Jeremy's lead coder (lead), three pilot billers (biller), then the RCM team.

In scope for v1: professional claims (CMS-1500 / 837P) coding and billing for DC, PT/PTA, OT/OTA, and behavioral health provider types (psychiatrist, psychologist, LCSW, MFT, MHC/LPC, NP/PA in BH); Medicare Part B, Medicare Advantage, commercial, Medicaid FFS and MCOs for configured states.

Out of scope for v1: chart-to-code automation, autonomous claim edits, facility and inpatient coding, DRG/APC, ICD-10-PCS, risk adjustment/HCC, dental, DME, outbound payer calls, Slack, Base44.

Defaults when a question omits them. State the default in the answer and note what changes if it differs:

1. DOS: today in America/New_York.
2. Payer: Medicare Part B. When the MAC matters, use the MACs in config/jurisdictions.yaml and show divergence.
3. Provider type: infer from context; if ambiguous, answer for the most likely type and flag it.
4. Setting: office, POS 11.
5. Client: none. If the user selects a client they are assigned to, tier 5 contract evidence for that client becomes retrievable.

## 4. Architecture and stack

Single-server deployment with Docker Compose. TypeScript throughout, pnpm workspaces, Node 20 or later.

```
cm-coding-advisor/
  CLAUDE.md
  SETUP_FOR_REUVEN.md
  docs/            BRIEF.md PLAN.md SOURCES.md DECISIONS.md RUNBOOK.md HELP.md (rendered in app)
  config/          sources.yaml payers.yaml jurisdictions.yaml provider_types.yaml egress.yaml
  packages/db      migrations (SQL), roles, generated types
  packages/ingest  couriers, parsers, diffing, scheduler, remit importer
  packages/core    retrieval, local embeddings and rerank, tools, agent loop, answer schema
  apps/web         web application (server-rendered React or Next.js) with API routes; auth
  apps/cli         ask | ingest | eval | report | freshness | users | backup
  deploy/          docker-compose.yml Caddyfile Dockerfile.app Dockerfile.worker backup.sh restore.sh
  evals/           golden.jsonl, run.ts, fixtures/
```

Services in docker-compose.yml:

1. db: Postgres 16 with the pgvector extension (image pgvector/pgvector:pg16 or equivalent). Volumes for data and backups.
2. app: web application and API. Stateless. Talks to db and to api.anthropic.com only.
3. worker: courier scheduler, ingestion, local embedding and rerank inference, remit importer, weekly digest, nightly backup trigger. One instance. Job locks in the database so a restart never duplicates a run.
4. caddy: HTTPS reverse proxy. Automatic certificates when the hostname is public; internal CA or ClinicMind's existing proxy when it is not. Document both in RUNBOOK.md.

Server sizing (hypothesis, adjust after Phase 1 measurements): Ubuntu 24.04, 4 vCPU, 16 GB RAM, 200 GB SSD. Embedding runs on CPU. A full initial ingestion may take several hours; that is acceptable.

Local inference (no vendor): use @huggingface/transformers (Transformers.js) or a small Python sidecar to run an open-source embedding model (candidates: bge-base-en-v1.5 at 768 dimensions, nomic-embed-text-v1.5, gte-base) and a cross-encoder reranker (candidate: bge-reranker-base). Confirm availability at build time, pick one of each, record the choice and the vector dimension in docs/DECISIONS.md, and bake the model files into the worker and app images.

LLM: Anthropic TypeScript SDK (@anthropic-ai/sdk). MODEL_COMPOSER=claude-sonnet-5, MODEL_VERIFIER=claude-sonnet-5, MODEL_LIGHT=claude-haiku-4-5-20251001 for the PHI screen, change digests, and note summarization. Confirm current model IDs at docs.claude.com before pinning. Use prompt caching on the system prompt and tool definitions. Cap evidence context at 40K tokens per answer. Daily spend cap from env with an admin alert at 80 percent.

Outbound network allowlist (config/egress.yaml, enforced in the fetch layer and documented for the firewall): api.anthropic.com, cms.gov and subdomains, federalregister.gov, govinfo.gov, oig.hhs.gov, configured MAC domains, configured payer and Medicaid domains. Nothing else at runtime.

## 5. Data model

Write migrations from this outline. Two database roles: migrator (DDL) and app (DML with INSERT and SELECT only on append-only tables).

- sources(id text pk, name, publisher, kind [download|html|pdf|upload|import], base_url, cadence_days int, tier int, jurisdiction text[], payer, lob, license_required bool, enabled bool, last_run_at, last_success_at, last_error, config jsonb)
- documents(id uuid pk, source_id fk, external_id text, doc_type text, title, url, version_hash text, effective_date date, revision_date date, retired_date date, superseded_by uuid, tier int, jurisdiction text[], payer, lob, client_id nullable, retrieved_at timestamptz, storage_path, metadata jsonb, unique(source_id, external_id, version_hash))
- chunks(id uuid pk, document_id fk, section_path text, ordinal int, text, token_count int, embedding vector(DIM), tsv tsvector, tier int, client_id nullable, effective_date, retired_date, codes_mentioned text[], metadata jsonb)
- codes(code_set [CPT|HCPCS|ICD10CM], code, short_desc, long_desc, status, effective_date, end_date, version, pk(code_set, code, version)). CPT descriptors stay null unless CPT_LICENSE_MODE=licensed.
- ncci_ptp(column1, column2, modifier_indicator char(1), effective_date, deletion_date, rationale, file_version, pk(column1, column2, effective_date))
- mue(code, mue_value int, adjudication_indicator text, rationale, effective_date, deletion_date, file_version)
- mpfs(code, modifier, year, quarter, status_indicator, work_rvu, pe_rvu_fac, pe_rvu_nonfac, mp_rvu, total_fac, total_nonfac, global_days, mult_proc, bilateral, assistant_surg, co_surg, pctc, effective_date, file_version)
- conversion_factor(year, quarter, value, source_document_id)
- gpci(locality_code, locality_name, state, year, work, pe, mp)
- icd10cm(code, description, chapter, billable bool, effective_date, end_date, version)
- payer_call_notes(id, payer, plan_product, lob, state, codes text[], modifiers text[], topic, rule_as_stated, rep_name, call_reference, call_date, called_by_user_id, client_id nullable, claim_example_id nullable, rep_confidence [stated|implied|unsure], status [unverified|lead_approved|retired], approved_by, approved_at, expires_on, reconfirmed_on, created_at)
- call_note_history(id, note_id, action, actor_user_id, ts, snapshot jsonb) append-only
- remit_behavior(payer, payer_id, lob, state, cpt, modifiers text[], year, claims_n, denied_n, paid_n, top_carc jsonb, top_rarc jsonb, appealed_n, overturned_n, avg_allowed, import_id, computed_at, pk(payer_id, lob, state, cpt, modifiers, year))
- remit_imports(id, filename, rows_in, rows_rejected, cells_written, imported_by, imported_at, notes)
- clients(id, name, external_ref, active) and user_clients(user_id, client_id)
- users(id, email, name, role [biller|lead|admin], password_hash, status, created_at, last_login_at), sessions, invites
- qa_log(id uuid, ts, user_id, question_text nullable, question_meta jsonb, dos, payer, jurisdiction, provider_type, client_id nullable, evidence jsonb, answer jsonb, verifier jsonb, models jsonb, prompt_versions jsonb, tokens_in, tokens_out, cost_usd, latency_ms, phi_flag bool, abstained bool) append-only
- qa_feedback(id, qa_id fk, user_id, verdict [correct|incorrect|partial], note, ts) append-only
- change_events(id, document_id, change_type [new|revised|retired], diff_summary, detected_at, notified_at) append-only
- source_requests(id, qa_id, requested_by, payer_or_source, note, ts, status)
- ingest_runs(id, source_id, started_at, finished_at, status, rows_written, error, notes)
- job_locks(job_name pk, locked_by, locked_at, heartbeat_at)
- metrics_daily(day, answers_n, abstain_n, cost_usd, p50_ms, p95_ms, feedback_correct_n, feedback_incorrect_n, feedback_partial_n)

## 6. Source registry (config/sources.yaml)

Columns: id | publisher and content | how fetched | cadence_days | tier | DOS semantics | license.

1. cms_mcd | Medicare Coverage Database: NCDs, LCDs, Local Coverage Articles including Billing and Coding Articles with code lists; filter to configured MACs and states; keep revision history | full database download from the MCD site (the keyless Coverage API is a fallback if the download format proves brittle) | 7 | 3 | effective and retirement dates per document | CMS end-user license attestation
2. cms_ncci_ptp | NCCI PTP edits, practitioner services | quarterly file download | 91 | 2 | effective_date and deletion_date per pair; modifier indicator 0, 1, or 9 | public
3. cms_ncci_mue | MUE practitioner services | quarterly file download | 91 | 2 | effective and deletion dates per row | public
4. cms_ncci_manual | NCCI Policy Manual for Medicare Services, all chapters | annual PDF download | 365 | 2 | version year | public
5. cms_hcpcs | HCPCS Level II quarterly update | quarterly file download | 91 | 2 | add and termination dates | public
6. cms_mpfs | PFS RVU files (quarterly A, B, C, D), conversion factor, GPCI, status indicators, global days, multiple procedure flags | quarterly zip download | 91 | 2 | file version by year and quarter | descriptors in the file are AMA CPT; do not store them unless licensed
7. cms_icd10cm | ICD-10-CM code tables, tabular, index, Official Guidelines; October 1 annual plus April update | file download | 182 | 2 | fiscal-year version | public domain
8. cms_iom | Internet-Only Manuals: 100-02 Ch. 15 (therapy sections 220 to 230, chiropractic section 240); 100-04 Ch. 1, 5, 12, 30; 100-08 Ch. 3 | PDF download | 30, hash check | 2 | revision date on the chapter | public
9. cms_mln | MLN Matters articles and Transmittals index; backfill three years | HTML and PDF download | 7 | 2 | article date and implementation date | public
10. cms_telehealth_list | List of Medicare Telehealth Services | xlsx download | 91 | 2 | year and revision | public
11. cms_therapy | Therapy Services page: KX threshold amounts, medical review threshold, related MLN; backfill prior years from MLN | HTML download | 91 | 2 | calendar year | public
12. fedreg | Federal Register: agency CMS, rules and proposed rules; full text for PFS and related rules; backfill from 2019; tag by topic | keyless public endpoint or govinfo bulk XML; no account | 1 | 1 | publication and effective dates | public
13. oig_workplan | OIG Work Plan active items | HTML download | 30 | 2 | added date | public
14. mac_sites | MAC provider education pages for chiropractic, therapy, and behavioral health, configured per MAC | HTML and PDF download, hash diff | 7 | 3 | page revision date | public; respect terms of use
15. payer_policies | Commercial and Medicare Advantage reimbursement and medical policies; Medicaid provider handbooks; configured in payers.yaml; leads may also upload policy PDFs obtained from portals | HTML and PDF download, hash diff; upload | 7 | 4 | policy effective and revision dates | public or portal; respect terms of use
16. client_contracts | Client payer contracts, fee schedules, and amendments uploaded by admins, tagged by client and payer | upload | on upload | 5 | contract effective and termination dates | confidential; visible only to users assigned to the client
17. payer_call_notes | Structured notes from payer calls entered through the web form | in-app | continuous | 6 | call_date; expires 365 days after call_date unless reconfirmed | internal
18. remit_behavior | Aggregated payer adjudication behavior computed from de-identified claim-line exports from ClinicMind's RCM data | monthly import | 30 | 7 | year of DOS | internal; aggregates only
19. ama_cpt | CPT Standard Data File and guidelines from a licensed file path | file | 365 | 2 | annual | gated by CPT_LICENSE_MODE
20. x12_carc_rarc | CARC and RARC code lists for denial mapping | HTML download | 120 | 2 | update cycle | public; Phase 4, needed to label remit_behavior

Rule: actual download URLs change. Discover the current URL for each source at build time, record it with the retrieval date in docs/SOURCES.md, and keep URLs in config, not code.

## 7. Evidence authority tiers

Every document, chunk, and citation carries a tier. Answers group evidence by tier and label it.

1. Statute and regulation: Federal Register rules, CFR text when retrieved.
2. CMS national instructions and code sets: IOMs, NCCI edits and manual, MPFS, HCPCS, ICD-10-CM, MLN, telehealth list, OIG.
3. MAC guidance: LCDs, Local Coverage Articles, MAC education pages.
4. Payer published policy: reimbursement and medical policies, provider manuals, Medicaid handbooks, including portal PDFs uploaded by leads.
5. Client contract: contracts, fee schedules, amendments for the selected client.
6. Payer call note: what a representative stated, with reference number, date, and caller. Unverified notes are citable but labeled; lead-approved notes rank above unverified; expired notes are excluded from retrieval unless reconfirmed.
7. Observed remittance behavior: aggregated adjudication statistics with explicit numerators and denominators; cells below REMIT_MIN_N (default 30) are labeled insufficient and are not citable.

Rendering rule: "Published rule" section uses tiers 1 to 4. "Contract terms" uses tier 5. "Our experience" uses tiers 6 and 7 with the counts shown. "Copy for appeal" output uses tiers 1 to 4 only.

## 8. Ingestion rules

1. Every fetch stores the raw artifact with its SHA-256 on disk under the db backup volume path or a dedicated artifacts volume. A document row is created per external_id and version_hash. An unchanged hash means no new version.
2. Effective dating: parse effective, revision, and retirement dates from the document itself; fall back to publication date and flag the fallback in metadata. Structured tables carry effective and deletion dates per row.
3. Supersession: when a new version of an external_id arrives, set superseded_by on the prior version. Prior versions stay queryable for historical DOS.
4. Chunking for narrative documents: split on section headings, target 500 to 1,000 tokens, 80-token overlap, section_path preserved (example: "100-02 > Ch.15 > 240.1.2"). Prepend document title and section path to the embedded text. Extract every code-like token (5-digit CPT, HCPCS letter plus four digits, ICD-10-CM patterns) into codes_mentioned.
5. Structured data never goes through embeddings. NCCI, MUE, MPFS, HCPCS, ICD-10-CM, the telehealth list, article code lists, and remit_behavior are queried by SQL tools.
6. PDF extraction: pdfjs-based extractor with heading heuristics. If extraction quality is poor (scanned pages, garbled text), flag the document and skip it in v1; no OCR in v1.
7. Change detection: compare each new version to the prior version; write change_events with a machine diff summary. A weekly job asks MODEL_LIGHT to summarize diffs per payer, MAC, and code set with document IDs, and posts the digest to the Sources page.
8. Idempotent and resumable: re-running a job never duplicates rows and finishes partial runs. Job locks with heartbeats; a lock older than 30 minutes without heartbeat is considered dead.
9. Sample first: each courier supports --limit for parser validation. Commit fixture files under evals/fixtures for unit tests.
10. Uploads (tiers 4 and 5) go through the same pipeline: hash, document row, chunking, embedding, with client_id set for contracts.

## 9. Retrieval and tools

Hybrid retrieval for policy chunks: pgvector cosine top 60 plus tsvector top 60 (English config plus exact matching on codes_mentioned), fused with reciprocal rank fusion, filtered by DOS window (effective_date <= DOS and (retired_date is null or retired_date > DOS)), jurisdiction, payer, doc_type, tier, and client visibility (client_id is null or client_id in the user's assignments); reranked to top 12 with the local cross-encoder; returned as evidence objects.

Evidence object: { evidence_id, document_id, external_id, title, doc_type, publisher, tier, section_path, text, effective_date, retired_date, retrieved_at, version_hash, url, client_id }

Agent tools, implemented as Claude tool definitions backed by SQL and retrieval:

1. lookup_code(code, dos): code set, status on DOS, descriptor if licensed, MPFS status indicator, global days, MUE, telehealth list membership.
2. ncci_check(codes[], dos): all PTP pairs among the given codes in force on DOS with modifier indicator and effective and deletion dates.
3. mpfs_lookup(code, dos, locality?): status, RVUs, conversion factor, estimated national or locality payment, multiple procedure and therapy flags.
4. icd10_lookup(query, dos): code or term search with billable flag.
5. mcd_lookup(query, jurisdiction, dos): NCDs, LCDs, and Articles relevant to a code or keyword for the MAC or state.
6. search_policy(query, filters): hybrid retrieval as above, tiers 1 to 5.
7. get_section(document_id, section_path): full section text for citation precision.
8. call_notes_lookup(payer, state, codes[], dos): tier 6 notes not expired as of today, approved first.
9. remit_lookup(payer, state, cpt, modifiers[], year): tier 7 cells with n at or above REMIT_MIN_N, with CARC and RARC labels.
10. freshness_report(source_ids[]): last success, cadence, stale flag.
11. list_changes(since, filters): recent change_events.
12. refresh_source(source_id): bounded refresh of one configured source when stale; at most once per answer.
13. submit_answer(answer): the only way to finish; validates against the schema in section 10.

Every tool result carries evidence_ids and tiers. The composer can cite only evidence_ids it received during this run.

## 10. Agent loop and answer contract

Loop: normalize question (DOS, payer, jurisdiction, provider type, setting, client, codes mentioned) > PHI screen > composer with tools (maximum 14 tool calls) > submit_answer > verifier > renderer > qa_log.

Composer system prompt lives at packages/core/prompts/composer.md and is versioned. It establishes the role of senior CPC and biller, restates section 2, and requires: ncci_check whenever two or more procedure codes are in play; mpfs_lookup whenever payment or status is in play; mcd_lookup for Medicare coverage questions; search_policy for commercial payers; call_notes_lookup and remit_lookup whenever the payer is not traditional Medicare. It cites by evidence_id, respects tier integrity, abstains and names the missing source when evidence is insufficient, and never restates a number, date, or descriptor that is not present in an evidence text.

Answer schema, enforced at submit_answer:

```ts
type Citation = {
  evidence_id: string; document_id: string; external_id: string; tier: 1|2|3|4|5|6|7;
  section_path: string; effective_date: string | null; retired_date: string | null;
  retrieved_at: string; url: string | null;
};

type Answer = {
  bottom_line: string;                    // 1 to 3 sentences, answer first
  applicability: {
    dos: string; payer: string; jurisdiction: string; provider_type: string; setting: string;
    client: string | null; defaults_applied: string[];
  };
  codes: {
    code: string; code_set: "CPT" | "HCPCS" | "ICD10CM"; role: "primary" | "add_on" | "diagnosis";
    modifiers: string[]; citations: Citation[]; // tiers 1 to 4 only
  }[];
  published_rules: { statement: string; citations: Citation[] }[];   // tiers 1 to 4
  contract_terms: { statement: string; citations: Citation[] }[];    // tier 5
  our_experience: {
    statement: string; numerator: number | null; denominator: number | null;
    citations: Citation[];                                           // tiers 6 and 7
  }[];
  divergence: { payer_or_jurisdiction: string; differs_how: string; citations: Citation[] }[];
  documentation_required: { element: string; citations: Citation[] }[];
  what_would_change_this: string[];
  next_action: { type: "none" | "call_payer" | "request_source" | "upload_policy"; script: string | null };
  confidence: { level: "high" | "medium" | "low"; rationale: string };
  freshness: { as_of: string; stale_sources: { source_id: string; last_success_at: string; cadence_days: number }[] };
  abstained: boolean; abstain_reason: string | null; missing_sources: string[];
};
```

next_action.script: when the answer depends on an unpublished payer position, the composer writes the exact question to ask the payer, the tier 1 to 4 citations to reference on the call, and a reminder to capture the reference number in a call note.

## 11. Verifier

Independent call with MODEL_VERIFIER at temperature 0, given the question, the Answer, and the full text of every cited evidence record.

1. For each code, modifier, statement, and documentation element: verdict supported, partial, or unsupported, with the supporting evidence_id and the quoted span.
2. Numeric and date check: every dollar amount, minute count, unit count, threshold, count, and date in the answer must appear in cited evidence text or, for our_experience, match the remit_behavior cell.
3. DOS check: every citation's effective window must contain the DOS; call notes must be unexpired as of today.
4. Tier check: codes and published_rules cite tiers 1 to 4 only; contract_terms cite tier 5 only; our_experience cites tiers 6 and 7 only.
5. Citation check, performed in code rather than by the model: every evidence_id in the answer must exist in this run's tool results, and client-scoped evidence must belong to a client the asking user is assigned to.

Policy: unsupported statements and documentation elements are removed and logged. If any code, modifier, or the bottom line is unsupported or partial, the answer is replaced with an abstention that lists the missing evidence. Verifier output is stored in qa_log.verifier.

## 12. Freshness, change digest, scheduler

1. The worker runs an in-process scheduler (node-cron or equivalent) with database job locks. Schedules come from cadence_days in sources.yaml. Admins can trigger any courier from the Sources page.
2. A source is stale when now minus last_success_at exceeds 1.5 x cadence_days, or when its last run failed.
3. Every answer computes freshness for the sources used plus the sources expected for that question class: NCCI for multi-code questions, MPFS for payment questions, MCD for Medicare coverage questions, payer_policies and call notes for commercial questions.
4. Stale sources render as a warning block in the answer.
5. Failed courier runs raise an admin alert on the Sources page and an email if SMTP is configured (optional; not required for day 1).
6. Weekly digest: new, revised, and retired documents by payer, MAC, and code set; call notes expiring within 30 days; remit cells that crossed the n threshold. Shown on the Sources page and on the Ask page as "What changed this week."

## 13. Web application

Server-rendered, plain, fast. No design system beyond a clean default. Works on a laptop browser; usable on a phone.

Auth: local accounts with email and password, admin-created or invite link, session cookies, password policy, lockout after repeated failures, optional Google OIDC behind AUTH_GOOGLE_ENABLED for later. Roles per section 3.

Pages:

1. Ask: question textarea; fields for DOS (default today), payer (dropdown from payers.yaml plus Medicare Part B and Medicare Advantage), state, provider type, client (only clients the user is assigned to); example questions; the rendered answer with sections in tier order, citations expandable to show the passage text, effective date, retrieval date, and link; "Copy for appeal" (tiers 1 to 4 only); feedback buttons Correct, Incorrect, Partial with optional note; "Add call note" shortcut prefilled from the question when next_action is call_payer; "Request source" when abstained; "Similar past questions" panel from team history.
2. History: my questions; team questions searchable by payer, code, and text; each opens the full answer as logged.
3. Call notes: list with filters; add form (Appendix C); lead approve, retire, reconfirm; expiring soon view.
4. Sources: freshness by source with last success and next run; run now (admin); change digest; source requests queue; upload payer policy (lead) and client contract (admin) with tagging.
5. Admin: users and roles; client assignments; remittance import with the CSV contract from Appendix B and a validation report; eval runs with results; cost today and month against the cap; model and prompt versions in use.
6. Help: rendered from docs/HELP.md: how to ask a good question, what each tier means, what abstention means and what to do next, how to write a call note, what the tool will not do.

Rate limit 30 questions per user per hour. Every question, answer, and feedback is logged to qa_log with user ID.

## 14. Payer intelligence layer

1. Published policy couriers (tier 4): per payer in payers.yaml, a courier for the policy library pages, with hash diff and PDF extraction. Portal-only policies: leads download and upload them; the upload form requires payer, policy title, effective date, and the portal path as the URL field.
2. Client contracts (tier 5): admins upload PDF or DOCX with client, payer, effective and termination dates, and contract type (agreement, fee schedule, amendment). Chunked and embedded with client_id. Retrieval enforces user_clients. Fee schedule tables are additionally parsed into a client_fee_schedule table when the layout is machine-readable; otherwise text only.
3. Call notes (tier 6): the form in Appendix C. Text is PHI-screened. Notes are citable immediately as unverified; leads approve or retire; approval and every edit write call_note_history. Expiry 365 days from call_date; reconfirmation resets expiry. Retrieval excludes expired and retired notes. Each note is also chunked into the corpus with metadata so search_policy finds it, but it carries tier 6 and can never support a published_rules statement.
4. Remittance behavior (tier 7): admins upload a de-identified claim-line CSV (Appendix B). The importer validates columns, rejects the file if any patient identifier column is present, aggregates into remit_behavior by payer, lob, state, CPT, modifiers, and DOS year, labels CARC and RARC from source 20, deletes the raw file after aggregation, and records remit_imports. Only cells with claims_n at or above REMIT_MIN_N are citable. Evidence text is generated with explicit numerator and denominator, for example: "Payer X, Florida, 97140 with 98940 and modifier 59, 2025: 1,240 claims, 1,141 denied (92.0 percent), top CARC 97; 402 appealed, 245 overturned (60.9 percent)." Raw 835 parsing is a stretch goal behind REMIT_835_ENABLED and is not required for day 1.

## 15. PHI, licensing, audit, security

1. PHI screen: MODEL_LIGHT returns { phi: boolean, categories: string[] }, combined with regex checks for SSN, DOB patterns, member ID and MRN-like tokens. On phi=true with PHI_MODE=deny: refuse, instruct the user to de-identify, persist only phi_flag=true. Applies to questions, call notes, and source requests. PHI_MODE=allow requires a BAA for the Anthropic account and is a configuration change, not a code change.
2. CPT: ClinicMind holds an AMA CPT license for its products. Using CPT content inside an LLM pipeline requires AMA review under its AI terms. Until CPT_LICENSE_MODE=licensed, no CPT descriptors exist anywhere in storage or output. CMS-published content that contains CPT is used internally under CMS's end-user license; do not build export or client-facing surfaces on it. CPT Assistant and AHA Coding Clinic are subscription content and are not ingested.
3. Contracts are confidential: enforced by user_clients at query time and by the verifier's client check; never included in team history for users outside the client.
4. Audit: qa_log stores evidence with version hashes and prompt versions so that any answer can be reconstructed as of its timestamp. Append-only tables enforced by database grants, not application code.
5. Security: secrets only in the server .env, never in the repo; Postgres not exposed outside the Docker network; HTTPS only; CSRF protection; dependency audit in CI; admin actions logged; nightly encrypted backups to a second location Reuven designates (another disk, an internal file share, or object storage he controls).

## 16. Evals and quality gates

evals/run.ts, invoked by `pnpm eval`. Golden set from Appendix A as evals/golden.jsonl with fields: id, specialty, question, dos, payer, jurisdiction, provider_type, client, expected_evidence_types, expected_behavior, must_not_contain, reviewer, reviewed_on.

Gates for Phase 2 exit and for day-1 readiness on the production server:

1. Citation validity: 100 percent of citations resolve to evidence_ids from the run. Hard gate.
2. Groundedness: verifier supported rate at least 95 percent on non-abstained answers.
3. Expected evidence: at least 90 percent of questions cite at least one document of an expected_evidence_type.
4. Abstention: the abstain cases in Appendix A abstain; the non-abstain cases do not.
5. Ablation: with the therapy threshold documents and conversion_factor rows removed, A14 and A17 abstain instead of answering from memory.
6. DOS: A23 returns two different sourced amounts for the two years.
7. PHI: A24 refuses under PHI_MODE=deny.
8. Tier integrity: A25 and A26 place call-note and remit evidence only in our_experience; A27 fails closed when a tier 6 note is the only support for a rule.
9. Client isolation: A28 returns contract evidence for an assigned user and none for an unassigned user.
10. Cost under $0.25 and p50 latency under 30 seconds per answer, logged.

Coder review: before expected_behavior is treated as gold, Jeremy's lead coder validates each item. Store reviewer initials and date in the JSONL.

## 17. Phases and acceptance criteria

Phase 0, Scaffold (days 1 to 2): repo, workspaces, strict TypeScript, ESLint, Prettier, vitest, migrations and roles from section 5, docker-compose.yml for local development, CI running tests, docs skeleton, CLI help. Accept: `docker compose up` brings up db and app locally; migrations apply cleanly; `pnpm test` green.

Phase 1, Federal spine (weeks 1 to 2): couriers for sources 1 through 13 and 20, with fixtures and parser tests; scheduler with job locks; full ingestion run locally; docs/SOURCES.md complete with discovered URLs. Accept: row counts logged per table and sanity-checked against each source's stated counts where available; 10 known code pairs spot-checked in ncci_ptp; 5 LCDs or Articles for the configured MACs verified against the MCD website by external_id and effective date; a re-run produces zero duplicates.

Phase 2, Engine (weeks 2 to 4): local embeddings and reranker baked into images; retrieval; tools; composer; verifier; tiers; CLI ask; qa_log; eval harness. Accept: gates 1 to 7 and 10 in section 16.

Phase 3, Web application (weeks 4 to 5): auth, roles, Ask, History, Help, feedback, source requests, Similar past questions. Accept: end-to-end in a browser; 10 golden questions answered in the UI with citations; feedback rows written; rate limit and PHI refusal visible in the UI.

Phase 4, Payer intelligence (weeks 5 to 6): payer policy couriers for payers.yaml (top 5 by ClinicMind claim volume; the list is a hypothesis until Jeremy supplies the Pareto list), policy and contract uploads with client isolation, call notes with approval workflow and expiry, remit importer and remit_behavior, CARC and RARC labels, digest, Copy for appeal, next_action scripts. Accept: 5 payers ingested with effective dates; a simulated policy revision produces a change event and appears in the digest; a call note round trip (add, cite as unverified, approve, cite as approved, expire, excluded); a sample remit CSV produces cells and A26 passes; gates 8 and 9 pass.

Phase 5, Production deployment (week 6): production compose with caddy, .env on the server, egress allowlist documented for the firewall, nightly backups with restore.sh tested once, log rotation, health endpoint, cost cap and alert, RUNBOOK.md. Accept: fresh server from SETUP_FOR_REUVEN.md to running app in under one hour of hands-on time; restore test passes; all containers restart cleanly after a reboot.

Phase 6, Day-1 readiness (week 7): full ingestion on the production server; eval run on production passes all gates; pilot users created; docs/HELP.md finalized; lead coder golden-set review recorded; pilot of five business days with three billers; feedback review; rollout checklist for the full RCM team. Accept: the day-1 definition in section 1, then the pilot definition of done.

Phase 7, CPT licensed content (when the AMA agreement is amended): loader for the AMA data file, descriptors enabled, evals re-run. Accept: section 16 gates still pass.

Optional later, not part of this build: Slack or Base44 front ends consuming the same API; Google OIDC; raw 835 parsing; email alerts.

## 18. Config and env, and what Reuven supplies

Server .env (never committed):

```
ANTHROPIC_API_KEY=
DATABASE_URL=postgres://app:...@db:5432/advisor
MIGRATOR_DATABASE_URL=postgres://migrator:...@db:5432/advisor
APP_BASE_URL=https://advisor.internal.clinicmind.example
SESSION_SECRET=
MODEL_COMPOSER=claude-sonnet-5
MODEL_VERIFIER=claude-sonnet-5
MODEL_LIGHT=claude-haiku-4-5-20251001
EMBEDDING_MODEL=            # local model id chosen in Phase 2; baked into images
RERANK_MODEL=               # local cross-encoder chosen in Phase 2; baked into images
CPT_LICENSE_MODE=none       # none | licensed
CPT_DATA_FILE_PATH=
PHI_MODE=deny               # deny | allow
REMIT_MIN_N=30
REMIT_835_ENABLED=0
AUTH_GOOGLE_ENABLED=0
DAILY_COST_CAP_USD=25
DEFAULT_TZ=America/New_York
DEFAULT_PAYER=Medicare Part B
BACKUP_TARGET=              # path or mount for nightly encrypted backups
RUN_INTEGRATION=0
```

config/jurisdictions.yaml: MACs and states to track. Hypothesis defaults: First Coast (JN) for Florida, plus Novitas, Palmetto, NGS, Noridian, WPS, and CGS. Replace with ClinicMind's client footprint.

config/payers.yaml: hypothesis defaults: UnitedHealthcare, Aetna, Cigna, Elevance/Anthem, Humana, Florida Blue, Florida Medicaid (AHCA) and its MCOs. Replace with the payers covering 80 percent of ClinicMind claim volume.

config/provider_types.yaml: DC, PT, PTA, OT, OTA, MD/DO psychiatry, PhD/PsyD, LCSW, LMFT/MFT, LMHC/LPC/MHC, NP, PA.

config/egress.yaml: allowlisted outbound domains per section 4.

What Reuven supplies, and when:

1. Before Phase 0: an Anthropic API key with billing enabled; a Claude Code subscription for the build.
2. Before Phase 5: a Linux VM per SETUP_FOR_REUVEN.md with Docker installed, an internal hostname or public domain, SSH access for deployment, and a backup target.
3. Before Phase 4: Jeremy's Pareto payer list, the MAC and state footprint, the client list with which users serve which clients, and a de-identified remit CSV export per Appendix B (or the data warehouse query that produces it).
4. Before Phase 6: pilot user names and emails; the lead coder's review of Appendix A.
5. Independently: the AMA licensing call for AI use of CPT; Phase 7 waits on it. The tool is usable without it, with CPT codes by number and CMS-sourced rules.

## 19. Working rules for Claude Code

1. Read this brief and CLAUDE.md fully before writing code. Write docs/PLAN.md, then proceed through Phase 2 without waiting. Ask only for credentials, the server, the CPT license decision, the payer and jurisdiction lists, the client list, or the remit export. Otherwise decide, record the decision in docs/DECISIONS.md, and continue.
2. Never fabricate data, URLs, row counts, eval results, or test results. Discover real endpoints. If a format differs from this brief, adapt and record it in docs/SOURCES.md.
3. Parser tests with committed fixtures for every courier and importer. Integration tests run only when RUN_INTEGRATION=1.
4. Conventional commits per milestone. Keep the main branch runnable and deployable at all times.
5. Do not add features outside the phases. No Slack, no Base44, no third-party SaaS at runtime.
6. Style for docs, Help page, and UI copy: plain, numbered, no em dashes, no emoji. Write for billers, not engineers.
7. Phase report format, printed in the terminal and appended to docs/PLAN.md: a. What works, with commands to reproduce. b. What is stubbed or blocked, and why. c. Row counts by table and eval results by gate. d. Open risks: licensing, terms of use, parser fragility, cost, server capacity. e. Start conditions for the next phase, including anything Reuven must supply.

## Appendix A: Golden eval set (seed; coder review required before gold)

Columns: id | specialty | question | dos | payer | jurisdiction | provider | client | expected_evidence_types | expected_behavior

- A1 | Chiro | Medicare patient, DC performs 98941 for a new episode of low back pain with subluxation. Which modifier signals active treatment, and which documentation elements must the initial visit contain? | today | Medicare B | FL (JN) | DC | none | IOM 100-02 Ch.15 sec 240; MAC chiropractic article | answer with citations
- A2 | Chiro | Same patient now in maintenance care. How is the claim billed so the patient can be held financially responsible, and is an ABN required? | today | Medicare B | FL (JN) | DC | none | IOM 100-02 Ch.15 sec 240; IOM 100-04 Ch.30 | answer
- A3 | Chiro | 97140 billed with 98940 at the same visit, same region. Is there an NCCI edit, what is the modifier indicator, and what would justify a modifier? | today | Medicare B | national | DC | none | ncci_ptp; NCCI Policy Manual | answer; must cite the PTP row
- A4 | Chiro | Will Medicare pay a DC for 97110 or an office E/M? What about a commercial plan? | today | Medicare B and commercial | national | DC | none | IOM 100-02 Ch.15 sec 240; payer policy | answer; divergence populated
- A5 | Chiro | Commercial: does [payer 1 in payers.yaml] require modifier 25 for an E/M with CMT on the same day, and what does its chiropractic reimbursement policy say about visit frequency? | today | payer 1 | national | DC | none | payer_policies | answer after Phase 4; abstain before
- A6 | BH | LCSW provides 60 minutes of psychotherapy by video to a Medicare patient at home. Which CPT, POS, and modifier apply, and is the service on the Medicare telehealth list for this DOS? | today | Medicare B | national | LCSW | none | telehealth list; MLN or IOM telehealth guidance; MPFS | answer
- A7 | BH | Psychiatrist performs a level 4 established-patient E/M plus 30 minutes of psychotherapy in the same visit. How is the psychotherapy add-on selected and what time documentation is required? | today | Medicare B | national | MD | none | NCCI Policy Manual; CPT guidelines if licensed; MLN | answer; abstain on descriptor and time-range specifics if CPT is unlicensed and no CMS source states them
- A8 | BH | What is the practitioner MUE for 90837 and its adjudication indicator? | today | Medicare B | national | any | none | mue | answer; must cite the MUE row
- A9 | BH | Can a mental health counselor or marriage and family therapist bill Medicare directly, since when, and what enrollment conditions apply? | today | Medicare B | national | MHC | none | Federal Register CY2024 PFS final rule; MLN | answer
- A10 | BH | 90853 and 90837 for the same patient on the same day: any NCCI conflict? | today | Medicare B | national | any | none | ncci_ptp | answer
- A11 | BH | Collaborative care codes 99492 and 99493: monthly time thresholds and required team roles. | today | Medicare B | national | MD or NP | none | MLN behavioral health integration guidance; MPFS | answer
- A12 | BH | Does the JN MAC limit the frequency of 90791, and which article applies? | today | Medicare B | FL (JN) | any | none | mcd articles | answer, or abstain if no article exists
- A13 | PT | PT provides 23 minutes of 97110 and 10 minutes of 97140. How many units under Medicare's timed-code rules, and how would a payer following CPT conventions differ? | today | Medicare B | national | PT | none | IOM 100-04 Ch.5; payer policy | answer; divergence populated
- A14 | PT | What is the KX modifier threshold amount for PT and SLP combined for this DOS, and what happens above the targeted medical review threshold? | today | Medicare B | national | PT | none | cms_therapy; MLN; Federal Register | answer; ablation target
- A15 | PT | A PTA furnishes the entire 97110 service. Which modifier applies and what payment adjustment results? | today | Medicare B | national | PTA | none | Federal Register PFS rules; MLN | answer
- A16 | PT | Plan of care certification and recertification timing for Medicare outpatient therapy. | today | Medicare B | national | PT | none | IOM 100-02 Ch.15 sec 220 | answer
- A17 | PT | Estimated Medicare national payment for 97110 on this DOS, showing the RVUs and conversion factor used. | today | Medicare B | national | PT | none | mpfs; conversion_factor | answer; ablation target
- A18 | PT | 97010 billed with 97110: separately payable under Medicare? | today | Medicare B | national | PT | none | mpfs status indicator | answer
- A19 | Cross | Timely filing limit for Medicare Part B claims, and for [payer 1] per its published policy. | today | both | national | any | none | IOM 100-04 Ch.1; payer_policies | answer; divergence
- A20 | Cross | Modifier 59 versus the X modifiers: what does CMS say about preference, and how does [configured MAC] apply it to therapy and CMT bundles? | today | Medicare B | configured MAC | any | none | MLN X-modifier guidance; MAC page | answer
- A21 | Abstain | What is [a regional payer not in payers.yaml] reimbursement policy for 98943? | today | that payer | national | DC | none | none | abstain; missing_sources names the payer; next_action is request_source
- A22 | Stale | Run A3 after setting cms_ncci_ptp.last_success_at older than 1.5 x cadence in a test database. | today | Medicare B | national | DC | none | ncci_ptp | answer with a stale warning
- A23 | DOS | Run A14 for DOS 2025-06-15 and DOS 2026-06-15. | two DOS values | Medicare B | national | PT | none | cms_therapy; MLN | two different sourced amounts
- A24 | PHI | A question containing a patient name, date of birth, and member ID. | today | any | any | any | none | none | refuse under PHI_MODE=deny; no question text persisted
- A25 | Tier 6 | With a lead-approved call note stating that [payer 1] requires a specific attachment for 97140 with 98940, ask how to bill the pair for [payer 1]. | today | payer 1 | FL | DC | none | payer_policies; payer_call_notes | published_rules cite tier 4; our_experience cites the note with reference number and date; next_action includes the reconfirmation reminder if within 30 days of expiry
- A26 | Tier 7 | With the sample remit CSV loaded, ask how [payer 1] adjudicates 97140 with 98940 and modifier 59 in Florida for 2025. | today | payer 1 | FL | DC | none | remit_behavior; payer_policies | our_experience shows claims_n, denied_n, overturned_n with percentages; no published_rules statement is supported by remit evidence
- A27 | Tier misuse | With only an unverified call note and no published policy for [payer 2], ask what [payer 2] requires for 90837 telehealth. | today | payer 2 | national | LCSW | none | payer_call_notes | published_rules empty; our_experience cites the note labeled unverified; confidence low; next_action call_payer with script
- A28 | Client isolation | Ask the timely filing limit under [client A]'s contract with [payer 1], first as a user assigned to client A, then as a user who is not. | today | payer 1 | national | any | client A | client_contracts | contract_terms cites the contract for the assigned user; no contract evidence and a note that contract terms are unavailable for the unassigned user

## Appendix B: Remittance CSV contract (de-identified claim lines)

Required columns: claim_ref, line_ref, payer_name, payer_id, plan_product, lob (Medicare|MA|Commercial|Medicaid|Other), state, client_ref, provider_type, dos (YYYY-MM-DD), cpt, modifiers (pipe-delimited, may be empty), icd_primary, units, billed_amount, allowed_amount, paid_amount, carc (pipe-delimited), rarc (pipe-delimited), denied_flag (0|1), appealed_flag (0|1), appeal_outcome (overturned|upheld|partial|pending|na), remit_date (YYYY-MM-DD).

Forbidden columns, causing rejection of the whole file: any column whose name or content matches patient name, date of birth, member ID, subscriber ID, SSN, address, phone, or email patterns.

Processing: validate; aggregate to remit_behavior; label CARC and RARC; write remit_imports with rows_in and rows_rejected; delete the raw file. Cells with claims_n below REMIT_MIN_N are stored but flagged insufficient and never cited.

## Appendix C: Call note form fields

Required: payer, plan_product, lob, state, codes (one or more), topic (dropdown: coverage, modifier, documentation, prior auth, timely filing, appeals, fee schedule, other), rule_as_stated (free text, PHI-screened), rep_name, call_reference, call_date, called_by (auto), rep_confidence (stated|implied|unsure).

Optional: modifiers, client (from the user's assignments), claim_example_ref (claim reference only, no patient identifiers), attachments (portal screenshot PDFs, PHI-screened).

Behavior: saved as unverified and citable immediately; leads see a review queue; approval, edit, retire, and reconfirm write call_note_history; expiry is call_date plus 365 days; the Sources page lists notes expiring within 30 days.
