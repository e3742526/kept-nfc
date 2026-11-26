import { z } from 'zod';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { notFound } from '../http/errors.js';
import { type Ctx, requireRole } from '../things/service.js';
import { shortId } from './series.js';

export const ReplaceLabelBody = z.strictObject({
  locationId: z.uuid(),
  previous: z.string().trim().min(1).max(1024),
  replacement: z.string().trim().min(1).max(1024),
  reason: z.string().trim().min(1).max(240),
});
export const ReplaceLabelResult = z.object({ kind: z.enum(['thing', 'place']), id: z.uuid() });

export async function replaceLabel(ctx: Ctx, body: z.infer<typeof ReplaceLabelBody>) {
  const locationId = body.locationId.toLowerCase();
  await requireRole(ctx.client, locationId, 'labels.use');
  const previous = await shortId(ctx.client, body.previous);
  const replacement = await shortId(ctx.client, body.replacement);
  if (!previous || !replacement || previous === replacement) throw notFound();
  const { rows } = await ctx.client.query<{
    thing_id: string | null;
    place_id: string | null;
    changed: boolean;
  }>('SELECT * FROM kept.replace_printed_label($1, $2, $3, $4)', [
    locationId,
    previous,
    replacement,
    body.reason,
  ]);
  const row = rows[0];
  const id = row?.thing_id ?? row?.place_id;
  if (!id) throw notFound();
  const kind = row?.thing_id ? ('thing' as const) : ('place' as const);
  if (row?.changed)
    await audited(ctx.tx, {
      locationId,
      actor: actorOf(ctx.scope),
      action: 'label.replace',
      entity: { type: kind, id },
      before: { code: previous },
      after: { code: replacement, reason: body.reason },
      requestId: ctx.requestId,
    });
  return { kind, id };
}
