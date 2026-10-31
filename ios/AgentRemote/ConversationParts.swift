import SwiftUI
import UniformTypeIdentifiers

// MARK: - Sending while the agent works (C-3)

/// `POST /sessions/:id/messages`. Newer Macs accept a message during a turn and return the stored row with
/// `queued: true`; older ones answer `{accepted}` only, and reject a send during a turn.
struct SendReply: Decodable { var accepted: Bool?; var queued: Bool?; var message: Message? }

/// Macs that rejected a message sent during a turn, i.e. services from before queueing. For them Send stays
/// disabled while the agent works, as it always was, until the app restarts or the Mac reports a queue count.
@MainActor enum QueueSupport {
    static var unsupported: Set<String> = []
    /// What a pre-queue service answers (409) to a send during a turn or with a question pending.
    static let olderMacErrors: Set<String> = ["Wait for the current response or interrupt it first.", "Answer the pending question first, or interrupt it to continue."]
}

// MARK: - Messages (L-3, C-10)

struct MessageView: View {
    let message: Message
    var api: API? = nil
    var sessionID: String? = nil
    var speak: () -> Void = {}
    /// Files this message produced (`artifact.messageId`), shown as chips under it (C-4).
    var files: [Artifact] = []
    var openFile: ((Artifact) -> Void)? = nil
    var saveFile: ((Artifact, ArtifactFiles.Action) -> Void)? = nil
    /// Set for a queued follow-up the person can still take back.
    var cancelQueued: (() -> Void)? = nil
    @State private var savedOverride: Bool?
    @State private var saving = false
    @State private var saveError: String?
    @State private var selecting = false
    private var saved: Bool { savedOverride ?? message.important ?? false }
    private var canSave: Bool { sessionID != nil && api != nil && message.role == "assistant" && message.kind == "text" && message.partial != true }
    private func toggleSaved() {
        guard let api, let sessionID, !saving else { return }
        saving = true
        Task { @MainActor in
            defer { saving = false }
            do {
                let data = try await api.request(API.sessionPath(sessionID) + "/importance", method: "POST", body: ["message": message.id, "important": !saved])
                struct Result: Decodable { var important: Bool }
                savedOverride = try JSONDecoder().decode(Result.self, from: data).important
            } catch { saveError = error.localizedDescription }
        }
    }
    var body: some View {
        Group {
            switch message.role {
            case "tool": tool
            case "user": user
            case "assistant": agent
            default: status
            }
        }
        .onChange(of: message.important) { _, _ in savedOverride = nil }
        .alert("Couldn’t update knowledge", isPresented: Binding(get: { saveError != nil }, set: { if !$0 { saveError = nil } })) { Button("OK") { saveError = nil } } message: { Text(saveError ?? "") }
        .sheet(isPresented: $selecting) { SelectableTextSheet(text: message.text) }
    }
    private var tool: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 8) {
                Text(message.text).font(.caption.monospaced()).frame(maxWidth: .infinity, alignment: .leading)
                if let details = message.details, details != message.text { DisclosureGroup("Raw tool data") {
                    Text(details).font(.caption.monospaced())
                    CopyTextButton(text: details, label: "Copy tool data")
                } }
            }.padding(.top, 6)
        } label: { Label(message.kind.replacingOccurrences(of: "_", with: " "), systemImage: "terminal").font(.caption).foregroundStyle(.secondary) }
        .padding(12).background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: Theme.cardCorner))
        .contentShape(Rectangle())
        .contextMenu { CopyTextButton(text: message.text, label: "Copy message") }
    }
    /// Your turns: a tinted bubble on the right, at most ~85% of the width.
    private var user: some View {
        VStack(alignment: .trailing, spacing: 2) {
            TrailingBubbleLayout {
                MessageMarkdown(text: message.text, images: message.images ?? [], api: api, cacheKey: message.id, fill: false)
                    .modifier(SelectableOnMac())
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Theme.userBubble, in: RoundedRectangle(cornerRadius: Theme.bubbleCorner, style: .continuous))
                    .opacity(message.queued == true ? 0.7 : 1)
                    .contentShape(RoundedRectangle(cornerRadius: Theme.bubbleCorner, style: .continuous))
                    .contextMenu { menu }
            }
            if message.queued == true { queuedLine }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .contain).accessibilityLabel("You said")
    }
    private var queuedLine: some View {
        HStack(spacing: 4) {
            Image(systemName: "clock")
            Text("Queued — sends when the agent finishes")
            if let cancelQueued {
                Text("·").accessibilityHidden(true)
                Button("Cancel", action: cancelQueued)
                    .frame(minWidth: Theme.tapTarget, minHeight: Theme.tapTarget).contentShape(Rectangle())
                    .accessibilityLabel("Cancel queued message").accessibilityIdentifier("cancelQueued")
            }
        }
        .font(.caption).foregroundStyle(Theme.info)
        .frame(minHeight: Theme.tapTarget).padding(.vertical, -8)
        .accessibilityElement(children: .contain).accessibilityIdentifier("queuedMessage")
    }
    /// The agent's turns: full width, no bubble, with small actions underneath.
    private var agent: some View {
        VStack(alignment: .leading, spacing: 6) {
            MessageMarkdown(text: message.text, images: message.images ?? [], api: api, cacheKey: message.id)
                .modifier(SelectableOnMac())
                .contentShape(Rectangle())
                .contextMenu { menu }
            if !files.isEmpty, let openFile {
                FlowLayout(spacing: 8) {
                    ForEach(files) { file in FileChip(artifact: file, open: { openFile(file) }, save: saveFile.map { save in { save(file, $0) } }) }
                }.padding(.top, 2)
            }
            if message.partial != true && message.kind == "text" {
                HStack(spacing: 0) {
                    CopyTextButton(text: message.text, label: "Copy message").labelStyle(.iconOnly)
                    Button(action: speak) { Image(systemName: "speaker.wave.2") }.accessibilityLabel("Read reply aloud")
                    if canSave { Button(action: toggleSaved) { Image(systemName: saved ? "bookmark.fill" : "bookmark") }.disabled(saving).accessibilityLabel(saved ? "Remove from saved knowledge" : "Save to knowledge") }
                }
                .buttonStyle(MessageActionStyle())
                // 44 pt targets, drawn as small icons: pull the row back so it sits snugly under the text.
                .padding(.leading, -14).padding(.vertical, -10)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain).accessibilityLabel("Agent said")
    }
    /// Status notes stay quiet; errors and "needs you" notices keep their color.
    private var status: some View {
        let style: (icon: String, color: Color) = message.kind == "error" ? ("exclamationmark.triangle.fill", Theme.failure) : message.kind == "attention" ? ("exclamationmark.bubble.fill", Theme.needsYou) : ("info.circle", Theme.info)
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: style.icon).accessibilityHidden(true)
            Text(message.text).frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.footnote).foregroundStyle(style.color)
        .modifier(SelectableOnMac())
        .contentShape(Rectangle())
        .contextMenu { menu }
    }
    @ViewBuilder private var menu: some View {
        CopyTextButton(text: message.text, label: "Copy message")
        ShareLink(item: message.text) { Label("Share", systemImage: "square.and.arrow.up") }
        if !Platform.isMac { Button { selecting = true } label: { Label("Select Text", systemImage: "selection.pin.in.out") } }
        if message.role == "assistant" { Button(action: speak) { Label("Read Aloud", systemImage: "speaker.wave.2") } }
        if canSave { Button(action: toggleSaved) { Label(saved ? "Remove from saved knowledge" : "Save to knowledge", systemImage: saved ? "bookmark.slash" : "bookmark") }.disabled(saving) }
        if let cancelQueued { Button(role: .destructive, action: cancelQueued) { Label("Cancel Queued Message", systemImage: "xmark.circle") } }
    }
}

