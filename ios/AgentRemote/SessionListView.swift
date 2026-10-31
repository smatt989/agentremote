import SwiftUI
import CoreImage.CIFilterBuiltins

struct SessionListView: View {
    @EnvironmentObject var state: AppState
    @ObservedObject private var updater = MacUpdater.shared
    @Environment(\.scenePhase) private var phase
    @State private var pairing = false
    @State private var navigation: [Session] = []
    @State private var selected: Session? // Mac sidebar selection; the iPhone pushes onto `navigation` instead
    @State private var createdSession: Session?
    @State private var creating = false
    @State private var settings = false
    @State private var memory = false
    @State private var tab = "chats"
    @State private var notifications = false
    @State private var deleting: Session?
    @State private var confirmDelete = false
    @State private var operating = false
    @State private var actionError: String?
    @State private var search = ""
    @State private var addingDevice = false
    @State private var renaming: Session?
    @State private var renameText = ""
    @State private var showingUsage = false
    @StateObject private var usage = UsageMonitor()
    /// On iPhone an open chat covers the list, so the list polls slowly underneath it (L-8). The Mac's split view keeps the list on screen.
    private var chatCovers: Bool { !Platform.isMac && !navigation.isEmpty }
    var filtered: [Session] { state.sessions.filter { search.isEmpty || ($0.title + $0.cwd + $0.provider).localizedCaseInsensitiveContains(search) } }
    var body: some View {
        TabView(selection: $tab) {
            chats.tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }.tag("chats")
            Group {
                if let host = state.host { KnowledgeView(host: host).id(host.id) }
                else { ContentUnavailableView("Pair a Mac first", systemImage: "books.vertical", description: Text("Your knowledge wiki will appear here after pairing.")) }
            }.tabItem { Label("Knowledge", systemImage: "books.vertical") }.tag("knowledge")
        }
        .sheet(isPresented: $state.claudeSignIn) { if let host = state.host { ClaudeSignInView(host: host) { Task { await state.refresh() } } } }
        .onChange(of: state.pairingCode) { _, code in if code != nil { tab = "chats" } }
        .onChange(of: state.notificationSessionID) { _, id in
                guard let id else { return }
                Task {
                    await state.refresh()
                    if let session = state.sessions.first(where: { $0.id == id }) { tab = "chats"; open(session, replacing: true) }
                    state.notificationSessionID = nil
                }
            }
    }
    @ViewBuilder private var chats: some View {
        if Platform.isMac {
            NavigationSplitView {
                chatList.navigationSplitViewColumnWidth(min: 260, ideal: 320, max: 440)
            } detail: {
                NavigationStack {
                    if let session = selected, let host = state.host { ConversationView(session: session, host: host).id(session.id) }
                    else { ContentUnavailableView("Select a chat", systemImage: "bubble.left.and.bubble.right", description: Text(state.host == nil ? "Pair a Mac to see its chats." : "Choose a chat, or press ⌘N to start one.")) }
                }
            }
            .onChange(of: state.sessions.map(\.id)) { old, new in
                // A chat deleted here or on another device closes instead of showing a stale conversation
                if let id = selected?.id, old.contains(id), !new.contains(id) { selected = nil }
            }
        } else {
            NavigationStack(path: $navigation) { chatList }
        }
    }
    private func open(_ session: Session, replacing: Bool = false) {
        if Platform.isMac { selected = session } else if replacing { navigation = [session] } else { navigation.append(session) }
    }
    @ViewBuilder private func row(_ session: Session) -> some View {
        if Platform.isMac { SessionRow(session: session).tag(session.id) }
        else { NavigationLink(value: session) { SessionRow(session: session) } }
    }
    private var chatList: some View {
            VStack(spacing: 0) {
                if state.host != nil {
                    UsageSummaryLine(usage: usage) { showingUsage = true }
                    ListSearchField(text: $search, prompt: "Search chats")
                }
                List(selection: Platform.isMac ? Binding(get: { selected?.id }, set: { id in selected = state.sessions.first { $0.id == id } }) : nil) {
                if state.host == nil {
                    ContentUnavailableView {
                        Label("Bring your agents along", systemImage: "bubble.left.and.text.bubble.right")
                    } description: { Text("Start work, follow commands, and pick up chats from your phone.") } actions: { Button("Pair this iPhone", action: { pairing = true }).buttonStyle(.borderedProminent) }
                }
                if let error = state.error { Section { Label(error, systemImage: "wifi.exclamationmark").font(.caption).foregroundStyle(Theme.failure) } }
                ForEach(state.warnings, id: \.self) { warning in Label(warning, systemImage: "info.circle").font(.caption).foregroundStyle(Theme.info) }
                if let auth = state.claudeAuth, ["expired", "expiring"].contains(auth.state) {
                    Section { ClaudeAuthBanner(status: auth, hostName: state.host?.name ?? "your Mac") { state.claudeSignIn = true } }
                }
                Section {
                    ForEach(filtered) { session in
                        row(session)
                        .accessibilityIdentifier("session-" + session.id)
                        .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button("Delete", role: .destructive) { deleting = session; confirmDelete = true }
                                .disabled(operating || session.control == "external-live")
                            Button("End") { Task { await end(session) } }
                                .disabled(operating || session.control == "external-live" || session.status == "ended")
                        }
                        .contextMenu {
                            if let host = state.host, !state.renameUnsupported.contains(host.id) {
                                Button("Rename", systemImage: "pencil") { renameText = session.title; renaming = session }.disabled(operating)
                            }
                            Button("End chat", systemImage: "xmark.circle") { Task { await end(session) } }
                                .disabled(operating || session.control == "external-live" || session.status == "ended")
                            Button("Delete chat", systemImage: "trash", role: .destructive) { deleting = session; confirmDelete = true }
                                .disabled(operating || session.control == "external-live")
                        }
                    }
                }
            }
                .listStyle(.plain)
                .scrollDismissesKeyboard(.interactively)
                .overlay {
                    if state.host != nil && filtered.isEmpty && state.error == nil {
                        ContentUnavailableView(search.isEmpty ? "No chats yet" : "No matching chats", systemImage: "bubble.left.and.bubble.right", description: Text(search.isEmpty ? "Tap the compose button to start a chat." : "Try a different title, project, or agent."))
                    }
                }
            }
            .navigationTitle("Chats")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Section(state.host?.name ?? "Your Mac") {
                            ForEach(state.hosts) { host in
                                Button { state.selectedHostID = host.id; state.sessions = []; state.claudeAuth = nil; navigation = []; selected = nil } label: {
                                    Label(host.name, systemImage: host.id == state.selectedHostID ? "checkmark" : "desktopcomputer")
                                }
                            }
                            Button("Pair another Mac", systemImage: "plus") { pairing = true }
                            Button("Add a device…", systemImage: "qrcode") { addingDevice = true }.disabled(state.host == nil)
                        }
                        Section {
                            Button("Model defaults") { settings = true }
                            Button("Memory notes") { memory = true }
                            Button("Notifications") { notifications = true }
                        }.disabled(state.host == nil)
                        if Platform.isMac {
                            Section(updater.status) {
                                if let version = updater.readyVersion { Button("Restart to Update (\(version))", systemImage: "arrow.down.circle") { updater.restartToUpdate() } }
                                else { Button("Check for Updates") { Task { await updater.check(manual: true) } } }
                            }
                        }
                    } label: { Image(systemName: "gearshape") }.accessibilityLabel("Settings")
                }
                if let version = updater.readyVersion {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { updater.restartToUpdate() } label: { Image(systemName: "arrow.down.circle") }
                            .accessibilityLabel("Restart to update to \(version)").help("Restart to update to \(version)")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { creating = true } label: { Image(systemName: "square.and.pencil") }
                        .accessibilityLabel("New chat").disabled(state.host == nil).keyboardShortcut("n")
                }
            }
            .refreshable { await state.refresh() }
            .sheet(isPresented: $pairing) { PairView() }
            .sheet(isPresented: $addingDevice) { if let host = state.host { AddDeviceView(host: host) } }
            .alert("Rename chat", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Name", text: $renameText)
                Button("Cancel", role: .cancel) { renaming = nil }
                Button("Save") { if let session = renaming { Task { await rename(session) } }; renaming = nil }
            }
            .onChange(of: state.pairingCode) { _, code in if code != nil { pairing = true } }
            .alert("Couldn’t update the chat", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
                Button("OK", role: .cancel) { actionError = nil }
            } message: { Text(actionError ?? "") }
            .navigationDestination(for: Session.self) { session in if let host = state.host { ConversationView(session: session, host: host).toolbar(.hidden, for: .tabBar) } }
            .sheet(isPresented: $creating, onDismiss: { if let session = createdSession { createdSession = nil; search = ""; open(session) } }) { CreateSessionView { session in createdSession = session } }
            .sheet(isPresented: $memory) { if let host = state.host { MemoryView(host: host) } }
            .sheet(isPresented: $notifications) { ReplyNotificationSettings() }
            .sheet(isPresented: $settings) { if let host = state.host { ModelDefaultsView(host: host) } }
            .confirmationDialog("Delete chat permanently?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete permanently", role: .destructive) { if let session = deleting { Task { await delete(session) } } }
            } message: { Text(deleting?.deletionMessage ?? "") }
            .sheet(isPresented: $showingUsage) { UsageSheet(usage: usage, hostName: state.host?.name ?? "your Mac") }
            // Every 5 s while the list is on screen. Under an open iPhone chat, every 30 s instead: enough to keep other
            // chats' unread state and reply alerts current, without a full list poll behind every conversation poll.
            // Returning to the list restarts this task, which refreshes at once. Usage limits follow, at most once a minute.
            .task(id: "\(phase)-\(state.selectedHostID ?? "")-\(chatCovers)") {
                guard phase == .active else { return }
                let covered = chatCovers
                while !Task.isCancelled {
                    if covered { do { try await Task.sleep(for: .seconds(30)) } catch { break } }
                    async let limits: Void = usage.refresh(state.api)
                    await state.refresh(); await limits
                    if !covered { do { try await Task.sleep(for: .seconds(5)) } catch { break } }
                }
            }
    }
    private func end(_ session: Session) async {
        guard let api = state.api else { return }; operating = true; defer { operating = false }
        do { _ = try await api.request(API.sessionPath(session.id) + "/end", method: "POST"); await state.refresh() }
        catch { actionError = error.localizedDescription }
    }
    private func rename(_ session: Session) async {
        let title = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let host = state.host, !title.isEmpty, title != session.title else { return }
        operating = true; defer { operating = false }
        do {
            let renamed = try await state.rename(session, to: title, host: host)
            if selected?.id == renamed.id { selected = renamed }
        } catch { actionError = error.localizedDescription }
    }
    private func delete(_ session: Session) async {
        guard let api = state.api else { return }; operating = true; defer { operating = false }
        do { _ = try await api.request(API.sessionPath(session.id) + "/delete", method: "POST"); state.sessions.removeAll { $0.id == session.id }; await state.refresh() }
        catch { actionError = error.localizedDescription }
    }
}
private struct ListSearchField: View {
    @Binding var text: String
    let prompt: String
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField(prompt, text: $text).textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityIdentifier("list-search")
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                    .accessibilityLabel("Clear search")
            }
        }.padding(10).background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal, 16).padding(.vertical, 8)
    }
}
struct StatusBadge: View {
    var status: String
    var body: some View {
        HStack(spacing: 5) { if ["running", "submitting"].contains(status) { ProgressView().controlSize(.mini).tint(Theme.accent) } else { Image(systemName: status == "waiting" ? "questionmark.circle.fill" : "circle.fill").font(.system(size: status == "waiting" ? 12 : 6)).foregroundStyle(status == "waiting" ? Theme.needsYou : Theme.info) }; Text(status == "running" ? "Working on Mac" : status == "waiting" ? "Needs your answer" : status.capitalized) }
            .font(.caption2).foregroundStyle(.secondary)
    }
}
struct PairView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var scanning = false
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("Your Mac, securely connected", systemImage: "lock.shield").font(.headline)
                    Text("Scan the code shown by Agent Remote on your Mac. Pair once, then connect wherever you are.").foregroundStyle(.secondary)
                    Button { scanning = true } label: { Label("Scan QR code", systemImage: "qrcode.viewfinder") }.buttonStyle(.borderedProminent)
                }
                Section("Or paste a pairing link") {
                    TextField("agentremote://pair#…", text: $code, axis: .vertical).lineLimit(1...4).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .font(.callout.monospaced()).accessibilityIdentifier("pairingCode")
                }
                if let invite = try? RelayInvite.parse(code) { Section { Label(invite.name, systemImage: "desktopcomputer"); Text("End-to-end encrypted · No VPN required").font(.caption).foregroundStyle(.secondary) } }
                if let error { Text(error).foregroundStyle(Theme.failure) }
                Button(busy ? "Connecting…" : "Pair Mac") {
                    busy = true
                    Task { do { try await state.pair(code: code); dismiss() } catch { self.error = error.localizedDescription }; busy = false }
                }.disabled(busy || code.isEmpty)
            }.navigationTitle("Pair a Mac").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
                .onAppear { if let pending = state.pairingCode { code = pending } }
                .onChange(of: state.pairingCode) { _, pending in if let pending { code = pending; error = nil } }
                // Clear the opened link, so opening the same link again shows this sheet again.
                .onDisappear { state.pairingCode = nil }
                .sheet(isPresented: $scanning) {
                    NavigationStack {
                        QRScanner(found: { value in code = value; scanning = false }, failed: { message in error = message; scanning = false })
                            .ignoresSafeArea(edges: .bottom)
                            .navigationTitle("Scan your Mac’s code").navigationBarTitleDisplayMode(.inline)
                            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { scanning = false } } }
                    }
                }
        }
    }
}
struct CreateSessionView: View {
    var onCreated: (Session) -> Void = { _ in }
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var provider = "claude"
    @State private var title = ""
    @State private var cwd = ""
    @State private var folder = "" // "" is home, else a recent folder's path or `otherFolder`
    @State private var model = ""
    @State private var localProvider = "ollama"
    @State private var defaults = ModelDefaults()
    @State private var agents: [AgentAvailability]? // nil: the Mac has no /agents route, so every agent is offered as before
    @State private var recent: RecentFolders? // nil: no /folders/recent route, so the folder is typed as before
    @State private var catalogs: [String: AgentModelCatalog] = [:]
    @State private var loadingDefaults = true
    @State private var busy = false
    @State private var error: String?
    @State private var signingIn = false
    private static let otherFolder = "\u{0}other"
    private var selectedAgent: AgentAvailability? { agents?.first { $0.id == provider } }
    private var recentFolders: [RecentFolder] {
        var seen: Set<String> = [recent?.home ?? ""]
        return (recent?.folders ?? []).sorted { $0.lastUsed > $1.lastUsed }.filter { seen.insert($0.path).inserted }
    }
    var body: some View {
        NavigationStack {
            Form {
                // Rows appear once the Mac has answered: a Catalyst menu picker that starts disabled stays grey.
                if loadingDefaults { HStack(spacing: 10) { ProgressView(); Text("Checking \(state.host?.name ?? "your Mac")…").foregroundStyle(.secondary) } } else {
                agentChoice
                TextField("Chat name", text: $title)
                folderChoice
                if provider == "local" {
                    TextField("Installed model name (required)", text: $model).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker("Local server", selection: $localProvider) { Text("Ollama").tag("ollama"); Text("LM Studio").tag("lmstudio") }
                } else {
                    ModelPicker(title: "Model", model: $model, catalog: catalogs[provider]).id(provider)
                }
                Text("This model is used for this chat. Change future defaults in Settings.").font(.footnote).foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Label { Text("Full access enabled") } icon: { Image(systemName: "exclamationmark.shield.fill").foregroundStyle(Theme.caution) }
                    Text("The agent can use your Mac’s local files, agent configuration, and connected tools.").font(.footnote).foregroundStyle(.secondary)
                }.accessibilityElement(children: .combine)
                if let error { Text(error).foregroundStyle(Theme.failure) }
                Button(busy ? "Starting…" : "Create chat") {
                    guard let api = state.api else { return }; busy = true
                    // A blank name lets the Mac name the chat from its first message (older Macs use "New session").
                    var body: [String: Any] = ["provider": provider]
                    let name = title.trimmingCharacters(in: .whitespacesAndNewlines); if !name.isEmpty { body["title"] = name }
                    let path = recent == nil || folder == Self.otherFolder ? cwd.trimmingCharacters(in: .whitespacesAndNewlines) : folder
                    if !path.isEmpty { body["cwd"] = path }; if !model.isEmpty { body["model"] = model }
                    if provider == "local" { body["localProvider"] = localProvider }
                    Task { do { let session = try await api.post("/sessions", body: body, as: Session.self); state.sessions.removeAll { $0.id == session.id }; state.sessions.insert(session, at: 0); onCreated(session); dismiss() } catch { self.error = error.localizedDescription }; busy = false }
                }.disabled(busy || loadingDefaults || (provider == "local" && model.isEmpty) || selectedAgent?.installed == false)
                }
            }.navigationTitle("New chat").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task {
                defer { loadingDefaults = false }
                guard let api = state.api else { return }
                async let available = try? api.get("/agents", as: AgentAvailabilityList.self)
                async let folders = try? api.get("/folders/recent", as: RecentFolders.self)
                do { defaults = try await api.get("/settings/models", as: ModelDefaults.self); localProvider = defaults.localProvider }
                catch { self.error = error.localizedDescription }
                recent = await folders
                if let list = await available?.agents, !list.isEmpty {
                    agents = list
                    // The first agent that is ready to use, preferring Claude.
                    let ready = list.filter { $0.installed && $0.signedIn != false }
                    provider = (ready.first { $0.id == "claude" } ?? ready.first ?? list.first { $0.installed })?.id ?? "local"
                }
                model = defaults.model(for: provider)
            }
            .task {
                guard let api = state.api else { return }
                let sessions = state.sessions
                async let claude = api.modelCatalog("claude", sessions: sessions)
                async let codex = api.modelCatalog("codex", sessions: sessions)
                catalogs["claude"] = await claude; catalogs["codex"] = await codex
            }
            .onChange(of: provider) { _, value in model = defaults.model(for: value) }
            .sheet(isPresented: $signingIn) {
                if let host = state.host { ClaudeSignInView(host: host) { Task { await reloadAgents(); await state.refresh() } } }
            }
        }
    }
    @ViewBuilder private var agentChoice: some View {
        if let agents {
            Section("Agent") {
                ForEach(agents) { agent in
                    agentRow(agent.id, agent.name, enabled: agent.installed, caption: !agent.installed ? "Not installed on this Mac — install it from Agent Remote on the Mac" : agent.signedIn == false ? "Signed out — sign in on the Mac" : nil)
                    if agent.id == "claude", agent.installed, agent.signedIn == false {
                        Button("Sign in to Claude from here") { signingIn = true }.font(.callout)
                    }
                }
                agentRow("local", "Local model", enabled: true, caption: nil)
            }
        } else {
            Picker("Agent", selection: $provider) { Text("Claude").tag("claude"); Text("Codex").tag("codex"); Text("Local model").tag("local") }
        }
    }
    private func agentRow(_ id: String, _ name: String, enabled: Bool, caption: String?) -> some View {
        Button { provider = id } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).foregroundStyle(enabled ? Color.primary : Color.secondary)
                    if let caption { Text(caption).font(.caption).foregroundStyle(enabled ? Theme.needsYou : Theme.info) }
                }
                Spacer()
                if provider == id { Image(systemName: "checkmark").foregroundStyle(Theme.accent) }
            }.contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled)
        .accessibilityIdentifier("agent-" + id).accessibilityAddTraits(provider == id ? .isSelected : [])
    }
    @ViewBuilder private var folderChoice: some View {
        if recent != nil {
            Picker("Folder", selection: $folder) {
                Text("Home (~)").tag("")
                ForEach(recentFolders, id: \.path) { Text($0.label).tag($0.path) }
                Text("Other folder…").tag(Self.otherFolder)
            }.accessibilityIdentifier("folderPicker")
            if folder == Self.otherFolder {
                TextField("Folder on the Mac, e.g. ~/Projects/site", text: $cwd).textInputAutocapitalization(.never).autocorrectionDisabled()
            }
        } else {
            TextField("Working directory (default: home)", text: $cwd).textInputAutocapitalization(.never).autocorrectionDisabled()
        }
    }
    private func reloadAgents() async {
        guard let api = state.api, let list = try? await api.get("/agents", as: AgentAvailabilityList.self), !list.agents.isEmpty else { return }
        agents = list.agents
    }
}

