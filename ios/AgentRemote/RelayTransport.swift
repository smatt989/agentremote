import Foundation
import CryptoKit

private struct RelayFrame: Codable {
    var type: String
    var packet: SecurePacket?
    var id: String?
    var reason: String?
}
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
actor RelayConnection {
    private var socket: URLSessionWebSocketTask?
    private var receiver: Task<Void, Never>?
    private var lastUse = Date.distantPast
    private let endpoint: String
    private let session: URLSession
    private struct Pending {
        var header: SecurePacket
        var continuation: CheckedContinuation<SecurePacket, Error>
        var timeout: Task<Void, Never>
    }
    private var pending: [String: Pending] = [:]
    init(endpoint: String) {
        self.endpoint = endpoint
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60
        config.waitsForConnectivity = false
        self.session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }
    private func connect() throws -> URLSessionWebSocketTask {
        _ = try RelayCrypto.endpoint(endpoint)
        if let socket, socket.state == .running, Date().timeIntervalSince(lastUse) < 30 { lastUse = Date(); return socket }
        disconnect(AppError.message("The connection was interrupted. Check your session before retrying a command."))
        let task = session.webSocketTask(with: URL(string: endpoint.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/v1/client")!)
        task.maximumMessageSize = 40_000_000
        socket = task; lastUse = Date(); task.resume()
        receiver = Task { [weak self] in
            do {
                while !Task.isCancelled {
                    let message = try await task.receive()
                    let data: Data
                    switch message { case .data(let value): data = value; case .string(let value): data = Data(value.utf8); @unknown default: continue }
                    await self?.received(data, from: task)
                }
            } catch { await self?.failed(error, from: task) }
        }
        return task
    }
    func exchange(_ packet: SecurePacket) async throws -> SecurePacket {
        try Task.checkCancellation()
        let task = try connect()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                let timeout = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(55)); await self?.finish(packet.id, error: AppError.message("The Mac did not respond in time. Check your session before retrying a command.")) } catch {}
                }
                pending[packet.id] = Pending(header: packet, continuation: continuation, timeout: timeout)
                Task {
                    do {
                        let frame = RelayFrame(type: "request", packet: packet)
                        let data = try JSONEncoder().encode(frame)
                        try await task.send(.string(String(decoding: data, as: UTF8.self)))
                    } catch { self.finish(packet.id, error: error) }
                }
            }
        }, onCancel: { Task { await self.finish(packet.id, error: CancellationError()) } })
    }
    private func received(_ data: Data, from task: URLSessionWebSocketTask) {
        guard socket === task else { return }
        do {
            let frame = try JSONDecoder().decode(RelayFrame.self, from: data)
            if frame.type == "unavailable", let id = frame.id {
                let message: String
                switch frame.reason {
                case "mac_offline": message = "Your Mac is offline. It will reconnect automatically when it’s awake and online."
                case "device_not_authorized": message = "This device is no longer paired, or the code has expired. Pair with your Mac again."
                case "relay_busy": message = "The relay is busy. Try again in a moment."
                case "relay_quota": message = "Your Mac has used today’s allowance on the shared relay. It resets within 24 hours, or you can run your own relay."
                default: message = "The connection is unavailable. Your Mac may still be working; check the session before retrying."
                }
                finish(id, error: AppError.message(message)); return
            }
            guard frame.type == "response", let packet = frame.packet, let item = pending[packet.id] else { return }
            guard packet.host == item.header.host, packet.channel == item.header.channel, packet.issuedAt == item.header.issuedAt else { finish(packet.id, error: AppError.message("The relay returned a mismatched response.")); return }
            pending.removeValue(forKey: packet.id); item.timeout.cancel(); item.continuation.resume(returning: packet)
        } catch { disconnect(error) }
    }
    private func finish(_ id: String, error: Error) {
        guard let item = pending.removeValue(forKey: id) else { return }
        item.timeout.cancel(); item.continuation.resume(throwing: error)
    }
    private func failed(_ error: Error, from task: URLSessionWebSocketTask) { if socket === task { disconnect(error) } }
    private func disconnect(_ error: Error) {
        socket?.cancel(with: .goingAway, reason: nil); socket = nil; receiver?.cancel(); receiver = nil
        for id in Array(pending.keys) { finish(id, error: error) }
    }
}
actor RelayPool {
    static let shared = RelayPool()
    private var connections: [String: RelayConnection] = [:]
    func connection(_ endpoint: String) -> RelayConnection {
        if let existing = connections[endpoint] { return existing }
        let connection = RelayConnection(endpoint: endpoint); connections[endpoint] = connection; return connection
    }
}
enum EncryptedRelay {
    private struct Response: Decodable { var status: Int; var body: String }
    static func request(endpoint: String, host: String, channel: String, secret: Data, value: [String: Any]) async throws -> Data {
        let header = SecurePacket(host: host, channel: channel, id: UUID().uuidString, issuedAt: Int64(Date().timeIntervalSince1970 * 1000), box: "")
        let packet = try RelayCrypto.seal(JSONSerialization.data(withJSONObject: value), secret: secret, header: header, direction: "request")
        let connection = await RelayPool.shared.connection(endpoint)
        let response = try await connection.exchange(packet)
        let cleartext = try RelayCrypto.open(response, secret: secret, direction: "response")
        let result = try JSONDecoder().decode(Response.self, from: cleartext)
        guard let body = Data(base64Encoded: result.body) else { throw AppError.message("The Mac returned invalid data.") }
        guard (200..<300).contains(result.status) else {
            let error = (try? JSONSerialization.jsonObject(with: body)) as? [String: String]
            throw AppError.message(error?["error"] ?? "Your Mac couldn’t finish this request. Check that Agent Remote is running on the Mac, then pull to refresh or try again.")
        }
        return body
    }
    static func pair(_ invite: RelayInvite, name: String) async throws -> (RelayPairResponse, Data) {
        guard let bootstrap = Data(base64Encoded: invite.secret) else { throw AppError.message("Invalid pairing key.") }
        let privateKey = Curve25519.KeyAgreement.PrivateKey()
        let data = try await request(endpoint: invite.relay, host: invite.host, channel: invite.channel, secret: bootstrap, value: ["op": "pair", "name": name, "publicKey": privateKey.publicKey.rawRepresentation.base64EncodedString()])
        let response = try JSONDecoder().decode(RelayPairResponse.self, from: data)
        guard response.host == invite.host, let peer = Data(base64Encoded: response.publicKey) else { throw AppError.message("The pairing response came from a different Mac.") }
        let secret = try RelayCrypto.pairingKey(privateKey: privateKey, peer: peer, bootstrap: bootstrap, host: invite.host, device: response.deviceId)
        return (response, secret)
    }
}