/// Small icon, full 44×44 pt hit area (Theme.tapTarget).
struct MessageActionStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.caption).foregroundStyle(Theme.info)
            .frame(width: Theme.tapTarget, height: Theme.tapTarget).contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.4 : 1)
    }
}

/// On Mac, message text selects with the pointer like any document. On iPhone a long press already opens the
/// message menu, so selection lives behind "Select Text" there instead of fighting the gesture.
struct SelectableOnMac: ViewModifier {
    func body(content: Content) -> some View {
        if Platform.isMac { content.textSelection(.enabled) } else { content }
    }
}

/// A read-only text view with real range selection, for picking part of a message on iPhone.
struct SelectableTextSheet: View {
    let text: String
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            SelectableTextView(text: text).padding(.horizontal)
                .navigationTitle("Select Text").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}
struct SelectableTextView: UIViewRepresentable {
    let text: String
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false; view.isSelectable = true; view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body); view.adjustsFontForContentSizeCategory = true
        view.text = text
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) { if view.text != text { view.text = text } }
}

/// Places one child against the trailing edge, offering it at most `fraction` of the width; it may be narrower.
struct TrailingBubbleLayout: Layout {
    var fraction: CGFloat = 0.85
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let size = child.sizeThatFits(ProposedViewSize(width: proposal.width.map { $0 * fraction }, height: nil))
        return CGSize(width: proposal.width ?? size.width, height: size.height)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        let size = child.sizeThatFits(ProposedViewSize(width: bounds.width * fraction, height: nil))
        child.place(at: CGPoint(x: bounds.maxX - size.width, y: bounds.minY), proposal: ProposedViewSize(size))
    }
}

