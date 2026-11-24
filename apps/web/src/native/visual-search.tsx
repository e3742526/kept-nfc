import type { VisualSearchCoverage, VisualSearchMatch, VisualSearchResult } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { Camera, ChevronRight, Image, Images, ScanSearch } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileTrigger } from 'react-aria-components';
import { isApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { useFormat } from '@/lib/format';
import { usePlatform } from './adapters';
import { ScreenHeader } from './back-button';
import { type Connection, nativeErrorCode } from './bridge';
import { type InventoryCache, loadDetail, previewUrl } from './inventory';
import type { Target } from './labels';
import { isAuthRefusal, isRestoreEpochMismatch } from './outbox';
import {
  NATIVE_VISUAL_SOURCE_MAX_BYTES,
  type VisualSearchAdapter,
  VisualSearchProtocolError,
} from './visual-search-api';

export type VisualSearchIntent = {
  mode: 'text' | 'photo';
  text: string;
  locationId?: string;
};

export function PhotoSearchActions({
  onOpen,
}: {
  onOpen: (mode: VisualSearchIntent['mode']) => void;
}) {
  const { visualSearch } = usePlatform();
  if (!visualSearch) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" onPress={() => onOpen('text')}>
        <ScanSearch size={16} aria-hidden />
        <Trans>Find in photos</Trans>
      </Button>
      <Button variant="secondary" onPress={() => onOpen('photo')}>
        <Camera size={16} aria-hidden />
        <Trans>Search with a photo</Trans>
      </Button>
    </div>
  );
}

type Failure = 'incompatible' | 'offline' | 'permission' | 'unavailable' | 'invalid' | 'expired';
type Status = { coverage: VisualSearchCoverage } | { failure: Failure };
type AuthError = (reason: 'expired' | 'restored') => void;

function failureKind(error: unknown, stage: 'endpoint' | 'photo' | 'search'): Failure {
  if (error instanceof VisualSearchProtocolError || nativeErrorCode(error) === 'UNIMPLEMENTED')
    return 'incompatible';
  if (nativeErrorCode(error) === 'invalid_visual_photo') return 'invalid';
  if (isApiError(error)) {
    if (error.code === 'offline') return 'offline';
    if (error.status === 403) return 'permission';
    if (error.status === 404) return stage === 'search' ? 'expired' : 'incompatible';
    if (stage === 'photo' && [400, 413, 415].includes(error.status)) return 'invalid';
  }
  return 'unavailable';
}

function FailureMessage({ failure }: { failure: Failure }) {
  switch (failure) {
    case 'incompatible':
      return <Trans>Update your SheepKeep server to search photos.</Trans>;
    case 'offline':
      return <Trans>Photo search needs a connection.</Trans>;
    case 'permission':
      return <Trans>You do not have permission to search photos in this location.</Trans>;
    case 'invalid':
      return <Trans>Choose a readable photo for visual search.</Trans>;
    case 'expired':
      return <Trans>This search photo is no longer available. Choose it again.</Trans>;
    default:
      return <Trans>Photo search is temporarily unavailable.</Trans>;
  }
}

function CoverageNotes({ coverage }: { coverage: VisualSearchCoverage }) {
  const { t } = useLingui();
  const fmt = useFormat();
  const unsupported = coverage.unsupported ?? 0;
  const incomplete = coverage.pending + coverage.failed + coverage.paused + unsupported > 0;
  return (
    <div className="grid gap-1 text-small text-ink-2" role="status">
      <p className="m-0">{t`Indexed photos: ${fmt.num(coverage.ready)}`}</p>
      {incomplete && (
        <p className="m-0">
          <Trans>Photo indexing is incomplete.</Trans>
        </p>
      )}
      {coverage.pending > 0 && (
        <p className="m-0">{t`Waiting to index: ${fmt.num(coverage.pending)}`}</p>
      )}
      {coverage.failed > 0 && (
        <p className="m-0">{t`Indexing failed: ${fmt.num(coverage.failed)}`}</p>
      )}
      {coverage.paused > 0 && (
        <p className="m-0">{t`Indexing paused: ${fmt.num(coverage.paused)}`}</p>
      )}
      {unsupported > 0 && <p className="m-0">{t`Unsupported photos: ${fmt.num(unsupported)}`}</p>}
    </div>
  );
}

