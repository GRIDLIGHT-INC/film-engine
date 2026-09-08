import SwiftUI
import AVFoundation
import CoreMotion
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
    /// The project's delivery aspect, as a number. The page already knows it and
    /// already parses it in one place; the camera is told rather than guessing,
    /// so a 9:16 deliverable guides 9:16. Absent means "no guide".
    let aspect: Double?

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

/// Where the director tapped, held for the turnaround.
///
/// THIS BREAKS THE PATTERN OF THE TWO LOCKS BEFORE IT, deliberately. An
/// exposure and a white balance mean the same thing on any lens, so PCC-002 and
/// PCC-003 carry the VALUE across a lens change and refit it. A lens position
/// does not: AVCaptureDevice.h:1265 says it "does not correspond to an exact
/// physical distance, nor does it represent a consistent focus distance from
/// device to device". So 0.6 on the wide is a different distance from 0.6 on
/// the telephoto, and re-applying the number after a lens change focuses
/// somewhere nobody chose.
///
/// What IS meaningful across lenses is the POINT — the same part of the frame.
/// So the point is what is stored and carried, and the position is re-derived
/// by focusing again on the new lens.
struct FocusLock: Equatable {
    /// Normalised into the device's own space: (0,0) top left, (1,1) bottom
    /// right, per :1155.
    let x: Double
    let y: Double

    /// Fit a converted tap into the range the device documents.
    ///
    /// `captureDevicePointConverted` can land a hair outside at the very edge,
    /// and setFocusPointOfInterest throws where the point is unsupported. A
    /// non-finite tap answers the CENTRE — the documented default — rather than
    /// propagating NaN into the device.
    static func point(x: Double, y: Double) -> FocusLock {
        guard x.isFinite, y.isFinite else { return FocusLock(x: 0.5, y: 0.5) }
        return FocusLock(x: min(max(x, 0), 1), y: min(max(y, 0), 1))
    }
}

// ── guides ───────────────────────────────────────────────────────────────────

/// The arithmetic behind the level and the aspect guide.
///
/// Pure by construction: it takes numbers and returns numbers, so it can be
/// exercised off-device — a simulator has no camera and no motion.
enum PlateGuides {

    /// Where a delivery aspect sits inside the sensor, as a normalised rect.
    ///
    /// Returned in capture space (0...1 of the sensor) rather than in screen
    /// points, because the preview is `.resizeAspectFill` and therefore CROPS —
    /// only `layerRectConverted(fromMetadataOutputRect:)` knows how. Placing it
    /// by hand draws the guide in the wrong place, silently.
    ///
    /// Letterbox and pillarbox are one computation with the comparison
    /// reversed, which is why this is worth its own function: an inverted
    /// version still draws a tidy centred rectangle, it just marks the wrong
    /// crop, and a director frames to it.
    static func deliveryRect(delivery: Double, sensor: Double) -> (x: Double, y: Double,
                                                                  width: Double, height: Double) {
        // A project with no aspect recorded, or a malformed one, guides the
        // WHOLE frame. A zero-area guide is invisible and reads as the feature
        // being broken; a NaN rect is undefined behaviour in CoreGraphics.
        guard delivery.isFinite, sensor.isFinite, delivery > 0, sensor > 0 else {
            return (0, 0, 1, 1)
        }
        if abs(delivery - sensor) < 1e-9 { return (0, 0, 1, 1) }

        if delivery > sensor {
            // Wider than the sensor: full width, and height given back.
            let h = sensor / delivery
            return (0, (1 - h) / 2, 1, h)
        }
        // Narrower: full height, and width given back.
        let w = delivery / sensor
        return ((1 - w) / 2, 0, w, 1)
    }

