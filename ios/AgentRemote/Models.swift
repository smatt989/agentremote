import Foundation
import Security
import UIKit
import UserNotifications
import CryptoKit

struct Host: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var endpoint: String
    var transport: String?
    var relayHost: String?
    var deviceId: String?
}
struct Session: Codable, Identifiable, Hashable {
    var id: String
    var provider: String
    var title: String
    var cwd: String
    var status: String
    var control: String?
    var note: String?
    var lastCompletedAt: Double?
    var lastCompletedRole: String?
    var latestAssistantMessageId: String?
    var latestAssistantToken: String?
    var unread: Bool?
    var updatedAt: Double
    var external: Bool?
    var terminal: Bool?
    var model: String?
    var effort: String?
    var effectiveModel: String?
    var usage: SessionUsage?
    var rateLimit: RateLimitPause?
    var compaction: CompactionState?
    var authRequired: Bool?
    /// Follow-ups waiting to be sent after the current turn (newer Macs; nil on older ones).
    var queued: Int?
}
struct Message: Codable, Identifiable, Equatable {
    var id: String
    var requestId: String?
    var role: String
    var kind: String
    var text: String
    var seq: Int?
    var details: String?
    var important: Bool?
    var images: [Artifact]?
    var partial: Bool?
    var completedAt: Double?
    var createdAt: Double?
    /// A follow-up sent while the agent was working; false once delivered (newer Macs).
    var queued: Bool?
    func precedes(_ other: Message) -> Bool {
        let a = completedAt ?? createdAt ?? 0, b = other.completedAt ?? other.createdAt ?? 0
        return a == b ? (seq ?? 0) < (other.seq ?? 0) : a < b
    }
}
struct ArtifactInfo: Decodable { var size: Int; var chunk: Int }
struct Artifact: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var mime: String
    /// The assistant message that produced the file (newer Macs), and its size in bytes when the Mac sends it.
    var messageId: String?
    var size: Int?
}
struct SessionList: Codable { var sessions: [Session]; var warnings: [String]; var claudeAuth: ClaudeAuthStatus?; var etag: String? }
/// `GET /sessions?etag=` on a 0.7.8+ Mac answers `{unchanged, etag}` when the list is the same; older Macs send the list.
struct SessionListPoll: Decodable { var unchanged: Bool?; var etag: String? }
/// Claude Code's login on the Mac. `state` is ok, expiring (within 3 days), expired, or unknown; `expiresAt` is epoch ms.
struct ClaudeAuthStatus: Codable, Hashable { var state: String; var expiresAt: Double?; var login: ClaudeLogin? }
struct ClaudeLogin: Codable, Hashable { var id: String; var url: String?; var state: String }
struct ClaudeLoginStart: Decodable { var id: String; var url: String }
struct ClaudeLoginResult: Decodable { var ok: Bool; var claudeAuth: ClaudeAuthStatus? }
struct SessionDetail: Decodable {
    var session: Session; var messages: [Message]; var artifacts: [Artifact]?; var warning: String?; var questions: [AgentQuestion]?; var nextBefore: Int?
    // 0.7.8+ Macs: a revision cursor for `?since=` polls. A reply with `delta` holds only rows changed since then.
    var cursor: Int?; var delta: Bool?; var removed: [String]?; var important: [String]?
    var images: [String: [Artifact]]?; var artifactsHash: String?; var imagesHash: String?
}
struct QuestionOption: Codable, Hashable { var label: String; var description: String? }
struct QuestionItem: Codable, Identifiable, Equatable { var id: String; var title: String; var options: [QuestionOption]; var multiSelect: Bool? }
struct AgentQuestion: Codable, Identifiable, Equatable { var id: String; var questions: [QuestionItem]; var state: String; var native: Bool?; var readOnly: Bool?; var choiceOnly: Bool? }
struct MemoryEntry: Codable, Identifiable { var id: String; var text: String; var topic: String?; var trust: String?; var quote: String?; var sourceSession: String? }
struct MemoryResult: Decodable { var results: [MemoryEntry]; var warning: String? }
struct PairResponse: Decodable { var token: String; var hostId: String; var name: String }
struct EmptyResponse: Decodable {}
struct ReadResponse: Decodable { var session: Session }
/// `GET /agents` on newer Macs: which agent CLIs are installed there, and signed in (nil when unknown).
struct AgentAvailability: Codable, Identifiable, Hashable { var id: String; var name: String; var installed: Bool; var signedIn: Bool? }
struct AgentAvailabilityList: Decodable { var agents: [AgentAvailability] }
/// `GET /folders/recent` on newer Macs: the home folder and recently used working folders (`lastUsed` is epoch ms).
struct RecentFolder: Codable, Hashable { var path: String; var label: String; var lastUsed: Double }
struct RecentFolders: Codable, Equatable { var home: String; var folders: [RecentFolder] }
/// `POST /pairing/invite` on newer Macs: a one-time `agentremote://pair#…` link for another device.
struct PairingInvite: Decodable {
    var uri: String; var expires: Double
    /// Epoch ms like the rest of the service; tolerate seconds too.
    var expiresAt: Date { Date(timeIntervalSince1970: expires > 100_000_000_000 ? expires / 1000 : expires) }
}
struct ModelDefaults: Codable, Equatable {
    var codex = ""
    var claude = ""
    var local = ""
    var localProvider = "ollama"
    func model(for provider: String) -> String { provider == "codex" ? codex : provider == "claude" ? claude : local }
    var body: [String: Any] { ["codex": codex, "claude": claude, "local": local, "localProvider": localProvider] }
}
/// What the new-chat form offers for one Mac. Kept on the device so the form opens filled in at once; it is fetched
/// again in the background each time. `agents` and `recent` are nil for Macs without those routes.
struct NewChatOptions: Codable, Equatable {
    var defaults = ModelDefaults()
    var agents: [AgentAvailability]?
    var recent: RecentFolders?
    var catalogs: [String: AgentModelCatalog] = [:]
}
extension Session {
    var deletionMessage: String {
        "Permanently delete this chat from the Mac and remove its Agent Remote attachments? " +
        (provider == "codex" ? "Chats it spawned will also be deleted. " : "") +
        "Learned memory from this chat is also removed. Project working files are kept. This cannot be undone."
    }
}

