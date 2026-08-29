import SwiftUI
import WebKit

/// The app IS the app.
///
/// This ships `src/index.html` — every one of its pages — rather than a second
/// implementation of them. A native rewrite would be a SECOND SURFACE, and this
/// codebase has paid three times over for two surfaces disagreeing: the plate
/// pointer, the frame pointer, and effectiveCamera. One surface cannot drift
/// from itself.
struct ContentView: View {
    @EnvironmentObject var settings: ServerSettings
    @State private var showingSettings = false

    var body: some View {
        Group {
            if settings.isConfigured {
                WebAppView(serverURL: settings.normalized)
                    .ignoresSafeArea(edges: .bottom)
                    .overlay(alignment: .topTrailing) {
                        Button { showingSettings = true } label: {
                            Image(systemName: "gearshape.fill")
                                .padding(10)
                                .background(.ultraThinMaterial, in: Circle())
                        }
                        .padding(.trailing, 12)
                        .padding(.top, 4)
                        .opacity(0.55)
                    }
            } else {
                SetupView()
            }
        }
        .sheet(isPresented: $showingSettings) { SetupView(isSheet: true) }
    }
}

/// The one question the app has to ask, asked properly.
struct SetupView: View {
    @EnvironmentObject var settings: ServerSettings
    @Environment(\.dismiss) private var dismiss
    var isSheet: Bool = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("192.168.4.40", text: $settings.serverURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                } header: {
                    Text("Film Engine server")
                } footer: {
                    Text("The address of the Mac running Film Engine. Start it there with "
                         + "FILM_ENGINE_HOST=0.0.0.0 so the phone can reach it, and enter the LAN "
                         + "address it prints. The port is 3100 unless you say otherwise.")
                }

                Section {
                    Button("Check connection") { settings.check() }
                        .disabled(!settings.isConfigured)
                    statusRow
                }

                if case .reachable = settings.status {
                    Section {
                        Button("Open Film Engine") { dismiss() }
                            .font(.headline)
                    }
                }
            }
            .navigationTitle(isSheet ? "Server" : "Connect")
            .toolbar {
                if isSheet {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
            }
        }
    }

    @ViewBuilder private var statusRow: some View {
        switch settings.status {
        case .unknown:
            Text("Not checked yet.").foregroundStyle(.secondary)
        case .checking:
            HStack { ProgressView(); Text("Checking…").foregroundStyle(.secondary) }
        case .reachable(let url):
            Label("Reachable at \(url)", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .unreachable(let why):
            // Say WHICH failure. "Cannot connect" and "answered but is not
            // Film Engine" send you to completely different places.
            Label(why, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        }
    }
}

/// The bundled SPA, served over a custom scheme.
///
/// Not `loadFileURL`: WKWebView gives a `file://` page an opaque origin with no
/// localStorage, and the app stores the project selection, the API address and
/// every editor preference there — it would come up blank on every launch. A
/// registered scheme handler gives a real, stable origin instead, with no local
/// HTTP server to run.
struct WebAppView: UIViewRepresentable {
    let serverURL: String

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: BundleSchemeHandler.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        // Tell the web app where the engine is BEFORE it boots. Its own
        // `defaultApiBase()` returns '' off a non-http origin precisely so this
        // can be the answer rather than a broken "file://localhost:3100".
        let inject = WKUserScript(
            source: "try { localStorage.setItem('film_api_url', '\(serverURL)'); } catch (e) {}",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true)
        config.userContentController.addUserScript(inject)

        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = .black
        view.scrollView.backgroundColor = .black
        view.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) { view.isInspectable = true }
        view.load(URLRequest(url: BundleSchemeHandler.entryURL))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) { }
}

/// Serves the app's bundled Web/ folder over `film-engine://`.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "film-engine"
    static let entryURL = URL(string: "\(scheme)://app/index.html")!

    private static let types: [String: String] = [
        "html": "text/html", "js": "text/javascript", "css": "text/css",
        "json": "application/json", "png": "image/png", "jpg": "image/jpeg",
        "svg": "image/svg+xml", "woff2": "font/woff2",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let path = task.request.url?.path ?? "/index.html"
        let name = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let file = name.isEmpty ? "index.html" : name

        guard let url = Bundle.main.url(forResource: "Web/\(file)", withExtension: nil)
                ?? Bundle.main.url(forResource: (file as NSString).deletingPathExtension,
                                   withExtension: (file as NSString).pathExtension,
                                   subdirectory: "Web"),
              let data = try? Data(contentsOf: url) else {
            task.didFailWithError(NSError(domain: "FilmEngine", code: 404,
                userInfo: [NSLocalizedDescriptionKey: "Not in the app bundle: \(file)"]))
            return
        }

        let type = Self.types[(file as NSString).pathExtension.lowercased()] ?? "application/octet-stream"
        let response = HTTPURLResponse(url: task.request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": type,
                                                      "Content-Length": String(data.count)])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) { }
}
