import { PHOTO_DETAILS_MAX_PHOTOS, PhotoDetails, type ThingDetailsExtraction } from '@kept/shared';
import sharp from 'sharp';
import { z } from 'zod';
import type { ImageInput } from '../ai/call.js';
import { extract } from '../ai/extract.js';
import { requireScope } from '../auth/http.js';
import { aiCaptureState } from '../capture/service.js';
import { withScope } from '../db/scope.js';
import type { KeptApp } from '../http/app.js';
import { AppError, invalid } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { LIMIT_INPUT_PIXELS } from '../storage/derivatives.js';
import { liveThing, requireRole } from '../things/service.js';
import { matchType } from './apply.js';
import { EVIDENCE_MAX_PX, partsFor, type SourceFile } from './image.js';
import { detailsPrompt } from './prompts/details.js';

// POST /api/v1/things/:id/photo-details {attachmentIds?, jpegs?} → 200 PhotoDetails
//   What a thing's photos say about it, for a person editing it to review into the form: the
//   thing's own photos by attachment id and/or photos just taken (JPEG, base64; the phone also
//   saves those to the thing's photos through sync). Read as evidence (upright, at most 3072 px,
//   no metadata, never stored) with the location's provider, like the extract job, but nothing is
//   applied, no extraction attempt is made and nothing is audited: the edit the person saves is
//   (thing.update). The call itself is on the AI ledger. Needs `ai.capture` and AI capture on
//   (409 `ai_unavailable`).

const maxJpegBytes = 4 * 1024 * 1024;
const MAX_NEW_PHOTOS = 2;

const Body = z
  .strictObject({
    attachmentIds: z.array(z.uuid()).max(PHOTO_DETAILS_MAX_PHOTOS).default([]),
    jpegs: z.array(z.base64().min(16).max(maxJpegBytes)).max(MAX_NEW_PHOTOS).default([]),
  })
  .refine(
    (b) =>
      b.attachmentIds.length + b.jpegs.length >= 1 &&
      b.attachmentIds.length + b.jpegs.length <= PHOTO_DETAILS_MAX_PHOTOS,
    `Choose 1 to ${PHOTO_DETAILS_MAX_PHOTOS} photos.`,
  );

/** A photo just taken, as an evidence copy: upright, at most 3072 px, JPEG, no metadata. */
export async function photoEvidence(base64: string): Promise<ImageInput> {
  try {
    const image = sharp(Buffer.from(base64, 'base64'), { limitInputPixels: LIMIT_INPUT_PIXELS });
    if ((await image.metadata()).format !== 'jpeg') throw Error('Expected JPEG');
    const { data, info } = await image
      .rotate()
      .resize({
        width: EVIDENCE_MAX_PX,
        height: EVIDENCE_MAX_PX,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: new Uint8Array(data),
      mediaType: 'image/jpeg',
      width: info.width,
      height: info.height,
    };
  } catch {
    throw invalid('Choose a readable JPEG photo.');
  }
}

export function registerPhotoDetails(app: KeptApp, { ai, files, pools }: InventoryDeps) {
  app.post(
    '/api/v1/things/:id/photo-details',
    {
      bodyLimit: MAX_NEW_PHOTOS * (maxJpegBytes + 64) + 4096,
      schema: {
        params: z.object({ id: z.uuid() }),
        body: Body,
        response: { 200: PhotoDetails },
      },
    },
    async (req) => {
      const scope = requireScope(req);
      if (!ai || !files) throw new AppError('ai_unavailable', 409);
      const { attachmentIds, jpegs } = req.body;
      const found = await withScope(pools.app, scope, async (tx, client) => {
        const thing = await liveThing(client, req.params.id);
        const role = await requireRole(client, thing.location_id, 'ai.capture');
        if ((await aiCaptureState(tx, client, thing.location_id, role)) !== 'on')
          throw new AppError('ai_unavailable', 409);
        const { rows: loc } = await client.query<{ languages: string[]; owner: string }>(
          'SELECT languages, owner_account_id AS owner FROM public.locations WHERE id = $1',
          [thing.location_id],
        );
        const { rows } = await client.query<{
          attachment_id: string;
          file_id: string;
          location_id: string;
          mime: string;
          display_key: string | null;
        }>(
          `SELECT a.id AS attachment_id, f.id AS file_id, f.location_id, f.mime,
                  d.storage_key AS display_key
             FROM public.attachments a JOIN public.files f ON f.id = a.file_id
             LEFT JOIN public.file_derivatives d ON d.file_id = f.id AND d.variant = 'display'
            WHERE a.id = ANY ($1::uuid[]) AND a.thing_id = $2 AND a.role = 'photo'`,
          [attachmentIds, thing.id],
        );
        // In the order asked for; a photo that isn't this thing's (or isn't visible) is a 404.
        const sources: SourceFile[] = attachmentIds.map((id) => {
          const r = rows.find((row) => row.attachment_id === id);
          if (!r) throw new AppError('not_found', 404);
          return {
            attachmentId: r.attachment_id,
            fileId: r.file_id,
            locationId: r.location_id,
            mime: r.mime,
            displayKey: r.display_key,
          };
        });
        return {
          thing,
          languages: loc[0]?.languages ?? ['en'],
          owner: loc[0]?.owner ?? null,
          sources,
        };
      });
      const parts = await partsFor('label', found.sources, {
        blobs: files.blobs,
        textOf: async () => null,
      });
      if (parts.missing.length > 0)
        throw invalid('A photo could not be read yet. Wait for it to finish uploading.');
      const images = [...parts.images, ...(await Promise.all(jpegs.map(photoEvidence)))];
      const result = await extract(await ai.runtime(scope), {
        mode: 'thing',
        schema: 'thing-details',
        images,
        prompt: detailsPrompt({ languages: found.languages, photos: images.length }),
        locationId: found.thing.location_id,
        userId: scope.userId,
        links: { thingId: found.thing.id },
        requestId: req.id,
        jobId: req.id,
        attempt: 1,
      });
      if (result.status === 'no_provider') throw new AppError('ai_unavailable', 409);
      if (result.status === 'paused') throw new AppError('ai_paused', 409);
      if (result.status !== 'ok') throw invalid('No details could be read from these photos.');
      const object = (result.value.value as ThingDetailsExtraction).objects[0];
      if (!object) return {};
      const out: PhotoDetails = {};
      for (const key of ['name', 'brand', 'model', 'serial', 'barcode', 'colour', 'specs'] as const)
        if (object[key]) out[key] = object[key];
      const hint = object.type_hint;
      if (hint && found.owner) {
        const typeId = await withScope(pools.app, scope, (_tx, client) =>
          matchType(client, found.owner as string, hint.value),
        );
        if (typeId) out.type = { id: typeId, value: hint.value, confidence: hint.confidence };
      }
      return out;
    },
  );
}