/// Applies a `?since=` delta to the conversation already on screen.
enum ConversationMerge {
    /// Upserts changed rows, drops removed ids, applies the saved-response ids and (when sent) the session's image
    /// placements, and orders rows by the service's key (time, then seq), so the result equals a fresh full page.
    /// While older history is still unloaded (`hasOlder`), a new row older than the loaded window is left for
    /// "Load earlier", so paging never skips a gap.
    static func apply(_ current: [Message], _ delta: SessionDetail, hasOlder: Bool) -> [Message] {
        var byID = Dictionary(current.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        for id in delta.removed ?? [] { byID[id] = nil }
        let oldest = hasOlder ? current.first : nil
        for message in delta.messages {
            if byID[message.id] == nil, let oldest, message.precedes(oldest) { continue }
            byID[message.id] = message
        }
        var merged = Array(byID.values)
        if let important = delta.important.map(Set.init) { for i in merged.indices { merged[i].important = important.contains(merged[i].id) } }
        if let images = delta.images { for i in merged.indices { let placed = images[merged[i].id]; merged[i].images = placed?.isEmpty == false ? placed : nil } }
        return merged.sorted { $0.precedes($1) }
    }
}

/// What a conversation looked like when it was last shown, so reopening it is instant.
struct ConversationSnapshot: Codable {
    var version = 1
    var session: Session
    var messages: [Message]
    var artifacts: [Artifact]
    var cursor: Int?
    var artifactsHash: String?
    var imagesHash: String?
    var earlierCursor: Int?
    var hasOlder: Bool
}

/// On-device cache of conversations and session lists, in Caches/AgentRemote (purgeable, not backed up).
/// One file per paired Mac and conversation, newest 300 rows and at most 3 MB each, 64 MB in total with
/// least-recently-used eviction. It holds only what the app already displayed. A file that fails to decode
/// is deleted and the conversation is fetched again. Re-pairing a Mac or a "pair again" error clears that Mac's files.
enum LocalCache {
    static let rowLimit = 300, fileLimit = 3_000_000, totalLimit = 64_000_000
    private static let lock = NSLock()
    private static var memory: [String: ConversationSnapshot] = [:], memoryOrder: [String] = []
    static var root: URL {
        (FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory).appendingPathComponent("AgentRemote/v1", isDirectory: true)
    }
    private static func name(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined() }
    static func folder(host: String) -> URL { root.appendingPathComponent(name(host), isDirectory: true) }
    private static func file(host: String, key: String) -> URL { folder(host: host).appendingPathComponent(name(key) + ".json") }

