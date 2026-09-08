import SwiftUI
import AVFoundation
import UIKit

/// SHOOT A REFERENCE PLATE, GUIDED, IN ONE SESSION.
///
/// The web page already has a Shoot button: `uploadControl()` appends an
/// `<input type="file" capture="environment">`, and WKWebView opens the camera
/// for it. That is fine for ONE picture and it is all a browser can offer —
/// one photo per tap, with nothing on screen saying which view you are on or
/// what the last one looked like.
///
/// A reference plate is usually not one picture. A character turnaround is
/// front, side-left, side-right and back; the engine ranks exactly those in
/// `VIEW_RANK` and attaches the front one to every frame the character appears
/// in. Shooting four through a file input means four round trips out to the
/// page and back, hunting for the next view's control each time.
///
/// So this is the ONE thing added natively, and it is deliberately only the
/// CAPTURE. The page still decides the subject, the views and the route — it
/// posts them in — because choosing in two places is the second surface this
/// whole design exists to avoid.
///
/// THE UPLOAD GOES THROUGH THE SAME IMPORT ROUTE the web path uses, with the
/// same body: `{ data, view, name }`. A second upload path is how one of them
/// comes to skip a check the other has.
struct PlateCaptureRequest: Decodable {
    /// The import route, exactly as the page builds it, e.g.
    /// `/characters/<id>/refsheet/import`. Native never constructs one.
    let url: String
    /// Where the engine is. The page knows; the camera should not have to.
    let apiBase: String
    /// What is being photographed, for the person holding the phone.
    let subject: String
    /// The views to walk, in order. One entry is an ordinary single plate.
    let views: [PlateView]

    struct PlateView: Decodable, Identifiable {
        let key: String      // what the engine stores: "front", "side-left", …
        let label: String    // what a person reads: "Front", "Left side"
        var id: String { key }
    }
}

/// What came back, reported to the page rather than kept here.
struct PlateCaptureResult: Encodable {
    var uploaded: [String] = []
    var failed: [String: String] = [:]
    var cancelled = false
}

// ── lenses ───────────────────────────────────────────────────────────────────

/// A physical rear camera, and what to call it.
///
/// Only the three BUILT-IN cameras are offered. The 28mm and 35mm settings a
/// phone also shows are digital crops of the main sensor rather than separate
/// lenses, so they belong to zoom, not to this picker — offering them here
/// would present a crop as though it were optics.
struct PlateLens: Identifiable, Equatable {
    let id: String                       // the device's uniqueID
    let device: AVCaptureDevice
    let label: String                    // "24mm", or the plain name if the angle is unknown

    static func == (a: PlateLens, b: PlateLens) -> Bool { a.id == b.id }

    /// The 35mm-equivalent focal length of a lens with this horizontal field of view.
    ///
    /// PCC-001 asked for `focalLengthIn35mmFilm`, and THAT SYMBOL DOES NOT EXIST
    /// in AVFoundation — checked against iPhoneOS26.1.sdk. It is an EXIF key,
    /// `kCGImagePropertyExifFocalLenIn35mmFilm` in ImageIO, written onto a
    /// photograph that has already been taken. A picker is read BEFORE anything
    /// is shot, so it cannot be labelled from it.
    ///
    /// `AVCaptureDeviceFormat.videoFieldOfView` is published before capture and
    /// the geometry from there is exact: a 35mm frame is 36mm wide, so half of
    /// it subtends atan(18/f).
    ///
    /// The guard is not defensive tidiness. That property is documented "if
    /// field of view is unknown, a value of 0 is returned" — and tan(0) is 0,
    /// so 18/0 is infinity, and `Int(Double.infinity)` TRAPS. Unguarded, this
    /// does not mislabel a lens, it crashes the camera on exactly the device
    /// whose format cannot report an angle.
    static func equivalentFocalMM(fovDegrees: Float) -> Int? {
        guard fovDegrees > 1, fovDegrees < 179 else { return nil }
        let half = Double(fovDegrees) / 2 * .pi / 180
        let mm = 18.0 / tan(half)
        guard mm.isFinite, mm > 0, mm < 2000 else { return nil }
        return Int(mm.rounded())
    }

