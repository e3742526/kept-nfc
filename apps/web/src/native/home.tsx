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
import { useEffect, useState } from 'react';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { HistoryEvent, Page } from '@/api/inventory/types';
import { useSummary } from '@/components/history/labels';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/format';
import { usePlatform } from './adapters';
import type { Connection } from './bridge';
import type { InventoryCache } from './inventory';
import type { Target } from './labels';

export type HomeStats = { items: number; boxes: number; rooms: number; unplaced: number };

/** What the four Home tiles count. Items and boxes match what Browse lists (drafts excluded). */
export function homeStats(cache: InventoryCache | undefined): HomeStats {
  if (!cache) return { items: 0, boxes: 0, rooms: 0, unplaced: 0 };
  const unplacedPlaces = new Set(cache.places.filter((p) => p.isUnplaced).map((p) => p.id));
  let items = 0;
  let boxes = 0;
  let unplaced = 0;
  for (const thing of cache.things) {
    if (thing.reviewState === 'draft') continue;
    items += 1;
    if (thing.isContainer) boxes += 1;
    if (thing.placeId && unplacedPlaces.has(thing.placeId)) unplaced += 1;
  }
  const rooms = cache.places.filter((p) => p.kindKey === 'room' && !p.isUnplaced).length;
  return { items, boxes, rooms, unplaced };
}

/** Things still waiting for the person to confirm them. */
export function draftCount(cache: InventoryCache | undefined): number {
  return cache?.things.filter((thing) => thing.reviewState === 'draft').length ?? 0;
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
  return (
    <Button
      variant="secondary"
      className="kept-stat"
      isDisabled={isDisabled}
      aria-label={`${fmt.num(value)} ${label}`}
      onPress={onPress}
    >
      <span className="kept-stat-top">
        <Icon size={15} className="kept-stat-icon" aria-hidden />
        <span className="kept-stat-value">{fmt.num(value)}</span>
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
  online,
  onOpen,
  onHistory,
}: {
  connection: Connection;
  online: boolean;
  onOpen: (target: Target) => void;
  onHistory?: () => void;
}) {
  const { t } = useLingui();
  const { transport } = usePlatform();
  const fmt = useFormat();
  const summary = useSummary();
  const [events, setEvents] = useState<HistoryEvent[]>([]);

  useEffect(() => {
    if (!online) return;
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
  }, [connection, online, transport]);

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
          const openable =
            (event.entity.type === 'thing' || event.entity.type === 'place') &&
            event.entity.id &&
            event.location_id;
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
              {openable ? (
                <Button
                  variant="ghost"
                  className="kept-recent-row"
                  onPress={() =>
                    onOpen({
                      id: event.entity.id as string,
                      locationId: event.location_id as string,
                      kind: event.entity.type === 'place' ? 'place' : 'thing',
                    })
                  }
                >
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
  const stats = homeStats(cache);
  const drafts = draftCount(cache);
  const ready = !!cache;
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
            {drafts === 1 ? t`1 item to review` : t`${fmt.num(drafts)} items to review`}
          </p>
          <Button variant="secondary" size="small" isDisabled={!online} onPress={onReview}>
            <Trans>Review</Trans>
          </Button>
        </section>
      )}
      <RecentActivity
        connection={connection}
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
          aria-label={online ? t`Refresh` : t`Offline`}
          onPress={onRetry}
        >
          {!online ? (
            <>
              <span className="kept-sync-dot kept-sync-dot-warn" aria-hidden />
              <WifiOff size={14} aria-hidden />
              <span>{pendingCount > 0 ? t`Offline · ${pendingCount} waiting` : t`Offline`}</span>
            </>
          ) : failedCount > 0 ? (
            <>
              <span className="kept-sync-dot kept-sync-dot-warn" aria-hidden />
              <RefreshCw size={14} className={working ? 'kept-spin' : undefined} aria-hidden />
              <span>{t`Sync failed · ${pendingCount} waiting · Retry`}</span>
            </>
          ) : (
            <>
              <span className="kept-sync-dot kept-sync-dot-ok" aria-hidden />
              <RefreshCw size={14} className={working ? 'kept-spin' : undefined} aria-hidden />
              <span>{cache ? t`Synced ${fmt.relative(cache.asOf)}` : t`Syncing…`}</span>
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