    static func load<T: Decodable>(_ type: T.Type, host: String, key: String) -> T? {
        let url = file(host: host, key: key)
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let value = try? JSONDecoder().decode(T.self, from: data) else { try? FileManager.default.removeItem(at: url); return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path) // recently used
        return value
    }
    static func save<T: Encodable>(_ value: T, host: String, key: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        let url = file(host: host, key: key)
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            #if targetEnvironment(macCatalyst)
            try data.write(to: url, options: .atomic)
            #else
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #endif
        } catch { return }
        evict()
    }
    /// Encodes, writes and evicts on a serial background queue, so the main actor never waits on disk
    /// and writes for the same key land in the order they were made (L-8).
    private static let writer = DispatchQueue(label: "AgentRemote.LocalCache", qos: .utility)
    static func saveInBackground<T: Encodable>(_ value: T, host: String, key: String) {
        writer.async { save(value, host: host, key: key) }
    }
    static func remove(host: String, key: String) {
        lock.withLock { memory[host + "\u{0}" + key] = nil }
        try? FileManager.default.removeItem(at: file(host: host, key: key))
    }
    static func clear(host: String) {
        lock.withLock { for key in memory.keys where key.hasPrefix(host + "\u{0}") { memory[key] = nil } }
        try? FileManager.default.removeItem(at: folder(host: host))
    }
    /// Deletes least-recently-used files until the cache is under its total limit.
    static func evict() {
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]) else { return }
        var files: [(url: URL, size: Int, date: Date)] = []
        for case let url as URL in enumerator {
            guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]), values.isRegularFile == true else { continue }
            files.append((url, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast))
        }
        var total = files.reduce(0) { $0 + $1.size }
        for entry in files.sorted(by: { $0.date < $1.date }) where total > totalLimit { try? FileManager.default.removeItem(at: entry.url); total -= entry.size }
    }

    // Conversations are also kept decoded in memory (a few), since SwiftUI may rebuild the view many times.
    static func conversation(host: String, session: String) -> ConversationSnapshot? {
        let key = host + "\u{0}" + session
        if let hit = remembered(host: host, session: session) { return hit }
        guard let value = load(ConversationSnapshot.self, host: host, key: "conversation:" + session), value.version == 1 else { return nil }
        remember(value, key: key)
        return value
    }
    /// Only the in-memory copy: cheap enough for a view's init, unlike `conversation`, which may read and decode a file.
    static func remembered(host: String, session: String) -> ConversationSnapshot? {
        lock.withLock { memory[host + "\u{0}" + session] }
    }
    static func storeConversation(_ snapshot: ConversationSnapshot, host: String) {
        var value = snapshot
        // Bound the file: keep the newest rows; anything trimmed is fetched again by "Load earlier".
        if value.messages.count > rowLimit { value.messages = Array(value.messages.suffix(rowLimit)); value.hasOlder = true; value.earlierCursor = value.messages.first?.seq }
        while value.messages.count > 20, ((try? JSONEncoder().encode(value))?.count ?? 0) > fileLimit {
            value.messages.removeFirst(value.messages.count / 4); value.hasOlder = true; value.earlierCursor = value.messages.first?.seq
        }
        remember(value, key: host + "\u{0}" + snapshot.session.id)
        save(value, host: host, key: "conversation:" + snapshot.session.id)
    }
    private static func remember(_ value: ConversationSnapshot, key: String) {
        lock.withLock {
            memory[key] = value; memoryOrder.removeAll { $0 == key }; memoryOrder.append(key)
            while memoryOrder.count > 6 { memory[memoryOrder.removeFirst()] = nil }
        }
    }
}

