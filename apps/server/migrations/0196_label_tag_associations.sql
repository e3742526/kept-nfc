ALTER TABLE "short_ids" ADD COLUMN "nfc_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "short_ids" ADD COLUMN "uhf_epc" text;--> statement-breakpoint
ALTER TABLE "short_ids" ADD CONSTRAINT "short_ids_uhf_epc_uq" UNIQUE("uhf_epc");--> statement-breakpoint
ALTER TABLE "short_ids" ADD CONSTRAINT "short_ids_uhf_epc_chk" CHECK (uhf_epc IS NULL OR uhf_epc ~ '^(?:[0-9A-F]{2}){4,64}$');
--> statement-breakpoint
-- Tags use the existing label registry and inherit its inventory target and lifecycle.
-- EPC values can only be registered once and NFC is set after the client verifies NDEF readback.
CREATE FUNCTION kept.register_label_tag(p_location uuid, p_code char(6), p_kind text, p_epc text)
RETURNS TABLE (thing_id uuid, place_id uuid, changed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  held public.short_ids%ROWTYPE;
BEGIN
  IF kept.current_user_id() IS NULL OR
      NOT coalesce(p_location IN (SELECT kept.writable_location_ids()), false) THEN
    RAISE EXCEPTION 'no such label' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.* INTO held FROM public.short_ids s
   WHERE s.location_id = p_location AND s.code = p_code AND s.state = 'assigned'
     AND (EXISTS (SELECT 1 FROM public.things t WHERE t.id = s.thing_id AND t.deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM public.places p WHERE p.id = s.place_id AND p.deleted_at IS NULL))
   FOR UPDATE;
  IF held.code IS NULL THEN
    RAISE EXCEPTION 'no such label' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_kind = 'nfc' AND p_epc IS NULL THEN
    IF held.nfc_verified_at IS NULL THEN
      UPDATE public.short_ids SET nfc_verified_at = now() WHERE code = p_code;
      RETURN QUERY SELECT held.thing_id, held.place_id, true;
    ELSE
      RETURN QUERY SELECT held.thing_id, held.place_id, false;
    END IF;
  ELSIF p_kind = 'uhf' AND p_epc ~ '^(?:[0-9A-F]{2}){4,64}$' THEN
    IF held.uhf_epc IS NULL THEN
      UPDATE public.short_ids SET uhf_epc = p_epc WHERE code = p_code;
      RETURN QUERY SELECT held.thing_id, held.place_id, true;
    ELSIF held.uhf_epc = p_epc THEN
      RETURN QUERY SELECT held.thing_id, held.place_id, false;
    END IF;
  END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION kept.register_label_tag(uuid, character, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.register_label_tag(uuid, character, text, text) TO kept_app;
--> statement-breakpoint
-- Runtime inserts retain the original columns. Only the authorized functions can write the new
-- lifecycle fields, including when a caller allocates a new short ID.
REVOKE INSERT ON public.short_ids FROM kept_app, kept_system;
--> statement-breakpoint
GRANT INSERT (code, location_id, thing_id, place_id, state, is_primary, printed_at, claimed_at,
              claimed_by, created_at, updated_at, row_version, change_xid)
  ON public.short_ids TO kept_app, kept_system;
