import { I18nProvider } from '@lingui/react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  History,
  Home,
  Inbox,
  MapPin,
  Monitor,
  Moon,
  Package,
  Plus,
  QrCode,
  Settings,
  Sun,
  Tags,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { capturePaths } from '@/api/capture/paths';
import type { CaptureBatch, InboxPage } from '@/api/capture/types';
import { ApiError } from '@/api/client';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { Page, SearchResponse } from '@/api/inventory/types';
import { paths } from '@/api/paths';
import { BrandLockup } from '@/components/brand';
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
import { BackButton } from './back-button';
import {
  type CompletionState,
  type Connection,
  nativeErrorCode,
  type StorageStats,
} from './bridge';
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
import { RecordScreen } from './record';
import { Rooms } from './rooms';
import { Trash } from './trash';
import './native.css';

type Screen =
  | { kind: 'home' }
  | { kind: 'record'; target: Target; backToRooms?: boolean }
  | { kind: 'new'; place?: Target }
  | { kind: 'rooms' }
  | { kind: 'unplaced' }
  | { kind: 'labelSheets' }
  | { kind: 'trash' }
  | { kind: 'capture'; destination?: Destination; location?: string; back?: Target }
  | { kind: 'identify' }
  | { kind: 'find' | 'enroll'; box: LabelBox }
  | { kind: 'batches' }
  | { kind: 'more' };

type TabKey = 'home' | 'capture' | 'scan' | 'more';

function tabFor(screen: Screen): TabKey {
  switch (screen.kind) {
    case 'capture':
      return 'capture';
    case 'identify':
      return 'scan';
    case 'more':
    case 'trash':
    case 'unplaced':
    case 'labelSheets':
    case 'batches':
      return 'more';
    default:
      return 'home';
  }
}

/** Sticky bottom tab bar: the four main phone destinations, icon-first. */
function TabBar({ tab, onTab }: { tab: TabKey; onTab: (tab: TabKey) => void }) {
  const { t } = useLingui();
  const tabs = [
    { key: 'home', label: t`Home`, Icon: Home },
    { key: 'capture', label: t`Capture`, Icon: Plus },
    { key: 'scan', label: t`Scan`, Icon: QrCode },
    { key: 'more', label: t`More`, Icon: Settings },
  ] as const;
  return (
    <nav className="kept-tabbar">
      {tabs.map(({ key, label, Icon }) => (
        <Button
          key={key}
          variant="ghost"
          className="kept-tabbar-button"
          aria-current={tab === key ? 'page' : undefined}
          onPress={() => onTab(key)}
        >
          <Icon size={22} aria-hidden />
          <span className="kept-tabbar-label">{label}</span>
        </Button>
      ))}
    </nav>
  );
}

