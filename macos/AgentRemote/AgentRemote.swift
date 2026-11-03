import AppKit
import SwiftUI
import ServiceManagement
import Darwin
import Carbon

struct CommandResult: Sendable { let code: Int32; let data: Data }
enum DesktopError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case let .message(value) = self { return value }; return nil }
}
enum Commands {
    static func run(_ executable: URL, _ arguments: [String], environment: [String: String]? = nil, timeoutSeconds: Double = 20, process: Process = Process()) async throws -> CommandResult {
        try await Task.detached {
            let pipe = Pipe()
            process.executableURL = executable; process.arguments = arguments
            process.environment = environment
            process.standardOutput = pipe; process.standardError = pipe; process.standardInput = FileHandle.nullDevice
            try process.run()
            let timeout = DispatchWorkItem {
                if process.isRunning {
                    process.terminate()
                    DispatchQueue.global().asyncAfter(deadline: .now() + 3) { if process.isRunning { kill(process.processIdentifier, SIGKILL) } }
                }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeoutSeconds, execute: timeout)
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit(); timeout.cancel()
            return CommandResult(code: process.terminationStatus, data: data)
        }.value
    }
    static func quote(_ text: String) -> String { "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'" }
}
struct RuntimeStatus: Decodable {
    let pid: Int32
    let port: Int
    let relay: String
    let updatedAt: Double
    let activeSessions: Int
    let pairedDevices: Int
}
struct DesktopInfo: Decodable { let activeSessions: Int; let pairedDevices: Int }
struct PairingImage: Decodable { let image: String; let expires: Double; let uri: String? }
struct KeepAwakeStatus: Decodable { let enabled: Bool }

