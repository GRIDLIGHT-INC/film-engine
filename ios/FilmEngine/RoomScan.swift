import SwiftUI
import UIKit
import ARKit
import SceneKit
import RoomPlan
import CoreImage

/// SCAN A LOCATION WITH LIDAR, PHOTOGRAPH IT, AND BUILD IT AS A PREVIS SET.
///
/// "We shouldn't have to be connected to the computer, we can just connect
/// after… scan the room and then it would ask to take pictures and guide us on
/// taking appropriate pictures of the set; the LiDAR builds the base, and the
/// pictures are loaded into Claude to finish the details."
///
/// Three steps, all on the phone, none of them needing the Mac:
///
///   1. ROOMS. Apple's RoomPlan reads walls, doors, windows, floors, stairs and
///      furniture at their real size. Room after room in ONE AR session, so the
///      kitchen stays beside the hall and the bedroom above the living room.
///   2. PHOTOS. The session keeps running, so the app knows where every wall is
///      and where the phone is. It asks for one photograph of each wall from
///      across the room, shows how far to walk and which way to turn, and keeps
///      each picture WITH ITS POSE: the set and the photo then line up exactly,
///      with no camera placed by eye.
///   3. SAVE. Everything is written to the phone (Documents/Scans). It is sent
///      to a location in Film Engine later, from the app's home, when the Mac
///      is reachable. Asked for by the Previs page instead, it is sent at once.
///
/// Nothing is decided here: the engine turns the scan into a set, renders it
/// beside each photo, and Claude adds every object the photos show.
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
    var photos = 0
    var saved = false
    var error: String? = nil
    /// The engine's answer (the finished build, with its report), verbatim.
    var response: String? = nil
}

/// The names the page and the app agree on, said once (held by the tests).
enum RoomScanBridge {
    static let name = "roomScan"
    static let callback = "roomScanDone"
}

// ── what is kept on the phone ───────────────────────────────────────────────

/// One photograph and the pose it was taken from, for the image AS SAVED (upright).
struct ScanPhoto: Codable, Identifiable {
    var id: String { view }
    let view: String
    let file: String
    /// ARKit camera-to-world, 16 floats, column-major.
    let cameraToWorld: [Float]
    /// Horizontal focal length in pixels, for `width`.
    let focalPx: Float
    let width: Int
    let height: Int
    let guided: Bool
}

struct SentInfo: Codable {
    let project: String
    let location: String
    let at: Date
}

/// A scan kept on the phone until it is sent.
struct SavedScan: Codable, Identifiable {
    let id: String
    var name: String
    let createdAt: Date
    let rooms: Int
    var photos: [ScanPhoto]
    var sent: SentInfo?
}

@MainActor
final class ScanStore: ObservableObject {
    static let shared = ScanStore()
    @Published private(set) var scans: [SavedScan] = []

