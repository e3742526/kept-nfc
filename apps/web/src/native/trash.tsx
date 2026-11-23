import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronRight, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { Page, TrashItem } from '@/api/inventory/types';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { usePlatform } from './adapters';
import { ScreenHeader } from './back-button';
import type { Connection } from './bridge';
import type { InventoryCache } from './inventory';
import type { Target } from './labels';
import { isAuthRefusal, isRestoreEpochMismatch } from './outbox';

export function Trash({
  connection,
  cache,
  onClose,
  onRestored,
  onAuthError,
}: {
  connection: Connection;
  cache: InventoryCache | undefined;
  onClose: () => void;
  onRestored: (target: Target) => void;
  onAuthError: (reason: 'expired' | 'restored') => void;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const errorText = useErrorText();
  const describe = useRef(errorText);
  describe.current = errorText;
  const [page, setPage] = useState<Page<TrashItem>>();
  const [busy, setBusy] = useState<string>();
  const [status, setStatus] = useState('');
  const [cursor, setCursor] = useState<string>();

  useEffect(() => {
    let current = true;
    void adapters.transport
      .request<Page<TrashItem>>(connection, inventoryPaths.trash + qs({ kind: 'thing', cursor }))
      .then((result) => {
        if (current) {
          setPage(result);
          setStatus('');
        }
      })
      .catch((error: unknown) => {
        if (!current) return;
        if (isAuthRefusal(error)) onAuthError('expired');
        else if (isRestoreEpochMismatch(error)) onAuthError('restored');
        else {
          setPage(undefined);
          setStatus(describe.current(error));
        }
      });
    return () => {
      current = false;
    };
  }, [adapters, connection, cursor, onAuthError]);

  async function restore(item: TrashItem) {
    setBusy(item.id);
    setStatus('');
    try {
      await adapters.transport.request(connection, inventoryPaths.thingRestore(item.id), {
        method: 'POST',
        body: {},
      });
      onRestored({ kind: 'thing', id: item.id, locationId: item.locationId });
    } catch (error) {
      if (isAuthRefusal(error)) onAuthError('expired');
      else if (isRestoreEpochMismatch(error)) onAuthError('restored');
      else setStatus(errorText(error));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="grid gap-4">
      <ScreenHeader
        title={<Trans>Trash</Trans>}
        onBack={onClose}
        icon={<Trash2 size={18} aria-hidden />}
      />
      {page?.items.length ? (
        <ul className="grid gap-2">
          {page.items.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-3"
            >
              <div className="grid min-w-0 gap-0.5">
                <bdi className="break-words font-semibold">{item.name ?? t`Untitled`}</bdi>
                <time className="text-small text-ink-2" dateTime={item.deletedAt}>
                  {new Date(item.deletedAt).toLocaleString()}
                </time>
              </div>
              {cache?.locations.some(
                (location) => location.id === item.locationId && location.role !== 'viewer',
              ) && (
                <Button
                  variant="secondary"
                  size="small"
                  isPending={busy === item.id}
                  isDisabled={!!busy}
                  onPress={() => void restore(item)}
                >
                  <RotateCcw size={15} aria-hidden />
                  <Trans>Restore</Trans>
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        page && (
          <p className="text-ink-2">
            <Trans>Trash is empty.</Trans>
          </p>
        )
      )}
      {page?.next_cursor && (
        <Button variant="secondary" onPress={() => setCursor(page.next_cursor ?? undefined)}>
          <Trans>Next page</Trans>
          <ChevronRight size={16} className="rtl:rotate-180" aria-hidden />
        </Button>
      )}
      {cursor && (
        <Button variant="ghost" onPress={() => setCursor(undefined)}>
          <Trans>First page</Trans>
        </Button>
      )}
      {status && <p role="alert">{status}</p>}
    </section>
  );
}
