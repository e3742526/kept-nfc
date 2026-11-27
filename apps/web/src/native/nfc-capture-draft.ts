import { z } from 'zod';
import type { PlatformAdapters } from './adapters';
import type { Connection } from './bridge';
import { resolveDestination } from './destination';
import type { InventoryCache } from './inventory';

const key = 'nfcItemDrafts';
const draftSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  url: z.url(),
  locationId: z.uuid(),
  destinationId: z.uuid(),
  verified: z.boolean(),
  name: z.string(),
  note: z.string(),
  quantity: z.string(),
  tags: z.array(z.string()),
  intent: z.enum(['record', 'add']),
  typeId: z.uuid().optional(),
  customDraft: z.record(z.string(), z.unknown()).optional(),
  originals: z
    .array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        mime: z.string(),
        role: z.enum(['photo', 'document']),
        bytes: z.number().int().positive(),
      }),
    )
    .default([]),
});
export type NfcCaptureDraft = z.infer<typeof draftSchema>;

export function destinationForNfcDraft(cache: InventoryCache, draft: NfcCaptureDraft) {
  const original = resolveDestination(cache, draft.destinationId);
  if (original?.locationId === draft.locationId) return original;
  const unplaced = cache.places.find(
    (place) => place.locationId === draft.locationId && place.isUnplaced,
  );
  return unplaced && resolveDestination(cache, unplaced.id);
}

const writes = new WeakMap<Connection, Promise<void>>();

async function readDrafts(connection: Connection, adapters: PlatformAdapters) {
  const stored = await adapters.outbox.getValue(connection, key);
  return stored ? z.array(draftSchema).parse(JSON.parse(stored)) : [];
}

export async function findNfcDraft(
  connection: Connection,
  adapters: PlatformAdapters,
  url: string,
) {
  await writes.get(connection);
  const draft = (await readDrafts(connection, adapters)).find((entry) => entry.url === url);
  if (!draft) return;
  // A capture can be committed just before the app exits, before its draft is removed.
  const [pending, completed] = await Promise.all([
    adapters.outbox.list(connection),
    adapters.outbox.completions(connection),
  ]);
  if (completed[draft.id] || pending.some(({ capture }) => capture.id === draft.id)) return;
  return draft;
}

export function updateNfcDraft(
  connection: Connection,
  adapters: PlatformAdapters,
  id: string,
  draft?: NfcCaptureDraft,
) {
  const next = (writes.get(connection) ?? Promise.resolve()).then(async () => {
    const entries = (await readDrafts(connection, adapters)).filter((entry) => entry.id !== id);
    if (draft) entries.push(draft);
    await adapters.outbox.setValue(connection, key, JSON.stringify(entries));
  });
  writes.set(
    connection,
    next.catch(() => {}),
  );
  return next;
}
