import {
  CreateAreaPayload,
  CreateThingPayload,
  KEPT_VERSION,
  NATIVE_ADD_ITEM_PAYLOAD_VERSION,
  NATIVE_CREATE_AREA_PAYLOAD_VERSION,
  NATIVE_DEVICE_SUGGESTIONS_PAYLOAD_VERSION,
  NATIVE_INVENTORY_PAYLOAD_VERSION,
  NATIVE_LOCATION_PHOTO_PAYLOAD_VERSION,
  newId,
  PAYLOAD_VERSION,
  type QueueItem,
  TagThingsPayload,
} from '@kept/shared';
import { capturePaths } from '@/api/capture/paths';
import { ApiError } from '@/api/client';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { AttachmentView, BuiltinPlaceKind, Page, PlaceView } from '@/api/inventory/types';
import { paths } from '@/api/paths';
import { capacitorAdapters, type PlatformAdapters } from './adapters';
import type { Capture, Connection, OriginalMeta, PendingCapture, StorageStats } from './bridge';
import { forgetPlacePhotos } from './place-photo-cache';
import { rememberDestination } from './recent-destinations';
import { NativeSyncQueue, sendNativeQueue } from './sync-queue';

export type { Capture, OriginalMeta, PendingCapture, StorageStats };

export type SelectedOriginal = { file: File; role: 'photo' | 'document' };

export type ReviewEntry = {
  id: string;
  tagRequestId: string;
  name: string;
  quantity: string;
  note?: string;
  estimatedQuantity?: number;
  evidence?: number[];
  existing?: {
    id: string;
    update?: { key: string; rowVersion: number; name: string; note: string | null };
  };
  include: boolean;
  categories: string[];
  tags: string[];
  /** A label given to this item while adding it; the server claims it at sync. */
  claimCode?: string;
  /** `claimCode` is on an NFC tag written and read back while adding it: registered as the
   * item's verified NFC tag once the server has claimed it. */
  claimNfcVerified?: true;
};
export type PhotoReviewDraft = {
  accepted: boolean;
  acceptedAt?: string;
  entries: ReviewEntry[];
  verified?: string[];
};
export type DraftFields = {
  locationId: string;
  boxId?: string;
  placeId?: string;
  placeCreation?: {
    parentId: string | null;
    kindKey: BuiltinPlaceKind;
    description: string | null;
  };
  placePhoto?: { replaces?: { id: string; rowVersion: number } };
  dependsOnPlace?: string;
  attachToThingId?: string;
  locationPhoto?: true;
  captureIntent?: 'record' | 'add';
  skipServerSuggestions?: true;
  name: string;
  note?: string;
  quantity?: string;
  batchId?: string;
  barcode?: string;
  typeId?: string;
  custom?: Record<string, unknown>;
  review?: PhotoReviewDraft;
  tags?: string[];
  binEvidenceId?: string;
  /** A label given to the item while adding it (a scanned blank, or one reserved for a new NFC
   * tag or QR label): `create_thing`'s `claimCode`, claimed when the capture syncs. */
  claimCode?: string;
  /** See `ReviewEntry.claimNfcVerified`. */
  claimNfcVerified?: true;
};
type StoredFields = DraftFields & {
  version: number;
  attemptId?: string;
  uploadIds?: Record<string, string>;
};

const chunkBytes = 256 * 1024;
export const mobileFileLimit = 25 * 1024 * 1024;

/** Failures requiring user action (move target, discard, etc.) rather than silent auto-retry. */
export const ACTION_REQUIRED_FAILURES = new Set([
  'upc_already_exists',
  'parent_dropped',
  'target_trashed',
  'target_missing',
  'not_permitted',
  'location_revoked',
  'unsupported_media_type',
  'idempotency_mismatch',
  'precondition_failed',
  'validation',
  'payload_too_large',
  'checksum_mismatch',
  // The server couldn't parse the op (the shared sender drops just that one, D35).
  'invalid',
  // Older/rolled-back server that cannot accept this capture shape. Held, never
  // retried in a loop and never fixed by stripping fields such as reviewSuggestions.
  'compatibility_hold',
]);

