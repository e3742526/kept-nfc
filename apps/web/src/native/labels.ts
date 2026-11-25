import {
  normaliseInputCode,
  parseDeviceLabel,
  parseScan,
  SHORT_CODE,
  storedCodeOf,
} from '@kept/shared';
import { capturePaths } from '@/api/capture/paths';
import type { ReservedLabel, ScanOutcome } from '@/api/capture/types';
import { ApiError } from '@/api/client';
import { capacitorAdapters, type PlatformAdapters } from './adapters';
import type { Connection } from './bridge';
import type { InventoryCache } from './inventory';

export type Target = Extract<ScanOutcome, { outcome: 'open' }>['target'];
export type ScanCandidate = Extract<
  ScanOutcome,
  { outcome: 'legacy_ambiguous' }
>['candidates'][number];

export type ReadResult =
  | { status: 'resolved'; target: Target; cached: boolean }
  | { status: 'ambiguous'; candidates: ScanCandidate[] }
  | { status: 'unassigned'; claim?: { code: string; locationId: string } }
  | {
      status: 'malformed' | 'foreign' | 'unresolved' | 'not_in_your_kept' | 'not_kept';
    };

/** A label's code from its `/l/` path: a short ID folded onto Crockford base32, or a numbered
 * label's alias (`BIN-A09Z-0001`, nothing folded); '' for anything else. */
function labelCodeOf(pathname: string): string {
  const part = /^\/l\/([a-z0-9-]{6,13})$/i.exec(pathname)?.[1] ?? '';
  const alias = parseDeviceLabel(part);
  if (alias && alias.code === part.toUpperCase()) return alias.code;
  const code = normaliseInputCode(part);
  return /^[a-z0-9]{6}$/i.test(part) && SHORT_CODE.test(code) ? code : '';
}

/** `origins`: the server's own, then its label address (`labelOrigins`). */
export function approvedLabel(text: string, origins: string | readonly string[]) {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { status: 'malformed' } as const;
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    return { status: 'malformed' } as const;
  }
  if (!([] as string[]).concat(origins).includes(url.origin)) return { status: 'foreign' } as const;
  const code = labelCodeOf(url.pathname);
  if (url.search || url.hash || !code) return { status: 'malformed' } as const;
  return { status: 'approved', code } as const;
}

/** Rejects `/l/...` URLs pointing at a different SheepKeep server even when scanned as QR codes. */
function checkQrUrlOrigin(text: string, origins: readonly string[]) {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!/^\/l(?:\/|$)/i.test(url.pathname)) return null;
  if (url.username || url.password) return { status: 'malformed' } as const;
  if (!origins.includes(url.origin)) return { status: 'foreign' } as const;
  const code = labelCodeOf(url.pathname);
  if (url.search || url.hash || !code) return { status: 'malformed' } as const;
  return { status: 'approved', code } as const;
}

export function labelUrl(origin: string, code: string): string {
  return `${origin}/l/${encodeURIComponent(code)}`;
}

// The label address (KEPT_LABEL_URL on the server): the origin new labels and NFC tags carry, so
// they keep working while the server moves. Asked once per connection, remembered for offline
// use; until it is known, and for a server with none, it is the server's own origin. Labels and
// tags made under either origin are this server's.
const LABEL_ADDRESS_KEY = 'labelAddressV1';
const labelAddresses = new Map<string, string>();
const labelAddressLoads = new Map<string, Promise<string>>();

