import { Trans, useLingui } from '@lingui/react/macro';
import { MapPin, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { paths } from '@/api/paths';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter, Modal } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { TextField } from '@/components/ui/text-field';
import { isolate } from '@/lib/bidi';
import { usePlatform } from './adapters';
import { ScreenHeader } from './back-button';
import type { Connection } from './bridge';
import type { InventoryCache } from './inventory';
import { isAuthRefusal, isRestoreEpochMismatch } from './outbox';

export function LocationSettings({
  cache,
  connection,
  online,
  syncing,
  onBack,
  onVisibilityChanged,
  onDeleted,
  onAuthError,
}: {
  cache: InventoryCache;
  connection: Connection;
  online: boolean;
  syncing: boolean;
  onBack: () => void;
  onVisibilityChanged: (hide: boolean) => Promise<void>;
  onDeleted: (id: string) => Promise<void>;
  onAuthError: (reason: 'expired' | 'restored') => void;
}) {
  const { t } = useLingui();
  const { transport } = usePlatform();
  const errorText = useErrorText();
  const [deleting, setDeleting] = useState<InventoryCache['locations'][number]>();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const name = deleting?.name ?? '';
  const matches = typed.trim() === name.trim();
  const ownPersonal = cache.locations.find(({ id }) => id === cache.personal?.id);
  const personal = ownPersonal?.name ?? '';
  const hidePersonal = cache.personal?.hide === true;
  const hasAnother = cache.locations.some(({ id }) => id !== ownPersonal?.id);
  const disabled = !online || syncing || busy;

  async function run(work: () => Promise<void>) {
    if (disabled) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await work();
    } catch (failure) {
      if (isAuthRefusal(failure)) onAuthError('expired');
      else if (isRestoreEpochMismatch(failure)) onAuthError('restored');
      else setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  function changeVisibility(hide: boolean) {
    return run(async () => {
      await transport.request(connection, paths.me, {
        method: 'PATCH',
        body: { hidePersonal: hide },
      });
      await onVisibilityChanged(hide);
    });
  }

  function deleteLocation() {
    if (!deleting || !matches) return;
    return run(async () => {
      await transport.request(connection, paths.location(deleting.id), { method: 'DELETE' });
      setDeleting(undefined);
      setStatus(t`Deleted ${isolate(name)}. It can be restored for 30 days.`);
      await onDeleted(deleting.id);
    });
  }

  function closeDialog() {
    if (busy) return;
    setDeleting(undefined);
    setError('');
  }

  return (
    <section className="grid gap-4">
      <ScreenHeader
        title={<Trans>Locations</Trans>}
        onBack={onBack}
        icon={<MapPin size={18} aria-hidden />}
      />
      {ownPersonal && (
        <section className="kept-card">
          <Switch
            isSelected={hidePersonal}
            isDisabled={disabled || (!hidePersonal && !hasAnother)}
            onChange={(hide) => void changeVisibility(hide)}
          >
            <span>
              <Trans>
                Hide <bdi>{personal}</bdi>
              </Trans>
            </span>
          </Switch>
          <p className="text-small text-ink-2">
            {hasAnother ? (
              <Trans>
                It leaves the menu, Home, lists and search, for you only. Nothing in it changes, a
                link to it still opens it, and its reminders still reach you. Show it again here any
                time.
              </Trans>
            ) : hidePersonal ? (
              <Trans>
                <bdi>{personal}</bdi> is showing because it's your only location. It hides again
                when you have another.
              </Trans>
            ) : (
              <Trans>
                <bdi>{personal}</bdi> is your only location, so it stays. Add or join another first.
              </Trans>
            )}
          </p>
        </section>
      )}
      <ul className="grid gap-2">
        {cache.locations
          .filter(({ id }) => id !== ownPersonal?.id)
          .map((location) => {
            const name = location.name;
            return (
              <li
                key={location.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface p-3"
              >
                <bdi className="break-words font-semibold">{name}</bdi>
                {location.role === 'owner' && location.kind && location.kind !== 'personal' && (
                  <Button
                    variant="secondary"
                    className="text-danger"
                    isDisabled={disabled}
                    onPress={() => {
                      setTyped('');
                      setError('');
                      setDeleting(location);
                    }}
                  >
                    <Trash2 size={16} aria-hidden />
                    <span>
                      <Trans>
                        Delete <bdi>{name}</bdi>…
                      </Trans>
                    </span>
                  </Button>
                )}
              </li>
            );
          })}
      </ul>
      {status && <p role="status">{status}</p>}
      {error && !deleting && <p role="alert">{error}</p>}
      {deleting && (
        <Modal isOpen onOpenChange={(open) => !open && closeDialog()}>
          <Dialog
            title={
              <Trans>
                Delete <bdi>{name}</bdi>?
              </Trans>
            }
            showClose={false}
          >
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void deleteLocation();
              }}
            >
              <p className="text-small text-ink-2">
                <Trans>
                  Deleting <bdi>{name}</bdi> removes it for everyone in it. It stays restorable for
                  30 days.
                </Trans>
              </p>
              <TextField
                label={t`Type ${name} to confirm`}
                value={typed}
                onChange={setTyped}
                autoComplete="off"
                isReadOnly={busy}
                isInvalid={typed.trim() !== '' && !matches}
                errorMessage={t`That isn't the location's name.`}
              />
              {error && <p role="alert">{error}</p>}
              <DialogFooter>
                <Button variant="secondary" isDisabled={busy} onPress={closeDialog} autoFocus>
                  <Trans>Cancel</Trans>
                </Button>
                <Button
                  type="submit"
                  variant="danger"
                  isDisabled={!matches || disabled}
                  isPending={busy}
                >
                  <span>
                    <Trans>
                      Delete <bdi>{name}</bdi>
                    </Trans>
                  </span>
                </Button>
              </DialogFooter>
            </form>
          </Dialog>
        </Modal>
      )}
    </section>
  );
}
