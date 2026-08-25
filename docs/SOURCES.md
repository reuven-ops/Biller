# Source registry: discovered URLs and retrieval dates

Every URL below was fetched and verified on the retrieval date shown, with HTTP 200 (or a followed redirect to 200). URLs live in config/sources.yaml; this file is the audit trail and records where reality diverges from the brief. Never cite this file as evidence; it is build documentation.

All entries in this revision: discovered and verified 2026-08-25.

## 1. cms_mcd (Medicare Coverage Database)

1. Discovered: the bulk export zips at downloads.cms.gov/medicare-coverage-database/downloads/exports/ (current_lcd.zip, all_lcd.zip, current_article.zip, all_article.zip, ncd.zip, all_data.zip, refreshed weekly) are gated by an interactive license modal covering AMA CPT, ADA CDT, and AHA UB-04 terms. The Coverage API at https://api.coverage.cms.gov is keyless with an OpenAPI spec at /docs/v1/coverage-api.json: report endpoints for final LCDs, proposed LCDs, and Articles filterable by state_id and contractor_id; NCD list and detail tokenless; LCD and Article detail behind a one-hour bearer token issued by GET /v1/metadata/license-agreement/.
2. Divergence from the brief: the brief prefers the full database download with the API as fallback. The download requires an interactive attestation click, so the courier uses the API, whose token flow is the built-for-programs acceptance of the same terms (DECISIONS.md D11). api.coverage.cms.gov is a true cms.gov subdomain, so the egress allowlist covers it; downloads.cms.gov is also allowlisted for completeness.
3. Date semantics verified: report rows carry effective_date and retirement_date as MM/DD/YYYY with literal N/A; LCD detail carries rev_eff_date, rev_end_date, date_retired; Article detail carries article_eff_date, article_rev_end_date, date_retired. NCD effective_date is occasionally prose, in which case the courier stores null and keeps the text in the narrative.
4. Parser notes: narrative fields are double entity-encoded HTML; contractor_name_type embeds CRLF; no pagination observed (next_token empty even on 14,836-row child responses).

## 2. cms_ncci_ptp (NCCI PTP edits, practitioner)

1. Discovered: downloads page https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-procedure-procedure-ptp-edits. Current quarter 2026 Q3, version v322r0, four zips medicare-ncci-2026q3-practitioner-ptp-edits-ccipra-v322r0-f1.zip through f4 (17 to 20 MB each, 2,633,389 records per CMS labels), each behind the CMS/AMA end-user point-and-click agreement at /license/ama?file=..., whose Accept submits agree=yes to the file URL. The quarterly additions, deletions, and revisions zip is not gated.
2. Divergence from the brief: the brief lists this source as public; the full files are attestation-gated because the pairs are CPT codes. The courier performs the attestation (DECISIONS.md D7); the attestation is recorded in document metadata and run notes.
3. Format verified from the downloaded f1: inner ccipra-vNNNrN-fN.TXT, tab-delimited, Latin-1, AMA notice line, title line, wrapped multi-line header, then Column1, Column2, prior-to-1996 flag (*), effective date YYYYMMDD, deletion date (YYYYMMDD or * for none), modifier indicator 0, 1, or 9, rationale text. No CPT descriptors anywhere.
4. URLs are re-minted every quarter; the courier scrapes the downloads page each run and keeps only the newest version present.

## 3. cms_ncci_mue (MUE practitioner)

1. Discovered: landing https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-medically-unlikely-edits-mues, current table https://www.cms.gov/files/zip/medicare-ncci-2026-q3-practitioner-services-mue-table.zip (not license-gated), containing the same table as .xlsx and .csv.
2. Format verified: CSV is Latin-1; record 0 is a quoted multi-line AMA notice, record 1 the header (first cell contains an embedded newline), then 15,162 data rows: code, MUE value, adjudication indicator (number and label in one field), rationale. No per-row dates; the effective date rides in the file name (Eff_07-01-2026). The courier treats each quarterly file as a full snapshot: value changes insert a new effective-dated row, disappeared codes get deletion_date.

## 4. cms_ncci_manual (NCCI Policy Manual)

1. Discovered: landing https://www.cms.gov/medicare/coding-billing/national-correct-coding-initiative-ncci-edits/medicare-ncci-policy-manual. The current (2026) edition is 16 separate PDFs plus one combined file: https://www.cms.gov/files/document/2026-ncci-medicare-policy-manual-all-chapters.pdf (1.8 MB, about 287 pages). Archive zips exist for 2015 to 2025 only.
2. Divergence from the brief: the brief expected an annual zip; the current edition is loose PDFs. The courier ingests the combined all-chapters PDF, effective January 1 of the edition year.
3. Extraction verified with pdfjs: text-based PDFs, CHAPTER roman-numeral headings plus lettered section headings; table-of-contents dot-leader lines excluded by the section splitter.

