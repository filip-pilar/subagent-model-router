import Foundation

struct AuthorizationReference: Codable, Equatable, Hashable {
    var env = ""
    var header: String?
    var scheme: String?
}

struct Upstream: Codable, Equatable {
    var baseUrl: String
    var `protocol`: String
    var authorization: AuthorizationReference?
}

struct Destination: Codable, Equatable, Hashable {
    var name: String
    var openaiBaseUrl: String?
    var anthropicBaseUrl: String?
}

struct Route: Codable, Equatable, Hashable {
    var enabled: Bool
    var alias: String?
    var model: String
    var destination: String
    var authorization: AuthorizationReference?
    var requiredMultiAgentVersion: String?
}

struct GatewayConfig: Codable, Equatable {
    var enabled: Bool
    var host: String
    var port: Int
    var maxBodyBytes: Int
}

struct ClaudeConfig: Codable, Equatable {
    var enabled: Bool
    var originalUpstream: Upstream
    var mappingTtlMs: Int
    var settingsPath: String?
}

struct CodexConfig: Codable, Equatable {
    var enabled: Bool
    var originalUpstream: Upstream
    var hookTimeoutMs: Int
    var configPath: String?
    var hooksPath: String?
    var sourceCatalogPath: String?
    var overlayCatalogPath: String?
    var parentModels: [String]
}

struct HarnessConfigs: Codable, Equatable { var claude: ClaudeConfig; var codex: CodexConfig }
struct RouteMaps: Codable, Equatable { var claude: [String: Route]; var codex: [String: Route] }

struct PreservedAgent: Codable, Equatable {
    var agentType: String
    var path: String
    var alias: String
    var originalModel: String
    var originalModelLine: String
    var installedModelLine: String
    var modelOffset: Int
    var originalContentHash: String
    var installedContentHash: String
}

struct PreservedState: Codable, Equatable { var customCodexAgents: [String: PreservedAgent] }

struct RouterConfig: Codable, Equatable {
    var version: Int
    var gateway: GatewayConfig
    var destinations: [String: Destination]
    var harnesses: HarnessConfigs
    var routes: RouteMaps
    var preserved: PreservedState
}

struct IntegrationState: Codable { var claude: Bool; var codex: Bool }

struct HarnessDetection: Codable {
    var detected: Bool
    var version: String?
    var cliPath: String?
    var appPath: String?
}

struct DetectionState: Codable { var claude: HarnessDetection; var codex: HarnessDetection }

struct AgentDescription: Codable, Identifiable, Hashable {
    var harness: String
    var name: String
    var kind: String
    var path: String?
    var explicitModel: String?
    var id: String { "\(harness):\(name)" }
}

struct AppStatePayload: Codable {
    var config: RouterConfig
    var integration: IntegrationState
    var detection: DetectionState
    var agents: [AgentDescription]
    var codexParentModel: String?
}

struct LifecycleResult: Codable { var changed: [String]; var conflicts: [String] }
struct ModelsResult: Codable { var reachable: Bool; var models: [String] }
struct CommandErrorPayload: Codable { var error: String }

enum DestinationReachability: Equatable {
    case unknown
    case checking
    case reachable(modelCount: Int)
    case unreachable(String)

    var label: String {
        switch self {
        case .unknown: "Not tested"
        case .checking: "Checking…"
        case .reachable(let count): count == 0 ? "Reachable" : "Reachable · \(count) models"
        case .unreachable: "Currently unreachable"
        }
    }
}

enum DestinationValidation {
    static func isValidURL(_ value: String?) -> Bool {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        guard let components = URLComponents(string: value),
              components.scheme == "http" || components.scheme == "https",
              components.host?.isEmpty == false else { return false }
        return true
    }

    static func canSave(id: String, destination: Destination) -> Bool {
        guard !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !destination.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        let entered = [destination.openaiBaseUrl, destination.anthropicBaseUrl].compactMap { value -> String? in
            guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return value
        }
        return !entered.isEmpty && entered.allSatisfy { isValidURL($0) }
    }
}

enum ConfigEditing {
    static func savingDestination(_ config: RouterConfig, id: String, destination: Destination) -> RouterConfig {
        var result = config
        result.destinations[id] = destination
        return result
    }

    static func deletingDestination(_ config: RouterConfig, id: String) -> RouterConfig {
        var result = config
        result.destinations.removeValue(forKey: id)
        return result
    }

    static func savingRoute(_ config: RouterConfig, harness: Harness, agent: String, route: Route, parentModels: [String]) -> RouterConfig {
        var result = config
        if harness == .claude { result.routes.claude[agent] = route }
        else {
            result.routes.codex[agent] = route
            result.harnesses.codex.parentModels = parentModels
        }
        return result
    }

    static func deletingRoute(_ config: RouterConfig, harness: Harness, agent: String) -> RouterConfig {
        var result = config
        if harness == .claude { result.routes.claude.removeValue(forKey: agent) }
        else { result.routes.codex.removeValue(forKey: agent) }
        return result
    }
}

enum Harness: String, CaseIterable, Identifiable, Codable {
    case claude, codex
    var id: String { rawValue }
    var title: String { self == .claude ? "Claude Code" : "Codex" }
}

struct DestinationItem: Identifiable, Hashable { var id: String; var value: Destination }
struct RouteItem: Identifiable, Hashable {
    var harness: Harness
    var agent: String
    var route: Route
    var id: String { "\(harness.rawValue):\(agent)" }
}
