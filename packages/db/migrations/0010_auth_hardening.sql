-- Phase 3 M3.1: login lockout state and the admin action audit log (brief 13, 15.5).

ALTER TABLE users
  ADD COLUMN failed_logins int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz;

CREATE TABLE admin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES users(id),
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX admin_audit_ts_idx ON admin_audit (ts);

-- Audit log is append only, like the other history tables (0007 pattern).
REVOKE UPDATE, DELETE, TRUNCATE ON admin_audit FROM app;
