import Foundation
import CryptoKit
@main struct MacWrapperRelaySmoke {
    static func main() async throws {
        let code = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
        let invite = try RelayInvite.parse(code)
        let (device, secret) = try await EncryptedRelay.pair(invite, name: "Disposable wrapper test")
        func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
            var value: [String: Any] = ["method": method, "path": path, "token": device.token]
            if let body { value["body"] = body }
            return try await EncryptedRelay.request(endpoint: invite.relay, host: invite.host, channel: device.deviceId, secret: secret, value: value)
        }
        let health = try await request("/health")
        guard let result = try JSONSerialization.jsonObject(with: health) as? [String: Any], result["hostId"] as? String == device.hostId else { throw AppError.message("Wrong Mac identity") }
        _ = try await request("/settings/models", method: "POST", body: ["codex": "wrapper-test", "claude": "", "local": "", "localProvider": "ollama"])
        let defaults = try await request("/settings/models")
        guard String(decoding: defaults, as: UTF8.self).contains("wrapper-test") else { throw AppError.message("Defaults not saved") }
        print("Packaged Mac service: native iPhone pairing and encrypted settings round trip passed.")
    }
}
