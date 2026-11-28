ALTER TABLE "reminder_deliveries" ADD COLUMN "send_claim" uuid;--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD COLUMN "send_claimed_at" timestamp with time zone;
--> statement-breakpoint
GRANT UPDATE (send_claim, send_claimed_at) ON public.reminder_deliveries TO kept_system;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.purge_expired_exports(p_limit integer) RETURNS SETOF text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.export_runs x
     SET status = 'failed', error = 'abandoned', finished_at = now(),
         secrets_key_ciphertext = NULL, key_version = NULL
   WHERE x.status IN ('queued', 'running')
     AND coalesce(x.started_at, x.created_at) <= now() -
         CASE WHEN x.kind = 'claim_pack' THEN interval '40 minutes' ELSE interval '3 hours' END;
  RETURN QUERY
  WITH gone AS (
    SELECT x.id, x.storage_key FROM public.export_runs x
     WHERE x.status <> 'expired' AND (x.expires_at <= now() OR x.created_by IS NULL)
     ORDER BY x.expires_at, x.id
     LIMIT greatest(p_limit, 0)
     FOR UPDATE),
  done AS (
    UPDATE public.export_runs x
       SET status = 'expired', storage_key = NULL, token_hash = NULL, token_expires_at = NULL,
           secrets_key_ciphertext = NULL, key_version = NULL
      FROM gone
     WHERE x.id = gone.id
    RETURNING gone.storage_key)
  SELECT d.storage_key FROM done d WHERE d.storage_key IS NOT NULL;
  DELETE FROM public.export_runs x
   WHERE x.status = 'expired' AND x.expires_at <= now() - interval '90 days';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.stale_import_runs(p_before timestamptz, p_limit integer)
RETURNS TABLE (id uuid, has_archive boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  -- Import attempts expire at two hours. Preserve the resumable input until normal retention.
  UPDATE public.import_runs r SET status = 'failed', error = 'abandoned', finished_at = now()
   WHERE r.id IN (
     SELECT x.id FROM public.import_runs x
      WHERE x.status = 'running' AND x.updated_at < now() - interval '3 hours'
      ORDER BY x.updated_at, x.id LIMIT greatest(p_limit, 0) FOR UPDATE SKIP LOCKED
   );
  RETURN QUERY
  SELECT x.id, x.archive_bytes IS NOT NULL OR x.archive_sha256 IS NOT NULL
    FROM public.import_runs x
   WHERE x.updated_at < p_before
     AND (x.status IN ('draft', 'checked')
          OR (x.status IN ('failed', 'cancelled', 'done')
              AND (x.rows IS NOT NULL OR x.archive_bytes IS NOT NULL
                   OR x.archive_sha256 IS NOT NULL OR x.inspect IS NOT NULL
                   OR x.secrets_key_ciphertext IS NOT NULL)))
   ORDER BY x.updated_at, x.id
   LIMIT greatest(p_limit, 0);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.purge_expired_reports(p_limit integer) RETURNS SETOF uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.report_runs r SET status = 'failed', error = 'timeout', finished_at = now()
   WHERE r.id IN (
     SELECT x.id FROM public.report_runs x
      WHERE x.status IN ('queued', 'running')
        AND coalesce(x.started_at, x.created_at) <= now() - interval '10 minutes'
      ORDER BY coalesce(x.started_at, x.created_at), x.id
      LIMIT greatest(p_limit, 0) FOR UPDATE SKIP LOCKED
   );
  RETURN QUERY
  DELETE FROM public.report_runs r
   WHERE r.id IN (SELECT x.id FROM public.report_runs x
                   WHERE x.expires_at <= now() OR x.user_id IS NULL
                   ORDER BY x.expires_at, x.id
                   LIMIT greatest(p_limit, 0))
  RETURNING r.id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.prune_assistant(p_now timestamptz)
RETURNS TABLE (what text, removed bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM public.assistant_threads th WHERE th.expires_at < p_now;
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'assistant_threads'; removed := n; RETURN NEXT;

  UPDATE public.assistant_proposals p SET status = 'expired'
   WHERE p.status = 'open' AND p.expires_at < p_now;
  GET DIAGNOSTICS n = ROW_COUNT;
  what := 'assistant_proposals'; removed := n; RETURN NEXT;
  -- Eight minutes covers the job's two 200-second attempts and the retry delay.
  UPDATE public.assistant_turns t SET status = 'failed', status_reason = 'timeout',
         finished_at = p_now
   WHERE t.status IN ('queued', 'running') AND t.updated_at <= p_now - interval '8 minutes';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    what := 'abandoned_turns'; removed := n; RETURN NEXT;
  END IF;
END $$;
