import { DevicePhotoProposals } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useMemo } from 'react';
import { capturePaths } from '@/api/capture/paths';
import type { LabelBatch, LabelCellContent } from '@/api/capture/types';
import type { PrintApi } from '@/components/labels/thermal/api';
import type { NativeThermalOutput } from '@/components/labels/thermal/output';
import { type ThermalSource, ThermalStudio } from '@/components/labels/thermal/studio';
import { suggestWorkshopIcon } from '@/components/labels/thermal/workshop-icons';
import { usePlatform } from './adapters';
import type { Connection } from './bridge';

export function NativeThermalPrint({
  connection,
  locationId,
  batch,
  thingId,
  placeId,
  onSaved,
  cachedLabel,
}: {
  connection: Connection;
  locationId: string;
  batch?: LabelBatch | undefined;
  thingId?: string | undefined;
  placeId?: string | undefined;
  onSaved?: (batch: LabelBatch) => void;
  cachedLabel?: LabelCellContent | undefined;
}) {
  const { t } = useLingui();
  const { transport, media, captureAI, niimbot } = usePlatform();
  const bluetooth = useMemo(() => niimbot?.(connection), [connection, niimbot]);
  const sourceLocationId = batch?.locationId ?? locationId;
  const batchKind = batch?.kind;
  const api = useMemo<PrintApi>(
    () => ({
      address: async () =>
        (await transport.request<{ url: string }>(connection, capturePaths.labelAddress)).url,
      preview: (body) =>
        transport.request(connection, capturePaths.labelBatches, {
          method: 'POST',
          body: { ...body, dryRun: true },
        }),
      create: (body) =>
        transport.request(connection, capturePaths.labelBatches, {
          method: 'POST',
          body,
          ...(body.id ? { idempotencyKey: body.id } : {}),
        }),
      replace: (body) =>
        transport.request(connection, capturePaths.labelReplace, { method: 'POST', body }),
      registerTag: (body) =>
        transport.request(connection, capturePaths.labelTags, { method: 'POST', body }),
      confirm: (id) =>
        transport.request(connection, capturePaths.labelBatchPrinted(id), { method: 'POST' }),
    }),
    [connection, transport],
  );
  const source = useMemo<ThermalSource>(
    () =>
      batchKind
        ? { kind: batchKind, locationId: sourceLocationId }
        : thingId
          ? { kind: 'things', thingIds: [thingId], locationId: sourceLocationId }
          : placeId
            ? { kind: 'places', placeIds: [placeId], locationId: sourceLocationId }
            : { kind: 'blank', locationId: sourceLocationId },
    [thingId, placeId, sourceLocationId, batchKind],
  );
  const send = media.thermalPdf;
  const output: NativeThermalOutput | undefined = send
    ? (pdf, share) => send(connection, pdf, share, t`SheepKeep labels`)
    : undefined;
  const propose = captureAI?.serverProposals;

  return (
    <ThermalStudio
      key={JSON.stringify([connection.id, source, batch?.id])}
      owner={connection.id}
      source={source}
      api={api}
      nativeOutput={output}
      bluetooth={bluetooth}
      cachedLabel={cachedLabel}
      batch={batch}
      suggestIcon={
        propose &&
        (async (photo) => {
          const { items } = DevicePhotoProposals.parse(
            await propose(connection, sourceLocationId, photo),
          );
          return items
            .map((item) => suggestWorkshopIcon('', item.categories?.join(' ') ?? '', item.name))
            .find((icon) => icon !== 'MSC');
        })
      }
      {...(onSaved ? { onSaved } : {})}
    />
  );
}