// `Keychain` (per-Mac token and E2E secret, shared with the Notification Service Extension) is in NotificationSupport.swift.

struct API {
    var host: Host
    func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        if host.transport == "relay" {
            guard let route = host.relayHost, let device = host.deviceId, let token = Keychain.get(host.id), let encoded = Keychain.get(host.id + "/e2e"), let secret = Data(base64Encoded: encoded) else { throw AppError.message("Pair this Mac again to restore the connection.") }
            var value: [String: Any] = ["method": method, "path": path, "token": token]
            if let body { value["body"] = body }
            return try await EncryptedRelay.request(endpoint: host.endpoint, host: route, channel: device, secret: secret, value: value)
        }
        guard let url = URL(string: host.endpoint + path), url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? "")) else {
            throw AppError.message("The saved direct connection address is invalid. Pair using your Mac’s QR code.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 40
        if let token = Keychain.get(host.id) { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body); request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let details = (try? JSONSerialization.jsonObject(with: data)) as? [String: String]
            throw AppError.message(details?["error"] ?? "Your Mac couldn’t finish this request. Check that Agent Remote is running on the Mac, then pull to refresh or try again.")
        }
        return data
    }
    /// Saves an artifact to a temporary file. Each relay reply is one encrypted packet, so the file arrives in
    /// byte ranges (two in flight, each retried) and is never held in memory whole. Macs older than 0.7.6 have
    /// no /info route and send the file in one piece, as before.
    func download(_ artifact: Artifact, progress: ((Double) -> Void)? = nil) async throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(artifact.id)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent((artifact.name as NSString).lastPathComponent)
        guard let info = try? await get("/artifacts/\(artifact.id)/info", as: ArtifactInfo.self), info.chunk > 0 else {
            try await request("/artifacts/" + artifact.id).write(to: url, options: .atomic); return url
        }
        let partial = url.appendingPathExtension("partial")
        try? FileManager.default.removeItem(at: partial)
        guard FileManager.default.createFile(atPath: partial.path, contents: nil) else { throw AppError.message("Could not save \(artifact.name) on this device.") }
        let handle = try FileHandle(forWritingTo: partial)
        let chunks = (info.size + info.chunk - 1) / info.chunk
        var next = 0, received = 0
        func chunk(_ index: Int) async throws -> (Int, Data) {
            let offset = index * info.chunk, expected = min(info.chunk, info.size - offset)
            for attempt in 1...3 {
                do {
                    let data = try await request("/artifacts/\(artifact.id)?offset=\(offset)&length=\(info.chunk)")
                    guard data.count == expected else { throw AppError.message("\(artifact.name) changed on the Mac while downloading. Try again.") }
                    return (offset, data)
                } catch is CancellationError { throw CancellationError() }
                catch { if attempt == 3 { throw error }; try await Task.sleep(for: .seconds(attempt)) }
            }
            throw CancellationError()
        }
        do {
            try await withThrowingTaskGroup(of: (Int, Data).self) { group in
                while next < min(2, chunks) { let index = next; group.addTask { try await chunk(index) }; next += 1 }
                while let (offset, data) = try await group.next() {
                    try handle.seek(toOffset: UInt64(offset)); try handle.write(contentsOf: data)
                    received += data.count; progress?(Double(received) / Double(max(info.size, 1)))
                    if next < chunks { let index = next; group.addTask { try await chunk(index) }; next += 1 }
                }
            }
            try handle.close()
        } catch { try? handle.close(); try? FileManager.default.removeItem(at: partial); throw error }
        try? FileManager.default.removeItem(at: url)
        try FileManager.default.moveItem(at: partial, to: url)
        return url
    }
    func get<T: Decodable>(_ path: String, as: T.Type) async throws -> T { try API.decode(T.self, from: await request(path)) }
    func post<T: Decodable>(_ path: String, body: [String: Any], as: T.Type) async throws -> T { try API.decode(T.self, from: await request(path, method: "POST", body: body)) }
    /// A reply this build cannot decode almost always means the Mac and the app are on different versions.
    static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) }
        catch is DecodingError { throw AppError.message("Your Mac sent a reply this app doesn’t understand. Update Agent Remote on your Mac and on this device, then try again.") }
    }
    static func sessionPath(_ id: String) -> String { "/sessions/" + id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)! }
    /// A Mac from before a route existed answers 404 "Route not found." (directly and through the relay).
    static func isUnsupported(_ error: Error) -> Bool {
        if case AppError.message(let text) = error { return text == "Route not found." }
        return false
    }
    /// The model list for an agent. The Mac serves it per conversation (`/sessions/:id/models`, keyed only by the
    /// conversation's agent), so this asks through any chat of that agent. Claude's aliases are known without one.
    func modelCatalog(_ provider: String, sessions: [Session]) async -> AgentModelCatalog? {
        if let session = sessions.first(where: { $0.provider == provider }),
           let catalog = try? await get(API.sessionPath(session.id) + "/models", as: AgentModelCatalog.self), !catalog.models.isEmpty { return catalog }
        guard provider == "claude" else { return nil }
        return AgentModelCatalog(models: ["opus", "sonnet", "haiku"].map { AgentModelChoice(id: $0, name: $0.capitalized, efforts: ["low", "medium", "high", "xhigh", "max"]) }, note: nil)
    }
}