    /// How the phone is being held, from the gravity vector.
    ///
    /// iOS device coordinates: x right, y up, z out of the screen. Gravity
    /// points DOWN, so an upright phone reads (0, -1, 0).
    ///
    /// `rollIsMeaningful` is the field that matters and it is not defensive
    /// tidiness. Roll is the rotation about the camera's axis, read from the
    /// HORIZONTAL component of gravity — and when the phone points straight
    /// down at a table, which is an ordinary way to photograph a prop, that
    /// component vanishes and roll has no value at all. `atan2(0, 0)` is 0 in
    /// Swift, so a naive reading says "0 degrees, level" with total confidence
    /// at exactly the moment it knows nothing. A confident wrong level is worse
    /// than no level: a director trusts it and shoots crooked.
    static func level(gx: Double, gy: Double, gz: Double)
        -> (rollDegrees: Double, pitchDegrees: Double, rollIsMeaningful: Bool) {
        guard gx.isFinite, gy.isFinite, gz.isFinite else { return (0, 0, false) }

        let horizontal = (gx * gx + gy * gy).squareRoot()
        let pitch = horizontal == 0 && gz == 0 ? 0
                                              : atan2(gz, horizontal) * 180 / .pi

        // Below about six degrees of horizontal gravity the roll is noise; the
        // threshold is named rather than magic, and the answer is "we cannot
        // tell" rather than a number.
        let meaningful = horizontal > 0.1
        let roll = meaningful ? atan2(gx, -gy) * 180 / .pi : 0
        return (roll, pitch, meaningful)
    }
}

/// What a frame was actually shot at.
///
/// Read from the captured photo's EXIF rather than from the locks, because a
/// plate shot on full auto is still worth diagnosing — and because the locks
/// say what was ASKED for while EXIF says what the sensor did.
///
/// This closes a loop from PCC-001. `focalLengthIn35mmFilm` is exactly the EXIF
/// key that could NOT label the lens picker, because it is written after the
/// shutter. Here the shot has happened, so it is the right source — and it is
/// the true 35mm equivalent for that frame rather than one derived from the
/// format's field of view.
struct CaptureSettings {
    var lens: String?
    var iso: Double?
    var shutterSeconds: Double?
    var whiteBalanceK: Double?

    /// The body the engine's `capture` block expects. Absent fields are OMITTED
    /// rather than sent as null: the route treats an absent field as "not
    /// recorded", and a null would be a value it has to decide how to read.
    var json: [String: Any] {
        var out: [String: Any] = [:]
        if let lens { out["lens"] = lens }
        if let iso { out["iso"] = iso }
        if let shutterSeconds { out["shutter_s"] = shutterSeconds }
        if let whiteBalanceK { out["white_balance_k"] = whiteBalanceK }
        return out
    }

    /// Read what the sensor actually did, from the frame's own metadata.
    static func from(photo: AVCapturePhoto, fallbackLens: String?, whiteBalanceK: Double?)
        -> CaptureSettings {
        var s = CaptureSettings()
        s.lens = fallbackLens
        s.whiteBalanceK = whiteBalanceK

        let exif = photo.metadata[kCGImagePropertyExifDictionary as String] as? [String: Any]
        if let mm = exif?[kCGImagePropertyExifFocalLenIn35mmFilm as String] as? Double, mm > 0 {
            // The frame's own answer beats the picker's label.
            s.lens = "\(Int(mm.rounded()))mm"
        }
        if let isos = exif?[kCGImagePropertyExifISOSpeedRatings as String] as? [Double],
           let first = isos.first {
            s.iso = first
        }
        if let t = exif?[kCGImagePropertyExifExposureTime as String] as? Double, t > 0 {
            s.shutterSeconds = t
        }
        return s
    }
}

/// How much of a frame the monitoring tools actually read.
///
/// At `sessionPreset = .photo` a frame is 4032x3024 — 12.2 million pixels.
/// Reading every one of them thirty times a second is not slow, it is
/// impossible, so peaking and the exposure warning walk a STRIDE.
///
/// A stride of zero is not a wrong number. `stride(from: 0, to: w, by: 0)` does
/// not terminate: the app freezes with the camera open, and the only symptom is
/// that the shutter stops responding. Every path here returns at least 1.
enum FrameAnalysis {
    /// The sampling budget in pixels. 65_536 is a 256x256-equivalent, which is
    /// ample for finding edges and clipped highlights and is ~190x less work
    /// than the full frame.
    static let budget = 65_536

