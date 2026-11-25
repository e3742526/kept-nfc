import type { PlaceEvidence } from '@kept/shared';
import type pg from 'pg';
import { signFile } from '../files/views.js';
import type { FileStorage } from '../storage/blob-store.js';

type PlaceReference = {
  id: string;
  name: string;
  description: string | null;
  file_id: string | null;
  storage_key: string | null;
  mime: string | null;
  rotation: number | null;
};

/** Each path runs from the root place to the closest place. Description and photo can inherit
 * independently. Load only live evidence visible to the caller and sign a thumbnail once per file. */
export async function placeEvidenceForPaths(
  client: pg.ClientBase,
  files: FileStorage | null,
  paths: readonly (readonly string[])[],
): Promise<(PlaceEvidence | undefined)[]> {
  const ids = [...new Set(paths.flat())];
  if (!ids.length) return paths.map(() => undefined);
  const { rows } = await client.query<PlaceReference>(
    `SELECT p.id, p.name, p.description, photo.*
       FROM public.places p
       LEFT JOIN LATERAL (
         SELECT f.id AS file_id, f.mime, d.storage_key, a.photo_rotation AS rotation
           FROM public.attachments a
           JOIN public.files f ON f.id = a.file_id AND f.location_id = p.location_id
           JOIN public.file_derivatives d ON d.file_id = f.id AND d.variant = 'thumb'
          WHERE $2 AND a.place_id = p.id AND a.location_id = p.location_id
            AND a.role = 'photo' AND NOT a.in_review AND a.location_photo_taken_at IS NULL
            AND a.photo_archived_at IS NULL AND f.mime LIKE 'image/%' AND f.derivative_state = 'ready'
          ORDER BY a.thumbnail_selected_at DESC NULLS LAST, a.sort, a.created_at, a.id
          LIMIT 1
       ) photo ON true
      WHERE p.id = ANY ($1::uuid[]) AND p.deleted_at IS NULL AND NOT p.is_unplaced`,
    [ids, !!files],
  );
  const references = new Map(rows.map((row) => [row.id, row]));
  const urls = new Map<string, Promise<string>>();
  return Promise.all(
    paths.map(async (path) => {
      const nearestFirst = path.map((id) => references.get(id)).reverse();
      const description = nearestFirst.find((place) => place?.description);
      const photo = nearestFirst.find((place) => place?.storage_key);
      const evidence: PlaceEvidence = {};
      if (description?.description) {
        evidence.description = {
          placeId: description.id,
          placeName: description.name,
          text: description.description,
        };
      }
      if (files && photo?.file_id && photo.storage_key && photo.mime) {
        let url = urls.get(photo.file_id);
        if (!url) {
          url = signFile(files, photo.storage_key, photo.file_id, photo.mime, 'thumb').then(
            ({ url }) => url,
          );
          urls.set(photo.file_id, url);
        }
        evidence.referencePhoto = {
          placeId: photo.id,
          placeName: photo.name,
          thumbUrl: await url,
          rotation: photo.rotation ?? 0,
        };
      }
      return evidence.description || evidence.referencePhoto ? evidence : undefined;
    }),
  );
}