const COMPATIBILITY_CODES = new Set([
  'unsupported_capability',
  'capability_missing',
  'capabilities_missing',
  'version_mismatch',
  'unsupported_payload',
  'unsupported_operation',
  'server_outdated',
  'client_outdated',
]);

/** Integration contract v1 (docs/mvp1/integration-contract.md). */
export const NATIVE_CONTRACT_VERSION = 1;
export const NATIVE_CAPTURE_PAYLOAD_VERSION = 2;
export const captureCapabilitiesPath = capturePaths.nativeCaptureCapabilities;

export type CaptureCapabilities = {
  contractVersion: number;
  capturePayloadVersions: number[];
  placeDescriptions?: true;
  placeCreationPayloadVersion?: number;
  account: string;
  epoch: string;
};

export function isRestoreEpochMismatch(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.details.reason === 'restore_epoch_mismatch' || Boolean(error.hint?.includes('restored')))
  );
}

export function isAuthRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 401 || error.code === 'mfa_required' || error.code === 'two_factor_required')
  );
}

/**
 * Negotiate capture compatibility before any upload or capture mutation (contract v1).
 * A missing/older endpoint is a recoverable hold: queue, identity and originals stay put.
 */
export async function ensureCaptureCompatible(
  connection: Connection,
  adapters: PlatformAdapters = capacitorAdapters,
  version = NATIVE_CAPTURE_PAYLOAD_VERSION,
): Promise<CaptureCapabilities> {
  let caps: unknown;
  try {
    caps = await adapters.transport.request<unknown>(connection, captureCapabilitiesPath);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 0 || error.status === 429 || error.status >= 500) throw error;
      if (isRestoreEpochMismatch(error)) throw error;
      if (error.status === 401) {
        // A pre-negotiation native server may answer 401 on the missing route because its
        // context hook runs before 404. Probe /api/v1/me with the same session and context.
        try {
          await adapters.transport.request<unknown>(connection, paths.me);
          throw new ReplayError('compatibility_hold');
        } catch (probeError) {
          if (probeError instanceof ReplayError) throw probeError;
          if (
            probeError instanceof ApiError &&
            (probeError.status === 0 ||
              probeError.status === 429 ||
              probeError.status >= 500 ||
              isAuthRefusal(probeError) ||
              probeError.status === 403 ||
              isRestoreEpochMismatch(probeError))
          ) {
            throw probeError;
          }
          throw error;
        }
      }
      if (isAuthRefusal(error)) throw error;
    }
    // 404/405 from an older server, or an unparseable non-contract body (e.g. HTML fallback).
    throw new ReplayError('compatibility_hold');
  }
  const valid =
    typeof caps === 'object' &&
    caps !== null &&
    (caps as CaptureCapabilities).contractVersion === NATIVE_CONTRACT_VERSION &&
    Array.isArray((caps as CaptureCapabilities).capturePayloadVersions) &&
    (caps as CaptureCapabilities).capturePayloadVersions.includes(version) &&
    (caps as CaptureCapabilities).account === connection.account &&
    (caps as CaptureCapabilities).epoch === connection.epoch;
  if (!valid) throw new ReplayError('compatibility_hold');
  return caps as CaptureCapabilities;
}

/** True when a server response signals an older/incompatible server rather than bad data. */
export function isCompatibilityFailure(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 426 || error.status === 501) return true;
  const serverCode = error.serverCode ?? '';
  if (COMPATIBILITY_CODES.has(serverCode) || COMPATIBILITY_CODES.has(error.code)) return true;
  if (error.status === 404 || error.status === 405) {
    return /capabilit|compat|negotiat/i.test(`${error.message} ${error.hint ?? ''} ${serverCode}`);
  }
  // A strict older schema rejecting the capture payload (e.g. unknown reviewSuggestions)
  // is a compatibility hold, not a terminal invalid operation: keep the payload intact.
  if (error.code === 'validation' || serverCode.includes('validation')) {
    return /reviewSuggestions|unknown|unrecognized|unsupported/i.test(
      `${error.message} ${error.hint ?? ''} ${JSON.stringify(error.details)}`,
    );
  }
  return false;
}

export function draftFields(capture: Capture): StoredFields {
  return JSON.parse(capture.payload) as StoredFields;
}

