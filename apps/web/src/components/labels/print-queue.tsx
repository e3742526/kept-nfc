import { hasQr, LABEL_STOCKS } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useCallback, useEffect, useState } from 'react';
import { capturePaths } from '@/api/capture/paths';
import { api } from '@/api/client';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Select, SelectItem } from '@/components/ui/select';
import { sep } from '@/lib/format';
import { useStockText } from './stock-picker';

export type QueueTarget = { locationId: string; kind: 'thing' | 'place'; recordId: string };
type Row = QueueTarget & { batchId: string | null; name: string | null; available: boolean };
type Result = { items: Row[]; batchId?: string };
type Action =
  | (QueueTarget & { action: 'add' | 'remove' })
  | (Omit<QueueTarget, 'recordId'> & { action: 'prepare'; stock: string });
export type PrintQueueRequest = (action?: Action) => Promise<Result>;
export const webPrintQueue: PrintQueueRequest = (action) =>
  action ? api.post(capturePaths.labelQueue, action) : api.get(capturePaths.labelQueue);

export function QueueLabelButton({
  target,
  request = webPrintQueue,
}: {
  target: QueueTarget;
  request?: PrintQueueRequest;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  return (
    <div>
      <Button
        variant="secondary"
        isPending={busy}
        onPress={async () => {
          setBusy(true);
          setNotice('');
          try {
            await request({ action: 'add', ...target });
            setNotice(t`Added to print queue.`);
            window.dispatchEvent(new Event('kept-print-queue'));
          } catch (error) {
            setNotice(errorText(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Trans>Queue label</Trans>
      </Button>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}

export function PrintQueue({
  request = webPrintQueue,
  openBatch,
  confirmPrinted,
  locationName,
  heading: Heading = 'h2',
}: {
  request?: PrintQueueRequest;
  openBatch: (id: string) => void | Promise<void>;
  confirmPrinted?: (id: string) => Promise<unknown>;
  locationName: (id: string) => string | undefined;
  heading?: 'h2' | 'h3';
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const [items, setItems] = useState<Row[]>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const [stock, setStock] = useState('letter_writable_12');
  const stockText = useStockText();
  const stocks = LABEL_STOCKS.filter((entry) =>
    confirmPrinted ? entry.key.startsWith('letter_writable_') : hasQr(entry),
  ).map((entry) => ({ id: entry.key, label: stockText(entry).title }));
  const reload = useCallback(async () => {
    try {
      setItems((await request()).items);
      setFailure(undefined);
    } catch (error) {
      setFailure(error);
    }
  }, [request]);
  useEffect(() => {
    void reload();
    const refresh = () => void reload();
    window.addEventListener('focus', refresh);
    window.addEventListener('kept-print-queue', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('kept-print-queue', refresh);
    };
  }, [reload]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setFailure(undefined);
    try {
      await work();
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  const groups = new Map<string, Row[]>();
  for (const row of items ?? []) {
    const key = `${row.locationId}:${row.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return (
    <section className="grid gap-3 kept-card">
      <div className="flex flex-wrap items-center gap-2">
        <Heading className="text-title">
          <Trans>Print queue</Trans>
        </Heading>
        <Button variant="ghost" size="small" isDisabled={busy} onPress={() => void reload()}>
          <Trans>Refresh</Trans>
        </Button>
      </div>
      {items?.length === 0 && (
        <p>
          <Trans>Your print queue is empty.</Trans>
        </p>
      )}
      {Boolean(items?.length) && (
        <Select
          label={t`Label stock`}
          items={stocks}
          selectedKey={stock}
          onSelectionChange={(value) => {
            if (value) setStock(String(value));
          }}
        >
          {({ id, label }) => <SelectItem id={id}>{label}</SelectItem>}
        </Select>
      )}
      {[...groups.entries()].map(([key, rows]) => {
        const first = rows[0];
        if (!first) return null;
        const { kind, locationId } = first;
        const batchId = rows.find((row) => row.batchId)?.batchId;
        return (
          <div key={key} className="grid gap-2 rounded-lg border border-line p-3">
            <p className="font-semibold">
              {locationName(locationId) ?? t`Inventory location`}
              {sep()}
              {kind === 'thing' ? t`Items` : t`Places`}
            </p>
            <ul className="grid gap-1">
              {rows.map(({ recordId, name, available }) => (
                <li className="flex flex-wrap items-center gap-2" key={recordId}>
                  <bdi>{available ? name || t`Unnamed item` : t`Record unavailable`}</bdi>
                  <Button
                    size="small"
                    variant="ghost"
                    isDisabled={busy}
                    onPress={() =>
                      void run(async () => {
                        setItems(
                          (await request({ action: 'remove', locationId, kind, recordId })).items,
                        );
                      })
                    }
                  >
                    <Trans>Remove</Trans>
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button
                isPending={busy}
                isDisabled={!batchId && !rows.some((row) => row.available)}
                onPress={() =>
                  void run(async () => {
                    if (batchId) return openBatch(batchId);
                    const result = await request({ action: 'prepare', locationId, kind, stock });
                    setItems(result.items);
                    if (result.batchId) await openBatch(result.batchId);
                  })
                }
              >
                {batchId ? <Trans>Open print batch</Trans> : <Trans>Prepare labels</Trans>}
              </Button>
              {batchId && confirmPrinted && (
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() =>
                    void run(async () => {
                      await confirmPrinted(batchId);
                      await reload();
                    })
                  }
                >
                  <Trans>Yes, printed OK</Trans>
                </Button>
              )}
            </div>
          </div>
        );
      })}
      {failure !== undefined && <p role="status">{errorText(failure)}</p>}
    </section>
  );
}
