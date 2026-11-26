import Foundation

public enum NiimbotError: String, Error {
    case busy, cancelled, bluetoothOff, bluetoothDenied, bluetoothUnavailable
    case unavailable, unsupportedPrinter, timeout, disconnected, rejected, invalidImage
}

struct NiimbotPacket: Equatable {
    let command: UInt8
    let payload: [UInt8]

    init(_ command: UInt8, _ payload: [UInt8]) {
        precondition(payload.count <= 255)
        self.command = command
        self.payload = payload
    }

    var encoded: Data {
        let body = [command, UInt8(payload.count)] + payload
        return Data([0x55, 0x55] + body + [body.reduce(0, ^), 0xAA, 0xAA])
    }
}

/// Notifications may split frames, concatenate them, or contain an echoed connection prefix.
struct NiimbotFrames {
    private var buffer: [UInt8] = []

    mutating func receive(_ bytes: Data) -> [NiimbotPacket] {
        guard bytes.count <= 4096 else {
            buffer.removeAll()
            return []
        }
        buffer.append(contentsOf: bytes)
        var result: [NiimbotPacket] = []
        var start = 0
        while buffer.count - start >= 2 {
            guard buffer[start] == 0x55, buffer[start + 1] == 0x55 else {
                start += 1
                continue
            }
            guard buffer.count - start >= 4 else { break }
            let length = Int(buffer[start + 3])
            let end = start + length + 7
            guard end <= buffer.count else { break }
            let crc = end - 3
            guard buffer[end - 2] == 0xAA, buffer[end - 1] == 0xAA,
                  buffer[(start + 2)..<crc].reduce(0, ^) == buffer[crc]
            else {
                start += 1
                continue
            }
            result.append(NiimbotPacket(buffer[start + 2], Array(buffer[(start + 4)..<crc])))
            start = end
        }
        if start > 0 { buffer.removeFirst(start) }
        return result
    }
}

public struct NiimbotPage {
    public static let maximumWidth = 567
    public static let maximumHeight = 591
    public static let maximumPages = 40
    public static let maximumCopies = 20

    let width: Int
    let height: Int
    let pixels: [UInt8]

    public init(width: Int, height: Int, bitmap: Data) throws {
        guard (1...Self.maximumWidth).contains(width), (1...Self.maximumHeight).contains(height),
              bitmap.count == ((width + 7) / 8) * height
        else { throw NiimbotError.invalidImage }
        let remainder = width % 8
        let bytes = Array(bitmap)
        if remainder != 0 {
            let rowBytes = (width + 7) / 8
            let unused = UInt8((1 << (8 - remainder)) - 1)
            guard stride(from: rowBytes - 1, to: bytes.count, by: rowBytes).allSatisfy({
                bytes[$0] & unused == 0
            }) else { throw NiimbotError.invalidImage }
        }
        self.width = width
        self.height = height
        pixels = bytes
    }

    func rowPackets() -> [NiimbotPacket] {
        let rowBytes = (width + 7) / 8
        var frames: [NiimbotPacket] = []
        var y = 0
        while y < height {
            let start = y * rowBytes
            let first = pixels[start..<(start + rowBytes)]
            var run = 1
            while y + run < height, run < 200 {
                let next = (y + run) * rowBytes
                guard first.elementsEqual(pixels[next..<(next + rowBytes)]) else { break }
                run += 1
            }
            let count = first.reduce(0) { $0 + $1.nonzeroBitCount }
            let index = NiimbotV4.u16(y)
            if count == 0 {
                frames.append(NiimbotPacket(0x84, index + [UInt8(run)]))
            } else {
                let dots = NiimbotV4.u16(count)
                frames.append(NiimbotPacket(0x85, index + [0, dots[1], dots[0], UInt8(run)] + first))
            }
            y += run
        }
        return frames
    }
}

public struct NiimbotIdentity: Equatable {
    public let modelId: Int
    public let protocolGeneration: Int?
    public let firmware: String?
    public let lidOpen: Bool?
    public let paperOut: Bool?
    public let rollRecognized: Bool?
    public let batteryPercent: Int?
}

public struct NiimbotPrintResult: Equatable {
    public enum State: String { case completed, cancelled, uncertain }
    public let state: State
    public let completed: Int
}

@MainActor
protocol NiimbotTransport: AnyObject {
    var lastReceivedRow: Int? { get set }
    func send(_ data: Data) async throws
    func request(_ packet: NiimbotPacket, response: UInt8, timeout: TimeInterval) async throws -> NiimbotPacket
}

@MainActor
struct NiimbotV4 {
    static let modelId = 4097
    let transport: NiimbotTransport

    nonisolated static func u16(_ value: Int) -> [UInt8] {
        [UInt8(value >> 8), UInt8(value & 255)]
    }

    private func request(_ command: UInt8, _ payload: [UInt8], _ response: UInt8,
                         timeout: TimeInterval = 2) async throws -> [UInt8] {
        try await transport.request(NiimbotPacket(command, payload), response: response, timeout: timeout).payload
    }

