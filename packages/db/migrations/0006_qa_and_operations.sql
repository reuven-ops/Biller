-- Brief section 5: qa log, feedback, change events, source requests, ingest runs,
-- job locks, daily metrics.

-- Append-only; enforced by grants in 0007.
CREATE TABLE qa_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES users(id),
  question_text text, -- NULL when phi_flag is true; the text is never persisted
  question_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  dos date,
  payer text,
  jurisdiction text,
  provider_type text,
  client_id uuid REFERENCES clients(id),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer jsonb,
  verifier jsonb,
  models jsonb NOT NULL DEFAULT '{}'::jsonb,
  prompt_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  cost_usd numeric NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  phi_flag boolean NOT NULL DEFAULT false,
  abstained boolean NOT NULL DEFAULT false
);

CREATE INDEX qa_log_user_idx ON qa_log (user_id, ts);
CREATE INDEX qa_log_ts_idx ON qa_log (ts);

-- Append-only; enforced by grants in 0007.
CREATE TABLE qa_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qa_id uuid NOT NULL REFERENCES qa_log(id),
  user_id uuid REFERENCES users(id),
  verdict text NOT NULL CHECK (verdict IN ('correct', 'incorrect', 'partial')),
  note text,
  ts timestamptz NOT NULL DEFAULT now()
);

-- Append-only; enforced by grants in 0007.
CREATE TABLE change_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id),
  change_type text NOT NULL CHECK (change_type IN ('new', 'revised', 'retired')),
  diff_summary text,
  detected_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz
);

CREATE INDEX change_events_detected_idx ON change_events (detected_at);

CREATE TABLE source_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qa_id uuid REFERENCES qa_log(id),
  requested_by uuid REFERENCES users(id),
  payer_or_source text NOT NULL,
  note text,
  ts timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'declined'))
);

CREATE TABLE ingest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL REFERENCES sources(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  rows_written integer NOT NULL DEFAULT 0,
  error text,
  notes text
);

CREATE INDEX ingest_runs_source_idx ON ingest_runs (source_id, started_at);

CREATE TABLE job_locks (
  job_name text PRIMARY KEY,
  locked_by text NOT NULL,
  locked_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE metrics_daily (
  day date PRIMARY KEY,
  answers_n integer NOT NULL DEFAULT 0,
  abstain_n integer NOT NULL DEFAULT 0,
  cost_usd numeric NOT NULL DEFAULT 0,
  p50_ms integer,
  p95_ms integer,
  feedback_correct_n integer NOT NULL DEFAULT 0,
  feedback_incorrect_n integer NOT NULL DEFAULT 0,
  feedback_partial_n integer NOT NULL DEFAULT 0
);
