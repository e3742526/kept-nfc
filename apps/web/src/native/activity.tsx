import type { ActivityKind } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { ChevronDown, ChevronRight, Clock, FileText, Share2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { HistoryEvent, Page } from '@/api/inventory/types';
import { useSummary } from '@/components/history/labels';
import { useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/format';
import { usePlatform } from './adapters';
import { ScreenHeader } from './back-button';
import type { Connection } from './bridge';
import { eventIcon } from './home';
import type { Target } from './labels';
import { isAuthRefusal, isRestoreEpochMismatch } from './outbox';

type AuthError = (reason: 'expired' | 'restored') => void;

/** The household activity feed, a page at a time (GET /api/v1/activity). */
function useActivity(
  connection: Connection,
  online: boolean,
  kind: ActivityKind | undefined,
  onAuthError: AuthError,
) {
  const { transport } = usePlatform();
  const errorText = useErrorText();
  const [page, setPage] = useState<Page<HistoryEvent>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Callers pass fresh closures every render; the feed must not reload because of them.
  const latest = useRef({ errorText, onAuthError });
  latest.current = { errorText, onAuthError };

  const load = useCallback(
    async (cursor?: string) => {
      setBusy(true);
      setError('');
      try {
        const result = await transport.request<Page<HistoryEvent>>(
          connection,
          inventoryPaths.activity + qs({ kind, limit: 25, cursor }),
        );
        setPage((previous) => ({
          ...result,
          items: [...(cursor ? (previous?.items ?? []) : []), ...result.items],
        }));
      } catch (caught) {
        if (isAuthRefusal(caught)) latest.current.onAuthError('expired');
        else if (isRestoreEpochMismatch(caught)) latest.current.onAuthError('restored');
        else setError(latest.current.errorText(caught));
      } finally {
        setBusy(false);
      }
    },
    [connection, kind, transport],
  );

  useEffect(() => {
    setPage(undefined);
    if (online) void load();
  }, [online, load]);

  return { page, busy, error, more: () => page?.next_cursor && load(page.next_cursor) };
}

function openable(event: HistoryEvent): Target | undefined {
  if (
    (event.entity.type === 'thing' || event.entity.type === 'place') &&
    event.entity.id &&
    event.location_id
  )
    return {
      id: event.entity.id,
      locationId: event.location_id,
      kind: event.entity.type === 'place' ? 'place' : 'thing',
    };
}

function Chips<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (id: T) => void;
}) {
  return (
    <div className="kept-chips">
      {options.map((option) => (
        <Button
          key={option.id}
          variant="secondary"
          size="small"
          className="kept-chip"
          aria-pressed={value === option.id}
          onPress={() => onChange(option.id)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

/** Everything recorded, newest first, filtered by what happened (added, moved, checked). */
export function HistoryScreen({
  connection,
  online,
  onBack,
  onOpen,
  onAuthError,
}: {
  connection: Connection;
  online: boolean;
  onBack: () => void;
  onOpen: (target: Target) => void;
  onAuthError: AuthError;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const summary = useSummary();
  const [kind, setKind] = useState<ActivityKind | 'all'>('all');
  const feed = useActivity(connection, online, kind === 'all' ? undefined : kind, onAuthError);
  return (
    <section className="grid gap-3">
      <ScreenHeader
        title={<Trans>History</Trans>}
        onBack={onBack}
        icon={<Clock size={18} aria-hidden />}
      />
      <Chips
        value={kind}
        onChange={setKind}
        options={[
          { id: 'all', label: t`All` },
          { id: 'added', label: t`Added` },
          { id: 'moved', label: t`Moved` },
          { id: 'checked', label: t`Checked` },
        ]}
      />
      {!online && (
        <p className="text-ink-2" role="status">
          <Trans>Connect to SheepKeep to see history.</Trans>
        </p>
      )}
      {feed.error && <p role="alert">{feed.error}</p>}
      <ul className="kept-recent-list">
        {feed.page?.items.map((event) => {
          const Icon = eventIcon(event.action);
          const target = openable(event);
          const body = (
            <>
              <span className="kept-recent-icon" aria-hidden>
                <Icon size={15} />
              </span>
              <span className="kept-recent-text kept-wrap">{summary(event)}</span>
              <span className="kept-recent-when">{fmt.relative(event.at)}</span>
            </>
          );
          return (
            <li key={event.id}>
              {target ? (
                <Button variant="ghost" className="kept-recent-row" onPress={() => onOpen(target)}>
                  {body}
                </Button>
              ) : (
                <div className="kept-recent-row">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {online && feed.page && feed.page.items.length === 0 && (
        <p className="text-ink-2">
          <Trans>Nothing recorded yet.</Trans>
        </p>
      )}
      {feed.page?.next_cursor && (
        <Button variant="secondary" isPending={feed.busy} onPress={() => void feed.more()}>
          <Trans>Load more</Trans>
        </Button>
      )}
    </section>
  );
}

export type LocalLogEntry = {
  id: string;
  name: string;
  takenAt: string;
  reason: string;
  message: string;
  destination: string;
  files: number;
};

type LogFilter = 'all' | 'phone' | 'ai' | 'captures';

function Detail({ label, value }: { label: string; value: string | undefined | null }) {
  if (!value) return null;
  return (
    <div className="kept-log-detail">
      <dt>{label}</dt>
      <dd>
        <bdi>{value}</bdi>
      </dd>
    </div>
  );
}

/**
 * Logs with provenance: what is waiting or failed on this iPhone, and the server's own record of
 * every change (who, from where, what, when). The server record is append-only, so there is no
 * Clear; Share copies the visible entries as text.
 */
export function LogsScreen({
  connection,
  online,
  local,
  onBack,
  onOpen,
  onAuthError,
}: {
  connection: Connection;
  online: boolean;
  local: LocalLogEntry[];
  onBack: () => void;
  onOpen: (target: Target) => void;
  onAuthError: AuthError;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const summary = useSummary();
  const feed = useActivity(connection, online, undefined, onAuthError);
  const [filter, setFilter] = useState<LogFilter>('all');
  const [openId, setOpenId] = useState<string>();
  const [shared, setShared] = useState('');

  const events = (feed.page?.items ?? []).filter((event) =>
    filter === 'ai'
      ? event.action === 'ai.call'
      : filter === 'captures'
        ? event.action.includes('capture')
        : filter !== 'phone',
  );
  const showLocal = filter === 'all' || filter === 'phone' || filter === 'captures';

  async function share() {
    const lines = [
      ...(showLocal
        ? local.map(
            (entry) =>
              `${fmt.dateTime(entry.takenAt)}  [this iPhone] ${entry.name} → ${entry.destination}: ${entry.message} (${entry.reason}, capture ${entry.id})`,
          )
        : []),
      ...events.map(
        (event) =>
          `${fmt.dateTime(event.at)}  [server] ${summary(event)} — ${event.actor.displayName ?? event.actor.type} (${event.action}, event ${event.id})`,
      ),
    ];
    const text = lines.join('\n');
    try {
      if (navigator.share) await navigator.share({ title: 'SheepKeep logs', text });
      else {
        await navigator.clipboard.writeText(text);
        setShared(t`Copied to the clipboard.`);
      }
    } catch {
      /* The person dismissed the share sheet. */
    }
  }

  return (
    <section className="grid gap-3">
      <ScreenHeader
        title={<Trans>Logs</Trans>}
        onBack={onBack}
        icon={<FileText size={18} aria-hidden />}
        trailing={
          <Button
            variant="ghost"
            size="small"
            aria-label={t`Share logs`}
            onPress={() => void share()}
          >
            <Share2 size={18} aria-hidden />
          </Button>
        }
      />
      <Chips
        value={filter}
        onChange={setFilter}
        options={[
          { id: 'all', label: t`All` },
          { id: 'phone', label: t`This iPhone` },
          { id: 'captures', label: t`Captures` },
          { id: 'ai', label: t`AI` },
        ]}
      />
      {shared && <p role="status">{shared}</p>}
      {showLocal && (
        <section className="grid gap-1" aria-label={t`On this iPhone`}>
          <h3 className="kept-recent-title">
            <Trans>On this iPhone</Trans>
          </h3>
          {local.length === 0 ? (
            <p className="text-small text-ink-2">
              <Trans>Nothing is waiting to sync.</Trans>
            </p>
          ) : (
            <ul className="kept-recent-list">
              {local.map((entry) => (
                <li key={entry.id} className="kept-log-entry">
                  <p className="kept-log-title">
                    <bdi>{entry.name}</bdi>
                  </p>
                  <p className="kept-log-error">{entry.message}</p>
                  <dl className="kept-log-details">
                    <Detail label={t`Destination`} value={entry.destination} />
                    <Detail label={t`Captured`} value={fmt.dateTime(entry.takenAt)} />
                    <Detail label={t`Reason`} value={entry.reason} />
                    <Detail label={t`Capture ID`} value={entry.id} />
                    <Detail label={t`Files`} value={String(entry.files)} />
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {filter !== 'phone' && (
        <section className="grid gap-1" aria-label={t`Server log`}>
          <h3 className="kept-recent-title">
            <Trans>Server log</Trans>
          </h3>
          {!online && (
            <p className="text-small text-ink-2" role="status">
              <Trans>Connect to SheepKeep to see the server log.</Trans>
            </p>
          )}
          {feed.error && <p role="alert">{feed.error}</p>}
          <ul className="kept-recent-list">
            {events.map((event) => {
              const expanded = openId === event.id;
              const target = openable(event);
              const diffKeys = event.diff ? Object.keys(event.diff) : [];
              return (
                <li key={event.id} className="kept-log-entry">
                  <Button
                    variant="ghost"
                    className="kept-log-toggle"
                    aria-expanded={expanded}
                    onPress={() => setOpenId(expanded ? undefined : event.id)}
                  >
                    <span className="kept-recent-text kept-wrap">{summary(event)}</span>
                    <span className="kept-recent-when">{fmt.relative(event.at)}</span>
                    {expanded ? (
                      <ChevronDown size={16} aria-hidden />
                    ) : (
                      <ChevronRight size={16} className="rtl:rotate-180" aria-hidden />
                    )}
                  </Button>
                  {expanded && (
                    <>
                      <dl className="kept-log-details">
                        <Detail
                          label={t`Who`}
                          value={event.actor.displayName ?? event.actor.type}
                        />
                        <Detail label={t`Source`} value={event.actor.type} />
                        <Detail label={t`Action`} value={event.action} />
                        <Detail label={t`About`} value={event.summaryParams.name} />
                        <Detail label={t`Server logged`} value={fmt.dateTime(event.at)} />
                        <Detail
                          label={t`Changed`}
                          value={diffKeys.length ? diffKeys.join(', ') : undefined}
                        />
                        <Detail label={t`Event ID`} value={event.id} />
                      </dl>
                      {target && (
                        <Button
                          variant="secondary"
                          size="small"
                          className="kept-log-open"
                          onPress={() => onOpen(target)}
                        >
                          <Trans>Open</Trans>
                        </Button>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {feed.page?.next_cursor && (
            <Button variant="secondary" isPending={feed.busy} onPress={() => void feed.more()}>
              <Trans>Load more</Trans>
            </Button>
          )}
        </section>
      )}
    </section>
  );
}