function httpsOrigin(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** The label address, asked of the server once per connection (then remembered). */
export function loadLabelAddress(
  connection: Connection,
  adapters: PlatformAdapters = capacitorAdapters,
): Promise<string> {
  const known = labelAddressLoads.get(connection.id);
  if (known) return known;
  const load = (async () => {
    let address: string | null = null;
    try {
      const out = await adapters.transport.request<{ url: string }>(
        connection,
        capturePaths.labelAddress,
      );
      address = httpsOrigin(out.url) ?? connection.origin;
      await adapters.outbox.setValue(connection, LABEL_ADDRESS_KEY, address).catch(() => {});
    } catch {
      // Offline, or an older server: the last answer, else the server's own origin.
      labelAddressLoads.delete(connection.id);
      address = httpsOrigin(
        await adapters.outbox.getValue(connection, LABEL_ADDRESS_KEY).catch(() => null),
      );
    }
    const origin = address ?? connection.origin;
    labelAddresses.set(connection.id, origin);
    return origin;
  })();
  labelAddressLoads.set(connection.id, load);
  return load;
}

/** The origin a new label or tag of this connection carries (its label address once known). */
export function labelBase(connection: Connection): string {
  return labelAddresses.get(connection.id) ?? connection.origin;
}

/** The origins a label of this server may carry: its own, and its label address. */
export function labelOrigins(connection: Connection): string[] {
  const address = labelAddresses.get(connection.id);
  return address && address !== connection.origin
    ? [connection.origin, address]
    : [connection.origin];
}

// Older entries may already be on a tag whose readback failed. Leave them for a physical scan.
const POOL_KEY = 'reservedLabelsV2';

type Pool = Record<string, string[]>;
const poolOperations = new Map<string, Promise<unknown>>();

/** A departing picker may return a code while the next picker is checking one out. */
async function withReservedPool<T>(connection: Connection, run: () => Promise<T>): Promise<T> {
  const previous = poolOperations.get(connection.id) ?? Promise.resolve();
  const operation = previous.then(run, run);
  poolOperations.set(connection.id, operation);
  try {
    return await operation;
  } finally {
    if (poolOperations.get(connection.id) === operation) poolOperations.delete(connection.id);
  }
}

async function readPool(connection: Connection, adapters: PlatformAdapters): Promise<Pool> {
  const raw = await adapters.outbox.getValue(connection, POOL_KEY);
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Pool) : {};
  } catch {
    return {};
  }
}

async function writePool(connection: Connection, pool: Pool, adapters: PlatformAdapters) {
  await adapters.outbox.setValue(connection, POOL_KEY, JSON.stringify(pool));
}

/** Keeps a reserved code that was never written or shown, so the next new label reuses it. */
export async function shelveReservedCode(
  connection: Connection,
  locationId: string,
  code: string,
  adapters: PlatformAdapters = capacitorAdapters,
): Promise<void> {
  await withReservedPool(connection, async () => {
    const pool = await readPool(connection, adapters);
    const held = pool[locationId] ?? [];
    if (held.includes(code)) return;
    pool[locationId] = [...held, code].slice(-20);
    await writePool(connection, pool, adapters);
  }).catch(() => {});
}

/** A shelved code that is still an unclaimed blank of the location, or null. */
export async function takeShelvedCode(
  connection: Connection,
  cache: InventoryCache | undefined,
  locationId: string,
  adapters: PlatformAdapters = capacitorAdapters,
): Promise<ReservedLabel | null> {
  return withReservedPool(connection, async () => {
    const pool = await readPool(connection, adapters);
    const held = [...(pool[locationId] ?? [])];
    if (held.length === 0) return null;
    let found: ReservedLabel | null = null;
    while (!found && held.length) {
      const code = held.shift() as string;
      try {
        const url = labelUrl(await loadLabelAddress(connection, adapters), code);
        const result = await resolveLabel(connection, cache, url, 'nfc', undefined, true, adapters);
        if (result.status === 'unassigned' && result.claim?.locationId === locationId) {
          found = { code, url, locationId };
        }
      } catch {
        // Cannot check it now: leave the rest on the shelf and make a new one.
        held.unshift(code);
        break;
      }
    }
    if (held.length) pool[locationId] = held;
    else delete pool[locationId];
    // Hand out the code only once its removal is durable.
    await writePool(connection, pool, adapters);
    return found;
  }).catch(() => null);
}

