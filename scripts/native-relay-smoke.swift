import Foundation
import CryptoKit

// Uses the exact CryptoKit and URLSession code compiled into the iPhone app.
@main struct NativeRelaySmoke {
    static func main() async throws {
        let code = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
        let invite = try RelayInvite.parse(code)
        let (device, secret) = try await EncryptedRelay.pair(invite, name: "Native transport test")
        func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
            var value: [String: Any] = ["method": method, "path": path, "token": device.token]
            if let body { value["body"] = body }
            return try await EncryptedRelay.request(endpoint: invite.relay, host: invite.host, channel: device.deviceId, secret: secret, value: value)
        }
        let health = try await request("/health")
        guard let metadata = try JSONSerialization.jsonObject(with: health) as? [String: Any], metadata["hostId"] as? String == device.hostId else { throw AppError.message("Host identity mismatch") }
        let bytes = Data((0..<512_000).map { UInt8($0 % 251) })
        let uploaded = try await request("/sessions/codex:fixture/artifacts", method: "POST", body: ["name": "native-chart.png", "base64": bytes.base64EncodedString()])
        let artifact = try JSONSerialization.jsonObject(with: uploaded) as! [String: Any]
        let downloaded = try await request("/artifacts/" + (artifact["id"] as! String))
        guard downloaded == bytes else { throw AppError.message("Image transfer mismatch") }
        let command: [String: Any] = ["requestId": UUID().uuidString, "text": "native-client-secret"]
        _ = try await request("/sessions/codex:fixture/messages", method: "POST", body: command)
        _ = try await request("/sessions/codex:fixture/messages", method: "POST", body: command)
        let detail = try await request("/sessions/codex:fixture")
        guard String(decoding: detail, as: UTF8.self).contains("NATIVE_REPLY") else { throw AppError.message("Reply missing") }
        let parsed = try JSONSerialization.jsonObject(with: detail) as! [String: Any]
        let questions = parsed["questions"] as! [[String: Any]]
        guard let questionID = questions.first?["id"] as? String else { throw AppError.message("Question missing") }
        let answerPath = "/sessions/codex:fixture/questions/" + questionID + "/answer"
        _ = try await request(answerPath, method: "POST", body: ["answers": ["0": "Revenue"]])
        _ = try await request(answerPath, method: "POST", body: ["answers": ["0": "Revenue"]])
        let memory = try await request("/memory?q=Hex")
        guard String(decoding: memory, as: UTF8.self).contains("analytics") else { throw AppError.message("Memory missing") }
        let memoryData = try JSONSerialization.jsonObject(with: memory) as! [String: Any]
        let fact = (memoryData["results"] as! [[String: Any]]).first { $0["topic"] != nil }!
        _ = try await request("/memory/forget", method: "POST", body: ["id": fact["id"] as! String])
        let forgotten = try await request("/memory?q=Hex")
        guard !String(decoding: forgotten, as: UTF8.self).contains("analytics") else { throw AppError.message("Forgotten memory reappeared") }
        _ = try await request("/settings/models", method: "POST", body: ["codex": "test-model", "claude": "", "local": "", "localProvider": "ollama"])
        let defaults = try await request("/settings/models")
        guard String(decoding: defaults, as: UTF8.self).contains("test-model") else { throw AppError.message("Model default missing") }
        _ = try await request("/sessions/codex:fixture/end", method: "POST")
        let ended = try await request("/sessions/codex:fixture")
        guard String(decoding: ended, as: UTF8.self).contains("ended") else { throw AppError.message("End failed") }
        _ = try await request("/sessions/codex:fixture/delete", method: "POST")
        _ = try await request("/sessions/codex:fixture/delete", method: "POST")
        let sessions = try await request("/sessions")
        guard !String(decoding: sessions, as: UTF8.self).contains("codex:fixture") else { throw AppError.message("Deleted session reappeared") }
        print("Native CryptoKit + URLSession: pairing, encrypted API, message retry, 512 KB artifacts, model defaults, memory search/forget, questions/answer retries, end and delete passed.")
    }
}
