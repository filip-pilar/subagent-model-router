import AppKit
import Foundation
import Testing
@testable import SubagentModelRouterApp

private final class HelperStub: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var calls: [[String]] = []
    var response: @Sendable ([String]) -> ProcessResult

    init(response: @escaping @Sendable ([String]) -> ProcessResult) { self.response = response }

    func run(_ executable: URL, _ arguments: [String], _ input: Data?, _ timeout: TimeInterval) -> ProcessResult {
        lock.withLock { calls.append(arguments) }
        return response(arguments)
    }

    var callCount: Int { lock.withLock { calls.count } }
}

private final class LaunchAtLoginStub {
    var enabled: Bool
    private(set) var registerCalls = 0
    private(set) var unregisterCalls = 0

    init(enabled: Bool) { self.enabled = enabled }

    var service: LaunchAtLoginService {
        LaunchAtLoginService(
            isEnabled: { [weak self] in self?.enabled == true },
            register: { [weak self] in self?.registerCalls += 1; self?.enabled = true },
            unregister: { [weak self] in self?.unregisterCalls += 1; self?.enabled = false }
        )
    }
}

private final class LaunchAtLoginPreferenceStub {
    var value: Bool?

    init(value: Bool? = nil) { self.value = value }

    var preference: LaunchAtLoginPreference {
        LaunchAtLoginPreference(
            value: { [weak self] in self?.value },
            set: { [weak self] in self?.value = $0 }
        )
    }
}

@MainActor
@Test func controllerBootstrapsFromHelperState() async throws {
    let fixture = try makeFixture()
    let stub = HelperStub { _ in ProcessResult(status: 0, stdout: fixture.payload, stderr: "", timedOut: false) }
    let controller = makeController(fixture: fixture, stub: stub)

    await controller.bootstrap()

    #expect(controller.gatewayState == .stopped)
    #expect(controller.payload?.integration.claude == false)
    #expect(controller.payload?.config.gateway.port == 9476)
    #expect(stub.callCount == 1)
}

@Test func sharedAppStateContractDecodesInSwift() throws {
    let fixture = try repositoryRoot()
        .appending(path: "contracts/app-state-v2.json")
    let payload = try JSONDecoder().decode(AppStatePayload.self, from: Data(contentsOf: fixture))

    #expect(payload.config.version == 2)
    #expect(payload.config.routes.claude["Explore"]?.authorization?.header == "X-Api-Key")
    #expect(payload.config.routes.codex["explorer"]?.alias == "router-explorer")
    #expect(payload.config.routes.codex["explorer"]?.requiredMultiAgentVersion == nil)
    #expect(payload.config.mainRoutes.claude?.model == "claude-main-routed")
    #expect(payload.config.mainRoutes.codex?.enabled == false)
    #expect(payload.config.harnesses.codex.originalUpstream.credentialHeaders == ["Authorization", "X-Original-Auth"])
    #expect(payload.config.preserved.customCodexAgents.count == 1)
    #expect(payload.integration.claude)
    #expect(payload.detection.codex.appPath == "/Applications/Codex.app")
    #expect(payload.agents.map(\.id) == ["claude:Explore", "codex:explorer"])
    #expect(payload.agents[1].codexV2Eligible == true)
    #expect(payload.codexParentModel == "parent-model")
}

@MainActor
@Test func watcherRefreshDoesNotCreateAFeedbackLoop() async throws {
    let fixture = try makeFixture()
    let stub = HelperStub { _ in ProcessResult(status: 0, stdout: fixture.payload, stderr: "", timedOut: false) }
    let controller = makeController(fixture: fixture, stub: stub)
    await controller.bootstrap()

    try Data("external edit".utf8).write(to: fixture.paths.config, options: .atomic)
    try await Task.sleep(for: .seconds(1))
    let settledCount = stub.callCount
    try await Task.sleep(for: .milliseconds(600))

    #expect(settledCount >= 2)
    #expect(stub.callCount == settledCount)
    #expect(settledCount <= 4)
}

