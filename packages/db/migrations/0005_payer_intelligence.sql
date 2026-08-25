-- Brief section 5: payer call notes, call note history, remittance behavior.

CREATE TABLE payer_call_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payer text NOT NULL,
  plan_product text,
  lob text,
  state text,
  codes text[] NOT NULL DEFAULT '{}',
  modifiers text[] NOT NULL DEFAULT '{}',
  topic text NOT NULL,
  rule_as_stated text NOT NULL,
  rep_name text,
  call_reference text,
  call_date date NOT NULL,
  called_by_user_id uuid REFERENCES users(id),
  client_id uuid REFERENCES clients(id),
  claim_example_id text,
  rep_confidence text CHECK (rep_confidence IN ('stated', 'implied', 'unsure')),
  status text NOT NULL DEFAULT 'unverified'
    CHECK (status IN ('unverified', 'lead_approved', 'retired')),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  expires_on date NOT NULL,
  reconfirmed_on date,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payer_call_notes_payer_idx ON payer_call_notes (payer, state);
CREATE INDEX payer_call_notes_codes_idx ON payer_call_notes USING gin (codes);

-- Append-only; enforced by grants in 0007.
CREATE TABLE call_note_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES payer_call_notes(id),
  action text NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  ts timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL
);

CREATE TABLE remit_behavior (
  payer text NOT NULL,
  payer_id text NOT NULL,
  lob text NOT NULL,
  state text NOT NULL,
  cpt text NOT NULL,
  modifiers text[] NOT NULL DEFAULT '{}',
  year integer NOT NULL,
  claims_n integer NOT NULL,
  denied_n integer NOT NULL,
  paid_n integer NOT NULL,
  top_carc jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_rarc jsonb NOT NULL DEFAULT '[]'::jsonb,
  appealed_n integer NOT NULL DEFAULT 0,
  overturned_n integer NOT NULL DEFAULT 0,
  avg_allowed numeric,
  import_id uuid,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (payer_id, lob, state, cpt, modifiers, year)
);

CREATE TABLE remit_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text NOT NULL,
  rows_in integer NOT NULL,
  rows_rejected integer NOT NULL,
  cells_written integer NOT NULL,
  imported_by uuid REFERENCES users(id),
  imported_at timestamptz NOT NULL DEFAULT now(),
  notes text
);

ALTER TABLE remit_behavior
  ADD CONSTRAINT remit_behavior_import_fk FOREIGN KEY (import_id) REFERENCES remit_imports(id);
