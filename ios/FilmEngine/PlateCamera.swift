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

// ── exposure ─────────────────────────────────────────────────────────────────

/// A metered exposure, held across a turnaround.
///
/// Four views shot on autoexposure disagree about brightness, and the front
/// plate conditions every frame its subject appears in — so the exposure is
/// metered once and held.
///
/// The arithmetic here exists because of PCC-001. `minISO`, `maxISO`,
/// `minExposureDuration` and `maxExposureDuration` belong to
/// `AVCaptureDeviceFormat`, so they CHANGE WITH THE LENS, and AVCaptureDevice
/// documents that only values inside that range are supported — passing one
/// outside raises NSInvalidArgumentException. So changing lens while locked
/// does not merely mismatch a plate, it can crash the camera.
struct ExposureLock: Equatable {
    let seconds: Double
    let iso: Float

    /// The result of fitting an exposure to a format that may not accept it.
    struct Fitted: Equatable {
        let seconds: Double
        let iso: Float
        /// How far off the requested brightness this ended up, in stops. Zero
        /// when the format had room. Reported rather than swallowed: a silently
        /// darker plate looks like the lock worked, and the mismatch is found
        /// after the frames have been generated and paid for.
        let stopsOff: Double
    }

    /// Fit an exposure to what a format actually supports.
    ///
    /// CLAMPING ALONE WOULD BE THE WRONG FIX. Clamping ISO 400 down to a
    /// telephoto's max of 200 makes that view a stop darker — the views then
    /// disagree about brightness, which is the exact failure this lock exists
    /// to prevent. Exposure is duration x ISO, so whatever one term loses is
    /// moved into the other and the brightness is preserved. Only when BOTH are
    /// pinned is it impossible, and then the residual is reported.
    ///
    /// Motion blur is the price of lengthening the duration, and it is the
    /// right trade here: a plate is a static subject, and a brightness mismatch
    /// across a turnaround is visible in every frame generated from it.
    static func fit(seconds: Double, iso: Float,
                    minSeconds: Double, maxSeconds: Double,
                    minISO: Float, maxISO: Float) -> Fitted {
        // A format reporting zeroes or an inverted range is not hypothetical —
        // "0 means unknown" is the same convention that bit videoFieldOfView in
        // PCC-001. Answer something usable rather than dividing by it.
        let loS = min(minSeconds, maxSeconds), hiS = max(minSeconds, maxSeconds)
        let loI = min(minISO, maxISO), hiI = max(minISO, maxISO)
        guard loS > 0, hiS > 0, loI > 0, hiI > 0,
              seconds > 0, iso > 0, seconds.isFinite, iso.isFinite else {
            return Fitted(seconds: max(loS, 0), iso: max(loI, 0), stopsOff: 0)
        }

        let wanted = seconds * Double(iso)          // the brightness to hold

        // Clamp the duration first, then buy back the difference with ISO —
        // and if ISO cannot cover it, spend what is left back on duration.
        var s = min(max(seconds, loS), hiS)
        var i = Float(min(max(wanted / s, Double(loI)), Double(hiI)))
        s = min(max(wanted / Double(i), loS), hiS)

        let got = s * Double(i)
        return Fitted(seconds: s, iso: i, stopsOff: log2(got / wanted))
    }

    /// This lock, fitted to a format's own limits.
    func fitted(minSeconds: Double, maxSeconds: Double,
                minISO: Float, maxISO: Float) -> Fitted {
        ExposureLock.fit(seconds: seconds, iso: iso,
                         minSeconds: minSeconds, maxSeconds: maxSeconds,
                         minISO: minISO, maxISO: maxISO)
    }

    /// "1/60s · ISO 400" — the values, so a wrong lock can be spotted on sight.
    var label: String {
        let shutter = seconds >= 1 ? String(format: "%.1fs", seconds)
                                   : "1/\(Int((1 / seconds).rounded()))s"
        return "\(shutter) · ISO \(Int(iso.rounded()))"
    }
}

/// A metered white balance, held across a turnaround.
///
/// A plate that matches on brightness and not colour still disagrees, so this
/// locks and releases WITH the exposure rather than beside it.
///
/// The rules here are Apple's and they are unusual (AVCaptureDevice.h:1795):
/// gains are normalised to the MINIMUM channel — "R:2 G:2 B:4 will be
/// normalized to R:1 G:1 B:2" — explicitly "to avoid brightness changes", and
/// the 1.0...maxWhiteBalanceGain range is checked AFTER that normalisation. A
/// violation throws NSRangeException, so an unfitted gain crashes the camera
/// rather than tinting a plate.
///
/// `maxWhiteBalanceGain` belongs to the DEVICE, not the format, so PCC-001's
/// picker moves it — the same interaction the exposure ranges have in PCC-002,
/// with the same consequence.
struct WhiteBalanceLock: Equatable {
    let red: Float
    let green: Float
    let blue: Float

