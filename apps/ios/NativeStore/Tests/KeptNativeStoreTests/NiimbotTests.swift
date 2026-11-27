import Foundation
import XCTest
@testable import KeptNativeStore

final class NiimbotTests: XCTestCase {
    func testFramingChecksChecksumAndCombinesSplitNotifications() {
        let model = NiimbotPacket(0x48, [0x10, 0x01])
        XCTAssertEqual(model.encoded, Data([0x55, 0x55, 0x48, 2, 0x10, 1, 0x5B, 0xAA, 0xAA]))
        let end = NiimbotPacket(0xF4, [1])
        var broken = model.encoded
        broken[6] ^= 1
        var decoder = NiimbotFrames()
        XCTAssertEqual(decoder.receive(Data([0x03]) + broken + model.encoded.prefix(4)), [])
        XCTAssertEqual(decoder.receive(model.encoded.dropFirst(4) + end.encoded), [model, end])
    }

    func testRowPackingAndBounds() throws {
        let page = try NiimbotPage(width: 9, height: 4, bitmap: Data([0, 0, 0, 0, 0x80, 0x80, 0x80, 0x80]))
        XCTAssertEqual(page.rowPackets(), [
            NiimbotPacket(0x84, [0, 0, 2]),
            NiimbotPacket(0x85, [0, 2, 0, 2, 0, 2, 0x80, 0x80]),
        ])
        let blank = try NiimbotPage(width: 1, height: 201, bitmap: Data(repeating: 0, count: 201))
        XCTAssertEqual(blank.rowPackets(), [
            NiimbotPacket(0x84, [0, 0, 200]),
            NiimbotPacket(0x84, [0, 200, 1]),
        ])
        XCTAssertThrowsError(try NiimbotPage(width: 568, height: 1, bitmap: Data()))
        XCTAssertThrowsError(try NiimbotPage(width: 9, height: 1, bitmap: Data([0x80, 0x01])))
    }

    @MainActor
    func testStandardB1CannotStartAV4Print() async throws {
        let link = PrinterFixture()
        link.model = [0x10, 0x00]
        do {
            _ = try await NiimbotV4(transport: link).print(pages: [page()], copies: 1, density: 3)
            XCTFail("A B1 must be rejected")
        } catch let error as NiimbotError {
            XCTAssertEqual(error, .unsupportedPrinter)
        }
        XCTAssertEqual(link.requests.map(\.command), [0xA5, 0x40])
    }

    @MainActor
    func testCopiesAndDifferentPagesWaitForPrinterCounterBeforeEnding() async throws {
        let link = PrinterFixture()
        link.pageCounts = [0, 2, 4]
        let result = try await NiimbotV4(transport: link).print(pages: [page(), page()], copies: 2, density: 4)
        XCTAssertEqual(result, NiimbotPrintResult(state: .completed, completed: 4))
        XCTAssertEqual(link.requests.map(\.command), [
            0xA5, 0x40, 0x21, 0x23, 0x01, 0x13, 0xE3, 0xA3, 0xA3, 0x13, 0xE3, 0xA3, 0xF3,
        ])
        XCTAssertEqual(link.requests.first { $0.command == 0x01 }?.payload, [0, 4, 0, 0, 0, 0, 0, 1, 0])
        XCTAssertEqual(link.requests.first { $0.command == 0x13 }?.payload, [0, 1, 0, 8, 0, 2, 0, 0, 0, 0, 0, 0, 0])
        XCTAssertEqual(link.writes.first, Data([0x03, 0x55, 0x55, 0xC1, 1, 1, 0xC1, 0xAA, 0xAA]))
    }

    @MainActor
    func testMissingAcknowledgementAfterStartIsUncertainAndDoesNotRetry() async throws {
        let link = PrinterFixture()
        link.failCommand = 0xE3
        let result = try await NiimbotV4(transport: link).print(pages: [page()], copies: 1, density: 3)
        XCTAssertEqual(result, NiimbotPrintResult(state: .uncertain, completed: 0))
        XCTAssertEqual(link.requests.filter { $0.command == 0xE3 }.count, 1)
        XCTAssertEqual(link.requests.last?.command, 0xF3)
    }

    @MainActor
    func testEndRefusalReportsUncertaintyEvenWhenPageCounterReachedTarget() async throws {
        let link = PrinterFixture()
        link.pageCounts = [1]
        link.refuseEnd = true
        let result = try await NiimbotV4(transport: link).print(pages: [page()], copies: 1, density: 3)
        XCTAssertEqual(result, NiimbotPrintResult(state: .uncertain, completed: 1))
    }

    @MainActor
    func testCancellationDuringSecondPageKeepsFirstPageCount() async throws {
        let link = PrinterFixture()
        link.pageCounts = [1]
        link.cancelSecondPage = true
        let result = try await NiimbotV4(transport: link).print(pages: [page(), page()], copies: 1, density: 3)
        XCTAssertEqual(result, NiimbotPrintResult(state: .uncertain, completed: 1))
    }

    @MainActor
    func testStatusWithDifferentHeartbeatLayoutStaysUnknown() async throws {
        let link = PrinterFixture()
        link.heartbeat = [0, 0, 100, 0, 1, 1]
        let identity = try await NiimbotV4(transport: link).identify(details: true)
        XCTAssertEqual(identity.modelId, 4097)
        XCTAssertNil(identity.lidOpen)
        XCTAssertNil(identity.paperOut)
        XCTAssertNil(identity.rollRecognized)
    }

    private func page() throws -> NiimbotPage {
        try NiimbotPage(width: 8, height: 1, bitmap: Data([0x80]))
    }
}

@MainActor
private final class PrinterFixture: NiimbotTransport {
    var model: [UInt8] = [0x10, 0x01]
    var heartbeat: [UInt8] = []
    var requests: [NiimbotPacket] = []
    var writes: [Data] = []
    var pageCounts: [UInt8] = []
    var lastReceivedRow: Int?
    var failCommand: UInt8?
    var cancelSecondPage = false
    var refuseEnd = false

    func send(_ data: Data) async throws { writes.append(data) }

    func request(_ packet: NiimbotPacket, response: UInt8, timeout: TimeInterval) async throws -> NiimbotPacket {
        requests.append(packet)
        if packet.command == failCommand { throw NiimbotError.timeout }
        switch (packet.command, packet.payload) {
        case (0x40, [8]): return NiimbotPacket(response, model)
        case (0xF3, _) where refuseEnd: return NiimbotPacket(response, [0])
        case (0xDC, _): return NiimbotPacket(response, heartbeat)
        case (0xA3, _): return NiimbotPacket(response, [0, pageCounts.removeFirst(), 100, 100])
        case (0xE3, _) where cancelSecondPage && requests.filter({ $0.command == 0xE3 }).count == 2:
            throw NiimbotError.cancelled
        default: return NiimbotPacket(response, [1])
        }
    }
}
