import Foundation
import XCTest
@testable import KeptNativeStore

final class SyncQueueTests: XCTestCase {
    private let context = "https://kept.example.com|account|epoch"

    private func outbox() throws -> (Outbox, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return (try Outbox(root: root), root)
    }

    private func capture() -> String { UUID().uuidString.lowercased() }

    func testQueuesInOrderAndKeepsTheFirstItemForAKey() throws {
        let (store, _) = try outbox()
        let first = capture()
        let second = capture()
        let rows = try store.enqueueSyncOps(context: context, capture: first, ops: [
            ("a", #"{"op":"create_thing","n":1}"#), ("b", #"{"op":"create_thing","n":2}"#),
        ])
        XCTAssertEqual(rows.map(\.idempotencyKey), ["a", "b"])
        XCTAssertEqual(rows.map(\.state), ["pending", "pending"])
        _ = try store.enqueueSyncOps(context: context, capture: second, ops: [("c", #"{"n":3}"#)])

        // A replay builds the item again; the queued one is what may have been sent.
        let again = try store.enqueueSyncOps(context: context, capture: first, ops: [("a", #"{"changed":true}"#)])
        XCTAssertEqual(again.first?.item, #"{"op":"create_thing","n":1}"#)
        XCTAssertEqual(again.first?.seq, rows.first?.seq)

        let all = try store.syncOps(context: context)
        XCTAssertEqual(all.map(\.idempotencyKey), ["a", "b", "c"])
        XCTAssertEqual(all.map(\.seq), all.map(\.seq).sorted())
        XCTAssertEqual(try store.syncOps(context: "https://other.example.com|account|epoch"), [])
    }

    func testRefusesAKeyQueuedForAnotherCapture() throws {
        let (store, _) = try outbox()
        _ = try store.enqueueSyncOps(context: context, capture: capture(), ops: [("a", "{}")])
        XCTAssertThrowsError(try store.enqueueSyncOps(context: context, capture: capture(), ops: [("a", "{}")]))
        XCTAssertThrowsError(try store.enqueueSyncOps(context: context, capture: capture(), ops: [("x", "{}"), ("x", "{}")]))
        XCTAssertThrowsError(try store.enqueueSyncOps(context: context, capture: "not-a-uuid", ops: [("y", "{}")]))
    }

    func testAnswersAreFinalAndOnlyUnsentOpsAreTakenBack() throws {
        let (store, _) = try outbox()
        let id = capture()
        let rows = try store.enqueueSyncOps(context: context, capture: id, ops: [
            ("sent", "{}"), ("applied", "{}"), ("waiting", "{}"),
        ])
        try store.setSyncOpState(context: context, seqs: rows.prefix(2).map(\.seq), state: "sent")
        try store.settleSyncOp(context: context, idempotencyKey: "applied", state: "applied",
                               result: #"{"outcome":"applied"}"#)
        // An answered op can't be put back into the queue's unanswered states.
        try store.setSyncOpState(context: context, seqs: [rows[1].seq], state: "pending")
        XCTAssertThrowsError(try store.setSyncOpState(context: context, seqs: [rows[0].seq], state: "applied"))
        XCTAssertThrowsError(try store.settleSyncOp(context: context, idempotencyKey: "sent", state: "sent", result: "{}"))

        let removed = try store.unqueueSyncOps(context: context, idempotencyKeys: ["sent", "applied", "waiting"])
        XCTAssertEqual(removed, ["waiting"])
        let left = try store.syncOps(context: context)
        XCTAssertEqual(left.map(\.idempotencyKey), ["sent", "applied"])
        XCTAssertEqual(left.map(\.state), ["sent", "applied"])
        XCTAssertEqual(left[1].result, #"{"outcome":"applied"}"#)
    }

    func testReleaseIsRefusedWhileAnOpMayHaveBeenApplied() throws {
        let (store, _) = try outbox()
        let id = capture()
        let rows = try store.enqueueSyncOps(context: context, capture: id, ops: [("k", "{}")])
        try store.setSyncOpState(context: context, seqs: [rows[0].seq], state: "sent")
        XCTAssertFalse(try store.releaseSyncOps(context: context, capture: id))
        XCTAssertEqual(try store.syncOps(context: context).count, 1)

        try store.settleSyncOp(context: context, idempotencyKey: "k", state: "dropped",
                               result: #"{"outcome":"dropped","reason":"target_trashed"}"#)
        XCTAssertTrue(try store.releaseSyncOps(context: context, capture: id))
        XCTAssertEqual(try store.syncOps(context: context), [])
    }

    func testQueueSurvivesReopeningAndFinishingACaptureRemovesItsOps() throws {
        let (store, root) = try outbox()
        let kept = capture()
        let done = capture()
        _ = try store.enqueueSyncOps(context: context, capture: kept, ops: [("kept", "{}")])
        _ = try store.enqueueSyncOps(context: context, capture: done, ops: [("done", "{}")])

        let reopened = try Outbox(root: root)
        XCTAssertEqual(try reopened.syncOps(context: context).map(\.idempotencyKey), ["kept", "done"])
        try reopened.complete(context: context, id: done)
        try reopened.discard(context: context, id: kept)
        XCTAssertEqual(try reopened.syncOps(context: context), [])
        XCTAssertEqual(try reopened.completions(context: context), [done: .synced, kept: .discarded])
    }

    func testSeqIsNeverReusedAfterOpsLeave() throws {
        let (store, _) = try outbox()
        let id = capture()
        let first = try store.enqueueSyncOps(context: context, capture: id, ops: [("one", "{}")])
        _ = try store.unqueueSyncOps(context: context, idempotencyKeys: ["one"])
        let second = try store.enqueueSyncOps(context: context, capture: id, ops: [("two", "{}")])
        XCTAssertGreaterThan(second[0].seq, first[0].seq)
    }
}
