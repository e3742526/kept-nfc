import { AMOUNT_STRING, newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { Camera, Check, FileText, Images, MapPin, Package, Plus, Trash2 } from 'lucide-react';
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { TextField as AriaTextField, FileTrigger, Label, TextArea } from 'react-aria-components';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { inputClass } from '@/components/ui/field';
import { Select, SelectItem } from '@/components/ui/select';
import { TextField } from '@/components/ui/text-field';
import { sep, useBytes } from '@/lib/format';
import { usePlatform } from './adapters';
import { ScreenHeader } from './back-button';
import { type CompletionState, type Connection, StorageFullError } from './bridge';
import { type Destination, DestinationPicker, defaultDestination } from './destination';
import { createBox, type InventoryCache, inventoryPath } from './inventory';
import { mobileFileLimit, type PendingCapture, type SelectedOriginal, saveOnPhone } from './outbox';

type ChosenFile = SelectedOriginal & { key: string; previewUrl?: string };

/** Where the item goes, as `Room › Box` (the location name is left to the picker). */
function destinationLabel(cache: InventoryCache, destination: Destination): string {
  const row = [...cache.places, ...cache.things].find((entry) => entry.id === destination.id);
  return row
    ? [...inventoryPath(cache, row).slice(1), destination.name].join(' › ')
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
  suggested,
  pending = [],
  completions = {},
  syncing = false,
  leaveRef,
  onClose,
  onSave,
}: {
  connection: Connection;
  box?: Destination;
  location?: string;
  cache?: InventoryCache;
  /** Description prefilled from a search that found nothing. */
  initialName?: string;
  /** Where the next item most likely goes (the box used last); the picker changes it. */
  suggested?: Destination;
  pending?: readonly PendingCapture[];
  /** Durable terminal states; only `synced` counts as synchronized. */
  completions?: Readonly<Record<string, CompletionState>>;
  syncing?: boolean;
  leaveRef: Ref<() => Promise<boolean>>;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const confirm = useConfirm();
  const formatBytes = useBytes();
  const [destination, setDestination] = useState(
    () => box ?? suggested ?? (cache && defaultDestination(cache)),
  );
  const [changingDestination, setChangingDestination] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const photosOnly = destination?.kind === 'photos';
  const documentsOnly = destination?.kind === 'documents';
  const evidenceOnly = photosOnly || documentsOnly;
  const [intent, setIntent] = useState<'record' | 'add'>('record');
  const [batchId] = useState(newId);
  const [name, setName] = useState(initialName);
  const [note, setNote] = useState('');
  const [quantity, setQuantity] = useState('');
  const [files, setFiles] = useState<ChosenFile[]>([]);
  const [batchEntryIds, setBatchEntryIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const previewUrlsRef = useRef<string[]>([]);

  async function canLeave() {
    if (busy) return false;
    if (!name && !note && !quantity && !files.length) return true;
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

  function choose(source: FileList | null, role: SelectedOriginal['role']) {
    if (!source) return;
    const items = Array.from(source);
    if (
      items.some((file) => file.size === 0 || file.size > mobileFileLimit) ||
      files.length + items.length > 20
    ) {
      setStatus(t`Choose up to 20 files, each no larger than 25 MB.`);
      return;
    }
    setStatus('');
    const next: ChosenFile[] = items.map((file) => {
      const previewUrl = role === 'photo' ? createPreviewUrl(file) : undefined;
      if (previewUrl) previewUrlsRef.current.push(previewUrl);
      return { file, role, key: newId(), ...(previewUrl ? { previewUrl } : {}) };
    });
    setFiles((current) => [...current, ...next]);
  }

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
          name: evidenceOnly ? destination.name : name.trim(),
          ...(!evidenceOnly ? { captureIntent: intent } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(quantity ? { quantity } : {}),
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
      setFiles([]);
      setStatus(t`Saved on device.`);
      onSave();
      setTimeout(() =>
        formRef.current?.querySelector<HTMLInputElement>('input[name=name]')?.focus(),
      );
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

  const headerTitle = photosOnly
    ? t`Record photos`
    : documentsOnly
      ? t`Add documents`
      : box && box.kind !== 'place'
        ? t`Adding to box`
        : t`Capture inventory`;

  return (
    <section className="grid gap-4">
      <ScreenHeader
        title={headerTitle}
        onBack={() => {
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
      {box && (
        <header className="kept-card">
          <div className="flex items-start gap-3">
            <span className="kept-row-lead" aria-hidden>
              {box.kind === 'place' ? <MapPin size={18} /> : <Package size={18} />}
            </span>
            <div className="grid min-w-0 gap-0.5">
              <h3 className="text-body font-semibold">
                <bdi>{box.name}</bdi>
              </h3>
              {location && (
                <p className="text-small text-ink-2">
                  <bdi>{location}</bdi>
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
        ref={formRef}
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {!evidenceOnly && (
          <TextField
            label={t`Description`}
            placeholder={t`Holiday decorations`}
            value={name}
            onChange={setName}
            isDisabled={busy}
            inputProps={{
              maxLength: 200,
              name: 'name',
              autoFocus: !initialName,
              enterKeyHint: 'done',
            }}
          />
        )}
        <div className="kept-media-bar">
          {!documentsOnly && (
            <>
              <FileTrigger
                acceptedFileTypes={['image/*']}
                defaultCamera="environment"
                onSelect={(list) => choose(list, 'photo')}
              >
                <Button variant="secondary" className="kept-media-btn" isDisabled={busy}>
                  <Camera size={20} aria-hidden />
                  <Trans>Take a photo</Trans>
                </Button>
              </FileTrigger>
              <FileTrigger
                acceptedFileTypes={['image/*']}
                allowsMultiple
                onSelect={(list) => choose(list, 'photo')}
              >
                <Button variant="secondary" className="kept-media-btn" isDisabled={busy}>
                  <Images size={20} aria-hidden />
                  <Trans>Choose photos</Trans>
                </Button>
              </FileTrigger>
            </>
          )}
          {!photosOnly && (
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
        {files.length > 0 && (
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
        {cache && !box && (
          <div className="grid gap-2">
            {destination && !changingDestination ? (
              <div className="kept-card kept-destination">
                <span className="kept-row-lead" aria-hidden>
                  {destination.kind === 'place' ? <MapPin size={18} /> : <Package size={18} />}
                </span>
                <div className="grid min-w-0 flex-1 gap-0.5">
                  <span className="text-small text-ink-2">
                    <Trans>Destination</Trans>
                  </span>
                  <bdi className="font-semibold">{destinationLabel(cache, destination)}</bdi>
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
                  cache={cache}
                  value={destination}
                  onChange={setDestination}
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
          </div>
        )}
        {!evidenceOnly && (
          <details className="kept-details">
            <summary>
              <Trans>Details</Trans>
            </summary>
            <div className="grid gap-4 pt-3">
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
        <Button type="submit" isPending={busy} isDisabled={!canSave}>
          <Check size={18} aria-hidden />
          {photosOnly
            ? t`Save photos`
            : documentsOnly
              ? t`Save documents`
              : box && box.kind !== 'place'
                ? t`Save to box`
                : t`Save capture`}
        </Button>
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
  onClose,
  onCreated,
}: {
  connection: Connection;
  cache: InventoryCache;
  place?: { id: string; name: string; locationId: string };
  onClose: () => void;
  onCreated: (id: string, locationId: string) => void;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const [name, setName] = useState('');
  const [target, setTarget] = useState<Destination | undefined>(() =>
    place ? { ...place, kind: 'place' } : defaultDestination(cache),
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  async function submit() {
    if (!target || busy) return;
    setBusy(true);
    setStatus('');
    try {
      const result = await createBox(connection, cache, target, name.trim() || t`Box`, adapters);
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
          cache={cache}
          value={target}
          onChange={setTarget}
          disabled={busy}
          placesOnly
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
