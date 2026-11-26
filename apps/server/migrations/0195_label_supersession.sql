ALTER TABLE "short_ids" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "short_ids" ADD COLUMN "superseded_by" uuid;--> statement-breakpoint
ALTER TABLE "short_ids" ADD COLUMN "replacement_code" char(6);--> statement-breakpoint
ALTER TABLE "short_ids" ADD COLUMN "replacement_reason" text;--> statement-breakpoint
ALTER TABLE "short_ids" ADD CONSTRAINT "short_ids_replacement_fk" FOREIGN KEY ("replacement_code") REFERENCES "public"."short_ids"("code") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- A replacement claims a blank of the same location. Retain the original target and code so
-- every older sticker still resolves. The owner function is the only writer of history fields.
CREATE FUNCTION kept.replace_printed_label(p_location uuid, p_old char(6), p_new char(6), p_reason text)
RETURNS TABLE (thing_id uuid, place_id uuid, changed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  uid uuid := kept.current_user_id();
  original public.short_ids%ROWTYPE;
  result text;
BEGIN
  IF uid IS NULL OR p_location IS NULL OR p_reason IS NULL
     OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 240
     OR NOT coalesce(p_location IN (SELECT kept.writable_location_ids()), false) THEN
    RAISE EXCEPTION 'no such label' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.* INTO original FROM public.short_ids s
   WHERE s.code = p_old AND s.location_id = p_location AND s.state = 'assigned'
     AND (EXISTS (SELECT 1 FROM public.things t WHERE t.id = s.thing_id AND t.deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM public.places p WHERE p.id = s.place_id AND p.deleted_at IS NULL))
   FOR UPDATE;
  IF original.code IS NULL THEN
    RAISE EXCEPTION 'no such label' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF original.superseded_at IS NOT NULL THEN
    IF original.superseded_by = uid AND original.replacement_code = p_new
       AND original.replacement_reason = btrim(p_reason) THEN
      RETURN QUERY SELECT original.thing_id, original.place_id, false;
      RETURN;
    END IF;
    RAISE EXCEPTION 'no such label' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT c.outcome INTO result FROM kept.claim_blank_code(p_new, original.thing_id, original.place_id) c;
  IF result IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'no such blank label' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.short_ids s SET superseded_at = now(), superseded_by = uid,
         replacement_code = p_new, replacement_reason = btrim(p_reason), is_primary = false
   WHERE s.code = p_old;
  UPDATE public.short_ids s
     SET printed_at = coalesce(s.printed_at, now()), is_primary = s.is_primary OR original.is_primary
   WHERE s.code = p_new;
  RETURN QUERY SELECT original.thing_id, original.place_id, true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kept.replace_printed_label(uuid, character, character, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.replace_printed_label(uuid, character, character, text) TO kept_app;