export function canRetarget(entry: PendingCapture): boolean {
  const fields = draftFields(entry.capture);
  if (fields.review || fields.placeCreation || fields.placePhoto) return false;
  return (
    (entry.failure === 'target_trashed' ||
      entry.failure === 'target_missing' ||
      entry.failure === 'parent_dropped') &&
    !fields.attachToThingId
  );
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export async function stageOriginal(
  connection: Connection,
  adapters: PlatformAdapters,
  id: string,
  fileId: string,
  file: Blob,
): Promise<void> {
  if (file.size <= 0 || file.size > mobileFileLimit) throw new Error('Invalid file size');
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    const bytes = new Uint8Array(await file.slice(offset, offset + chunkBytes).arrayBuffer());
    await adapters.outbox.stage(connection, { id, file: fileId, offset, data: base64(bytes) });
  }
}

export async function saveOnPhone(
  connection: Connection,
  fields: DraftFields,
  files: SelectedOriginal[],
  adapters: PlatformAdapters = capacitorAdapters,
  staged?: { id: string; originals: OriginalMeta[] },
): Promise<string> {
  if (
    files.length + (staged?.originals.length ?? 0) > 20 ||
    files.some(({ file }) => file.size <= 0 || file.size > mobileFileLimit)
  ) {
    throw new Error('Invalid file size');
  }
  const id = staged?.id ?? newId();
  const takenAt = new Date().toISOString();
  const originals: OriginalMeta[] = [...(staged?.originals ?? [])];
  const payload = JSON.stringify({
    ...fields,
    batchId: fields.batchId ?? id,
    version: PAYLOAD_VERSION,
  });
  try {
    for (const { file, role } of files) {
      const fileId = newId();
      await stageOriginal(connection, adapters, id, fileId, file);
      originals.push({
        id: fileId,
        mime: file.type || 'application/octet-stream',
        name: file.name.slice(0, 120),
        role,
        bytes: file.size,
      });
    }
    await adapters.outbox.save(connection, {
      id,
      takenAt,
      payload,
      files: JSON.stringify(originals),
    });
    return id;
  } catch (error) {
    if (!staged) await adapters.outbox.abort(connection, id).catch(() => {});
    throw error;
  }
}

export class ReplayError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Queues a capture's ops and sends the queue (sync-queue.ts). An op already queued under its key
 * is sent as it was queued, never rebuilt. Answers this capture's queued ops by key; any of
 * `items` left unanswered throws: `compatibility_hold` when the queue is blocked, else `retry`.
 * No answer from the server throws the transport's error (the ops stay `sent`).
 */
async function queueAndSend(
  connection: Connection,
  adapters: PlatformAdapters,
  captureId: string,
  items: QueueItem[],
) {
  const queue = new NativeSyncQueue(connection, adapters);
  await queue.enqueue(captureId, items);
  const blocked = await sendNativeQueue(queue, connection, adapters, isCompatibilityFailure);
  const mine = await queue.ofCapture(captureId);
  const unanswered = items.some(({ idempotencyKey }) => !mine.get(idempotencyKey)?.result);
  if (unanswered) throw new ReplayError(blocked ? 'compatibility_hold' : 'retry');
  return mine;
}

async function waitForPlace(connection: Connection, adapters: PlatformAdapters, id: string) {
  const completions = await getCompletions(connection, adapters);
  if (completions[id] === 'synced') return;
  if (completions[id] === 'discarded') throw new ReplayError('parent_dropped');
  if ((await adapters.outbox.list(connection)).some(({ capture }) => capture.id === id)) {
    throw new ReplayError('waiting_for_place');
  }
  // Terminal entries may age out. A scoped live read can still confirm the parent.
  const place = await adapters.transport.request<{ id: string }>(
    connection,
    inventoryPaths.place(id),
  );
  if (place?.id !== id) throw new ReplayError('target_missing');
}

async function ensurePlaceQueueCompatible(connection: Connection, adapters: PlatformAdapters) {
  const caps = await ensureCaptureCompatible(connection, adapters);
  if (caps.placeCreationPayloadVersion !== NATIVE_CREATE_AREA_PAYLOAD_VERSION) {
    throw new ReplayError('compatibility_hold');
  }
}

