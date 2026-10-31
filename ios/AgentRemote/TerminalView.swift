import SwiftUI
import WebKit

struct TerminalFrame: Decodable {
    var cols: Int?; var rows: Int?
    var sharedInput: Bool?; var inputRevision: Int?
    var seq: Int; var reset: Bool; var data: String; var owner: String; var generation: Int; var ended: Bool
}
@MainActor final class TerminalModel: ObservableObject {
    let web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    @Published var owner = "desktop"
    @Published var ended = false
    @Published var error: String?
    @Published var sending = false
    var seq = 0
    var generation = 0
    init() {
        web.isOpaque = false; web.backgroundColor = .black
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "TerminalAssets") { web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }
    }
    private struct PendingPrompt {
        let id: String
        let text: String
        let generation: Int
        var pasted = false
    }
    private var pendingPrompt: PendingPrompt?
    private var pendingShared: (id: String, text: String, revision: Int)?
    private func ready(_ frame: TerminalFrame) async throws -> Bool {
        for _ in 0..<100 {
            if !web.isLoading, web.url != nil { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        let result: Any = try await withCheckedThrowingContinuation { continuation in
            web.callAsyncJavaScript("return await window.applyFrame(frame)", arguments: ["frame": ["reset": frame.reset, "data": frame.data, "cols": frame.cols ?? 80, "rows": frame.rows ?? 28]], in: nil, in: .page) { result in continuation.resume(with: result) }
        }
        let value = result as? [String: Any]
        return value?["ready"] as? Bool == true
    }
    func sendPrompt(_ text: String, requestID: String, api: API, path: String) async throws {
        // Keep the generation and input IDs on ambiguous network retries. A
        // second Send must not paste the same message twice or press Enter twice.
        if let pendingPrompt, pendingPrompt.id != requestID {
            throw AppError.message("The previous send may be partly entered. Retry that message, or finish it in Terminal controls and reopen this chat.")
        }
        if let pending = pendingShared {
            guard pending.id == requestID && pending.text == text else { throw AppError.message("Retry the original message before changing it.") }
            try await sendShared(pending, api: api, path: path); return
        }
        if pendingPrompt == nil {
            let detail = try await api.get(path, as: SessionDetail.self)
            guard !["running", "waiting", "submitting"].contains(detail.session.status) else { throw AppError.message("Claude is still working or waiting for an answer.") }
            let frame = try await api.get(path + "/terminal", as: TerminalFrame.self)
            guard !frame.ended else { throw AppError.message("This terminal has ended. Resume the chat on your Mac.") }
            if frame.sharedInput == true {
                let pending = (id: requestID, text: text, revision: frame.inputRevision ?? 0)
                pendingShared = pending
                try await sendShared(pending, api: api, path: path); return
            }
            guard try await ready(frame) else { throw AppError.message("Claude on your Mac has unsent text or is asking something. Open Terminal controls from the menu to finish it there, then send again.") }
            let controlData = try await api.request(path + "/terminal/control", method: "POST", body: [:])
            guard let control = try JSONSerialization.jsonObject(with: controlData) as? [String: Any], let generation = control["generation"] as? Int else { throw AppError.message("Could not take input control.") }
            // Recheck after taking control: desktop keystrokes arriving before
            // the handoff must not become part of the phone's message.
            let current = try await api.get(path + "/terminal", as: TerminalFrame.self)
            guard current.generation == generation, current.owner == "you", try await ready(current) else { throw AppError.message("The desktop input changed. Check Terminal controls before sending.") }
            pendingPrompt = PendingPrompt(id: requestID, text: text, generation: generation)
        }
        guard var pending = pendingPrompt, pending.text == text else { throw AppError.message("Retry the original message before changing it.") }
        func write(_ value: String, suffix: String) async throws {
            _ = try await api.request(path + "/terminal/input", method: "POST", body: ["generation": pending.generation, "requestId": pending.id + suffix, "data": Data(value.utf8).base64EncodedString()])
        }
        if !pending.pasted {
            let clean = text.replacingOccurrences(of: "\u{1b}", with: "")
            try await write("\u{1b}[200~" + clean + "\u{1b}[201~", suffix: "-paste")
            pending.pasted = true; pendingPrompt = pending
        }
        try await Task.sleep(for: .milliseconds(180))
        try await write("\r", suffix: "-enter")
        pendingPrompt = nil
    }
    private func sendShared(_ pending: (id: String, text: String, revision: Int), api: API, path: String) async throws {
        do {
            _ = try await api.request(path + "/terminal/input", method: "POST", body: ["requestId": pending.id, "prompt": pending.text, "inputRevision": pending.revision])
            pendingShared = nil
        } catch {
            // Definitive rejection did not insert any input. Network ambiguity
            // retains the same request ID and revision for safe retry.
            if error.localizedDescription.contains("terminal input changed") { pendingShared = nil }
            throw error
        }
    }
    func refresh(_ api: API, _ path: String) async {
        guard !web.isLoading else { return }
        do {
            let data = try await api.request(path + "?after=\(seq)")
            let frame = try JSONDecoder().decode(TerminalFrame.self, from: data)
            // Only JSON data enters the bundled renderer. No terminal text becomes HTML.
            let object: [String: Any] = ["reset": frame.reset, "data": frame.data, "cols": frame.cols ?? 80, "rows": frame.rows ?? 28]
            let json = String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
            _ = try await web.evaluateJavaScript("window.frame(\(json))")
            seq = frame.seq; generation = frame.generation; owner = frame.owner; ended = frame.ended
        } catch { self.error = error.localizedDescription }
    }
    func control(_ api: API, _ path: String) async {
        guard !sending else { return }; sending = true; defer { sending = false }
        do { let data = try await api.request(path + "/control", method: "POST", body: [:]); let value = try JSONSerialization.jsonObject(with: data) as? [String: Any]; generation = value?["generation"] as? Int ?? 0; owner = "you"; error = nil } catch { self.error = error.localizedDescription }
    }
    func input(_ text: String, _ api: API, _ path: String) async -> Bool {
        guard !sending, !ended else { return false }
        sending = true; defer { sending = false }
        do {
            _ = try await api.request(path + "/input", method: "POST", body: ["generation": generation, "requestId": UUID().uuidString, "data": Data(text.utf8).base64EncodedString()]); error = nil; return true
        } catch { self.error = error.localizedDescription + " Check the terminal before retrying."; return false }
    }
}
private struct TerminalWeb: UIViewRepresentable {
    let web: WKWebView
    func makeUIView(context: Context) -> WKWebView { web }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
struct TerminalView: View {
    let session: Session
    let host: Host
    @StateObject private var model = TerminalModel()
    @Environment(\.scenePhase) private var phase
    @State private var text = ""
    private var api: API { API(host: host) }
    private var path: String { API.sessionPath(session.id) + "/terminal" }
    var body: some View {
        VStack(spacing: 8) {
            Text(model.ended ? "Terminal ended" : "Same live chat on your Mac and phone").font(.caption).foregroundStyle(.secondary).padding(.horizontal)
            TerminalWeb(web: model.web)
            if let error = model.error { Text(error).font(.caption).foregroundStyle(Theme.failure).padding(.horizontal) }
            ScrollView(.horizontal) {
                HStack {
                    key("↑", "\u{1b}[A"); key("↓", "\u{1b}[B"); key("←", "\u{1b}[D"); key("→", "\u{1b}[C")
                    key("Tab", "\t"); key("Space", " "); key("⌫", "\u{7f}"); key("Esc", "\u{1b}"); key("Ctrl-C", "\u{3}")
                }.buttonStyle(.bordered).padding(.horizontal)
            }.disabled(model.ended || model.sending)
            HStack {
                TextField("Type into terminal", text: $text, axis: .vertical).lineLimit(1...4).textFieldStyle(.roundedBorder).autocorrectionDisabled()
                Button("Type") { let value = text; Task { if await model.input("\u{1b}[200~" + value.replacingOccurrences(of: "\u{1b}", with: "") + "\u{1b}[201~", api, path) { text = "" } } }
                key("Enter", "\r").buttonStyle(.bordered)
            }.padding(.horizontal).disabled(model.ended || model.sending)
            Text("Type inserts text; Enter submits. You can also type directly on your Mac.").font(.caption2).foregroundStyle(.secondary).padding(.bottom, 4)
        }
        .navigationTitle("Live terminal").navigationBarTitleDisplayMode(.inline)
        .task(id: phase) { guard phase == .active else { return }; while !Task.isCancelled { await model.refresh(api, path); try? await Task.sleep(for: .milliseconds(350)) } }
    }
    private func key(_ title: String, _ value: String) -> some View { Button(title) { Task { _ = await model.input(value, api, path) } } }
}
