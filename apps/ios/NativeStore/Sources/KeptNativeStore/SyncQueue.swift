import Foundation
import SQLite3

/// One queued `/sync/ops` operation. The JavaScript sync rules (apps/web/src/offline/queue.ts and
/// send-queue.ts, shared with the web app) decide what is sent and when. This table only keeps the
/// queue durably and refuses the changes those rules never make.
public struct SyncOpRow: Codable, Equatable {
    /// Queue order, never reused.
    public let seq: Int
    /// The capture whose replay queued it. Finishing the capture removes its rows.
    public let capture: String
    public let idempotencyKey: String
    public let state: String
    /// The queue item as JSON, frozen once queued.
    public let item: String
    /// The server's answer as JSON, once there is one.
    public let result: String?
}

public enum SyncOpState: String, CaseIterable {
    case pending, sent, blocked, applied
    case needsReview = "needs_review"
    case dropped

    /// The server has applied nothing of an op in these states, so it may still be taken back.
    static let unsent: Set<SyncOpState> = [.pending, .blocked]
    /// The server's answers.
    static let answered: Set<SyncOpState> = [.applied, .needsReview, .dropped]
}

extension Outbox {
    static let syncItemLimit = 65_536
    static let syncResultLimit = 16_384
    static let syncBatchLimit = 100

    func createSyncQueue() throws {
        try sql("""
            CREATE TABLE IF NOT EXISTS sync_ops (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                context TEXT NOT NULL,
                capture TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                state TEXT NOT NULL,
                item TEXT NOT NULL,
                result TEXT,
                UNIQUE (context, idempotency_key)
            )
            """)
        try sql("CREATE INDEX IF NOT EXISTS sync_ops_capture ON sync_ops (context, capture)")
    }

    /// Runs `body` in one SQLite transaction: all of it is stored, or none of it.
    func transaction<T>(_ body: () throws -> T) throws -> T {
        try sql("BEGIN IMMEDIATE")
        do {
            let value = try body()
            try sql("COMMIT")
            return value
        } catch {
            try? sql("ROLLBACK")
            throw error
        }
    }

    /// Queues a capture's ops in order and answers their rows. An op already queued under its
    /// idempotency key keeps its row, item and state: a replay never changes what may have been
    /// sent.
    public func enqueueSyncOps(
        context: String, capture: String, ops: [(idempotencyKey: String, item: String)]
    ) throws -> [SyncOpRow] {
        let capture = capture.lowercased()
        guard validContext(context), validCapture(capture),
              !ops.isEmpty, ops.count <= Self.syncBatchLimit,
              ops.allSatisfy({ validKey($0.idempotencyKey) && validItem($0.item) }),
              Set(ops.map(\.idempotencyKey)).count == ops.count
        else { throw OutboxError.invalid }
        return try transaction {
            var rows: [SyncOpRow] = []
            for op in ops {
                if let existing = try syncOp(context: context, key: op.idempotencyKey) {
                    // One key, one op: a key queued for another capture is a client bug.
                    guard existing.capture == capture else { throw OutboxError.invalid }
                    rows.append(existing)
                    continue
                }
                try sql("""
                    INSERT INTO sync_ops (context, capture, idempotency_key, state, item)
                    VALUES (?, ?, ?, 'pending', ?)
                    """, [context, capture, op.idempotencyKey, op.item])
                guard let inserted = try syncOp(context: context, key: op.idempotencyKey)
                else { throw OutboxError.storage }
                rows.append(inserted)
            }
            return rows
        }
    }

    /// Every queued op of this context, in queue order.
    public func syncOps(context: String) throws -> [SyncOpRow] {
        guard validContext(context) else { throw OutboxError.invalid }
        return try query(
            "SELECT \(Self.syncColumns) FROM sync_ops WHERE context = ? ORDER BY seq", [context],
            map: syncRow
        )
    }

