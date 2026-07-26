import SwiftUI

struct ManagementView: View {
    @ObservedObject var controller: RouterController

    var body: some View {
        TabView {
            RoutesView(controller: controller).tabItem { Label("Routes", systemImage: "arrow.triangle.swap") }
            DestinationsView(controller: controller).tabItem { Label("Destinations", systemImage: "network") }
            AdvancedView(controller: controller).tabItem { Label("Advanced", systemImage: "gearshape") }
        }
        .padding(12)
    }
}

private struct DestinationsView: View {
    @ObservedObject var controller: RouterController
    @State private var selection: String?
    @State private var draftID = ""
    @State private var draft = Destination(name: "", openaiBaseUrl: nil, anthropicBaseUrl: nil)

    private var items: [DestinationItem] { (controller.payload?.config.destinations ?? [:]).map { .init(id: $0.key, value: $0.value) }.sorted { $0.value.name < $1.value.name } }

    var body: some View {
        HSplitView {
            VStack(spacing: 8) {
                if items.isEmpty { ContentUnavailableView("No Destinations", systemImage: "network.slash", description: Text("Add a Responses or Messages-compatible service.")) }
                else { List(items, selection: $selection) { item in HStack { VStack(alignment: .leading) { Text(item.value.name); Text(protocols(item.value)).font(.caption).foregroundStyle(.secondary) }; Spacer(); reachabilityIcon(item.id) }.tag(item.id) } }
                Button("Add Destination", systemImage: "plus") { newDestination() }.padding(.bottom, 4)
            }.frame(minWidth: 220)
            Form {
                TextField("Name", text: $draft.name)
                TextField("Identifier", text: $draftID).disabled(selection != nil)
                TextField("OpenAI Responses URL", text: optional($draft.openaiBaseUrl))
                TextField("Anthropic Messages URL", text: optional($draft.anthropicBaseUrl))
                Text("Destinations may be saved while offline. Connection tests also load advertised models when available.").font(.caption).foregroundStyle(.secondary)
                if let selection { LabeledContent("Status") { Text((controller.destinationReachability[selection] ?? .unknown).label).foregroundStyle(reachabilityColor(selection)) } }
                if selection != nil {
                    HStack {
                        if draft.openaiBaseUrl != nil { Button("Test OpenAI") { Task { await controller.testModels(destination: draftID, harness: .codex) } } }
                        if draft.anthropicBaseUrl != nil { Button("Test Anthropic") { Task { await controller.testModels(destination: draftID, harness: .claude) } } }
                    }
                }
                HStack {
                    Button("Save") { save() }.buttonStyle(.borderedProminent).disabled(!valid)
                    if selection != nil { Button("Delete", role: .destructive) { delete() } }
                }
            }.formStyle(.grouped).frame(minWidth: 460)
        }
        .onChange(of: selection) { _, value in load(value) }
        .task { if selection == nil, let first = items.first?.id { selection = first; load(first) } }
    }

    private var valid: Bool { DestinationValidation.canSave(id: draftID, destination: draft) }
    private func protocols(_ value: Destination) -> String { [value.openaiBaseUrl == nil ? nil : "OpenAI", value.anthropicBaseUrl == nil ? nil : "Anthropic"].compactMap { $0 }.joined(separator: " · ") }
    private func optional(_ binding: Binding<String?>) -> Binding<String> { Binding(get: { binding.wrappedValue ?? "" }, set: { binding.wrappedValue = $0.isEmpty ? nil : $0 }) }
    private func newDestination() { selection = nil; draftID = "destination-\(items.count + 1)"; draft = Destination(name: "", openaiBaseUrl: nil, anthropicBaseUrl: nil) }
    private func load(_ id: String?) { guard let id, let value = controller.payload?.config.destinations[id] else { return }; draftID = id; draft = value }
    private func save() { guard let config = controller.payload?.config else { return }; let edited = ConfigEditing.savingDestination(config, id: draftID, destination: draft); Task { try? await controller.saveConfig(edited); selection = draftID } }
    private func delete() { guard let id = selection, let config = controller.payload?.config else { return }; let edited = ConfigEditing.deletingDestination(config, id: id); Task { try? await controller.saveConfig(edited); selection = nil; newDestination() } }
    @ViewBuilder private func reachabilityIcon(_ id: String) -> some View {
        switch controller.destinationReachability[id] ?? .unknown {
        case .unknown: EmptyView()
        case .checking: ProgressView().controlSize(.small)
        case .reachable: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .unreachable: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        }
    }
    private func reachabilityColor(_ id: String) -> Color {
        switch controller.destinationReachability[id] ?? .unknown { case .reachable: .green; case .unreachable: .orange; default: .secondary }
    }
}