    struct Fitted: Equatable {
        let red: Float
        let green: Float
        let blue: Float
        /// How far the delivered cast is from the requested one, in stops on
        /// the worst channel. Zero when the device could express it. Reported
        /// rather than swallowed: a quietly warmer plate looks like the lock
        /// worked, and the mismatch surfaces after the frames are paid for.
        let stopsOff: Double
    }

    /// Fit a metered cast to what a device can actually express.
    ///
    /// Normalising is not clamping and both are needed. Dividing by the minimum
    /// channel preserves the RATIOS — which are the colour — and only changes
    /// the scale, which is why Apple does it to avoid brightness changes.
    /// Clamping after it changes the colour, so it happens only when the cast
    /// is wider than the device can hold, and says so.
    static func fit(red: Float, green: Float, blue: Float, maxGain: Float) -> Fitted {
        // A channel at zero makes the normalisation a division by zero, and NaN
        // propagates straight into setWhiteBalanceModeLocked. The same "0 means
        // unknown" convention has already bitten videoFieldOfView in PCC-001
        // and the exposure ranges in PCC-002.
        let ceiling = maxGain.isFinite && maxGain >= 1 ? maxGain : 1
        guard red.isFinite, green.isFinite, blue.isFinite,
              red > 0, green > 0, blue > 0 else {
            return Fitted(red: 1, green: 1, blue: 1, stopsOff: 0)   // neutral: no cast claimed
        }

        // Apple's rule, verbatim: normalise to the minimum channel.
        let low = min(red, min(green, blue))
        var r = red / low, g = green / low, b = blue / low

        // Only now is the range meaningful. Clamping alters the cast, so the
        // worst channel's shortfall is measured against what was asked for.
        let wanted = (r, g, b)
        r = min(r, ceiling); g = min(g, ceiling); b = min(b, ceiling)

        let drift = max(abs(log2(Double(r / wanted.0))),
                        max(abs(log2(Double(g / wanted.1))), abs(log2(Double(b / wanted.2)))))
        return Fitted(red: r, green: g, blue: b, stopsOff: drift.isFinite ? drift : 0)
    }

    /// This lock, fitted to a device's own ceiling.
    func fitted(maxGain: Float) -> Fitted {
        WhiteBalanceLock.fit(red: red, green: green, blue: blue, maxGain: maxGain)
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

    /// The exposure being held, if any, and what it cost to fit it to the
    /// current lens. Nil means the camera is metering each view on its own,
    /// which is what it did before PCC-002.
    @Published private(set) var exposure: ExposureLock?
    @Published private(set) var exposureWarning: String?

    /// The colour being held, and how it reads. Gains are device-specific and
    /// meaningless to a person, so the temperature is what is shown.
    @Published private(set) var whiteBalance: WhiteBalanceLock?
    @Published private(set) var whiteBalanceLabel: String?

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

    /// Meter what the camera is seeing now, and hold it for the whole walk.
    ///
    /// `exposureDuration` and `ISO` are READ-ONLY on AVCaptureDevice — settable
    /// only through `setExposureModeCustom`, which is why there is no other
    /// path here.
    func lockExposure() {
        guard let device = lens?.device, state == .ready else { return }
        guard device.isExposureModeSupported(.custom) else {
            exposureWarning = "This lens cannot hold a fixed exposure."
            return
        }
        // Read what auto has settled on, then pin exactly that: the point is to
        // keep what the director is already looking at, not to impose a guess.
        let held = ExposureLock(seconds: CMTimeGetSeconds(device.exposureDuration),
                                iso: device.iso)
        exposure = held
        apply(held, to: device)

        // The colour goes with it. A plate that matches on brightness and not
        // colour still disagrees, and two separate affordances would let a
        // director hold one and believe the turnaround was held.
        let gains = device.deviceWhiteBalanceGains
        whiteBalance = WhiteBalanceLock(red: gains.redGain, green: gains.greenGain,
                                        blue: gains.blueGain)
        if let wb = whiteBalance { applyWhiteBalance(wb, to: device) }
    }

    /// Go back to metering each view on its own.
    ///
    /// A subject genuinely can need re-metering — a dark back against a bright
    /// wall — and a lock with no way out would strand the whole session.
    func unlockExposure() {
        exposure = nil
        exposureWarning = nil
        whiteBalance = nil
        whiteBalanceLabel = nil
        guard let device = lens?.device, (try? device.lockForConfiguration()) != nil else { return }
        defer { device.unlockForConfiguration() }
        if device.isExposureModeSupported(.continuousAutoExposure) {
            device.exposureMode = .continuousAutoExposure
        }
        // Released together, or the colour stays pinned after the director has
        // asked for auto — which reads as the release not working.
        if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
            device.whiteBalanceMode = .continuousAutoWhiteBalance
        }
    }

