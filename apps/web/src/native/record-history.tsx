import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronUp, History, Image, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { AttachmentView, HistoryEvent, Page } from '@/api/inventory/types';
import { useSummary } from '@/components/history/labels';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { isolate } from '@/lib/bidi';
import { sep } from '@/lib/format';
import { usePlatform } from './adapters';
import type { Connection } from './bridge';
import type { InventoryCache } from './inventory';
import type { Target } from './labels';
import { isAuthRefusal, isRestoreEpochMismatch } from './outbox';

export function RecordHistory({
  connection,
  cache,
  target,
  container,
  canEdit,
  attachments,
  onOpenPhoto,
  onOpen,
  onChanged,
  onAuthError,
}: {
  connection: Connection;
  cache: InventoryCache | undefined;
  target: Target;
  container: boolean;
  canEdit: boolean;
  attachments: AttachmentView[];
  onOpenPhoto: (attachment: AttachmentView) => void;
  onOpen: (target: Target) => void;
  onChanged: () => void;
  onAuthError?: (reason: 'expired' | 'restored') => void;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const errorText = useErrorText();
  const formatSummary = useSummary();
  const [page, setPage] = useState<Page<HistoryEvent>>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  async function load(cursor?: string) {
    setBusy(true);
    setStatus('');
    try {
      const path =
        target.kind === 'thing'
          ? inventoryPaths.thingHistory(target.id) +
            qs({ kind: 'changes', contents: container ? 1 : undefined, cursor })
          : inventoryPaths.placeHistory(target.id) + qs({ cursor });
      const result = await adapters.transport.request<Page<HistoryEvent>>(connection, path);
      setPage((previous) => ({
        ...result,
        items: [...(cursor ? (previous?.items ?? []) : []), ...result.items],
      }));
    } catch (error) {
      if (isAuthRefusal(error)) onAuthError?.('expired');
      else if (isRestoreEpochMismatch(error)) onAuthError?.('restored');
      else {
        setPage(undefined);
        setStatus(errorText(error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function undo(id: string) {
    setBusy(true);
    setStatus('');
    try {
      await adapters.transport.request(connection, inventoryPaths.undo(id), {
        method: 'POST',
        body: {},
      });
      onChanged();
    } catch (error) {
      if (isAuthRefusal(error)) onAuthError?.('expired');
      else if (isRestoreEpochMismatch(error)) onAuthError?.('restored');
      else setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  function summary(event: HistoryEvent) {
    if (
      event.summaryKey === 'attachment.create.photo' ||
      event.summaryKey === 'thing.capture.attach'
    )
      return t`Photo added. No inventory or location changes recorded.`;
    const name = isolate(event.summaryParams.name ?? t`Item`);
    if (event.summaryKey === 'thing.restore' || event.action === 'thing.restore')
      return t`Record for ${name} restored`;
    if (event.action === 'thing.trash') return t`Record for ${name} moved to Trash`;
    if (event.action === 'thing.update') {
      const tags = event.diff?.tag_ids;
      if (tags && 'before' in tags) {
        const before = Array.isArray(tags.before) ? tags.before : [];
        const after = Array.isArray(tags.after) ? tags.after : [];
        const words = (source: unknown[], other: unknown[]) =>
          source
            .filter((id) => !other.includes(id))
            .flatMap((id) => {
              const tag = cache?.tags?.find((candidate) => candidate.id === id);
              return tag ? [isolate(tag.name)] : [];
            })
            .join(', ');
        const added = words(after, before);
        const removed = words(before, after);
        return (
          [added && t`Assigned category ${added}`, removed && t`Removed category ${removed}`]
            .filter(Boolean)
            .join(sep()) || t`Updated categories for ${name}`
        );
      }
      if (Object.keys(event.diff ?? {}).some((key) => key.startsWith('custom.')))
        return t`Updated custom fields for ${name}`;
    }
    if (
      event.summaryKey === 'thing.move.removed' ||
      event.summaryKey === 'thing.move.corrected' ||
      event.summaryKey === 'box.check.unchanged' ||
      event.summaryKey === 'undo'
    )
      return formatSummary(event);
    if (
      event.summaryKey === 'thing.capture.recorded' ||
      event.summaryKey === 'thing.capture.named' ||
      event.action === 'thing.create'
    ) {
      const parent = event.diff?.container_id;
      const path = recordedPath(event, 'after');
      const where =
        container && parent && 'after' in parent && parent.after === target.id
          ? (cache?.things.find((item) => item.id === target.id)?.name ?? path)
          : path;
      const intent = event.diff?.capture_intent;
      if (intent && 'after' in intent && intent.after === 'add') {
        if (!where) return formatSummary(event);
        const destination = isolate(where);
        return t`Added ${name} to ${destination}`;
      }
      if (!where) return t`Recorded ${name}`;
      const destination = isolate(where);
      return t`Recorded ${name} in ${destination}`;
    }
    if (container && event.entity.id !== target.id) {
      const parent = event.diff?.container_id;
      if (parent && 'before' in parent && event.action === 'thing.move') {
        if (parent.before === target.id) return t`${name} moved out of this box`;
        if (parent.after === target.id) return t`${name} moved into this box`;
      }
    }
    return formatSummary(event);
  }

  function recordedPath(event: HistoryEvent, side: 'before' | 'after') {
    const change = event.diff?.path;
    const locationChange = event.diff?.location_id;
    const paths = change && 'before' in change ? change[side] : null;
    if (!paths && !locationChange) return '';
    const locationId =
      locationChange && 'before' in locationChange ? locationChange[side] : event.location_id;
    const location = cache?.locations.find((entry) => entry.id === locationId)?.name;
    return [
      location,
      ...(Array.isArray(paths) ? paths.filter((step) => typeof step === 'string') : []),
    ]
      .filter(Boolean)
      .join(' › ');
  }

  function renderEvent(event: HistoryEvent) {
    const before = recordedPath(event, 'before');
    const after = recordedPath(event, 'after');
    const evidence = event.diff?.attachment_ids;
    const fileIds = event.diff?.file_ids;
    const attached = evidence && 'after' in evidence ? evidence.after : null;
    const files = fileIds && 'after' in fileIds ? fileIds.after : null;
    const photos = attachments.filter(
      (entry) =>
        entry.role === 'photo' &&
        entry.file &&
        ((Array.isArray(attached) && attached.includes(entry.id)) ||
          (!attached &&
            event.entity.id === target.id &&
            Array.isArray(files) &&
            files.includes(entry.file.id))),
    );
    const captured = event.diff?.captured_at;
    const related =
      event.entity.id !== target.id && event.entity.type === 'thing'
        ? cache?.things.find((item) => item.id === event.entity.id)
        : undefined;
    const savedOnDevice = eventTime(captured);
    const observed = event.action === 'thing.capture' ? null : eventTime(event.diff?.last_seen_at);
    return (
      <li key={event.id} className="grid gap-1 rounded-lg border border-line bg-surface p-3">
        <p>
          <bdi>{summary(event)}</bdi>
        </p>
        {event.action.endsWith('.move') && before && after && before !== after && (
          <p className="text-small">
            <Trans>From</Trans> <bdi>{before}</bdi>
            <br />
            <Trans>To</Trans> <bdi>{after}</bdi>
          </p>
        )}
        <p className="text-small text-ink-2">
          <Trans>Recorded at</Trans>{' '}
          <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>
          {event.actor.displayName && (
            <>
              {sep()}
              <bdi>{event.actor.displayName}</bdi>
            </>
          )}
        </p>
        {savedOnDevice && (
          <p className="text-small text-ink-2">
            <Trans>Saved on device</Trans>{' '}
            <time dateTime={savedOnDevice}>{new Date(savedOnDevice).toLocaleString()}</time>
          </p>
        )}
        {observed && (
          <p className="text-small text-ink-2">
            <Trans>Observed at</Trans>{' '}
            <time dateTime={observed}>{new Date(observed).toLocaleString()}</time>
          </p>
        )}
        {photos.map((photo) => (
          <Button
            key={photo.id}
            variant="secondary"
            size="small"
            onPress={() => onOpenPhoto(photo)}
          >
            <Image size={14} aria-hidden />
            <bdi>{photo.name ?? t`Photograph`}</bdi>
          </Button>
        ))}
        {related && (
          <Button
            variant="secondary"
            size="small"
            onPress={() =>
              onOpen({ kind: 'thing', id: related.id, locationId: related.locationId })
            }
          >
            <Trans>Open</Trans> <bdi>{related.name ?? t`Untitled`}</bdi>
          </Button>
        )}
        {canEdit &&
          !event.undone &&
          !event.undo_of &&
          event.undoable_until &&
          Date.parse(event.undoable_until) > Date.now() &&
          ['thing.move', 'thing.trash', 'box.check'].includes(event.action) && (
            <Button
              variant="ghost"
              size="small"
              isPending={busy}
              onPress={() => void undo(event.id)}
            >
              <Undo2 size={14} aria-hidden />
              <Trans>Undo</Trans>
            </Button>
          )}
      </li>
    );
  }

  return (
    <section className="kept-card">
      <h3 className="kept-card-title">
        <History size={16} aria-hidden />
        <Trans>History</Trans>
      </h3>
      {!page ? (
        <Button
          variant="secondary"
          className="justify-self-center"
          isPending={busy}
          onPress={() => void load()}
        >
          <History size={16} aria-hidden />
          <Trans>View history</Trans>
        </Button>
      ) : (
        <>
          {page.items.length ? (
            <ol className="grid gap-2">
              {captureGroups(page.items, container).map((events) => {
                const first = events[0];
                if (!first) return null;
                if (events.length === 1) return renderEvent(first);
                const count = events.length;
                const isRecord = first.summaryKey === 'thing.capture.recorded';
                return (
                  <li key={first.id} className="rounded-lg border border-line bg-surface p-3">
                    <details>
                      <summary className="min-h-10 font-semibold">
                        {isRecord
                          ? t`Recorded ${count} entries from photo review`
                          : t`Added ${count} entries from photo review`}
                      </summary>
                      <ol className="grid gap-2 pt-2">{events.map(renderEvent)}</ol>
                    </details>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-ink-2">
              <Trans>No history yet.</Trans>
            </p>
          )}
          {page.next_cursor && (
            <Button
              variant="secondary"
              isPending={busy}
              onPress={() => void load(page.next_cursor ?? undefined)}
            >
              <Trans>Load more</Trans>
            </Button>
          )}
          <Button
            variant="ghost"
            className="justify-self-start"
            isDisabled={busy}
            onPress={() => setPage(undefined)}
          >
            <ChevronUp size={16} aria-hidden />
            <Trans>Hide history</Trans>
          </Button>
        </>
      )}
      {status && <p role="alert">{status}</p>}
    </section>
  );
}

function eventTime(change: NonNullable<HistoryEvent['diff']>[string] | undefined) {
  return change &&
    'after' in change &&
    typeof change.after === 'string' &&
    Number.isFinite(Date.parse(change.after))
    ? change.after
    : null;
}

/** Group only approved photo captures sharing a session in the loaded history. */
export function captureGroups(events: HistoryEvent[], container: boolean): HistoryEvent[][] {
  const groups = new Map<string, HistoryEvent[]>();
  const ordered: HistoryEvent[][] = [];
  for (const event of events) {
    const batch = event.diff?.batch_id;
    const files = event.diff?.file_ids;
    if (
      !container ||
      (event.summaryKey !== 'thing.capture.recorded' &&
        event.summaryKey !== 'thing.capture.named') ||
      !batch ||
      !('after' in batch) ||
      typeof batch.after !== 'string' ||
      !files ||
      !('after' in files) ||
      !Array.isArray(files.after) ||
      !files.after.length
    ) {
      ordered.push([event]);
      continue;
    }
    const key = JSON.stringify([batch.after, event.summaryKey, [...files.after].sort()]);
    const group = groups.get(key);
    if (group) group.push(event);
    else {
      const created = [event];
      groups.set(key, created);
      ordered.push(created);
    }
  }
  return ordered;
}
