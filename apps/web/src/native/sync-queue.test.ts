import { KEPT_VERSION, newId, type QueueItem, type SyncOpsRequest } from '@kept/shared';
import { describe, expect, it, vi } from 'vitest';
import { capturePaths } from '@/api/capture/paths';
import { ApiError } from '@/api/client';
import { memorySyncQueue } from '@/test/memory-sync-queue';
import { capacitorAdapters, type PlatformAdapters } from './adapters';
import type { Connection } from './bridge';
import { isCompatibilityFailure } from './outbox';
import { NativeSyncQueue, sendNativeQueue } from './sync-queue';

const connection: Connection = {
  id: 'https://kept.example.com|user-1|epoch-1',
  origin: 'https://kept.example.com',
  account: 'user-1',
  epoch: 'epoch-1',
};

function item(key: string, name = 'Drill'): QueueItem {
  const id = newId();
  return {
    clientVersion: KEPT_VERSION,
    payloadVersion: 1,
    clientId: id,
    idempotencyKey: key,
    op: 'tag_things',
    takenAt: '2026-11-27T12:00:00.000Z',
    locationId: newId(),
    payload: { thingIds: [id], add: [newId()], name },
  };
}

function setup(send: (body: SyncOpsRequest) => unknown) {
  const memory = memorySyncQueue();
  const request = vi.fn(async (_conn: Connection, path: string, options?: { body?: unknown }) => {
    if (path !== capturePaths.syncOps) throw new Error(`unexpected ${path}`);
    return send(options?.body as SyncOpsRequest);
  });
  const adapters: PlatformAdapters = {
    ...capacitorAdapters,
    transport: { ...capacitorAdapters.transport, request: request as never },
    outbox: { ...capacitorAdapters.outbox, syncQueue: memory.queue },
  };
  const queue = new NativeSyncQueue(connection, adapters);
  const run = () => sendNativeQueue(queue, connection, adapters, isCompatibilityFailure);
  return { queue, request, run, memory };
}

const applied = (body: SyncOpsRequest) => ({
  results: body.ops.map((op) => ({
    clientId: op.clientId,
    idempotencyKey: op.idempotencyKey,
    outcome: 'applied',
  })),
});

describe('the iPhone sync queue', () => {
  it('keeps the first item queued under a key, whatever a replay builds', async () => {
    const { queue } = setup(applied);
    const capture = newId();
    const first = item('tags:one', 'Drill');
    await queue.enqueue(capture, [first]);
    const [again] = await queue.enqueue(capture, [{ ...item('tags:one', 'Changed') }]);
    expect(again).toMatchObject({ ...first, state: 'pending' });
  });

  it('sends in queue order and never sends an answered op again', async () => {
    const { queue, request, run } = setup(applied);
    await queue.enqueue(newId(), [item('k-one-1'), item('k-two-2')]);
    await queue.enqueue(newId(), [item('k-three')]);
    expect(await run()).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    const body = request.mock.calls[0]?.[2]?.body as SyncOpsRequest;
    expect(body.ops.map((op) => op.idempotencyKey)).toEqual(['k-one-1', 'k-two-2', 'k-three']);
    expect((await queue.entries()).map((e) => e.state)).toEqual(['applied', 'applied', 'applied']);
    expect(await run()).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('resends a sent op unchanged when no answer came, and it stays sent meanwhile', async () => {
    let online = false;
    const { queue, request, run } = setup((body) => {
      if (!online) throw new ApiError(0, 'offline', 'No connection');
      return applied(body);
    });
    const capture = newId();
    await queue.enqueue(capture, [item('lost-answer')]);
    await expect(run()).rejects.toMatchObject({ status: 0 });
    expect((await queue.entries())[0]?.state).toBe('sent');
    // A sent op may have been applied: it can't be taken back or released for a retarget.
    expect(await queue.unqueue(['lost-answer'])).toEqual([]);
    expect(await queue.release(capture)).toBe(false);
    online = true;
    expect(await run()).toBeNull();
    const [lost, resent] = request.mock.calls.map(
      ([, , options]) => (options?.body as SyncOpsRequest | undefined)?.ops[0],
    );
    expect(resent).toEqual(lost);
  });

  it('blocks and keeps the queue on an outdated refusal, then sends it on a later run', async () => {
    let refuse = true;
    const { queue, run } = setup((body) => {
      if (refuse) throw new ApiError(409, 'client_outdated', 'Update the app');
      return applied(body);
    });
    await queue.enqueue(newId(), [item('held-op-1')]);
    expect(await run()).toBe('client_outdated');
    expect((await queue.entries())[0]?.state).toBe('blocked');
    refuse = false;
    // Still blocked until a new run unblocks it.
    expect(await run()).toBe('client_outdated');
    await queue.unblock();
    expect(await run()).toBeNull();
    expect((await queue.entries())[0]?.state).toBe('applied');
  });

  it('holds, never drops, an op an older server rejects for its newer shape', async () => {
    const { queue, run } = setup(() => {
      throw new ApiError(400, 'validation', 'Unrecognized key: "reviewSuggestions"');
    });
    await queue.enqueue(newId(), [item('newer-shape')]);
    expect(await run()).toBe('server_outdated');
    expect((await queue.entries())[0]).toMatchObject({ state: 'blocked' });
  });

  it('drops only the op the server cannot parse, and sends the rest', async () => {
    const { queue, run } = setup((body) => {
      if (body.ops.some((op) => op.idempotencyKey === 'broken-op'))
        throw new ApiError(400, 'validation', 'Bad op');
      return applied(body);
    });
    await queue.enqueue(newId(), [item('good-op-1'), item('broken-op'), item('good-op-2')]);
    expect(await run()).toBeNull();
    const states = Object.fromEntries((await queue.entries()).map((e) => [e.idempotencyKey, e]));
    expect(states['good-op-1']?.state).toBe('applied');
    expect(states['broken-op']).toMatchObject({
      state: 'dropped',
      result: { outcome: 'dropped', reason: 'invalid' },
    });
    expect(states['good-op-2']?.state).toBe('applied');
  });

  it('puts unanswered ops back after a partial answer and sends them again', async () => {
    let partial = true;
    const { queue, run } = setup((body) => {
      if (partial) {
        partial = false;
        return { results: applied(body).results.slice(0, 1) };
      }
      return applied(body);
    });
    await queue.enqueue(newId(), [item('part-one'), item('part-two')]);
    await expect(run()).rejects.toMatchObject({ status: 500 });
    expect((await queue.entries()).map((e) => e.state)).toEqual(['applied', 'pending']);
    expect(await run()).toBeNull();
    expect((await queue.entries()).map((e) => e.state)).toEqual(['applied', 'applied']);
  });

  it('drops a child whose parent was dropped on this phone without sending it', async () => {
    const { queue, request, run } = setup((body) => ({
      results: body.ops.map((op) => ({
        clientId: op.clientId,
        idempotencyKey: op.idempotencyKey,
        outcome: 'dropped',
        reason: 'target_trashed',
      })),
    }));
    await queue.enqueue(newId(), [item('parent-op')]);
    expect(await run()).toBeNull();
    await queue.enqueue(newId(), [{ ...item('child-op'), dependsOn: ['parent-op'] }]);
    expect(await run()).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect((await queue.entries())[1]).toMatchObject({
      state: 'dropped',
      result: { reason: 'parent_dropped' },
    });
  });
});
