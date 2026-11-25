import { Trans, useLingui } from '@lingui/react/macro';
import { Archive, Check, Image, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { AttachmentView, Page } from '@/api/inventory/types';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { usePlatform } from './adapters';
import { ScreenHeader } from './back-button';
import type { Connection } from './bridge';
import { previewUrl } from './inventory';
import type { Target } from './labels';
import { isAuthRefusal, isRestoreEpochMismatch } from './outbox';

type View = 'current' | 'archived';

/**
 * A box's photo library: the current photos and the archive. Archiving sets a photo aside (it is
 * no longer the cover and drops out of photo search) and can be undone; deleting is permanent.
 */
export function BoxPhotos({
  connection,
  target,
  name,
  online,
  canEdit,
  onBack,
  onAdd,
  onChanged,
  onAuthError,
}: {
  connection: Connection;
  target: Target;
  name: string;
  online: boolean;
  canEdit: boolean;
  onBack: () => void;
  onAdd: () => void;
  onChanged: () => void;
  onAuthError: (reason: 'expired' | 'restored') => void;
}) {
  const { t } = useLingui();
  const { transport } = usePlatform();
  const errorText = useErrorText();
  const confirm = useConfirm();
  const [view, setView] = useState<View>('current');
  const [current, setCurrent] = useState<AttachmentView[]>();
  const [archived, setArchived] = useState<AttachmentView[]>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const latest = useRef({ errorText, onAuthError });
  latest.current = { errorText, onAuthError };

  const path = target.kind === 'thing' ? inventoryPaths.thingAttachments(target.id) : '';

  const fail = useCallback((error: unknown) => {
    if (isAuthRefusal(error)) latest.current.onAuthError('expired');
    else if (isRestoreEpochMismatch(error)) latest.current.onAuthError('restored');
    else setStatus(latest.current.errorText(error));
  }, []);

  const load = useCallback(async () => {
    if (!online || !path) return;
    try {
      const [now, before] = await Promise.all([
        transport.request<Page<AttachmentView>>(
          connection,
          path + qs({ role: 'photo', limit: 100 }),
        ),
        transport.request<Page<AttachmentView>>(
          connection,
          path + qs({ role: 'photo', archived: 'only', limit: 100 }),
        ),
      ]);
      setCurrent(now.items);
      setArchived(before.items);
    } catch (error) {
      fail(error);
    }
  }, [connection, fail, online, path, transport]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = (view === 'current' ? current : archived) ?? [];
  const chosen = shown.filter((photo) => selected.has(photo.id));

  function switchView(next: View) {
    setView(next);
    setSelected(new Set());
  }

  function toggle(id: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setStatus('');
    try {
      await work();
      setSelected(new Set());
      await load();
      onChanged();
    } catch (error) {
      fail(error);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const setArchivedState = (value: boolean) =>
    run(async () => {
      for (const photo of chosen) {
        await transport.request(connection, inventoryPaths.attachment(photo.id), {
          method: 'PATCH',
          ifMatch: photo.rowVersion,
          body: { archived: value },
        });
      }
    });

  async function remove() {
    const count = chosen.length;
    const ok = await confirm({
      title:
        count === 1 ? t`Delete this photo permanently?` : t`Delete ${count} photos permanently?`,
      body: t`This cannot be undone. Archive them instead to keep them.`,
      confirmLabel: t`Delete`,
      cancelLabel: t`Cancel`,
      destructive: true,
    });
    if (!ok) return;
    await run(async () => {
      for (const photo of chosen) {
        await transport.request(connection, inventoryPaths.attachment(photo.id), {
          method: 'DELETE',
        });
      }
    });
  }

  return (
    <section className="grid gap-3">
      <ScreenHeader
        title={<Trans>Photos</Trans>}
        onBack={onBack}
        icon={<Image size={18} aria-hidden />}
        trailing={
          canEdit && online ? (
            <Button variant="ghost" size="small" onPress={onAdd}>
              <Plus size={16} aria-hidden />
              <Trans>Add photos</Trans>
            </Button>
          ) : undefined
        }
      />
      <p className="text-small text-ink-2">
        <bdi>{name}</bdi>
      </p>
      <div className="kept-chips">
        <Button
          variant="secondary"
          size="small"
          className="kept-chip"
          aria-pressed={view === 'current'}
          onPress={() => switchView('current')}
        >
          {t`Current (${current?.length ?? 0})`}
        </Button>
        <Button
          variant="secondary"
          size="small"
          className="kept-chip"
          aria-pressed={view === 'archived'}
          onPress={() => switchView('archived')}
        >
          {t`Archived (${archived?.length ?? 0})`}
        </Button>
      </div>
      {!online && (
        <p className="text-ink-2" role="status">
          <Trans>Connect to SheepKeep to manage photos.</Trans>
        </p>
      )}
      {status && <p role="alert">{status}</p>}
      {online && current && shown.length === 0 && (
        <p className="text-ink-2">
          {view === 'current' ? <Trans>No photos yet.</Trans> : <Trans>Nothing archived.</Trans>}
        </p>
      )}
      <ul className="kept-photo-grid">
        {shown.map((photo, index) => {
          const src = previewUrl(photo.file?.thumbUrl, connection.origin);
          const isSelected = selected.has(photo.id);
          const label = photo.name ?? t`Photo ${index + 1}`;
          return (
            <li key={photo.id}>
              <Button
                variant="secondary"
                className="kept-photo"
                aria-pressed={isSelected}
                aria-label={label}
                isDisabled={!canEdit || busy}
                onPress={() => toggle(photo.id)}
              >
                {src ? (
                  <img alt="" src={src} loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                  <Image size={28} aria-hidden />
                )}
                {isSelected && (
                  <span className="kept-photo-check" aria-hidden>
                    <Check size={14} />
                  </span>
                )}
              </Button>
              {photo.createdAt && (
                <time dateTime={photo.createdAt} className="kept-photo-date">
                  {new Date(photo.createdAt).toLocaleDateString()}
                </time>
              )}
            </li>
          );
        })}
      </ul>
      {canEdit && chosen.length > 0 && (
        <div className="kept-photo-actions" role="toolbar" aria-label={t`Selected photos`}>
          {view === 'current' ? (
            <Button
              variant="secondary"
              isPending={busy}
              onPress={() => void setArchivedState(true)}
            >
              <Archive size={16} aria-hidden />
              <Trans>Archive</Trans>
            </Button>
          ) : (
            <Button
              variant="secondary"
              isPending={busy}
              onPress={() => void setArchivedState(false)}
            >
              <RotateCcw size={16} aria-hidden />
              <Trans>Restore</Trans>
            </Button>
          )}
          <Button variant="secondary" isDisabled={busy} onPress={() => void remove()}>
            <Trash2 size={16} aria-hidden />
            <Trans>Delete</Trans>
          </Button>
        </div>
      )}
    </section>
  );
}