    /// Optional observations may be absent on a different firmware. Connection loss and
    /// cancellation still stop the operation.
    private func optional(_ command: UInt8, _ payload: [UInt8], _ response: UInt8) async throws -> [UInt8] {
        do { return try await request(command, payload, response, timeout: 0.8) }
        catch NiimbotError.timeout { return [] }
        catch NiimbotError.rejected { return [] }
    }

    func identify(details: Bool) async throws -> NiimbotIdentity {
        var greeting = Data([0x03])
        greeting.append(NiimbotPacket(0xC1, [1]).encoded)
        try await transport.send(greeting)
        try await Task.sleep(nanoseconds: 200_000_000)
        let printerStatus = try await optional(0xA5, [1], 0xB5)
        let model = try await request(0x40, [0x08], 0x48)
        guard model.count == 2, model[0] == 0x10, model[1] == 0x01 else {
            throw NiimbotError.unsupportedPrinter
        }
        let generation: Int? = printerStatus.count >= 13
            ? Self.generation(major: printerStatus[11], minor: printerStatus[12]) : nil
        let version = details ? try await optional(0x40, [0x09], 0x49) : []
        let firmware = version.count == 2 ? "\(version[0]).\(String(format: "%02d", version[1]))" : nil
        let heartbeat = details ? try await optional(0xDC, [4], 0xD9) : []
        let status = heartbeat.count == 13 ? heartbeat : nil
        let battery = details ? try await optional(0x40, [0x0A], 0x4A) : []
        let charge = battery.count == 1 && battery[0] <= 100 ? Int(battery[0]) : nil
        return NiimbotIdentity(
            modelId: Self.modelId, protocolGeneration: generation, firmware: firmware,
            lidOpen: status.flatMap { $0[4] <= 1 ? $0[4] == 1 : nil },
            paperOut: status.flatMap { $0[5] <= 1 ? $0[5] == 1 : nil },
            rollRecognized: status.flatMap { $0[6] <= 1 ? $0[6] == 1 : nil },
            batteryPercent: charge
        )
    }

    private static func generation(major: UInt8, minor: UInt8) -> Int? {
        switch Int(major) * 100 + Int(minor) {
        case 204...299: return 3
        case 300...301: return 4
        case 302...: return 5
        default: return nil
        }
    }

    func print(pages: [NiimbotPage], copies: Int, density: Int) async throws -> NiimbotPrintResult {
        guard (1...NiimbotPage.maximumPages).contains(pages.count),
              (1...NiimbotPage.maximumCopies).contains(copies),
              (1...5).contains(density)
        else { throw NiimbotError.invalidImage }

        var started = false
        var completed = 0
        do {
            _ = try await identify(details: false)
            _ = try await request(0x21, [UInt8(density)], 0x31)
            _ = try await request(0x23, [1], 0x33) // Gap stock.
            started = true
            _ = try await request(0x01, Self.u16(pages.count * copies) + [0, 0, 0, 0, 0, 1, 0], 0x02)
            for (index, page) in pages.enumerated() {
                transport.lastReceivedRow = nil
                // This advisory query opens the V4 page. Its response is independent of the
                // completion polls, which occur after the page acknowledgement.
                try await transport.send(NiimbotPacket(0xA3, [1]).encoded)
                try await Task.sleep(nanoseconds: 30_000_000)
                let size = Self.u16(page.height) + Self.u16(page.width) + Self.u16(copies)
                _ = try await request(0x13, size + Array(repeating: 0, count: 7), 0x14)
                for row in page.rowPackets() {
                    try await transport.send(row.encoded)
                }
                guard try await request(0xE3, [1], 0xE4, timeout: 10) == [1]
                else { throw NiimbotError.rejected }
                if let last = transport.lastReceivedRow, last != page.height - 1 {
                    throw NiimbotError.rejected
                }
                completed = try await awaitPage((index + 1) * copies, completed: completed, copies: copies)
            }
        } catch {
            if started {
                // PrintEnd feeds the paper out. Never retry a job automatically after a
                // command that may have produced a label.
                _ = try? await request(0xF3, [1], 0xF4)
                return NiimbotPrintResult(state: .uncertain, completed: completed)
            }
            if error is CancellationError || (error as? NiimbotError) == .cancelled {
                return NiimbotPrintResult(state: .cancelled, completed: 0)
            }
            throw error
        }
        do {
            guard try await request(0xF3, [1], 0xF4) == [1]
            else { throw NiimbotError.rejected }
            return NiimbotPrintResult(state: .completed, completed: completed)
        } catch {
            return NiimbotPrintResult(state: .uncertain, completed: completed)
        }
    }

    private func awaitPage(_ target: Int, completed: Int, copies: Int) async throws -> Int {
        // Multiple copies upload one image. Give the feed time for the selected quantity.
        let deadline = ProcessInfo.processInfo.systemUptime + 25 + Double(copies - 1) * 4
        while ProcessInfo.processInfo.systemUptime < deadline {
            let status = try await optional(0xA3, [1], 0xB3)
            if status.count >= 4 {
                let page = (Int(status[0]) << 8) | Int(status[1])
                guard page >= completed, page <= target else { throw NiimbotError.rejected }
                if page == target { return page }
            }
            try await Task.sleep(nanoseconds: 150_000_000)
        }
        throw NiimbotError.timeout
    }
}