@MainActor final class AppState: ObservableObject {
    @Published var hosts: [Host] = []
    @Published var selectedHostID: String?
    @Published var sessions: [Session] = []
    @Published var warnings: [String] = []
    @Published var error: String?
    @Published var pairingCode: String?
    @Published var notificationSessionID: String?
    @Published var claudeAuth: ClaudeAuthStatus?
    @Published var claudeSignIn = false
    var visibleSessionID: String?
    var host: Host? { hosts.first { $0.id == selectedHostID } }
    var api: API? { host.map { API(host: $0) } }
    init() {
        if let data = UserDefaults.standard.data(forKey: "hosts"), let saved = try? JSONDecoder().decode([Host].self, from: data) { hosts = saved }
        selectedHostID = hosts.first?.id
        // Show the last list right away; refresh() brings it up to date.
        if let host, let cached = LocalCache.load(SessionList.self, host: host.id, key: "sessions") { sessions = cached.sessions; warnings = cached.warnings; claudeAuth = cached.claudeAuth }
        if let host { chatOptions[host.id] = LocalCache.load(NewChatOptions.self, host: host.id, key: "new-chat") }
        ReplyNotifications.shared.state = self
    }
    func pair(code: String) async throws {
        let invite = try RelayInvite.parse(code)
        let (response, secret) = try await EncryptedRelay.pair(invite, name: Platform.deviceName)
        try Keychain.put(response.token, host: response.hostId)
        try Keychain.put(secret.base64EncodedString(), host: response.hostId + "/e2e")
        LocalCache.clear(host: response.hostId); sessionsETag[response.hostId] = nil; chatOptions[response.hostId] = nil
        let host = Host(id: response.hostId, name: response.name, endpoint: invite.relay, transport: "relay", relayHost: invite.host, deviceId: response.deviceId)
        hosts.removeAll { $0.id == host.id }; hosts.append(host); selectedHostID = host.id
        UserDefaults.standard.set(try JSONEncoder().encode(hosts), forKey: "hosts")
        pairingCode = nil; await refresh()
    }
    func pair(endpoint: String, code: String) async throws {
        let trimmed = endpoint.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: trimmed), url.host != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty else { throw AppError.message("Enter just the Mac’s HTTPS address, without a path or password.") }
        let provisional = Host(id: UUID().uuidString, name: "Mac", endpoint: trimmed)
        let response = try await API(host: provisional).post("/pair", body: ["code": code.trimmingCharacters(in: .whitespacesAndNewlines), "name": "iPhone"], as: PairResponse.self)
        try Keychain.put(response.token, host: response.hostId)
        LocalCache.clear(host: response.hostId); sessionsETag[response.hostId] = nil; chatOptions[response.hostId] = nil
        let host = Host(id: response.hostId, name: response.name, endpoint: trimmed)
        hosts.removeAll { $0.id == host.id }; hosts.append(host); selectedHostID = host.id
        UserDefaults.standard.set(try JSONEncoder().encode(hosts), forKey: "hosts")
        await refresh()
    }
    private var sessionsETag: [String: String] = [:]
    /// Macs whose service has no rename route; Rename is hidden for them until the app restarts.
    @Published var renameUnsupported: Set<String> = []
    /// `POST /sessions/:id/title`, then updates the list and its on-device copy.
    func rename(_ session: Session, to title: String, host: Host) async throws -> Session {
        do {
            let renamed = try await API(host: host).post(API.sessionPath(session.id) + "/title", body: ["title": title], as: ReadResponse.self).session
            if selectedHostID == host.id, let index = sessions.firstIndex(where: { $0.id == renamed.id }) {
                sessions[index] = renamed; sessionsETag[host.id] = nil
                LocalCache.saveInBackground(SessionList(sessions: sessions, warnings: warnings, claudeAuth: claudeAuth), host: host.id, key: "sessions")
            }
            return renamed
        } catch {
            guard API.isUnsupported(error) else { throw error }
            renameUnsupported.insert(host.id)
            throw AppError.message("Renaming needs a newer Agent Remote on \(host.name). Update it on the Mac, then try again.")
        }
    }
    /// The new-chat form's choices per Mac, so the form opens filled in. `refreshChatOptions` updates them from the Mac.
    @Published private(set) var chatOptions: [String: NewChatOptions] = [:]
    private var chatOptionsLoading: Set<String> = []
    /// Fetches the form's choices (skipped while a fetch for that Mac is in flight). A choice the Mac does not answer
    /// keeps its previous value; a failed model-defaults request is rethrown after the rest is saved.
    func refreshChatOptions(_ host: Host) async throws {
        if chatOptions[host.id] == nil, let cached = LocalCache.load(NewChatOptions.self, host: host.id, key: "new-chat") { chatOptions[host.id] = cached }
        guard chatOptionsLoading.insert(host.id).inserted else { return }
        defer { chatOptionsLoading.remove(host.id) }
        let api = API(host: host), previous = chatOptions[host.id], known = selectedHostID == host.id ? sessions : []
        async let available = try? api.get("/agents", as: AgentAvailabilityList.self)
        async let folders = try? api.get("/folders/recent", as: RecentFolders.self)
        async let claude = api.modelCatalog("claude", sessions: known)
        async let codex = api.modelCatalog("codex", sessions: known)
        var failure: Error?, next = previous ?? NewChatOptions()
        do { next.defaults = try await api.get("/settings/models", as: ModelDefaults.self) } catch { failure = error }
        if let agents = await available?.agents, !agents.isEmpty { next.agents = agents }
        if let recent = await folders { next.recent = recent }
        if let catalog = await claude { next.catalogs["claude"] = catalog }
        if let catalog = await codex { next.catalogs["codex"] = catalog }
        if next != previous { chatOptions[host.id] = next; LocalCache.saveInBackground(next, host: host.id, key: "new-chat") }
        if let failure { throw failure }
    }

    /// Chats opened before the Mac has made them, by provisional id (`pendingPrefix`). The new-chat form opens the
    /// chat at once; the conversation waits on `createdChat` before its first request, and sending retries a failure.
    static let pendingPrefix = "pending:"
    private struct PendingChat { var body: [String: Any]; var host: Host; var task: Task<Session, Error>?; var failure: Error? }
    private var pendingChats: [String: PendingChat] = [:]
    /// Provisional id → the Mac's id, once created (the Mac sidebar keeps the provisional chat selected).
    @Published private(set) var createdChats: [String: String] = [:]
    func startChat(_ body: [String: Any], provider: String, title: String, cwd: String, model: String?, host: Host) -> Session {
        let session = Session(id: Self.pendingPrefix + UUID().uuidString, provider: provider, title: title.isEmpty ? "New chat" : title, cwd: cwd,
                              status: "idle", updatedAt: Date().timeIntervalSince1970 * 1000, model: model)
        pendingChats[session.id] = PendingChat(body: body, host: host)
        _ = creation(session.id, retry: true)
        return session
    }
    private func creation(_ id: String, retry: Bool) -> Task<Session, Error>? {
        guard var pending = pendingChats[id] else { return nil }
        if let task = pending.task { return task }
        if pending.failure != nil, !retry { return nil }
        let api = API(host: pending.host), body = pending.body, hostID = pending.host.id
        let task = Task { () throws -> Session in
            let session = try await api.post("/sessions", body: body, as: Session.self)
            if self.selectedHostID == hostID { self.sessions.removeAll { $0.id == session.id }; self.sessions.insert(session, at: 0) }
            return session
        }
        pending.task = task; pending.failure = nil; pendingChats[id] = pending
        return task
    }
    /// The Mac's session for a provisional chat. After a failure it throws that failure again unless `retry` is set.
    func createdChat(_ id: String, retry: Bool) async throws -> Session {
        guard let task = creation(id, retry: retry) else { throw pendingChats[id]?.failure ?? AppError.message("This chat was not started.") }
        do {
            let session = try await task.value
            createdChats[id] = session.id
            return session
        } catch {
            if pendingChats[id]?.task == task { pendingChats[id]?.task = nil; pendingChats[id]?.failure = error }
            throw error
        }
    }

    func refresh() async {
        guard let api else { return }
        let hostID = api.host.id
        do {
            if sessions.isEmpty, let cached = LocalCache.load(SessionList.self, host: hostID, key: "sessions") { sessions = cached.sessions }
            // With the etag of the list on screen, a 0.7.8+ Mac answers "unchanged" in a few bytes.
            let data = try await api.request("/sessions" + (sessionsETag[hostID].map { "?etag=" + $0 } ?? ""))
            guard selectedHostID == hostID else { return }
            if let poll = try? JSONDecoder().decode(SessionListPoll.self, from: data), poll.unchanged == true { error = nil; return }
            let result = try API.decode(SessionList.self, from: data)
            sessionsETag[hostID] = result.etag
            if sessions != result.sessions { sessions = result.sessions }
            if claudeAuth != result.claudeAuth { claudeAuth = result.claudeAuth }
            if warnings != result.warnings { warnings = result.warnings }
            ReplyNotifications.shared.observe(result.sessions, host: api.host); error = nil
            LocalCache.saveInBackground(result, host: hostID, key: "sessions")
        }
        catch is CancellationError {} catch {
            if case AppError.message(let text) = error, text.hasPrefix("Pair this") { LocalCache.clear(host: hostID); sessionsETag[hostID] = nil }
            self.error = error.localizedDescription
        }
    }
}

