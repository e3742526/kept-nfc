-- Future functions start private. Preserve existing ACLs because earlier migrations
-- relied on the schema default for their RLS helpers and explicitly scoped doors.
ALTER DEFAULT PRIVILEGES FOR ROLE kept_owner IN SCHEMA kept
  REVOKE EXECUTE ON FUNCTIONS FROM kept_app, kept_system;
