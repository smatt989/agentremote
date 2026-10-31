import Foundation
import CryptoKit

enum AppError: LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case .message(let text): return text } }
}

struct SecurePacket: Codable {
    var v = 1
    var host: String
    var channel: String
    var id: String
    var issuedAt: Int64
    var box: String
}
struct RelayInvite: Codable {
    var v: Int
    var relay: String
    var host: String
    var channel: String
    var secret: String
    var expires: Int64
    var name: String
    /// Accepts the code itself or any text containing an `agentremote://pair#…` link (a message someone sent themselves).
    static func parse(_ code: String) throws -> RelayInvite {
        let text = code.trimmingCharacters(in: .whitespacesAndNewlines)
        let link = text.range(of: #"agentremote://pair#[A-Za-z0-9_\-+/=]+"#, options: .regularExpression).map { String(text[$0]) } ?? text
        guard code.count < 4096, let url = URL(string: link), url.scheme == "agentremote", url.host == "pair", let fragment = url.fragment else { throw AppError.message("This isn’t an Agent Remote pairing code.") }
        var base64 = fragment.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64) else { throw AppError.message("This pairing code is incomplete. Scan the QR code on your Mac again.") }
        guard let invite = try? JSONDecoder().decode(RelayInvite.self, from: data) else { throw AppError.message("This pairing code is damaged. Scan the QR code on your Mac again.") }
        guard invite.v == 1, invite.host.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil, invite.channel.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil, Data(base64Encoded: invite.secret)?.count == 32 else { throw AppError.message("This pairing code is damaged. Scan the QR code on your Mac again.") }
        guard invite.expires > Int64(Date().timeIntervalSince1970 * 1000) else { throw AppError.message("This code has expired. Generate a new one on your Mac.") }
        _ = try RelayCrypto.endpoint(invite.relay)
        return invite
    }
}
struct RelayPairResponse: Codable {
    var token: String
    var deviceId: String
    var hostId: String
    var host: String
    var name: String
    var publicKey: String
}
enum RelayCrypto {
    static func endpoint(_ value: String) throws -> URL {
        guard let url = URL(string: value), let host = url.host, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, ["", "/"].contains(url.path), url.scheme == "wss" || (url.scheme == "ws" && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)) else { throw AppError.message("The pairing code contains an invalid relay address.") }
        return url
    }
    static func key(_ secret: Data, packet: SecurePacket, direction: String) throws -> SymmetricKey {
        guard secret.count == 32 else { throw AppError.message("Pair this Mac again to restore its encryption key.") }
        return HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: secret), salt: Data(packet.host.utf8), info: Data("agent-remote/v1/\(packet.channel)/\(direction)".utf8), outputByteCount: 32)
    }
    static func aad(_ packet: SecurePacket, direction: String) -> Data {
        Data("agent-remote/v1\n\(packet.host)\n\(packet.channel)\n\(packet.id)\n\(packet.issuedAt)\n\(direction)".utf8)
    }
    static func seal(_ data: Data, secret: Data, header: SecurePacket, direction: String, nonce: AES.GCM.Nonce? = nil) throws -> SecurePacket {
        let box = try AES.GCM.seal(data, using: key(secret, packet: header, direction: direction), nonce: nonce, authenticating: aad(header, direction: direction))
        guard let combined = box.combined, combined.count < 30_000_000 else { throw AppError.message("This request is too large.") }
        var packet = header; packet.box = combined.base64EncodedString(); return packet
    }
    static func open(_ packet: SecurePacket, secret: Data, direction: String) throws -> Data {
        guard packet.v == 1, abs(Double(packet.issuedAt) - Date().timeIntervalSince1970 * 1000) < 120_000, packet.box.count <= 40_000_000, let data = Data(base64Encoded: packet.box) else { throw AppError.message("Received an invalid or expired encrypted response.") }
        return try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key(secret, packet: packet, direction: direction), authenticating: aad(packet, direction: direction))
    }
    static func pairingKey(privateKey: Curve25519.KeyAgreement.PrivateKey, peer: Data, bootstrap: Data, host: String, device: String) throws -> Data {
        let publicKey = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peer)
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: publicKey)
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: bootstrap, sharedInfo: Data("agent-remote/pair/v1/\(host)/\(device)".utf8), outputByteCount: 32)
        return key.withUnsafeBytes { Data($0) }
    }
}