@MainActor final class DesktopModel: ObservableObject {
    @Published var connection = "Starting…"
    @Published var connected = false
    @Published var running = false
    @Published var legacy = false
    @Published var working = false
    @Published var error: String?
    @Published var activeSessions = 0
    @Published var pairedDevices = 0
    @Published var agentWorking: String?
    @Published var agentMessage: String?
    @Published var signedIn: [String: Bool] = [:]
    private var agentProcess: Process?
    @Published var codex: String?
    @Published var claude: String?
    @Published var qrImage: NSImage?
    @Published var qrExpires = Date.distantPast
    @Published var pairingURI: String?
    @Published var linkCopied = false
    @Published var checkingSignIn = false
    private(set) var signInCheckedAt = Date.distantPast
    var signInPending: Bool { checkingSignIn || signInCheckedAt == .distantPast }
    @Published var keepAwake: Bool? // nil when the service doesn't support the setting
    @Published var terminalEnabled = false
    @Published var terminalMessage: String?
    let permissions = PermissionsModel()
    @Published var loginEnabled = false
    @Published var loginNeedsApproval = false
    private var child: Process?
    private var wantsRunning = false
    private var restartAttempts = 0
    private var logHandle: FileHandle?
    private var timer: Timer?
    let home = FileManager.default.homeDirectoryForCurrentUser
    let resources: URL
    let stateDirectory: URL
    let logDirectory: URL
    let port: Int
    let testing: Bool
    var node: URL {
        #if arch(arm64)
        return resources.appendingPathComponent("runtime/arm64/bin/node")
        #else
        return resources.appendingPathComponent("runtime/x64/bin/node")
        #endif
    }
    var service: URL { resources.appendingPathComponent("service") }
    var installed: Bool { Bundle.main.bundleURL.path.hasPrefix("/Applications/") || Bundle.main.bundleURL.path.hasPrefix(home.appendingPathComponent("Applications").path + "/") }
    var environment: [String: String] {
        var value = ProcessInfo.processInfo.environment
        value["PATH"] = searchDirectories.joined(separator: ":")
        value["AGENT_REMOTE_STATE"] = stateDirectory.path
        value["AGENT_REMOTE_PORT"] = String(port)
        value["NODE_NO_WARNINGS"] = "1"
        value["AGENT_REMOTE_PARENT_PID"] = String(getpid())
        if let codex { value["AGENT_REMOTE_CODEX"] = codex }
        if let claude { value["AGENT_REMOTE_CLAUDE"] = claude }
        return value
    }
    var searchDirectories: [String] {
        var values = [node.deletingLastPathComponent().path, home.appendingPathComponent(".local/bin").path,
                      "/opt/homebrew/bin", "/usr/local/bin", home.appendingPathComponent(".volta/bin").path,
                      home.appendingPathComponent(".asdf/shims").path, "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        let versions = home.appendingPathComponent(".nvm/versions/node")
        if let names = try? FileManager.default.contentsOfDirectory(atPath: versions.path) {
            values += names.sorted { $0.compare($1, options: .numeric) == .orderedDescending }.map { versions.appendingPathComponent($0 + "/bin").path }
        }
        if testing, let directory = ProcessInfo.processInfo.environment["AGENT_REMOTE_TEST_AGENT_DIR"] { values.insert(directory, at: 0) }
        return values
    }
    init() {
        resources = Bundle.main.resourceURL!
        let env = ProcessInfo.processInfo.environment
        testing = env["AGENT_REMOTE_WRAPPER_TEST"] == "1"
        stateDirectory = URL(fileURLWithPath: env["AGENT_REMOTE_STATE"] ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AgentRemote").path)
        logDirectory = testing ? stateDirectory.appendingPathComponent("logs") : FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/AgentRemote")
        port = Int(env["AGENT_REMOTE_PORT"] ?? "8787") ?? 8787
        scanAgents(); updateLoginStatus(); checkTerminal()
    }
    var agentReady: Bool { (claude != nil && signedIn["claude"] == true) || (codex != nil && signedIn["codex"] == true) }
    var loginShellIsZsh: Bool { (ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh").hasSuffix("/zsh") }
    func checkTerminal() {
        let rc = (try? String(contentsOf: home.appendingPathComponent(".zshrc"), encoding: .utf8)) ?? ""
        terminalEnabled = rc.contains("# Agent Remote terminal access")
    }
    func enableTerminal() async {
        guard !working else { return }; working = true; defer { working = false }
        do {
            let result = try await Commands.run(node,[service.appendingPathComponent("desktop/src/terminal-setup.mjs").path],environment:environment)
            let output = String(decoding: result.data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            guard result.code == 0 else { throw DesktopError.message(output.isEmpty ? "Could not enable terminal access." : "Could not enable terminal access: " + output) }
            terminalMessage = output.isEmpty ? "Terminal access enabled. Open a new Terminal tab and run claude or codex normally." : output
            error = nil; checkTerminal()
        } catch { self.error = error.localizedDescription }
    }
    func loadKeepAwake() async {
        keepAwake = (try? await admin(["keep-awake"], as: KeepAwakeStatus.self))?.enabled
    }
    func setKeepAwake(_ enabled: Bool) async {
        let previous = keepAwake; keepAwake = enabled
        do {
            let result = try await Commands.run(node, [service.appendingPathComponent("desktop/src/admin.mjs").path, "keep-awake", enabled ? "on" : "off"], environment: environment)
            guard result.code == 0 else { throw DesktopError.message(String(decoding: result.data, as: UTF8.self)) }
            await loadKeepAwake()
        } catch { keepAwake = previous; self.error = "Could not change Keep this Mac awake: " + error.localizedDescription }
    }
    func scanAgents() {
        func locate(_ name: String) -> String? {
            let paths = searchDirectories.map { $0 + "/" + name } + (name == "codex" ? ["/Applications/Codex.app/Contents/Resources/codex"] : [])
            return paths.first { FileManager.default.isExecutableFile(atPath: $0) }
        }
        codex = locate("codex"); claude = locate("claude")
    }
    func begin() async {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in Task { @MainActor in self?.refresh() } }
        await start()
        await checkAgentSignIn()
        await loadKeepAwake()
    }
    /// Re-checks things the user may have changed elsewhere (System Settings, Terminal) when the app comes forward.
    func recheck() async {
        await permissions.refresh()
        if Date().timeIntervalSince(signInCheckedAt) > 20 { await checkAgentSignIn() }
        if timer != nil { await loadKeepAwake() }
    }
    func refresh() {
        scanAgents(); updateLoginStatus()
        if qrExpires <= Date() { qrImage = nil; pairingURI = nil }
        // An agent installed outside the app (for example in Terminal) still gets its sign-in checked.
        if !checkingSignIn, Date().timeIntervalSince(signInCheckedAt) > 60,
           (claude != nil && signedIn["claude"] == nil) || (codex != nil && signedIn["codex"] == nil) { Task { await checkAgentSignIn() } }
        let path = stateDirectory.appendingPathComponent("desktop-status.json")
        if let data = try? Data(contentsOf: path), let status = try? JSONDecoder().decode(RuntimeStatus.self, from: data),
           Date().timeIntervalSince1970 * 1000 - status.updatedAt < 15_000,
           status.port == port, kill(status.pid, 0) == 0 {
            running = true; connected = status.relay == "connected"
            activeSessions = status.activeSessions; pairedDevices = status.pairedDevices
            connection = !connected ? (status.relay == "reconnecting" ? "Reconnecting…" : "Connecting…") : pairedDevices == 0 ? "Ready · waiting for a phone to pair" : "Online · your phone can reach this Mac"
        } else if legacy {
            running = true; connected = false; connection = "Existing Mac service is running"
        } else if child?.isRunning != true {
            running = false; connected = false
            if !wantsRunning { connection = "Remote access is stopped" }
        }
    }
    func legacyIsLoaded() async -> Bool {
        guard !testing else { return false }
        let result = try? await Commands.run(URL(fileURLWithPath: "/bin/launchctl"), ["print", "gui/\(getuid())/com.agentremote.desktop"])
        return result?.code == 0
    }
    func start() async {
        guard !working, child?.isRunning != true else { return }
        working = true; defer { working = false }
        error = nil; wantsRunning = true
        if await legacyIsLoaded() {
            legacy = true; running = true; connection = "Existing Mac service is running"
            if let info = try? await admin(["desktop-info"], as: DesktopInfo.self) { activeSessions = info.activeSessions; pairedDevices = info.pairedDevices }
            refresh(); return
        }
        legacy = false
        do {
            // Do not launch a second service or take over an unrelated listener.
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/health")!); request.timeoutInterval = 1
            if let (_, response) = try? await URLSession.shared.data(for: request), response is HTTPURLResponse {
                throw DesktopError.message("Port \(port) is already in use. Stop the other service, then click Start remote access.")
            }
            try FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let log = logDirectory.appendingPathComponent("desktop-app.log")
            if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
            let handle = try FileHandle(forWritingTo: log); try handle.seekToEnd(); logHandle = handle
            let process = Process(); process.executableURL = node
            process.arguments = [service.appendingPathComponent("desktop/src/server.mjs").path]
            process.currentDirectoryURL = home; process.environment = environment
            process.standardOutput = handle; process.standardError = handle; process.standardInput = FileHandle.nullDevice
            process.terminationHandler = { [weak self] process in
                Task { @MainActor in
                    guard let self, self.child === process else { return }
                    self.child = nil; try? self.logHandle?.close(); self.logHandle = nil
                    self.running = false; self.connected = false
                    if self.wantsRunning {
                        self.restartAttempts += 1
                        if self.restartAttempts <= 3 {
                            self.connection = "Restarting the Mac service…"
                            try? await Task.sleep(nanoseconds: 3_000_000_000)
                            if self.wantsRunning { await self.start() }
                        } else {
                            self.wantsRunning = false; self.connection = "Mac service stopped"
                            self.error = "The service could not stay running. Open the logs for details, then try Start remote access."
                        }
                    }
                }
            }
            child = process; try process.run(); running = true; connection = "Connecting…"
        } catch { child = nil; wantsRunning = false; running = false; connection = "Remote access is stopped"; self.error = error.localizedDescription }
    }
    func stop() async {
        guard !legacy, !working else { return }
        working = true; wantsRunning = false; defer { working = false }
        child?.terminate()
        for _ in 0..<50 { if child?.isRunning != true { break }; try? await Task.sleep(nanoseconds: 100_000_000) }
        if child?.isRunning == true { error = "The service is still stopping. Wait a moment before starting it again." }
        qrImage = nil; pairingURI = nil; refresh()
    }
    func terminate() { wantsRunning = false; timer?.invalidate(); child?.terminate(); if agentProcess?.isRunning == true { agentProcess?.terminate() } }
    func admin<T: Decodable>(_ arguments: [String], as type: T.Type) async throws -> T {
        let result = try await Commands.run(node, [service.appendingPathComponent("desktop/src/admin.mjs").path] + arguments, environment: environment)
        guard result.code == 0 else { throw DesktopError.message(String(decoding: result.data, as: UTF8.self)) }
        return try JSONDecoder().decode(type, from: result.data)
    }
    func pair() async {
        guard running else { error = "Start remote access first, then pair a device."; return }
        guard !working else { return }; working = true; defer { working = false }
        do {
            let response = try await admin(["pair-native"], as: PairingImage.self)
            guard let encoded = response.image.split(separator: ",", maxSplits: 1).last,
                  let data = Data(base64Encoded: String(encoded)), let image = NSImage(data: data) else { throw DesktopError.message("Could not generate the pairing code.") }
            qrExpires = Date(timeIntervalSince1970: response.expires / 1000); qrImage = image; pairingURI = response.uri; error = nil
        } catch { self.error = error.localizedDescription }
    }
    /// Copies the current invitation, generating one first if none is showing.
    func copyPairingLink() async {
        if pairingURI == nil || qrExpires <= Date() { await pair() }
        guard let uri = pairingURI, qrExpires > Date() else {
            if error == nil { error = "This version of the Mac service can't make pairing links yet. Scan the QR code instead." }
            return
        }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(uri, forType: .string)
        linkCopied = true
        try? await Task.sleep(nanoseconds: 2_500_000_000); linkCopied = false
    }
    func switchFromLegacy() async {
        guard legacy, !working, installed else { return }
        working = true; defer { working = false }
        let original = home.appendingPathComponent("Library/LaunchAgents/com.agentremote.desktop.plist")
        let backup = original.appendingPathExtension("previous-\(UUID().uuidString)")
        var stoppedLegacy = false
        do {
            let info = try await admin(["desktop-info"], as: DesktopInfo.self)
            guard info.activeSessions == 0 else { throw DesktopError.message("End the running Agent Remote sessions before switching services.") }
            try FileManager.default.copyItem(at: original, to: backup)
            let result = try await Commands.run(URL(fileURLWithPath: "/bin/launchctl"), ["bootout", "gui/\(getuid())/com.agentremote.desktop"])
            guard result.code == 0 else { throw DesktopError.message("Could not stop the older login service. It has been left in place.") }
            stoppedLegacy = true
            try FileManager.default.removeItem(at: original)
            legacy = false; running = false
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            working = false; await start(); working = true
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard child?.isRunning == true else { throw DesktopError.message("The bundled service did not start.") }
            setLogin(true)
        } catch {
            let reason = error.localizedDescription
            if stoppedLegacy {
                wantsRunning = false; child?.terminate()
                for _ in 0..<50 { if child?.isRunning != true { break }; try? await Task.sleep(nanoseconds: 100_000_000) }
                do {
                    if !FileManager.default.fileExists(atPath: original.path) { try FileManager.default.copyItem(at: backup, to: original) }
                    let restored = try await Commands.run(URL(fileURLWithPath: "/bin/launchctl"), ["bootstrap", "gui/\(getuid())", original.path])
                    guard restored.code == 0 else { throw DesktopError.message("The older service could not be restarted.") }
                    legacy = true; running = true; self.error = reason + " The older service has been restored."
                } catch { self.error = reason + " Restore the saved service definition at " + backup.path + ". " + error.localizedDescription }
            } else { self.error = reason }
        }
    }
    func updateLoginStatus() {
        guard !testing else { return }
        loginEnabled = SMAppService.mainApp.status == .enabled
        loginNeedsApproval = SMAppService.mainApp.status == .requiresApproval
    }
    func setLogin(_ enabled: Bool) {
        guard installed, !testing else { error = "Move Agent Remote into Applications first."; return }
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            updateLoginStatus()
            if loginNeedsApproval { SMAppService.openSystemSettingsLoginItems() }
        } catch { self.error = "Could not change Start at login: " + error.localizedDescription }
    }
    func openLogs() { NSWorkspace.shared.open(logDirectory) }
    func checkAgentSignIn() async {
        while checkingSignIn { try? await Task.sleep(nanoseconds: 100_000_000) }
        checkingSignIn = true; defer { checkingSignIn = false; signInCheckedAt = Date() }
        for (name, path) in [("codex", codex), ("claude", claude)] {
            guard let path else { continue }
            let args = name == "codex" ? ["login", "status"] : ["auth", "status"]
            if let result = try? await Commands.run(URL(fileURLWithPath: path), args, environment: environment) { signedIn[name] = result.code == 0 }
        }
    }
    private func runAgentCommand(_ executable: URL, _ args: [String], seconds: Double) async throws -> CommandResult {
        let process = Process(); agentProcess = process; defer { agentProcess = nil }
        return try await Commands.run(executable, args, environment: environment, timeoutSeconds: seconds, process: process)
    }
    func cancelAgentSetup() { if agentProcess?.isRunning == true { agentProcess?.terminate() } }
    func setupAgent(_ name: String, install: Bool) async {
        guard agentWorking == nil, ["codex", "claude"].contains(name) else { return }
        agentWorking = name; error = nil; defer { agentWorking = nil }
        do {
            if install {
                agentMessage = "Installing \(name == "codex" ? "Codex" : "Claude") from its official provider…"
                let directory = stateDirectory.appendingPathComponent("setup/" + UUID().uuidString)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                defer { try? FileManager.default.removeItem(at: directory) }
                let installer = directory.appendingPathComponent("install.sh")
                let endpoint = name == "codex" ? "https://chatgpt.com/codex/install.sh" : "https://claude.ai/install.sh"
                let downloaded = try await runAgentCommand(URL(fileURLWithPath: "/usr/bin/curl"), ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "15", "--max-time", "120", endpoint, "-o", installer.path], seconds: 130)
                guard downloaded.code == 0 else { throw DesktopError.message("Could not download the official installer. Check your internet connection and retry.") }
                let installed = try await runAgentCommand(URL(fileURLWithPath: name == "codex" ? "/bin/sh" : "/bin/bash"), [installer.path], seconds: 300)
                guard installed.code == 0 else { throw DesktopError.message("The provider installer did not finish. Use Manual setup for its troubleshooting output.") }
                scanAgents()
            }
            guard let path = name == "codex" ? codex : claude else { throw DesktopError.message("The agent executable was not found. Try Manual setup.") }
            agentMessage = "Finish \(name == "codex" ? "Codex" : "Claude") sign-in in your browser. This can take a few minutes."
            let args = name == "codex" ? ["login"] : ["auth", "login"]
            let result = try await runAgentCommand(URL(fileURLWithPath: path), args, seconds: 600)
            guard result.code == 0 else { throw DesktopError.message("Sign-in did not finish. Retry, or use Manual setup if your browser did not open.") }
            await checkAgentSignIn()
            agentMessage = signedIn[name] == true ? "\(name == "codex" ? "Codex" : "Claude") is connected." : "Sign-in finished. Your next session will use this Mac’s provider settings."
        } catch { agentMessage = nil; self.error = error.localizedDescription }
    }
    func openAgent(_ name: String, install: Bool) {
        do {
            let directory = stateDirectory.appendingPathComponent("setup")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let url = directory.appendingPathComponent("\(name)-setup.command")
            let path = name == "codex" ? codex : claude
            let endpoint = name == "codex" ? "https://chatgpt.com/codex/install.sh" : "https://claude.ai/install.sh"
            let shell = name == "codex" ? "/bin/sh" : "/bin/bash"
            let script: String
            if install {
                script = """
                #!/bin/zsh
                set -e
                export PATH=\(Commands.quote(searchDirectories.joined(separator: ":")))
                echo 'Installing \(name) from its official provider…'
                installer=$(/usr/bin/mktemp -t agentremote-\(name))
                trap '/bin/rm -f "$installer"' EXIT
                /usr/bin/curl --fail --show-error --location --proto '=https' --proto-redir '=https' \(Commands.quote(endpoint)) -o "$installer"
                \(shell) "$installer"
                echo 'Installation finished. Complete sign-in below.'
                \(name)
                """
            } else {
                guard let path else { throw DesktopError.message("Install \(name) first.") }
                script = "#!/bin/zsh\nexport PATH=\(Commands.quote(searchDirectories.joined(separator: ":")))\nexec \(Commands.quote(path))\n"
            }
            try script.write(to: url, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
            NSWorkspace.shared.open(url)
        } catch { self.error = error.localizedDescription }
    }
}

private let setupAccent = Color(red: 0.36, green: 0.89, blue: 0.74)

enum StepState { case done, needed, checking, info }

/// One numbered setup step. Finished steps collapse to their summary line so returning users see a short checklist.
struct StepCard<Content: View>: View {
    let number: Int
    let title: String
    let state: StepState
    let summary: String
    @Binding var shown: Bool
    var forceOpen = false
    @ViewBuilder let content: () -> Content
    private var open: Bool { state != .done || shown || forceOpen }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 12) {
                badge.frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline)
                    Text(summary).font(.caption).foregroundStyle(state == .needed ? Color.orange : Color.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                if state == .done && !forceOpen {
                    Button(shown ? "Hide" : "Show") { withAnimation(.easeInOut(duration: 0.15)) { shown.toggle() } }.buttonStyle(.link).font(.callout)
                }
            }
            if open { content().padding(.leading, 36) }
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(state == .needed ? 0.06 : 0.04), in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(state == .needed ? Color.orange.opacity(0.35) : Color.clear))
    }
    @ViewBuilder private var badge: some View {
        switch state {
        case .done: Image(systemName: "checkmark.circle.fill").font(.system(size: 21)).foregroundStyle(setupAccent)
        case .checking: ProgressView().controlSize(.small)
        case .needed, .info:
            Text("\(number)").font(.system(size: 13, weight: .bold, design: .rounded)).foregroundStyle(state == .needed ? Color.orange : Color.secondary)
                .frame(width: 22, height: 22).overlay(Circle().strokeBorder(state == .needed ? Color.orange : Color.secondary, lineWidth: 1.5))
        }
    }
}

