import { I18nProvider } from '@lingui/react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  ChevronRight,
  FileText,
  History,
  type Home,
  Inbox,
  LogOut,
  MapPin,
  MessageSquare,
  Monitor,
  Moon,
  Package,
  Palette,
  Plus,
  QrCode,
  Radar,
  RefreshCw,
  Search,
  Settings,
  Sun,
  Tags,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { capturePaths } from '@/api/capture/paths';
import type { CaptureBatch, InboxPage } from '@/api/capture/types';
import { ApiError } from '@/api/client';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { Page, SearchResponse } from '@/api/inventory/types';
import { paths } from '@/api/paths';
import { AppMark, BrandLockup } from '@/components/brand';
import { ProjectNotice } from '@/components/project-notice';
import { Button } from '@/components/ui/button';
import { ConfirmProvider, useConfirm } from '@/components/ui/confirm';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { i18n, startLocale } from '@/i18n/i18n';
import { isolate } from '@/lib/bidi';
import { sep, useBytes } from '@/lib/format';
import { setThemePref, type ThemePref, usePrefs, watchSystemTheme } from '@/lib/prefs';
import { NativePlatformProvider, usePlatform } from './adapters';
import { AssistantScreen } from './assistant';
import { ScreenHeader } from './back-button';
import {
  type CompletionState,
  type Connection,
  nativeErrorCode,
  type StorageStats,
} from './bridge';
import { Browse, browseDefaults } from './browse';
import { CaptureAISettings } from './capture-ai';
import { CaptureForm, NewBoxForm } from './capture-form';
import type { Destination } from './destination';
import {
  type InventoryCache,
  inventoryPath,
  loadInventory,
  localInventorySearch,
  previewUrl,
  type RecordDetail,
  readInventory,
} from './inventory';
import { FIND_TARGET_KEY, type LabelBox, LabelPanel } from './label-panel';
import { LabelSheets } from './label-sheets';
import { resolveLabel, type Target } from './labels';
import {
  canRetarget,
  discardCapture,
  discardHeldCapture,
  draftFields,
  getCompletions,
  getOutboxStats,
  heldCaptureExport,
  isAuthRefusal,
  isRestoreEpochMismatch,
  listHeldCaptures,
  type PendingCapture,
  retargetCapture,
  retryCapture,
  syncOutbox,
} from './outbox';
import { applyPalette, type PaletteId, setPalette, usePalette } from './palette';
import { PhotoReview } from './photo-review';
import { RecordScreen } from './record';
import { Rooms } from './rooms';
import { Trash } from './trash';
import { PhotoSearchActions, type VisualSearchIntent, VisualSearchScreen } from './visual-search';
import './native.css';

type Screen =
  | { kind: 'home' }
  | {
      kind: 'record';
      target: Target;
      backToRooms?: boolean;
      backToBrowse?: boolean;
      backToVisual?: boolean;
    }
  | { kind: 'new'; place?: Target }
  | { kind: 'rooms' }
  | { kind: 'unplaced' }
  | { kind: 'labelSheets' }
  | { kind: 'trash' }
  | {
      kind: 'capture';
      destination?: Destination;
      location?: string;
      back?: Target;
      name?: string;
    }
  | { kind: 'identify' }
  | { kind: 'find' | 'enroll'; box: LabelBox }
  | { kind: 'batches' }
  | { kind: 'assistant' }
  | { kind: 'browse' }
  | { kind: 'visualSearch'; intent: VisualSearchIntent }
  | { kind: 'photoReview'; id: string }
  | { kind: 'more' };

type TabKey = 'home' | 'capture' | 'scan' | 'more';

function tabFor(screen: Screen): TabKey {
  switch (screen.kind) {
    case 'capture':
      return 'capture';
    case 'photoReview':
      return 'capture';
    case 'identify':
      return 'scan';
    case 'more':
    case 'trash':
    case 'unplaced':
    case 'labelSheets':
    case 'batches':
    case 'assistant':
      return 'more';
    default:
      return 'home';
  }
}

/**
 * Fixed bottom tab bar: the four main phone destinations, icon-first. Search and Add are the
 * two jobs people open the app for, so Search is the landing tab and Add is the emphasized one.
 * The unsynced-capture badge sits on Search, where the pending list lives.
 */
function TabBar({
  tab,
  pendingCount = 0,
  onTab,
}: {
  tab: TabKey;
  pendingCount?: number;
  onTab: (tab: TabKey) => void;
}) {
  const { t } = useLingui();
  const tabs = [
    { key: 'home', label: t`Search`, Icon: Search },
    { key: 'capture', label: t`Add`, Icon: Plus },
    { key: 'scan', label: t`Scan`, Icon: QrCode },
    { key: 'more', label: t`More`, Icon: Settings },
  ] as const;
  return (
    <nav className="kept-tabbar">
      {tabs.map(({ key, label, Icon }) => (
        <Button
          key={key}
          variant="ghost"
          className={`kept-tabbar-button${key === 'capture' ? ' kept-tabbar-add' : ''}`}
          aria-current={tab === key ? 'page' : undefined}
          onPress={() => onTab(key)}
        >
          <Icon size={22} aria-hidden />
          <span className="kept-tabbar-label">{label}</span>
          {key === 'home' && pendingCount > 0 && (
            <span className="kept-tabbar-badge" aria-hidden>
              {pendingCount > 99 ? '99+' : pendingCount}
            </span>
          )}
        </Button>
      ))}
    </nav>
  );
}

type TileTone = 'amber' | 'info' | 'ok' | 'violet' | 'danger' | 'neutral';

/** Icon tile for the compartmentalized home and More grids. */
function ActionTile({
  label,
  onPress,
  isDisabled,
  Icon,
  tone = 'neutral',
}: {
  label: string;
  onPress: () => void;
  isDisabled?: boolean;
  Icon: typeof Home;
  tone?: TileTone;
}) {
  return (
    <Button
      variant="secondary"
      className={`kept-tile kept-tile-${tone}`}
      isDisabled={isDisabled}
      onPress={onPress}
    >
      <span className="kept-tile-icon" aria-hidden>
        <Icon size={20} />
      </span>
      <span className="kept-tile-label">{label}</span>
    </Button>
  );
}

/** Light / dark / system appearance switch (follows the OS on "system"). */
function ThemeSwitch() {
  const { t } = useLingui();
  const { theme } = usePrefs();
  const options: { id: ThemePref; label: string; Icon: typeof Sun }[] = [
    { id: 'light', label: t`Light`, Icon: Sun },
    { id: 'dark', label: t`Dark`, Icon: Moon },
    { id: 'system', label: t`System`, Icon: Monitor },
  ];
  return (
    <div className="kept-theme-switch">
      {options.map(({ id, label, Icon }) => (
        <Button
          key={id}
          variant="secondary"
          size="small"
          className="kept-theme-option"
          aria-pressed={theme === id}
          onPress={() => setThemePref(id)}
        >
          <Icon size={16} aria-hidden />
          {label}
        </Button>
      ))}
    </div>
  );
}

