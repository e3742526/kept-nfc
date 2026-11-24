-- Keep original IDs, hashes and bytes authoritative. A supported original is preferred.
-- A file's bounded display rendition opens indexing to HEIC and large camera originals.
CREATE FUNCTION kept.visual_photo_sources(p_locations uuid[], p_attachment uuid)
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
     AND a.role = 'photo' AND NOT a.in_review
     AND t.deleted_at IS NULL AND t.review_state <> 'draft' AND t.name IS NOT NULL
     AND f.class IN ('photo', 'evidence') AND f.mime LIKE 'image/%'
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.visual_photo_sources(uuid[], uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.visual_photo_sources(uuid[], uuid) TO kept_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION kept.visual_sources(p_locations uuid[], p_attachment uuid)
RETURNS TABLE (attachment_id uuid, location_id uuid, thing_id uuid, file_id uuid,
               content_hash text, storage_key text, bytes bigint, captured_at timestamptz)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT s.attachment_id, s.location_id, s.thing_id, s.file_id, s.content_hash,
         s.storage_key, s.bytes, s.captured_at
    FROM kept.visual_photo_sources(p_locations, p_attachment) s
   WHERE s.use_original OR s.display_key IS NOT NULL
$$;
--> statement-breakpoint
CREATE FUNCTION kept.visual_store(p_attachment uuid, p_location uuid, p_file uuid, p_hash text,
                                  p_generation text, p_vector vector, p_display_key text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_location NOT IN (SELECT kept.writable_location_ids()) THEN RETURN false; END IF;
  IF p_vector IS NOT NULL AND (vector_dims(p_vector) <> 512 OR (p_vector <#> p_vector) >= 0) THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM public.attachments a JOIN public.things t ON t.id = a.thing_id
   WHERE a.id = p_attachment AND a.location_id = p_location FOR UPDATE OF a, t;
  -- A changed display may have finished encoding against its old blob. The row lock also
  -- orders the index commit against display replacement's invalidation trigger.
  IF p_display_key IS NOT NULL THEN
    PERFORM 1 FROM public.file_derivatives d
     WHERE d.file_id = p_file AND d.location_id = p_location
       AND d.variant = 'display' AND d.storage_key = p_display_key FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
  END IF;
  INSERT INTO public.visual_embeddings AS e
    (attachment_id, location_id, file_id, content_hash, region, generation, state, embedding)
  SELECT s.attachment_id, s.location_id, s.file_id, s.content_hash, 'whole', p_generation,
         CASE WHEN p_vector IS NULL THEN 'failed' ELSE 'ready' END, p_vector
    FROM kept.visual_photo_sources(ARRAY[p_location], p_attachment) s
   WHERE s.file_id = p_file AND s.content_hash = p_hash
     AND (CASE WHEN s.use_original THEN p_display_key IS NULL ELSE s.display_key = p_display_key END)
     AND p_location IN (SELECT kept.writable_location_ids())
  ON CONFLICT (attachment_id, content_hash, region, generation) DO UPDATE
      SET location_id = excluded.location_id, file_id = excluded.file_id, state = excluded.state,
          embedding = excluded.embedding, indexed_at = now()
    WHERE e.state <> 'ready' OR excluded.state = 'ready'
       OR e.location_id <> excluded.location_id OR e.file_id <> excluded.file_id;
  RETURN FOUND;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.visual_store(uuid, uuid, uuid, text, text, vector, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.visual_store(uuid, uuid, uuid, text, text, vector, text) TO kept_app;
--> statement-breakpoint
-- Rollback keeps the previous worker's original-only write contract.
CREATE OR REPLACE FUNCTION kept.visual_store(p_attachment uuid, p_location uuid, p_file uuid, p_hash text,
                                             p_generation text, p_vector vector) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT kept.visual_store(p_attachment, p_location, p_file, p_hash, p_generation, p_vector, NULL)
$$;
--> statement-breakpoint
CREATE FUNCTION kept.visual_display_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.visual_embeddings e USING public.files f
   WHERE e.file_id = OLD.file_id AND f.id = OLD.file_id
     AND NOT (
       f.bytes <= 8388608 AND f.width::bigint * f.height <= 20000000
       AND f.width IS NOT NULL AND f.height IS NOT NULL
       AND f.mime IN ('image/jpeg', 'image/png', 'image/webp')
     );
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.visual_display_changed() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER file_derivatives_visual_changed
  AFTER DELETE OR UPDATE OF storage_key, bytes, width, height ON public.file_derivatives
  FOR EACH ROW WHEN (OLD.variant = 'display')
  EXECUTE FUNCTION kept.visual_display_changed();
--> statement-breakpoint
-- Each new display has its own immutable blob namespace, so no running reader (including a
-- cross-account copy of a file) picks up different bytes under the selected rendition key.
CREATE FUNCTION kept.set_file_display(p_file uuid, p_variants jsonb, p_revision uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  f public.files%ROWTYPE;
  namespace uuid;
BEGIN
  SELECT * INTO f FROM public.files x
   WHERE x.id = p_file
     AND x.location_id IN (SELECT kept.writable_location_ids())
     AND x.created_by = kept.current_user_id() FOR UPDATE;
  IF f.id IS NULL THEN
    RAISE EXCEPTION 'no such file of yours' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_revision IS NULL OR p_revision = p_file
     OR jsonb_typeof(p_variants) IS DISTINCT FROM 'array' OR jsonb_array_length(p_variants) = 0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_variants) v
                 WHERE v->>'variant' NOT IN ('display', 'thumb', 'share')) THEN
    RAISE EXCEPTION 'renditions are display, thumb and share, with their own revision'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Scope a revision to its file. A caller cannot supply another file's blob namespace.
  namespace := substr(encode(sha256(convert_to(
    'kept-display-v1:' || p_file::text || ':' || p_revision::text, 'UTF8')), 'hex'), 1, 32)::uuid;
  DELETE FROM public.file_derivatives d
   WHERE d.file_id = f.id
     AND d.variant IN (SELECT v->>'variant' FROM jsonb_array_elements(p_variants) v);
  INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key, width, height,
                                       bytes)
  SELECT f.id, v->>'variant', f.location_id,
         'd/' || namespace::text || '/' || (v->>'variant') || '.jpg',
         (v->>'width')::int, (v->>'height')::int, (v->>'bytes')::bigint
    FROM jsonb_array_elements(p_variants) v;
  UPDATE public.files x SET derivative_state = 'ready' WHERE x.id = f.id;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.set_file_display(uuid, jsonb, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.set_file_display(uuid, jsonb, uuid) TO kept_app;
--> statement-breakpoint
-- A stable keyset cursor allows an operator to pass repeatedly failed sources in a large
-- backfill, and to resume the scan after an interruption. One extra ID signals another page.
CREATE FUNCTION kept.visual_backlog(p_location uuid, p_generation text, p_limit integer, p_after uuid)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT s.attachment_id FROM kept.visual_sources(ARRAY[p_location], NULL) s
    LEFT JOIN public.visual_embeddings e ON e.attachment_id = s.attachment_id
     AND e.location_id = s.location_id AND e.file_id = s.file_id AND e.content_hash = s.content_hash
     AND e.region = 'whole' AND e.generation = p_generation
   WHERE p_location IN (SELECT kept.admin_location_ids())
     AND e.state IS DISTINCT FROM 'ready'
     AND (p_after IS NULL OR s.attachment_id > p_after)
   ORDER BY s.attachment_id
   LIMIT greatest(0, least(coalesce(p_limit, 0), 101))
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION kept.visual_backlog(uuid, text, integer, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION kept.visual_backlog(uuid, text, integer, uuid) TO kept_app;
