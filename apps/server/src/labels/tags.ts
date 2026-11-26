import { z } from 'zod';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { AppError, notFound, pgErrorOf } from '../http/errors.js';
import { type Ctx, requireRole } from '../things/service.js';
import { shortId } from './series.js';

const common = {
  locationId: z.uuid(),
  label: z.string().trim().min(1).max(1024),
};

export const Epc = z
  .string()
  .trim()
  .regex(/^(?:[A-Fa-f0-9]{2}){4,64}$/)
  .toUpperCase();

export const RegisterTagBody = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('nfc') }),
  z.strictObject({ ...common, kind: z.literal('uhf'), epc: Epc }),
]);

export const RegisterTagResult = z.object({ configured: z.literal(true) });

export async function registerTag(ctx: Ctx, body: z.infer<typeof RegisterTagBody>) {
  const locationId = body.locationId.toLowerCase();
  await requireRole(ctx.client, locationId, 'labels.use');
  const code = await shortId(ctx.client, body.label);
  if (!code) throw notFound();
  const epc = body.kind === 'uhf' ? body.epc : null;
  const conflict = () =>
    new AppError('conflict', 409, 'The EPC or label already has a registration.');
  const { rows } = await ctx.client
    .query<{
      thing_id: string | null;
      place_id: string | null;
      changed: boolean;
    }>('SELECT * FROM kept.register_label_tag($1, $2, $3, $4)', [locationId, code, body.kind, epc])
    .catch((error: unknown) => {
      if (pgErrorOf(error)?.constraint === 'short_ids_uhf_epc_uq') throw conflict();
      throw error;
    });
  const row = rows[0];
  if (row === undefined) throw conflict();
  if (row.changed) {
    const id = row.thing_id ?? row.place_id;
    if (!id) throw notFound();
    await audited(ctx.tx, {
      locationId,
      actor: actorOf(ctx.scope),
      action: 'label.tag.register',
      entity: { type: row.thing_id ? 'thing' : 'place', id },
      after: { code, ...(epc ? { uhf_epc: epc } : { nfc_verified: true }) },
      requestId: ctx.requestId,
    });
  }
  return { configured: true as const };
}