/** Color palette variations that layer over light, dark, and system modes. */
function PaletteSwitch() {
  const { t } = useLingui();
  const palette = usePalette();
  const options: { id: PaletteId; label: string; swatch: [string, string] }[] = [
    { id: 'default', label: t`Default`, swatch: ['#173E37', '#E2B86B'] },
    { id: 'slate', label: t`Slate`, swatch: ['#1E293B', '#2563EB'] },
    { id: 'meadow', label: t`Meadow`, swatch: ['#163322', '#2E7D4F'] },
    { id: 'contrast', label: t`High contrast`, swatch: ['#000000', '#FFD166'] },
  ];
  return (
    <div className="kept-palette-grid">
      {options.map(({ id, label, swatch }) => (
        <Button
          key={id}
          variant="secondary"
          size="small"
          className="kept-palette-option"
          aria-pressed={palette === id}
          onPress={() => setPalette(id)}
        >
          <span className="kept-swatch" aria-hidden>
            <span className="kept-swatch-a" style={{ background: swatch[0] }} />
            <span className="kept-swatch-b" style={{ background: swatch[1] }} />
          </span>
          <span>{label}</span>
        </Button>
      ))}
    </div>
  );
}

type PersistedFindTarget = LabelBox;

function ThingList({
  items,
  onOpen,
  origin,
}: {
  items: {
    id: string;
    name: string | null;
    locationId: string;
    path: string;
    thumbUrl?: string | null;
  }[];
  origin?: string;
  onOpen: (target: Target) => void;
}) {
  const { t } = useLingui();
  return (
    <ul className="grid gap-2">
      {items.map((thing) => {
        const image = origin && previewUrl(thing.thumbUrl, origin);
        return (
          <li key={thing.id}>
            <Button
              variant="secondary"
              className="kept-phone-row"
              onPress={() => onOpen({ id: thing.id, kind: 'thing', locationId: thing.locationId })}
            >
              {image ? (
                <img
                  alt=""
                  src={image}
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  className="kept-thumb"
                />
              ) : (
                <span className="kept-row-lead" aria-hidden>
                  <Package size={18} />
                </span>
              )}
              <span className="kept-row-body">
                <bdi className="text-body font-semibold">{thing.name ?? t`Untitled`}</bdi>
                {thing.path && (
                  <bdi className="font-normal text-small text-ink-2">{thing.path}</bdi>
                )}
              </span>
              <ChevronRight size={18} className="kept-row-chevron rtl:rotate-180" aria-hidden />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function Batches({
  connection,
  onClose,
  onOpen,
  onAuthError,
}: {
  connection: Connection;
  onClose: () => void;
  onOpen: (target: Target) => void;
  onAuthError?: (reason: 'expired' | 'restored') => void;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const [batches, setBatches] = useState<CaptureBatch[]>();
  const [reviews, setReviews] = useState<InboxPage>();
  const [batchId, setBatchId] = useState<string>();
  const [status, setStatus] = useState('');
  useEffect(() => {
    let live = true;
    void adapters.transport
      .request<Page<CaptureBatch>>(
        connection,
        `${capturePaths.captureBatches}${qs({ mine: '1', limit: 30 })}`,
      )
      .then(({ items }) => {
        if (live) setBatches(items);
      })
      .catch((error: unknown) => {
        if (!live) return;
        if (isAuthRefusal(error)) {
          onAuthError?.('expired');
          return;
        }
        if (isRestoreEpochMismatch(error)) {
          onAuthError?.('restored');
          return;
        }
        setStatus(t`Connect to SheepKeep to review recent batches.`);
      });
    return () => {
      live = false;
    };
  }, [adapters, connection, onAuthError, t]);

  async function review(batch: CaptureBatch) {
    setBatchId(batch.batchId);
    setReviews(undefined);
    setStatus('');
    try {
      setReviews(
        await adapters.transport.request(
          connection,
          `${capturePaths.inbox}${qs({ batchId: batch.batchId })}`,
        ),
      );
    } catch (error) {
      if (isAuthRefusal(error)) {
        onAuthError?.('expired');
        return;
      }
      if (isRestoreEpochMismatch(error)) {
        onAuthError?.('restored');
        return;
      }
      setStatus(t`Connect to SheepKeep to review recent batches.`);
    }
  }

  return (
    <section className="grid gap-4">
      <ScreenHeader
        title={<Trans>Recent capture batches</Trans>}
        onBack={onClose}
        icon={<History size={18} aria-hidden />}
      />
      {batches?.length === 0 && (
        <p className="text-ink-2">
          <Trans>No capture batches yet.</Trans>
        </p>
      )}
      {batches?.map((batch) => {
        const path = batch.placePath.map((step) => step.name).join(' › ');
        return (
          <div key={batch.batchId} className="grid gap-2">
            <Button
              variant="secondary"
              className="kept-phone-row"
              onPress={() => void review(batch)}
            >
              <span className="kept-row-lead" aria-hidden>
                <History size={18} />
              </span>
              <span className="kept-row-body">
                <bdi className="font-semibold">{path}</bdi>
                <span className="text-small font-normal text-ink-2">
                  {t`Saved: ${batch.count}`}
                  {sep()}
                  {new Date(batch.capturedAt).toLocaleString()}
                </span>
              </span>
              <ChevronRight size={18} className="kept-row-chevron rtl:rotate-180" aria-hidden />
            </Button>
            {batchId === batch.batchId &&
              reviews &&
              (reviews.items.length ? (
                <ThingList
                  onOpen={onOpen}
                  items={reviews.items.flatMap((review) =>
                    review.thing ? [{ ...review.thing, path }] : [],
                  )}
                />
              ) : (
                <p className="text-ink-2">
                  <Trans>Nothing in this batch needs review.</Trans>
                </p>
              ))}
          </div>
        );
      })}
      {status && <p role="status">{status}</p>}
    </section>
  );
}

export function Inventory({
  connection,
  onSignOut,
}: {
  connection: Connection;
  onSignOut: (reason?: 'expired' | 'restored') => void;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const confirm = useConfirm();
  const formatBytes = useBytes();
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });
  const [browseFilters, setBrowseFilters] = useState(browseDefaults);
  useEffect(() => {
    let active = true;
    void adapters.outbox
      .getValue(connection, 'browseLayout')
      .then((raw) => {
        if (!raw || !active) return;
        const prefs: unknown = JSON.parse(raw);
        if (!prefs || typeof prefs !== 'object') return;
        const { grid, sort } = prefs as Partial<typeof browseDefaults>;
        setBrowseFilters((prior) => ({
          ...prior,
          grid: grid === true,
          sort:
            sort === 'name' ||
            sort === 'recorded' ||
            sort === 'updated' ||
            sort === 'lastSeen' ||
            sort === 'location'
              ? sort
              : prior.sort,
        }));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [adapters, connection]);

  const backStack = useRef<Screen[]>([]);
  const [cache, setCache] = useState<InventoryCache>();
  const cacheRef = useRef<InventoryCache | undefined>(undefined);
  const [pending, setPending] = useState<PendingCapture[]>([]);
  const [completions, setCompletions] = useState<Record<string, CompletionState>>({});
  const [held, setHeld] = useState<PendingCapture[]>([]);
  const [stats, setStats] = useState<StorageStats>();
  const [recentBoxes, setRecentBoxes] = useState<string[]>([]);
  const recentRef = useRef<string[]>([]);
  const [savedFindTarget, setSavedFindTarget] = useState<PersistedFindTarget>();
  const [retargetingId, setRetargetingId] = useState<string>();
  const [retargetBoxId, setRetargetBoxId] = useState<string | null>(null);
  const [openingPendingMedia, setOpeningPendingMedia] = useState<string>();
  const [query, setQuery] = useState('');
  const [locationFilter, setLocationFilter] = useState<string | null>(null);
  const [roomFilter, setRoomFilter] = useState<string | null>(null);
  const [unplacedLocationFilter, setUnplacedLocationFilter] = useState<string | null>(null);
  const [found, setFound] = useState<SearchResponse>();
  const [cachedSearch, setCachedSearch] = useState(false);
  const [working, setWorking] = useState(false);
  const [online, setOnline] = useState(false);
  const [status, setStatus] = useState('');
  const running = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const canLeaveCapture = useRef<() => Promise<boolean>>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const pushScreen = (next: Screen) => {
    backStack.current = [...backStack.current.slice(-9), screen];
    setScreen(next);
  };
  const goBack = () => {
    const previous = backStack.current.pop();
    setScreen(previous ?? { kind: 'home' });
  };
  const goHome = () => {
    backStack.current = [];
    setScreen({ kind: 'home' });
  };
  const goTab = async (tab: TabKey) => {
    if (tab === 'home' && screen.kind === 'home') {
      // Re-tapping the active Search tab jumps straight into the search field.
      window.scrollTo?.({ top: 0 });
      searchRef.current?.querySelector('input')?.focus();
      return;
    }
    if (screen.kind === 'capture') {
      if (tab === 'capture' || !(await canLeaveCapture.current?.())) return;
    }
    const kind = tab === 'scan' ? 'identify' : tab;
    backStack.current = [];
    setScreen((current) => (current === screen ? { kind } : current));
  };
  const showTabs = screen.kind !== 'record' && screen.kind !== 'find' && screen.kind !== 'enroll';
  const visualScreen =
    screen.kind === 'visualSearch'
      ? screen
      : backStack.current.findLast(
          (entry): entry is Extract<Screen, { kind: 'visualSearch' }> =>
            entry.kind === 'visualSearch',
        );
  const openVisualRecord = (target: Target) =>
    pushScreen({ kind: 'record', target, backToVisual: true });
  const open = (target: Target, backToRooms = false) => {
    setScreen({ kind: 'record', target, backToRooms });
    if (
      target.kind !== 'thing' ||
      !cacheRef.current?.things.find((item) => item.id === target.id)?.isContainer
    )
      return;
    const next = [target.id, ...recentRef.current.filter((id) => id !== target.id)].slice(0, 6);
    recentRef.current = next;
    setRecentBoxes(next);
    void adapters.outbox.setValue(connection, 'recentBoxes', JSON.stringify(next)).catch(() => {});
  };

  const display = useCallback((next: InventoryCache | undefined) => {
    cacheRef.current = next;
    if (mounted.current) {
      setCache(next);
      setLocationFilter((selected) =>
        next?.locations.some((location) => location.id === selected) ? selected : null,
      );
      setRoomFilter((selected) =>
        next?.places.some((place) => place.id === selected) ? selected : null,
      );
      setUnplacedLocationFilter((selected) =>
        next?.locations.some((location) => location.id === selected) ? selected : null,
      );
    }
  }, []);

  const refreshPendingState = useCallback(async () => {
    const [queue, outboxStats, done, heldEntries] = await Promise.all([
      adapters.outbox.list(connection),
      getOutboxStats(connection, adapters),
      getCompletions(connection, adapters).catch(() => ({}) as Record<string, CompletionState>),
      listHeldCaptures(connection, adapters).catch(() => [] as PendingCapture[]),
    ]);
    if (!mounted.current) return;
    setPending(queue);
    setStats(outboxStats);
    setCompletions(done);
    setHeld(heldEntries);
  }, [adapters, connection]);

  const cacheDetail = useCallback(
    (detail: RecordDetail) => {
      const current = cacheRef.current;
      if (!current?.things.some((entry) => entry.id === detail.id)) return;
      const next = { ...current, details: { ...current.details, [detail.id]: detail } };
      display(next);
      void adapters.outbox.saveCache(connection, JSON.stringify(next)).catch(() => {});
    },
    [adapters, connection, display],
  );

  const failureText = useCallback(
    (reason: string, fields: ReturnType<typeof draftFields>): string => {
      switch (reason) {
        case 'target_trashed':
        case 'target_missing':
          return fields.boxId && !fields.review
            ? t`The destination box is missing or in Trash. Move this capture to another box or discard it.`
            : t`Could not sync this capture automatically. Retry or review it.`;
        case 'not_permitted':
        case 'location_revoked':
          return t`You no longer have write permission in that box’s location.`;
        case 'precondition_failed':
          return t`This record changed while you were editing. Close and reopen it to see the latest version.`;
        case 'unsupported_media_type':
          return t`An attached file format is not supported by SheepKeep.`;
        case 'payload_too_large':
          return t`An attached file exceeds the server upload limit.`;
        case 'checksum_mismatch':
          return t`An uploaded file did not match its saved checksum. Retry or review the capture.`;
        case 'attachments_unconfirmed':
          return fields.attachToThingId
            ? t`Could not sync this capture automatically. Retry or review it.`
            : t`The entry was created, but an attachment could not be verified yet. Retry to confirm.`;
        case 'compatibility_hold':
          return t`This SheepKeep server is older and cannot accept this capture yet. Your entry and originals stay on this iPhone — upgrade SheepKeep, then retry. Nothing was changed or removed.`;
        default:
          return t`Could not sync this capture automatically. Retry or review it.`;
      }
    },
    [t],
  );

  const refresh = useCallback(
    (includeFailed = false) => {
      if (running.current) return running.current;
      const work = async () => {
        setWorking(true);
        try {
          await refreshPendingState();
          await adapters.transport.request(connection, paths.me);
          setOnline(true);
          const count = await syncOutbox(connection, adapters, { includeFailed });
          await refreshPendingState();
          display(await loadInventory(connection, adapters));
          if (mounted.current) {
            setStatus(count ? t`Synced entries: ${count}` : '');
          }
        } catch (error) {
          if (!mounted.current) return;
          if (isAuthRefusal(error) || (error instanceof ApiError && error.status === 403)) {
            onSignOut('expired');
            return;
          }
          if (isRestoreEpochMismatch(error)) {
            onSignOut('restored');
            return;
          }
          setOnline(false);
          setStatus(
            error instanceof ApiError && error.status === 0
              ? t`Offline. Changes stay on this iPhone until SheepKeep is reachable.`
              : t`Could not sync. Pending captures are still on this iPhone.`,
          );
        } finally {
          if (mounted.current) setWorking(false);
        }
      };
      running.current = work().finally(() => {
        running.current = null;
      });
      return running.current;
    },
    [adapters, connection, display, onSignOut, refreshPendingState, t],
  );

  useEffect(() => {
    mounted.current = true;
    void readInventory(connection, adapters)
      .then((stored) => {
        if (stored && mounted.current) display(stored);
      })
      .catch(() => {});
    void adapters.outbox
      .getValue(connection, FIND_TARGET_KEY)
      .then((raw) => {
        if (raw && mounted.current) setSavedFindTarget(JSON.parse(raw) as PersistedFindTarget);
      })
      .catch(() => {});
    void adapters.outbox
      .getValue(connection, 'recentBoxes')
      .then((raw) => {
        if (!raw || !mounted.current || recentRef.current.length) return;
        const saved: unknown = JSON.parse(raw);
        if (Array.isArray(saved)) {
          const ids = saved
            .filter((value): value is string => typeof value === 'string')
            .slice(0, 6);
          recentRef.current = ids;
          setRecentBoxes(ids);
        }
      })
      .catch(() => {});
    void refresh();
    const now = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('online', now);
    document.addEventListener('visibilitychange', now);
    const appStateListener = adapters.lifecycle.onAppStateChange(({ active }) => {
      if (active) void refresh();
    });
    const interval = setInterval(now, 45_000);
    return () => {
      mounted.current = false;
      window.removeEventListener('online', now);
      document.removeEventListener('visibilitychange', now);
      void appStateListener.then((remove) => remove()).catch(() => {});
      clearInterval(interval);
    };
  }, [adapters, connection, display, refresh]);

  useEffect(() => {
    let current = true;
    const readLink = async () => {
      const linkUrl = await adapters.lifecycle.takeLink(connection);
      if (!linkUrl) return;
      const resolved = await resolveLabel(
        connection,
        cacheRef.current,
        linkUrl,
        'nfc',
        undefined,
        false,
        adapters,
      );
      if (!current) return;
      if (resolved.status === 'resolved') {
        const mayLeave = canLeaveCapture.current;
        if (mayLeave && !(await mayLeave())) return;
        if (current) setScreen({ kind: 'record', target: resolved.target });
      } else if (resolved.status === 'foreign')
        setStatus(t`This tag belongs to a different SheepKeep server.`);
      else setStatus(t`This label is unavailable in your SheepKeep.`);
    };
    const listen = adapters.lifecycle.onLink(() => {
      void readLink().catch(() => {});
    });
    void readLink().catch(() => {});
    return () => {
      current = false;
      void listen.then((remove) => remove()).catch(() => {});
    };
  }, [adapters, connection, t]);

  useEffect(() => {
    let current = true;
    setFound(undefined);
    setCachedSearch(false);
    if (!query.trim()) return;
    const timer = setTimeout(() => {
      void adapters.transport
        .request<SearchResponse>(
          connection,
          `${inventoryPaths.search}${qs({ q: query.trim(), limit: 50 })}`,
        )
        .then((result) => {
          if (current) setFound(result);
        })
        .catch((error: unknown) => {
          if (!current) return;
          if (isAuthRefusal(error)) {
            onSignOut('expired');
            return;
          }
          if (isRestoreEpochMismatch(error)) {
            onSignOut('restored');
            return;
          }
          if (error instanceof ApiError && error.status === 0) setCachedSearch(true);
          else setStatus(t`Could not search SheepKeep. Try again.`);
        });
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [adapters, connection, onSignOut, query, t]);

  const savedLocally = () => {
    void refreshPendingState().catch(() => {});
    void refresh();
  };

  function retryOne(id: string, changeDestination?: () => Promise<boolean>) {
    if (running.current) return running.current;
    const work = async () => {
      setWorking(true);
      setStatus('');
      try {
        if (changeDestination && !(await changeDestination())) return;
        const ok = await retryCapture(connection, id, adapters);
        await refreshPendingState();
        if (ok) {
          display(await loadInventory(connection, adapters));
          setStatus(t`Synced entries: ${1}`);
        } else {
          setStatus(t`Could not sync this capture. Review the error below.`);
        }
      } catch (error) {
        if (isAuthRefusal(error)) {
          onSignOut('expired');
          return;
        }
        if (isRestoreEpochMismatch(error)) {
          onSignOut('restored');
          return;
        }
        setStatus(t`Offline. Changes stay on this iPhone until SheepKeep is reachable.`);
      } finally {
        if (mounted.current) setWorking(false);
      }
    };
    running.current = work().finally(() => {
      running.current = null;
    });
    return running.current;
  }

  async function moveAndRetry(entry: PendingCapture) {
    const nextBox = cache?.things.find((item) => item.id === retargetBoxId && item.isContainer);
    if (!nextBox) return;
    await retryOne(entry.capture.id, async () => {
      try {
        await retargetCapture(
          connection,
          entry,
          { id: nextBox.id, locationId: nextBox.locationId },
          adapters,
        );
        setRetargetingId(undefined);
        setRetargetBoxId(null);
        await refreshPendingState();
        return true;
      } catch {
        setStatus(t`Could not update the destination box.`);
        return false;
      }
    });
  }

  async function confirmDiscardHeld(entry: PendingCapture) {
    const fields = draftFields(entry.capture);
    const ok = await confirm({
      title: t`Discard held ${isolate(fields.name)}?`,
      body: t`This held capture and its originals on this iPhone will be deleted. This cannot be undone.`,
      confirmLabel: t`Discard`,
      destructive: true,
    });
    if (!ok) return;
    await discardHeldCapture(connection, entry, adapters);
    await refreshPendingState();
  }

  async function exportHeld(entry: PendingCapture) {
    const data = heldCaptureExport(entry, cache);
    const metadata = JSON.stringify(data, null, 2);
    try {
      await adapters.media.exportHeld(connection, {
        heldContext: entry.capture.context ?? '',
        id: entry.capture.id,
        metadata,
      });
    } catch {
      setStatus(t`Could not open this held original.`);
    }
  }

  async function confirmDiscard(entry: PendingCapture) {
    const fields = draftFields(entry.capture);
    const ok = await confirm({
      title: t`Discard ${isolate(fields.name)}?`,
      body: t`This unsynced capture and its saved photos or documents on this iPhone will be deleted.`,
      confirmLabel: t`Discard`,
      destructive: true,
    });
    if (!ok) return;
    await discardCapture(connection, entry.capture.id, adapters);
    await refreshPendingState();
  }

  async function openPendingOriginal(id: string, file: string) {
    if (openingPendingMedia !== undefined) return;
    setOpeningPendingMedia(`${id}:${file}`);
    setStatus('');
    try {
      await adapters.media.openPending(connection, { id, file });
    } catch {
      if (mounted.current) setStatus(t`Could not open this pending original.`);
    } finally {
      if (mounted.current) setOpeningPendingMedia(undefined);
    }
  }

  async function handleSignOut() {
    if (pending.length > 0) {
      const ok = await confirm({
        title: t`Sign out with unsynced captures?`,
        body: t`You still have ${pending.length} capture(s) saved on this iPhone. They stay locked to this account and will not sync under another account or server.`,
        confirmLabel: t`Sign out`,
        cancelLabel: t`Stay signed in`,
        destructive: true,
      });
      if (!ok) return;
    }
    onSignOut();
  }

  const currentBoxes = cache?.things.filter((thing) => thing.isContainer) ?? [];
  const editableBoxes = currentBoxes.filter((box) =>
    cache?.locations.some((loc) => loc.id === box.locationId && loc.role !== 'viewer'),
  );
  const canWrite = cache?.locations.some((location) => location.role !== 'viewer') ?? false;
  // The box used most recently is the likeliest place for the next item.
  const suggestedBox = recentBoxes
    .map((id) => editableBoxes.find((box) => box.id === id))
    .find((box) => box !== undefined);
  const suggestedDestination: Destination | undefined = suggestedBox && {
    id: suggestedBox.id,
    locationId: suggestedBox.locationId,
    name: suggestedBox.name ?? t`Untitled`,
    kind: 'box',
  };
  const filterableRooms =
    cache?.places.filter(
      (place) => !place.isUnplaced && (!locationFilter || place.locationId === locationFilter),
    ) ?? [];
  const visibleBoxes = query.trim()
    ? currentBoxes
    : currentBoxes.filter((thing) => {
        if (locationFilter && thing.locationId !== locationFilter) return false;
        if (roomFilter && thing.placeId !== roomFilter) return false;
        return true;
      });
  const localResults = cache && cachedSearch ? localInventorySearch(cache, query) : [];
  const things = query.trim()
    ? (found?.things.items.map((thing) => ({
        ...thing,
        path: [
          cache?.locations.find((entry) => entry.id === thing.locationId)?.name,
          ...thing.path.map((part) => part.name),
        ]
          .filter(Boolean)
          .join(' › '),
      })) ??
      localResults.map((thing) => ({
        ...thing,
        path: cache ? inventoryPath(cache, thing).join(' › ') : '',
      })))
    : visibleBoxes.map((thing) => ({
        ...thing,
        path: cache ? inventoryPath(cache, thing).join(' › ') : '',
      }));

  // Unsynced and held captures: above the content everywhere except the add form, where they
  // sit below it so the description field stays the first thing on screen.
  const queuePanels = (
    <>
      {pending.length > 0 && (
        <section
          className="grid gap-3 rounded-lg border border-line bg-surface p-3"
          aria-label={t`Pending captures`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold">
              {stats
                ? t`Pending captures: ${pending.length} (${formatBytes(stats.pendingBytes)})`
                : t`Pending captures: ${pending.length}`}
            </p>
            <Button
              variant="secondary"
              size="small"
              isPending={working}
              onPress={() => void refresh(true)}
            >
              <Trans>Retry sync</Trans>
            </Button>
          </div>
          <ul className="grid gap-2">
            {pending.map((entry) => {
              const fields = draftFields(entry.capture);
              const boxName =
                cache?.things.find((item) => item.id === (fields.attachToThingId ?? fields.boxId))
                  ?.name ??
                cache?.places.find((item) => item.id === fields.placeId)?.name ??
                t`Destination`;
              return (
                <li
                  key={entry.capture.id}
                  className="grid gap-2 rounded-lg bg-sunken p-3 text-small"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">
                      <bdi>{fields.name}</bdi>
                    </span>
                    <span
                      className={
                        entry.failure
                          ? 'kept-badge kept-badge-danger'
                          : 'kept-badge kept-badge-warn'
                      }
                    >
                      {fields.review && !fields.review.accepted
                        ? t`Photo review`
                        : entry.failure
                          ? t`Failed`
                          : working
                            ? t`Syncing…`
                            : t`Saved on device`}
                    </span>
                  </div>
                  <p className="text-ink-2">
                    <bdi>{boxName}</bdi>
                    {entry.capture.files.length > 0 && (
                      <>
                        {sep()}
                        {t`Files: ${entry.capture.files.length}`}
                      </>
                    )}
                  </p>
                  {fields.review?.accepted && (
                    <p className="m-0 text-small">
                      <Trans>Synced</Trans> {fields.review.verified?.length ?? 0}/
                      {fields.review.entries.filter((row) => row.include).length +
                        (fields.binEvidenceId ? 1 : 0)}
                    </p>
                  )}
                  {entry.failure && (
                    <p className="text-danger">{failureText(entry.failure, fields)}</p>
                  )}
                  {entry.capture.files.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {entry.capture.files.map(({ file }) => {
                        const key = `${entry.capture.id}:${file.id}`;
                        return (
                          <Button
                            key={file.id}
                            size="small"
                            variant="secondary"
                            className="max-w-full [overflow-wrap:anywhere]"
                            isPending={openingPendingMedia === key}
                            isDisabled={
                              openingPendingMedia !== undefined && openingPendingMedia !== key
                            }
                            onPress={() => void openPendingOriginal(entry.capture.id, file.id)}
                          >
                            {t`Preview ${isolate(file.name)}`}
                          </Button>
                        );
                      })}
                    </div>
                  )}
                  {retargetingId === entry.capture.id ? (
                    <div className="grid gap-2">
                      <Select
                        label={t`Destination box`}
                        items={editableBoxes}
                        selectedKey={retargetBoxId}
                        onSelectionChange={(key) =>
                          setRetargetBoxId(key === null ? null : String(key))
                        }
                      >
                        {(box) => (
                          <SelectItem id={box.id} textValue={box.name ?? t`Untitled`}>
                            <bdi>{box.name ?? t`Untitled`}</bdi>
                          </SelectItem>
                        )}
                      </Select>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="small"
                          isDisabled={!retargetBoxId || working}
                          onPress={() => void moveAndRetry(entry)}
                        >
                          <Trans>Move and retry</Trans>
                        </Button>
                        <Button
                          size="small"
                          variant="ghost"
                          onPress={() => {
                            setRetargetingId(undefined);
                            setRetargetBoxId(null);
                          }}
                        >
                          <Trans>Cancel</Trans>
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="small"
                        variant="secondary"
                        isDisabled={working}
                        onPress={() => {
                          if (fields.review && !fields.review.accepted)
                            pushScreen({ kind: 'photoReview', id: entry.capture.id });
                          else void retryOne(entry.capture.id);
                        }}
                      >
                        {fields.review && !fields.review.accepted ? t`Review` : t`Retry`}
                      </Button>
                      {canRetarget(entry) && editableBoxes.length > 0 && (
                        <Button
                          size="small"
                          variant="secondary"
                          isDisabled={working}
                          onPress={() => {
                            setRetargetingId(entry.capture.id);
                            setRetargetBoxId(editableBoxes[0]?.id ?? null);
                          }}
                        >
                          <Trans>Change box</Trans>
                        </Button>
                      )}
                      <Button
                        size="small"
                        variant="ghost"
                        isDisabled={working}
                        onPress={() => void confirmDiscard(entry)}
                      >
                        <Trans>Discard</Trans>
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {held.length > 0 && (
        <section
          className="grid gap-3 rounded-lg border border-line bg-surface p-3"
          aria-label={t`Held captures from before a restore`}
        >
          <p className="font-semibold">{t`Held captures: ${held.length}`}</p>
          <p className="text-small text-ink-2">
            <Trans>
              These captures were saved before this SheepKeep server was restored, so automatic
              replay is paused to avoid creating duplicates. They stay on this iPhone until you
              export or discard them. Saved on device does not mean backed up.
            </Trans>
          </p>
          <ul className="grid gap-2">
            {held.map((entry) => {
              const fields = draftFields(entry.capture);
              const destinationId = fields.attachToThingId ?? fields.boxId ?? fields.placeId;
              const boxName =
                cache?.things.find((item) => item.id === destinationId)?.name ??
                cache?.places.find((item) => item.id === destinationId)?.name ??
                destinationId;
              return (
                <li
                  key={`${entry.capture.context ?? ''}:${entry.capture.id}`}
                  className="grid gap-2 rounded-lg bg-sunken p-3 text-small"
                >
                  <span className="font-semibold">
                    <bdi>{fields.name}</bdi>
                  </span>
                  <p className="text-ink-2">
                    <bdi>{boxName}</bdi>
                    {fields.note && (
                      <>
                        {sep()}
                        <bdi>{fields.note}</bdi>
                      </>
                    )}
                    {entry.capture.files.length > 0 && (
                      <>
                        {sep()}
                        {t`Files: ${entry.capture.files.length}`}
                      </>
                    )}
                  </p>
                  {entry.capture.files.map(({ file, sha256 }) => (
                    <p key={file.id} className="break-all text-ink-2">
                      <bdi>{file.name}</bdi> ({formatBytes(file.bytes)}){sep()}SHA-256{' '}
                      <bdi className="ltr">{sha256}</bdi>
                    </p>
                  ))}
                  <div className="flex flex-wrap gap-2">
                    {entry.capture.files.map(({ file }) => (
                      <Button
                        key={file.id}
                        size="small"
                        variant="secondary"
                        onPress={() =>
                          void adapters.media
                            .openHeld(connection, {
                              heldContext: entry.capture.context ?? '',
                              id: entry.capture.id,
                              file: file.id,
                            })
                            .catch(() => setStatus(t`Could not open this held original.`))
                        }
                      >
                        {t`Preview ${isolate(file.name)}`}
                      </Button>
                    ))}
                    <Button size="small" variant="secondary" onPress={() => void exportHeld(entry)}>
                      <Trans>Export details</Trans>
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      onPress={() => void confirmDiscardHeld(entry)}
                    >
                      <Trans>Discard</Trans>
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );

  return (
    <>
      <header className="kept-appbar">
        <div className="kept-appbar-brand">
          <AppMark size={28} />
          <h1 className="kept-appbar-name m-0">SheepKeep</h1>
        </div>
        <Button
          variant="ghost"
          size="small"
          className="kept-sync-pill"
          isDisabled={working}
          aria-label={online ? t`Refresh` : t`Offline`}
          onPress={() => void refresh()}
        >
          <span
            className={`kept-sync-dot ${online ? 'kept-sync-dot-ok' : 'kept-sync-dot-warn'}`}
            aria-hidden
          />
          {online ? (
            <RefreshCw size={14} className={working ? 'kept-spin' : undefined} aria-hidden />
          ) : (
            <>
              <WifiOff size={14} aria-hidden />
              <span>
                <Trans>Offline</Trans>
              </span>
            </>
          )}
        </Button>
      </header>
      {screen.kind === 'home' && (
        <div className="kept-search" ref={searchRef}>
          <TextField
            aria-label={t`Search inventory`}
            placeholder={t`Search inventory`}
            value={query}
            onChange={setQuery}
            inputProps={{
              type: 'search',
              maxLength: 200,
              enterKeyHint: 'search',
              autoCapitalize: 'none',
              autoCorrect: 'off',
            }}
          />
        </div>
      )}
      <div className="mb-4 grid gap-2">
        {status && (
          <p className="rounded-xl bg-sunken p-3 text-ink-2" role="status">
            {status}
          </p>
        )}
        {screen.kind === 'home' && savedFindTarget && (
          <section
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface p-3"
            aria-label={t`Saved Find target`}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="kept-row-lead" aria-hidden>
                <Radar size={18} />
              </span>
              <div className="grid min-w-0 gap-0.5">
                <span className="text-small text-ink-2">
                  <Trans>Resumable Find target</Trans>
                </span>
                <strong className="font-semibold">
                  <bdi>{savedFindTarget.name}</bdi>
                </strong>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="small"
                onPress={() => setScreen({ kind: 'find', box: savedFindTarget })}
              >
                <Radar size={15} aria-hidden />
                <Trans>Continue finding</Trans>
              </Button>
              <Button
                size="small"
                variant="ghost"
                onPress={() => {
                  void adapters.outbox.deleteValue(connection, FIND_TARGET_KEY).catch(() => {});
                  setSavedFindTarget(undefined);
                }}
              >
                <X size={15} aria-hidden />
                <Trans>Clear</Trans>
              </Button>
            </div>
          </section>
        )}
        {screen.kind !== 'capture' && queuePanels}
      </div>
      {screen.kind === 'home' && (
        <section className="grid gap-4">
          <PhotoSearchActions
            onOpen={(mode) =>
              pushScreen({
                kind: 'visualSearch',
                intent: {
                  mode,
                  text: query,
                  ...(locationFilter ? { locationId: locationFilter } : {}),
                },
              })
            }
          />
          {query.trim() ? (
            canWrite && (
              <Button
                variant="secondary"
                className="kept-phone-row kept-add-row"
                onPress={() => pushScreen({ kind: 'capture', name: query.trim() })}
              >
                <span className="kept-row-lead kept-row-lead-accent" aria-hidden>
                  <Plus size={18} />
                </span>
                <span className="kept-row-body">
                  <bdi className="font-semibold">{t`Add “${isolate(query.trim())}”`}</bdi>
                </span>
                <ChevronRight size={18} className="kept-row-chevron rtl:rotate-180" aria-hidden />
              </Button>
            )
          ) : (
            <div className="kept-quick">
              <Button
                variant="secondary"
                size="small"
                isDisabled={!cache}
                onPress={() => pushScreen({ kind: 'browse' })}
              >
                <Trans>Browse</Trans>
              </Button>
              <Button
                variant="secondary"
                size="small"
                className="kept-quick-button"
                isDisabled={!cache}
                onPress={() => pushScreen({ kind: 'rooms' })}
              >
                <MapPin size={16} aria-hidden />
                <Trans>Rooms</Trans>
              </Button>
              <Button
                variant="secondary"
                size="small"
                className="kept-quick-button"
                isDisabled={!online || !canWrite}
                onPress={() => pushScreen({ kind: 'new' })}
              >
                <Package size={16} aria-hidden />
                <Trans>Create box</Trans>
              </Button>
            </div>
          )}
          {!query.trim() && ((cache?.locations.length ?? 0) > 1 || filterableRooms.length > 1) && (
            <div className="kept-filters">
              {(cache?.locations.length ?? 0) > 1 && (
                <Select
                  label={t`Location`}
                  items={[
                    { id: 'all', name: t`All` },
                    ...(cache?.locations ?? []).map((location) => ({
                      id: location.id,
                      name: location.name,
                    })),
                  ]}
                  selectedKey={locationFilter ?? 'all'}
                  onSelectionChange={(key) => {
                    setLocationFilter(key === null || key === 'all' ? null : String(key));
                    setRoomFilter(null);
                  }}
                >
                  {(item) => (
                    <SelectItem id={item.id} textValue={item.name}>
                      <bdi>{item.name}</bdi>
                    </SelectItem>
                  )}
                </Select>
              )}
              {filterableRooms.length > 1 && (
                <Select
                  label={t`Room`}
                  items={[
                    { id: 'all', name: t`All` },
                    ...filterableRooms.map((place) => ({
                      id: place.id,
                      name: place.name,
                    })),
                  ]}
                  selectedKey={roomFilter ?? 'all'}
                  onSelectionChange={(key) =>
                    setRoomFilter(key === null || key === 'all' ? null : String(key))
                  }
                >
                  {(item) => (
                    <SelectItem id={item.id} textValue={item.name}>
                      <bdi>{item.name}</bdi>
                    </SelectItem>
                  )}
                </Select>
              )}
            </div>
          )}
          {cache && !online && (
            <p className="text-small text-ink-2">
              {t`Cached inventory from ${new Date(cache.asOf).toLocaleString()}`}
            </p>
          )}
          {cache?.truncated && (
            <p className="text-small text-ink-2">
              <Trans>Only part of your inventory is cached.</Trans>
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <h2 className="kept-card-title text-title">
              <Package size={18} aria-hidden />
              <span>{query.trim() ? t`Search results` : t`Boxes`}</span>
            </h2>
            {!query.trim() && things.length > 0 && (
              <span className="kept-badge kept-badge-neutral">{things.length}</span>
            )}
          </div>
          <ThingList items={things} onOpen={open} origin={online ? connection.origin : undefined} />
          {(
            found?.places ??
            (query.trim() && cachedSearch
              ? (cache?.places.filter(
                  (place) =>
                    !place.isUnplaced &&
                    place.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
                ) ?? [])
              : [])
          ).map((place) => (
            <Button
              key={place.id}
              variant="secondary"
              className="kept-phone-row"
              onPress={() => open({ id: place.id, locationId: place.locationId, kind: 'place' })}
            >
              <span className="kept-row-lead" aria-hidden>
                <MapPin size={18} />
              </span>
              <span className="kept-row-body">
                <bdi className="font-semibold">{place.name}</bdi>
              </span>
              <ChevronRight size={18} className="kept-row-chevron rtl:rotate-180" aria-hidden />
            </Button>
          ))}
          {found?.documents.items
            .filter((entry) => entry.subject.kind === 'thing' || entry.subject.kind === 'place')
            .map((doc) => (
              <Button
                key={doc.attachmentId}
                variant="secondary"
                className="kept-phone-row"
                onPress={() =>
                  open({
                    id: doc.subject.id,
                    locationId: doc.locationId,
                    kind: doc.subject.kind === 'place' ? 'place' : 'thing',
                  })
                }
              >
                <span className="kept-row-lead" aria-hidden>
                  <FileText size={18} />
                </span>
                <span className="kept-row-body">
                  <bdi className="font-semibold">{doc.subject.name ?? t`Document`}</bdi>
                  {doc.snippet && (
                    <span className="text-small font-normal text-ink-2">
                      <bdi>{doc.snippet}</bdi>
                    </span>
                  )}
                </span>
                <ChevronRight size={18} className="kept-row-chevron rtl:rotate-180" aria-hidden />
              </Button>
            ))}
          {!query.trim() && cache && things.length === 0 && (
            <p className="text-ink-2">
              <Trans>No boxes yet.</Trans>
            </p>
          )}
          {query.trim() &&
            (cachedSearch || found) &&
            things.length === 0 &&
            !found?.places.length &&
            !found?.documents.items.length && (
              <p className="text-ink-2">
                <Trans>No matching inventory.</Trans>
              </p>
            )}
        </section>
      )}
      {visualScreen && (
        <VisualSearchScreen
          connection={connection}
          visible={screen.kind === 'visualSearch'}
          online={online}
          intent={visualScreen.intent}
          cache={cache}
          onOpen={openVisualRecord}
          onBack={goBack}
          onAuthError={onSignOut}
        />
      )}
      {screen.kind === 'record' && (
        <RecordScreen
          key={screen.target.id}
          connection={connection}
          cache={cache}
          target={screen.target}
          pending={pending}
          syncing={working}
          online={online}
          onClose={
            screen.backToBrowse || screen.backToVisual
              ? goBack
              : screen.backToRooms
                ? () => setScreen({ kind: 'rooms' })
                : goHome
          }
          onOpen={screen.backToVisual ? openVisualRecord : open}
          onCache={cacheDetail}
          onCreateBox={() => setScreen({ kind: 'new', place: screen.target })}
          onCapture={(destination, location) =>
            setScreen({ kind: 'capture', destination, location, back: screen.target })
          }
          onInventoryChanged={() => {
            void refresh();
          }}
          onLabel={(kind, box) =>
            screen.backToVisual ? pushScreen({ kind, box }) : setScreen({ kind, box })
          }
          onAuthError={onSignOut}
        />
      )}
      {screen.kind === 'new' && cache && (
        <NewBoxForm
          connection={connection}
          cache={cache}
          place={cache.places.find((entry) => entry.id === screen.place?.id)}
          onClose={() => (screen.place ? open(screen.place, true) : goHome())}
          onCreated={(id, locationId) => {
            open({ id, locationId, kind: 'thing' });
            void refresh();
          }}
        />
      )}
      {screen.kind === 'rooms' && cache && (
        <Rooms
          connection={connection}
          cache={cache}
          online={online}
          recent={recentBoxes}
          onClose={goBack}
          onOpen={(target) => open(target, true)}
          onCreated={(target) => {
            setScreen({ kind: 'record', target, backToRooms: true });
            void refresh();
          }}
          onAuthError={onSignOut}
        />
      )}
      {screen.kind === 'capture' && (
        <CaptureForm
          connection={connection}
          box={screen.destination}
          cache={cache}
          location={screen.location}
          initialName={screen.name}
          suggested={suggestedDestination}
          pending={pending}
          completions={completions}
          syncing={working}
          online={online}
          leaveRef={canLeaveCapture}
          onClose={() => (screen.back ? open(screen.back) : goBack())}
          onSave={savedLocally}
          onReview={(id) => pushScreen({ kind: 'photoReview', id })}
        />
      )}
      {screen.kind === 'capture' && <div className="mt-4 grid gap-2">{queuePanels}</div>}
      {screen.kind === 'photoReview' && pending.find((item) => item.capture.id === screen.id) && (
        <PhotoReview
          key={screen.id}
          entry={pending.find((item) => item.capture.id === screen.id) as PendingCapture}
          cache={cache}
          connection={connection}
          online={online}
          onBack={goBack}
          onSaved={() => {
            goBack();
            savedLocally();
          }}
        />
      )}
      {screen.kind === 'identify' && (
        <LabelPanel
          connection={connection}
          cache={cache}
          action="identify"
          onOpen={(target) => {
            open(target);
            if (online) void refresh();
          }}
          onClose={goBack}
          onAuthError={onSignOut}
        />
      )}
      {(screen.kind === 'find' || screen.kind === 'enroll') && (
        <LabelPanel
          connection={connection}
          cache={cache}
          action={screen.kind}
          box={screen.box}
          onOpen={open}
          canEnroll={
            cache?.locations.some(
              (location) => location.id === screen.box.locationId && location.role !== 'viewer',
            ) === true
          }
          onClearFindTarget={() => setSavedFindTarget(undefined)}
          onClose={() => {
            const back = backStack.current.at(-1);
            if (back?.kind === 'record' && back.backToVisual) goBack();
            else open({ id: screen.box.id, kind: 'thing', locationId: screen.box.locationId });
          }}
          onAuthError={onSignOut}
        />
      )}
      {screen.kind === 'labelSheets' && cache && (
        <LabelSheets
          connection={connection}
          cache={cache}
          onClose={goBack}
          onAuthError={onSignOut}
        />
      )}
      {screen.kind === 'unplaced' && cache && (
        <section className="grid gap-4">
          <ScreenHeader
            title={<Trans>Unplaced</Trans>}
            onBack={goBack}
            icon={<Inbox size={18} aria-hidden />}
          />
          {cache.locations.length > 1 && (
            <Select
              label={t`Location`}
              items={[
                { id: 'all', name: t`All locations` },
                ...cache.locations.map((loc) => ({ id: loc.id, name: loc.name })),
              ]}
              selectedKey={unplacedLocationFilter ?? 'all'}
              onSelectionChange={(key) =>
                setUnplacedLocationFilter(key === null || key === 'all' ? null : String(key))
              }
            >
              {(item) => (
                <SelectItem id={item.id} textValue={item.name}>
                  <bdi>{item.name}</bdi>
                </SelectItem>
              )}
            </Select>
          )}
          <ThingList
            onOpen={open}
            origin={online ? connection.origin : undefined}
            items={cache.things
              .filter(
                (thing) =>
                  (!unplacedLocationFilter || thing.locationId === unplacedLocationFilter) &&
                  thing.placeId ===
                    cache.locations.find((location) => location.id === thing.locationId)
                      ?.unplacedPlaceId,
              )
              .map((thing) => ({ ...thing, path: inventoryPath(cache, thing).join(' › ') }))}
          />
        </section>
      )}
      {screen.kind === 'trash' && (
        <Trash
          connection={connection}
          cache={cache}
          onClose={goBack}
          onAuthError={onSignOut}
          onRestored={(target) => {
            open(target);
            void refresh();
          }}
        />
      )}
      {screen.kind === 'batches' && (
        <Batches connection={connection} onClose={goBack} onOpen={open} onAuthError={onSignOut} />
      )}
      {screen.kind === 'browse' && cache && (
        <Browse
          connection={connection}
          online={online}
          cache={cache}
          filters={browseFilters}
          onFilters={(next) => {
            if (next.grid !== browseFilters.grid || next.sort !== browseFilters.sort) {
              void adapters.outbox
                .setValue(
                  connection,
                  'browseLayout',
                  JSON.stringify({ grid: next.grid, sort: next.sort }),
                )
                .catch(() => {});
            }
            setBrowseFilters(next);
          }}
          onBack={goBack}
          onOpen={(target) => pushScreen({ kind: 'record', target, backToBrowse: true })}
          onPhotoSearch={(mode) =>
            pushScreen({ kind: 'visualSearch', intent: { mode, text: browseFilters.q } })
          }
          onRooms={() => pushScreen({ kind: 'rooms' })}
          onInventoryChanged={() => {
            void refresh();
          }}
          onAuthError={onSignOut}
        />
      )}
      {screen.kind === 'assistant' && (
        <AssistantScreen
          key={connection.id}
          connection={connection}
          cache={cache}
          online={online}
          onBack={goBack}
          onOpen={(target) => open(target)}
          onAuthError={onSignOut}
          onInventoryChanged={() => {
            void refresh();
          }}
        />
      )}
      {screen.kind === 'more' && (
        <section className="grid gap-4">
          <h2 className="kept-card-title text-title">
            <Settings size={18} aria-hidden />
            <Trans>More</Trans>
          </h2>
          <section className="kept-card" aria-label={t`Settings`}>
            <h3 className="kept-card-title text-small text-ink-2">
              <Palette size={15} aria-hidden />
              <Trans>Settings</Trans>
            </h3>
            <ThemeSwitch />
            <PaletteSwitch />
          </section>
          <CaptureAISettings connection={connection} />
          <div className="kept-tiles">
            <ActionTile
              label={t`Assistant`}
              Icon={MessageSquare}
              tone="violet"
              onPress={() => pushScreen({ kind: 'assistant' })}
            />
            <ActionTile
              label={t`Print label sheets`}
              Icon={Tags}
              tone="amber"
              isDisabled={!cache || !online}
              onPress={() => pushScreen({ kind: 'labelSheets' })}
            />
            <ActionTile
              label={t`Recent capture batches`}
              Icon={History}
              tone="violet"
              isDisabled={!online}
              onPress={() => pushScreen({ kind: 'batches' })}
            />
            <ActionTile
              label={t`Unplaced`}
              Icon={Inbox}
              tone="neutral"
              isDisabled={!cache}
              onPress={() => pushScreen({ kind: 'unplaced' })}
            />
            <ActionTile
              label={t`Trash`}
              Icon={Trash2}
              tone="danger"
              isDisabled={!online}
              onPress={() => pushScreen({ kind: 'trash' })}
            />
          </div>
          <section className="kept-card" aria-label={t`Account`}>
            <h3 className="kept-card-title text-small text-ink-2">
              <Trans>Account</Trans>
            </h3>
            <p className="break-all text-small text-ink-2">
              <bdi>{connection.origin}</bdi>
            </p>
            <Button
              variant="secondary"
              size="small"
              className="justify-self-start"
              onPress={() => void handleSignOut()}
            >
              <LogOut size={16} aria-hidden />
              <Trans>Sign out</Trans>
            </Button>
          </section>
          <footer className="pt-2">
            <ProjectNotice revision={import.meta.env.VITE_SHEEPKEEP_REVISION} />
          </footer>
        </section>
      )}
      {showTabs && <TabBar tab={tabFor(screen)} pendingCount={pending.length} onTab={goTab} />}
    </>
  );
}

export function KeptPhone() {
  const { t } = useLingui();
  const adapters = usePlatform();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [address, setAddress] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    void adapters.credentials
      .connection()
      .then((saved) => {
        if (saved) {
          setConnection(saved);
          setAddress(saved.origin);
        }
      })
      .catch(() => setStatus(t`SheepKeep could not read the saved session.`))
      .finally(() => setBusy(false));
  }, [adapters, t]);

  async function signIn() {
    setBusy(true);
    setStatus('');
    try {
      const next = await adapters.credentials.connect(address);
      setConnection(next);
      setAddress(next.origin);
    } catch (error) {
      switch (nativeErrorCode(error)) {
        case 'sign_in_cancelled':
          setStatus(t`Sign-in cancelled.`);
          break;
        case 'apple_sign_in_unsupported':
          setStatus(t`Update this SheepKeep server to sign in with Apple.`);
          break;
        default:
          setStatus(t`Could not connect to SheepKeep. Check the server address and try again.`);
      }
    } finally {
      setBusy(false);
    }
  }

  const signOut = useCallback(
    (reason?: 'expired' | 'restored') => {
      setBusy(true);
      setStatus('');
      setConnection(null);
      void adapters.credentials
        .disconnect()
        .then(({ revoked }) => {
          if (reason === 'restored') {
            setStatus(
              t`This SheepKeep was restored or replaced. Pending captures from the previous server state are held for review.`,
            );
          } else if (reason === 'expired') {
            setStatus(t`Your session ended. Sign in again to see your pending captures.`);
          } else if (!revoked) {
            setStatus(
              t`Signed out on this iPhone. SheepKeep could not revoke the server session while offline.`,
            );
          }
        })
        .catch(() => setStatus(t`Could not sign out.`))
        .finally(() => setBusy(false));
    },
    [adapters, t],
  );

  return (
    <main className="kept-phone">
      {connection ? (
        <Inventory key={connection.id} connection={connection} onSignOut={signOut} />
      ) : (
        <>
          <header className="mb-6 flex flex-col items-center gap-2 pt-6 text-center">
            <h1 className="m-0">
              <BrandLockup width={180} />
            </h1>
          </header>
          <section className="kept-card">
            <h2 className="text-title font-semibold">
              <Trans>Connect to your inventory</Trans>
            </h2>
            <form
              className="grid gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (address.trim() && !busy) void signIn();
              }}
            >
              <TextField
                label={t`SheepKeep server address`}
                placeholder="https://kept.example.com"
                value={address}
                onChange={setAddress}
                isDisabled={busy}
                inputProps={{
                  dir: 'ltr',
                  autoCapitalize: 'none',
                  autoCorrect: 'off',
                  inputMode: 'url',
                }}
              />
              <Button type="submit" isPending={busy} isDisabled={!address.trim()}>
                <Trans>Sign in with Apple</Trans>
              </Button>
            </form>
          </section>
          <footer className="mt-6 border-t border-line pt-4">
            <ProjectNotice revision={import.meta.env.VITE_SHEEPKEEP_REVISION} />
          </footer>
        </>
      )}
      {status && (
        <p className="mt-4 rounded-xl bg-sunken p-3 text-ink-2" role="status">
          {status}
        </p>
      )}
    </main>
  );
}

async function start() {
  await startLocale();
  watchSystemTheme();
  applyPalette();
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing SheepKeep app root');
  createRoot(root).render(
    <I18nProvider i18n={i18n}>
      <NativePlatformProvider>
        <ConfirmProvider>
          <KeptPhone />
        </ConfirmProvider>
      </NativePlatformProvider>
    </I18nProvider>,
  );
}

if (typeof document !== 'undefined' && document.getElementById('root')) {
  void start();
}