async function replayPlace(
  connection: Connection,
  capture: Capture,
  fields: StoredFields,
  adapters: PlatformAdapters,
) {
  await ensurePlaceQueueCompatible(connection, adapters);
  const mine = await queueAndSend(connection, adapters, capture.id, [
    {
      clientVersion: KEPT_VERSION,
      payloadVersion: NATIVE_CREATE_AREA_PAYLOAD_VERSION,
      clientId: capture.id,
      idempotencyKey: capture.id,
      op: 'create_area',
      takenAt: capture.takenAt,
      locationId: fields.locationId,
      ...(fields.dependsOnPlace ? { dependsOn: [fields.dependsOnPlace] } : {}),
      payload: CreateAreaPayload.parse({
        id: capture.id,
        name: fields.name,
        ...fields.placeCreation,
      }),
    },
  ]);
  const result = mine.get(capture.id)?.result;
  if (
    result?.outcome !== 'applied' ||
    result.entity?.type !== 'place' ||
    result.entity.id !== capture.id
  ) {
    throw new ReplayError(result?.reason ?? 'needs_review');
  }
  await adapters.outbox.complete(connection, capture.id);
}

async function replayPlacePhoto(
  connection: Connection,
  capture: Capture,
  fields: StoredFields,
  adapters: PlatformAdapters,
) {
  await ensurePlaceQueueCompatible(connection, adapters);
  const original = capture.files[0];
  const placeId = fields.placeId;
  if (!placeId || !original || capture.files.length !== 1) throw new ReplayError('validation');
  const place = await adapters.transport
    .request<PlaceView>(connection, inventoryPaths.place(placeId))
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404)
        throw new ReplayError('target_missing');
      throw error;
    });
  if (place?.id !== placeId || place.locationId !== fields.locationId)
    throw new ReplayError('target_missing');
  const previous = fields.placePhoto?.replaces;
  const existing = fields.attemptId && place.attachments.find(({ id }) => id === fields.attemptId);
  if (existing) {
    if (existing.file?.sha256 !== original.sha256) throw new ReplayError('checksum_mismatch');
    await forgetPlacePhotos(connection, adapters, placeId).catch(() => {});
    await adapters.outbox.complete(connection, capture.id);
    return;
  }
  if (
    previous &&
    !place.attachments.some(
      ({ id, rowVersion }) => id === previous.id && rowVersion === previous.rowVersion,
    )
  ) {
    throw new ReplayError('precondition_failed');
  }
  const attemptId = fields.attemptId ?? newId();
  if (!fields.attemptId)
    await adapters.outbox.retarget(
      connection,
      capture.id,
      JSON.stringify({ ...fields, attemptId }),
    );
  const uploaded = await adapters.transport.uploadOriginal(connection, {
    id: capture.id,
    file: original.file.id,
    location: fields.locationId,
    uploadId: attemptId,
    placePhoto: true,
  });
  if (uploaded.sha256 !== original.sha256 || uploaded.bytes !== original.file.bytes)
    throw new ReplayError('checksum_mismatch');
  const attachment = await adapters.transport.request<AttachmentView>(
    connection,
    inventoryPaths.attachments,
    {
      method: 'POST',
      idempotencyKey: attemptId,
      ...(previous ? { ifMatch: previous.rowVersion } : {}),
      body: {
        id: attemptId,
        locationId: fields.locationId,
        subject: { placeId },
        role: 'photo',
        fileId: uploaded.id,
        ...(previous ? { replacesAttachmentId: previous.id } : {}),
      },
    },
  );
  if (attachment?.id !== attemptId || attachment.file?.id !== uploaded.id)
    throw new ReplayError('attachments_unconfirmed');
  await forgetPlacePhotos(connection, adapters, placeId).catch(() => {});
  await adapters.outbox.complete(connection, capture.id);
}

