import CryptoKit
import Foundation
import SwiftUI

/// Automatic updates for Agent Remote Client (the Mac Catalyst build). Reads the `update.json` published on every
/// GitHub release, downloads a newer client, and installs it only if it matches the published checksum, is signed by
/// this team with this bundle identifier, is notarized and carries the advertised build. The verified copy replaces
/// the app when it next quits, or straight away with Restart to Update. The phone updates through TestFlight instead.
@MainActor final class MacUpdater: ObservableObject {
    static let shared = MacUpdater()
    @Published private(set) var readyVersion: String?
    @Published private(set) var status = ""
    private var checking = false
    private var lastCheck = Date.distantPast
    private var relaunchFlag: URL?

    func start() {
        #if targetEnvironment(macCatalyst)
        Task {
            while true {
                if readyVersion == nil, Date().timeIntervalSince(lastCheck) > 6 * 3600 { await check() }
                try? await Task.sleep(nanoseconds: 15 * 60 * 1_000_000_000)
            }
        }
        #endif
    }

    #if targetEnvironment(macCatalyst)
    private static let manifestURL = URL(string: "https://github.com/smatt989/agentremote-site/releases/latest/download/update.json")!
    private struct Manifest: Decodable {
        struct Asset: Decodable { let build: Int; let url: URL; let sha256: String }
        let version: String
        let client: Asset
    }
    private let installed = Bundle.main.bundleURL
    private let currentBuild = Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0
    /// A translocated or disk-image copy cannot be replaced; the app has to be moved to Applications first.
    var canInstall: Bool {
        let path = installed.path
        return !path.contains("/AppTranslocation/") && !path.hasPrefix("/Volumes/")
            && FileManager.default.isWritableFile(atPath: installed.deletingLastPathComponent().path)
    }

    func check(manual: Bool = false) async {
        guard !checking, readyVersion == nil else { return }
        checking = true; lastCheck = Date(); defer { checking = false }
        do {
            var request = URLRequest(url: Self.manifestURL); request.cachePolicy = .reloadIgnoringLocalCacheData
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw AppError.message("No update information is published yet.") }
            let manifest = try JSONDecoder().decode(Manifest.self, from: data)
            guard manifest.client.build > currentBuild else { status = "Agent Remote Client is up to date."; return }
            guard canInstall else { status = "Version \(manifest.version) is available. Move Agent Remote Client to Applications to update."; return }
            status = "Downloading version \(manifest.version)…"
            let app = try await fetch(manifest.client)
            try scheduleInstall(app)
            readyVersion = manifest.version
            status = "Version \(manifest.version) installs when Agent Remote Client quits."
        } catch {
            status = "Update check failed: \(error.localizedDescription)"
        }
    }

    private func fetch(_ asset: Manifest.Asset) async throws -> URL {
        let work = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("\(Bundle.main.bundleIdentifier ?? "AgentRemoteClient")/updates/\(asset.build)") // Catalyst's cache folder is not per app
        try? FileManager.default.removeItem(at: work)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let (temporary, response) = try await URLSession.shared.download(from: asset.url)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw AppError.message("The update download failed.") }
        let zip = work.appendingPathComponent("client.zip")
        try FileManager.default.moveItem(at: temporary, to: zip)
        let digest = SHA256.hash(data: try Data(contentsOf: zip, options: .mappedIfSafe)).map { String(format: "%02x", $0) }.joined()
        guard digest == asset.sha256.lowercased() else { throw AppError.message("The update did not match its published checksum.") }
        guard try await Self.run("/usr/bin/ditto", ["-x", "-k", zip.path, work.path]) == 0 else { throw AppError.message("The update could not be unpacked.") }
        try? FileManager.default.removeItem(at: zip)
        let app = work.appendingPathComponent("Agent Remote Client.app")
        let requirement = "=anchor apple generic and certificate leaf[subject.OU] = \"YA9PU25M2S\" and identifier \"\(Bundle.main.bundleIdentifier ?? "")\""
        guard try await Self.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", requirement, app.path]) == 0 else {
            throw AppError.message("The update is not signed by Agent Remote's developer.")
        }
        guard try await Self.run("/usr/sbin/spctl", ["--assess", "--type", "execute", app.path]) == 0 else {
            throw AppError.message("macOS did not accept the update's notarization.")
        }
        let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        guard Int(info?["CFBundleVersion"] as? String ?? "") == asset.build else { throw AppError.message("The update's build number did not match its release.") }
        return app
    }

    /// Starts a detached helper that waits for this process to exit, swaps the bundle (restoring the old one if the
    /// copy fails), and reopens the app only if Restart to Update created the flag file.
    private func scheduleInstall(_ app: URL) throws {
        let work = app.deletingLastPathComponent()
        let flag = work.appendingPathComponent("relaunch")
        let script = """
        PID=$1; NEW=$2; DEST=$3; FLAG=$4; OLD=$5
        while kill -0 $PID 2>/dev/null; do sleep 1; done
        codesign --verify --deep --strict "$NEW" || exit 1
        rm -rf "$OLD"; mv "$DEST" "$OLD" || exit 1
        if ditto "$NEW" "$DEST" && codesign --verify --deep --strict "$DEST"; then rm -rf "$OLD" "$NEW"
        else rm -rf "$DEST"; mv "$OLD" "$DEST"; fi
        [ -e "$FLAG" ] && { rm -f "$FLAG"; open "$DEST"; }
        """
        // Its own session (setsid), so it is not stopped along with this app's process group when the app quits.
        let arguments = ["/bin/zsh", "-c", script, "install", String(getpid()), app.path, installed.path, flag.path, work.appendingPathComponent("previous.app").path]
        guard Self.spawn(arguments, newSession: true) != nil else { throw AppError.message("The update helper could not start.") }
        relaunchFlag = flag
    }

    func restartToUpdate() {
        guard let relaunchFlag else { return }
        FileManager.default.createFile(atPath: relaunchFlag.path, contents: nil)
        // Quit through AppKit so the app shuts down normally; the helper then installs and reopens it.
        if let app = (NSClassFromString("NSApplication") as? NSObject.Type)?.value(forKey: "sharedApplication") as? NSObject {
            app.perform(NSSelectorFromString("terminate:"), with: nil)
        } else { exit(0) }
    }

    /// Foundation's Process is unavailable in Mac Catalyst, so tools are started with posix_spawn.
    nonisolated private static func spawn(_ arguments: [String], newSession: Bool = false) -> pid_t? {
        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        if newSession { posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID)) }
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        for descriptor: Int32 in [0, 1, 2] { posix_spawn_file_actions_addopen(&actions, descriptor, "/dev/null", descriptor == 0 ? O_RDONLY : O_WRONLY, 0) }
        var argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) } + [nil]
        var pid: pid_t = 0
        let result = posix_spawn(&pid, arguments[0], &actions, &attributes, &argv, environ)
        argv.forEach { free($0) }
        posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes)
        return result == 0 ? pid : nil
    }

    private static func run(_ executable: String, _ arguments: [String]) async throws -> Int32 {
        await Task.detached {
            guard let pid = spawn([executable] + arguments) else { return -1 }
            var status: Int32 = 0
            while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
            return (status & 0x7f) == 0 ? (status >> 8) & 0xff : -1
        }.value
    }
    #else
    func check(manual: Bool = false) async {}
    func restartToUpdate() {}
    #endif
}
