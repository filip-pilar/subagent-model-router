import Foundation

final class ConfigWatcher: @unchecked Sendable {
    private var source: DispatchSourceFileSystemObject?
    private var descriptor: Int32 = -1

    func start(directory: URL, onChange: @escaping @Sendable () -> Void) {
        stop()
        descriptor = open(directory.path, O_EVTONLY)
        guard descriptor >= 0 else { return }
        let next = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: [.write, .rename, .delete], queue: .global(qos: .utility))
        next.setEventHandler(handler: onChange)
        next.setCancelHandler { [descriptor] in close(descriptor) }
        source = next
        next.resume()
    }

    func stop() { source?.cancel(); source = nil; descriptor = -1 }
    deinit { stop() }
}