/**
 * A new blank code for a label made while adding an item (an NFC tag written now, or one QR
 * label shared now). The capture claims it with `claimCode` when it syncs. `key` is the
 * Idempotency-Key: a retry with the same key answers the same code.
 */
export function reserveLabel(
  connection: Connection,
  locationId: string,
  key: string,
  adapters: PlatformAdapters = capacitorAdapters,
): Promise<ReservedLabel> {
  return adapters.transport.request<ReservedLabel>(connection, capturePaths.labelReserve, {
    method: 'POST',
    idempotencyKey: key,
    body: { locationId },
  });
}

function resolveOfflineFromCache(
  cache: InventoryCache | undefined,
  parsed: ReturnType<typeof parseScan>,
  rawText: string,
): ReadResult {
  if (!cache) return { status: 'unresolved' };

  if (parsed.kind === 'kept') {
    const code = parsed.code;
    const hit = cache.codes.find((entry) => entry.code === code);
    if (hit) {
      if (hit.state === 'retired') return { status: 'not_in_your_kept' };
      if (hit.state === 'blank') {
        const location = cache.locations.find((entry) => entry.id === hit.locationId);
        return location && location.role !== 'viewer'
          ? { status: 'unassigned', claim: { code, locationId: hit.locationId } }
          : { status: 'not_in_your_kept' };
      }
      if (hit.state === 'assigned') {
        if (hit.thingId && cache.things.some((item) => item.id === hit.thingId)) {
          return {
            status: 'resolved',
            target: { id: hit.thingId, kind: 'thing', locationId: hit.locationId },
            cached: true,
          };
        }
        if (hit.placeId && cache.places.some((item) => item.id === hit.placeId)) {
          return {
            status: 'resolved',
            target: { id: hit.placeId, kind: 'place', locationId: hit.locationId },
            cached: true,
          };
        }
      }
    }
    const cachedThing = cache.things.find((item) => item.shortCode === code);
    if (cachedThing) {
      return {
        status: 'resolved',
        target: { id: cachedThing.id, kind: 'thing', locationId: cachedThing.locationId },
        cached: true,
      };
    }
    const keptLegacy = cache.legacyCodes.find(
      (entry) => entry.source === 'kept' && entry.code === code,
    );
    if (keptLegacy) {
      if (keptLegacy.thingId && cache.things.some((item) => item.id === keptLegacy.thingId)) {
        return {
          status: 'resolved',
          target: { id: keptLegacy.thingId, kind: 'thing', locationId: keptLegacy.locationId },
          cached: true,
        };
      }
      if (keptLegacy.placeId && cache.places.some((item) => item.id === keptLegacy.placeId)) {
        return {
          status: 'resolved',
          target: { id: keptLegacy.placeId, kind: 'place', locationId: keptLegacy.locationId },
          cached: true,
        };
      }
    }
    return { status: 'unresolved' };
  }

  const legacyCode =
    parsed.kind === 'homebox'
      ? (parsed.assetId ?? parsed.uuid ?? '').toUpperCase()
      : storedCodeOf(rawText);
  if (legacyCode) {
    const matches = cache.legacyCodes.filter((entry) =>
      parsed.kind === 'homebox'
        ? entry.source === 'homebox' && entry.code === legacyCode
        : entry.code === legacyCode,
    );
    const candidates: ScanCandidate[] = [];
    const seen = new Set<string>();
    for (const entry of matches) {
      const targetId = entry.thingId ?? entry.placeId;
      if (!targetId || seen.has(targetId)) continue;
      const locationName = cache.locations.find((loc) => loc.id === entry.locationId)?.name ?? '';
      if (entry.thingId) {
        const thing = cache.things.find((t) => t.id === entry.thingId);
        if (thing) {
          seen.add(targetId);
          candidates.push({
            id: thing.id,
            kind: 'thing',
            name: thing.name ?? '',
            locationId: entry.locationId,
            locationName,
          });
        }
      } else if (entry.placeId) {
        const place = cache.places.find((p) => p.id === entry.placeId);
        if (place) {
          seen.add(targetId);
          candidates.push({
            id: place.id,
            kind: 'place',
            name: place.name,
            locationId: entry.locationId,
            locationName,
          });
        }
      }
    }
    if (candidates.length === 1 && candidates[0]) {
      const only = candidates[0];
      return {
        status: 'resolved',
        target: { id: only.id, kind: only.kind, locationId: only.locationId },
        cached: true,
      };
    }
    if (candidates.length > 1) {
      return { status: 'ambiguous', candidates };
    }
  }

  return { status: 'unresolved' };
}

