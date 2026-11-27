import type { PlatformAdapters } from './adapters';
import type { Connection } from './bridge';
import type { Destination } from './destination';

const RECENT_DESTINATIONS = 'recentDestinations';
const writes = new WeakMap<Connection, Promise<void>>();

export async function readRecentDestinations(connection: Connection, adapters: PlatformAdapters) {
  try {
    const raw = await adapters.outbox.getValue(connection, RECENT_DESTINATIONS);
    const ids: unknown = raw && JSON.parse(raw);
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberDestination(
  connection: Connection,
  adapters: PlatformAdapters,
  id: string,
) {
  const next = (writes.get(connection) ?? Promise.resolve())
    .then(async () => {
      const ids = await readRecentDestinations(connection, adapters);
      await adapters.outbox.setValue(
        connection,
        RECENT_DESTINATIONS,
        JSON.stringify([id, ...ids.filter((item) => item !== id)].slice(0, 6)),
      );
    })
    .catch(() => {});
  writes.set(connection, next);
  return next;
}

const LAST_ADD_DESTINATION = 'lastAddDestination';

/** The place or box the last item or box was added to on this phone, as it was saved. */
export async function readLastAddDestination(
  connection: Connection,
  adapters: PlatformAdapters,
): Promise<Destination | undefined> {
  try {
    const raw = await adapters.outbox.getValue(connection, LAST_ADD_DESTINATION);
    const saved: unknown = raw && JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return;
    const { id, locationId, name, kind } = saved as Record<string, unknown>;
    if (typeof id !== 'string' || typeof locationId !== 'string' || typeof name !== 'string')
      return;
    if (kind !== 'place' && kind !== 'box') return;
    return { id, locationId, name, kind };
  } catch {
    return;
  }
}

export function rememberLastAddDestination(
  connection: Connection,
  adapters: PlatformAdapters,
  { id, locationId, name, kind }: Destination,
) {
  if (kind !== 'place' && kind !== 'box') return Promise.resolve();
  return adapters.outbox
    .setValue(connection, LAST_ADD_DESTINATION, JSON.stringify({ id, locationId, name, kind }))
    .catch(() => {});
}
