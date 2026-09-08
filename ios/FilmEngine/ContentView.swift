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

    func makeCoordinator() -> Coordinator { Coordinator(serverURL: serverURL) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: BundleSchemeHandler.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        /*
         * THE ONE NATIVE CAPABILITY, and the page asks for it.
         *
         * The page decides the subject, the views and the import route and
         * posts them in; native opens the camera and uploads through that same
         * route. Choosing in two places is the second surface this design
         * exists to avoid, so the only thing that lives here is the part a
         * browser genuinely cannot do — walking a turnaround in one session
         * with the view on screen.
         */
        config.userContentController.add(context.coordinator, name: PlateCameraBridge.name)

        /*
         * Tell the web app where the engine is BEFORE it boots, by TWO routes.
         *
         * The global cannot fail and is what the page reads first. The stored
         * copy is set as well, so opening the same page in a browser later
         * still remembers — but it is the fallback, not the channel.
         *
         * That ordering is a fix rather than a nicety. localStorage does not
         * return null when it is unavailable, it THROWS, and a custom WKWebView
         * scheme can be exactly the kind of origin it refuses. When the page
         * read the address from storage at the top of its script, that throw
         * killed every function defined below it: the shell painted, no request
         * was ever made, and nothing on the page responded to a tap.
         */
        let inject = WKUserScript(
            source: "window.__filmEngineApiBase = '\(serverURL)';"
                  + "try { localStorage.setItem('film_api_url', '\(serverURL)'); } catch (e) {}",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true)
        config.userContentController.addUserScript(inject)

        let view = WKWebView(frame: .zero, configuration: config)
        context.coordinator.webView = view
        view.isOpaque = false
        view.backgroundColor = .black
        view.scrollView.backgroundColor = .black
        view.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) { view.isInspectable = true }
        view.load(URLRequest(url: BundleSchemeHandler.entryURL))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) { }

    /// Receives the page's request to shoot, presents the camera, and hands the
    /// outcome straight back to the page — which owns every decision around it.
    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler {
        weak var webView: WKWebView?
        private let serverURL: String
        private var presented: UIViewController?

        init(serverURL: String) { self.serverURL = serverURL }

        func userContentController(_ controller: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            guard message.name == PlateCameraBridge.name,
                  let body = message.body as? String,
                  let data = body.data(using: .utf8),
                  var request = try? JSONDecoder().decode(PlateCaptureRequest.self, from: data)
            else {
                report(PlateCaptureResult(cancelled: true))
                return
            }
            // The page may not know the engine's address — the app injected it.
            if request.apiBase.isEmpty { request = request.withBase(serverURL) }
            present(request)
        }

        private func present(_ request: PlateCaptureRequest) {
            guard let host = webView?.window?.rootViewController else { return }
            let sheet = UIHostingController(rootView: PlateCameraView(request: request) { [weak self] result in
                self?.presented?.dismiss(animated: true)
                self?.presented = nil
                self?.report(result)
            })
            sheet.modalPresentationStyle = .fullScreen
            presented = sheet
            (host.presentedViewController ?? host).present(sheet, animated: true)
        }

        /// Back to the page, which refreshes whatever the plate belongs to. A
        /// capture the page never hears about is a picture the director cannot
        /// see landed.
        private func report(_ result: PlateCaptureResult) {
            let json = (try? JSONEncoder().encode(result)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            let escaped = json.replacingOccurrences(of: "\\", with: "\\\\")
                              .replacingOccurrences(of: "'", with: "\\'")
            webView?.evaluateJavaScript(
                "window.\(PlateCameraBridge.callback) && window.\(PlateCameraBridge.callback)('\(escaped)')")
        }
    }
}

/// The two names the page and the app must agree on, said once.
///
/// They are checked against src/index.html by backend/tests/ios-app.test.js:
/// a bridge the page posts to under a different name is a Shoot button that
/// silently does nothing, which is indistinguishable from no camera.
enum PlateCameraBridge {
    static let name = "plateCamera"
    static let callback = "plateCameraDone"
}

extension PlateCaptureRequest {
    func withBase(_ base: String) -> PlateCaptureRequest {
        PlateCaptureRequest(url: url, apiBase: base, subject: subject, views: views)
    }
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
