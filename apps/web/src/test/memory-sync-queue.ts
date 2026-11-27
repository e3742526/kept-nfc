// The iPhone app's SQLite sync queue (apps/ios/NativeStore/Sources/KeptNativeStore/SyncQueue.swift)
// in memory, for tests: the same rules, kept in step with SyncQueueTests.swift. A key queued once
// keeps its item and state; answers are final; only pending and blocked ops can be taken back; a
// capture's ops are released only while none is sent or applied; finishing a capture removes them.
import type { PlatformSyncQueue } from '@/native/adapters';
import type { SyncOpRow } from '@/native/bridge';

const ANSWERED = new Set(['applied', 'needs_review', 'dropped']);
const UNSENT = new Set(['pending', 'blocked']);

export function memorySyncQueue() {
  // Rows of every context, like the one SQLite table; each call sees its own context's.
  const all = new Map<string, SyncOpRow[]>();
  let next = 1;
  const rowsOf = (context: string) => {
    const rows = all.get(context) ?? [];
    all.set(context, rows);
    return rows;
  };
  const copy = (row: SyncOpRow): SyncOpRow => ({ ...row });

  const queue: PlatformSyncQueue = {
    async enqueue(conn, capture, ops) {
      const rows = rowsOf(conn.id);
      const byKey = (key: string) => rows.find((row) => row.idempotencyKey === key);
      const id = capture.toLowerCase();
      if (new Set(ops.map((op) => op.idempotencyKey)).size !== ops.length)
        throw new Error('invalid');
      const out: SyncOpRow[] = [];
      for (const op of ops) {
        const existing = byKey(op.idempotencyKey);
        if (existing) {
          if (existing.capture !== id) throw new Error('invalid');
          out.push(copy(existing));
          continue;
        }
        const row: SyncOpRow = {
          seq: next++,
          capture: id,
          idempotencyKey: op.idempotencyKey,
          state: 'pending',
          item: op.item,
        };
        rows.push(row);
        out.push(copy(row));
      }
      return out;
    },
    async list(conn) {
      return rowsOf(conn.id).map(copy);
    },
    async setState(conn, seqs, state) {
      if (ANSWERED.has(state)) throw new Error('invalid');
      for (const row of rowsOf(conn.id)) {
        if (seqs.includes(row.seq) && !ANSWERED.has(row.state)) row.state = state;
      }
    },
    async settle(conn, key, state, result) {
      if (!ANSWERED.has(state)) throw new Error('invalid');
      const row = rowsOf(conn.id).find((r) => r.idempotencyKey === key);
      if (row) Object.assign(row, { state, result });
    },
    async unqueue(conn, keys) {
      const rows = rowsOf(conn.id);
      const removed: string[] = [];
      for (const key of keys) {
        const row = rows.find((r) => r.idempotencyKey === key);
        if (!row || !UNSENT.has(row.state)) continue;
        rows.splice(rows.indexOf(row), 1);
        removed.push(key);
      }
      return removed;
    },
    async release(conn, capture) {
      const rows = rowsOf(conn.id);
      const id = capture.toLowerCase();
      const mine = rows.filter((row) => row.capture === id);
      if (mine.some((row) => row.state === 'sent' || row.state === 'applied')) return false;
      for (const row of mine) rows.splice(rows.indexOf(row), 1);
      return true;
    },
  };

  /** What `complete` and `discard` do to the queue in SQLite. */
  const finish = (context: string, capture: string) => {
    const rows = rowsOf(context);
    const id = capture.toLowerCase();
    for (const row of rows.filter((r) => r.capture === id)) rows.splice(rows.indexOf(row), 1);
  };

  return { queue, rowsOf, finish };
}