/// "Default", the Mac's model list for the agent, and "Custom…" for any other alias or ID.
struct ModelPicker: View {
    let title: String
    @Binding var model: String
    let catalog: AgentModelCatalog?
    @State private var custom = false
    private static let customTag = "\u{0}custom"
    private var listed: Bool { model.isEmpty || catalog?.models.contains { $0.id == model } == true }
    private var typing: Bool { custom || !listed }
    private var shown: String { typing ? Self.customTag : model }
    var body: some View {
        Picker(title, selection: Binding(get: { shown }, set: { value in
            if value == Self.customTag { custom = true } else { custom = false; model = value }
        })) {
            Text("Default").tag("")
            ForEach(catalog?.models ?? []) { Text($0.name).tag($0.id) }
            Text("Custom…").tag(Self.customTag)
        }
        // Catalyst's menu picker keeps its old title when the value or list changes from code (a loaded default).
        .id(shown + "|" + (catalog?.models.map(\.id).joined(separator: ",") ?? ""))
        if typing {
            TextField("Model alias or ID", text: $model).textInputAutocapitalization(.never).autocorrectionDisabled()
        }
    }
}

struct ModelDefaultsView: View {
    let host: Host
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var defaults = ModelDefaults()
    @State private var catalogs: [String: AgentModelCatalog] = [:]
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ModelPicker(title: "Codex model", model: $defaults.codex, catalog: catalogs["codex"])
                    ModelPicker(title: "Claude model", model: $defaults.claude, catalog: catalogs["claude"])
                } header: { Text("Cloud models") } footer: { Text("Default uses the agent’s own default on the Mac. Choose Custom… to enter any model alias or ID.") }
                Section("Local model") {
                    TextField("Installed model name", text: $defaults.local)
                    Picker("Server", selection: $defaults.localProvider) { Text("Ollama").tag("ollama"); Text("LM Studio").tag("lmstudio") }
                }
                Section { Text("Applies to new chats on \(host.name), from any paired device. Existing chats keep their model.").font(.footnote).foregroundStyle(.secondary) }
                if let error { Text(error).foregroundStyle(Theme.failure) }
                if loading { ProgressView("Loading defaults…") }
            }
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .navigationTitle("Model defaults")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") {
                        saving = true
                        Task { do { _ = try await API(host: host).post("/settings/models", body: defaults.body, as: ModelDefaults.self); dismiss() } catch { self.error = error.localizedDescription }; saving = false }
                    }.disabled(loading || saving)
                }
            }
            .task {
                do { defaults = try await API(host: host).get("/settings/models", as: ModelDefaults.self); loading = false }
                catch { self.error = error.localizedDescription }
            }
            .task {
                let api = API(host: host), sessions = state.selectedHostID == host.id ? state.sessions : []
                async let claude = api.modelCatalog("claude", sessions: sessions)
                async let codex = api.modelCatalog("codex", sessions: sessions)
                catalogs["claude"] = await claude; catalogs["codex"] = await codex
            }
        }
    }
}