/** Icon tile for the compartmentalized home and More grids. */
function ActionTile({
  label,
  onPress,
  isDisabled,
  Icon,
}: {
  label: string;
  onPress: () => void;
  isDisabled?: boolean;
  Icon: typeof Home;
}) {
  return (
    <Button variant="secondary" className="kept-tile" isDisabled={isDisabled} onPress={onPress}>
      <Icon size={24} aria-hidden />
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
              {image && (
                <img
                  alt=""
                  src={image}
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  className="kept-thumb"
                />
              )}
              <bdi className="text-body">{thing.name ?? t`Untitled`}</bdi>
              {thing.path && <bdi className="font-normal text-small text-ink-2">{thing.path}</bdi>}
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
      <BackButton onPress={onClose} />
      <h2 className="text-title font-semibold">
        <Trans>Recent capture batches</Trans>
      </h2>
      {batches?.length === 0 && (
        <p>
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
              <bdi>{path}</bdi>
              <span>{t`Saved: ${batch.count}`}</span>
              <span>{new Date(batch.capturedAt).toLocaleString()}</span>
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
  const [found, setFound] = useState<SearchResponse>();
  const [cachedSearch, setCachedSearch] = useState(false);
  const [working, setWorking] = useState(false);
  const [online, setOnline] = useState(false);
  const [status, setStatus] = useState('');
  const running = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const goHome = () => setScreen({ kind: 'home' });
  const goTab = (tab: TabKey) => {
    switch (tab) {
      case 'capture':
        setScreen({ kind: 'capture' });
        break;
      case 'scan':
        setScreen({ kind: 'identify' });
        break;
      case 'more':
        setScreen({ kind: 'more' });
        break;
      default:
        setScreen({ kind: 'home' });
        break;
    }
  };
  const showTabs = screen.kind !== 'record' && screen.kind !== 'find' && screen.kind !== 'enroll';
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
    if (mounted.current) setCache(next);
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
          return fields.boxId
            ? t`The destination box is missing or in Trash. Move this capture to another box or discard it.`
            : t`Could not sync this capture automatically. Retry or review it.`;
        case 'not_permitted':
        case 'location_revoked':
          return t`You no longer have write permission in that box’s location.`;
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
      if (resolved.status === 'resolved') setScreen({ kind: 'record', target: resolved.target });
      else if (resolved.status === 'foreign')
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
  const visibleBoxes =
    locationFilter && !query.trim()
      ? currentBoxes.filter((thing) => thing.locationId === locationFilter)
      : currentBoxes;
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

  return (
    <>
      <div className="mb-5 grid gap-2">
        {status && (
          <p className="rounded-lg bg-sunken p-3 text-ink-2" role="status">
            {status}
          </p>
        )}
        {screen.kind === 'home' && savedFindTarget && (
          <section
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface p-3"
            aria-label={t`Saved Find target`}
          >
            <div className="grid gap-0.5">
              <span className="text-small text-ink-2">
                <Trans>Resumable Find target</Trans>
              </span>
              <strong className="font-semibold">
                <bdi>{savedFindTarget.name}</bdi>
              </strong>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="small"
                onPress={() => setScreen({ kind: 'find', box: savedFindTarget })}
              >
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
                <Trans>Clear</Trans>
              </Button>
            </div>
          </section>
        )}
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
                        {entry.failure ? t`Failed` : working ? t`Syncing…` : t`Saved on device`}
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
                          onPress={() => void retryOne(entry.capture.id)}
                        >
                          <Trans>Retry</Trans>
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
                      <Button
                        size="small"
                        variant="secondary"
                        onPress={() => void exportHeld(entry)}
                      >
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
      </div>
      {screen.kind === 'home' && (
        <section className="grid gap-4">
          <div className="kept-tiles">
            <ActionTile
              label={t`Capture inventory`}
              Icon={Plus}
              isDisabled={!cache?.locations.some((location) => location.role !== 'viewer')}
              onPress={() => setScreen({ kind: 'capture' })}
            />
            <ActionTile
              label={t`Rooms`}
              Icon={MapPin}
              isDisabled={!cache}
              onPress={() => setScreen({ kind: 'rooms' })}
            />
            <ActionTile
              label={t`Create box`}
              Icon={Package}
              isDisabled={
                !online || !cache?.locations.some((location) => location.role !== 'viewer')
              }
              onPress={() => setScreen({ kind: 'new' })}
            />
            <ActionTile
              label={t`Scan QR or NFC`}
              Icon={QrCode}
              onPress={() => setScreen({ kind: 'identify' })}
            />
          </div>
          <TextField
            label={t`Search inventory`}
            value={query}
            onChange={setQuery}
            inputProps={{ type: 'search', maxLength: 200 }}
          />
          {(cache?.locations.length ?? 0) > 1 && !query.trim() && (
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
              onSelectionChange={(key) =>
                setLocationFilter(key === null || key === 'all' ? null : String(key))
              }
            >
              {(item) => (
                <SelectItem id={item.id} textValue={item.name}>
                  <bdi>{item.name}</bdi>
                </SelectItem>
              )}
            </Select>
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
          <h2 className="text-title font-semibold">
            {query.trim() ? t`Search results` : t`Boxes`}
          </h2>
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
              <bdi>{place.name}</bdi>
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
                <bdi>{doc.subject.name ?? t`Document`}</bdi>
                {doc.snippet && (
                  <span className="text-small font-normal">
                    <bdi>{doc.snippet}</bdi>
                  </span>
                )}
              </Button>
            ))}
          {!query.trim() && cache && things.length === 0 && (
            <p>
              <Trans>No boxes yet.</Trans>
            </p>
          )}
          {query.trim() &&
            (cachedSearch || found) &&
            things.length === 0 &&
            !found?.places.length &&
            !found?.documents.items.length && (
              <p>
                <Trans>No matching inventory.</Trans>
              </p>
            )}
          <Button
            variant="ghost"
            className="justify-self-start"
            onPress={() => void handleSignOut()}
          >
            <Trans>Sign out</Trans>
          </Button>
        </section>
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
          onClose={screen.backToRooms ? () => setScreen({ kind: 'rooms' }) : goHome}
          onOpen={open}
          onCache={cacheDetail}
          onCreateBox={() => setScreen({ kind: 'new', place: screen.target })}
          onCapture={(destination, location) =>
            setScreen({ kind: 'capture', destination, location, back: screen.target })
          }
          onInventoryChanged={() => {
            void refresh();
          }}
          onLabel={(kind, box) => setScreen({ kind, box })}
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
          onClose={goHome}
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
          pending={pending}
          completions={completions}
          syncing={working}
          onClose={() => (screen.back ? open(screen.back) : goHome())}
          onSave={savedLocally}
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
          onClose={goHome}
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
          onClose={() =>
            open({ id: screen.box.id, kind: 'thing', locationId: screen.box.locationId })
          }
          onAuthError={onSignOut}
        />
      )}
      {screen.kind === 'labelSheets' && cache && (
        <LabelSheets
          connection={connection}
          cache={cache}
          onClose={goHome}
          onAuthError={onSignOut}
        />
      )}
      {screen.kind === 'unplaced' && cache && (
        <section className="grid gap-3">
          <BackButton onPress={goHome} />
          <h2 className="text-title font-semibold">
            <Trans>Unplaced</Trans>
          </h2>
          <ThingList
            onOpen={open}
            items={cache.things
              .filter(
                (thing) =>
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
          onClose={goHome}
          onAuthError={onSignOut}
          onRestored={(target) => {
            open(target);
            void refresh();
          }}
        />
      )}
      {screen.kind === 'batches' && (
        <Batches connection={connection} onClose={goHome} onOpen={open} onAuthError={onSignOut} />
      )}
      {screen.kind === 'more' && (
        <section className="grid gap-5">
          <h2 className="text-title font-semibold">
            <Trans>More</Trans>
          </h2>
          <section className="grid gap-2" aria-label={t`Settings`}>
            <h3 className="text-small font-semibold text-ink-2">
              <Trans>Settings</Trans>
            </h3>
            <ThemeSwitch />
          </section>
          <div className="kept-tiles">
            <ActionTile
              label={t`Scan QR or NFC`}
              Icon={QrCode}
              onPress={() => setScreen({ kind: 'identify' })}
            />
            <ActionTile
              label={t`Print label sheets`}
              Icon={Tags}
              isDisabled={!cache || !online}
              onPress={() => setScreen({ kind: 'labelSheets' })}
            />
            <ActionTile
              label={t`Recent capture batches`}
              Icon={History}
              isDisabled={!online}
              onPress={() => setScreen({ kind: 'batches' })}
            />
            <ActionTile
              label={t`Trash`}
              Icon={Trash2}
              isDisabled={!online}
              onPress={() => setScreen({ kind: 'trash' })}
            />
            <ActionTile
              label={t`Unplaced`}
              Icon={Inbox}
              isDisabled={!cache}
              onPress={() => setScreen({ kind: 'unplaced' })}
            />
            <ActionTile
              label={t`Rooms`}
              Icon={MapPin}
              isDisabled={!cache}
              onPress={() => setScreen({ kind: 'rooms' })}
            />
          </div>
          <Button
            variant="ghost"
            className="justify-self-start"
            onPress={() => void handleSignOut()}
          >
            <Trans>Sign out</Trans>
          </Button>
        </section>
      )}
      {showTabs && <TabBar tab={tabFor(screen)} onTab={goTab} />}
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
      <header className="mb-5 border-b border-line pb-4">
        <h1 className="m-0">
          <BrandLockup width={168} />
        </h1>
        {connection && (
          <p className="break-all text-small text-ink-2">
            <bdi>{connection.origin}</bdi>
          </p>
        )}
      </header>
      {connection ? (
        <Inventory key={connection.id} connection={connection} onSignOut={signOut} />
      ) : (
        <>
          <h2 className="mb-4 text-title font-semibold">
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
        </>
      )}
      <footer className="mt-6 border-t border-line pt-4">
        <ProjectNotice />
      </footer>
      {status && (
        <p className="mt-4 text-ink-2" role="status">
          {status}
        </p>
      )}
    </main>
  );
}

async function start() {
  await startLocale();
  watchSystemTheme();
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
