import { NATIVE_CREATE_AREA_PAYLOAD_VERSION, newId } from '@kept/shared';
import { describe, expect, it, vi } from 'vitest';
import { capturePaths } from '@/api/capture/paths';
import { ApiError } from '@/api/client';
import { inventoryPaths } from '@/api/inventory/paths';
import { paths } from '@/api/paths';
import { memorySyncQueue } from '@/test/memory-sync-queue';
import { capacitorAdapters, type PlatformAdapters } from './adapters';
import {
  type Capture,
  type Connection,
  type NativeRequestOptions,
  type PendingCapture,
  StorageFullError,
} from './bridge';
import {
  ACTION_REQUIRED_FAILURES,
  captureCapabilitiesPath,
  discardCapture,
  draftFields,
  ensureCaptureCompatible,
  heldCaptureExport,
  isAuthRefusal,
  isCompatibilityFailure,
  isRestoreEpochMismatch,
  replayCapture,
  retargetCapture,
  retryCapture,
  saveOnPhone,
  syncOutbox,
} from './outbox';

const connection: Connection = {
  id: 'https://kept.example.com|user-1|epoch-1',
  origin: 'https://kept.example.com',
  account: 'user-1',
  epoch: 'epoch-1',
};

it('preserves an offline replacement and its original when the cached version conflicts', async () => {
  const placeId = newId();
  const locationId = newId();
  const previousId = newId();
  const fileId = newId();
  const request = vi.fn(async (_conn: Connection, path: string) => {
    if (path === inventoryPaths.place(placeId)) {
      return { id: placeId, locationId, attachments: [{ id: previousId, rowVersion: 3 }] };
    }
    if (path === inventoryPaths.attachments)
      throw new ApiError(412, 'precondition_failed', 'Photo changed');
    throw new Error(`Unexpected path ${path}`);
  });
  const upload = vi.fn().mockResolvedValue({ id: fileId, sha256: 'a'.repeat(64), bytes: 5 });
  const { adapters } = makeInMemoryAdapters({
    request: request as PlatformAdapters['transport']['request'],
    uploadOriginal: upload,
    capabilities: () => ({
      contractVersion: 1,
      capturePayloadVersions: [2],
      placeCreationPayloadVersion: NATIVE_CREATE_AREA_PAYLOAD_VERSION,
      account: connection.account,
      epoch: connection.epoch,
    }),
  });
  const id = await saveOnPhone(
    connection,
    {
      locationId,
      placeId,
      name: 'Garage shelf',
      placePhoto: { replaces: { id: previousId, rowVersion: 3 } },
    },
    [{ file: new File(['photo'], 'shelf.jpg', { type: 'image/jpeg' }), role: 'photo' }],
    adapters,
  );
  expect(await syncOutbox(connection, adapters)).toBe(0);
  expect(request).toHaveBeenCalledWith(
    connection,
    inventoryPaths.attachments,
    expect.objectContaining({
      ifMatch: 3,
      body: expect.objectContaining({ replacesAttachmentId: previousId, fileId }),
    }),
  );
  expect(await adapters.outbox.list(connection)).toMatchObject([
    {
      capture: { id, files: [{ file: { name: 'shelf.jpg', bytes: 5 } }] },
      failure: 'precondition_failed',
    },
  ]);
  expect(await adapters.outbox.completions(connection)).toEqual({});
});

function makeInMemoryAdapters(
  overrides: {
    request?: PlatformAdapters['transport']['request'];
    uploadOriginal?: PlatformAdapters['transport']['uploadOriginal'];
    capabilities?: () => unknown;
  } = {},
) {
  const staged = new Map<string, string>();
  const captures = new Map<string, PendingCapture>();
  const completionStates = new Map<string, 'synced' | 'discarded'>();
  const syncQueue = memorySyncQueue();

  const delegateRequest = overrides.request ?? vi.fn();
  const adapters: PlatformAdapters = {
    ...capacitorAdapters,
    transport: {
      // Contract v1 negotiation is answered by the fake server by default.
      request: async (conn: Connection, path: string, options?: unknown) => {
        if (path === captureCapabilitiesPath) {
          if (overrides.capabilities) return overrides.capabilities();
          return {
            contractVersion: 1,
            capturePayloadVersions: [2],
            account: conn.account,
            epoch: conn.epoch,
          };
        }
        return delegateRequest(conn, path, options);
      },
      uploadOriginal: overrides.uploadOriginal ?? vi.fn(),
    },
    outbox: {
      ...capacitorAdapters.outbox,
      async stage(_conn, input) {
        staged.set(`${input.id}:${input.file}:${input.offset}`, input.data);
      },
      async save(_conn, input) {
        const files = JSON.parse(input.files) as Capture['files'][number]['file'][];
        captures.set(input.id, {
          capture: {
            id: input.id,
            payload: input.payload,
            takenAt: input.takenAt,
            files: files.map((file) => ({ file, sha256: 'a'.repeat(64) })),
          },
        });
      },
      async abort(_conn, id) {
        for (const key of staged.keys()) {
          if (key.startsWith(`${id}:`)) staged.delete(key);
        }
      },
      async list() {
        return [...captures.values()];
      },
      async failed(_conn, id, reason) {
        const entry = captures.get(id);
        if (entry) captures.set(id, { ...entry, failure: reason });
      },
      async clearFailure(_conn, id) {
        const entry = captures.get(id);
        if (entry) captures.set(id, { capture: entry.capture });
      },
      async retarget(_conn, id, payload) {
        const entry = captures.get(id);
        if (!entry) throw new Error('missing');
        const next: Capture = { ...entry.capture, payload };
        captures.set(id, { capture: next });
        return next;
      },
      syncQueue: syncQueue.queue,
      async complete(conn, id) {
        syncQueue.finish(conn.id, id);
        completionStates.set(id, 'synced');
        captures.delete(id);
      },
      async discard(conn, id) {
        syncQueue.finish(conn.id, id);
        completionStates.set(id, 'discarded');
        captures.delete(id);
      },
      async completions() {
        return Object.fromEntries(completionStates);
      },
      async listHeld() {
        return [];
      },
      async discardHeld() {},
      async stats() {
        const pendingBytes = [...captures.values()].reduce(
          (sum, entry) => sum + entry.capture.files.reduce((s, f) => s + f.file.bytes, 0),
          0,
        );
        return { pendingCount: captures.size, pendingBytes, cacheBytes: 0 };
      },
    },
  };

  return { adapters, staged, captures, completionStates, syncQueue };
}

