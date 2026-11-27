import { AMOUNT_STRING, newId, normalize, TAG_LIMITS } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { Camera, Check, FileText, Images, MapPin, Package, Plus, Trash2 } from 'lucide-react';
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { TextField as AriaTextField, FileTrigger, Label, TextArea } from 'react-aria-components';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { CreateRegistryResult, Page, Tag } from '@/api/inventory/types';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { inputClass } from '@/components/ui/field';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { sep, useBytes } from '@/lib/format';
import { usePlatform } from './adapters';
import { ScreenHeader } from './back-button';
import {
  type CaptureAIProvider,
  type CompletionState,
  type Connection,
  StorageFullError,
  type TagReading,
} from './bridge';
import { CaptureSuggestion, type PhotoSuggestion } from './capture-ai';
import {
  type DetailRow,
  DetailSuggestions,
  detailRowsFor,
  leadSuggestion,
} from './capture-details';
import { CategoryPicker, equivalentCategory } from './category-picker';
import {
  type Destination,
  DestinationPicker,
  defaultDestination,
  PlacePreview,
  resolveDestination,
} from './destination';
import { createBox, type InventoryCache, inventoryPath } from './inventory';
import { type ItemLabel, ItemLabelPicker } from './item-label';
import { mobileFileLimit, type PendingCapture, type SelectedOriginal, saveOnPhone } from './outbox';
import { readRecentDestinations } from './recent-destinations';

type ChosenFile = SelectedOriginal & { key: string; previewUrl?: string };
type AddStep = 'photos' | 'details' | 'label';

/** Return the recorded path, with the location name when the screen has room for it. */
function destinationLabel(cache: InventoryCache, destination: Destination, full = false): string {
  if (full && destination.path) return destination.path;
  const row = [...cache.places, ...cache.things].find((entry) => entry.id === destination.id);
  return row
    ? [...inventoryPath(cache, row).slice(full ? 0 : 1), destination.name].join(' › ')
    : destination.name;
}

function createPreviewUrl(file: File): string | undefined {
  if (typeof URL.createObjectURL !== 'function') return undefined;
  try {
    return URL.createObjectURL(file);
  } catch {
    return undefined;
  }
}

function revokePreviewUrl(url: string | undefined): void {
  if (url && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  }
}

