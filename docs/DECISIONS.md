# Decisions and tradeoffs

Numbered, newest last. Each entry states the decision, the reason, and what would change it.

## D1. Anthropic API key not present in the build environment (2026-08-25)

1. Decision: every Anthropic call goes through one client wrapper in packages/core. LLM_MODE=live uses the Anthropic SDK with ANTHROPIC_API_KEY. LLM_MODE=stub uses a deterministic local stub that exercises the same code paths (tool loop, schema validation, verifier plumbing) without network calls. Tests always run with the stub. The default is live when a key is present, otherwise the process refuses to answer real questions and says why.
2. Reason: the key is not available in this environment, and brief rule 19.2 forbids fabricating results. The stub lets the whole engine be built and unit-tested now, and the live gates run the moment the key lands in .env.
3. What would change it: the key arriving. No code change needed; set ANTHROPIC_API_KEY and leave LLM_MODE unset or live.
4. Eval gates that depend on live composer or verifier output are reported as blocked on the key, never as passed on stub output.

## D2. Node 22 in the build environment (2026-08-25)

1. Decision: build and CI target Node 20 or later per the brief; the build container runs Node 22.22. The engines field requires >=20.
2. Reason: brief section 4 says Node 20 or later.
3. What would change it: nothing expected; Node 22 is an LTS line.

## D3. Repository name (2026-08-25)

1. Decision: the repository is reuven-ops/biller with working directory Biller, not cm-coding-advisor. The internal layout follows brief section 4 exactly.
2. Reason: the repository existed before the build started; renaming it is Reuven's call, not a build step.
3. What would change it: Reuven renaming the repo; nothing in the code depends on the repo name.

## D4. Vector dimension parameterized in migrations, default 768 (2026-08-25)

1. Decision: chunks.embedding is vector(EMBEDDING_DIM) with the dimension substituted by the migration runner from env, default 768 to match bge-base-en-v1.5, the leading candidate. The final model choice lands in Phase 2 milestone M2.1 and is recorded here.
2. Reason: migrations ship in Phase 0 before the model decision; parameterizing avoids a rewrite.
3. What would change it: choosing a model with a different dimension in M2.1; the migration runner re-creates the column and index on an empty corpus, or a re-embed job runs on a populated one.

## D5. Optional build-time CA argument in the Dockerfiles (2026-08-25)

1. Decision: Dockerfile.app and Dockerfile.worker accept an optional EXTRA_CA_B64 build argument (base64 PEM). When set, the certificates are written into the image and NODE_EXTRA_CA_CERTS points at them; when empty, the file is empty and nothing changes. docker-compose.yml passes it from BUILD_EXTRA_CA_B64.
2. Reason: the build environment inspects outbound TLS with its own certificate authority, so pnpm install inside docker build fails certificate verification without it. Production servers build with the argument unset and trust only the public certificate store.
3. What would change it: nothing; it is inert outside inspected environments.

## D6. pgvector extension installed at bootstrap, not by migrations (2026-08-25)

1. Decision: deploy/initdb/01-roles.sh installs the vector extension into template1 and the advisor database as the Postgres superuser when the data volume first initializes. Migration 0001 keeps CREATE EXTENSION IF NOT EXISTS as a safeguard.
2. Reason: the pgvector build in the pgvector/pgvector:pg16 image is not marked trusted, so the non-superuser migrator role cannot create the extension itself. Installing into template1 also covers scratch databases created by integration tests.
3. What would change it: a pgvector build marked trusted; the bootstrap step would become redundant but harmless.

## D7. CMS end-user license attestation is performed by the couriers (2026-08-25)

1. Decision: the full NCCI PTP files (and the MCD database download, which the brief already lists with license "CMS end-user license attestation") sit behind CMS point-and-click end-user agreements. The courier performs the same request the Accept button performs (the CMS-provided access path, agree=yes) and records the attestation in the ingest run notes. A kill switch exists: CMS_LICENSE_ATTESTATION=refuse makes these couriers fail with a clear message instead of attesting. Default is accept.
2. Reason: the brief plans automated weekly MCD downloads behind exactly this attestation (section 6.1), holds that CMS-published content containing CPT is used internally under CMS's end-user license (section 15.2), and ClinicMind holds an AMA CPT license for its products. The PTP files differ from the brief only in that they are attestation-gated rather than public; per rule 19.2 the difference is adapted to and recorded in docs/SOURCES.md. This is use of the intended access mechanism, not circumvention; no CPT descriptors are stored (the PTP files carry code pairs, dates, indicators, and rationale text only).
3. What would change it: Reuven setting CMS_LICENSE_ATTESTATION=refuse, or AMA/CMS changing the terms presented at the attestation page.

## D8. conversion_factor stores the non-QPP conversion factor (2026-08-25)

1. Decision: since CY2026 the PFS carries two conversion factors (qualifying APM participant and non-QPP). The conversion_factor table stores the non-QPP value, read from the PPRRVU non-QPP file's CONV FACTOR column; the QPP variant is retrievable from the stored artifact when needed.
2. Reason: the table schema in brief section 5 holds one value per year and quarter; the non-QPP factor is the general case for ClinicMind's provider mix (chiropractic, therapy, behavioral health practitioners are typically not qualifying APM participants).
3. What would change it: payment questions for QPP participants becoming common; then a cf_variant column is added by migration and mpfs_lookup takes a variant parameter.

## D9. Federal Register full text scope (2026-08-25)

1. Decision: fedreg stores document rows with metadata and abstract chunks for every CMS rule and proposed rule since 2019-01-01 (brief section 6.12), and full rule text, chunked, for Physician Fee Schedule rules published 2023-01-01 or later. Earlier PFS rules keep metadata and abstract only.
2. Reason: PFS rules are among the largest Federal Register documents; full text for every year back to 2019 would add gigabytes of low-yield chunks. The eval set's oldest full-text need is the CY2024 PFS final rule (published November 2023) for A9. The threshold lives in config/sources.yaml (full_text_from) and is one line to widen.
3. What would change it: an eval or biller question needing pre-2023 PFS full text; widen full_text_from and re-run the courier.

## D10. x12_carc_rarc is blocked on licensing and stays disabled (2026-08-25)

1. Decision: the X12 CARC and RARC list pages are publicly viewable, but the X12 Website Terms of Use expressly prohibit data mining, robots, and extraction methods, and prohibit using the Materials in connection with AI or machine learning tools, including as retrieval grounding. Under brief hard rule 11 (never circumvent terms of use; flag and stop) the source is disabled and no courier scrapes it. The saved terms page is kept in the discovery record.
2. What Reuven should do: license the X12 External Code List (ecommerce.x12.org) or obtain written permission through X12's IP-use request process. Licensed distributions are also machine-readable, which removes the scraping question entirely.
3. Impact until licensed: remit_behavior (Phase 4) aggregates by raw CARC and RARC codes from ClinicMind's own remittance data, without X12 description labels. The brief listed this source as public; the divergence is recorded here and in docs/SOURCES.md per rule 19.2.
