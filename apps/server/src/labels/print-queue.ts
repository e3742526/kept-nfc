import type pg from 'pg';
import { z } from 'zod';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { AppError, notFound } from '../http/errors.js';
import { locationModuleSet } from '../http/modules.js';
import { type Ctx, requireRole } from '../things/service.js';
import { CreateBatchBody, createBatch, dismissBatch } from './service.js';

const kind = z.enum(['thing', 'place']);
const target = { locationId: z.uuid(), kind, recordId: z.uuid() };
const maxQueueSize = 500;

export const QueueAction = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('add'), ...target }),
  z.strictObject({ action: z.literal('remove'), ...target }),
  z.strictObject({
    action: z.literal('prepare'),
    locationId: target.locationId,
    kind,
    stock: CreateBatchBody.shape.stock,
  }),
]);
export const QueueEntry = z.object({
  ...target,
  batchId: z.uuid().nullable(),
  name: z.string().nullable(),
  available: z.boolean(),
});
export const QueueResult = z.object({
  items: z.array(QueueEntry),
  batchId: z.uuid().optional(),
});
type Entry = z.infer<typeof QueueEntry>;

export async function readPrintQueue(client: pg.ClientBase): Promise<Entry[]> {
  const { rows } = await client.query<Entry>(
    `SELECT q.location_id AS "locationId", q.kind, q.record_id AS "recordId",
            q.batch_id AS "batchId", coalesce(t.name, p.name) AS name,
            (t.id IS NOT NULL OR p.id IS NOT NULL) AS available
       FROM public.label_print_queue q
       LEFT JOIN public.things t ON q.kind = 'thing' AND t.id = q.record_id
         AND t.location_id = q.location_id AND t.deleted_at IS NULL
       LEFT JOIN public.places p ON q.kind = 'place' AND p.id = q.record_id
         AND p.location_id = q.location_id AND p.deleted_at IS NULL
      ORDER BY q.queued_at, q.record_id LIMIT $1`,
    [maxQueueSize],
  );
  return rows;
}

export async function changePrintQueue(
  ctx: Ctx,
  publicUrl: string,
  input: z.infer<typeof QueueAction>,
): Promise<z.infer<typeof QueueResult>> {
  const { client, tx, scope } = ctx;
  const locationId = input.locationId.toLowerCase();
  await requireRole(client, locationId, 'labels.use');
  if (input.action !== 'remove' && !(await locationModuleSet(tx, locationId))?.has('labels')) {
    throw new AppError('module_off', 409);
  }
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('kept.label_queue:' || kept.current_user_id()::text, 0))",
  );
  const items = await readPrintQueue(client);
  if (input.action === 'prepare') {
    const group = items.filter((row) => row.locationId === locationId && row.kind === input.kind);
    const ready = group.find((row) => row.batchId);
    if (ready?.batchId) return { items, batchId: ready.batchId };
    const ids = group.filter((row) => row.available).map((row) => row.recordId);
    if (!ids.length) throw notFound();
    const kind = input.kind === 'thing' ? 'things' : 'places';
    const result = await createBatch(ctx, publicUrl, {
      locationId,
      kind,
      stock: input.stock,
      ...(kind === 'things' ? { thingIds: ids } : { placeIds: ids }),
    });
    if (!('batch' in result)) throw new Error('Print queue did not create a batch');
    const { batch } = result;
    const printedIds = batch.labels.flatMap((label) => (label.targetId ? [label.targetId] : []));
    await client.query(
      `UPDATE public.label_print_queue SET batch_id = $1
        WHERE location_id = $2 AND kind = $3 AND record_id = ANY($4::uuid[])`,
      [batch.id, locationId, input.kind, printedIds],
    );
    return { items: await readPrintQueue(client), batchId: batch.id };
  }

  const recordId = input.recordId.toLowerCase();
  let changed: number | null;
  if (input.action === 'add') {
    if (
      items.some(
        (row) =>
          row.recordId === recordId && row.kind === input.kind && row.locationId === locationId,
      )
    ) {
      return { items };
    }
    if (
      items.length >= maxQueueSize &&
      !items.some((row) => row.recordId === recordId && row.kind === input.kind)
    )
      throw new AppError('conflict', 409, 'The print queue is full.');
    const table = input.kind === 'thing' ? 'things' : 'places';
    const live = input.kind === 'place' ? 'AND NOT is_unplaced' : '';
    const { rowCount } = await client.query(
      `INSERT INTO public.label_print_queue (user_id, location_id, kind, record_id)
       SELECT kept.current_user_id(), location_id, $3, id FROM public.${table}
        WHERE id = $1 AND location_id = $2 AND deleted_at IS NULL ${live}
       ON CONFLICT (user_id, kind, record_id, location_id) DO NOTHING`,
      [recordId, locationId, input.kind],
    );
    if (!rowCount) throw notFound();
    // A moved record gets a new row in its current location. The scope of a saved row is fixed.
    await client.query(
      `DELETE FROM public.label_print_queue WHERE record_id = $1 AND location_id <> $2 AND kind = $3`,
      [recordId, locationId, input.kind],
    );
    changed = rowCount;
  } else {
    const queued = items.find(
      (row) =>
        row.recordId === recordId && row.kind === input.kind && row.locationId === locationId,
    );
    if (queued?.batchId) {
      // Return the other labels to the queue so the next print excludes this record.
      await dismissBatch(ctx, publicUrl, queued.batchId);
      await client.query(
        'UPDATE public.label_print_queue SET batch_id = NULL WHERE batch_id = $1',
        [queued.batchId],
      );
    }
    const result = await client.query(
      `DELETE FROM public.label_print_queue WHERE location_id = $1 AND kind = $2 AND record_id = $3`,
      [locationId, input.kind, recordId],
    );
    changed = result.rowCount;
  }
  if (changed) {
    await audited(tx, {
      locationId,
      actor: actorOf(scope),
      action: input.action === 'add' ? 'labels.queue_add' : 'labels.queue_remove',
      entity: { type: 'label_print_queue', id: recordId },
      ...(input.action === 'add'
        ? { after: { kind: input.kind } }
        : { before: { kind: input.kind } }),
      requestId: ctx.requestId,
    });
  }
  return { items: await readPrintQueue(client) };
}
