SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '45s';
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "photo_rotation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "photo_archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "thumbnail_selected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_photo_management_chk" CHECK (photo_rotation IN (0, 90, 180, 270) AND
          (photo_rotation = 0 OR
            (file_id IS NOT NULL AND num_nonnulls(thing_id, place_id) = 1
              AND (role = 'photo' OR location_photo_taken_at IS NOT NULL))) AND
          ((photo_archived_at IS NULL AND thumbnail_selected_at IS NULL) OR
            (role = 'photo' AND file_id IS NOT NULL AND num_nonnulls(thing_id, place_id) = 1
              AND (photo_archived_at IS NULL OR thumbnail_selected_at IS NULL))));
--> statement-breakpoint
GRANT UPDATE (photo_rotation, photo_archived_at, thumbnail_selected_at) ON public.attachments TO kept_app;
--> statement-breakpoint

-- Keep the sync cover cache aligned with the active photo selection.
CREATE OR REPLACE FUNCTION kept.refresh_thing_cover() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.thing_id IS NOT NULL THEN
    ids := ids || OLD.thing_id;
  END IF;
  IF TG_OP IN ('UPDATE', 'INSERT') AND NEW.thing_id IS NOT NULL THEN
    ids := ids || NEW.thing_id;
  END IF;
  IF cardinality(ids) = 0 THEN
    RETURN NULL;
  END IF;
  UPDATE public.things t
     SET cover_file_id = c.file_id
    FROM (SELECT x.id,
                 (SELECT a.file_id FROM public.attachments a
                   WHERE a.thing_id = x.id AND a.role = 'photo' AND a.file_id IS NOT NULL
                     AND NOT a.in_review AND a.photo_archived_at IS NULL
                   ORDER BY a.thumbnail_selected_at DESC NULLS LAST, a.sort, a.created_at, a.id LIMIT 1) AS file_id
            FROM unnest(ids) AS x(id)) c
   WHERE t.id = c.id AND t.cover_file_id IS DISTINCT FROM c.file_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER attachments_thing_cover ON public.attachments;
--> statement-breakpoint
CREATE TRIGGER attachments_thing_cover
  AFTER INSERT OR DELETE OR UPDATE OF role, sort, thing_id, file_id, in_review, photo_archived_at, thumbnail_selected_at ON public.attachments
  FOR EACH ROW EXECUTE FUNCTION kept.refresh_thing_cover();
