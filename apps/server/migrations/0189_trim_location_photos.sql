-- Retention follows the logged time, not the arrival order of offline uploads.
-- Reassignments must also keep the cap when an item is merged or converted.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE FUNCTION kept.trim_location_photos() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.attachments
    WHERE id IN (
      SELECT a.id
      FROM public.attachments a
      WHERE a.location_id = NEW.location_id
        AND a.location_photo_taken_at IS NOT NULL
        AND ((NEW.thing_id IS NOT NULL AND a.thing_id = NEW.thing_id)
          OR (NEW.place_id IS NOT NULL AND a.place_id = NEW.place_id))
      ORDER BY a.location_photo_taken_at DESC, a.id DESC
      OFFSET 3
    );
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER attachments_trim_location_photos
  AFTER INSERT OR UPDATE OF thing_id, place_id ON public.attachments
  FOR EACH ROW WHEN (NEW.location_photo_taken_at IS NOT NULL)
  EXECUTE FUNCTION kept.trim_location_photos();
