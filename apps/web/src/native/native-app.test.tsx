import type { SnapshotPage } from '@kept/shared';
import { I18nProvider } from '@lingui/react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { assistantPaths } from '@/api/assistant/paths';
import type { AskBody, ConfirmBody, Proposal } from '@/api/assistant/types';
import { capturePaths } from '@/api/capture/paths';
import { ApiError } from '@/api/client';
import { inventoryPaths } from '@/api/inventory/paths';
import type {
  AttachmentView,
  CreateAttachmentBody,
  FileView,
  Tag,
  ThingView,
  UpdateAttachmentBody,
} from '@/api/inventory/types';
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
import { saveOnPhone } from './outbox';

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
  const unplacedId = '88888888-8888-7888-8888-888888888888';

  const garage = {
    id: placeId,
    locationId: locId,
    parentId: null as string | null,
    description: null as string | null,
    name: 'Garage',
    kindKey: 'room',
    isUnplaced: false,
    deleted: false,
    rowVersion: 1,
    path: [],
    counts: { things: 0, places: 0 },
    attachments: [] as AttachmentView[],
  };
  const rooms = [garage, { ...garage, id: unplacedId, name: 'Unplaced', isUnplaced: true }];
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
  const locationPhotosByThing = new Map<string, unknown[]>();
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
    openedRemote: [] as Parameters<PlatformAdapters['media']['openRemote']>[1][],
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
    reservedLabelKeys: [] as Array<string | undefined>,
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
            capturePayloadVersions: [2, 3, 4, 5],
            placeDescriptions: true,
            placeCreationPayloadVersion: 6,
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
                effectiveModules: ['labels'],
                name: 'Home',
                role: 'owner',
                unplacedPlaceId: unplacedId,
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
          const body = options.body as {
            id: string;
            name: string;
            kindKey: string;
            parentId?: string;
            description?: string;
          };
          expect(options.idempotencyKey).toBe(body.id);
          const room = { ...garage, ...body };
          rooms.push(room);
          return room as T;
        }
        const room = rooms.find((entry) => inventoryPaths.place(entry.id) === path);
        if (room) {
          if (options?.method === 'PATCH') {
            if (options.ifMatch !== room.rowVersion)
              throw new ApiError(412, 'precondition_failed', 'Stale');
            Object.assign(room, options.body);
            room.rowVersion++;
          }
          const path = [{ id: room.id, name: room.name }];
          let next = room;
          while (next.parentId) {
            const parent = rooms.find((entry) => entry.id === next.parentId);
            if (!parent) break;
            path.unshift({ id: parent.id, name: parent.name });
            next = parent;
          }
          return { ...room, path } as T;
        }
        if (path === capturePaths.syncOps) {
          const body = options?.body as {
            ops: Array<{
              clientId: string;
              op: string;
              idempotencyKey: string;
              takenAt: string;
              payload: {
                id: string;
                parentId?: string | null;
                kindKey?: string;
                description?: string | null;
                name?: string;
                note?: string;
                quantity?: string;
                target: { containerId?: string; placeId?: string };
                attachToThingId?: string;
                locationPhoto?: true;
                claimCode?: string;
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
            if (op.op === 'create_area') {
              const { id, name, parentId, description, kindKey } = op.payload;
              rooms.push({
                ...garage,
                id,
                name: name ?? '',
                parentId: parentId ?? null,
                description: description ?? null,
                kindKey: kindKey ?? 'room',
              });
              return {
                clientId: op.clientId,
                idempotencyKey: op.idempotencyKey,
                outcome: 'applied',
                entity: { type: 'place', id },
              };
            }
            const createdId = op.payload.attachToThingId ?? op.payload.id;
            if (!op.payload.attachToThingId)
              serverThings.set(createdId, {
                id: createdId,
                locationId: locId,
                shortCode: op.payload.claimCode ?? '4CD5EF',
                labelPrinted: !!op.payload.claimCode,
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
            const attachments = op.payload.files.map((f, index) => {
              const meta = uploadedFiles.get(f.fileId);
              const hasPreview = f.role === 'photo' && meta?.mime === 'image/jpeg';
              return {
                id: `att-${createdId}-${index}`,
                role: op.payload.locationPhoto ? 'document' : f.role,
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
                  thumbUrl: hasPreview ? '/f/fixture-thumb.jpg' : null,
                  displayUrl: hasPreview ? '/f/fixture-display.jpg' : null,
                },
                url: null,
                subject: { thingId: createdId },
                name: f.role === 'photo' ? 'photo.jpg' : 'manual.pdf',
                ...(op.payload.locationPhoto ? { locationPhotoTakenAt: op.takenAt } : {}),
                createdBy: { displayName: 'Ibrahim' },
                rowVersion: 1,
              };
            });
            if (op.payload.locationPhoto) locationPhotosByThing.set(createdId, attachments);
            else attachmentsByThing.set(createdId, attachments);
            return {
              clientId: op.clientId,
              idempotencyKey: op.idempotencyKey,
              outcome: 'applied',
              entity: { type: 'thing', id: createdId, shortCode: '4CD5EF' },
            };
          });
          return { results } as T;
        }
        if (path === capturePaths.labelReserve) {
          events.reservedLabelKeys.push(options?.idempotencyKey);
          return {
            code: 'RSV234',
            url: 'https://kept.example.com/l/RSV234',
            locationId: (options?.body as { locationId?: string } | undefined)?.locationId,
          } as T;
        }
        if (path === capturePaths.scanResolve) {
          const text = (options?.body as { text?: string } | undefined)?.text ?? '';
          if (text.includes('BNK234') || text.includes('RSV234'))
            return { outcome: 'claim', locationId: locId } as T;
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
          if (text.endsWith('/4CD5EF')) {
            const item = [...serverThings.values()].find((thing) => thing.shortCode === '4CD5EF');
            if (item)
              return {
                outcome: 'open',
                target: { kind: 'thing', id: item.id, locationId: locId },
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
        if (path.startsWith(inventoryPaths.activity)) {
          return {
            items: [
              {
                id: 'activity-1',
                at: '2026-11-22T20:00:00Z',
                location_id: locId,
                entity: { type: 'thing', id: boxId },
                actor: { type: 'user', id: 'u1', displayName: 'Ibrahim' },
                action: 'thing.create',
                summaryKey: 'event',
                summaryParams: { name: 'Fixture ladder', action: 'thing.create' },
                summary: 'Fixture ladder added',
                diff: { name: { before: null, after: 'Fixture ladder', class: 'plain' } },
              },
            ],
            next_cursor: null,
          } as T;
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
        const attachmentMatch = /^\/api\/v1\/attachments\/([^/?]+)$/.exec(path);
        if (attachmentMatch?.[1] && options?.method === 'PATCH') {
          for (const entries of attachmentsByThing.values()) {
            const found = entries.find(
              (entry) => (entry as { id: string }).id === attachmentMatch[1],
            );
            if (found) {
              Object.assign(found, {
                photoArchivedAt: (options.body as { photoArchived: boolean }).photoArchived
                  ? '2026-11-23T10:00:00Z'
                  : undefined,
              });
              return found as T;
            }
          }
          throw new ApiError(404, 'not_found', 'Not found');
        }
        if (path.startsWith('/api/v1/things/')) {
          const attMatch = /^\/api\/v1\/things\/([^/]+)\/attachments/.exec(path);
          if (attMatch?.[1]) {
            const archived = new URL(path, origin).searchParams.get('archivedPhotos') === 'true';
            const items = (attachmentsByThing.get(attMatch[1]) ?? []).filter(
              (entry) =>
                Boolean((entry as { photoArchivedAt?: string }).photoArchivedAt) === archived,
            );
            return {
              items,
              next_cursor: null,
              locationPhotos: locationPhotosByThing.get(attMatch[1]) ?? [],
            } as T;
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
    serverThings,
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

async function continueToItemDetails(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^(Add manually|Continue)$/ }));
}

async function saveNewItem(user: ReturnType<typeof userEvent.setup>) {
  const next = screen.queryByRole('button', { name: 'Continue to labels' });
  if (next) await user.click(next);
  await user.click(screen.getByRole('button', { name: /^(Skip NFC and save|Save item)$/ }));
}

async function openItemLabelPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Continue to labels' }));
  await user.click(screen.getByText('QR or NFC label'));
}

async function openSettings(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    within(await screen.findByRole('navigation')).getByRole('button', { name: 'More' }),
  );
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
}

/** Home is a command center now: boxes are one tap away behind the Boxes tile. */
async function openWinterBox(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole('navigation');
  const tile = screen.queryByRole('button', { name: /Boxes$/ });
  if (tile) {
    await waitFor(() => expect(tile).toBeEnabled());
    await user.click(tile);
  }
  await user.click(await screen.findByRole('button', { name: /Winter Box/i }));
}

describe('KeptPhone mobile workflows', () => {
  it('enrolls a place label and scans it into an active capture without losing the draft', async () => {
    const origin = 'https://kept.example.com';
    const connection = {
      id: `${origin}|ibrahim|epoch-1`,
      origin,
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: connection });
    const garage = env.rooms[0];
    if (!garage) throw new Error('Missing Garage');
    const code = 'P14CE2';
    const url = `${origin}/l/${code}`;
    const alias = 'GARAGE-SHELF-LABEL';
    const request = env.adapters.transport.request;
    const issue = vi.fn();
    const syncCapture = vi.fn();
    const scanTag = vi.spyOn(env.adapters.nfc, 'scanTag');
    env.adapters.transport.request = async <T,>(
      context: Connection,
      path: string,
      options?: NativeRequestOptions,
    ): Promise<T> => {
      if (path === inventoryPaths.placeLabel(garage.id)) {
        issue(options);
        return { code } as T;
      }
      if (path === capturePaths.scanResolve) {
        const text = (options?.body as { text?: string })?.text;
        if (text === url || text === alias) {
          return { outcome: 'open', target: { ...garage, kind: 'place' } } as T;
        }
      }
      if (path === capturePaths.syncOps) syncCapture(options?.body);
      return request(context, path, options);
    };
    const user = userEvent.setup();
    env.renderApp();
    await user.click(await screen.findByRole('button', { name: /Places$/ }));
    await user.click(screen.getByRole('button', { name: /^Garage/ }));
    await user.click(await screen.findByRole('button', { name: 'QR and NFC label' }));
    expect(await screen.findByText(code)).toBeInTheDocument();
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST' }));
    const fingerprint = 'c'.repeat(64);
    env.pushScan(
      {
        status: 'inspected',
        occupied: false,
        writable: true,
        required: 30,
        capacity: 140,
        fingerprint,
      },
      { status: 'written' },
    );
    await user.click(screen.getByRole('button', { name: 'Inspect NFC tag' }));
    await user.click(await screen.findByRole('button', { name: 'Write and verify' }));
    expect(await screen.findByText('SheepKeep tag verified.')).toBeInTheDocument();
    expect(scanTag).toHaveBeenLastCalledWith(
      connection,
      expect.objectContaining({
        mode: 'write',
        url,
        fingerprint,
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Add' }));
    await continueToItemDetails(user);
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'USB cable');
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.click(screen.getByRole('button', { name: 'Scan place label' }));
    const scanner = within(await screen.findByRole('dialog', { name: 'Scan place label' }));
    env.pushScan({ status: 'read', url });
    await user.click(await scanner.findByRole('button', { name: 'Scan NFC tag' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Scan place label' })).toBeNull(),
    );
    await user.click(screen.getByRole('button', { name: 'Scan place label' }));
    const legacyScanner = within(await screen.findByRole('dialog', { name: 'Scan place label' }));
    await user.type(await legacyScanner.findByRole('textbox', { name: 'Type the code' }), alias);
    await user.click(legacyScanner.getByRole('button', { name: 'Open label' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Scan place label' })).toBeNull(),
    );
    expect(syncCapture).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('USB cable');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('Home › Garage')).toBeInTheDocument();
    await saveNewItem(user);
    expect(await screen.findByText('Synced: 1')).toBeInTheDocument();
    expect(syncCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        ops: [
          expect.objectContaining({
            locationId: garage.locationId,
            payload: expect.objectContaining({ name: 'USB cable', target: { placeId: garage.id } }),
          }),
        ],
      }),
    );
  });

  it('opens Where to look from an item and switches the historical grouping', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const request = env.adapters.transport.request;
    const recordedAt = '2026-11-24T10:00:00Z';
    const row = {
      locationId: env.rooms[0]?.locationId,
      locationName: 'Home',
      count: 3,
      lastRecordedAt: recordedAt,
    };
    const history = vi.fn(() => ({
      rooms: [{ ...row, path: ['Garage'] }],
      destinations: [{ ...row, path: ['Garage', 'Shelf 1'] }],
      locations: [{ ...row, path: [] }],
      limited: true,
    }));
    env.adapters.transport.request = async <T,>(
      connection: Connection,
      path: string,
      options?: NativeRequestOptions,
    ): Promise<T> =>
      path === inventoryPaths.placementHistory(env.boxId)
        ? (history() as T)
        : request(connection, path, options);
    const user = userEvent.setup();
    env.renderApp();
    await openWinterBox(user);
    expect(history).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Where to look' }));
    expect(await screen.findByText('Recorded placements 3')).toBeVisible();
    expect(screen.getByText('Based on the most recent recorded placements.')).toBeVisible();
    await user.click(screen.getByRole('radio', { name: 'Exact places' }));
    expect(screen.getByText(/Shelf 1/)).toBeVisible();
    await user.click(screen.getByRole('radio', { name: 'Locations' }));
    expect(screen.queryByText(/Shelf 1/)).toBeNull();
    expect(history).toHaveBeenCalledTimes(1);
  });

  it.each([
    { description: 'Fixture  WRENCH', expectedQuantity: '4' },
    { description: '', expectedQuantity: '4' },
    { description: 'Screwdriver', expectedQuantity: '' },
  ])(
    'carries the entered quantity into a single-item photo review for description "$description"',
    async ({ description, expectedQuantity }) => {
      const origin = 'https://kept.example.com';
      const connection = {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      };
      const env = createFakeEnvironment({ initialConnection: connection });
      env.adapters.captureAI = {
        status: vi.fn(async () => ({ apple: 'unsupported' as const })),
        connect: vi.fn(async () => ({ account: 'ibrahim@kept.test' })),
        disconnect: vi.fn(async () => ({ revoked: true })),
        models: vi.fn(async () => []),
        suggest: vi.fn(async () => ({ name: '' })),
        serverProposals: vi.fn(async () => ({
          items: [{ name: 'Fixture wrench', quantity: 2 }],
        })),
      };
      await env.adapters.outbox.setValue(connection, 'defaultPhotoAI', 'server');

      const request = vi.spyOn(env.adapters.transport, 'request');
      const user = userEvent.setup();
      const mounted = env.renderApp();
      await user.click(
        within(await screen.findByRole('navigation')).getByRole('button', { name: 'Add' }),
      );
      const picker = document.querySelector<HTMLInputElement>(
        'input[type=file][accept="image/*"][multiple]',
      );
      if (!picker) throw new Error('Photo input is missing');
      await user.upload(picker, new File(['photo'], 'review.jpg', { type: 'image/jpeg' }));
      await continueToItemDetails(user);
      if (description)
        await user.type(screen.getByRole('textbox', { name: 'Description' }), description);
      await user.click(screen.getByText('Details', { selector: 'summary' }));
      await user.type(screen.getByRole('textbox', { name: 'Quantity (optional)' }), '4');
      await user.click(await screen.findByRole('button', { name: 'Suggest items' }));

      await screen.findByRole('heading', { name: 'Photo review' });
      await user.click(screen.getByText('Details', { selector: 'summary' }));
      expect(screen.getByRole('textbox', { name: 'Quantity (optional)' })).toHaveValue(
        expectedQuantity,
      );
      expect(screen.getByText('AI estimate: 2')).toBeVisible();

      await user.click(screen.getByRole('button', { name: 'Save review for later' }));
      await screen.findByRole('button', { name: /^Review$/ });
      mounted.unmount();
      env.renderApp();
      await user.click(await screen.findByRole('button', { name: /^Review$/ }));
      await user.click(screen.getByText('Details', { selector: 'summary' }));
      expect(screen.getByRole('textbox', { name: 'Quantity (optional)' })).toHaveValue(
        expectedQuantity,
      );
      await user.click(screen.getByRole('button', { name: 'Save selected entries' }));
      await waitFor(() =>
        expect(request).toHaveBeenCalledWith(
          expect.anything(),
          capturePaths.syncOps,
          expect.objectContaining({
            body: expect.objectContaining({
              ops: [
                expect.objectContaining({
                  payload: expect.objectContaining({
                    name: 'Fixture wrench',
                    quantity: expectedQuantity || undefined,
                  }),
                }),
              ],
            }),
          }),
        ),
      );
    },
  );

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
    await continueToItemDetails(user);
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Drill');
    await user.click(screen.getByText('Details', { selector: 'summary' }));
    await user.type(screen.getByRole('textbox', { name: 'Quantity (optional)' }), '4');
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
    // These read the server's suggestions: this iPhone opts into the server's API key.
    await env.adapters.outbox.setValue(
      { id: `${origin}|ibrahim|epoch-1` } as Connection,
      'defaultPhotoAI',
      'server',
    );
    env.renderApp();
    await user.click(
      within(await screen.findByRole('navigation')).getByRole('button', { name: 'Add' }),
    );
    const picker = document.querySelector<HTMLInputElement>(
      'input[type=file][accept="image/*"][multiple]',
    );
    if (!picker) throw new Error('Photo picker is missing');
    await user.upload(picker, new File(['photo'], 'manual.jpg', { type: 'image/jpeg' }));
    await continueToItemDetails(user);
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
    await saveNewItem(user);
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
    // These read the server's suggestions: this iPhone opts into the server's API key.
    await env.adapters.outbox.setValue(
      { id: `${origin}|ibrahim|epoch-1` } as Connection,
      'defaultPhotoAI',
      'server',
    );
    env.renderApp();
    await user.click(
      within(await screen.findByRole('navigation')).getByRole('button', { name: 'Add' }),
    );
    const picker = document.querySelector<HTMLInputElement>(
      'input[type=file][accept="image/*"][multiple]',
    );
    if (!picker) throw new Error('Photo input is missing');
    await user.upload(
      picker,
      new File([new Uint8Array([1, 2, 3])], 'review.jpg', { type: 'image/jpeg' }),
    );
    await continueToItemDetails(user);
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Holiday supplies');
    await user.click(await screen.findByRole('button', { name: 'Suggest categories' }));
    expect(await screen.findByDisplayValue('Holiday supplies')).toBeVisible();
    expect(screen.getAllByRole('textbox', { name: 'Name' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Create Electrical' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create Decorations' })).toBeVisible();
  });

  it('uses Assistant photos, model selection, confirmed record changes, and thread deletion', async () => {
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
    const deleted = vi.fn();
    const original = env.adapters.transport.request;
    const request = vi
      .spyOn(env.adapters.transport, 'request')
      .mockImplementation(
        async <T,>(conn: Connection, path: string, options?: NativeRequestOptions): Promise<T> => {
          if (path === assistantPaths.models) {
            return {
              items: [
                { id: 'text-model', isDefault: true, vision: false },
                { id: 'photo-model', isDefault: false, vision: true },
              ],
            } as T;
          }
          if (path === assistantPaths.threads)
            return (options?.method === 'POST' ? thread : { items: [] }) as T;
          if (path === assistantPaths.thread(thread.id)) {
            if (options?.method === 'DELETE') {
              deleted();
              return undefined as T;
            }
            return { thread, messages, proposals: proposals.map((p) => ({ ...p })) } as T;
          }
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
    expect(tabs.at(-1)).toHaveTextContent('More');
    await user.click(await screen.findByRole('button', { name: 'Assistant' }));
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

    const fileInput = document.querySelector<HTMLInputElement>(
      'input[type=file][accept="image/*"]',
    );
    if (!fileInput) throw new Error('Assistant photo input is missing');
    await user.upload(fileInput, new File(['photo data'], 'fixture.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: /Model/ }));
    expect(screen.queryByRole('option', { name: 'text-model' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'photo-model' }));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(ask).toHaveBeenLastCalledWith({
        text: 'Describe this photo',
        context,
        locale: 'en',
        model: 'photo-model',
        photo: btoa('photo data'),
      }),
    );

    await user.click(await screen.findByRole('button', { name: 'Delete this thread' }));
    expect(deleted).not.toHaveBeenCalled();
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => expect(deleted).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Delete this thread' })).not.toBeInTheDocument(),
    );
    expect(inventory).toEqual(['add_thing', 'update_thing']);
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
      status: vi.fn(async () => ({ apple: 'available' as const, chatGPT: 'ibrahim@kept.test' })),
      connect: vi.fn(async () => ({ account: 'ibrahim@kept.test' })),
      disconnect: vi.fn(async () => ({ revoked: true })),
      models: vi.fn(async () => []),
      suggest: vi.fn(),
      serverProposals: vi.fn(),
    };
    const user = userEvent.setup();
    const first = env.renderApp();
    await openSettings(user);
    await user.click(await screen.findByRole('button', { name: /Default location/ }));
    await user.click(await screen.findByRole('option', { name: 'Home' }));
    await user.click(await screen.findByRole('button', { name: 'AI and photo suggestions' }));
    // The ChatGPT plan is the default; the server's API key is the opt-in.
    expect(await screen.findByRole('button', { name: /Default photo AI/ })).toHaveTextContent(
      'ChatGPT plan',
    );
    await user.click(await screen.findByRole('button', { name: /Default photo AI/ }));
    await user.click(await screen.findByRole('option', { name: 'Server API' }));
    expect(await env.adapters.outbox.getValue(connection, 'defaultPhotoAI')).toBeUndefined();
    const save = screen.getByRole('button', { name: /^Save$/ });
    vi.spyOn(env.adapters.outbox, 'setValue').mockRejectedValueOnce(new Error('No storage'));
    await user.click(save);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not save the photo AI default.',
    );
    await user.click(save);
    expect(await screen.findByText('Photo AI default saved.')).toBeInTheDocument();
    await waitFor(async () => {
      expect(await env.adapters.outbox.getValue(connection, 'defaultLocation')).toBe(
        env.rooms[0]?.locationId,
      );
      expect(await env.adapters.outbox.getValue(connection, 'defaultPhotoAI')).toBe('server');
    });
    first.unmount();
    let finishReading = () => {};
    const reading = new Promise<void>((resolve) => {
      finishReading = resolve;
    });
    const readValue = env.adapters.outbox.getValue.bind(env.adapters.outbox);
    vi.spyOn(env.adapters.outbox, 'getValue').mockImplementation(async (conn, key) => {
      if (key === 'defaultPhotoAI') await reading;
      return readValue(conn, key);
    });
    env.renderApp();
    await openSettings(user);
    expect(await screen.findByRole('button', { name: /Default location/ })).toHaveTextContent(
      'Home',
    );
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Add' }));
    const picker = document.querySelector<HTMLInputElement>(
      'input[type=file][accept="image/*"][multiple]',
    );
    if (!picker) throw new Error('Photo picker is missing');
    await user.upload(picker, new File(['photo'], 'default.jpg', { type: 'image/jpeg' }));
    await continueToItemDetails(user);
    const provider = await screen.findByRole('button', { name: /AI provider/ });
    expect(provider).toBeDisabled();
    await act(async () => finishReading());
    expect(provider).toBeEnabled();
    expect(provider).toHaveTextContent('Server API');
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
    await continueToItemDetails(user);
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

    await saveNewItem(user);
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

  it('listens for an NFC tag while the QR camera runs on Scan, and the first read wins', async ({
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
    const pendingTag = () => {
      let deliver: (tag: TagReading) => void = () => {};
      const reading = new Promise<TagReading>((resolve) => {
        deliver = resolve;
      });
      return { reading, deliver: (tag: TagReading) => deliver(tag) };
    };
    const first = pendingTag();
    const scanTag = vi
      .spyOn(env.adapters.nfc, 'scanTag')
      .mockImplementationOnce(() => first.reading);
    const cancelTag = vi.spyOn(env.adapters.nfc, 'cancelTag');
    const user = userEvent.setup();
    env.renderApp();

    const scanTab = within(await screen.findByRole('navigation')).getByRole('button', {
      name: 'Scan',
    });
    await user.click(scanTab);
    // Both at once: the camera opens and the NFC reader listens.
    expect(screen.getByLabelText('Camera view')).toBeInTheDocument();
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(scanTag).toHaveBeenCalledTimes(1);
    expect(scanTag).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: 'read' }),
    );
    expect(
      screen.getByText(
        'Point the camera at a QR label, or hold the top of your iPhone near an NFC tag.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scan NFC tag' })).toBeNull();

    // A typed code answers first: the NFC reader stops, and its late reading is dropped.
    await user.type(screen.getByRole('textbox', { name: 'Type the code' }), 'NOPE99');
    await user.click(screen.getByRole('button', { name: 'Open label' }));
    expect(cancelTag).toHaveBeenCalled();
    await act(async () => first.deliver({ status: 'read', url: `${origin}/l/7KQ4MZ` }));
    expect(screen.getByRole('heading', { name: 'Identify a label' })).toBeInTheDocument();

    // The camera carries on; NFC listens again on request, and closing its sheet is quiet.
    expect(screen.getByLabelText('Camera view')).toBeInTheDocument();
    const second = pendingTag();
    scanTag.mockImplementationOnce(() => second.reading);
    await user.click(await screen.findByRole('button', { name: 'Scan NFC tag' }));
    expect(scanTag).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Scan NFC tag' })).toBeNull();
    await act(async () => second.deliver({ status: 'cancelled' }));
    expect(screen.getByLabelText('Camera view')).toBeInTheDocument();
    expect(screen.queryByText('Scan cancelled.')).toBeNull();

    // Listening again, a tag opens its box and the camera lets go.
    env.pushScan({ status: 'read', url: `${origin}/l/7KQ4MZ` });
    await user.click(screen.getByRole('button', { name: 'Scan NFC tag' }));
    expect(await screen.findByRole('heading', { name: 'Winter Box' })).toBeInTheDocument();
    expect(stopCamera).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Scan' }));
    expect(screen.getByLabelText('Camera view')).toBeInTheDocument();
    expect(scanTag).toHaveBeenCalledTimes(4);
  });

  it('starts adding an item from a blank NFC tag found on Scan, and writes it as the label', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const request = vi.spyOn(env.adapters.transport, 'request');
    const scanTag = vi.spyOn(env.adapters.nfc, 'scanTag');
    const user = userEvent.setup();
    env.renderApp();
    const boxes = await screen.findByRole('button', { name: '2 Boxes' });
    await waitFor(() => expect(boxes).toBeEnabled());

    env.pushScan(
      { status: 'blank', fingerprint: 'fp-blank', occupied: false, writable: true, capacity: 137 },
      { status: 'written' },
    );
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Scan' }));
    // The Add form opens with the tag ready to write; no code is reserved until it is written.
    expect(await screen.findByRole('textbox', { name: 'Description' })).toBeInTheDocument();
    expect(env.events.reservedLabelKeys).toHaveLength(0);
    await user.type(screen.getByLabelText('Description'), 'Tripod');
    await user.click(screen.getByRole('button', { name: 'Continue to labels' }));
    expect(await screen.findByText('This tag is blank and ready to write.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Write and verify' }));
    expect(await screen.findByText(/NFC tag written and verified/)).toBeInTheDocument();
    expect(env.events.reservedLabelKeys).toHaveLength(1);
    expect(scanTag.mock.calls.at(-1)?.[1]).toMatchObject({
      mode: 'write',
      url: `${origin}/l/RSV234`,
      fingerprint: 'fp-blank',
    });

    await saveNewItem(user);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.anything(),
        capturePaths.syncOps,
        expect.objectContaining({
          body: expect.objectContaining({
            ops: [
              expect.objectContaining({
                payload: expect.objectContaining({ name: 'Tripod', claimCode: 'RSV234' }),
              }),
            ],
          }),
        }),
      ),
    );
    // The next item starts without the tag.
    expect(await screen.findByText('Saved on device.')).toBeInTheDocument();
    expect(screen.queryByText('This tag is blank and ready to write.')).toBeNull();
  });

  it('creates a place and captures an item there from the home destination picker', async () => {
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
    await user.click(await screen.findByRole('button', { name: /Places$/ }));
    await user.click(screen.getByRole('button', { name: 'Create place' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Attic');
    await user.type(
      await screen.findByRole('textbox', { name: 'Description' }),
      'Seasonal shelves',
    );
    await user.click(screen.getByRole('button', { name: 'Create place' }));
    expect(await screen.findByRole('heading', { name: 'Attic' })).toBeInTheDocument();
    expect(screen.getByText('Seasonal shelves')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add sub-location' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Shelf 1');
    await user.click(screen.getAllByRole('button', { name: 'Add sub-location' })[1] as HTMLElement);
    expect(await screen.findByRole('heading', { name: 'Shelf 1' })).toBeInTheDocument();
    expect(screen.getByText('Home › Attic › Shelf 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add sub-location' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Upper shelf');
    await user.click(screen.getAllByRole('button', { name: 'Add sub-location' })[1] as HTMLElement);
    expect(await screen.findByRole('heading', { name: 'Upper shelf' })).toBeInTheDocument();
    expect(screen.getByText('Home › Attic › Shelf 1 › Upper shelf')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Add' }));
    await continueToItemDetails(user);
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.click(screen.getByRole('button', { name: /Room or box/ }));
    await user.click(await screen.findByRole('option', { name: 'Attic' }));
    // The picker stays open until Done, so choosing a location never files the item by accident.
    await user.click(screen.getByRole('button', { name: /Room or box/ }));
    await user.click(await screen.findByRole('option', { name: 'Shelf 1' }));
    await user.click(screen.getByRole('button', { name: /Room or box/ }));
    await user.click(await screen.findByRole('option', { name: 'Upper shelf' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('Home › Attic › Shelf 1 › Upper shelf')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Winter gloves');
    await saveNewItem(user);
    expect(await screen.findByText('Synced: 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: /Places$/ }));
    await user.type(screen.getByRole('textbox', { name: 'Search places' }), 'Seasonal');
    expect(screen.getByRole('button', { name: /Attic/ })).toBeInTheDocument();
    await user.clear(screen.getByRole('textbox', { name: 'Search places' }));
    expect(screen.getByRole('button', { name: /^Attic/ })).toHaveTextContent(
      'Direct items 0, All levels 1',
    );
    await user.click(screen.getByRole('button', { name: 'Expand or collapse Attic' }));
    expect(screen.getByRole('button', { name: /^Shelf 1/ })).toHaveTextContent(
      'Direct items 0, All levels 1',
    );
    await user.click(screen.getByRole('button', { name: 'Expand or collapse Shelf 1' }));
    const deepest = screen.getByRole('button', { name: /^Upper shelf/ });
    expect(deepest).toHaveTextContent('Direct items 1, All levels 1');
    await user.click(deepest);
    expect(await screen.findByRole('button', { name: 'Winter gloves' })).toBeInTheDocument();
  });

  it('chooses a place kind when adding, then changes the name, description, and kind in place', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const request = vi.spyOn(env.adapters.transport, 'request');
    const user = userEvent.setup();
    env.renderApp();
    await user.click(await screen.findByRole('button', { name: /Places$/ }));
    await user.click(screen.getByRole('button', { name: 'Create place' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Back storage');
    await user.click(screen.getByRole('button', { name: 'Room Kind' }));
    await user.click(await screen.findByRole('option', { name: 'Closet' }));
    await user.click(screen.getByRole('button', { name: 'Create place' }));
    expect(await screen.findByRole('heading', { name: 'Back storage' })).toBeVisible();
    expect(screen.getByText('Closet')).toBeVisible();
    const created = env.rooms.find(({ name }) => name === 'Back storage');
    expect(created?.kindKey).toBe('closet');
    if (!created) throw new Error('Missing place');

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const name = screen.getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Mudroom');
    await user.type(
      await screen.findByRole('textbox', { name: 'Description' }),
      'By the back door',
    );
    await user.click(screen.getByRole('button', { name: 'Closet Kind' }));
    await user.click(await screen.findByRole('option', { name: 'Room' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('heading', { name: 'Mudroom' })).toBeVisible();
    expect(screen.getByText('By the back door')).toBeVisible();
    expect(screen.getByText('Room')).toBeVisible();
    expect(request).toHaveBeenCalledWith(expect.anything(), inventoryPaths.place(created.id), {
      method: 'PATCH',
      ifMatch: 1,
      body: { name: 'Mudroom', description: 'By the back door', kindKey: 'room' },
    });
  });

  it('moves a deep bin through Places and updates the same item path and counts', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const garage = env.rooms[0];
    const bin = env.serverThings.get(env.boxId);
    if (!garage || !bin) throw new Error('Missing garage or bin fixture');
    const shelf = {
      ...garage,
      id: '60555555-5555-7555-8555-555555555555',
      name: 'Workshop shelf',
      parentId: garage.id,
    };
    const upper = {
      ...shelf,
      id: '70555555-5555-7555-8555-555555555555',
      name: 'Upper shelf',
      parentId: shelf.id,
    };
    const shed = { ...garage, id: '90555555-5555-7555-8555-555555555555', name: 'Shed' };
    env.rooms.push(shelf, upper, shed);
    const cableId = 'a0555555-5555-7555-8555-555555555555';
    const cable = {
      ...bin,
      id: cableId,
      name: 'USB cable',
      containerId: env.boxId,
      placeId: null,
      isContainer: false,
      typeId: null,
      shortCode: null,
      labelPrinted: false,
    };
    env.serverThings.set(cableId, cable);
    const originalBinPath = [garage, shelf, upper].map(({ id, name }) => ({ id, name }));
    Object.assign(bin, { placeId: upper.id, path: originalBinPath });
    Object.assign(cable, { path: [...originalBinPath, { id: env.boxId, name: bin.name }] });
    const move = vi.fn();
    const request = env.adapters.transport.request;
    env.adapters.transport.request = async <T,>(
      connection: Connection,
      path: string,
      options?: NativeRequestOptions,
    ) => {
      if (path === inventoryPaths.movePreview) return { crossLocation: false } as T;
      if (path === inventoryPaths.move) {
        move(options);
        const nextPath = [{ id: shed.id, name: shed.name }];
        Object.assign(bin, { placeId: shed.id, path: nextPath, rowVersion: 2 });
        Object.assign(cable, { path: [...nextPath, { id: env.boxId, name: bin.name }] });
        return { moved: [env.boxId] } as T;
      }
      return request<T>(connection, path, options);
    };
    const user = userEvent.setup();
    env.renderApp();
    await user.click(await screen.findByRole('button', { name: /Places$/ }));
    await user.click(screen.getByRole('button', { name: 'Expand or collapse Garage' }));
    await user.click(screen.getByRole('button', { name: 'Expand or collapse Workshop shelf' }));
    expect(screen.getByRole('button', { name: /^Upper shelf/ })).toHaveTextContent(
      'Direct items 1, All levels 2',
    );
    await user.click(screen.getByRole('button', { name: 'Expand or collapse Upper shelf' }));
    await user.click(screen.getByRole('button', { name: /^Winter Box/ }));
    expect(
      await screen.findByText('Home › Garage › Workshop shelf › Upper shelf'),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Move' }));
    await user.click(screen.getByRole('button', { name: /Room or box/ }));
    await user.click(await screen.findByRole('option', { name: 'Shed' }));
    await user.click(screen.getAllByRole('button', { name: 'Move' })[1] as HTMLElement);
    await waitFor(() =>
      expect(move).toHaveBeenCalledWith(
        expect.objectContaining({
          ifMatch: 1,
          body: { thingIds: [env.boxId], to: { placeId: shed.id } },
        }),
      ),
    );
    expect(await screen.findByText('Home › Shed')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'USB cable' }));
    expect(await screen.findByRole('heading', { name: 'USB cable' })).toBeInTheDocument();
    expect(await screen.findByText('Home › Shed › Winter Box')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('button', { name: /^Shed/ })).toHaveTextContent(
      'Direct items 1, All levels 2',
    );
  });

  it('loads places beyond a capped snapshot when online and discloses missing places offline', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const garage = env.rooms[0];
    if (!garage) throw new Error('Missing Garage');
    const request = env.adapters.transport.request;
    const liveReads = vi.fn();
    env.adapters.transport.request = async <T,>(
      connection: Connection,
      path: string,
      options?: NativeRequestOptions,
    ): Promise<T> => {
      if (path === inventoryPaths.locationDestinations(garage.locationId)) {
        liveReads();
        return [
          { ...garage, kind: 'place' },
          {
            id: 'remote-shelf',
            locationId: garage.locationId,
            parentId: garage.id,
            name: 'Electrical shelf',
            description: 'Cables and adapters',
            kind: 'place',
          },
        ] as T;
      }
      const result = await request<T>(connection, path, options);
      if (path.startsWith(capturePaths.syncSnapshot)) return { ...result, truncated: true };
      return result;
    };
    const user = userEvent.setup();
    env.renderApp();
    await user.click(await screen.findByRole('button', { name: 'Places' }));
    await user.type(screen.getByRole('textbox', { name: 'Search places' }), 'adapters');
    expect(await screen.findByRole('button', { name: /^Electrical shelf/ })).toBeInTheDocument();
    expect(screen.queryByText(/Direct items/)).toBeNull();
    expect(liveReads).toHaveBeenCalled();
    env.setOnline(false);
    act(() => env.emitAppState(true));
    expect(
      await screen.findByText('Some destinations are missing from this device.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Electrical shelf/ })).toBeNull();
  });

  it('reopens pending place and item work after offline relaunch and replays it in dependency order', async () => {
    const origin = 'https://kept.example.com';
    const connection = {
      id: `${origin}|ibrahim|epoch-1`,
      origin,
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: connection });
    const user = userEvent.setup();
    let supportsOfflinePlaces = true;
    const transport = env.adapters.transport.request;
    env.adapters.transport.request = async <T,>(
      context: Connection,
      path: string,
      options?: NativeRequestOptions,
    ) => {
      if (path === capturePaths.nativeCaptureCapabilities && !supportsOfflinePlaces) {
        const caps = await transport<T>(context, path, options);
        return { ...caps, placeCreationPayloadVersion: undefined } as T;
      }
      if (path !== inventoryPaths.attachments) return transport<T>(context, path, options);
      const body = options?.body as CreateAttachmentBody & {
        id: string;
        subject: { placeId: string };
      };
      const place = env.rooms.find(({ id }) => id === body.subject.placeId);
      if (!place) throw new Error('Photo replay ran before its place existed');
      const entry = (await env.adapters.outbox.list(context)).find(({ capture }) =>
        capture.files.some(({ file }) => file.id === body.fileId),
      );
      const original = entry?.capture.files[0];
      if (!original) throw new Error('Missing original photo');
      const attachment = {
        id: body.id,
        file: { id: body.fileId, sha256: original.sha256 },
      } as AttachmentView;
      place.attachments = [...place.attachments, attachment];
      return attachment as T;
    };
    const request = vi.spyOn(env.adapters.transport, 'request');
    const first = env.renderApp();
    await user.click(await screen.findByRole('button', { name: /Places$/ }));
    env.setOnline(false);
    act(() => env.emitAppState(true));
    await screen.findByText('Offline. Changes stay on this iPhone until SheepKeep is reachable.');
    await user.click(screen.getByRole('button', { name: 'Create place' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Offline garage');
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Beside the house');
    await user.click(screen.getByRole('button', { name: 'Room Kind' }));
    await user.click(await screen.findByRole('option', { name: 'Floor' }));
    await user.click(screen.getByRole('button', { name: 'Create place' }));
    await screen.findByRole('heading', { name: 'Offline garage' });
    await user.click(screen.getByRole('button', { name: 'Add sub-location' }));
    const name = screen.getByRole('textbox', { name: 'Name' });
    await user.type(name, 'Offline shelf');
    const form = name.closest('form');
    if (!form) throw new Error('Missing place form');
    await user.click(within(form).getByRole('button', { name: 'Add sub-location' }));
    await screen.findByRole('heading', { name: 'Offline shelf' });
    const input = first.container.querySelector<HTMLInputElement>(
      'input[aria-label="Choose reference photo"]',
    );
    if (!input) throw new Error('Missing photo input');
    await user.upload(input, new File(['fixture photo'], 'shelf.jpg', { type: 'image/jpeg' }));
    await waitFor(async () => expect(await env.adapters.outbox.list(connection)).toHaveLength(3));
    await user.click(screen.getByRole('button', { name: 'Add here' }));
    await continueToItemDetails(user);
    const captureName = screen.getByRole('textbox', { name: 'Description' });
    const captureForm = captureName.closest('form');
    if (!captureForm) throw new Error('Missing capture form');
    expect(within(captureForm).getByText(/ › Offline garage › Offline shelf$/)).toBeVisible();
    await user.type(captureName, 'USB cable');
    await saveNewItem(user);
    await waitFor(async () => expect(await env.adapters.outbox.list(connection)).toHaveLength(4));
    const manifest = await env.adapters.outbox.list(connection);
    const parent = manifest[0]?.capture.id;
    const shelf = manifest[1]?.capture.id;
    expect(manifest[2]?.capture.files).toHaveLength(1);
    first.unmount();
    const second = env.renderApp();
    await user.click(await screen.findByRole('button', { name: /Places$/ }));
    await user.click(await screen.findByRole('button', { name: /^Offline garage/ }));
    await screen.findByRole('heading', { name: 'Offline garage' });
    await user.click(screen.getByRole('button', { name: 'Offline shelf' }));
    expect(await screen.findByRole('heading', { name: 'Offline shelf' })).toBeVisible();
    expect(request.mock.calls.filter(([, path]) => path === capturePaths.syncOps)).toEqual([]);
    supportsOfflinePlaces = false;
    env.setOnline(true);
    act(() => env.emitAppState(true));
    await waitFor(async () =>
      expect((await env.adapters.outbox.list(connection))[0]?.failure).toBe('compatibility_hold'),
    );
    expect(request.mock.calls.filter(([, path]) => path === capturePaths.syncOps)).toEqual([]);
    expect(env.events.uploadedFiles).toEqual([]);
    supportsOfflinePlaces = true;
    await user.click(await screen.findByRole('button', { name: 'Retry sync' }));
    await waitFor(async () => expect(await env.adapters.outbox.list(connection)).toEqual([]));
    const ops = request.mock.calls
      .filter(([, path]) => path === capturePaths.syncOps)
      .flatMap(([, , options]) => (options?.body as { ops: unknown[] } | undefined)?.ops ?? []);
    expect(ops).toMatchObject([
      {
        op: 'create_area',
        clientId: parent,
        payload: { kindKey: 'floor', description: 'Beside the house' },
      },
      {
        op: 'create_area',
        clientId: shelf,
        dependsOn: [parent],
        payload: { parentId: parent, kindKey: 'room' },
      },
      { op: 'create_thing', dependsOn: [shelf], payload: { target: { placeId: shelf } } },
    ]);
    expect(
      request.mock.calls.find(([, path]) => path === inventoryPaths.attachments)?.[2]?.body,
    ).toMatchObject({ subject: { placeId: shelf }, role: 'photo' });
    second.unmount();
  });

  it('retries reference photo replacement with the same key after an uncertain response', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const garage = env.rooms[0];
    if (!garage) throw new Error('Missing Garage');
    const file: FileView = {
      id: '55555555-5555-7555-8555-555555555555',
      mime: 'image/jpeg',
      class: 'photo',
      sha256: 'a'.repeat(64),
      bytes: 5,
      width: 50,
      height: 50,
      hasGps: false,
      derivativeState: 'ready',
      displayUrl: '/f/full',
      thumbUrl: '/f/thumb',
    };
    const old: AttachmentView = {
      id: '66666666-6666-7666-8666-666666666666',
      file,
      rowVersion: 2,
      role: 'photo',
      name: 'Shelf layout',
      subject: { placeId: garage.id },
      sort: 10,
      url: null,
      createdBy: { displayName: 'Ibrahim' },
      canManage: true,
    };
    let attachments: AttachmentView[] = [
      old,
      { ...old, id: 'log', name: 'Location log', locationPhotoTakenAt: '2026-11-24T10:00:00Z' },
    ];
    const request = env.adapters.transport.request;
    const attempts: NativeRequestOptions[] = [];
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new Error('Upload failed'))
      .mockResolvedValue(file);
    env.adapters.transport.uploadOriginal = upload;
    env.adapters.transport.request = async <T,>(
      connection: Connection,
      path: string,
      options?: NativeRequestOptions,
    ): Promise<T> => {
      if (path === inventoryPaths.place(garage.id)) return { ...garage, attachments } as T;
      if (path === inventoryPaths.attachments && options?.method === 'POST') {
        attempts.push(options);
        const body = options.body as CreateAttachmentBody;
        if (attempts.length === 1) {
          expect(body.replacesAttachmentId).toBe(old.id);
          expect(options.ifMatch).toBe(old.rowVersion);
          throw new ApiError(0, 'offline', 'Response lost');
        }
        const updated = { ...old, id: options.idempotencyKey as string };
        attachments = [updated, ...attachments.slice(1)];
        return updated as T;
      }
      return request<T>(connection, path, options);
    };
    const user = userEvent.setup();
    const { container } = env.renderApp();
    await user.click(await screen.findByRole('button', { name: /Places$/ }));
    await user.click(screen.getByRole('button', { name: /^Garage/ }));
    expect(await screen.findByRole('button', { name: 'Take photo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Shelf layout' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Replace photo' }));
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Choose reference photo"]',
    );
    if (!input) throw new Error('Missing reference photo input');
    await user.upload(input, new File(['photo'], 'shelf.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(attempts).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Shelf layout' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(attempts).toHaveLength(1));
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(attempts).toHaveLength(2));
    expect(attempts[1]).toEqual(attempts[0]);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Shelf layout' })).toBeInTheDocument();
    expect(
      await env.adapters.outbox.list({
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      }),
    ).toEqual([]);
  });

  it('keeps place description writes disabled against an older server', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    env.setCapabilitiesHandler(({ account, epoch }) => ({
      contractVersion: 1,
      capturePayloadVersions: [2, 3, 4, 5],
      account,
      epoch,
    }));
    const user = userEvent.setup();
    env.renderApp();
    await user.click(await screen.findByRole('button', { name: /Places$/ }));
    await user.click(screen.getByRole('button', { name: 'Create place' }));
    expect(screen.queryByRole('textbox', { name: 'Description' })).toBeNull();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Storage');
    await user.click(screen.getByRole('button', { name: 'Create place' }));
    expect(await screen.findByRole('heading', { name: 'Storage' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.queryByRole('textbox', { name: 'Description' })).toBeNull();
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
    await openWinterBox(user);
    await user.click(screen.getByRole('button', { name: 'Add photos' }));
    expect(screen.queryByRole('textbox', { name: 'Description' })).not.toBeInTheDocument();
    const picker = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    if (!picker) throw new Error('Expected photo picker');
    await user.upload(picker, new File(['image bytes'], 'bin.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: 'Save photos' }));
    expect(await screen.findByText('Synced: 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    const photo = await screen.findByRole('button', { name: 'photo.jpg' });
    expect(photo.querySelector('img')).toHaveAttribute('src', `${origin}/f/fixture-thumb.jpg`);
    await user.click(photo);
    expect(env.events.openedRemote[0]).toMatchObject({ thing: env.boxId, variant: 'display' });
    const original = screen.getByRole('button', { name: 'Open original photo' });
    expect(original).toHaveAccessibleDescription('photo.jpg');
    await user.click(original);
    expect(env.events.openedRemote[1]).toMatchObject({
      thing: env.boxId,
      file: env.events.openedRemote[0]?.file,
    });
    expect(env.events.openedRemote[1]?.variant).toBeUndefined();
    expect(screen.getByText('No cached contents.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'QR and NFC label' }));
    await user.click(screen.getByRole('button', { name: 'Share QR label PDF' }));
    expect(env.events.sharedLabelPdfs).toEqual([{ url: `${origin}/l/7KQ4MZ`, name: 'Winter Box' }]);
  });

  it('rotates an item photo, uses it as thumbnail, and restores it from the archive', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    let photo: AttachmentView = {
      id: 'photo-controls-fixture',
      role: 'photo',
      sort: 0,
      name: 'Shelf label',
      url: null,
      subject: { thingId: env.boxId },
      rowVersion: 1,
      createdBy: { displayName: 'Ibrahim' },
      file: {
        id: 'fixture-file',
        mime: 'image/jpeg',
        class: 'photo',
        bytes: 50,
        sha256: 'a'.repeat(64),
        hasGps: false,
        width: 8,
        height: 4,
        derivativeState: 'ready',
        thumbUrl: '/f/label-thumb.jpg',
        displayUrl: '/f/label-preview.jpg',
      },
    };
    let selected = false;
    const request = env.adapters.transport.request.bind(env.adapters.transport);
    env.adapters.transport.request = async <T,>(
      conn: Connection,
      path: string,
      options?: NativeRequestOptions,
    ) => {
      if (path.startsWith(inventoryPaths.thingAttachments(env.boxId))) {
        const archive = new URL(path, origin).searchParams.has('archivedPhotos');
        return {
          items: Boolean(photo.photoArchivedAt) === archive ? [photo] : [],
          next_cursor: null,
        } as T;
      }
      if (path === inventoryPaths.attachment(photo.id)) {
        expect(options?.ifMatch).toBe(photo.rowVersion);
        const patch = options?.body as UpdateAttachmentBody;
        photo = { ...photo, rowVersion: photo.rowVersion + 1 };
        if (patch.photoRotation !== undefined) photo.photoRotation = patch.photoRotation;
        if (patch.selectThumbnail) selected = true;
        if (patch.photoArchived === true) {
          photo.photoArchivedAt = '2026-11-24T20:00:00Z';
          selected = false;
        }
        if (patch.photoArchived === false) delete photo.photoArchivedAt;
        return photo as T;
      }
      if (path === inventoryPaths.thing(env.boxId) && !options?.method) {
        const thing = await request<ThingView>(conn, path);
        return {
          ...thing,
          ...(selected
            ? {
                thumbUrl: photo.file?.thumbUrl,
                thumbnailRotation: photo.photoRotation,
                thumbnailAttachmentId: photo.id,
              }
            : {}),
        } as T;
      }
      return request<T>(conn, path, options);
    };
    const user = userEvent.setup();
    env.renderApp();
    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Photo options' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Rotate clockwise' }));
    await waitFor(() =>
      expect(dialog.getByRole('img', { name: 'Shelf label' })).toHaveStyle({ rotate: '90deg' }),
    );
    await user.click(dialog.getByRole('button', { name: 'Use as thumbnail' }));
    expect(await dialog.findByRole('button', { name: 'Current thumbnail' })).toBeDisabled();
    await user.click(dialog.getByRole('button', { name: 'Archive photo' }));
    expect(await screen.findByText('Photo archived.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Cover photo' })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Archived photos' }));
    await user.click(await screen.findByRole('button', { name: 'Shelf label' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Restore photo' }),
    );
    expect(await screen.findByText('Photo restored.')).toBeInTheDocument();
    expect(await screen.findByText('No archived photos.')).toBeInTheDocument();
    expect(
      (await screen.findByRole('button', { name: 'Shelf label' })).querySelector('img'),
    ).toHaveStyle({ rotate: '90deg' });
  });

  it('queues a location photo offline and shows it separately after sync', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const request = vi.spyOn(env.adapters.transport, 'request');
    const user = userEvent.setup();
    env.renderApp();
    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Add location photo' }));
    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attach PDF' })).not.toBeInTheDocument();
    env.setOnline(false);
    const picker = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    if (!picker) throw new Error('Expected photo picker');
    await user.upload(picker, new File(['location image'], 'shelf.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: 'Save location photo' }));
    expect(await screen.findByText('Saved on device.')).toBeInTheDocument();
    expect(env.events.uploadedFiles).toHaveLength(0);

    env.setOnline(true);
    act(() => env.emitAppState(true));
    expect(await screen.findByText('Synced: 1')).toBeInTheDocument();
    expect(request).toHaveBeenCalledWith(
      expect.anything(),
      capturePaths.syncOps,
      expect.objectContaining({
        body: expect.objectContaining({
          ops: [
            expect.objectContaining({
              payloadVersion: 5,
              payload: expect.objectContaining({ attachToThingId: env.boxId, locationPhoto: true }),
            }),
          ],
        }),
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Back' }));
    const heading = await screen.findByRole('heading', { name: 'Last logged location' });
    const location = heading.closest('section');
    if (!location) throw new Error('Expected a location photo section');
    await user.click(await within(location).findByRole('button', { name: 'photo.jpg' }));
    expect(env.events.openedRemote.at(-1)).toMatchObject({ thing: env.boxId, variant: 'display' });
    expect(screen.queryByRole('heading', { name: 'Photos' })).not.toBeInTheDocument();
  });

  it('hides Personal from Places and deletes only an owned location after typed confirmation', async () => {
    const origin = 'https://kept.example.com';
    const connection = {
      id: `${origin}|ibrahim|epoch-1`,
      origin,
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: connection, cabinLocation: true });
    const home = env.rooms[0];
    if (!home) throw new Error('Missing Garage');
    const personalId = '77777777-7777-7777-8777-777777777777';
    let hidePersonal = false;
    let homeDeleted = false;
    const deleteHome = vi.fn();
    const updateVisibility = vi.fn();
    const request = env.adapters.transport.request;
    env.adapters.transport.request = async <T,>(
      conn: Connection,
      path: string,
      options?: NativeRequestOptions,
    ) => {
      if (path === paths.me) {
        if (options?.method === 'PATCH') {
          updateVisibility(options.body);
          hidePersonal = (options.body as { hidePersonal: boolean }).hidePersonal;
        }
        return { personalLocationId: personalId, profile: { hidePersonal } } as T;
      }
      if (path === paths.location(home.locationId) && options?.method === 'DELETE') {
        deleteHome(options);
        homeDeleted = true;
        return { id: home.locationId, purgeAfter: '2026-12-25T12:00:00Z' } as T;
      }
      if (path.startsWith(capturePaths.syncSnapshot)) {
        const page = await request<SnapshotPage>(conn, path, options);
        const first = page.locations[0];
        if (!first) throw new Error('Missing Home location');
        return {
          ...page,
          locations: [
            ...page.locations.flatMap((location) =>
              location.id !== home.locationId
                ? [{ ...location, kind: 'vacation_home' }]
                : homeDeleted
                  ? []
                  : [{ ...location, kind: 'home' }],
            ),
            { ...first, id: personalId, kind: 'personal', name: 'Personal' },
          ],
        } as T;
      }
      return request<T>(conn, path, options);
    };
    const user = userEvent.setup();
    env.renderApp();
    await openSettings(user);
    await user.click(await screen.findByRole('button', { name: 'Locations' }));
    const toggle = await screen.findByRole('switch', { name: 'Hide Personal' });
    expect(screen.queryByRole('button', { name: /^Delete (Personal|Cabin)/ })).toBeNull();
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    expect(updateVisibility).toHaveBeenCalledExactlyOnceWith({ hidePersonal: true });
    await waitFor(() => expect(toggle).toBeChecked());
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Home' }));
    await user.click(await screen.findByRole('button', { name: /Places$/ }));
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Personal' })).toBeNull();

    await openSettings(user);
    await user.click(await screen.findByRole('button', { name: 'Locations' }));
    const openDelete = await screen.findByRole('button', { name: 'Delete Home…' });
    await waitFor(() => expect(openDelete).toBeEnabled());
    await user.click(openDelete);
    const dialog = within(await screen.findByRole('dialog', { name: 'Delete Home?' }));
    const submit = dialog.getByRole('button', { name: 'Delete Home' });
    expect(submit).toBeDisabled();
    const typed = dialog.getByRole('textbox', { name: 'Type Home to confirm' });
    await user.type(typed, 'Cabin');
    expect(submit).toBeDisabled();
    expect(deleteHome).not.toHaveBeenCalled();
    await user.clear(typed);
    await user.type(typed, 'Home');
    await user.click(submit);
    await waitFor(() => expect(deleteHome).toHaveBeenCalledExactlyOnceWith({ method: 'DELETE' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete Home…' })).toBeNull());

    env.revokeCabinLocation();
    act(() => env.emitAppState(true));
    expect(await screen.findByText(/showing because it's your only location/)).toBeVisible();
  });

  it('moves an item to Trash directly from its record after confirmation', async () => {
    const origin = 'https://kept.example.com';
    const connection = {
      id: `${origin}|ibrahim|epoch-1`,
      origin,
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: connection });
    const itemId = env.spareBoxId;
    env.serverThings.set(itemId, {
      ...env.serverThings.get(itemId),
      name: 'USB cable',
      isContainer: false,
    });
    const request = env.adapters.transport.request;
    const trash = vi.fn();
    vi.spyOn(env.adapters.transport, 'request').mockImplementation(
      async <T,>(conn: Connection, path: string, options?: NativeRequestOptions): Promise<T> => {
        if (path !== inventoryPaths.thingTrash(itemId)) return request<T>(conn, path, options);
        trash(options);
        env.serverThings.delete(itemId);
        return { trashed: [itemId], moved: [], trashBatchId: 'fixture-batch' } as T;
      },
    );
    const user = userEvent.setup();
    env.renderApp();
    await user.click(await screen.findByRole('button', { name: /Items$/ }));
    await user.click(await screen.findByRole('button', { name: /USB cable/ }));
    const moveToTrash = await screen.findByRole('button', { name: 'Move to Trash' });
    await user.click(moveToTrash);
    const dialog = await screen.findByRole('alertdialog', { name: /Move USB cable to Trash\?/ });
    expect(dialog).toHaveTextContent('You can restore it from Trash for 30 days.');
    expect(trash).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(trash).not.toHaveBeenCalled();

    await user.click(moveToTrash);
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Move to Trash' }),
    );
    await waitFor(() =>
      expect(trash).toHaveBeenCalledExactlyOnceWith({ method: 'POST', body: {} }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'USB cable' })).not.toBeInTheDocument(),
    );
  });

  it('fills the edit form from the AI reading of photos, and keeps a photo taken for it', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const label: AttachmentView = {
      id: 'nameplate-photo',
      role: 'photo',
      sort: 0,
      name: 'Nameplate',
      url: null,
      subject: { thingId: env.boxId },
      rowVersion: 1,
      createdBy: { displayName: 'Ibrahim' },
      file: null,
    } as unknown as AttachmentView;
    const photoDetails = vi.fn(async () => ({
      model: { value: 'DCF887', confidence: 0.95 },
      serial: { value: 'SN-77', confidence: 0.4 },
      specs: { value: '20 V, brushless, 1/4 in hex chuck', confidence: 0.6 },
    }));
    env.adapters.captureAI = {
      status: vi.fn(async () => ({ apple: 'unsupported' as const })),
      connect: vi.fn(async () => ({ account: 'ibrahim@kept.test' })),
      disconnect: vi.fn(async () => ({ revoked: true })),
      models: vi.fn(async () => []),
      suggest: vi.fn(async () => ({ name: '' })),
      photoDetails,
    };
    const patches: unknown[] = [];
    const request = env.adapters.transport.request.bind(env.adapters.transport);
    env.adapters.transport.request = async <T,>(
      conn: Connection,
      path: string,
      options?: NativeRequestOptions,
    ) => {
      if (path.startsWith(inventoryPaths.thingAttachments(env.boxId))) {
        const archive = new URL(path, origin).searchParams.has('archivedPhotos');
        return { items: archive ? [] : [label], next_cursor: null } as T;
      }
      if (path === inventoryPaths.thing(env.boxId) && options?.method === 'PATCH')
        patches.push(options.body);
      return request<T>(conn, path, options);
    };
    const save = vi.spyOn(env.adapters.outbox, 'save');
    const user = userEvent.setup();
    const { container } = env.renderApp();
    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('heading', { name: 'Fill in from photos' })).toBeInTheDocument();
    // The thing's own photo is chosen to be read; it can be left out.
    const nameplate = await screen.findByRole('button', { name: 'Nameplate' });
    expect(nameplate).toHaveAttribute('aria-pressed', 'true');

    // A photo taken now is kept with the item and read with the chosen one.
    const picker = container.querySelector<HTMLInputElement>('input[capture="environment"]');
    if (!picker) throw new Error('Expected a rear-camera input on the edit form');
    const taken = new File(['photo'], 'nameplate.jpg', { type: 'image/jpeg' });
    await user.upload(picker, taken);
    expect(await screen.findByRole('button', { name: /Fill in 2 fields/ })).toBeEnabled();
    expect(photoDetails).toHaveBeenCalledWith(expect.anything(), env.boxId, {
      attachmentIds: ['nameplate-photo'],
      photo: taken,
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(JSON.parse(save.mock.calls[0]?.[1].payload ?? '{}')).toMatchObject({
      attachToThingId: env.boxId,
      skipServerSuggestions: true,
    });

    // An unsure serial is shown but not ticked; the model and the specs are.
    const suggestions = within(screen.getByRole('list', { name: 'Suggestions' }));
    expect(
      suggestions.getByRole('button', { name: /Serial number.*SN-77.*Not sure/ }),
    ).toHaveAttribute('aria-pressed', 'false');
    expect(suggestions.getByRole('button', { name: /Model.*DCF887/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: /Fill in 2 fields/ }));
    expect(screen.getByRole('textbox', { name: 'Model' })).toHaveValue('DCF887');
    expect(screen.getByRole('textbox', { name: 'Serial number' })).toHaveValue('');
    expect(screen.getByText('Filled in. Check the fields, then save.')).toBeInTheDocument();

    // Nothing is saved until the person saves the form.
    expect(patches).toEqual([]);
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({
      model: 'DCF887',
      notes: expect.stringContaining('Specs: 20 V, brushless, 1/4 in hex chuck'),
    });
    expect(patches[0]).not.toHaveProperty('serial');
  });

  it('reads the photos with the ChatGPT plan by default, on Terra, from signed links to the photos', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const label = {
      id: 'nameplate-photo',
      role: 'photo',
      sort: 0,
      name: 'Nameplate',
      url: null,
      subject: { thingId: env.boxId },
      rowVersion: 1,
      createdBy: { displayName: 'Ibrahim' },
      file: {
        id: 'nameplate-file',
        mime: 'image/jpeg',
        class: 'photo',
        bytes: 50,
        sha256: 'b'.repeat(64),
        hasGps: false,
        width: 8,
        height: 4,
        derivativeState: 'ready',
        thumbUrl: '/f/nameplate-thumb.jpg',
        displayUrl: '/f/nameplate-display.jpg',
      },
    } as unknown as AttachmentView;
    const chatGPTDetails = vi.fn(async () =>
      JSON.stringify({
        model: { value: 'DCF887', confidence: 0.95 },
        type_hint: { value: 'Tools', confidence: 0.4 },
      }),
    );
    const photoDetails = vi.fn();
    env.adapters.captureAI = {
      status: vi.fn(async () => ({ apple: 'unsupported' as const, chatGPT: 'ibrahim@kept.test' })),
      connect: vi.fn(async () => ({ account: 'ibrahim@kept.test' })),
      disconnect: vi.fn(async () => ({ revoked: true })),
      models: vi.fn(async () => [
        { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' },
        { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' },
      ]),
      suggest: vi.fn(async () => ({ name: '' })),
      chatGPTDetails,
      photoDetails,
    };
    const signed: unknown[] = [];
    const request = env.adapters.transport.request.bind(env.adapters.transport);
    env.adapters.transport.request = async <T,>(
      conn: Connection,
      path: string,
      options?: NativeRequestOptions,
    ) => {
      if (path.startsWith(inventoryPaths.thingAttachments(env.boxId))) {
        const archive = new URL(path, origin).searchParams.has('archivedPhotos');
        return { items: archive ? [] : [label], next_cursor: null } as T;
      }
      if (path.startsWith(inventoryPaths.fileUrl('nameplate-file'))) {
        signed.push({ path, body: options?.body });
        // As local storage answers: a path on this server, not a full address.
        return { url: '/f/signed-display.jpg', expiresAt: '2026-11-26T02:00:00Z' } as T;
      }
      return request<T>(conn, path, options);
    };
    const user = userEvent.setup();
    env.renderApp();
    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    // The ChatGPT plan is the default, with Terra chosen from the plan's models.
    expect(await screen.findByRole('button', { name: /AI provider/ })).toHaveTextContent(
      'ChatGPT plan',
    );
    expect(
      await screen.findByRole('button', { name: /GPT-6\.1 Terra.*Model|Model.*GPT-6\.1 Terra/ }),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Read selected photos' }));
    expect(await screen.findByRole('button', { name: /Fill in 1 field/ })).toBeEnabled();
    expect(signed).toEqual([
      {
        path: `${inventoryPaths.fileUrl('nameplate-file')}?thingId=${env.boxId}`,
        body: { variant: 'display' },
      },
    ]);
    expect(chatGPTDetails).toHaveBeenCalledWith(expect.anything(), 'gpt-6.1-terra', {
      urls: [`${origin}/f/signed-display.jpg`],
      photo: undefined,
    });
    expect(photoDetails).not.toHaveBeenCalled();
    expect(
      await env.adapters.outbox.getValue(
        { id: `${origin}|ibrahim|epoch-1` } as Connection,
        'chatGPTDetailsModel',
      ),
    ).toBe('gpt-6.1-terra');
    await user.click(screen.getByRole('button', { name: /Fill in 1 field/ }));
    expect(screen.getByRole('textbox', { name: 'Model' })).toHaveValue('DCF887');

    // The iPhone's refusals say what went wrong, not "Something went wrong".
    chatGPTDetails.mockRejectedValueOnce({ code: 'image' });
    await user.click(screen.getByRole('button', { name: 'Read selected photos' }));
    expect(await screen.findByText('Choose a readable photo.')).toBeInTheDocument();
    chatGPTDetails.mockRejectedValueOnce({ code: 'suggestion' });
    await user.click(screen.getByRole('button', { name: 'Read selected photos' }));
    expect(
      await screen.findByText(
        'ChatGPT could not read these photos. Try again, or choose fewer photos.',
      ),
    ).toBeInTheDocument();
  });

  it('records when an item was bought: a new purchase, or its purchase’s new date', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const calls: { path: string; method?: string; ifMatch?: unknown; body?: unknown }[] = [];
    let purchase: unknown = null;
    const receipt = {
      id: 'receipt-1',
      locationId: 'loc',
      vendor: null,
      purchasedOn: '2025-03-02',
      currency: null,
      notes: null,
      needsReview: 0,
      rowVersion: 7,
      lines: [
        {
          id: 'line-mine',
          description: 'Winter Box',
          quantity: 1,
          thing: { id: env.boxId, name: 'Winter Box' },
        },
        { id: 'line-other', description: 'Tape', quantity: 1, thing: null },
      ],
    };
    const request = env.adapters.transport.request.bind(env.adapters.transport);
    env.adapters.transport.request = async <T,>(
      conn: Connection,
      path: string,
      options?: NativeRequestOptions,
    ) => {
      if (path.startsWith(inventoryPaths.purchases)) {
        calls.push({
          path,
          method: options?.method,
          ifMatch: options?.ifMatch,
          body: options?.body,
        });
        return receipt as T;
      }
      const answer = await request<T>(conn, path, options);
      if (path === inventoryPaths.thing(env.boxId) && !options?.method && purchase)
        return { ...(answer as object), purchase } as T;
      return answer;
    };
    const setDate = async (user: ReturnType<typeof userEvent.setup>, date: string) => {
      const [year, month, day] = date.split('-');
      const group = screen.getByRole('group', { name: 'Bought on' });
      await user.click(within(group).getByRole('spinbutton', { name: /month/i }));
      await user.keyboard(`${month}${day}${year}`);
    };
    const user = userEvent.setup();
    const view = env.renderApp();

    // No purchase yet: a date makes a one-line purchase for the item.
    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await setDate(user, '2025-11-21');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      path: inventoryPaths.purchases,
      method: 'POST',
      body: {
        purchasedOn: '2025-11-21',
        lines: [{ description: 'Winter Box', quantity: 1, thingId: env.boxId }],
      },
    });
    view.unmount();

    // A purchase: its date changes (If-Match its version), and the other things on it are named.
    purchase = {
      purchaseId: 'receipt-1',
      lineId: 'line-mine',
      purchasedOn: '2025-03-02',
      vendor: null,
      lineDescription: 'Winter Box',
      quantity: 1,
      receipts: [],
    };
    calls.length = 0;
    env.renderApp();
    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(
      await screen.findByText(
        'This receipt has 1 other thing on it: the date and shop change for it too.',
      ),
    ).toBeInTheDocument();
    await setDate(user, '2025-03-09');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.at(-1)).toEqual({
      path: inventoryPaths.purchase('receipt-1'),
      method: 'PATCH',
      ifMatch: 7,
      body: { purchasedOn: '2025-03-09' },
    });
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
    await openWinterBox(user);
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
    expect(await screen.findByRole('button', { name: /Boxes$/ })).toBeInTheDocument();
    expect(connect).toHaveBeenCalledTimes(4);
    expect(connect).toHaveBeenLastCalledWith(address);
  });

  it.each([true, false])(
    'checks whether the session is valid (%s) when NFC registration returns 401 after sign-in',
    async (sessionValid) => {
      const origin = 'https://kept.example.com';
      const connection = {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      };
      const env = createFakeEnvironment();
      const locationId = env.rooms[0]?.locationId;
      if (!locationId) throw new Error('Missing Home location');
      const id = await saveOnPhone(
        connection,
        { locationId, name: 'Drill', claimCode: 'NFC234', claimNfcVerified: true },
        [],
        env.adapters,
      );
      const request = env.adapters.transport.request;
      let supportsTagRegistration = false;
      env.adapters.transport.request = async <T,>(
        conn: Connection,
        path: string,
        options?: NativeRequestOptions,
      ): Promise<T> => {
        if (path !== capturePaths.labelTags) return request<T>(conn, path, options);
        if (supportsTagRegistration) return { configured: true } as T;
        if (!sessionValid) {
          env.setMeHandler(() => {
            throw new ApiError(401, 'unauthenticated', 'Session expired');
          });
        }
        throw new ApiError(401, 'unauthenticated', 'Sign in required');
      };
      const user = userEvent.setup();
      env.renderApp();
      await user.type(await screen.findByLabelText('SheepKeep server address'), origin);
      await user.click(screen.getByRole('button', { name: 'Sign in with Apple' }));

      if (!sessionValid) {
        expect(await screen.findByText(/Your session ended/)).toBeVisible();
        expect(env.events.disconnected).toBe(1);
        expect(await env.adapters.outbox.list(connection)).toMatchObject([{ capture: { id } }]);
        return;
      }

      await waitFor(async () => {
        expect(await env.adapters.outbox.list(connection)).toMatchObject([
          { capture: { id }, failure: 'compatibility_hold' },
        ]);
      });
      expect(env.events.disconnected).toBe(0);
      expect(await screen.findByRole('button', { name: /Boxes$/ })).toBeVisible();

      supportsTagRegistration = true;
      await user.click(await screen.findByRole('button', { name: 'Retry sync' }));
      await waitFor(async () => expect(await env.adapters.outbox.list(connection)).toEqual([]));
      expect(env.completionsFor(connection.id)).toEqual({ [id]: 'synced' });
    },
  );

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

    const boxesTile = await screen.findByRole('button', { name: /Boxes$/ });
    await waitFor(() => expect(boxesTile).toBeEnabled());
    await user.click(boxesTile);
    const winterBoxBtn = await screen.findByRole('button', { name: /Winter Box/i });
    expect(winterBoxBtn).toHaveTextContent('Garage');
    expectLogicalOnly();
    await user.click(winterBoxBtn);

    await screen.findByRole('button', { name: 'Add to this box' });
    await user.click(screen.getByRole('button', { name: 'Add to this box' }));

    // Start with a photo, then add details and a PDF while offline.
    env.setOnline(false);
    const photo = new File(['jpegbytes'], 'ornaments.jpg', { type: 'image/jpeg' });
    const photoInput = document.querySelector<HTMLInputElement>(
      'input[accept="image/*"][multiple]',
    );
    if (!photoInput) throw new Error('Expected a photo input');
    await user.upload(photoInput, photo);
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Holiday decorations');
    await user.type(screen.getByLabelText('Notes'), 'Glass baubles');
    await user.type(screen.getByLabelText('Quantity (optional)'), '2');

    const pdf = new File(['%PDF-1.4'], 'packing-guide.pdf', { type: 'application/pdf' });
    const pdfInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!pdfInput) throw new Error('Expected a PDF input');
    await user.upload(pdfInput, pdf);

    await saveNewItem(user);
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
    await openWinterBox(user);
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

  it('opens the NFC writer from Scan for a bin or an item and verifies the chosen label', async () => {
    const origin = 'https://kept.example.com';
    const connection = {
      id: `${origin}|ibrahim|epoch-1`,
      origin,
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: connection });
    const scanTag = vi.spyOn(env.adapters.nfc, 'scanTag');
    const user = userEvent.setup();
    env.renderApp();
    await screen.findByRole('navigation');
    const tab = (name: string) =>
      within(screen.getByRole('navigation')).getByRole('button', { name });
    await user.click(tab('Add'));
    await continueToItemDetails(user);
    await user.type(screen.getByRole('textbox', { name: 'Description' }), 'Cordless drill');
    await saveNewItem(user);
    expect(await screen.findByText('Synced: 1')).toBeInTheDocument();

    await user.click(tab('Scan'));
    await user.click(await screen.findByRole('button', { name: 'Write NFC tag' }));
    expect(
      await screen.findByRole('heading', { name: 'Choose an item or bin' }),
    ).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Search inventory' }), '7KQ4MZ');
    expect(screen.queryByRole('button', { name: /Spare Box/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Winter Box/ }));
    expect(await screen.findByRole('button', { name: 'Inspect NFC tag' })).toBeEnabled();
    expect(screen.getByText('7KQ4MZ')).toBeInTheDocument();
    // Only Scan's own listening read: nothing inspected or written yet.
    expect(scanTag.mock.calls.map(([, input]) => input.mode)).toEqual(['read']);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(
      await screen.findByRole('heading', { name: 'Choose an item or bin' }),
    ).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Search inventory' }), 'cordless');
    await user.click(await screen.findByRole('button', { name: /Cordless drill/ }));
    const fingerprint = 'a'.repeat(64);
    env.pushScan(
      {
        status: 'inspected',
        occupied: false,
        writable: true,
        required: 36,
        capacity: 140,
        fingerprint,
      },
      { status: 'written' },
    );
    await user.click(screen.getByRole('button', { name: 'Inspect NFC tag' }));
    await user.click(await screen.findByRole('button', { name: 'Write and verify' }));
    expect(await screen.findByText('SheepKeep tag verified.')).toBeInTheDocument();
    expect(scanTag).toHaveBeenLastCalledWith(
      connection,
      expect.objectContaining({
        mode: 'write',
        url: `${origin}/l/4CD5EF`,
        fingerprint,
      }),
    );
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

    await openWinterBox(user);
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
    await user.click(await screen.findByRole('button', { name: /Continue finding/ }));

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

    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Add to this box' }));

    env.setStorageFull(true);
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Tools');
    await saveNewItem(user);
    expect(
      await screen.findByText('Your iPhone storage is full. Free up space and try again.'),
    ).toBeInTheDocument();

    env.setStorageFull(false);
    env.setForceDrop('target_trashed');
    await saveNewItem(user);
    expect(await screen.findByText('Saved on device.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(await screen.findByRole('button', { name: 'Back' }));

    expect(
      await screen.findByText(/The destination box is missing or in Trash/),
    ).toBeInTheDocument();

    // Safe sign-out confirmation warns when pending captures exist (sign-out lives in More).
    await openSettings(user);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stay signed in' }));
    expect(env.events.disconnected).toBe(0);
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Home' }));

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

    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Add to this box' }));
    env.setOnline(false);
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Offline discard me');
    await saveNewItem(user);
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

    await openWinterBox(user);
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

    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Add to this box' }));

    // 1. Failed sync while form is open -> Needs attention: 1, never Synced or Saved on device.
    env.setForceDrop('target_trashed');
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Failed batch item');
    await saveNewItem(user);
    expect(await screen.findByText(/Needs attention: 1/)).toBeInTheDocument();
    expect(screen.queryByText(/Synced:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Saved on device:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Syncing:/)).not.toBeInTheDocument();

    // 2. Async queue disappearance without a `synced` completion never becomes Synced.
    env.setForceDrop(null);
    env.setOnline(false);
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Disappear offline item');
    await saveNewItem(user);
    expect(await screen.findByText(/Saved on device: 1/)).toBeInTheDocument();

    env.clearQueueWithoutCompletion(conn.id);
    env.setOnline(true);

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
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Verified item');
    await saveNewItem(user);

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
      expect(await screen.findByRole('searchbox')).toBeInTheDocument();
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
    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Add to this box' }));
    const original = new File(['a photo'], 'holiday.jpg', { type: 'image/jpeg' });
    const fileInput = view.container.querySelector<HTMLInputElement>('input[type=file]');
    if (!fileInput) throw new Error('Expected a photograph input');
    await user.upload(fileInput, original);
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Holiday decorations');

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
    await user.click(screen.getByRole('button', { name: 'Back' }));
    dialog = await screen.findByRole('alertdialog', { name: 'Discard this draft?' });
    await user.click(within(dialog).getByRole('button', { name: 'Discard draft' }));
    expect(await screen.findByRole('button', { name: 'Add to this box' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'Boxes' })).toBeInTheDocument();
    expect(env.events.uploadedFiles).toHaveLength(0);
  });

  it('shows the Home command center: counts open their lists, Assistant sits in the header', async () => {
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

    const boxes = await screen.findByRole('button', { name: '2 Boxes' });
    expect(screen.getByRole('button', { name: '2 Items' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 Places' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '0 Unplaced' })).toBeInTheDocument();
    // Find shows only when a target is saved; Assistant is the header button, not a tab.
    expect(screen.queryByRole('button', { name: /Continue finding/ })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('navigation')).queryByRole('button', { name: 'Assistant' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Assistant' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    await user.click(boxes);
    expect(await screen.findByRole('button', { name: 'Boxes' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Categories' }));
    expect(screen.getByRole('button', { name: 'Categories' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Back' }));

    // A search shows results instead of the command center, and the enter arrow opens Browse.
    await user.type(screen.getByRole('searchbox', { name: 'Search inventory' }), 'Winter');
    expect(screen.queryByRole('button', { name: /Boxes$/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open in Browse' }));
    expect(await screen.findByRole('textbox', { name: 'Search' })).toHaveValue('Winter');
    expect(screen.getByRole('button', { name: 'Items' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('adds manually or from the camera on Home and keeps Scan in the tab bar', async () => {
    const env = createFakeEnvironment({
      initialConnection: {
        id: 'https://kept.example.com|ibrahim|epoch-1',
        origin: 'https://kept.example.com',
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const user = userEvent.setup();
    const { container } = env.renderApp();

    const manual = await screen.findByRole('button', { name: 'Add manually' });
    await waitFor(() => expect(manual).toBeEnabled());
    const scan = within(screen.getByRole('navigation')).getByRole('button', { name: 'Scan' });
    expect(screen.getAllByRole('button', { name: 'Scan' })).toEqual([scan]);
    await user.click(manual);
    expect(await screen.findByLabelText('Description')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));

    const picker = container.querySelector<HTMLInputElement>('input[capture="environment"]');
    if (!picker) throw new Error('Expected a rear-camera input on Home');
    expect(picker).toHaveAttribute('accept', 'image/*');
    const openCamera = vi.fn();
    picker.addEventListener('click', openCamera);
    await user.click(screen.getByRole('button', { name: 'Add with camera' }));
    expect(openCamera).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();

    await user.upload(picker, new File(['photo'], 'camera.jpg', { type: 'image/jpeg' }));
    expect(await screen.findByLabelText('Description')).toHaveValue('');
    expect(screen.getAllByText('camera.jpg')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Review multiple items' }));
    await screen.findByRole('heading', { name: 'Photo review' });
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await continueToItemDetails(user);
    expect(await screen.findByLabelText('Description')).toHaveValue('');
    expect(screen.queryByText('camera.jpg')).not.toBeInTheDocument();
  });

  it('switches the Add tab between an item and a box', async () => {
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
    await user.click(
      within(await screen.findByRole('navigation')).getByRole('button', { name: 'Add' }),
    );
    await continueToItemDetails(user);
    const addBox = screen.getByRole('button', { name: 'Add box' });
    await waitFor(() => expect(addBox).toBeEnabled());
    await user.type(screen.getByLabelText('Description'), 'Keep this draft');
    await user.click(addBox);
    const dialog = await screen.findByRole('alertdialog', { name: 'Discard this draft?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Description')).toHaveValue('Keep this draft');
    await user.click(addBox);
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard draft' }),
    );
    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add box' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    expect(await screen.findByRole('button', { name: 'Add manually' })).toBeInTheDocument();
  });

  it('shows remaining places when the selected location is revoked', async () => {
    const env = createFakeEnvironment({
      cabinLocation: true,
      initialConnection: {
        id: 'https://kept.example.com|ibrahim|epoch-1',
        origin: 'https://kept.example.com',
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const user = userEvent.setup();
    env.renderApp();
    await user.click(await screen.findByRole('button', { name: '1 Places' }));
    await user.click(screen.getByRole('button', { name: /Location/ }));
    await user.click(screen.getByRole('option', { name: 'Cabin' }));
    expect(screen.queryByRole('button', { name: /Garage/ })).not.toBeInTheDocument();

    env.revokeCabinLocation();
    act(() => env.emitAppState(true));
    expect(await screen.findByRole('button', { name: /^Garage/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Location/ })).not.toBeInTheDocument();
  });

  it('archives a box photo from its photo library and restores it', async () => {
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
    await openWinterBox(user);
    await user.click(screen.getByRole('button', { name: 'Add photos' }));
    const picker = document.querySelectorAll<HTMLInputElement>('input[type="file"]')[1];
    if (!picker) throw new Error('Expected photo picker');
    await user.upload(picker, new File(['image bytes'], 'bin.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: 'Save photos' }));
    expect(await screen.findByText('Synced: 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));

    await user.click(await screen.findByRole('button', { name: 'Photo library' }));
    expect(await screen.findByRole('button', { name: /Current \(1\)/ })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'photo.jpg' }));
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(await screen.findByRole('button', { name: /Archived \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Current \(0\)/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Archived/ }));
    await user.click(await screen.findByRole('button', { name: 'photo.jpg' }));
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByRole('button', { name: /Current \(1\)/ })).toBeInTheDocument();
  });

  it('shows recent activity on Home and the full History and Logs with provenance', async () => {
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
    const recent = await screen.findByRole('region', { name: 'Recent activity' });
    expect(within(recent).getByText(/Fixture ladder/)).toBeInTheDocument();

    await user.click(within(recent).getByRole('button', { name: 'History' }));
    expect(await screen.findByRole('heading', { name: 'History' })).toBeInTheDocument();
    expect(await screen.findByText(/Fixture ladder/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));

    await openSettings(user);
    await user.click(await screen.findByRole('button', { name: 'Logs' }));
    const entry = await screen.findByRole('button', { name: /Fixture ladder/ });
    expect(screen.queryByText('Event ID')).not.toBeInTheDocument();
    await user.click(entry);
    expect(screen.getByText('Who')).toBeInTheDocument();
    expect(screen.getByText('Server logged')).toBeInTheDocument();
    expect(screen.getByText('activity-1')).toBeInTheDocument();
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

    const tabbar = await screen.findByRole('navigation');
    expect(within(tabbar).getAllByRole('button')).toEqual(
      ['Home', 'Search', 'Scan', 'Add', 'More'].map((name) =>
        within(tabbar).getByRole('button', { name }),
      ),
    );
    expect(within(tabbar).getByRole('button', { name: 'Home' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // The Scan tab opens label identification with a back button.
    await user.click(within(tabbar).getByRole('button', { name: 'Scan' }));
    expect(await screen.findByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(within(tabbar).getByRole('button', { name: 'Scan' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    // Search opens Browse directly and reselecting the tab keeps the current query.
    const searchTab = within(tabbar).getByRole('button', { name: 'Search' });
    await user.click(searchTab);
    const browseSearch = await screen.findByRole('textbox', { name: 'Search' });
    expect(searchTab).toHaveAttribute('aria-current', 'page');
    await user.type(browseSearch, 'ladder');
    await user.click(searchTab);
    expect(browseSearch).toHaveValue('ladder');

    // The Add tab opens the guided form with a back button.
    await user.click(within(tabbar).getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('button', { name: 'Add manually' })).toBeInTheDocument();

    // The More tab compartments settings, appearance, and secondary workflows.
    await user.click(within(tabbar).getByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('button', { name: 'Settings' }));
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

    // Sign-out lives in Settings.
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));

    // Scan and Add already have tabs, so More does not repeat them; secondary workflows stay.
    expect(screen.queryByRole('button', { name: 'Scan QR or NFC' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print label sheets' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trash' })).toBeInTheDocument();

    // Home is the landing screen: the search field comes first and the Rooms count is one tap
    // away; sign-out lives only in Settings.
    await user.click(within(tabbar).getByRole('button', { name: 'Home' }));
    const search = await screen.findByRole('searchbox', { name: 'Search inventory' });
    expect(screen.getByRole('button', { name: /Places$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Capture inventory' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();

    // Re-tapping the active Home tab focuses the search field.
    await user.click(within(tabbar).getByRole('button', { name: 'Home' }));
    expect(search).toHaveFocus();
    expectLogicalOnly();
  });

  it.each(['online', 'offline'] as const)(
    'finds Matilda Jane on Home and in Items using a search phrase while %s',
    async (network) => {
      const origin = 'https://kept.example.com';
      const connection = {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      };
      const env = createFakeEnvironment({ initialConnection: connection });
      const item = env.serverThings.get(env.boxId);
      if (!item) throw new Error('Expected an inventory fixture');
      item.name = 'Matilda Jane';
      const baseRequest = env.adapters.transport.request;
      const searchAttempts: string[] = [];
      const request = vi
        .spyOn(env.adapters.transport, 'request')
        .mockImplementation(
          async <T,>(
            conn: Connection,
            path: string,
            options?: NativeRequestOptions,
          ): Promise<T> => {
            const url = new URL(path, origin);
            const isBrowse = url.pathname === inventoryPaths.things;
            if (network === 'online' && (isBrowse || url.pathname === inventoryPaths.search)) {
              const q = url.searchParams.get('q') ?? '';
              searchAttempts.push(q);
              const items = q === 'matilda Jane' ? [item] : [];
              const page = { items, next_cursor: null, total: items.length };
              return (
                isBrowse ? page : { things: page, places: [], documents: { items: [] } }
              ) as T;
            }
            if (path === assistantPaths.models || path === assistantPaths.threads)
              return { items: [], next_cursor: null } as T;
            return baseRequest<T>(conn, path, options);
          },
        );
      const user = userEvent.setup();
      env.renderApp();
      const tile = await screen.findByRole('button', { name: '2 Items' });
      await waitFor(() => expect(tile).toBeEnabled());
      if (network === 'offline') env.setOnline(false);

      const phrase = 'find matilda Jane';
      await user.type(screen.getByRole('searchbox', { name: 'Search inventory' }), phrase);
      expect(await screen.findByText('Matilda Jane')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Open in Browse' }));
      const itemsSearch = screen.getByRole('textbox', { name: 'Search' });
      expect(itemsSearch).toHaveValue(phrase);
      expect(await screen.findByRole('button', { name: /Matilda Jane/ })).toBeInTheDocument();
      await user.clear(itemsSearch);
      await user.type(itemsSearch, phrase);
      await user.keyboard('{Enter}');
      expect(itemsSearch).not.toHaveFocus();
      expect(await screen.findByRole('button', { name: /Matilda Jane/ })).toBeInTheDocument();
      expect(screen.getByText('Matches 1')).toBeInTheDocument();
      if (network === 'online') {
        expect(searchAttempts.filter((q) => q === 'matilda Jane')).toHaveLength(3);
        expect(searchAttempts).not.toContain(phrase);
        await user.click(screen.getByRole('button', { name: 'Ask the assistant' }));
        expect(await screen.findByRole('textbox', { name: 'Ask the assistant' })).toHaveValue(
          phrase,
        );
        expect(request.mock.calls.some(([, , options]) => options?.method === 'POST')).toBe(false);
      }
    },
  );

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
    const itemsTile = await screen.findByRole('button', { name: /Items$/ });
    await waitFor(() => expect(itemsTile).toBeEnabled());
    await user.click(itemsTile);
    await user.type(screen.getByRole('textbox', { name: 'Search' }), 'red connector');
    await user.click(screen.getByRole('button', { name: 'Find in photos' }));
    expect(await screen.findByText('Bin photo')).toBeInTheDocument();
    const results = screen.getByRole('list', { name: 'Possible photo matches' });
    expect(within(results).getByText('Garage')).toBeInTheDocument();
    await waitFor(() =>
      expect(results.querySelector('img')).toHaveAttribute(
        'src',
        `${connection.origin}/fixture-thumb.jpg`,
      ),
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
    await screen.findByRole('button', { name: /Boxes$/ });
    await user.type(screen.getByRole('searchbox', { name: 'Search inventory' }), 'Snow shovel');
    await user.click(await screen.findByRole('button', { name: /Add .*Snow shovel/ }));
    expect(screen.getByLabelText('Description')).toHaveValue('Snow shovel');
    // The destination is a one-line summary; the full picker opens only on Change.
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Room or box/ })).not.toBeInTheDocument();
    await saveNewItem(user);
    expect(await screen.findByText('Saved on device.')).toBeInTheDocument();
    await continueToItemDetails(user);
    expect(screen.getByLabelText('Description')).toHaveValue('');
  });

  it('guides a manual add without photos or NFC and makes its QR label available after sync', async () => {
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
    const scanTag = vi.spyOn(env.adapters.nfc, 'scanTag');
    env.renderApp();
    await openWinterBox(user);
    await user.click(screen.getByRole('button', { name: 'Add to this box' }));
    expect(screen.getByRole('button', { name: 'Take a photo' })).toBeVisible();
    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add manually' }));
    expect(screen.getByRole('button', { name: 'Continue to labels' })).toBeDisabled();
    await user.type(screen.getByLabelText('Description'), 'Spare charger');
    await user.click(screen.getByRole('button', { name: 'Continue to labels' }));
    expect(screen.getByRole('heading', { name: 'Add an NFC tag?' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Description')).toHaveValue('Spare charger');
    await user.click(screen.getByRole('button', { name: 'Continue to labels' }));
    await user.click(screen.getByRole('button', { name: 'Skip NFC and save' }));
    expect(await screen.findByText('Synced: 1')).toBeVisible();
    expect(scanTag).not.toHaveBeenCalled();
    expect(env.events.reservedLabelKeys).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(await screen.findByRole('button', { name: 'Spare charger' }));
    await user.click(await screen.findByRole('button', { name: 'QR and NFC label' }));
    expect(await screen.findByRole('button', { name: 'Share QR label PDF' })).toBeVisible();
  });

  it('gives a new item a scanned blank label or a newly written NFC tag, claimed at sync', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const request = vi.spyOn(env.adapters.transport, 'request');
    const scanTag = vi.spyOn(env.adapters.nfc, 'scanTag');
    const user = userEvent.setup();
    env.renderApp();
    const boxes = await screen.findByRole('button', { name: '2 Boxes' });
    await waitFor(() => expect(boxes).toBeEnabled());
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Add' }));
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Camera');
    await openItemLabelPicker(user);

    // A tag that already belongs to something is refused; a blank label of this location is taken.
    env.pushScan(
      { status: 'read', url: `${origin}/l/7KQ4MZ` },
      { status: 'read', url: `${origin}/l/BNK234` },
    );
    await user.click(screen.getByRole('button', { name: 'Scan NFC tag' }));
    expect(
      await screen.findByText(/already on .*Winter Box.*Use a blank label/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Scan NFC tag' }));
    expect(await screen.findByText(/Scanned label\. It opens this item/)).toBeInTheDocument();
    expect(screen.getByText('BNK234')).toBeInTheDocument();
    await saveNewItem(user);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.anything(),
        capturePaths.syncOps,
        expect.objectContaining({
          body: expect.objectContaining({
            ops: [
              expect.objectContaining({
                payload: expect.objectContaining({ name: 'Camera', claimCode: 'BNK234' }),
              }),
            ],
          }),
        }),
      ),
    );
    // The next item starts without a label.
    expect(await screen.findByText('Saved on device.')).toBeInTheDocument();
    expect(screen.queryByText('BNK234')).not.toBeInTheDocument();

    // Scanning a writable blank tag leads straight to writing without a second inspection.
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Lens');
    await openItemLabelPicker(user);
    env.pushScan(
      {
        status: 'blank',
        fingerprint: 'fp-1',
        occupied: false,
        writable: true,
        capacity: 137,
      },
      { status: 'written' },
    );
    await user.click(screen.getByRole('button', { name: 'Scan NFC tag' }));
    expect(await screen.findByText('This tag is blank and ready to write.')).toBeInTheDocument();
    expect(env.events.reservedLabelKeys).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Write and verify' }));
    expect(await screen.findByText(/NFC tag written and verified/)).toBeInTheDocument();
    expect(
      scanTag.mock.calls.slice(-2).map(([, input]) => [input.mode, input.url, input.fingerprint]),
    ).toEqual([
      ['read', undefined, undefined],
      ['write', `${origin}/l/RSV234`, 'fp-1'],
    ]);
    expect(env.events.reservedLabelKeys).toHaveLength(1);
    expect(env.events.reservedLabelKeys[0]).toEqual(expect.any(String));
    await saveNewItem(user);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.anything(),
        capturePaths.syncOps,
        expect.objectContaining({
          body: expect.objectContaining({
            ops: [
              expect.objectContaining({
                payload: expect.objectContaining({ name: 'Lens', claimCode: 'RSV234' }),
              }),
            ],
          }),
        }),
      ),
    );
  });

  it('makes a new QR label for an item, and labels an item that is not a box', async () => {
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
    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Add to this box' }));
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Watch');
    await openItemLabelPicker(user);
    await user.click(screen.getByRole('button', { name: 'New QR label' }));
    expect(await screen.findByText(/New QR label\. Share it to print/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Share QR label PDF' }));
    expect(env.events.sharedLabelPdfs).toEqual([{ url: `${origin}/l/RSV234`, name: 'Watch' }]);
    // Returning from details and choosing the label again keeps the code already shared.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Continue to labels' }));
    await user.click(screen.getByRole('button', { name: 'Remove label' }));
    await user.click(screen.getByRole('button', { name: 'New QR label' }));
    expect(await screen.findByText('RSV234')).toBeInTheDocument();
    expect(env.events.reservedLabelKeys).toHaveLength(1);
    await saveNewItem(user);
    expect(await screen.findByText('Synced: 1')).toBeInTheDocument();

    // An item that is not a box has its own label screen, opened from the item.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(await screen.findByRole('button', { name: /^Watch/ }));
    expect(await screen.findByRole('heading', { name: 'Watch' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Find this box' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'QR and NFC label' }));
    await user.click(screen.getByRole('button', { name: 'Share QR label PDF' }));
    expect(env.events.sharedLabelPdfs.at(-1)).toEqual({ url: `${origin}/l/RSV234`, name: 'Watch' });
  });

  it('offers a reserved label again after a draft is discarded, instead of reserving another', async () => {
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
    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Add to this box' }));
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Ring');
    await openItemLabelPicker(user);
    await user.click(screen.getByRole('button', { name: 'New QR label' }));
    expect(await screen.findByText(/New QR label\. Share it to print/)).toBeInTheDocument();
    expect(env.events.reservedLabelKeys).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Continue to labels' }));
    await user.click(screen.getByRole('button', { name: 'Remove label' }));

    // Discarding the draft leaves the reserved code unused; the next form takes it back.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(await screen.findByRole('button', { name: 'Discard draft' }));
    await user.click(await screen.findByRole('button', { name: 'Add to this box' }));
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Necklace');
    await openItemLabelPicker(user);
    await user.click(screen.getByRole('button', { name: 'New QR label' }));
    expect(await screen.findByText('RSV234')).toBeInTheDocument();
    expect(env.events.reservedLabelKeys).toHaveLength(1);
  });

  it('recovers an unverified write by scanning its tag and keeps its code out of the reuse pool', async () => {
    const origin = 'https://kept.example.com';
    const connection = {
      id: `${origin}|ibrahim|epoch-1`,
      origin,
      account: 'ibrahim',
      epoch: 'epoch-1',
    };
    const env = createFakeEnvironment({ initialConnection: connection });
    const user = userEvent.setup();
    env.renderApp();
    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Add to this box' }));
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Ring');
    await openItemLabelPicker(user);
    env.pushScan(
      {
        status: 'inspected',
        fingerprint: 'tag-contents',
        writable: true,
        capacity: 137,
        required: 36,
      },
      { status: 'write_unverified' },
    );
    await user.click(screen.getByRole('button', { name: 'Write new NFC tag' }));
    await user.click(await screen.findByRole('button', { name: 'Write and verify' }));
    await screen.findByText(/Writing was interrupted/);
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(await screen.findByRole('button', { name: 'Discard draft' }));

    await user.click(screen.getByRole('button', { name: 'Add to this box' }));
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Ring');
    await openItemLabelPicker(user);
    env.pushScan({ status: 'read', url: `${origin}/l/RSV234` });
    await user.click(screen.getByRole('button', { name: 'Scan NFC tag' }));
    await screen.findByText(/Scanned label\. It opens this item once the item syncs/);
    expect(
      JSON.parse((await env.adapters.outbox.getValue(connection, 'reservedLabelsV2')) ?? '{}'),
    ).toEqual({});
  });

  it('keeps a reserved code for the next tag when the write never started', async () => {
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
    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Add to this box' }));
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Ring');
    await openItemLabelPicker(user);
    const inspected = {
      status: 'inspected',
      fingerprint: 'tag-contents',
      writable: true,
      capacity: 137,
      required: 36,
    };
    env.pushScan(inspected, { status: 'cancelled', writeStarted: false }, inspected, {
      status: 'written',
      writeStarted: true,
    });
    await user.click(screen.getByRole('button', { name: 'Write new NFC tag' }));
    await user.click(await screen.findByRole('button', { name: 'Write and verify' }));
    await screen.findByText('Scan cancelled.');
    await user.click(screen.getByRole('button', { name: 'Write new NFC tag' }));
    await user.click(await screen.findByRole('button', { name: 'Write and verify' }));
    await screen.findByText(/NFC tag written and verified/);
    expect(env.events.reservedLabelKeys).toHaveLength(1);
  });

  it('shelves a late reservation for the next capture without opening the NFC reader', async () => {
    const origin = 'https://kept.example.com';
    const env = createFakeEnvironment({
      initialConnection: {
        id: `${origin}|ibrahim|epoch-1`,
        origin,
        account: 'ibrahim',
        epoch: 'epoch-1',
      },
    });
    const request = env.adapters.transport.request;
    const gate = Promise.withResolvers<void>();
    vi.spyOn(env.adapters.transport, 'request').mockImplementation(
      async (connection, path, options) => {
        const response = await request(connection, path, options);
        if (path === capturePaths.labelReserve) await gate.promise;
        return response;
      },
    );
    const scan = vi.spyOn(env.adapters.nfc, 'scanTag');
    const user = userEvent.setup();
    env.renderApp();
    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Add to this box' }));
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Ring');
    await openItemLabelPicker(user);
    await user.click(screen.getByRole('button', { name: 'Write new NFC tag' }));
    await waitFor(() => expect(env.events.reservedLabelKeys).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(await screen.findByRole('button', { name: 'Discard draft' }));
    await screen.findByRole('button', { name: 'Add to this box' });
    await act(async () => gate.resolve());
    expect(scan).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Add to this box' }));
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Ring');
    await openItemLabelPicker(user);
    await user.click(screen.getByRole('button', { name: 'New QR label' }));
    expect(await screen.findByText('RSV234')).toBeInTheDocument();
    expect(env.events.reservedLabelKeys).toHaveLength(1);
  });

  it('asks before a label is left behind by a review of several items, and keeps it for the next item', async () => {
    const origin = 'https://kept.example.com';
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
        items: [{ name: 'Lights' }, { name: 'Tinsel' }],
      })),
    };
    const user = userEvent.setup();
    // These read the server's suggestions: this iPhone opts into the server's API key.
    await env.adapters.outbox.setValue(
      { id: `${origin}|ibrahim|epoch-1` } as Connection,
      'defaultPhotoAI',
      'server',
    );
    env.renderApp();
    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Add to this box' }));
    const picker = document.querySelector<HTMLInputElement>(
      'input[type=file][accept="image/*"][multiple]',
    );
    if (!picker) throw new Error('Photo input is missing');
    await user.upload(picker, new File([new Uint8Array([1])], 'a.jpg', { type: 'image/jpeg' }));
    await continueToItemDetails(user);
    await user.type(screen.getByLabelText('Description'), 'Holiday supplies');
    await openItemLabelPicker(user);
    await user.click(screen.getByRole('button', { name: 'New QR label' }));
    expect(await screen.findByText('RSV234')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));

    // Declining keeps the draft, the photo and the label exactly as they were.
    await user.click(await screen.findByRole('button', { name: 'Suggest items' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryAllByText('Photo review')).toHaveLength(0);
    expect(screen.getByLabelText('Description')).toHaveValue('Holiday supplies');
    await user.click(screen.getByRole('button', { name: 'Continue to labels' }));
    expect(screen.getByText('RSV234')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));

    // Confirming reviews both items without the label, which stays for the next item.
    await user.click(screen.getByRole('button', { name: 'Suggest items' }));
    await user.click(await screen.findByRole('button', { name: 'Review items' }));
    expect((await screen.findAllByText('Photo review')).length).toBeGreaterThan(0);
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
    await openWinterBox(user);
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Add' }));
    await continueToItemDetails(user);
    expect(await screen.findByText(/Winter Box/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Description'), 'Scarf');
    await saveNewItem(user);
    expect(await screen.findByText('Saved on device.')).toBeInTheDocument();
  });
});
