import { labelStock, newId, usesThermalLabelEditor } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronRight, Printer, Tags } from 'lucide-react';
import { useEffect, useState } from 'react';
import { capturePaths } from '@/api/capture/paths';
import type { CreateLabelBatchBody, CreateLabelBatchResult, LabelBatch } from '@/api/capture/types';
import { qs } from '@/api/inventory/paths';
import type { Page } from '@/api/inventory/types';
import { PrintQueue } from '@/components/labels/print-queue';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Select, SelectItem } from '@/components/ui/select';
import { sep } from '@/lib/format';
import { usePlatform } from './adapters';
import { ScreenHeader } from './back-button';
import type { Connection } from './bridge';
import { LocationPicker, writableLocations } from './destination';
import type { InventoryCache } from './inventory';
import { approvedLabel, labelBase, labelOrigins, labelUrl, loadLabelAddress } from './labels';
import { isAuthRefusal, isRestoreEpochMismatch } from './outbox';
import { useNativePrintQueue } from './print-queue';
import { NativeThermalPrint } from './thermal-print';

const counts = [8, 12, 24];

export function LabelSheets({
  connection,
  cache,
  onClose,
  onAuthError,
}: {
  connection: Connection;
  cache: InventoryCache;
  onClose: () => void;
  onAuthError: (reason: 'expired' | 'restored') => void;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const queue = useNativePrintQueue(connection);
  const errorText = useErrorText();
  const [location, setLocation] = useState(writableLocations(cache)[0]?.id ?? null);
  const [count, setCount] = useState(12);
  const [id, setId] = useState(newId);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [batches, setBatches] = useState<LabelBatch[]>([]);
  const [thermal, setThermal] = useState(false);
  const [reprint, setReprint] = useState<LabelBatch>();

  useEffect(() => {
    let current = true;
    setBatches([]);
    if (location)
      void adapters.transport
        .request<Page<LabelBatch>>(
          connection,
          capturePaths.labelBatches + qs({ locationId: location }),
        )
        .then((page) => {
          if (current)
            setBatches(
              page.items.filter(
                (batch) =>
                  batch.stock.startsWith('letter_writable_') ||
                  usesThermalLabelEditor(batch.stock, Boolean(batch.thermal)),
              ),
            );
        })
        .catch((error: unknown) => {
          if (!current) return;
          if (isAuthRefusal(error)) onAuthError('expired');
          else if (isRestoreEpochMismatch(error)) onAuthError('restored');
        });
    return () => {
      current = false;
    };
  }, [adapters, connection, location, onAuthError]);

  async function share(batch?: LabelBatch) {
    if (!location || !adapters.media.shareLabelSheet) return;
    setBusy(true);
    setStatus('');
    try {
      let sheet = batch;
      if (!sheet) {
        const body: CreateLabelBatchBody = {
          id,
          locationId: location,
          kind: 'blank',
          stock: `letter_writable_${count}`,
          blankCount: count,
        };
        const response = await adapters.transport.request<CreateLabelBatchResult>(
          connection,
          capturePaths.labelBatches,
          {
            method: 'POST',
            body,
            idempotencyKey: id,
          },
        );
        sheet = response.batch;
        setBatches((previous) => [
          response.batch,
          ...previous.filter((entry) => entry.id !== response.batch.id),
        ]);
        setId(newId());
      } else {
        sheet = await adapters.transport.request<LabelBatch>(
          connection,
          capturePaths.labelBatch(sheet.id),
        );
      }
      const stock = labelStock(sheet.stock);
      // The server's link: its label address, and a numbered label's alias.
      await loadLabelAddress(connection, adapters);
      const origins = labelOrigins(connection);
      const labels = sheet.labels.map((label) => {
        const url = label.url || labelUrl(labelBase(connection), label.alias ?? label.code);
        if (approvedLabel(url, origins).status !== 'approved') throw new Error('Invalid label');
        return { url, ...(label.name ? { name: label.name } : {}) };
      });
      await adapters.media.shareLabelSheet(connection, {
        columns: stock.cols,
        rows: stock.rows,
        labels,
      });
    } catch (error) {
      if (isAuthRefusal(error)) onAuthError('expired');
      else if (isRestoreEpochMismatch(error)) onAuthError('restored');
      else setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-4">
      <ScreenHeader
        title={<Trans>Print label sheets</Trans>}
        onBack={onClose}
        icon={<Tags size={18} aria-hidden />}
      />
      <PrintQueue
        heading="h3"
        request={queue}
        locationName={(id) => cache.locations.find((entry) => entry.id === id)?.name}
        openBatch={async (id) => {
          const batch = await adapters.transport.request<LabelBatch>(
            connection,
            capturePaths.labelBatch(id),
          );
          if (usesThermalLabelEditor(batch.stock, Boolean(batch.thermal))) {
            setLocation(batch.locationId);
            setReprint(batch);
            setThermal(true);
          } else await share(batch);
        }}
        confirmPrinted={(id) =>
          adapters.transport.request(connection, capturePaths.labelBatchPrinted(id), {
            method: 'POST',
          })
        }
      />
      <div className="kept-card">
        <LocationPicker
          cache={cache}
          value={location}
          onChange={(value) => {
            setReprint(undefined);
            setLocation(value);
            setId(newId());
          }}
          disabled={busy}
        />
        <Button
          variant="secondary"
          onPress={() => {
            setThermal((value) => !value);
            setReprint(undefined);
          }}
        >
          {thermal ? <Trans>Office sheets and other stock</Trans> : <Trans>Thermal printing</Trans>}
        </Button>
        {thermal ? (
          location && (
            <NativeThermalPrint
              key={reprint?.id ?? location}
              connection={connection}
              locationId={location}
              batch={reprint}
              canManageLabels
            />
          )
        ) : (
          <>
            <Select
              label={t`Labels per US Letter sheet`}
              items={counts.map((value) => ({ id: value }))}
              selectedKey={count}
              onSelectionChange={(key) => {
                if (key != null) setCount(Number(key));
                setId(newId());
              }}
              isDisabled={busy}
            >
              {(option) => <SelectItem id={option.id}>{String(option.id)}</SelectItem>}
            </Select>
            <Button
              isDisabled={!location || !adapters.media.shareLabelSheet}
              isPending={busy}
              onPress={() => void share()}
            >
              <Printer size={18} aria-hidden />
              <Trans>Create blank labels</Trans>
            </Button>
          </>
        )}
      </div>
      {batches.length > 0 && (
        <ul className="grid gap-2">
          {batches
            .filter(
              (batch) => usesThermalLabelEditor(batch.stock, Boolean(batch.thermal)) === thermal,
            )
            .map((batch) => (
              <li key={batch.id}>
                <Button
                  variant="secondary"
                  className="kept-phone-row"
                  isDisabled={busy}
                  onPress={() => (thermal ? setReprint(batch) : void share(batch))}
                >
                  <span className="kept-row-lead" aria-hidden>
                    <Printer size={18} />
                  </span>
                  <span className="kept-row-body">
                    <span className="font-semibold">
                      <Trans>Reprint label sheet</Trans>
                    </span>
                    <span className="text-small font-normal text-ink-2">
                      <time dateTime={batch.createdAt}>
                        {new Date(batch.createdAt).toLocaleString()}
                      </time>
                      {batch.labels[0]?.code && (
                        <>
                          {sep()}
                          <bdi className="ltr">{batch.labels[0].code}</bdi>
                        </>
                      )}
                    </span>
                  </span>
                  <ChevronRight size={18} className="kept-row-chevron rtl:rotate-180" aria-hidden />
                </Button>
              </li>
            ))}
        </ul>
      )}
      {status && <p role="alert">{status}</p>}
    </section>
  );
}
