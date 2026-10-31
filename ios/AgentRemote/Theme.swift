import SwiftUI

/// One small color and shape vocabulary for the app (L-1). Each color has one meaning:
/// accent = the app's own actions and highlights, needsYou = waiting on the user,
/// failure = something broke, info = quiet secondary state, caution = risk disclosures.
enum Theme {
    static let accent = Color.mint
    static let needsYou = Color.orange
    static let failure = Color.red
    static let caution = Color.yellow
    static let info = Color.secondary
    static let success = Color.green
    /// Background of the user's own messages, so your turns read apart from the agent's (L-3).
    static let userBubble = Color.mint.opacity(0.14)
    static let cardCorner: CGFloat = 12
    static let bubbleCorner: CGFloat = 16
    /// Minimum tap target (Apple HIG).
    static let tapTarget: CGFloat = 44
}