export async function replayCapture(
  connection: Connection,
  capture: Capture,
  adapters: PlatformAdapters = capacitorAdapters,
): Promise<void> {
  // Contract v1: negotiate before uploading files or submitting capture mutations.
  const fields = draftFields(capture);
  if (fields.review && !fields.review.accepted) return;
  if (fields.dependsOnPlace) await waitForPlace(connection, adapters, fields.dependsOnPlace);
  if (fields.placeCreation) return replayPlace(connection, capture, fields, adapters);
  if (fields.placePhoto) return replayPlacePhoto(connection, capture, fields, adapters);
  const reviewed = fields.review?.entries.filter((entry) => entry.include);
  if (reviewed && !reviewed.length) throw new ReplayError('validation');
  const required = fields.locationPhoto
    ? NATIVE_LOCATION_PHOTO_PAYLOAD_VERSION
    : fields.barcode || fields.custom
      ? NATIVE_ADD_ITEM_PAYLOAD_VERSION
      : fields.skipServerSuggestions
        ? NATIVE_DEVICE_SUGGESTIONS_PAYLOAD_VERSION
        : fields.captureIntent
          ? NATIVE_INVENTORY_PAYLOAD_VERSION
          : NATIVE_CAPTURE_PAYLOAD_VERSION;
  await ensureCaptureCompatible(connection, adapters, required);
  const verified = new Set(fields.review?.verified);
  const entries = reviewed ?? [
    {
      id: capture.id,
      tagRequestId: capture.id,
      name: fields.name,
      quantity: fields.quantity,
      note: fields.note,
      tags: fields.tags ?? [],
      existing: fields.attachToThingId ? { id: fields.attachToThingId } : undefined,
      claimCode: fields.attachToThingId ? undefined : fields.claimCode,
      claimNfcVerified: fields.attachToThingId ? undefined : fields.claimNfcVerified,
    },
  ];
  const work = [
    ...entries,
    ...(fields.binEvidenceId && fields.boxId
      ? [
          {
            id: fields.binEvidenceId,
            tagRequestId: fields.binEvidenceId,
            name: '',
            quantity: undefined,
            tags: [],
            existing: { id: fields.boxId },
            claimCode: undefined,
            claimNfcVerified: undefined,
          },
        ]
      : []),
  ].filter(({ id }) => !verified.has(id));
  if (!work.length) {
    await adapters.outbox.complete(connection, capture.id);
    return;
  }
  const keyOf = (entry: (typeof work)[number]) =>
    reviewed ? entry.id : (fields.attemptId ?? entry.id);
  // Ops queued by an earlier attempt are frozen with the files they name: no upload is needed
  // again, and none of them is rebuilt.
  const queued = await new NativeSyncQueue(connection, adapters).ofCapture(capture.id);
  const allQueued = work.every((entry) => queued.has(keyOf(entry)));
  const uploadedFiles: { fileId: string; role: 'photo' | 'document'; sha256: string }[] = [];

  for (const { file, sha256 } of allQueued ? [] : capture.files) {
    const uploaded = await adapters.transport.uploadOriginal(connection, {
      id: capture.id,
      file: file.id,
      location: fields.locationId,
      ...(fields.uploadIds?.[file.id] ? { uploadId: fields.uploadIds[file.id] } : {}),
    });
    if (uploaded.sha256 !== sha256 || uploaded.bytes !== file.bytes) {
      throw new ReplayError('checksum_mismatch');
    }
    // A per-location dedupe hit returns the canonical server file id.
    if (!uploadedFiles.some((entry) => entry.fileId === uploaded.id && entry.role === file.role)) {
      uploadedFiles.push({ fileId: uploaded.id, role: file.role, sha256 });
    }
  }

  const ops: QueueItem[] = work.map((entry) => ({
    clientVersion: KEPT_VERSION,
    payloadVersion: entry.existing && !fields.locationPhoto ? PAYLOAD_VERSION : required,
    clientId: entry.id,
    idempotencyKey: keyOf(entry),
    op: 'create_thing' as const,
    takenAt: fields.review?.acceptedAt ?? capture.takenAt,
    locationId: fields.locationId,
    ...(fields.dependsOnPlace ? { dependsOn: [fields.dependsOnPlace] } : {}),
    payload: CreateThingPayload.parse({
      id: entry.id,
      batchId: fields.batchId,
      target: fields.boxId
        ? { containerId: fields.boxId }
        : fields.placeId
          ? { placeId: fields.placeId }
          : { unplaced: true },
      mode: 'thing',
      ...(entry.existing
        ? {
            attachToThingId: entry.existing.id,
            ...(fields.locationPhoto ? { locationPhoto: true } : {}),
          }
        : {
            reviewSuggestions: true,
            captureIntent: fields.captureIntent,
            skipServerSuggestions: fields.skipServerSuggestions,
            name: entry.name,
            note: ('note' in entry ? entry.note : fields.note)?.trim() || undefined,
            quantity: entry.quantity || undefined,
            ...(!reviewed && fields.barcode ? { barcode: fields.barcode } : {}),
            ...(!reviewed && fields.typeId ? { typeId: fields.typeId } : {}),
            ...(!reviewed && fields.custom ? { custom: fields.custom } : {}),
            claimCode: entry.claimCode,
          }),
      files: uploadedFiles,
    }),
  }));
  const answers = await queueAndSend(
    connection,
    adapters,
    capture.id,
    allQueued ? work.map((entry) => queued.get(keyOf(entry)) as QueueItem) : ops,
  );
  let failed: string | undefined;
  for (const entry of work) {
    const subject = entry.existing?.id ?? entry.id;
    const result = answers.get(keyOf(entry))?.result;
    // A label claimed first for something else leaves the item made with its own code and a
    // `label_claim` inbox item to settle it: the capture itself is done.
    const labelTaken =
      result?.outcome === 'needs_review' &&
      result.reason === 'already_claimed' &&
      !!entry.claimCode;
    if (
      !result ||
      (result.outcome !== 'applied' && !labelTaken) ||
      result.entity?.type !== 'thing' ||
      result.entity?.id !== subject
    ) {
      failed ??= result?.reason ?? 'needs_review';
      continue;
    }
    try {
      if (entry.claimCode && entry.claimNfcVerified && !labelTaken) {
        await registerWrittenTag(connection, adapters, fields.locationId, entry.claimCode);
      }
      if (entry.existing && 'update' in entry.existing && entry.existing.update) {
        const { key, rowVersion, name, note } = entry.existing.update;
        await adapters.transport.request(connection, inventoryPaths.thing(subject), {
          method: 'PATCH',
          ifMatch: rowVersion,
          idempotencyKey: key,
          body: { name, ...(note !== null ? { notes: note } : {}) },
        });
      }
      if (
        entry.tags.length &&
        (!entry.existing || ('update' in entry.existing && entry.existing.update))
      ) {
        // The protocol's own `tag_things` op, queued and sent like the capture's ops.
        const key = `tags:${entry.tagRequestId}`;
        const tagged = await queueAndSend(connection, adapters, capture.id, [
          {
            clientVersion: KEPT_VERSION,
            payloadVersion: PAYLOAD_VERSION,
            clientId: newId(),
            idempotencyKey: key,
            op: 'tag_things',
            takenAt: capture.takenAt,
            locationId: fields.locationId,
            payload: TagThingsPayload.parse({ thingIds: [subject], add: entry.tags }),
          },
        ]);
        const answer = tagged.get(key)?.result;
        if (answer?.outcome !== 'applied') {
          failed ??= answer?.reason ?? 'needs_review';
          continue;
        }
      }
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        !ACTION_REQUIRED_FAILURES.has(error.code) ||
        isAuthRefusal(error) ||
        isRestoreEpochMismatch(error)
      )
        throw error;
      failed ??= error.code;
      continue;
    }
    // The accepted log may already have aged out of the three-photo window. The signed-in
    // server's replay result and the verified upload confirm this operation even in that case.
    if (capture.files.length && !fields.locationPhoto) {
      const remaining = new Set(
        capture.files.map(({ file, sha256 }) => `${file.role}:${file.bytes}:${sha256}`),
      );
      let cursor: string | undefined;
      do {
        const page: Page<AttachmentView> = await adapters.transport.request(
          connection,
          `${inventoryPaths.thingAttachments(subject)}${qs({ limit: 100, cursor })}`,
        );
        for (const { role, file } of page.items) {
          if (file) remaining.delete(`${role}:${file.bytes}:${file.sha256}`);
        }
        if (page.next_cursor === cursor) break;
        cursor = page.next_cursor ?? undefined;
      } while (cursor && remaining.size);
      if (remaining.size) {
        failed ??= 'attachments_unconfirmed';
        continue;
      }
    }
    verified.add(entry.id);
    if (fields.review) {
      await adapters.outbox.retarget(
        connection,
        capture.id,
        JSON.stringify({
          ...fields,
          review: { ...fields.review, verified: [...verified] },
        }),
      );
    }
  }
  if (failed) throw new ReplayError(failed);

  await adapters.outbox.complete(connection, capture.id);
  const destinationId = fields.boxId ?? fields.placeId;
  if (destinationId && !fields.attachToThingId)
    void rememberDestination(connection, adapters, destinationId);
}