/// A permission line: what it is for, its live status, and the one button that fixes it.
struct PermissionRow<Actions: View>: View {
    let title: String
    let detail: String
    let status: String
    let ok: Bool
    @ViewBuilder let actions: () -> Actions
    var body: some View {
        HStack(alignment: .top) {
            Image(systemName: ok ? "checkmark.circle.fill" : "circle.dashed").foregroundStyle(ok ? setupAccent : Color.secondary).padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(title).font(.body.weight(.medium))
                    Text(status).font(.caption.weight(.medium)).foregroundStyle(ok ? setupAccent : Color.orange)
                }
                Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            actions()
        }
    }
}

struct PermissionsStep: View {
    @ObservedObject var permissions: PermissionsModel
    @Binding var shown: Bool
    private static let filesSettings = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders")!
    private var state: StepState { !permissions.checked ? .checking : permissions.complete ? .done : .needed }
    private var summary: String {
        if !permissions.checked { return "Checking permissions…" }
        if permissions.complete { return "Screen Recording and folder access are allowed" }
        let missing = [permissions.screenRecording ? nil : "Screen Recording", permissions.foldersGranted ? nil : "folder access"].compactMap { $0 }
        return "Allow " + missing.joined(separator: " and ") + " so remote sessions don’t stall"
    }
    private var folderStatus: String {
        let values = PermissionsModel.folderNames.map { permissions.folders[$0] ?? .unknown }
        if values.allSatisfy({ $0 == .granted }) { return "Allowed" }
        if values.allSatisfy({ $0 == .unknown }) { return "Not checked" }
        let blocked = PermissionsModel.folderNames.filter { permissions.folders[$0] != .granted }
        return blocked.joined(separator: ", ") + " not allowed"
    }
    var body: some View {
        StepCard(number: 2, title: "Allow permissions", state: state, summary: summary, shown: $shown) {
            VStack(alignment: .leading, spacing: 14) {
                PermissionRow(title: "Screen Recording", detail: "Lets agents take screenshots of this Mac. If the switch in System Settings is already on, this clears the old entry so you can turn it on again. Choose Later if macOS offers Quit & Reopen: reopening ends running sessions.",
                              status: permissions.screenRecording ? "Allowed" : "Not allowed", ok: permissions.screenRecording) {
                    if !permissions.screenRecording {
                        Button(permissions.screenRequested ? "Fix in Settings…" : "Grant…") { permissions.requestScreenRecording() }
                    }
                }
                Divider()
                PermissionRow(title: "Desktop, Documents and Downloads", detail: "macOS asks once per folder the first time an agent opens it, and a phone session waits until someone clicks Allow at this Mac. Answer those prompts now instead.",
                              status: folderStatus, ok: permissions.foldersGranted) {
                    if !permissions.foldersGranted {
                        if PermissionsModel.folderNames.contains(where: { permissions.folders[$0] == .denied }) {
                            Button("Open Settings") { NSWorkspace.shared.open(Self.filesSettings) }
                        } else {
                            Button(permissions.requestingFolders ? "Waiting…" : "Allow folder access") { Task { await permissions.requestFolders() } }
                                .disabled(permissions.requestingFolders)
                        }
                    }
                }
                if !permissions.fullDiskAccess {
                    HStack(spacing: 4) {
                        Text("Optional: Full Disk Access covers every folder at once.").font(.caption).foregroundStyle(.secondary)
                        Button("Open Full Disk Access settings") { NSWorkspace.shared.open(PermissionsModel.fullDiskSettings) }.buttonStyle(.link).font(.caption)
                    }
                }
                ForEach(permissions.browsers) { browser in
                    Divider()
                    PermissionRow(title: browser.name + " (optional)", detail: "Lets agents work in your signed-in tabs. " + browser.javascriptTip,
                                  status: Self.text(browser.access), ok: browser.access == .granted) {
                        if browser.access != .granted {
                            Button(permissions.requestingBrowser == browser.id ? "Waiting…" : browser.access == .denied ? "Open Settings" : "Allow…") {
                                Task { await permissions.requestAutomation(browser.id) }
                            }.disabled(permissions.requestingBrowser != nil)
                        }
                    }
                }
            }
        }
    }
    private static func text(_ access: Access) -> String {
        switch access { case .granted: return "Allowed"; case .denied: return "Not allowed"; case .notDetermined: return "Not asked yet"; case .unknown: return "Not checked" }
    }
}

