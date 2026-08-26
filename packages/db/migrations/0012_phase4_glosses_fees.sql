-- Phase 4: the D14 denial code glosses and the machine-readable client fee schedules.

CREATE TABLE code_glosses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_type text NOT NULL CHECK (code_type IN ('carc', 'rarc', 'group')),
  code text NOT NULL,
  gloss text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  -- Evidence records (quotes, document ids, urls) the gloss was drafted from (D14).
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  drafted_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  -- Set when a cited document changes so leads re-review (D14.2b).
  needs_review boolean NOT NULL DEFAULT false,
  UNIQUE (code_type, code)
);

CREATE TABLE client_fee_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  payer text NOT NULL,
  cpt text NOT NULL,
  modifiers text[] NOT NULL DEFAULT '{}',
  allowed_amount numeric NOT NULL,
  effective_date date,
  termination_date date,
  source_document_id uuid REFERENCES documents(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX client_fee_schedule_lookup_idx ON client_fee_schedule (client_id, payer, cpt);