/** Marks a claimed label's NFC tag verified after readback. Registration can be retried safely. */
async function registerWrittenTag(
  connection: Connection,
  adapters: PlatformAdapters,
  locationId: string,
  code: string,
) {
  try {
    await adapters.transport.request(connection, capturePaths.labelTags, {
      method: 'POST',
      body: { locationId, label: code, kind: 'nfc' },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      // Older servers can return 401 for a missing route because native context is checked
      // before the 404. Keep the registration pending if this session is still valid.
      await adapters.transport.request(connection, paths.me);
      throw new ReplayError('compatibility_hold');
    }
    if (
      !(error instanceof ApiError) ||
      error.status === 0 ||
      error.status === 429 ||
      error.status >= 500 ||
      isAuthRefusal(error) ||
      isRestoreEpochMismatch(error)
    )
      throw error;
  }
}

function classifyFailure(error: unknown): string {
  if (isCompatibilityFailure(error)) return 'compatibility_hold';
  if (error instanceof ReplayError) return error.reason;
  if (error instanceof ApiError) return error.code;
  return 'retry';
}

export async function syncOutbox(
  connection: Connection,
  adapters: PlatformAdapters = capacitorAdapters,
  options: { includeFailed?: boolean } = {},
): Promise<number> {
  // A new run may find the server updated: ops blocked by a refusal go again (D148).
  await new NativeSyncQueue(connection, adapters).unblock();
  const queue = await adapters.outbox.list(connection);
  let count = 0;
  for (const entry of queue) {
    const review = draftFields(entry.capture).review;
    if (review && !review.accepted) continue;
    if (!options.includeFailed && entry.failure && ACTION_REQUIRED_FAILURES.has(entry.failure)) {
      continue;
    }
    try {
      await replayCapture(connection, entry.capture, adapters);
      count++;
    } catch (error) {
      if (error instanceof ApiError && error.status === 0) throw error;
      if (isAuthRefusal(error) || isRestoreEpochMismatch(error)) throw error;
      const reason = classifyFailure(error);
      if (reason === 'waiting_for_place') continue;
      await adapters.outbox.failed(connection, entry.capture.id, reason);
      if (error instanceof ApiError && (error.status >= 500 || error.status === 429)) {
        throw error;
      }
    }
  }
  return count;
}

export async function retryCapture(
  connection: Connection,
  id: string,
  adapters: PlatformAdapters = capacitorAdapters,
): Promise<boolean> {
  const queue = await adapters.outbox.list(connection);
  const entry = queue.find((item) => item.capture.id === id);
  if (!entry) return false;
  const review = draftFields(entry.capture).review;
  if (review && !review.accepted) return false;
  try {
    await adapters.outbox.clearFailure(connection, id);
    await new NativeSyncQueue(connection, adapters).unblock();
    await replayCapture(connection, entry.capture, adapters);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 0) throw error;
    if (isAuthRefusal(error) || isRestoreEpochMismatch(error)) throw error;
    await adapters.outbox.failed(connection, id, classifyFailure(error));
    return false;
  }
}

