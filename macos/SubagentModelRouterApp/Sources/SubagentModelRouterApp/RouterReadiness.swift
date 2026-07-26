import Foundation

enum RouterReadiness {
    struct Snapshot: Decodable, Sendable {
        let ready: Bool
        let service: String
        let version: String
    }

    static func inspect(port: Int = 9476) async -> Snapshot? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/__router/readiness") else { return nil }
        do {
            var request = URLRequest(url: url)
            request.timeoutInterval = 1
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  http.statusCode == 200,
                  http.value(forHTTPHeaderField: "x-subagent-model-router") == "1" else { return nil }
            let snapshot = try JSONDecoder().decode(Snapshot.self, from: data)
            return snapshot.ready && snapshot.service == "subagent-model-router" ? snapshot : nil
        } catch { return nil }
    }
}
