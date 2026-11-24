import CryptoKit
import Foundation

public enum NFCLabelValidationResult: Equatable {
    case approved(code: String)
    case foreign
    case malformed
}

/// Validates SheepKeep label URLs (NDEF tags, label sheets) against the configured server origin
/// and the server's own label address, without silently switching servers. A label is
/// `/l/<short ID>` or `/l/<numbered alias>` (`BIN-A09Z-0001`); `approved(code:)` carries the
/// short ID folded onto Crockford base32, or the alias in upper case (base36: nothing folded).
public struct NFCLabelValidation {
    private static let shortCodePattern = try! NSRegularExpression(pattern: "^[0-9A-HJKMNP-TV-Z]{6}$")
    private static let labelPathPattern = try! NSRegularExpression(pattern: "^/l/([A-Za-z0-9]{6})$")
    private static let aliasPathPattern = try! NSRegularExpression(
        pattern: "^/l/([A-Za-z]{3}-[0-9A-Za-z]{4}-[0-9]{4})$"
    )

    public static func normaliseShortCode(_ raw: String) -> String {
        raw.uppercased()
            .replacingOccurrences(of: "O", with: "0")
            .replacingOccurrences(of: "I", with: "1")
            .replacingOccurrences(of: "L", with: "1")
    }

    public static func isValidShortCode(_ code: String) -> Bool {
        let range = NSRange(code.startIndex..<code.endIndex, in: code)
        return shortCodePattern.firstMatch(in: code, options: [], range: range) != nil
    }

    public static func validate(urlText: String, expectedOrigin: URL) -> NFCLabelValidationResult {
        validate(urlText: urlText, expectedOrigins: [expectedOrigin])
    }

    /// `expectedOrigins`: the server's origin, then its label address when it has one.
    public static func validate(urlText: String, expectedOrigins: [URL]) -> NFCLabelValidationResult {
        let trimmed = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: trimmed),
              let scheme = parts.scheme?.lowercased(), scheme == "https",
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil
        else { return .malformed }

        let port = parts.port ?? 443
        let matches = expectedOrigins.contains { expected in
            guard let expectedScheme = expected.scheme?.lowercased(),
                  let expectedHost = expected.host?.lowercased()
            else { return false }
            let expectedPort = expected.port ?? (expectedScheme == "https" ? 443 : 80)
            return expectedScheme == "https" && host == expectedHost && port == expectedPort
        }
        guard matches else {
            return expectedOrigins.isEmpty ? .malformed : .foreign
        }

        guard parts.query == nil, parts.fragment == nil else { return .malformed }
        let path = parts.path
        let pathRange = NSRange(path.startIndex..<path.endIndex, in: path)
        if let match = aliasPathPattern.firstMatch(in: path, options: [], range: pathRange),
           let aliasRange = Range(match.range(at: 1), in: path)
        {
            let alias = String(path[aliasRange]).uppercased()
            guard !alias.hasSuffix("-0000") else { return .malformed }
            return .approved(code: alias)
        }
        guard let match = labelPathPattern.firstMatch(in: path, options: [], range: pathRange),
              let codeRange = Range(match.range(at: 1), in: path)
        else { return .malformed }

        let code = normaliseShortCode(String(path[codeRange]))
        guard isValidShortCode(code) else { return .malformed }
        return .approved(code: code)
    }

    /// The label address the server names (`GET /api/v1/labels/address`), as an https origin;
    /// nil for anything else.
    public static func labelOrigin(_ text: String) -> URL? {
        guard var parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme?.lowercased() == "https",
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/"
        else { return nil }
        parts.scheme = "https"
        parts.host = host
        parts.path = ""
        if parts.port == 443 { parts.port = nil }
        return parts.url
    }
}

/// Suppresses consecutive reads with the same NDEF contents during the cooldown.
public struct NFCRepeatDebouncer {
    public let window: TimeInterval
    private var lastFingerprint: String?
    private var lastDetectedAt: Date?

    public init(window: TimeInterval = 2.5) {
        self.window = window
    }

    public mutating func shouldAccept(fingerprint: String, at date: Date = Date()) -> Bool {
        if let lastFingerprint, let lastDetectedAt,
           lastFingerprint == fingerprint,
           date.timeIntervalSince(lastDetectedAt) < window
        {
            return false
        }
        lastFingerprint = fingerprint
        lastDetectedAt = date
        return true
    }

    public mutating func reset() {
        lastFingerprint = nil
        lastDetectedAt = nil
    }
}

public struct NDEFRecordSnapshot: Equatable {
    public let typeNameFormat: UInt8
    public let type: Data
    public let identifier: Data
    public let payload: Data

    public init(typeNameFormat: UInt8, type: Data, identifier: Data, payload: Data) {
        self.typeNameFormat = typeNameFormat
        self.type = type
        self.identifier = identifier
        self.payload = payload
    }

    public static func fingerprint(_ records: [NDEFRecordSnapshot]) -> String {
        var hash = SHA256()
        for record in records {
            let line = [
                String(record.typeNameFormat),
                record.type.base64EncodedString(),
                record.identifier.base64EncodedString(),
                record.payload.base64EncodedString(),
            ].joined(separator: "|") + "\n"
            hash.update(data: Data(line.utf8))
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

public enum FindOutcome: String, Codable, Equatable {
    case match
    case nonmatch
    case unresolved
    case foreign
    case malformed
    case unassigned
    case unavailable
    case repeated
}

/// Tracks the single active continuous Find session and rejects stale or empty session commands.
public struct NFCFindSessionGate: Equatable {
    public private(set) var activeSessionId: String?

    public init() {}

    public mutating func begin(_ sessionId: String) -> Bool {
        guard activeSessionId == nil, !sessionId.isEmpty, sessionId.count <= 64 else {
            return false
        }
        activeSessionId = sessionId
        return true
    }

    public func acceptsCommand(sessionId: String?) -> Bool {
        guard let sessionId, !sessionId.isEmpty, let activeSessionId else { return false }
        return sessionId == activeSessionId
    }

    public func acceptsCancel(sessionId: String?) -> Bool {
        guard let sessionId else { return true }
        guard !sessionId.isEmpty, let activeSessionId else { return false }
        return sessionId == activeSessionId
    }

    public mutating func end(sessionId: String? = nil) {
        if sessionId == nil || sessionId == activeSessionId {
            activeSessionId = nil
        }
    }
}
