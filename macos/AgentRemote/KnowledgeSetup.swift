import AppKit
import SwiftUI
import UniformTypeIdentifiers

// Choosing what the knowledge base learns from: projects found in past Claude and Codex chats, agent instruction
// files, and ChatGPT or Claude.ai exports. The service does the work; see desktop/src/knowledge-bootstrap.mjs.
struct KnowledgeSetupState: Decodable { let done: Bool; let excluded: [String]; let instructions: Bool }
struct KnowledgeProject: Decodable, Identifiable {
    let path: String; let display: String; let name: String; let home: Bool; let sessions: Int; let providers: [String]
    let lastAt: Double; let exists: Bool; let git: Bool; let files: [String]; let excluded: Bool
    var id: String { path }
}
struct KnowledgeInstructionFile: Decodable, Identifiable { let path: String; let display: String; let size: Int; var id: String { path } }
struct KnowledgeProgress: Decodable {
    let conversations: Int; let learned: Int; let waiting: Int; let imported: Int; let importedLearned: Int
    let projects: Int; let projectOverviews: Int; let notes: Int; let articles: Int; let profileAt: Double?
}
struct KnowledgeImport: Decodable, Identifiable { let id: String; let source: String; let file: String; let at: Double; let conversations: Int; let learned: Int }
struct KnowledgeSources: Decodable {
    let setup: KnowledgeSetupState; let projects: [KnowledgeProject]; let instructionFiles: [KnowledgeInstructionFile]
    let progress: KnowledgeProgress; let imports: [KnowledgeImport]
}
struct ExportOption: Decodable, Hashable { let limit: Int; let calls: Int; let since: Double? }
struct ExportPreview: Decodable { let source: String; let total: Int; let usable: Int; let newest: Double?; let oldest: Double?; let options: [ExportOption] }
struct ExportImported: Decodable { let conversations: Int }
struct ImportRemoved: Decodable { let removed: Int }

@MainActor final class KnowledgeSetupModel: ObservableObject {
    @Published var sources: KnowledgeSources?
    @Published var excluded: Set<String> = []
    @Published var instructions = true
    @Published var error: String?
    @Published var saving = false
    @Published var preview: ExportPreview?
    @Published var previewPath: String?
    @Published var choice = 0
    @Published var importing = false
    @Published var importMessage: String?
    private var edited = false
    var changed: Bool { guard let setup = sources?.setup else { return false }; return Set(setup.excluded) != excluded || setup.instructions != instructions }
    func load() async {
        do {
            let value: KnowledgeSources = try await WikiAPI.get("/knowledge/sources")
            sources = value; error = nil
            if !edited { excluded = Set(value.setup.excluded); instructions = value.setup.instructions }
        } catch { self.error = "Couldn’t reach the Agent Remote service. Start remote access, then try again." }
    }
    func toggle(_ project: KnowledgeProject, _ on: Bool) { edited = true; if on { excluded.remove(project.path) } else { excluded.insert(project.path) } }
    func setInstructions(_ on: Bool) { edited = true; instructions = on }
    func save(start: Bool) async {
        saving = true; defer { saving = false }
        var body: [String: Any] = ["excluded": Array(excluded), "instructions": instructions]
        if start { body["done"] = true }
        do { let value: KnowledgeSources = try await WikiAPI.post("/knowledge/sources", json: body, timeout: 120); sources = value; edited = false; error = nil }
        catch { self.error = error.localizedDescription }
    }
    func chooseExport() {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.zip, .json]; panel.allowsMultipleSelection = false
        panel.message = "Choose the ChatGPT or Claude.ai export (.zip) you downloaded"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            importing = true; importMessage = "Reading the export…"; preview = nil; defer { importing = false }
            do {
                let value: ExportPreview = try await WikiAPI.post("/knowledge/imports/preview", json: ["path": url.path], timeout: 600)
                preview = value; previewPath = url.path; choice = min(1, max(0, value.options.count - 1)); importMessage = nil
            } catch { importMessage = error.localizedDescription }
        }
    }
    func importExport() async {
        guard let preview, let path = previewPath, preview.options.indices.contains(choice) else { return }
        importing = true; importMessage = "Importing…"; defer { importing = false }
        do {
            let value: ExportImported = try await WikiAPI.post("/knowledge/imports", json: ["path": path, "limit": preview.options[choice].limit], timeout: 600)
            self.preview = nil; previewPath = nil
            importMessage = "Imported \(value.conversations) conversations. They are learned in the background" + (sources?.setup.done == true ? "." : " once you start learning.")
            await load()
        } catch { importMessage = error.localizedDescription }
    }
    func remove(_ item: KnowledgeImport) async {
        do { let _: ImportRemoved = try await WikiAPI.post("/knowledge/imports/remove", json: ["id": item.id], timeout: 120); await load() }
        catch { importMessage = error.localizedDescription }
    }
}