/// A one-time pairing link for this Mac, for a device that can't scan the Mac's code (a laptop, say):
/// send the link to yourself, or scan this screen's code with the other device.
struct AddDeviceView: View {
    let host: Host
    @Environment(\.dismiss) private var dismiss
    @State private var invite: PairingInvite?
    @State private var code: UIImage?
    @State private var loading = false
    @State private var error: String?
    @State private var unsupported = false
    private var expiry: String {
        guard let date = invite?.expiresAt else { return "" }
        return Calendar.current.isDateInToday(date) ? date.formatted(date: .omitted, time: .shortened) : date.formatted(date: .abbreviated, time: .shortened)
    }
    var body: some View {
        NavigationStack {
            Form {
                if !unsupported { Section { Text("Open this link on the device you want to add, in Agent Remote. Or scan the code with that device’s camera.").font(.footnote).foregroundStyle(.secondary) } }
                if let invite {
                    Section {
                        if let code {
                            Image(uiImage: code).interpolation(.none).resizable().scaledToFit().frame(maxWidth: 220)
                                .padding(14).background(Color.white, in: RoundedRectangle(cornerRadius: 12))
                                .frame(maxWidth: .infinity).accessibilityLabel("Pairing code for \(host.name)").accessibilityIdentifier("deviceInviteQR")
                        }
                        if let url = URL(string: invite.uri) { ShareLink(item: url) { Label("Send link…", systemImage: "square.and.arrow.up") } }
                        CopyTextButton(text: invite.uri, label: "Copy link")
                        Text(invite.expiresAt > Date() ? "Works once, until \(expiry)" : "This link has expired. Create a new one.").font(.footnote).foregroundStyle(.secondary)
                    }
                    Section {
                        Label { Text("Anyone with this link can control this Mac. Send it only to yourself.").foregroundStyle(.secondary) } icon: { Image(systemName: "exclamationmark.shield.fill").foregroundStyle(Theme.caution) }.font(.footnote)
                        Button("Create a new link") { Task { await load() } }.disabled(loading)
                    }
                } else if loading {
                    HStack(spacing: 10) { ProgressView(); Text("Creating a link on \(host.name)…").foregroundStyle(.secondary) }
                }
                if let error {
                    Section {
                        Text(error).foregroundStyle(Theme.failure)
                        if !unsupported { Button("Try again") { Task { await load() } } }
                    }
                }
            }
            .navigationTitle("Add a device").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
        }
    }
    private func load() async {
        loading = true; error = nil; defer { loading = false }
        do {
            let result = try await API(host: host).post("/pairing/invite", body: [:], as: PairingInvite.self)
            invite = result; code = Self.qrCode(result.uri)
        } catch {
            unsupported = API.isUnsupported(error)
            self.error = unsupported ? "Adding a device from here needs a newer Agent Remote on \(host.name). Until then, open Agent Remote on the Mac and use its pairing code." : error.localizedDescription
        }
    }
    static func qrCode(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8); filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: image)
    }
}