## 5. cms_hcpcs (HCPCS Level II quarterly)

1. Discovered: landing https://www.cms.gov/medicare/coding-billing/healthcare-common-procedure-system/quarterly-update with one zip per quarter back to January 2023, e.g. https://www.cms.gov/files/zip/october-2026-alpha-numeric-hcpcs-file.zip. Some 2023 and 2024 quarters use the plural -files.zip; the courier scrapes anchors rather than templating URLs.
2. Format verified: each zip carries the dataset as fixed-width txt plus a one-row-per-code xlsx (HCPC2026_OCT_ANWEB.xlsx, 48 columns). Per-row dates in YYYYMMDD: ADD DT, ACT EFF DT, TERM DT (termination is the last usable date, inclusive). Inner file names drift by quarter, so the courier matches by glob. HCPCS Level II descriptors are public and stored; the file contains no CPT Level I descriptors.

## 6. cms_mpfs (PFS relative value files)

1. Discovered: landing https://www.cms.gov/medicare/payment/fee-schedules/physician/pfs-relative-value-files linking per-release detail pages (rvu26c and so on); each detail page links one zip whose filename embeds a repost date, e.g. https://www.cms.gov/files/zip/rvu26c-updated-06-30-2026.zip. Both levels are scraped each run because slugs and paths drift across years.
2. Format verified: the zip carries PPRRVU csv/txt/xlsx (since 2026 split into nonQPP and QPP variants with different conversion factors), GPCI csv, ANES csv, OPPSCAP csv, and the RVU record-layout PDF. The PPRRVU csv has ten preamble and caption lines before the real header row (HCPCS,MOD,DESCRIPTION,...); the conversion factor is a per-row column. No per-row dates: each release is the authoritative snapshot for its quarter (A=January, B=April, C=July, D=October).
3. Licensing: the DESCRIPTION column is AMA CPT text and is dropped at parse time; the committed fixture redacts it (evals/fixtures/cms_mpfs). conversion_factor stores the non-QPP value (DECISIONS.md D8).
4. Limitation: the per-row CONV FACTOR column exists from the 2026 layout on; 2024 and 2025 releases carry no per-row conversion factor (verified against the downloaded files), so conversion_factor holds 2026 quarters only. Historical conversion factors live in the release documentation PDFs; a parser for those is future work and payment estimates for pre-2026 DOS say so instead of guessing.

## 7. cms_icd10cm (ICD-10-CM)

1. Discovered: landing https://www.cms.gov/medicare/coding-billing/icd-10-codes listing FY packages; code descriptions zips such as https://www.cms.gov/files/zip/2027-code-descriptions-tabular-order.zip and the mid-year https://www.cms.gov/files/zip/april-1-2026-code-descriptions-tabular-order.zip; guidelines PDF https://www.cms.gov/files/document/fy-2026-icd-10-cm-coding-guidelines.pdf. Slugs are hand-authored and inconsistent across years; always scraped.
2. Format verified: icd10cm_order_YYYY.txt is fixed-width (order number 1-5, code 7-13 undotted, billable flag at 15, short description 17-76, long description 78+). FY files are effective October 1 of the prior year through September 30; an April package supersedes the base package for the same FY. Public domain; descriptions stored.

## 8. cms_iom (Internet-Only Manual chapters)

1. Discovered: manual hub https://www.cms.gov/medicare/regulations-guidance/manuals/internet-only-manuals-ioms (the older /regulations-and-guidance/... URL redirects). The six chapters from brief section 6.8 serve directly: bp102c15.pdf, clm104c01.pdf, clm104c05.pdf, clm104c12.pdf, clm104c30.pdf, pim83c03.pdf under https://www.cms.gov/regulations-and-guidance/guidance/manuals/downloads/. Exact URLs are pinned in config/sources.yaml because some other chapters break the naming pattern (bp102c03pdf.pdf).
2. Date semantics verified: chapter title page carries "(Rev. NNNNN; Issued: MM-DD-YY)"; sections carry their own revision lines with Effective and Implementation dates, kept inside chunk text for citation. Separator punctuation varies (semicolon or colon) and years appear as 2 or 4 digits; the parser tolerates both.

## 9. cms_mln (MLN Matters and Transmittals)