struct SetupView: View {
    @ObservedObject var model: DesktopModel
    @State private var confirmStop = false
    @State private var confirmTerminal = false
    @State private var shown: Set<Int> = []
    private var accent: Color { setupAccent }
    private func shownBinding(_ step: Int) -> Binding<Bool> {
        Binding(get: { shown.contains(step) }, set: { if $0 { shown.insert(step) } else { shown.remove(step) } })
    }
    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 16) {
                        Image(systemName: "desktopcomputer").font(.system(size: 35, weight: .medium)).foregroundStyle(accent)
                            .frame(width: 70, height: 70).background(accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 18))
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Agent Remote").font(.system(size: 29, weight: .bold, design: .rounded))
                            Text("Your Mac’s agents, on your phone or laptop.").font(.callout).foregroundStyle(.secondary)
                        }
                        Spacer()
                    }.padding(.bottom, 6)
                    statusCard
                    if !model.installed {
                        Label("Drag Agent Remote into Applications before enabling Start at login.", systemImage: "folder")
                            .font(.callout).foregroundStyle(.orange)
                    }
                    if let error = model.error {
                        Label(error, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange).textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    agentsStep
                    PermissionsStep(permissions: model.permissions, shown: shownBinding(2))
                    awakeStep
                    pairStep.id(4)
                    tryStep
                    footer
                }.padding(28)
            }
            .onChange(of: model.qrImage != nil) { showing in
                if showing { withAnimation { proxy.scrollTo(4, anchor: .top) } }
            }
        }
        .background(Color(red: 0.055, green: 0.075, blue: 0.075))
        .preferredColorScheme(.dark).tint(accent)
        .onAppear { Task { await model.recheck() } }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in Task { await model.recheck() } }
        .alert("Stop remote access?", isPresented: $confirmStop) {
            Button("Cancel", role: .cancel) {}
            Button("Stop", role: .destructive) { Task { await model.stop() } }
        } message: { Text("Your phone will disconnect, and agent work started by this service may be interrupted. Conversation history is kept.") }
        .alert("Enable Terminal Access?", isPresented: $confirmTerminal) {
            Button("Cancel", role: .cancel) {}
            Button("Enable") { Task { await model.enableTerminal() } }
        } message: {
            Text("This adds one line to ~/.zshrc so claude, codex and pickup in new Terminal tabs share sessions with your phone. A backup of ~/.zshrc is saved first. Works with zsh only."
                 + (model.loginShellIsZsh ? "" : " Your login shell isn’t zsh, so it won’t take effect until you use zsh."))
        }
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Circle().fill(model.connected ? accent : model.running ? Color.orange : Color.secondary).frame(width: 9, height: 9)
                Text(model.connection).font(.headline)
                Spacer()
                if model.working { ProgressView().controlSize(.small) }
            }
            Text("\(model.pairedDevices) paired \(model.pairedDevices == 1 ? "device" : "devices") · \(model.activeSessions) active \(model.activeSessions == 1 ? "session" : "sessions")")
                .font(.caption).foregroundStyle(.secondary)
            if model.legacy {
                Text("An earlier Agent Remote service is already running. Your existing pairing still works.").font(.callout).foregroundStyle(.secondary)
                Button("Use this app to manage the service") { Task { await model.switchFromLegacy() } }
                    .disabled(model.working || !model.installed)
            } else if !model.running {
                Button("Start remote access") { Task { await model.start() } }.buttonStyle(.borderedProminent).tint(accent).foregroundStyle(.black)
                    .disabled(model.working)
            }
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading).background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 14))
    }

    // Step 1
    private var agentsStep: some View {
        let ready = [("Claude", "claude", model.claude), ("Codex", "codex", model.codex)].filter { $0.2 != nil && model.signedIn[$0.1] == true }.map(\.0)
        let installedUnknown = (model.claude != nil && model.signedIn["claude"] == nil) || (model.codex != nil && model.signedIn["codex"] == nil)
        let state: StepState = model.agentReady ? .done : model.signInPending && installedUnknown ? .checking : .needed
        let summary = model.agentReady ? ready.joined(separator: " and ") + (ready.count == 1 ? " is" : " are") + " signed in"
            : state == .checking ? "Checking your agents…" : "Install Claude Code or Codex and sign in"
        return StepCard(number: 1, title: "Connect an agent", state: state, summary: summary, shown: shownBinding(1)) {
            VStack(alignment: .leading, spacing: 14) {
                agent("Claude", name: "claude", path: model.claude)
                Divider()
                agent("Codex", name: "codex", path: model.codex)
                if let message = model.agentMessage {
                    HStack { if model.agentWorking != nil { ProgressView().controlSize(.small) }; Text(message).font(.caption).foregroundStyle(.secondary); if model.agentWorking != nil { Button("Cancel") { model.cancelAgentSetup() } } }
                }
                Text("You need at least one. Existing sign-ins are reused. Install missing agents here and finish sign-in in your browser. Local models use your installed Ollama or LM Studio server.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // Step 3
    private var awakeStep: some View {
        let state: StepState = model.keepAwake == true ? .done : model.keepAwake == false ? .needed : .info
        let summary = model.keepAwake == true ? "On · this Mac stays awake while agents work"
            : model.keepAwake == false ? "Off · this Mac may sleep in the middle of a task" : "Keep this Mac awake and online while you’re away"
        return StepCard(number: 3, title: "Keep this Mac awake", state: state, summary: summary, shown: shownBinding(3)) {
            VStack(alignment: .leading, spacing: 6) {
                if let enabled = model.keepAwake {
                    Toggle("Keep this Mac awake while agents work", isOn: Binding(get: { enabled }, set: { value in Task { await model.setKeepAwake(value) } }))
                        .toggleStyle(.switch).controlSize(.small)
                }
                Text("Your Mac can still sleep when you close a laptop lid.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    // Step 4
    private var pairStep: some View {
        let paired = model.pairedDevices > 0
        let summary = paired ? "\(model.pairedDevices) paired \(model.pairedDevices == 1 ? "device" : "devices") · pair another any time"
            : "Scan a QR code with your iPhone, or copy a link for your laptop"
        return StepCard(number: 4, title: "Pair a phone or laptop", state: paired ? .done : .needed, summary: summary, shown: shownBinding(4), forceOpen: model.qrImage != nil) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Button(model.qrImage == nil ? "Show pairing code" : "New code") { Task { await model.pair() } }
                        .disabled(!model.running || model.working)
                    Button(model.linkCopied ? "Copied" : "Copy pairing link") { Task { await model.copyPairingLink() } }
                        .disabled(!model.running || model.working || (model.qrImage != nil && model.pairingURI == nil))
                    Spacer()
                }
                if !model.running { Text("Start remote access first.").font(.caption).foregroundStyle(.orange) }
                if let image = model.qrImage {
                    HStack {
                        Spacer()
                        VStack(spacing: 10) {
                            Image(nsImage: image).interpolation(.none).resizable().scaledToFit().frame(width: 244, height: 244).background(.white).clipShape(RoundedRectangle(cornerRadius: 12))
                            Text("Expires at \(model.qrExpires.formatted(date: .omitted, time: .shortened)) · Single use").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                }
                Text("iPhone: open Agent Remote, tap Pair this iPhone, then Scan QR code. Already paired with another Mac? Use the gear menu → Pair another Mac.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text("Laptop: on your paired phone, tap the gear menu → Add a device… → Send link, and AirDrop it to the laptop. Or copy the pairing link here and send it to yourself. A link works once, for 5 minutes. Anyone with it can control this Mac.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Link("Don’t have the app yet? Get it for iPhone, or Agent Remote Client for another Mac.", destination: URL(string: "https://smatt989.github.io/agentremote-site/#download")!)
                    .font(.caption)
            }
        }
    }

    // Step 5
    private var tryStep: some View {
        StepCard(number: 5, title: "Try it", state: .info, summary: "Open Agent Remote on your phone and start a chat.", shown: .constant(true)) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Try: “Summarize what’s in my Downloads folder.”").font(.callout)
                Divider()
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text("Terminal access (optional)").font(.body.weight(.medium))
                            if model.terminalEnabled { Text("On").font(.caption.weight(.medium)).foregroundStyle(accent) }
                        }
                        Text("Run claude, codex and pickup in Terminal and share those sessions with your phone.").font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 12)
                    if !model.terminalEnabled {
                        Button("Enable Terminal Access…") { confirmTerminal = true }.disabled(model.working || (model.codex == nil && model.claude == nil))
                    }
                }
                if let message = model.terminalMessage {
                    Text(message).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
                if model.terminalEnabled {
                    Text("Tip: run `pickup` in a new Terminal tab to continue a phone chat here.").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Button("Pair a device…") { Task { await model.pair() } }.disabled(!model.running || model.working)
                Button("Open Agent Remote Client…") { (NSApp.delegate as? AppDelegate)?.openClient() }.disabled(!model.running)
                Button("Knowledge wiki…") { (NSApp.delegate as? AppDelegate)?.showKnowledge() }.disabled(!model.running)
                Spacer()
            }
            HStack {
                Toggle("Start at login", isOn: Binding(get: { model.loginEnabled }, set: { model.setLogin($0) }))
                    .toggleStyle(.switch).controlSize(.small).disabled(!model.installed || model.testing)
                Spacer()
                Button("Open logs") { model.openLogs() }
                if !model.legacy && model.running {
                    Button("Stop remote access") { confirmStop = true }.disabled(model.working)
                }
            }
            if model.loginNeedsApproval {
                Button("Allow Agent Remote in Login Items…") { SMAppService.openSystemSettingsLoginItems() }
            }
            Text("Close this window to leave Agent Remote running in the menu bar. New agent sessions have full access to this Mac.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text("Version \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?") (\(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"))")
                .font(.caption2).foregroundStyle(.tertiary).textSelection(.enabled)
        }.padding(.top, 6)
    }

    private func agent(_ title: String, name: String, path: String?) -> some View {
        let status = model.signedIn[name]
        let label = path == nil ? "Not installed" : status == true ? "Signed in" : status == false ? "Sign in to connect"
            : model.signInPending ? "Checking…" : "Installed · couldn’t check sign-in"
        return HStack {
            Image(systemName: path != nil && status == true ? "checkmark.circle.fill" : path != nil && status == false ? "exclamationmark.circle" : "circle.dashed")
                .foregroundStyle(path != nil && status == true ? accent : path != nil && status == false ? Color.orange : Color.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.medium))
                Text(label).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button(path == nil ? "Install \(title)…" : "Sign in…") { Task { await model.setupAgent(name, install: path == nil) } }.disabled(model.agentWorking != nil)
            Menu {
                Button("Manual setup in Terminal…") { model.openAgent(name, install: path == nil) }
            } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).frame(width: 22).disabled(model.agentWorking != nil)
        }
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = DesktopModel()
    lazy var updater = Updater(model: model)
    var autoUpdateItem: NSMenuItem!
    var window: NSWindow!
    var statusItem: NSStatusItem!
    var knowledgeWindow: NSWindow?
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 740), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Agent Remote"; window.minSize = NSSize(width: 560, height: 590); window.center(); window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: SetupView(model: model))
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menuIcon = NSImage(named: "MenuBarTemplate")
        menuIcon?.isTemplate = true
        menuIcon?.size = NSSize(width: 22, height: 22)
        menuIcon?.accessibilityDescription = "Agent Remote"
        statusItem.button?.image = menuIcon ?? NSImage(systemSymbolName: "point.3.connected.trianglepath.dotted", accessibilityDescription: "Agent Remote")
        let menu = NSMenu()
        menu.addItem(withTitle: "Open Agent Remote…", action: #selector(showWindow), keyEquivalent: "")
        menu.addItem(withTitle: "Open Agent Remote Client…", action: #selector(openClient), keyEquivalent: "n")
        menu.addItem(withTitle: "Knowledge wiki…", action: #selector(showKnowledge), keyEquivalent: "k")
        menu.addItem(withTitle: "Pair a device…", action: #selector(pairPhone), keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "")
        autoUpdateItem = menu.addItem(withTitle: "Install Updates Automatically", action: #selector(toggleAutoUpdate), keyEquivalent: "")
        autoUpdateItem.state = updater.automatic ? .on : .off
        menu.addItem(withTitle: "Open logs", action: #selector(openLogs), keyEquivalent: "")
        menu.addItem(withTitle: "Quit Agent Remote…", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items { item.target = self }; statusItem.menu = menu
        // A login launch stays quietly in the menu bar after the first open.
        if !UserDefaults.standard.bool(forKey: "hasOpened") || NSAppleEventManager.shared().currentAppleEvent?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue != keyAELaunchedAsLogInItem {
            showWindow()
        }
        if !model.testing { UserDefaults.standard.set(true, forKey: "hasOpened") }
        Task {
            await model.begin()
            updater.start()
            if model.testing, let report = ProcessInfo.processInfo.environment["AGENT_REMOTE_TEST_REPORT"] { await testInterface(report: URL(fileURLWithPath: report)) }
        }
    }
    // Opt-in packaging checks run only with isolated test state supplied by the test script.
    private func testInterface(report: URL) async {
        var result: [String: Any] = [:]
        do {
            for _ in 0..<150 { model.refresh(); if model.connected { break }; try await Task.sleep(nanoseconds: 200_000_000) }
            guard model.connected else { throw DesktopError.message("UI did not observe a connected service.") }
            if ProcessInfo.processInfo.environment["AGENT_REMOTE_TEST_AGENT_DIR"] != nil {
                await model.setupAgent("codex", install: false)
                await model.setupAgent("claude", install: false)
                guard model.signedIn["codex"] == true && model.signedIn["claude"] == true && model.error == nil else { throw DesktopError.message("Agent sign-in command routing failed.") }
                result["signInCommandRouting"] = true
            }
            await model.pair()
            guard model.qrImage != nil && model.qrExpires > Date() else { throw DesktopError.message("Native QR pairing view failed.") }
            result["pairingUI"] = true
            model.qrImage = nil; model.pairingURI = nil // Never include a real invitation in the diagnostic image.
            if let path = ProcessInfo.processInfo.environment["AGENT_REMOTE_TEST_SNAPSHOT"] {
                try await Task.sleep(nanoseconds: 200_000_000)
                if let view = window.contentView {
                    view.layoutSubtreeIfNeeded(); view.displayIfNeeded()
                    if let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
                        view.cacheDisplay(in: view.bounds, to: bitmap)
                        if let png = bitmap.representation(using: .png, properties: [:]) {
                            try png.write(to: URL(fileURLWithPath: path))
                            result["snapshot"] = true
                        }
                    }
                }
            }
            window.close()
            try await Task.sleep(nanoseconds: 500_000_000)
            model.refresh()
            guard model.running && model.connected else { throw DesktopError.message("Closing the window stopped the service.") }
            result["closeKeepsRunning"] = true
            if ProcessInfo.processInfo.environment["AGENT_REMOTE_TEST_LOGIN_ITEM"] == "1" {
                guard SMAppService.mainApp.status == .notRegistered || SMAppService.mainApp.status == .notFound else {
                    throw DesktopError.message("A login item was already registered; this test will not change it.")
                }
                do {
                    try SMAppService.mainApp.register()
                    result["loginItemStatus"] = SMAppService.mainApp.status.rawValue
                    try await SMAppService.mainApp.unregister()
                    result["loginItemUnregistered"] = true
                } catch {
                    try? await SMAppService.mainApp.unregister()
                    throw error
                }
            }
            await model.stop()
            guard !model.running else { throw DesktopError.message("Stop remote access did not stop the service.") }
            await model.start()
            for _ in 0..<150 { model.refresh(); if model.connected { break }; try await Task.sleep(nanoseconds: 200_000_000) }
            guard model.connected else { throw DesktopError.message("Start remote access did not reconnect.") }
            result["stopAndRestart"] = true
        } catch { result["error"] = error.localizedDescription }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: report, options: .atomic) }
    }
    @objc func showKnowledge() {
        if knowledgeWindow == nil {
            let view = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            view.title = "Agent Remote — Knowledge"; view.isReleasedWhenClosed = false; view.center()
            view.contentView = NSHostingView(rootView: WikiView()); knowledgeWindow = view
        }
        knowledgeWindow?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    /// Chats on this Mac happen in Agent Remote Client, the same app as on the phone and other Macs.
    @objc func openClient() {
        if let client = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.agentremote.iphone") {
            NSWorkspace.shared.openApplication(at: client, configuration: NSWorkspace.OpenConfiguration())
        } else {
            NSWorkspace.shared.open(URL(string: "https://smatt989.github.io/agentremote-site/#download")!)
        }
    }
    @objc func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func pairPhone() { showWindow(); Task { await model.pair() } }
    @objc func openLogs() { model.openLogs() }
    @objc func checkForUpdates() { Task { await updater.check(manual: true) } }
    @objc func toggleAutoUpdate() { updater.automatic.toggle(); autoUpdateItem.state = updater.automatic ? .on : .off }
    @objc func quit() { NSApp.terminate(nil) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if model.running && !model.legacy && !model.testing {
            let alert = NSAlert(); alert.messageText = "Quit Agent Remote?"
            alert.informativeText = "Remote access will stop, and work started by this service may be interrupted. Close the window instead to keep it running."
            alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "Quit and stop remote access")
            if alert.runModal() == .alertFirstButtonReturn { return .terminateCancel }
        }
        return .terminateNow
    }
    func applicationWillTerminate(_ notification: Notification) { model.terminate() }
}
@main struct AgentRemoteMac {
    @MainActor static func main() {
        let app = NSApplication.shared; let delegate = AppDelegate(); app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
