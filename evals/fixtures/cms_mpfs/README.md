# cms_mpfs fixtures

1. PPRRVU2026_Jul_nonQPP.excerpt.redacted.csv: the first 71 CSV records (preamble,
   caption rows, header, then data rows) of the real PPRRVU2026_Jul_nonQPP.csv from
   https://www.cms.gov/files/zip/rvu26c-updated-06-30-2026.zip, retrieved 2026-08-25.
   The DESCRIPTION column in data rows is replaced with the literal REDACTED because
   those values are AMA CPT descriptors and are never stored or committed under
   CPT_LICENSE_MODE=none (brief non-negotiable 5). Every other value is unmodified.
2. GPCI2026.csv: the complete Addendum E GPCI file from the same zip, unmodified
   (public CMS data, no CPT content).
