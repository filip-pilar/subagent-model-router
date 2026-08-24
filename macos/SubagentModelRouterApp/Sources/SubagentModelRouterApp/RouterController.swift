import AppKit
import Combine
import Darwin
import Foundation
import ServiceManagement

struct LaunchAtLoginService {
    let isEnabled: () -> Bool
    let register: () throws -> Void
    let unregister: () throws -> Void

    static let system = LaunchAtLoginService(
        isEnabled: { SMAppService.mainApp.status == .enabled },
        register: { try SMAppService.mainApp.register() },
        unregister: { try SMAppService.mainApp.unregister() }
    )
}

struct LaunchAtLoginPreference {
    let value: () -> Bool?
    let set: (Bool?) -> Void

    private static let key = "launchAtLoginPreference"
    static let system = LaunchAtLoginPreference(
        value: {
            guard UserDefaults.standard.object(forKey: key) != nil else { return nil }
            return UserDefaults.standard.bool(forKey: key)
        },
        set: { value in
            if let value { UserDefaults.standard.set(value, forKey: key) }
            else { UserDefaults.standard.removeObject(forKey: key) }
        }
    )
}

@MainActor
final class RouterController: ObservableObject {
    enum GatewayState: Equatable { case checking, starting, running, stopped, failed(String) }
    struct Feedback: Equatable { var title: String; var detail: String; var failure: Bool }
    private struct ModelDiscoveryKey: Hashable { var destination: String; var harness: Harness }

    static let usageGuideURL = URL(string: "https://github.com/filip-pilar/subagent-model-router/blob/main/docs/USING_THE_APP.md")!

    @Published private(set) var gatewayState: GatewayState = .checking
    @Published private(set) var payload: AppStatePayload?
    @Published private(set) var feedback: Feedback?
    @Published private(set) var busy = false
    @Published private var discoveredModels: [ModelDiscoveryKey: [String]] = [:]
    @Published private(set) var destinationReachability: [String: DestinationReachability] = [:]
    @Published private(set) var pendingForceHarness: Harness?
    @Published private(set) var pendingForceHarnessConflicts: [String] = []
    @Published private(set) var pendingForceReset = false
    @Published private(set) var pendingForceResetConflicts: [String] = []
    @Published var launchAtLogin: Bool

    let paths: AppPaths
    private let installHelper: @Sendable (AppPaths) throws -> Void
    private let helperRunner: @Sendable (URL, [String], Data?, TimeInterval) throws -> ProcessResult
    private let readinessInspector: @Sendable () async -> RouterReadiness.Snapshot?
    private let launchAtLoginService: LaunchAtLoginService
    private let launchAtLoginPreference: LaunchAtLoginPreference
    private var helperProcess: Process?
    private var lifeline: Pipe?
    private var stopping = false
    private var monitorTask: Task<Void, Never>?
    private var reloadTask: Task<Void, Never>?
    private let watcher = ConfigWatcher()

    var isRunning: Bool { gatewayState == .running }
    var configured: Bool { payload?.integration.claude == true || payload?.integration.codex == true }
    var enabledRoutes: Int {
        guard let config = payload?.config else { return 0 }
        return config.routes.claude.values.filter(\.enabled).count + config.routes.codex.values.filter(\.enabled).count
    }

