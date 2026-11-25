import { newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { useState } from 'react';
import { capturePaths } from '@/api/capture/paths';
import type { ClaimBody, ClaimResult, LabelClaimedDetails } from '@/api/capture/types';
import { ApiError } from '@/api/client';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';

import { TextField } from '@/components/ui/text-field';
import { usePlatform } from './adapters';
import type { Connection } from './bridge';
import { type Destination, DestinationPicker } from './destination';
import type { InventoryCache } from './inventory';
import type { Target } from './labels';
import { isAuthRefusal, isRestoreEpochMismatch } from './outbox';
import { rememberDestination } from './recent-destinations';

export function ClaimBinLabel({
  connection,
  cache,
  locationId,
  code,
  onOpen,
  onAuthError,
}: {
  connection: Connection;
  cache: InventoryCache;
  locationId: string;
  code: string;
  onOpen: (target: Target) => void;
  onAuthError?: (reason: 'expired' | 'restored') => void;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const errorText = useErrorText();
  const [existing, setExisting] = useState(false);
  const [destination, setDestination] = useState<Destination>();
  const [name, setName] = useState('');
  const [id, setId] = useState(newId);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [claimed, setClaimed] = useState<LabelClaimedDetails['claimedFor']>();

  async function submit() {
    if (busy) return;
    let body: ClaimBody;
    if (!destination) return;
    if (existing) body = { thingId: destination.id };
    else
      body = {
        newContainer: {
          id,
          name: name.trim() || t`Box`,
          ...(destination.kind === 'box'
            ? { containerId: destination.id }
            : { placeId: destination.id }),
        },
      };
    setBusy(true);
    setStatus('');
    try {
      const result = await adapters.transport.request<ClaimResult>(
        connection,
        capturePaths.codeClaim(code),
        {
          method: 'POST',
          body,
          idempotencyKey: id,
        },
      );
      void rememberDestination(connection, adapters, destination.id);
      onOpen({ ...result.target, locationId });
    } catch (error) {
      if (isAuthRefusal(error)) onAuthError?.('expired');
      else if (isRestoreEpochMismatch(error)) onAuthError?.('restored');
      else {
        setStatus(errorText(error));
        if (
          error instanceof ApiError &&
          (error.code === 'label_claimed' || error.serverCode === 'label_claimed')
        ) {
          setClaimed(error.details.claimedFor as LabelClaimedDetails['claimedFor'] | undefined);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-3 rounded-lg border border-line p-3">
      <h3 className="font-semibold">
        <Trans>Assign label</Trans> <bdi>{code}</bdi>
      </h3>
      {claimed ? (
        <Button variant="secondary" onPress={() => onOpen({ ...claimed, locationId })}>
          <Trans>Open</Trans> <bdi>{claimed.name}</bdi>
        </Button>
      ) : (
        <>
          <Button
            variant="secondary"
            isDisabled={busy}
            onPress={() => {
              setExisting(!existing);
              setDestination(undefined);
              setId(newId());
            }}
          >
            {existing ? <Trans>Create box</Trans> : <Trans>Choose existing box</Trans>}
          </Button>
          {!existing && (
            <TextField
              label={t`Box name (optional)`}
              value={name}
              isDisabled={busy}
              inputProps={{ maxLength: 200 }}
              onChange={(value) => {
                setName(value);
                setId(newId());
              }}
            />
          )}
          <DestinationPicker
            key={String(existing)}
            cache={cache}
            connection={connection}
            online={true}
            value={destination}
            boxesOnly={existing}
            onlyLocation={locationId}
            disabled={busy}
            onAuthError={onAuthError}
            onChange={(value) => {
              setDestination(value);
              setId(newId());
            }}
          />
          <Button isPending={busy} isDisabled={!destination} onPress={() => void submit()}>
            <Trans>Assign label</Trans>
          </Button>
        </>
      )}
      {status && <p role="alert">{status}</p>}
    </section>
  );
}
