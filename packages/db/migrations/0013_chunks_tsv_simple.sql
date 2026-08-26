-- Exact-token search arm (gate 3 fix). The english FTS config drops stopwords,
-- so a query for the AT modifier loses its key token ("at") entirely and the
-- passage that answers it can rank below thousands of generic Medicare chunks.
-- A simple-config tsvector keeps every token verbatim (lowercased only), giving
-- retrieval an indexed exact-word arm for modifier and short-token lookups.
ALTER TABLE chunks
  ADD COLUMN tsv_simple tsvector GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED;

CREATE INDEX chunks_tsv_simple_idx ON chunks USING gin (tsv_simple);
