import Foundation
import CryptoKit
import Security
import UserNotifications

// Shared by the app and the Notification Service Extension (AgentRemoteNotificationService). No UIKit here.

/// Per-Mac secrets: the API token (account = host id) and the relay E2E secret (account = host id + "/e2e").
/// On iPhone they live in the shared access group `$(AppIdentifierPrefix)com.agentremote.shared`, so the
/// Notification Service Extension can open sealed alerts. Builds without that entitlement (no push, Mac Catalyst)
/// keep using the app's own group, exactly as before.
enum Keychain {
    static let service = "AgentRemote"
    /// The resolved group from Info.plist (`AgentRemoteKeychainGroup`); nil on Mac Catalyst or when the build has no team prefix.
    static let sharedGroup: String? = {
        #if targetEnvironment(macCatalyst)
        return nil
        #else
        guard let value = Bundle.main.object(forInfoDictionaryKey: "AgentRemoteKeychainGroup") as? String,
              value.hasSuffix(".com.agentremote.shared"), !value.hasPrefix("."), !value.contains("$") else { return nil }
        return value
        #endif
    }()
    private static func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
    private static func add(_ data: Data, account: String, group: String?) -> OSStatus {
        var value = base(account)
        value[kSecValueData as String] = data
        value[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        if let group { value[kSecAttrAccessGroup as String] = group }
        return SecItemAdd(value as CFDictionary, nil)
    }
    static func put(_ token: String, host: String) throws {
        SecItemDelete(base(host) as CFDictionary) // every copy, in every group this app can reach
        var status = add(Data(token.utf8), account: host, group: sharedGroup)
        if status == errSecMissingEntitlement, sharedGroup != nil { status = add(Data(token.utf8), account: host, group: nil) }
        if status != errSecSuccess { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
    static func get(_ host: String) -> String? { data(host, group: nil).flatMap { String(data: $0, encoding: .utf8) } }
    private static func data(_ account: String, group: String?) -> Data? {
        var query = base(account)
        query[kSecReturnData as String] = true
        if let group { query[kSecAttrAccessGroup as String] = group }
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }
    /// Copies items saved before the shared group existed into it. The old copy is deleted only after the shared
    /// copy has been read back and matches, so an interrupted or refused migration never loses a pairing.
    static func migrateToSharedGroup(accounts: [String]) {
        guard let shared = sharedGroup else { return }
        for account in accounts {
            var query = base(account)
            query[kSecMatchLimit as String] = kSecMatchLimitAll
            query[kSecReturnAttributes as String] = true
            var result: CFTypeRef?
            guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let items = result as? [[String: Any]] else { continue }
            let groups = items.compactMap { $0[kSecAttrAccessGroup as String] as? String }
            let old = groups.filter { $0 != shared }
            guard let source = old.first, let value = data(account, group: source) else { continue }
            if !groups.contains(shared) {
                let status = add(value, account: account, group: shared)
                guard status == errSecSuccess || status == errSecDuplicateItem else { continue } // e.g. missing entitlement: keep the old item
            }
            guard data(account, group: shared) == value else { continue }
            for group in old { var item = base(account); item[kSecAttrAccessGroup as String] = group; SecItemDelete(item as CFDictionary) }
        }
    }
}

/// The content a Mac seals for one device (see desktop/src/reply-notifications.mjs `sealPush`).
struct PushContent: Codable, Equatable {
    struct Question: Codable, Equatable { var id: String; var item: String?; var options: [String]? }
    var v: Int?
    var kind: String
    var session: String
    var title: String
    var body: String
    var reply: Bool?
    var question: Question?
}

enum PushCrypto {
    static let maxLength = 1500
    static func key(_ secret: Data, hostId: String) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: secret), salt: Data(hostId.utf8), info: Data("agent-remote/v1/push".utf8), outputByteCount: 32)
    }
    static func aad(hostId: String, session: String, kind: String) -> Data { Data("agent-remote/v1/push\n\(hostId)\n\(session)\n\(kind)".utf8) }
    /// AES-256-GCM `nonce | ciphertext | tag`, bound to the visible host, session and kind. Throws on any mismatch.
    static func open(_ e2e: String, secret: Data, hostId: String, session: String, kind: String) throws -> PushContent {
        guard secret.count == 32, e2e.count <= maxLength, let combined = Data(base64Encoded: e2e), combined.count >= 28 else { throw CocoaError(.coderInvalidValue) }
        let plain = try AES.GCM.open(AES.GCM.SealedBox(combined: combined), using: key(secret, hostId: hostId), authenticating: aad(hostId: hostId, session: session, kind: kind))
        let content = try JSONDecoder().decode(PushContent.self, from: plain)
        guard content.session == session, content.kind == kind, !content.title.isEmpty, content.title.count <= 200, content.body.count <= 400, (content.question?.options?.count ?? 0) <= 3 else { throw CocoaError(.coderInvalidValue) }
        return content
    }
}