    /// A plain name, for a lens whose format publishes no angle.
    static func fallbackName(_ type: AVCaptureDevice.DeviceType) -> String {
        switch type {
        case .builtInUltraWideCamera: return "Ultra Wide"
        case .builtInTelephotoCamera: return "Telephoto"
        default:                      return "Wide"
        }
    }

    init(device: AVCaptureDevice) {
        self.id = device.uniqueID
        self.device = device
        if let mm = PlateLens.equivalentFocalMM(fovDegrees: device.activeFormat.videoFieldOfView) {
            self.label = "\(mm)mm"
        } else {
            self.label = PlateLens.fallbackName(device.deviceType)
        }
    }

    /// What this device actually has, widest first.
    ///
    /// Built from what DiscoverySession RETURNS, never from what was asked for:
    /// a two-lens phone must offer two, and building the list from the request
    /// would offer a telephoto that is not there and fail at selection.
    static func discover() -> [PlateLens] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInUltraWideCamera, .builtInWideAngleCamera, .builtInTelephotoCamera],
            mediaType: .video,
            position: .back
        ).devices.map(PlateLens.init(device:))
    }
}

// ── the camera ───────────────────────────────────────────────────────────────

/// The capture session, and the one honest answer when there is no camera.
///
/// The simulator has none, and `AVCaptureDevice.default` returns nil there. A
/// black screen with a shutter that does nothing is indistinguishable from a
/// broken app; saying so is the whole difference.
@MainActor
final class PlateCameraModel: NSObject, ObservableObject {
    enum State: Equatable {
        case idle
        case ready
        case unavailable(String)
    }

    @Published private(set) var state: State = .idle
    @Published var lastShot: UIImage?

    /// What this phone has, and which one is live. Empty until `configure()`.
    @Published private(set) var lenses: [PlateLens] = []
    @Published private(set) var lens: PlateLens?

    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private var input: AVCaptureDeviceInput?
    private var onCapture: ((UIImage?) -> Void)?

    func start() {
        guard state == .idle else { return }

        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configure()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                Task { @MainActor in
                    guard let self else { return }
                    granted ? self.configure()
                            : self.fail("Camera access was declined. Settings → Film Engine → Camera.")
                }
            }
        case .denied, .restricted:
            fail("Camera access is off for Film Engine. Settings → Film Engine → Camera.")
        @unknown default:
            fail("The camera is unavailable on this device.")
        }
    }

    private func fail(_ why: String) { state = .unavailable(why) }

    private func configure() {
        // The rear cameras: a reference plate is a photograph of a thing in the
        // world, never of the person holding the phone.
        lenses = PlateLens.discover()

        // The wide is the default because it is the one every phone has and the
        // one a plate is normally shot on — the ultra-wide barrel-distorts the
        // edges of a subject, which then conditions every frame it appears in.
        let start = lenses.first { $0.device.deviceType == .builtInWideAngleCamera } ?? lenses.first
        guard let start, let first = try? AVCaptureDeviceInput(device: start.device) else {
            fail("This device has no rear camera — a simulator does not have one. "
                 + "Shoot on a real phone, or use Upload to send a picture you already have.")
            return
        }

        session.beginConfiguration()
        session.sessionPreset = .photo          // full sensor: a plate is cropped from later
        if session.canAddInput(first) { session.addInput(first) }
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()

        input = first
        lens = start
        state = .ready
        Task.detached { [session] in session.startRunning() }
    }

    /// Change lens.
    ///
    /// The swap happens inside begin/commitConfiguration because a session
    /// reconfigured outside one can be left with no input at all — a black
    /// preview with a working shutter, which is the failure this whole file is
    /// written against. If the new lens cannot be opened the old input goes
    /// back, so a failed switch leaves a working camera rather than none.
    func select(_ next: PlateLens) {
        guard state == .ready, next != lens else { return }
        guard let replacement = try? AVCaptureDeviceInput(device: next.device) else { return }

        session.beginConfiguration()
        if let current = input { session.removeInput(current) }
        if session.canAddInput(replacement) {
            session.addInput(replacement)
            input = replacement
            lens = next
        } else if let current = input, session.canAddInput(current) {
            session.addInput(current)            // put the working lens back
        }
        session.commitConfiguration()
    }

    func stop() {
        guard session.isRunning else { return }
        Task.detached { [session] in session.stopRunning() }
    }

    func shoot(_ done: @escaping (UIImage?) -> Void) {
        guard state == .ready else { done(nil); return }
        onCapture = done
        let settings = AVCapturePhotoSettings()
        settings.flashMode = .off               // a flash on a reference plate is a lighting decision
        output.capturePhoto(with: settings, delegate: self)
    }
}

