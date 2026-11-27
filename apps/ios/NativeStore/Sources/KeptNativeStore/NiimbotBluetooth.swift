#if os(iOS)
import CoreBluetooth
import Foundation

public struct NiimbotDevice {
    public let id: UUID
    public let name: String
}

/// Owns one foreground BLE operation at a time. Only an explicit choice is connected.
@MainActor
public final class NiimbotBluetooth {
    private var active: BluetoothLink?

    public init() {}

    public func discover(showOtherDevices: Bool) async throws -> [NiimbotDevice] {
        try await useLink { link in
            try await link.discover(showOtherDevices: showOtherDevices)
        }
    }

    public func identify(_ id: UUID) async throws -> NiimbotIdentity {
        try await useLink { link in
            try await link.connect(id)
            return try await NiimbotV4(transport: link).identify(details: true)
        }
    }

    public func print(_ id: UUID, pages: [NiimbotPage], copies: Int, density: Int) async throws -> NiimbotPrintResult {
        do {
            return try await useLink { link in
                try await link.connect(id)
                return try await NiimbotV4(transport: link).print(pages: pages, copies: copies, density: density)
            }
        } catch NiimbotError.cancelled {
            return NiimbotPrintResult(state: .cancelled, completed: 0)
        }
    }

    public func cancel() { active?.cancel() }

    private func useLink<T>(_ action: (BluetoothLink) async throws -> T) async throws -> T {
        guard active == nil else { throw NiimbotError.busy }
        let link = BluetoothLink()
        active = link
        defer {
            link.close()
            active = nil
        }
        return try await action(link)
    }
}