    /// Stride to walk, and the dimensions that stride actually yields.
    ///
    /// Both are returned because a consumer allocates against them — PCC-008
    /// and PCC-009 are both consumers, and dimensions that disagree with the
    /// stride size every buffer wrongly.
    static func plan(width: Int, height: Int, budget: Int = budget)
        -> (stride: Int, width: Int, height: Int) {
        guard width > 0, height > 0 else { return (1, 0, 0) }

        // A caller asking for a budget of nothing gets the smallest sample
        // rather than a division by zero.
        let cap = max(budget, 1)
        let pixels = width * height

        /*
         * No early return for an already-small frame, and that is deliberate.
         *
         * One was written and then deleted: for any frame under the budget the
         * general path already yields stride 1 and the full dimensions —
         * pixels/cap <= 1, so the square root is <= 1 and rounds up to exactly
         * 1, and the loop below runs zero times. The branch could not change an
         * outcome for any input, and unexercised code that looks like a
         * safeguard is worse than none: it reads as covering a case nobody
         * checked. Proven by mutation — deleting it changed no answer.
         */
        var s = Int((Double(pixels) / Double(cap)).squareRoot().rounded(.up))
        s = max(1, min(s, max(width, height)))
        // The square root rounds to a stride that can still be a hair over.
        // Bounded by the longest edge, where the sample is one pixel.
        while s < max(width, height),
              ((width + s - 1) / s) * ((height + s - 1) / s) > cap { s += 1 }

        return (s, (width + s - 1) / s, (height + s - 1) / s)
    }
}

/// Where the picture is SHARP.
///
/// Apple ships no peaking API; every implementation computes it per frame. This
/// reads the luma plane PCC-007 delivers and marks pixels whose local gradient
/// is steep enough to be in focus.
///
/// THE THRESHOLD IS ABSOLUTE, AND THAT IS THE WHOLE FEATURE. A relative one —
/// peak the top N% of gradients — always finds a top N%, so the overlay would
/// look the same in focus and out of it, and racking focus would change
/// nothing. Sharpness is an absolute property of the picture: a defocused edge
/// crosses the same brightness range over more pixels, so its gradient is
/// lower. Locking exposure (PCC-002) is what keeps that stable across a
/// turnaround.
extension FocusPeaking {
    /// Read the luma plane out of a capture buffer and run the detector.
    ///
    /// Separate from `peaks` so the arithmetic stays pure and testable without
    /// a camera — a simulator produces no CVPixelBuffer at all.
    static func read(_ buffer: CVPixelBuffer,
                     plan: (stride: Int, width: Int, height: Int)) -> [(x: Int, y: Int)]? {
        /*
         * Locked for the read. CVPixelBufferGetBaseAddressOfPlane is valid only
         * between lock and unlock; outside it the address is undefined and
         * works right up until the frame is recycled underneath.
         *
         * .readOnly because a write lock on a capture buffer forces a copy of
         * every frame.
         */
        guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { return nil }
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }

        /*
         * PLANE 0 IS LUMA. The format is 420YpCbCr8BiPlanarFullRange: plane 0
         * is full-resolution brightness, plane 1 is interleaved CbCr at half
         * resolution. Reading plane 1 gives colour edges at half the detail —
         * plausible on screen and wrong.
         *
         * And the row stride is read PER PLANE. The buffer-wide bytesPerRow is
         * a different number, and using it is the same padding bug wearing a
         * different hat.
         */
        guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return nil }
        let rowBytes = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        let w = CVPixelBufferGetWidthOfPlane(buffer, 0)
        let h = CVPixelBufferGetHeightOfPlane(buffer, 0)

        let luma = [UInt8](UnsafeBufferPointer(
            start: base.assumingMemoryBound(to: UInt8.self), count: rowBytes * h))
        return peaks(luma: luma, width: w, height: h, bytesPerRow: rowBytes, stride: plan.stride)
    }
}

enum FocusPeaking {
    /// Gradient magnitude at which a pixel counts as in focus, on 8-bit luma.
    ///
    /// A hard edge on a real subject runs to 200+; a defocused one on the same
    /// subject is single digits per pixel. 24 sits well clear of sensor noise
    /// and well below anything genuinely sharp.
    static let threshold = 24

