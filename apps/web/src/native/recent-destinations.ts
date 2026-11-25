import type { PlatformAdapters } from './adapters';
import type { Connection } from './bridge';

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
