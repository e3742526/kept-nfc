import { I18nProvider } from '@lingui/react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { assistantPaths } from '@/api/assistant/paths';
import type { AskBody, ConfirmBody, Proposal } from '@/api/assistant/types';
import { capturePaths } from '@/api/capture/paths';
import { ApiError } from '@/api/client';
import { inventoryPaths } from '@/api/inventory/paths';
import type { Tag } from '@/api/inventory/types';
import { paths } from '@/api/paths';
import * as cameraSession from '@/camera/session';
import { ConfirmProvider } from '@/components/ui/confirm';
import { activateLocale, i18n } from '@/i18n/i18n';
import { expectLogicalOnly } from '@/test/render';
import { NativePlatformProvider, type PlatformAdapters } from './adapters';
import {
  type Capture,
  type Connection,
  type FindTagEvent,
  type NativeRequestOptions,
  type PendingCapture,
  StorageFullError,
  type TagReading,
} from './bridge';
import { KeptPhone } from './main';

beforeAll(async () => {
  await activateLocale('en');
});

type FakeEnvOptions = {
  initialConnection?: Connection | null;
  cabinLocation?: boolean;
  tags?: Tag[];
};

function createFakeEnvironment(opts: FakeEnvOptions = {}) {
  let currentConnection: Connection | null = opts.initialConnection ?? null;
  let online = true;
  let failStorageFull = false;
  let forceDropReason: string | null = null;
  let cabinLocation = opts.cabinLocation ?? false;

  const boxId = '11111111-1111-7111-8111-111111111111';
  const spareBoxId = '22222222-2222-7222-8222-222222222222';
  const locId = '33333333-3333-7333-8333-333333333333';
  const placeId = '44444444-4444-7444-8444-444444444444';

  const garage = {
    id: placeId,
    locationId: locId,
    parentId: null,
    name: 'Garage',
    kindKey: 'room',
    isUnplaced: false,
    deleted: false,
    rowVersion: 1,
    path: [],
    attachments: [],
  };
  const rooms = [garage];
  const outboxByContext = new Map<string, PendingCapture[]>();
  const cacheByContext = new Map<string, string>();
  const kvByContext = new Map<string, Map<string, string>>();
  const serverThings = new Map<string, Record<string, unknown>>([
    [
      boxId,
      {
        id: boxId,
        rowVersion: 1,
        locationId: locId,
        shortCode: '7KQ4MZ',
        labelPrinted: true,
        name: 'Winter Box',
        typeId: 'type-box',
        placeId,
        containerId: null,
        quantity: 1,
        lifecycle: 'in_use',
        derivedState: [],
        path: [{ id: placeId, name: 'Garage' }],
        containerThumbUrl: null,
        thumbUrl: null,
        lastSeenAt: null,
        isContainer: true,
        tags: [],
        brand: null,
        model: null,
        serial: null,
        barcode: null,
        colour: null,
        condition: null,
        notes: 'Top shelf',
        aliases: {},
        belongsTo: null,
        manualUrl: null,
        expiresOn: null,
        expiryLeadDays: null,
        ended: null,
        acquiredFrom: null,
        provenanceNotes: null,
        locationUncertain: false,
        reviewState: 'confirmed',
        fieldStatus: {},
        fields: [],
        custom: {},
        archivedCustom: {},
        secrets: [],
        contentsCount: 0,
        purchase: null,
        photos: [],
        attachmentsCount: 0,
        meters: [],
        links: [],
      },
    ],
    [
      spareBoxId,
      {
        id: spareBoxId,
        locationId: locId,
        shortCode: '9AB2CD',
        labelPrinted: true,
        name: 'Spare Box',
        typeId: 'type-box',
        placeId,
        containerId: null,
        quantity: 1,
        lifecycle: 'in_use',
        derivedState: [],
        path: [{ id: placeId, name: 'Garage' }],
        containerThumbUrl: null,
        thumbUrl: null,
        lastSeenAt: null,
        isContainer: true,
        tags: [],
        brand: null,
        model: null,
        serial: null,
        barcode: null,
        colour: null,
        condition: null,
        notes: null,
        aliases: {},
        belongsTo: null,
        manualUrl: null,
        expiresOn: null,
        expiryLeadDays: null,
        ended: null,
        acquiredFrom: null,
        provenanceNotes: null,
        locationUncertain: false,
        reviewState: 'confirmed',
        fieldStatus: {},
        fields: [],
        custom: {},
        archivedCustom: {},
        secrets: [],
        contentsCount: 0,
        purchase: null,
        photos: [],
        attachmentsCount: 0,
        meters: [],
        links: [],
      },
    ],
  ]);
  const attachmentsByThing = new Map<string, unknown[]>();
  const uploadedFiles = new Map<string, { sha256: string; bytes: number; mime: string }>();

  let findListener: ((reading: FindTagEvent) => void) | null = null;
  let resolveFind: ((value: TagReading & { sessionId?: string }) => void) | null = null;
  let currentFindSession: string | null = null;
  let capabilitiesOverride: ((conn: Connection) => unknown) | null = null;
  let meOverride: ((conn: Connection) => unknown) | null = null;
  const appStateListeners = new Set<(state: { active: boolean }) => void>();
  const scanSequence: TagReading[] = [];
  const completionsByContext = new Map<string, Map<string, 'synced' | 'discarded'>>();
  const getCompletions = (ctx: string) => {
    const existing = completionsByContext.get(ctx);
    if (existing) return existing;
    const next = new Map<string, 'synced' | 'discarded'>();
    completionsByContext.set(ctx, next);
    return next;
  };
  const isHeld = (candidate: string, current: string) => {
    if (candidate === current) return false;
    const a = candidate.split('|');
    const b = current.split('|');
    return (
      a.length === 3 &&
      b.length === 3 &&
      Boolean(a[0] && a[1] && a[2] && b[2]) &&
      a[0] === b[0] &&
      a[1] === b[1] &&
      a[2] !== b[2]
    );
  };

  const events = {
    matches: [] as string[],
    nonMatches: [] as string[],
    openedRemote: [] as Array<{ thing?: string; file: string; mime: string }>,
    openedPending: [] as Array<{ id: string; file: string }>,
    continueCalls: [] as Array<string | undefined>,
    continueSessions: [] as Array<string | undefined>,
    finishCalls: [] as Array<string | undefined>,
    finishSessions: [] as Array<string | undefined>,
    openedHeld: [] as Array<{ heldContext: string; id: string; file: string }>,
    exportedHeld: [] as Array<{ heldContext: string; id: string; metadata: string }>,
    uploadedFiles: [] as Array<{ id: string; file: string; location: string }>,
    disconnected: 0,
    sharedLabelPdfs: [] as { url: string; name: string }[],
  };

  const getQueue = (ctx: string) => {
    const existing = outboxByContext.get(ctx);
    if (existing) return existing;
    const next: PendingCapture[] = [];
    outboxByContext.set(ctx, next);
    return next;
  };

  const getKv = (ctx: string) => {
    const existing = kvByContext.get(ctx);
    if (existing) return existing;
    const next = new Map<string, string>();
    kvByContext.set(ctx, next);
    return next;
  };

  const adapters: PlatformAdapters = {
    credentials: {
      async connection() {
        return currentConnection;
      },
      async connect(address) {
        const origin = address.trim().replace(/\/+$/, '');
        currentConnection = {
          id: `${origin}|ibrahim|epoch-1`,
          origin,
          account: 'ibrahim',
          epoch: 'epoch-1',
        };
        return currentConnection;
      },
      async disconnect() {
        events.disconnected += 1;
        if (currentConnection) cacheByContext.delete(currentConnection.id);
        currentConnection = null;
        return { revoked: true };
      },
    },
    transport: {
      async request<T>(
        _conn: Connection,
        path: string,
        options?: NativeRequestOptions,
      ): Promise<T> {
        if (!online) throw new ApiError(0, 'offline', 'Offline');

        if (path === capturePaths.nativeCaptureCapabilities) {
          if (capabilitiesOverride) return capabilitiesOverride(_conn) as T;
          return {
            contractVersion: 1,
            capturePayloadVersions: [2, 3, 4],
            account: _conn.account,
            epoch: _conn.epoch,
          } as T;
        }
        if (path === paths.me) {
          if (meOverride) return meOverride(_conn) as T;
          return { id: 'ibrahim', email: 'ibrahim@kept.test' } as T;
        }
        if (path === inventoryPaths.thingsTags) return { changed: [], events: [] } as T;
        if (path.startsWith(inventoryPaths.accountRegistry('acc-1', 'tags'))) {
          return { items: opts.tags ?? [], next_cursor: null } as T;
        }
        if (path.startsWith(capturePaths.syncSnapshot)) {
          return {
            asOf: '2026-11-22T20:00:00Z',
            complete: true,
            nextCursor: null,
            locations: [
              {
                id: locId,
                ownerAccountId: 'acc-1',
                name: 'Home',
                role: 'owner',
                unplacedPlaceId: placeId,
              },
              ...(cabinLocation
                ? [
                    {
                      id: '55555555-5555-7555-8555-555555555555',
                      ownerAccountId: 'acc-1',
                      name: 'Cabin',
                      role: 'viewer',
                      unplacedPlaceId: '66666666-6666-7666-8666-666666666666',
                    },
                  ]
                : []),
            ],
            tags: { items: (opts.tags ?? []).map((tag) => ({ ...tag, accountId: 'acc-1' })) },
            types: {
              items: [{ id: 'type-box', builtinKey: 'box_bin', name: 'Box', isContainer: true }],
            },
            changes: {
              places: rooms,
              things: [...serverThings.values()].map((t) => ({
                id: t.id,
                locationId: locId,
                shortCode: t.shortCode,
                labelPrinted: t.labelPrinted,
                name: t.name,
                typeId: t.typeId,
                placeId: t.placeId,
                containerId: t.containerId,
                quantity: String(t.quantity),
                aliases: {},
                lifecycle: 'in_use',
                reviewState: t.reviewState,
                locationUncertain: false,
                lastSeenAt: null,
                coverFileId: null,
                isContainer: t.isContainer,
                deleted: false,
              })),
              codes: [
                {
                  code: '7KQ4MZ',
                  locationId: locId,
                  state: 'assigned',
                  thingId: boxId,
                  placeId: null,
                  isPrimary: true,
                  printedAt: null,
                },
                {
                  code: '9AB2CD',
                  locationId: locId,
                  state: 'assigned',
                  thingId: spareBoxId,
                  placeId: null,
                  isPrimary: true,
                  printedAt: null,
                },
              ],
              legacyCodes: [],
            },
            removed: [],
            revokedLocationIds: [],
          } as T;
        }
        if (path === inventoryPaths.locationPlaces(locId) && options?.method === 'POST') {
          const body = options.body as { id: string; name: string; kindKey: string };
          expect(options.idempotencyKey).toBe(body.id);
          const room = { ...garage, ...body };
          rooms.push(room);
          return room as T;
        }
        const room = rooms.find((entry) => inventoryPaths.place(entry.id) === path);
        if (room) return room as T;
        if (path === capturePaths.syncOps) {
          const body = options?.body as {
            ops: Array<{
              clientId: string;
              idempotencyKey: string;
              payload: {
                id: string;
                name?: string;
                note?: string;
                quantity?: string;
                target: { containerId?: string; placeId?: string };
                attachToThingId?: string;
                files: Array<{ fileId: string; role: string }>;
              };
            }>;
          };
          const results = body.ops.map((op) => {
            if (forceDropReason) {
              return {
                clientId: op.clientId,
                idempotencyKey: op.idempotencyKey,
                outcome: 'dropped',
                reason: forceDropReason,
              };
            }
            const createdId = op.payload.attachToThingId ?? op.payload.id;
            if (!op.payload.attachToThingId)
              serverThings.set(createdId, {
                id: createdId,
                locationId: locId,
                shortCode: '4CD5EF',
                labelPrinted: false,
                name: op.payload.name ?? null,
                typeId: null,
                placeId: op.payload.target.placeId ?? null,
                containerId: op.payload.target.containerId ?? null,
                quantity: Number(op.payload.quantity ?? 1),
                lifecycle: 'in_use',
                derivedState: [],
                path: [
                  { id: placeId, name: 'Garage' },
                  ...(op.payload.target.containerId ? [{ id: boxId, name: 'Winter Box' }] : []),
                ],
                containerThumbUrl: null,
                thumbUrl: null,
                lastSeenAt: null,
                isContainer: false,
                tags: [],
                brand: null,
                model: null,
                serial: null,
                barcode: null,
                colour: null,
                condition: null,
                notes: op.payload.note ?? null,
                aliases: {},
                belongsTo: null,
                manualUrl: null,
                expiresOn: null,
                expiryLeadDays: null,
                ended: null,
                acquiredFrom: null,
                provenanceNotes: null,
                locationUncertain: false,
                reviewState: 'confirmed',
                fieldStatus: {},
                fields: [],
                custom: {},
                archivedCustom: {},
                secrets: [],
                contentsCount: 0,
                purchase: null,
                photos: [],
                attachmentsCount: op.payload.files.length,
                meters: [],
                links: [],
              });
            attachmentsByThing.set(
              createdId,
              op.payload.files.map((f, index) => {
                const meta = uploadedFiles.get(f.fileId);
                return {
                  id: `att-${createdId}-${index}`,
                  role: f.role,
                  sort: index,
                  file: {
                    id: f.fileId,
                    sha256: meta?.sha256 ?? 'a'.repeat(64),
                    bytes: meta?.bytes ?? 10,
                    mime: meta?.mime ?? (f.role === 'photo' ? 'image/jpeg' : 'application/pdf'),
                    class: f.role === 'photo' ? 'evidence' : 'document',
                    hasGps: false,
                    width: null,
                    height: null,
                    derivativeState: 'ready',
                    thumbUrl: null,
                    displayUrl: null,
                  },
                  url: null,
                  subject: { thingId: createdId },
                  name: f.role === 'photo' ? 'photo.jpg' : 'manual.pdf',
                  createdBy: { displayName: 'Ibrahim' },
                  rowVersion: 1,
                };
              }),
            );
            return {
              clientId: op.clientId,
              idempotencyKey: op.idempotencyKey,
              outcome: 'applied',
              entity: { type: 'thing', id: createdId, shortCode: '4CD5EF' },
            };
          });
          return { results } as T;
        }
        if (path === capturePaths.scanResolve) {
          const text = (options?.body as { text?: string } | undefined)?.text ?? '';
          if (text.includes('7KQ4MZ') || text.trim().toUpperCase() === '7KQ4MZ') {
            return {
              outcome: 'open',
              target: { kind: 'thing', id: boxId, locationId: locId },
            } as T;
          }
          if (text.includes('9AB2CD') || text.trim().toUpperCase() === '9AB2CD') {
            return {
              outcome: 'open',
              target: { kind: 'thing', id: spareBoxId, locationId: locId },
            } as T;
          }
          if (text.includes('AMBIG1')) {
            return {
              outcome: 'legacy_ambiguous',
              candidates: [
                {
                  id: boxId,
                  kind: 'thing',
                  locationId: locId,
                  locationName: 'Home',
                  name: 'Winter Box',
                },
                {
                  id: spareBoxId,
                  kind: 'thing',
                  locationId: locId,
                  locationName: 'Home',
                  name: 'Spare Box',
                },
              ],
            } as T;
          }
          return { outcome: 'not_in_your_kept' } as T;
        }
        if (path === inventoryPaths.thingNotHere(boxId)) {
          const box = serverThings.get(boxId);
          expect(options?.ifMatch).toBe(box?.rowVersion);
          if (box) box.locationUncertain = true;
          return box as T;
        }
        if (path.startsWith(inventoryPaths.thingHistory(boxId))) {
          return {
            items: [
              {
                id: 'history-1',
                at: '2026-11-22T20:00:00Z',
                entity: { type: 'thing', id: boxId },
                actor: { displayName: 'Ibrahim' },
                action: 'thing.capture',
                summaryKey: 'thing.capture.attach',
                summaryParams: {},
                diff: {
                  mode: { after: 'thing', before: null, class: 'plain' },
                  captured_at: { after: '2026-11-22T19:30:00Z', before: null, class: 'plain' },
                },
              },
              ...['Cordless drill', 'Extension cords'].map((name) => ({
                id: `review-${name}`,
                at: '2026-11-22T19:59:00Z',
                location_id: locId,
                entity: { type: 'thing', id: `fixture-${name}` },
                actor: { displayName: 'Ibrahim' },
                action: 'thing.capture',
                summaryKey: 'thing.capture.recorded',
                summaryParams: { name },
                diff: {
                  capture_intent: { before: null, after: 'record', class: 'plain' },
                  batch_id: { before: null, after: 'one-review', class: 'plain' },
                  file_ids: { before: null, after: ['shared-photo'], class: 'plain' },
                  container_id: { before: null, after: boxId, class: 'plain' },
                  last_seen_at: { before: null, after: '2026-11-22T19:30:00Z', class: 'plain' },
                },
              })),
              {
                id: 'history-trash',
                at: '2026-11-22T19:58:00Z',
                entity: { type: 'thing', id: spareBoxId },
                actor: { displayName: 'Ibrahim' },
                action: 'thing.trash',
                summaryKey: 'thing.trash',
                summaryParams: { name: 'Spare Box' },
                diff: { removed_from_container_id: { after: boxId, before: null, class: 'plain' } },
              },
            ],
            next_cursor: null,
          } as T;
        }
        if (path.startsWith('/api/v1/things/')) {
          const attMatch = /^\/api\/v1\/things\/([^/]+)\/attachments/.exec(path);
          if (attMatch?.[1]) {
            return { items: attachmentsByThing.get(attMatch[1]) ?? [], next_cursor: null } as T;
          }
          const detailMatch = /^\/api\/v1\/things\/([^/?]+)$/.exec(path);
          if (detailMatch?.[1]) {
            const thing = serverThings.get(detailMatch[1]);
            if (!thing) throw new ApiError(404, 'not_found', 'Not found');
            if (options?.method === 'PATCH') {
              expect(options.ifMatch).toBe(thing.rowVersion);
              Object.assign(thing, options.body, { rowVersion: Number(thing.rowVersion) + 1 });
            }
            return thing as T;
          }
        }
        if (path.startsWith(capturePaths.inbox) && !path.includes('/accept')) {
          const items = [...serverThings.values()]
            .filter((t) => t.id !== boxId && t.id !== spareBoxId)
            .map((t) => ({
              id: 'inbox-item-1',
              kind: 'draft',
              locationId: locId,
              createdAt: '2026-11-22T20:00:00Z',
              createdBy: { displayName: 'Ibrahim' },
              rowVersion: 1,
              batch: null,
              thing: t,
              suggestions: [
                {
                  field: 'name',
                  value: 'Holiday glass ornaments',
                  confidence: 0.9,
                  source: { extractionId: 'ext-1', attachmentId: 'att-1' },
                },
              ],
            }));
          return {
            items,
            next_cursor: null,
            counts: { byKind: {}, mine: items.length, everyone: items.length },
          } as T;
        }
        if (path.includes('/accept')) {
          const body = options?.body as { set?: { name?: string } };
          if (body.set?.name) {
            for (const [id, thing] of serverThings) {
              if (id !== boxId && id !== spareBoxId) {
                thing.name = body.set.name;
              }
            }
          }
          return { item: undefined } as T;
        }
        throw new Error(`Unhandled request path: ${path}`);
      },
      async uploadOriginal(conn, input) {
        if (!online) throw new ApiError(0, 'offline', 'Offline');
        events.uploadedFiles.push({ id: input.id, file: input.file, location: input.location });
        const entry = getQueue(conn.id).find((q) => q.capture.id === input.id);
        const orig = entry?.capture.files.find((f) => f.file.id === input.file);
        if (!orig) throw new Error('Missing staged original');
        uploadedFiles.set(orig.file.id, {
          sha256: orig.sha256,
          bytes: orig.file.bytes,
          mime: orig.file.mime,
        });
        return {
          id: orig.file.id,
          sha256: orig.sha256,
          bytes: orig.file.bytes,
          mime: orig.file.mime,
          class: orig.file.role === 'photo' ? 'evidence' : 'document',
          hasGps: false,
          width: null,
          height: null,
          derivativeState: 'ready',
          thumbUrl: null,
          displayUrl: null,
        };
      },
    },
    outbox: {
      async stage() {},
      async save(conn, input) {
        if (failStorageFull) throw new StorageFullError();
        const files = JSON.parse(input.files) as Capture['files'][number]['file'][];
        getQueue(conn.id).push({
          capture: {
            id: input.id,
            payload: input.payload,
            takenAt: input.takenAt,
            files: files.map((file) => ({ file, sha256: 'd'.repeat(64) })),
          },
        });
      },
      async abort() {},
      async list(conn) {
        return [...getQueue(conn.id)];
      },
      async failed(conn, id, reason) {
        const list = getQueue(conn.id);
        const idx = list.findIndex((e) => e.capture.id === id);
        if (idx >= 0 && list[idx]) list[idx] = { capture: list[idx].capture, failure: reason };
      },
      async clearFailure(conn, id) {
        const list = getQueue(conn.id);
        const idx = list.findIndex((e) => e.capture.id === id);
        if (idx >= 0 && list[idx]) list[idx] = { capture: list[idx].capture };
      },
      async retarget(conn, id, payload) {
        const list = getQueue(conn.id);
        const idx = list.findIndex((e) => e.capture.id === id);
        if (idx < 0 || !list[idx]) throw new Error('missing');
        const updated: Capture = { ...list[idx].capture, payload };
        list[idx] = { capture: updated };
        return updated;
      },
      async complete(conn, id) {
        getCompletions(conn.id).set(id, 'synced');
        outboxByContext.set(
          conn.id,
          getQueue(conn.id).filter((e) => e.capture.id !== id),
        );
      },
      async discard(conn, id) {
        getCompletions(conn.id).set(id, 'discarded');
        outboxByContext.set(
          conn.id,
          getQueue(conn.id).filter((e) => e.capture.id !== id),
        );
      },
      async completions(conn) {
        return Object.fromEntries(getCompletions(conn.id));
      },
      async listHeld(conn) {
        const held: PendingCapture[] = [];
        for (const [ctx, queue] of outboxByContext) {
          if (!isHeld(ctx, conn.id)) continue;
          for (const entry of queue) {
            held.push({ ...entry, capture: { ...entry.capture, context: ctx } });
          }
        }
        return held;
      },
      async discardHeld(conn, heldContext, id) {
        if (!isHeld(heldContext, conn.id)) throw new Error('not held');
        getCompletions(heldContext).set(id, 'discarded');
        outboxByContext.set(
          heldContext,
          getQueue(heldContext).filter((e) => e.capture.id !== id),
        );
      },
      async stats(conn) {
        const list = getQueue(conn.id);
        return {
          pendingCount: list.length,
          pendingBytes: list.reduce(
            (sum, e) => sum + e.capture.files.reduce((s, f) => s + f.file.bytes, 0),
            0,
          ),
          cacheBytes: cacheByContext.get(conn.id)?.length ?? 0,
        };
      },
      async cached(conn) {
        return cacheByContext.get(conn.id);
      },
      async saveCache(conn, data) {
        cacheByContext.set(conn.id, data);
      },
      async clearCache(conn) {
        cacheByContext.delete(conn.id);
      },
      async getValue(conn, key) {
        return getKv(conn.id).get(key);
      },
      async setValue(conn, key, data) {
        getKv(conn.id).set(key, data);
      },
      async deleteValue(conn, key) {
        getKv(conn.id).delete(key);
      },
    },
    nfc: {
      async scanTag() {
        return scanSequence.shift() ?? { status: 'cancelled' };
      },
      startFind(_conn, input) {
        currentFindSession = input.sessionId;
        return new Promise<TagReading & { sessionId?: string }>((resolve) => {
          resolveFind = resolve;
        });
      },
      async continueFind(conn, sessionId, message) {
        void conn;
        events.continueCalls.push(message);
        events.continueSessions.push(sessionId);
      },
      async finishFind(conn, sessionId, message) {
        void conn;
        events.finishCalls.push(message);
        events.finishSessions.push(sessionId);
        // Native guard: a stale finish must not terminate a newer session.
        if (sessionId !== currentFindSession) return;
        resolveFind?.({ status: 'matched', sessionId });
        resolveFind = null;
      },
      async cancelTag(sessionId) {
        if (sessionId && currentFindSession && sessionId !== currentFindSession) return;
        resolveFind?.({ status: 'cancelled', sessionId: currentFindSession ?? undefined });
        resolveFind = null;
      },
      async onFindReading(callback) {
        findListener = callback;
        return () => {
          findListener = null;
        };
      },
    },
    feedback: {
      async match(_conn, announcement) {
        events.matches.push(announcement ?? '');
      },
      async nonMatch(_conn, announcement) {
        events.nonMatches.push(announcement ?? '');
      },
    },
    media: {
      async shareLabelPdf(_conn, input) {
        events.sharedLabelPdfs.push(input);
      },
      async openRemote(_conn, input) {
        events.openedRemote.push(input);
      },
      async openPending(_conn, input) {
        events.openedPending.push(input);
      },
      async openHeld(_conn, input) {
        events.openedHeld.push(input);
      },
      async exportHeld(_conn, input) {
        events.exportedHeld.push(input);
      },
    },
    lifecycle: {
      async takeLink() {
        return undefined;
      },
      async onLink() {
        return () => {};
      },
      async onAppStateChange(callback) {
        appStateListeners.add(callback);
        return () => {
          appStateListeners.delete(callback);
        };
      },
    },
  };

  function renderApp() {
    return render(
      <I18nProvider i18n={i18n}>
        <NativePlatformProvider adapters={adapters}>
          <ConfirmProvider>
            <KeptPhone />
          </ConfirmProvider>
        </NativePlatformProvider>
      </I18nProvider>,
    );
  }

  return {
    adapters,
    events,
    boxId,
    spareBoxId,
    renderApp,
    rooms,
    setOnline: (value: boolean) => {
      online = value;
    },
    revokeCabinLocation: () => {
      cabinLocation = false;
    },
    setStorageFull: (value: boolean) => {
      failStorageFull = value;
    },
    setForceDrop: (reason: string | null) => {
      forceDropReason = reason;
    },
    pushScan: (...readings: TagReading[]) => {
      scanSequence.push(...readings);
    },
    emitFindReading: (event: FindTagEvent) => {
      findListener?.({ sessionId: currentFindSession ?? undefined, ...event });
    },
    endFindSession: (status: string) => {
      resolveFind?.({ status, sessionId: currentFindSession ?? undefined });
      resolveFind = null;
    },
    seedHeld: (entry: PendingCapture, heldContext: string) => {
      getQueue(heldContext).push(entry);
    },
    seedPending: (entry: PendingCapture, ctx: string) => {
      getQueue(ctx).push(entry);
    },
    clearQueueWithoutCompletion: (ctx: string) => {
      outboxByContext.set(ctx, []);
    },
    getCurrentFindSession: () => currentFindSession,
    emitRawFindReading: (event: FindTagEvent) => {
      findListener?.(event);
    },
    emitAppState: (active: boolean) => {
      if (!active && resolveFind) {
        resolveFind({ status: 'interrupted', sessionId: currentFindSession ?? undefined });
        resolveFind = null;
      }
      for (const listener of appStateListeners) listener({ active });
    },
    setCapabilitiesHandler: (handler: ((conn: Connection) => unknown) | null) => {
      capabilitiesOverride = handler;
    },
    setMeHandler: (handler: ((conn: Connection) => unknown) | null) => {
      meOverride = handler;
    },
    completionsFor: (ctx: string) => Object.fromEntries(getCompletions(ctx)),
    setConnection: (conn: Connection | null) => {
      currentConnection = conn;
    },
  };
}

