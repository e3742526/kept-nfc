import {
  deviceLabelCode,
  deviceLabelReference,
  parseDeviceLabel,
  parseDeviceLabelReference,
  parseScan,
} from '@kept/shared';
/**
 * Mock handlers for label batches, blank sheets, "Printed OK?" and claims (T16). A thing without
 * a code (an offline capture not yet synced) can't be in a batch: it's counted as `pending`. A
 * claim of a code another phone claimed first is 409 `label_claimed` with the other target's
 * name; any code the caller can't claim is the same 404 as a random one (D137). A `dryRun`
 * create (the preview) answers the labels without saving a batch or allocating a blank (a place
 * with no code is given one, as by the server), and names
 * the newest unconfirmed batch holding exactly the same codes. "Not printed" (`dismiss`) sets an
 * unconfirmed batch aside; "Printed OK?" clears that. The print queue is the signed-in user's own:
 * "Prepare labels" makes the batch for a location's queued things or places as POST /labels/batches
 * does, and "Printed OK?" takes what that batch printed off the queue.
 */

import {
  accessOf,
  liveThing,
  newId,
  now,
  paginate,
  placePath,
  type StoredThing,
  thingPath,
} from '../../inventory/mock/db';
import { contentsTemplate } from '../../inventory/mock/places';
import type { PathStep } from '../../inventory/types';
import type { MockState } from '../../mock/fixtures';
import {
  err,
  forbidden,
  MockReply,
  type MockRoute,
  notFound,
  reply,
  route,
  sessionGate,
} from '../../mock/kit';
import { capturePaths as p } from '../paths';
import type {
  ClaimBody,
  CreateLabelBatchBody,
  LabelBatch,
  LabelBatchPreview,
  LabelCellContent,
  RegisterLabelTag,
  ReplaceLabelBody,
} from '../types';
import { allocateCode } from './capture';
import { type StoredQueueEntry, urlOf } from './state';

const BLANK_CAP = 1000;
const QUEUE_CAP = 500;

type QueueTarget = { locationId: string; kind: 'thing' | 'place'; recordId: string };
type QueueAction =
  | (QueueTarget & { action: 'add' | 'remove' })
  | (Omit<QueueTarget, 'recordId'> & { action: 'prepare'; stock: string });

/** "Garage › Shelf A": the label's path line (unplaced areas included, as the server names them). */
const pathText = (steps: PathStep[]) => steps.map((s) => s.name).join(' › ');

/** Every code on a printed label in the mock (see `printedCodes` below); Home's count uses it too.
 * Things only: a place's `labelPrinted` isn't read here, as the place fixtures' codes were never
 * printed in the labels' story (its tests print them). */
export function printedCodesOf(state: MockState): Set<string> {
  const out = new Set(state.capture.codes.filter((c) => c.printedAt).map((c) => c.code));
  for (const t of state.inventory.things) if (t.labelPrinted && t.shortCode) out.add(t.shortCode);
  return out;
}