    /// Pin a held colour onto a device, refitted to ITS ceiling.
    ///
    /// `maxWhiteBalanceGain` is a property of the DEVICE, so the lens picker
    /// moves it — and AVCaptureDevice.h:1795 throws NSRangeException on a gain
    /// outside 1.0...maxWhiteBalanceGain after normalisation.
    private func applyWhiteBalance(_ held: WhiteBalanceLock, to device: AVCaptureDevice) {
        // AVCaptureDevice.h:1715 — where custom gains are unsupported, passing
        // anything but AVCaptureWhiteBalanceGainsCurrent raises an exception.
        guard device.isLockingWhiteBalanceWithCustomDeviceGainsSupported,
              (try? device.lockForConfiguration()) != nil else { return }
        defer { device.unlockForConfiguration() }

        let fit = held.fitted(maxGain: device.maxWhiteBalanceGain)
        let gains = AVCaptureDevice.WhiteBalanceGains(redGain: fit.red, greenGain: fit.green,
                                               blueGain: fit.blue)
        // The temperature is read from the FITTED gains, never the requested
        // ones: temperatureAndTintValues throws on an out-of-range input too.
        let t = device.temperatureAndTintValues(for: gains)
        whiteBalanceLabel = "\(Int(t.temperature.rounded()))K"
        if abs(fit.stopsOff) >= 0.05 {
            exposureWarning = String(format: "This lens cannot hold that colour — %.1f stops of cast.",
                                     fit.stopsOff)
        }
        device.setWhiteBalanceModeLocked(with: gains, completionHandler: nil)
    }

    /// Pin a held exposure onto a device, refitted to ITS format.
    ///
    /// The refit is the whole reason PCC-001 had to land first: the ranges
    /// belong to the format, so an exposure metered on the wide can be illegal
    /// on the telephoto, and passing it raises NSInvalidArgumentException.
    private func apply(_ held: ExposureLock, to device: AVCaptureDevice) {
        guard device.isExposureModeSupported(.custom),
              (try? device.lockForConfiguration()) != nil else { return }
        defer { device.unlockForConfiguration() }

        let f = device.activeFormat
        let fit = held.fitted(minSeconds: CMTimeGetSeconds(f.minExposureDuration),
                              maxSeconds: CMTimeGetSeconds(f.maxExposureDuration),
                              minISO: f.minISO, maxISO: f.maxISO)

        // Naming the shortfall is the point: a plate that is quietly a stop
        // darker looks like the lock worked.
        exposureWarning = abs(fit.stopsOff) < 0.05 ? nil
            : String(format: "This lens cannot reach that exposure — %.1f stops off.", fit.stopsOff)

        device.setExposureModeCustom(duration: CMTime(seconds: fit.seconds, preferredTimescale: 1_000_000),
                                     iso: fit.iso, completionHandler: nil)
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
            // A lock lives on the DEVICE, so the new lens has none — and the
            // held values may be outside its format's range. Re-applying
            // refits them to the new format; without this the UI reads LOCK
            // while the next plate is metered automatically.
            if let held = exposure { apply(held, to: next.device) }
            if let wb = whiteBalance { applyWhiteBalance(wb, to: next.device) }
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

            // The exposure lock, and what it is holding. Shown above the lens
            // picker because it applies to the whole turnaround while the lens
            // applies to this shot — and because an invisible lock is
            // indistinguishable from none, so a director re-meters by habit.
            if pending == nil {
                VStack(spacing: 4) {
                    Button {
                        camera.exposure == nil ? camera.lockExposure() : camera.unlockExposure()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: camera.exposure == nil ? "sun.max" : "lock.fill")
                            Text(camera.exposure.map { e in
                                // The colour rides on the same chip: they lock
                                // together, so showing them apart would imply
                                // they can be held apart.
                                "LOCK · \(e.label)"
                                    + (camera.whiteBalanceLabel.map { " · \($0)" } ?? "")
                            } ?? "Auto exposure & colour")
                                .font(.system(.footnote, design: .monospaced))
                        }
                        .padding(.vertical, 7).padding(.horizontal, 12)
                        .background(camera.exposure == nil ? .white.opacity(0.18) : .yellow,
                                    in: Capsule())
                        .foregroundStyle(camera.exposure == nil ? .white : .black)
                    }
                    .accessibilityLabel(camera.exposure == nil
                        ? "Lock exposure and colour for the whole turnaround"
                        : "Exposure locked at \(camera.exposure?.label ?? ""). Tap to release.")

                    // A lens that cannot reach the held exposure delivers a
                    // quietly darker plate, which looks like the lock worked.
                    if let warning = camera.exposureWarning {
                        Text(warning).font(.caption2).foregroundStyle(.orange)
                            .multilineTextAlignment(.center).padding(.horizontal, 24)
                    }
                }
                .padding(.bottom, 10)
            }

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
