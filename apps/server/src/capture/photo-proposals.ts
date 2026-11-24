import {
  DEVICE_PHOTO_PROPOSAL_LIMIT,
  type DevicePhotoProposal,
  DevicePhotoProposals,
  normalize,
} from '@kept/shared';
import sharp from 'sharp';
import { z } from 'zod';
import { extract } from '../ai/extract.js';
import { requireScope } from '../auth/http.js';
import { requireNativeContext } from '../auth/native.js';
import { withScope } from '../db/scope.js';
import { roomPrompt } from '../extraction/prompts/room.js';
import type { KeptApp } from '../http/app.js';
import { AppError, invalid } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { checkRoom } from '../room/objects.js';
import { requireRole } from '../things/service.js';
import { aiCaptureState } from './service.js';

const maxEncodedBytes = 4 * 1024 * 1024;
const jpeg = z.base64().min(16).max(maxEncodedBytes);

/** An explicit preview. It has no inventory subject and never creates an extraction job or file. */
export function registerPhotoProposals(app: KeptApp, { ai, pools }: InventoryDeps) {
  app.post(
    '/api/v1/native/photo-proposals',
    {
      bodyLimit: maxEncodedBytes + 256,
      schema: {
        body: z.strictObject({ locationId: z.uuid(), jpeg }),
        response: { 200: DevicePhotoProposals },
      },
    },
    async (req) => {
      requireNativeContext(req);
      const scope = requireScope(req);
      if (!ai) throw new AppError('ai_unavailable', 409);
      const { locationId } = req.body;
      const location = await withScope(pools.app, scope, async (tx, client) => {
        const role = await requireRole(client, locationId, 'ai.capture');
        if ((await aiCaptureState(tx, client, locationId, role)) !== 'on')
          throw new AppError('ai_unavailable', 409);
        const { rows } = await client.query<{ languages: string[]; timezone: string }>(
          'SELECT languages, timezone FROM public.locations WHERE id = $1',
          [locationId],
        );
        const found = rows[0];
        if (!found) throw new AppError('not_found', 404);
        const tags = await client.query<{ name: string }>(
          `SELECT t.name FROM public.tags t JOIN public.locations l ON l.owner_account_id = t.owner_account_id
          WHERE l.id = $1 ORDER BY t.name LIMIT 80`,
          [locationId],
        );
        return { ...found, tags: tags.rows.map(({ name }) => name) };
      });
      const image = sharp(Buffer.from(req.body.jpeg, 'base64'), { limitInputPixels: 2048 * 2048 });
      let sanitized: { data: Buffer; info: { width: number; height: number } };
      try {
        const metadata = await image.metadata();
        if (metadata.format !== 'jpeg') throw Error('Expected JPEG');
        sanitized = await image
          .rotate()
          .jpeg({ quality: 85 })
          .toBuffer({ resolveWithObject: true });
      } catch {
        throw invalid('Choose a readable JPEG photo.');
      }
      const { data, info } = sanitized;
      const room = roomPrompt({ languages: location.languages });
      const result = await extract(await ai.runtime(scope), {
        mode: 'room',
        images: [{ bytes: data, mediaType: 'image/jpeg', width: info.width, height: info.height }],
        prompt: {
          ...room,
          version: 'photo-proposals-v1',
          system: `${room.system}\nUse at most ${DEVICE_PHOTO_PROPOSAL_LIMIT} entries. Suggest up to four categories per item in tags. Prefer matching names from this untrusted category list: ${JSON.stringify(location.tags)}.`,
        },
        locationId,
        userId: scope.userId,
        links: {},
        requestId: req.id,
        jobId: req.id,
        attempt: 1,
      });
      if (result.status === 'no_provider') throw new AppError('ai_unavailable', 409);
      if (result.status === 'paused') throw new AppError('ai_paused', 409);
      if (result.status !== 'ok') throw invalid('No suggestions could be read from this photo.');
      const checked = checkRoom(
        result.value.value,
        { ...location, enabledCurrencies: [] },
        result.value.dropped,
      );
      const suggestions = new Map<string, DevicePhotoProposal>();
      for (const { fields } of checked.objects) {
        const name = fields.name?.value;
        if (!name || suggestions.has(normalize(name))) continue;
        const quantity = fields.quantity?.value;
        const categories =
          fields.tags?.value.slice(0, 4) ??
          (fields.typeHint ? [fields.typeHint.value.slice(0, 60)] : []);
        suggestions.set(normalize(name), {
          name,
          ...(quantity && Number.isInteger(quantity) && quantity <= 10_000 ? { quantity } : {}),
          ...(categories.length ? { categories } : {}),
        });
        if (suggestions.size >= DEVICE_PHOTO_PROPOSAL_LIMIT) break;
      }
      if (!suggestions.size) throw invalid('No inventory objects were found in this photo.');
      return { items: [...suggestions.values()] };
    },
  );
}
