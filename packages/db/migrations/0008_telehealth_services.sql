-- List of Medicare Telehealth Services (source 10). The brief's section 5 outline has
-- no dedicated table, but section 8.5 requires the telehealth list to be queryable by
-- SQL tools; this table fills that gap. short_desc stays NULL under
-- CPT_LICENSE_MODE=none (the published file's descriptors are AMA CPT).
CREATE TABLE telehealth_services (
  code text NOT NULL,
  year integer NOT NULL,
  action text NOT NULL,
  short_desc text,
  file_version text NOT NULL,
  PRIMARY KEY (code, year)
);
