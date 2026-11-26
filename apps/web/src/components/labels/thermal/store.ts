import {
  createDeviceLabelBatch,
  deviceLabelReference,
  type PrinterProfile,
  type ThermalBatchSpec,
} from '@kept/shared';
import Dexie, { type Table } from 'dexie';
import type { CreateLabelBatchBody, LabelBatch } from '@/api/capture/types';
import type { ThermalContent } from './document';

export type PrintState = 'opened' | 'submitted' | 'cancelled' | 'failed' | 'partial' | 'confirmed';
export type Registration = 'pending' | 'registered' | 'collision' | 'address-changed' | 'blocked';

export type PrintManifest = {
  id: string;
  owner: string;
  locationId: string;
  prefix: string;
  series: string;
  origin: string;
  stock: string;
  spec: ThermalBatchSpec;
  createdAt: string;
  codes: string[];
  registration: Registration;
  prints: { at: string; state: PrintState }[];
  confirmedAt?: string;
  confirmationSynced?: boolean;
};

type Preferences = {
  owner: string;
  profiles: PrinterProfile[];
  profileId: string;
  stock: string;
  address?: string | undefined;
};

class PrintStore extends Dexie {
  declare jobs: Table<PrintManifest, string>;
  declare preferences: Table<Preferences, string>;

  constructor(options?: ConstructorParameters<typeof Dexie>[1]) {
    // The offline inventory orphan scanner owns the kept-* database namespace.
    super('sheepkeep-thermal-printing', options);
    this.version(1).stores({
      jobs: 'id, [owner+locationId], &[owner+prefix+series]',
      preferences: 'owner',
    });
  }
}

export { PrintStore };
export const printStore = new PrintStore();

export async function createPrintManifest(
  store: PrintStore,
  input: Pick<PrintManifest, 'owner' | 'locationId' | 'prefix' | 'origin' | 'stock' | 'spec'>,
  count: number,
): Promise<PrintManifest> {
  return store.transaction('rw', store.jobs, async () => {
    const existing = await store.jobs
      .where('[owner+prefix+series]')
      .between([input.owner, input.prefix, Dexie.minKey], [input.owner, input.prefix, Dexie.maxKey])
      .toArray();
    const reserved = new Set(existing.map((row) => row.series));
    const batch = createDeviceLabelBatch(input.prefix, count, (_prefix, series) =>
      reserved.has(series),
    );
    const manifest: PrintManifest = {
      ...input,
      id: batch.id,
      series: batch.batchId,
      codes: batch.labels.map((label) => label.code),
      createdAt: new Date().toISOString(),
      registration: 'pending',
      prints: [],
    };
    await store.jobs.add(manifest);
    return manifest;
  });
}

export function registrationBody(job: PrintManifest): CreateLabelBatchBody {
  return {
    id: job.id,
    locationId: job.locationId,
    kind: 'blank',
    series: { prefix: job.prefix, id: job.series, origin: job.origin },
    blankCount: job.codes.length,
    stock: job.stock,
    thermal: job.spec,
  };
}

export function manifestLabels(job: PrintManifest): ThermalContent[] {
  return job.codes.map((identifier) => ({
    identifier,
    url: `${job.origin}/l/${deviceLabelReference(identifier, job.id)}`,
    name: job.spec.category,
    category: job.spec.category,
    writeIn: job.prefix === 'TMP' && !job.spec.category,
    contents: job.spec.contents,
    drawerContents: job.spec.contents,
  }));
}

export function batchLabels(batch: Pick<LabelBatch, 'labels' | 'thermal'>): ThermalContent[] {
  return batch.labels.map((label) => ({
    identifier: label.alias ?? label.code,
    url: label.url,
    name: label.name ?? batch.thermal?.category,
    writeIn: label.kind === 'blank' && label.alias?.startsWith('TMP-') && !batch.thermal?.category,
    location: label.path,
    barcode: label.barcode,
    contents: batch.thermal?.contents || label.model,
    category: label.category ?? batch.thermal?.category,
    drawerContents: batch.thermal?.contents || label.drawerContents || label.name,
    drawerPosition: label.drawerPosition,
    nfc: label.nfc,
    uhf: label.uhf,
  }));
}

export function matchedRegistration(job: PrintManifest, batch: LabelBatch): boolean {
  const expected = manifestLabels(job);
  return (
    batch.id === job.id &&
    batch.labels.length === expected.length &&
    batch.labels.every(
      (label, i) => label.alias === expected[i]?.identifier && label.url === expected[i]?.url,
    )
  );
}

export async function recordPrint(store: PrintStore, id: string, state: PrintState) {
  await store.jobs
    .where('id')
    .equals(id)
    .modify((row) => {
      const at = new Date().toISOString();
      row.prints.push({ at, state });
      if (state === 'confirmed') row.confirmedAt ??= at;
    });
}
