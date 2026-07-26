import Foundation

struct AppPaths: Sendable {
    let dataDirectory: URL
    let config: URL
    let helper: URL
    let log: URL

    static let current: AppPaths = {
        let environment = ProcessInfo.processInfo.environment
        let home = (environment["SMR_HOME"] ?? environment["HMR_HOME"]).map { URL(filePath: $0, directoryHint: .isDirectory) }
            ?? FileManager.default.homeDirectoryForCurrentUser
        let root = home
            .appending(path: ".local/share/subagent-model-router", directoryHint: .isDirectory)
        return AppPaths(
            dataDirectory: root,
            config: root.appending(path: "config.json"),
            helper: root.appending(path: "bin/subagent-model-router-helper"),
            log: root.appending(path: "menu-app.log")
        )
    }()
}
