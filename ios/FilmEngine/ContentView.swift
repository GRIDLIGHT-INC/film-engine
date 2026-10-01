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
    @StateObject private var store = ScanStore.shared
    @State private var showingSettings = false
    @State private var scanning = false

    /*
     * The phone does TWO things: scan a location in 3D (RoomPlan, drawing its
     * lines live) and photograph it, then send both to a project's location.
     * Everything else happens in Film Engine on the Mac. Scanning needs no
     * network: on location there may be none, so a scan is kept on the phone
     * and sent when the Mac is reachable.
     */
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { scanning = true } label: {
                        Label("Scan a location", systemImage: "viewfinder")
                            .font(.headline)
                    }
                    .disabled(!RoomScanSupport.available)
                } footer: {
                    Text(RoomScanSupport.available
                         ? "LiDAR, room after room (stairs and upper floors too), then guided photos of every wall. Works offline: it is saved on this iPhone and sent to Film Engine later."
                         : RoomScanSupport.reason)
                }
                Section("Saved scans") {
                    if store.scans.isEmpty {
                        Text("None yet.").foregroundStyle(.secondary)
                    }
                    ForEach(store.scans) { scan in
                        NavigationLink {
                            ScanDetailView(scanId: scan.id)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(scan.name).font(.body.weight(.semibold))
                                Text("\(scan.rooms) room\(scan.rooms == 1 ? "" : "s") · \(scan.photos.count) photo\(scan.photos.count == 1 ? "" : "s") · \(scan.createdAt.formatted(date: .abbreviated, time: .shortened))")
                                    .font(.footnote).foregroundStyle(.secondary)
                                if let sent = scan.sent {
                                    Text("Sent to \(sent.location) · \(sent.at.formatted(date: .abbreviated, time: .shortened))")
                                        .font(.footnote).foregroundStyle(.green)
                                }
                            }
                        }
                        .swipeActions { Button("Delete", role: .destructive) { store.delete(scan) } }
                    }
                }
                Section {
                    Button { showingSettings = true } label: { Label("Film Engine on your Mac", systemImage: "desktopcomputer") }
                } footer: {
                    Text(settings.isConfigured ? "Scans are sent to \(settings.normalized)." : "Set the Mac's address before sending a scan. Scanning does not need it.")
                }
            }
            .navigationTitle("Film Engine")
        }
        .fullScreenCover(isPresented: $scanning) {
            if #available(iOS 17.0, *) {
                RoomScanView(request: nil) { _ in scanning = false; store.reload() }
            }
        }
        .sheet(isPresented: $showingSettings) { SetupView(isSheet: true) }
    }
}

/// One saved scan: rename it, look at its photos, take more, send it, or delete it.
struct ScanDetailView: View {
    let scanId: String
    @ObservedObject private var store = ScanStore.shared
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var adding = false
    @State private var sending = false

    private var scan: SavedScan? { store.scans.first { $0.id == scanId } }