export async function resolveLabel(
  connection: Connection,
  cache: InventoryCache | undefined,
  text: string,
  mode: 'nfc' | 'qr',
  format?: string,
  onlineRequired = false,
  adapters: PlatformAdapters = capacitorAdapters,
): Promise<ReadResult> {
  // The label address as known (main.tsx asks for it on start, and before a link is read).
  const origins = labelOrigins(connection);
  const nfcCheck = mode === 'nfc' ? approvedLabel(text, origins) : undefined;
  if (nfcCheck && nfcCheck.status !== 'approved') return nfcCheck;

  const qrCheck = mode === 'qr' ? checkQrUrlOrigin(text, origins) : null;
  if (qrCheck && qrCheck.status !== 'approved') return qrCheck;

  const parsed = parseScan(text, format);

  try {
    const response = await adapters.transport.request<ScanOutcome>(
      connection,
      capturePaths.scanResolve,
      {
        method: 'POST',
        body: { text, ...(format ? { format } : {}) },
      },
    );
    switch (response.outcome) {
      case 'open':
        return { status: 'resolved', target: response.target, cached: false };
      case 'claim':
        return {
          status: 'unassigned',
          // A numbered label is claimed by the short ID the server names for it.
          ...(response.code || parsed.kind === 'kept'
            ? {
                claim: {
                  code: response.code ?? (parsed.kind === 'kept' ? parsed.code : ''),
                  locationId: response.locationId,
                },
              }
            : {}),
        };
      case 'legacy_ambiguous':
        return { status: 'ambiguous', candidates: response.candidates };
      case 'not_kept':
      case 'barcode':
        return { status: 'not_kept' };
      case 'not_in_your_kept':
        return { status: 'not_in_your_kept' };
    }
  } catch (error) {
    if (onlineRequired || !(error instanceof ApiError && error.status === 0)) throw error;
  }

  return resolveOfflineFromCache(cache, parsed, text);
}

export function describeTargetFromCache(
  cache: InventoryCache | undefined,
  target: Target,
): string | null {
  if (!cache) return null;
  if (target.kind === 'thing') {
    return cache.things.find((item) => item.id === target.id)?.name ?? null;
  }
  return cache.places.find((item) => item.id === target.id)?.name ?? null;
}

export async function inspectTagOwner(
  connection: Connection,
  cache: InventoryCache | undefined,
  existingUrl: string,
  adapters: PlatformAdapters = capacitorAdapters,
): Promise<string | null> {
  const checked = approvedLabel(existingUrl, labelOrigins(connection));
  if (checked.status !== 'approved') return null;
  try {
    const resolved = await resolveLabel(
      connection,
      cache,
      existingUrl,
      'nfc',
      undefined,
      false,
      adapters,
    );
    if (resolved.status === 'resolved') {
      return describeTargetFromCache(cache, resolved.target);
    }
  } catch {
    // Non-fatal: still let user inspect/overwrite even if lookup failed.
  }
  return null;
}

export function isTarget(result: ReadResult, id: string, kind: Target['kind'] = 'thing'): boolean {
  return result.status === 'resolved' && result.target.kind === kind && result.target.id === id;
}
