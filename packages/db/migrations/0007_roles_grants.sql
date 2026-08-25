-- Brief non-negotiable 7 and section 15.4: the app role gets INSERT and SELECT only on
-- the four append-only tables, enforced by grants, not application code. The migrator
-- role owns all objects. The app role is created by the bootstrap script
-- (deploy/initdb/01-roles.sh) before migrations run.

GRANT USAGE ON SCHEMA public TO app;

-- Full DML on ordinary tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;

-- Append-only tables: strip UPDATE, DELETE, TRUNCATE.
REVOKE UPDATE, DELETE, TRUNCATE ON qa_log FROM app;
REVOKE UPDATE, DELETE, TRUNCATE ON qa_feedback FROM app;
REVOKE UPDATE, DELETE, TRUNCATE ON change_events FROM app;
REVOKE UPDATE, DELETE, TRUNCATE ON call_note_history FROM app;

-- The migration ledger is written only by the migrator.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON schema_migrations FROM app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app;

-- Future tables created by the migrator default to full DML for app; migrations that
-- add append-only tables must revoke explicitly, as above.
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app;