@MainActor
@Test func failedSetupAndLifecycleConflictsRemainVisible() async throws {
    let fixture = try makeFixture()
    let stub = HelperStub { arguments in
        if arguments.contains("setup") { return ProcessResult(status: 1, stdout: #"{"error":"catalog capture failed"}"#, stderr: "", timedOut: false) }
        if arguments.contains("remove") || arguments.contains("reset") {
            return ProcessResult(status: 0, stdout: #"{"changed":[],"conflicts":["owned configuration changed","custom agent changed"]}"#, stderr: "", timedOut: false)
        }
        return ProcessResult(status: 0, stdout: fixture.payload, stderr: "", timedOut: false)
    }
    let controller = makeController(fixture: fixture, stub: stub)
    await controller.bootstrap()

    await controller.setupOperation(.codex)
    #expect(controller.feedback == .init(title: "Could not set up Codex", detail: "catalog capture failed", failure: true))
    #expect(controller.payload?.integration.codex == false)

    await controller.removeOperation(.claude)
    #expect(controller.pendingForceHarness == .claude)
    #expect(controller.pendingForceHarnessConflicts == ["owned configuration changed", "custom agent changed"])
    await controller.resetOperation()
    #expect(controller.pendingForceReset)
    #expect(controller.pendingForceResetConflicts == ["owned configuration changed", "custom agent changed"])
    #expect(controller.feedback?.detail.contains("owned configuration changed") == true)
}

@MainActor
@Test func discoveredModelsStayScopedToDestinationAndProtocol() async throws {
    let fixture = try makeFixture()
    let stub = HelperStub { arguments in
        if arguments.contains("models") {
            let models = arguments.contains("claude") ? #"{"reachable":true,"models":["claude-child"]}"# : #"{"reachable":true,"models":["codex-child"]}"#
            return ProcessResult(status: 0, stdout: models, stderr: "", timedOut: false)
        }
        return ProcessResult(status: 0, stdout: fixture.payload, stderr: "", timedOut: false)
    }
    let controller = makeController(fixture: fixture, stub: stub)
    await controller.bootstrap()

    await controller.testModels(destination: "one", harness: .claude)
    await controller.testModels(destination: "two", harness: .codex)

    #expect(controller.models(destination: "one", harness: .claude) == ["claude-child"])
    #expect(controller.models(destination: "one", harness: .codex).isEmpty)
    #expect(controller.models(destination: "two", harness: .codex) == ["codex-child"])
    #expect(controller.models(destination: "two", harness: .claude).isEmpty)
}

@Test func destinationAndRouteEditingRulesCoverInvalidAndDanglingState() throws {
    let fixture = try makeFixture()
    let valid = Destination(name: "Local", openaiBaseUrl: "http://127.0.0.1:9000/v1", anthropicBaseUrl: nil)
    let partlyMalformed = Destination(name: "Local", openaiBaseUrl: "http://127.0.0.1:9000/v1", anthropicBaseUrl: "not a URL")
    #expect(DestinationValidation.canSave(id: "local", destination: valid))
    #expect(!DestinationValidation.canSave(id: "local", destination: partlyMalformed))

    var config = try #require(ConfigEditing.savingDestination(fixture.config, id: "local", destination: valid))
    let route = Route(enabled: true, alias: nil, model: "child", destination: "local", authorization: nil, requiredMultiAgentVersion: nil)
    config = ConfigEditing.savingRoute(config, harness: .claude, agent: "Explore", route: route, parentModels: [])
    #expect(config.routes.claude["Explore"] == route)
    config = try #require(ConfigEditing.savingMainRoute(config, harness: .claude, route: route))
    #expect(config.mainRoutes.claude == route)
    let replacement = Route(enabled: false, alias: nil, model: "replacement", destination: "local", authorization: nil, requiredMultiAgentVersion: nil)
    #expect(ConfigEditing.savingMainRoute(config, harness: .claude, route: replacement) == nil)
    config = try #require(ConfigEditing.savingMainRoute(config, harness: .claude, route: replacement, replacingExisting: true))
    #expect(config.mainRoutes.claude == replacement)
    config = ConfigEditing.deletingMainRoute(config, harness: .claude)
    #expect(config.mainRoutes.claude == nil)
    config = ConfigEditing.deletingDestination(config, id: "local")
    #expect(config.destinations["local"] == nil)
    #expect(config.routes.claude["Explore"]?.destination == "local")
    config = ConfigEditing.deletingRoute(config, harness: .claude, agent: "Explore")
    #expect(config.routes.claude["Explore"] == nil)
}

@Test func destinationIdentifiersDoNotOverwriteOrRetargetExistingState() throws {
    let fixture = try makeFixture()
    let first = Destination(name: "First", openaiBaseUrl: "http://127.0.0.1:9001/v1", anthropicBaseUrl: nil)
    let third = Destination(name: "Third", openaiBaseUrl: "http://127.0.0.1:9003/v1", anthropicBaseUrl: nil)
    let replacement = Destination(name: "Replacement", openaiBaseUrl: "http://127.0.0.1:9013/v1", anthropicBaseUrl: nil)
    var config = fixture.config
    config.destinations = ["destination-1": first, "destination-3": third]
    config.routes.claude["Explore"] = Route(enabled: true, alias: nil, model: "child", destination: "destination-2", authorization: nil, requiredMultiAgentVersion: nil)

    #expect(DestinationValidation.nextAvailableID(in: config) == "destination-4")
    #expect(!DestinationValidation.canSave(id: "destination-3", destination: replacement, existingIDs: Set(config.destinations.keys)))
    #expect(ConfigEditing.savingDestination(config, id: "destination-3", destination: replacement) == nil)

    let edited = try #require(ConfigEditing.savingDestination(config, id: "destination-3", destination: replacement, replacing: "destination-3"))
    #expect(edited.destinations["destination-3"] == replacement)
    #expect(edited.destinations["destination-1"] == first)

    let generatedID = DestinationValidation.nextAvailableID(in: config)
    let added = try #require(ConfigEditing.savingDestination(config, id: generatedID, destination: replacement))
    #expect(generatedID == "destination-4")
    #expect(added.destinations["destination-4"] == replacement)
    #expect(added.destinations["destination-3"] == third)
    #expect(added.routes.claude["Explore"]?.destination == "destination-2")
}

@Test func codexCompatibilityUsesV2OnlyForExplicitGlobalCustomAgents() {
    let agents = [
        AgentDescription(harness: "codex", name: "explorer", kind: "built-in", path: nil, explicitModel: nil, codexV2Eligible: nil),
        AgentDescription(harness: "codex", name: "reviewer", kind: "user", path: "/tmp/reviewer.toml", explicitModel: "gpt-custom", codexV2Eligible: true),
        AgentDescription(harness: "codex", name: "malformed", kind: "user", path: "/tmp/malformed.toml", explicitModel: "gpt-custom", codexV2Eligible: false),
        AgentDescription(harness: "codex", name: "dynamic", kind: "user", path: "/tmp/dynamic.toml", explicitModel: nil, codexV2Eligible: false),
    ]

    #expect(CodexCompatibility.supportsV2(agentType: "reviewer", agents: agents))
    #expect(!CodexCompatibility.supportsV2(agentType: "explorer", agents: agents))
    #expect(!CodexCompatibility.supportsV2(agentType: "malformed", agents: agents))
    #expect(!CodexCompatibility.supportsV2(agentType: "dynamic", agents: agents))
    #expect(!CodexCompatibility.supportsV2(agentType: "manual", agents: agents))

    let usable = Destination(name: "OpenAI", openaiBaseUrl: "https://provider.example/v1", anthropicBaseUrl: nil)
    let dangling = Route(enabled: true, alias: "router-explorer", model: "child", destination: "missing", authorization: nil, requiredMultiAgentVersion: "v1")
    #expect(!CodexCompatibility.requiresParentModels(agentType: "explorer", route: dangling, destinations: [:], agents: agents))
    #expect(CodexCompatibility.requiresParentModels(agentType: "explorer", route: dangling, destinations: ["missing": usable], agents: agents))
    #expect(!CodexCompatibility.requiresParentModels(agentType: "reviewer", route: dangling, destinations: ["missing": usable], agents: agents))
}

@MainActor
@Test func launchAtLoginEnablesOnceAndExplicitDisableSurvivesBootstrapAndSetup() async throws {
    let fixture = try makeFixture()
    var configured = try JSONDecoder().decode(AppStatePayload.self, from: Data(fixture.payload.utf8))
    configured.integration.claude = true
    let configuredPayload = String(decoding: try JSONEncoder().encode(configured), as: UTF8.self)
    let stub = HelperStub { arguments in
        if arguments.contains("setup") { return ProcessResult(status: 0, stdout: "{}", stderr: "", timedOut: false) }
        return ProcessResult(status: 0, stdout: configuredPayload, stderr: "", timedOut: false)
    }
    try FileManager.default.createDirectory(at: fixture.paths.helper.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("#!/bin/sh\nwhile IFS= read -r line; do :; done\n".utf8).write(to: fixture.paths.helper)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: fixture.paths.helper.path)
    let login = LaunchAtLoginStub(enabled: false)
    let preference = LaunchAtLoginPreferenceStub()
    let controller = makeController(
        fixture: fixture,
        stub: stub,
        readinessInspector: { RouterReadiness.Snapshot(ready: true, service: "subagent-model-router", version: "test") },
        launchAtLoginService: login.service,
        launchAtLoginPreference: preference.preference
    )

    await controller.setupOperation(.claude)
    #expect(login.registerCalls == 1)
    #expect(controller.launchAtLogin)

    controller.setLaunchAtLogin(false)
    #expect(login.unregisterCalls == 1)
    #expect(!controller.launchAtLogin)
    #expect(preference.value == false)

    await controller.bootstrap()
    await controller.setupOperation(.codex)
    #expect(login.registerCalls == 1)
    #expect(!controller.launchAtLogin)

    controller.stopGatewayAction()
    try await Task.sleep(for: .milliseconds(250))

    let reconfigured = makeController(
        fixture: fixture,
        stub: stub,
        readinessInspector: { RouterReadiness.Snapshot(ready: true, service: "subagent-model-router", version: "test") },
        launchAtLoginService: login.service,
        launchAtLoginPreference: preference.preference
    )
    await reconfigured.setupOperation(.claude)
    #expect(login.registerCalls == 1)
    #expect(!reconfigured.launchAtLogin)
    reconfigured.stopGatewayAction()
    try await Task.sleep(for: .milliseconds(250))
}

@Test func menuSymbolsExistOnTheDeploymentTarget() {
    #expect(NSImage(systemSymbolName: "arrow.triangle.branch", accessibilityDescription: nil) != nil)
    #expect(NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: nil) != nil)
}

@MainActor
@Test func usageGuidePointsAtTheRepositoryDocumentation() {
    #expect(RouterController.usageGuideURL.absoluteString.hasSuffix("/docs/USING_THE_APP.md"))
}

private struct Fixture: @unchecked Sendable {
    let root: URL
    let paths: AppPaths
    let config: RouterConfig
    let payload: String
}

private func repositoryRoot() throws -> URL {
    var directory = URL(filePath: #filePath).deletingLastPathComponent()
    for _ in 0..<8 {
        let candidate = directory.appending(path: "contracts/app-state-v2.json")
        if FileManager.default.fileExists(atPath: candidate.path) { return directory }
        directory.deleteLastPathComponent()
    }
    throw CocoaError(.fileNoSuchFile)
}

private func makeFixture() throws -> Fixture {
    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    let data = root.appending(path: ".local/share/subagent-model-router", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
    let paths = AppPaths(dataDirectory: data, config: data.appending(path: "config.json"), helper: data.appending(path: "bin/helper"), log: data.appending(path: "menu-app.log"))
    let config = RouterConfig(
        version: 2,
        gateway: GatewayConfig(enabled: true, host: "127.0.0.1", port: 9476, maxBodyBytes: 16 * 1024 * 1024),
        destinations: [:],
        harnesses: HarnessConfigs(
            claude: ClaudeConfig(enabled: false, originalUpstream: Upstream(baseUrl: "https://api.anthropic.com", protocol: "anthropic-messages", authorization: nil), mappingTtlMs: 1_800_000, settingsPath: nil),
            codex: CodexConfig(enabled: false, originalUpstream: Upstream(baseUrl: "https://api.openai.com/v1", protocol: "openai-responses", authorization: nil), hookTimeoutMs: 1_500, configPath: nil, hooksPath: nil, sourceCatalogPath: nil, overlayCatalogPath: data.appending(path: "codex-model-catalog.json").path, parentModels: [])
        ),
        routes: RouteMaps(claude: [:], codex: [:]),
        mainRoutes: MainRouteMap(claude: nil, codex: nil),
        preserved: PreservedState(customCodexAgents: [:])
    )
    let payload = AppStatePayload(
        config: config,
        integration: IntegrationState(claude: false, codex: false),
        detection: DetectionState(
            claude: HarnessDetection(detected: false, version: nil, cliPath: nil, appPath: nil),
            codex: HarnessDetection(detected: false, version: nil, cliPath: nil, appPath: nil)
        ),
        agents: [],
        codexParentModel: nil
    )
    let encoded = try JSONEncoder().encode(payload)
    return Fixture(root: root, paths: paths, config: config, payload: String(decoding: encoded, as: UTF8.self))
}

@MainActor
private func makeController(
    fixture: Fixture,
    stub: HelperStub,
    readinessInspector: @escaping @Sendable () async -> RouterReadiness.Snapshot? = { nil },
    launchAtLoginService: LaunchAtLoginService = .system,
    launchAtLoginPreference: LaunchAtLoginPreference = .system
) -> RouterController {
    RouterController(
        paths: fixture.paths,
        autoBootstrap: false,
        installHelper: { paths in try FileManager.default.createDirectory(at: paths.dataDirectory, withIntermediateDirectories: true) },
        helperRunner: { executable, arguments, input, timeout in stub.run(executable, arguments, input, timeout) },
        readinessInspector: readinessInspector,
        launchAtLoginService: launchAtLoginService,
        launchAtLoginPreference: launchAtLoginPreference
    )
}
