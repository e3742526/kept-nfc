// @vitest-environment node
import { defaultPrinterProfile } from '@kept/shared';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import type { LabelBatch } from '@/api/capture/types';
import { ApiError } from '@/api/client';
import type { PrintApi } from './api';
import { DEFAULT_THERMAL_OPTIONS } from './document';
import { printSpec, syncPrintManifest } from './jobs';
import {
  createPrintManifest,
  manifestLabels,
  type PrintManifest,
  PrintStore,
  recordPrint,
} from './store';

const stock = 'thermal_50x20';
const input = {
  owner: 'user',
  locationId: 'location',
  prefix: 'TOL',
  origin: 'https://labels.example.org',
  stock,
  spec: printSpec(
    stock,
    'single',
    defaultPrinterProfile(),
    {
      ...DEFAULT_THERMAL_OPTIONS,
      payload: 'app',
    },
    'Tools',
    '',
  ),
};

function batchOf(job: PrintManifest): LabelBatch {
  return {
    id: job.id,
    kind: 'blank',
    locationId: job.locationId,
    stock,
    startCell: 1,
    createdAt: job.createdAt,
    printedConfirmedAt: null,
    dismissedAt: null,
    labels: manifestLabels(job).map((label) => ({
      code: 'AB1234',
      alias: label.identifier,
      url: label.url,
      kind: 'blank',
    })),
  };
}

function mockApi() {
  return {
    create: vi.fn<PrintApi['create']>(),
    confirm: vi.fn<PrintApi['confirm']>(),
    preview: vi.fn<PrintApi['preview']>(),
    address: vi.fn<PrintApi['address']>(),
    replace: vi.fn<PrintApi['replace']>(),
    registerTag: vi.fn<PrintApi['registerTag']>(),
  };
}

describe('lasting thermal manifests', () => {
  it('persists before printing and syncs an offline print and confirmation without changing codes', async () => {
    const store = new PrintStore({ indexedDB: new IDBFactory(), IDBKeyRange });
    const job = await createPrintManifest(store, input, 2);
    const pending = await store.jobs.get(job.id);
    expect(pending).toEqual(job);
    expect(manifestLabels(job).map((label) => label.name)).toEqual(['Tools', 'Tools']);

    const api = mockApi();
    api.create.mockRejectedValueOnce(new ApiError(0, 'offline', 'offline'));
    expect(await syncPrintManifest(job, api, store)).toEqual(job);
    await recordPrint(store, job.id, 'partial');
    await recordPrint(store, job.id, 'confirmed');

    const batch = batchOf(job);
    api.create.mockResolvedValue({ batch, excluded: { pending: 0, other: 0 } });
    api.confirm
      .mockRejectedValueOnce(new ApiError(0, 'offline', 'offline'))
      .mockResolvedValue(batch);
    const registered = await syncPrintManifest(job, api, store);
    expect(registered.registration).toBe('registered');
    expect(registered.confirmationSynced).toBeUndefined();
    expect(registered.prints.map((print) => print.state)).toEqual(['partial', 'confirmed']);
    expect(manifestLabels(registered)).toEqual(manifestLabels(job));
    expect((await syncPrintManifest(registered, api, store)).confirmationSynced).toBe(true);
    expect(api.create).toHaveBeenCalledTimes(2);
    store.close();
  });

  it('keeps the collided manifest and print history for review', async () => {
    const store = new PrintStore({ indexedDB: new IDBFactory(), IDBKeyRange });
    const [job, other] = await Promise.all([
      createPrintManifest(store, { ...input, prefix: 'TMP' }, 1),
      createPrintManifest(store, { ...input, prefix: 'TMP' }, 1),
    ]);
    expect(job.series).not.toBe(other.series);
    const api = mockApi();
    api.create.mockRejectedValue(new ApiError(409, 'label_series_collision', 'reserved'));
    await recordPrint(store, job.id, 'failed');
    const collision = await syncPrintManifest(job, api, store);
    expect(collision.registration).toBe('collision');
    expect(collision.prints.at(-1)?.state).toBe('failed');
    expect(collision.codes).toEqual(job.codes);
    expect(await syncPrintManifest(collision, api, store)).toEqual(collision);
    expect(api.create).toHaveBeenCalledTimes(1);
    store.close();
  });
});
