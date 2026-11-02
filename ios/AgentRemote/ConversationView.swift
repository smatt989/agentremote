import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import QuickLook
import AVKit

struct ConversationView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var confirmDelete = false
    @State private var showSessionControls = false
    @State private var showLimitPrompt = false
    @State private var promptedLimit: String?
    @State private var showTerminalControls = false
    @StateObject private var terminalSender = TerminalModel()
    @State private var operating = false
    @State var session: Session
    let host: Host
    @State private var cursor: Int?
    @State private var artifactsHash: String?
    @State private var imagesHash: String?
    @State private var cacheSavedAt = Date.distantPast
    /// Opens with the chat as it was last shown (LocalCache); refresh() then fetches only what changed.
    /// SwiftUI runs this init on every parent update, so it only takes the in-memory copy (a dictionary lookup).
    /// A copy that has to be read and decoded from disk is loaded off the main thread by loadCache().
    init(session: Session, host: Host) {
        self.host = host
        _session = State(initialValue: session)
        _queueUnsupported = State(initialValue: QueueSupport.unsupported.contains(host.id))
        if session.id.hasPrefix(AppState.pendingPrefix) { _historyLoaded = State(initialValue: true); _cacheChecked = State(initialValue: true); _startedNew = State(initialValue: true) }
        if let cached = LocalCache.remembered(host: host.id, session: session.id) {
            _messages = State(initialValue: cached.messages)
            _artifacts = State(initialValue: cached.artifacts)
            _cursor = State(initialValue: cached.cursor)
            _artifactsHash = State(initialValue: cached.artifactsHash)
            _imagesHash = State(initialValue: cached.imagesHash)
            _earlierCursor = State(initialValue: cached.earlierCursor)
            _hasOlder = State(initialValue: cached.hasOlder)
            _historyLoaded = State(initialValue: true)
            _cacheChecked = State(initialValue: true)
        }
    }
    @State private var cacheChecked = false
    /// Opened from the new-chat form, so the composer takes focus.
    @State private var startedNew = false
    @State private var queueUnsupported = false
    @State private var showFiles = false
    @Environment(\.scenePhase) private var phase
    @StateObject private var voice = Voice()
    @State private var messages: [Message] = []
    @State private var questions: [AgentQuestion] = []
    @State private var artifacts: [Artifact] = []
    @State private var showArtifacts = false
    @State private var attached: [Artifact] = []
    @State private var prompt = ""
    @State private var error: String?
    @State private var connectionError: String?
    @State private var sending = false
    @State private var outgoing: Message?
    @State private var outgoingBaseline = 0
    @State private var photo: PhotosPickerItem?
    @State private var importing = false
    @State private var dropTargeted = false
    @State private var autoSpeak = false
    @State private var lastSpoken: String?
    @State private var previewFile: PreviewFile?
    @State private var downloading: (name: String, progress: Double)?
    @State private var downloadedFiles: [String: URL] = [:]
    @State private var savedFile: URL?
    @FocusState private var composerFocused: Bool
    /// Off by default: in a working session most rows are tool calls and results, which bury the replies.
    @AppStorage("showToolActivity") private var showToolActivity = false
    @State private var pendingID: String?
    @State private var pendingText: String?
    @State private var pendingAttachments: [String] = []
    @State private var hasOlder = false
    @State private var earlierCursor: Int?
    @State private var historyLoaded = false
    @State private var followLatest = true
    @State private var isVisible = false
    @State private var acknowledgedToken: String?
    @State private var receiptRevision = 0
    @State private var atBottom = true
    @State private var draggingHistory = false
    @State private var contentGrew = false
    @State private var viewportHeight: CGFloat = 0
    @State private var signingIn = false
    @State private var resendText: String?
    @State private var renaming = false
    @State private var renameText = ""
    /// Set once a message has been sent from this device; until then an empty chat offers starter prompts.
    @AppStorage("sentFirstMessage") private var sentFirstMessage = false
    private var isRunning: Bool { ["running", "submitting"].contains(session.status) }
    /// The agent is mid-turn or waiting on a question: a new message would be queued (newer Macs).
    private var agentBusy: Bool { !questions.isEmpty || ["running", "submitting", "waiting", "compacting"].contains(session.status) }
    /// Terminal-shared chats type straight into Terminal, and pre-queue Macs reject sends during a turn.
    private var canQueue: Bool { session.terminal != true && !queueUnsupported }
    private var hasDraft: Bool { !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var scrollRevision: String { "\(outgoing?.id ?? "")-\(messages.count)-\(messages.last?.text.count ?? 0)-\(questions.count)-\(artifacts.count)-\(session.status)" }
    private var api: API { API(host: host) }
    private var path: String { API.sessionPath(session.id) }
    private var unavailable: Bool { session.control == "external-live" }
    /// Opened before the Mac has made the chat (AppState.startChat); `ready()` switches to the Mac's session.
    private var provisional: Bool { session.id.hasPrefix(AppState.pendingPrefix) }

    var body: some View {
        VStack(spacing: 0) {
            HStack { StatusBadge(status: sending ? "submitting" : session.status); Spacer(); Text(session.provider.uppercased()).font(.caption2.bold()).foregroundStyle(.mint) }.padding(.horizontal).padding(.vertical, 8)
            if let pause = session.rateLimit, pause.decision != "cancelled" {
                Button { showSessionControls = true } label: {
                    Label(pause.decision == "scheduled" ? "Waiting for usage to reset · Manage" : "Usage limit reached · Continue options", systemImage: "clock.arrow.circlepath")
                        .font(.caption).foregroundStyle(.orange).padding(8)
                }
            }
            if let note = session.note, unavailable { Text(note).font(.caption).foregroundStyle(.orange).padding(.horizontal) }
            if session.authRequired == true {
                Button { signingIn = true } label: {
                    Label("Claude is signed out on \(host.name) · Sign in", systemImage: "person.crop.circle.badge.exclamationmark")
                        .font(.caption).foregroundStyle(.orange).padding(8)
                }.accessibilityIdentifier("conversationClaudeSignIn")
            } else if let resend = resendText {
                HStack {
                    Label("Signed in", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    Spacer()
                    Button("Resend last message") { resendText = nil; prompt = resend; Task { await send() } }
                    Button { resendText = nil } label: { Image(systemName: "xmark") }.accessibilityLabel("Dismiss")
                }.font(.caption).padding(.horizontal).padding(.vertical, 6)
            }
            ScrollViewReader { proxy in
                // Queued follow-ups go last, in the order sent, until the Mac delivers them (newer replies may sort after them).
                let queued = messages.filter { $0.queued == true }.sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
                let items = TranscriptItem.build(queued.isEmpty ? messages : messages.filter { $0.queued != true }, showActivity: showToolActivity)
                let files = FilePlacement(artifacts, shown: items)
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        // Lazy, so a long chat lays out only what is on screen. The tail below stays eager: the
                        // bottom marker must always report its position for "Jump to latest" and re-pinning.
                        LazyVStack(alignment: .leading, spacing: 16) {
                            if hasOlder { Button("Load earlier messages") { Task { await older() } }.font(.caption).frame(minHeight: Theme.tapTarget) }
                            if messages.isEmpty && outgoing == nil && historyLoaded {
                                ContentUnavailableView("Ready when you are", systemImage: "text.bubble", description: Text("Send a prompt, image, or voice message to your Mac."))
                                if !sentFirstMessage && session.terminal != true { starters }
                            }
                            ForEach(items) { item in
                                switch item {
                                case .message(let message):
                                    MessageView(message: message, api: api, sessionID: session.id, speak: { voice.speak(message.text) },
                                                files: files.byMessage[message.id] ?? [], openFile: { file in Task { await preview(file) } },
                                                saveFile: { file, action in Task { await save(file, action) } })
                                    .id(message.id)
                                case .hidden(let id, let count):
                                    Button { showToolActivity = true } label: {
                                        Label(count == 1 ? "1 tool step hidden" : "\(count) tool steps hidden", systemImage: "wrench.and.screwdriver").font(.caption2).foregroundStyle(.tertiary)
                                    }.buttonStyle(.plain).id(id).accessibilityHint("Shows tool activity")
                                }
                            }
                        }
                        if let outgoing {
                            MessageView(message: outgoing, api: api, speak: { voice.speak(outgoing.text) })
                            if sending { Text("Sending…").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .trailing).accessibilityIdentifier("messageSending") }
                        }
                        ForEach(questions) { question in
                            QuestionCard(question: question, disabled: sending || operating || question.readOnly == true || (question.native != true && ["running", "submitting"].contains(session.status))) { answers in
                                sending = true
                                Task { defer { sending = false }; do {
                                    _ = try await api.post(path + "/questions/" + question.id + "/answer", body: ["answers": answers], as: EmptyResponse.self)
                                    error = nil; await refresh()
                                } catch { self.error = error.localizedDescription } }
                            }
                        }
                        // Files no reply claims (older Macs, or the reply is not loaded) keep the list at the end.
                        if !files.unattached.isEmpty {
                            DisclosureGroup(isExpanded: $showArtifacts) {
                                if showArtifacts {
                                    LazyVStack(alignment: .leading, spacing: 10) {
                                        ForEach(files.unattached) { artifact in
                                            ArtifactView(artifact: artifact, api: api) { Task { await preview(artifact) } } save: { action in Task { await save(artifact, action) } }
                                        }
                                    }.padding(.top, 8)
                                }
                            } label: {
                                Label("Files & charts (\(files.unattached.count))", systemImage: "paperclip")
                                    .font(.callout).foregroundStyle(.secondary)
                            }
                            .accessibilityIdentifier("conversationFiles")
                            .padding(.top, 8)
                        }
                        if isRunning {
                            HStack(spacing: 10) { ProgressView().tint(.mint); Text("Working on your Mac…").font(.callout).foregroundStyle(.secondary); Spacer() }
                                .padding(.vertical, 12).accessibilityIdentifier("turnActivity")
                        } else if session.status == "waiting" { Label("Waiting for an answer", systemImage: "questionmark.bubble").foregroundStyle(.orange) }
                        ForEach(queued) { message in
                            MessageView(message: message, api: api, sessionID: session.id, cancelQueued: { Task { await cancelQueued(message) } }).id(message.id)
                        }
                        Color.clear.frame(height: 16).id("conversation-bottom")
                            .background(GeometryReader { geometry in Color.clear.preference(key: BottomPositionKey.self, value: geometry.frame(in: .named("conversation-scroll")).maxY) })
                    }.padding()
                }
                .coordinateSpace(name: "conversation-scroll").accessibilityIdentifier("conversationHistory")
                .scrollDismissesKeyboard(.interactively)
                .background(GeometryReader { geometry in Color.clear.onAppear { viewportHeight = geometry.size.height }.onChange(of: geometry.size.height) { _, height in viewportHeight = height; contentGrew = true } })
                .onPreferenceChange(BottomPositionKey.self) { bottom in
                    guard viewportHeight > 0 else { return }
                    atBottom = bottom <= viewportHeight + 24
                    if atBottom && !draggingHistory { followLatest = true }
                    if atBottom { contentGrew = false }
                    // Re-pin only for new content; scrolling up by itself must never be undone.
                    if followLatest && contentGrew && !atBottom && !draggingHistory { DispatchQueue.main.async { proxy.scrollTo("conversation-bottom", anchor: .bottom) } }
                }
                .simultaneousGesture(DragGesture().onChanged { _ in draggingHistory = true; followLatest = false }.onEnded { _ in draggingHistory = false; followLatest = atBottom })
                // Trackpad and mouse-wheel scrolling on Mac is not a drag, so watch the scroll phase as well.
                .modifier(UserScrollTracking { active in
                    if active { draggingHistory = true; followLatest = false } else { draggingHistory = false; followLatest = atBottom }
                })
                .defaultScrollAnchor(.bottom)
                .onChange(of: scrollRevision) { _, _ in
                    contentGrew = true
                    if followLatest { DispatchQueue.main.async { proxy.scrollTo("conversation-bottom", anchor: .bottom) } }
                }
                .overlay(alignment: .bottomTrailing) {
                    if !atBottom { Button {
                        followLatest = true
                        proxy.scrollTo("conversation-bottom", anchor: .bottom)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { proxy.scrollTo("conversation-bottom", anchor: .bottom) }
                    } label: { Image(systemName: "arrow.down").font(.headline).frame(width: 46, height: 46).background(.regularMaterial, in: Circle()).contentShape(Circle()) }
                    .buttonStyle(.plain).accessibilityLabel("Jump to latest message").accessibilityIdentifier("jumpToBottom").padding(12) }
                }
            }
            if let downloading {
                HStack {
                    Text("Downloading \(downloading.name)").font(.caption).lineLimit(1).truncationMode(.middle)
                    ProgressView(value: downloading.progress).frame(maxWidth: 140)
                    Text(downloading.progress, format: .percent.precision(.fractionLength(0))).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                .padding(.horizontal).padding(.vertical, 6)
            }
            if let savedFile {
                HStack {
                    Label("Saved \(savedFile.lastPathComponent) to Downloads", systemImage: "checkmark.circle.fill").font(.caption).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 8)
                    Button("Show in Finder") { Task { _ = await UIApplication.shared.open(savedFile.deletingLastPathComponent()) } }.font(.caption)
                    Button { self.savedFile = nil } label: { Image(systemName: "xmark") }.font(.caption).accessibilityLabel("Dismiss")
                }
                .padding(.horizontal).padding(.vertical, 6).accessibilityIdentifier("artifactSaved")
            }
            if let error = error ?? connectionError ?? voice.error {
                HStack(alignment: .top) {
                    Text(error).font(.caption).foregroundStyle(.orange)
                    Spacer(minLength: 8)
                    CopyTextButton(text: error, label: "Copy error").labelStyle(.iconOnly)
                }
                .padding(.horizontal).padding(.vertical, 6)
                .contextMenu { CopyTextButton(text: error, label: "Copy error") }
            }
            composer
        }
        .onDrop(of: [.item], isTargeted: $dropTargeted, perform: drop)
        .overlay {
            if dropTargeted && session.terminal != true {
                RoundedRectangle(cornerRadius: 14).strokeBorder(Color.mint, style: StrokeStyle(lineWidth: 2, dash: [8]))
                    .background(Color.mint.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                    .overlay { Label("Drop to attach", systemImage: "paperclip").font(.headline).foregroundStyle(.mint) }
                    .padding(8).allowsHitTesting(false)
            }
        }
        .background(Color(uiColor: .systemBackground))
        .navigationTitle(session.title).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !artifacts.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showFiles = true } label: {
                        HStack(spacing: 3) { Image(systemName: "paperclip"); Text("\(artifacts.count)").font(.callout.monospacedDigit()) }
                    }
                    .accessibilityLabel("Files, \(artifacts.count)").accessibilityIdentifier("chatFilesButton").help("Files in this chat")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showToolActivity.toggle() } label: {
                    Image(systemName: showToolActivity ? "wrench.and.screwdriver.fill" : "wrench.and.screwdriver")
                }
                .accessibilityLabel(showToolActivity ? "Hide tool activity" : "Show tool activity")
                .accessibilityIdentifier("toggleToolActivity").help(showToolActivity ? "Hide tool activity" : "Show tool activity")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Toggle("Show tool activity", systemImage: "wrench.and.screwdriver", isOn: $showToolActivity)
                    if session.terminal == true { Button("Terminal controls", systemImage: "terminal") { showTerminalControls = true } }
                    Button("Model, effort & usage", systemImage: "slider.horizontal.3") { showSessionControls = true }.disabled(provisional)
                    if !state.renameUnsupported.contains(host.id) {
                        Button("Rename", systemImage: "pencil") { renameText = session.title; renaming = true }.disabled(operating || provisional)
                    }
                    Toggle("Speak replies", isOn: $autoSpeak)
                    Button("Stop speaking") { voice.stopSpeaking() }
                    Button("Interrupt turn", systemImage: "stop.circle") { Task { await stop(end: false) } }.disabled(unavailable || operating || provisional)
                    Button("End chat", systemImage: "xmark.circle") { Task { await stop(end: true) } }.disabled(unavailable || operating || provisional)
                    Button("Delete chat", systemImage: "trash", role: .destructive) { confirmDelete = true }.disabled(unavailable || operating || provisional)
                } label: { Image(systemName: "ellipsis.circle") }
            }
        }
        .alert("Usage limit reached", isPresented: $showLimitPrompt) {
            Button("Continue when it resets") { Task { await chooseRetry("scheduled") } }
            Button("See options") { showSessionControls = true }
            Button("Not now", role: .cancel) { Task { await chooseRetry("cancelled") } }
        } message: { Text("Would you like Agent Remote to continue this work automatically when usage becomes available? Your Mac must remain running.") }
        .sheet(isPresented: $showSessionControls) {
            SessionControlsView(session: session, api: api) { next in
                if next.id != session.id { messages = []; questions = []; artifacts = []; historyLoaded = false; outgoing = nil; earlierCursor = nil; hasOlder = false; cursor = nil; artifactsHash = nil; imagesHash = nil }
                session = next
                showSessionControls = false
                Task { await refresh() }
            }
        }
        .confirmationDialog("Delete chat permanently?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete permanently", role: .destructive) { Task { await delete() } }
        } message: { Text(session.deletionMessage) }
        .alert("Rename chat", isPresented: $renaming) {
            TextField("Name", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Save") { Task { await rename() } }
        }
        .task(id: phase) {
            await loadCache()
            // iOS hands first responder back on return to the app, which reopened the keyboard over the chat.
            guard phase == .active else { if voice.recording { appendDictation(voice.transcript) }; voice.stop(); composerFocused = false; saveCache(force: true); return }
            while !Task.isCancelled { if await ready() { await refresh() }; do { try await Task.sleep(for: .seconds(1)) } catch { break } }
        }
        .task {
            // iOS drops focus requested while the new-chat sheet is still closing.
            guard startedNew, !Platform.isMac else { return }
            do { try await Task.sleep(for: .milliseconds(450)); composerFocused = true } catch {}
        }
        .onAppear { isVisible = true; state.visibleSessionID = session.id }
        .onDisappear { isVisible = false; composerFocused = false; saveCache(force: true); if state.visibleSessionID == session.id { state.visibleSessionID = nil }; voice.stop(); voice.stopSpeaking() }
        .task(id: "\(phase)-\(isVisible)-\(atBottom)-\(showArtifacts)-\(receiptRevision)-\(session.latestAssistantToken ?? "")") {
            do { try await Task.sleep(for: .milliseconds(350)); await acknowledgeVisibleResponse() } catch {}
        }
        .onChange(of: photo) { _, value in
            guard let value else { return }
            Task {
                do {
                    if let data = try await value.loadTransferable(type: Data.self), let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) { try await upload(jpeg, name: "photo-\(UUID().uuidString.prefix(8)).jpg") }
                    else { error = "This photo could not be loaded." }
                } catch { self.error = error.localizedDescription }
                photo = nil
            }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            Task { do {
                for url in try result.get() {
                    let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }
                    try await upload(Data(contentsOf: url), name: url.lastPathComponent)
                }
            } catch { self.error = error.localizedDescription } }
        }
        .sheet(isPresented: $showTerminalControls) { NavigationStack { TerminalView(session: session, host: host).toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { showTerminalControls = false } } } } }
        .sheet(item: $previewFile) { file in ArtifactPreview(file: file).modifier(LargeMacSheet()) }
        .sheet(isPresented: $showFiles) {
            ChatFilesSheet(files: artifacts.reversed(), fetch: { file in await fetch(file).map { PreviewFile(url: $0, name: file.name, mime: file.mime) } }, save: { file, action in Task { await save(file, action) } })
                .modifier(LargeMacSheet())
        }
        .sheet(isPresented: $signingIn) {
            ClaudeSignInView(host: host) {
                resendText = messages.last(where: { $0.role == "user" && $0.kind == "text" })?.text
                Task { await refresh(); await state.refresh() }
            }
        }
    }
    /// Suggestions for someone's first chat. A tap fills the composer; nothing is sent until they choose to.
    private var starters: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(["Summarize what’s in my Downloads folder", "Take a screenshot of my Mac and describe what’s open", "What do you know about me so far?"], id: \.self) { text in
                Button { prompt = text; if !Platform.isMac { composerFocused = true } } label: {
                    Text(text).font(.callout).multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                }.buttonStyle(.plain).accessibilityHint("Adds this to the message box")
            }
            Text("Tip: on your Mac, run `pickup` in Terminal to continue a phone chat at your desk.").font(.caption).foregroundStyle(.secondary).padding(.top, 4)
        }.frame(maxWidth: 520).frame(maxWidth: .infinity).accessibilityIdentifier("starterPrompts")
    }
    /// While the agent works, a message is queued and sent when it finishes (newer Macs); older Macs and
    /// Terminal-shared chats keep Send disabled until the turn ends, as before.
    private var canSend: Bool {
        hasDraft && !sending && outgoing == nil && !operating && !unavailable && (!agentBusy || canQueue)
    }
    /// With nothing typed, the Send button becomes Stop while the agent works.
    private var showStop: Bool { isRunning && !hasDraft && attached.isEmpty && !sending && !unavailable }
    private var placeholder: String {
        if !questions.isEmpty && canQueue { return "Answer the question above, or type to queue a message" }
        if agentBusy && queueUnsupported && session.terminal != true { return "Message your Mac… (send when this reply finishes)" }
        return "Message your Mac…"
    }
    private var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !attached.isEmpty {
                ScrollView(.horizontal) { HStack { ForEach(attached) { file in Button { attached.removeAll { $0.id == file.id } } label: { Label(file.name, systemImage: "xmark.circle.fill").font(.caption) } } } }
            }
            if voice.recording { Text(voice.transcript.isEmpty ? "Listening…" : voice.transcript).font(.callout).foregroundStyle(.mint) }
            Group {
                if Platform.isMac {
                    MacComposerField(text: $prompt, disabled: sending, focusOnAppear: startedNew) { if canSend { Task { await send() } } }
                        .overlay(alignment: .topLeading) { if prompt.isEmpty { Text(placeholder == "Message your Mac…" ? "Message your Mac… (Return to send, Shift-Return for a new line)" : placeholder).foregroundStyle(.tertiary).allowsHitTesting(false) } }
                } else {
                    TextField(placeholder, text: $prompt, axis: .vertical).lineLimit(1...6).disabled(sending)
                        .focused($composerFocused).accessibilityIdentifier("composer")
                }
            }.padding(12).background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
            HStack(spacing: 20) {
                if session.terminal != true {
                PhotosPicker(selection: $photo, matching: .images) { Image(systemName: "photo") }.accessibilityLabel("Attach photo")
                Button { importing = true } label: { Image(systemName: "paperclip") }.accessibilityLabel("Attach file")
                }
                Button {
                    if voice.recording { Task { appendDictation(await voice.finish()) } }
                    else { Task { await voice.start() } }
                } label: { Image(systemName: voice.recording ? "stop.circle.fill" : "mic").foregroundStyle(voice.recording ? Color.red : Color.mint) }.accessibilityLabel(voice.recording ? "Finish recording" : "Record prompt")
                Spacer()
                if composerFocused && !Platform.isMac {
                    Button { composerFocused = false } label: { Image(systemName: "keyboard.chevron.compact.down") }
                        .accessibilityLabel("Hide keyboard").accessibilityIdentifier("hideKeyboard")
                }
                if showStop {
                    Button { Task { await stop(end: false) } } label: {
                        Image(systemName: "stop.fill").font(.headline).frame(width: 34, height: 34).background(Theme.accent, in: Circle()).foregroundStyle(.black)
                    }
                    .disabled(operating).keyboardShortcut(".", modifiers: .command)
                    .accessibilityLabel("Stop").accessibilityHint("Interrupts the agent").accessibilityIdentifier("stopTurn").help("Stop the agent (⌘.)")
                } else {
                    Button { Task { await send() } } label: { if sending { ProgressView() } else { Image(systemName: "arrow.up").font(.headline).frame(width: 34, height: 34).background(Theme.accent, in: Circle()).foregroundStyle(.black) } }
                        .disabled(!canSend).keyboardShortcut(.return, modifiers: .command)
                        .accessibilityLabel("Send message").accessibilityHint(agentBusy && canQueue ? "Queues it until the agent finishes" : "")
                }
            }.padding(.horizontal, 4)
        }.padding().background(.bar)
    }
    /// For a chat opened before the Mac made it: waits for the Mac's session and switches to it. A failed start is
    /// shown as the error and tried again only on `retry` (sending or attaching), so polling does not repeat it.
    private func ready(retry: Bool = false) async -> Bool {
        guard provisional else { return true }
        let id = session.id
        do {
            let created = try await state.createdChat(id, retry: retry)
            guard session.id == id else { return true }
            if state.visibleSessionID == id { state.visibleSessionID = created.id }
            session = created; error = nil
            return true
        } catch is CancellationError { return false } catch {
            self.error = "Couldn’t start this chat on \(host.name): \(error.localizedDescription) Send again to retry."
            return false
        }
    }
    private func refresh() async {
        do {
            // 0.7.8+ Macs answer `?since=` with only the rows changed since `cursor`; older Macs ignore it and
            // send the full page, which is handled exactly as before.
            let query = cursor.map { "?since=\($0)&artifacts=\(artifactsHash ?? "")&images=\(imagesHash ?? "")" } ?? ""
            let detail = try await api.get(path + query, as: SessionDetail.self)
            let previous = session.status
            if session != detail.session { session = detail.session }
            if detail.session.queued != nil, queueUnsupported { QueueSupport.unsupported.remove(host.id); queueUnsupported = false }
            if let pause = session.rateLimit, pause.decision == "ask", promptedLimit != pause.id {
                promptedLimit = pause.id; showLimitPrompt = true
            }
            var merged: [Message]
            if detail.delta == true {
                merged = ConversationMerge.apply(messages, detail, hasOlder: hasOlder)
            } else {
                // A full page. Keep rows loaded earlier only if the page overlaps them (otherwise the cache is
                // older than one page and keeping it would leave a gap), as before the cache existed.
                let pageIDs = Set(detail.messages.map(\.id) + detail.messages.compactMap(\.requestId))
                let overlaps = historyLoaded && (detail.nextBefore == nil || messages.contains { pageIDs.contains($0.id) })
                let first = detail.messages.first
                merged = (overlaps ? messages.filter { old in !pageIDs.contains(old.id) && first.map { old.precedes($0) } == true } : []) + detail.messages
                if !overlaps { earlierCursor = detail.nextBefore; hasOlder = earlierCursor != nil }
                historyLoaded = true
            }
            if hasOlder, let oldest = merged.first?.seq { earlierCursor = oldest }
            if let outgoing, merged.contains(where: { $0.id == outgoing.id || $0.requestId == outgoing.id || ($0.role == "user" && $0.text.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines) == outgoing.text.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines) && ($0.seq ?? 0) > outgoingBaseline) }) { self.outgoing = nil }
            // Assign only real changes, so an idle poll does not make SwiftUI lay the transcript out again.
            let changed = merged != messages || (detail.artifacts.map { $0 != artifacts } ?? false)
            if merged != messages { messages = merged }
            if let files = detail.artifacts, files != artifacts { artifacts = files }
            let pending = detail.questions ?? []
            if pending != questions { questions = pending }
            if connectionError != detail.warning { connectionError = detail.warning }
            cursor = detail.cursor; artifactsHash = detail.artifactsHash; imagesHash = detail.imagesHash
            receiptRevision += 1
            if changed { saveCache() }
            if autoSpeak, previous == "running", session.status == "idle", let message = messages.last(where: { $0.role == "assistant" && $0.kind == "text" }), message.id != lastSpoken { lastSpoken = message.id; voice.speak(message.text) }
        } catch is CancellationError {} catch {
            if case AppError.message(let text) = error, text == "Session not found." { LocalCache.remove(host: host.id, key: "conversation:" + session.id) }
            self.connectionError = error.localizedDescription
        }
    }
    /// Writes the snapshot off the main thread, at most every 5 s while a reply streams (always when leaving).
    private func saveCache(force: Bool = false) {
        guard historyLoaded, !provisional, !messages.isEmpty, force || Date().timeIntervalSince(cacheSavedAt) > 5 else { return }
        cacheSavedAt = Date()
        let snapshot = ConversationSnapshot(session: session, messages: messages, artifacts: artifacts, cursor: cursor, artifactsHash: artifactsHash, imagesHash: imagesHash, earlierCursor: earlierCursor, hasOlder: hasOlder)
        let hostID = host.id
        Task.detached(priority: .utility) { LocalCache.storeConversation(snapshot, host: hostID) }
    }
    private func acknowledgeVisibleResponse() async {
        guard !Task.isCancelled, isVisible, phase == .active, atBottom, !showArtifacts,
              let token = session.latestAssistantToken, token != acknowledgedToken,
              messages.contains(where: { $0.id == session.latestAssistantMessageId && $0.partial != true }) else { return }
        do {
            let result = try await api.post(path + "/read", body: ["token": token], as: ReadResponse.self)
            acknowledgedToken = token
            if let index = state.sessions.firstIndex(where: { $0.id == session.id }) { state.sessions[index] = result.session }
        } catch { /* Retry on the next completed refresh; fetching is not a read receipt. */ }
    }
    private func chooseRetry(_ decision: String) async {
        do { _ = try await api.post(path + "/retry", body: ["decision": decision], as: ReadResponse.self); await refresh() }
        catch { self.error = error.localizedDescription }
    }
    private func older() async {
        guard let seq = earlierCursor else { hasOlder = false; return }
        do { let detail = try await api.get(path + "?before=\(seq)", as: SessionDetail.self); messages = detail.messages + messages; earlierCursor = detail.nextBefore; hasOlder = earlierCursor != nil }
        catch { self.error = error.localizedDescription }
    }
    private func appendDictation(_ text: String) {
        let text = text.trimmingCharacters(in: .whitespaces)
        if !text.isEmpty { prompt += (prompt.isEmpty ? "" : " ") + text }
    }
    private func send() async {
        guard !sending, outgoing == nil, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        sending = true; defer { sending = false }
        let text = prompt; let files = attached; let ids = files.map(\.id)
        // Keep the same ID on a retry after an ambiguous network failure.
        if pendingText != text || pendingAttachments != ids { pendingID = UUID().uuidString; pendingText = text; pendingAttachments = ids }
        let requestID = pendingID ?? UUID().uuidString; pendingID = requestID
        outgoingBaseline = messages.compactMap(\.seq).max() ?? 0
        outgoing = Message(id: requestID, role: "user", kind: "text", text: text)
        let queueing = agentBusy
        followLatest = true; prompt = ""; attached = []; error = nil
        // Put the keyboard away so the reply can be read; tapping the composer brings it back.
        if !Platform.isMac { composerFocused = false }
        // A first message typed before the Mac made the chat shows as "Sending…" until it has.
        guard await ready(retry: true) else { outgoing = nil; if prompt.isEmpty { prompt = text; attached = files }; return }
        do {
            if session.terminal == true {
                try await terminalSender.sendPrompt(text, requestID: requestID, api: api, path: path)
            } else {
            let reply = try await api.post(path + "/messages", body: ["requestId": requestID, "text": text, "attachments": ids], as: SendReply.self)
            // A queued message comes back as stored; show it in place now (with its Cancel) instead of as "Sending…".
            if let stored = reply.message {
                if let index = messages.firstIndex(where: { $0.id == stored.id }) { messages[index] = stored } else { messages.append(stored) }
                outgoing = nil
            }
            }
            pendingID = nil; pendingText = nil; error = nil; sentFirstMessage = true
            Task { await refresh() }
        } catch {
            outgoing = nil
            if prompt.isEmpty { prompt = text; attached = files }
            if queueing, case AppError.message(let text) = error, QueueSupport.olderMacErrors.contains(text) {
                // A Mac from before queueing: fall back to sending once the turn ends, and say why.
                QueueSupport.unsupported.insert(host.id); queueUnsupported = true
                self.error = "Agent Remote on \(host.name) can’t hold a message until the agent finishes. Send it when this reply is done, or update Agent Remote on the Mac."
            } else { self.error = error.localizedDescription }
        }
    }
    /// `POST /sessions/:id/queue/cancel`: takes a queued message back before the agent gets it.
    /// A 409 (already sent) or 404 (unknown) means there is nothing left to cancel: refresh shows what happened.
    private func cancelQueued(_ message: Message) async {
        do {
            _ = try await api.post(path + "/queue/cancel", body: ["id": message.id], as: EmptyResponse.self)
            messages.removeAll { $0.id == message.id }
            error = nil; saveCache(force: true); await refresh()
        } catch {
            await refresh()
            if messages.contains(where: { $0.id == message.id && $0.queued == true }) { self.error = error.localizedDescription }
        }
    }
    /// The chat as last shown, read and decoded off the main thread when it is not already in memory (L-8).
    /// Runs before the first poll, so the poll can ask for only what changed since.
    private func loadCache() async {
        guard !cacheChecked else { return }
        let hostID = host.id, sessionID = session.id
        let cached = await Task.detached(priority: .userInitiated) { LocalCache.conversation(host: hostID, session: sessionID) }.value
        cacheChecked = true
        guard let cached, sessionID == session.id, !historyLoaded, messages.isEmpty else { return }
        messages = cached.messages; artifacts = cached.artifacts
        cursor = cached.cursor; artifactsHash = cached.artifactsHash; imagesHash = cached.imagesHash
        earlierCursor = cached.earlierCursor; hasOlder = cached.hasOlder; historyLoaded = true
    }
    private func upload(_ data: Data, name: String) async throws {
        guard data.count <= 20_000_000 else { throw AppError.message("Choose a file smaller than 20 MB.") }
        guard await ready(retry: true) else { return }
        let artifact = try await api.post(path + "/artifacts", body: ["name": name, "base64": data.base64EncodedString()], as: Artifact.self)
        attached.append(artifact)
    }
    /// Files dragged in from Finder or another app attach exactly like the paperclip. Plain text and link drags are left to the composer.
    private func drop(_ providers: [NSItemProvider]) -> Bool {
        let files = providers.filter { $0.suggestedName != nil || !($0.hasItemConformingToTypeIdentifier(UTType.text.identifier) || $0.hasItemConformingToTypeIdentifier(UTType.url.identifier)) }
        guard session.terminal != true, !files.isEmpty else { return false }
        Task { for provider in files {
            do { let (data, name) = try await Self.load(provider); try await upload(data, name: name) }
            catch { self.error = error.localizedDescription }
        } }
        return true
    }
    nonisolated private static func load(_ provider: NSItemProvider) async throws -> (Data, String) {
        try await withCheckedThrowingContinuation { continuation in
            // The copy is deleted when the handler returns, so read it here.
            _ = provider.loadFileRepresentation(forTypeIdentifier: UTType.item.identifier) { url, error in
                guard let url, let data = try? Data(contentsOf: url) else { continuation.resume(throwing: error ?? AppError.message("This item could not be attached.")); return }
                continuation.resume(returning: (data, url.lastPathComponent))
            }
        }
    }
    private func rename() async {
        let title = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title != session.title else { return }
        operating = true; defer { operating = false }
        do { session = try await state.rename(session, to: title, host: host); saveCache(force: true) }
        catch { self.error = error.localizedDescription }
    }
    private func delete() async {
        operating = true; defer { operating = false }
        do { _ = try await api.request(path + "/delete", method: "POST"); LocalCache.remove(host: host.id, key: "conversation:" + session.id); state.sessions.removeAll { $0.id == session.id }; dismiss(); await state.refresh() }
        catch { self.error = error.localizedDescription }
    }
    private func stop(end: Bool) async {
        operating = true; defer { operating = false }
        do { _ = try await api.request(path + (end ? "/end" : "/stop"), method: "POST"); error = nil; await refresh() } catch { self.error = error.localizedDescription }
    }
    /// Fetches a file once per visit, so opening it and then saving it does not download it twice.
    private func fetch(_ artifact: Artifact) async -> URL? {
        if let url = downloadedFiles[artifact.id], FileManager.default.fileExists(atPath: url.path) { return url }
        guard downloading == nil else { return nil }
        downloading = (artifact.name, 0); defer { downloading = nil }
        do {
            let url = try await api.download(artifact) { fraction in Task { @MainActor in if downloading != nil { downloading = (artifact.name, fraction) } } }
            downloadedFiles[artifact.id] = url
            return url
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
        return nil
    }
    private func preview(_ artifact: Artifact) async {
        guard let url = await fetch(artifact) else { return }
        previewFile = PreviewFile(url: url, name: artifact.name, mime: artifact.mime)
    }
    private func save(_ artifact: Artifact, _ action: ArtifactFiles.Action) async {
        guard let url = await fetch(artifact) else { return }
        do { if let saved = try await ArtifactFiles.perform(action, url: url) { savedFile = saved; error = nil } }
        catch { self.error = error.localizedDescription }
    }
}
/// The transcript as shown: with tool activity hidden, each run of tool/status rows collapses into one small marker.
enum TranscriptItem: Identifiable {
    case message(Message), hidden(id: String, count: Int)
    var id: String { switch self { case .message(let m): m.id; case .hidden(let id, _): id } }
    static func build(_ messages: [Message], showActivity: Bool) -> [TranscriptItem] {
        if showActivity { return messages.map { .message($0) } }
        var items: [TranscriptItem] = [], run: [Message] = []
        func flush() { if let first = run.first { items.append(.hidden(id: "hidden:" + first.id, count: run.count)); run = [] } }
        for message in messages {
            if message.isActivity { run.append(message) } else { flush(); items.append(.message(message)) }
        }
        flush()
        return items
    }
}
extension Message {
    /// Tool calls and results, plus system status notes. Errors and "needs attention" notices always stay visible.
    var isActivity: Bool { role == "tool" || (role == "system" && !["error", "attention"].contains(kind)) }
}
struct CopyTextButton: View {
    let text: String
    let label: String
    var body: some View {
        Button {
            // Replace all representations so Universal Clipboard receives text only.
            UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: text]])
        } label: { Label(label, systemImage: "doc.on.doc") }
        .accessibilityLabel(label)
    }
}
struct ArtifactView: View {
    let artifact: Artifact
    let api: API
    var open: () -> Void
    var save: (ArtifactFiles.Action) -> Void
    private var icon: String {
        switch MediaKind(name: artifact.name, mime: artifact.mime) {
        case .video: "play.rectangle"
        case .audio: "waveform"
        case nil: "doc.text.magnifyingglass"
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if artifact.mime.hasPrefix("image/") { InlineArtifactImage(artifact: artifact, api: api) }
            HStack(alignment: .firstTextBaseline) {
                Button(action: open) { Label(artifact.name, systemImage: icon).font(.callout).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading) }
                    .buttonStyle(.borderless)
                Button { save(ArtifactFiles.primarySave) } label: { Image(systemName: "arrow.down.circle") }
                    .buttonStyle(.borderless).help(ArtifactFiles.primarySaveTitle)
                    .accessibilityLabel("\(ArtifactFiles.primarySaveTitle) \(artifact.name)")
            }
        }
        .padding(12).background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
        .contextMenu {
            Button(action: open) { Label("Open", systemImage: icon) }
            Button { save(ArtifactFiles.primarySave) } label: { Label(ArtifactFiles.primarySaveTitle, systemImage: "arrow.down.circle") }
            if Platform.isMac {
                Button { save(.saveAs) } label: { Label("Save As…", systemImage: "square.and.arrow.down") }
                Button { save(.openInDefaultApp) } label: { Label("Open in Default App", systemImage: "arrow.up.forward.app") }
            }
        }
    }
}
/// Video and audio play in AVKit; Quick Look on Mac Catalyst shows only a still frame of a movie.
enum MediaKind {
    case video, audio
    init?(name: String, mime: String) {
        let ext = (name as NSString).pathExtension.lowercased()
        if ["mp4", "m4v", "mov"].contains(ext) || ["video/mp4", "video/quicktime", "video/x-m4v"].contains(mime) { self = .video }
        else if ["mp3", "m4a", "wav", "aac", "aif", "aiff", "caf"].contains(ext) || ["audio/mpeg", "audio/mp4", "audio/wav", "audio/aac", "audio/aiff", "audio/x-caf"].contains(mime) { self = .audio }
        else { return nil }
    }
}
/// Getting a downloaded artifact off the device's temporary folder: Downloads, a save panel / Save to Files, or the Mac's default app.
@MainActor enum ArtifactFiles {
    enum Action { case downloads, saveAs, openInDefaultApp }
    /// On Mac the one-click action writes to ~/Downloads; on iPhone there is no Downloads folder, so it opens Save to Files.
    static var primarySave: Action { Platform.isMac ? .downloads : .saveAs }
    static var primarySaveTitle: String { Platform.isMac ? "Download" : "Save to Files" }
    /// Returns the saved copy when the action wrote one itself (Downloads).
    static func perform(_ action: Action, url: URL) async throws -> URL? {
        switch action {
        case .downloads: return try saveToDownloads(url)
        case .saveAs: try export(url); return nil
        case .openInDefaultApp:
            guard await UIApplication.shared.open(url) else { throw AppError.message("No app on this Mac can open \(url.lastPathComponent).") }
            return nil
        }
    }
    /// Copies into Downloads without overwriting: "clip.mp4", then "clip 2.mp4", …
    static func saveToDownloads(_ url: URL, folder: URL? = nil) throws -> URL {
        let folder = try folder ?? FileManager.default.url(for: .downloadsDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let base = url.deletingPathExtension().lastPathComponent, ext = url.pathExtension
        var target = folder.appendingPathComponent(url.lastPathComponent), copy = 2
        while FileManager.default.fileExists(atPath: target.path) {
            target = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(copy)" : "\(base) \(copy).\(ext)"); copy += 1
        }
        try FileManager.default.copyItem(at: url, to: target)
        return target
    }
    /// The system save panel on Mac, Save to Files on iPhone. Presented over whatever is frontmost, including a preview sheet.
    static func export(_ url: URL) throws {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        guard var top = (scene?.keyWindow ?? scene?.windows.first)?.rootViewController else { throw AppError.message("Could not open the save panel.") }
        while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
        top.present(UIDocumentPickerViewController(forExporting: [url], asCopy: true), animated: true)
    }
}
struct PreviewFile: Identifiable {
    var id: URL { url }
    let url: URL
    let name: String
    let mime: String
    var isMarkdown: Bool { ["md", "markdown"].contains(url.pathExtension.lowercased()) || mime == "text/markdown" }
    var media: MediaKind? { MediaKind(name: url.lastPathComponent, mime: mime) }
    var text: String? {
        guard isMarkdown || mime.hasPrefix("text/") || ["txt", "csv", "json", "log"].contains(url.pathExtension.lowercased()) else { return nil }
        // Very large text (logs, CSVs) opens in Quick Look instead of being laid out as one SwiftUI Text.
        guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int, size <= 2_000_000 else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }
}
struct ArtifactPreview: View {
    let file: PreviewFile
    @Environment(\.dismiss) private var dismiss
    @State private var saved: URL?
    @State private var problem: String?
    private func run(_ action: ArtifactFiles.Action) {
        Task {
            do { if let copy = try await ArtifactFiles.perform(action, url: file.url) { saved = copy }; problem = nil }
            catch { problem = error.localizedDescription }
        }
    }
    var body: some View {
        NavigationStack {
            Group {
                if let media = file.media { MediaPlayer(url: file.url, audioOnly: media == .audio).accessibilityIdentifier("artifactPlayer") }
                else if let text = file.text {
                    ScrollView {
                        if file.isMarkdown { MessageMarkdown(text: text).padding().textSelection(.enabled) }
                        else { Text(text).frame(maxWidth: .infinity, alignment: .leading).padding().textSelection(.enabled) }
                    }
                } else if FileQuickLook.canPreview(file.url) { FileQuickLook(url: file.url) }
                else { ContentUnavailableView("Preview unavailable", systemImage: "doc", description: Text("Use Share to open this file in another app.")) }
            }
            .safeAreaInset(edge: .bottom) {
                if let message = problem ?? saved.map({ "Saved to Downloads as \($0.lastPathComponent)" }) {
                    HStack {
                        Text(message).font(.caption).foregroundStyle(problem == nil ? Color.secondary : Color.orange).lineLimit(2)
                        Spacer(minLength: 8)
                        if let saved, problem == nil { Button("Show in Finder") { Task { _ = await UIApplication.shared.open(saved.deletingLastPathComponent()) } }.font(.caption) }
                    }.padding(.horizontal).padding(.vertical, 8).background(.bar)
                }
            }
            .navigationTitle(file.name).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // Catalyst draws leading items as small round buttons, which cut "Done" down to "D…".
                    if Platform.isMac { Button { dismiss() } label: { Image(systemName: "xmark") }.keyboardShortcut(.cancelAction).accessibilityLabel("Done") }
                    else { Button("Done") { dismiss() } }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { run(ArtifactFiles.primarySave) } label: { Label(ArtifactFiles.primarySaveTitle, systemImage: "arrow.down.circle") }
                        .accessibilityIdentifier("artifactDownload")
                    if Platform.isMac {
                        Menu {
                            Button("Save As…") { run(.saveAs) }
                            Button("Open in Default App") { run(.openInDefaultApp) }
                        } label: { Label("More", systemImage: "ellipsis.circle") }
                    }
                    ShareLink(item: file.url)
                }
            }
        }
    }
}
/// Catalyst sheets default to a small fixed panel; a page-sized sheet leaves room to watch a video.
struct LargeMacSheet: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *), Platform.isMac { content.presentationSizing(.page) } else { content }
    }
}
/// AVKit playback with full controls (scrubbing, volume, full screen) for video and audio files.
struct MediaPlayer: UIViewControllerRepresentable {
    let url: URL
    var audioOnly = false // AVKit draws its own audio artwork on both platforms
    func makeUIViewController(context: Context) -> AVPlayerViewController {
        // Play through the speaker even with the ring/silent switch off; voice input sets its own category when it starts.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: audioOnly ? .default : .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        let controller = AVPlayerViewController()
        controller.player = AVPlayer(url: url)
        controller.player?.play()
        return controller
    }
    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {}
    static func dismantleUIViewController(_ controller: AVPlayerViewController, coordinator: ()) { controller.player?.pause(); controller.player = nil }
}
struct FileQuickLook: UIViewControllerRepresentable {
    let url: URL
    static func canPreview(_ url: URL) -> Bool {
        #if targetEnvironment(macCatalyst)
        true // canPreview is unavailable on Mac; Quick Look shows a generic icon for unknown types
        #else
        QLPreviewController.canPreview(url as NSURL)
        #endif
    }
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController(); controller.dataSource = context.coordinator; return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {}
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

struct QuestionCard: View {
    let question: AgentQuestion
    let disabled: Bool
    var answer: ([String: String]) -> Void
    @State private var answers: [String: String] = [:]
    @State private var selections: [String: Set<String>] = [:]
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(question.questions) { item in
                VStack(alignment: .leading, spacing: 10) {
                    Text(item.title).font(.headline)
                    ForEach(item.options, id: \.self) { option in
                        Button {
                            if item.multiSelect == true {
                                var values = selections[item.id] ?? []
                                if values.contains(option.label) { values.remove(option.label) } else { values.insert(option.label) }
                                selections[item.id] = values
                                answers[item.id] = item.options.filter { values.contains($0.label) }.map(\.label).joined(separator: ", ")
                            } else { answers[item.id] = option.label }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(option.label)
                                    if let detail = option.description, !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer()
                                Image(systemName: (item.multiSelect == true ? (selections[item.id] ?? []).contains(option.label) : answers[item.id] == option.label) ? "checkmark.circle.fill" : "circle")
                            }.padding(10).background(Color(uiColor: .tertiarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                        }.buttonStyle(.plain)
                    }
                    // Claude's own terminal prompts (folder trust, permissions) only accept one of their options.
                    if question.choiceOnly != true {
                        TextField("Or type your answer…", text: Binding(get: { answers[item.id] ?? "" }, set: { answers[item.id] = $0; selections[item.id] = [] }), axis: .vertical)
                            .textFieldStyle(.roundedBorder)
                    }
                }
            }
            if question.readOnly == true { Text("Answer this question in the desktop Claude client. This view will update when you do.").font(.caption).foregroundStyle(.secondary) }
            Button("Continue") { answer(answers) }.buttonStyle(.borderedProminent)
                .disabled(disabled || question.questions.contains { (answers[$0.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
        }.padding().background(Color.mint.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct BottomPositionKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// Block-level Markdown parsing; SwiftUI Text alone only handles inline markup. Rendered by MessageMarkdown (ConversationParts).
struct MarkdownBlock {
    enum Kind { case paragraph, code, heading, bullet, quote, table, rule, image }
    var kind: Kind; var text: String; var language = ""; var level = 0
    static func parse(_ text: String, images: [Artifact] = []) -> [MarkdownBlock] {
        // Replace only registered image links, keeping all other Markdown intact.
        let pattern = #"!?\[([^\]]*)\]\((?:<([^>]+)>|([^\n]+?))\)"#
        var rendered = text
        var used = Set<String>()
        let protected = (try? NSRegularExpression(pattern: #"(?s)```.*?(?:```|$)|~~~.*?(?:~~~|$)|`[^`\n]*`"#))?.matches(in: text, range: NSRange(text.startIndex..., in: text)).map(\.range) ?? []
        if let regex = try? NSRegularExpression(pattern: pattern) {
            for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
                if protected.contains(where: { NSIntersectionRange($0, match.range).length > 0 }) { continue }
                let index = match.range(at: 2).location == NSNotFound ? 3 : 2
                guard let range = Range(match.range(at: index), in: text), let full = Range(match.range, in: text) else { continue }
                let target = String(text[range]).removingPercentEncoding ?? String(text[range])
                guard let artifact = images.first(where: { target == $0.name || target.hasSuffix("/" + $0.name) || target == "/artifacts/" + $0.id }) else { continue }
                rendered.replaceSubrange(full, with: "\n\nagentremote-image:" + artifact.id + "\n\n")
                used.insert(artifact.id)
            }
        }
        for artifact in images where !used.contains(artifact.id) { rendered += "\n\nagentremote-image:" + artifact.id + "\n" }
        let lines = rendered.components(separatedBy: "\n")
        var result: [MarkdownBlock] = []; var paragraph: [String] = []; var code: [String] = []; var fence: String?; var language = ""
        func flush() { if !paragraph.isEmpty { result.append(.init(kind: .paragraph, text: paragraph.joined(separator: "\n"))); paragraph = [] } }
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let marker = fence {
                if trimmed.hasPrefix(marker) { result.append(.init(kind: .code, text: code.joined(separator: "\n"), language: language)); code = []; fence = nil }
                else { code.append(line) }; continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { flush(); fence = String(trimmed.prefix(3)); language = String(trimmed.dropFirst(3)); continue }
            if trimmed.hasPrefix("agentremote-image:"), images.contains(where: { "agentremote-image:" + $0.id == trimmed }) { flush(); result.append(.init(kind: .image, text: String(trimmed.dropFirst("agentremote-image:".count)))); continue }
            if trimmed.isEmpty { flush(); continue }
            if ["---", "***", "___"].contains(trimmed) { flush(); result.append(.init(kind: .rule, text: "")); continue }
            let hashes = trimmed.prefix { $0 == "#" }.count
            if (1...6).contains(hashes), trimmed.dropFirst(hashes).hasPrefix(" ") { flush(); result.append(.init(kind: .heading, text: String(trimmed.dropFirst(hashes + 1)), level: hashes)); continue }
            if trimmed.hasPrefix("> ") { flush(); result.append(.init(kind: .quote, text: String(trimmed.dropFirst(2)))); continue }
            if trimmed.hasPrefix("|"), trimmed.hasSuffix("|") { flush(); if result.last?.kind == .table { result[result.count-1].text += "\n" + trimmed } else { result.append(.init(kind: .table, text: trimmed)) }; continue }
            if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ") { flush(); result.append(.init(kind: .bullet, text: String(trimmed.dropFirst(2)), language: "•", level: (line.count - trimmed.count) / 2)); continue }
            if let range = trimmed.range(of: #"^\d+[.)] "#, options: .regularExpression) { flush(); result.append(.init(kind: .bullet, text: String(trimmed[range.upperBound...]), language: String(trimmed[range]).trimmingCharacters(in: .whitespaces), level: (line.count-trimmed.count)/2)); continue }
            paragraph.append(line)
        }
        flush(); if fence != nil { result.append(.init(kind: .code, text: code.joined(separator: "\n"), language: language)) }; return result
    }
}

struct SessionControlsView: View {
    let session: Session
    let api: API
    let onSession: (Session) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var usage: UsageResponse?
    @State private var catalog: AgentModelCatalog?
    @State private var model = ""
    @State private var effort = ""
    @State private var autoRetry = false
    @State private var busy = false
    @State private var error: String?
    @State private var handoffID = UUID().uuidString
    private var path: String { API.sessionPath(session.id) }
    private var efforts: [String] { catalog?.models.first(where: { $0.id == model })?.efforts ?? (session.provider == "claude" ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high", "xhigh"]) }
    var body: some View {
        NavigationStack {
            Form {
                Section("Context window") {
                    if let u = usage?.usage, let used = u.contextTokens {
                        if let window = u.contextWindow, window > 0 {
                            ProgressView(value: min(used, window), total: window)
                            Text("\(Int(used).formatted()) / \(Int(window).formatted()) tokens")
                        } else { Text("\(Int(used).formatted()) context tokens · limit unavailable") }
                    } else { Text("Usage will appear when the service reports it.").foregroundStyle(.secondary) }
                    Text("Automatic compaction is handled by the service. It preserves a summary as the chat grows.").font(.caption).foregroundStyle(.secondary)
                    if let c = usage?.compaction { Text("Last compaction: \(c.state)").font(.caption) }
                    Button("Compact now") { perform { _ = try await api.post(path + "/compact", body: [:], as: EmptyResponse.self); dismiss() } }
                }
                Section("Account usage limits") {
                    if let limits = usage?.limits, !limits.windows.isEmpty {
                        ForEach(Array(limits.windows.enumerated()), id: \.offset) { _, window in
                            VStack(alignment: .leading) {
                                Text(window.name)
                                if let percent = window.usedPercent { ProgressView(value: min(max(percent, 0), 100), total: 100); Text("\(Int(percent))% used").font(.caption) }
                                if let reset = window.resetAt { Text("Resets \(Date(timeIntervalSince1970: reset / 1000).formatted(date: .abbreviated, time: .shortened))").font(.caption) }
                            }
                        }
                    } else { Text("The service has not reported account limits yet.").foregroundStyle(.secondary) }
                    if let pause = usage?.rateLimit {
                        Text(pause.message).font(.caption)
                        Text(pause.decision == "scheduled" ? "Automatic continuation is scheduled." : "Continuation: \(pause.decision)").font(.caption)
                        if pause.resetAt == nil { Text("Reset time is unavailable. Automatic continuation waits for a service availability update.").font(.caption).foregroundStyle(.secondary) }
                        Button("Continue automatically when available") { retry("scheduled") }
                        Button("Cancel automatic continuation") { retry("cancelled") }
                    }
                    Toggle("Always continue after usage resets", isOn: $autoRetry)
                        .onChange(of: autoRetry) { _, value in
                            guard usage != nil, value != usage?.preferences.autoRetry else { return }
                            perform { let p = try await api.post("/settings/session-preferences", body: ["autoRetry": value], as: SessionPreferences.self); usage?.preferences = p }
                        }
                    Text("Applies to future usage-limit pauses on this Mac. The Mac must stay running. Network failures are never automatically replayed.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Model & effort") {
                    Picker("Model", selection: $model) {
                        Text("Service default").tag("")
                        if let catalog { ForEach(catalog.models) { Text($0.name).tag($0.id) } }
                        if !model.isEmpty && !(catalog?.models.contains(where: { $0.id == model }) ?? false) { Text(model).tag(model) }
                    }
                    if session.provider == "claude" { TextField("Model alias or ID", text: $model).textInputAutocapitalization(.never).autocorrectionDisabled() }
                    Picker("Effort", selection: $effort) { Text("Default").tag(""); ForEach(efforts, id: \.self) { Text($0.capitalized).tag($0) } }
                    Text("Changes apply to the next turn, including in an existing chat.").font(.caption).foregroundStyle(.secondary)
                    Button("Apply model & effort") { perform { let result = try await api.post(path + "/configuration", body: ["model": model, "effort": effort], as: ReadResponse.self); onSession(result.session) } }
                }
                Section("Continue with another service") {
                    Text("Creates a linked chat in the same working folder, with a copy of this history. The other service uses its own account allowance.").font(.caption).foregroundStyle(.secondary)
                    Button(session.provider == "claude" ? "Continue with Codex" : "Continue with Claude") {
                        perform { let result = try await api.post(path + "/handoff", body: ["provider": session.provider == "claude" ? "codex" : "claude", "requestId": handoffID], as: ReadResponse.self); onSession(result.session) }
                    }
                }
                if let error { Section { Text(error).foregroundStyle(.orange) } }
                if let warning = usage?.warning { Section { Text(warning).font(.caption).foregroundStyle(.secondary) } }
            }
            .disabled(busy)
            .navigationTitle("Chat controls").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
            .onChange(of: model) { _, _ in if !efforts.contains(effort) { effort = "" } }
            .task {
                model = session.model ?? ""; effort = session.effort ?? ""
                do { usage = try await api.get(path + "/usage", as: UsageResponse.self); autoRetry = usage?.preferences.autoRetry ?? false } catch { self.error = error.localizedDescription }
                do { catalog = try await api.get(path + "/models", as: AgentModelCatalog.self) } catch { self.error = error.localizedDescription }
            }
        }
    }
    private func perform(_ action: @escaping () async throws -> Void) {
        busy = true; error = nil
        Task { defer { busy = false }; do { try await action() } catch { self.error = error.localizedDescription } }
    }
    private func retry(_ decision: String) { perform { _ = try await api.post(path + "/retry", body: ["decision": decision], as: ReadResponse.self); usage = try await api.get(path + "/usage", as: UsageResponse.self) } }
}

private final class ChatImageCache {
    static let shared = NSCache<NSString, UIImage>()
}
struct InlineArtifactImage: View {
    let artifact: Artifact
    let api: API
    @State private var image: UIImage?
    @State private var error: String?
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let image {
                Button { expanded = true } label: {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: .infinity, maxHeight: 360).clipShape(RoundedRectangle(cornerRadius: 10))
                }.buttonStyle(.plain).accessibilityLabel("Open \(artifact.name). Pinch to zoom.")
                Text(artifact.name).font(.caption2).foregroundStyle(.secondary)
            } else if let error { Text(error).font(.caption).foregroundStyle(.orange) }
            else { ProgressView().frame(maxWidth: .infinity, minHeight: 100) }
        }
        .task(id: artifact.id) {
            let key = (api.host.id + "/" + artifact.id) as NSString
            if let cached = ChatImageCache.shared.object(forKey: key) { image = cached; return }
            do {
                let url = try await api.download(artifact)
                guard let decoded = UIImage(contentsOfFile: url.path) else { error = "This image format cannot be previewed."; return }
                ChatImageCache.shared.totalCostLimit = 64 * 1024 * 1024
                ChatImageCache.shared.setObject(decoded, forKey: key, cost: Int(decoded.size.width * decoded.size.height * decoded.scale * decoded.scale * 4))
                image = decoded
            } catch is CancellationError {} catch { self.error = "Could not load \(artifact.name)." }
        }
        .fullScreenCover(isPresented: $expanded) {
            if let image {
                NavigationStack {
                    ZoomableChatImage(image: image).ignoresSafeArea(edges: .bottom).background(.black)
                        .navigationTitle(artifact.name).navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { expanded = false } } }
                }
            }
        }
    }
}
struct ZoomableChatImage: UIViewRepresentable {
    let image: UIImage
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> ImageZoomScrollView {
        let view = ImageZoomScrollView(); view.delegate = context.coordinator
        view.minimumZoomScale = 1; view.maximumZoomScale = 8; view.bouncesZoom = true
        view.showsVerticalScrollIndicator = false; view.showsHorizontalScrollIndicator = false
        view.imageView.image = image; view.imageView.contentMode = .scaleAspectFit
        view.addSubview(view.imageView)
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        tap.numberOfTapsRequired = 2; view.addGestureRecognizer(tap)
        return view
    }
    func updateUIView(_ view: ImageZoomScrollView, context: Context) { view.imageView.image = image }
    final class Coordinator: NSObject, UIScrollViewDelegate {
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { (scrollView as? ImageZoomScrollView)?.imageView }
        @objc func doubleTap(_ gesture: UITapGestureRecognizer) {
            guard let view = gesture.view as? ImageZoomScrollView else { return }
            if view.zoomScale > 1 { view.setZoomScale(1, animated: true) }
            else { let point = gesture.location(in: view.imageView), size = CGSize(width: view.bounds.width / 3, height: view.bounds.height / 3); view.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true) }
        }
    }
}
final class ImageZoomScrollView: UIScrollView {
    let imageView = UIImageView()
    private var previousSize = CGSize.zero
    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != previousSize {
            previousSize = bounds.size; setZoomScale(1, animated: false)
            imageView.frame = CGRect(origin: .zero, size: bounds.size); contentSize = bounds.size
        }
    }
}

// Give multiline cells a finite width before measuring their height. A Grid in
// an unbounded horizontal ScrollView can otherwise allocate single-line rows.
struct ReadableMarkdownTable: View {
    let rows: [[String]]
    @State private var showColumns = false
    @ScaledMetric(relativeTo: .body) private var columnWidth: CGFloat = 230
    @ScaledMetric(relativeTo: .body) private var keyWidth: CGFloat = 110
    private var columnCount: Int { rows.map(\.count).max() ?? 0 }
    private func cell(_ value: String) -> AttributedString {
        (try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(value)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if columnCount > 2 {
                Picker("Table layout", selection: $showColumns) {
                    Text("Read by row").tag(false)
                    Text("Compare columns").tag(true)
                }.pickerStyle(.segmented)
            }
            if columnCount > 2 && !showColumns {
                ForEach(Array(rows.dropFirst().enumerated()), id: \.offset) { _, row in
                    VStack(alignment: .leading, spacing: 14) {
                        if let title = row.first { Text(cell(title)).font(.headline).foregroundStyle(.mint) }
                        ForEach(1..<columnCount, id: \.self) { column in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(cell(column < (rows.first?.count ?? 0) ? rows[0][column] : "Column \(column + 1)"))
                                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                Text(cell(column < row.count ? row[column] : "—"))
                                    .fixedSize(horizontal: false, vertical: true)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                }
            } else {
                Text("Swipe sideways to see every column").font(.caption).foregroundStyle(.secondary)
                ScrollView(.horizontal) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.offset) { rowIndex, row in
                            HStack(alignment: .top, spacing: 0) {
                                ForEach(0..<columnCount, id: \.self) { column in
                                    Text(cell(column < row.count ? row[column] : ""))
                                        .fontWeight(rowIndex == 0 ? .semibold : .regular)
                                        .frame(width: column == 0 ? keyWidth : columnWidth, alignment: .topLeading)
                                        .fixedSize(horizontal: false, vertical: true)
                                        .padding(12)
                                }
                            }.fixedSize(horizontal: false, vertical: true)
                            if rowIndex < rows.count - 1 { Divider() }
                        }
                    }.fixedSize(horizontal: true, vertical: true)
                }.background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Reports when the person scrolls (any input device), not when the view scrolls itself.
private struct UserScrollTracking: ViewModifier {
    let changed: (Bool) -> Void
    @State private var active = false
    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollPhaseChange { _, phase in
                let scrolling = phase == .interacting || phase == .decelerating
                if scrolling != active { active = scrolling; changed(scrolling) }
            }
        } else { content }
    }
}

/// Mac composer. SwiftUI's multi-line TextField inserts the newline on Mac before any key handler runs, so this
/// UITextView takes Return itself: Return sends, Shift- or Option-Return adds a line, and IME composition is left alone.
/// `disabled` rejects edits but never touches isEditable: turning that off resigns first responder inside a SwiftUI
/// update, which re-enters the view graph and spins on an AttributeGraph cycle (the Oct 12, 2026 hang on Return).
struct MacComposerField: UIViewRepresentable {
    @Binding var text: String
    let disabled: Bool
    var focusOnAppear = false
    let submit: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }
    func makeUIView(context: Context) -> ReturnSendingTextView {
        let view = ReturnSendingTextView()
        view.focusWhenShown = focusOnAppear
        view.font = .preferredFont(forTextStyle: .body); view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear; view.textContainerInset = .zero; view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = false; view.delegate = context.coordinator
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }
    func updateUIView(_ view: ReturnSendingTextView, context: Context) {
        context.coordinator.text = $text; context.coordinator.disabled = disabled
        if view.text != text { view.text = text; view.invalidateIntrinsicContentSize() }
        view.submit = submit
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ReturnSendingTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 320, line = uiView.font?.lineHeight ?? 18
        let fitted = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        if uiView.isScrollEnabled != (fitted > line * 6) { uiView.isScrollEnabled = fitted > line * 6 }
        return CGSize(width: width, height: min(max(fitted, line), line * 6))
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        var text: Binding<String>
        var disabled = false
        init(text: Binding<String>) { self.text = text }
        func textView(_ view: UITextView, shouldChangeTextIn range: NSRange, replacementText: String) -> Bool { !disabled }
        func textViewDidChange(_ view: UITextView) { text.wrappedValue = view.text; view.invalidateIntrinsicContentSize() }
    }
}
final class ReturnSendingTextView: UITextView {
    var submit: (() -> Void)?
    var focusWhenShown = false
    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard focusWhenShown, window != nil else { return }
        focusWhenShown = false
        DispatchQueue.main.async { [weak self] in _ = self?.becomeFirstResponder() }
    }
    private var swallowed: Set<UIKeyboardHIDUsage> = []
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if let key = presses.first?.key, [.keyboardReturnOrEnter, .keypadEnter].contains(key.keyCode), markedTextRange == nil {
            swallowed.insert(key.keyCode)
            if key.modifierFlags.contains(.shift) || key.modifierFlags.contains(.alternate) {
                if delegate?.textView?(self, shouldChangeTextIn: selectedRange, replacementText: "\n") != false { insertText("\n") }
            } else { submit?() }
            return
        }
        super.pressesBegan(presses, with: event)
    }
    override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if let code = presses.first?.key?.keyCode, swallowed.remove(code) != nil { return }
        super.pressesEnded(presses, with: event)
    }
    override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        if let code = presses.first?.key?.keyCode, swallowed.remove(code) != nil { return }
        super.pressesCancelled(presses, with: event)
    }
}