/// Notification categories and action identifiers shared by the extension (which picks the category after
/// decrypting) and the app (which registers the fixed ones and handles the responses).
enum NotificationCategories {
    static let reply = "reply", question = "question", questionOptionsPrefix = "question.options."
    static let replyAction = "reply", answerAction = "answer", openAction = "open", optionPrefix = "option."
    static let maxDynamic = 30

    static var fixed: [UNNotificationCategory] {
        let reply = UNTextInputNotificationAction(identifier: replyAction, title: "Reply", options: [.authenticationRequired], textInputButtonTitle: "Send", textInputPlaceholder: "Message")
        let open = UNNotificationAction(identifier: openAction, title: "Open", options: [.foreground])
        return [UNNotificationCategory(identifier: Self.reply, actions: [reply], intentIdentifiers: []),
                UNNotificationCategory(identifier: question, actions: [answer, open], intentIdentifiers: [])]
    }
    static var answer: UNTextInputNotificationAction {
        UNTextInputNotificationAction(identifier: answerAction, title: "Answer…", options: [.authenticationRequired], textInputButtonTitle: "Send", textInputPlaceholder: "Your answer")
    }
    /// Registers the fixed categories and keeps option categories the extension added for alerts still on screen.
    static func registerFixed() async {
        let center = UNUserNotificationCenter.current()
        let existing = await center.notificationCategories().filter { $0.identifier.hasPrefix(questionOptionsPrefix) }
        center.setNotificationCategories(Set(fixed).union(existing))
    }
    /// Buttons are fixed per category, so each distinct option set gets its own category, registered just before the
    /// alert is shown. Returns nil when it could not be registered (the caller then uses the plain `question` category).
    static func optionsCategory(_ options: [String]) async -> String? {
        guard !options.isEmpty else { return nil }
        let id = questionOptionsPrefix + SHA256.hash(data: Data(options.joined(separator: "\u{0}").utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        let center = UNUserNotificationCenter.current()
        var categories = await center.notificationCategories()
        if !categories.contains(where: { $0.identifier == id }) {
            let buttons = options.prefix(3).enumerated().map { UNNotificationAction(identifier: optionPrefix + String($0.offset), title: $0.element, options: [.authenticationRequired]) }
            let dynamic = categories.filter { $0.identifier.hasPrefix(questionOptionsPrefix) }
            if dynamic.count >= maxDynamic { categories.subtract(dynamic) } // bounded; older alerts keep tap-to-open
            categories.formUnion(fixed)
            categories.insert(UNNotificationCategory(identifier: id, actions: buttons + [answer], intentIdentifiers: []))
            center.setNotificationCategories(categories)
            // The set call is asynchronous; reading back waits for it, so the alert is shown with its buttons.
            guard await center.notificationCategories().contains(where: { $0.identifier == id }) else { return nil }
        }
        return id
    }
}

enum RichNotification {
    /// Decrypts `e2e` and returns the alert with the chat title, the reply's first line or the question, and the
    /// right actions. Any problem returns nil, and the caller shows the generic alert unchanged (fail closed).
    static func content(for original: UNNotificationContent) async -> UNNotificationContent? {
        let info = original.userInfo
        guard let e2e = info["e2e"] as? String, let hostId = info["hostId"] as? String, let session = info["sessionId"] as? String,
              let kind = info["kind"] as? String, ["reply", "question"].contains(kind),
              let encoded = Keychain.get(hostId + "/e2e"), let secret = Data(base64Encoded: encoded),
              let value = try? PushCrypto.open(e2e, secret: secret, hostId: hostId, session: session, kind: kind),
              let content = original.mutableCopy() as? UNMutableNotificationContent else { return nil }
        content.title = value.title
        content.body = value.body
        var userInfo = info
        userInfo["e2e"] = nil
        if kind == "question", let question = value.question, let item = question.item {
            let options = question.options ?? []
            userInfo["question"] = ["id": question.id, "item": item, "options": options]
            content.categoryIdentifier = await NotificationCategories.optionsCategory(options) ?? NotificationCategories.question
        } else if kind == "reply", value.reply == true {
            content.categoryIdentifier = NotificationCategories.reply
        }
        content.userInfo = userInfo
        return content
    }
}