    /// Moves ops between the unanswered states. Answers go through `settleSyncOp`.
    public func setSyncOpState(context: String, seqs: [Int], state: String) throws {
        guard validContext(context), let next = SyncOpState(rawValue: state),
              !SyncOpState.answered.contains(next),
              !seqs.isEmpty, seqs.count <= Self.syncBatchLimit
        else { throw OutboxError.invalid }
        try transaction {
            for seq in seqs {
                // An answered op stays answered: its result is the server's.
                try sql("""
                    UPDATE sync_ops SET state = ?
                    WHERE context = ? AND seq = CAST(? AS INTEGER)
                      AND state NOT IN ('applied', 'needs_review', 'dropped')
                    """, [next.rawValue, context, String(seq)])
            }
        }
    }

    /// Records the server's answer for the op under this key.
    public func settleSyncOp(context: String, idempotencyKey: String, state: String, result: String) throws {
        guard validContext(context), validKey(idempotencyKey),
              let answer = SyncOpState(rawValue: state), SyncOpState.answered.contains(answer),
              !result.isEmpty, result.utf8.count <= Self.syncResultLimit
        else { throw OutboxError.invalid }
        try sql("""
            UPDATE sync_ops SET state = ?, result = ? WHERE context = ? AND idempotency_key = ?
            """, [answer.rawValue, result, context, idempotencyKey])
    }

    /// Takes back ops the server has never seen (`pending` or `blocked`), and answers the keys
    /// removed. Sent and answered ops stay.
    public func unqueueSyncOps(context: String, idempotencyKeys: [String]) throws -> [String] {
        guard validContext(context), idempotencyKeys.count <= Self.syncBatchLimit,
              idempotencyKeys.allSatisfy(validKey)
        else { throw OutboxError.invalid }
        return try transaction {
            var removed: [String] = []
            for key in idempotencyKeys {
                guard let row = try syncOp(context: context, key: key),
                      let state = SyncOpState(rawValue: row.state), SyncOpState.unsent.contains(state)
                else { continue }
                try sql("DELETE FROM sync_ops WHERE seq = CAST(? AS INTEGER)", [String(row.seq)])
                removed.append(key)
            }
            return removed
        }
    }

    /// Clears a capture's ops before it is sent again under new keys (retargeting a dropped
    /// capture). Refused, changing nothing, while any of its ops is `sent` (the server may have
    /// applied it) or `applied`.
    public func releaseSyncOps(context: String, capture: String) throws -> Bool {
        let capture = capture.lowercased()
        guard validContext(context), validCapture(capture) else { throw OutboxError.invalid }
        return try transaction {
            let held = try query("""
                SELECT COUNT(*) FROM sync_ops
                WHERE context = ? AND capture = ? AND state IN ('sent', 'applied')
                """, [context, capture]) { row in Int(sqlite3_column_int64(row, 0)) }.first ?? 0
            guard held == 0 else { return false }
            try sql("DELETE FROM sync_ops WHERE context = ? AND capture = ?", [context, capture])
            return true
        }
    }

    private static let syncColumns = "seq, capture, idempotency_key, state, item, result"

    private func syncOp(context: String, key: String) throws -> SyncOpRow? {
        try query(
            "SELECT \(Self.syncColumns) FROM sync_ops WHERE context = ? AND idempotency_key = ?",
            [context, key], map: syncRow
        ).first
    }

    private func syncRow(_ row: OpaquePointer) throws -> SyncOpRow {
        SyncOpRow(
            seq: Int(sqlite3_column_int64(row, 0)),
            capture: try string(row, 1),
            idempotencyKey: try string(row, 2),
            state: try string(row, 3),
            item: try string(row, 4),
            result: optionalString(row, 5)
        )
    }

    private func validContext(_ context: String) -> Bool {
        !context.isEmpty && context.utf8.count <= 1024
    }

    private func validCapture(_ capture: String) -> Bool {
        UUID(uuidString: capture) != nil
    }

    private func validKey(_ key: String) -> Bool {
        !key.isEmpty && key.utf8.count <= 200
    }

    private func validItem(_ item: String) -> Bool {
        !item.isEmpty && item.utf8.count <= Self.syncItemLimit
    }
}