/// Short date for project and import rows.
private func day(_ milliseconds: Double?) -> String {
    guard let milliseconds, milliseconds > 0 else { return "" }
    return Date(timeIntervalSince1970: milliseconds / 1000).formatted(date: .abbreviated, time: .omitted)
}

@MainActor struct KnowledgeSetupView: View {
    @StateObject var model = KnowledgeSetupModel()
    @State private var confirmRemove: KnowledgeImport?
    private let accent = Color(red: 0.36, green: 0.89, blue: 0.74)
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Build your knowledge base").font(.system(size: 26, weight: .bold, design: .rounded))
                    Text("Agent Remote learns from your Claude and Codex conversations on this Mac and turns them into a wiki that your agents read before they answer. Choose what it may learn from. Everything stays on this Mac.")
                        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if let error = model.error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
                if let sources = model.sources {
                    progress(sources)
                    projects(sources)
                    instructions(sources)
                    exports(sources)
                    footer(sources)
                } else if model.error == nil { ProgressView("Looking for your conversations…") }
            }.padding(28)
        }
        .background(Color(red: 0.055, green: 0.075, blue: 0.075)).preferredColorScheme(.dark).tint(accent)
        .frame(minWidth: 620, minHeight: 560)
        .task { await model.load(); while !Task.isCancelled { try? await Task.sleep(nanoseconds: 5_000_000_000); await model.load() } }
        .alert("Remove this import?", isPresented: Binding(get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } })) {
            Button("Cancel", role: .cancel) {}
            Button("Remove", role: .destructive) { if let item = confirmRemove { Task { await model.remove(item) } } }
        } message: { Text("Its conversations and everything learned from them are removed from this Mac. The export file is not touched.") }
    }
    private func card<Content: View>(_ title: String, _ subtitle: String? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            content()
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 14))
    }
    @ViewBuilder private func progress(_ sources: KnowledgeSources) -> some View {
        let p = sources.progress
        if sources.setup.done {
            card("Learning") {
                VStack(alignment: .leading, spacing: 6) {
                    ProgressView(value: Double(p.learned + p.importedLearned), total: Double(max(1, p.conversations + p.imported)))
                    Text("\(p.learned) of \(p.conversations) conversations learned" + (p.imported > 0 ? " · \(p.importedLearned) of \(p.imported) imported chats" : "")
                         + (p.projects > 0 ? " · \(p.projectOverviews) of \(p.projects) project overviews" : "")).font(.callout)
                    Text("\(p.articles) wiki articles · " + (p.profileAt.map { "About you written \(day($0))" } ?? "About you is written once enough is learned"))
                        .font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Button("Open the wiki") { (NSApp.delegate as? AppDelegate)?.showKnowledge(article: p.profileAt == nil ? nil : profileID) }
                        Spacer()
                    }.padding(.top, 4)
                }
            }
        } else {
            card("Nothing older is learned yet", "Chats you start in Agent Remote are learned right away. The \(p.waiting) conversations from before are waiting for you to choose which projects to include below.") { EmptyView() }
        }
    }
    private func projects(_ sources: KnowledgeSources) -> some View {
        card("Projects", "Found in your Claude and Codex conversations on this Mac. Each included project also gets a short overview from its README, recent commits and chat titles. Excluding a project removes what was already learned from it. Its conversations stay on this Mac.") {
            if sources.projects.isEmpty { Text("No past conversations found yet.").font(.callout).foregroundStyle(.secondary) }
            ForEach(sources.projects) { project in
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(project.home ? "Chats started in your home folder" : project.name).font(.body.weight(.medium))
                        Text([project.display, "\(project.sessions) \(project.sessions == 1 ? "conversation" : "conversations")", "last \(day(project.lastAt))",
                              project.files.isEmpty ? nil : project.files.joined(separator: ", ")].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    Spacer(minLength: 12)
                    Toggle(project.name, isOn: Binding(get: { !model.excluded.contains(project.path) }, set: { model.toggle(project, $0) })).labelsHidden()
                        .toggleStyle(.switch).controlSize(.small)
                }
            }
        }
    }
    private func instructions(_ sources: KnowledgeSources) -> some View {
        card("Agent instruction files", "CLAUDE.md and AGENTS.md files already describe how you work. They are read as reference notes, including files they import with @.") {
            HStack {
                Text("Learn from instruction files")
                Spacer()
                Toggle("Learn from instruction files", isOn: Binding(get: { model.instructions }, set: { model.setInstructions($0) })).labelsHidden().toggleStyle(.switch).controlSize(.small)
            }
            if model.instructions {
                if sources.instructionFiles.isEmpty { Text("None found in your included projects.").font(.caption).foregroundStyle(.secondary) }
                ForEach(sources.instructionFiles) { file in Text("\(file.display) · \(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))").font(.caption).foregroundStyle(.secondary) }
            }
        }
    }
    private func exports(_ sources: KnowledgeSources) -> some View {
        card("Chats from ChatGPT or Claude.ai", "Export your history and import the zip here. ChatGPT: Settings → Data controls → Export data. Claude.ai: Settings → Privacy → Export data. Each emails you a download link.") {
            HStack {
                Button("Import an export…") { model.chooseExport() }.disabled(model.importing)
                if model.importing { ProgressView().controlSize(.small) }
                if let message = model.importMessage { Text(message).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            }
            if let preview = model.preview {
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(preview.source == "chatgpt" ? "ChatGPT" : "Claude.ai") export · \(preview.usable) conversations from \(day(preview.oldest)) to \(day(preview.newest))").font(.callout)
                    Picker("Import", selection: $model.choice) {
                        ForEach(Array(preview.options.enumerated()), id: \.offset) { index, option in
                            Text((option.limit == preview.usable ? "All \(option.limit)" : "Newest \(option.limit)") + " · about \(option.calls) background model calls" + (option.since.map { ", since \(day($0))" } ?? "")).tag(index)
                        }
                    }.pickerStyle(.radioGroup)
                    Text("Learning uses your own Claude or Codex plan and runs slowly in the background, so a large import can take days and count toward your usage limits.").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    HStack { Button("Import") { Task { await model.importExport() } }.buttonStyle(.borderedProminent).foregroundStyle(.black).disabled(model.importing); Button("Cancel") { model.preview = nil } }
                }.padding(12).background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
            }
            ForEach(sources.imports) { item in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(item.source == "chatgpt" ? "ChatGPT" : "Claude.ai") · \(item.file)").font(.callout)
                        Text("\(item.learned) of \(item.conversations) learned · imported \(day(item.at))").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Remove…") { confirmRemove = item }
                }
            }
        }
    }
    private func footer(_ sources: KnowledgeSources) -> some View {
        HStack {
            Text("Learning runs in the background on your own Claude or Codex plan and counts toward its usage limits.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Spacer()
            if model.saving { ProgressView().controlSize(.small) }
            if !sources.setup.done {
                Button("Start learning") { Task { await model.save(start: true) } }.buttonStyle(.borderedProminent).foregroundStyle(.black).disabled(model.saving)
            } else {
                Button("Save changes") { Task { await model.save(start: false) } }.buttonStyle(.borderedProminent).foregroundStyle(.black).disabled(model.saving || !model.changed)
            }
        }
    }
}
