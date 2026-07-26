// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "SubagentModelRouterApp",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "SubagentModelRouterApp", targets: ["SubagentModelRouterApp"])],
    targets: [
        .executableTarget(name: "SubagentModelRouterApp"),
        .testTarget(name: "SubagentModelRouterAppTests", dependencies: ["SubagentModelRouterApp"]),
    ],
    swiftLanguageModes: [.v5]
)
