import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { capacitorAdapters, type PlatformAdapters } from './adapters';
import type { Connection } from './bridge';
import type { InventoryCache } from './inventory';
import {
  approvedLabel,
  inspectTagOwner,
  isTarget,
  resolveLabel,
  shelveReservedCode,
  takeShelvedCode,
} from './labels';

const connection: Connection = {
  id: 'https://kept.example.com|user-1|epoch-1',
  origin: 'https://kept.example.com',
  account: 'user-1',
  epoch: 'epoch-1',
};

const baseCache: InventoryCache = {
  asOf: '2026-11-22T20:00:00Z',
  truncated: false,
  locations: [
    {
      id: 'loc-1',
      ownerAccountId: 'acc-1',
      name: 'Home',
      kind: 'home',
      timezone: 'UTC',
      languages: ['en'],
      role: 'owner',
      effectiveModules: [],
      unplacedPlaceId: 'place-1',
      suggestRadiusM: 100,
    },
    {
      id: 'loc-2',
      ownerAccountId: 'acc-1',
      name: 'Cabin',
      kind: 'home',
      timezone: 'UTC',
      languages: ['en'],
      role: 'viewer',
      effectiveModules: [],
      unplacedPlaceId: 'place-2',
      suggestRadiusM: 100,
    },
  ],
  types: [],
  places: [
    {
      id: 'place-1',
      locationId: 'loc-1',
      parentId: null,
      name: 'Garage',
      kindKey: 'room',
      icon: null,
      isUnplaced: false,
      sort: 0,
      deleted: false,
    },
  ],
  things: [
    {
      id: 'box-1',
      locationId: 'loc-1',
      shortCode: '7KQ4MZ',
      labelPrinted: true,
      name: 'Holiday decorations',
      typeId: 'type-box',
      placeId: 'place-1',
      containerId: null,
      quantity: '1',
      aliases: {},
      lifecycle: 'in_use',
      reviewState: 'confirmed',
      locationUncertain: false,
      lastSeenAt: null,
      coverFileId: null,
      isContainer: true,
      deleted: false,
    },
  ],
  codes: [
    {
      code: '7KQ4MZ',
      locationId: 'loc-1',
      state: 'assigned',
      thingId: 'box-1',
      placeId: null,
      isPrimary: true,
      printedAt: '2026-11-22T19:00:00Z',
    },
    {
      code: 'BNK001',
      locationId: 'loc-1',
      state: 'blank',
      thingId: null,
      placeId: null,
      isPrimary: false,
    },
    {
      code: 'BNK002',
      locationId: 'loc-2',
      state: 'blank',
      thingId: null,
      placeId: null,
      isPrimary: false,
    },
    {
      code: 'RET199',
      locationId: 'loc-1',
      state: 'retired',
      thingId: 'box-1',
      placeId: null,
      isPrimary: false,
    },
  ],
  legacyCodes: [
    {
      locationId: 'loc-1',
      source: 'homebox',
      sourceCollection: 'main',
      code: '000-042',
      thingId: 'box-1',
      placeId: null,
    },
  ],
  details: {},
};

function makeAdapters(requestImpl: PlatformAdapters['transport']['request']): PlatformAdapters {
  return {
    ...capacitorAdapters,
    transport: {
      ...capacitorAdapters.transport,
      request: requestImpl,
    },
  };
}

