import AppKit
import SwiftUI

struct WikiEntry: Decodable, Identifiable, Hashable {
    let id: String; let topic: String; let title: String; let summary: String
    let parent: String?
    let kind: String?
    let pending: Bool?
}
struct WikiLink: Decodable, Identifiable { let id: String; let title: String }
struct WikiPage: Decodable {
    let id: String; let title: String?; let markdown: String; let nextOffset: Int?
    let related: [WikiLink]; let updatedAt: Double
    let breadcrumbs: [WikiLink]?; let children: [WikiLink]?; let backlinks: [WikiLink]?
    let outline: [WikiLink]?; let revision: Int?; let pending: Bool?
}
struct WikiResults: Decodable { let results: [WikiEntry]; let warning: String? }
struct WikiTalkPost: Decodable, Hashable { let role: String; let at: Double; let text: String; let decision: String? }
struct WikiTalkThread: Decodable, Identifiable { let id: String; let kind: String; let status: String; let title: String; let targetTitle: String?; let claims: [String]; let posts: [WikiTalkPost]; let updated: Double }
struct WikiTalk: Decodable { let id: String; let open: Int; let threads: [WikiTalkThread] }
struct WikiTalkResult: Decodable { let talk: WikiTalk? }
struct WikiPosted: Decodable { let ok: Bool }
// Talk pages record how editors (and you) discussed and decided changes to an article.
enum WikiTalkText {
    static func kind(_ kind: String) -> String {
        ["update": "Update requested", "conflict": "Conflicting claims", "stale-claim": "Possibly outdated", "needs-verification": "Verification",
         "misplaced-evidence": "Misplaced claim", "merge-proposal": "Merge proposal", "split-proposal": "Split proposal", "move": "Move proposal",
         "note": "Note", "removal": "Removed from article", "handoff": "Moved here", "curation": "Reorganized", "merged": "Merged article", "comment": "Comment"][kind] ?? kind
    }
    static func role(_ role: String) -> String {
        ["steward": "Article steward", "curator": "Curator", "librarian": "Librarian", "verifier": "Verifier", "reviewer": "Reviewer", "session agent": "Session agent", "user": "You"][role] ?? role
    }
    static func status(_ status: String) -> String { ["open": "Open", "accepted": "Accepted", "declined": "Declined", "resolved": "Recorded"][status] ?? status }
}
struct WikiResult: Decodable { let page: WikiPage? }