    var body: some View {
        Group {
            if let scan {
                List {
                    Section("Name") {
                        TextField("Name", text: $name)
                            .onSubmit { rename(scan) }
                        if name != scan.name && !name.trimmingCharacters(in: .whitespaces).isEmpty {
                            Button("Save name") { rename(scan) }
                        }
                    }
                    Section {
                        Button { adding = true } label: { Label("Add photos", systemImage: "camera") }
                            .disabled(!RoomScanSupport.available)
                        Button { sending = true } label: { Label(scan.sent == nil ? "Send to Film Engine…" : "Send again…", systemImage: "paperplane") }
                    } footer: {
                        Text("Add photos opens the camera on this scan: point at the room you scanned until it recognises it, and new photos line up with the scan like the first ones.")
                    }
                    Section("Photos (\(scan.photos.count))") {
                        if scan.photos.isEmpty { Text("No photos yet.").foregroundStyle(.secondary) }
                        ForEach(scan.photos) { p in
                            HStack(spacing: 12) {
                                if let img = UIImage(contentsOfFile: store.folder(scan.id).appendingPathComponent(p.file).path) {
                                    Image(uiImage: img).resizable().scaledToFill().frame(width: 72, height: 54).clipped().cornerRadius(6)
                                }
                                VStack(alignment: .leading) {
                                    Text(p.guided ? p.view.replacingOccurrences(of: "scan-", with: "") : "extra").font(.body)
                                    Text("\(p.width)×\(p.height)").font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                            .swipeActions { Button("Delete", role: .destructive) { store.deletePhoto(scan, view: p.view) } }
                        }
                    }
                    Section {
                        Button("Delete this scan", role: .destructive) { store.delete(scan); dismiss() }
                    }
                }
                .navigationTitle(scan.name)
                .onAppear { if name.isEmpty { name = scan.name } }
                .fullScreenCover(isPresented: $adding) {
                    if #available(iOS 17.0, *) {
                        RoomScanView(request: nil, resume: scan) { _ in adding = false; store.reload() }
                    }
                }
                .sheet(isPresented: $sending) { SendScanView(scan: scan) }
            } else {
                Text("This scan is no longer on the phone.").foregroundStyle(.secondary)
            }
        }
    }

    private func rename(_ scan: SavedScan) {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty, n != scan.name else { return }
        var s = scan
        s.name = n
        try? store.write(s)
    }
}

/// Send a scan kept on the phone to a location: choose the project, then a
/// location or a new one. The engine builds the set on the Mac.
struct SendScanView: View {
    let scan: SavedScan
    @EnvironmentObject var settings: ServerSettings
    @Environment(\.dismiss) private var dismiss
    @State private var projects: [Item] = []
    @State private var locations: [Item] = []
    @State private var project: Item?
    @State private var newName = ""
    @State private var status = ""
    @State private var working = false
    @State private var result: String?

    struct Item: Identifiable, Hashable { let id: String; let name: String }

    var body: some View {
        NavigationStack {
            Form {
                if !settings.isConfigured {
                    Text("Set the Mac's address first (Server on the home screen).")
                }
                if let result {
                    Section("Sent") { Text(result) }
                } else {
                    Section("Project") {
                        Picker("Project", selection: $project) {
                            Text("Choose…").tag(Item?.none)
                            ForEach(projects) { Text($0.name).tag(Item?.some($0)) }
                        }
                    }
                    if project != nil {
                        Section("Location") {
                            ForEach(locations) { loc in
                                Button(loc.name) { Task { await send(to: loc) } }.disabled(working)
                            }
                            HStack {
                                TextField("New location name", text: $newName)
                                Button("Create & send") { Task { await createAndSend() } }
                                    .disabled(working || newName.trimmingCharacters(in: .whitespaces).isEmpty)
                            }
                        }
                    }
                }
                if working { ProgressView() }
                if !status.isEmpty { Text(status).font(.footnote).foregroundStyle(.secondary) }
            }
            .navigationTitle(scan.name)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await loadProjects() }
            .onChange(of: project) { p in Task { await loadLocations(p) } }
        }
    }

    private var base: String { settings.normalized }

