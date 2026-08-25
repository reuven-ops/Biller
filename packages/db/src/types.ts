// Row types for the tables in brief section 5. Kept by hand next to the migrations;
// a migration that changes a table changes its type here in the same commit.

export type SourceKind = 'download' | 'html' | 'pdf' | 'upload' | 'import';
export type Tier = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Role = 'biller' | 'lead' | 'admin';
export type CodeSet = 'CPT' | 'HCPCS' | 'ICD10CM';

export interface SourceRow {
  id: string;
  name: string;
  publisher: string;
  kind: SourceKind;
  base_url: string;
  cadence_days: number;
  tier: Tier;
  jurisdiction: string[];
  payer: string | null;
  lob: string | null;
  license_required: boolean;
  enabled: boolean;
  last_run_at: Date | null;
  last_success_at: Date | null;
  last_error: string | null;
  config: Record<string, unknown>;
}

export interface DocumentRow {
  id: string;
  source_id: string;
  external_id: string;
  doc_type: string;
  title: string;
  url: string | null;
  version_hash: string;
  effective_date: Date | null;
  revision_date: Date | null;
  retired_date: Date | null;
  superseded_by: string | null;
  tier: Tier;
  jurisdiction: string[];
  payer: string | null;
  lob: string | null;
  client_id: string | null;
  retrieved_at: Date;
  storage_path: string | null;
  metadata: Record<string, unknown>;
}

export interface ChunkRow {
  id: string;
  document_id: string;
  section_path: string;
  ordinal: number;
  text: string;
  token_count: number;
  embedding: string | null; // pgvector text form
  tier: Tier;
  client_id: string | null;
  effective_date: Date | null;
  retired_date: Date | null;
  codes_mentioned: string[];
  metadata: Record<string, unknown>;
}

export interface CodeRow {
  code_set: CodeSet;
  code: string;
  short_desc: string | null;
  long_desc: string | null;
  status: string | null;
  effective_date: Date | null;
  end_date: Date | null;
  version: string;
}

export interface NcciPtpRow {
  column1: string;
  column2: string;
  modifier_indicator: string;
  effective_date: Date;
  deletion_date: Date | null;
  rationale: string | null;
  file_version: string;
}

export interface MueRow {
  code: string;
  mue_value: number;
  adjudication_indicator: string | null;
  rationale: string | null;
  effective_date: Date;
  deletion_date: Date | null;
  file_version: string;
}

export interface MpfsRow {
  code: string;
  modifier: string;
  year: number;
  quarter: number;
  status_indicator: string | null;
  work_rvu: string | null;
  pe_rvu_fac: string | null;
  pe_rvu_nonfac: string | null;
  mp_rvu: string | null;
  total_fac: string | null;
  total_nonfac: string | null;
  global_days: string | null;
  mult_proc: string | null;
  bilateral: string | null;
  assistant_surg: string | null;
  co_surg: string | null;
  pctc: string | null;
  effective_date: Date | null;
  file_version: string;
}

export interface ConversionFactorRow {
  year: number;
  quarter: number;
  value: string;
  source_document_id: string | null;
}

export interface GpciRow {
  locality_code: string;
  locality_name: string | null;
  state: string | null;
  year: number;
  work: string | null;
  pe: string | null;
  mp: string | null;
}

export interface Icd10cmRow {
  code: string;
  description: string;
  chapter: string | null;
  billable: boolean;
  effective_date: Date | null;
  end_date: Date | null;
  version: string;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  password_hash: string | null;
  status: 'active' | 'disabled' | 'invited';
  created_at: Date;
  last_login_at: Date | null;
}

export interface ClientRow {
  id: string;
  name: string;
  external_ref: string | null;
  active: boolean;
}

export interface PayerCallNoteRow {
  id: string;
  payer: string;
  plan_product: string | null;
  lob: string | null;
  state: string | null;
  codes: string[];
  modifiers: string[];
  topic: string;
  rule_as_stated: string;
  rep_name: string | null;
  call_reference: string | null;
  call_date: Date;
  called_by_user_id: string | null;
  client_id: string | null;
  claim_example_id: string | null;
  rep_confidence: 'stated' | 'implied' | 'unsure' | null;
  status: 'unverified' | 'lead_approved' | 'retired';
  approved_by: string | null;
  approved_at: Date | null;
  expires_on: Date;
  reconfirmed_on: Date | null;
  created_at: Date;
}

export interface RemitBehaviorRow {
  payer: string;
  payer_id: string;
  lob: string;
  state: string;
  cpt: string;
  modifiers: string[];
  year: number;
  claims_n: number;
  denied_n: number;
  paid_n: number;
  top_carc: unknown;
  top_rarc: unknown;
  appealed_n: number;
  overturned_n: number;
  avg_allowed: string | null;
  import_id: string | null;
  computed_at: Date;
}

export interface QaLogRow {
  id: string;
  ts: Date;
  user_id: string | null;
  question_text: string | null;
  question_meta: Record<string, unknown>;
  dos: Date | null;
  payer: string | null;
  jurisdiction: string | null;
  provider_type: string | null;
  client_id: string | null;
  evidence: unknown;
  answer: unknown;
  verifier: unknown;
  models: Record<string, unknown>;
  prompt_versions: Record<string, unknown>;
  tokens_in: number;
  tokens_out: number;
  cost_usd: string;
  latency_ms: number;
  phi_flag: boolean;
  abstained: boolean;
}

export interface IngestRunRow {
  id: string;
  source_id: string;
  started_at: Date;
  finished_at: Date | null;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  rows_written: number;
  error: string | null;
  notes: string | null;
}

export interface JobLockRow {
  job_name: string;
  locked_by: string;
  locked_at: Date;
  heartbeat_at: Date;
}

export interface ChangeEventRow {
  id: string;
  document_id: string;
  change_type: 'new' | 'revised' | 'retired';
  diff_summary: string | null;
  detected_at: Date;
  notified_at: Date | null;
}
