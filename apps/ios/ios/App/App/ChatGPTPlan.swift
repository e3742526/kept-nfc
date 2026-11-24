import AuthenticationServices
import CryptoKit
import Foundation
import Network
import Security
import UIKit

/// ChatGPT plan authorization stays in the native app, scoped to the signed-in SheepKeep account.
@MainActor
final class ChatGPTPlan {
    private static let issuer = "https://auth.openai.com"
    private static let resource = "https://api.openai.com/v1"
    private nonisolated static let planScope = "chatgpt.tokens.use.direct"

    private struct Registration: Codable {
        let clientID: String
        let subject: String
        let email: String
        var idToken: String?
        var accessToken: String?
        var refreshToken: String?
        var expiresAt: Date?

        var label: String { email.isEmpty ? "ChatGPT" : email }
    }

    private struct Tokens: Decodable {
        let access_token: String
        let id_token: String?
        let refresh_token: String?
        let expires_in: TimeInterval
        let scope: String?

        var grantsPlanAccess: Bool {
            scope?.split(separator: " ").contains(Substring(ChatGPTPlan.planScope)) == true
        }
    }

    private var operating = false

    func account(context: String) throws -> String? {
        let saved = try Self.read(context)
        return saved?.refreshToken != nil ? saved?.label : nil
    }

    func connect(context: String, window: UIWindow) async throws -> String {
        try await perform {
            let previous = try Self.read(context)
            let verifier = try Self.random()
            let state = try Self.random()
            let nonce = try Self.random()
            let hostID = try Self.hostID()
            let (callback, redirect) = try await ChatGPTCallback().authorize(window: window, state: state) { redirect in
                var fields = [
                    "client_id": previous?.clientID ?? "dynamic_agent_client",
                    "ext_agent_host_id": hostID,
                    "response_type": "code",
                    "redirect_uri": redirect,
                    "scope": "openid profile email offline_access resource.invoke \(Self.planScope)",
                    "resource": Self.resource,
                    "state": state,
                    "nonce": nonce,
                    "code_challenge_method": "S256",
                    "code_challenge": Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
                ]
                if let previous {
                    if !previous.email.isEmpty { fields["login_hint"] = previous.email }
                    fields["id_token_hint"] = previous.idToken
                } else {
                    fields["agent_name_hint"] = "SheepKeep"
                }
                return try Self.url(Self.issuer + "/api/accounts/authorize", fields: fields)
            }
            if callback["error"] != nil { throw CaptureAIError.cancelled }
            guard let code = callback["code"], !code.isEmpty,
                  let clientID = callback["client_id"] ?? previous?.clientID,
                  !clientID.isEmpty, clientID != "dynamic_agent_client", clientID.utf8.count <= 256,
                  previous == nil || previous?.clientID == clientID
            else { throw CaptureAIError.signInFailed }

            let tokens = try await Self.token([
                "grant_type": "authorization_code", "client_id": clientID, "code": code,
                "code_verifier": verifier, "redirect_uri": redirect
            ])
            guard tokens.grantsPlanAccess, let idToken = tokens.id_token,
                  let refresh = tokens.refresh_token, !refresh.isEmpty
            else { throw CaptureAIError.signInFailed }

            let (subject, email) = try await Self.identity(idToken, clientID: clientID, nonce: nonce)
            guard previous == nil || previous?.subject == subject else { throw CaptureAIError.signInFailed }
            let saved = Registration(
                clientID: clientID, subject: subject, email: email, idToken: idToken,
                accessToken: tokens.access_token, refreshToken: refresh,
                expiresAt: Date().addingTimeInterval(tokens.expires_in)
            )
            try Self.write(saved, context: context)
            return saved.label
        }
    }

    func disconnect(context: String) async throws -> Bool {
        try await perform {
            guard var saved = try Self.read(context) else { return true }
            let refresh = saved.refreshToken
            // Clear local access first so a failed network request never leaves the app connected.
            saved.accessToken = nil
            saved.refreshToken = nil
            saved.idToken = nil
            saved.expiresAt = nil
            try Self.write(saved, context: context)
            guard let refresh else { return true }
            let form = [
                "token": refresh, "token_type_hint": "refresh_token", "client_id": saved.clientID
            ]
            do {
                let request = try Self.form(Self.issuer + "/api/accounts/oauth/revoke", form)
                let (_, response) = try await KeptHTTP.send(request)
                return response.statusCode == 200
            } catch {
                return false
            }
        }
    }