struct MemoryView: View {
    let host: Host
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [MemoryEntry] = []
    @State private var search = ""
    @State private var error: String?
    @State private var forgetting: MemoryEntry?
    var body: some View {
        NavigationStack {
            List {
                Section { Text("Learned automatically from chats and stored on this Mac. Relevant excerpts are shared with the agent you use.").font(.footnote).foregroundStyle(.secondary) }
                if let error { Text(error).foregroundStyle(Theme.failure) }
                ForEach(entries) { entry in
                    VStack(alignment: .leading, spacing: 8) {
                        if let topic = entry.topic { Text(topic.replacingOccurrences(of: "/", with: " › ")).font(.caption).foregroundStyle(Theme.accent) }
                        Text(entry.text).textSelection(.enabled)
                        if let trust = entry.trust { Text(trust).font(.caption).foregroundStyle(.secondary) }
                        if let quote = entry.quote { DisclosureGroup("Source") { Text(quote).font(.caption).textSelection(.enabled) } }
                    }.swipeActions { if entry.topic != nil { Button("Forget", role: .destructive) { forgetting = entry } } }
                }
                if entries.isEmpty { Text("No saved memories yet. Relevant chats are searchable immediately; learning runs after chats settle.").foregroundStyle(.secondary) }
            }.navigationTitle("Memory").searchable(text: $search, prompt: "Search remembered context")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task(id: search) {
                do { try await Task.sleep(for: .milliseconds(300)); let q = search.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+#"))) ?? ""; let result = try await API(host: host).get("/memory?q=" + q, as: MemoryResult.self); entries = result.results; error = result.warning }
                catch is CancellationError {} catch { self.error = error.localizedDescription }
            }
            .confirmationDialog("Forget this memory?", isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }), titleVisibility: .visible) {
                Button("Forget", role: .destructive) { if let entry = forgetting { Task {
                    do { _ = try await API(host: host).post("/memory/forget", body: ["id": entry.id], as: EmptyResponse.self); entries.removeAll { $0.id == entry.id } }
                    catch { self.error = error.localizedDescription }
                } }; forgetting = nil }
            } message: { Text("Removes this saved note and excludes its source message from future memory retrieval. The original chat stays in history.") }
        }
    }
}


