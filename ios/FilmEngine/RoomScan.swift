import SwiftUI
import UIKit
import ARKit
import RoomPlan

/// SCAN A LOCATION WITH LIDAR, AND BUILD IT AS A PREVIS SET.
///
/// "Build our own app to do the appropriate scanning… scan with LiDAR in our
/// own app… what if I want to do the entire house with multiple levels?"
///
/// Apple's RoomPlan does the scanning: it reads walls, doors, windows, floors,
/// stairs and furniture, each with its real size, while you walk the room. This
/// screen adds the one thing a house needs: scanning ROOM AFTER ROOM IN ONE
/// SESSION. Every room captured in the same AR session shares one set of world
/// coordinates — vertical included — so the kitchen stays beside the hall and
/// the bedroom stays above the living room. Walk between rooms (and up the
/// stairs) without stopping the session, then StructureBuilder merges them.
///
/// Nothing is decided here. The page names the location and the import route;
/// this captures and uploads the CapturedStructure as Apple's own JSON (what
/// each thing IS) with the USDZ beside it (the mesh). The engine turns the
/// JSON into a set and Blender builds it — free, on the Mac.
struct RoomScanRequest: Decodable {
    /// The import route the page built, e.g. `/locations/<id>/room-scan/import`.
    let url: String
    /// Where the engine is; empty means the address the app injected.
    let apiBase: String
    /// The location, for the person holding the phone.
    let location: String

    func withBase(_ base: String) -> RoomScanRequest {
        RoomScanRequest(url: url, apiBase: base, location: location)
    }
}

/// What came back, reported to the page.
struct RoomScanResult: Encodable {
    var cancelled = false
    var ok = false
    var rooms = 0
    var error: String? = nil
    /// The engine's answer (the finished build, with its report), verbatim.
    var response: String? = nil
}

/// The names the page and the app agree on, said once (held by the tests).
enum RoomScanBridge {
    static let name = "roomScan"
    static let callback = "roomScanDone"
}

@available(iOS 17.0, *)
@MainActor
final class RoomScanModel: NSObject, ObservableObject, RoomCaptureViewDelegate {
    let arSession = ARSession()
    private(set) lazy var captureView: RoomCaptureView = {
        let v = RoomCaptureView(frame: .zero, arSession: arSession)
        v.delegate = self
        return v
    }()

    @Published var rooms: [CapturedRoom] = []
    @Published var scanning = false
    @Published var processing = false
    @Published var uploading = false
    @Published var message = "Stand in the first room. Tap Start, then walk slowly, pointing at every wall, door and window."

    override init() { super.init() }
    // RoomCaptureViewDelegate inherits NSCoding; this object is never archived.
    required init?(coder: NSCoder) { super.init() }
    nonisolated func encode(with coder: NSCoder) { }

    func startRoom() {
        captureView.captureSession.run(configuration: RoomCaptureSession.Configuration())
        scanning = true
        message = rooms.isEmpty
            ? "Scanning room 1. Walk the edges; get the corners, the doors and the windows."
            : "Scanning room \(rooms.count + 1). The rooms keep their places, stairs and floors included."
    }

    /// Stop this room but keep the AR session running, so the next room lands in the same space.
    func finishRoom() {
        captureView.captureSession.stop(pauseARSession: false)
        scanning = false
        processing = true
        message = "Processing the room…"
    }

    nonisolated func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool { true }