    func models(context: String) async throws -> [[String: String]] {
        try await perform {
            struct Catalog: Decodable {
                struct Model: Decodable {
                    let slug: String
                    let display_name: String
                    let visibility: String
                }
                let models: [Model]
            }
            let request = try await apiRequest("/models", context: context)
            let (data, response) = try await KeptHTTP.send(request)
            try Self.checkResponse(response)
            let models = try JSONDecoder().decode(Catalog.self, from: data).models
            var seen = Set<String>()
            return models.filter { $0.visibility == "list" && seen.insert($0.slug).inserted }
                .map { ["id": $0.slug, "name": $0.display_name] }
        }
    }

    func describe(context: String, model: String, jpeg: String) async throws -> String {
        try await perform {
            var request = try await apiRequest("/responses", context: context)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "model": model, "store": false, "stream": true,
                "instructions": inventoryPhotoInstructions,
                "input": [[
                    "role": "user",
                    "content": [
                        ["type": "input_text", "text": "Describe the main item in this inventory photo."],
                        ["type": "input_image", "image_url": "data:image/jpeg;base64,\(jpeg)", "detail": "auto"]
                    ]
                ]]
            ])
            let (bytes, response) = try await KeptHTTP.stream(request)
            try Self.checkResponse(response)
            var received = 0
            for try await line in bytes.lines {
                received += line.utf8.count
                guard received <= 512 * 1024 else { throw CaptureAIError.suggestion }
                guard line.hasPrefix("data: "),
                      let event = try? JSONSerialization.jsonObject(with: Data(line.dropFirst(6).utf8))
                        as? [String: Any]
                else { continue }
                switch event["type"] as? String {
                case "response.completed":
                    let result = event["response"] as? [String: Any]
                    let output = result?["output"] as? [[String: Any]] ?? []
                    let text = output.filter { $0["type"] as? String == "message" }
                        .flatMap { $0["content"] as? [[String: Any]] ?? [] }
                        .filter { $0["type"] as? String == "output_text" }
                        .compactMap { $0["text"] as? String }
                        .joined(separator: " ")
                    guard !text.isEmpty else { throw CaptureAIError.suggestion }
                    return text
                case "response.failed", "response.incomplete", "error":
                    throw CaptureAIError.suggestion
                default: continue
                }
            }
            throw CaptureAIError.suggestion
        }
    }

    private func perform<T>(_ operation: () async throws -> T) async throws -> T {
        guard !operating else { throw CaptureAIError.busy }
        operating = true
        defer { operating = false }
        return try await operation()
    }

    private func apiRequest(_ path: String, context: String) async throws -> URLRequest {
        guard var saved = try Self.read(context), let refresh = saved.refreshToken else {
            throw CaptureAIError.reconnect
        }
        if (saved.expiresAt ?? .distantPast) < Date().addingTimeInterval(60) || saved.accessToken == nil {
            let tokens = try await Self.token([
                "grant_type": "refresh_token", "client_id": saved.clientID, "refresh_token": refresh
            ])
            guard tokens.scope == nil || tokens.grantsPlanAccess else { throw CaptureAIError.reconnect }
            saved.accessToken = tokens.access_token
            saved.refreshToken = tokens.refresh_token ?? refresh
            saved.expiresAt = Date().addingTimeInterval(tokens.expires_in)
            // Keep the previously verified ID token as the login hint.
            try Self.write(saved, context: context)
        }
        var request = URLRequest(url: try Self.url(Self.resource + path))
        request.setValue("Bearer \(saved.accessToken ?? "")", forHTTPHeaderField: "Authorization")
        return request
    }

    private static func checkResponse(_ response: HTTPURLResponse) throws {
        switch response.statusCode {
        case 200: return
        case 401, 403: throw CaptureAIError.reconnect
        case 429: throw CaptureAIError.quota
        default: throw CaptureAIError.suggestion
        }
    }

    private static func token(_ fields: [String: String]) async throws -> Tokens {
        let fields = fields.merging(["resource": resource]) { first, _ in first }
        let request = try form(issuer + "/api/accounts/oauth/token", fields)
        let (data, response) = try await KeptHTTP.send(request)
        guard response.statusCode == 200 else {
            throw fields["grant_type"] == "refresh_token" && (400...403).contains(response.statusCode)
                ? CaptureAIError.reconnect : CaptureAIError.signInFailed
        }
        let tokens = try JSONDecoder().decode(Tokens.self, from: data)
        guard !tokens.access_token.isEmpty, tokens.expires_in.isFinite, tokens.expires_in > 0 else {
            throw CaptureAIError.signInFailed
        }
        return tokens
    }

    private static func form(_ endpoint: String, _ fields: [String: String]) throws -> URLRequest {
        var request = URLRequest(url: try url(endpoint))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var components = URLComponents()
        components.queryItems = fields.map { URLQueryItem(name: $0.key, value: $0.value) }
        // In a form body, an unescaped plus means a space.
        request.httpBody = Data((components.percentEncodedQuery ?? "")
            .replacingOccurrences(of: "+", with: "%2B").utf8)
        return request
    }

    private static func url(_ base: String, fields: [String: String] = [:]) throws -> URL {
        guard var components = URLComponents(string: base) else { throw CaptureAIError.signInFailed }
        if !fields.isEmpty {
            components.queryItems = fields.map { URLQueryItem(name: $0.key, value: $0.value) }
            components.percentEncodedQuery = components.percentEncodedQuery?
                .replacingOccurrences(of: "+", with: "%2B")
        }
        guard let result = components.url else { throw CaptureAIError.signInFailed }
        return result
    }

    private static func identity(
        _ token: String, clientID: String, nonce: String
    ) async throws -> (subject: String, email: String) {
        struct Keys: Decodable {
            struct Key: Decodable {
                let kty: String
                let kid: String
                let n: String?
                let e: String?
            }
            let keys: [Key]
        }
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3,
              let headerData = decodeBase64URL(String(parts[0])),
              let header = try JSONSerialization.jsonObject(with: headerData) as? [String: Any],
              header["alg"] as? String == "RS256", let kid = header["kid"] as? String,
              let claimsData = decodeBase64URL(String(parts[1])),
              let signature = decodeBase64URL(String(parts[2]))
        else { throw CaptureAIError.signInFailed }
        let (jwks, response) = try await KeptHTTP.send(URLRequest(url: try url(issuer + "/.well-known/jwks.json")))
        guard response.statusCode == 200,
              let key = try JSONDecoder().decode(Keys.self, from: jwks).keys.first(where: {
                  $0.kid == kid && $0.kty == "RSA"
              }),
              let modulus = key.n.flatMap(decodeBase64URL), let exponent = key.e.flatMap(decodeBase64URL),
              let publicKey = rsaKey(modulus: modulus, exponent: exponent),
              SecKeyVerifySignature(
                  publicKey, .rsaSignatureMessagePKCS1v15SHA256,
                  Data("\(parts[0]).\(parts[1])".utf8) as CFData, signature as CFData, nil
              ),
              let claims = try JSONSerialization.jsonObject(with: claimsData) as? [String: Any],
              claims["iss"] as? String == issuer, claims["nonce"] as? String == nonce,
              let exp = claims["exp"] as? Double, exp > Date().timeIntervalSince1970,
              let subject = claims["sub"] as? String, !subject.isEmpty
        else { throw CaptureAIError.signInFailed }
        let audience = (claims["aud"] as? [String]) ?? [claims["aud"] as? String ?? ""]
        guard audience.contains(clientID), audience.count == 1 || claims["azp"] as? String == clientID,
              claims["azp"] == nil || claims["azp"] as? String == clientID
        else { throw CaptureAIError.signInFailed }
        return (subject, claims["email"] as? String ?? "")
    }

    private static func rsaKey(modulus: Data, exponent: Data) -> SecKey? {
        guard (256...1024).contains(modulus.count), (1...8).contains(exponent.count) else { return nil }
        func der(_ tag: UInt8, _ value: Data) -> Data {
            let length = value.count
            if length < 128 { return Data([tag, UInt8(length)]) + value }
            if length <= 255 { return Data([tag, 0x81, UInt8(length)]) + value }
            return Data([tag, 0x82, UInt8(length >> 8), UInt8(length & 255)]) + value
        }
        func integer(_ value: Data) -> Data {
            der(0x02, (value.first ?? 0) & 0x80 == 0 ? value : Data([0]) + value)
        }
        let pkcs1 = der(0x30, integer(modulus) + integer(exponent))
        let attributes = [
            kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
            kSecAttrKeyClass as String: kSecAttrKeyClassPublic
        ]
        return SecKeyCreateWithData(pkcs1 as CFData, attributes as CFDictionary, nil)
    }

    private static func hostID() throws -> String {
        let account = "agent-host"
        if let data = try readData(account), let saved = String(data: data, encoding: .utf8) {
            return saved
        }
        let new = "urn:uuid:\(UUID().uuidString.lowercased())"
        try writeData(Data(new.utf8), account: account)
        return new
    }

    private static func random() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw CaptureAIError.signInFailed
        }
        return base64URL(Data(bytes))
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private static func decodeBase64URL(_ value: String) -> Data? {
        let standard = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        return Data(base64Encoded: standard + String(repeating: "=", count: (4 - standard.utf8.count % 4) % 4))
    }

    private static func keychainQuery(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "info.keptinventory.nfc") + ".chatgpt",
            kSecAttrAccount as String: account
        ]
    }

    private static func readData(_ account: String) throws -> Data? {
        var query = keychainQuery(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw KeptNativeError.keychain }
        return data
    }

    private static func writeData(_ data: Data, account: String) throws {
        var query = keychainQuery(account)
        let changes = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, changes as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw KeptNativeError.keychain }
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw KeptNativeError.keychain }
    }

    private static func accountKey(_ context: String) -> String {
        Data(SHA256.hash(data: Data(context.utf8))).base64EncodedString()
    }

    private static func read(_ context: String) throws -> Registration? {
        guard let data = try readData(accountKey(context)) else { return nil }
        return try JSONDecoder().decode(Registration.self, from: data)
    }

    private static func write(_ registration: Registration, context: String) throws {
        try writeData(JSONEncoder().encode(registration), account: accountKey(context))
    }
}

