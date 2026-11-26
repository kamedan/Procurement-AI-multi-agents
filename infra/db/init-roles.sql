-- Executed once on fresh PostgreSQL volume initialization.
-- Creates the non-owner, NOBYPASSRLS runtime role and private checkpoint schema.
-- Application tables are owned by procureai_owner (migration role) and protected
-- with FORCE ROW LEVEL SECURITY so procureai_app can never bypass tenant policies.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'procureai_app') THEN
    CREATE ROLE procureai_app LOGIN PASSWORD 'procureai_app_local_dev_pw_2026' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS langgraph_checkpoints AUTHORIZATION procureai_owner;

GRANT USAGE ON SCHEMA public TO procureai_app;
GRANT USAGE ON SCHEMA langgraph_checkpoints TO procureai_app;
ALTER DEFAULT PRIVILEGES FOR ROLE procureai_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO procureai_app;
ALTER DEFAULT PRIVILEGES FOR ROLE procureai_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO procureai_app;
ALTER DEFAULT PRIVILEGES FOR ROLE procureai_owner IN SCHEMA langgraph_checkpoints
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO procureai_app;
ALTER DEFAULT PRIVILEGES FOR ROLE procureai_owner IN SCHEMA langgraph_checkpoints
  GRANT USAGE, SELECT ON SEQUENCES TO procureai_app;