private struct RoutesView: View {
    @ObservedObject var controller: RouterController
    @State private var selection: String?
    @State private var harness: Harness = .claude
    @State private var agent = ""
    @State private var route = Route(enabled: true, alias: nil, model: "", destination: "", authorization: nil, requiredMultiAgentVersion: nil)
    @State private var parentModels = ""
    @State private var advanced = false

    private var items: [RouteItem] {
        guard let config = controller.payload?.config else { return [] }
        return (config.routes.claude.map { RouteItem(harness: .claude, agent: $0.key, route: $0.value) } + config.routes.codex.map { RouteItem(harness: .codex, agent: $0.key, route: $0.value) }).sorted { $0.agent < $1.agent }
    }
    private var compatibleDestinations: [DestinationItem] {
        (controller.payload?.config.destinations ?? [:]).compactMap { id, value in
            guard harness == .claude ? value.anthropicBaseUrl != nil : value.openaiBaseUrl != nil else { return nil }
            return DestinationItem(id: id, value: value)
        }.sorted { $0.value.name < $1.value.name }
    }
    private var advertisedModels: [String] { controller.models(destination: route.destination, harness: harness) }

    var body: some View {
        HSplitView {
            VStack(spacing: 8) {
                if items.isEmpty { ContentUnavailableView("No Routes", systemImage: "arrow.triangle.swap", description: Text("Add a destination, then route a global agent.")) }
                else { List(items, selection: $selection) { item in HStack { VStack(alignment: .leading) { Text(item.agent); Text(item.harness.title).font(.caption).foregroundStyle(.secondary) }; Spacer(); if controller.payload?.config.destinations[item.route.destination] == nil { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange) } else if item.route.enabled { Circle().fill(.green).frame(width: 7, height: 7) } }.tag(item.id) } }
                Button("Add Route", systemImage: "plus") { newRoute() }.padding(.bottom, 4)
            }.frame(minWidth: 230)
            Form {
                Picker("Harness", selection: $harness) { ForEach(Harness.allCases) { Text($0.title).tag($0) } }.disabled(selection != nil)
                TextField("Agent type", text: $agent).disabled(selection != nil)
                if let agents = controller.payload?.agents.filter({ $0.harness == harness.rawValue }), !agents.isEmpty {
                    Picker("Detected agents", selection: $agent) { Text("Manual entry").tag(""); ForEach(agents) { Text("\($0.name) · \($0.kind)").tag($0.name) } }
                }
                Picker("Destination", selection: $route.destination) { Text("Select…").tag(""); ForEach(compatibleDestinations) { Text($0.value.name).tag($0.id) } }
                TextField("Model", text: $route.model)
                if !advertisedModels.isEmpty { Picker("Advertised models", selection: $route.model) { ForEach(advertisedModels, id: \.self) { Text($0).tag($0) } } }
                Toggle("Enabled", isOn: $route.enabled)
                HStack { Button("Test Connection / Models") { Task { await controller.testModels(destination: route.destination, harness: harness) } }.disabled(route.destination.isEmpty); Spacer() }
                DisclosureGroup("Advanced", isExpanded: $advanced) {
                    if harness == .codex {
                        TextField("Codex alias", text: optional($route.alias))
                        Toggle("Require V1 multi-agent compatibility", isOn: Binding(get: { route.requiredMultiAgentVersion == "v1" }, set: { route.requiredMultiAgentVersion = $0 ? "v1" : nil; if $0 && parentModels.isEmpty { parentModels = configuredParentModel() } }))
                        TextField("Parent models (comma-separated)", text: $parentModels)
                    }
                    TextField("Authorization environment variable", text: auth(\.env))
                    TextField("Authorization header", text: authOptional(\.header))
                    TextField("Authorization scheme", text: authOptional(\.scheme))
                }
                HStack { Button("Save") { save() }.buttonStyle(.borderedProminent).disabled(!valid); if selection != nil { Button("Delete", role: .destructive) { delete() } } }
            }.formStyle(.grouped).frame(minWidth: 470)
        }
        .onChange(of: selection) { _, value in load(value) }
        .onChange(of: harness) { _, _ in if !compatibleDestinations.contains(where: { $0.id == route.destination }) { route.destination = "" } }
        .task { if selection == nil, let first = items.first?.id { selection = first; load(first) } }
    }

    private var valid: Bool { !agent.trimmingCharacters(in: .whitespaces).isEmpty && !route.destination.isEmpty && !route.model.isEmpty && (route.requiredMultiAgentVersion != "v1" || !parentModels.split(separator: ",").isEmpty) }
    private func newRoute() { selection = nil; harness = .claude; agent = ""; route = Route(enabled: true, alias: nil, model: "", destination: "", authorization: nil, requiredMultiAgentVersion: nil); parentModels = controller.payload?.config.harnesses.codex.parentModels.joined(separator: ", ") ?? "" }
    private func load(_ id: String?) { guard let id, let item = items.first(where: { $0.id == id }) else { return }; harness = item.harness; agent = item.agent; route = item.route; parentModels = controller.payload?.config.harnesses.codex.parentModels.joined(separator: ", ") ?? "" }
    private func save() {
        guard let config = controller.payload?.config else { return }
        if harness == .codex {
            if route.alias?.isEmpty != false { route.alias = "router-" + agent.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: "-")) }
        }
        let parents = parentModels.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let edited = ConfigEditing.savingRoute(config, harness: harness, agent: agent, route: route, parentModels: parents)
        Task { do { try await controller.saveConfig(edited); selection = "\(harness.rawValue):\(agent)" } catch {} }
    }
    private func delete() { guard let config = controller.payload?.config else { return }; let edited = ConfigEditing.deletingRoute(config, harness: harness, agent: agent); Task { try? await controller.saveConfig(edited); selection = nil; newRoute() } }
    private func configuredParentModel() -> String {
        let configured = controller.payload?.config.harnesses.codex.parentModels ?? []
        return configured.isEmpty ? controller.payload?.codexParentModel ?? "" : configured.joined(separator: ", ")
    }
    private func optional(_ binding: Binding<String?>) -> Binding<String> { Binding(get: { binding.wrappedValue ?? "" }, set: { binding.wrappedValue = $0.isEmpty ? nil : $0 }) }
    private func auth(_ path: WritableKeyPath<AuthorizationReference, String>) -> Binding<String> { Binding(get: { route.authorization?[keyPath: path] ?? "" }, set: { if route.authorization == nil { route.authorization = AuthorizationReference() }; route.authorization?[keyPath: path] = $0; if route.authorization?.env.isEmpty == true { route.authorization = nil } }) }
    private func authOptional(_ path: WritableKeyPath<AuthorizationReference, String?>) -> Binding<String> { Binding(get: { route.authorization?[keyPath: path] ?? "" }, set: { if route.authorization == nil { route.authorization = AuthorizationReference() }; route.authorization?[keyPath: path] = $0.isEmpty ? nil : $0 }) }
}

private struct AdvancedView: View {
    @ObservedObject var controller: RouterController
    @State private var confirmForceReset = false
    var body: some View {
        Form {
            LabeledContent("Configuration") { Text(controller.paths.config.path).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
            LabeledContent("Gateway") { Text("127.0.0.1:9476") }
            Button("Reveal Config in Finder", action: controller.revealConfig)
            Text("Valid external edits reload automatically. Invalid edits are reported and left untouched.").font(.caption).foregroundStyle(.secondary)
            if controller.pendingForceReset { Button("Review Force Reset…", role: .destructive) { confirmForceReset = true } }
        }.formStyle(.grouped)
        .alert("Force Reset Everything?", isPresented: $confirmForceReset) {
            Button("Force Reset", role: .destructive) { controller.reset(force: true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("These later edits conflict with restoration and may be overwritten:\n\n\(controller.pendingForceResetConflicts.joined(separator: "\n"))")
        }
    }
}
