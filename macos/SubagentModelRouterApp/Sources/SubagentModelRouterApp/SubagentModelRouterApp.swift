import SwiftUI

@main
struct SubagentModelRouterMenuApp: App {
    @StateObject private var controller = RouterController()

    var body: some Scene {
        MenuBarExtra("Subagent Model Router", systemImage: "arrow.triangle.branch") {
            RouterMenu(controller: controller)
        }
        .menuBarExtraStyle(.window)

        Window("Subagent Model Router", id: "routes") {
            ManagementView(controller: controller)
        }
        .defaultSize(width: 780, height: 540)
        .windowResizability(.contentMinSize)
    }
}

private struct RouterMenu: View {
    private enum PresentedAlert: Identifiable {
        case unverified(Harness)
        case forceRemove(Harness)

        var id: String {
            switch self {
            case .unverified(let harness): "unverified-\(harness.rawValue)"
            case .forceRemove(let harness): "force-remove-\(harness.rawValue)"
            }
        }
    }

    @ObservedObject var controller: RouterController
    @Environment(\.openWindow) private var openWindow
    @State private var confirmReset = false
    @State private var presentedAlert: PresentedAlert?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 9) {
                Image(systemName: controller.isRunning ? "arrow.triangle.branch" : "exclamationmark.triangle")
                    .foregroundStyle(controller.isRunning ? .green : .secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Subagent Model Router").font(.headline)
                    Text(statusText).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(14)
            Divider()

            VStack(spacing: 0) {
                row("Router", icon: "point.3.connected.trianglepath.dotted") {
                    status(controller.isRunning ? "Running" : "Stopped", active: controller.isRunning)
                    Button(controller.isRunning ? "Stop" : "Start") {
                        controller.isRunning ? controller.stopGatewayAction() : controller.startGatewayAction()
                    }.disabled(controller.busy || (!controller.configured && !controller.isRunning))
                }
                Divider().padding(.leading, 32)
                harnessRow(.claude)
                Divider().padding(.leading, 32)
                harnessRow(.codex)
                Divider().padding(.leading, 32)
                row("Routes", icon: "arrow.triangle.swap") {
                    Text("\(controller.enabledRoutes) enabled").font(.caption).foregroundStyle(.secondary)
                    Button("Manage…") { openWindow(id: "routes"); NSApp.activate(ignoringOtherApps: true) }
                }
                Divider().padding(.leading, 32)
                row("Launch at Login", icon: "power") {
                    Toggle("Launch at Login", isOn: Binding(get: { controller.launchAtLogin }, set: controller.setLaunchAtLogin))
                        .labelsHidden().toggleStyle(.switch).controlSize(.small)
                }
            }.padding(.horizontal, 14)

            if let feedback = controller.feedback {
                Divider()
                VStack(alignment: .leading, spacing: 4) {
                    HStack { Image(systemName: feedback.failure ? "exclamationmark.triangle.fill" : "checkmark.circle.fill").foregroundStyle(feedback.failure ? .orange : .green); Text(feedback.title).font(.caption).fontWeight(.semibold); Spacer(); Button("Dismiss") { controller.dismissFeedback() }.buttonStyle(.plain).font(.caption2) }
                    Text(feedback.detail).font(.caption2).foregroundStyle(.secondary).lineLimit(4)
                }.padding(12)
            }

            Divider()
            HStack {
                Button("Log", systemImage: "doc.text", action: controller.openLog)
                Button("Help", systemImage: "questionmark.circle", action: controller.openHelp)
                Button("Reset…", role: .destructive) { confirmReset = true }
                Spacer()
                Button("Quit", action: controller.quit)
            }.buttonStyle(.bordered).controlSize(.small).padding(12)
        }
        .frame(width: 410)
        .background(.regularMaterial)
        .confirmationDialog("Reset Subagent Model Router?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Reset Everything", role: .destructive) { controller.reset() }
            Button("Cancel", role: .cancel) {}
        } message: { Text("This restores router-owned Claude and Codex changes and deletes all destinations and routes.") }
        .alert(item: $presentedAlert) { item in
            switch item {
            case .unverified(let harness):
                Alert(
                    title: Text("Unverified harness version"),
                    message: Text("This harness is older than the version verified with the router. You can continue, but its configuration format may differ."),
                    primaryButton: .default(Text("Set Up Anyway")) { controller.setup(harness) },
                    secondaryButton: .cancel()
                )
            case .forceRemove(let harness):
                Alert(
                    title: Text("Force Remove Routing Setup?"),
                    message: Text("These later edits conflict with restoration and may be overwritten:\n\n\(controller.pendingForceHarnessConflicts.joined(separator: "\n"))"),
                    primaryButton: .destructive(Text("Force Remove")) { controller.remove(harness, force: true) },
                    secondaryButton: .cancel()
                )
            }
        }
    }

    private func harnessRow(_ harness: Harness) -> some View {
        let detection = harness == .claude ? controller.payload?.detection.claude : controller.payload?.detection.codex
        let configured = harness == .claude ? controller.payload?.integration.claude == true : controller.payload?.integration.codex == true
        return row(harness.title, icon: harness == .claude ? "brain" : "terminal") {
            VStack(alignment: .trailing, spacing: 1) {
                status(configured ? "Routing set up" : detection?.detected == true ? "Detected" : "Missing", active: configured)
                if let version = detection?.version { Text(version).font(.caption2).foregroundStyle(.tertiary).lineLimit(1) }
            }
            if configured {
                if controller.pendingForceHarness == harness { Button("Review…", role: .destructive) { presentedAlert = .forceRemove(harness) } }
                else { Button("Remove") { controller.remove(harness) } }
            } else if detection?.detected == true {
                Button("Set Up Routing") {
                    if controller.versionNeedsWarning(harness) { presentedAlert = .unverified(harness) } else { controller.setup(harness) }
                }
            }
        }
    }

    private func row<Content: View>(_ title: String, icon: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 9) { Image(systemName: icon).frame(width: 18).foregroundStyle(.secondary); Text(title); Spacer(); content() }.frame(minHeight: 44)
    }
    private func status(_ text: String, active: Bool) -> some View { Text(text).font(.caption).foregroundStyle(active ? .green : .secondary) }
    private var statusText: String {
        switch controller.gatewayState { case .checking: "Checking setup"; case .starting: "Starting gateway"; case .running: "Gateway ready on 127.0.0.1:9476"; case .stopped: "Gateway stopped"; case .failed: "Needs attention" }
    }
}
