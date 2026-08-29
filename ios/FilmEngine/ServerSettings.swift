import Foundation
import Combine

/// Where the API lives.
///
/// The app ships the whole SPA, but not the engine: `server.js` runs on the
/// Mac holding the projects, the database and the generated media. So the one
/// thing this app genuinely has to ask is the address of that machine — and
/// without it the screen would be blank with no way to say why, which is the
/// "Backend offline" misdiagnosis this project has already paid for twice.
///
/// Persisted, because asking on every launch is asking a question the user
/// already answered.
final class ServerSettings: ObservableObject {
    private static let key = "film_api_url"

    @Published var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: Self.key) }
    }

    /// The last reachability answer, so the setup screen can be specific
    /// rather than saying "something went wrong".
    @Published var status: Status = .unknown

    enum Status: Equatable {
        case unknown
        case checking
        case reachable(String)
        case unreachable(String)
    }

    init() {
        serverURL = UserDefaults.standard.string(forKey: Self.key) ?? ""
    }

    var isConfigured: Bool { !normalized.isEmpty }

    /// Accepts what a person actually types — "192.168.4.40", with or without
    /// a scheme or a port — and returns something the web app can use.
    var normalized: String {
        var text = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return "" }
        if !text.contains("://") { text = "http://" + text }
        guard var parts = URLComponents(string: text), let host = parts.host, !host.isEmpty else { return "" }
        if parts.port == nil { parts.port = 3100 }
        parts.path = ""
        return parts.string ?? ""
    }

    /// Ask the engine whether it is there. Free, and it turns a blank screen
    /// into a sentence.
    func check() {
        let target = normalized
        guard let url = URL(string: target + "/api/health") else {
            status = .unreachable("That does not look like an address.")
            return
        }
        status = .checking
        var request = URLRequest(url: url)
        request.timeoutInterval = 6
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    self?.status = .unreachable(error.localizedDescription)
                } else if let http = response as? HTTPURLResponse, (200..<400).contains(http.statusCode) {
                    self?.status = .reachable(target)
                } else {
                    self?.status = .unreachable("The server answered, but not like Film Engine.")
                }
            }
        }.resume()
    }
}
