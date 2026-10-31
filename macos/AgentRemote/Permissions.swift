import AppKit
import Carbon
import CoreGraphics

/// Privacy permissions the agents need. Status checks never show a macOS prompt;
/// prompts appear only from the request functions, which the Setup window calls on a button press.
enum Access: Equatable { case unknown, granted, denied, notDetermined }

struct BrowserAccess: Identifiable, Equatable {
    let id: String // bundle identifier
    let name: String
    let javascriptTip: String
    var access: Access
}

@MainActor final class PermissionsModel: ObservableObject {
    static let folderNames = ["Desktop", "Documents", "Downloads"]
    static let screenSettings = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!
    static let fullDiskSettings = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!
    static let automationSettings = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")!
    @Published var checked = false
    @Published var screenRecording = false
    @Published var fullDiskAccess = false
    @Published var folders: [String: Access] = [:]
    @Published var browsers: [BrowserAccess] = []
    @Published var requestingFolders = false
    @Published var requestingBrowser: String?
    private var refreshing = false
    private let defaults = UserDefaults.standard
    private let home = FileManager.default.homeDirectoryForCurrentUser

    var foldersGranted: Bool { Self.folderNames.allSatisfy { folders[$0] == .granted } }
    var complete: Bool { screenRecording && foldersGranted }
    var screenRequested: Bool { defaults.bool(forKey: "screenRecordingRequested") }

    func refresh() async {
        guard !refreshing else { return }; refreshing = true; defer { refreshing = false; checked = true }
        screenRecording = CGPreflightScreenCaptureAccess()
        let home = home, names = Self.folderNames
        // Only re-read folders once the user has answered the prompts; a read before then would show them.
        let probeFolders = defaults.bool(forKey: "folderAccessRequested")
        let (disk, folderResults) = await Task.detached { () -> (Bool, [String: Access]) in
            // Full Disk Access never prompts, so probing a file it protects is always silent.
            let tcc = home.appendingPathComponent("Library/Application Support/com.apple.TCC/TCC.db")
            let disk = FileHandle(forReadingAtPath: tcc.path) != nil
            var results: [String: Access] = [:]
            for name in names { results[name] = disk ? .granted : probeFolders ? Self.read(home.appendingPathComponent(name)) : .unknown }
            return (disk, results)
        }.value
        fullDiskAccess = disk; folders = folderResults
        var next: [BrowserAccess] = []
        for (id, name, tip) in [("com.google.Chrome", "Google Chrome", "In Chrome, also turn on View → Developer → Allow JavaScript from Apple Events."),
                                ("com.apple.Safari", "Safari", "In Safari, also turn on Develop → Allow JavaScript from Apple Events.")]
            where NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) != nil {
            let status = await Task.detached { Self.automation(id, ask: false) }.value
            // A browser that isn't running can't be checked; keep the last answer we saw.
            let known = status ?? Access(stored: defaults.string(forKey: "automation." + id))
            if let status { defaults.set(status.stored, forKey: "automation." + id) }
            next.append(BrowserAccess(id: id, name: name, javascriptTip: tip, access: known))
        }
        browsers = next
    }

    func requestScreenRecording() {
        // macOS shows its own prompt only the first time; after that the switch lives in System Settings.
        // A switch that is on but still denied belongs to an older build's signature, and macOS keeps it
        // instead of re-asking, so clear our entry first. The request then lists this build afresh.
        if screenRequested {
            let reset = Process()
            reset.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
            reset.arguments = ["reset", "ScreenCapture", Bundle.main.bundleIdentifier ?? "com.matthewslotkin.agentremote.mac"]
            try? reset.run(); reset.waitUntilExit()
        }
        defaults.set(true, forKey: "screenRecordingRequested")
        if !CGRequestScreenCaptureAccess() { NSWorkspace.shared.open(Self.screenSettings) }
        Task { await refresh() }
    }

    /// Reads each protected folder once so macOS asks now, at the Mac, instead of mid-session from the phone.
    /// Agent processes started by this app's service inherit the answer.
    func requestFolders() async {
        guard !requestingFolders else { return }; requestingFolders = true; defer { requestingFolders = false }
        let home = home
        for name in Self.folderNames {
            let result = await Task.detached { Self.read(home.appendingPathComponent(name)) }.value
            folders[name] = result
        }
        defaults.set(true, forKey: "folderAccessRequested")
        await refresh()
    }

    func requestAutomation(_ id: String) async {
        guard requestingBrowser == nil else { return }
        if browsers.first(where: { $0.id == id })?.access == .denied { NSWorkspace.shared.open(Self.automationSettings); return }
        requestingBrowser = id; defer { requestingBrowser = nil }
        // macOS can only ask about a running app, so open the browser quietly first.
        if NSRunningApplication.runningApplications(withBundleIdentifier: id).isEmpty, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) {
            let configuration = NSWorkspace.OpenConfiguration(); configuration.activates = false
            _ = try? await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
            for _ in 0..<20 where NSRunningApplication.runningApplications(withBundleIdentifier: id).isEmpty { try? await Task.sleep(nanoseconds: 250_000_000) }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
        let status = await Task.detached { Self.automation(id, ask: true) }.value
        if let status { defaults.set(status.stored, forKey: "automation." + id) }
        if status == .denied { NSWorkspace.shared.open(Self.automationSettings) }
        await refresh()
    }

    nonisolated static func read(_ url: URL) -> Access {
        (try? FileManager.default.contentsOfDirectory(atPath: url.path)) != nil ? .granted : .denied
    }

    /// nil when the browser isn't running, because macOS can't answer then.
    nonisolated static func automation(_ bundleID: String, ask: Bool) -> Access? {
        var target = AEAddressDesc()
        let bytes = Array(bundleID.utf8)
        guard AECreateDesc(DescType(typeApplicationBundleID), bytes, bytes.count, &target) == noErr else { return .unknown }
        defer { AEDisposeDesc(&target) }
        switch AEDeterminePermissionToAutomateTarget(&target, AEEventClass(typeWildCard), AEEventID(typeWildCard), ask) {
        case noErr: return .granted
        case OSStatus(errAEEventNotPermitted): return .denied
        case OSStatus(errAEEventWouldRequireUserConsent): return .notDetermined
        case OSStatus(procNotFound): return nil
        default: return .unknown
        }
    }
}

private extension Access {
    init(stored: String?) {
        switch stored { case "granted": self = .granted; case "denied": self = .denied; case "notDetermined": self = .notDetermined; default: self = .unknown }
    }
    var stored: String { switch self { case .granted: "granted"; case .denied: "denied"; case .notDetermined: "notDetermined"; case .unknown: "unknown" } }
}
