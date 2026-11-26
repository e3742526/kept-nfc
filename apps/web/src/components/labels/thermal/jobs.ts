import type { PrinterProfile, ThermalBatchSpec, ThermalLayout } from '@kept/shared';
import { isApiError } from '@/api/client';
import type { PrintApi } from './api';
import type { ThermalOptions } from './document';
import {
  matchedRegistration,
  type PrintManifest,
  type PrintStore,
  printStore,
  registrationBody,
} from './store';

export function printSpec(
  stock: string,
  layout: ThermalLayout,
  profile: PrinterProfile,
  options: ThermalOptions,
  category: string,
  contents: string,
): ThermalBatchSpec {
  return {
    layout,
    profile: {
      dpi: profile.dpi,
      orientation: profile.orientation,
      scale: profile.scale,
      printableWidth: profile.printableWidth,
      printableHeight: profile.printableHeight,
      maxMediaWidth: profile.maxMediaWidth,
      minMediaWidth: profile.minMediaWidth,
      minFeedLength: profile.minFeedLength,
      qrMm: profile.qrMm,
      calibration: profile.calibration[stock],
    },
    options,
    ...(category.trim() ? { category: category.trim() } : {}),
    ...(contents.trim() ? { contents: contents.trim() } : {}),
  };
}

export async function syncPrintManifest(
  job: PrintManifest,
  api: PrintApi,
  store: PrintStore = printStore,
): Promise<PrintManifest> {
  if (job.registration === 'collision') return job;
  if (job.registration === 'registered') {
    if (job.confirmedAt && !job.confirmationSynced) await syncPrintConfirmation(job, api, store);
    return (await store.jobs.get(job.id)) ?? job;
  }
  let registration: PrintManifest['registration'];
  try {
    const { batch } = await api.create(registrationBody(job));
    registration = matchedRegistration(job, batch) ? 'registered' : 'blocked';
  } catch (error) {
    if (isApiError(error) && error.code === 'offline') return job;
    if (isApiError(error) && error.code === 'label_series_collision') registration = 'collision';
    else if (isApiError(error) && error.code === 'label_address_changed')
      registration = 'address-changed';
    else registration = 'blocked';
  }
  // A retry from another tab must not replace confirmation or print attempts.
  await store.jobs
    .where('id')
    .equals(job.id)
    .modify((row) => {
      if (row.registration !== 'registered') row.registration = registration;
    });
  const updated = (await store.jobs.get(job.id)) ?? job;
  if (updated.registration === 'registered' && updated.confirmedAt) {
    await syncPrintConfirmation(updated, api, store);
  }
  return (await store.jobs.get(job.id)) ?? updated;
}

export async function syncPrintConfirmation(
  job: PrintManifest,
  api: PrintApi,
  store: PrintStore = printStore,
) {
  const confirmed = await api.confirm(job.id).catch(() => null);
  if (confirmed) await store.jobs.update(job.id, { confirmationSynced: true });
}

export function knownLabelAddress(raw: string): string {
  const url = new URL(raw);
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('invalid label address');
  return raw.trim().replace(/\/+$/, '');
}