    private func getJSON(_ path: String) async -> [String: Any]? {
        guard let url = URL(string: base + path) else { return nil }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            return try JSONSerialization.jsonObject(with: data) as? [String: Any]
        } catch { status = "Film Engine is not reachable: \(error.localizedDescription)"; return nil }
    }

    private func loadProjects() async {
        guard let d = await getJSON("/film/projects"), let list = d["projects"] as? [[String: Any]] else { return }
        projects = list.compactMap { p in (p["id"] as? String).map { Item(id: $0, name: (p["title"] as? String) ?? "Untitled") } }
    }

    private func loadLocations(_ p: Item?) async {
        locations = []
        guard let p, let d = await getJSON("/film/projects/\(p.id)/locations"), let list = d["locations"] as? [[String: Any]] else { return }
        locations = list.compactMap { l in (l["id"] as? String).map { Item(id: $0, name: (l["name"] as? String) ?? "Location") } }
    }

    private func createAndSend() async {
        guard let p = project, let url = URL(string: base + "/film/projects/\(p.id)/locations") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["name": newName.trimmingCharacters(in: .whitespaces)])
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            // A name already in the project answers with the existing one.
            let row = (obj?["existing"] as? [String: Any]) ?? obj
            guard let id = row?["id"] as? String else { status = (obj?["error"] as? String) ?? "Could not create the location."; return }
            await send(to: Item(id: id, name: (row?["name"] as? String) ?? newName))
        } catch { status = error.localizedDescription }
    }

    private func send(to loc: Item) async {
        working = true
        status = "Sending \(scan.rooms) room\(scan.rooms == 1 ? "" : "s") and \(scan.photos.count) photos. Blender builds the set on the Mac; this can take a minute…"
        defer { working = false }
        let r = await ScanStore.shared.send(scan, base: base, locationId: loc.id, name: scan.name)
        if r.ok {
            var s = scan
            s.sent = SentInfo(project: project?.name ?? "", location: loc.name, at: Date())
            try? ScanStore.shared.write(s)
            result = "Built as a set for \(loc.name), with \(scan.photos.count) photos as its plates.\n\n"
                + "Next, ask Claude: “Finish the set for \(loc.name) from its scan and photos (set_build_brief, then set_build_render).” "
                + "It adds every object the photos show on top of the scan."
            status = ""
        } else {
            status = r.error ?? "The scan was not sent."
        }
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
                        Button("Done") { dismiss() }
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
        // The LiDAR room scan, asked for by the page the same way.
        config.userContentController.add(context.coordinator, name: RoomScanBridge.name)

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
                  + "window.__filmEngineRoomScan = \(RoomScanSupport.available ? "true" : "false");"
                  + "window.__filmEngineRoomScanWhyNot = '\(RoomScanSupport.reason)';"
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
            if message.name == RoomScanBridge.name {
                guard let body = message.body as? String, let data = body.data(using: .utf8),
                      var request = try? JSONDecoder().decode(RoomScanRequest.self, from: data) else {
                    reportScan(RoomScanResult(cancelled: true)); return
                }
                if request.apiBase.isEmpty { request = request.withBase(serverURL) }
                presentScan(request)
                return
            }
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

        private func presentScan(_ request: RoomScanRequest) {
            guard #available(iOS 17.0, *), RoomScanSupport.available else {
                reportScan(RoomScanResult(error: RoomScanSupport.reason)); return
            }
            guard let host = webView?.window?.rootViewController else { return }
            let sheet = UIHostingController(rootView: RoomScanView(request: request) { [weak self] result in
                self?.presented?.dismiss(animated: true)
                self?.presented = nil
                self?.reportScan(result)
            })
            sheet.modalPresentationStyle = .fullScreen
            presented = sheet
            (host.presentedViewController ?? host).present(sheet, animated: true)
        }

        private func reportScan(_ result: RoomScanResult) {
            let json = (try? JSONEncoder().encode(result)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            let escaped = json.replacingOccurrences(of: "\\", with: "\\\\")
                              .replacingOccurrences(of: "'", with: "\\'")
            webView?.evaluateJavaScript(
                "window.\(RoomScanBridge.callback) && window.\(RoomScanBridge.callback)('\(escaped)')")
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
        // Every field is carried through. `aspect`, `destination` and `media`
        // deliberately have NO default: with one, this reconstruction would
        // compile while silently dropping the field — the aspect guide would
        // never appear, a walkthrough would never be budgeted against Marble,
        // and every session would fall back to stills.
        PlateCaptureRequest(url: url, apiBase: base, subject: subject, views: views,
                            aspect: aspect, destination: destination, media: media)
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
