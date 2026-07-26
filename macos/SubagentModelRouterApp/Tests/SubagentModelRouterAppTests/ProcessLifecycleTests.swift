import Darwin
import Foundation
import Testing
@testable import SubagentModelRouterApp

@Test func helperStopsWhenLifelineCloses() async throws {
    let process = Process(), lifeline = Pipe()
    process.executableURL = URL(filePath: "/bin/sh")
    process.arguments = ["-c", "read value || exit 0"]
    process.standardInput = lifeline
    try process.run()
    await ProcessLifecycle.stop(process, lifeline: lifeline, graceful: .seconds(1))
    #expect(!process.isRunning)
    #expect(process.terminationStatus == 0)
}

@Test func processRunnerCapturesInputAndOutput() throws {
    let result = try ProcessRunner.run(executable: URL(filePath: "/bin/sh"), arguments: ["-c", "read value; printf '%s' \"$value\""], input: Data("hello\n".utf8))
    #expect(result.status == 0)
    #expect(result.stdout == "hello")
}

@Test func readinessPayloadRequiresExpectedIdentityFields() throws {
    let data = Data(#"{"ready":true,"service":"subagent-model-router","version":"0.1.0"}"#.utf8)
    let value = try JSONDecoder().decode(RouterReadiness.Snapshot.self, from: data)
    #expect(value.ready)
    #expect(value.service == "subagent-model-router")
}

@Test func configurationWatcherObservesAtomicDirectoryChanges() throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let changed = DispatchSemaphore(value: 0)
    let watcher = ConfigWatcher()
    watcher.start(directory: directory) { changed.signal() }
    try Data("{}".utf8).write(to: directory.appending(path: "config.json"), options: .atomic)
    #expect(changed.wait(timeout: .now() + 2) == .success)
    watcher.stop()
}