export function CaptureForm({
  connection,
  box,
  location,
  cache,
  initialName = '',
  initialPhoto,
  skipPhotos = false,
  blankTag,
  suggested,
  pending = [],
  completions = {},
  syncing = false,
  online = true,
  preferredProvider = 'chatgpt',
  photoPreferenceLoaded = true,
  leaveRef,
  onClose,
  onSave,
  onAdded,
  onReview,
  onAuthError,
  headerExtra,
}: {
  connection: Connection;
  box?: Destination;
  location?: string;
  cache?: InventoryCache;
  /** Description prefilled from a search that found nothing. */
  initialName?: string;
  initialPhoto?: File;
  skipPhotos?: boolean;
  /** A blank NFC tag scanned on the way here: the label step offers to write it. */
  blankTag?: TagReading;
  /** Where Add starts (the place or box added to last, else Unplaced); the picker changes it. */
  suggested?: Destination;
  pending?: readonly PendingCapture[];
  /** Durable terminal states; only `synced` counts as synchronized. */
  completions?: Readonly<Record<string, CompletionState>>;
  syncing?: boolean;
  online?: boolean;
  preferredProvider?: CaptureAIProvider;
  photoPreferenceLoaded?: boolean;
  leaveRef: Ref<() => Promise<boolean>>;
  onClose: () => void;
  onSave: () => void;
  /** An item was saved into this place or box (not photos or documents for a record). */
  onAdded?: (destination: Destination) => void;
  onReview?: (id: string) => void;
  onAuthError?: (reason: 'expired' | 'restored') => void;
  /** Shown right under the header (the Add tab's Item | Box switch). */
  headerExtra?: ReactNode;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const confirm = useConfirm();
  const formatBytes = useBytes();
  const [destination, setDestination] = useState(
    () => box ?? suggested ?? (cache && defaultDestination(cache)),
  );
  const [changingDestination, setChangingDestination] = useState(false);
  const locationPhoto = destination?.kind === 'location-photo';
  const photosOnly = destination?.kind === 'photos' || locationPhoto;
  const documentsOnly = destination?.kind === 'documents';
  const evidenceOnly = photosOnly || documentsOnly;
  const [step, setStep] = useState<AddStep>(() =>
    initialName || initialPhoto || blankTag || skipPhotos ? 'details' : 'photos',
  );
  const focusStepHeading = useCallback(
    (heading: HTMLHeadingElement | null) => heading?.focus(),
    [],
  );
  const [labelBusy, setLabelBusy] = useState(false);
  const showDetails = !evidenceOnly && step === 'details';
  const showLabels = !evidenceOnly && step === 'label';
  const [tags, setTags] = useState<string[]>([]);
  const [intent, setIntent] = useState<'record' | 'add'>('record');
  const [batchId] = useState(newId);
  const [name, setName] = useState(initialName);
  const [note, setNote] = useState('');
  const [quantity, setQuantity] = useState('');
  const [files, setFiles] = useState<ChosenFile[]>([]);
  const [label, setLabel] = useState<ItemLabel>();
  // Bumped after each save, so the next item starts with a fresh label picker.
  const [labelSession, setLabelSession] = useState(0);
  // A blank NFC tag scanned on the way here: the details step leads to the label step to write it.
  const blankTagWaiting = !!blankTag && labelSession === 0;
  const [providerOverride, setProvider] = useState<CaptureAIProvider>();
  const provider = providerOverride ?? preferredProvider;
  const photos = evidenceOnly ? [] : files.filter((item) => item.role === 'photo');
  const firstPhoto = photos[0];
  const captureLocation = cache?.locations.find(({ id }) => id === destination?.locationId);
  const account = captureLocation?.ownerAccountId;
  const [batchEntryIds, setBatchEntryIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const previewUrlsRef = useRef<string[]>([]);
  // The AI's reading of these photos, itemized by field; it goes stale when the photos change.
  const photoKey = photos.map(({ key }) => key).join(',');
  const [details, setDetails] = useState<{ photoKey: string; items: PhotoSuggestion[] }>();
  const shownDetails = details?.photoKey === photoKey ? details.items : undefined;
  // Categories created from a suggestion, named until the cache has them.
  const [createdTags, setCreatedTags] = useState<(Tag & { accountId: string })[]>([]);
  const categoryOptions = [
    ...(cache?.tags?.filter((tag) => tag.accountId === account) ?? []),
    ...createdTags.filter((tag) => tag.accountId === account),
  ];
  const [recentIds, setRecentIds] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    void readRecentDestinations(connection, adapters).then((ids) => {
      if (current) setRecentIds(ids);
    });
    return () => {
      current = false;
    };
  }, [adapters, connection]);
  const recentDestinations =
    cache && !evidenceOnly
      ? recentIds
          .filter((id) => id !== destination?.id)
          .flatMap((id) => resolveDestination(cache, id) ?? [])
          .slice(0, 4)
      : [];

  async function canLeave() {
    if (busy) return false;
    if (!name && !note && !quantity && !files.length && !tags.length && !label) return true;
    return confirm({
      title: t`Discard this draft?`,
      confirmLabel: t`Discard draft`,
      destructive: true,
    });
  }

  useImperativeHandle(leaveRef, () => canLeave);

  useEffect(() => {
    return () => {
      for (const url of previewUrlsRef.current) revokePreviewUrl(url);
      previewUrlsRef.current = [];
    };
  }, []);

  const quantityInvalid =
    quantity !== '' && (!AMOUNT_STRING.test(quantity) || Number(quantity) <= 0);

  const canSave =
    destination && (evidenceOnly ? files.length > 0 : !!name.trim() && !quantityInvalid);
  // A label is claimed only in the location it was made for.
  const claimCode =
    !evidenceOnly && label && label.locationId === destination?.locationId ? label.code : undefined;
  // A tag written and read back here: the item's verified NFC tag once the label is claimed.
  const nfcVerified =
    claimCode && label?.source === 'nfc' ? ({ claimNfcVerified: true } as const) : {};

  function clearLabel() {
    setLabel(undefined);
    setLabelSession((n) => n + 1);
  }

  function added(to: Destination) {
    setRecentIds((ids) => [to.id, ...ids.filter((id) => id !== to.id)]);
    onAdded?.(to);
  }

  function changeDestination(next: Destination | undefined) {
    const owner = cache?.locations.find(({ id }) => id === next?.locationId)?.ownerAccountId;
    if (account !== owner) setTags([]);
    if (label && label.locationId !== next?.locationId) setLabel(undefined);
    setDestination(next);
  }

  /** A category the AI named: an existing one by name, else created (online only). */
  async function categoryFor(row: DetailRow): Promise<string | undefined> {
    if (row.tag) return row.tag.id;
    if (!account) return;
    const path = inventoryPaths.accountRegistry(account, 'tags');
    const { items } = await adapters.transport.request<Page<Tag>>(
      connection,
      path + qs({ q: row.value, limit: 30 }),
    );
    const found =
      items.find((tag) => equivalentCategory(tag.name, row.value)) ??
      (
        await adapters.transport.request<CreateRegistryResult<'tags'>>(connection, path, {
          method: 'POST',
          idempotencyKey: newId(),
          body: { name: row.value },
        })
      ).item;
    setCreatedTags((current) => [
      ...current.filter(({ id }) => id !== found.id),
      { ...found, accountId: account },
    ]);
    return found.id;
  }

  async function applyDetails(rows: readonly DetailRow[]) {
    if (busy) return;
    setBusy(true);
    setStatus('');
    let failed = false;
    const addedTags: string[] = [];
    for (const row of rows) {
      if (row.field === 'name') setName(row.value);
      else if (row.field === 'quantity') setQuantity(row.value);
      else if (row.field === 'note')
        setNote((current) => (current.trim() ? `${current.trimEnd()}\n${row.value}` : row.value));
      else {
        try {
          const id = await categoryFor(row);
          if (id) addedTags.push(id);
        } catch {
          failed = true;
        }
      }
    }
    if (addedTags.length)
      setTags((current) => [...new Set([...current, ...addedTags])].slice(0, TAG_LIMITS.perThing));
    setDetails(undefined);
    setBusy(false);
    setStatus(
      failed
        ? t`Some categories could not be added. Check your connection and try again.`
        : t`Filled in. Check the fields, then save.`,
    );
  }

  function goToStep(next: AddStep) {
    setStatus('');
    setStep(next);
  }
  const pendingById = new Map(pending.map((entry) => [entry.capture.id, entry]));
  const batchPendingCount = batchEntryIds.filter((id) => {
    const entry = pendingById.get(id);
    return Boolean(entry && !entry.failure);
  }).length;
  const batchFailedCount = batchEntryIds.filter((id) =>
    Boolean(pendingById.get(id)?.failure),
  ).length;
  // Truthful sync state: an entry counts as synced only with an explicit durable
  // `synced` completion (server confirmed record + attachments). Disappearing
  // from the pending queue — discard, failure cleanup, refresh races — never does.
  const batchSyncedCount = batchEntryIds.filter(
    (id) => !pendingById.has(id) && completions[id] === 'synced',
  ).length;
  const batchDiscardedCount = batchEntryIds.filter(
    (id) => !pendingById.has(id) && completions[id] === 'discarded',
  ).length;

  function prepareFiles(source: ArrayLike<File>, role: SelectedOriginal['role']) {
    const items = Array.from(source);
    if (
      items.some((file) => file.size === 0 || file.size > mobileFileLimit) ||
      files.length + items.length > (locationPhoto ? 1 : 20)
    ) {
      setStatus(
        locationPhoto
          ? t`Choose one photo no larger than 25 MB.`
          : t`Choose up to 20 files, each no larger than 25 MB.`,
      );
      return;
    }
    setStatus('');
    return items.map((file): ChosenFile => {
      const previewUrl = role === 'photo' ? createPreviewUrl(file) : undefined;
      if (previewUrl) previewUrlsRef.current.push(previewUrl);
      return { file, role, key: newId(), ...(previewUrl ? { previewUrl } : {}) };
    });
  }

  function choose(source: FileList | null, role: SelectedOriginal['role']) {
    if (!source) return;
    const next = prepareFiles(source, role);
    if (next) setFiles((current) => [...current, ...next]);
  }

  const attachInitialPhoto = useEffectEvent((photo: File) => {
    const next = prepareFiles([photo], 'photo');
    if (next) setFiles(next);
  });
  useEffect(() => {
    if (initialPhoto) attachInitialPhoto(initialPhoto);
  }, [initialPhoto]);

  function removeFile(key: string) {
    setFiles((current) => {
      const target = current.find((item) => item.key === key);
      if (target?.previewUrl) {
        revokePreviewUrl(target.previewUrl);
        previewUrlsRef.current = previewUrlsRef.current.filter((u) => u !== target.previewUrl);
      }
      return current.filter((item) => item.key !== key);
    });
  }

  async function reviewPhoto(items: PhotoSuggestion[] = []) {
    if (busy || !firstPhoto || !destination || evidenceOnly || !onReview) return;
    // A label belongs to one item. A review of several items can't know which, so it is never
    // guessed: the label stays on this form, for the next item saved, once that is confirmed.
    if (
      claimCode &&
      items.length > 1 &&
      !(await confirm({
        title: t`Keep the label for another item?`,
        body: t`The label is not added to these items. It stays here for the next item you save.`,
        confirmLabel: t`Review items`,
        cancelLabel: t`Cancel`,
      }))
    )
      return;
    setBusy(true);
    setStatus('');
    try {
      const proposals: PhotoSuggestion[] = items.length ? items : [{ name: name.trim() }];
      const draftName = normalize(name);
      // The label goes with the item when the review is of one item; with several, it stays
      // here for the next item saved (confirmed above).
      const labelled = proposals.length === 1 ? claimCode : undefined;
      const id = await saveOnPhone(
        connection,
        {
          locationId: destination.locationId,
          ...(destination.kind === 'place'
            ? { placeId: destination.id }
            : { boxId: destination.id, binEvidenceId: newId() }),
          ...(cache?.pendingPlaceIds?.includes(destination.id)
            ? { dependsOnPlace: destination.id }
            : {}),
          name: name.trim() || t`Photo review`,
          captureIntent: intent,
          skipServerSuggestions: true,
          batchId: newId(),
          review: {
            accepted: false,
            entries: proposals.map((item) => ({
              id: newId(),
              tagRequestId: newId(),
              name: item.name,
              note: items.length ? (item.description ?? note.trim()) : note.trim(),
              quantity:
                proposals.length === 1 && (!draftName || normalize(item.name) === draftName)
                  ? quantity
                  : '',
              estimatedQuantity: items.length ? (item.quantity ?? undefined) : undefined,
              evidence: item.evidence,
              include: true,
              categories: item.categories ?? [],
              tags,
              ...(labelled ? { claimCode: labelled, ...nfcVerified } : {}),
            })),
          },
        },
        [...photos, ...files.filter((item) => item.role === 'document')],
        adapters,
      );
      for (const item of files) revokePreviewUrl(item.previewUrl);
      previewUrlsRef.current = [];
      setFiles([]);
      setName('');
      setQuantity('');
      setNote('');
      if (labelled) clearLabel();
      added(destination);
      onSave();
      onReview(id);
    } catch {
      setStatus(t`SheepKeep could not save on this iPhone. Check available storage and try again.`);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (busy || !canSave || !destination) return;
    setBusy(true);
    setStatus('');
    try {
      const savedId = await saveOnPhone(
        connection,
        {
          locationId: destination.locationId,
          ...(evidenceOnly
            ? { attachToThingId: destination.id }
            : destination.kind === 'place'
              ? { placeId: destination.id }
              : { boxId: destination.id }),
          ...(cache?.pendingPlaceIds?.includes(destination.id)
            ? { dependsOnPlace: destination.id }
            : {}),
          ...(locationPhoto ? { locationPhoto: true } : {}),
          name: evidenceOnly ? destination.name : name.trim(),
          ...(!evidenceOnly ? { captureIntent: intent, tags } : {}),
          ...(firstPhoto ? { skipServerSuggestions: true } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(quantity ? { quantity } : {}),
          ...(claimCode ? { claimCode, ...nfcVerified } : {}),
          batchId,
        },
        files,
        adapters,
      );
      for (const item of files) revokePreviewUrl(item.previewUrl);
      previewUrlsRef.current = [];
      setBatchEntryIds((ids) => [...ids, savedId]);
      setName('');
      setNote('');
      setQuantity('');
      // Action and categories stay for the next item: a bin is usually filled with similar things.
      setFiles([]);
      clearLabel();
      setStep('photos');
      setStatus(t`Saved on device.`);
      if (!evidenceOnly) added(destination);
      onSave();
    } catch (error) {
      setStatus(
        error instanceof StorageFullError
          ? t`Your iPhone storage is full. Free up space and try again.`
          : t`SheepKeep could not save on this iPhone. Check available storage and try again.`,
      );
    } finally {
      setBusy(false);
    }
  }

  const headerTitle = locationPhoto
    ? t`Add location photo`
    : photosOnly
      ? t`Record photos`
      : documentsOnly
        ? t`Add documents`
        : box && box.kind !== 'place'
          ? t`Adding to box`
          : t`Add item`;

  return (
    <section className="grid gap-4">
      <ScreenHeader
        title={headerTitle}
        onBack={() => {
          if (showLabels) {
            goToStep('details');
            return;
          }
          if (showDetails) {
            goToStep('photos');
            return;
          }
          void canLeave().then((ok) => {
            if (ok) onClose();
          });
        }}
        backDisabled={busy}
        icon={
          photosOnly ? (
            <Camera size={18} aria-hidden />
          ) : documentsOnly ? (
            <FileText size={18} aria-hidden />
          ) : (
            <Plus size={18} aria-hidden />
          )
        }
      />
      {headerExtra}
      {box && (evidenceOnly || !cache) && (
        <header className="kept-card">
          <div className="flex items-start gap-3">
            <span className="kept-row-lead" aria-hidden>
              {box.kind === 'place' ? <MapPin size={18} /> : <Package size={18} />}
            </span>
            <div className="grid min-w-0 gap-0.5">
              <h3 className="text-body font-semibold">
                <bdi>{box.name}</bdi>
              </h3>
              {(location || (cache && destinationLabel(cache, box) !== box.name)) && (
                <p className="text-small text-ink-2">
                  <bdi>{cache ? destinationLabel(cache, box, true) : location}</bdi>
                </p>
              )}
            </div>
          </div>
        </header>
      )}
      {batchEntryIds.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg bg-sunken px-3 py-2 text-small"
          role="status"
        >
          <span>{t`Entries in this batch: ${batchEntryIds.length}`}</span>
          {batchSyncedCount > 0 && (
            <span className="kept-badge kept-badge-ok">{t`Synced: ${batchSyncedCount}`}</span>
          )}
          {batchPendingCount > 0 && (
            <span className="kept-badge kept-badge-warn">
              {syncing
                ? t`Syncing: ${batchPendingCount}`
                : t`Saved on device: ${batchPendingCount}`}
            </span>
          )}
          {batchFailedCount > 0 && (
            <span className="kept-badge kept-badge-danger">
              {t`Needs attention: ${batchFailedCount}`}
            </span>
          )}
          {batchDiscardedCount > 0 && (
            <span className="kept-badge">{t`Discarded: ${batchDiscardedCount}`}</span>
          )}
        </div>
      )}
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (showDetails && canSave) {
            if (blankTagWaiting) goToStep('label');
            else void save();
          }
          if ((evidenceOnly || showLabels) && !labelBusy) void save();
        }}
      >
        {!evidenceOnly && (
          <h3 key={step} ref={focusStepHeading} tabIndex={-1} className="text-title font-semibold">
            {step === 'photos'
              ? t`Add photos`
              : step === 'details'
                ? t`Item details`
                : t`Add an NFC tag?`}
          </h3>
        )}
        {cache && showDetails && (
          <div className="grid gap-2">
            {destination && !changingDestination ? (
              <div className="kept-card kept-destination">
                <span className="kept-row-lead" aria-hidden>
                  {destination.kind === 'place' ? (
                    <PlacePreview connection={connection} id={destination.id} online={online} />
                  ) : (
                    <Package size={18} />
                  )}
                </span>
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className="text-small text-ink-2">
                    <Trans>Destination</Trans>
                  </span>
                  <bdi className="font-semibold">{destinationLabel(cache, destination, true)}</bdi>
                </div>
                <Button
                  variant="secondary"
                  size="small"
                  isDisabled={busy}
                  onPress={() => setChangingDestination(true)}
                >
                  <Trans>Change</Trans>
                </Button>
              </div>
            ) : (
              <div className="grid gap-3">
                <DestinationPicker
                  connection={connection}
                  online={online}
                  cache={cache}
                  value={destination}
                  offerTagWrite
                  onAuthError={onAuthError}
                  onChange={changeDestination}
                  disabled={busy}
                />
                {destination && (
                  <Button
                    variant="secondary"
                    size="small"
                    className="justify-self-start"
                    onPress={() => setChangingDestination(false)}
                  >
                    <Trans>Done</Trans>
                  </Button>
                )}
              </div>
            )}
            {!changingDestination && recentDestinations.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-small text-ink-2">
                  <Trans>Recent</Trans>
                </span>
                {recentDestinations.map((recent) => (
                  <Button
                    key={recent.id}
                    variant="secondary"
                    size="small"
                    isDisabled={busy}
                    onPress={() => changeDestination(recent)}
                  >
                    <bdi>{destinationLabel(cache, recent)}</bdi>
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}
        {showDetails && (
          <TextField
            label={t`Description`}
            placeholder={t`Holiday decorations`}
            value={name}
            onChange={setName}
            isDisabled={busy}
            inputProps={{
              maxLength: 200,
              name: 'name',
              enterKeyHint: 'next',
            }}
          />
        )}
        {!showLabels && (
          <div className="kept-media-bar">
            {!documentsOnly && (evidenceOnly || step === 'photos') && (
              <>
                <FileTrigger
                  acceptedFileTypes={['image/*']}
                  defaultCamera="environment"
                  onSelect={(list) => choose(list, 'photo')}
                >
                  <Button
                    variant="secondary"
                    className="kept-media-btn"
                    isDisabled={busy || (locationPhoto && files.length > 0)}
                  >
                    <Camera size={20} aria-hidden />
                    <Trans>Take a photo</Trans>
                  </Button>
                </FileTrigger>
                <FileTrigger
                  acceptedFileTypes={['image/*']}
                  allowsMultiple={!locationPhoto}
                  onSelect={(list) => choose(list, 'photo')}
                >
                  <Button
                    variant="secondary"
                    className="kept-media-btn"
                    isDisabled={busy || (locationPhoto && files.length > 0)}
                  >
                    <Images size={20} aria-hidden />
                    {locationPhoto ? <Trans>Choose photo</Trans> : <Trans>Choose photos</Trans>}
                  </Button>
                </FileTrigger>
              </>
            )}
            {!photosOnly && (evidenceOnly || showDetails) && (
              <FileTrigger
                acceptedFileTypes={['application/pdf', '.pdf']}
                allowsMultiple
                onSelect={(list) => choose(list, 'document')}
              >
                <Button variant="secondary" className="kept-media-btn" isDisabled={busy}>
                  <FileText size={20} aria-hidden />
                  <Trans>Attach PDF</Trans>
                </Button>
              </FileTrigger>
            )}
          </div>
        )}
        {!showLabels && files.length > 0 && (
          <ul className="grid gap-2">
            {files.map(({ file, key, role, previewUrl }) => (
              <li
                className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-2"
                key={key}
              >
                <div className="flex min-w-0 items-center gap-3">
                  {previewUrl ? (
                    <img src={previewUrl} alt="" className="kept-thumb" loading="lazy" />
                  ) : (
                    <span className="kept-row-lead" aria-hidden>
                      <FileText size={18} />
                    </span>
                  )}
                  <div className="grid min-w-0 gap-0.5">
                    <bdi className="break-words font-medium">{file.name}</bdi>
                    <span className="text-small text-ink-2">
                      {role === 'photo' ? t`Photo` : t`PDF document`}
                      {sep()}
                      {formatBytes(file.size)}
                    </span>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="small"
                  isDisabled={busy}
                  onPress={() => removeFile(key)}
                >
                  <Trash2 size={15} aria-hidden />
                  <Trans>Remove</Trans>
                </Button>
              </li>
            ))}
          </ul>
        )}
        {showDetails && firstPhoto && (
          <CaptureSuggestion
            key={`${photos.map(({ key }) => key).join(',')}:${destination?.id ?? ''}`}
            connection={connection}
            files={photos.map(({ file }) => file)}
            locationId={destination?.locationId}
            provider={provider}
            onProviderChange={setProvider}
            onDetails={(items) => setDetails({ photoKey, items })}
            onProposals={destination && onReview ? reviewPhoto : undefined}
            online={online}
            disabled={busy || !photoPreferenceLoaded}
          />
        )}
        {showDetails && shownDetails && (
          <DetailSuggestions
            key={photoKey}
            rows={
              leadSuggestion(shownDetails)
                ? detailRowsFor(
                    leadSuggestion(shownDetails) as PhotoSuggestion,
                    { name, quantity, note, tags },
                    categoryOptions,
                    online && !!captureLocation && captureLocation.role !== 'viewer',
                  )
                : []
            }
            others={Math.max(0, shownDetails.length - 1)}
            disabled={busy}
            onApply={(rows) => void applyDetails(rows)}
            onDismiss={() => setDetails(undefined)}
            onReviewItems={
              destination && onReview ? () => void reviewPhoto(shownDetails) : undefined
            }
          />
        )}
        {showDetails && firstPhoto && onReview && (
          <Button
            variant="secondary"
            isDisabled={busy || !destination}
            onPress={() => void reviewPhoto()}
          >
            <Trans>Review multiple items</Trans>
          </Button>
        )}
        {showDetails && (
          <Select
            label={t`Action`}
            selectedKey={intent}
            isDisabled={busy}
            items={[
              { id: 'record', label: t`Record existing contents` },
              { id: 'add', label: t`Add contents` },
            ]}
            onSelectionChange={(key) => setIntent(key === 'add' ? 'add' : 'record')}
          >
            {(option) => <SelectItem id={option.id}>{option.label}</SelectItem>}
          </Select>
        )}
        {showDetails && account && (
          <CategoryPicker
            key={account}
            connection={connection}
            accountId={account}
            online={online}
            canCreate={captureLocation.role !== 'viewer'}
            options={categoryOptions}
            selected={tags}
            disabled={busy}
            onChange={setTags}
          />
        )}
        {showLabels && (
          <p className="text-small text-ink-2">
            <Trans>Your item gets a QR code when it syncs. You can print it later.</Trans>
          </p>
        )}
        {showLabels && destination && captureLocation && captureLocation.role !== 'viewer' && (
          <ItemLabelPicker
            key={`${labelSession}:${destination.locationId}`}
            connection={connection}
            cache={cache}
            locationId={destination.locationId}
            itemName={name}
            online={online}
            value={claimCode ? label : undefined}
            blankTag={labelSession === 0 ? blankTag : undefined}
            onChange={setLabel}
            onBusyChange={setLabelBusy}
            disabled={busy}
          />
        )}
        {showDetails && (
          <details className="kept-details">
            <summary>
              <Trans>Details</Trans>
            </summary>
            <div className="grid gap-4 pt-3">
              <TextField
                label={t`Quantity (optional)`}
                value={quantity}
                onChange={setQuantity}
                isDisabled={busy}
                isInvalid={quantityInvalid}
                errorMessage={quantityInvalid ? t`Enter a quantity greater than zero.` : undefined}
                inputProps={{ inputMode: 'decimal', maxLength: 17 }}
              />
              <AriaTextField
                className="grid gap-1"
                value={note}
                onChange={setNote}
                isDisabled={busy}
              >
                <Label className="text-small font-semibold">
                  <Trans>Notes</Trans>
                </Label>
                <TextArea className={inputClass} maxLength={500} rows={3} />
              </AriaTextField>
            </div>
          </details>
        )}
        {!evidenceOnly && step === 'photos' && (
          <Button onPress={() => goToStep('details')}>
            {files.length ? <Trans>Continue</Trans> : <Trans>Add manually</Trans>}
          </Button>
        )}
        {showDetails && !blankTagWaiting && (
          <Button type="submit" isPending={busy} isDisabled={!canSave}>
            <Check size={18} aria-hidden />
            <Trans>Save item</Trans>
          </Button>
        )}
        {showDetails && (
          <Button
            type={blankTagWaiting ? 'submit' : 'button'}
            variant={blankTagWaiting ? 'primary' : 'secondary'}
            isDisabled={!canSave || busy}
            onPress={blankTagWaiting ? undefined : () => goToStep('label')}
          >
            <Trans>Continue to labels</Trans>
          </Button>
        )}
        {(evidenceOnly || showLabels) && (
          <Button type="submit" isPending={busy} isDisabled={!canSave || labelBusy}>
            <Check size={18} aria-hidden />
            {locationPhoto
              ? t`Save location photo`
              : photosOnly
                ? t`Save photos`
                : documentsOnly
                  ? t`Save documents`
                  : claimCode
                    ? t`Save item`
                    : t`Skip NFC and save`}
          </Button>
        )}
      </form>
      <p role="status" className="text-ink-2">
        {status}
      </p>
    </section>
  );
}

export function NewBoxForm({
  connection,
  cache,
  place,
  suggested,
  onClose,
  onCreated,
  onAdded,
  headerExtra,
}: {
  connection: Connection;
  cache: InventoryCache;
  place?: Destination;
  /** Where Add starts when no place was given (the place or box added to last, else Unplaced). */
  suggested?: Destination;
  onClose: () => void;
  onCreated: (id: string, locationId: string) => void;
  onAdded?: (destination: Destination) => void;
  headerExtra?: ReactNode;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const [name, setName] = useState('');
  const [target, setTarget] = useState<Destination | undefined>(() =>
    place ? { ...place, kind: place.kind ?? 'place' } : (suggested ?? defaultDestination(cache)),
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  async function submit() {
    if (!target || busy) return;
    setBusy(true);
    setStatus('');
    try {
      const result = await createBox(connection, cache, target, name.trim() || t`Box`, adapters);
      onAdded?.(target);
      onCreated(result.id, result.locationId);
    } catch {
      setStatus(t`Could not create the box. Check your connection and selected location.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-4">
      <ScreenHeader
        title={<Trans>Create a box</Trans>}
        onBack={onClose}
        backDisabled={busy}
        icon={<Package size={18} aria-hidden />}
      />
      {headerExtra}
      <form
        className="kept-card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={t`Box name (optional)`}
          value={name}
          onChange={setName}
          inputProps={{ maxLength: 200 }}
          isDisabled={busy}
        />
        <DestinationPicker
          connection={connection}
          online={true}
          cache={cache}
          value={target}
          onChange={setTarget}
          disabled={busy}
        />
        <Button type="submit" isPending={busy} isDisabled={!target}>
          <Plus size={18} aria-hidden />
          <Trans>Create box</Trans>
        </Button>
      </form>
      <p role="status" className="text-ink-2">
        {status}
      </p>
    </section>
  );
}
