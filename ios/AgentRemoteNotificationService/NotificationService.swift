import UserNotifications

/// Replaces the generic alert ("Your agent has replied.") with the chat title and the first line of the reply, or the
/// question and its options, decrypted on this iPhone with the paired Mac's E2E secret (shared Keychain group).
/// Fails closed: if anything is missing or does not verify, the generic alert is shown unchanged.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        lock.withLock { handler = contentHandler; original = request.content }
        Task { finish(await RichNotification.content(for: request.content) ?? request.content) }
    }
    override func serviceExtensionTimeWillExpire() {
        if let original = lock.withLock({ original }) { finish(original) }
    }
    private func finish(_ content: UNNotificationContent) {
        let deliver = lock.withLock { () -> ((UNNotificationContent) -> Void)? in defer { handler = nil }; return handler }
        deliver?(content)
    }
}