export function labelsRoutes(state: MockState): MockRoute[] {
  const inv = () => state.inventory;
  const cap = () => state.capture;
  const access = () => accessOf(state);
  const codeTaken = (code: string) =>
    inv().things.some((t) => t.shortCode === code) ||
    inv().places.some((x) => x.shortCode === code) ||
    cap().codes.some((c) => c.code === code);
  const labelsOn = (locationId: string) =>
    state.locations.find((l) => l.id === locationId)?.modules.includes('labels') ?? false;
  /** The thing or place now carries a printed label (StoredThing/StoredPlace.labelPrinted). */
  const markLabelled = (target: { kind: 'thing' | 'place'; id: string }) => {
    const rows: { id: string; labelPrinted?: boolean }[] =
      target.kind === 'thing' ? inv().things : inv().places;
    const row = rows.find((x) => x.id === target.id);
    if (row) row.labelPrinted = true;
  };
  /** The codes on a printed label: a code confirmed printed, or the code of a thing the fixtures
   * say carries one (`labelPrinted`, what lists show as the tape). The server's rule is one table
   * (labels/printed-sql.ts); the mock keeps the two in step here. */
  const printedCodes = () => printedCodesOf(state);
  const me = () => state.me.user.id;
  /** The signed-in user's queue rows, oldest first (the same objects as in the state). */
  const myQueue = () =>
    cap()
      .labelQueue.filter((q) => q.userId === me())
      .slice(0, QUEUE_CAP);
  /** The queued thing or place, while it is live in the location it was queued in. */
  const queuedRecord = ({ locationId, kind, recordId }: QueueTarget) => {
    if (!access().visible(locationId)) return undefined;
    const record =
      kind === 'thing'
        ? liveThing(inv(), recordId)
        : inv().places.find((x) => x.id === recordId && !x.deletedAt);
    return record?.locationId === locationId ? record : undefined;
  };
  const queueItems = () =>
    myQueue().map(({ locationId, kind, recordId, batchId }) => {
      const record = queuedRecord({ locationId, kind, recordId });
      return {
        locationId,
        kind,
        recordId,
        batchId,
        name: record?.name ?? null,
        available: record !== undefined,
      };
    });
  /** POST /labels/batches, which "Prepare labels" calls as the server's queue calls createBatch. */
  const createBatch = (body: CreateLabelBatchBody) =>
    routes
      .find((r) => r.method === 'POST' && r.template === p.labelBatches)
      ?.handler({
        method: 'POST',
        path: p.labelBatches,
        params: {},
        query: new URLSearchParams(),
        headers: {},
        body,
      });

  const short = (locationId: string, text: string) => {
    const scan = parseScan(text);
    if (scan.kind === 'kept') return scan.code;
    if (scan.kind !== 'alias') return '';
    for (const batch of cap().labelBatches) {
      if (batch.locationId !== locationId) continue;
      const cell = batch.labels.find((label) => label.alias === scan.alias);
      if (!cell) continue;
      const guard = parseDeviceLabelReference(cell.url.split('/').at(-1) ?? '')?.guard;
      if (!scan.guard || scan.guard === guard) return cell.code;
    }
    return '';
  };
  const routes: MockRoute[] = [
    // The label address: the mock has no label host, so labels carry the page's own origin.
    route('POST', p.labelTags, ({ body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const tag = body as RegisterLabelTag;
      if (!access().visible(tag.locationId)) return notFound();
      if (!access().canWrite(tag.locationId)) return forbidden();
      if (!labelsOn(tag.locationId))
        return err(409, 'module_off', 'Labels are off in this location.');
      const code = short(tag.locationId, tag.label);
      const entry = cap().codes.find(
        (item) => item.code === code && item.locationId === tag.locationId,
      );
      if (entry?.state !== 'assigned') return notFound();
      if (tag.kind === 'nfc') entry.nfc = true;
      else {
        const epc = tag.epc.trim().toUpperCase();
        if (!/^(?:[0-9A-F]{2}){4,64}$/.test(epc)) return err(400, 'validation', 'Invalid EPC.');
        if (
          (entry.uhfEpc && entry.uhfEpc !== epc) ||
          cap().codes.some((item) => item !== entry && item.uhfEpc === epc)
        ) {
          return err(409, 'conflict', 'The EPC or label already has a registration.');
        }
        entry.uhfEpc = epc;
      }
      return reply(200, { configured: true });
    }),
    route('POST', p.labelReplace, ({ body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const { locationId, previous, replacement, reason } = body as ReplaceLabelBody;
      if (!access().visible(locationId)) return notFound();
      if (!access().canWrite(locationId)) return forbidden();
      if (!labelsOn(locationId)) return err(409, 'module_off', 'Labels are off in this location.');
      if (!reason.trim()) return err(400, 'validation', 'A reason is required.');
      const old = cap().codes.find(
        (entry) => entry.code === short(locationId, previous) && entry.locationId === locationId,
      );
      const next = cap().codes.find(
        (entry) => entry.code === short(locationId, replacement) && entry.locationId === locationId,
      );
      if (!old?.target || old.superseded || next?.state !== 'blank') return notFound();
      old.superseded = true;
      next.state = 'assigned';
      next.target = old.target;
      next.printedAt ??= now();
      return reply(200, old.target);
    }),
    route('GET', p.labelAddress, () => reply(200, { url: urlOf('').replace(/\/l\/$/, '') })),
    route('POST', p.labelBatches, ({ body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const b = body as CreateLabelBatchBody;
      if (!access().visible(b.locationId)) return notFound();
      if (!access().canWrite(b.locationId)) return forbidden();
      if (!labelsOn(b.locationId))
        return err(409, 'module_off', 'Labels are off in this location.');
      if (!b.dryRun && b.series?.id && b.id) {
        const prior = cap().labelBatches.find((batch) => batch.id === b.id);
        if (prior) return reply(201, { batch: prior, excluded: { pending: 0, other: 0 } });
        const taken = cap().labelBatches.some((batch) => {
          const first = parseDeviceLabel(batch.labels[0]?.alias ?? '');
          return first?.prefix === b.series?.prefix && first?.batchId === b.series?.id;
        });
        if (taken)
          return err(409, 'label_series_collision', 'This label series is already reserved.');
      }
      const labels: LabelCellContent[] = [];
      // Excluded and counted, as the server does: `pending` when the caller can't see it at all
      // (an offline capture not synced yet looks the same), `other` when it is visible but can't
      // be labelled here (trashed, or in another location).
      let pending = 0;
      let other = 0;
      let blank = 0;
      if (b.kind === 'blank') {
        const count = b.blankCount ?? 0;
        const unclaimed = cap().codes.filter(
          (c) => c.locationId === b.locationId && c.state === 'blank',
        ).length;
        if (count < 1 || count > 500) return err(400, 'validation', 'Between 1 and 500 labels.');
        if (unclaimed + count > BLANK_CAP)
          return err(409, 'blank_cap_reached', 'This location already has 1,000 unclaimed labels.');
        blank = count;
        // A preview allocates nothing: the codes are made only when the batch is.
        for (let i = 0; i < (b.dryRun ? 0 : count); i++) {
          const code = allocateCode(codeTaken);
          cap().codes.push({
            code,
            locationId: b.locationId,
            state: 'blank',
            target: null,
            printedAt: null,
          });
          const alias = b.series?.id
            ? deviceLabelCode(b.series.prefix, b.series.id, i + 1)
            : undefined;
          labels.push({
            code,
            kind: 'blank',
            ...(alias ? { alias } : {}),
            url: urlOf(alias && b.id ? deviceLabelReference(alias, b.id) : code),
          });
        }
      } else if (b.kind === 'things') {
        const printed = printedCodes();
        const ids = b.unprinted
          ? inv()
              .things.filter(
                (t) =>
                  t.locationId === b.locationId &&
                  !t.deletedAt &&
                  !(t.shortCode && printed.has(t.shortCode)) &&
                  (!b.unprinted?.placeId ||
                    thingPath(inv(), t).some((s) => s.id === b.unprinted?.placeId)),
              )
              .map((t) => t.id)
          : (b.thingIds ?? []);
        for (const id of ids) {
          const t = liveThing(inv(), id);
          if (!t || t.locationId !== b.locationId) {
            const seen = inv().things.find((x) => x.id === id);
            if (seen && access().visible(seen.locationId)) other += 1;
            else pending += 1;
            continue;
          }
          if (!t.shortCode) {
            pending += 1;
            continue;
          }
          labels.push({
            code: t.shortCode,
            url: urlOf(t.shortCode),
            kind: 'thing',
            name: t.name ?? '',
            ...(t.type?.name ? { category: t.type.name } : {}),
            path: pathText(thingPath(inv(), t)),
            targetId: t.id,
          });
        }
      } else {
        const printed = printedCodes();
        const under = (placeId: string, root: string): boolean => {
          const pl = inv().places.find((x) => x.id === placeId);
          if (!pl) return false;
          return pl.id === root || (pl.parentId !== null && under(pl.parentId, root));
        };
        const root = b.unprinted?.placeId;
        if (root && !inv().places.some((x) => x.id === root && x.locationId === b.locationId))
          return notFound();
        const ids = b.unprinted
          ? inv()
              .places.filter(
                (x) =>
                  x.locationId === b.locationId &&
                  !x.deletedAt &&
                  !x.isUnplaced &&
                  !(x.shortCode && printed.has(x.shortCode)) &&
                  (!root || under(x.id, root)),
              )
              .sort((a, z) => a.name.localeCompare(z.name))
              .map((x) => x.id)
          : (b.placeIds ?? []);
        for (const id of ids) {
          const pl = inv().places.find((x) => x.id === id && !x.deletedAt);
          if (!pl || pl.locationId !== b.locationId) {
            const seen = inv().places.find((x) => x.id === id);
            if (seen && access().visible(seen.locationId)) other += 1;
            else pending += 1;
            continue;
          }
          // A place with no code is given one, on a dry run too, as the server does.
          if (!pl.shortCode) pl.shortCode = allocateCode(codeTaken);
          const cabinet = inv().places.find(
            (place) => place.id === pl.parentId && !place.deletedAt,
          );
          let position: string | undefined;
          if (pl.kindKey === 'drawer' && pl.cell && cabinet?.layout) {
            const codeEnd = (n: number) => String(n).padStart(2, '0');
            const suffix = `-R${codeEnd(pl.cell.row)}-C${codeEnd(pl.cell.col)}`;
            const positions = pl.ownCodes
              ?.filter(
                (code) =>
                  /-R(0[1-9]|[1-9][0-9])-C(0[1-9]|[1-9][0-9])$/.test(code) &&
                  cabinet.ownCodes?.includes(code.slice(0, -8)),
              )
              .sort();
            position =
              positions?.find((code) => code.endsWith(suffix)) ??
              (positions?.length === 1 ? positions[0] : undefined);
          }
          labels.push({
            code: pl.shortCode,
            url: urlOf(pl.shortCode),
            kind: 'place',
            name: pl.name,
            ...(pl.kindKey === 'drawer' && pl.description
              ? { drawerContents: pl.description }
              : {}),
            ...(position ? { drawerPosition: position } : {}),
            path: pathText(placePath(inv(), pl.parentId)),
            targetId: pl.id,
          });
        }
      }
      const excluded = { pending, other };
      if (b.dryRun) {
        const codes = new Set(labels.map((l) => l.code));
        const same =
          b.kind === 'blank' || codes.size === 0
            ? undefined
            : cap().labelBatches.find(
                (x) =>
                  x.locationId === b.locationId &&
                  x.kind === b.kind &&
                  !x.printedConfirmedAt &&
                  !x.dismissedAt &&
                  x.labels.length === codes.size &&
                  x.labels.every((l) => codes.has(l.code)),
              );
        const unconfirmed = same
          ? { id: same.id, createdAt: same.createdAt, stock: same.stock, count: same.labels.length }
          : null;
        return reply(200, { labels, blank, excluded, unconfirmed } satisfies LabelBatchPreview);
      }
      // A real batch with nothing to label (the preview was stale, or everything is pending).
      if (b.kind !== 'blank' && labels.length === 0)
        return err(
          400,
          'validation',
          'The request is not valid.',
          'Nothing here can be labelled yet: what is left is waiting to sync, or already printed.',
          { excluded },
        );
      const batch: LabelBatch = {
        id: b.id ?? newId(),
        locationId: b.locationId,
        kind: b.kind,
        stock: b.stock,
        ...(b.thermal ? { thermal: b.thermal } : {}),
        startCell: b.startCell ?? 1,
        createdAt: now(),
        printedConfirmedAt: null,
        dismissedAt: null,
        labels,
      };
      cap().labelBatches.unshift(batch);
      return reply(201, { batch, excluded });
    }),

    route('GET', p.labelBatches, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const locationId = query.get('locationId');
      const items = cap().labelBatches.filter(
        (b) => access().visible(b.locationId) && (!locationId || b.locationId === locationId),
      );
      return paginate(items, query);
    }),

    route('GET', p.labelBatch(':id'), ({ params }) => {
      const batch = cap().labelBatches.find((b) => b.id === params.id);
      return batch && access().visible(batch.locationId) ? batch : notFound();
    }),

    route('POST', p.labelBatchPrinted(':id'), ({ params }) => {
      const batch = cap().labelBatches.find((b) => b.id === params.id);
      if (!batch || !access().visible(batch.locationId)) return notFound();
      const at = now();
      batch.printedConfirmedAt ??= at;
      batch.dismissedAt = null;
      for (const l of batch.labels) {
        if (l.targetId && l.kind !== 'blank') markLabelled({ kind: l.kind, id: l.targetId });
        const c = cap().codes.find((x) => x.code === l.code);
        if (c) c.printedAt ??= at;
        else if (l.targetId && l.kind !== 'blank')
          // A thing's or place's own code, printed for the first time.
          cap().codes.push({
            code: l.code,
            locationId: batch.locationId,
            state: 'assigned',
            target: { kind: l.kind, id: l.targetId, name: l.name ?? '' },
            printedAt: at,
          });
      }
      cap().labelQueue = cap().labelQueue.filter((q) => q.batchId !== batch.id);
      return batch;
    }),

    route('POST', p.labelBatchDismiss(':id'), ({ params }) => {
      const batch = cap().labelBatches.find((b) => b.id === params.id);
      if (!batch || !access().visible(batch.locationId)) return notFound();
      if (!access().canWrite(batch.locationId)) return forbidden();
      if (batch.printedConfirmedAt)
        return err(
          400,
          'validation',
          'The request is not valid.',
          'This batch was confirmed printed.',
        );
      batch.dismissedAt ??= now();
      return batch;
    }),

    // One blank for a label made while adding an item; the capture's claimCode claims it.
    route('POST', p.labelReserve, ({ body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const { locationId } = body as { locationId: string };
      if (!access().visible(locationId)) return notFound();
      if (!access().canWrite(locationId)) return forbidden();
      if (!labelsOn(locationId)) return err(409, 'module_off', 'Labels are off in this location.');
      const unclaimed = cap().codes.filter(
        (c) => c.locationId === locationId && c.state === 'blank',
      ).length;
      if (unclaimed + 1 > BLANK_CAP)
        return err(409, 'blank_cap_reached', 'This location already has 1,000 unclaimed labels.');
      const code = allocateCode(codeTaken);
      cap().codes.push({ code, locationId, state: 'blank', target: null, printedAt: null });
      return reply(201, { code, url: urlOf(code), locationId });
    }),

    route('GET', p.labelSummary, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const locationId = query.get('locationId');
      const inScope = (id: string) => access().visible(id) && (!locationId || id === locationId);
      const printed = printedCodes();
      // A count's label coverage: what is in a place and the places inside it, boxes included.
      const placeId = query.get('placeId');
      const under = new Set<string>(placeId ? [placeId] : []);
      for (let grew = !!placeId; grew; ) {
        grew = false;
        for (const pl of inv().places)
          if (pl.parentId && under.has(pl.parentId) && !under.has(pl.id)) {
            under.add(pl.id);
            grew = true;
          }
      }
      const placeOf = (t: {
        placeId: string | null;
        containerId: string | null;
      }): string | null => {
        let cur: { placeId: string | null; containerId: string | null } | undefined = t;
        for (let i = 0; cur && i < 20; i++) {
          if (cur.placeId) return cur.placeId;
          const box: string | null = cur.containerId;
          cur = inv().things.find((x) => x.id === box);
        }
        return null;
      };
      const coded = inv().things.filter(
        (t) =>
          !t.deletedAt &&
          inScope(t.locationId) &&
          t.shortCode &&
          (!placeId || under.has(placeOf(t) ?? '')),
      );
      return {
        unprinted: coded.filter((t) => !printed.has(t.shortCode as string)).length,
        blankUnclaimed: cap().codes.filter((c) => c.state === 'blank' && inScope(c.locationId))
          .length,
        things: coded.length,
      };
    }),

    route('POST', p.codeClaim(':code'), ({ params, body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const code = cap().codes.find((c) => c.code === params.code);
      if (!code || !access().canWrite(code.locationId)) return notFound();
      if (code.state === 'assigned' && code.target)
        return err(409, 'label_claimed', 'This label was already claimed.', undefined, {
          claimedFor: code.target,
        });
      const b = body as ClaimBody;
      let target: { kind: 'thing' | 'place'; id: string; name: string } | null = null;
      if ('thingId' in b) {
        const t = liveThing(inv(), b.thingId);
        if (t?.locationId === code.locationId)
          target = { kind: 'thing', id: t.id, name: t.name ?? '' };
      } else if ('placeId' in b) {
        const pl = inv().places.find((x) => x.id === b.placeId && !x.deletedAt);
        if (pl?.locationId === code.locationId)
          target = { kind: 'place', id: pl.id, name: pl.name };
      } else {
        // D43 "New box here": the container is created and claimed in one step (T16).
        const nc = b.newContainer;
        const parent =
          'placeId' in nc
            ? inv().places.find((x) => x.id === nc.placeId && !x.deletedAt)
            : liveThing(inv(), nc.containerId);
        if (parent?.locationId === code.locationId) {
          inv().things.push({
            ...contentsTemplate(),
            id: nc.id,
            locationId: code.locationId,
            shortCode: code.code,
            name: nc.name,
            type: null,
            placeId: 'placeId' in nc ? nc.placeId : null,
            containerId: 'containerId' in nc ? nc.containerId : null,
            isContainer: true,
            reviewState: 'confirmed',
          } as StoredThing);
          target = { kind: 'thing', id: nc.id, name: nc.name };
        }
      }
      if (!target) return notFound();
      code.state = 'assigned';
      code.target = target;
      // A claimed blank is a printed label: what it went to shows the tape.
      code.printedAt ??= now();
      markLabelled(target);
      return { outcome: 'claimed', target: { kind: target.kind, id: target.id } };
    }),

    route('GET', p.labelQueue, () => sessionGate(state) ?? { items: queueItems() }),
    route('POST', p.labelQueue, ({ body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const input = body as QueueAction;
      if (!['add', 'remove', 'prepare'].includes(input?.action))
        return err(400, 'validation', 'The request is not valid.');
      const { locationId, kind } = input;
      if (!access().visible(locationId)) return notFound();
      if (!access().canWrite(locationId)) return forbidden();
      if (input.action !== 'remove' && !labelsOn(locationId))
        return err(409, 'module_off', 'Labels are off in this location.');
      const queue = myQueue();
      if (input.action === 'prepare') {
        const group = queue.filter((q) => q.locationId === locationId && q.kind === kind);
        const ready = group.find((q) => q.batchId)?.batchId;
        if (ready) return { items: queueItems(), batchId: ready };
        const ids = group.filter((q) => queuedRecord(q)).map((q) => q.recordId);
        if (!ids.length) return notFound();
        const made = createBatch({
          locationId,
          kind: kind === 'thing' ? 'things' : 'places',
          stock: input.stock,
          ...(kind === 'thing' ? { thingIds: ids } : { placeIds: ids }),
        });
        if (!(made instanceof MockReply) || made.status !== 201) return made;
        const { batch } = made.body as { batch: LabelBatch };
        const printed = new Set(batch.labels.map((label) => label.targetId));
        for (const q of group) if (printed.has(q.recordId)) q.batchId = batch.id;
        return { items: queueItems(), batchId: batch.id };
      }
      const { recordId } = input;
      const same = (q: StoredQueueEntry) =>
        q.locationId === locationId && q.kind === kind && q.recordId === recordId;
      if (input.action === 'add') {
        if (queue.some(same)) return { items: queueItems() };
        // A record queued in another location is moved here, so it doesn't grow the queue.
        if (
          queue.length >= QUEUE_CAP &&
          !queue.some((q) => q.kind === kind && q.recordId === recordId)
        )
          return err(409, 'conflict', 'The print queue is full.');
        const record = queuedRecord(input);
        if (!record || ('isUnplaced' in record && record.isUnplaced)) return notFound();
        cap().labelQueue = cap().labelQueue.filter(
          (q) => !(q.userId === me() && q.kind === kind && q.recordId === recordId),
        );
        cap().labelQueue.push({ userId: me(), locationId, kind, recordId, batchId: null });
        return { items: queueItems() };
      }
      const batchId = queue.find(same)?.batchId;
      if (batchId) {
        // "Not printed" for its batch, and the batch's other labels go back to the queue.
        const batch = cap().labelBatches.find((b) => b.id === batchId);
        if (batch?.printedConfirmedAt)
          return err(
            400,
            'validation',
            'The request is not valid.',
            'This batch was confirmed printed.',
          );
        if (batch) batch.dismissedAt ??= now();
        for (const q of cap().labelQueue) if (q.batchId === batchId) q.batchId = null;
      }
      cap().labelQueue = cap().labelQueue.filter((q) => !(q.userId === me() && same(q)));
      return { items: queueItems() };
    }),
  ];
  return routes;
}