/// The public-client OAuth flow requires an HTTP callback on the browser's own loopback interface.
@MainActor
private final class ChatGPTCallback: NSObject, ASWebAuthenticationPresentationContextProviding {
    typealias Reply = ([String: String], String)
    private static let path = "/auth/callback"
    private static let loopback = "127.0.0.1"
    private static let maxHeader = 8192
    private weak var window: UIWindow?
    private var browser: ASWebAuthenticationSession?
    private var listener: NWListener?
    private var sockets: [ObjectIdentifier: NWConnection] = [:]
    private var timeout: Task<Void, Never>?
    private var result: CheckedContinuation<Reply, Error>?
    private var redirect: String?
    private var state = ""

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        window ?? ASPresentationAnchor()
    }

    func authorize(
        window: UIWindow, state: String, url: @escaping (String) throws -> URL
    ) async throws -> Reply {
        self.window = window
        self.state = state
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(Self.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener

        return try await withCheckedThrowingContinuation { continuation in
            result = continuation
            listener.stateUpdateHandler = { [weak self] status in
                Task { @MainActor in
                    guard let self, self.result != nil else { return }
                    switch status {
                    case .ready:
                        guard let port = self.listener?.port?.rawValue else {
                            self.finish(.failure(CaptureAIError.signInFailed))
                            return
                        }
                        let redirect = "http://\(Self.loopback):\(port)\(Self.path)"
                        do {
                            self.redirect = redirect
                            try self.present(url(redirect))
                        } catch {
                            self.finish(.failure(error))
                        }
                    case .failed, .waiting:
                        self.finish(.failure(CaptureAIError.signInFailed))
                    default: break
                    }
                }
            }
            listener.newConnectionHandler = { [weak self] socket in
                Task { @MainActor in
                    guard let self, self.result != nil, self.sockets.count < 8 else {
                        socket.cancel()
                        return
                    }
                    let id = ObjectIdentifier(socket)
                    self.sockets[id] = socket
                    socket.start(queue: .main)
                    self.receive(socket, header: Data())
                    Task { @MainActor [weak self] in
                        try? await Task.sleep(nanoseconds: 10_000_000_000)
                        self?.sockets.removeValue(forKey: id)?.cancel()
                    }
                }
            }
            listener.start(queue: .main)
            timeout = Task { @MainActor [weak self] in
                do {
                    try await Task.sleep(nanoseconds: 300_000_000_000)
                    self?.finish(.failure(CaptureAIError.cancelled))
                } catch {}
            }
        }
    }

    private func present(_ url: URL) throws {
        // The browser navigates to HTTP loopback. A custom-scheme or HTTPS callback
        // would change the registered redirect URI. The loopback listener closes the sheet.
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: nil) { [weak self] _, _ in
            Task { @MainActor in self?.finish(.failure(CaptureAIError.cancelled)) }
        }
        session.presentationContextProvider = self
        browser = session
        guard session.start() else { throw CaptureAIError.signInFailed }
    }

    private func receive(_ socket: NWConnection, header: Data) {
        socket.receive(minimumIncompleteLength: 1, maximumLength: Self.maxHeader) { [weak self] data, _, done, error in
            Task { @MainActor in
                guard let self, self.sockets[ObjectIdentifier(socket)] != nil else { return }
                let header = header + (data ?? Data())
                if header.count > Self.maxHeader || error != nil {
                    self.respond(socket, reply: nil)
                } else if header.range(of: Data("\r\n\r\n".utf8)) != nil {
                    self.respond(socket, reply: self.parse(header))
                } else if done {
                    self.close(socket)
                } else {
                    self.receive(socket, header: header)
                }
            }
        }
    }

    private func parse(_ header: Data) -> Reply? {
        guard let redirect, let text = String(data: header, encoding: .utf8),
              let line = text.components(separatedBy: "\r\n").first
        else { return nil }
        let pieces = line.split(separator: " ")
        guard pieces.count == 3, pieces[0] == "GET",
              let target = URLComponents(string: String(pieces[1])),
              target.scheme == nil, target.host == nil, target.percentEncodedPath == Self.path
        else { return nil }
        var fields: [String: String] = [:]
        for parameter in target.queryItems ?? [] {
            guard fields[parameter.name] == nil, let value = parameter.value else { return nil }
            fields[parameter.name] = value
        }
        guard fields["state"] == state, fields["code"] != nil || fields["error"] != nil else { return nil }
        return (fields, redirect)
    }

    private func respond(_ socket: NWConnection, reply: Reply?) {
        let body = reply == nil ? "This sign-in request could not be completed." : "Return to SheepKeep."
        let status = reply == nil ? "400 Bad Request" : "200 OK"
        let response = """
            HTTP/1.1 \(status)\r
            Content-Type: text/plain; charset=utf-8\r
            Cache-Control: no-store\r
            Referrer-Policy: no-referrer\r
            Content-Length: \(body.utf8.count)\r
            Connection: close\r
            \r
            \(body)
            """
        socket.send(content: Data(response.utf8), completion: .contentProcessed { [weak self] _ in
            Task { @MainActor in
                self?.close(socket)
                if let reply { self?.finish(.success(reply)) }
            }
        })
    }

    private func close(_ socket: NWConnection) {
        sockets.removeValue(forKey: ObjectIdentifier(socket))
        socket.cancel()
    }

    private func finish(_ outcome: Result<Reply, Error>) {
        guard let result else { return }
        self.result = nil
        listener?.cancel()
        listener = nil
        for socket in sockets.values { socket.cancel() }
        sockets.removeAll()
        timeout?.cancel()
        timeout = nil
        browser?.cancel()
        browser = nil
        result.resume(with: outcome)
    }
}