extension PlateCameraModel: AVCapturePhotoCaptureDelegate {
    nonisolated func photoOutput(_ output: AVCapturePhotoOutput,
                                 didFinishProcessingPhoto photo: AVCapturePhoto,
                                 error: Error?) {
        let image = photo.fileDataRepresentation().flatMap(UIImage.init(data:))
        Task { @MainActor in
            self.lastShot = image
            let cb = self.onCapture
            self.onCapture = nil
            cb?(image)
        }
    }
}

/// The live preview.
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.layer.session = session
        v.layer.videoGravity = .resizeAspectFill
        return v
    }
    func updateUIView(_ view: PreviewView, context: Context) { }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        // swiftlint:disable:next force_cast
        override var layer: AVCaptureVideoPreviewLayer { super.layer as! AVCaptureVideoPreviewLayer }
    }
}

// ── the session UI ───────────────────────────────────────────────────────────

/// Walks the requested views, one shot each, uploading as it goes.
struct PlateCameraView: View {
    let request: PlateCaptureRequest
    let finished: (PlateCaptureResult) -> Void

    @StateObject private var camera = PlateCameraModel()
    @State private var index = 0
    @State private var pending: UIImage?
    @State private var busy = false
    @State private var result = PlateCaptureResult()
    @State private var problem: String?
    @Environment(\.dismiss) private var dismiss

