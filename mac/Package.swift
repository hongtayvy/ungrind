// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "Ungrind",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Ungrind", targets: ["Ungrind"]),
        .library(name: "UngrindKit", targets: ["UngrindKit"]),
    ],
    targets: [
        // Models and the bridge to the Node engine. No UI, so it is unit-testable.
        .target(name: "UngrindKit"),
        .executableTarget(name: "Ungrind", dependencies: ["UngrindKit"]),
        .testTarget(name: "UngrindKitTests", dependencies: ["UngrindKit"]),
    ]
)