    static var root: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("Scans", isDirectory: true)
    }
    func folder(_ id: String) -> URL { Self.root.appendingPathComponent(id, isDirectory: true) }

    init() { reload() }

    func reload() {
        let fm = FileManager.default
        try? fm.createDirectory(at: Self.root, withIntermediateDirectories: true)
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        let dirs = (try? fm.contentsOfDirectory(at: Self.root, includingPropertiesForKeys: nil)) ?? []
        scans = dirs.compactMap { d in
            guard let data = try? Data(contentsOf: d.appendingPathComponent("scan.json")) else { return nil }
            return try? dec.decode(SavedScan.self, from: data)
        }.sorted { $0.createdAt > $1.createdAt }
    }

    func write(_ scan: SavedScan) throws {
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        try enc.encode(scan).write(to: folder(scan.id).appendingPathComponent("scan.json"))
        reload()
    }

    func delete(_ scan: SavedScan) {
        try? FileManager.default.removeItem(at: folder(scan.id))
        reload()
    }

    /// The body the engine's room-scan import reads: the structure, the USDZ and the posed photos.
    func uploadBody(_ scan: SavedScan, name: String) throws -> Data {
        let dir = folder(scan.id)
        var body = Data("{\"name\":".utf8)
        body.append(try JSONEncoder().encode(name))
        body.append(Data(",\"structure\":".utf8))
        body.append(try Data(contentsOf: dir.appendingPathComponent("structure.json")))
        if let usdz = try? Data(contentsOf: dir.appendingPathComponent("scan.usdz")) {
            body.append(Data(",\"usdz\":\"data:model/vnd.usdz+zip;base64,".utf8))
            body.append(Data(usdz.base64EncodedString().utf8))
            body.append(Data("\"".utf8))
        }
        body.append(Data(",\"photos\":[".utf8))
        var first = true
        for p in scan.photos {
            guard let jpg = try? Data(contentsOf: dir.appendingPathComponent(p.file)) else { continue }
            if !first { body.append(Data(",".utf8)) }
            first = false
            let meta: [String: Any] = ["view": p.view, "camera_to_world": p.cameraToWorld.map { Double($0) },
                                       "focal_px": Double(p.focalPx), "width": p.width, "height": p.height]
            var obj = try JSONSerialization.data(withJSONObject: meta)
            obj.removeLast()   // the closing brace: the image goes in beside the pose
            body.append(obj)
            body.append(Data(",\"image\":\"data:image/jpeg;base64,".utf8))
            body.append(Data(jpg.base64EncodedString().utf8))
            body.append(Data("\"}".utf8))
        }
        body.append(Data("]}".utf8))
        return body
    }

    /// Send a saved scan to a location's import route. The engine builds it on the Mac.
    func send(_ scan: SavedScan, base: String, locationId: String, name: String) async -> RoomScanResult {
        do {
            let body = try uploadBody(scan, name: name)
            let b = base.hasSuffix("/") ? String(base.dropLast()) : base
            guard let endpoint = URL(string: b + "/film" + "/locations/\(locationId)/room-scan/import") else {
                return RoomScanResult(rooms: scan.rooms, error: "Bad engine address: \(base)")
            }
            return await postScan(endpoint, body: body, rooms: scan.rooms, photos: scan.photos.count)
        } catch {
            return RoomScanResult(rooms: scan.rooms, error: error.localizedDescription)
        }
    }
}

func postScan(_ endpoint: URL, body: Data, rooms: Int, photos: Int) async -> RoomScanResult {
    var req = URLRequest(url: endpoint, timeoutInterval: 900)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = body
    do {
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let text = String(data: data, encoding: .utf8) ?? ""
        if status >= 200 && status < 300 {
            return RoomScanResult(ok: true, rooms: rooms, photos: photos, response: text)
        }
        return RoomScanResult(rooms: rooms, photos: photos, error: "The engine refused the scan (\(status)): \(text.prefix(400))")
    } catch {
        return RoomScanResult(rooms: rooms, photos: photos, error: error.localizedDescription)
    }
}

// ── where to stand for each photograph ──────────────────────────────────────

/// One wall to photograph: stand at `stand`, face `facing` (horizontal, unit).
struct PhotoTarget: Identifiable {
    let id: String
    let label: String
    let stand: SIMD3<Float>
    let facing: SIMD3<Float>
}

/// Across the room from every wall, at eye height, facing it. From the rooms as
/// captured (session coordinates), so the targets and the phone share one world.
@available(iOS 17.0, *)
func photoTargets(for rooms: [CapturedRoom]) -> [PhotoTarget] {
    var out: [PhotoTarget] = []
    for (r, room) in rooms.enumerated() {
        let walls = room.walls
        guard !walls.isEmpty else { continue }
        let centres = walls.map { SIMD3<Float>($0.transform.columns.3.x, $0.transform.columns.3.y, $0.transform.columns.3.z) }
        let mid = centres.reduce(SIMD3<Float>(repeating: 0), +) / Float(centres.count)
        let floorY = walls.map { $0.transform.columns.3.y - $0.dimensions.y / 2 }.min() ?? 0
        let names = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"]
        var n = 0
        for (i, w) in walls.enumerated() where w.dimensions.x >= 1.2 {
            let c = centres[i]
            var inward = SIMD3<Float>(mid.x - c.x, 0, mid.z - c.z)
            let toMid = simd_length(inward)
            guard toMid > 0.2 else { continue }
            inward /= toMid
            let back = max(1.2, min(toMid * 1.7, 6))
            let stand = SIMD3<Float>(c.x + inward.x * back, floorY + 1.5, c.z + inward.z * back)
            let label = rooms.count > 1
                ? "Room \(r + 1), \(n < names.count ? names[n] : "next") wall"
                : "The \(n < names.count ? names[n] : "next") wall"
            out.append(PhotoTarget(id: "scan-r\(r + 1)-w\(n + 1)", label: label, stand: stand, facing: -inward))
            n += 1
        }
    }
    return out
}

// ── the session ─────────────────────────────────────────────────────────────