describe('approvedLabel and resolveLabel', () => {
  it('validates HTTPS, origin match, and Crockford short codes strictly', () => {
    expect(approvedLabel('https://kept.example.com/l/7kq4mz', connection.origin)).toEqual({
      status: 'approved',
      code: '7KQ4MZ',
    });
    expect(approvedLabel('https://kept.example.com/l/oIl4mz', connection.origin)).toEqual({
      status: 'approved',
      code: '0114MZ',
    });
    expect(approvedLabel('https://other.example.com/l/7KQ4MZ', connection.origin)).toEqual({
      status: 'foreign',
    });
    expect(approvedLabel('http://kept.example.com/l/7KQ4MZ', connection.origin)).toEqual({
      status: 'malformed',
    });
    expect(approvedLabel('https://kept.example.com/l/7KQ4MZ?q=1', connection.origin)).toEqual({
      status: 'malformed',
    });
    expect(approvedLabel('not-a-url', connection.origin)).toEqual({ status: 'malformed' });
  });

  it('rejects foreign-server URLs for both NFC and QR without calling the backend', async () => {
    const request = vi.fn();
    const adapters = makeAdapters(request);

    expect(
      await resolveLabel(
        connection,
        baseCache,
        'https://other.kept.test/l/7KQ4MZ',
        'nfc',
        undefined,
        false,
        adapters,
      ),
    ).toEqual({ status: 'foreign' });

    expect(
      await resolveLabel(
        connection,
        baseCache,
        'https://other.kept.test/l/7KQ4MZ',
        'qr',
        'qr_code',
        false,
        adapters,
      ),
    ).toEqual({ status: 'foreign' });

    expect(request).not.toHaveBeenCalled();
  });

  it('resolves online outcomes including open, claim, ambiguous, and not_kept', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        outcome: 'open',
        target: { kind: 'thing', id: 'box-1', locationId: 'loc-1' },
      })
      .mockResolvedValueOnce({ outcome: 'claim', locationId: 'loc-1' })
      .mockResolvedValueOnce({
        outcome: 'legacy_ambiguous',
        candidates: [
          {
            locationName: 'Home',
            locationId: 'loc-1',
            name: 'Copy A',
            kind: 'thing',
            id: 't-1',
          },
          {
            locationName: 'Cabin',
            locationId: 'loc-2',
            name: 'Copy B',
            kind: 'thing',
            id: 't-2',
          },
        ],
      })
      .mockResolvedValueOnce({ outcome: 'not_kept', text: 'hello' });
    const adapters = makeAdapters(request);

    const open = await resolveLabel(
      connection,
      baseCache,
      'https://kept.example.com/l/7KQ4MZ',
      'nfc',
      undefined,
      false,
      adapters,
    );
    expect(open).toEqual({
      status: 'resolved',
      target: { kind: 'thing', id: 'box-1', locationId: 'loc-1' },
      cached: false,
    });
    expect(isTarget(open, 'box-1')).toBe(true);

    expect(
      await resolveLabel(connection, baseCache, 'BNK001', 'qr', undefined, false, adapters),
    ).toEqual({ status: 'unassigned', claim: { code: 'BNK001', locationId: 'loc-1' } });

    const ambiguous = await resolveLabel(
      connection,
      baseCache,
      '012345678905',
      'qr',
      'upc_a',
      false,
      adapters,
    );
    expect(ambiguous.status).toBe('ambiguous');

    expect(
      await resolveLabel(connection, baseCache, 'hello', 'qr', undefined, false, adapters),
    ).toEqual({ status: 'not_kept' });
  });

  it('distinguishes cached offline matches, retired, unassigned, and uncached unresolved', async () => {
    const request = vi.fn().mockRejectedValue(new ApiError(0, 'offline', 'Offline'));
    const adapters = makeAdapters(request);

    expect(
      await resolveLabel(
        connection,
        baseCache,
        'https://kept.example.com/l/7KQ4MZ',
        'nfc',
        undefined,
        false,
        adapters,
      ),
    ).toEqual({
      status: 'resolved',
      target: { id: 'box-1', kind: 'thing', locationId: 'loc-1' },
      cached: true,
    });

    expect(
      await resolveLabel(
        connection,
        baseCache,
        'https://kept.example.com/l/RET199',
        'nfc',
        undefined,
        false,
        adapters,
      ),
    ).toEqual({ status: 'not_in_your_kept' });

    expect(
      await resolveLabel(connection, baseCache, 'BNK001', 'qr', undefined, false, adapters),
    ).toEqual({ status: 'unassigned', claim: { code: 'BNK001', locationId: 'loc-1' } });

    expect(
      await resolveLabel(connection, baseCache, 'BNK002', 'qr', undefined, false, adapters),
    ).toEqual({ status: 'not_in_your_kept' });

    // An uncached label offline must be unresolved, never claimed as a nonmatch or absent.
    expect(
      await resolveLabel(
        connection,
        baseCache,
        'https://kept.example.com/l/ZZZZ99',
        'nfc',
        undefined,
        false,
        adapters,
      ),
    ).toEqual({ status: 'unresolved' });

    expect(
      await resolveLabel(
        connection,
        baseCache,
        'https://homebox.old/a/000042',
        'qr',
        undefined,
        false,
        adapters,
      ),
    ).toEqual({
      status: 'resolved',
      target: { id: 'box-1', kind: 'thing', locationId: 'loc-1' },
      cached: true,
    });
  });

  it('inspectTagOwner identifies existing target name on same server only', async () => {
    const request = vi.fn().mockResolvedValue({
      outcome: 'open',
      target: { kind: 'thing', id: 'box-1', locationId: 'loc-1' },
    });
    const adapters = makeAdapters(request);

    expect(
      await inspectTagOwner(connection, baseCache, 'https://kept.example.com/l/7KQ4MZ', adapters),
    ).toBe('Holiday decorations');

    expect(
      await inspectTagOwner(connection, baseCache, 'https://other.example.com/l/7KQ4MZ', adapters),
    ).toBeNull();
  });
});

