-- Brief section 5: sources, documents, chunks.

CREATE TABLE sources (
  id text PRIMARY KEY,
  name text NOT NULL,
  publisher text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('download', 'html', 'pdf', 'upload', 'import')),
  base_url text NOT NULL DEFAULT '',
  cadence_days integer NOT NULL,
  tier integer NOT NULL CHECK (tier BETWEEN 1 AND 7),
  jurisdiction text[] NOT NULL DEFAULT '{}',
  payer text,
  lob text,
  license_required boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES sources(id),
  external_id text NOT NULL,
  doc_type text NOT NULL,
  title text NOT NULL,
  url text,
  version_hash text NOT NULL,
  effective_date date,
  revision_date date,
  retired_date date,
  superseded_by uuid REFERENCES documents(id),
  tier integer NOT NULL CHECK (tier BETWEEN 1 AND 7),
  jurisdiction text[] NOT NULL DEFAULT '{}',
  payer text,
  lob text,
  client_id uuid,
  retrieved_at timestamptz NOT NULL DEFAULT now(),
  storage_path text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_id, external_id, version_hash)
);

CREATE INDEX documents_source_external_idx ON documents (source_id, external_id);
CREATE INDEX documents_effective_idx ON documents (effective_date, retired_date);
CREATE INDEX documents_client_idx ON documents (client_id) WHERE client_id IS NOT NULL;

CREATE TABLE chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  section_path text NOT NULL DEFAULT '',
  ordinal integer NOT NULL,
  text text NOT NULL,
  token_count integer NOT NULL,
  embedding vector({{EMBEDDING_DIM}}),
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  tier integer NOT NULL CHECK (tier BETWEEN 1 AND 7),
  client_id uuid,
  effective_date date,
  retired_date date,
  codes_mentioned text[] NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (document_id, ordinal)
);

CREATE INDEX chunks_document_idx ON chunks (document_id);
CREATE INDEX chunks_tsv_idx ON chunks USING gin (tsv);
CREATE INDEX chunks_codes_idx ON chunks USING gin (codes_mentioned);
CREATE INDEX chunks_effective_idx ON chunks (effective_date, retired_date);
CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