enum ScanPhase { case rooms, photos, saving, done }

@available(iOS 17.0, *)
@MainActor
final class RoomScanModel: NSObject, ObservableObject, RoomCaptureViewDelegate {
    let arSession = ARSession()
    private(set) lazy var captureView: RoomCaptureView = {
        let v = RoomCaptureView(frame: .zero, arSession: arSession)
        v.delegate = self
        return v
    }()

    @Published var phase: ScanPhase = .rooms
    @Published var rooms: [CapturedRoom] = []
    @Published var scanning = false
    @Published var processing = false
    @Published var busy = false
    @Published var message = "Stand in the first room. Tap Start, then walk slowly, pointing at every wall, door and window."
    @Published var targets: [PhotoTarget] = []
    @Published var photos: [ScanPhoto] = []
    @Published var guide = "…"
    @Published var onMark = false
    @Published var flash = false

    let scanId = UUID().uuidString
    private var timer: Timer?
    private let ci = CIContext()

    override init() { super.init() }
    // RoomCaptureViewDelegate inherits NSCoding; this object is never archived.
    required init?(coder: NSCoder) { super.init() }
    nonisolated func encode(with coder: NSCoder) { }

    var folder: URL { ScanStore.root.appendingPathComponent(scanId, isDirectory: true) }

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
            self.message = "\(self.rooms.count) room\(self.rooms.count == 1 ? "" : "s") scanned. Walk to the next room (or up the stairs) and tap Scan another room, or Take photos."
        }
    }

    // ── photos ──

    func beginPhotos() {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        targets = photoTargets(for: rooms)
        phase = .photos
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.updateGuide() }
        }
        updateGuide()
    }

    var nextTarget: PhotoTarget? { targets.first { t in !photos.contains { $0.view == t.id } } }

    func skipTarget() {
        guard let t = nextTarget else { return }
        targets.removeAll { $0.id == t.id }
        updateGuide()
    }

    func updateGuide() {
        guard let frame = arSession.currentFrame else { guide = "Waiting for the camera…"; onMark = false; return }
        if case .limited = frame.camera.trackingState { guide = "Move the phone slowly so it can find its place again."; onMark = false; return }
        if case .notAvailable = frame.camera.trackingState { guide = "Tracking lost. Point at the room you scanned."; onMark = false; return }
        let m = frame.camera.transform
        let pos = SIMD3<Float>(m.columns.3.x, m.columns.3.y, m.columns.3.z)
        let fwd3 = -SIMD3<Float>(m.columns.2.x, m.columns.2.y, m.columns.2.z)
        guard let t = nextTarget else {
            guide = "Every wall is photographed. Take extra photos of anything detailed, then tap Done."
            onMark = false
            return
        }
        let d = SIMD3<Float>(t.stand.x - pos.x, 0, t.stand.z - pos.z)
        let dist = simd_length(d)
        var fwd = SIMD3<Float>(fwd3.x, 0, fwd3.z)
        if simd_length(fwd) > 0.01 { fwd = simd_normalize(fwd) }
        // Signed turn from where the phone looks to where it should look (left positive).
        let cross = fwd.z * t.facing.x - fwd.x * t.facing.z
        let turn = atan2(cross, simd_dot(fwd, t.facing)) * 180 / .pi
        var parts: [String] = []
        if dist > 0.6 {
            // Which way to walk, said relative to where the phone is facing.
            let dn = simd_normalize(d)
            let side = fwd.z * dn.x - fwd.x * dn.z
            let ahead = simd_dot(fwd, dn)
            let way = ahead > 0.7 ? "ahead" : ahead < -0.7 ? "behind you" : (side > 0 ? "to your left" : "to your right")
            parts.append(String(format: "Walk %.1f m %@", dist, way))
        }
        if abs(turn) > 12 { parts.append(String(format: "turn %@ %.0f°", turn > 0 ? "left" : "right", abs(turn))) }
        let tilt = asin(max(-1, min(1, fwd3.y))) * 180 / .pi
        if abs(tilt) > 15 { parts.append(tilt > 0 ? "tilt down a little" : "tilt up a little") }
        onMark = parts.isEmpty
        guide = onMark ? "\(t.label): good, take it." : "\(t.label): " + parts.joined(separator: ", ")
    }

    /// Keep the frame and the pose it was taken from, upright as the phone was held.
    func capture(extra: Bool) {
        guard let frame = arSession.currentFrame else { return }
        let view = extra ? "scan-extra-\(photos.filter { !$0.guided }.count + 1)" : (nextTarget?.id ?? "scan-extra-\(photos.count + 1)")
        let portrait = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.interfaceOrientation.isPortrait ?? true
        let landscapeLeft = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.interfaceOrientation == .landscapeLeft
        var image = CIImage(cvPixelBuffer: frame.capturedImage)
        let rawW = Float(CVPixelBufferGetWidth(frame.capturedImage)), rawH = Float(CVPixelBufferGetHeight(frame.capturedImage))
        var m = frame.camera.transform
        let K = frame.camera.intrinsics
        var width = rawW, height = rawH, fx = K.columns.0.x
        if portrait {
            // The sensor is landscape; upright in portrait is a quarter turn clockwise,
            // and the camera's right is then the sensor's up.
            image = image.oriented(.right)
            let x = m.columns.0, y = m.columns.1
            m.columns.0 = y
            m.columns.1 = -x
            width = rawH; height = rawW; fx = K.columns.1.y
        } else if landscapeLeft {
            image = image.oriented(.down)
            m.columns.0 = -m.columns.0
            m.columns.1 = -m.columns.1
        }
        guard let cs = CGColorSpace(name: CGColorSpace.sRGB),
              let jpg = ci.jpegRepresentation(of: image, colorSpace: cs,
                                              options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.85])
        else { return }
        let file = "\(view).jpg"
        do { try jpg.write(to: folder.appendingPathComponent(file)) } catch { message = "Could not save the photo: \(error.localizedDescription)"; return }
        let cols = [m.columns.0, m.columns.1, m.columns.2, m.columns.3]
        let flat = cols.flatMap { [$0.x, $0.y, $0.z, $0.w] }
        photos.removeAll { $0.view == view }
        photos.append(ScanPhoto(view: view, file: file, cameraToWorld: flat, focalPx: fx,
                                width: Int(width), height: Int(height), guided: !extra))
        flash = true
        Task { try? await Task.sleep(nanoseconds: 150_000_000); flash = false }
        updateGuide()
    }

    // ── keeping it ──

    /// Merge the rooms and write everything to the phone. Needs no connection.
    func save(name: String) async -> SavedScan? {
        guard !rooms.isEmpty else { return nil }
        timer?.invalidate()
        busy = true
        phase = .saving
        message = "Merging \(rooms.count) room\(rooms.count == 1 ? "" : "s") and saving to this iPhone…"
        defer { busy = false }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let structure = try await StructureBuilder(options: [.beautifyObjects]).capturedStructure(from: rooms)
            try JSONEncoder().encode(structure).write(to: folder.appendingPathComponent("structure.json"))
            try? structure.export(to: folder.appendingPathComponent("scan.usdz"))
            let scan = SavedScan(id: scanId, name: name, createdAt: Date(), rooms: rooms.count, photos: photos, sent: nil)
            try ScanStore.shared.write(scan)
            arSession.pause()
            phase = .done
            message = "Saved on this iPhone: \(rooms.count) room\(rooms.count == 1 ? "" : "s"), \(photos.count) photo\(photos.count == 1 ? "" : "s")."
            return scan
        } catch {
            message = "Could not save the scan: \(error.localizedDescription)"
            phase = .photos
            return nil
        }
    }

    func cancel() {
        timer?.invalidate()
        if scanning { captureView.captureSession.stop() }
        arSession.pause()
        if !FileManager.default.fileExists(atPath: folder.appendingPathComponent("scan.json").path) {
            try? FileManager.default.removeItem(at: folder)
        }
    }
}