private struct KnowledgePreview: Decodable, Identifiable {
    let id: String; let title: String; let summary: String; let parent: String?; let pending: Bool?
}
private struct KnowledgeLink: Decodable, Identifiable { let id: String; let title: String }
private struct KnowledgeResults: Decodable { let results: [KnowledgePreview]; let warning: String? }
private struct KnowledgePage: Decodable {
    let id: String; let title: String?; let markdown: String; let related: [KnowledgeLink]; let nextOffset: Int?
    let breadcrumbs: [KnowledgeLink]?; let children: [KnowledgeLink]?; let backlinks: [KnowledgeLink]?
    let revision: Int?; let pending: Bool?; let updatedAt: Double?
}
private struct KnowledgePageResult: Decodable { let page: KnowledgePage? }
private struct TalkPost: Decodable, Hashable { let role: String; let at: Double; let text: String; let decision: String? }
private struct TalkThread: Decodable, Identifiable { let id: String; let kind: String; let status: String; let title: String; let targetTitle: String?; let claims: [String]; let posts: [TalkPost] }
private struct Talk: Decodable { let open: Int; let threads: [TalkThread] }
private struct TalkResult: Decodable { let talk: Talk? }
private struct TalkPosted: Decodable { let ok: Bool }
// Talk pages record how the wiki's editors (and you) discussed and decided changes to an article.
private enum TalkText {
    static func kind(_ kind: String) -> String {
        ["update": "Update requested", "conflict": "Conflicting claims", "stale-claim": "Possibly outdated", "needs-verification": "Verification",
         "misplaced-evidence": "Misplaced claim", "merge-proposal": "Merge proposal", "split-proposal": "Split proposal", "move": "Move proposal",
         "note": "Note", "removal": "Removed from article", "handoff": "Moved here", "curation": "Reorganized", "merged": "Merged article", "comment": "Comment"][kind] ?? kind
    }
    static func role(_ role: String) -> String {
        ["steward": "Article steward", "curator": "Curator", "librarian": "Librarian", "verifier": "Verifier", "reviewer": "Reviewer", "session agent": "Chat agent", "user": "You"][role] ?? role
    }
    static func status(_ status: String) -> String { ["open": "Open", "accepted": "Accepted", "declined": "Declined", "resolved": "Recorded"][status] ?? status }
}
private func knowledgeQuery(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+#"))) ?? ""
}
private struct KnowledgeView: View {
    let host: Host
    @State private var search = ""
    @State private var pages: [KnowledgePreview] = []
    @State private var error: String?
    @State private var loading = false
    @State private var path: [String] = []
    @State private var generation = 0
    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                ListSearchField(text: $search, prompt: "Search knowledge")
                List {
                if search.isEmpty {
                    Text("Start with a subject and follow the links. Articles bring together what you’ve learned across chats.").font(.footnote).foregroundStyle(.secondary)
                    if pages.contains(where: { $0.pending == true }) { Text("\(pages.filter { $0.pending == true }.count) articles are being organized or updated.").font(.caption).foregroundStyle(.secondary) }
                    Section("Subjects") { ForEach(pages.filter { $0.parent == nil }) { page in articleRow(page) } }
                    Section { DisclosureGroup("All articles") { ForEach(pages.filter { $0.parent != nil }) { page in articleRow(page) } } }
                } else { ForEach(pages) { page in articleRow(page) } }
                if let error { Text(error).foregroundStyle(Theme.failure) }
                if loading { ProgressView("Loading articles…") }
                if pages.isEmpty && !loading { Text(search.isEmpty ? "Articles appear as chats are learned." : "No matching articles.").foregroundStyle(.secondary) }
                }.listStyle(.plain).scrollDismissesKeyboard(.interactively)
            }.navigationTitle("Knowledge").navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { id in KnowledgePageView(host: host, id: id, openArticle: { path.append($0) }, home: { path.removeAll() }) }
            .task(id: search) { do { try await Task.sleep(for: .milliseconds(300)); await load() } catch {} }
            .refreshable { await load() }
        }
    }
    private func articleRow(_ page: KnowledgePreview) -> some View {
        NavigationLink(value: page.id) {
            VStack(alignment: .leading, spacing: 6) { Text(page.title).font(.headline); Text(page.summary).font(.caption).foregroundStyle(.secondary).lineLimit(3) }.padding(.vertical, 4)
        }.accessibilityIdentifier("wiki-article-" + page.id)
    }
    private func load() async {
        generation += 1; let request = generation; let query = search; loading = true; error = nil
        defer { if generation == request { loading = false } }
        do {
            if query.isEmpty {
                // One lightweight call lists every article's title and metadata; prose and evidence load per article.
                let response = try await API(host: host).get("/knowledge/index", as: KnowledgeResults.self)
                try Task.checkCancellation(); guard request == generation else { return }
                error = response.warning; pages = response.results
                return
            }
            var result: [KnowledgePreview] = []; var offset = 0
            while true {
                let response = try await API(host: host).get("/knowledge?q=" + knowledgeQuery(query) + "&offset=\(offset)", as: KnowledgeResults.self)
                try Task.checkCancellation(); guard request == generation else { return }
                result.append(contentsOf: response.results.filter { incoming in !result.contains { $0.id == incoming.id } })
                offset += response.results.count; error = response.warning
                if response.results.isEmpty { break }
            }
            pages = result
        } catch is CancellationError {} catch { if request == generation { self.error = error.localizedDescription } }
    }
}
private struct KnowledgePageView: View {
    let host: Host; let id: String
    let openArticle: (String) -> Void
    let home: () -> Void
    @State private var markdown = ""
    @State private var page: KnowledgePage?
    @State private var error: String?
    @State private var loading = false
    @State private var sourcesExpanded = false
    @State private var talk: Talk?
    @State private var talkExpanded = false
    @State private var talkError: String?
    @State private var draft = ""
    @State private var posting = false
    private var mainText: String {
        let article = markdown.components(separatedBy: "\n\n## Related pages").first ?? markdown
        return article.components(separatedBy: "\n\n## Explore this topic").first ?? article
    }
    private var sections: [String] { mainText.components(separatedBy: "\n\n## ") }
    private var sources: String { markdown.components(separatedBy: "\n\n## Sources\n\n").dropFirst().joined(separator: "\n\n") }
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if loading { ProgressView("Opening article…") }
                    if let error { Text(error).foregroundStyle(Theme.failure); Button("Try again") { Task { await load() } } }
                    if let page {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack {
                                Button("Wiki", action: home)
                                ForEach(page.breadcrumbs ?? []) { item in Text("›").foregroundStyle(.secondary); Button(item.title) { openArticle(item.id) } }
                            }.font(.footnote)
                        }
                        if let updated = page.updatedAt {
                            Text("Updated \(Date(timeIntervalSince1970: updated / 1000).formatted(date: .abbreviated, time: .omitted))\(page.pending == true ? " · Update in progress" : "")").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    MessageMarkdown(text: sections.first ?? "").textSelection(.enabled)
                    if sections.count > 1 {
                        DisclosureGroup("Contents") {
                            VStack(alignment: .leading, spacing: 12) {
                                ForEach(Array(sections.dropFirst().enumerated()), id: \.offset) { index, section in
                                    Button(section.components(separatedBy: "\n").first ?? "Section") { withAnimation { proxy.scrollTo("section-\(index)", anchor: .top) } }.multilineTextAlignment(.leading)
                                }
                            }.padding(.top, 10)
                        }
                    }
                    ForEach(Array(sections.dropFirst().enumerated()), id: \.offset) { index, section in
                        MessageMarkdown(text: "## " + section).textSelection(.enabled).id("section-\(index)")
                    }
                    articleLinks("Explore this topic", page?.children ?? [])
                    articleLinks("See also", page?.related ?? [])
                    articleLinks("Linked from", page?.backlinks ?? [])
                    if page != nil { talkSection }
                    if !sources.isEmpty {
                        Divider()
                        DisclosureGroup("Sources and evidence", isExpanded: $sourcesExpanded) {
                            Text(sources).font(.footnote).textSelection(.enabled).padding(.top, 12)
                        }
                    }
                }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .navigationTitle(page?.title ?? "Article").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button(action: home) { Image(systemName: "house") }.accessibilityLabel("Wiki home") } }
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == "agentremote-wiki", url.host == "article",
                  let target = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "id" })?.value else { return .discarded }
            if target != id { openArticle(target) }; return .handled
        })
        .task(id: id) { await load(); await loadTalk() }
        .refreshable { await load(); await loadTalk() }
    }
    @ViewBuilder private var talkSection: some View {
        Divider()
        DisclosureGroup(isExpanded: $talkExpanded) {
            VStack(alignment: .leading, spacing: 14) {
                Text("Editors discuss this article here. A comment you post is treated as your own statement about the subject.").font(.footnote).foregroundStyle(.secondary)
                TextField("Correct or add to this article…", text: $draft, axis: .vertical).lineLimit(1...6).textFieldStyle(.roundedBorder)
                Button(posting ? "Posting…" : "Post comment") { Task { await postComment() } }
                    .disabled(posting || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if let talkError { Text(talkError).font(.footnote).foregroundStyle(Theme.failure) }
                if talk?.threads.isEmpty ?? true { Text("No discussion yet.").font(.footnote).foregroundStyle(.secondary) }
                ForEach(talk?.threads ?? []) { thread in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 6) {
                            Text(TalkText.kind(thread.kind)).font(.caption.bold()).padding(.horizontal, 7).padding(.vertical, 2).background(.quaternary, in: Capsule())
                            Text(TalkText.status(thread.status)).font(.caption).foregroundStyle(thread.status == "open" ? Theme.accent : Theme.info)
                        }
                        Text(thread.title).font(.subheadline.bold())
                        if let target = thread.targetTitle { Text("With: \(target)").font(.caption).foregroundStyle(.secondary) }
                        ForEach(thread.claims, id: \.self) { claim in Text("“\(claim)”").font(.caption).foregroundStyle(.secondary).lineLimit(4) }
                        ForEach(thread.posts, id: \.self) { post in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(TalkText.role(post.role)) · \(Date(timeIntervalSince1970: post.at / 1000).formatted(date: .abbreviated, time: .shortened))").font(.caption2).foregroundStyle(.secondary)
                                Text(post.text).font(.footnote).textSelection(.enabled)
                            }.padding(.leading, 8)
                        }
                    }.padding(10).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
                }
            }.padding(.top, 10)
        } label: {
            Text("Talk" + ((talk?.open ?? 0) > 0 ? " · \(talk!.open) open" : "")).font(.headline)
        }
    }
    private func loadTalk() async {
        do { talk = try await API(host: host).get("/knowledge/talk?id=" + knowledgeQuery(id), as: TalkResult.self).talk; talkError = nil }
        catch is CancellationError {} catch { talkError = error.localizedDescription }
    }
    // A comment is the user's own statement: the article's steward reads it as user-stated evidence.
    private func postComment() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines); guard !text.isEmpty else { return }
        posting = true; defer { posting = false }
        do { _ = try await API(host: host).post("/knowledge/talk", body: ["id": id, "text": text], as: TalkPosted.self); draft = ""; await loadTalk(); await load() }
        catch { talkError = error.localizedDescription }
    }
    @ViewBuilder private func articleLinks(_ title: String, _ links: [KnowledgeLink]) -> some View {
        if !links.isEmpty {
            Divider(); Text(title).font(.headline)
            ForEach(links) { item in Button { openArticle(item.id) } label: { HStack { Text(item.title).multilineTextAlignment(.leading); Spacer(); Image(systemName: "chevron.right").font(.caption) } }.padding(.vertical, 4) }
        }
    }
    private func load() async {
        guard !loading else { return }; loading = true; error = nil; markdown = ""
        defer { loading = false }
        do {
            var text = ""; var offset = 0; var revision: Int?
            while true {
                var route = "/knowledge/page?id=" + knowledgeQuery(id) + "&offset=\(offset)&budget=60000"
                if let revision { route += "&revision=\(revision)" }
                let response = try await API(host: host).get(route, as: KnowledgePageResult.self)
                try Task.checkCancellation()
                guard let article = response.page else { error = "This article is no longer available."; return }
                page = article; text += article.markdown; revision = article.revision
                guard let next = article.nextOffset, next > offset else { break }; offset = next
            }
            markdown = text
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }
}

