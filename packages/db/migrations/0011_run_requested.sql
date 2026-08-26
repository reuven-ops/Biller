-- Phase 3 M3.4: admin "run now" on the Sources page. The scheduler treats a
-- requested source as due on its next pass and clears the request.

ALTER TABLE sources
  ADD COLUMN run_requested_at timestamptz;
