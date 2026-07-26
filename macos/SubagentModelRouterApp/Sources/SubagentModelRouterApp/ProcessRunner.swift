import Darwin
import Foundation

struct ProcessResult: Sendable {
    let status: Int32
    let stdout: String
    let stderr: String
    let timedOut: Bool
}

private final class PipeCapture: @unchecked Sendable {
    private let handle: FileHandle
    private let finished = DispatchSemaphore(value: 0)
    private var data = Data()
    init(_ pipe: Pipe) { handle = pipe.fileHandleForReading }
    func start() {
        DispatchQueue.global(qos: .utility).async { [self] in
            defer { finished.signal() }
            while let chunk = try? handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
                if data.count < 4 * 1024 * 1024 { data.append(chunk.prefix(4 * 1024 * 1024 - data.count)) }
            }
        }
    }
    func value() -> Data { finished.wait(); return data }
}

enum ProcessRunner {
    static func run(executable: URL, arguments: [String], input: Data? = nil, timeout: TimeInterval = 30) throws -> ProcessResult {
        let process = Process()
        let output = Pipe(), error = Pipe(), standardInput = Pipe()
        process.executableURL = executable
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = error
        if input != nil { process.standardInput = standardInput }
        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }
        try process.run()
        let outputCapture = PipeCapture(output), errorCapture = PipeCapture(error)
        outputCapture.start(); errorCapture.start()
        if let input {
            standardInput.fileHandleForWriting.write(input)
            try? standardInput.fileHandleForWriting.close()
        }
        let timedOut = finished.wait(timeout: .now() + timeout) == .timedOut
        if timedOut {
            process.terminate()
            if finished.wait(timeout: .now() + 2) == .timedOut { kill(process.processIdentifier, SIGKILL); _ = finished.wait(timeout: .now() + 2) }
        }
        let out = outputCapture.value(), err = errorCapture.value()
        return ProcessResult(status: process.terminationStatus, stdout: String(decoding: out, as: UTF8.self), stderr: String(decoding: err, as: UTF8.self), timedOut: timedOut)
    }
}