export async function retargetCapture(
  connection: Connection,
  entry: PendingCapture,
  destination: { id: string; locationId: string },
  adapters: PlatformAdapters = capacitorAdapters,
): Promise<Capture> {
  if (!canRetarget(entry)) throw new ReplayError('needs_review');
  const { capture } = entry;
  // The new destination goes under new keys. The old ops must all have been answered without
  // being applied; one that is `sent` may have been, and then retargeting would duplicate it.
  if (!(await new NativeSyncQueue(connection, adapters).release(capture.id)))
    throw new ReplayError('needs_review');
  const fields = draftFields(capture);
  // Kept keeps the rejected request under its old key. Reuse the record ID to prevent duplicates.
  // Uploads use location-specific IDs but the device still reads the same protected originals.
  const uploadIds =
    destination.locationId === fields.locationId
      ? fields.uploadIds
      : Object.fromEntries(capture.files.map(({ file }) => [file.id, newId()]));
  const next = JSON.stringify({
    ...fields,
    boxId: destination.id,
    placeId: undefined,
    dependsOnPlace: undefined,
    locationId: destination.locationId,
    attemptId: newId(),
    uploadIds,
  });
  return adapters.outbox.retarget(connection, capture.id, next);
}

export async function discardCapture(
  connection: Connection,
  id: string,
  adapters: PlatformAdapters = capacitorAdapters,
): Promise<void> {
  // Distinct durable state from a server-confirmed sync; never reuse `complete`.
  await adapters.outbox.discard(connection, id);
}

