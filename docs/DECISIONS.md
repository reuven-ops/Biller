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