enum WikiAPI {
    static func get<T: Decodable>(_ path: String, query: [String: String] = [:]) async throws -> T {
        let directory = ProcessInfo.processInfo.environment["AGENT_REMOTE_STATE"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AgentRemote")
        let token = try String(contentsOf: directory.appendingPathComponent("desktop-token"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let status = try Data(contentsOf: directory.appendingPathComponent("desktop-status.json"))
        let port = (try JSONSerialization.jsonObject(with: status) as? [String: Any])?["port"] as? Int ?? 8787
        var url = URLComponents(string: "http://127.0.0.1:\(port)\(path)")!
        url.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        var request = URLRequest(url: url.url!); request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
            throw NSError(domain: "Knowledge", code: 1, userInfo: [NSLocalizedDescriptionKey: "Couldn’t load the wiki. Make sure Agent Remote is running, then refresh."])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    static func post<T: Decodable>(_ path: String, body: [String: String]) async throws -> T {
        let directory = ProcessInfo.processInfo.environment["AGENT_REMOTE_STATE"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AgentRemote")
        let token = try String(contentsOf: directory.appendingPathComponent("desktop-token"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let status = try Data(contentsOf: directory.appendingPathComponent("desktop-status.json"))
        let port = (try JSONSerialization.jsonObject(with: status) as? [String: Any])?["port"] as? Int ?? 8787
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!); request.httpMethod = "POST"; request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization"); request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw NSError(domain: "Knowledge", code: 2, userInfo: [NSLocalizedDescriptionKey: message ?? "Couldn’t post to the wiki. Make sure Agent Remote is running."])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    static func articleID(_ url: URL) -> String? {
        guard url.scheme == "agentremote-wiki", url.host == "article" else { return nil }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "id" })?.value
    }
}

@MainActor final class WikiModel: ObservableObject {
    @Published var entries: [WikiEntry] = []
    @Published var selected: String?
    @Published var markdown = ""
    @Published var page: WikiPage?
    @Published var listError: String?
    @Published var pageError: String?
    @Published var loading = false
    @Published var reading = false
    @Published var back: [String] = []
    @Published var forward: [String] = []
    @Published var talk: WikiTalk?
    @Published var talkError: String?
    var generation = 0
    var readGeneration = 0
    func navigate(_ id: String) {
        guard id != selected else { return }
        if let selected { back.append(selected) }
        forward = []; selected = id
    }
    func goBack() { guard let id = back.popLast() else { return }; if let selected { forward.append(selected) }; selected = id }
    func goForward() { guard let id = forward.popLast() else { return }; if let selected { back.append(selected) }; selected = id }
    func home() { if let selected { back.append(selected) }; selected = nil; forward = [] }
    func search(_ text: String) async {
        generation += 1; let requestGeneration = generation; loading = true; listError = nil
        defer { if generation == requestGeneration { loading = false } }
        do {
            if text.isEmpty {
                // One lightweight call lists every article's title and metadata; prose and evidence load per article.
                let value: WikiResults = try await WikiAPI.get("/knowledge/index")
                try Task.checkCancellation(); guard generation == requestGeneration else { return }
                listError = value.warning; entries = value.results
                return
            }
            var result: [WikiEntry] = []; var offset = 0
            while true {
                let value: WikiResults = try await WikiAPI.get("/knowledge", query: ["q": text, "offset": String(offset)])
                try Task.checkCancellation(); guard generation == requestGeneration else { return }
                result.append(contentsOf: value.results.filter { item in !result.contains(where: { $0.id == item.id }) })
                offset += value.results.count; listError = value.warning
                if value.results.isEmpty { break }
            }
            entries = result
        } catch is CancellationError {} catch { if generation == requestGeneration { listError = error.localizedDescription } }
    }
    func loadTalk(_ id: String) async {
        do { let value: WikiTalkResult = try await WikiAPI.get("/knowledge/talk", query: ["id": id]); if selected == id { talk = value.talk; talkError = nil } }
        catch { if selected == id { talkError = error.localizedDescription } }
    }
    // A comment is your own statement: the article's steward reads it as user-stated evidence.
    func comment(_ id: String, _ text: String) async -> Bool {
        do { let _: WikiPosted = try await WikiAPI.post("/knowledge/talk", body: ["id": id, "text": text]); await loadTalk(id); await read(id); return true }
        catch { talkError = error.localizedDescription; return false }
    }
    func read(_ id: String) async {
        readGeneration += 1; let requestGeneration = readGeneration
        markdown = ""; page = nil; pageError = nil; reading = true
        defer { if readGeneration == requestGeneration { reading = false } }
        do {
            var text = ""; var cursor = 0; var revision: Int?
            repeat {
                var query = ["id": id, "offset": String(cursor), "budget": "60000"]
                if let revision { query["revision"] = String(revision) }
                let value: WikiResult = try await WikiAPI.get("/knowledge/page", query: query)
                try Task.checkCancellation(); guard selected == id && requestGeneration == readGeneration else { return }
                guard let page = value.page else { pageError = "This article is no longer available."; return }
                text += page.markdown; self.page = page; revision = page.revision
                guard let next = page.nextOffset, next > cursor else { break }; cursor = next
            } while true
            markdown = text
        } catch is CancellationError {} catch { if requestGeneration == readGeneration { pageError = error.localizedDescription } }
    }
}

@MainActor struct WikiView: View {
    @StateObject private var model: WikiModel
    init() { _model = StateObject(wrappedValue: WikiModel()) }
    init(model: WikiModel) { _model = StateObject(wrappedValue: model) }
    @State private var query = ""
    @State private var sourcesExpanded = false
    @State private var refresh = 0
    @State private var talkExpanded = false
    @State private var draft = ""
    @State private var posting = false
    private var mainText: String {
        let article = model.markdown.components(separatedBy: "\n\n## Related pages").first ?? model.markdown
        return article.components(separatedBy: "\n\n## Explore this topic").first ?? article
    }
    private var sources: String { model.markdown.components(separatedBy: "\n\n## Sources\n\n").dropFirst().joined(separator: "\n\n") }
    private var sections: [String] { mainText.components(separatedBy: "\n\n## ") }
    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Search the wiki", text: $query).textFieldStyle(.plain)
                    if !query.isEmpty { Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain) }
                }.padding(12).background(.quaternary.opacity(0.4)).clipShape(RoundedRectangle(cornerRadius: 9)).padding(12)
                List(selection: Binding(get: { model.selected }, set: { if let id = $0 { model.navigate(id) } })) {
                    if let error = model.listError { Text(error).foregroundStyle(.orange) }
                    ForEach(model.entries) { entry in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(entry.title).font(.headline).lineLimit(3)
                            Text(entry.summary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }.padding(.vertical, 5).tag(entry.id)
                    }
                    if model.loading { ProgressView().controlSize(.small) }
                }.listStyle(.sidebar)
                Text("\(model.entries.count) articles" + (model.entries.contains(where: { $0.pending == true }) ? " · \(model.entries.filter { $0.pending == true }.count) updating" : "")).font(.caption).foregroundStyle(.secondary).padding(12)
            }.navigationSplitViewColumnWidth(min: 250, ideal: 310, max: 420)
        } detail: {
            if model.selected != nil {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 22) {
                            if model.reading { ProgressView("Opening article…") }
                            if let error = model.pageError { Text(error).foregroundStyle(.orange) }
                            if let page = model.page {
                                HStack {
                                    Button("Wiki") { model.home() }.buttonStyle(.link)
                                    ForEach(page.breadcrumbs ?? []) { p in Text("›").foregroundStyle(.secondary); Button(p.title) { model.navigate(p.id) }.buttonStyle(.link) }
                                }.font(.callout)
                                Text("Updated \(Date(timeIntervalSince1970: page.updatedAt / 1000).formatted(date: .abbreviated, time: .shortened))\(page.pending == true ? " · Update in progress" : "")").font(.caption).foregroundStyle(.secondary)
                            }
                            MacMessageMarkdown(text: sections.first ?? "").lineSpacing(4)
                            if sections.count > 1 {
                                DisclosureGroup("Contents") {
                                    ForEach(Array(sections.dropFirst().enumerated()), id: \.offset) { index, section in
                                        Button(section.components(separatedBy: "\n").first ?? "Section") { withAnimation { proxy.scrollTo("section-\(index)", anchor: .top) } }.buttonStyle(.link).padding(.vertical, 3)
                                    }
                                }
                            }
                            ForEach(Array(sections.dropFirst().enumerated()), id: \.offset) { index, section in
                                MacMessageMarkdown(text: "## " + section).lineSpacing(4).id("section-\(index)")
                            }
                            articleLinks("Explore this topic", model.page?.children ?? [])
                            articleLinks("See also", model.page?.related ?? [])
                            articleLinks("Linked from", model.page?.backlinks ?? [])
                            talkSection
                            if !sources.isEmpty {
                                Divider()
                                DisclosureGroup("Sources and evidence", isExpanded: $sourcesExpanded) {
                                    Text(sources).font(.callout).textSelection(.enabled).padding(.top, 14)
                                }
                            }
                        }.padding(36).frame(maxWidth: 880, alignment: .leading).frame(maxWidth: .infinity)
                    }.id(model.selected)
                }
                .environment(\.openURL, OpenURLAction { url in
                    guard let id = WikiAPI.articleID(url) else { return .discarded }
                    model.navigate(id); return .handled
                })
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        Text("Knowledge wiki").font(.largeTitle.bold())
                        Text("Start with a subject, then follow the links to explore. Articles bring together what you’ve learned across conversations.").font(.title3).foregroundStyle(.secondary)
                        if model.entries.isEmpty && !model.loading { Text("Articles will appear as your conversations are learned.").foregroundStyle(.secondary) }
                        ForEach(model.entries.filter { $0.parent == nil }) { entry in
                            Button { model.navigate(entry.id) } label: {
                                VStack(alignment: .leading, spacing: 8) {
                                    Label(entry.title, systemImage: "book.closed").font(.title2)
                                    Text(entry.summary).foregroundStyle(.secondary).lineLimit(3)
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(18)
                            }.buttonStyle(.plain).background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 12))
                        }
                    }.padding(36).frame(maxWidth: 880, alignment: .leading).frame(maxWidth: .infinity)
                }
            }
        }
        .navigationTitle("Agent Remote Knowledge")
        .toolbar {
            ToolbarItem { Button { model.goBack() } label: { Label("Back", systemImage: "chevron.left") }.disabled(model.back.isEmpty).keyboardShortcut("[", modifiers: .command) }
            ToolbarItem { Button { model.goForward() } label: { Label("Forward", systemImage: "chevron.right") }.disabled(model.forward.isEmpty).keyboardShortcut("]", modifiers: .command) }
            ToolbarItem { Button { query = ""; model.home() } label: { Label("Wiki home", systemImage: "house") } }
            ToolbarItem { Button { refresh += 1 } label: { Label("Refresh", systemImage: "arrow.clockwise") }.keyboardShortcut("r", modifiers: .command) }
        }
        .task(id: query) { do { try await Task.sleep(for: .milliseconds(250)); await model.search(query) } catch {} }
        .task(id: refresh) { if refresh > 0 { await model.search(query); if let id = model.selected { await model.read(id); await model.loadTalk(id) } } }
        .task(id: model.selected) { sourcesExpanded = false; talkExpanded = false; model.talk = nil; if let id = model.selected { await model.read(id); await model.loadTalk(id) } }
        .frame(minWidth: 850, minHeight: 580)
        .background(Color(nsColor: .windowBackgroundColor))
    }
    @ViewBuilder private var talkSection: some View {
        if let id = model.selected {
            Divider()
            DisclosureGroup(isExpanded: $talkExpanded) {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Editors discuss this article here. Comments you post are treated as your own statements about the subject.").font(.callout).foregroundStyle(.secondary)
                    HStack(alignment: .top) {
                        TextField("Correct or add to this article…", text: $draft, axis: .vertical).lineLimit(1...5).textFieldStyle(.roundedBorder)
                        Button(posting ? "Posting…" : "Post") {
                            let text = draft.trimmingCharacters(in: .whitespacesAndNewlines); posting = true
                            Task { if await model.comment(id, text) { draft = "" }; posting = false }
                        }.disabled(posting || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    if let error = model.talkError { Text(error).foregroundStyle(.orange) }
                    if model.talk?.threads.isEmpty ?? true { Text("No discussion yet.").foregroundStyle(.secondary) }
                    ForEach(model.talk?.threads ?? []) { thread in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 8) {
                                Text(WikiTalkText.kind(thread.kind)).font(.caption.bold()).padding(.horizontal, 7).padding(.vertical, 2).background(.quaternary, in: Capsule())
                                Text(WikiTalkText.status(thread.status)).font(.caption).foregroundStyle(thread.status == "open" ? .orange : .secondary)
                                Text(thread.title).font(.callout.bold()).lineLimit(2)
                            }
                            if let target = thread.targetTitle { Text("With: \(target)").font(.caption).foregroundStyle(.secondary) }
                            ForEach(thread.claims, id: \.self) { claim in Text("“\(claim)”").font(.caption).foregroundStyle(.secondary).lineLimit(3) }
                            ForEach(thread.posts, id: \.self) { post in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("\(WikiTalkText.role(post.role)) · \(Date(timeIntervalSince1970: post.at / 1000).formatted(date: .abbreviated, time: .shortened))\(post.decision.map { $0 == "comment" ? "" : " · " + $0 } ?? "")").font(.caption).foregroundStyle(.secondary)
                                    Text(post.text).font(.callout).textSelection(.enabled)
                                }.padding(.leading, 10)
                            }
                        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 9))
                    }
                }.padding(.top, 12)
            } label: {
                Text("Talk" + ((model.talk?.open ?? 0) > 0 ? " · \(model.talk!.open) open" : "")).font(.title2.bold())
            }
        }
    }
    @ViewBuilder private func articleLinks(_ title: String, _ links: [WikiLink]) -> some View {
        if !links.isEmpty {
            Divider(); Text(title).font(.title2.bold())
            ForEach(links) { p in Button(p.title) { model.navigate(p.id) }.buttonStyle(.link) }
        }
    }
}
