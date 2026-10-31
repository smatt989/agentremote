import SwiftUI

// MARK: - Chat rows (L-2)

/// One chat in the list: its title on one line, then "Claude · ~/dev/project · 3:42 PM", with the chat's state
/// trailing (working, needs you, failed, queued follow-ups, or an unread dot). At accessibility text sizes the
/// same parts stack and wrap instead.
struct SessionRow: View {
    let session: Session
    @Environment(\.dynamicTypeSize) private var textSize

    var body: some View {
        Group {
            if textSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    title
                    Text(details.joined(separator: " · ")).font(.footnote).foregroundStyle(.secondary)
                    status(alignment: .leading)
                }.frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(alignment: .center, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        title.lineLimit(1)
                        detailLine
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    status(alignment: .trailing).fixedSize()
                }
            }
        }
        .padding(.vertical, 1)
        .accessibilityElement(children: .combine)
        .accessibilityValue(session.unread == true ? "Unread reply" : "")
    }

    private var title: some View { Text(session.title).font(.body.weight(.semibold)) }
    private var provider: String { Self.providerName(session.provider) }
    private var folder: String? { Self.shortFolder(session.cwd) }
    private var time: String? { Self.shortTime(session.lastCompletedAt ?? session.updatedAt) }
    private var details: [String] { [provider, folder, time].compactMap { $0 } }

    /// Provider and time keep their width; a long folder gives way, truncated in the middle.
    private var detailLine: some View {
        HStack(spacing: 4) {
            Text(provider).fixedSize()
            if let folder { Text("·"); Text(folder).truncationMode(.middle) }
            if let time { Text("·"); Text(time).fixedSize() }
        }
        .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
    }

    private func status(alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: 3) {
            primaryStatus
            if let queued = session.queued, queued > 0 {
                Text("Queued \(queued)").font(.caption).monospacedDigit().foregroundStyle(.secondary)
                    .accessibilityLabel("\(queued) queued follow-up\(queued == 1 ? "" : "s")")
            }
        }
    }

    @ViewBuilder private var primaryStatus: some View {
        if session.status == "waiting" {
            badge("Needs you", "questionmark.circle.fill", Theme.needsYou)
        } else if session.authRequired == true {
            badge("Sign in", "person.crop.circle.badge.exclamationmark", Theme.needsYou)
        } else if ["running", "submitting", "compacting"].contains(session.status) {
            HStack(spacing: 5) {
                ProgressView().controlSize(.mini).tint(Theme.accent)
                Text(session.status == "compacting" ? "Compacting" : "Working")
            }.font(.caption).foregroundStyle(.secondary)
        } else if ["error", "failed"].contains(session.status) {
            badge("Failed", "exclamationmark.triangle.fill", Theme.failure)
        } else if session.control == "external-live" {
            Text("In another client").font(.caption).foregroundStyle(Theme.info)
        } else if session.unread == true {
            Circle().fill(Theme.accent).frame(width: 10, height: 10).accessibilityHidden(true)
        }
    }

    /// Icon and word together (a Label in a list row may collapse to its icon).
    private func badge(_ text: String, _ icon: String, _ color: Color) -> some View {
        HStack(spacing: 4) { Image(systemName: icon); Text(text) }.font(.caption.weight(.semibold)).foregroundStyle(color)
    }

    static func providerName(_ provider: String) -> String {
        ["claude": "Claude", "codex": "Codex", "local": "Local"][provider] ?? provider.capitalized
    }
    /// "/Users/me/dev/project" → "~/dev/project"; the home folder itself → "~".
    static func shortFolder(_ cwd: String) -> String? {
        let parts = cwd.split(separator: "/")
        guard !parts.isEmpty else { return cwd.isEmpty ? nil : cwd }
        if cwd.hasPrefix("/"), parts.count >= 2, ["Users", "home"].contains(parts[0]) {
            let rest = parts.dropFirst(2)
            return rest.isEmpty ? "~" : "~/" + rest.joined(separator: "/")
        }
        return cwd
    }
    /// "3:42 PM" today, "Yesterday", a weekday within the week, else "Oct 3".
    static func shortTime(_ milliseconds: Double?, now: Date = Date()) -> String? {
        guard let milliseconds, milliseconds > 0 else { return nil }
        let date = Date(timeIntervalSince1970: milliseconds / 1000), calendar = Calendar.current
        if calendar.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if (2..<7).contains(days) { return date.formatted(.dateTime.weekday(.abbreviated)) }
        if !calendar.isDate(date, equalTo: now, toGranularity: .year) { return date.formatted(.dateTime.month(.abbreviated).day().year()) }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

// MARK: - Plan usage (C-9)

/// `GET /usage` on newer Macs: how much of each agent's plan limits is used. Fields are null when unknown;
/// older Macs answer 404 and the feature stays hidden.
struct PlanUsageReport: Decodable, Hashable { var claude: PlanUsage?; var codex: PlanUsage? }
struct PlanUsage: Decodable, Hashable { var fiveHour: PlanWindow?; var sevenDay: PlanWindow?; var updatedAt: Double? }
/// `utilization` is 0...1 (1 = the limit is reached); `resetsAt` is epoch ms.
struct PlanWindow: Decodable, Hashable { var utilization: Double?; var resetsAt: Double? }

struct PlanLimit: Equatable {
    let provider: String, window: String, utilization: Double, resetsAt: Double?
    var percent: Int { Int((max(utilization, 0) * 100).rounded()) }
    var tint: Color { Self.tint(utilization) }
    /// "Claude: 42% of 5-hour limit · resets 4:10 PM"
    var summary: String {
        let used = utilization >= 1 ? "\(window) limit reached" : "\(percent)% of \(window) limit"
        return "\(provider): \(used)" + (PlanLimit.resetText(resetsAt).map { " · resets \($0)" } ?? "")
    }
    static func tint(_ utilization: Double) -> Color { utilization >= 1 ? Theme.failure : utilization >= 0.8 ? Theme.needsYou : Theme.info }
    /// "4:10 PM" today, "Thu 9:00 AM" this week, else "Oct 21".
    static func resetText(_ milliseconds: Double?, now: Date = Date()) -> String? {
        guard let milliseconds else { return nil }
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        guard date > now else { return nil }
        if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if date.timeIntervalSince(now) < 6 * 86_400 { return date.formatted(.dateTime.weekday(.abbreviated).hour().minute()) }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

extension PlanUsageReport {
    var limits: [PlanLimit] {
        [("Claude", claude), ("Codex", codex)].flatMap { name, usage -> [PlanLimit] in
            [("5-hour", usage?.fiveHour), ("weekly", usage?.sevenDay)].compactMap { window, value in
                value?.utilization.map { PlanLimit(provider: name, window: window, utilization: $0, resetsAt: value?.resetsAt) }
            }
        }
    }
    /// The window closest to its limit (Claude first on a tie), which is the one that would stop work soonest.
    var tightest: PlanLimit? { limits.reduce(nil) { best, next in best.map { next.utilization > $0.utilization ? next : $0 } ?? next } }
}

/// Fetches `/usage` for the selected Mac alongside the list poll, at most once a minute. Remembers Macs
/// without the route (404) so they are not asked again until the app restarts.
@MainActor final class UsageMonitor: ObservableObject {
    @Published private(set) var report: PlanUsageReport?
    private var hostID: String?
    private var fetchedAt: Date?
    private var unsupported: Set<String> = []
    func refresh(_ api: API?) async {
        guard let api else { hostID = nil; report = nil; return }
        let id = api.host.id
        if hostID != id { hostID = id; report = nil; fetchedAt = nil }
        guard !unsupported.contains(id), fetchedAt.map({ Date().timeIntervalSince($0) >= 60 }) ?? true else { return }
        fetchedAt = Date()
        do {
            let value = try await api.get("/usage", as: PlanUsageReport.self)
            if hostID == id { report = value }
        } catch {
            guard API.isUnsupported(error) else { return } // keep the last figures through a dropped connection
            unsupported.insert(id); if hostID == id { report = nil }
        }
    }
}

/// The compact line under the list title; hidden until the Mac reports a limit.
struct UsageSummaryLine: View {
    @ObservedObject var usage: UsageMonitor
    let open: () -> Void
    var body: some View {
        if let limit = usage.report?.tightest {
            Button(action: open) {
                HStack(spacing: 5) {
                    Image(systemName: "gauge.with.dots.needle.50percent").imageScale(.small)
                    Text(limit.summary).multilineTextAlignment(.leading)
                    Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .font(.footnote).foregroundStyle(limit.tint)
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 20).padding(.top, 4)
            .accessibilityIdentifier("usageSummary")
            .accessibilityHint("Shows Claude and Codex usage limits")
        }
    }
}

/// Both limit windows for Claude and Codex on the selected Mac.
struct UsageSheet: View {
    @ObservedObject var usage: UsageMonitor
    let hostName: String
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                section("Claude", usage.report?.claude)
                section("Codex", usage.report?.codex)
            }
            .navigationTitle("Usage limits").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
    private func section(_ name: String, _ value: PlanUsage?) -> some View {
        Section {
            let windows = [("5-hour limit", value?.fiveHour), ("Weekly limit", value?.sevenDay)].compactMap { title, window in window?.utilization.map { (title, $0, window?.resetsAt) } }
            if windows.isEmpty { Text("Not reported by \(hostName) yet.").foregroundStyle(.secondary) }
            ForEach(windows, id: \.0) { title, utilization, resetsAt in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(title)
                        Spacer()
                        Text(utilization >= 1 ? "Limit reached" : "\(Int((max(utilization, 0) * 100).rounded()))% used").monospacedDigit().foregroundStyle(utilization >= 0.8 ? PlanLimit.tint(utilization) : .secondary)
                    }
                    ProgressView(value: min(max(utilization, 0), 1)).tint(utilization >= 0.8 ? PlanLimit.tint(utilization) : Theme.accent)
                    if let reset = PlanLimit.resetText(resetsAt) { Text("Resets \(reset)").font(.caption).foregroundStyle(.secondary) }
                }.padding(.vertical, 2).accessibilityElement(children: .combine)
            }
        } header: { Text(name) } footer: {
            if let updated = value?.updatedAt { Text("Updated \(Date(timeIntervalSince1970: updated / 1000).formatted(date: .omitted, time: .shortened))") }
        }
    }
}
