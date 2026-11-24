import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Boxes,
  ChevronRight,
  ClipboardCheck,
  Inbox,
  MapPin,
  Package,
  Plus,
  QrCode,
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
  const rooms = cache?.places.filter((p) => p.kindKey === 'room' && !p.isUnplaced).length ?? 0;
  return { items, boxes, rooms, unplaced, drafts };
}

function StatTile({
  value,
  label,
  Icon,
  isDisabled,
  onPress,
}: {
  value: number;
  label: string;
  Icon: typeof Package;
  isDisabled?: boolean;
  onPress: () => void;
}) {
  const fmt = useFormat();
  const number = fmt.num(value);
  return (
    <Button
      variant="secondary"
      className="kept-stat"
      isDisabled={isDisabled}
      aria-label={`${number} ${label}`}
      onPress={onPress}
    >
      <Icon size={16} className="kept-stat-icon" aria-hidden />
      <span className="kept-stat-value">{number}</span>
      <span className="kept-stat-label">{label}</span>
    </Button>
  );
}

function RecentActivity({
  connection,
  cache,
  online,
  onOpen,
}: {
  connection: Connection;
  cache: InventoryCache | undefined;
  online: boolean;
  onOpen: (target: Target) => void;
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
      .request<Page<HistoryEvent>>(connection, inventoryPaths.activity + qs({ limit: 3 }))
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
      <h2 className="kept-recent-title">
        <Trans>Recent activity</Trans>
      </h2>
      <ul className="kept-recent-list">
        {events.map((event) => {
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
          value={stats.rooms}
          label={t`Rooms`}
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
      <div className="kept-home-actions">
        <Button className="kept-home-action" isDisabled={!canWrite} onPress={onAdd}>
          <Plus size={18} aria-hidden />
          <Trans>Add</Trans>
        </Button>
        <Button variant="secondary" className="kept-home-action" onPress={onScan}>
          <QrCode size={18} aria-hidden />
          <Trans>Scan</Trans>
        </Button>
      </div>
      <div className="kept-home-actions">
        <Button
          variant="secondary"
          className="kept-home-action"
          isDisabled={!ready}
          onPress={onCategories}
        >
          <Tag size={16} aria-hidden />
          <Trans>Categories</Trans>
        </Button>
        <Button
          variant="secondary"
          className="kept-home-action"
          isDisabled={!ready || !online}
          onPress={onLabels}
        >
          <Tags size={16} aria-hidden />
          <Trans>Labels</Trans>
        </Button>
      </div>
      {drafts > 0 && (
        <Button
          variant="secondary"
          className="kept-phone-row kept-review-bar"
          isDisabled={!online}
          onPress={onReview}
        >
          <span className="kept-row-lead kept-row-lead-accent" aria-hidden>
            <ClipboardCheck size={18} />
          </span>
          <span className="kept-row-body">
            <span className="font-semibold">
              {plural(drafts, { one: '# item to review', other: '# items to review' })}
            </span>
          </span>
          <ChevronRight size={18} className="kept-row-chevron rtl:rotate-180" aria-hidden />
        </Button>
      )}
      <RecentActivity connection={connection} cache={cache} online={online} onOpen={onOpen} />
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
