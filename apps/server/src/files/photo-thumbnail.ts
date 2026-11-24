/** Pick the preferred visible photo with a ready thumbnail, or the first available photo. */
export const photoThumbnailJoin = (thing: string, alias: string) => `LEFT JOIN LATERAL (
  SELECT a.id, a.file_id, a.photo_rotation
    FROM public.attachments a
    JOIN public.file_derivatives d ON d.file_id = a.file_id AND d.variant = 'thumb'
   WHERE a.thing_id = ${thing} AND a.role = 'photo'
     AND NOT a.in_review AND a.photo_archived_at IS NULL
   ORDER BY a.thumbnail_selected_at DESC NULLS LAST, a.sort, a.created_at, a.id
   LIMIT 1
) ${alias} ON true`;