@MainActor
private final class BluetoothLink: NSObject, @preconcurrency CBCentralManagerDelegate,
    @preconcurrency CBPeripheralDelegate, NiimbotTransport {
    // CoreBluetooth delivers both delegates on the central manager's main queue.
    private let serviceID = CBUUID(string: "E7810A71-73AE-499D-8C15-FAA9AEF0C3F2")
    private let characteristicID = CBUUID(string: "BEF8D6C9-9C21-4C9E-B632-BD58C1009F9F")
    private lazy var central = CBCentralManager(delegate: self, queue: .main,
        options: [CBCentralManagerOptionShowPowerAlertKey: false])
    private var selected: CBPeripheral?
    private var channel: CBCharacteristic?
    private var devices: [UUID: NiimbotDevice] = [:]
    private var scanningFor: UUID?
    private var includeOtherDevices = false
    private var failure: NiimbotError?
    private var cancelled = false
    private var frames = NiimbotFrames()
    private var wanted: UInt8?
    private var reply: NiimbotPacket?
    private var refused = false
    var lastReceivedRow: Int?

    func discover(showOtherDevices: Bool) async throws -> [NiimbotDevice] {
        try await ready()
        includeOtherDevices = showOtherDevices
        // B1 Pro can omit the service UUID from its advertising packets.
        central.scanForPeripherals(withServices: nil)
        defer { central.stopScan() }
        let end = ProcessInfo.processInfo.systemUptime + 4
        while ProcessInfo.processInfo.systemUptime < end {
            try check()
            try await pause()
        }
        return devices.values.sorted {
            let firstIsPrinter = Self.printerName($0.name)
            let secondIsPrinter = Self.printerName($1.name)
            if firstIsPrinter != secondIsPrinter { return firstIsPrinter }
            return $0.name < $1.name
        }
    }

    func connect(_ id: UUID) async throws {
        try await ready()
        selected = central.retrievePeripherals(withIdentifiers: [id]).first
        if selected == nil {
            scanningFor = id
            central.scanForPeripherals(withServices: nil)
            defer {
                central.stopScan()
                scanningFor = nil
            }
            try await wait(5, error: .unavailable) { selected != nil }
        }
        guard let printer = selected else { throw NiimbotError.unavailable }
        printer.delegate = self
        central.connect(printer)
        try await wait(9, error: .unavailable) { channel?.isNotifying == true }
    }

    func request(_ packet: NiimbotPacket, response: UInt8, timeout: TimeInterval) async throws -> NiimbotPacket {
        guard wanted == nil else { throw NiimbotError.busy }
        wanted = response
        reply = nil
        refused = false
        defer {
            wanted = nil
            reply = nil
            refused = false
        }
        try await send(packet.encoded)
        try await wait(timeout) { reply != nil || refused }
        guard let reply else { throw NiimbotError.rejected }
        return reply
    }

    func send(_ data: Data) async throws {
        try check()
        guard let printer = selected, let channel, printer.state == .connected, channel.isNotifying
        else { throw NiimbotError.disconnected }
        // Keep each protocol frame intact and give the printer one frame per BLE write.
        guard data.count <= printer.maximumWriteValueLength(for: .withoutResponse)
        else { throw NiimbotError.unsupportedPrinter }
        try await wait(4) { printer.canSendWriteWithoutResponse }
        try check()
        printer.writeValue(data, for: channel, type: .withoutResponse)
        if data.count > 2 && (data[2] == 0x84 || data[2] == 0x85) {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    private func ready() async throws {
        _ = central
        try await wait(30) { central.state == .poweredOn }
    }

    private func pause() async throws {
        try await Task.sleep(nanoseconds: 10_000_000)
    }

    private func wait(
        _ seconds: TimeInterval, error: NiimbotError = .timeout, until predicate: () -> Bool
    ) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + seconds
        repeat {
            try check()
            if predicate() { return }
            try await pause()
        } while ProcessInfo.processInfo.systemUptime < deadline
        try check()
        throw error
    }

    private func check() throws {
        try Task.checkCancellation()
        if cancelled { throw NiimbotError.cancelled }
        if let failure { throw failure }
        switch central.state {
        case .unauthorized: throw NiimbotError.bluetoothDenied
        case .poweredOff: throw NiimbotError.bluetoothOff
        case .unsupported: throw NiimbotError.bluetoothUnavailable
        default: break
        }
    }

    func cancel() {
        cancelled = true
        close()
    }

    func close() {
        if central.state == .poweredOn { central.stopScan() }
        if let printer = selected {
            printer.delegate = nil
            if central.state == .poweredOn { central.cancelPeripheralConnection(printer) }
        }
        selected = nil
        channel = nil
        central.delegate = nil
    }

    private static func printerName(_ name: String) -> Bool {
        let upper = name.uppercased()
        return upper.hasPrefix("B1") || upper.contains("NIIMBOT")
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {}

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        if let id = scanningFor {
            if peripheral.identifier == id { selected = peripheral }
            return
        }
        let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        // A service match is also a useful hint on firmware that advertises the service.
        let services = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
        guard let name, !name.isEmpty, devices.count < 50,
              includeOtherDevices || Self.printerName(name) || services.contains(serviceID)
        else { return }
        devices[peripheral.identifier] = NiimbotDevice(id: peripheral.identifier, name: String(name.prefix(100)))
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral === selected else { return }
        peripheral.discoverServices([serviceID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        if peripheral === selected { failure = .unavailable }
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        if peripheral === selected { failure = .disconnected }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard peripheral === selected else { return }
        guard error == nil, let service = peripheral.services?.first(where: { $0.uuid == serviceID })
        else {
            failure = .unsupportedPrinter
            return
        }
        peripheral.discoverCharacteristics([characteristicID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard peripheral === selected else { return }
        guard error == nil, let characteristic = service.characteristics?.first(where: { $0.uuid == characteristicID }),
              characteristic.properties.contains(.writeWithoutResponse),
              characteristic.properties.contains(.notify) || characteristic.properties.contains(.indicate)
        else {
            failure = .unsupportedPrinter
            return
        }
        channel = characteristic
        peripheral.setNotifyValue(true, for: characteristic)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        if peripheral === selected, characteristic === channel, error != nil || !characteristic.isNotifying {
            failure = .disconnected
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral === selected, characteristic === channel else { return }
        guard error == nil, let data = characteristic.value else {
            failure = .disconnected
            return
        }
        for frame in frames.receive(data) {
            if frame.command == 0xD3, frame.payload.count >= 2 {
                let row = (Int(frame.payload[0]) << 8) | Int(frame.payload[1])
                lastReceivedRow = max(lastReceivedRow ?? row, row)
            } else if frame.command == wanted, reply == nil {
                reply = frame
            } else if wanted != nil, frame.command == 0x00 || frame.command == 0xDB {
                refused = true
            }
        }
    }
}
#endif