    /// The sampled points that are in focus, in STRIDED coordinates.
    ///
    /// Returned in the sampled grid rather than in source pixels because that
    /// is what the overlay scales from — and because returning source
    /// coordinates would invite a consumer to re-derive the stride and get a
    /// different answer.
    static func peaks(luma: [UInt8], width: Int, height: Int, bytesPerRow: Int,
                      stride: Int, threshold: Int = threshold) -> [(x: Int, y: Int)] {
        let step = max(1, stride)
        // A row stride shorter than the width is a malformed geometry, and
        // reading it is not a wrong answer but a crash.
        guard width > 0, height > 0, bytesPerRow >= width,
              luma.count >= bytesPerRow * height else { return [] }

        var out: [(x: Int, y: Int)] = []
        var sy = 0
        var y = step
        while y < height - step {
            var sx = 0
            var x = step
            while x < width - step {
                /*
                 * INDEXED BY bytesPerRow, NEVER BY WIDTH. CVPixelBuffer rows are
                 * padded to an alignment, so a plane's row stride is wider than
                 * its picture. Using width reads into the padding and then walks
                 * progressively further out of line down the frame — a diagonal
                 * smear of phantom edges that looks like a real detection.
                 */
                let here = y * bytesPerRow + x
                let dx = Int(luma[here + step]) - Int(luma[here - step])
                let dy = Int(luma[(y + step) * bytesPerRow + x])
                       - Int(luma[(y - step) * bytesPerRow + x])
                if abs(dx) + abs(dy) >= threshold { out.append((x: sx, y: sy)) }
                x += step; sx += 1
            }
            y += step; sy += 1
        }
        return out
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
    /// What the frame currently under review was shot at.
    @Published private(set) var lastSettings: CaptureSettings?

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
    /// The same temperature as a number, for the record kept with the plate.
    /// The label is for reading; a stored "5600K" would have to be re-parsed.
    private(set) var whiteBalanceKelvin: Double?

    /// Where focus is held, if it is. Stored as a POINT rather than a lens
    /// position, because only the point survives a lens change meaningfully.
    @Published private(set) var focus: FocusLock?

    /// How the phone is being held. `rollIsMeaningful` is false where the
    /// phone points straight up or down and roll has no value.
    @Published private(set) var tilt: (rollDegrees: Double, pitchDegrees: Double,
                                       rollIsMeaningful: Bool) = (0, 0, false)

    private let motion = CMMotionManager()

    /// Start reporting how the phone is held. Silent where there is no motion
    /// hardware — a simulator — rather than showing a level stuck at zero.
    func startLevel() {
        guard motion.isDeviceMotionAvailable, !motion.isDeviceMotionActive else { return }
        motion.deviceMotionUpdateInterval = 1.0 / 30
        motion.startDeviceMotionUpdates(to: .main) { [weak self] m, _ in
            guard let self, let g = m?.gravity else { return }
            self.tilt = PlateGuides.level(gx: g.x, gy: g.y, gz: g.z)
        }
    }

    func stopLevel() { motion.stopDeviceMotionUpdates() }

    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    /*
     * Frames for the monitoring tools, ALONGSIDE the preview layer rather than
     * instead of it.
     *
     * Replacing the layer with an MTKView is the obvious reading of "frame
     * access" and it would delete `captureDevicePointConverted` and
     * `layerRectConverted` — the two transforms PCC-004 and PCC-005
     * deliberately refused to hand-roll, across six call sites. The layer keeps
     * displaying; this only hands frames to the analysis.
     */
    private let frames = AVCaptureVideoDataOutput()
    /*
     * SERIAL, and not main. AVCaptureVideoDataOutput.h:56 — "A serial dispatch
     * queue must be used to guarantee that video frames will be delivered in
     * order", and a nil queue throws NSInvalidArgumentException. Not main
     * because :52 says a blocked queue drops frames, and analysing a
     * multi-megapixel frame on main stutters every control on screen.
     */
    private let frameQueue = DispatchQueue(label: "film-engine.plate.frames")
    private var input: AVCaptureDeviceInput?
    private var onCapture: ((UIImage?) -> Void)?

    /*
     * What the monitoring tools read. Called on `frameQueue`, never on main —
     * a consumer that needs the main actor hops there itself, so one slow
     * consumer cannot stall the delivery of every later frame.
     *
     * PCC-008 (focus peaking) and PCC-009 (the exposure warning) are the
     * consumers this exists for. A data output whose frames reach nothing is
     * the same write-only preview in a more expensive form.
     */
    typealias FrameConsumer = (CVPixelBuffer, (stride: Int, width: Int, height: Int)) -> Void

    /*
     * Behind a lock, NOT `nonisolated(unsafe)`.
     *
     * That marker is the compiler saying it cannot prove the access is safe and
     * the author replying that it is. Here the reply would be false: this is
     * written on the main actor (the view sets it, stop() clears it) and read
     * on the frame queue thirty times a second, so releasing the closure while
     * the other thread loads it can crash — rarely, under load, which is the
     * worst shape of bug to find.
     */
    private let frameLock = NSLock()
    nonisolated(unsafe) private var _onFrame: FrameConsumer?

    nonisolated var onFrame: FrameConsumer? {
        get { frameLock.lock(); defer { frameLock.unlock() }; return _onFrame }
        set { frameLock.lock(); defer { frameLock.unlock() }; _onFrame = newValue }
    }

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

        /*
         * Stated rather than inherited: without it the device hands over
         * whatever plane layout it prefers, which differs by hardware, and the
         * analysis would read a layout it was not written for and produce a
         * plausible wrong answer rather than an error.
         *
         * Late frames are DISCARDED. For monitoring the newest frame is the
         * only one worth having — a stale one is a lie about what the camera is
         * pointing at — and :52 warns that retaining them grows memory until
         * the app is killed.
         */
        frames.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String:
                                    kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        frames.alwaysDiscardsLateVideoFrames = true
        frames.setSampleBufferDelegate(self, queue: frameQueue)
        if session.canAddOutput(frames) { session.addOutput(frames) }

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
        whiteBalanceKelvin = nil
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
        whiteBalanceKelvin = Double(t.temperature)
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

    /// Focus on what the director tapped, then hold it for the walk.
    ///
    /// The order is the documented one and it is not optional: :1155 says
    /// "setting focusPointOfInterest alone does not initiate a focus
    /// operation. After setting focusPointOfInterest, call -setFocusMode: to
    /// apply the new point of interest." Setting only the point draws a focus
    /// square and focuses nothing.
    func lockFocus(at point: FocusLock) {
        guard let device = lens?.device, state == .ready else { return }
        focus = point
        applyFocus(point, to: device)
    }

    /// Back to autofocus. A view genuinely can need re-focusing — a prop held
    /// closer than the last one — and a lock with no way out strands the walk.
    func unlockFocus() {
        focus = nil
        guard let device = lens?.device,
              device.isFocusModeSupported(.continuousAutoFocus),
              (try? device.lockForConfiguration()) != nil else { return }
        device.focusMode = .continuousAutoFocus
        device.unlockForConfiguration()
    }

    /// Point the device at a spot and hold focus there.
    ///
    /// Re-focusing rather than re-applying a number is what makes this correct
    /// across a lens change; see FocusLock's own note.
    private func applyFocus(_ at: FocusLock, to device: AVCaptureDevice) {
        guard (try? device.lockForConfiguration()) != nil else { return }
        defer { device.unlockForConfiguration() }

        if device.isFocusPointOfInterestSupported {
            device.focusPointOfInterest = CGPoint(x: at.x, y: at.y)
        }
        // The mode is what actually starts the operation.
        if device.isFocusModeSupported(.autoFocus) {
            device.focusMode = .autoFocus
        }
        // Then pin it wherever that lands. AVCaptureLensPositionCurrent is used
        // rather than a stored number because :1125 says a custom position
        // throws where isLockingFocusWithCustomLensPositionSupported is false,
        // and because a number carried from another lens is meaningless anyway.
        if device.isLockingFocusWithCustomLensPositionSupported {
            device.setFocusModeLocked(lensPosition: AVCaptureDevice.currentLensPosition,
                                      completionHandler: nil)
        } else if device.isFocusModeSupported(.locked) {
            device.focusMode = .locked
        }
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
            // The POINT is re-focused on the new lens. The lens position is
            // deliberately NOT carried: :1265 says it is not a consistent
            // distance across devices, so the number would focus elsewhere.
            if let at = focus { applyFocus(at, to: next.device) }
        } else if let current = input, session.canAddInput(current) {
            session.addInput(current)            // put the working lens back
        }
        session.commitConfiguration()
    }