    private var view: PlateCaptureRequest.PlateView? {
        index < request.views.count ? request.views[index] : nil
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            switch camera.state {
            case .unavailable(let why):
                // A reason, not a black screen. The picture the shutter would
                // have taken does not exist and saying why is the only useful
                // thing left.
                VStack(spacing: 16) {
                    Image(systemName: "camera.fill").font(.largeTitle).foregroundStyle(.secondary)
                    Text(why).multilineTextAlignment(.center).padding(.horizontal, 32)
                    Button("Close") { finish(cancelled: true) }.buttonStyle(.borderedProminent)
                }
                .foregroundStyle(.white)

            case .idle:
                ProgressView().tint(.white)

            case .ready:
                if let pending {
                    Image(uiImage: pending).resizable().scaledToFit().ignoresSafeArea()
                } else {
                    CameraPreview(session: camera.session).ignoresSafeArea()
                }
                overlay
            }
        }
        .onAppear { camera.start() }
        .onDisappear { camera.stop() }
    }

    private var overlay: some View {
        VStack {
            // WHICH VIEW, and how far through. The whole reason this is native
            // rather than a file input.
            VStack(spacing: 2) {
                Text(request.subject.uppercased())
                    .font(.system(.footnote, design: .monospaced)).tracking(2)
                Text(view?.label ?? "Done").font(.title3.weight(.medium))
                if request.views.count > 1 {
                    Text("\(min(index + 1, request.views.count)) of \(request.views.count)")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 10).padding(.horizontal, 18)
            .background(.ultraThinMaterial, in: Capsule())
            .padding(.top, 12)

            if let problem {
                Text(problem).font(.footnote).foregroundStyle(.orange)
                    .multilineTextAlignment(.center).padding(.horizontal, 24).padding(.top, 8)
            }

            Spacer()

            // The lens picker sits directly above the shutter, where a thumb
            // already is, and ONLY when there is a choice to make: a phone with
            // one rear camera gets no control rather than a control with one
            // option, which reads as broken.
            //
            // It is hidden while a shot is pending review, because changing
            // lens then would not re-take the picture being judged.
            if pending == nil && camera.lenses.count > 1 {
                HStack(spacing: 8) {
                    ForEach(camera.lenses) { option in
                        Button { camera.select(option) } label: {
                            Text(option.label)
                                .font(.system(.footnote, design: .monospaced))
                                .padding(.vertical, 7).padding(.horizontal, 12)
                                .background(option == camera.lens ? .white : .white.opacity(0.18),
                                            in: Capsule())
                                .foregroundStyle(option == camera.lens ? .black : .white)
                        }
                        .accessibilityLabel("\(option.label) lens")
                        .accessibilityAddTraits(option == camera.lens ? [.isSelected] : [])
                    }
                }
                .padding(.bottom, 18)
            }

            if pending == nil {
                HStack(spacing: 40) {
                    Button("Cancel") { finish(cancelled: true) }
                    Button { take() } label: {
                        Circle().strokeBorder(.white, lineWidth: 4).frame(width: 74, height: 74)
                            .overlay(Circle().fill(.white).frame(width: 60, height: 60))
                    }
                    // Skipping is allowed: a director may not be able to reach
                    // the far side of a thing, and refusing to move on would
                    // strand the whole session on one view.
                    Button("Skip") { advance() }
                }
                .foregroundStyle(.white).padding(.bottom, 34)
            } else {
                HStack(spacing: 28) {
                    Button("Retake") { pending = nil; problem = nil }
                    Button(busy ? "Uploading…" : (index + 1 < request.views.count ? "Use & next" : "Use & finish")) {
                        upload()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(busy)
                }
                .foregroundStyle(.white).padding(.bottom, 34)
            }
        }
    }

    private func take() {
        problem = nil
        camera.shoot { image in
            guard let image else { problem = "That shot did not come back. Try again."; return }
            pending = image
        }
    }

    private func advance() {
        pending = nil
        problem = nil
        if index + 1 < request.views.count { index += 1 } else { finish(cancelled: false) }
    }

    private func upload() {
        guard let image = pending, let view else { return }
        busy = true
        problem = nil
        Task {
            do {
                try await PlateUploader.send(image: image, view: view.key, request: request)
                result.uploaded.append(view.key)
                busy = false
                advance()
            } catch {
                // NAMED, and the shot is KEPT. Losing a photograph because an
                // upload failed would make a director shoot it twice.
                result.failed[view.key] = error.localizedDescription
                problem = "Not uploaded: \(error.localizedDescription)"
                busy = false
            }
        }
    }

    private func finish(cancelled: Bool) {
        camera.stop()
        result.cancelled = cancelled
        finished(result)
        dismiss()
    }
}

// ── the upload ───────────────────────────────────────────────────────────────

enum PlateUploader {
    enum Failure: LocalizedError {
        case badURL, encode, http(Int, String), transport(String)
        var errorDescription: String? {
            switch self {
            case .badURL: return "The engine address is not a URL."
            case .encode: return "That photograph could not be encoded."
            case .http(let code, let why): return why.isEmpty ? "The engine answered \(code)." : why
            case .transport(let why): return why
            }
        }
    }

    /// The SAME route and the SAME body the web page posts. JPEG at 0.9 because
    /// a plate is a photograph, and a 12-megapixel PNG is tens of megabytes
    /// travelling base64 — a third larger again — over a phone's network.
    static func send(image: UIImage, view: String, request: PlateCaptureRequest) async throws {
        guard let data = image.jpegData(compressionQuality: 0.9) else { throw Failure.encode }
        let base = request.apiBase.hasSuffix("/") ? String(request.apiBase.dropLast()) : request.apiBase
        guard let url = URL(string: "\(base)/film\(request.url)") else { throw Failure.badURL }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 120
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "data": "data:image/jpeg;base64,\(data.base64EncodedString())",
            "view": view,
            "name": "\(view).jpg",
        ])

        let (body, response): (Data, URLResponse)
        do { (body, response) = try await URLSession.shared.data(for: req) }
        catch { throw Failure.transport(error.localizedDescription) }

        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            // The engine's own sentence, not a status number. Its refusals name
            // the remedy and a bare 400 does not.
            let why = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])
                .flatMap { $0?["error"] as? String } ?? ""
            throw Failure.http(code, why)
        }
    }
}