struct SessionUsage: Codable, Hashable {
    var contextTokens: Double?; var contextWindow: Double?; var totalTokens: Double?; var updatedAt: Double?
}
struct UsageWindow: Codable, Hashable { var name: String; var usedPercent: Double?; var resetAt: Double? }
struct UsageLimits: Codable, Hashable { var windows: [UsageWindow]; var updatedAt: Double? }
struct CompactionState: Codable, Hashable { var state: String; var updatedAt: Double? }
struct RateLimitPause: Codable, Hashable { var id: String; var message: String; var resetAt: Double?; var decision: String }
struct SessionPreferences: Codable { var autoRetry: Bool }
struct UsageResponse: Decodable { var usage: SessionUsage?; var limits: UsageLimits?; var compaction: CompactionState?; var rateLimit: RateLimitPause?; var preferences: SessionPreferences; var warning: String?; var autoCompaction: String }
struct AgentModelChoice: Codable, Equatable, Identifiable { var id: String; var name: String; var efforts: [String]; var defaultEffort: String? }
struct AgentModelCatalog: Codable, Equatable { var models: [AgentModelChoice]; var note: String? }

struct PushStatus: Decodable { var configured: Bool; var enabled: Bool? }

@MainActor final class ReplyNotifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = ReplyNotifications()
    weak var state: AppState?
    @Published var statusMessage = "Get an alert when a reply finishes. Alerts always work while the app is open."
    private var observed: [String: String] = [:]
    private var initializedHosts = Set<String>()
    private var deviceToken: String?
    var enabled: Bool { UserDefaults.standard.bool(forKey: "replyNotifications") }
    override init() { super.init(); UNUserNotificationCenter.current().delegate = self }
    func enable(_ value: Bool) async {
        if !value {
            UserDefaults.standard.set(false, forKey: "replyNotifications")
            for host in state?.hosts ?? [] { _ = try? await API(host: host).post("/notifications/device",body:["enabled":false],as:PushStatus.self) }
            statusMessage = "Reply notifications are off."; return
        }
        do {
            guard try await UNUserNotificationCenter.current().requestAuthorization(options:[.alert,.sound,.badge]) else { statusMessage = "Notifications are disabled in iPhone Settings."; return }
            UserDefaults.standard.set(true, forKey: "replyNotifications")
            statusMessage = "Reply alerts are on while the app is open. Checking background notification setup…"
            UIApplication.shared.registerForRemoteNotifications()
            await register()
        } catch { statusMessage = error.localizedDescription }
    }
    func token(_ data: Data) { deviceToken = data.map { String(format:"%02x",$0) }.joined(); Task { await register() } }
    func registrationFailed() { statusMessage = "Lock-screen alerts aren’t available yet for this Mac. You’ll still see replies when the app is open." }
    func register() async {
        guard enabled else { return }
        for host in state?.hosts ?? [] {
            do {
                let api = API(host:host), status = try await api.get("/notifications/status",as:PushStatus.self)
                guard status.configured else { statusMessage = "Lock-screen alerts aren’t available yet for this Mac. You’ll still see replies when the app is open."; continue }
                guard let deviceToken else { continue }
                let environment = Bundle.main.object(forInfoDictionaryKey:"AgentRemotePushEnvironment") as? String ?? "development"
                _ = try await api.post("/notifications/device",body:["enabled":true,"token":deviceToken,"topic":Bundle.main.bundleIdentifier ?? "","environment":environment == "production" ? "production" : "development"],as:PushStatus.self)
                statusMessage = "Reply notifications are enabled, including when your phone is locked."
            } catch { statusMessage = error.localizedDescription }
        }
    }
    func observe(_ sessions: [Session], host: Host) {
        let initial = initializedHosts.insert(host.id).inserted
        for session in sessions {
            guard let token = session.latestAssistantToken else { continue }
            let key = host.id + "/" + session.id
            if initial { observed[key] = token; continue }
            guard !["running","submitting","compacting"].contains(session.status) else { continue }
            let previous = observed.updateValue(token,forKey:key)
            guard enabled, previous != token, session.unread != false, state?.visibleSessionID != session.id else { continue }
            let content = UNMutableNotificationContent();content.title = "Agent Remote";content.body = "Your agent has replied.";content.sound = .default
            content.userInfo = ["hostId":host.id,"sessionId":session.id]
            let request = UNNotificationRequest(identifier:key,content:content,trigger:nil)
            UNUserNotificationCenter.current().add(request) { _ in }
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        Task { @MainActor in
            let session = notification.request.content.userInfo["sessionId"] as? String
            completionHandler(session == state?.visibleSessionID ? [] : [.banner,.sound])
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            // Reply / Answer / option buttons: sent in the background (AgentRemoteApp.swift).
            if NotificationActions.handles(response) { await NotificationActions.perform(response); completionHandler(); return }
            let info = response.notification.request.content.userInfo
            if info["kind"] as? String == "auth", let host = info["hostId"] as? String {
                state?.selectedHostID = host; state?.claudeSignIn = true
            } else if let host = info["hostId"] as? String, let session = info["sessionId"] as? String {
                state?.selectedHostID = host; state?.notificationSessionID = session
            }
            completionHandler()
        }
    }
}
@MainActor final class ReplyNotificationDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey:Any]? = nil) -> Bool {
        NotificationActions.launch()
        if ReplyNotifications.shared.enabled { application.registerForRemoteNotifications() };return true
    }
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) { ReplyNotifications.shared.token(deviceToken) }
    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) { ReplyNotifications.shared.registrationFailed() }
}

enum Platform {
    /// The Mac Catalyst build: a desktop window with a sidebar instead of the phone's push navigation.
    static var isMac: Bool { UIDevice.current.userInterfaceIdiom == .mac }
    /// Shown in the host's device list, so a Mac client can be told apart from the phone and revoked separately.
    static var deviceName: String {
        guard isMac else { return "iPhone" }
        let name = ProcessInfo.processInfo.hostName.replacingOccurrences(of: ".local", with: "")
        return name.isEmpty ? "Mac" : name
    }
}