    func stop() {
        // Detach FIRST. A delegate left attached holds a strong reference and
        // keeps the queue awake after the sheet is dismissed — the camera
        // indicator stays lit and frames keep arriving for nobody.
        frames.setSampleBufferDelegate(nil, queue: nil)
        onFrame = nil
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

extension PlateCameraModel: AVCaptureVideoDataOutputSampleBufferDelegate {
    nonisolated func captureOutput(_ output: AVCaptureOutput,
                                   didOutput sampleBuffer: CMSampleBuffer,
                                   from connection: AVCaptureConnection) {
        guard let consumer = onFrame,
              let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        // The subsample is planned HERE, once, rather than by each consumer:
        // two consumers computing it separately is how they come to walk the
        // same frame at different strides and disagree about where an edge is.
        let plan = FrameAnalysis.plan(width: CVPixelBufferGetWidth(pixels),
                                      height: CVPixelBufferGetHeight(pixels))
        consumer(pixels, plan)
    }
}

extension PlateCameraModel: AVCapturePhotoCaptureDelegate {
    nonisolated func photoOutput(_ output: AVCapturePhotoOutput,
                                 didFinishProcessingPhoto photo: AVCapturePhoto,
                                 error: Error?) {
        let image = photo.fileDataRepresentation().flatMap(UIImage.init(data:))
        Task { @MainActor in
            self.lastShot = image
            // Read from THIS frame, so a plate shot on auto records what the
            // sensor actually did rather than what the locks were holding.
            self.lastSettings = CaptureSettings.from(
                photo: photo,
                fallbackLens: self.lens?.label,
                whiteBalanceK: self.whiteBalanceKelvin)
            let cb = self.onCapture
            self.onCapture = nil
            cb?(image)
        }
    }
}

/// The live preview.
/// The three guides, drawn over the preview.
///
/// A UIView rather than SwiftUI shapes because the aspect rect must be placed
/// by `layerRectConverted(fromMetadataOutputRect:)` — the preview is
/// `.resizeAspectFill` and therefore CROPS, and only the layer knows how. This
/// is the same lesson as PCC-004's tap conversion: use Apple's transform, or
/// draw in the wrong place silently.
final class GuideOverlay: UIView {
    var showLevel = true
    var showGrid = true
    var showAspect = true
    var showPeaking = false
    /// Sampled points that are in focus, in the strided grid the detector
    /// walked, plus that grid's size so they can be scaled onto the view.
    var peaks: [(x: Int, y: Int)] = []
    var peakGrid: (width: Int, height: Int) = (0, 0)
    var aspect: Double? = nil
    var tilt: (rollDegrees: Double, pitchDegrees: Double, rollIsMeaningful: Bool) = (0, 0, false)
    /// Supplied by the preview, because only it can convert capture space.
    var convert: ((CGRect) -> CGRect)? = nil

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        ctx.setLineWidth(1)

        if showGrid {
            ctx.setStrokeColor(UIColor.white.withAlphaComponent(0.35).cgColor)
            for i in 1...2 {
                let x = rect.width * CGFloat(i) / 3, y = rect.height * CGFloat(i) / 3
                ctx.move(to: CGPoint(x: x, y: 0)); ctx.addLine(to: CGPoint(x: x, y: rect.height))
                ctx.move(to: CGPoint(x: 0, y: y)); ctx.addLine(to: CGPoint(x: rect.width, y: y))
            }
            ctx.strokePath()
        }

        if showAspect, let a = aspect {
            // The sensor is 4:3 at .photo — the preset the session is
            // configured with. Stated here rather than assumed elsewhere.
            let r = PlateGuides.deliveryRect(delivery: a, sensor: 4.0 / 3.0)
            let capture = CGRect(x: r.x, y: r.y, width: r.width, height: r.height)
            let onScreen = convert?(capture) ?? rect
            ctx.setStrokeColor(UIColor.systemYellow.withAlphaComponent(0.9).cgColor)
            ctx.setLineWidth(2)
            ctx.stroke(onScreen)
        }

        if showPeaking, peakGrid.width > 0, peakGrid.height > 0 {
            // Scaled from the SAMPLED grid, which is what the detector returns
            // — never from source pixels, which would mean re-deriving the
            // stride here and getting a different answer from the detector.
            let sx = rect.width / CGFloat(peakGrid.width)
            let sy = rect.height / CGFloat(peakGrid.height)
            ctx.setFillColor(UIColor.systemGreen.withAlphaComponent(0.85).cgColor)
            for p in peaks {
                ctx.fill(CGRect(x: CGFloat(p.x) * sx, y: CGFloat(p.y) * sy,
                                width: max(sx, 1.5), height: max(sy, 1.5)))
            }
        }

        if showLevel {
            // A roll that means nothing is drawn differently and labelled,
            // never drawn as a confident horizon.
            let c = CGPoint(x: rect.midX, y: rect.midY)
            let live = tilt.rollIsMeaningful
            ctx.setStrokeColor((live && abs(tilt.rollDegrees) < 1
                                ? UIColor.systemGreen : UIColor.white.withAlphaComponent(live ? 0.85 : 0.3)).cgColor)
            ctx.setLineWidth(2)
            let angle = live ? CGFloat(tilt.rollDegrees * .pi / 180) : 0
            let half: CGFloat = 44
            ctx.move(to: CGPoint(x: c.x - cos(angle) * half, y: c.y - sin(angle) * half))
            ctx.addLine(to: CGPoint(x: c.x + cos(angle) * half, y: c.y + sin(angle) * half))
            ctx.strokePath()
        }
    }
}

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    /// The guides to draw over the picture, and what they need.
    var guides: ((GuideOverlay) -> Void)? = nil
    /// Where the director tapped, already in the device's own space.
    ///
    /// The conversion is the PREVIEW LAYER's: `captureDevicePointConverted`
    /// knows the videoGravity (.resizeAspectFill CROPS the picture) and the
    /// orientation. Hand-rolling that transform is a second implementation of
    /// Apple's, and when it disagrees it does so silently — by focusing a
    /// little way from where the finger went.
    var onTap: ((FocusLock) -> Void)? = nil

    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.layer.session = session
        v.layer.videoGravity = .resizeAspectFill
        if onTap != nil {
            let tap = UITapGestureRecognizer(target: context.coordinator,
                                             action: #selector(Coordinator.tapped(_:)))
            v.addGestureRecognizer(tap)
        }
        context.coordinator.onTap = onTap

        let overlay = GuideOverlay(frame: v.bounds)
        overlay.backgroundColor = .clear
        overlay.isUserInteractionEnabled = false
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // The converter belongs to the LAYER: it is the only thing that knows
        // how .resizeAspectFill crops the picture onto this view.
        overlay.convert = { [weak v] r in
            guard let v else { return .zero }
            return v.layer.layerRectConverted(fromMetadataOutputRect: r)
        }
        v.addSubview(overlay)
        context.coordinator.overlay = overlay
        guides?(overlay)
        return v
    }
    func updateUIView(_ view: PreviewView, context: Context) {
        context.coordinator.onTap = onTap
        if let o = context.coordinator.overlay { guides?(o); o.setNeedsDisplay() }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject {
        var onTap: ((FocusLock) -> Void)?
        weak var overlay: GuideOverlay?

        @objc func tapped(_ g: UITapGestureRecognizer) {
            guard let view = g.view as? PreviewView, let onTap else { return }
            let p = view.layer.captureDevicePointConverted(fromLayerPoint: g.location(in: view))
            onTap(FocusLock.point(x: p.x, y: p.y))
        }
    }

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
    // Captured WITH the frame. Reading the camera at upload time would
    // record whatever it has settled on since, which is a different shot.
    @State private var shotAt: CaptureSettings?
    @State private var busy = false
    @State private var result = PlateCaptureResult()
    @State private var problem: String?
    // Three switches, not one. A director who wants the level should not have
    // to accept a grid over the subject they are judging.
    @State private var showLevel = true
    @State private var showGrid = false
    @State private var showAspect = true
    // OFF by default. Peaking is an aid while focusing, not part of the plate,
    // and a shimmer over the subject you are judging is noise — the same
    // reasoning as the thirds grid.
    @State private var showPeaking = false
    @State private var peaks: [(x: Int, y: Int)] = []
    @State private var peakGrid: (width: Int, height: Int) = (0, 0)
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
                    CameraPreview(session: camera.session, guides: { o in
                        o.showLevel = showLevel; o.showGrid = showGrid
                        o.showAspect = showAspect; o.aspect = request.aspect
                        o.tilt = camera.tilt
                        o.showPeaking = showPeaking
                        o.peaks = peaks; o.peakGrid = peakGrid
                    }) { camera.lockFocus(at: $0) }.ignoresSafeArea()
                }
                overlay
            }
        }
        .onAppear {
            camera.start(); camera.startLevel()
            // Frames arrive on the camera's serial queue. The detection runs
            // THERE and only the result hops to main — analysing on main would
            // stutter every control, which is why PCC-007 gave it its own queue.
            camera.onFrame = { pixels, plan in
                guard showPeaking else { return }
                guard let found = FocusPeaking.read(pixels, plan: plan) else { return }
                Task { @MainActor in
                    peaks = found
                    peakGrid = (plan.width, plan.height)
                }
            }
        }
        .onDisappear { camera.onFrame = nil; camera.stop(); camera.stopLevel() }
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

            // The guides. Off is a real choice for each: a grid over a subject
            // you are judging is noise, and an aspect guide on a plate that
            // will not be cropped is a line for nothing.
            if pending == nil {
                HStack(spacing: 8) {
                    guideToggle("level", "level.fill", $showLevel)
                    guideToggle("grid", "grid", $showGrid)
                    guideToggle("aspect", "rectangle.ratio.16.to.9", $showAspect)
                    guideToggle("peaking", "camera.metering.spot", $showPeaking)
                }
                .padding(.bottom, 8)
                // A roll that cannot be computed says so. Pointing the phone
                // straight down at a prop is an ordinary shot, and a level
                // reading "0° — level" there would be a confident lie.
                if showLevel && !camera.tilt.rollIsMeaningful {
                    Text("Level unavailable — the phone is pointing straight up or down")
                        .font(.caption2).foregroundStyle(.white.opacity(0.6))
                        .padding(.bottom, 6)
                }
            }

            // The focus lock. Separate from the exposure chip because it is
            // taken by TAPPING the subject rather than by pressing a control,
            // and because a director releases them independently: a view can
            // need re-focusing while the light has not changed.
            if pending == nil, camera.focus != nil {
                Button { camera.unlockFocus() } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "viewfinder")
                        Text("FOCUS HELD").font(.system(.caption, design: .monospaced))
                    }
                    .padding(.vertical, 6).padding(.horizontal, 11)
                    .background(.yellow, in: Capsule()).foregroundStyle(.black)
                }
                .accessibilityLabel("Focus locked. Tap to return to autofocus.")
                .padding(.bottom, 8)
            } else if pending == nil {
                Text("Tap the subject to focus")
                    .font(.caption2).foregroundStyle(.white.opacity(0.7)).padding(.bottom, 8)
            }

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
                    Button("Retake") { pending = nil; shotAt = nil; problem = nil }
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

    /// One switch, built once — three literals is how they come to disagree.
    private func guideToggle(_ name: String, _ icon: String, _ on: Binding<Bool>) -> some View {
        Button { on.wrappedValue.toggle() } label: {
            Image(systemName: icon)
                .font(.footnote)
                .padding(7)
                .background(on.wrappedValue ? .white : .white.opacity(0.18), in: Circle())
                .foregroundStyle(on.wrappedValue ? .black : .white)
        }
        .accessibilityLabel("\(name) guide, \(on.wrappedValue ? "on" : "off")")
    }

    private func take() {
        problem = nil
        camera.shoot { image in
            guard let image else { problem = "That shot did not come back. Try again."; return }
            pending = image
            // Taken WITH the frame. Read at upload time it would describe
            // whatever the camera has settled on since, which is a different
            // shot — and a retake would carry the previous frame's settings.
            shotAt = camera.lastSettings
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
                try await PlateUploader.send(image: image, view: view.key, request: request,
                                             settings: shotAt)
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
    static func send(image: UIImage, view: String, request: PlateCaptureRequest,
                     settings: CaptureSettings? = nil) async throws {
        guard let data = image.jpegData(compressionQuality: 0.9) else { throw Failure.encode }
        let base = request.apiBase.hasSuffix("/") ? String(request.apiBase.dropLast()) : request.apiBase
        guard let url = URL(string: "\(base)/film\(request.url)") else { throw Failure.badURL }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 120
        // `payload`, not `body`: the response is destructured into `body` a few
        // lines down, in the same scope.
        var payload: [String: Any] = [
            "data": "data:image/jpeg;base64,\(data.base64EncodedString())",
            "view": view,
            "name": "\(view).jpg",
        ]
        /*
         * What it was shot at, so a plate that comes back wrong can be
         * diagnosed rather than re-shot blind. OMITTED when there is nothing to
         * say: the route reads an absent block as "not recorded", and an empty
         * one would claim the settings were recorded and were none.
         *
         * A malformed field is dropped by the route and never costs the upload
         * — the photograph is the thing that cannot be retaken.
         */
        if let json = settings?.json, !json.isEmpty { payload["capture"] = json }
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)

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
