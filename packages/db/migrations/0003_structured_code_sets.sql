-- Brief section 5: structured code sets. Queried by SQL tools, never embedded.

CREATE TABLE codes (
  code_set text NOT NULL CHECK (code_set IN ('CPT', 'HCPCS', 'ICD10CM')),
  code text NOT NULL,
  short_desc text, -- CPT descriptors stay NULL unless CPT_LICENSE_MODE=licensed
  long_desc text,
  status text,
  effective_date date,
  end_date date,
  version text NOT NULL,
  PRIMARY KEY (code_set, code, version)
);

CREATE INDEX codes_code_idx ON codes (code);

CREATE TABLE ncci_ptp (
  column1 text NOT NULL,
  column2 text NOT NULL,
  modifier_indicator char(1) NOT NULL,
  effective_date date NOT NULL,
  deletion_date date,
  rationale text,
  file_version text NOT NULL,
  PRIMARY KEY (column1, column2, effective_date)
);

CREATE INDEX ncci_ptp_column2_idx ON ncci_ptp (column2);

CREATE TABLE mue (
  code text NOT NULL,
  mue_value integer NOT NULL,
  adjudication_indicator text,
  rationale text,
  effective_date date NOT NULL,
  deletion_date date,
  file_version text NOT NULL,
  PRIMARY KEY (code, effective_date)
);

CREATE TABLE mpfs (
  code text NOT NULL,
  modifier text NOT NULL DEFAULT '',
  year integer NOT NULL,
  quarter integer NOT NULL,
  status_indicator text,
  work_rvu numeric,
  pe_rvu_fac numeric,
  pe_rvu_nonfac numeric,
  mp_rvu numeric,
  total_fac numeric,
  total_nonfac numeric,
  global_days text,
  mult_proc text,
  bilateral text,
  assistant_surg text,
  co_surg text,
  pctc text,
  effective_date date,
  file_version text NOT NULL,
  PRIMARY KEY (code, modifier, year, quarter)
);

CREATE TABLE conversion_factor (
  year integer NOT NULL,
  quarter integer NOT NULL,
  value numeric NOT NULL,
  source_document_id uuid REFERENCES documents(id),
  PRIMARY KEY (year, quarter)
);

CREATE TABLE gpci (
  locality_code text NOT NULL,
  locality_name text,
  state text,
  year integer NOT NULL,
  work numeric,
  pe numeric,
  mp numeric,
  PRIMARY KEY (locality_code, year)
);

CREATE TABLE icd10cm (
  code text NOT NULL,
  description text NOT NULL,
  chapter text,
  billable boolean NOT NULL,
  effective_date date,
  end_date date,
  version text NOT NULL,
  PRIMARY KEY (code, version)
);

CREATE INDEX icd10cm_description_idx ON icd10cm USING gin (to_tsvector('english', description));
