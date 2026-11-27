/**
 * Sending the queue to `POST /sync/ops` (D35, D148): the rules the sync engine follows, apart
 * from where the queue is kept, so the iPhone app's SQLite queue (native/sync-queue.ts) sends by
 * the same rules as the web app's Dexie one.
 *
 * - Ops go strictly in queue order, 50 at a time, stopping at the first entry whose files aren't
 *   up yet (`nextBatch`, queue.ts). An entry whose `dependsOn` parent was dropped on this phone
 *   is dropped without being sent.
 * - An entry is marked `sent` before the request. With no answer (offline, 5xx, a dropped
 *   connection) it stays `sent` and goes again next time, unchanged, under the same key: the
 *   server answers a replay from its ledger.
 * - A 409 `client_outdated` or `server_outdated` blocks the batch and keeps the queue.
 * - A 400 finds the op that doesn't parse by sending one at a time, and drops only that one.
 * - A partial answer (a 500 in one op) puts the unanswered ones back to `pending`.
 */
import type { QueueItem, SyncOpResult, SyncOpsRequest, SyncOpsResponse } from '@kept/shared';
import { ApiError } from '@/api/client';
import { nextBatch } from './queue';
import type { QueueEntry, SyncNotice } from './store';
import type { SyncStore } from './sync-store';

/** What sending needs from a store: a subset of `SyncStore`. */
export type SendStore = Pick<
  SyncStore,
  'entries' | 'unuploadedSeqs' | 'setState' | 'settle' | 'clearOutdated'
> & {
  addNotice(notice: Omit<SyncNotice, 'id' | 'at'>): Promise<void>;
};

export type OutdatedCode = 'client_outdated' | 'server_outdated';

export type SendOptions = {
  clientVersion: string;
  /** Why entries left blocked by an earlier run are held, when the caller knows. */
  blockedCode?: () => OutdatedCode | null;
  /** The server refused this build or itself is too old: the batch is blocked. */
  onBlocked?: (code: OutdatedCode) => void;
  /** The server answered a batch: whatever blocked the queue before is over. */
  onAnswered?: () => void;
};

const errStatus = (e: unknown) => (e instanceof ApiError ? e.status : undefined);
const outdatedCode = (e: unknown): OutdatedCode | null =>
  e instanceof ApiError && (e.code === 'client_outdated' || e.code === 'server_outdated')
    ? e.code
    : null;

/** Exactly the wire fields: the server's schema is strict (SyncOpsRequestSchema). */
export function toItem(e: QueueEntry): QueueItem {
  return {
    clientVersion: e.clientVersion,
    payloadVersion: e.payloadVersion,
    clientId: e.clientId,
    idempotencyKey: e.idempotencyKey,
    op: e.op,
    takenAt: e.takenAt,
    locationId: e.locationId,
    ...(e.dependsOn ? { dependsOn: e.dependsOn } : {}),
    payload: e.payload,
  };
}

/** An answer made on the phone for an op the server never saw. */
export const localDrop = (e: QueueEntry, reason: string): SyncOpResult => ({
  clientId: e.clientId,
  idempotencyKey: e.idempotencyKey,
  outcome: 'dropped',
  reason,
});

/**
 * Sends every ready op, in order. Answers the problem that left ops blocked, or null. Throws when
 * a batch got no answer (its ops stay `sent`) or only part of one.
 */
export async function sendQueue(
  store: SendStore,
  syncOps: (body: SyncOpsRequest) => Promise<SyncOpsResponse>,
  opts: SendOptions,
): Promise<OutdatedCode | null> {
  let max: number | undefined;
  for (;;) {
    const all = await store.entries();
    const byKey = new Map(all.map((e) => [e.idempotencyKey, e.state]));
    const needs = await store.unuploadedSeqs();
    const batch = nextBatch(
      all,
      (seq) => !needs.has(seq),
      (k) => byKey.get(k),
      max,
    );
    let send = batch.send;
    for (const e of batch.parentDropped) await store.settle(localDrop(e, 'parent_dropped'));
    if (send.length === 0) {
      const blocked = all.some((e) => e.state === 'blocked');
      return blocked ? (opts.blockedCode?.() ?? 'client_outdated') : null;
    }
    await store.setState(
      send.map((e) => e.seq),
      'sent',
    );
    // Re-read: an op taken back ("Undo this batch", `unqueue`) before it was marked is gone.
    const marked = new Set(send.map((e) => e.seq));
    send = (await store.entries()).filter((e) => marked.has(e.seq) && e.state === 'sent');
    if (send.length === 0) continue;
    const seqs = send.map((e) => e.seq);
    let res: SyncOpsResponse;
    try {
      res = await syncOps({ clientVersion: opts.clientVersion, ops: send.map(toItem) });
    } catch (e) {
      const outdated = outdatedCode(e);
      if (outdated) {
        // Nothing in the batch was applied; the queue stays, blocked, never dropped (D148).
        await store.setState(seqs, 'blocked');
        await store.addNotice({ kind: 'outdated' });
        opts.onBlocked?.(outdated);
        return outdated;
      }
      if (errStatus(e) === 400) {
        // The batch didn't parse. Find the one op that doesn't, by sending one at a time.
        if (send.length > 1) {
          await store.setState(seqs, 'pending');
          max = 1;
          continue;
        }
        const [only] = send;
        if (only) await store.settle(localDrop(only, 'invalid'));
        continue;
      }
      // No answer (offline, 5xx, a dropped connection): the server may have applied them, so
      // they stay `sent` (never taken back by `unqueue`, never re-written by an upgrade) and go
      // again next run with the same keys; the server answers a replay from its ledger.
      throw e;
    }
    opts.onAnswered?.();
    await store.clearOutdated();
    const answered = new Set<string>();
    for (const r of res.results) {
      await store.settle(r);
      answered.add(r.idempotencyKey);
    }
    const unanswered = send.filter((e) => !answered.has(e.idempotencyKey));
    if (unanswered.length > 0) {
      // The server stopped part-way (a 500 in one op): the rest go again, same keys.
      await store.setState(
        unanswered.map((e) => e.seq),
        'pending',
      );
      throw new ApiError(500, 'internal', 'The server answered part of the batch.');
    }
  }
}