describe('the shelf of reserved label codes', () => {
  const locationId = 'loc-1';
  function shelfAdapters(online: (code: string) => 'blank' | 'taken' | 'offline') {
    const kv = new Map<string, string>();
    const adapters = {
      ...makeAdapters(vi.fn()),
      outbox: {
        ...makeAdapters(vi.fn()).outbox,
        getValue: async (_c: Connection, key: string) => kv.get(key),
        setValue: async (_c: Connection, key: string, data: string) => {
          kv.set(key, data);
        },
      },
      transport: {
        ...makeAdapters(vi.fn()).transport,
        request: async (_c: Connection, _path: string, options?: { body?: { text?: string } }) => {
          const code = /\/l\/([A-Z0-9]{6})/.exec(options?.body?.text ?? '')?.[1] ?? '';
          const state = online(code);
          if (state === 'offline') throw new ApiError(0, 'offline', 'Offline');
          return state === 'blank'
            ? { outcome: 'claim', locationId }
            : { outcome: 'open', target: { kind: 'thing', id: 'x', locationId } };
        },
      },
    } as unknown as PlatformAdapters;
    return { adapters, kv };
  }

  it('hands back an unused reserved code once, and skips one that has been claimed since', async () => {
    const { adapters } = shelfAdapters((code) => (code === 'TKN234' ? 'taken' : 'blank'));
    await shelveReservedCode(connection, locationId, 'TKN234', adapters);
    await shelveReservedCode(connection, locationId, 'FRE234', adapters);
    await shelveReservedCode(connection, locationId, 'FRE234', adapters);
    const first = await takeShelvedCode(connection, undefined, locationId, adapters);
    expect(first).toEqual({
      code: 'FRE234',
      url: `${connection.origin}/l/FRE234`,
      locationId,
    });
    expect(await takeShelvedCode(connection, undefined, locationId, adapters)).toBeNull();
    expect(await takeShelvedCode(connection, undefined, 'other', adapters)).toBeNull();
  });

  it('keeps the shelf when the check cannot be made, instead of dropping the code', async () => {
    const { adapters, kv } = shelfAdapters(() => 'offline');
    await shelveReservedCode(connection, locationId, 'FRE234', adapters);
    expect(await takeShelvedCode(connection, undefined, locationId, adapters)).toBeNull();
    expect(JSON.parse(kv.get('reservedLabelsV2') as string)).toEqual({ [locationId]: ['FRE234'] });
  });

  it('leaves legacy reservations for physical scans', async () => {
    const { adapters, kv } = shelfAdapters(() => 'blank');
    const legacy = JSON.stringify({ [locationId]: ['FRE234'] });
    kv.set('reservedLabels', legacy);
    expect(await takeShelvedCode(connection, undefined, locationId, adapters)).toBeNull();
    expect(kv.get('reservedLabels')).toBe(legacy);
  });

  it('preserves a late return while another capture checks out a reserved code', async () => {
    const { adapters } = shelfAdapters(() => 'blank');
    await shelveReservedCode(connection, locationId, 'FRE234', adapters);
    const [first] = await Promise.all([
      takeShelvedCode(connection, undefined, locationId, adapters),
      shelveReservedCode(connection, locationId, 'RSV234', adapters),
    ]);
    expect(first?.code).toBe('FRE234');
    const checkouts = await Promise.all([
      takeShelvedCode(connection, undefined, locationId, adapters),
      takeShelvedCode(connection, undefined, locationId, adapters),
    ]);
    expect(checkouts.map((label) => label?.code)).toEqual(['RSV234', undefined]);
  });
});
