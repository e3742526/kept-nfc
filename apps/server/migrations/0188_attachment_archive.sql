-- A photo can be archived: kept, out of the way. Archived photos are not a thing's cover and
-- are not indexed for photo search; restoring clears the mark. Deleting is the existing
-- DELETE /api/v1/attachments/:id.
ALTER TABLE public.attachments ADD COLUMN archived_at timestamptz;
--> statement-breakpoint
GRANT UPDATE (archived_at) ON public.attachments TO kept_app;
--> statement-breakpoint
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
                     AND NOT a.in_review AND a.archived_at IS NULL
                   ORDER BY a.sort, a.created_at, a.id LIMIT 1) AS file_id
            FROM unnest(ids) AS x(id)) c
   WHERE t.id = c.id AND t.cover_file_id IS DISTINCT FROM c.file_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER attachments_thing_cover ON public.attachments;
--> statement-breakpoint
CREATE TRIGGER attachments_thing_cover
  AFTER INSERT OR DELETE OR UPDATE OF role, sort, thing_id, file_id, in_review, archived_at
  ON public.attachments
  FOR EACH ROW EXECUTE FUNCTION kept.refresh_thing_cover();
--> statement-breakpoint
-- Cover caches that already name an archived photo: none can exist yet, so nothing to repair.
CREATE OR REPLACE FUNCTION kept.visual_photo_sources(p_locations uuid[], p_attachment uuid)
RETURNS TABLE (attachment_id uuid, location_id uuid, thing_id uuid, file_id uuid,
               content_hash text, storage_key text, bytes bigint, captured_at timestamptz,
               display_key text, display_bytes bigint, use_original boolean)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT a.id, a.location_id, t.id, f.id, f.sha256::text, f.storage_key, f.bytes, f.created_at,
         d.storage_key, d.bytes,
         f.bytes <= 8388608 AND coalesce(f.width::bigint * f.height, 0) <= 20000000
           AND f.mime IN ('image/jpeg', 'image/png', 'image/webp')
           AND ((f.width IS NOT NULL AND f.height IS NOT NULL) OR d.storage_key IS NULL)
    FROM public.attachments a
    JOIN public.things t ON t.id = a.thing_id AND t.location_id = a.location_id
    JOIN public.files f ON f.id = a.file_id AND f.location_id = a.location_id
    LEFT JOIN public.file_derivatives d ON d.file_id = f.id AND d.location_id = f.location_id
     AND d.variant = 'display' AND d.bytes <= 8388608
     AND d.width <= 2048 AND d.height <= 2048 AND f.derivative_state = 'ready'
   WHERE (p_attachment IS NULL OR a.id = p_attachment)
     AND a.location_id IN (SELECT kept.visual_locations(p_locations))
     AND a.role = 'photo' AND NOT a.in_review AND a.archived_at IS NULL
     AND t.deleted_at IS NULL AND t.review_state <> 'draft' AND t.name IS NOT NULL
     AND f.class IN ('photo', 'evidence') AND f.mime LIKE 'image/%'
$$;
