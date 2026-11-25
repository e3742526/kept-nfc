import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  ArrowRightLeft,
  Boxes,
  Eye,
  Image,
  Inbox,
  MapPin,
  Minus,
  Package,
  Pencil,
  Plus,
  QrCode,
  Radar,
  RefreshCw,
  Settings,
  Tag,
  Tags,
  WifiOff,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { HistoryEvent, Page } from '@/api/inventory/types';
import { useSummary } from '@/components/history/labels';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/format';
import { usePlatform } from './adapters';
import type { Connection } from './bridge';
import type { InventoryCache } from './inventory';
import type { Target } from './labels';

/** What the four Home tiles count. Items and boxes match what Browse lists (drafts excluded). */
function homeStats(cache: InventoryCache | undefined) {
  const unplacedPlaces = new Map(cache?.locations.map((loc) => [loc.id, loc.unplacedPlaceId]));
  let items = 0;
  let boxes = 0;
  let unplaced = 0;
  let drafts = 0;
  for (const thing of cache?.things ?? []) {
    if (thing.reviewState === 'draft') {
      drafts += 1;
      continue;
    }
    items += 1;
    if (thing.isContainer) boxes += 1;
    if (thing.placeId && thing.placeId === unplacedPlaces.get(thing.locationId)) unplaced += 1;
  }
  const places = cache?.places.filter((p) => !p.isUnplaced).length ?? 0;
  return { items, boxes, places, unplaced, drafts };
}

function StatTile({
  value,
  label,
  Icon,
  isDisabled,
  onPress,
}: {
  value: number | undefined;
  label: string;
  Icon: typeof Package;
  isDisabled?: boolean;
  onPress: () => void;
}) {
  const fmt = useFormat();
  const number = value === undefined ? '—' : fmt.num(value);
  return (
    <Button
      variant="secondary"
      className="kept-stat"
      isDisabled={isDisabled}
      aria-label={value === undefined ? label : `${number} ${label}`}
      onPress={onPress}
    >
      <span className="kept-stat-top">
        <Icon size={15} className="kept-stat-icon" aria-hidden />
        <span className="kept-stat-value">{number}</span>
      </span>
      <span className="kept-stat-label">{label}</span>
    </Button>
  );
}

export function eventIcon(action: string) {
  if (action.includes('create') || action.includes('capture')) return Plus;
  if (action.includes('move')) return ArrowRightLeft;
  if (action.includes('check') || action.includes('seen')) return Eye;
  if (action.includes('remove') || action.includes('delete') || action.includes('trash'))
    return Minus;
  return Pencil;
}