describe('KeptPhone mobile workflows', () => {
  it('resumes a two-photo review and syncs only selected entries with shared originals', async () => {
    const origin = 'https://kept.example.com';
    const category = (id: string, name: string): Tag => ({
      id,
      name,
      ownerAccountId: 'acc-1',
      rowVersion: 1,
      colour: null,
    });
    const tools = category('tools', 'Tools');
    const electrical = category('electrical', 'Electrical');
    const env = createFakeEnvironment({
      tags: [tools, electrical],
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    env.adapters.captureAI = {
      status: vi.fn(async () => ({ apple: 'available' as const })),
      connect: vi.fn(async () => ({ account: 'ibrahim@kept.test' })),
      disconnect: vi.fn(async () => ({ revoked: true })),
      models: vi.fn(async () => []),
      suggest: vi.fn(async (_connection, _provider, file) => ({
        name: JSON.stringify({
          items:
            file.name === 'second.jpg'
              ? [{ name: 'drill', quantity: 3 }, { name: 'Extension cord' }]
              : [
                  { name: 'Drill', quantity: 2, categories: ['Tools'] },
                  { name: 'Tape measure' },
                  { name: 'False positive' },
                ],
        }),
      })),
    };
    const user = userEvent.setup();
    const request = vi.spyOn(env.adapters.transport, 'request');
    const upload = vi.spyOn(env.adapters.transport, 'uploadOriginal');
    const mounted = env.renderApp();
    await user.click(
      within(await screen.findByRole('navigation')).getByRole('button', { name: 'Add' }),
    );
    const picker = document.querySelector<HTMLInputElement>(
      'input[type=file][accept="image/*"][multiple]',
    );
    if (!picker) throw new Error('Photo input is missing');
    await user.upload(picker, [
      new File([new Uint8Array([1, 2, 3])], 'review.jpg', { type: 'image/jpeg' }),
      new File([new Uint8Array([4, 5, 6])], 'second.jpg', { type: 'image/jpeg' }),
    ]);
    await user.click(await screen.findByRole('button', { name: /AI provider/ }));
    await user.click(await screen.findByRole('option', { name: 'Apple Intelligence' }));
    await user.click(screen.getByRole('button', { name: 'Suggest items' }));
    const names = await screen.findAllByRole('textbox', { name: 'Name' });
    expect(names).toHaveLength(4);
    const drill = names[0];
    if (!drill) throw new Error('Missing suggestion');
    const firstRow = drill.closest('.kept-card');
    if (!(firstRow instanceof HTMLElement)) throw new Error('Missing proposal card');
    await user.click(within(firstRow).getByRole('button', { name: 'Tools' }));
    await user.click(within(firstRow).getByText('Categories', { selector: 'summary' }));
    await user.type(
      await within(firstRow).findByRole('textbox', { name: 'Search categories' }),
      'elec',
    );
    await user.click(within(firstRow).getByRole('checkbox', { name: 'Electrical' }));
    await user.clear(drill);
    await user.type(drill, 'Cordless drill');
    await user.click(screen.getByRole('checkbox', { name: /False positive/ }));
    await user.click(screen.getByRole('button', { name: 'Add entry' }));
    const manual = screen.getAllByRole('textbox', { name: 'Name' }).at(-1);
    if (!manual) throw new Error('Missing manual row');
    await user.type(manual, 'Christmas lights');
    await user.click(screen.getByRole('button', { name: 'Save review for later' }));
    await screen.findByRole('button', { name: /^Review$/ });
    expect(request.mock.calls.filter(([, path]) => path === capturePaths.syncOps)).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
    mounted.unmount();
    env.renderApp();
    await user.click(await screen.findByRole('button', { name: /^Review$/ }));
    expect(await screen.findByDisplayValue('Cordless drill')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /False positive/ })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Save selected entries' }));
    await waitFor(() =>
      expect(request.mock.calls.some(([, path]) => path === capturePaths.syncOps)).toBe(true),
    );
    expect(upload).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.anything(),
        inventoryPaths.thingsTags,
        expect.objectContaining({
          body: expect.objectContaining({ add: [tools.id, electrical.id] }),
        }),
      ),
    );
    const sent = request.mock.calls.find(([, path]) => path === capturePaths.syncOps)?.[2]?.body;
    expect(sent).toMatchObject({
      ops: [
        {
          payloadVersion: 4,
          payload: {
            name: 'Cordless drill',
            quantity: undefined,
            captureIntent: 'record',
            skipServerSuggestions: true,
          },
        },
        { payloadVersion: 4, payload: { name: 'Tape measure', skipServerSuggestions: true } },
        { payloadVersion: 4, payload: { name: 'Extension cord', skipServerSuggestions: true } },
        { payloadVersion: 4, payload: { name: 'Christmas lights', skipServerSuggestions: true } },
      ],
    });
  });

  it('keeps manual photo capture usable after empty, malformed and cancelled proposals', async () => {
    const origin = 'https://workshop.kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    let resolveLate: (proposal: unknown) => void = () => {};
    const late = new Promise((resolve) => {
      resolveLate = resolve;
    });
    env.adapters.captureAI = {
      status: vi.fn(async () => ({ apple: 'unsupported' as const })),
      connect: vi.fn(async () => ({ account: 'ibrahim@kept.test' })),
      disconnect: vi.fn(async () => ({ revoked: true })),
      models: vi.fn(async () => []),
      suggest: vi.fn(async () => ({ name: '' })),
      serverProposals: vi
        .fn()
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({ items: [{ name: false }] })
        .mockReturnValueOnce(late),
    };
    const request = vi.spyOn(env.adapters.transport, 'request');
    const user = userEvent.setup();
    env.renderApp();
    await user.click(
      within(await screen.findByRole('navigation')).getByRole('button', { name: 'Add' }),
    );
    const picker = document.querySelector<HTMLInputElement>(
      'input[type=file][accept="image/*"][multiple]',
    );
    if (!picker) throw new Error('Photo picker is missing');
    await user.upload(picker, new File(['photo'], 'manual.jpg', { type: 'image/jpeg' }));
    for (let attempt = 0; attempt < 2; attempt++) {
      await user.click(await screen.findByRole('button', { name: 'Suggest items' }));
      expect(await screen.findByText('Could not suggest items from this photo.')).toBeVisible();
    }
    await user.click(screen.getByRole('button', { name: 'Suggest items' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel suggestions' }));
    await act(async () => resolveLate({ items: [{ name: 'Late drill' }] }));
    expect(screen.queryByDisplayValue('Late drill')).toBeNull();
    expect(request.mock.calls.some(([, path]) => path === capturePaths.syncOps)).toBe(false);
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Manual tools');
    await user.click(screen.getByRole('button', { name: /^Save (capture|to box)$/ }));
    await waitFor(() => {
      const sync = request.mock.calls.find(([, path]) => path === capturePaths.syncOps);
      expect(sync?.[2]?.body).toMatchObject({
        ops: [
          {
            payloadVersion: 4,
            payload: { name: 'Manual tools', captureIntent: 'record', skipServerSuggestions: true },
          },
        ],
      });
    });
  });

  it('offers optional categories for one broad description without replacing it', async () => {
    const origin = 'https://holiday.kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    env.adapters.captureAI = {
      status: vi.fn(async () => ({ apple: 'available' as const })),
      connect: vi.fn(async () => ({ account: 'ibrahim@kept.test' })),
      disconnect: vi.fn(async () => ({ revoked: true })),
      models: vi.fn(async () => []),
      suggest: vi.fn(async () => ({ name: '' })),
      serverProposals: vi.fn(async () => ({
        items: [
          { name: 'Christmas lights', categories: ['Electrical', 'Decorations'] },
          { name: 'Tinsel', categories: ['Decorations'] },
        ],
      })),
    };
    const user = userEvent.setup();
    env.renderApp();
    await user.click(
      within(await screen.findByRole('navigation')).getByRole('button', { name: 'Add' }),
    );
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Holiday supplies');
    const picker = document.querySelector<HTMLInputElement>(
      'input[type=file][accept="image/*"][multiple]',
    );
    if (!picker) throw new Error('Photo input is missing');
    await user.upload(
      picker,
      new File([new Uint8Array([1, 2, 3])], 'review.jpg', { type: 'image/jpeg' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Suggest categories' }));
    expect(await screen.findByDisplayValue('Holiday supplies')).toBeVisible();
    expect(screen.getAllByRole('textbox', { name: 'Name' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Create Electrical' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create Decorations' })).toBeVisible();
  });

  it('opens Assistant from its tab and confirms and undoes inventory changes', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const locationId = env.rooms[0]?.locationId;
    if (!locationId) throw new Error('The fixture needs an inventory location');
    const context = { kind: 'none' as const, recordOnly: true as const };
    const thread = { id: 'chat', title: null, context };
    const messages: { id: string; role: 'user'; parts: { type: 'text'; text: string }[] }[] = [];
    const proposals: Proposal[] = [];
    const inventory: string[] = [];
    const ask = vi.fn();
    const original = env.adapters.transport.request;
    const request = vi
      .spyOn(env.adapters.transport, 'request')
      .mockImplementation(
        async <T,>(conn: Connection, path: string, options?: NativeRequestOptions): Promise<T> => {
          if (path === assistantPaths.threads)
            return (options?.method === 'POST' ? thread : { items: [] }) as T;
          if (path === assistantPaths.thread(thread.id))
            return { thread, messages, proposals: proposals.map((p) => ({ ...p })) } as T;
          if (path === assistantPaths.threadTurns(thread.id)) {
            const body = options?.body as AskBody;
            ask(body);
            const id = String(proposals.length + 1);
            messages.push({ id, role: 'user', parts: [{ type: 'text', text: body.text }] });
            const adding = id === '1';
            const removing = id === '3';
            proposals.push({
              id,
              batchId: id,
              turnId: id,
              locationId,
              tool: adding ? 'add_thing' : removing ? 'remove_inventory_record' : 'update_thing',
              args: adding
                ? { items: [{ name: 'Socket wrench', quantity: 2 }] }
                : removing
                  ? { thing_id: env.boxId }
                  : { thing_id: env.boxId, fields: { name: 'Metric socket wrench' } },
              argsHash: `fixture-${id}`,
              before: adding ? {} : { name: 'Socket wrench' },
              refs: {
                [locationId]: { kind: 'location', name: 'Home', path: [] },
                [env.boxId]: { kind: 'thing', name: 'Socket wrench', path: ['Garage'] },
              },
              status: 'open',
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
            });
            return { turnId: id } as T;
          }
          if (path.startsWith(assistantPaths.turn('')))
            return { status: 'done', messages, proposals } as T;
          if (path === assistantPaths.proposalsConfirm) {
            const body = options?.body as ConfirmBody;
            const proposal = proposals.find((p) => p.batchId === body.batchId);
            if (!proposal) throw new Error('The request must confirm an existing proposal');
            expect(body.proposals).toEqual([{ id: proposal.id, argsHash: proposal.argsHash }]);
            proposal.status = 'confirmed';
            if (proposal.tool === 'remove_inventory_record') {
              proposal.audit = {
                eventId: 'trash-event',
                until: new Date(Date.now() + 600_000).toISOString(),
              };
            }
            inventory.push(proposal.tool);
            return { results: [{ id: proposal.id, status: 'confirmed' }] } as T;
          }
          if (path === inventoryPaths.undo('trash-event')) {
            inventory.pop();
            const removed = proposals.at(-1);
            if (removed?.audit) removed.audit.undone = true;
            return {} as T;
          }
          return original<T>(conn, path, options);
        },
      );
    const user = userEvent.setup();
    env.renderApp();
    const tabs = within(await screen.findByRole('navigation')).getAllByRole('button');
    expect(tabs.at(-2)).toHaveTextContent('More');
    expect(tabs.at(-1)).toHaveTextContent('Assistant');
    await user.click(
      within(await screen.findByRole('navigation')).getByRole('button', { name: 'Assistant' }),
    );
    expect(screen.queryByRole('button', { name: /^Location/ })).not.toBeInTheDocument();
    const question = screen.getByRole('textbox', { name: 'Ask the assistant' });
    await user.type(question, 'Add two socket wrenches');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Socket wrench')).toBeVisible();
    expect(ask).toHaveBeenCalledWith({
      text: 'Add two socket wrenches',
      context,
      locale: 'en',
    });
    expect(inventory).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Confirm 1' }));
    await waitFor(() => expect(inventory).toEqual(['add_thing']));
    await user.type(question, 'Rename it to Metric socket wrench');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Metric socket wrench')).toBeVisible();
    expect(inventory).toEqual(['add_thing']);
    await user.click(screen.getByRole('button', { name: 'Confirm 1' }));
    await waitFor(() => expect(inventory).toEqual(['add_thing', 'update_thing']));
    await user.type(question, 'Delete the old record');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Move to Trash')).toBeVisible();
    expect(inventory).toEqual(['add_thing', 'update_thing']);
    await user.click(screen.getByRole('button', { name: 'Confirm 1' }));
    await waitFor(() =>
      expect(inventory).toEqual(['add_thing', 'update_thing', 'remove_inventory_record']),
    );
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(inventory).toEqual(['add_thing', 'update_thing']));
    expect(await screen.findByText('Undone')).toBeVisible();
    expect(
      request.mock.calls
        .filter(([, , options]) => options?.method === 'POST')
        .map(([, path]) => path),
    ).toEqual([
      assistantPaths.threads,
      assistantPaths.threadTurns(thread.id),
      assistantPaths.proposalsConfirm,
      assistantPaths.threadTurns(thread.id),
      assistantPaths.proposalsConfirm,
      assistantPaths.threadTurns(thread.id),
      assistantPaths.proposalsConfirm,
      inventoryPaths.undo('trash-event'),
    ]);
  });

  it('keeps the native defaults from More across a relaunch and applies the photo provider', async () => {
    const origin = 'https://defaults.kept.example.com';
    const connection = {
      id: `${origin}|ibrahim|epoch-1`,
      origin,
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: connection });
    env.adapters.captureAI = {
      status: vi.fn(async () => ({ apple: 'available' as const })),
      connect: vi.fn(async () => ({ account: 'ibrahim@kept.test' })),
      disconnect: vi.fn(async () => ({ revoked: true })),
      models: vi.fn(async () => []),
      suggest: vi.fn(),
      serverProposals: vi.fn(),
    };
    const user = userEvent.setup();
    const first = env.renderApp();
    await user.click(
      within(await screen.findByRole('navigation')).getByRole('button', { name: 'More' }),
    );
    await user.click(await screen.findByRole('button', { name: /Default location/ }));
    await user.click(await screen.findByRole('option', { name: 'Home' }));
    await user.click(await screen.findByRole('button', { name: /Default photo AI/ }));
    await user.click(await screen.findByRole('option', { name: 'Apple Intelligence' }));
    await waitFor(async () => {
      expect(await env.adapters.outbox.getValue(connection, 'defaultLocation')).toBe(
        env.rooms[0]?.locationId,
      );
      expect(await env.adapters.outbox.getValue(connection, 'defaultPhotoAI')).toBe('apple');
    });
    first.unmount();
    env.renderApp();
    await user.click(
      within(await screen.findByRole('navigation')).getByRole('button', { name: 'More' }),
    );
    expect(await screen.findByRole('button', { name: /Default location/ })).toHaveTextContent(
      'Home',
    );
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Add' }));
    const picker = document.querySelector<HTMLInputElement>(
      'input[type=file][accept="image/*"][multiple]',
    );
    if (!picker) throw new Error('Photo picker is missing');
    await user.upload(picker, new File(['photo'], 'default.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByRole('button', { name: /AI provider/ })).toHaveTextContent(
      'Apple Intelligence',
    );
  });

  it('uses an authorized ChatGPT photo suggestion only when accepted, then skips server suggestions', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const ai = {
      status: vi.fn(async () => ({ apple: 'available' as const })),
      connect: vi.fn(async () => ({ account: 'ibrahim@kept.test' })),
      disconnect: vi.fn(async () => ({ revoked: true })),
      models: vi.fn(async () => [{ id: 'fixture-vision', name: 'Fixture vision model' }]),
      suggest: vi.fn(async () => ({ name: 'Assorted cables' })),
    };
    env.adapters.captureAI = ai;
    const request = vi.spyOn(env.adapters.transport, 'request');
    const user = userEvent.setup();
    env.renderApp();

    await user.click(
      within(await screen.findByRole('navigation')).getByRole('button', { name: 'Add' }),
    );
    const picker = document.querySelector<HTMLInputElement>(
      'input[type=file][accept="image/*"][multiple]',
    );
    if (!picker) throw new Error('Expected a photo picker');
    const photo = new File(['image bytes'], 'cables.jpg', { type: 'image/jpeg' });
    await user.upload(picker, photo);
    const description = screen.getByRole('textbox', { name: 'Description' });
    await user.type(description, 'My draft');

    await user.click(await screen.findByRole('button', { name: /AI provider/ }));
    await user.click(await screen.findByRole('option', { name: 'Apple Intelligence' }));
    await user.click(screen.getByRole('button', { name: 'Suggest description' }));
    expect(ai.suggest).toHaveBeenLastCalledWith(expect.anything(), 'apple', photo, undefined);
    expect(description).toHaveValue('My draft');

    await user.click(screen.getByRole('button', { name: /AI provider/ }));
    await user.click(await screen.findByRole('option', { name: 'ChatGPT plan' }));
    await user.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
    await user.click(await screen.findByRole('button', { name: 'Suggest description' }));
    expect(ai.connect).toHaveBeenCalledTimes(1);
    expect(ai.suggest).toHaveBeenLastCalledWith(
      expect.anything(),
      'chatgpt',
      photo,
      'fixture-vision',
    );
    expect(description).toHaveValue('My draft');
    await user.click(await screen.findByRole('button', { name: 'Use this description' }));
    expect(description).toHaveValue('Assorted cables');

    await user.click(screen.getByRole('button', { name: /^Save (capture|to box)$/ }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.anything(),
        capturePaths.syncOps,
        expect.objectContaining({
          body: expect.objectContaining({
            ops: [
              expect.objectContaining({
                payloadVersion: 4,
                payload: expect.objectContaining({
                  name: 'Assorted cables',
                  skipServerSuggestions: true,
                }),
              }),
            ],
          }),
        }),
      ),
    );
  });

  it('starts with the QR camera and switches between QR and NFC from Scan', async ({
    onTestFinished,
  }) => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const stopCamera = vi.fn();
    const getUserMedia = vi.fn(
      async () => ({ getTracks: () => [{ stop: stopCamera }] }) as unknown as MediaStream,
    );
    const camera = vi.spyOn(cameraSession, 'cameraEnv').mockReturnValue({
      secure: true,
      media: { getUserMedia },
    });
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    onTestFinished(() => {
      camera.mockRestore();
      play.mockRestore();
    });
    let deliverTag: (tag: TagReading) => void = () => {};
    const scanTag = vi.spyOn(env.adapters.nfc, 'scanTag').mockImplementationOnce(
      () =>
        new Promise<TagReading>((resolve) => {
          deliverTag = resolve;
        }),
    );
    const cancelTag = vi.spyOn(env.adapters.nfc, 'cancelTag');
    const user = userEvent.setup();
    env.renderApp();

    const scanTab = within(await screen.findByRole('navigation')).getByRole('button', {
      name: 'Scan',
    });
    await user.click(scanTab);
    expect(screen.getByLabelText('Camera view')).toBeInTheDocument();
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(scanTag).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Scan NFC tag' }));
    expect(screen.queryByLabelText('Camera view')).not.toBeInTheDocument();
    expect(stopCamera).toHaveBeenCalledBefore(scanTag);
    expect(scanTag).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Scan QR code' }));
    expect(cancelTag).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Camera view')).toBeInTheDocument();
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    // A tag result already on its way from the bridge cannot open a box after switching.
    await act(async () => deliverTag({ status: 'read', url: `${origin}/l/7KQ4MZ` }));
    expect(screen.getByRole('heading', { name: 'Identify a label' })).toBeInTheDocument();

    env.pushScan({ status: 'cancelled' }, { status: 'read', url: `${origin}/l/7KQ4MZ` });
    await user.click(screen.getByRole('button', { name: 'Scan NFC tag' }));
    expect(await screen.findByText('Scan cancelled.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Scan QR code' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Scan again' }));
    expect(await screen.findByRole('heading', { name: 'Winter Box' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Scan' }));
    expect(screen.getByLabelText('Camera view')).toBeInTheDocument();
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    expect(scanTag).toHaveBeenCalledTimes(3);
  });

  it('creates a room and captures an item there from the home destination picker', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const user = userEvent.setup();
    env.renderApp();
    await user.click(await screen.findByRole('button', { name: 'Rooms' }));
    await user.click(screen.getByRole('button', { name: 'Create room' }));
    await user.type(screen.getByRole('textbox', { name: 'Room name' }), 'Attic');
    await user.click(screen.getByRole('button', { name: 'Create room' }));
    expect(await screen.findByRole('heading', { name: 'Attic' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.click(screen.getByRole('button', { name: /Room or box/ }));
    await user.click(await screen.findByRole('option', { name: 'Attic' }));
    // The picker stays open until Done, so choosing a location never files the item by accident.
    expect(screen.getByRole('button', { name: /Room or box/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('Home › Attic')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Winter gloves');
    await user.click(screen.getByRole('button', { name: 'Save capture' }));
    expect(await screen.findByText('Synced: 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Rooms' }));
    await user.click(screen.getByRole('button', { name: /Attic/ }));
    expect(await screen.findByRole('button', { name: 'Winter gloves' })).toBeInTheDocument();
  });

  it('adds photos to a bin without a new item and shares its existing label URL', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const user = userEvent.setup();
    env.renderApp();
    await user.click(await screen.findByRole('button', { name: /Winter Box/i }));
    await user.click(screen.getByRole('button', { name: 'Add photos' }));
    expect(screen.queryByRole('textbox', { name: 'Description' })).not.toBeInTheDocument();
    const picker = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    if (!picker) throw new Error('Expected photo picker');
    await user.upload(picker, new File(['image bytes'], 'bin.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: 'Save photos' }));
    expect(await screen.findByText('Synced: 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(await screen.findByRole('button', { name: 'photo.jpg' }));
    expect(env.events.openedRemote.at(-1)?.thing).toBe(env.boxId);
    expect(screen.getByText('No cached contents.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'QR and NFC label' }));
    await user.click(screen.getByRole('button', { name: 'Share QR label PDF' }));
    expect(env.events.sharedLabelPdfs).toEqual([{ url: `${origin}/l/7KQ4MZ`, name: 'Winter Box' }]);
  });

  it('edits a bin in place and shows the last known location and photo history', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const user = userEvent.setup();
    env.renderApp();
    await user.click(await screen.findByRole('button', { name: /Winter Box/i }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const name = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Holiday bin');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(await screen.findByRole('heading', { name: 'Holiday bin' })).toBeInTheDocument();
    expect(screen.getByText('Top shelf')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('button', { name: 'Not here' }));
    expect(await screen.findByText(/Last known location/)).toHaveTextContent('Home › Garage');
    await user.click(screen.getByRole('button', { name: 'View history' }));
    expect(
      await screen.findByText('Photo added. No inventory or location changes recorded.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Record for .*Spare Box.* moved to Trash/)).toBeInTheDocument();
    const photoEvent = screen
      .getByText('Photo added. No inventory or location changes recorded.')
      .closest('li');
    expect(photoEvent?.querySelector('time')?.dateTime).toBe('2026-11-22T20:00:00Z');
    expect(photoEvent?.querySelectorAll('time')[1]?.dateTime).toBe('2026-11-22T19:30:00Z');
    expect(photoEvent).toHaveTextContent('Recorded at');
    expect(photoEvent).toHaveTextContent('Saved on device');
    const group = screen.getByText('Recorded 2 entries from photo review');
    await user.click(group);
    expect(screen.getByText(/Recorded .*Cordless drill.* in .*Holiday bin/)).toBeVisible();
    expect(screen.getByText(/Recorded .*Extension cords.* in .*Holiday bin/)).toBeVisible();
    expect(screen.queryByText('Observed at')).not.toBeInTheDocument();
  });

  it('keeps the address and allows retry after the browser sign-in sheet is cancelled', async () => {
    const env = createFakeEnvironment();
    const connect = vi
      .spyOn(env.adapters.credentials, 'connect')
      .mockRejectedValueOnce({ code: 'sign_in_cancelled' })
      .mockRejectedValueOnce({ code: 'network' })
      .mockRejectedValueOnce({ code: 'apple_sign_in_unsupported' });
    const user = userEvent.setup();
    env.renderApp();

    const address = 'https://kept.example.com';
    const serverField = await screen.findByLabelText('SheepKeep server address');
    await user.type(serverField, address);
    const signIn = screen.getByRole('button', { name: 'Sign in with Apple' });
    await user.click(signIn);
    expect(await screen.findByRole('status')).toHaveTextContent('Sign-in cancelled.');
    expect(serverField).toHaveValue(address);
    expect(signIn).toBeEnabled();

    await user.click(signIn);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Could not connect to SheepKeep. Check the server address and try again.',
    );

    await user.click(signIn);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Update this SheepKeep server to sign in with Apple.',
    );
    expect(serverField).toHaveValue(address);

    await user.click(signIn);
    expect(await screen.findByRole('button', { name: /Winter Box/i })).toBeInTheDocument();
    expect(connect).toHaveBeenCalledTimes(4);
    expect(connect).toHaveBeenLastCalledWith(address);
  });

  it('previews ordinary pending originals from the outbox after relaunch', async () => {
    const connection: Connection = {
      id: 'https://kept.example.com|ibrahim|epoch-1',
      origin: 'https://kept.example.com',
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: connection });
    const captureId = '66666666-6666-7666-8666-666666666666';
    const photoId = '55555555-5555-7555-8555-555555555555';
    const pdfId = '77777777-7777-7777-8777-777777777777';
    env.seedPending(
      {
        capture: {
          id: captureId,
          context: connection.id,
          payload: JSON.stringify({ boxId: env.boxId, name: 'Saved ornaments' }),
          takenAt: '2026-11-22T20:00:00Z',
          files: [
            {
              file: { id: photoId, name: 'saved.jpg', mime: 'image/jpeg', role: 'photo', bytes: 9 },
              sha256: 'f'.repeat(64),
            },
            {
              file: {
                id: pdfId,
                name: 'saved.pdf',
                mime: 'application/pdf',
                role: 'document',
                bytes: 8,
              },
              sha256: 'e'.repeat(64),
            },
          ],
        },
      },
      connection.id,
    );
    env.setOnline(false);
    const initial = env.renderApp();
    await screen.findByRole('region', { name: 'Pending captures' });
    initial.unmount();
    env.renderApp();

    const user = userEvent.setup();
    const outbox = within(await screen.findByRole('region', { name: 'Pending captures' }));
    const photo = outbox.getByRole('button', { name: /Preview.*saved\.jpg/ });
    const pdf = outbox.getByRole('button', { name: /Preview.*saved\.pdf/ });
    await waitFor(() => expect(photo).toBeEnabled());
    const preview = vi
      .spyOn(env.adapters.media, 'openPending')
      .mockRejectedValueOnce(new Error('Missing original'));
    await user.click(photo);
    expect(await screen.findByText('Could not open this pending original.')).toBeInTheDocument();
    expect(outbox.getByText('Saved ornaments')).toBeInTheDocument();
    expect(preview).toHaveBeenNthCalledWith(1, connection, { id: captureId, file: photoId });

    await user.click(pdf);
    expect(preview).toHaveBeenNthCalledWith(2, connection, { id: captureId, file: pdfId });
    expect(env.events.openedHeld).toHaveLength(0);

    const sync = Promise.withResolvers<void>();
    env.setOnline(true);
    const waitForServer = vi.fn(async () => {
      await sync.promise;
      throw new ApiError(0, 'offline', 'Offline');
    });
    env.setMeHandler(waitForServer);
    const retry = outbox.getByRole('button', { name: 'Retry' });
    const discard = outbox.getByRole('button', { name: 'Discard' });
    await user.click(outbox.getByRole('button', { name: 'Retry sync' }));
    await waitFor(() => expect(waitForServer).toHaveBeenCalledTimes(1));
    expect(retry).toBeDisabled();
    expect(discard).toBeDisabled();
    await user.click(photo);
    expect(preview).toHaveBeenNthCalledWith(3, connection, { id: captureId, file: photoId });
    await act(async () => sync.resolve());
    await waitFor(() => expect(retry).toBeEnabled());
    expect(discard).toBeEnabled();
  });

  it('supports login, offline capture of photo+PDF, pending preview, sync, remote open, and AI review', async () => {
    const env = createFakeEnvironment();
    const user = userEvent.setup();
    env.renderApp();

    const serverField = await screen.findByLabelText('SheepKeep server address');
    await user.type(serverField, 'https://kept.example.com');
    await user.click(screen.getByRole('button', { name: 'Sign in with Apple' }));

    const winterBoxBtn = await screen.findByRole('button', { name: /Winter Box/i });
    expect(winterBoxBtn).toHaveTextContent('Home › Garage');
    expectLogicalOnly();
    await user.click(winterBoxBtn);

    await screen.findByRole('button', { name: 'Add to this box' });
    await user.click(screen.getByRole('button', { name: 'Add to this box' }));

    // Capture offline with photo + PDF.
    env.setOnline(false);
    await user.type(screen.getByLabelText('Description'), 'Holiday decorations');
    await user.type(screen.getByLabelText('Notes'), 'Glass baubles');
    await user.type(screen.getByLabelText('Quantity (optional)'), '2');

    const photo = new File(['jpegbytes'], 'ornaments.jpg', { type: 'image/jpeg' });
    const pdf = new File(['%PDF-1.4'], 'packing-guide.pdf', { type: 'application/pdf' });
    const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
    expect(fileInputs.length).toBe(3);
    const photoInput = fileInputs.item(1);
    const pdfInput = fileInputs.item(2);
    if (!photoInput || !pdfInput) throw new Error('Expected photo and PDF file inputs');
    await user.upload(photoInput, photo);
    await user.upload(pdfInput, pdf);

    await user.click(screen.getByRole('button', { name: 'Save to box' }));
    expect(await screen.findByText('Saved on device.')).toBeInTheDocument();
    expect(screen.getByText('Entries in this batch: 1')).toBeInTheDocument();

    // Pending capture and pending original preview work inside the box before sync.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Pending captures')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'packing-guide.pdf' }));
    expect(env.events.openedPending).toHaveLength(1);

    // Return online and retry sync.
    env.setOnline(true);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(await screen.findByRole('button', { name: 'Retry sync' }));

    await waitFor(() => {
      expect(screen.queryByLabelText('Pending captures')).not.toBeInTheDocument();
    });

    // Reopen synced item, open remote original attachment, and edit AI suggestion.
    await user.click(await screen.findByRole('button', { name: /Winter Box/i }));
    await user.click(await screen.findByRole('button', { name: /^Holiday decorations/ }));

    await user.click(await screen.findByRole('button', { name: 'manual.pdf' }));
    expect(env.events.openedRemote).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Check AI suggestions' }));
    const suggestedInput = await screen.findByLabelText('Suggested description');
    expect(suggestedInput).toHaveValue('Holiday glass ornaments');
    await user.clear(suggestedInput);
    await user.type(suggestedInput, 'Holiday ornaments box');
    await user.click(screen.getByRole('button', { name: 'Use this description' }));
    expect(
      await screen.findByRole('heading', { name: 'Holiday ornaments box' }),
    ).toBeInTheDocument();
  });

  it('handles NFC enroll recovery, continuous Find nonmatch/offline/match, and target persistence', async () => {
    const conn: Connection = {
      id: 'https://kept.example.com|ibrahim|epoch-1',
      origin: 'https://kept.example.com',
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: conn });
    const user = userEvent.setup();
    const view = env.renderApp();

    await user.click(await screen.findByRole('button', { name: /Winter Box/i }));
    await user.click(await screen.findByRole('button', { name: 'QR and NFC label' }));

    // Enroll: occupied tag belonging to Spare Box + interrupted write + Verify recovery.
    env.pushScan(
      {
        status: 'inspected',
        occupied: true,
        writable: true,
        capacity: 140,
        required: 36,
        fingerprint: 'f'.repeat(64),
        url: 'https://kept.example.com/l/9AB2CD',
      },
      { status: 'write_unverified' },
      {
        status: 'inspected',
        occupied: true,
        writable: true,
        capacity: 140,
        required: 36,
        fingerprint: 'f'.repeat(64),
        url: 'https://kept.example.com/l/7KQ4MZ',
      },
    );

    await user.click(screen.getByRole('button', { name: 'Inspect NFC tag' }));
    expect(await screen.findByText(/Currently linked to:/)).toHaveTextContent('Spare Box');
    await user.click(screen.getByRole('button', { name: 'Overwrite NFC tag' }));
    expect(await screen.findByText(/Writing was interrupted/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Verify tag now' }));
    expect(
      await screen.findByText('This tag already contains the verified SheepKeep label.'),
    ).toBeInTheDocument();

    // Find mode: continuous session handles nonmatch, repeated, offline unresolved, timeout, and match.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(await screen.findByRole('button', { name: 'Find this box' }));

    await user.click(screen.getByRole('button', { name: 'Scan NFC tag' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Stop scanning' })).toBeInTheDocument(),
    );

    act(() => {
      env.emitFindReading({ status: 'read', url: 'https://kept.example.com/l/9AB2CD' });
    });
    expect(await screen.findByText(/not this box/)).toBeInTheDocument();
    expect(env.events.nonMatches).toHaveLength(1);
    expect(env.events.continueCalls).toHaveLength(1);

    act(() => {
      env.emitFindReading({ status: 'repeated' });
    });
    expect(
      await screen.findByText('Same tag scanned again. Move to another box.'),
    ).toBeInTheDocument();

    // Uncached offline tag is explicitly unresolved, never verified nonmatch.
    env.setOnline(false);
    act(() => {
      env.emitFindReading({ status: 'read', url: 'https://kept.example.com/l/ZZZZ99' });
    });
    expect(
      await screen.findByText(
        'This label could not be checked offline, so it is not confirmed as a different box.',
      ),
    ).toBeInTheDocument();
    expect(env.events.nonMatches).toHaveLength(1);
    env.setOnline(true);

    // A label lookup can finish after Core NFC has already timed out.
    let finishLookup = () => {};
    const lookupDelay = new Promise<void>((resolve) => {
      finishLookup = resolve;
    });
    const request = env.adapters.transport.request;
    const slowLookup = vi
      .spyOn(env.adapters.transport, 'request')
      .mockImplementation(async (connection, path, options) => {
        if (path === capturePaths.scanResolve) await lookupDelay;
        return request(connection, path, options);
      });
    act(() => {
      env.emitFindReading({ status: 'read', url: 'https://kept.example.com/l/7KQ4MZ' });
      env.endFindSession('timeout');
    });
    expect(await screen.findByRole('button', { name: 'Continue scanning' })).toBeInTheDocument();
    await act(async () => finishLookup());
    expect(env.events.matches).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Continue scanning' })).toBeInTheDocument();
    slowLookup.mockRestore();

    // Session B (restart after timeout) stays active until its own valid result:
    // A's late answer must not finish it, and a non-match keeps it scanning.
    const finishesBeforeB = env.events.finishCalls.length;
    await user.click(screen.getByRole('button', { name: 'Continue scanning' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Stop scanning' })).toBeInTheDocument(),
    );
    act(() => {
      env.emitFindReading({ status: 'read', url: 'https://kept.example.com/l/9AB2CD' });
    });
    expect(await screen.findByText(/not this box/)).toBeInTheDocument();
    expect(env.events.matches).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Stop scanning' })).toBeInTheDocument();
    act(() => {
      env.emitFindReading({ status: 'read', url: 'https://kept.example.com/l/7KQ4MZ' });
    });
    expect(await screen.findByRole('button', { name: 'Open box' })).toBeInTheDocument();
    expect(env.events.matches).toHaveLength(1);
    expect(env.events.finishCalls.length).toBe(finishesBeforeB + 1);
    // Finish and the preceding continue belong to the same (B) session, distinct
    // from session A's continue calls recorded before the timeout.
    expect(env.events.finishSessions.at(-1)).toBe(env.events.continueSessions.at(-1));
    expect(env.events.finishSessions.at(-1)).not.toBe(env.events.continueSessions[0]);

    view.unmount();
    env.renderApp();
    expect(await screen.findByText('Resumable Find target')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue finding' }));

    // Typed QR fallback in Find mode also triggers match feedback!
    await user.type(screen.getByLabelText('Type the code'), '7KQ4MZ');
    await user.click(screen.getByRole('button', { name: 'Open label' }));
    expect(await screen.findByRole('button', { name: 'Open box' })).toBeInTheDocument();
    expect(env.events.matches).toHaveLength(2);
  });

  it('handles storage exhaustion, action-required retargeting, and safe sign-out confirmation', async () => {
    const conn: Connection = {
      id: 'https://kept.example.com|ibrahim|epoch-1',
      origin: 'https://kept.example.com',
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: conn });
    const user = userEvent.setup();
    env.renderApp();

    await user.click(await screen.findByRole('button', { name: /Winter Box/i }));
    await user.click(await screen.findByRole('button', { name: 'Add to this box' }));

    env.setStorageFull(true);
    await user.type(screen.getByLabelText('Description'), 'Tools');
    await user.click(screen.getByRole('button', { name: 'Save to box' }));
    expect(
      await screen.findByText('Your iPhone storage is full. Free up space and try again.'),
    ).toBeInTheDocument();

    env.setStorageFull(false);
    env.setForceDrop('target_trashed');
    await user.click(screen.getByRole('button', { name: 'Save to box' }));
    expect(await screen.findByText('Saved on device.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(await screen.findByRole('button', { name: 'Back' }));

    expect(
      await screen.findByText(/The destination box is missing or in Trash/),
    ).toBeInTheDocument();

    // Safe sign-out confirmation warns when pending captures exist (sign-out lives in More).
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stay signed in' }));
    expect(env.events.disconnected).toBe(0);
    await user.click(
      within(screen.getByRole('navigation')).getByRole('button', { name: 'Search' }),
    );

    // Move failed capture to Spare Box and retry cleanly.
    env.setForceDrop(null);
    await user.click(screen.getByRole('button', { name: 'Change box' }));
    await user.click(screen.getByRole('button', { name: 'Move and retry' }));
    await waitFor(() => {
      expect(screen.queryByLabelText('Pending captures')).not.toBeInTheDocument();
    });
  });

  it('never counts a discarded offline capture as synced, and recovers held work', async () => {
    const conn: Connection = {
      id: 'https://kept.example.com|ibrahim|epoch-1',
      origin: 'https://kept.example.com',
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: conn });
    const user = userEvent.setup();
    env.renderApp();

    await user.click(await screen.findByRole('button', { name: /Winter Box/i }));
    await user.click(await screen.findByRole('button', { name: 'Add to this box' }));
    env.setOnline(false);
    await user.type(screen.getByLabelText('Description'), 'Offline discard me');
    await user.click(screen.getByRole('button', { name: 'Save to box' }));
    expect(await screen.findByText('Saved on device.')).toBeInTheDocument();
    expect(await screen.findByText(/Saved on device: 1/)).toBeInTheDocument();

    // Discard through the pending-work panel while the capture form stays open.
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    const discardButtons = screen.getAllByRole('button', { name: 'Discard' });
    const confirmDiscard = discardButtons.at(-1);
    if (!confirmDiscard) throw new Error('Expected a discard confirmation');
    await user.click(confirmDiscard);
    expect(await screen.findByText(/Discarded: 1/)).toBeInTheDocument();
    expect(screen.queryByText(/Synced:/)).not.toBeInTheDocument();
  });

  it('ignores delayed Find resolutions across timeout, cancellation, and backgrounding, and treats ambiguous reads as unresolved', async () => {
    const conn: Connection = {
      id: 'https://kept.example.com|ibrahim|epoch-1',
      origin: 'https://kept.example.com',
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: conn });
    const user = userEvent.setup();
    env.renderApp();

    await user.click(await screen.findByRole('button', { name: /Winter Box/i }));
    await user.click(await screen.findByRole('button', { name: 'Find this box' }));

    // 1. Audit scenario: Start session A -> scan target -> delay response -> A times out ->
    // start session B -> complete A's delayed response WHILE B is active -> B stays active!
    let resolveDelayedA = () => {};
    let delayedPromiseA = new Promise<void>((resolve) => {
      resolveDelayedA = resolve;
    });
    const baseRequest = env.adapters.transport.request;
    let delayScan = true;
    const scanSpy = vi
      .spyOn(env.adapters.transport, 'request')
      .mockImplementation(async (c, path, opts) => {
        if (path === capturePaths.scanResolve && delayScan) {
          await delayedPromiseA;
        }
        return baseRequest(c, path, opts);
      });

    await user.click(screen.getByRole('button', { name: 'Scan NFC tag' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Stop scanning' })).toBeInTheDocument(),
    );
    const sessionA = env.getCurrentFindSession();
    expect(sessionA).toEqual(expect.any(String));

    act(() => {
      env.emitFindReading({ status: 'read', url: 'https://kept.example.com/l/7KQ4MZ' });
      env.endFindSession('timeout');
    });
    expect(await screen.findByRole('button', { name: 'Continue scanning' })).toBeInTheDocument();

    delayScan = false;
    await user.click(screen.getByRole('button', { name: 'Continue scanning' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Stop scanning' })).toBeInTheDocument(),
    );
    const sessionB = env.getCurrentFindSession();
    expect(sessionB).toEqual(expect.any(String));
    expect(sessionB).not.toBe(sessionA);

    // Resolve session A's delayed lookup and also emit stale session-A and sessionless events while B runs.
    await act(async () => {
      resolveDelayedA();
      await Promise.resolve();
    });
    act(() => {
      if (sessionA) {
        env.emitRawFindReading({
          status: 'read',
          sessionId: sessionA,
          url: 'https://kept.example.com/l/7KQ4MZ',
        });
      }
      env.emitRawFindReading({
        status: 'read',
        url: 'https://kept.example.com/l/7KQ4MZ',
      });
    });

    expect(screen.getByRole('button', { name: 'Stop scanning' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open box' })).not.toBeInTheDocument();
    expect(env.events.matches).toHaveLength(0);
    expect(env.events.finishCalls).toHaveLength(0);

    // 2. Ambiguous Find reading remains unresolved (never a target match or non-match feedback).
    act(() => {
      env.emitFindReading({ status: 'read', url: 'https://kept.example.com/l/AMBIG1' });
    });
    expect(await screen.findByText(/cannot confirm whether it is this box/i)).toBeInTheDocument();
    expect(env.events.matches).toHaveLength(0);
    expect(env.events.nonMatches).toHaveLength(0);
    expect(env.events.continueSessions.at(-1)).toBe(sessionB);
    expect(screen.getByRole('button', { name: 'Stop scanning' })).toBeInTheDocument();

    // 3. Cancellation with in-flight delayed response also leaves next session C active.
    delayScan = true;
    let resolveDelayedB = () => {};
    delayedPromiseA = new Promise<void>((resolve) => {
      resolveDelayedB = resolve;
    });
    act(() => {
      env.emitFindReading({ status: 'read', url: 'https://kept.example.com/l/7KQ4MZ' });
    });
    await user.click(screen.getByRole('button', { name: 'Stop scanning' }));
    expect(await screen.findByText('Scan cancelled.')).toBeInTheDocument();

    delayScan = false;
    await user.click(screen.getByRole('button', { name: 'Scan NFC tag' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Stop scanning' })).toBeInTheDocument(),
    );
    const sessionC = env.getCurrentFindSession();
    expect(sessionC).not.toBe(sessionB);

    await act(async () => {
      resolveDelayedB();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Stop scanning' })).toBeInTheDocument();
    expect(env.events.matches).toHaveLength(0);

    // 4. App backgrounding invalidates session C and drops its delayed lookup.
    delayScan = true;
    let resolveDelayedC = () => {};
    delayedPromiseA = new Promise<void>((resolve) => {
      resolveDelayedC = resolve;
    });
    act(() => {
      env.emitFindReading({ status: 'read', url: 'https://kept.example.com/l/7KQ4MZ' });
      env.emitAppState(false);
    });
    expect(await screen.findByRole('button', { name: 'Continue scanning' })).toBeInTheDocument();
    await act(async () => {
      resolveDelayedC();
      await Promise.resolve();
    });
    expect(env.events.matches).toHaveLength(0);

    // 5. Fresh session D finally matches its own valid reading.
    delayScan = false;
    scanSpy.mockRestore();
    await user.click(screen.getByRole('button', { name: 'Continue scanning' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Stop scanning' })).toBeInTheDocument(),
    );
    const sessionD = env.getCurrentFindSession();
    act(() => {
      env.emitFindReading({ status: 'read', url: 'https://kept.example.com/l/7KQ4MZ' });
    });
    expect(await screen.findByRole('button', { name: 'Open box' })).toBeInTheDocument();
    expect(env.events.matches).toHaveLength(1);
    expect(env.events.finishSessions.at(-1)).toBe(sessionD);
  });

  it('keeps batch sync counts truthful across failed sync, async disappearance, and verified completion', async () => {
    const conn: Connection = {
      id: 'https://kept.example.com|ibrahim|epoch-1',
      origin: 'https://kept.example.com',
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: conn });
    const user = userEvent.setup();
    env.renderApp();

    await user.click(await screen.findByRole('button', { name: /Winter Box/i }));
    await user.click(await screen.findByRole('button', { name: 'Add to this box' }));

    // 1. Failed sync while form is open -> Needs attention: 1, never Synced or Saved on device.
    env.setForceDrop('target_trashed');
    await user.type(screen.getByLabelText('Description'), 'Failed batch item');
    await user.click(screen.getByRole('button', { name: 'Save to box' }));
    expect(await screen.findByText(/Needs attention: 1/)).toBeInTheDocument();
    expect(screen.queryByText(/Synced:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Saved on device:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Syncing:/)).not.toBeInTheDocument();

    // 2. Async queue disappearance without a `synced` completion never becomes Synced.
    env.setForceDrop(null);
    env.setOnline(false);
    await user.type(screen.getByLabelText('Description'), 'Disappear offline item');
    await user.click(screen.getByRole('button', { name: 'Save to box' }));
    expect(await screen.findByText(/Saved on device: 1/)).toBeInTheDocument();

    env.clearQueueWithoutCompletion(conn.id);
    env.setOnline(true);
    await user.type(screen.getByLabelText('Description'), 'Verified item');

    // Delay attachment verification on the third entry to confirm Synced waits for verification.
    let resolveAttachments = () => {};
    const attachmentGate = new Promise<void>((resolve) => {
      resolveAttachments = resolve;
    });
    const baseRequest = env.adapters.transport.request;
    const spy = vi
      .spyOn(env.adapters.transport, 'request')
      .mockImplementation(async (c, path, opts) => {
        if (path.includes('/attachments')) await attachmentGate;
        return baseRequest(c, path, opts);
      });

    const photo = new File(['jpegbytes'], 'item.jpg', { type: 'image/jpeg' });
    const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]');
    const photoInput = fileInputs.item(1);
    if (!photoInput) throw new Error('Expected photo input');
    await user.upload(photoInput, photo);
    await user.click(screen.getByRole('button', { name: 'Save to box' }));

    expect(screen.getByText('Entries in this batch: 3')).toBeInTheDocument();
    expect(screen.queryByText(/Synced:/)).not.toBeInTheDocument();

    await act(async () => {
      resolveAttachments();
      await Promise.resolve();
    });
    expect(await screen.findByText(/Synced: 1/)).toBeInTheDocument();
    expect(screen.queryByText(/Saved on device:/)).not.toBeInTheDocument();
    spy.mockRestore();
  });

  it('shows held pre-restore work only for matching origin and canonical account, with export and discard', async () => {
    const conn: Connection = {
      id: 'https://kept.example.com|ibrahim|epoch-1',
      origin: 'https://kept.example.com',
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: conn });
    const user = userEvent.setup();
    // Held (pre-restore) work for the same origin+account is reviewable, not replayed.
    env.seedHeld(
      {
        capture: {
          id: '66666666-6666-7666-8666-666666666666',
          context: 'https://kept.example.com|ibrahim|epoch-0',
          payload: JSON.stringify({
            locationId: '33333333-3333-7333-8333-333333333333',
            boxId: env.boxId,
            name: 'Held ornaments',
            note: 'From before the restore',
            version: 1,
          }),
          takenAt: '2026-11-20T20:00:00Z',
          files: [
            {
              file: {
                id: '55555555-5555-7555-8555-555555555555',
                name: 'held.jpg',
                mime: 'image/jpeg',
                role: 'photo',
                bytes: 9,
              },
              sha256: 'f'.repeat(64),
            },
          ],
        },
      },
      'https://kept.example.com|ibrahim|epoch-0',
    );
    // Cross-account and cross-server captures must never be exposed.
    env.seedHeld(
      {
        capture: {
          id: '77777777-7777-7777-8777-777777777777',
          context: 'https://kept.example.com|alfred|epoch-0',
          payload: JSON.stringify({
            locationId: '33333333-3333-7333-8333-333333333333',
            boxId: env.boxId,
            name: 'Alfred secret item',
            version: 1,
          }),
          takenAt: '2026-11-20T20:00:00Z',
          files: [],
        },
      },
      'https://kept.example.com|alfred|epoch-0',
    );
    env.seedHeld(
      {
        capture: {
          id: '88888888-8888-7888-8888-888888888888',
          context: 'https://other.example.com|ibrahim|epoch-0',
          payload: JSON.stringify({
            locationId: '33333333-3333-7333-8333-333333333333',
            boxId: env.boxId,
            name: 'Other server item',
            version: 1,
          }),
          takenAt: '2026-11-20T20:00:00Z',
          files: [],
        },
      },
      'https://other.example.com|ibrahim|epoch-0',
    );

    env.renderApp();
    expect(await screen.findByText(/Held captures: 1/)).toBeInTheDocument();
    expect(screen.getByText('Held ornaments')).toBeInTheDocument();
    expect(screen.getByText(/From before the restore/)).toBeInTheDocument();
    expect(screen.getByText('f'.repeat(64))).toBeInTheDocument();
    expect(screen.getByText(/automatic replay is paused/i)).toBeInTheDocument();
    expect(screen.queryByText('Alfred secret item')).not.toBeInTheDocument();
    expect(screen.queryByText('Other server item')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Preview/ }));
    expect(env.events.openedHeld).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Export details' }));
    expect(env.events.exportedHeld).toHaveLength(1);
    const exportedJson = JSON.parse(env.events.exportedHeld[0]?.metadata ?? '{}') as {
      name?: string;
      note?: string;
      recoveryNotice?: string;
      destination?: { boxName?: string };
      files?: Array<{ sha256: string }>;
    };
    expect(exportedJson.name).toBe('Held ornaments');
    expect(exportedJson.note).toBe('From before the restore');
    expect(exportedJson.recoveryNotice).toMatch(/Automatic replay is paused/i);
    expect(exportedJson.destination?.boxName).toBe('Winter Box');
    expect(exportedJson.files?.[0]?.sha256).toBe('f'.repeat(64));

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    const heldDiscard = screen.getAllByRole('button', { name: 'Discard' });
    const confirmHeldDiscard = heldDiscard.at(-1);
    if (!confirmHeldDiscard) throw new Error('Expected a discard confirmation');
    await user.click(confirmHeldDiscard);
    await waitFor(() => {
      expect(screen.queryByText(/Held captures:/)).not.toBeInTheDocument();
    });
  });

  it('keeps an authenticated phone signed in on a pre-negotiation server 401 and retries after upgrade', async () => {
    const conn: Connection = {
      id: 'https://kept.example.com|ibrahim|epoch-1',
      origin: 'https://kept.example.com',
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: conn });
    const user = userEvent.setup();
    let upgraded = false;
    env.setCapabilitiesHandler(() => {
      if (!upgraded) throw new ApiError(401, 'unauthenticated', 'Unauthenticated');
      return {
        contractVersion: 1,
        capturePayloadVersions: [2],
        account: conn.account,
        epoch: conn.epoch,
      };
    });
    env.seedPending(
      {
        capture: {
          id: '99999999-9999-7999-8999-999999999999',
          payload: JSON.stringify({
            locationId: '33333333-3333-7333-8333-333333333333',
            boxId: env.boxId,
            batchId: '99999999-9999-7999-8999-999999999999',
            name: 'Hold for upgrade',
            version: 1,
          }),
          takenAt: '2026-11-22T20:00:00Z',
          files: [
            {
              file: {
                id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
                name: 'photo.jpg',
                mime: 'image/jpeg',
                role: 'photo',
                bytes: 10,
              },
              sha256: 'a'.repeat(64),
            },
          ],
        },
      },
      conn.id,
    );

    env.renderApp();
    expect(
      await screen.findByText(/This SheepKeep server is older and cannot accept this capture yet/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Hold for upgrade')).toBeInTheDocument();
    expect(screen.queryByLabelText('SheepKeep server address')).not.toBeInTheDocument();
    expect(env.events.uploadedFiles).toHaveLength(0);

    // Upgrade server and retry manually.
    upgraded = true;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.queryByLabelText('Pending captures')).not.toBeInTheDocument();
    });
    expect(env.events.uploadedFiles).toHaveLength(1);
  });

  it('renders Arabic RTL with logical CSS only', async () => {
    const conn: Connection = {
      id: 'https://kept.example.com|ibrahim|epoch-1',
      origin: 'https://kept.example.com',
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: conn });
    try {
      await activateLocale('ar');
      document.documentElement.dir = 'rtl';
      env.renderApp();
      expect(await screen.findByRole('button', { name: /Winter Box/i })).toBeInTheDocument();
      expectLogicalOnly();
    } finally {
      document.documentElement.dir = 'ltr';
      await activateLocale('en');
    }
  });

  it('keeps a capture draft and its original when navigation is cancelled', async () => {
    const env = createFakeEnvironment({
      initialConnection: {
        id: 'https://kept.example.com|ibrahim|epoch-1',
        origin: 'https://kept.example.com',
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const user = userEvent.setup();
    const view = env.renderApp();
    await user.click(await screen.findByRole('button', { name: /Winter Box/i }));
    await user.click(await screen.findByRole('button', { name: 'Add to this box' }));
    await user.type(await screen.findByLabelText('Description'), 'Holiday decorations');
    const original = new File(['a photo'], 'holiday.jpg', { type: 'image/jpeg' });
    const fileInput = view.container.querySelector<HTMLInputElement>('input[type=file]');
    if (!fileInput) throw new Error('Expected a photograph input');
    await user.upload(fileInput, original);

    const tabbar = screen.getByRole('navigation');
    await user.click(within(tabbar).getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Adding to box')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    await user.click(within(tabbar).getByRole('button', { name: 'More' }));
    let dialog = await screen.findByRole('alertdialog', { name: 'Discard this draft?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Description')).toHaveValue('Holiday decorations');
    expect(screen.getByText(/holiday.jpg/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    dialog = await screen.findByRole('alertdialog', { name: 'Discard this draft?' });
    await user.click(within(dialog).getByRole('button', { name: 'Discard draft' }));
    expect(await screen.findByRole('button', { name: 'Add to this box' })).toBeInTheDocument();
    expect(env.events.uploadedFiles).toHaveLength(0);
  });

  it('shows the remaining boxes when the selected location is revoked', async () => {
    const env = createFakeEnvironment({
      initialConnection: {
        id: 'https://kept.example.com|ibrahim|epoch-1',
        origin: 'https://kept.example.com',
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
      cabinLocation: true,
    });
    const user = userEvent.setup();
    env.renderApp();
    expect(await screen.findByRole('button', { name: /Winter Box/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Location/ }));
    await user.click(screen.getByRole('option', { name: 'Cabin' }));
    expect(screen.queryByRole('button', { name: /Winter Box/i })).not.toBeInTheDocument();

    env.revokeCabinLocation();
    act(() => env.emitAppState(true));
    expect(await screen.findByRole('button', { name: /Winter Box/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Location/ })).not.toBeInTheDocument();
  });

  it('navigates by tabs, switches appearance, and keeps overlap destinations reachable', async () => {
    const conn: Connection = {
      id: 'https://kept.example.com|ibrahim|epoch-1',
      origin: 'https://kept.example.com',
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: conn });
    const user = userEvent.setup();
    env.renderApp();

    // The tab bar is the main navigation: Search, Add, Scan, More.
    const tabbar = await screen.findByRole('navigation');
    expect(within(tabbar).getByRole('button', { name: 'Search' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(tabbar).getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(within(tabbar).getByRole('button', { name: 'Scan' })).toBeInTheDocument();
    expect(within(tabbar).getByRole('button', { name: 'More' })).toBeInTheDocument();

    // The Scan tab opens label identification with a back button.
    await user.click(within(tabbar).getByRole('button', { name: 'Scan' }));
    expect(await screen.findByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(within(tabbar).getByRole('button', { name: 'Scan' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // The Capture tab opens the capture form with a back button.
    await user.click(within(tabbar).getByRole('button', { name: 'Add' }));
    expect(await screen.findByLabelText('Description')).toBeInTheDocument();

    // The More tab compartments settings, appearance, and secondary workflows.
    await user.click(within(tabbar).getByRole('button', { name: 'More' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    for (const theme of ['Light', 'Dark', 'System']) {
      expect(screen.getByRole('button', { name: theme })).toHaveAttribute('aria-pressed');
    }
    await user.click(screen.getByRole('button', { name: 'Dark' }));
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    await user.click(screen.getByRole('button', { name: 'System' }));

    // Color palette variations layer over light/dark/system modes.
    for (const palette of ['Default', 'Slate', 'Meadow', 'High contrast']) {
      expect(screen.getByRole('button', { name: palette })).toHaveAttribute('aria-pressed');
    }
    await user.click(screen.getByRole('button', { name: 'High contrast' }));
    expect(screen.getByRole('button', { name: 'High contrast' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(document.documentElement.getAttribute('data-palette')).toBe('contrast');
    await user.click(screen.getByRole('button', { name: 'Default' }));
    expect(document.documentElement.getAttribute('data-palette')).toBeNull();

    // Scan and Add already have tabs, so More does not repeat them; secondary workflows stay.
    expect(screen.queryByRole('button', { name: 'Scan QR or NFC' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print label sheets' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trash' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();

    // Search is the landing screen: the search field comes first, Rooms stays one tap away,
    // and sign-out lives only in More.
    await user.click(within(tabbar).getByRole('button', { name: 'Search' }));
    const search = await screen.findByRole('searchbox', { name: 'Search inventory' });
    expect(screen.getByRole('button', { name: 'Rooms' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Capture inventory' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();

    // Re-tapping the active Search tab focuses the search field.
    await user.click(within(tabbar).getByRole('button', { name: 'Search' }));
    expect(search).toHaveFocus();
    expectLogicalOnly();
  });

  it('opens photo search from Browse and keeps its result when returning from the matching bin', async () => {
    const connection = {
      id: 'https://kept.example.com|ibrahim|epoch-1',
      origin: 'https://kept.example.com',
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: connection });
    const room = env.rooms[0];
    if (!room) throw new Error('Expected a room fixture');
    const coverage = { generation: 'whole-image-1', ready: 2, pending: 0, failed: 0, paused: 0 };
    const match = {
      thingId: env.boxId,
      locationId: room.locationId,
      name: 'Winter Box',
      path: [{ id: room.id, name: room.name }],
      attachmentId: '55555555-5555-7555-8555-555555555555',
      fileId: '66666666-6666-7666-8666-666666666666',
      capturedAt: '2026-11-23T09:30:00Z',
      score: 0.42,
      mime: 'image/heic',
      isContainer: true,
    };
    const adapter = {
      status: vi.fn().mockResolvedValue(coverage),
      upload: vi.fn(),
      search: vi.fn().mockResolvedValue({ outcome: 'matches', coverage, matches: [match] }),
      cancel: vi.fn(),
      thumbnail: vi.fn().mockResolvedValue('/fixture-thumb.jpg'),
    };
    env.adapters.visualSearch = adapter;
    const original = vi.spyOn(env.adapters.media, 'openRemote').mockResolvedValue(undefined);
    const user = userEvent.setup();
    env.renderApp();
    expect(await screen.findByRole('button', { name: 'Search with a photo' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Browse' }));
    await user.type(screen.getByRole('textbox', { name: 'Search' }), 'red connector');
    await user.click(screen.getByRole('button', { name: 'Find in photos' }));
    expect(await screen.findByText('Bin photo')).toBeInTheDocument();
    const results = screen.getByRole('list', { name: 'Possible photo matches' });
    expect(within(results).getByText('Garage')).toBeInTheDocument();
    expect(results.querySelector('img')).toHaveAttribute(
      'src',
      `${connection.origin}/fixture-thumb.jpg`,
    );
    await user.click(within(results).getByRole('button', { name: 'Open original photo' }));
    expect(original).toHaveBeenCalledWith(connection, {
      thing: match.thingId,
      file: match.fileId,
      mime: 'image/heic',
    });
    await user.click(within(results).getByRole('button', { name: 'Open record' }));
    expect(await screen.findByRole('button', { name: 'QR and NFC label' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Possible photo matches' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('list', { name: 'Possible photo matches' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Describe what you are looking for' })).toHaveValue(
      'red connector',
    );
    expect(adapter.search).toHaveBeenCalledExactlyOnceWith(connection, {
      text: 'red connector',
      limit: 8,
    });
  });

  it('turns a search with no match into an add, prefilled and focused on the next item', async () => {
    const env = createFakeEnvironment({
      initialConnection: {
        id: 'https://kept.example.com|ibrahim|epoch-1',
        origin: 'https://kept.example.com',
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const user = userEvent.setup();
    env.renderApp();
    await screen.findByRole('button', { name: /Winter Box/i });
    await user.type(screen.getByRole('searchbox', { name: 'Search inventory' }), 'Snow shovel');
    await user.click(await screen.findByRole('button', { name: /Add .*Snow shovel/ }));
    expect(screen.getByLabelText('Description')).toHaveValue('Snow shovel');
    // The destination is a one-line summary; the full picker opens only on Change.
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Room or box/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save capture' }));
    expect(await screen.findByText('Saved on device.')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toHaveValue('');
  });

  it('suggests the box opened last as the next destination', async () => {
    const env = createFakeEnvironment({
      initialConnection: {
        id: 'https://kept.example.com|ibrahim|epoch-1',
        origin: 'https://kept.example.com',
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const user = userEvent.setup();
    env.renderApp();
    await user.click(await screen.findByRole('button', { name: /Winter Box/i }));
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText(/Winter Box/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Description'), 'Scarf');
    await user.click(screen.getByRole('button', { name: 'Save capture' }));
    expect(await screen.findByText('Saved on device.')).toBeInTheDocument();
  });
});
