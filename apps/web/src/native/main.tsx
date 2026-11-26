import { normalize } from '@kept/shared';
import { I18nProvider } from '@lingui/react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Camera,
  ChevronRight,
  Clock,
  CornerDownLeft,
  Ellipsis,
  FileText,
  History,
  Home,
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
  Search,
  Settings,
  Sun,
  Tags,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { capturePaths } from '@/api/capture/paths';
import type { CaptureBatch, InboxPage } from '@/api/capture/types';
import { ApiError } from '@/api/client';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { Page, SearchResponse, ThingRow } from '@/api/inventory/types';
import { paths } from '@/api/paths';
import type { Me } from '@/api/types';
import { AppMark, BrandLockup } from '@/components/brand';
import { PhotoImage } from '@/components/photo-image';
import { PlaceEvidenceDetails } from '@/components/places/place-evidence';
import { ProjectNotice } from '@/components/project-notice';
import { Button } from '@/components/ui/button';
import { ConfirmProvider, useConfirm } from '@/components/ui/confirm';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { i18n, startLocale } from '@/i18n/i18n';
import { isolate } from '@/lib/bidi';
import { sep, useBytes } from '@/lib/format';
import { setThemePref, type ThemePref, usePrefs, watchSystemTheme } from '@/lib/prefs';
import { HistoryScreen, type LocalLogEntry, LogsScreen } from './activity';
import { NativePlatformProvider, usePlatform } from './adapters';
import { AssistantScreen } from './assistant';
import { ScreenHeader } from './back-button';
import { BoxPhotos } from './box-photos';
import {
  type CaptureAIProvider,
  type CompletionState,
  type Connection,
  nativeErrorCode,
  type StorageStats,
  type TagReading,
} from './bridge';
import { Browse, browseDefaults } from './browse';
import { CaptureAISettings } from './capture-ai';
import { CaptureForm, NewBoxForm } from './capture-form';
import { type Destination, defaultDestination, writableLocations } from './destination';
import { HomeDashboard } from './home';
import {
  type InventoryCache,
  inventoryPath,
  loadInventory,
  localInventorySearch,
  previewUrl,
  type RecordDetail,
  readInventory,
  shownInventory,
  withoutLocation,
  withPendingPlaces,
} from './inventory';
import { FIND_TARGET_KEY, type LabelBox, LabelPanel } from './label-panel';
import { LabelSheets } from './label-sheets';
import { loadLabelAddress, resolveLabel, type Target } from './labels';
import { LocationSettings } from './location-settings';
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
import { Places } from './rooms';
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
      backToAssistant?: boolean;
      backToVisual?: boolean;
    }
  | { kind: 'new'; place?: Target; destination?: Destination }
  | { kind: 'rooms' }
  | { kind: 'unplaced' }
  | { kind: 'labelSheets' }
  | { kind: 'trash' }
  | {
      kind: 'capture';
      destination?: Destination;
      location?: string;
      fromRecord?: boolean;
      name?: string;
      initialPhoto?: File;
      skipPhotos?: boolean;
      /** A blank NFC tag from Scan, ready to be written as the new item's label. */
      blankTag?: TagReading;
    }
  | { kind: 'identify' }
  | { kind: 'nfcTarget' }
  | { kind: 'find' | 'enroll'; box: LabelBox }
  | { kind: 'batches' }
  | { kind: 'assistant' }
  | { kind: 'browse' }
  | { kind: 'visualSearch'; intent: VisualSearchIntent }
  | { kind: 'photoReview'; id: string }
  | { kind: 'photoLibrary'; target: Target; name: string; location: string }
  | { kind: 'settings' }
  | { kind: 'locationSettings' }
  | { kind: 'ai' }
  | { kind: 'history' }
  | { kind: 'logs' }
  | { kind: 'more' };

type TabKey = 'home' | 'search' | 'scan' | 'capture' | 'more';

function tabFor(screen: Screen): TabKey {
  switch (screen.kind) {
    case 'browse':
      return 'search';
    case 'capture':
    case 'new':
      return 'capture';
    case 'photoReview':
      return 'capture';
    case 'identify':
    case 'nfcTarget':
      return 'scan';
    case 'more':
    case 'settings':
    case 'locationSettings':
    case 'ai':
    case 'history':
    case 'logs':
    case 'trash':
    case 'unplaced':
    case 'labelSheets':
    case 'batches':
      return 'more';
    default:
      return 'home';
  }
}