    nonisolated func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        Task { @MainActor in
            self.processing = false
            if let error {
                self.message = "That room did not process: \(error.localizedDescription). Scan it again."
                return
            }
            self.rooms.append(processedResult)
            self.message = "\(self.rooms.count) room\(self.rooms.count == 1 ? "" : "s") scanned. Walk to the next room (or up the stairs) and tap Scan another room, or Finish."
        }
    }

    /// Merge the rooms, export, and send to the engine.
    func finishAndUpload(_ request: RoomScanRequest) async -> RoomScanResult {
        guard !rooms.isEmpty else { return RoomScanResult(cancelled: true) }
        uploading = true
        message = "Merging \(rooms.count) room\(rooms.count == 1 ? "" : "s")…"
        defer { uploading = false }
        do {
            let structure = try await StructureBuilder(options: [.beautifyObjects]).capturedStructure(from: rooms)
            let json = try JSONEncoder().encode(structure)
            var usdz: Data? = nil
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("scan-\(UUID().uuidString).usdz")
            if (try? structure.export(to: url)) != nil { usdz = try? Data(contentsOf: url) }
            try? FileManager.default.removeItem(at: url)

            message = "Sending to Film Engine. Blender builds the set on the Mac…"
            var body = Data("{\"name\":".utf8)
            body.append(try JSONEncoder().encode("\(request.location) (\(rooms.count) room\(rooms.count == 1 ? "" : "s"))"))
            body.append(Data(",\"structure\":".utf8))
            body.append(json)
            if let usdz {
                body.append(Data(",\"usdz\":\"data:model/vnd.usdz+zip;base64,".utf8))
                body.append(Data(usdz.base64EncodedString().utf8))
                body.append(Data("\"".utf8))
            }
            body.append(Data("}".utf8))

            let base = request.apiBase.hasSuffix("/") ? String(request.apiBase.dropLast()) : request.apiBase
            guard let endpoint = URL(string: base + "/film" + request.url) else {
                return RoomScanResult(rooms: rooms.count, error: "Bad engine address: \(base)")
            }
            var req = URLRequest(url: endpoint, timeoutInterval: 600)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
            let (data, response) = try await URLSession.shared.data(for: req)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let text = String(data: data, encoding: .utf8) ?? ""
            if status >= 200 && status < 300 {
                return RoomScanResult(ok: true, rooms: rooms.count, response: text)
            }
            return RoomScanResult(rooms: rooms.count, error: "The engine refused the scan (\(status)): \(text.prefix(400))")
        } catch {
            return RoomScanResult(rooms: rooms.count, error: error.localizedDescription)
        }
    }
}

@available(iOS 17.0, *)
struct RoomCaptureContainer: UIViewRepresentable {
    let model: RoomScanModel
    func makeUIView(context: Context) -> RoomCaptureView { model.captureView }
    func updateUIView(_ view: RoomCaptureView, context: Context) { }
}

@available(iOS 17.0, *)
struct RoomScanView: View {
    let request: RoomScanRequest
    let done: (RoomScanResult) -> Void
    @StateObject private var model = RoomScanModel()

    var body: some View {
        ZStack(alignment: .bottom) {
            RoomCaptureContainer(model: model).ignoresSafeArea()
            VStack(spacing: 12) {
                Text(request.location.isEmpty ? "Scan location" : "Scan: \(request.location)")
                    .font(.headline)
                Text(model.message).font(.subheadline).multilineTextAlignment(.center)
                if model.uploading || model.processing { ProgressView() }
                HStack(spacing: 10) {
                    Button("Cancel") {
                        if model.scanning { model.captureView.captureSession.stop() }
                        done(RoomScanResult(cancelled: true))
                    }
                    .buttonStyle(.bordered)
                    if model.scanning {
                        Button("Room done") { model.finishRoom() }.buttonStyle(.borderedProminent)
                    } else if !model.processing && !model.uploading {
                        Button(model.rooms.isEmpty ? "Start" : "Scan another room") { model.startRoom() }
                            .buttonStyle(.borderedProminent)
                        if !model.rooms.isEmpty {
                            Button("Finish & build") {
                                Task { done(await model.finishAndUpload(request)) }
                            }
                            .buttonStyle(.borderedProminent).tint(.green)
                        }
                    }
                }
            }
            .padding(16)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
            .padding(16)
        }
    }
}

/// Whether this phone can scan at all: RoomPlan needs LiDAR and iOS 17 for multi-room.
enum RoomScanSupport {
    static var available: Bool {
        if #available(iOS 17.0, *) { return RoomCaptureSession.isSupported }
        return false
    }
    static var reason: String {
        if #available(iOS 17.0, *) {
            return RoomCaptureSession.isSupported ? "" : "This iPhone has no LiDAR scanner (an iPhone Pro is needed)."
        }
        return "Room scanning needs iOS 17 or later."
    }
}
