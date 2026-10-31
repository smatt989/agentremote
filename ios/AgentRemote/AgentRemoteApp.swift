import SwiftUI
import UserNotifications

@main struct AgentRemoteApp: App {
    @UIApplicationDelegateAdaptor(ReplyNotificationDelegate.self) private var delegate
    @StateObject private var state = AppState()
    var body: some Scene {
        WindowGroup {
            SessionListView().environmentObject(state).tint(.mint).preferredColorScheme(.dark)
                .onOpenURL { url in if url.scheme == "agentremote", url.host == "pair" { state.pairingCode = url.absoluteString } }
                .onAppear {
                    guard Platform.isMac else { return }
                    MacUpdater.shared.start()
                    for case let scene as UIWindowScene in UIApplication.shared.connectedScenes { scene.sizeRestrictions?.minimumSize = CGSize(width: 760, height: 520) }
                }
        }
    }
}

/// Answering from a notification: the Reply field on a reply alert, and the option buttons or "Answer…" field on a
/// question alert (both set up by the Notification Service Extension after it decrypts the alert). The app may be
/// launched in the background for this, so it reads paired Macs from storage rather than from AppState, sends through
/// the usual API path (end-to-end encrypted over the relay), and posts a local alert if the Mac can't be reached.
@MainActor enum NotificationActions {
    /// At launch: move per-Mac secrets into the shared Keychain group, and register the notification categories.
    static func launch() {
        Keychain.migrateToSharedGroup(accounts: hosts().flatMap { [$0.id, $0.id + "/e2e"] })
        Task { await NotificationCategories.registerFixed() }
    }
    static func hosts() -> [Host] {
        guard let data = UserDefaults.standard.data(forKey: "hosts") else { return [] }
        return (try? JSONDecoder().decode([Host].self, from: data)) ?? []
    }
    static func handles(_ response: UNNotificationResponse) -> Bool {
        let id = response.actionIdentifier
        return id == NotificationCategories.replyAction || id == NotificationCategories.answerAction || id.hasPrefix(NotificationCategories.optionPrefix)
    }
    static func perform(_ response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let action = response.actionIdentifier, typed = (response as? UNTextInputNotificationResponse)?.userText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let hostID = info["hostId"] as? String, let sessionID = info["sessionId"] as? String else { return }
        let isQuestion = action != NotificationCategories.replyAction
        let task = UIApplication.shared.beginBackgroundTask(withName: "Notification answer")
        defer { if task != .invalid { UIApplication.shared.endBackgroundTask(task) } }
        do {
            guard let host = hosts().first(where: { $0.id == hostID }) else { throw AppError.message("This Mac is no longer paired.") }
            let api = API(host: host), path = API.sessionPath(sessionID)
            if isQuestion {
                guard let question = info["question"] as? [String: Any], let id = question["id"] as? String, let item = question["item"] as? String else { throw AppError.message("Open the chat to answer.") }
                let options = question["options"] as? [String] ?? []
                var answer = typed ?? ""
                if action.hasPrefix(NotificationCategories.optionPrefix), let index = Int(action.dropFirst(NotificationCategories.optionPrefix.count)), options.indices.contains(index) { answer = options[index] }
                guard !answer.isEmpty else { return }
                _ = try await api.request(path + "/questions/" + id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)! + "/answer", method: "POST", body: ["answers": [item: answer]])
            } else {
                guard let text = typed, !text.isEmpty else { return }
                _ = try await api.request(path + "/messages", method: "POST", body: ["requestId": UUID().uuidString, "text": text, "attachments": [String]()])
            }
        } catch {
            let content = UNMutableNotificationContent()
            content.title = isQuestion ? "Your answer wasn’t sent" : "Your reply wasn’t sent"
            content.body = error.localizedDescription + " Tap to open the chat."
            content.sound = .default
            content.userInfo = ["hostId": hostID, "sessionId": sessionID]
            try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "send-failed/" + sessionID, content: content, trigger: nil))
        }
    }
}
