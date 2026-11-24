import { newId } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Archive,
  ArrowRightLeft,
  Camera,
  CheckCheck,
  ChevronRight,
  Clock,
  Compass,
  Ellipsis,
  FileText,
  History,
  Image,
  Layers,
  MapPin,
  Package,
  Pencil,
  Plus,
  QrCode,
  Radar,
  RotateCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { capturePaths } from '@/api/capture/paths';
import type {
  BoxCheckBody,
  ExtractionsResponse,
  InboxItem,
  InboxPage,
  Suggestion,
} from '@/api/capture/types';
import { ApiError } from '@/api/client';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type {
  AttachmentView,
  Page,
  PlaceView,
  ThingRow,
  ThingView,
  UpdateAttachmentBody,
} from '@/api/inventory/types';
import { useErrorText } from '@/components/page';
import { PhotoImage } from '@/components/photo-image';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, Modal } from '@/components/ui/dialog';
import { TextField } from '@/components/ui/text-field';
import { useFormat } from '@/lib/format';
import { usePlatform } from './adapters';
import { ScreenHeader } from './back-button';
import type { Connection } from './bridge';
import { CategoryPicker } from './category-picker';
import { CustomFieldDetails } from './custom-fields';
import type { Destination } from './destination';
import { EditRecord } from './edit-record';
import {
  type InventoryCache,
  inventoryPath,
  loadDetail,
  loadPlace,
  pendingForRecord,
  previewUrl,
  type RecordDetail,
} from './inventory';
import type { LabelBox } from './label-panel';
import type { Target } from './labels';
import { draftFields, isAuthRefusal, isRestoreEpochMismatch, type PendingCapture } from './outbox';
import { RecordHistory } from './record-history';

export type OpenBox = Destination & LabelBox;

function formatSuggestionValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((entry) =>
        entry && typeof entry === 'object' && 'name' in entry ? String(entry.name) : String(entry),
      )
      .join(', ');
  }
  return '';
}