@available(iOS 17.0, *)
struct RoomCaptureContainer: UIViewRepresentable {
    let model: RoomScanModel
    func makeUIView(context: Context) -> RoomCaptureView { model.captureView }
    func updateUIView(_ view: RoomCaptureView, context: Context) { }
}

/// The live camera for the photo step, on the SAME session as the scan.
@available(iOS 17.0, *)
struct ARCameraContainer: UIViewRepresentable {
    let model: RoomScanModel
    func makeUIView(context: Context) -> ARSCNView {
        let v = ARSCNView(frame: .zero)
        v.session = model.arSession
        v.automaticallyUpdatesLighting = false
        return v
    }
    func updateUIView(_ view: ARSCNView, context: Context) { }
}

@available(iOS 17.0, *)
struct RoomScanView: View {
    /// From the Previs page: send to its location as soon as it is saved. Nil: keep it on the phone.
    let request: RoomScanRequest?
    let done: (RoomScanResult) -> Void
    @StateObject private var model = RoomScanModel()
    @State private var name = ""

    var title: String {
        if let r = request, !r.location.isEmpty { return "Scan: \(r.location)" }
        return "Scan a location"
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            if model.phase == .rooms {
                RoomCaptureContainer(model: model).ignoresSafeArea()
            } else {
                ARCameraContainer(model: model).ignoresSafeArea()
                if model.flash { Color.white.opacity(0.6).ignoresSafeArea() }
            }
            VStack(spacing: 10) {
                Text(title).font(.headline)
                if model.phase == .photos {
                    Text(model.guide).font(.title3.weight(.semibold)).multilineTextAlignment(.center)
                        .foregroundStyle(model.onMark ? .green : .primary)
                    Text("\(model.photos.count) photo\(model.photos.count == 1 ? "" : "s") · \(max(0, model.targets.count - model.photos.filter { $0.guided }.count)) wall\(model.targets.count - model.photos.filter { $0.guided }.count == 1 ? "" : "s") to go. Hold the phone level at eye height.")
                        .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                } else {
                    Text(model.message).font(.subheadline).multilineTextAlignment(.center)
                }
                if model.busy || model.processing { ProgressView() }
                controls
            }
            .padding(16)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
            .padding(16)
        }
    }

    @ViewBuilder private var controls: some View {
        switch model.phase {
        case .rooms:
            HStack(spacing: 10) {
                Button("Cancel") { model.cancel(); done(RoomScanResult(cancelled: true)) }.buttonStyle(.bordered)
                if model.scanning {
                    Button("Room done") { model.finishRoom() }.buttonStyle(.borderedProminent)
                } else if !model.processing {
                    Button(model.rooms.isEmpty ? "Start" : "Scan another room") { model.startRoom() }
                        .buttonStyle(.borderedProminent)
                    if !model.rooms.isEmpty {
                        Button("Take photos") { model.beginPhotos() }.buttonStyle(.borderedProminent).tint(.green)
                    }
                }
            }
        case .photos:
            VStack(spacing: 8) {
                HStack(spacing: 10) {
                    if model.nextTarget != nil {
                        Button { model.capture(extra: false) } label: { Label("Take this wall", systemImage: "camera.fill") }
                            .buttonStyle(.borderedProminent).tint(model.onMark ? .green : .blue)
                        Button("Skip") { model.skipTarget() }.buttonStyle(.bordered)
                    }
                    Button { model.capture(extra: true) } label: { Label("Extra", systemImage: "plus.viewfinder") }
                        .buttonStyle(.bordered)
                }
                HStack(spacing: 10) {
                    TextField("Name this scan", text: $name).textFieldStyle(.roundedBorder).frame(maxWidth: 220)
                    Button(request == nil ? "Done, save" : "Done, send") { Task { await finish() } }
                        .buttonStyle(.borderedProminent).tint(.green)
                }
                Button("Cancel") { model.cancel(); done(RoomScanResult(cancelled: true)) }.font(.footnote)
            }
        case .saving:
            EmptyView()
        case .done:
            Button("Close") { done(RoomScanResult(ok: true, rooms: model.rooms.count, photos: model.photos.count, saved: true)) }
                .buttonStyle(.borderedProminent)
        }
    }

    private func finish() async {
        let label = name.trimmingCharacters(in: .whitespaces).isEmpty
            ? (request?.location.isEmpty == false ? request!.location : "Scan \(Date().formatted(date: .abbreviated, time: .shortened))")
            : name
        guard let scan = await model.save(name: label) else { return }
        guard let request else { return }   // kept on the phone; sent later from the app's home
        model.busy = true
        model.message = "Sending to Film Engine. Blender builds the set on the Mac…"
        let base = request.apiBase.hasSuffix("/") ? String(request.apiBase.dropLast()) : request.apiBase
        guard let endpoint = URL(string: base + "/film" + request.url),
              let body = try? ScanStore.shared.uploadBody(scan, name: label) else {
            done(RoomScanResult(rooms: scan.rooms, photos: scan.photos.count, saved: true, error: "Bad engine address: \(base)"))
            return
        }
        var result = await postScan(endpoint, body: body, rooms: scan.rooms, photos: scan.photos.count)
        result.saved = true
        model.busy = false
        if result.ok {
            var s = scan
            s.sent = SentInfo(project: "", location: request.location, at: Date())
            try? ScanStore.shared.write(s)
        }
        done(result)
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
