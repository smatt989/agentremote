import AppKit
import CryptoKit
import Darwin

/// `update.json`, published beside the DMG and client zip on every GitHub release of the site repo.
struct UpdateManifest: Decodable {
    struct Asset: Decodable { let build: Int; let url: URL; let sha256: String }
    let version: String
    let mac: Asset
    let client: Asset
}

/// Checks for, downloads, verifies and installs Agent Remote updates. A verified update is installed only after the
/// service has had no active session for `idleMinutes`, by `install-update.sh`, which rolls back if the new version
/// fails its health checks. Nothing is installed unless it is signed by this team with this bundle identifier,
/// notarized, and matches the checksum and build number the release published.
@MainActor final class Updater: ObservableObject {
    static let manifestURL = URL(string: "https://github.com/smatt989/agentremote-site/releases/latest/download/update.json")!
    static let team = "YA9PU25M2S"
    static let idleMinutes = 10
    @Published var status = ""
    @Published var ready: (version: String, app: URL)?
    @Published var checking = false
    var automatic: Bool {
        get { UserDefaults.standard.object(forKey: "autoUpdate") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "autoUpdate"); objectWillChange.send() }
    }
    private let model: DesktopModel
    private var idleSince: Date?
    private var timer: Timer?
    private let installed = Bundle.main.bundleURL
    private let currentBuild = Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
    private let folder = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AgentRemote/updates")

    init(model: DesktopModel) { self.model = model }

    /// A bundle that was not opened from a writable Applications folder (a translocated or disk-image copy) cannot be replaced.
    var canInstall: Bool {
        let path = installed.path
        return !path.contains("/AppTranslocation/") && !path.hasPrefix("/Volumes/")
            && FileManager.default.isWritableFile(atPath: installed.deletingLastPathComponent().path)
    }

    func start() {
        guard !model.testing else { return }
        Task { try? await Task.sleep(nanoseconds: 60_000_000_000); await check(manual: false) }
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in Task { @MainActor in self?.tick() } }
    }

    private var lastCheck = Date()
    private func tick() {
        if ready == nil, Date().timeIntervalSince(lastCheck) > 6 * 3600 { Task { await check(manual: false) } }
        guard ready != nil, automatic, canInstall else { idleSince = nil; return }
        model.refresh()
        if model.activeSessions > 0 || !model.running { idleSince = nil; return }
        if idleSince == nil { idleSince = Date() }
        if let since = idleSince, Date().timeIntervalSince(since) >= Double(Self.idleMinutes * 60) { install() }
    }

    func check(manual: Bool) async {
        guard !checking else { return }
        checking = true; lastCheck = Date(); defer { checking = false }
        do {
            var request = URLRequest(url: Self.manifestURL); request.cachePolicy = .reloadIgnoringLocalCacheData
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw DesktopError.message("No update information is published yet.") }
            let manifest = try JSONDecoder().decode(UpdateManifest.self, from: data)
            guard manifest.mac.build > currentBuild else {
                status = "Agent Remote is up to date."; if manual { alert(status) }; return
            }
            if ready?.version == manifest.version { if manual { offer() }; return }
            status = "Downloading Agent Remote \(manifest.version)…"
            let app = try await fetch(manifest)
            ready = (manifest.version, app)
            status = canInstall
                ? "Agent Remote \(manifest.version) is ready. It installs after \(Self.idleMinutes) idle minutes, or choose Install Update."
                : "Agent Remote \(manifest.version) is available. Move Agent Remote to Applications to install updates."
            if manual { offer() }
        } catch {
            status = "Update check failed: \(error.localizedDescription)"
            if manual { alert(status) }
        }
    }

    private func fetch(_ manifest: UpdateManifest) async throws -> URL {
        let work = folder.appendingPathComponent("download-\(manifest.mac.build)")
        try? FileManager.default.removeItem(at: work)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let (temporary, response) = try await URLSession.shared.download(from: manifest.mac.url)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw DesktopError.message("The update download failed.") }
        let dmg = work.appendingPathComponent("AgentRemote.dmg")
        try FileManager.default.moveItem(at: temporary, to: dmg)
        let digest = SHA256.hash(data: try Data(contentsOf: dmg, options: .mappedIfSafe)).map { String(format: "%02x", $0) }.joined()
        guard digest == manifest.mac.sha256.lowercased() else { throw DesktopError.message("The update did not match its published checksum.") }
        let mount = work.appendingPathComponent("mount")
        try FileManager.default.createDirectory(at: mount, withIntermediateDirectories: true)
        let hdiutil = URL(fileURLWithPath: "/usr/bin/hdiutil")
        guard try await Commands.run(hdiutil, ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount.path, dmg.path], timeoutSeconds: 120).code == 0 else {
            throw DesktopError.message("The update disk image could not be opened.")
        }
        let app = work.appendingPathComponent("Agent Remote.app")
        let copied = try await Commands.run(URL(fileURLWithPath: "/usr/bin/ditto"), [mount.appendingPathComponent("Agent Remote.app").path, app.path], timeoutSeconds: 300)
        _ = try? await Commands.run(hdiutil, ["detach", mount.path, "-force"], timeoutSeconds: 60)
        guard copied.code == 0 else { throw DesktopError.message("The update could not be copied from its disk image.") }
        try? FileManager.default.removeItem(at: dmg)
        try await Self.verify(app: app, identifier: Bundle.main.bundleIdentifier ?? "", build: manifest.mac.build)
        return app
    }

    /// Signed by this team with this bundle identifier, accepted by Gatekeeper (notarized), and the advertised build.
    static func verify(app: URL, identifier: String, build: Int) async throws {
        let requirement = "=anchor apple generic and certificate leaf[subject.OU] = \"\(team)\" and identifier \"\(identifier)\""
        guard try await Commands.run(URL(fileURLWithPath: "/usr/bin/codesign"), ["--verify", "--deep", "--strict", "-R", requirement, app.path], timeoutSeconds: 120).code == 0 else {
            throw DesktopError.message("The update is not signed by Agent Remote's developer.")
        }
        guard try await Commands.run(URL(fileURLWithPath: "/usr/sbin/spctl"), ["--assess", "--type", "execute", app.path], timeoutSeconds: 120).code == 0 else {
            throw DesktopError.message("macOS did not accept the update's notarization.")
        }
        let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        guard Int(info?["CFBundleVersion"] as? String ?? "") == build else { throw DesktopError.message("The update's build number did not match its release.") }
    }

    func install(force: Bool = false) {
        guard let ready, canInstall else { return }
        guard let script = Bundle.main.url(forResource: "install-update", withExtension: "sh") else { status = "The update installer is missing."; return }
        idleSince = nil
        status = "Installing Agent Remote \(ready.version)…"
        // A new session (setsid) so the installer survives this app being stopped by it.
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID))
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        for descriptor: Int32 in [0, 1, 2] { posix_spawn_file_actions_addopen(&actions, descriptor, "/dev/null", descriptor == 0 ? O_RDONLY : O_WRONLY, 0) }
        let arguments = ["/bin/zsh", script.path, ready.app.path, installed.path] + (force ? ["force"] : [])
        var argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) } + [nil]
        var pid: pid_t = 0
        let result = posix_spawn(&pid, "/bin/zsh", &actions, &attributes, &argv, environ)
        argv.forEach { free($0) }
        posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes)
        if result != 0 { status = "The update installer could not start (\(result))." }
        // If the installer postpones (a session started), it exits without stopping the app and the idle wait starts over.
    }

    private func offer() {
        guard let ready else { return }
        let alert = NSAlert()
        alert.messageText = "Agent Remote \(ready.version) is ready"
        if canInstall {
            alert.informativeText = model.activeSessions > 0
                ? "\(model.activeSessions) session(s) are working. Installing restarts Agent Remote and stops them. Otherwise it installs automatically once nothing has run for \(Self.idleMinutes) minutes."
                : "Installing restarts Agent Remote, which takes about a minute. Paired devices stay paired."
            alert.addButton(withTitle: "Install and Restart"); alert.addButton(withTitle: "Later")
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn { install(force: true) }
        } else {
            alert.informativeText = "Move Agent Remote to your Applications folder and open it from there to install updates."
            alert.runModal()
        }
    }

    private func alert(_ text: String) {
        let alert = NSAlert(); alert.messageText = text; NSApp.activate(ignoringOtherApps: true); alert.runModal()
    }
}