function SuggestionForm({
  connection,
  thing,
  onChanged,
  onAuthError,
}: {
  connection: Connection;
  thing: ThingView;
  onChanged: () => void;
  onAuthError?: (reason: 'expired' | 'restored') => void;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const errorText = useErrorText();
  const [review, setReview] = useState<InboxItem>();
  const [edit, setEdit] = useState('');
  const [extraSuggestions, setExtraSuggestions] = useState<Suggestion[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    setStatus('');
    try {
      const result = await adapters.transport.request<InboxPage>(
        connection,
        `${capturePaths.inbox}${qs({ locationId: thing.locationId, kind: 'draft', limit: 100 })}`,
      );
      const item = result.items.find(
        (entry) => entry.thing?.id === thing.id && (entry.suggestions?.length ?? 0) > 0,
      );
      const name = item?.suggestions?.find((part) => part.field === 'name')?.value;
      if (item && (typeof name === 'string' || (item.suggestions?.length ?? 0) > 0)) {
        setEdit(typeof name === 'string' ? name : (thing.name ?? ''));
        setExtraSuggestions((item.suggestions ?? []).filter((part) => part.field !== 'name'));
        setReview(item);
      } else {
        const attempts = await adapters.transport.request<ExtractionsResponse>(
          connection,
          capturePaths.thingExtractions(thing.id),
        );
        const state = attempts.items[0]?.status;
        setStatus(
          state === 'queued' ||
            state === 'running' ||
            state === 'waiting_provider' ||
            state === 'paused_budget'
            ? t`AI suggestions are still waiting. Your entry is saved.`
            : t`There are no AI suggestions to review. Your entry is saved.`,
        );
      }
    } catch (error) {
      if (isAuthRefusal(error)) {
        onAuthError?.('expired');
        return;
      }
      if (isRestoreEpochMismatch(error)) {
        onAuthError?.('restored');
        return;
      }
      setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function decide(useEdit: boolean) {
    if (!review) return;
    setBusy(true);
    setStatus('');
    try {
      const suggestionFields = (review.suggestions ?? []).map((entry) => entry.field);
      await adapters.transport.request(connection, capturePaths.inboxAccept(review.id), {
        method: 'POST',
        ifMatch: review.rowVersion,
        body: {
          reject: suggestionFields,
          ...(useEdit ? { set: { name: edit.trim() } } : {}),
        },
      });
      setReview(undefined);
      setExtraSuggestions([]);
      onChanged();
    } catch (error) {
      if (isAuthRefusal(error)) {
        onAuthError?.('expired');
        return;
      }
      if (isRestoreEpochMismatch(error)) {
        onAuthError?.('restored');
        return;
      }
      setStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-3 rounded-lg border border-line bg-surface p-4">
      {review ? (
        <>
          <TextField
            label={t`Suggested description`}
            value={edit}
            onChange={setEdit}
            inputProps={{ maxLength: 200 }}
            isDisabled={busy}
          />
          {extraSuggestions.length > 0 && (
            <ul className="grid gap-1 text-small text-ink-2">
              {extraSuggestions.map((part) => {
                const formatted = formatSuggestionValue(part.value);
                if (!formatted) return null;
                return (
                  <li key={`${part.field}-${part.source.extractionId}`}>
                    <bdi>
                      {part.field}: {formatted}
                    </bdi>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button isPending={busy} isDisabled={!edit.trim()} onPress={() => void decide(true)}>
              <Trans>Use this description</Trans>
            </Button>
            <Button variant="secondary" isDisabled={busy} onPress={() => void decide(false)}>
              <Trans>Keep my description</Trans>
            </Button>
          </div>
        </>
      ) : (
        <Button variant="secondary" isPending={busy} onPress={() => void check()}>
          <Sparkles size={16} aria-hidden />
          <Trans>Check AI suggestions</Trans>
        </Button>
      )}
      {status && (
        <p className="text-ink-2" role="status">
          {status}
        </p>
      )}
    </section>
  );
}

export function RecordScreen({
  connection,
  cache,
  target,
  pending = [],
  syncing = false,
  online = true,
  onClose,
  onOpen,
  onCreateBox,
  onCapture,
  onLabel,
  onCache,
  onInventoryChanged,
  onAuthError,
}: {
  connection: Connection;
  cache: InventoryCache | undefined;
  target: Target;
  pending?: readonly PendingCapture[];
  syncing?: boolean;
  online?: boolean;
  onClose: () => void;
  onOpen: (target: Target) => void;
  onCreateBox: () => void;
  onCapture: (destination: Destination, location: string) => void;
  onLabel: (mode: 'find' | 'enroll', box: OpenBox) => void;
  onCache: (detail: RecordDetail) => void;
  onInventoryChanged: () => void;
  onAuthError?: (reason: 'expired' | 'restored') => void;
}) {
  const { t } = useLingui();
  const adapters = usePlatform();
  const errorText = useErrorText();
  const confirm = useConfirm();
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof loadDetail>>>();
  const [place, setPlace] = useState<PlaceView>();
  const [unavailable, setUnavailable] = useState(false);
  const [cachedNotice, setCachedNotice] = useState(false);
  const [status, setStatus] = useState('');
  const [request, setRequest] = useState(0);
  const [openingMedia, setOpeningMedia] = useState<string>();
  const [editor, setEditor] = useState<'edit' | 'move' | 'correct' | 'actions'>();
  const [section, setSection] = useState<'all' | 'contents' | 'media' | 'history'>('all');
  const [editingFiles, setEditingFiles] = useState(false);
  const [photoDialog, setPhotoDialog] = useState<AttachmentView>();
  const [photoNotice, setPhotoNotice] = useState('');
  const [archivedPhotos, setArchivedPhotos] = useState<Page<AttachmentView>>();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [changing, setChanging] = useState(false);
  const [categorizing, setCategorizing] = useState(false);
  const [checkId, setCheckId] = useState(newId);
  const [childRows, setChildRows] = useState<ThingRow[]>([]);
  const describe = useRef(errorText);
  const format = useFormat();
  describe.current = errorText;
  const authErrorRef = useRef(onAuthError);
  authErrorRef.current = onAuthError;
  const cached =
    target.kind === 'thing'
      ? cache?.things.find((item) => item.id === target.id)
      : cache?.places.find((item) => item.id === target.id);

  const boxPending = pendingForRecord(pending, target.id);
  const pendingCount = boxPending.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload after local writes and outbox completion.
  useEffect(() => {
    let current = true;
    setCachedNotice(false);
    if (target.kind === 'thing') {
      void loadDetail(connection, target.id, adapters)
        .then((next) => {
          if (!current) return;
          setUnavailable(false);
          setCachedNotice(false);
          setDetail(next);
          setStatus('');
          onCache({
            id: next.thing.id,
            notes: next.thing.notes,
            attachments: next.attachments.map(({ id, name, role }) =>
              name === undefined ? { id, role } : { id, name, role },
            ),
          });
        })
        .catch(failed);
    } else {
      void loadPlace(connection, target.id, adapters)
        .then((next) => {
          if (!current) return;
          setUnavailable(false);
          setCachedNotice(false);
          setPlace(next);
          setStatus('');
        })
        .catch(failed);
    }
    function failed(error: unknown) {
      if (!current) return;
      if (isAuthRefusal(error)) {
        authErrorRef.current?.('expired');
        return;
      }
      if (isRestoreEpochMismatch(error)) {
        authErrorRef.current?.('restored');
        return;
      }
      if (error instanceof ApiError) {
        if ([403, 404, 409].includes(error.status)) {
          setDetail(undefined);
          setPlace(undefined);
          setUnavailable(true);
          setStatus(describe.current(error));
          return;
        }
        if (error.status === 0 && cached) {
          setCachedNotice(true);
          setStatus('');
          return;
        }
      }
      setStatus(describe.current(error));
    }
    return () => {
      current = false;
    };
  }, [adapters, connection, onCache, online, pendingCount, request, target]);

  const thing = detail?.thing;
  const row = thing ?? place ?? cached;
  const name = row?.name ?? t`Untitled`;
  const currentLocation = cache?.locations.find((location) => location.id === target.locationId);
  const locationName = currentLocation?.name;
  const path =
    row && 'path' in row
      ? [locationName, ...row.path.map((step) => step.name)].filter(Boolean).join(' › ')
      : cached && cache
        ? inventoryPath(cache, cached).join(' › ')
        : '';
  const children =
    cache?.things.filter((item) =>
      target.kind === 'thing'
        ? item.containerId === target.id
        : item.placeId === target.id && !item.containerId,
    ) ?? [];
  const childPlaces =
    target.kind === 'place'
      ? (cache?.places.filter((item) => item.parentId === target.id) ?? [])
      : [];
  const categoryTags =
    thing?.tags ??
    (cached && 'tagIds' in cached
      ? cache?.tags?.filter(({ id }) => cached.tagIds?.includes(id))
      : undefined) ??
    [];
  const canEdit = cache?.locations.some(
    (location) => location.id === target.locationId && location.role !== 'viewer',
  );
  const card = cache?.details[target.id];
  const notes = detail ? thing?.notes : card?.notes;
  const remoteAttachments =
    detail?.attachments ??
    place?.attachments.filter((attachment) => !attachment.locationPhotoTakenAt);
  const attachments = remoteAttachments ?? card?.attachments ?? [];
  const locationPhotos =
    detail?.locationPhotos ??
    place?.attachments
      .filter((attachment) => attachment.locationPhotoTakenAt)
      .sort((a, b) => (b.locationPhotoTakenAt ?? '').localeCompare(a.locationPhotoTakenAt ?? '')) ??
    [];
  const box =
    row && 'isContainer' in row && row.isContainer
      ? { id: row.id, name, locationId: row.locationId, shortCode: row.shortCode }
      : null;
  // An item that is not a box can have its own QR or NFC label too (a valuable item).
  const labelledItem =
    !box && target.kind === 'thing' && row && 'shortCode' in row && row.shortCode
      ? {
          id: row.id,
          name,
          locationId: row.locationId,
          shortCode: row.shortCode,
          isContainer: false,
        }
      : null;

  const browsable = !!box || target.kind === 'place';
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh thumbnails after record mutations.
  useEffect(() => {
    if (!online || !browsable) return;
    let current = true;
    const filter = target.kind === 'place' ? { placeId: target.id } : { containerId: target.id };
    void adapters.transport
      .request<Page<ThingRow>>(connection, inventoryPaths.things + qs({ ...filter, limit: 100 }))
      .then((page) => {
        if (current) setChildRows(page.items);
      })
      .catch((error: unknown) => {
        if (!current) return;
        setChildRows([]);
        if (isAuthRefusal(error)) authErrorRef.current?.('expired');
        else if (isRestoreEpochMismatch(error)) authErrorRef.current?.('restored');
      });
    return () => {
      current = false;
    };
  }, [adapters, browsable, connection, online, request, target]);

  function changed() {
    setEditor(undefined);
    setRequest((value) => value + 1);
    onInventoryChanged();
  }

  async function update(work: () => Promise<void>) {
    if (changing) return;
    setChanging(true);
    setStatus('');
    try {
      await work();
    } catch (error) {
      if (isAuthRefusal(error)) onAuthError?.('expired');
      else if (isRestoreEpochMismatch(error)) onAuthError?.('restored');
      else setStatus(errorText(error));
    } finally {
      setChanging(false);
    }
  }

  function checkContents() {
    if (!box) return;
    const id = box.id;
    const body: BoxCheckBody = {
      id: checkId,
      unchanged: true,
      lines: children.map((child) => ({
        thingId: child.id,
        expectedQty: child.quantity,
        foundQty: child.quantity,
      })),
    };
    return update(async () => {
      if (
        !(await confirm({
          title: t`Confirm contents unchanged?`,
          body: t`Confirm that you checked every listed entry in this bin.`,
          confirmLabel: t`Confirm`,
          cancelLabel: t`Cancel`,
        }))
      )
        return;
      await adapters.transport.request(connection, capturePaths.thingBoxCheck(id), {
        method: 'POST',
        body,
        idempotencyKey: checkId,
      });
      setCheckId(newId());
      changed();
    });
  }

  function removeAttachment(attachment: AttachmentView) {
    return update(async () => {
      if (
        !(await confirm({
          title: t`Remove this attachment?`,
          confirmLabel: t`Remove`,
          cancelLabel: t`Cancel`,
          destructive: true,
        }))
      )
        return;
      await adapters.transport.request(connection, inventoryPaths.attachment(attachment.id), {
        method: 'DELETE',
      });
      changed();
    });
  }

  async function loadArchive(cursor?: string) {
    setArchiveLoading(true);
    if (!cursor) setArchivedPhotos(undefined);
    try {
      const endpoint =
        target.kind === 'thing' ? inventoryPaths.thingAttachments : inventoryPaths.placeAttachments;
      const page = await adapters.transport.request<Page<AttachmentView>>(
        connection,
        endpoint(target.id) + qs({ archivedPhotos: true, limit: 50, cursor }),
      );
      setArchivedPhotos((previous) =>
        cursor && previous ? { ...page, items: [...previous.items, ...page.items] } : page,
      );
    } finally {
      setArchiveLoading(false);
    }
  }

  function changePhoto(attachment: AttachmentView, body: UpdateAttachmentBody) {
    return update(async () => {
      const saved = await adapters.transport.request<AttachmentView>(
        connection,
        inventoryPaths.attachment(attachment.id),
        { method: 'PATCH', ifMatch: attachment.rowVersion, body },
      );
      if (body.photoArchived === undefined) {
        setPhotoDialog((current) => (current?.id === saved.id ? saved : current));
      } else {
        setPhotoDialog(undefined);
        setPhotoNotice(body.photoArchived ? t`Photo archived.` : t`Photo restored.`);
      }
      changed();
      if (archiveOpen && body.photoArchived !== undefined) await loadArchive();
    });
  }

  async function openRemoteFile(
    attachment: Pick<AttachmentView, 'id' | 'file'>,
    variant: 'display' | 'original',
  ) {
    if (!attachment.file || openingMedia !== undefined) return;
    setOpeningMedia(`${attachment.id}:${variant}`);
    setStatus('');
    try {
      await adapters.media.openRemote(connection, {
        ...(target.kind === 'thing' ? { thing: target.id } : {}),
        file: attachment.file.id,
        mime: attachment.file.mime,
        ...(variant === 'display' ? { variant } : {}),
      });
    } catch (error) {
      if (isAuthRefusal(error)) {
        onAuthError?.('expired');
        return;
      }
      if (isRestoreEpochMismatch(error)) {
        onAuthError?.('restored');
        return;
      }
      setStatus(errorText(error));
    } finally {
      setOpeningMedia(undefined);
    }
  }

  async function openPendingFile(draftId: string, fileId: string) {
    const key = `${draftId}:${fileId}`;
    setOpeningMedia(key);
    setStatus('');
    try {
      await adapters.media.openPending(connection, { id: draftId, file: fileId });
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      setOpeningMedia(undefined);
    }
  }

  const unknown = thing?.locationUncertain && thing.path.some((step) => step.isUnplaced);
  const cover = online && previewUrl(thing?.thumbUrl, connection.origin);
  const coverPhoto =
    remoteAttachments?.find(({ id }) => id === thing?.thumbnailAttachmentId) ??
    thing?.photos?.find(({ id }) => id === thing.thumbnailAttachmentId);
  const photoDialogSrc = previewUrl(
    photoDialog?.file?.displayUrl ?? photoDialog?.file?.thumbUrl,
    connection.origin,
  );
  const photoDialogLabel = photoDialog?.name ?? t`Photograph`;
  const showContents = section === 'all' || section === 'contents';
  const showMedia = section === 'all' || section === 'media';
  const showHistory = section === 'all' || section === 'history';
  const hasSections =
    browsable ||
    attachments.length > 0 ||
    locationPhotos.length > 0 ||
    (online && Boolean(thing || place));
  return (
    <section className="grid gap-4">
      <ScreenHeader
        onBack={onClose}
        icon={
          target.kind === 'place' ? (
            <MapPin size={18} aria-hidden />
          ) : (
            <Package size={18} aria-hidden />
          )
        }
      />
      {unavailable || !row ? (
        <p role="status">{status || t`Opening inventory…`}</p>
      ) : (
        <>
          <header className="kept-card">
            {cover &&
              (coverPhoto ? (
                <Button
                  variant="ghost"
                  aria-label={t`Cover photo`}
                  className="w-full border-0 p-0"
                  onPress={() => {
                    setStatus('');
                    setPhotoDialog(coverPhoto);
                  }}
                >
                  <PhotoImage
                    src={cover}
                    rotation={thing?.thumbnailRotation}
                    className="aspect-video max-h-48 w-full rounded-lg"
                    loading="eager"
                  />
                </Button>
              ) : (
                <PhotoImage
                  src={cover}
                  rotation={thing?.thumbnailRotation}
                  className="aspect-video max-h-48 w-full rounded-lg"
                  loading="eager"
                />
              ))}
            <h2 className="text-display font-semibold">
              <bdi>{name}</bdi>
            </h2>
            {path && (
              <p className="flex items-start gap-1.5 text-small text-ink-2">
                <MapPin size={15} className="mt-0.5 shrink-0" aria-hidden />
                <span>
                  {unknown ? (
                    <>
                      <Trans>Location unknown</Trans>{' '}
                    </>
                  ) : (
                    'locationUncertain' in row &&
                    row.locationUncertain && (
                      <>
                        <Trans>Last known location</Trans>{' '}
                      </>
                    )
                  )}
                  <bdi>{path}</bdi>
                </span>
              </p>
            )}
            {unknown && !!thing?.lastKnownPath?.length && (
              <p className="text-small text-ink-2">
                <Trans>Last known location</Trans>{' '}
                <bdi>{[locationName, ...thing.lastKnownPath].filter(Boolean).join(' › ')}</bdi>
              </p>
            )}
            <div className="kept-chips">
              {'shortCode' in row && row.shortCode && (
                <span className="kept-chip">
                  <QrCode size={13} aria-hidden />
                  <span className="sr-only">
                    <Trans>Label code:</Trans>{' '}
                  </span>
                  <bdi className="ltr">{row.shortCode}</bdi>
                </span>
              )}
              {'quantity' in row && Number(row.quantity) !== 1 && (
                <span className="kept-chip">
                  <Layers size={13} aria-hidden />
                  <span>{t`Quantity: ${row.quantity}`}</span>
                </span>
              )}
              {'lastSeenAt' in row && row.lastSeenAt && (
                <span className="kept-chip">
                  <Clock size={13} aria-hidden />
                  <span>{t`Last recorded activity: ${new Date(row.lastSeenAt).toLocaleString()}`}</span>
                </span>
              )}
            </div>
            {(cachedNotice || (!online && !detail && !place)) && cache && (
              <p className="text-small text-ink-2" role="status">
                {t`Showing cached details from ${new Date(cache.asOf).toLocaleString()}`}
              </p>
            )}
          </header>
          {box && (
            <div className="flex flex-wrap gap-2">
              {canEdit && (
                <Button onPress={() => onCapture(box, path)}>
                  <Plus size={16} aria-hidden />
                  <Trans>Add to this box</Trans>
                </Button>
              )}
              <Button variant="secondary" onPress={() => onLabel('find', box)}>
                <Radar size={16} aria-hidden />
                <Trans>Find this box</Trans>
              </Button>
              {box.shortCode && (
                <Button variant="secondary" onPress={() => onLabel('enroll', box)}>
                  <QrCode size={16} aria-hidden />
                  {canEdit ? <Trans>QR and NFC label</Trans> : <Trans>View QR label</Trans>}
                </Button>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {canEdit && target.kind === 'place' && (
              <Button onPress={() => onCapture({ ...target, name, kind: 'place' }, path)}>
                <Plus size={16} aria-hidden />
                <Trans>Add to this room</Trans>
              </Button>
            )}
            {online && canEdit && place && !place.isUnplaced && (
              <Button variant="secondary" onPress={onCreateBox}>
                <Package size={16} aria-hidden />
                <Trans>Create box</Trans>
              </Button>
            )}
            {canEdit && target.kind === 'thing' && (
              <Button
                variant="secondary"
                onPress={() => onCapture({ ...target, name, kind: 'photos' }, path)}
              >
                <Camera size={16} aria-hidden />
                <Trans>Add photos</Trans>
              </Button>
            )}
            {canEdit && thing && (
              <Button
                variant="secondary"
                onPress={() => onCapture({ ...target, name, kind: 'documents' }, path)}
              >
                <FileText size={16} aria-hidden />
                <Trans>Add documents</Trans>
              </Button>
            )}
            {labelledItem && (
              <Button variant="secondary" onPress={() => onLabel('enroll', labelledItem)}>
                <QrCode size={16} aria-hidden />
                {canEdit ? <Trans>QR and NFC label</Trans> : <Trans>View QR label</Trans>}
              </Button>
            )}
            {online && canEdit && (thing || place) && (
              <>
                <Button variant="secondary" onPress={() => setEditor('edit')}>
                  <Pencil size={16} aria-hidden />
                  <Trans>Edit</Trans>
                </Button>
                {thing && (
                  <>
                    <Button variant="secondary" onPress={() => setEditor('move')}>
                      <ArrowRightLeft size={16} aria-hidden />
                      <Trans>Move</Trans>
                    </Button>
                    {editor === 'actions' && (
                      <Button variant="secondary" onPress={() => setEditor('correct')}>
                        <Compass size={16} aria-hidden />
                        <Trans>Correct location</Trans>
                      </Button>
                    )}
                    <Button variant="secondary" onPress={() => setEditor('actions')}>
                      <Ellipsis size={16} aria-hidden />
                      <Trans>More actions</Trans>
                    </Button>
                  </>
                )}
              </>
            )}
          </div>
          {editor && online && canEdit && cache && (
            <EditRecord
              key={editor}
              connection={connection}
              cache={cache}
              thing={thing}
              place={place}
              mode={editor}
              onClose={() => setEditor(undefined)}
              onChanged={changed}
              onMoved={(destination) => {
                changed();
                onOpen({ ...target, locationId: destination.locationId });
              }}
              onTrashed={() => {
                onInventoryChanged();
                onClose();
              }}
              onAuthError={onAuthError}
            />
          )}
          {section === 'all' && categoryTags.length > 0 && (!categorizing || !online) && (
            <ul aria-label={t`Categories`} className="flex flex-wrap gap-2">
              {categoryTags.map((tag) => (
                <li className="rounded-lg bg-sunken px-2 py-1" key={tag.id}>
                  <bdi>{tag.name}</bdi>
                </li>
              ))}
            </ul>
          )}
          {thing && section === 'all' && (
            <>
              <CustomFieldDetails
                thing={thing}
                connection={connection}
                attachments={detail?.attachments ?? []}
                online={online}
              />
              {canEdit && currentLocation?.ownerAccountId && (
                <>
                  <Button
                    variant="secondary"
                    aria-expanded={categorizing}
                    onPress={() => setCategorizing((current) => !current)}
                  >
                    <Trans>Categories</Trans>
                  </Button>
                  {categorizing &&
                    (online ? (
                      <CategoryPicker
                        key={thing.id}
                        connection={connection}
                        accountId={currentLocation.ownerAccountId}
                        online
                        canCreate
                        options={[
                          ...thing.tags,
                          ...(cache?.tags?.filter(
                            (tag) => tag.accountId === currentLocation.ownerAccountId,
                          ) ?? []),
                        ]}
                        selected={thing.tags.map(({ id }) => id)}
                        disabled={changing}
                        onChange={(ids) => {
                          const add = ids.filter((id) => !thing.tags.some((tag) => tag.id === id));
                          const remove = thing.tags
                            .filter(({ id }) => !ids.includes(id))
                            .map(({ id }) => id);
                          void update(async () => {
                            await adapters.transport.request(
                              connection,
                              inventoryPaths.thingsTags,
                              {
                                method: 'POST',
                                idempotencyKey: newId(),
                                body: { thingIds: [thing.id], add, remove },
                              },
                            );
                            changed();
                          });
                        }}
                      />
                    ) : (
                      <p>
                        <Trans>Needs a connection</Trans>
                      </p>
                    ))}
                </>
              )}
            </>
          )}
          {hasSections && (
            <fieldset className="kept-pill-bar m-0 border-0 p-0" aria-label={t`Filter`}>
              <Button
                variant="secondary"
                size="small"
                className="kept-pill"
                aria-pressed={section === 'all'}
                onPress={() => setSection('all')}
              >
                <Trans>All</Trans>
              </Button>
              {browsable && (
                <Button
                  variant="secondary"
                  size="small"
                  className="kept-pill"
                  aria-pressed={section === 'contents'}
                  onPress={() => setSection('contents')}
                >
                  <Package size={14} aria-hidden />
                  <Trans>Contents</Trans>
                </Button>
              )}
              {attachments.length > 0 && (
                <Button
                  variant="secondary"
                  size="small"
                  className="kept-pill"
                  aria-pressed={section === 'media'}
                  onPress={() => setSection('media')}
                >
                  <Image size={14} aria-hidden />
                  <Trans>Photos</Trans>
                </Button>
              )}
              {online && (thing || place) && (
                <Button
                  variant="secondary"
                  size="small"
                  className="kept-pill"
                  aria-pressed={section === 'history'}
                  onPress={() => setSection('history')}
                >
                  <History size={14} aria-hidden />
                  <Trans>History</Trans>
                </Button>
              )}
            </fieldset>
          )}
          {notes && section === 'all' && (
            <section className="kept-card">
              <h3 className="kept-card-title">
                <FileText size={16} aria-hidden />
                <Trans>Notes</Trans>
              </h3>
              <p className="whitespace-pre-wrap break-words text-ink-2">
                <bdi>{notes}</bdi>
              </p>
            </section>
          )}
          {boxPending.length > 0 && showContents && (
            <section className="kept-card">
              <h3 className="kept-card-title">
                <Clock size={16} aria-hidden />
                <Trans>Pending captures</Trans>
              </h3>
              <ul className="grid gap-2">
                {boxPending.map((entry) => {
                  const fields = draftFields(entry.capture);
                  return (
                    <li key={entry.capture.id} className="grid gap-2 rounded-lg bg-sunken p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <bdi className="font-semibold">
                          {fields.locationPhoto ? t`Location photo` : fields.name}
                        </bdi>
                        <span
                          className={
                            entry.failure
                              ? 'kept-badge kept-badge-danger'
                              : 'kept-badge kept-badge-warn'
                          }
                        >
                          {entry.failure
                            ? t`Needs attention`
                            : syncing
                              ? t`Syncing…`
                              : t`Saved on device`}
                        </span>
                      </div>
                      {fields.note && (
                        <p className="text-small text-ink-2">
                          <bdi>{fields.note}</bdi>
                        </p>
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
                                isPending={openingMedia === key}
                                isDisabled={openingMedia !== undefined && openingMedia !== key}
                                onPress={() => void openPendingFile(entry.capture.id, file.id)}
                              >
                                <bdi>{file.name}</bdi>
                              </Button>
                            );
                          })}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {showMedia && online && canEdit && attachments.length > 0 && (
            <Button
              variant="ghost"
              size="small"
              className="justify-self-start"
              onPress={() => setEditingFiles((value) => !value)}
            >
              <Pencil size={15} aria-hidden />
              {editingFiles ? t`Done` : t`Edit photos and files`}
            </Button>
          )}
          {showMedia &&
            (['location', 'photo', 'other'] as const).map((group) => {
              const locationGroup = group === 'location';
              const isPhoto = group !== 'other';
              const entries = locationGroup
                ? locationPhotos
                : attachments.filter((attachment) => (attachment.role === 'photo') === isPhoto);
              const canLogLocation = locationGroup && canEdit && target.kind === 'thing';
              if (!entries.length && !canLogLocation) return null;
              return (
                <section key={group} className="kept-card">
                  <h3 className="kept-card-title">
                    {locationGroup ? (
                      <MapPin size={16} aria-hidden />
                    ) : isPhoto ? (
                      <Image size={16} aria-hidden />
                    ) : (
                      <FileText size={16} aria-hidden />
                    )}
                    {locationGroup
                      ? t`Last logged location`
                      : isPhoto
                        ? t`Photos`
                        : t`Documents and files`}
                  </h3>
                  {canLogLocation && (
                    <>
                      <p className="text-small text-ink-2">
                        <Trans>
                          Take a photo of where you left this item. SheepKeep keeps the latest
                          three.
                        </Trans>
                      </p>
                      <Button
                        variant="secondary"
                        size="small"
                        onPress={() => onCapture({ ...target, name, kind: 'location-photo' }, path)}
                      >
                        <Camera size={16} aria-hidden />
                        <Trans>Add location photo</Trans>
                      </Button>
                    </>
                  )}
                  <ul
                    hidden={entries.length === 0}
                    className={isPhoto ? 'grid grid-cols-2 gap-2' : 'grid gap-2'}
                  >
                    {entries.map((attachment) => {
                      const label =
                        attachment.name ??
                        (locationGroup ? t`Location photo` : isPhoto ? t`Photograph` : t`Document`);
                      const original = (locationGroup ? locationPhotos : remoteAttachments)?.find(
                        (entry) => entry.id === attachment.id,
                      );
                      const takenAt = locationGroup
                        ? original?.locationPhotoTakenAt
                        : original?.createdAt;
                      const thumbnail =
                        online &&
                        isPhoto &&
                        previewUrl(original?.file?.thumbUrl, connection.origin);
                      const preview = isPhoto && Boolean(original?.file?.displayUrl);
                      const variant = preview ? 'display' : 'original';
                      const mediaKey = `${attachment.id}:${variant}`;
                      const originalKey = `${attachment.id}:original`;
                      const labelId = `attachment-label-${attachment.id}`;
                      const stampId =
                        locationGroup && takenAt
                          ? `location-photo-time-${attachment.id}`
                          : undefined;
                      return (
                        <li key={attachment.id}>
                          {original?.file && online && (preview || canEdit || !isPhoto) ? (
                            <Button
                              variant="secondary"
                              className={
                                isPhoto
                                  ? 'grid w-full min-w-0 justify-items-start gap-2 rounded-xl p-2 text-start'
                                  : 'kept-phone-row'
                              }
                              isPending={openingMedia === mediaKey}
                              isDisabled={openingMedia !== undefined && openingMedia !== mediaKey}
                              aria-describedby={stampId}
                              onPress={() => {
                                if (isPhoto && original.photoRotation) {
                                  setStatus('');
                                  setPhotoDialog(original);
                                } else {
                                  void openRemoteFile(original, variant);
                                }
                              }}
                            >
                              {thumbnail && (
                                <PhotoImage
                                  src={thumbnail}
                                  rotation={original.photoRotation}
                                  contain={locationGroup}
                                  className={
                                    locationGroup
                                      ? 'aspect-[4/3] w-full rounded-lg bg-sunken'
                                      : 'aspect-square w-full rounded-lg'
                                  }
                                />
                              )}
                              {!isPhoto && (
                                <span className="kept-row-lead" aria-hidden>
                                  <FileText size={18} />
                                </span>
                              )}
                              <bdi id={labelId} className="min-w-0 flex-1 break-all">
                                {label}
                              </bdi>
                            </Button>
                          ) : (
                            <span className="text-ink-2">
                              <bdi>{label}</bdi>
                            </span>
                          )}
                          {online && canEdit && preview && original && (
                            <Button
                              variant="ghost"
                              size="small"
                              aria-describedby={stampId ? `${labelId} ${stampId}` : labelId}
                              isPending={openingMedia === originalKey}
                              isDisabled={
                                openingMedia !== undefined && openingMedia !== originalKey
                              }
                              onPress={() => void openRemoteFile(original, 'original')}
                            >
                              <Trans>Open original photo</Trans>
                            </Button>
                          )}
                          {takenAt && (
                            <time
                              id={stampId}
                              dateTime={takenAt}
                              className="mt-1 block text-small text-ink-2"
                            >
                              {locationGroup
                                ? format.dateTime(takenAt)
                                : new Date(takenAt).toLocaleString()}
                            </time>
                          )}
                          {online &&
                            canEdit &&
                            isPhoto &&
                            original?.file?.mime.startsWith('image/') && (
                              <Button
                                variant="ghost"
                                size="small"
                                aria-describedby={labelId}
                                onPress={() => {
                                  setStatus('');
                                  setPhotoDialog(original);
                                }}
                              >
                                <Ellipsis size={15} aria-hidden />
                                <Trans>Photo options</Trans>
                              </Button>
                            )}
                          {!locationGroup && original && editingFiles && canEdit && online && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              <Button
                                variant="ghost"
                                size="small"
                                isDisabled={changing}
                                onPress={() => void removeAttachment(original)}
                              >
                                <Trash2 size={14} aria-hidden />
                                <Trans>Remove</Trans>
                              </Button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          {showMedia && online && canEdit && (thing || place) && (
            <section className={archiveOpen ? 'kept-card' : undefined}>
              <Button
                variant="ghost"
                size="small"
                aria-expanded={archiveOpen}
                className="justify-self-start"
                onPress={() => {
                  setArchiveOpen(!archiveOpen);
                  if (!archiveOpen) void update(loadArchive);
                }}
              >
                <Archive size={16} aria-hidden />
                {archiveOpen ? <Trans>Hide archived photos</Trans> : <Trans>Archived photos</Trans>}
              </Button>
              {archiveOpen && (
                <>
                  {archiveLoading && (
                    <p role="status">
                      <Trans>Loading archived photos…</Trans>
                    </p>
                  )}
                  {archivedPhotos &&
                    (archivedPhotos.items.length ? (
                      <ul className="grid grid-cols-2 gap-2">
                        {archivedPhotos.items.map((photo) => {
                          const src = previewUrl(photo.file?.thumbUrl, connection.origin);
                          return (
                            <li key={photo.id} className="min-w-0">
                              <Button
                                variant="secondary"
                                className="grid w-full min-w-0 justify-items-start gap-2 rounded-xl p-2 text-start"
                                onPress={() => {
                                  setStatus('');
                                  setPhotoDialog(photo);
                                }}
                              >
                                {src && (
                                  <PhotoImage
                                    src={src}
                                    rotation={photo.photoRotation}
                                    className="aspect-square w-full rounded-lg"
                                  />
                                )}
                                <bdi className="min-w-0 break-all">
                                  {photo.name ?? t`Photograph`}
                                </bdi>
                              </Button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="text-small text-ink-2">
                        <Trans>No archived photos.</Trans>
                      </p>
                    ))}
                  {archivedPhotos?.next_cursor && (
                    <Button
                      variant="secondary"
                      size="small"
                      isPending={archiveLoading}
                      onPress={() =>
                        void update(() => loadArchive(archivedPhotos.next_cursor ?? undefined))
                      }
                    >
                      <Trans>Show more</Trans>
                    </Button>
                  )}
                </>
              )}
            </section>
          )}
          {showContents && (box || target.kind === 'place') && (
            <section className="kept-card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="kept-card-title">
                  <Package size={16} aria-hidden />
                  <Trans>Contents</Trans>
                </h3>
                {box && online && canEdit && !cache?.truncated && children.length <= 500 && (
                  <Button
                    size="small"
                    variant="secondary"
                    isPending={changing}
                    onPress={() => void checkContents()}
                  >
                    <CheckCheck size={15} aria-hidden />
                    <Trans>Contents checked, unchanged</Trans>
                  </Button>
                )}
              </div>
              {children.length === 0 && childPlaces.length === 0 ? (
                <p className="text-ink-2">
                  <Trans>No cached contents.</Trans>
                </p>
              ) : (
                <ul className="grid gap-2">
                  {childPlaces.map((child) => (
                    <li key={child.id}>
                      <Button
                        variant="secondary"
                        className="kept-phone-row"
                        onPress={() =>
                          onOpen({ id: child.id, kind: 'place', locationId: child.locationId })
                        }
                      >
                        <span className="kept-row-lead" aria-hidden>
                          <MapPin size={18} />
                        </span>
                        <span className="kept-row-body">
                          <bdi className="font-semibold">{child.name}</bdi>
                        </span>
                        <ChevronRight
                          size={18}
                          className="kept-row-chevron rtl:rotate-180"
                          aria-hidden
                        />
                      </Button>
                    </li>
                  ))}
                  {children.map((child) => {
                    const childRow = childRows.find((hit) => hit.id === child.id);
                    const image = online && previewUrl(childRow?.thumbUrl, connection.origin);
                    return (
                      <li key={child.id}>
                        <Button
                          variant="secondary"
                          className="kept-phone-row"
                          onPress={() =>
                            onOpen({ id: child.id, kind: 'thing', locationId: child.locationId })
                          }
                        >
                          {image ? (
                            <PhotoImage
                              src={image}
                              rotation={childRow?.thumbnailRotation}
                              className="kept-thumb"
                            />
                          ) : (
                            <span className="kept-row-lead" aria-hidden>
                              <Package size={18} />
                            </span>
                          )}
                          <span className="kept-row-body">
                            <bdi className="font-semibold">{child.name ?? t`Untitled`}</bdi>
                            {Number(child.quantity) > 1 && (
                              <span className="text-small font-normal text-ink-2">
                                {t`Quantity: ${child.quantity}`}
                              </span>
                            )}
                          </span>
                          <ChevronRight
                            size={18}
                            className="kept-row-chevron rtl:rotate-180"
                            aria-hidden
                          />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
          {showHistory && online && (thing || place) && (
            <RecordHistory
              key={request}
              connection={connection}
              cache={cache}
              target={target}
              container={!!box}
              canEdit={!!canEdit}
              attachments={detail?.attachments ?? place?.attachments ?? []}
              onOpen={onOpen}
              onOpenPhoto={(attachment) => {
                if (attachment.photoRotation) setPhotoDialog(attachment);
                else if (attachment.file?.displayUrl) void openRemoteFile(attachment, 'display');
                else if (canEdit) void openRemoteFile(attachment, 'original');
              }}
              onChanged={() => {
                setRequest((value) => value + 1);
                onInventoryChanged();
              }}
              onAuthError={onAuthError}
            />
          )}
          {section === 'all' &&
            thing &&
            canEdit &&
            detail.attachments.some((entry) => entry.role === 'photo') && (
              <SuggestionForm
                connection={connection}
                thing={thing}
                onChanged={() => setRequest((value) => value + 1)}
                onAuthError={onAuthError}
              />
            )}
          {photoDialog && (
            <Modal
              isOpen
              onOpenChange={(open) => {
                if (!open) setPhotoDialog(undefined);
              }}
            >
              <Dialog title={<bdi>{photoDialogLabel}</bdi>}>
                {photoDialogSrc && (
                  <PhotoImage
                    src={photoDialogSrc}
                    alt={photoDialogLabel}
                    rotation={photoDialog.photoRotation}
                    contain
                    loading="eager"
                    className="h-[min(50dvh,24rem)] w-full rounded-lg bg-sunken"
                  />
                )}
                {online && canEdit && (
                  <div className="flex flex-wrap gap-2">
                    {photoDialog.photoArchivedAt ? (
                      <Button
                        isDisabled={changing}
                        onPress={() => void changePhoto(photoDialog, { photoArchived: false })}
                      >
                        <Trans>Restore photo</Trans>
                      </Button>
                    ) : (
                      <>
                        <Button
                          variant="secondary"
                          size="small"
                          isDisabled={changing}
                          onPress={() =>
                            void changePhoto(photoDialog, {
                              photoRotation: ((photoDialog.photoRotation ?? 0) + 90) % 360,
                            })
                          }
                        >
                          <RotateCw size={16} aria-hidden />
                          <Trans>Rotate clockwise</Trans>
                        </Button>
                        {thing && photoDialog.role === 'photo' && photoDialog.file?.thumbUrl && (
                          <Button
                            variant="secondary"
                            size="small"
                            isDisabled={changing || thing.thumbnailAttachmentId === photoDialog.id}
                            onPress={() => void changePhoto(photoDialog, { selectThumbnail: true })}
                          >
                            <Image size={16} aria-hidden />
                            {thing.thumbnailAttachmentId === photoDialog.id ? (
                              <Trans>Current thumbnail</Trans>
                            ) : (
                              <Trans>Use as thumbnail</Trans>
                            )}
                          </Button>
                        )}
                        {!photoDialog.locationPhotoTakenAt && photoDialog.role === 'photo' && (
                          <Button
                            variant="secondary"
                            size="small"
                            isDisabled={changing}
                            onPress={() => void changePhoto(photoDialog, { photoArchived: true })}
                          >
                            <Archive size={16} aria-hidden />
                            <Trans>Archive photo</Trans>
                          </Button>
                        )}
                      </>
                    )}
                    <Button
                      variant="ghost"
                      size="small"
                      isPending={openingMedia === `${photoDialog.id}:original`}
                      onPress={() => void openRemoteFile(photoDialog, 'original')}
                    >
                      <Trans>Open original photo</Trans>
                    </Button>
                  </div>
                )}
                {status && (
                  <p role="status" className="text-small text-ink-2">
                    {status}
                  </p>
                )}
              </Dialog>
            </Modal>
          )}
          {photoNotice && (
            <p role="status" className="text-small text-ink-2">
              {photoNotice}
            </p>
          )}
          {status && !photoDialog && (
            <p className="rounded-xl bg-sunken p-3 text-ink-2" role="status">
              {status}
            </p>
          )}
        </>
      )}
    </section>
  );
}