/// Lays children out in rows, wrapping to the next row when one would overflow.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    private func rows(_ width: CGFloat, _ subviews: Subviews) -> [(frame: CGRect, index: Int)] {
        var result: [(CGRect, Int)] = [], x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for (index, child) in subviews.enumerated() {
            let size = child.sizeThatFits(ProposedViewSize(width: width, height: nil)), w = min(size.width, width)
            if x > 0, x + w > width { y += rowHeight + spacing; x = 0; rowHeight = 0 }
            result.append((CGRect(x: x, y: y, width: w, height: size.height), index))
            x += w + spacing; rowHeight = max(rowHeight, size.height)
        }
        return result
    }
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let placed = rows(proposal.width ?? .infinity, subviews)
        return CGSize(width: proposal.width ?? placed.map(\.frame.maxX).max() ?? 0, height: placed.map(\.frame.maxY).max() ?? 0)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (frame, index) in rows(bounds.width, subviews) {
            subviews[index].place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), proposal: ProposedViewSize(frame.size))
        }
    }
}

// MARK: - Files on messages (C-4)

enum FileKind {
    static func icon(_ artifact: Artifact) -> String {
        let ext = (artifact.name as NSString).pathExtension.lowercased()
        if artifact.mime.hasPrefix("image/") { return "photo" }
        switch MediaKind(name: artifact.name, mime: artifact.mime) {
        case .video: return "play.rectangle"
        case .audio: return "waveform"
        case nil: break
        }
        if ext == "pdf" || artifact.mime == "application/pdf" { return "doc.richtext" }
        if ["csv", "tsv", "xlsx", "xls", "numbers"].contains(ext) { return "tablecells" }
        if ["zip", "gz", "tar", "tgz"].contains(ext) { return "doc.zipper" }
        if ["md", "markdown", "txt", "log", "json"].contains(ext) || artifact.mime.hasPrefix("text/") { return "doc.text" }
        return "doc"
    }
    /// "1.2 MB" when the Mac sends a size, otherwise the file type ("PNG").
    static func detail(_ artifact: Artifact) -> String {
        if let size = artifact.size { return ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file) }
        let ext = (artifact.name as NSString).pathExtension
        return ext.isEmpty ? "File" : ext.uppercased()
    }
}

