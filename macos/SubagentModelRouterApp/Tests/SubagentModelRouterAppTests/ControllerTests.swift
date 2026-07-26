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

    var config = ConfigEditing.savingDestination(fixture.config, id: "local", destination: valid)
    let route = Route(enabled: true, alias: nil, model: "child", destination: "local", authorization: nil, requiredMultiAgentVersion: nil)
    config = ConfigEditing.savingRoute(config, harness: .claude, agent: "Explore", route: route, parentModels: [])
    #expect(config.routes.claude["Explore"] == route)
    config = ConfigEditing.deletingDestination(config, id: "local")
    #expect(config.destinations["local"] == nil)
    #expect(config.routes.claude["Explore"]?.destination == "local")
    config = ConfigEditing.deletingRoute(config, harness: .claude, agent: "Explore")
    #expect(config.routes.claude["Explore"] == nil)
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
private func makeController(fixture: Fixture, stub: HelperStub) -> RouterController {
    RouterController(
        paths: fixture.paths,
        autoBootstrap: false,
        installHelper: { paths in try FileManager.default.createDirectory(at: paths.dataDirectory, withIntermediateDirectories: true) },
        helperRunner: { executable, arguments, input, timeout in stub.run(executable, arguments, input, timeout) },
        readinessInspector: { nil }
    )
}