/** The pending captures badge links back to Home, where the queue is shown. */
function TabBar({
  tab,
  canSearch,
  pendingCount = 0,
  onTab,
}: {
  tab?: TabKey;
  canSearch: boolean;
  pendingCount?: number;
  onTab: (tab: TabKey) => void;
}) {
  const { t } = useLingui();
  const tabs = [
    { key: 'home', label: t`Home`, Icon: Home },
    { key: 'search', label: t`Search`, Icon: Search },
    { key: 'scan', label: t`Scan`, Icon: QrCode },
    { key: 'capture', label: t`Add`, Icon: Plus },
    { key: 'more', label: t`More`, Icon: Ellipsis },
  ] as const;
  return (
    <nav className="kept-tabbar" aria-label={t`Main`}>
      {tabs.map(({ key, label, Icon }) => (
        <Button
          key={key}
          variant="ghost"
          className={`kept-tabbar-button${key === 'scan' ? ' kept-tabbar-scan' : ''}`}
          aria-current={tab === key ? 'page' : undefined}
          isDisabled={key === 'search' && !canSearch}
          onPress={() => onTab(key)}
        >
          {key === 'scan' ? (
            <span className="kept-tabbar-scan-icon" aria-hidden>
              <Icon size={26} />
            </span>
          ) : (
            <Icon size={22} aria-hidden />
          )}
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

/** One row of a More or Settings group: icon, label, chevron. */
function MoreRow({
  label,
  hint,
  Icon,
  isDisabled,
  onPress,
}: {
  label: string;
  hint?: string;
  Icon: typeof Home;
  isDisabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      variant="ghost"
      className="kept-more-row"
      isDisabled={isDisabled}
      aria-label={label}
      onPress={onPress}
    >
      <span className="kept-recent-icon" aria-hidden>
        <Icon size={16} />
      </span>
      <span className="kept-more-row-body">
        <span className="kept-more-row-label">{label}</span>
        {hint && <span className="kept-more-row-hint">{hint}</span>}
      </span>
      <ChevronRight size={18} className="kept-row-chevron rtl:rotate-180" aria-hidden />
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
    thumbnailRotation?: number;
    placeEvidence?: ThingRow['placeEvidence'];
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
                <PhotoImage src={image} rotation={thing.thumbnailRotation} className="kept-thumb" />
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
                <PlaceEvidenceDetails
                  evidence={thing.placeEvidence}
                  resolveThumbnail={(url) => (origin ? previewUrl(url, origin) : undefined)}
                />
              </span>
              <ChevronRight size={18} className="kept-row-chevron rtl:rotate-180" aria-hidden />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

const NFC_TARGET_PAGE_SIZE = 40;

function NfcTargetPicker({
  cache,
  onClose,
  onChoose,
}: {
  cache: InventoryCache;
  onClose: () => void;
  onChoose: (target: LabelBox) => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(NFC_TARGET_PAGE_SIZE);
  const choices = useMemo(() => {
    const writable = new Set(writableLocations(cache).map(({ id }) => id));
    return cache.things
      .filter(
        (thing) =>
          thing.shortCode && thing.reviewState === 'confirmed' && writable.has(thing.locationId),
      )
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  }, [cache]);
  const term = normalize(query);
  const matches = term
    ? choices.filter((thing) =>
        [thing.name, thing.shortCode].some((value) => value && normalize(value).includes(term)),
      )
    : choices;

  return (
    <section className="grid gap-3">
      <ScreenHeader title={<Trans>Choose an item or bin</Trans>} onBack={onClose} />
      <TextField
        label={t`Search inventory`}
        value={query}
        onChange={(value) => {
          setQuery(value);
          setLimit(NFC_TARGET_PAGE_SIZE);
        }}
      />
      {cache.truncated && (
        <p className="text-small text-ink-2">
          <Trans>Only part of your inventory is cached.</Trans>
        </p>
      )}
      {matches.length ? (
        <ThingList
          items={matches.slice(0, limit).map((thing) => ({
            id: thing.id,
            name: thing.name,
            locationId: thing.locationId,
            path: inventoryPath(cache, thing).join(' › '),
          }))}
          onOpen={({ id, locationId }) => {
            const thing = matches.find((item) => item.id === id && item.locationId === locationId);
            if (!thing?.shortCode) return;
            onChoose({
              id,
              locationId,
              name: thing.name ?? t`Untitled`,
              shortCode: thing.shortCode,
              isContainer: thing.isContainer,
            });
          }}
        />
      ) : (
        <p className="text-small text-ink-2" role="status">
          <Trans>No matching items</Trans>
        </p>
      )}
      {matches.length > limit && (
        <Button variant="secondary" onPress={() => setLimit(limit + NFC_TARGET_PAGE_SIZE)}>
          <Trans>Show more</Trans>
        </Button>
      )}
    </section>
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
  const [assistantThreadId, setAssistantThreadId] = useState<string>();
  const [preferredLocationId, setPreferredLocationId] = useState<string>();
  const [preferredAI, setPreferredAI] = useState<CaptureAIProvider>();
  const [photoPreferenceLoaded, setPhotoPreferenceLoaded] = useState(false);
  const [preferenceError, setPreferenceError] = useState(false);

  useEffect(() => {
    let active = true;
    void adapters.outbox
      .getValue(connection, 'defaultLocation')
      .then((location) => {
        if (active) setPreferredLocationId(location || undefined);
      })
      .catch(() => {});
    void adapters.outbox
      .getValue(connection, 'defaultPhotoAI')
      .then((provider) => {
        if (!active) return;
        // The ChatGPT plan unless this iPhone chose another: the server's API key is opt-in.
        setPreferredAI(provider === 'apple' || provider === 'server' ? provider : 'chatgpt');
      })
      .catch(() => {})
      .finally(() => {
        if (active) setPhotoPreferenceLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [adapters, connection]);

  async function saveDefaultLocation(value: string) {
    setPreferenceError(false);
    try {
      await adapters.outbox.setValue(connection, 'defaultLocation', value);
      setPreferredLocationId(value || undefined);
    } catch {
      setPreferenceError(true);
    }
  }

  async function savePhotoDefault(provider: CaptureAIProvider) {
    const key = 'defaultPhotoAI';
    await adapters.outbox.setValue(connection, key, provider);
    if ((await adapters.outbox.getValue(connection, key)) !== provider) {
      throw new Error('The device did not retain the photo AI preference');
    }
    setPreferredAI(provider);
  }

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
  const [authoritativeCache, setCache] = useState<InventoryCache>();
  const cacheRef = useRef<InventoryCache | undefined>(undefined);
  const [pending, setPending] = useState<PendingCapture[]>([]);
  const allInventory = useMemo(
    () => withPendingPlaces(authoritativeCache, pending),
    [authoritativeCache, pending],
  );
  const cache = useMemo(() => shownInventory(allInventory), [allInventory]);
  const hiddenPersonalId = cache !== allInventory ? allInventory?.personal?.id : undefined;
  // Hiding Personal takes it out of lists and search only: a screen opened for something in it
  // (a scanned label, a link) still reads the whole cache.
  const cacheForLocation = (id?: string) => (id && id === hiddenPersonalId ? allInventory : cache);
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
  const searchingHome = screen.kind === 'home' && !!query.trim();
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
  useEffect(() => {
    if (screen.kind !== 'capture' || !screen.initialPhoto) return;
    // The form owns the photo after mounting. Keep it out of subsequent Back navigation.
    setScreen((current) => (current === screen ? { ...screen, initialPhoto: undefined } : current));
  }, [screen]);
  const resetBrowseFilters = (mode: typeof browseDefaults.mode, q = '') => {
    setBrowseFilters((previous) => ({
      ...browseDefaults,
      mode,
      q,
      grid: previous.grid,
      sort: previous.sort,
    }));
  };
  const goTab = async (tab: TabKey | 'assistant') => {
    if (tab === 'assistant' && screen.kind === 'assistant') return;
    if (tab === 'home' && screen.kind === 'home') {
      // Re-tapping Home jumps straight into the search field.
      window.scrollTo?.({ top: 0 });
      searchRef.current?.querySelector('input')?.focus();
      return;
    }
    if (screen.kind === 'capture') {
      if (tab === 'capture' || !(await canLeaveCapture.current?.())) return;
    }
    if (screen.kind === 'new' && tab === 'capture') return;
    if (tab === 'search') {
      if (screen.kind === 'browse' && backStack.current.length === 0) return;
      resetBrowseFilters('all', screen.kind === 'home' ? query.trim() : '');
    }
    const kind = tab === 'scan' ? 'identify' : tab === 'search' ? 'browse' : tab;
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
  const openPhotoSearch = (mode: VisualSearchIntent['mode']) =>
    pushScreen({ kind: 'visualSearch', intent: { mode, text: query.trim() } });
  const openBrowse = (mode: typeof browseDefaults.mode, q = '') => {
    resetBrowseFilters(mode, q);
    pushScreen({ kind: 'browse' });
  };
  const rememberBox = (target: Target) => {
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
  const open = (target: Target, backToRooms = false) => {
    setScreen({ kind: 'record', target, backToRooms });
    rememberBox(target);
  };

  const display = useCallback((next: InventoryCache | undefined) => {
    cacheRef.current = next;
    if (mounted.current) {
      setCache(next);
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
        case 'waiting_for_place':
          return t`Waiting to sync`;
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

  const logEntries: LocalLogEntry[] = pending.map((entry) => {
    const fields = draftFields(entry.capture);
    return {
      id: entry.capture.id,
      name: fields.name?.trim() || t`Untitled`,
      takenAt: entry.capture.takenAt,
      reason: entry.failure ?? 'waiting',
      message: entry.failure ? failureText(entry.failure, fields) : t`Waiting to sync.`,
      destination:
        cache?.things.find((item) => item.id === (fields.attachToThingId ?? fields.boxId))?.name ??
        cache?.places.find((item) => item.id === fields.placeId)?.name ??
        t`Destination`,
      files: entry.capture.files.length,
    };
  });

  const refresh = useCallback(
    (includeFailed = false) => {
      if (running.current) return running.current;
      const work = async () => {
        setWorking(true);
        try {
          await refreshPendingState();
          const me = await adapters.transport.request<Me>(connection, paths.me);
          setOnline(true);
          const count = await syncOutbox(connection, adapters, { includeFailed });
          await refreshPendingState();
          const personal =
            me.personalLocationId && typeof me.profile?.hidePersonal === 'boolean'
              ? { id: me.personalLocationId, hide: me.profile.hidePersonal }
              : null;
          display(await loadInventory(connection, adapters, personal));
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

  async function updateLocationCache(update: (current: InventoryCache) => InventoryCache) {
    // A refresh that started before the write might still deliver the previous snapshot.
    await running.current;
    const current = cacheRef.current;
    if (current) {
      const next = update(current);
      display(next);
      // Best effort: the server already has the change, and the refresh below saves its snapshot.
      await adapters.outbox.saveCache(connection, JSON.stringify(next)).catch(() => {});
    }
    await refresh();
  }

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
    // The label address first (labels.ts), so a link or tag under it is this server's.
    void loadLabelAddress(connection, adapters).catch(() => {});
    const readLink = async () => {
      const linkUrl = await adapters.lifecycle.takeLink(connection);
      if (!linkUrl) return;
      await loadLabelAddress(connection, adapters).catch(() => {});
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
        if (current) {
          if (resolved.superseded) setStatus(t`Superseded label`);
          setScreen({ kind: 'record', target: resolved.target });
        }
      } else if (resolved.status === 'foreign')
        setStatus(t`This tag belongs to a different SheepKeep server.`);
      // The same answers Scan gives; Scan is where a blank label is claimed or a match chosen.
      else if (resolved.status === 'unassigned')
        setStatus(t`This label has not been assigned. Scan it from the Scan tab to use it.`);
      else if (resolved.status === 'ambiguous')
        setStatus(
          t`That code matches more than one item. Scan it from the Scan tab to choose one.`,
        );
      else if (resolved.status === 'unresolved')
        setStatus(t`This label could not be checked offline.`);
      else if (resolved.status === 'malformed')
        setStatus(t`This tag does not contain a SheepKeep label URL.`);
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
    if (!searchingHome) return;
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
  }, [adapters, connection, onSignOut, query, searchingHome, t]);

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

  const availableDefaultLocations = cache ? writableLocations(cache) : [];
  const defaultLocationId = availableDefaultLocations.find(
    ({ id }) => id === preferredLocationId,
  )?.id;
  const currentBoxes = cache?.things.filter((thing) => thing.isContainer) ?? [];
  const editableBoxes = currentBoxes.filter((box) =>
    cache?.locations.some((loc) => loc.id === box.locationId && loc.role !== 'viewer'),
  );
  const canWrite = cache?.locations.some((location) => location.role !== 'viewer') ?? false;
  // The box used most recently is the likeliest place for the next item.
  const suggestedBox = recentBoxes
    .map((id) => editableBoxes.find((box) => box.id === id))
    .find(
      (box) => box !== undefined && (!defaultLocationId || box.locationId === defaultLocationId),
    );
  const suggestedDestination: Destination | undefined = suggestedBox
    ? {
        id: suggestedBox.id,
        locationId: suggestedBox.locationId,
        name: suggestedBox.name ?? t`Untitled`,
        kind: 'box',
      }
    : cache && defaultDestination(cache, defaultLocationId);
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
    : [];

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

  // Item | Box: the Add tab makes either. Hidden when adding into a given box or room.
  const addTabs =
    (screen.kind === 'capture' && !screen.destination && !screen.fromRecord) ||
    (screen.kind === 'new' && !screen.place) ? (
      <div className="kept-add-tabs">
        <Button
          variant="secondary"
          size="small"
          className="kept-add-tab"
          aria-pressed={screen.kind === 'capture'}
          onPress={() => {
            if (screen.kind === 'new') setScreen({ kind: 'capture' });
          }}
        >
          <Plus size={16} aria-hidden />
          <Trans>Add item</Trans>
        </Button>
        <Button
          variant="secondary"
          size="small"
          className="kept-add-tab"
          aria-pressed={screen.kind === 'new'}
          isDisabled={!online || !canWrite}
          onPress={async () => {
            if (screen.kind !== 'capture') return;
            if (!(await canLeaveCapture.current?.())) return;
            setScreen({ kind: 'new' });
          }}
        >
          <Package size={16} aria-hidden />
          <Trans>Add box</Trans>
        </Button>
      </div>
    ) : null;

  return (
    <>
      {(screen.kind === 'home' || screen.kind === 'assistant') && (
        <header className="kept-appbar">
          <div className="kept-appbar-brand">
            <AppMark size={28} />
            <h1 className="kept-appbar-name m-0">SheepKeep</h1>
          </div>
          <Button
            variant="ghost"
            size="small"
            className="kept-appbar-assistant"
            aria-label={t`Assistant`}
            aria-current={screen.kind === 'assistant' ? 'page' : undefined}
            onPress={() => void goTab('assistant')}
          >
            <MessageSquare size={20} aria-hidden />
          </Button>
        </header>
      )}
      {screen.kind === 'home' && (
        <div className="kept-search" ref={searchRef}>
          <TextField
            className="kept-search-field"
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
              onKeyDown: (event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing && cache) {
                  event.preventDefault();
                  openBrowse('all', query.trim());
                }
              },
            }}
          />
          {!searchingHome && adapters.visualSearch && (
            <Button
              variant="secondary"
              className="kept-search-action"
              aria-label={t`Search with a photo`}
              onPress={() => openPhotoSearch('photo')}
            >
              <Camera size={18} aria-hidden />
            </Button>
          )}
          <Button
            variant="secondary"
            className="kept-search-action"
            aria-label={t`Open in Browse`}
            isDisabled={!cache}
            onPress={() => openBrowse('all', query.trim())}
          >
            <CornerDownLeft size={18} className="rtl:-scale-x-100" aria-hidden />
          </Button>
        </div>
      )}
      <div className="mb-4 grid gap-2">
        {status && (
          <p className="rounded-xl bg-sunken p-3 text-ink-2" role="status">
            {status}
          </p>
        )}
        {screen.kind !== 'capture' && queuePanels}
      </div>
      {screen.kind === 'home' && (
        <section className="grid gap-4">
          {!searchingHome && (
            <HomeDashboard
              connection={connection}
              cache={cache}
              online={online}
              working={working}
              pendingCount={pending.length}
              failedCount={pending.filter((entry) => entry.failure).length}
              canWrite={canWrite}
              onItems={() => openBrowse('all')}
              onBoxes={() => openBrowse('bins')}
              onCategories={() => openBrowse('categories')}
              onRooms={() => pushScreen({ kind: 'rooms' })}
              onUnplaced={() => {
                setUnplacedLocationFilter(null);
                pushScreen({ kind: 'unplaced' });
              }}
              onAddManually={() => pushScreen({ kind: 'capture', skipPhotos: true })}
              onAddWithCamera={(initialPhoto) => pushScreen({ kind: 'capture', initialPhoto })}
              onLabels={() => pushScreen({ kind: 'labelSheets' })}
              onReview={() => pushScreen({ kind: 'batches' })}
              onOpen={open}
              onRetry={() => void refresh(true)}
              onSettings={() => pushScreen({ kind: 'settings' })}
              findName={savedFindTarget?.name}
              onHistory={() => pushScreen({ kind: 'history' })}
              onFind={() => savedFindTarget && pushScreen({ kind: 'find', box: savedFindTarget })}
            />
          )}
          {searchingHome && (
            <>
              <PhotoSearchActions onOpen={openPhotoSearch} />
              {canWrite && (
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
              )}
            </>
          )}
          {searchingHome && cache && !online && (
            <p className="text-small text-ink-2">
              {t`Cached inventory from ${new Date(cache.asOf).toLocaleString()}`}
            </p>
          )}
          {cache?.truncated && (
            <p className="text-small text-ink-2">
              <Trans>Only part of your inventory is cached.</Trans>
            </p>
          )}
          {searchingHome && (
            <>
              <h2 className="kept-card-title text-title">
                <Package size={18} aria-hidden />
                <Trans>Search results</Trans>
              </h2>
              <ThingList
                items={things}
                onOpen={open}
                origin={online ? connection.origin : undefined}
              />
              {(
                found?.places ??
                (cachedSearch
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
                  onPress={() =>
                    open({ id: place.id, locationId: place.locationId, kind: 'place' })
                  }
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
                    <ChevronRight
                      size={18}
                      className="kept-row-chevron rtl:rotate-180"
                      aria-hidden
                    />
                  </Button>
                ))}
            </>
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
          cache={cacheForLocation(screen.target.locationId)}
          target={screen.target}
          pending={pending}
          syncing={working}
          online={online}
          onClose={
            screen.backToBrowse || screen.backToAssistant || screen.backToVisual
              ? goBack
              : screen.backToRooms
                ? () => setScreen({ kind: 'rooms' })
                : goHome
          }
          onOpen={
            screen.backToVisual ? openVisualRecord : (target) => open(target, screen.backToRooms)
          }
          onCache={cacheDetail}
          onCreateBox={(place) =>
            setScreen({
              kind: 'new',
              place: { ...place, kind: place.kind === 'box' ? 'thing' : 'place' },
              destination: place,
            })
          }
          onCapture={(destination, location) =>
            pushScreen({ kind: 'capture', destination, location, fromRecord: true })
          }
          onPhotoLibrary={(name, location) =>
            pushScreen({ kind: 'photoLibrary', target: screen.target, name, location })
          }
          onInventoryChanged={() => {
            void refresh();
          }}
          onPhotoQueued={savedLocally}
          onLabel={(kind, box) => pushScreen({ kind, box })}
          onAuthError={onSignOut}
        />
      )}
      {screen.kind === 'new' && cache && (
        <NewBoxForm
          headerExtra={addTabs}
          connection={connection}
          cache={cacheForLocation(screen.place?.locationId) ?? cache}
          place={
            screen.destination ??
            authoritativeCache?.places.find((entry) => entry.id === screen.place?.id)
          }
          onClose={() => (screen.place ? open(screen.place, true) : goHome())}
          onCreated={(id, locationId) => {
            open({ id, locationId, kind: 'thing' });
            void refresh();
          }}
        />
      )}
      {screen.kind === 'rooms' && cache && (
        <Places
          connection={connection}
          cache={cache}
          online={online}
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
          headerExtra={addTabs}
          connection={connection}
          box={screen.destination}
          cache={cacheForLocation(screen.destination?.locationId)}
          location={screen.location}
          initialName={screen.name}
          initialPhoto={screen.initialPhoto}
          skipPhotos={screen.skipPhotos}
          blankTag={screen.blankTag}
          suggested={suggestedDestination}
          pending={pending}
          completions={completions}
          syncing={working}
          online={online}
          preferredProvider={preferredAI}
          photoPreferenceLoaded={photoPreferenceLoaded}
          leaveRef={canLeaveCapture}
          onClose={goBack}
          onSave={savedLocally}
          onReview={(id) => pushScreen({ kind: 'photoReview', id })}
          onAuthError={onSignOut}
        />
      )}
      {screen.kind === 'capture' && <div className="mt-4 grid gap-2">{queuePanels}</div>}
      {screen.kind === 'photoReview' && pending.find((item) => item.capture.id === screen.id) && (
        <PhotoReview
          key={screen.id}
          entry={pending.find((item) => item.capture.id === screen.id) as PendingCapture}
          cache={allInventory}
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
          onProgram={canWrite ? () => pushScreen({ kind: 'nfcTarget' }) : undefined}
          onBlankTag={
            canWrite ? (blankTag) => pushScreen({ kind: 'capture', blankTag }) : undefined
          }
          onAuthError={onSignOut}
        />
      )}
      {screen.kind === 'nfcTarget' && cache && (
        <NfcTargetPicker
          cache={cache}
          onClose={goBack}
          onChoose={(box) => pushScreen({ kind: 'enroll', box })}
        />
      )}
      {(screen.kind === 'find' || screen.kind === 'enroll') && (
        <LabelPanel
          connection={connection}
          cache={cacheForLocation(screen.box.locationId)}
          action={screen.kind}
          box={screen.box}
          onOpen={open}
          canEnroll={
            authoritativeCache?.locations.some(
              (location) =>
                location.id === screen.box.locationId &&
                location.role !== 'viewer' &&
                (screen.box.kind !== 'place' ||
                  (online && location.effectiveModules?.includes('labels'))),
            ) === true
          }
          onClearFindTarget={() => setSavedFindTarget(undefined)}
          onClose={() => {
            const back = backStack.current.at(-1);
            if (back?.kind === 'record' || back?.kind === 'nfcTarget') goBack();
            else
              open({
                id: screen.box.id,
                kind: screen.box.kind ?? 'thing',
                locationId: screen.box.locationId,
              });
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
                  thing.reviewState !== 'draft' &&
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
          onOpen={(target) => {
            pushScreen({ kind: 'record', target, backToBrowse: true });
            rememberBox(target);
          }}
          onPhotoSearch={(mode) =>
            pushScreen({ kind: 'visualSearch', intent: { mode, text: browseFilters.q } })
          }
          onAssistant={() => pushScreen({ kind: 'assistant' })}
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
          defaultLocationId={defaultLocationId}
          threadId={assistantThreadId}
          onThreadChange={setAssistantThreadId}
          onOpen={(target) => pushScreen({ kind: 'record', target, backToAssistant: true })}
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
          <div className="kept-rows">
            <MoreRow
              label={t`Settings`}
              Icon={Settings}
              onPress={() => pushScreen({ kind: 'settings' })}
            />
          </div>
          <div className="kept-rows">
            <MoreRow
              label={t`Print label sheets`}
              Icon={Tags}
              isDisabled={!cache || !online}
              onPress={() => pushScreen({ kind: 'labelSheets' })}
            />
            <MoreRow
              label={t`Recent capture batches`}
              Icon={Inbox}
              isDisabled={!online}
              onPress={() => pushScreen({ kind: 'batches' })}
            />
            <MoreRow
              label={t`Unplaced`}
              Icon={MapPin}
              isDisabled={!cache}
              onPress={() => pushScreen({ kind: 'unplaced' })}
            />
            <MoreRow
              label={t`Trash`}
              Icon={Trash2}
              isDisabled={!online}
              onPress={() => pushScreen({ kind: 'trash' })}
            />
            <MoreRow
              label={t`History`}
              Icon={Clock}
              isDisabled={!online}
              onPress={() => pushScreen({ kind: 'history' })}
            />
          </div>
          <footer className="pt-2">
            <ProjectNotice revision={import.meta.env.VITE_SHEEPKEEP_REVISION} />
          </footer>
        </section>
      )}
      {screen.kind === 'photoLibrary' && (
        <BoxPhotos
          connection={connection}
          target={screen.target}
          name={screen.name}
          online={online}
          canEdit={
            authoritativeCache?.locations.some(
              (location) => location.id === screen.target.locationId && location.role !== 'viewer',
            ) ?? false
          }
          onBack={goBack}
          onAdd={() =>
            pushScreen({
              kind: 'capture',
              destination: { ...screen.target, name: screen.name, kind: 'photos' },
              location: screen.location,
              fromRecord: true,
            })
          }
          onChanged={() => void refresh()}
          onAuthError={onSignOut}
        />
      )}
      {screen.kind === 'ai' && (
        <section className="grid gap-4">
          <ScreenHeader
            title={<Trans>AI and photo suggestions</Trans>}
            onBack={goBack}
            icon={<MessageSquare size={18} aria-hidden />}
          />
          <CaptureAISettings
            connection={connection}
            preferred={preferredAI}
            preferenceLoaded={photoPreferenceLoaded}
            onPreferred={savePhotoDefault}
          />
          {preferenceError && (
            <p role="alert">
              <Trans>Could not save settings.</Trans>
            </p>
          )}
        </section>
      )}
      {screen.kind === 'history' && (
        <HistoryScreen
          connection={connection}
          online={online}
          onBack={goBack}
          onOpen={(target) => pushScreen({ kind: 'record', target, backToBrowse: true })}
          onAuthError={onSignOut}
        />
      )}
      {screen.kind === 'logs' && (
        <LogsScreen
          connection={connection}
          online={online}
          local={logEntries}
          onBack={goBack}
          onOpen={(target) => pushScreen({ kind: 'record', target, backToBrowse: true })}
          onAuthError={onSignOut}
        />
      )}
      {screen.kind === 'locationSettings' && authoritativeCache && (
        <LocationSettings
          cache={authoritativeCache}
          connection={connection}
          online={online}
          syncing={working}
          onBack={goBack}
          onVisibilityChanged={(hide) =>
            updateLocationCache((current) =>
              current.personal ? { ...current, personal: { ...current.personal, hide } } : current,
            )
          }
          onDeleted={(id) => updateLocationCache((current) => withoutLocation(current, id))}
          onAuthError={onSignOut}
        />
      )}
      {screen.kind === 'settings' && (
        <section className="grid gap-4">
          <ScreenHeader
            title={<Trans>Settings</Trans>}
            onBack={goBack}
            icon={<Settings size={18} aria-hidden />}
          />
          <section className="kept-card" aria-label={t`Appearance`}>
            <h3 className="kept-card-title text-small text-ink-2">
              <Palette size={15} aria-hidden />
              <Trans>Appearance</Trans>
            </h3>
            <ThemeSwitch />
            <PaletteSwitch />
            {availableDefaultLocations.length > 0 && (
              <Select
                label={t`Default location`}
                items={[{ id: 'automatic', name: t`Automatic` }, ...availableDefaultLocations]}
                selectedKey={defaultLocationId ?? 'automatic'}
                onSelectionChange={(key) => {
                  if (key) void saveDefaultLocation(key === 'automatic' ? '' : String(key));
                }}
              >
                {(item) => (
                  <SelectItem id={item.id}>
                    <bdi>{item.name}</bdi>
                  </SelectItem>
                )}
              </Select>
            )}
          </section>
          <section className="kept-rows" aria-label={t`Advanced`}>
            <MoreRow
              label={t`Locations`}
              Icon={MapPin}
              isDisabled={!authoritativeCache}
              onPress={() => pushScreen({ kind: 'locationSettings' })}
            />
            <MoreRow
              label={t`AI and photo suggestions`}
              Icon={MessageSquare}
              onPress={() => pushScreen({ kind: 'ai' })}
            />
            <MoreRow label={t`Logs`} Icon={FileText} onPress={() => pushScreen({ kind: 'logs' })} />
          </section>
          {preferenceError && (
            <p role="alert">
              <Trans>Could not save settings.</Trans>
            </p>
          )}
          <section className="kept-card" aria-label={t`Account`}>
            <h3 className="kept-card-title text-small text-ink-2">
              <Trans>Account</Trans>
            </h3>
            <p className="break-all text-small text-ink-2">
              <bdi>{connection.origin}</bdi>
            </p>
            {stats && (
              <p className="text-small text-ink-2">
                {t`Saved on this iPhone: ${formatBytes(stats.pendingBytes + stats.cacheBytes)} · ${stats.pendingCount} waiting`}
              </p>
            )}
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
        </section>
      )}
      {showTabs && (
        <TabBar
          tab={
            screen.kind === 'assistant'
              ? undefined
              : screen.kind === 'capture' || screen.kind === 'new' || screen.kind === 'photoReview'
                ? 'capture'
                : tabFor(backStack.current[0] ?? screen)
          }
          canSearch={!!cache}
          pendingCount={pending.length}
          onTab={goTab}
        />
      )}
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