1. Discovered: transmittal year listings at https://www.cms.gov/medicare/regulations-guidance/transmittals/{YYYY}-transmittals (server-rendered table, 25 rows per page); detail pages at clean URLs per transmittal with machine-readable time elements and the transmittal and MLN Matters article PDF links under /files/document/. Article PDF URLs embed a title slug and are taken from the detail page, never templated.
2. Robots: cms.gov disallows general query strings, which covers the listing pagination, but explicitly allows /sitemap.xml?page=N. The courier therefore backfills by enumerating detail-page URLs from the sitemap and reads the clean year listings for weekly increments. No query-string listing URLs are fetched.
3. Dates verified: issue, implementation, article release, and article revision dates as ISO datetime attributes; article PDFs restate release, effective, and implementation dates in prose.

## 10. cms_telehealth_list (Medicare telehealth services)

1. Discovered: landing https://www.cms.gov/medicare/coverage/telehealth/list-services linking exactly one file, https://www.cms.gov/files/zip/list-telehealth-services-calendar-year-2026.zip. Prior-year URLs now 301-redirect to the current year: CMS keeps only the current edition online, so each year must be archived at ingest time (the courier reads the year from the final URL after redirects).
2. Divergence from the brief: the CY 2026 file has no status, audio-only, or date columns; only HCPCS, Short Descriptor, Proposed Action (Maintain or Addition). The whole list is effective for the calendar year. The Short Descriptor column is AMA CPT text: stored only under CPT_LICENSE_MODE=licensed, redacted in the committed fixture.

## 11. cms_therapy (therapy thresholds page)

1. Discovered: current page https://www.cms.gov/medicare/coding-billing/therapy-services (the legacy /medicare/billing/therapyservices redirects; a guessed /medicare/payment/fee-schedules/therapy-services 404s). KX threshold amounts and the targeted medical review threshold exist only as prose ("For CY 2026 this KX modifier threshold amount is: $2,480 for PT and SLP services combined, and $2,480 for OT services"; "the MR threshold is $3,000").
2. Only the current year appears; each annual update overwrites the prose. The courier archives each year's page version and stores the amounts in therapy_thresholds; prior years come from MLN articles and the Federal Register corpus.

## 12. fedreg (Federal Register)

1. Discovered: keyless API https://www.federalregister.gov/api/v1/documents.json; agency slug centers-for-medicare-medicaid-services; types RULE and PRORULE; per_page up to 1000; full text per document at raw_text_url (minimal HTML wrapping GPO text in a pre block). 477 CMS rules and proposed rules since 2019-01-01 at discovery time. All machine dates ISO; effective_on null for proposed rules.
2. Caution: the human-facing site redirects plain HTTP clients to unblock.federalregister.gov (bot mitigation); the API and full-text paths are not blocked. The courier treats any redirect to the unblock host as a hard stop.
3. Scope: metadata and abstract for all documents since 2019; full text chunks for Physician Fee Schedule rules since 2023 (DECISIONS.md D9).

## 13. oig_workplan (OIG Work Plan)

1. Discovered: the legacy active-item-table URL 301-redirects to https://oig.hhs.gov/reports/work-plan/browse-work-plan-projects/. The page's own CSV export at https://oig.hhs.gov/workplan/export-workplan/ returns every item (784 rows at discovery: 379 active) with a 15-column header including Number, Title, Type, Narrative (raw HTML), Component, Agencies, Status, Announced Date (ISO), Est FY.
2. The CSV is the source of truth; the courier ingests active items and stamps retired_date on items that leave the active set. The export starts with a doubled BOM and contains quoted multiline fields.

## 20. x12_carc_rarc (CARC and RARC lists): BLOCKED

1. Discovered: the public list pages https://x12.org/codes/claim-adjustment-reason-codes and https://x12.org/codes/remittance-advice-remark-codes render the full lists server-side with per-code start, last-modified, and stop dates. robots.txt does not disallow the paths.
2. Blocking: the X12 Website Terms of Use prohibit data mining, robots, and extraction methods, and prohibit use of the Materials with AI or machine learning tools including as retrieval grounding. Per brief hard rule 11 the source is disabled; no courier exists. Reuven: license the X12 External Code List (ecommerce.x12.org) or obtain written permission; see DECISIONS.md D10. The brief listed this source as public; recorded per rule 19.2.

## Sources 14 to 19

mac_sites, payer_policies, client_contracts, payer_call_notes, remit_behavior, and ama_cpt are Phase 4 and Phase 7 sources; their discovery entries are added when those phases start.