    init(
        paths: AppPaths = .current,
        autoBootstrap: Bool = true,
        installHelper: @escaping @Sendable (AppPaths) throws -> Void = { try RouterController.installBundledHelper(paths: $0) },
        helperRunner: @escaping @Sendable (URL, [String], Data?, TimeInterval) throws -> ProcessResult = { executable, arguments, input, timeout in
            try ProcessRunner.run(executable: executable, arguments: arguments, input: input, timeout: timeout)
        },
        readinessInspector: @escaping @Sendable () async -> RouterReadiness.Snapshot? = { await RouterReadiness.inspect() },
        launchAtLoginService: LaunchAtLoginService = .system,
        launchAtLoginPreference: LaunchAtLoginPreference = .system
    ) {
        self.paths = paths
        self.installHelper = installHelper
        self.helperRunner = helperRunner
        self.readinessInspector = readinessInspector
        self.launchAtLoginService = launchAtLoginService
        self.launchAtLoginPreference = launchAtLoginPreference
        self.launchAtLogin = launchAtLoginService.isEnabled()
        guard autoBootstrap else { return }
        Task { await bootstrap() }
        monitorTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                guard let self, !Task.isCancelled else { return }
                await self.refreshReadiness()
            }
        }
    }

    func bootstrap() async {
        busy = true
        gatewayState = .checking
        do {
            let installHelper = installHelper
            let paths = paths
            try await Task.detached { try installHelper(paths) }.value
            Self.migrateLegacyDefaults()
            try await refreshPayload(showErrors: true)
            startWatching()
            if configured {
                try await startGateway()
            } else { gatewayState = .stopped }
        } catch { record(error, title: "Subagent Model Router could not start", affectGateway: true) }
        busy = false
    }

    func refreshPayload(showErrors: Bool = false) async throws {
        let result = try await runHelper(["--config", paths.config.path, "app-state", "--json"])
        guard result.status == 0 else { throw commandError(result) }
        payload = try JSONDecoder().decode(AppStatePayload.self, from: Data(result.stdout.utf8))
        destinationReachability = destinationReachability.filter { payload?.config.destinations[$0.key] != nil }
        if showErrors { feedback = nil }
    }

    func startGatewayAction() { Task { do { try await startGateway() } catch { record(error, title: "Could not start the router", affectGateway: true) } } }

    private func startGateway() async throws {
        guard helperProcess?.isRunning != true else { return }
        busy = true; gatewayState = .starting
        try Self.ensurePrivateDirectory(paths.dataDirectory)
        let descriptor = open(paths.log.path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { busy = false; throw Self.posixError("Could not open the router log") }
        _ = fchmod(descriptor, 0o600)
        let log = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        let process = Process(), pipe = Pipe()
        process.executableURL = paths.helper
        process.arguments = ["--config", paths.config.path, "start", "--parent-lifeline"]
        process.standardInput = pipe
        process.standardOutput = log
        process.standardError = log
        process.terminationHandler = { [weak self] completed in
            try? log.close()
            Task { @MainActor in
                guard let self, self.helperProcess === completed else { return }
                self.helperProcess = nil; self.lifeline = nil
                if !self.stopping { self.recordFailure("Router helper stopped", "Exit status \(completed.terminationStatus).", affectGateway: true) }
            }
        }
        try process.run()
        helperProcess = process; lifeline = pipe; stopping = false
        for _ in 0..<100 {
            if await readinessInspector() != nil { gatewayState = .running; busy = false; return }
            if !process.isRunning { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        await stopGateway()
        busy = false
        throw NSError(domain: "SubagentModelRouter", code: 1, userInfo: [NSLocalizedDescriptionKey: "The gateway did not become ready. Open the log for details."])
    }

    func stopGatewayAction() { Task { await stopGateway(); gatewayState = .stopped } }
    private func stopGateway() async {
        stopping = true
        if let helperProcess { await ProcessLifecycle.stop(helperProcess, lifeline: lifeline) }
        helperProcess = nil; lifeline = nil; gatewayState = .stopped; stopping = false
    }

    func setup(_ harness: Harness, force: Bool = false) { Task { await setupOperation(harness, force: force) } }

    func setupOperation(_ harness: Harness, force: Bool = false) async {
        let wasConfigured = configured
        busy = true; feedback = nil
        do {
            let result = try await runHelper(["--config", paths.config.path, "setup", harness.rawValue, "--helper-path", paths.helper.path, "--json"] + (force ? ["--force"] : []), timeout: 60)
            guard result.status == 0 else { throw commandError(result) }
            try await refreshPayload()
            if !isRunning { try await startGateway() }
            if !wasConfigured,
               configured,
               launchAtLoginPreference.value() != false,
               !launchAtLoginService.isEnabled() {
                try? launchAtLoginService.register()
            }
            launchAtLogin = launchAtLoginService.isEnabled()
            feedback = Feedback(title: "\(harness.title) routing is set up", detail: "The original configuration can be restored at any time.", failure: false)
        } catch { record(error, title: "Could not set up \(harness.title)") }
        busy = false
    }

    func remove(_ harness: Harness, force: Bool = false) { Task { await removeOperation(harness, force: force) } }

    func removeOperation(_ harness: Harness, force: Bool = false) async {
        busy = true; feedback = nil
        do {
            let result = try await runHelper(["--config", paths.config.path, "remove", harness.rawValue, "--json"] + (force ? ["--force"] : []), timeout: 60)
            guard result.status == 0 else { throw commandError(result) }
            let lifecycle = try JSONDecoder().decode(LifecycleResult.self, from: Data(result.stdout.utf8))
            if !lifecycle.conflicts.isEmpty {
                pendingForceHarness = harness
                pendingForceHarnessConflicts = lifecycle.conflicts
                recordFailure("Configuration changed after setup", lifecycle.conflicts.joined(separator: "\n"))
            } else {
                pendingForceHarness = nil
                pendingForceHarnessConflicts = []
                try await refreshPayload()
                feedback = Feedback(title: "\(harness.title) restored", detail: "Router-owned configuration was removed.", failure: false)
                if !configured { await stopGateway() }
            }
        } catch { record(error, title: "Could not restore \(harness.title)") }
        busy = false
    }

    func saveConfig(_ config: RouterConfig) async throws {
        do {
            let data = try JSONEncoder.pretty.encode(config)
            let result = try await runHelper(["--config", paths.config.path, "config", "replace", "--helper-path", paths.helper.path, "--json"], input: data, timeout: 60)
            guard result.status == 0 else { throw commandError(result) }
            payload?.config = try JSONDecoder().decode(RouterConfig.self, from: Data(result.stdout.utf8))
            feedback = Feedback(title: "Configuration applied", detail: "Routes and catalogs are up to date.", failure: false)
        } catch {
            record(error, title: "Configuration was not applied")
            throw error
        }
    }

    func testModels(destination: String, harness: Harness) async {
        let key = ModelDiscoveryKey(destination: destination, harness: harness)
        discoveredModels[key] = []
        destinationReachability[destination] = .checking
        do {
            let result = try await runHelper(["--config", paths.config.path, "models", destination, harness.rawValue, "--json"])
            guard result.status == 0 else { throw commandError(result) }
            let models = try JSONDecoder().decode(ModelsResult.self, from: Data(result.stdout.utf8))
            discoveredModels[key] = models.models
            destinationReachability[destination] = .reachable(modelCount: models.models.count)
            feedback = Feedback(title: "Destination is reachable", detail: models.models.isEmpty ? "No models were advertised; manual entry remains available." : "Found \(models.models.count) models.", failure: false)
        } catch {
            destinationReachability[destination] = .unreachable(error.localizedDescription)
            record(error, title: "Destination is currently unreachable")
        }
    }

    func models(destination: String, harness: Harness) -> [String] {
        discoveredModels[ModelDiscoveryKey(destination: destination, harness: harness)] ?? []
    }

    func reset(force: Bool = false) { Task { await resetOperation(force: force) } }

    func resetOperation(force: Bool = false) async {
        busy = true
        let result: ProcessResult
        do { result = try await runHelper(["--config", paths.config.path, "reset", "--json"] + (force ? ["--force"] : []), timeout: 60) }
        catch { record(error, title: "Reset failed"); busy = false; return }
        guard result.status == 0 else { record(commandError(result), title: "Reset failed"); busy = false; return }
        if let lifecycle = try? JSONDecoder().decode(LifecycleResult.self, from: Data(result.stdout.utf8)), !lifecycle.conflicts.isEmpty {
            pendingForceReset = true
            pendingForceResetConflicts = lifecycle.conflicts
            recordFailure("Configuration changed after setup", "Open Manage → Advanced to review the reset conflicts.\n\n\(lifecycle.conflicts.joined(separator: "\n"))"); busy = false; return
        }
        pendingForceReset = false
        pendingForceResetConflicts = []
        await stopGateway()
        if launchAtLoginService.isEnabled() { try? launchAtLoginService.unregister() }
        UserDefaults.standard.removePersistentDomain(forName: Bundle.main.bundleIdentifier ?? "dev.subagentmodelrouter.menu")
        UserDefaults.standard.removePersistentDomain(forName: "dev.harnessmodelrouter.menu")
        launchAtLoginPreference.set(nil)
        launchAtLogin = false
        try? await refreshPayload()
        feedback = Feedback(title: "Router reset", detail: "Harness configuration and router data were restored.", failure: false)
        busy = false
    }

    func setLaunchAtLogin(_ value: Bool) {
        do { if value { try launchAtLoginService.register() } else { try launchAtLoginService.unregister() } }
        catch { record(error, title: "Could not update Launch at Login") }
        launchAtLogin = launchAtLoginService.isEnabled()
        if launchAtLogin == value { launchAtLoginPreference.set(value) }
    }

    func openLog() { NSWorkspace.shared.open(paths.log) }
    func openHelp() { NSWorkspace.shared.open(Self.usageGuideURL) }
    func revealConfig() { NSWorkspace.shared.activateFileViewerSelecting([paths.config]) }
    func dismissFeedback() { feedback = nil }

    func quit() {
        if configured && !UserDefaults.standard.bool(forKey: "skipQuitWarning") {
            let alert = NSAlert()
            alert.messageText = "Quit Subagent Model Router?"
            alert.informativeText = "Claude Code or Codex routing will be unavailable until the app restarts. Routing setup will remain installed."
            alert.addButton(withTitle: "Quit")
            alert.addButton(withTitle: "Cancel")
            alert.showsSuppressionButton = true
            alert.suppressionButton?.title = "Don’t ask again"
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            if alert.suppressionButton?.state == .on { UserDefaults.standard.set(true, forKey: "skipQuitWarning") }
        }
        monitorTask?.cancel(); watcher.stop()
        Task { await stopGateway(); NSApplication.shared.terminate(nil) }
    }

    func versionNeedsWarning(_ harness: Harness) -> Bool {
        guard let value = harness == .claude ? payload?.detection.claude.version : payload?.detection.codex.version else { return false }
        let numbers = value.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
        let minimum = harness == .claude ? [2, 1, 216] : [0, 145, 0]
        return numbers.lexicographicallyPrecedes(minimum)
    }

    private func refreshReadiness() async {
        let ready = await readinessInspector() != nil
        if ready { gatewayState = .running }
        else if helperProcess?.isRunning != true, gatewayState == .running { gatewayState = .failed("The helper is not running") }
        launchAtLogin = launchAtLoginService.isEnabled()
    }

    private func startWatching() {
        watcher.start(directory: paths.dataDirectory) { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.reloadTask?.cancel()
                self.reloadTask = Task {
                    try? await Task.sleep(for: .milliseconds(250))
                    guard !Task.isCancelled else { return }
                    do { try await self.refreshPayload() }
                    catch { self.record(error, title: "External configuration is invalid") }
                }
            }
        }
    }

    private func runHelper(_ arguments: [String], input: Data? = nil, timeout: TimeInterval = 30) async throws -> ProcessResult {
        let helper = paths.helper
        let helperRunner = helperRunner
        return try await Task.detached { try helperRunner(helper, arguments, input, timeout) }.value
    }

    private func commandError(_ result: ProcessResult) -> Error {
        if let payload = try? JSONDecoder().decode(CommandErrorPayload.self, from: Data(result.stdout.utf8)) {
            return NSError(domain: "SubagentModelRouter", code: Int(result.status), userInfo: [NSLocalizedDescriptionKey: payload.error])
        }
        let message = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        return NSError(domain: "SubagentModelRouter", code: Int(result.status), userInfo: [NSLocalizedDescriptionKey: message.isEmpty ? result.stdout : message])
    }

    private func record(_ error: Error, title: String, affectGateway: Bool = false) { recordFailure(title, error.localizedDescription, affectGateway: affectGateway) }
    private func recordFailure(_ title: String, _ detail: String, affectGateway: Bool = false) { if affectGateway { gatewayState = .failed(detail) }; feedback = Feedback(title: title, detail: detail, failure: true) }

    nonisolated private static func ensurePrivateDirectory(_ path: URL) throws {
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let values = try path.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true else { throw NSError(domain: "SubagentModelRouter", code: 2, userInfo: [NSLocalizedDescriptionKey: "Refusing unsafe data directory"]) }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: path.path)
    }

    nonisolated static func installBundledHelper(paths: AppPaths) throws {
        guard let bundled = Bundle.main.url(forResource: "subagent-model-router-helper", withExtension: nil) else { throw NSError(domain: "SubagentModelRouter", code: 3, userInfo: [NSLocalizedDescriptionKey: "Bundled helper is missing"]) }
        try ensurePrivateDirectory(paths.dataDirectory)
        let directory = paths.helper.deletingLastPathComponent()
        try ensurePrivateDirectory(directory)
        let temporary = directory.appending(path: ".helper.\(UUID().uuidString).tmp")
        try FileManager.default.copyItem(at: bundled, to: temporary)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: temporary.path)
        if rename(temporary.path, paths.helper.path) != 0 { try? FileManager.default.removeItem(at: temporary); throw posixError("Could not install helper") }
    }

    nonisolated private static func migrateLegacyDefaults() {
        let defaults = UserDefaults.standard
        guard defaults.object(forKey: "skipQuitWarning") == nil,
              let legacy = UserDefaults(suiteName: "dev.harnessmodelrouter.menu"),
              legacy.object(forKey: "skipQuitWarning") != nil else { return }
        defaults.set(legacy.bool(forKey: "skipQuitWarning"), forKey: "skipQuitWarning")
    }

    nonisolated private static func posixError(_ message: String) -> NSError { NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "\(message): \(String(cString: strerror(errno)))"]) }
}

private extension JSONEncoder {
    static var pretty: JSONEncoder { let value = JSONEncoder(); value.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]; return value }
}
