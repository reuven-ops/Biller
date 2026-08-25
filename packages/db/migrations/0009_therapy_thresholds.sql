-- Structured therapy threshold amounts (source 11). The brief's section 5 outline has
-- no dedicated table; section 6.11 requires KX threshold amounts by calendar year for
-- DOS-aware answers, so the courier stores them here alongside the narrative page.
CREATE TABLE therapy_thresholds (
  year integer PRIMARY KEY,
  kx_pt_slp numeric,
  kx_ot numeric,
  mr_pt_slp numeric,
  mr_ot numeric,
  source_document_id uuid REFERENCES documents(id)
);