function Outcome({ result }: { result: VisualSearchResult }) {
  if (result.outcome === 'unavailable')
    return <Trans>Photo search is temporarily unavailable.</Trans>;
  if (result.outcome === 'partial_coverage')
    return <Trans>Search did not find a close match among indexed photos.</Trans>;
  if (result.outcome === 'no_close_match')
    return <Trans>No close photo match. Try different words or a clearer photo.</Trans>;
  if (result.outcome === 'ambiguous')
    return <Trans>Several recorded locations may match. Check the stored photos.</Trans>;
  if (result.uncertain)
    return (
      <Trans>These matches are weak. Check the stored photos before relying on a location.</Trans>
    );
  return <Trans>Possible photo matches. Check the stored photos to confirm.</Trans>;
}

function resultTarget(locationId: string, id: string): Target {
  return { kind: 'thing', id, locationId };
}

function MatchCard({
  match,
  connection,
  adapter,
  cache,
  onOpen,
  onAuthError,
}: {
  match: VisualSearchMatch;
  connection: Connection;
  adapter: VisualSearchAdapter;
  cache?: InventoryCache | undefined;
  onOpen: (target: Target) => void;
  onAuthError: AuthError;
}) {
  const platform = usePlatform();
  const fmt = useFormat();
  const [thumbnail, setThumbnail] = useState<string>();
  const [opening, setOpening] = useState(false);
  const [photoError, setPhotoError] = useState(false);
  const cached = cache?.things.find((item) => item.id === match.thingId);
  const isContainer = match.isContainer ?? cached?.isContainer;
  const containerId =
    match.containerId ??
    (match.containerId === undefined &&
    cached?.containerId &&
    match.path.some((part) => part.id === cached.containerId)
      ? cached.containerId
      : undefined);
  const locationName = cache?.locations.find((location) => location.id === match.locationId)?.name;
  const parts =
    locationName && match.path[0]?.id !== match.locationId
      ? [{ id: match.locationId, name: locationName }, ...match.path]
      : match.path;

  useEffect(() => {
    let active = true;
    void adapter
      .thumbnail(connection, match)
      .then((url) => {
        if (active) setThumbnail(previewUrl(url, connection.origin));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [adapter, connection, match]);

  async function original() {
    setOpening(true);
    setPhotoError(false);
    try {
      const mime =
        match.mime ??
        (await loadDetail(connection, match.thingId, platform)).attachments.find(
          (entry) => entry.id === match.attachmentId && entry.file?.id === match.fileId,
        )?.file?.mime;
      if (!mime) {
        setPhotoError(true);
        return;
      }
      await platform.media.openRemote(connection, {
        thing: match.thingId,
        file: match.fileId,
        mime,
      });
    } catch (error) {
      if (isRestoreEpochMismatch(error)) onAuthError('restored');
      else if (isAuthRefusal(error)) onAuthError('expired');
      else setPhotoError(true);
    } finally {
      setOpening(false);
    }
  }

  return (
    <li className="kept-card grid gap-2">
      <div className="flex items-start gap-3">
        {thumbnail ? (
          <img
            alt=""
            src={thumbnail}
            className="size-16 shrink-0 rounded-lg object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setThumbnail(undefined)}
          />
        ) : (
          <span className="grid size-16 shrink-0 place-items-center rounded-lg bg-sunken text-ink-2">
            <Image size={22} aria-hidden />
          </span>
        )}
        <div className="grid min-w-0 gap-1">
          <strong className="break-words">
            <bdi>{match.name}</bdi>
          </strong>
          {isContainer !== undefined && (
            <p className="m-0 text-small text-ink-2">
              {isContainer ? <Trans>Bin photo</Trans> : <Trans>Item photo</Trans>}
            </p>
          )}
          {parts.length > 0 && (
            <p className="m-0 flex flex-wrap items-center gap-x-1 text-small text-ink-2">
              <Trans>Recorded location</Trans>
              {parts.map((part, index) => (
                <span key={part.id} className="inline-flex max-w-full items-center gap-1">
                  {index > 0 && (
                    <ChevronRight size={12} className="shrink-0 rtl:rotate-180" aria-hidden />
                  )}
                  <bdi className="break-words">{part.name}</bdi>
                </span>
              ))}
            </p>
          )}
          <time dateTime={match.capturedAt} className="text-small text-ink-2">
            {fmt.date(match.capturedAt)}
          </time>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="small"
          variant="secondary"
          onPress={() => onOpen(resultTarget(match.locationId, match.thingId))}
        >
          <Trans>Open record</Trans>
        </Button>
        {containerId && containerId !== match.thingId && (
          <Button
            size="small"
            variant="secondary"
            onPress={() => onOpen(resultTarget(match.locationId, containerId))}
          >
            <Trans>Open containing bin</Trans>
          </Button>
        )}
        <Button
          size="small"
          variant="secondary"
          isDisabled={opening}
          onPress={() => void original()}
        >
          <Trans>Open original photo</Trans>
        </Button>
      </div>
      {photoError && (
        <p role="alert" className="m-0 text-small">
          <Trans>Photo unavailable</Trans>
        </p>
      )}
    </li>
  );
}

type SearchWork = { cancelled: boolean; inputId?: string };

export function VisualSearchScreen({
  connection,
  online,
  visible,
  intent,
  cache,
  onBack,
  onOpen,
  onAuthError,
}: {
  connection: Connection;
  online: boolean;
  visible: boolean;
  intent: VisualSearchIntent;
  cache?: InventoryCache | undefined;
  onBack: () => void;
  onOpen: (target: Target) => void;
  onAuthError: AuthError;
}) {
  const { t } = useLingui();
  const fmt = useFormat();
  const { visualSearch: adapter } = usePlatform();
  const [locationId, setLocationId] = useState(intent.locationId);
  const [text, setText] = useState(intent.text);
  const [status, setStatus] = useState<Status>();
  const [result, setResult] = useState<VisualSearchResult>();
  const [failure, setFailure] = useState<Failure>();
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const initialText = useRef(intent.mode === 'text' ? intent.text.trim() : '');
  const active = useRef<SearchWork | null>(null);
  const locations = cache?.locations;
  const forbidden =
    !!locations?.length &&
    locations.every(
      (location) => location.role === 'viewer' || (!!locationId && location.id !== locationId),
    );

  const release = useCallback(
    (work: SearchWork) => {
      if (!work.inputId) return;
      const { inputId } = work;
      delete work.inputId;
      void adapter?.cancel(connection, inputId).catch(() => {});
    },
    [adapter, connection],
  );
  const stop = useCallback(() => {
    const work = active.current;
    if (!work) return;
    active.current = null;
    work.cancelled = true;
    release(work);
  }, [release]);

  useEffect(() => () => stop(), [stop]);
  useEffect(() => {
    if (visible && online) return;
    stop();
    setBusy(false);
    if (!online) {
      setStatus(undefined);
      setResult(undefined);
      setFailure(undefined);
    }
  }, [visible, online, stop]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly refreshes the server status.
  useEffect(() => {
    if (!adapter || !online || !visible || forbidden) return;
    let current = true;
    void adapter
      .status(connection, locationId)
      .then((coverage) => {
        if (!current) return;
        setStatus({ coverage });
        if (coverage.access === 'denied') setResult(undefined);
      })
      .catch((error: unknown) => {
        if (!current) return;
        if (isRestoreEpochMismatch(error)) onAuthError('restored');
        else if (isAuthRefusal(error)) onAuthError('expired');
        else setStatus({ failure: failureKind(error, 'endpoint') });
      });
    return () => {
      current = false;
    };
  }, [adapter, connection, forbidden, locationId, online, onAuthError, retry, visible]);

  const run = useCallback(
    async (query: { text: string } | { photo: File }) => {
      if (!adapter || active.current) return;
      setResult(undefined);
      setFailure(undefined);
      const work: SearchWork = { cancelled: false };
      active.current = work;
      setBusy(true);
      let stage: Parameters<typeof failureKind>[1] = 'endpoint';
      try {
        const scope = locationId ? { locationIds: [locationId] } : {};
        let input: { text: string } | { inputId: string };
        if ('photo' in query) {
          stage = 'photo';
          const { inputId } = await adapter.upload(connection, query.photo, locationId);
          work.inputId = inputId;
          input = { inputId };
          stage = 'search';
        } else input = query;
        if (work.cancelled) return;
        const answer = await adapter.search(connection, { ...input, ...scope, limit: 8 });
        if (!work.cancelled) setResult(answer);
      } catch (error) {
        if (work.cancelled) return;
        if (isRestoreEpochMismatch(error)) onAuthError('restored');
        else if (isAuthRefusal(error)) onAuthError('expired');
        else setFailure(failureKind(error, stage));
      } finally {
        release(work);
        if (active.current === work) {
          active.current = null;
          setBusy(false);
        }
      }
    },
    [adapter, connection, locationId, onAuthError, release],
  );

  const coverage = status && 'coverage' in status ? status.coverage : undefined;
  const denied = forbidden || coverage?.access === 'denied';
  const unavailable =
    !online ||
    denied ||
    !coverage?.generation ||
    coverage.encoder === 'disabled' ||
    coverage.encoder === 'unavailable';
  useEffect(() => {
    if (unavailable || !visible || !initialText.current) return;
    const phrase = initialText.current;
    initialText.current = '';
    void run({ text: phrase });
  }, [run, unavailable, visible]);

  if (!visible) return null;

  function selectLocation(key: string | number | null) {
    stop();
    setBusy(false);
    setStatus(undefined);
    setFailure(undefined);
    setResult(undefined);
    initialText.current = '';
    setLocationId(key == null || key === 'all' ? undefined : String(key));
  }

  function selectPhoto(files: FileList | null) {
    const photo = files?.[0];
    if (!photo || unavailable || !visible) return;
    if (!photo.size || photo.size > NATIVE_VISUAL_SOURCE_MAX_BYTES) {
      setResult(undefined);
      setFailure('invalid');
      return;
    }
    void run({ photo });
  }

  return (
    <section className="grid gap-3">
      <ScreenHeader
        title={<Trans>Search photos</Trans>}
        onBack={onBack}
        icon={<ScanSearch size={18} aria-hidden />}
      />
      {locations && locations.length > 1 && (
        <Select
          label={t`Location`}
          items={[{ id: 'all', name: t`All locations` }, ...locations]}
          selectedKey={locationId ?? 'all'}
          onSelectionChange={selectLocation}
        >
          {(item) => (
            <SelectItem id={item.id} textValue={item.name}>
              <bdi>{item.name}</bdi>
            </SelectItem>
          )}
        </Select>
      )}
      <p className="m-0 text-small text-ink-2">
        <Trans>
          Photo search uses location only. Browse filters apply to ordinary inventory results.
        </Trans>
      </p>
      {!online ? (
        <p role="status">
          <FailureMessage failure="offline" />
        </p>
      ) : denied ? (
        <p role="status">
          <FailureMessage failure="permission" />
        </p>
      ) : status && 'failure' in status ? (
        <p role="status">
          <FailureMessage failure={status.failure} />
        </p>
      ) : coverage && (!coverage.generation || coverage.encoder === 'disabled') ? (
        <p role="status">
          <Trans>Photo search is not enabled on this server.</Trans>
        </p>
      ) : coverage?.encoder === 'unavailable' ? (
        <p role="status">
          <Trans>The photo search encoder is unavailable.</Trans>
        </p>
      ) : (
        !coverage && (
          <p role="status">
            <Trans>Checking photo search…</Trans>
          </p>
        )
      )}
      {online && ((status && 'failure' in status) || coverage?.encoder === 'unavailable') && (
        <Button
          variant="secondary"
          onPress={() => {
            setStatus(undefined);
            setRetry((value) => value + 1);
          }}
        >
          <Trans>Try again</Trans>
        </Button>
      )}
      {!unavailable && (
        <>
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (text.trim() && !busy) void run({ text: text.trim() });
            }}
          >
            <TextField
              label={t`Describe what you are looking for`}
              value={text}
              onChange={(value) => {
                setText(value);
                setResult(undefined);
                setFailure(undefined);
                initialText.current = '';
              }}
              isDisabled={busy}
              inputProps={{ maxLength: 200, enterKeyHint: 'search' }}
            />
            <Button type="submit" isDisabled={busy || !text.trim()}>
              <Trans>Find in photos</Trans>
            </Button>
          </form>
          <div className="flex flex-wrap gap-2">
            <FileTrigger
              acceptedFileTypes={['image/*']}
              defaultCamera="environment"
              onSelect={selectPhoto}
            >
              <Button variant="secondary" isDisabled={busy}>
                <Camera size={16} aria-hidden />
                <Trans>Take a photo</Trans>
              </Button>
            </FileTrigger>
            <FileTrigger acceptedFileTypes={['image/*']} onSelect={selectPhoto}>
              <Button variant="secondary" isDisabled={busy}>
                <Images size={16} aria-hidden />
                <Trans>Choose a photo</Trans>
              </Button>
            </FileTrigger>
          </div>
          <p className="m-0 text-small text-ink-2">
            {t`Use one photo up to ${fmt.num(NATIVE_VISUAL_SOURCE_MAX_BYTES / 1024 ** 2)} MB. Search photos are temporary.`}
          </p>
          {coverage && <CoverageNotes coverage={result?.coverage ?? coverage} />}
          {busy && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p role="status" className="m-0">
                <Trans>Searching photos…</Trans>
              </p>
              <Button
                variant="secondary"
                onPress={() => {
                  stop();
                  setBusy(false);
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
            </div>
          )}
          {failure && (
            <p role="alert">
              <FailureMessage failure={failure} />
            </p>
          )}
          {result && (
            <>
              <p role="status">
                <Outcome result={result} />
              </p>
              {adapter && result.matches.length > 0 && (
                <ul aria-label={t`Possible photo matches`} className="grid gap-2">
                  {result.matches.map((match) => (
                    <MatchCard
                      key={match.attachmentId}
                      adapter={adapter}
                      connection={connection}
                      cache={cache}
                      match={match}
                      onOpen={onOpen}
                      onAuthError={onAuthError}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
