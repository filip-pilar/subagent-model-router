import Darwin
import Foundation

enum ProcessLifecycle {
    static func stop(_ process: Process, lifeline: Pipe?, graceful: Duration = .seconds(2)) async {
        try? lifeline?.fileHandleForWriting.close()
        if await wait(process, for: graceful) { return }
        if process.isRunning { process.terminate() }
        if await wait(process, for: .seconds(2)) { return }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        _ = await wait(process, for: .seconds(2))
    }

    private static func wait(_ process: Process, for duration: Duration) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: duration)
        while process.isRunning, clock.now < deadline { try? await Task.sleep(for: .milliseconds(25)) }
        return !process.isRunning
    }
}
