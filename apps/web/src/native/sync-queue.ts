/**
 * The iPhone app's `/sync/ops` queue: kept in the app's SQLite database (SyncQueue.swift), sent
 * by the web app's rules (offline/send-queue.ts, D35 and D148). Before it, each capture replay
 * posted its ops itself and could rebuild them between attempts; now an op is queued once, under
 * its idempotency key, and the queue decides what goes, in order:
 *
 * - an op is frozen once queued: a replay re-reads it rather than building it again, so a retry
 *   never sends a different payload under a key the server may already have applied;
 * - `sent` ops go again unchanged when no answer came; answered ones are never sent again;
 * - an older server blocks the batch and the queue is kept (a `compatibility_hold` for the
 *   capture), never dropped or stripped;
 * - a capture's ops can be cleared for a retarget only while none of them may have been applied.
 *
 * Files are uploaded by the capture's replay before its ops are queued, so no queued op waits for
 * one. Finishing a capture (synced or discarded) removes its ops in the same SQLite transaction.
 */
import {
  KEPT_VERSION,
  type QueueItem,
  type SyncOpResult,
  type SyncOpsRequest,
  type SyncOpsResponse,
} from '@kept/shared';
import { capturePaths } from '@/api/capture/paths';
import { ApiError } from '@/api/client';
import { type SendStore, sendQueue } from '@/offline/send-queue';
import type { QueueEntry, QueueState } from '@/offline/store';
import type { PlatformAdapters } from './adapters';
import type { Connection, SyncOpRow } from './bridge';

const STATE_BATCH = 100;

function toEntry(row: SyncOpRow): QueueEntry {
  return {
    ...(JSON.parse(row.item) as QueueItem),
    seq: row.seq,
    state: row.state as QueueState,
    ...(row.result ? { result: JSON.parse(row.result) as SyncOpResult } : {}),
  };
}

export class NativeSyncQueue implements SendStore {
  constructor(
    private readonly connection: Connection,
    private readonly adapters: PlatformAdapters,
  ) {}

  private get rows() {
    return this.adapters.outbox.syncQueue;
  }

  /** Queues a capture's ops in order; ops already queued under their keys come back as they are. */
  async enqueue(capture: string, items: QueueItem[]): Promise<QueueEntry[]> {
    const rows = await this.rows.enqueue(
      this.connection,
      capture,
      items.map((item) => ({ idempotencyKey: item.idempotencyKey, item: JSON.stringify(item) })),
    );
    return rows.map(toEntry);
  }

  async entries(): Promise<QueueEntry[]> {
    return (await this.rows.list(this.connection)).map(toEntry);
  }

  /** The queued ops of one capture, by idempotency key. */
  async ofCapture(capture: string): Promise<Map<string, QueueEntry>> {
    const id = capture.toLowerCase();
    const rows = (await this.rows.list(this.connection)).filter((row) => row.capture === id);
    return new Map(rows.map((row) => [row.idempotencyKey, toEntry(row)]));
  }

  /** The replay uploads a capture's files before queueing its ops. */
  async unuploadedSeqs(): Promise<Set<number>> {
    return new Set();
  }

  async setState(seqs: number[], state: QueueState): Promise<void> {
    for (let at = 0; at < seqs.length; at += STATE_BATCH) {
      await this.rows.setState(this.connection, seqs.slice(at, at + STATE_BATCH), state);
    }
  }

  async settle(result: SyncOpResult, state: QueueState = result.outcome): Promise<void> {
    await this.rows.settle(this.connection, result.idempotencyKey, state, JSON.stringify(result));
  }

  /** The app shows a failed capture on the capture itself, not as a sync notice. */
  async addNotice(): Promise<void> {}
  async clearOutdated(): Promise<void> {}

  /** A new sync run may find the server updated: blocked ops become pending again. */
  async unblock(): Promise<void> {
    const blocked = (await this.entries()).filter((e) => e.state === 'blocked').map((e) => e.seq);
    if (blocked.length) await this.setState(blocked, 'pending');
  }

  /** Takes back ops the server has never seen. */
  unqueue(keys: string[]): Promise<string[]> {
    return this.rows.unqueue(this.connection, keys);
  }

  /** Clears a capture's ops for a retarget; false while one may have been applied. */
  release(capture: string): Promise<boolean> {
    return this.rows.release(this.connection, capture);
  }
}

/**
 * Sends the queue by the shared rules. A refusal meaning the server is older than this capture
 * shape (`isCompatibility`, outbox.ts) blocks the batch like `server_outdated`: kept intact.
 */
export function sendNativeQueue(
  queue: NativeSyncQueue,
  connection: Connection,
  adapters: PlatformAdapters,
  isCompatibility: (error: unknown) => boolean,
): Promise<'client_outdated' | 'server_outdated' | null> {
  const syncOps = async (body: SyncOpsRequest) => {
    try {
      return await adapters.transport.request<SyncOpsResponse>(connection, capturePaths.syncOps, {
        method: 'POST',
        body,
      });
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code !== 'client_outdated' &&
        error.code !== 'server_outdated' &&
        isCompatibility(error)
      ) {
        throw new ApiError(409, 'server_outdated', error.message, {
          ...(error.serverCode ? { serverCode: error.serverCode } : {}),
        });
      }
      throw error;
    }
  };
  return sendQueue(queue, syncOps, { clientVersion: KEPT_VERSION });
}