struct FileChip: View {
    let artifact: Artifact
    var open: () -> Void
    var save: ((ArtifactFiles.Action) -> Void)?
    var body: some View {
        Button(action: open) {
            HStack(spacing: 8) {
                Image(systemName: FileKind.icon(artifact)).foregroundStyle(Theme.accent)
                VStack(alignment: .leading, spacing: 1) {
                    Text(artifact.name).font(.callout).lineLimit(1).truncationMode(.middle)
                    Text(FileKind.detail(artifact)).font(.caption2).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 4)
            .frame(minHeight: Theme.tapTarget)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Theme.cardCorner, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(artifact.name), \(FileKind.detail(artifact))").accessibilityHint("Opens a preview").accessibilityIdentifier("fileChip")
        .contextMenu {
            Button(action: open) { Label("Open", systemImage: FileKind.icon(artifact)) }
            if let save {
                Button { save(ArtifactFiles.primarySave) } label: { Label(ArtifactFiles.primarySaveTitle, systemImage: "arrow.down.circle") }
                if Platform.isMac {
                    Button { save(.saveAs) } label: { Label("Save As…", systemImage: "square.and.arrow.down") }
                    Button { save(.openInDefaultApp) } label: { Label("Open in Default App", systemImage: "arrow.up.forward.app") }
                }
            }
        }
    }
}

/// Every file in the chat, newest first. Opens previews itself, since a sheet cannot present over another sheet.
struct ChatFilesSheet: View {
    let files: [Artifact]
    let fetch: (Artifact) async -> PreviewFile?
    let save: (Artifact, ArtifactFiles.Action) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var preview: PreviewFile?
    @State private var loading: String?
    var body: some View {
        NavigationStack {
            List(files) { file in
                Button {
                    guard loading == nil else { return }
                    loading = file.id
                    Task { preview = await fetch(file); loading = nil }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: FileKind.icon(file)).foregroundStyle(Theme.accent).frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(file.name).lineLimit(2).truncationMode(.middle)
                            Text(FileKind.detail(file)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        if loading == file.id { ProgressView() }
                    }.frame(minHeight: Theme.tapTarget).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .contextMenu {
                    Button { save(file, ArtifactFiles.primarySave) } label: { Label(ArtifactFiles.primarySaveTitle, systemImage: "arrow.down.circle") }
                    if Platform.isMac { Button { save(file, .saveAs) } label: { Label("Save As…", systemImage: "square.and.arrow.down") } }
                }
            }
            .overlay { if files.isEmpty { ContentUnavailableView("No files yet", systemImage: "paperclip", description: Text("Files the agent makes in this chat appear here.")) } }
            .navigationTitle("Files in this chat").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .sheet(item: $preview) { file in ArtifactPreview(file: file).modifier(LargeMacSheet()) }
        .accessibilityIdentifier("chatFilesSheet")
    }
}

// MARK: - Markdown, parsed once per message (L-8)

struct MessageMarkdown: View {
    let text: String
    var images: [Artifact] = []
    var api: API? = nil
    /// The message id; with the text it keys the parse cache, so scrolling and polling never re-run the parser.
    var cacheKey: String? = nil
    /// Full width (agent replies, documents) or hugging its text (a user bubble).
    var fill = true
    var body: some View {
        let rendered = RenderedMarkdown.make(text, images: images, key: cacheKey)
        VStack(alignment: .leading, spacing: 10) {
            ForEach(rendered.blocks) { item in
                let block = item.block, styled = item.styled ?? AttributedString(block.text)
                switch block.kind {
                case .code:
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(block.language.isEmpty ? "Code" : block.language).font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            CopyTextButton(text: block.text, label: "Copy code").labelStyle(.iconOnly).buttonStyle(MessageActionStyle()).padding(-12)
                        }
                        ScrollView(.horizontal) { Text(styled).font(.system(.callout, design: .monospaced)).fixedSize(horizontal: true, vertical: false) }
                    }.padding(12).background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                case .heading:
                    Text(styled).font(block.level == 1 ? .title2.bold() : .headline).padding(.top, 6)
                case .bullet:
                    HStack(alignment: .top, spacing: 8) { Text(block.language); Text(styled).frame(maxWidth: fill ? .infinity : nil, alignment: .leading) }.padding(.leading, CGFloat(block.level) * 12)
                case .quote:
                    HStack { Rectangle().fill(Theme.accent.opacity(0.5)).frame(width: 3); Text(styled).foregroundStyle(.secondary) }.fixedSize(horizontal: false, vertical: true)
                case .table:
                    ReadableMarkdownTable(rows: item.rows)
                case .rule: Divider()
                case .image:
                    if let artifact = images.first(where: { $0.id == block.text }), let api { InlineArtifactImage(artifact: artifact, api: api) }
                case .paragraph:
                    if fill { Text(styled).frame(maxWidth: .infinity, alignment: .leading) } else { Text(styled).fixedSize(horizontal: false, vertical: true) }
                }
            }
        }.frame(maxWidth: fill ? .infinity : nil, alignment: .leading)
    }
}

struct RenderedBlock: Identifiable {
    let id: Int
    let block: MarkdownBlock
    /// Inline Markdown for text blocks, syntax colors for code.
    var styled: AttributedString?
    var rows: [[String]] = []
}
/// A message's blocks, parsed and styled once and kept while the text is unchanged.
final class RenderedMarkdown {
    let text: String, imageIDs: [String], blocks: [RenderedBlock]
    init(text: String, imageIDs: [String], blocks: [RenderedBlock]) { self.text = text; self.imageIDs = imageIDs; self.blocks = blocks }
    private static let cache: NSCache<NSString, RenderedMarkdown> = { let cache = NSCache<NSString, RenderedMarkdown>(); cache.countLimit = 800; return cache }()
    static func make(_ text: String, images: [Artifact], key: String?) -> RenderedMarkdown {
        let ids = images.map(\.id)
        var hasher = Hasher(); hasher.combine(text); hasher.combine(ids)
        let cacheKey = "\(key ?? "")#\(hasher.finalize())" as NSString
        // Compare the text too, so a hash collision can never show another message's content.
        if let hit = cache.object(forKey: cacheKey), hit.text == text, hit.imageIDs == ids { return hit }
        let blocks = MarkdownBlock.parse(text, images: images).enumerated().map { index, block in
            switch block.kind {
            case .code: RenderedBlock(id: index, block: block, styled: SyntaxHighlighter.highlight(block.text, language: block.language))
            case .table: RenderedBlock(id: index, block: block, rows: tableRows(block.text))
            case .heading, .bullet, .quote, .paragraph: RenderedBlock(id: index, block: block, styled: inline(block.text))
            case .rule, .image: RenderedBlock(id: index, block: block)
            }
        }
        let value = RenderedMarkdown(text: text, imageIDs: ids, blocks: blocks)
        cache.setObject(value, forKey: cacheKey)
        return value
    }
    static func inline(_ text: String) -> AttributedString { (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text) }
    static func tableRows(_ text: String) -> [[String]] {
        text.components(separatedBy: "\n").compactMap { line in
            let cells = line.trimmingCharacters(in: CharacterSet(charactersIn: "|")).components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
            if cells.allSatisfy({ $0.range(of: #"^:?-{3,}:?$"#, options: .regularExpression) != nil }) { return nil }
            return cells
        }
    }
}

// MARK: - Code colors (C-10)

/// A small single-pass tokenizer: comments, strings, numbers and keywords for common languages. One combined regex
/// per language family, compiled once; results are cached with the message (RenderedMarkdown). Unknown or
/// untagged blocks, and very large ones, stay plain.
enum SyntaxHighlighter {
    // Theme has no code tokens yet; these are system colors that read in light and dark.
    static let keyword = Color(uiColor: .systemPink), string = Color(uiColor: .systemOrange)
    static let comment = Color(uiColor: .secondaryLabel), number = Color(uiColor: .systemPurple)
    private struct Grammar { let regex: NSRegularExpression }
    private static let cStyleComment = #"//[^\n]*|/\*[\s\S]*?\*/"#, hashComment = #"#[^\n]*"#
    private static let quoted = #""(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'"#
    private static let numberPattern = #"\b(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b"#
    private static func grammar(comment: String, string: String, keywords: String, caseInsensitive: Bool = false) -> Grammar? {
        let words = keywords.split(separator: " ").joined(separator: "|")
        let pattern = "(\(comment))|(\(string))|(\(numberPattern))|" + (words.isEmpty ? "((?!))" : #"(\b(?:"# + words + #")\b)"#)
        return (try? NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : [])).map(Grammar.init)
    }
    private static let grammars: [String: Grammar] = {
        var all: [String: Grammar?] = [:]
        all["swift"] = grammar(comment: cStyleComment, string: #""""[\s\S]*?"""|"# + quoted, keywords: "func let var if else guard return struct class enum protocol extension import for in while repeat switch case default break continue throw throws rethrows try catch do async await self Self nil true false init deinit static private fileprivate public internal open some any where as is inout defer lazy weak override mutating final typealias associatedtype subscript actor")
        all["js"] = grammar(comment: cStyleComment, string: quoted + #"|`(?:\\.|[^`\\])*`"#, keywords: "function const let var if else return class extends import export from default for of in while do switch case break continue throw try catch finally new this null undefined true false async await typeof instanceof interface type enum implements yield delete void static get set readonly as")
        all["python"] = grammar(comment: hashComment, string: #"[rbfRBF]?(?:"""[\s\S]*?"""|'''[\s\S]*?''')|[rbfRBF]?(?:"# + quoted + ")", keywords: "def class return if elif else for while in not and or is None True False import from as with try except finally raise lambda yield pass break continue global nonlocal async await assert del self match case")
        all["go"] = grammar(comment: cStyleComment, string: quoted + #"|`[^`]*`"#, keywords: "func package import var const type struct interface map chan go defer return if else for range switch case default break continue select nil true false fallthrough goto")
        all["rust"] = grammar(comment: cStyleComment, string: #""(?:\\.|[^"\\])*""#, keywords: "fn let mut pub struct enum impl trait use mod crate self Self super match if else loop while for in return break continue as ref move where async await dyn true false const static unsafe type None Some Ok Err")
        all["c"] = grammar(comment: cStyleComment, string: quoted, keywords: "class public private protected static final void int long short double float char byte boolean bool return if else for while do switch case default break continue new this null nullptr true false import package extends implements interface enum try catch finally throw throws const struct typedef sizeof namespace using virtual override auto unsigned signed fun val var when object is in let func string")
        all["shell"] = grammar(comment: #"(?<![\w$])#[^\n]*"#, string: quoted, keywords: "if then else elif fi for while until do done case esac function return in export local echo exit set unset source alias sudo cd")
        all["sql"] = grammar(comment: #"--[^\n]*|/\*[\s\S]*?\*/"#, string: #"'(?:''|[^'])*'"#, keywords: "select from where group by order having join left right inner outer full cross on as and or not null is in insert into values update set delete create table view index drop alter add primary key foreign references distinct limit offset union all case when then else end with count sum avg min max between like exists desc asc returning default", caseInsensitive: true)
        all["json"] = grammar(comment: "(?!)", string: #""(?:\\.|[^"\\\n])*""#, keywords: "true false null")
        all["yaml"] = grammar(comment: hashComment, string: quoted, keywords: "true false null yes no on off")
        all["ruby"] = grammar(comment: hashComment, string: quoted, keywords: "def end class module if elsif else unless while until for in do return yield begin rescue ensure raise nil true false self require then case when lambda proc attr_accessor attr_reader")
        all["css"] = grammar(comment: #"/\*[\s\S]*?\*/"#, string: quoted, keywords: "important")
        all["markup"] = grammar(comment: #"<!--[\s\S]*?-->"#, string: quoted, keywords: "")
        return all.compactMapValues { $0 }
    }()
    private static let aliases: [String: String] = [
        "swift": "swift", "js": "js", "javascript": "js", "jsx": "js", "ts": "js", "typescript": "js", "tsx": "js", "mjs": "js", "cjs": "js",
        "py": "python", "python": "python", "python3": "python", "go": "go", "golang": "go", "rs": "rust", "rust": "rust",
        "c": "c", "h": "c", "cpp": "c", "c++": "c", "hpp": "c", "cc": "c", "java": "c", "kotlin": "c", "kt": "c", "cs": "c", "csharp": "c", "objc": "c", "objective-c": "c", "scala": "c", "dart": "c", "php": "c",
        "sh": "shell", "bash": "shell", "zsh": "shell", "shell": "shell", "console": "shell", "fish": "shell",
        "sql": "sql", "postgres": "sql", "postgresql": "sql", "mysql": "sql", "sqlite": "sql", "json": "json", "jsonc": "json",
        "yaml": "yaml", "yml": "yaml", "toml": "yaml", "ini": "yaml", "rb": "ruby", "ruby": "ruby", "css": "css", "scss": "css", "less": "css",
        "html": "markup", "xml": "markup", "svg": "markup", "plist": "markup",
    ]
    static func highlight(_ code: String, language: String) -> AttributedString? {
        let name = language.trimmingCharacters(in: .whitespaces).split(separator: " ").first.map { $0.lowercased() } ?? ""
        guard code.utf16.count <= 40_000, let family = aliases[name], let grammar = grammars[family] else { return nil }
        let source = code as NSString, colors = [comment, string, number, keyword]
        var result = AttributedString(), cursor = 0
        for match in grammar.regex.matches(in: code, range: NSRange(location: 0, length: source.length)) {
            guard let group = (1...4).first(where: { match.range(at: $0).location != NSNotFound }) else { continue }
            let range = match.range(at: group)
            if range.location > cursor { result += AttributedString(source.substring(with: NSRange(location: cursor, length: range.location - cursor))) }
            var token = AttributedString(source.substring(with: range)); token.foregroundColor = colors[group - 1]
            result += token; cursor = range.location + range.length
        }
        if cursor < source.length { result += AttributedString(source.substring(from: cursor)) }
        return result
    }
}

/// Which files go under the reply that made them, and which stay in the list at the end of the chat.
struct FilePlacement {
    var byMessage: [String: [Artifact]] = [:]
    var unattached: [Artifact] = []
    init(_ artifacts: [Artifact], shown items: [TranscriptItem]) {
        guard !artifacts.isEmpty else { return }
        var replies = Set<String>(), inline = Set<String>()
        for item in items {
            guard case .message(let message) = item else { continue }
            if message.role == "assistant" { replies.insert(message.id) }
            // Pictures already drawn inside a message (your uploads, images a reply names) aren't listed again at the end.
            for image in message.images ?? [] { inline.insert(image.id) }
        }
        for file in artifacts {
            if let id = file.messageId, replies.contains(id) { byMessage[id, default: []].append(file) } else if !inline.contains(file.id) { unattached.append(file) }
        }
    }
}
