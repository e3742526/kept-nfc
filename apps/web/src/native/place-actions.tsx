import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { ApiError } from '@/api/client';
import { inventoryPaths } from '@/api/inventory/paths';
import type { PlaceView } from '@/api/inventory/types';
import { useErrorText } from '@/components/page';
import { isContentsChoice } from '@/components/places/trash-contents-dialog';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { usePlatform } from './adapters';
import type { Connection } from './bridge';
import { type Destination, DestinationPicker } from './destination';
import type { InventoryCache } from './inventory';
import { isAuthRefusal, isRestoreEpochMismatch } from './outbox';

export function PlaceActions({
  cache,
  connection,
  place,
  mode,
  onClose,
  onChanged,
  onTrashed,
  onAuthError,
}: {
  cache: InventoryCache;
  connection: Connection;
  place: PlaceView;
  mode: 'move' | 'trash';
  onClose: () => void;
  onChanged: () => void;
  onTrashed: () => void;
  onAuthError?: ((reason: 'expired' | 'restored') => void) | undefined;
}) {
  const { t } = useLingui();
  const confirm = useConfirm();
  const errorText = useErrorText();
  const { transport } = usePlatform();
  const [destination, setDestination] = useState<Destination>();
  const [hasContents, setHasContents] = useState(place.counts.places + place.counts.things > 0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const parentId = destination?.id === place.locationId ? null : destination?.id;

  async function submit(choice?: 'move' | 'trash') {
    if (busy) return;
    if (
      mode === 'trash' &&
      !(await confirm({
        title: t`Move to Trash?`,
        body:
          choice === 'trash'
            ? t`Everything inside goes with it, and comes back with it on Restore.`
            : undefined,
        cancelLabel: t`Cancel`,
        confirmLabel: t`Move to Trash`,
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    setMessage('');
    try {
      if (mode === 'move') {
        await transport.request(connection, inventoryPaths.place(place.id), {
          method: 'PATCH',
          ifMatch: place.rowVersion,
          body: { parentId },
        });
        onChanged();
      } else {
        await transport.request(connection, inventoryPaths.placeTrash(place.id), {
          method: 'POST',
          ifMatch: place.rowVersion,
          body: {
            ...(choice ? { contents: choice } : {}),
            ...(choice === 'move' && destination ? { moveTo: { placeId: destination.id } } : {}),
          },
        });
        onTrashed();
      }
    } catch (error) {
      if (isContentsChoice(error)) setHasContents(true);
      else if (isAuthRefusal(error)) onAuthError?.('expired');
      else if (isRestoreEpochMismatch(error)) onAuthError?.('restored');
      else if (error instanceof ApiError && error.status === 412)
        setMessage(
          t`This record changed while you were editing. Close and reopen it to see the latest version.`,
        );
      else setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="kept-card">
      {mode === 'trash' && hasContents && (
        <p>
          <Trans>What happens to what's inside</Trans>
        </p>
      )}
      {(mode === 'move' || hasContents) && (
        <DestinationPicker
          cache={cache}
          connection={connection}
          online
          onlyLocation={place.locationId}
          exclude={place.id}
          forParent={mode === 'move'}
          placesOnly
          disabled={busy}
          value={destination}
          onChange={setDestination}
          onAuthError={onAuthError}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {mode === 'move' ? (
          <Button
            isPending={busy}
            isDisabled={parentId === undefined || parentId === place.parentId}
            onPress={() => void submit()}
          >
            <Trans>Move</Trans>
          </Button>
        ) : hasContents ? (
          <>
            <Button isPending={busy} onPress={() => void submit('move')}>
              <Trans>Move contents</Trans>
            </Button>
            <Button variant="secondary" isDisabled={busy} onPress={() => void submit('trash')}>
              <Trans>Trash them too</Trans>
            </Button>
          </>
        ) : (
          <Button isPending={busy} onPress={() => void submit()}>
            <Trans>Move to Trash</Trans>
          </Button>
        )}
        <Button variant="ghost" isDisabled={busy} onPress={onClose}>
          <Trans>Cancel</Trans>
        </Button>
      </div>
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
