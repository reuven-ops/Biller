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

## D11. cms_mcd ingests through the Coverage API, not the bulk zips (2026-08-25)

1. Decision: the MCD bulk zip downloads are gated by an interactive license modal on the downloads page, so the courier uses the Coverage API (api.coverage.cms.gov) instead: reports and NCD data are keyless; LCD and Article detail endpoints take a one-hour bearer token that the API's own license-agreement endpoint issues, which is the API's documented acceptance mechanism for the same AMA, ADA, and AHA end-user terms. Attestation is governed by CMS_LICENSE_ATTESTATION (D7). The hcpc-code child endpoints, which carry CPT descriptors, are never called.
2. Reason: the brief (section 6.1) names the Coverage API as the sanctioned fallback and already plans for the CMS end-user license attestation. Fetching the zips headlessly would skip the modal; the API path accepts the same terms through the interface built for programs.
3. What would change it: the API adding pagination or rate limits that make weekly refreshes impractical; then revisit the bulk download with a recorded attestation flow.

## D12. Local inference models: bge-base-en-v1.5 and bge-reranker-base (2026-08-25)

1. Decision: embeddings come from Xenova/bge-base-en-v1.5 (768 dimensions, fp32 ONNX) and reranking from Xenova/bge-reranker-base, both running in process on CPU through Transformers.js with model files under MODELS_DIR, baked into the Docker images at build time. Queries carry the BGE retrieval prefix; passages do not. EMBEDDING_DIM stays 768, matching the D4 default, so no migration change.
2. Reason: both are brief-listed candidates, available as ONNX without network access at runtime, and validated in this environment: identical text yields identical vectors, a therapy query scores 0.82 against a therapy passage versus 0.39 against an unrelated one, and the reranker separates them by 14 points.
3. What would change it: retrieval quality findings in eval; nomic-embed-text-v1.5 (longer context) is the fallback candidate.

## D13. Temperature on the composer and verifier models (2026-08-25)

1. Decision: the brief requires temperature 0 for composer and verifier. The pinned models (claude-sonnet-5 family and newer) reject sampling parameters outright (the API returns 400 for temperature, top_p, top_k), so the client wrapper sends no sampling parameters on models that reject them and applies temperature 0 only where the model accepts it. The determinism intent stands: no sampling parameter is ever raised above default, prompts are versioned, and model IDs are pinned from env.
2. Reason: complying with the letter of "temperature 0" on these models is impossible; the wrapper implements the closest compliant behavior and records it here.
3. What would change it: the API reintroducing sampling control on these models.

## D14. Denial code descriptions without an X12 license: original glosses grounded in public CMS documents (2026-08-25)

1. Context: Reuven declined the X12 External Code List license (D10) but wants a clear description of each CARC and RARC in the Phase 4 remit views. Four research passes on 2026-08-25 verified every candidate public source (docs/SOURCES.md section 21). The controlling facts: no US government source republishes the complete current lists; CMS's own 2026 CCIIO guidance reproduces RARC text only "with X12's and WPC's permission for this prescribed purpose", which confirms CMS treats the description sentences as licensed X12 material; and the CAQH CORE code combinations file, which does contain the full text, sits behind DataSpring terms of service that prohibit copying and derivative works, so under hard rule 11 it is not used.
2. Decision, layered so nothing depends on X12 text:
   a. Framework prose. Ingest CMS's own public domain explanations of the remittance system: IOM 100-04 chapter 22 (group codes CO, OA, PR in section 60.1; CARC framework 60.2; RARC framework 60.3) is added to the cms_iom chapter list now; the MLN booklet ICN905367 (Remittance Advice Resources and FAQs) and the CCIIO CAA/NSA RARC guidance are queued as the cms_remit_guides source with the Phase 4 remit work. These give accurate, quotable answers to what a group code, CARC, or RARC means.
   b. Per code glosses. For each code that appears in ClinicMind remit data, a gloss job drafts an original plain language explanation in our own words through the same composer and verifier pipeline as answers: every claim must be supported by evidence retrieved from the ingested public corpus (IOM chapters, MLN articles and transmittals, MCD documents, Federal Register rules, the CCIIO guidance) or it is stripped; model memory is never a source (hard rule 2). Each gloss stores its evidence ids and quotes, is marked draft until a human approves it in the review queue, and renders in remit views as "our plain language explanation" with citations, visually distinct from quoted rule text. Approved glosses are versioned; a change event on any cited document flags dependent glosses for re-review.
   c. Honest gaps. A code with no supporting public evidence renders as the bare code number (a fact, not copyrightable) with "no published description on file" and a link that asks the advisor, which can still ground an answer in LCD or Article context where the code appears (the corpus already holds 274 CARC and 168 RARC mentions, most from cms_mcd). We do not backfill gaps from model memory and we do not assemble a complete X12 substitute list from fragments: coverage is whatever the public record supports, code by code.
3. Drafting references, not ingested sources: historical CMS transmittals that embed point in time code tables (R2372CP 2011, MM6229 2008) and the Indiana IHCP and MassHealth crosswalk spreadsheets (state works are outside 17 USC 105, and Mass.gov's terms flag third party copyright material) may be consulted when drafting a gloss and cited by URL, but their X12 origin sentences are not stored as display text. The MREP software's embedded code list is not extracted; that use exceeds the purpose CMS distributes it for.
4. Risk note for counsel review before Phase 4 ships: short quoted excerpts of X12 origin sentences appearing inside cited public federal documents are retained as retrieval evidence (the tool's normal quoting model); the displayed per code descriptions are original ClinicMind authored text. If counsel wants a stricter posture, the gloss display works without any quoted X12 origin sentence.
