# fedreg fixtures

1. sample_page1.json: a real Federal Register API list response (CMS rules and
   proposed rules since 2019 mentioning the Physician Fee Schedule), retrieved
   2026-08-25, unmodified.
2. raw_text_2026-14327.head.txt: the first 8 KB of the real raw_text_url body for
   document 2026-14327 (CY 2027 PFS proposed rule), retrieved 2026-08-25. Shows the
   HTML pre wrapper the parser strips; deliberately truncated, which also covers the
   missing-close-tag path.