export function getCompletions(
  connection: Connection,
  adapters: PlatformAdapters = capacitorAdapters,
): Promise<Record<string, import('./bridge').CompletionState>> {
  return adapters.outbox.completions(connection);
}

export function listHeldCaptures(
  connection: Connection,
  adapters: PlatformAdapters = capacitorAdapters,
): Promise<PendingCapture[]> {
  return adapters.outbox.listHeld(connection);
}

export async function discardHeldCapture(
  connection: Connection,
  entry: PendingCapture,
  adapters: PlatformAdapters = capacitorAdapters,
): Promise<void> {
  const heldContext = entry.capture.context;
  if (!heldContext) throw new ReplayError('needs_review');
  await adapters.outbox.discardHeld(connection, heldContext, entry.capture.id);
}

/** Metadata + integrity hashes for one held capture, safe to share for manual recovery. */
export function heldCaptureExport(
  entry: PendingCapture,
  cache?: {
    things: readonly { id: string; name: string | null }[];
    locations: readonly { id: string; name: string }[];
  },
) {
  const fields = draftFields(entry.capture);
  const boxName = cache?.things.find((item) => item.id === fields.boxId)?.name ?? undefined;
  const locationName =
    cache?.locations.find((loc) => loc.id === fields.locationId)?.name ?? undefined;
  return {
    captureId: entry.capture.id,
    takenAt: entry.capture.takenAt,
    heldContext: entry.capture.context ?? null,
    destination: {
      boxId: fields.boxId,
      ...(fields.placeId ? { placeId: fields.placeId } : {}),
      ...(fields.attachToThingId ? { thingId: fields.attachToThingId } : {}),
      ...(boxName ? { boxName } : {}),
      locationId: fields.locationId,
      ...(locationName ? { locationName } : {}),
    },
    name: fields.name,
    ...(fields.captureIntent ? { captureIntent: fields.captureIntent } : {}),
    ...(fields.note ? { note: fields.note } : {}),
    ...(fields.quantity ? { quantity: fields.quantity } : {}),
    ...(fields.batchId ? { batchId: fields.batchId } : {}),
    ...(fields.tags?.length ? { tags: fields.tags } : {}),
    ...(fields.review ? { review: fields.review } : {}),
    ...(fields.binEvidenceId ? { binEvidenceId: fields.binEvidenceId } : {}),
    ...(fields.claimCode ? { claimCode: fields.claimCode } : {}),
    failure: entry.failure ?? null,
    files: entry.capture.files.map(({ file, sha256 }) => ({
      fileId: file.id,
      name: file.name,
      mime: file.mime,
      role: file.role,
      bytes: file.bytes,
      sha256,
    })),
    recoveryNotice:
      'Automatic replay is paused because this capture predates a server restore. Verify the SHA-256 hashes before importing the originals elsewhere.',
  };
}

export function getOutboxStats(
  connection: Connection,
  adapters: PlatformAdapters = capacitorAdapters,
): Promise<StorageStats> {
  return adapters.outbox.stats(connection);
}