function RecentActivity({
  connection,
  cache,
  online,
  onOpen,
  onHistory,
}: {
  connection: Connection;
  cache: InventoryCache | undefined;
  online: boolean;
  onOpen: (target: Target) => void;
  onHistory?: () => void;
}) {
  const { t } = useLingui();
  const { transport } = usePlatform();
  const fmt = useFormat();
  const summary = useSummary();
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const asOf = cache?.asOf;

  useEffect(() => {
    if (!online || !asOf) return;
    let live = true;
    transport
      .request<Page<HistoryEvent>>(connection, inventoryPaths.activity + qs({ limit: 4 }))
      .then((page) => {
        if (live) setEvents(page.items);
      })
      .catch(() => {
        /* A stale list is fine here; Home never blocks on the feed. */
      });
    return () => {
      live = false;
    };
  }, [asOf, connection, online, transport]);

  if (!events.length) return null;
  return (
    <section className="kept-recent" aria-label={t`Recent activity`}>
      <div className="kept-recent-head">
        <h2 className="kept-recent-title">
          <Trans>Recent activity</Trans>
        </h2>
        {onHistory && (
          <Button variant="ghost" size="small" className="kept-recent-link" onPress={onHistory}>
            <Trans>History</Trans>
          </Button>
        )}
      </div>
      <ul className="kept-recent-list">
        {events.map((event) => {
          const Icon = eventIcon(event.action);
          const { type, id } = event.entity;
          const locationId = event.location_id;
          const records =
            type === 'place' ? cache?.places : type === 'thing' ? cache?.things : undefined;
          const target: Target | undefined =
            id &&
            locationId &&
            (type === 'place' || type === 'thing') &&
            records?.some((record) => record.id === id && record.locationId === locationId)
              ? { id, locationId, kind: type }
              : undefined;
          const body = (
            <>
              <span className="kept-recent-icon" aria-hidden>
                <Icon size={15} />
              </span>
              <span className="kept-recent-text">{summary(event)}</span>
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
    </section>
  );
}

/**
 * The command center: counts that open their lists, the two jobs (Add, Scan), shortcuts, the
 * review bar, recent activity, and the sync status line with a way to Settings.
 */
export function HomeDashboard({
  connection,
  cache,
  online,
  working,
  pendingCount,
  failedCount,
  canWrite,
  onItems,
  onBoxes,
  onRooms,
  onUnplaced,
  onAdd,
  onScan,
  onCategories,
  onLabels,
  onReview,
  onOpen,
  onRetry,
  onSettings,
  findName,
  onFind,
  onHistory,
}: {
  connection: Connection;
  cache: InventoryCache | undefined;
  online: boolean;
  working: boolean;
  pendingCount: number;
  failedCount: number;
  canWrite: boolean;
  onItems: () => void;
  onBoxes: () => void;
  onRooms: () => void;
  onUnplaced: () => void;
  onAdd: () => void;
  onScan: () => void;
  onCategories: () => void;
  onLabels: () => void;
  onReview: () => void;
  onOpen: (target: Target) => void;
  onRetry: () => void;
  onSettings: () => void;
  /** The saved Find target's name; the Find action shows only while one is saved. */
  findName?: string;
  onFind: () => void;
  onHistory?: () => void;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const stats = useMemo(() => homeStats(cache), [cache]);
  const { drafts } = stats;
  const ready = !!cache;
  const syncAge = cache ? fmt.relative(cache.asOf) : '';
  const waiting = fmt.num(pendingCount);
  return (
    <div className="kept-home">
      <div className="kept-stats">
        <StatTile
          value={stats.items}
          label={t`Items`}
          Icon={Package}
          isDisabled={!ready}
          onPress={onItems}
        />
        <StatTile
          value={stats.boxes}
          label={t`Boxes`}
          Icon={Boxes}
          isDisabled={!ready}
          onPress={onBoxes}
        />
        <StatTile
          value={cache?.truncated ? undefined : stats.places}
          label={t`Places`}
          Icon={MapPin}
          isDisabled={!ready}
          onPress={onRooms}
        />
        <StatTile
          value={stats.unplaced}
          label={t`Unplaced`}
          Icon={Inbox}
          isDisabled={!ready}
          onPress={onUnplaced}
        />
      </div>
      <div className={`kept-home-actions${findName ? ' kept-home-actions-3' : ''}`}>
        <Button className="kept-action" isDisabled={!canWrite} onPress={onAdd}>
          <span className="kept-action-well kept-action-well-accent" aria-hidden>
            <Plus size={20} />
          </span>
          <Trans>Add</Trans>
        </Button>
        <Button variant="secondary" className="kept-action" onPress={onScan}>
          <span className="kept-action-well" aria-hidden>
            <QrCode size={20} />
          </span>
          <Trans>Scan</Trans>
        </Button>
        {findName && (
          <Button
            variant="secondary"
            className="kept-action"
            aria-label={t`Continue finding ${findName}`}
            onPress={onFind}
          >
            <span className="kept-action-well" aria-hidden>
              <Radar size={20} />
            </span>
            <Trans>Find</Trans>
          </Button>
        )}
      </div>
      <div className="kept-shortcuts">
        <Button
          variant="ghost"
          className="kept-shortcut"
          isDisabled={!ready}
          onPress={onCategories}
        >
          <span className="kept-shortcut-well" aria-hidden>
            <Tag size={18} />
          </span>
          <Trans>Categories</Trans>
        </Button>
        <Button
          variant="ghost"
          className="kept-shortcut"
          isDisabled={!ready || !online}
          onPress={onLabels}
        >
          <span className="kept-shortcut-well" aria-hidden>
            <Tags size={18} />
          </span>
          <Trans>Labels</Trans>
        </Button>
      </div>
      {drafts > 0 && (
        <section className="kept-review-bar" aria-label={t`Needs attention`}>
          <Image size={18} className="kept-review-icon" aria-hidden />
          <p className="kept-review-text">
            {plural(drafts, { one: '# item to review', other: '# items to review' })}
          </p>
          <Button variant="secondary" size="small" isDisabled={!online} onPress={onReview}>
            <Trans>Review</Trans>
          </Button>
        </section>
      )}
      <RecentActivity
        connection={connection}
        cache={cache}
        online={online}
        onOpen={onOpen}
        onHistory={onHistory}
      />
      <div className="kept-statusline">
        <Button
          variant="ghost"
          size="small"
          className="kept-sync-pill"
          isDisabled={working}
          onPress={onRetry}
        >
          <span className="sr-only">
            <Trans>Refresh</Trans>{' '}
          </span>
          {!online ? (
            <>
              <span className="kept-sync-dot kept-sync-dot-warn" aria-hidden />
              <WifiOff size={14} aria-hidden />
              <span>{pendingCount > 0 ? t`Offline · ${waiting} waiting` : t`Offline`}</span>
            </>
          ) : failedCount > 0 ? (
            <>
              <span className="kept-sync-dot kept-sync-dot-warn" aria-hidden />
              <RefreshCw size={14} className={working ? 'kept-spin' : undefined} aria-hidden />
              <span>{t`Sync failed · ${waiting} waiting · Retry`}</span>
            </>
          ) : (
            <>
              <span className="kept-sync-dot kept-sync-dot-ok" aria-hidden />
              <RefreshCw size={14} className={working ? 'kept-spin' : undefined} aria-hidden />
              <span>{cache ? t`Synced ${syncAge}` : t`Syncing…`}</span>
            </>
          )}
        </Button>
        <Button
          variant="ghost"
          size="small"
          className="kept-gear"
          aria-label={t`Settings`}
          onPress={onSettings}
        >
          <Settings size={20} aria-hidden />
        </Button>
      </div>
    </div>
  );
}
