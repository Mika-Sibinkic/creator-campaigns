-- 068_audit_log_no_truncate.sql
--
-- The 008 triggers reject UPDATE and DELETE on audit_log, but row triggers do
-- not fire on TRUNCATE, and Supabase grants TRUNCATE to the API roles by
-- default. Revoke it so a service-role session cannot wipe the log either.
-- The table owner (postgres) can still TRUNCATE; that is direct database
-- access, not an app path.

REVOKE TRUNCATE ON public.audit_log FROM anon, authenticated, service_role;