describe('native outbox staging and replay', () => {
  it('chunks files durably, aborts cleanly on error, and surfaces StorageFullError', async () => {
    const { adapters, staged, captures } = makeInMemoryAdapters();
    const bigBytes = new Uint8Array(300_000);
    bigBytes.fill(65);
    const bigFile = new File([bigBytes], 'manual.pdf', { type: 'application/pdf' });

    const id = await saveOnPhone(
      connection,
      {
        locationId: newId(),
        boxId: newId(),
        name: 'Decorations',
        note: 'Top shelf',
        quantity: '2',
      },
      [{ file: bigFile, role: 'document' }],
      adapters,
    );
    expect(captures.has(id)).toBe(true);
    expect([...staged.keys()].filter((k) => k.startsWith(`${id}:`)).length).toBe(2);

    const abortSpy = vi.spyOn(adapters.outbox, 'abort');
    vi.spyOn(adapters.outbox, 'save').mockRejectedValueOnce(new StorageFullError());
    await expect(
      saveOnPhone(
        connection,
        { locationId: newId(), boxId: newId(), name: 'Failed' },
        [{ file: new File(['abc'], 'a.jpg', { type: 'image/jpeg' }), role: 'photo' }],
        adapters,
      ),
    ).rejects.toBeInstanceOf(StorageFullError);
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps local files when changing locations and attaches identical photos once', async () => {
    const dedupFileId = newId();
    const locId = newId();
    const boxId = newId();
    const captureId = newId();
    const localFileId = newId();
    const sha = 'b'.repeat(64);
    const capture: Capture = {
      id: captureId,
      takenAt: '2026-11-22T20:00:00Z',
      payload: JSON.stringify({
        locationId: locId,
        boxId,
        name: 'Winter ornaments',
        batchId: newId(),
        version: 1,
      }),
      files: [
        {
          file: {
            id: localFileId,
            name: 'photo.jpg',
            mime: 'image/jpeg',
            role: 'photo',
            bytes: 12,
          },
          sha256: sha,
        },
        {
          file: {
            id: newId(),
            name: 'photo-copy.jpg',
            mime: 'image/jpeg',
            role: 'photo',
            bytes: 12,
          },
          sha256: sha,
        },
      ],
    };

    const uploadOriginal = vi.fn().mockResolvedValue({
      id: dedupFileId,
      deduplicatedFrom: dedupFileId,
      sha256: sha,
      bytes: 12,
      mime: 'image/jpeg',
      class: 'evidence',
      hasGps: false,
      width: 100,
      height: 100,
      derivativeState: 'pending',
      thumbUrl: null,
      displayUrl: null,
    });
    const request = vi.fn().mockImplementation(async (_conn, path, opts) => {
      if (path === capturePaths.syncOps) {
        const op = (
          opts?.body as
            | {
                ops?: Array<{
                  idempotencyKey?: string;
                  payload: { files: Array<{ fileId: string }>; reviewSuggestions?: boolean };
                }>;
              }
            | undefined
        )?.ops?.[0];
        expect(op?.payload.files).toEqual([{ fileId: dedupFileId, role: 'photo', sha256: sha }]);
        expect(op?.payload.reviewSuggestions).toBe(true);
        return {
          results: [
            {
              clientId: captureId,
              idempotencyKey: op?.idempotencyKey ?? captureId,
              outcome: 'applied',
              entity: { type: 'thing', id: captureId },
            },
          ],
        };
      }
      if (path.startsWith(inventoryPaths.thingAttachments(captureId))) {
        return {
          items: [
            {
              id: newId(),
              role: 'photo',
              sort: 0,
              file: {
                id: dedupFileId,
                sha256: sha,
                bytes: 12,
                mime: 'image/jpeg',
                class: 'evidence',
                hasGps: false,
                width: 100,
                height: 100,
                derivativeState: 'ready',
                thumbUrl: null,
                displayUrl: null,
              },
              url: null,
              subject: { thingId: captureId },
              createdBy: { displayName: 'Ibrahim' },
              rowVersion: 1,
            },
          ],
          next_cursor: null,
        };
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const { adapters, captures } = makeInMemoryAdapters({ uploadOriginal, request });
    const failed = { capture, failure: 'target_missing' };
    captures.set(captureId, failed);
    const nextLocation = newId();
    const moved = await retargetCapture(
      connection,
      failed,
      { id: newId(), locationId: nextLocation },
      adapters,
    );
    expect(moved.files).toEqual(capture.files);
    const { uploadIds } = draftFields(moved);
    expect(new Set(Object.values(uploadIds ?? {})).size).toBe(2);

    await replayCapture(connection, moved, adapters);
    for (const { file } of capture.files) {
      expect(uploadIds?.[file.id]).not.toBe(file.id);
      expect(uploadOriginal).toHaveBeenCalledWith(connection, {
        id: captureId,
        file: file.id,
        location: nextLocation,
        uploadId: uploadIds?.[file.id],
      });
    }
    expect(captures.has(captureId)).toBe(false);
  });

  it('preserves pending capture on checksum mismatch or unconfirmed attachment', async () => {
    const locId = newId();
    const boxId = newId();
    const captureId = newId();
    const fileId = newId();
    const sha = 'c'.repeat(64);
    const capture: Capture = {
      id: captureId,
      takenAt: '2026-11-22T20:00:00Z',
      payload: JSON.stringify({
        locationId: locId,
        boxId,
        name: 'Manual',
        batchId: newId(),
        version: 1,
      }),
      files: [
        {
          file: {
            id: fileId,
            name: 'doc.pdf',
            mime: 'application/pdf',
            role: 'document',
            bytes: 8,
          },
          sha256: sha,
        },
      ],
    };
    const { adapters, captures } = makeInMemoryAdapters({
      uploadOriginal: vi.fn().mockResolvedValue({
        id: fileId,
        sha256: sha,
        bytes: 8,
        mime: 'application/pdf',
        class: 'document',
        hasGps: false,
        width: null,
        height: null,
        derivativeState: 'not_applicable',
        thumbUrl: null,
        displayUrl: null,
      }),
      request: vi
        .fn()
        .mockResolvedValueOnce({
          results: [
            {
              clientId: captureId,
              idempotencyKey: captureId,
              outcome: 'applied',
              entity: { type: 'thing', id: captureId },
            },
          ],
        })
        .mockResolvedValueOnce({ items: [], next_cursor: null }),
    });
    captures.set(captureId, { capture });

    await expect(syncOutbox(connection, adapters)).resolves.toBe(0);
    expect(captures.get(captureId)?.failure).toBe('attachments_unconfirmed');
  });

  it('preserves queue on 401/offline/restored-409 and handles retarget and discard', async () => {
    const locId = newId();
    const oldBoxId = newId();
    const newBoxId = newId();
    const captureId = newId();
    const capture: Capture = {
      id: captureId,
      takenAt: '2026-11-22T20:00:00Z',
      payload: JSON.stringify({
        locationId: locId,
        boxId: oldBoxId,
        name: 'Cables',
        batchId: newId(),
        version: 1,
      }),
      files: [],
    };
    const request = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(401, 'unauthenticated', 'Expired'))
      .mockRejectedValueOnce(
        new ApiError(409, 'conflict', 'Conflict', {
          hint: 'This SheepKeep was restored or replaced.',
        }),
      )
      .mockResolvedValueOnce({
        results: [
          {
            clientId: captureId,
            idempotencyKey: captureId,
            outcome: 'dropped',
            reason: 'target_trashed',
          },
        ],
      })
      .mockImplementationOnce(async (_conn: unknown, _path: string, opts?: { body?: unknown }) => {
        const op = (opts?.body as { ops?: Array<{ idempotencyKey?: string }> } | undefined)
          ?.ops?.[0];
        return {
          results: [
            {
              clientId: captureId,
              idempotencyKey: op?.idempotencyKey ?? captureId,
              outcome: 'applied',
              entity: { type: 'thing', id: captureId },
            },
          ],
        };
      });

    const { adapters, captures, completionStates } = makeInMemoryAdapters({ request });
    captures.set(captureId, { capture });

    await expect(syncOutbox(connection, adapters)).rejects.toMatchObject({ status: 401 });
    expect(captures.get(captureId)?.failure).toBeUndefined();

    await expect(syncOutbox(connection, adapters)).rejects.toMatchObject({ status: 409 });
    expect(captures.get(captureId)?.failure).toBeUndefined();

    expect(await syncOutbox(connection, adapters)).toBe(0);
    expect(captures.get(captureId)?.failure).toBe('target_trashed');

    // Passive sync skips action-required failures; retarget + retry resolves and completes.
    expect(await syncOutbox(connection, adapters)).toBe(0);
    expect(request).toHaveBeenCalledTimes(3);

    const destination = { id: newBoxId, locationId: locId };
    await expect(
      retargetCapture(connection, { capture }, destination, adapters),
    ).rejects.toMatchObject({
      reason: 'needs_review',
    });
    const failed = captures.get(captureId);
    if (!failed) throw new Error('Expected the failed capture to stay on the device');
    const retargeted = await retargetCapture(connection, failed, destination, adapters);
    const next = draftFields(retargeted);
    expect(next.attemptId).toEqual(expect.any(String));
    expect(next.attemptId).not.toBe(captureId);
    expect(await retryCapture(connection, captureId, adapters)).toBe(true);
    expect(request.mock.lastCall?.[2]).toMatchObject({
      body: {
        ops: [
          {
            clientId: captureId,
            idempotencyKey: next.attemptId,
            payload: { id: captureId, target: { containerId: newBoxId } },
          },
        ],
      },
    });
    expect(captures.has(captureId)).toBe(false);
    expect(completionStates.get(captureId)).toBe('synced');

    // Discard removes the pending item but is recorded as discarded, never synced.
    completionStates.delete(captureId);
    captures.set(captureId, { capture, failure: 'target_missing' });
    await discardCapture(connection, captureId, adapters);
    expect(captures.has(captureId)).toBe(false);
    expect(completionStates.get(captureId)).toBe('discarded');
    expect(await adapters.outbox.completions(connection)).toEqual({
      [captureId]: 'discarded',
    });
  });

  it('holds captures on a rolled-back server, then retries after upgrade (contract v1)', async () => {
    const captureId = newId();
    const capture: Capture = {
      id: captureId,
      takenAt: '2026-11-22T20:00:00Z',
      payload: JSON.stringify({
        locationId: newId(),
        boxId: newId(),
        name: 'Rolled back',
        batchId: newId(),
        version: 1,
      }),
      files: [],
    };
    let upgraded = false;
    const syncRequest = vi
      .fn()
      .mockImplementation(async (_c: unknown, _p: string, opts?: { body?: unknown }) => {
        const op = (
          opts?.body as
            | { ops?: Array<{ idempotencyKey?: string; payloadVersion?: number }> }
            | undefined
        )?.ops?.[0];
        expect(op?.payloadVersion).toBe(2);
        return {
          results: [
            {
              clientId: captureId,
              idempotencyKey: op?.idempotencyKey ?? captureId,
              outcome: 'applied',
              entity: { type: 'thing', id: captureId },
            },
          ],
        };
      });
    const { adapters, captures, completionStates } = makeInMemoryAdapters({
      request: syncRequest,
      capabilities: () => {
        if (!upgraded) throw new ApiError(404, 'not_found', 'Not found');
        return {
          contractVersion: 1,
          capturePayloadVersions: [2],
          account: connection.account,
          epoch: connection.epoch,
        };
      },
    });
    captures.set(captureId, { capture });

    // Older server without the negotiation endpoint: recoverable hold, no mutation sent.
    expect(await syncOutbox(connection, adapters)).toBe(0);
    expect(captures.get(captureId)?.failure).toBe('compatibility_hold');
    expect(syncRequest).not.toHaveBeenCalled();
    const heldEntry = captures.get(captureId);
    if (!heldEntry) throw new Error('Expected the held capture to stay on the device');
    expect(draftFields(heldEntry.capture).name).toBe('Rolled back');

    // Passive sync does not loop on a held capture.
    expect(await syncOutbox(connection, adapters)).toBe(0);
    expect(syncRequest).not.toHaveBeenCalled();

    // After upgrade, manual retry succeeds with the original identity intact.
    upgraded = true;
    expect(await retryCapture(connection, captureId, adapters)).toBe(true);
    expect(captures.has(captureId)).toBe(false);
    expect(completionStates.get(captureId)).toBe('synced');
  });

  it('classifies strict-schema rejection as a hold and keeps reviewSuggestions', async () => {
    const strict = new ApiError(400, 'validation', 'Unrecognized key: reviewSuggestions', {
      serverCode: 'validation',
    });
    expect(isCompatibilityFailure(strict)).toBe(true);
    expect(isCompatibilityFailure(new ApiError(409, 'server_outdated', 'Server outdated'))).toBe(
      true,
    );
    expect(isCompatibilityFailure(new ApiError(400, 'validation', 'Name is required'))).toBe(false);

    const boxId = newId();
    const locId = newId();
    const exported = heldCaptureExport(
      {
        capture: {
          id: newId(),
          context: 'https://kept.example.com|user-1|epoch-0',
          takenAt: '2026-11-22T20:00:00Z',
          payload: JSON.stringify({
            locationId: locId,
            boxId,
            name: 'Held entry',
            note: 'Fragile',
            version: 1,
          }),
          files: [
            {
              file: { id: newId(), name: 'a.jpg', mime: 'image/jpeg', role: 'photo', bytes: 3 },
              sha256: 'e'.repeat(64),
            },
          ],
        },
        failure: 'compatibility_hold',
      },
      {
        things: [{ id: boxId, name: 'Attic Box' }],
        locations: [{ id: locId, name: 'Home' }],
      },
    );
    expect(exported.name).toBe('Held entry');
    expect(exported.note).toBe('Fragile');
    expect(exported.recoveryNotice).toMatch(/Automatic replay is paused/i);
    expect(exported.destination).toEqual({
      boxId,
      boxName: 'Attic Box',
      locationId: locId,
      locationName: 'Home',
    });
    expect(exported.files[0]?.sha256).toBe('e'.repeat(64));
  });

  it('sends the label given while adding as claimCode, and finishes when it was taken elsewhere', async () => {
    type SentOp = { clientId: string; idempotencyKey: string; payload: Record<string, unknown> };
    const sentOps: SentOp[][] = [];
    let answer: 'applied' | 'needs_review' = 'applied';
    const request = vi.fn().mockImplementation(async (_conn, path, options) => {
      if (path !== capturePaths.syncOps) throw new Error(`unexpected ${path}`);
      const { ops } = (options as { body: { ops: SentOp[] } }).body;
      sentOps.push(ops);
      return {
        results: ops.map((op) => ({
          clientId: op.clientId,
          idempotencyKey: op.idempotencyKey,
          outcome: answer,
          ...(answer === 'needs_review' ? { reason: 'already_claimed', inboxItemId: newId() } : {}),
          entity: { type: 'thing', id: op.clientId, shortCode: 'ABC234' },
        })),
      };
    });
    const { adapters, captures, completionStates } = makeInMemoryAdapters({
      request,
      capabilities: () => ({
        contractVersion: 1,
        capturePayloadVersions: [2, 3],
        account: connection.account,
        epoch: connection.epoch,
      }),
    });
    const locationId = newId();
    const placeId = newId();

    const first = await saveOnPhone(
      connection,
      { locationId, placeId, name: 'Camera', captureIntent: 'record', claimCode: 'ABC234' },
      [],
      adapters,
    );
    expect(heldCaptureExport(captures.get(first) as PendingCapture).claimCode).toBe('ABC234');
    await syncOutbox(connection, adapters);
    expect(sentOps[0]?.[0]?.payload).toMatchObject({
      id: first,
      name: 'Camera',
      claimCode: 'ABC234',
    });
    expect(completionStates.get(first)).toBe('synced');

    // Another phone claimed the label first: the item is made with its own code and the
    // label_claim inbox item settles it, so the capture is done rather than stuck.
    answer = 'needs_review';
    const second = await saveOnPhone(
      connection,
      { locationId, placeId, name: 'Lens', captureIntent: 'record', claimCode: 'ABC234' },
      [],
      adapters,
    );
    await syncOutbox(connection, adapters);
    expect(completionStates.get(second)).toBe('synced');
    expect(captures.has(second)).toBe(false);

    // Without a label, needs_review still holds the capture.
    const third = await saveOnPhone(
      connection,
      { locationId, placeId, name: 'Tripod', captureIntent: 'record' },
      [],
      adapters,
    );
    await syncOutbox(connection, adapters);
    expect(sentOps.at(-1)?.[0]?.payload.claimCode).toBeUndefined();
    expect(captures.get(third)?.failure).toBe('already_claimed');
  });

  it('registers an NFC tag written while adding once its label is claimed, and retries it offline', async () => {
    type SentOp = { clientId: string; idempotencyKey: string; payload: Record<string, unknown> };
    const tagBodies: unknown[] = [];
    let tagsOffline = true;
    let answer: 'applied' | 'needs_review' = 'applied';
    const request = vi.fn().mockImplementation(async (_conn, path, options) => {
      if (path === capturePaths.labelTags) {
        if (tagsOffline) throw new ApiError(0, 'offline', 'Offline');
        tagBodies.push((options as { body: unknown }).body);
        return { configured: true };
      }
      if (path !== capturePaths.syncOps) throw new Error(`unexpected ${path}`);
      const { ops } = (options as { body: { ops: SentOp[] } }).body;
      return {
        results: ops.map((op) => ({
          clientId: op.clientId,
          idempotencyKey: op.idempotencyKey,
          outcome: answer,
          ...(answer === 'needs_review' ? { reason: 'already_claimed', inboxItemId: newId() } : {}),
          entity: { type: 'thing', id: op.clientId, shortCode: 'NFC234' },
        })),
      };
    });
    const { adapters, captures, completionStates } = makeInMemoryAdapters({
      request,
      capabilities: () => ({
        contractVersion: 1,
        capturePayloadVersions: [2, 3],
        account: connection.account,
        epoch: connection.epoch,
      }),
    });
    const locationId = newId();
    const placeId = newId();
    const fields = {
      locationId,
      placeId,
      name: 'Drill',
      captureIntent: 'record',
      claimCode: 'NFC234',
      claimNfcVerified: true,
    } as const;

    const first = await saveOnPhone(connection, fields, [], adapters);
    await expect(syncOutbox(connection, adapters)).rejects.toThrow('Offline');
    expect(captures.has(first)).toBe(true);
    tagsOffline = false;
    await syncOutbox(connection, adapters);
    expect(completionStates.get(first)).toBe('synced');
    expect(tagBodies).toEqual([{ locationId, label: 'NFC234', kind: 'nfc' }]);

    // A label claimed first elsewhere is not this item's: its tag is not registered.
    answer = 'needs_review';
    const second = await saveOnPhone(connection, { ...fields, name: 'Saw' }, [], adapters);
    await syncOutbox(connection, adapters);
    expect(completionStates.get(second)).toBe('synced');
    expect(tagBodies).toHaveLength(1);
  });

  it('retries only the unfinished review work after a record-version conflict', async () => {
    const existingId = newId();
    const binId = newId();
    const binEvidenceId = newId();
    const updateId = newId();
    const createdId = newId();
    const patchKey = newId();
    const fileId = newId();
    const sha256 = 'a'.repeat(64);
    const patches: unknown[] = [];
    const calls: string[][] = [];
    let conflicting = true;
    const { adapters, captures, completionStates } = makeInMemoryAdapters({
      capabilities: () => ({
        contractVersion: 1,
        capturePayloadVersions: [2, 3, 4],
        account: connection.account,
        epoch: connection.epoch,
      }),
      async uploadOriginal() {
        return {
          id: fileId,
          sha256,
          bytes: 5,
          mime: 'image/jpeg',
          class: 'evidence',
          hasGps: false,
          width: 1,
          height: 1,
          derivativeState: 'ready',
          thumbUrl: null,
          displayUrl: null,
        };
      },
      async request<T>(
        _connection: Connection,
        path: string,
        options?: NativeRequestOptions,
      ): Promise<T> {
        if (path === capturePaths.syncOps && options) {
          const { ops } = options.body as {
            ops: {
              clientId: string;
              idempotencyKey: string;
              payloadVersion: number;
              payload: { attachToThingId?: string };
            }[];
          };
          calls.push(ops.map(({ clientId }) => clientId));
          return {
            results: ops.map((op) => ({
              clientId: op.clientId,
              idempotencyKey: op.idempotencyKey,
              outcome: 'applied',
              entity: { type: 'thing', id: op.payload.attachToThingId ?? op.clientId },
            })),
          } as T;
        }
        if (path === inventoryPaths.thing(existingId)) {
          patches.push(options);
          if (conflicting) throw new ApiError(412, 'precondition_failed', 'Changed');
          return {} as T;
        }
        return {
          items: [{ role: 'photo', file: { id: fileId, sha256, bytes: 5 } }],
          next_cursor: null,
        } as T;
      },
    });
    const id = await saveOnPhone(
      connection,
      {
        name: 'Bin review',
        boxId: binId,
        binEvidenceId,
        locationId: newId(),
        captureIntent: 'record',
        skipServerSuggestions: true,
        review: {
          accepted: true,
          entries: [
            {
              id: updateId,
              tagRequestId: newId(),
              name: 'Existing drill',
              quantity: '',
              include: true,
              categories: [],
              tags: [],
              existing: {
                id: existingId,
                update: { key: patchKey, rowVersion: 7, name: 'Existing drill', note: null },
              },
            },
            {
              id: createdId,
              tagRequestId: newId(),
              name: 'Lights',
              quantity: '',
              include: true,
              categories: [],
              tags: [],
            },
          ],
        },
      },
      [{ file: new File(['photo'], 'review.jpg', { type: 'image/jpeg' }), role: 'photo' }],
      adapters,
    );
    expect(await syncOutbox(connection, adapters)).toBe(0);
    const held = captures.get(id);
    expect(held?.failure).toBe('precondition_failed');
    expect(held && draftFields(held.capture).review?.verified).toEqual([createdId, binEvidenceId]);
    expect(completionStates.has(id)).toBe(false);
    expect(await syncOutbox(connection, adapters)).toBe(0);
    conflicting = false;
    expect(await retryCapture(connection, id, adapters)).toBe(true);
    // The applied op is answered from the phone's queue: it isn't sent again, only the PATCH is.
    expect(calls).toEqual([[updateId, createdId, binEvidenceId]]);
    expect(patches).toEqual(
      Array.from({ length: 2 }, () => ({
        method: 'PATCH',
        ifMatch: 7,
        idempotencyKey: patchKey,
        body: { name: 'Existing drill' },
      })),
    );
    expect(completionStates.get(id)).toBe('synced');
  });

  it('holds a photo with local suggestions before uploading to a server that only supports v3', async () => {
    const uploadOriginal = vi.fn();
    const request = vi.fn();
    const { adapters, captures } = makeInMemoryAdapters({
      request,
      uploadOriginal,
      capabilities: () => ({
        contractVersion: 1,
        capturePayloadVersions: [2, 3],
        account: connection.account,
        epoch: connection.epoch,
      }),
    });
    const id = await saveOnPhone(
      connection,
      {
        name: 'Assorted cables',
        locationId: newId(),
        captureIntent: 'record',
        skipServerSuggestions: true,
      },
      [{ file: new File(['photo'], 'cables.jpg', { type: 'image/jpeg' }), role: 'photo' }],
      adapters,
    );

    expect(await syncOutbox(connection, adapters)).toBe(0);
    expect(uploadOriginal).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    const held = captures.get(id);
    expect(held).toMatchObject({ failure: 'compatibility_hold', capture: { id } });
    if (!held) throw new Error('Expected the capture to stay in the outbox');
    expect(draftFields(held.capture).skipServerSuggestions).toBe(true);
  });

  it('probes /api/v1/me when capability negotiation returns 401 on pre-negotiation servers', async () => {
    const captureId = newId();
    const capture: Capture = {
      id: captureId,
      takenAt: '2026-11-22T20:00:00Z',
      payload: JSON.stringify({
        locationId: newId(),
        boxId: newId(),
        name: 'Pre-negotiation hold',
        batchId: newId(),
        version: 1,
      }),
      files: [],
    };
    let upgraded = false;
    let meAuthorized = true;
    const delegate = vi
      .fn()
      .mockImplementation(async (_conn: Connection, path: string, opts?: { body?: unknown }) => {
        if (path === paths.me) {
          if (!meAuthorized) throw new ApiError(401, 'unauthenticated', 'Expired');
          return { id: 'user-1' };
        }
        if (path === capturePaths.syncOps) {
          const op = (opts?.body as { ops?: Array<{ idempotencyKey?: string }> } | undefined)
            ?.ops?.[0];
          return {
            results: [
              {
                clientId: captureId,
                idempotencyKey: op?.idempotencyKey ?? captureId,
                outcome: 'applied',
                entity: { type: 'thing', id: captureId },
              },
            ],
          };
        }
        throw new Error(`Unexpected path ${path}`);
      });
    const uploadOriginal = vi.fn();
    const { adapters, captures, completionStates } = makeInMemoryAdapters({
      request: delegate,
      uploadOriginal,
      capabilities: () => {
        if (!upgraded) throw new ApiError(401, 'unauthenticated', 'Unauthenticated');
        return {
          contractVersion: 1,
          capturePayloadVersions: [2],
          account: connection.account,
          epoch: connection.epoch,
        };
      },
    });
    captures.set(captureId, { capture });

    // Pre-negotiation server: capability returns 401, /me returns 200 -> compatibility_hold.
    expect(await syncOutbox(connection, adapters)).toBe(0);
    expect(captures.get(captureId)?.failure).toBe('compatibility_hold');
    expect(uploadOriginal).not.toHaveBeenCalled();
    expect(delegate).toHaveBeenCalledTimes(1);
    expect(delegate).toHaveBeenCalledWith(connection, paths.me, undefined);

    // Genuine expiry (/me also 401) rethrows 401 rather than misclassifying as compatibility_hold.
    meAuthorized = false;
    await expect(retryCapture(connection, captureId, adapters)).rejects.toMatchObject({
      status: 401,
    });
    expect(captures.get(captureId)?.failure).toBeUndefined();

    // Server upgraded and session valid: retry succeeds with original identity intact.
    upgraded = true;
    meAuthorized = true;
    expect(await retryCapture(connection, captureId, adapters)).toBe(true);
    expect(captures.has(captureId)).toBe(false);
    expect(completionStates.get(captureId)).toBe('synced');
  });

  it('treats capability 429 as retryable, HTML 200 fallback as compatibility_hold, and restore reason as mismatch', async () => {
    const captureId = newId();
    const capture: Capture = {
      id: captureId,
      takenAt: '2026-11-22T20:00:00Z',
      payload: JSON.stringify({
        locationId: newId(),
        boxId: newId(),
        name: 'Edge classification',
        batchId: newId(),
        version: 1,
      }),
      files: [],
    };
    let mode: 'rate_limit' | 'html_fallback' | 'restore_reason' = 'rate_limit';
    const { adapters, captures } = makeInMemoryAdapters({
      capabilities: () => {
        if (mode === 'rate_limit') throw new ApiError(429, 'rate_limited', 'Slow down');
        if (mode === 'html_fallback') throw new SyntaxError('Unexpected token < in JSON');
        throw new ApiError(409, 'conflict', 'Conflict', {
          details: { reason: 'restore_epoch_mismatch' },
        });
      },
    });
    captures.set(captureId, { capture });

    await expect(syncOutbox(connection, adapters)).rejects.toMatchObject({ status: 429 });
    expect(captures.get(captureId)?.failure).toBe('rate_limited');
    expect(ACTION_REQUIRED_FAILURES.has('rate_limited')).toBe(false);

    await adapters.outbox.clearFailure(connection, captureId);
    mode = 'restore_reason';
    const restoreErr = await ensureCaptureCompatible(connection, adapters).catch((e: unknown) => e);
    expect(isRestoreEpochMismatch(restoreErr)).toBe(true);
    await expect(syncOutbox(connection, adapters)).rejects.toMatchObject({ status: 409 });
    expect(captures.get(captureId)?.failure).toBeUndefined();

    mode = 'html_fallback';
    expect(await syncOutbox(connection, adapters)).toBe(0);
    expect(captures.get(captureId)?.failure).toBe('compatibility_hold');

    expect(isAuthRefusal(new ApiError(401, 'unauthenticated', 'No'))).toBe(true);
    expect(isAuthRefusal(new ApiError(403, 'mfa_required', 'MFA'))).toBe(true);
    expect(isAuthRefusal(new ApiError(403, 'two_factor_required', '2FA'))).toBe(true);
    expect(isAuthRefusal(new ApiError(403, 'forbidden', 'Denied'))).toBe(false);
  });
});

// The phone loses the server (or the app is killed) between the steps of one capture's replay.
// Each step the server finished keeps its answer; nothing the server may have applied is sent
// again under its key with a different payload; nothing is applied twice.
describe('a replay interrupted between its steps', () => {
  type Op = {
    clientId: string;
    idempotencyKey: string;
    op: string;
    payload: { id?: string; thingIds?: string[]; add?: string[] };
  };
  const steps = ['create', 'tags', 'attachments'] as const;
  const fileId = newId();

  function fakeServer(failAfter: (typeof steps)[number] | 'none') {
    const ledger = new Map<string, { hash: string; result: unknown }>();
    const sent: Op[] = [];
    const things = new Set<string>();
    const tagged: string[][] = [];
    let failing = failAfter !== 'none';
    const lose = (step: (typeof steps)[number]) => {
      // The server did the work; the answer never reaches the phone.
      if (failing && step === failAfter) {
        failing = false;
        throw new ApiError(0, 'offline', 'Lost the connection');
      }
    };
    const request = vi.fn(async (_conn: Connection, path: string, options?: unknown) => {
      if (path === capturePaths.syncOps) {
        const { ops } = (options as { body: { ops: (Op & { clientVersion?: string })[] } }).body;
        const results = ops.map(({ clientVersion: _version, ...op }) => {
          sent.push(op);
          // The server's ledger (sync/ops.ts): the same key and request answer the same result.
          const hash = JSON.stringify(op);
          const prior = ledger.get(op.idempotencyKey);
          if (prior)
            return prior.hash === hash
              ? prior.result
              : {
                  clientId: op.clientId,
                  idempotencyKey: op.idempotencyKey,
                  outcome: 'dropped',
                  reason: 'idempotency_mismatch',
                };
          if (op.op === 'create_thing' && op.payload.id) things.add(op.payload.id);
          if (op.op === 'tag_things') tagged.push(op.payload.add ?? []);
          const result = {
            clientId: op.clientId,
            idempotencyKey: op.idempotencyKey,
            outcome: 'applied',
            ...(op.op === 'create_thing'
              ? { entity: { type: 'thing', id: op.payload.id ?? '' } }
              : {}),
          };
          ledger.set(op.idempotencyKey, { hash, result });
          return result;
        });
        lose(ops.some((op) => op.op === 'tag_things') ? 'tags' : 'create');
        return { results };
      }
      if (path.includes('/attachments')) {
        lose('attachments');
        return {
          items: [{ role: 'photo', file: { id: fileId, sha256: 'a'.repeat(64), bytes: 5 } }],
          next_cursor: null,
        };
      }
      throw new Error(`Unexpected path ${path}`);
    });
    return { request, sent, things, tagged, ledger };
  }

  it.each(steps)(
    'after the server finished the %s step, finishes once on the next run',
    async (step) => {
      const server = fakeServer(step);
      const uploadOriginal = vi
        .fn()
        .mockResolvedValue({ id: fileId, sha256: 'a'.repeat(64), bytes: 5 });
      const { adapters, completionStates, syncQueue } = makeInMemoryAdapters({
        request: server.request as PlatformAdapters['transport']['request'],
        uploadOriginal,
      });
      const tag = newId();
      const id = await saveOnPhone(
        connection,
        { locationId: newId(), boxId: newId(), name: 'Drill', tags: [tag] },
        [{ file: new File(['photo'], 'drill.jpg', { type: 'image/jpeg' }), role: 'photo' }],
        adapters,
      );

      await expect(syncOutbox(connection, adapters)).rejects.toMatchObject({ status: 0 });
      expect(completionStates.has(id)).toBe(false);
      expect(await syncOutbox(connection, adapters)).toBe(1);

      expect(completionStates.get(id)).toBe('synced');
      expect([...server.things]).toEqual([id]);
      expect(server.tagged).toEqual([[tag]]);
      // Every op sent more than once went byte for byte the same; none was refused as changed.
      const byKey = new Map<string, Op[]>();
      for (const op of server.sent)
        byKey.set(op.idempotencyKey, [...(byKey.get(op.idempotencyKey) ?? []), op]);
      for (const copies of byKey.values())
        for (const copy of copies) expect(copy).toEqual(copies[0]);
      expect(server.sent.map((op) => op.op).sort()).toEqual(
        step === 'create'
          ? ['create_thing', 'create_thing', 'tag_things']
          : step === 'tags'
            ? ['create_thing', 'tag_things', 'tag_things']
            : ['create_thing', 'tag_things'],
      );
      // An op answered before the interruption isn't sent again, and its files aren't uploaded again.
      expect(uploadOriginal).toHaveBeenCalledTimes(1);
      // Finishing the capture leaves nothing queued.
      expect(syncQueue.rowsOf(connection.id)).toEqual([]);
    },
  );

  it('refuses to retarget a capture whose op may have been applied, and allows it once dropped', async () => {
    let answer: 'lose' | 'trashed' = 'lose';
    const request = vi.fn(async (_conn: Connection, path: string, options?: unknown) => {
      if (path !== capturePaths.syncOps) throw new Error(`Unexpected path ${path}`);
      if (answer === 'lose') throw new ApiError(0, 'offline', 'Lost the connection');
      const { ops } = (options as { body: { ops: Op[] } }).body;
      return {
        results: ops.map((op) => ({
          clientId: op.clientId,
          idempotencyKey: op.idempotencyKey,
          outcome: 'dropped',
          reason: 'target_trashed',
        })),
      };
    });
    const { adapters, captures } = makeInMemoryAdapters({
      request: request as PlatformAdapters['transport']['request'],
      uploadOriginal: vi.fn().mockResolvedValue({ id: fileId, sha256: 'a'.repeat(64), bytes: 5 }),
    });
    const id = await saveOnPhone(
      connection,
      { locationId: newId(), boxId: newId(), name: 'Drill' },
      [{ file: new File(['photo'], 'drill.jpg', { type: 'image/jpeg' }), role: 'photo' }],
      adapters,
    );
    await expect(syncOutbox(connection, adapters)).rejects.toMatchObject({ status: 0 });
    // Shown as trashed (say, a stale answer) while the op is still `sent`: not retargeted.
    const pending = { capture: captures.get(id)?.capture as Capture, failure: 'target_trashed' };
    await expect(
      retargetCapture(connection, pending, { id: newId(), locationId: newId() }, adapters),
    ).rejects.toMatchObject({ reason: 'needs_review' });

    answer = 'trashed';
    expect(await syncOutbox(connection, adapters)).toBe(0);
    const failed = captures.get(id);
    expect(failed?.failure).toBe('target_trashed');
    const moved = await retargetCapture(
      connection,
      failed as PendingCapture,
      { id: newId(), locationId: newId() },
      adapters,
    );
    expect(draftFields(moved).attemptId).toBeDefined();
  });
});