struct ReplyNotificationSettings: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var notifications = ReplyNotifications.shared
    @AppStorage("replyNotifications") private var enabled = false
    @State private var working = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Notify me when an agent replies",isOn:Binding(get:{enabled},set:{value in
                        working = true;Task { await notifications.enable(value);enabled = notifications.enabled;working = false }
                    })).disabled(working)
                    Text(notifications.statusMessage).font(.caption).foregroundStyle(.secondary)
                    Text("Notifications use a generic message. Chat text and project names stay private.").font(.caption).foregroundStyle(.secondary)
                    if !Platform.isMac {
                        Button("Open iPhone notification settings") { if let url = URL(string:UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) } }
                    }
                }
            }.navigationTitle("Notifications").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement:.topBarTrailing) { Button("Done") { dismiss() } } }
                .task { await notifications.register() }
        }
    }
}

/// Shown above the chat list when Claude Code's login on the Mac is about to lapse or already has.
struct ClaudeAuthBanner: View {
    let status: ClaudeAuthStatus
    let hostName: String
    let signIn: () -> Void
    private var expired: Bool { status.state == "expired" }
    private var when: String {
        guard let expiresAt = status.expiresAt else { return "soon" }
        return Date(timeIntervalSince1970: expiresAt / 1000).formatted(.relative(presentation: .named))
    }
    var body: some View {
        Button(action: signIn) {
            HStack(spacing: 12) {
                Image(systemName: expired ? "person.crop.circle.badge.exclamationmark" : "clock.badge.exclamationmark").font(.title3).foregroundStyle(Theme.needsYou)
                VStack(alignment: .leading, spacing: 2) {
                    Text(expired ? "Claude is signed out" : "Claude sign-in expires \(when)").font(.subheadline.weight(.semibold))
                    Text(expired ? "New Claude messages on \(hostName) fail until you sign in." : "Renew it now so Claude chats on \(hostName) keep working.").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text("Sign in").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accent)
            }.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("claudeSignInBanner")
    }
}

/// Signs Claude Code in on the Mac from the phone. The Mac runs `claude auth login`, which prints an
/// Anthropic sign-in link and then waits for the code Anthropic shows after you approve; this view
/// carries the link to Safari and the code back. Tokens never pass through the phone.
struct ClaudeSignInView: View {
    let host: Host
    var onSignedIn: () -> Void = {}
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var login: ClaudeLoginStart?
    @State private var code = ""
    @State private var working = false
    @State private var error: String?
    @State private var signedIn: ClaudeAuthStatus?
    private var api: API { API(host: host) }
    private var trimmed: String { code.trimmingCharacters(in: .whitespacesAndNewlines) }
    var body: some View {
        NavigationStack {
            Form {
                if let signedIn {
                    Section {
                        Label("Claude is signed in on \(host.name).", systemImage: "checkmark.circle.fill").foregroundStyle(Theme.success)
                        if let expiresAt = signedIn.expiresAt {
                            Text("This sign-in lasts until \(Date(timeIntervalSince1970: expiresAt / 1000).formatted(date: .abbreviated, time: .shortened)). You'll get a reminder before then.").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Section { Text("Claude Code on \(host.name) needs a fresh sign-in. Approve it in Safari, then bring the code back here.").font(.footnote).foregroundStyle(.secondary) }
                    Section("1 · Approve in Safari") {
                        if let login, let url = URL(string: login.url) {
                            Button { openURL(url) } label: { Label("Open Claude sign-in", systemImage: "safari") }
                            Text("Sign in if asked and tap Authorize. Copy the code that appears, then return to Agent Remote.").font(.caption).foregroundStyle(.secondary)
                        } else if error == nil {
                            HStack(spacing: 10) { ProgressView(); Text("Getting a sign-in link from your Mac…").foregroundStyle(.secondary) }
                        }
                    }
                    Section("2 · Paste the code") {
                        HStack {
                            TextField("Code", text: $code).textInputAutocapitalization(.never).autocorrectionDisabled().font(.body.monospaced()).submitLabel(.done).onSubmit { Task { await submit() } }
                            PasteButton(payloadType: String.self) { values in
                                Task { @MainActor in if let value = values.first { code = value.trimmingCharacters(in: .whitespacesAndNewlines) } }
                            }.labelStyle(.iconOnly).buttonBorderShape(.capsule)
                        }
                        Button { Task { await submit() } } label: {
                            HStack { Text("Finish sign-in"); if working { Spacer(); ProgressView() } }
                        }.disabled(working || trimmed.isEmpty).accessibilityIdentifier("finishClaudeSignIn")
                    }.disabled(login == nil)
                    if let error {
                        Section {
                            Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(Theme.failure)
                            Button("Get a new link") { Task { await start() } }
                        }
                    }
                }
            }
            .navigationTitle("Sign in to Claude")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if signedIn == nil { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { cancel() } } }
                else { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss(); onSignedIn() } } }
            }
            .interactiveDismissDisabled(working)
            .task { await start() }
        }
    }
    private func start() async {
        error = nil; login = nil; code = ""
        do { login = try await api.post("/claude/auth/login", body: [:], as: ClaudeLoginStart.self) }
        catch { self.error = error.localizedDescription }
    }
    private func submit() async {
        guard let login, !working, !trimmed.isEmpty else { return }
        working = true; defer { working = false }
        do {
            let result = try await api.post("/claude/auth/login/code", body: ["id": login.id, "code": trimmed], as: ClaudeLoginResult.self)
            signedIn = result.claudeAuth ?? ClaudeAuthStatus(state: "ok")
        } catch {
            // The Mac ends a sign-in after a rejected code, so the next attempt needs a new link.
            self.error = error.localizedDescription; self.login = nil
        }
    }
    private func cancel() {
        if let id = login?.id { Task { _ = try? await api.post("/claude/auth/login/cancel", body: ["id": id], as: EmptyResponse.self) } }
        dismiss()
    }
}
