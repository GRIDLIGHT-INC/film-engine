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
extension FrameAnalysis {
    /// The luma plane, copied out once for every analysis that wants it.
    ///
    /// ONE READ, NOT ONE PER DETECTOR. `onFrame` holds a single closure, so a
    /// second subscriber would silently REPLACE the first rather than run
    /// beside it — and the copy is ~1.5MB per frame, so doing it twice is
    /// ~90MB/s of memory traffic for nothing. Focus peaking and the exposure
    /// warning both read what this returns.
    ///
    /// Separate from the detectors so the arithmetic stays pure and testable
    /// without a camera: a simulator produces no CVPixelBuffer at all.
    static func luma(from buffer: CVPixelBuffer)
        -> (bytes: [UInt8], width: Int, height: Int, bytesPerRow: Int)? {
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
         * The row stride is read PER PLANE. The buffer-wide bytesPerRow is a
         * different number, and using it is the padding bug in another hat.
         */
        guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) else { return nil }
        let rowBytes = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        let w = CVPixelBufferGetWidthOfPlane(buffer, 0)
        let h = CVPixelBufferGetHeightOfPlane(buffer, 0)
        let bytes = [UInt8](UnsafeBufferPointer(
            start: base.assumingMemoryBound(to: UInt8.self), count: rowBytes * h))
        return (bytes, w, h, rowBytes)
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

/// Where the picture has run out of headroom.
///
/// An overexposed plate cannot be recovered: the detail is not dark, it is
/// absent, and every frame generated from that plate inherits the hole. Caught
/// before the upload it costs one more shot; caught afterwards it costs the
/// frames too.
enum ExposureWarning {
    /// At or one below the maximum an 8-bit FULL-RANGE luma can express.
    ///
    /// The format matters and getting it wrong is silent. PCC-007 requests
    /// 420YpCbCr8BiPlanarFullRange, where luma runs 0...255. The VIDEO-range
    /// variant runs 16...235, so a detector holding 255 against one of those
    /// never fires at all, and one holding 235 against a full-range buffer
    /// calls an ordinary bright wall blown out.
    ///
    /// 254 rather than 255 because a sensor can roll off by a hair and there is
    /// no recoverable detail either way; 248 is genuinely bright and is not
    /// clipped.
    static let clipLevel: UInt8 = 254

    /// The fraction of the frame above which this is worth saying out loud.
    ///
    /// SOME clipping is correct exposure — a highlight on an eye, a chrome
    /// edge, a lamp in shot — so a warning that fires on any clipping at all is
    /// a warning that is always on, and one nobody reads. Two per cent is well
    /// clear of specular highlights and well below a blown face.
    static let warnFraction = 0.02

    /// The clipped points, and what fraction of what was SAMPLED they are.
    ///
    /// A fraction rather than a count: a quarter of the frame is a quarter
    /// whatever the frame size, and a consumer comparing a raw count against a
    /// threshold would warn on a big frame and stay silent on a small one for
    /// the same picture. Divided by the SAMPLED total, not the full pixel
    /// count, or striding would under-report by the square of the stride —
    /// silently, and in the reassuring direction.
    static func clipped(luma: [UInt8], width: Int, height: Int, bytesPerRow: Int,
                        stride: Int) -> (points: [(x: Int, y: Int)], fraction: Double) {
        let step = max(1, stride)
        guard width > 0, height > 0, bytesPerRow >= width,
              luma.count >= bytesPerRow * height else { return ([], 0) }

        var points: [(x: Int, y: Int)] = []
        var seen = 0
        var sy = 0, y = 0
        while y < height {
            var sx = 0, x = 0
            while x < width {
                // Indexed by bytesPerRow, NEVER by width: rows are padded, and
                // indexing by width reads the padding and walks progressively
                // out of line down the frame.
                if luma[y * bytesPerRow + x] >= clipLevel { points.append((x: sx, y: sy)) }
                seen += 1
                x += step; sx += 1
            }
            y += step; sy += 1
        }
        return (points, seen > 0 ? Double(points.count) / Double(seen) : 0)
    }
}

// ── recording ────────────────────────────────────────────────────────────────

/// What a recording mode IS, in numbers.
///
/// Deliberately free of AVFoundation types so the arithmetic can be compiled
/// and executed on its own — `fcc-recording.test.js` runs this table rather
/// than reading it, on the precedent `FrameAnalysis` set. A regex over the
/// source would confirm the file contains some digits.
///
/// **The rates are not chosen here.** They are `backend/lib/capture-policy.js`
/// `MODES`, byte for byte, and the test holds the two to exact equality in both
/// directions. That file computes how many seconds fit under the binding
/// upload ceiling; those seconds only mean anything if the camera records at
/// the rate they were computed from. A recorder encoding 1080p30 at twice the
/// budgeted rate produces a file that is perfectly valid, plays perfectly, and
/// breaches the ceiling at half the duration the app promised — discovered at
/// upload, which is the entire failure `capture-policy` exists to prevent.
struct RecordingMode: Equatable {
    /*
     * What kind of picture comes out.
     *
     * `rec709` is display-referred with the grade baked in — right for a
     * reference plate, wrong for footage that has to be graded alongside
     * generated material. `appleLog` keeps the latitude, and is the only
     * gradeable format that fits the existing upload pipe: ProRes is roughly
     * seven gigabytes a minute and is inseparable from external storage.
     */
    enum ColorSpace: String { case rec709, apple_log, apple_log2 }

    /*
     * What a phone has to REPORT before a format can use it.
     *
     * A model string is the wrong gate and fails in both directions: it has
     * never heard of the phone that shipped this morning — exactly the one with
     * the feature — and goes stale again when Apple brings a capability to
     * older hardware. Each case names the iOS it needs; the PROBE lives in an
     * extension outside this struct, because it touches AVFoundation and this
     * table must stay pure enough for the tests to compile and run it alone.
     */
    enum Capability: String, CaseIterable {
        case apple_log2, prores_raw, open_gate

        /// Every one is an iOS 26 symbol against a deployment target of 16.
        var minIOS: Int { 26 }

        var label: String {
            switch self {
            case .apple_log2: return "Apple Log 2"
            case .prores_raw: return "ProRes RAW"
            case .open_gate: return "open gate"
            }
        }

        /// What a phone without it is told, rather than failing silently.
        var degrade: String {
            switch self {
            case .apple_log2:
                return "This camera cannot record Apple Log 2 — the take records the log format "
                    + "it can, and can still be graded."
            case .prores_raw:
                return "This camera cannot record ProRes RAW — the take records ProRes 422, "
                    + "which is the closest format it has."
            case .open_gate:
                return "This camera has no open-gate format — the take records the ordinary "
                    + "16:9 crop of the sensor."
            }
        }
    }

    /*
     * What the writer encodes, and what can carry it.
     *
     * The container is not decoration: ProRes cannot be written into an mp4,
     * and a writer that discovers that when the director presses record has
     * already lost the take. FCC-001 chose `.mov` with exactly this in mind.
     */
    enum Codec: String {
        case hevc, prores422, prores422hq, prores_raw

        var fileExtension: String { "mov" }

        var label: String {
            switch self {
            case .hevc: return "HEVC"
            case .prores422: return "ProRes 422"
            case .prores422hq: return "ProRes 422 HQ"
            case .prores_raw: return "ProRes RAW"
            }
        }
    }

    /*
     * How a take leaves the phone.
     *
     * A format is not usable because it can be RECORDED — it is usable because
     * the file can then go somewhere. Mirrored from `capture-policy.js`
     * TRANSPORTS and held equal by test, like the rates and the colour spaces:
     * two answers to "can I shoot this" is a camera offering what the upload
     * will refuse.
     */
    enum Transport: String, CaseIterable {
        case upload, external

        /// Whether this transport exists WITHOUT asking the device.
        ///
        /// The upload always does. A drive never does statically — whether one
        /// is plugged in is a property of this moment, not of the table — so
        /// `RecordingBudget.transport(_:driveFreeBytes:)` is what resolves it
        /// once the phone has answered. Reading this alone for an external
        /// format refuses ProRes with a drive attached and working.
        var isAvailable: Bool { self == .upload }

        var label: String {
            switch self {
            case .upload: return "uploaded to the Mac"
            case .external: return "recorded straight to an external USB-C drive"
            }
        }

        var remedy: String {
            switch self {
            case .upload: return ""
            case .external:
                // FCC-009 built this. The remedy is now a thing a director can
                // DO, rather than a feature they are told does not exist.
                return "no external drive is attached — plug in a USB-C drive the camera can "
                    + "record to, and this format becomes available"
            }
        }
    }

    let id: String
    let width: Int
    let height: Int
    let fps: Int
    let bitsPerSecond: Int
    let colorSpace: ColorSpace
    let codec: Codec
    let transports: [Transport]
    /// What the phone must report before this format can be recorded. Empty for
    /// everything the camera could already do.
    var requires: [Capability] = []

    /// What a second of this mode costs on disk and, later, in transport.
    var bytesPerSecond: Int { bitsPerSecond / 8 }

    /// What a director is actually choosing between. Two formats are equal
    /// buttons until this number is on them.
    var megabytesPerMinute: Int {
        Int((Double(bytesPerSecond) * 60 / 1_048_576).rounded())
    }

    /// The first declared transport that exists. Order is the format's own
    /// preference; availability is the world's answer.
    var transport: Transport? { transports.first { $0.isAvailable } }

    /// What a picker shows. The id is for the machine; this is for a person.
    var label: String {
        (codec == .hevc ? "" : "\(codec.label), ")
            + "\(width)x\(height) at \(fps)fps"
            + (colorSpace == .apple_log ? ", Apple Log" : "")
    }

    /// Whether this mode produces footage worth grading.
    var isGradeable: Bool { colorSpace == .apple_log || colorSpace == .apple_log2 }

    /*
     * Apple's published iPhone figures, as MB per minute of HEVC, converted the
     * same way capture-policy converts them. Nominal, not measured — which is
     * what they are called there too, rather than presented as exact.
     */
    static let all: [RecordingMode] = [
        RecordingMode(id: "1080p30", width: 1920, height: 1080, fps: 30,
                      bitsPerSecond: 6_291_456, colorSpace: .rec709, codec: .hevc,
                      transports: [.upload]),      // ~45 MB/min
        RecordingMode(id: "4k30", width: 3840, height: 2160, fps: 30,
                      bitsPerSecond: 18_874_368, colorSpace: .rec709, codec: .hevc,
                      transports: [.upload]),     // ~135 MB/min
        RecordingMode(id: "4k60", width: 3840, height: 2160, fps: 60,
                      bitsPerSecond: 55_924_056, colorSpace: .rec709, codec: .hevc,
                      transports: [.upload]),     // ~400 MB/min
        /*
         * The gradeable one. Half as much again as 4K30 Rec.709 — 200 MB/min
         * against 135 — which is why it is a mode of its own rather than a flag:
         * priced at the Rec.709 rate it would promise a 44-second take and
         * deliver about 30.
         *
         * Log is offered at 4K30 ONLY, because that is the one rate the epic
         * publishes. Inventing figures for 1080p30 and 4K60 log would put a
         * number nobody measured in front of a director, and a duration that is
         * confidently wrong is worse than one that is absent.
         */
        RecordingMode(id: "4k30-log", width: 3840, height: 2160, fps: 30,
                      bitsPerSecond: 27_962_024, colorSpace: .apple_log, codec: .hevc,
                      transports: [.upload]),                                // ~200 MB/min

        /*
         * PRORES, and every one of them travels ONLY by external storage.
         *
         * That is the epic's constraint expressed as a rule rather than
         * remembered: `external` does not exist until FCC-009, so each is
         * refused and SHOWN refused with that transport's remedy. Declaring
         * `.upload` here would offer them immediately — and 422 HQ at 4K30 is
         * 116MB a SECOND against a 100MB ceiling, so it does not fit one frame
         * that could travel.
         *
         * Rates mirror `capture-policy.js`: 1080p30 422 HQ is the figure Apple
         * publishes and the brief already pins, the rest are derived there and
         * flagged `inferred`, and both tables are held equal by test.
         */
        RecordingMode(id: "1080p30-prores422hq", width: 1920, height: 1080, fps: 30,
                      bitsPerSecond: 243_381_480, colorSpace: .rec709,
                      codec: .prores422hq, transports: [.external]),         // ~1.70 GiB/min
        RecordingMode(id: "4k30-prores422hq", width: 3840, height: 2160, fps: 30,
                      bitsPerSecond: 973_525_920, colorSpace: .rec709,
                      codec: .prores422hq, transports: [.external]),         // ~6.80 GiB/min
        RecordingMode(id: "1080p30-prores422", width: 1920, height: 1080, fps: 30,
                      bitsPerSecond: 162_623_080, colorSpace: .rec709,
                      codec: .prores422, transports: [.external]),           // ~1.14 GiB/min
        /*
         * THE HARDWARE TIER. Each declares the capability the phone must report
         * before it can be offered, so a 15 Pro Max is TOLD rather than failing
         * at the moment the director presses record.
         *
         * Open gate has no entry: its raster is a property of the sensor, so it
         * is built from the format the device reports — see `openGate(on:)`.
         */
        RecordingMode(id: "4k30-log2", width: 3840, height: 2160, fps: 30,
                      bitsPerSecond: 27_962_024, colorSpace: .apple_log2,
                      codec: .hevc, transports: [.upload],
                      requires: [.apple_log2]),                              // ~200 MB/min
        RecordingMode(id: "4k30-prores_raw", width: 3840, height: 2160, fps: 30,
                      bitsPerSecond: 650_492_320, colorSpace: .rec709,
                      codec: .prores_raw, transports: [.external],
                      requires: [.prores_raw]),                              // ~4.55 GiB/min

        RecordingMode(id: "4k30-prores422", width: 3840, height: 2160, fps: 30,
                      bitsPerSecond: 650_492_320, colorSpace: .rec709,
                      codec: .prores422, transports: [.external]),           // ~4.55 GiB/min
    ]

    /*
     * REFUSES rather than defaults. Falling back to a working mode would record
     * at a rate nobody chose against a budget computed for a different one, and
     * it would look exactly like it worked — the shape of failure this whole
     * table exists to remove.
     */
    static func mode(_ id: String) -> RecordingMode? { all.first { $0.id == id } }
}

/// How long a take may be, and how much of it is left.
///
/// **The number this exists for is twenty-two seconds.** 4K60 costs about
/// 400MB a minute and the upload accepts 150MB, so a 4K60 take breaches it in
/// 22 seconds — shorter than many useful shots, and until FCC-004 discovered at
/// UPLOAD, after the take was shot. 4K30 gets 66 seconds; 1080p30 gets 200.
/// Those differ by an order of magnitude, which is why a director has to be
/// told which one they are working against rather than left to guess.
///
/// **It used to say fourteen, and that was a third of every take.** There was
/// one `ceilingBytes` — 100MB, World Labs' cap on a video handed to Marble —
/// applied to footage that goes into the CUT and never reaches World Labs.
/// FCC-011 gave every transport its own ceiling on both sides of the wire, so
/// a take is priced against the route it will actually travel by.
///
/// MIRRORED FROM `backend/lib/capture-policy.js`, deliberately. Swift cannot
/// require a node module, so the budget exists twice — the same arrangement
/// `screenplay-pagination.js` and `shot-motion.js` already have with the page.
/// `fcc-transport.test.js` compiles this and holds every number equal to the
/// server's, because two budgets that disagree are worse than one that is
/// wrong: the app would promise one duration and then refuse a different one.
enum RecordingBudget {
    /*
     * THE UPLOAD'S ceiling — `body-limit.js` FILE_LIMIT, the body this engine
     * accepts. Since FCC-010 a take travels RAW and in chunks, so this is the
     * whole number rather than the three quarters of it that base64 leaves.
     */
    static let uploadCeilingBytes = 157_286_400

    /*
     * MARBLE'S, which is a DESTINATION limit and binds only a capture handed
     * to World Labs. It is here so the camera can quote it when shooting FOR a
     * world — and named separately from the upload precisely so nothing can
     * apply it to footage again by taking a minimum over both.
     */
    static let worldCeilingBytes = 104_857_600

    /*
     * The transport this mode would actually travel by, GIVEN what is plugged
     * in. `Transport.isAvailable` cannot answer for a drive — the pure table
     * has no device to ask — so the drive arrives as an argument. Reading
     * `mode.transport` alone leaves every ProRes format refused with a healthy
     * drive attached, which is what it did between FCC-009 and here.
     */
    static func transport(_ mode: RecordingMode, driveFreeBytes: Int? = nil) -> RecordingMode.Transport? {
        mode.transports.first { $0 == .external ? (driveFreeBytes != nil) : $0.isAvailable }
    }

    /*
     * The ceiling that binds THIS mode's route — never the smallest one there
     * is. On a drive that is a different number by four orders of magnitude:
     * ProRes 422 HQ at 4K30 fits zero seconds under any body limit here and
     * about ninety on a terabyte.
     *
     * A destination is a separate axis from a transport, so a take shot FOR a
     * world is held to whichever of the two is smaller. That is the only place
     * a minimum is taken, and both numbers genuinely apply to that route.
     */
    static func ceilingBytes(_ mode: RecordingMode,
                             driveFreeBytes: Int? = nil,
                             forWorld: Bool = false) -> Int {
        let transportCeiling: Int
        switch transport(mode, driveFreeBytes: driveFreeBytes) {
        case .external: transportCeiling = driveFreeBytes ?? 0
        case .upload:   transportCeiling = uploadCeilingBytes
        case nil:
            // Nowhere for the file to go. Zero is the truth, and `refusal`
            // names the transport rather than the number.
            return 0
        }
        return forWorld ? min(transportCeiling, worldCeilingBytes) : transportCeiling
    }

    /// The longest take this mode allows. Floor, not round: a take that fits
    /// "on average" is a take that does not fit.
    static func maxSeconds(_ mode: RecordingMode,
                           driveFreeBytes: Int? = nil,
                           forWorld: Bool = false) -> Int {
        ceilingBytes(mode, driveFreeBytes: driveFreeBytes, forWorld: forWorld) / mode.bytesPerSecond
    }

    /// What is left, once `elapsed` seconds have been recorded.
    ///
    /// CLAMPED AT ZERO. "-12s remaining" is not a duration, and on 4K60 — the
    /// mode where the ceiling actually bites — it is what a director would be
    /// looking at within half a minute.
    static func remaining(_ mode: RecordingMode, elapsed: Int,
                          driveFreeBytes: Int? = nil, forWorld: Bool = false) -> Int {
        max(0, maxSeconds(mode, driveFreeBytes: driveFreeBytes, forWorld: forWorld) - elapsed)
    }

    /*
     * The threshold SCALES with the mode, and it has to.
     *
     * A fixed ten seconds is lit for half of 4K60's twenty-two-second budget —
     * which is noise, and noise is what makes a real warning unreadable — while
     * being a rounding error on 1080p30's two hundred. The last tenth, floored
     * at three seconds so a short budget still gets a warning somebody can act
     * on.
     */
    static func warnSeconds(_ mode: RecordingMode,
                            driveFreeBytes: Int? = nil, forWorld: Bool = false) -> Int {
        max(3, maxSeconds(mode, driveFreeBytes: driveFreeBytes, forWorld: forWorld) / 10)
    }

    /// Is the end of the clip close enough to say so?
    static func isEndInSight(_ mode: RecordingMode, elapsed: Int,
                             driveFreeBytes: Int? = nil, forWorld: Bool = false) -> Bool {
        remaining(mode, elapsed: elapsed, driveFreeBytes: driveFreeBytes, forWorld: forWorld)
            <= warnSeconds(mode, driveFreeBytes: driveFreeBytes, forWorld: forWorld)
    }

    /*
     * Whether a format can be shot at all, and if not, what would fix it.
     *
     * ON THE BUDGET RATHER THAN THE MODE, because it is a budget question: it
     * depends on the ceiling, which is not a property of the format. Keeping
     * `RecordingMode` free of it also keeps that table a pure statement of what
     * a format IS — which is what lets the tests compile and RUN it on its own.
     */
    static func isOffered(_ mode: RecordingMode,
                          driveFreeBytes: Int? = nil, forWorld: Bool = false) -> Bool {
        transport(mode, driveFreeBytes: driveFreeBytes) != nil
            && maxSeconds(mode, driveFreeBytes: driveFreeBytes, forWorld: forWorld) >= 1
    }

    /// Told no, and told what would make it yes. A refusal with no way forward
    /// is a dead end; the whole value of refusing is naming the remedy.
    static func refusal(_ mode: RecordingMode,
                        driveFreeBytes: Int? = nil, forWorld: Bool = false) -> String? {
        if isOffered(mode, driveFreeBytes: driveFreeBytes, forWorld: forWorld) { return nil }
        if transport(mode, driveFreeBytes: driveFreeBytes) == nil,
           let blocked = mode.transports.first {
            return "\(mode.label) travels only by \(blocked.label), and \(blocked.remedy)."
        }
        let mb = ceilingBytes(mode, driveFreeBytes: driveFreeBytes, forWorld: forWorld) / 1_048_576
        return "\(mode.label) costs \(mode.megabytesPerMinute)MB a minute, which does not fit "
            + "one second under the \(mb)MB ceiling."
    }

    /*
     * What to shoot when nobody has chosen. The LONGEST take rather than the
     * highest resolution, which is the same judgement `capture-policy.js`
     * `recommended()` makes and for the same reason: a world is reconstructed
     * from coverage, so three minutes of 1080p is worth more than twenty-two
     * seconds of 4K60.
     */
    static func recommended(driveFreeBytes: Int? = nil, forWorld: Bool = false) -> RecordingMode {
        RecordingMode.all.max {
            maxSeconds($0, driveFreeBytes: driveFreeBytes, forWorld: forWorld)
                < maxSeconds($1, driveFreeBytes: driveFreeBytes, forWorld: forWorld)
        } ?? RecordingMode.all[0]
    }
}

/// The writer, and everything that must happen on the frame queue.
///
/// A separate object rather than fields on the model, for the reason the frame
/// consumer is held behind a lock: `append` runs on `frameQueue` sixty times a
/// second and start/stop are pressed on the main actor. Keeping the writer's
/// whole lifecycle inside one non-isolated class means there is exactly one
/// place that has to be right about which thread it is on.
///
/// Not an `AVCaptureMovieFileOutput`, which would record video with none of
/// this code. That is a SECOND capture path: the monitoring tools read frames
/// from the data output, so peaking and the exposure warning would be computed
/// from buffers that are not the ones being written, and the two would drift
/// under load with nothing to show for it. The epic says the writer is fed from
/// the output that already exists, and this is why.
final class RecordingSink {
    /*
     * WHICH TRACK a buffer belongs to, as a named case rather than a flag.
     *
     * Both outputs deliver through the same delegate signature, so before this
     * existed every buffer went to the one input the writer had — and the
     * moment audio arrived, sound samples were handed to the picture track.
     * That fails silently: the append is refused, the clip comes back mute, and
     * the video track is perfectly healthy. `append(buf, true)` would read
     * identically whichever way round it was passed; this cannot.
     */
    enum Track { case video, audio }

    private let lock = NSLock()
    private var writer: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var audioInput: AVAssetWriterInput?
    private var started = false
    private var dropped = 0

    private(set) var url: URL?

    var isRecording: Bool { lock.lock(); defer { lock.unlock() }; return writer != nil }

    /// Frames appended, and frames the encoder could not take. Reported rather
    /// than swallowed: a clip that quietly lost a third of its frames plays.
    private(set) var written = 0

    /// Open a writer for `mode`. Returns why not, or nil on success.
    func begin(mode: RecordingMode, to url: URL, sound: Bool) -> String? {
        lock.lock(); defer { lock.unlock() }
        guard writer == nil else { return "already recording" }

        guard let w = try? AVAssetWriter(outputURL: url, fileType: mode.codec.fileType) else {
            return "The recording could not be opened at \(url.lastPathComponent)."
        }
        /*
         * The bitrate is the mode's, so the file matches what the budget priced.
         * Expected frame rate is stated as well: without it the encoder rations
         * bits against a rate it guesses, and a 60fps clip comes out soft.
         */
        /*
         * THE CODEC COMES FROM THE MODE, never from here.
         *
         * Hardwiring HEVC would make a mode called "ProRes 422 HQ" record HEVC
         * — a take that lies about what it is, in a file that plays perfectly
         * and is the wrong thing to hand an editor.
         *
         * ProRes is a CONSTANT-quality codec: its rate is a property of the
         * format rather than something a caller sets, so
         * AVVideoAverageBitRateKey does not apply. The registry's ProRes
         * figures are what a minute COSTS, used to budget the take; asking the
         * encoder to hit them would be asking ProRes to be something else.
         */
        var settings: [String: Any] = [
            AVVideoCodecKey: mode.avCodec,
            AVVideoWidthKey: mode.width,
            AVVideoHeightKey: mode.height,
        ]
        if mode.codec == .hevc {
            settings[AVVideoCompressionPropertiesKey] = [
                AVVideoAverageBitRateKey: mode.bitsPerSecond,
                AVVideoExpectedSourceFrameRateKey: mode.fps,
            ]
        }
        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        /*
         * AVAssetWriterInput.h: without this the input assumes it may make the
         * caller wait. The caller here is `frameQueue`, which also carries
         * focus peaking and the exposure warning — so the encoder would stall
         * the monitoring the director is watching while they record.
         */
        videoInput.expectsMediaDataInRealTime = true
        guard w.canAdd(videoInput) else { return "This device cannot record \(mode.id)." }
        w.add(videoInput)

        /*
         * The sound, when there is any. AAC at 44.1kHz stereo is the ordinary
         * choice for a .mov, and it is small enough beside HEVC that it does
         * not move the duration `capture-policy` budgets: 128kbit/s is about
         * 16KB a second against 1080p30's 786KB, roughly two per cent.
         *
         * `sound: false` builds NO audio input rather than an input nothing
         * feeds. An empty track is worse than an absent one — it makes a
         * deliberate MOS take look like a broken microphone.
         */
        var audioInput: AVAssetWriterInput?
        if sound {
            let a = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVNumberOfChannelsKey: 2,
                AVSampleRateKey: 44_100,
                AVEncoderBitRateKey: 128_000,
            ])
            a.expectsMediaDataInRealTime = true
            guard w.canAdd(a) else { return "This device cannot record sound." }
            w.add(a)
            audioInput = a
        }

        guard w.startWriting() else {
            return w.error.map { "Recording failed to start: \($0.localizedDescription)" }
                ?? "Recording failed to start."
        }
        writer = w
        self.videoInput = videoInput
        self.audioInput = audioInput
        started = false
        written = 0
        dropped = 0
        self.url = url
        return nil
    }

    /// Feed one buffer. Called on the frame queue, never on main.
    func append(_ sample: CMSampleBuffer, to track: Track) {
        lock.lock(); defer { lock.unlock() }
        guard let writer, writer.status == .writing else { return }
        guard let input = (track == .video ? videoInput : audioInput) else { return }

        /*
         * The session is anchored to the FIRST buffer's own timestamp.
         *
         * `.zero` is the tempting constant and it is wrong: capture buffers
         * carry the host clock, which is time since boot. Starting at zero puts
         * every sample hours into the timeline — the file writes successfully,
         * reports a duration of several hours, and opens in an NLE as a clip
         * that is almost entirely empty. It fails as a plausible file rather
         * than as an error.
         */
        /*
         * THE PICTURE ANCHORS THE CLIP, never the sound.
         *
         * Audio arrives on its own schedule and can precede the first frame, so
         * starting on whichever buffer turns up first is a race decided by
         * microphone warm-up — the same take begins on a frame or on 30ms of
         * sound over a black picture depending on the run, and it is not
         * reproducible. Anchoring on video means the handful of audio samples
         * that arrive first fall outside the session; they are COUNTED as
         * dropped below rather than vanishing, because "a few samples lost at
         * the head" and "the microphone is not working" look identical in a
         * waveform.
         */
        if !started {
            guard track == .video else { dropped += 1; return }
            writer.startSession(atSourceTime: CMSampleBufferGetPresentationTimeStamp(sample))
            started = true
        }
        /*
         * Asked, not assumed. `append` returns false when the encoder is behind
         * and the sample is simply lost; without the guard a clip silently
         * drops frames under load and still reports success.
         */
        guard input.isReadyForMoreMediaData else { dropped += 1; return }
        if input.append(sample) { written += 1 } else { dropped += 1 }
    }

    /// Close the file. `done` carries the finished URL, or nil and a reason.
    func finish(_ done: @escaping (URL?, String?) -> Void) {
        lock.lock()
        guard let writer, let videoInput else {
            lock.unlock()
            done(nil, "nothing was recording")
            return
        }
        let audioInput = self.audioInput
        let out = url
        let lost = dropped
        self.writer = nil
        self.videoInput = nil
        self.audioInput = nil
        lock.unlock()

        /*
         * EVERY track is marked finished, not just the picture.
         *
         * `finishWriting` does not wait for an input that was never told the
         * media had ended, so leaving the audio input unmarked closes the file
         * with its sound truncated — or absent — while the video track is
         * perfectly healthy. That reads as a microphone fault and gets blamed
         * on the phone.
         */
        videoInput.markAsFinished()
        audioInput?.markAsFinished()
        // A file with no samples is not a clip. Saying so beats handing over
        // something that opens and shows nothing.
        guard started else {
            writer.cancelWriting()
            done(nil, "No frames reached the recording.")
            return
        }
        writer.finishWriting {
            if writer.status == .completed {
                done(out, lost > 0 ? "\(lost) frames were dropped by the encoder." : nil)
            } else {
                done(nil, writer.error.map { "Recording failed: \($0.localizedDescription)" }
                        ?? "Recording did not complete.")
            }
        }
    }
}

/*
 * The AVFoundation types, kept OUT of `RecordingMode` itself.
 *
 * That struct is a pure statement of what a format is — no AVFoundation — which
 * is what lets `fcc-recording`, `fcc-log`, `fcc-format-picker` and `fcc-prores`
 * compile and RUN it on its own. The same layering `RecordingBudget` follows.
 */
extension RecordingMode {
    var avCodec: AVVideoCodecType {
        switch codec {
        case .hevc: return AVVideoCodecType.hevc
        case .prores422: return AVVideoCodecType.proRes422
        case .prores422hq: return AVVideoCodecType.proRes422HQ
        case .prores_raw:
            /*
             * iOS 26 and newer hardware. The fallback is not a guess: it is
             * exactly what `Capability.prores_raw.degrade` tells the director —
             * "the take records ProRes 422, which is the closest format it
             * has." The capability gate stops this mode being selectable on a
             * phone without it, so reaching here means the OS is older than the
             * symbol, and degrading beats refusing to build.
             */
            if #available(iOS 26.0, *) { return AVVideoCodecType.proResRAW }
            return AVVideoCodecType.proRes422
        }
    }
}

extension RecordingMode.Codec {
    /// ProRes is a QuickTime codec; an mp4 cannot carry it.
    var fileType: AVFileType { .mov }
}

/*
 * ASKING THE DEVICE, which is the whole acceptance of FCC-008.
 *
 * Kept out of `RecordingMode` because it touches AVFoundation and that table
 * must stay pure enough for the tests to compile and run it alone — the same
 * layering `avCodec` and `RecordingBudget` already follow.
 *
 * Every probe is a real API read out of the installed SDK rather than recalled,
 * and every one asks what the hardware CAN DO. Nothing anywhere reads a model
 * identifier: that gate has never heard of the phone that shipped this morning,
 * which is exactly the one with the feature.
 */
extension RecordingMode.Capability {
    func isAvailable(device: AVCaptureDevice, output: AVCaptureVideoDataOutput) -> Bool {
        guard #available(iOS 26.0, *) else { return false }
        switch self {
        case .apple_log2:
            return device.activeFormat.supportedColorSpaces.contains(.appleLog2)
        case .prores_raw:
            /*
             * The right question for an AVAssetWriter pipeline, and the SDK
             * says so: this list is what may be used for AVVideoCodecKey with
             * an asset writer, and passing anything absent from it raises.
             */
            return output.availableVideoCodecTypesForAssetWriter(writingTo: .mov)
                .contains(.proResRAW)
        case .open_gate:
            return RecordingMode.openGateFormat(on: device) != nil
        }
    }
}

extension RecordingMode {
    /*
     * OPEN GATE IS A FORMAT, NOT A FLAG — there is no `isOpenGateSupported`
     * anywhere in AVFoundation, which is why this walks the device's own list.
     *
     * It is the full sensor rather than the 16:9 crop, so it is the widest
     * format whose aspect is NOT 16:9. Its raster is therefore READ from the
     * device: nothing published gives a pixel count for it, and typing one
     * would be an invented number for hardware nobody here has measured.
     */
    static func openGateFormat(on device: AVCaptureDevice) -> AVCaptureDevice.Format? {
        device.formats
            .filter { f in
                let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
                guard d.width > 0, d.height > 0 else { return false }
                let aspect = Double(d.width) / Double(d.height)
                // 16:9 is 1.777…; the full sensor is nearer 4:3.
                return abs(aspect - 16.0 / 9.0) > 0.05
            }
            .max { a, b in
                let da = CMVideoFormatDescriptionGetDimensions(a.formatDescription)
                let db = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
                return Int(da.width) * Int(da.height) < Int(db.width) * Int(db.height)
            }
    }

    /// The open-gate mode this PHONE can record, built from what it reports.
    /// Nil where the sensor offers no such format — never a typed fallback.
    static func openGate(on device: AVCaptureDevice) -> RecordingMode? {
        guard let f = openGateFormat(on: device) else { return nil }
        let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
        let fps = Int(f.videoSupportedFrameRateRanges.first?.maxFrameRate ?? 30)
        /*
         * Priced from the pixels it actually reports, against 4K30 Apple Log —
         * the anchored rate nearest in kind. Derived, like every other rate
         * this epic could not find published.
         */
        let pixels = Double(d.width) * Double(d.height)
        let ref = 3840.0 * 2160.0
        let bits = Int(27_962_024.0 * (pixels / ref) * (Double(fps) / 30.0))
        return RecordingMode(id: "opengate\(fps)", width: Int(d.width), height: Int(d.height),
                             fps: fps, bitsPerSecond: bits, colorSpace: .rec709,
                             codec: .hevc, transports: [.external], requires: [.open_gate])
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

    /*
     * Whether anything is reading the phone AT ALL — which is a different
     * answer from "roll is undefined at this angle", and they were one message.
     *
     * With no motion hardware `tilt` never leaves (0, 0, false), and the
     * overlay told the director the phone was pointing straight up or down. It
     * is not; nothing is reading it. PCC-005 established that a confidently
     * wrong level is worse than none, and then shipped a message that was
     * confidently wrong about its own cause.
     */
    @Published private(set) var levelUnavailable = true

    private let motion = CMMotionManager()

    /// Start reporting how the phone is held. Silent where there is no motion
    /// hardware — a simulator — rather than showing a level stuck at zero.
    func startLevel() {
        // Recorded, not merely checked: a guard whose answer reaches nobody
        // leaves the view unable to tell this case from a vertical phone.
        levelUnavailable = !motion.isDeviceMotionAvailable
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

    /*
     * The microphone, and a queue of its OWN.
     *
     * Sharing `frameQueue` would put every sound buffer behind the frame
     * analysis — peaking and the exposure warning walk a multi-megapixel frame
     * — and audio arrives roughly every 20ms and is dropped if nothing takes
     * it in time. So sound would go missing in exactly the moments a director
     * has the monitoring tools switched on, which is the hardest possible time
     * to notice it. The writer serialises the two appends behind its own lock;
     * the inputs are independent, so nothing needs one global order.
     */
    private let audio = AVCaptureAudioDataOutput()
    private let audioQueue = DispatchQueue(label: "film-engine.plate.audio")
    private var input: AVCaptureDeviceInput?
    private var onCapture: ((UIImage?) -> Void)?

    /*
     * The writer. Non-isolated because `append` is called from the frame queue
     * delegate, which cannot hop to the main actor per buffer without becoming
     * the stall it is trying to avoid.
     */
    nonisolated let sink = RecordingSink()

    /// Whether a take is running, and what it is being recorded at.
    @Published private(set) var isRecording = false
    @Published private(set) var recordingMode: RecordingMode?
    /*
     * The format a director chose, and the one every take actually uses.
     *
     * FCC-002 recorded at `RecordingBudget.recommended` and left a note saying
     * FCC-006 would make it a choice. A picker whose selection does not reach
     * `startRecording` is a control that changes a label and nothing else.
     *
     * It starts at the recommendation — the longest take rather than the
     * highest resolution — so a director who never opens the picker gets the
     * same behaviour as before.
     */
    @Published var selectedMode: RecordingMode = RecordingBudget.recommended()

    /*
     * The drive a take will be written to, and why there is none.
     *
     * "Discovering it afterwards costs the take": a drive that turns out to be
     * unusable four seconds into a ProRes recording has not produced a shorter
     * take, it has produced a corrupt one. So both are held BEFORE anything is
     * opened, and the picker shows the reason on the rows that need a drive.
     */
    @Published private(set) var externalDrive: String?
    @Published private(set) var driveProblem: String?
    /*
     * The drive's own answer to "how much fits", which is the EXTERNAL
     * transport's ceiling. It has no static number — that is the whole reason
     * the transport is device-reported — so every budget question about a
     * ProRes format takes it as an argument. Nil means no drive, which is a
     * ceiling of zero rather than an unknown one.
     */
    @Published private(set) var driveFreeBytes: Int?

    /*
     * Which advanced formats this PHONE cannot record, and why.
     *
     * Filled by asking the device at configure time, never by reading a model
     * identifier. A 15 Pro Max is TOLD what it is not getting rather than
     * meeting an exception at the moment the director presses record.
     */
    @Published private(set) var capabilityProblem: [String: String] = [:]

    /*
     * The colour space to put back when the take ends.
     *
     * The SDK is explicit: "Photo capture is not supported when AVCaptureDevice
     * has selected AVCaptureColorSpace_AppleLog or AVCaptureColorSpace_AppleLog2
     * as color space." FCC-005 set a log space and never restored it, so after
     * one log take the plate shutter was dead for the rest of the session —
     * nothing errored, stills simply stopped. That silently undid the guarantee
     * FCC-001 exists for.
     */
    private var colorSpaceBeforeRecording: AVCaptureColorSpace?

    /// Why this take is not being recorded in a gradeable colour space.
    ///
    /// Nil when it is, or when a Rec.709 mode was chosen deliberately. A log
    /// take that quietly came back Rec.709 is ungradeable footage that plays
    /// perfectly — indistinguishable from a good one until somebody tries to
    /// grade it, by which point the shot is over.
    @Published private(set) var logUnavailable: String?

    /// Whether this take will carry sound, and why not when it will not.
    /// A mute clip that looks exactly like a normal one is the defect FCC-003
    /// exists to close — so the reason is state, not a log line.
    @Published private(set) var recordsAudio = false
    @Published private(set) var soundless: String?

    /// Why the last take could not start or finish. Nil when it went fine.
    @Published private(set) var recordingProblem: String?

    /// How long the take has been running. Whole seconds: a transport counting
    /// tenths is a stopwatch, and what a director needs is the shot length.
    @Published private(set) var elapsedSeconds = 0
    /// The file the last take produced, auto-stopped or not. Held on the model
    /// rather than only handed to a callback, because a take the BUDGET ended
    /// has no caller waiting for it and must not be dropped on the floor.
    @Published private(set) var lastTake: URL?

    /// What is left of the budget, or nil when nothing is recording.
    var secondsRemaining: Int? {
        recordingMode.map { RecordingBudget.remaining($0, elapsed: elapsedSeconds, driveFreeBytes: driveFreeBytes) }
    }

    /// Whether the end is close enough to say so.
    var endInSight: Bool {
        recordingMode.map { RecordingBudget.isEndInSight($0, elapsed: elapsedSeconds, driveFreeBytes: driveFreeBytes) } ?? false
    }

    private var ticker: Task<Void, Never>?

    /*
     * Restored when the take ends. Recording at 4K needs a 4K preset, and a
     * plate needs `.photo` for the full sensor — so the preset is the mode's
     * for the duration and the stills setting the rest of the time. Putting the
     * session permanently on a video preset would quietly downgrade every plate
     * the camera has ever shot.
     */
    private var presetBeforeRecording: AVCaptureSession.Preset?

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
            askForSound()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                Task { @MainActor in
                    guard let self else { return }
                    granted ? self.askForSound()
                            : self.fail("Camera access was declined. Settings → Film Engine → Camera.")
                }
            }
        case .denied, .restricted:
            fail("Camera access is off for Film Engine. Settings → Film Engine → Camera.")
        @unknown default:
            fail("The camera is unavailable on this device.")
        }
    }

    /*
     * The microphone is asked for SEPARATELY, and being refused is not a
     * failure.
     *
     * MOS is a real thing a director chooses, so a declined microphone must not
     * stop the camera — but it must not produce a mute file in silence either.
     * That is the trap this whole task is about: iOS grants a microphone input
     * to an unauthorised app and simply delivers no samples, so the take comes
     * back with no sound, no error, and nothing to blame but the hardware.
     * `soundless` is the sentence a director reads instead.
     */
    private func askForSound() {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            recordsAudio = true
            configure()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                Task { @MainActor in
                    guard let self else { return }
                    self.recordsAudio = granted
                    if !granted {
                        self.soundless = "Microphone access was declined — takes will be silent. "
                            + "Settings → Film Engine → Microphone."
                    }
                    self.configure()
                }
            }
        case .denied, .restricted:
            recordsAudio = false
            soundless = "Microphone access is off for Film Engine — takes will be silent. "
                + "Settings → Film Engine → Microphone."
            configure()
        @unknown default:
            recordsAudio = false
            soundless = "The microphone is unavailable on this device — takes will be silent."
            configure()
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
        /*
         * THE FLAG THE WHOLE TASK TURNS ON, and it must be off BEFORE the
         * session runs.
         *
         * Left alone, AVCaptureSession configures the device's colour space
         * itself — so `activeColorSpace = .appleLog` is assigned and the session
         * quietly puts it back. The take records Rec.709, looks completely
         * normal, and is ungradeable. Nothing errors, which is why the task
         * names this property rather than only the assignment.
         */
        session.automaticallyConfiguresCaptureDeviceForWideColor = false
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

        /*
         * The microphone, only when it has actually been granted. Adding the
         * input without permission is the silent failure: iOS accepts it and
         * delivers nothing, so the session looks correctly configured and every
         * take is mute.
         */
        if recordsAudio {
            if let mic = AVCaptureDevice.default(for: .audio),
               let micInput = try? AVCaptureDeviceInput(device: mic),
               session.canAddInput(micInput) {
                session.addInput(micInput)
                audio.setSampleBufferDelegate(self, queue: audioQueue)
                if session.canAddOutput(audio) { session.addOutput(audio) }
            } else {
                // Granted and still unusable — another app may hold it.
                recordsAudio = false
                soundless = "The microphone could not be opened — takes will be silent."
            }
        }

        session.commitConfiguration()

        input = first
        lens = start
        /*
         * ASK THE PHONE WHAT IT CAN DO, once, here — never a model string.
         * A format the sensor cannot record is greyed in the picker with the
         * reason, so a 15 Pro Max is told rather than meeting an exception at
         * the moment the director presses record.
         */
        probeCapabilities(on: start.device)
        probeExternalStorage()
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

    /// Put the mode's colour space on the device, or say why not.
    ///
    /// Called AFTER the preset has been committed, because which colour spaces
    /// exist is a property of the FORMAT and the session chooses the format at
    /// commit — asking the old one whether it supports Apple Log answers about
    /// the format being left behind.
    ///
    /// Every refusal is NAMED. An older phone recording Rec.709 instead of log
    /// is legitimate; doing it in silence hands back footage that plays
    /// perfectly and cannot be graded, which nobody discovers until the shot is
    /// over.
    private func applyColorSpace(_ mode: RecordingMode, to device: AVCaptureDevice) {
        logUnavailable = nil
        guard mode.isGradeable else { return }   // Rec.709 was the choice, not a failure

        guard #available(iOS 17.0, *) else {
            logUnavailable = "Apple Log needs iOS 17 — this take records Rec.709 and cannot be graded."
            return
        }

        /*
         * Apple Log 2 is iOS 26 and newer hardware, so it DEGRADES to Apple Log
         * rather than failing — which is the shape this whole task is about. A
         * phone that cannot reach the requested space records the best one it
         * has and says which.
         */
        var wanted = AVCaptureColorSpace.appleLog
        if mode.colorSpace == .apple_log2 {
            if #available(iOS 26.0, *),
               device.activeFormat.supportedColorSpaces.contains(.appleLog2) {
                wanted = .appleLog2
            } else {
                logUnavailable = RecordingMode.Capability.apple_log2.degrade
            }
        }
        guard device.activeFormat.supportedColorSpaces.contains(wanted) else {
            logUnavailable = "This camera cannot record a log colour space at \(mode.id) — "
                + "the take records Rec.709 and cannot be graded."
            return
        }
        guard (try? device.lockForConfiguration()) != nil else {
            logUnavailable = "The colour space could not be set — this take records Rec.709."
            return
        }
        defer { device.unlockForConfiguration() }
        // Remembered so it can be PUT BACK: photo capture is unsupported while
        // a log space is selected, so leaving it kills the plate shutter.
        colorSpaceBeforeRecording = device.activeColorSpace
        device.activeColorSpace = wanted
    }

    /*
     * Put the colour space back, or stills stay broken.
     *
     * Runs when the take ends, beside the preset restore and for the same
     * reason — except the consequence here is worse than a clamped exposure:
     * the SDK refuses photo capture entirely while a log space is selected, so
     * without this the plate shutter is dead for the rest of the session and
     * nothing anywhere says so.
     */
    private func restoreColorSpace() {
        guard let before = colorSpaceBeforeRecording else { return }
        colorSpaceBeforeRecording = nil
        guard let device = lens?.device,
              (try? device.lockForConfiguration()) != nil else { return }
        defer { device.unlockForConfiguration() }
        device.activeColorSpace = before
    }

    /*
     * What this phone cannot record, and why — filled by asking the DEVICE.
     *
     * A capability the hardware lacks makes every format requiring it
     * unavailable, and each carries its own sentence rather than disappearing.
     * A format that silently vanishes is indistinguishable from one that was
     * never built, which is the rule FCC-006 established for transports and
     * this follows for hardware.
     */
    private func probeCapabilities(on device: AVCaptureDevice) {
        var problems: [String: String] = [:]
        for capability in RecordingMode.Capability.allCases
        where !capability.isAvailable(device: device, output: frames) {
            for mode in RecordingMode.all where mode.requires.contains(capability) {
                problems[mode.id] = capability.degrade
            }
        }
        capabilityProblem = problems
    }

    /*
     * THE PRE-FLIGHT, and every part of it runs before a writer is opened.
     *
     * Four of the five questions are the OS's own — `AVExternalStorageDevice`
     * answers supply, permission, presence and suitability, and
     * `isNotRecommendedForCaptureUse` IS the speed-and-format verdict this task
     * asks for. Timing a throwaway write ourselves would be slower, less
     * accurate than the system's answer, and wear on a drive somebody paid for.
     *
     * The fifth is the one the OS cannot answer, because it depends on what is
     * about to be shot: a drive with a megabyte free is connected, suitable and
     * useless. That is computed against the chosen format's own rate.
     *
     * Returns the refusal, or nil when the drive is good.
     */
    @available(iOS 17.0, *)
    private func drive(for mode: RecordingMode) -> (device: AVExternalStorageDevice?, why: String?) {
        guard AVExternalStorageDeviceDiscoverySession.isSupported else {
            return (nil, "This phone cannot record to external storage. The formats that need a "
                    + "drive are unavailable on it.")
        }
        guard AVExternalStorageDevice.authorizationStatus == .authorized else {
            return (nil, "Film Engine has not been allowed to use external storage, so no drive "
                    + "can be seen. Settings → Film Engine.")
        }
        guard let found = AVExternalStorageDeviceDiscoverySession.shared?
                .externalStorageDevices.first(where: { $0.isConnected }) else {
            return (nil, "No external drive is attached. Plug in a USB-C drive to record this "
                    + "format.")
        }
        guard !found.isNotRecommendedForCaptureUse else {
            return (found, "This drive is not fast enough to record to, or is not formatted for "
                    + "it. A USB-3 drive formatted exFAT is what these formats need.")
        }
        // Room for a usable take, measured in the format's own seconds.
        guard found.freeSize / mode.bytesPerSecond >= 1 else {
            return (found, "There is not enough room on the drive for a usable take in this "
                    + "format.")
        }
        return (found, nil)
    }

    /*
     * Ask once, when the camera comes up, so the picker can grey the rows that
     * need a drive with the reason rather than with silence. Permission is
     * requested here for the same reason the microphone's is: without it the
     * discovery session lists NOTHING, which is indistinguishable from nothing
     * being plugged in — and a director is sent to check a cable that is fine.
     */
    private func probeExternalStorage() {
        guard #available(iOS 17.0, *) else {
            driveProblem = "External storage recording needs iOS 17."
            return
        }
        if AVExternalStorageDevice.authorizationStatus == .notDetermined {
            AVExternalStorageDevice.requestAccess { [weak self] _ in
                Task { @MainActor in self?.refreshDrive() }
            }
            return
        }
        refreshDrive()
    }

    @available(iOS 17.0, *)
    private func refreshDrive() {
        let (found, why) = drive(for: selectedMode)
        externalDrive = found?.displayName
        driveProblem = why
        // The free space regardless of the room verdict: that verdict is about
        // the SELECTED mode, and the picker prices every other row against its
        // own rate. Discarding the number here would grey a format that fits.
        driveFreeBytes = found.map { Int($0.freeSize) }
    }

    /// Put every held lock back on a device.
    ///
    /// A lock lives on the DEVICE, and the SESSION chooses that device's
    /// `activeFormat` — so anything that reconfigures the session releases all
    /// three at once. `select()` has known this since PCC-001; FCC-002 then
    /// added two more reconfiguration sites, and a take metered automatically
    /// while the chip on screen reads LOCK HELD is worse than a plate, because
    /// a plate can be re-shot.
    ///
    /// ONE helper rather than a copy per site: three copies is how one of them
    /// comes to carry the focus lock and the others do not. Each is re-applied
    /// only if it is actually held — re-applying a lock nobody set would pin
    /// the camera to whatever it happened to be metering.
    ///
    /// The refit is NOT done here. `apply(_:to:)` and its two siblings already
    /// clamp a held value into the format's own range and report the shortfall
    /// in stops; doing it again would be a second answer to the same question.
    private func reapplyLocks(to device: AVCaptureDevice) {
        if let held = exposure { apply(held, to: device) }
        if let wb = whiteBalance { applyWhiteBalance(wb, to: device) }
        // The POINT is re-focused rather than the lens position carried: a
        // stored position is not a consistent distance across formats, so the
        // number would focus somewhere else.
        if let at = focus { applyFocus(at, to: device) }
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
            //
            // Applied INSIDE the block here, unlike a preset change: the format
            // belongs to the device being added and is already correct before
            // the commit.
            reapplyLocks(to: next.device)
        } else if let current = input, session.canAddInput(current) {
            session.addInput(current)            // put the working lens back
        }
        session.commitConfiguration()
    }

    func stop() {
        // Detach FIRST. A delegate left attached holds a strong reference and
        // keeps the queue awake after the sheet is dismissed — the camera
        // indicator stays lit and frames keep arriving for nobody.
        /*
         * A take in progress is CLOSED, not abandoned. Detaching the delegate
         * below stops the buffers, so a writer left open would keep a
         * half-written file on disk that no longer has anything feeding it —
         * the take is unrecoverable either way, and this at least leaves a
         * playable one.
         */
        if isRecording { stopRecording { _ in } }
        frames.setSampleBufferDelegate(nil, queue: nil)
        onFrame = nil
        guard session.isRunning else { return }
        Task.detached { [session] in session.stopRunning() }
    }

    /*
     * The preset a mode needs. `.photo` delivers the full sensor for a plate
     * and is not a video size, so recording swaps to the matching video preset
     * and swaps back — see `presetBeforeRecording`.
     */
    private func preset(for mode: RecordingMode) -> AVCaptureSession.Preset {
        mode.height >= 2160 ? .hd4K3840x2160 : .hd1920x1080
    }

    /// Start a take. Reports why not rather than failing silently.
    ///
    /// The photo output is untouched: since iOS 16 both outputs may be active
    /// on one session, so recording never required losing the plate camera.
    func startRecording(_ modeID: String) {
        guard !isRecording else { return }
        guard state == .ready else {
            recordingProblem = "The camera is not ready."
            return
        }
        /*
         * REFUSED, not defaulted. Recording at a rate nobody asked for, against
         * a budget computed for a different one, is the failure `RecordingMode`
         * exists to remove — and it would look exactly like it worked.
         */
        guard let mode = RecordingMode.mode(modeID) else {
            recordingProblem = "\(modeID) is not a recording mode this camera knows."
            return
        }

        /*
         * Refused BEFORE the session is touched. Starting a take the sensor
         * cannot record would raise inside AVFoundation — the failing-rather-
         * than-degrading outcome this task exists to remove.
         */
        if let why = capabilityProblem[mode.id] {
            recordingProblem = why
            return
        }

        let wanted = preset(for: mode)
        guard session.canSetSessionPreset(wanted) else {
            recordingProblem = "This device cannot record \(mode.id)."
            return
        }
        presetBeforeRecording = session.sessionPreset
        session.beginConfiguration()
        session.sessionPreset = wanted
        session.commitConfiguration()
        /*
         * AFTER the commit, never inside it.
         *
         * The session applies the new preset — and therefore the device's new
         * activeFormat — when the configuration is committed. `apply(_:to:)`
         * refits against `device.activeFormat`, so calling it inside the block
         * would clamp against the format being LEFT BEHIND and then set a value
         * the new one refuses: 4K60 caps the frame duration at 1/60s, so an
         * exposure metered at 1/30 on the photo preset is illegal there.
         *
         * The colour space goes first, for the same reason and one more: the
         * supported set belongs to the format the commit just chose, and
         * changing it after the locks were restored would reconfigure the
         * device underneath them.
         */
        if let device = lens?.device {
            applyColorSpace(mode, to: device)
            reapplyLocks(to: device)
        }

        /*
         * WHERE THE TAKE GOES, decided before the writer is opened.
         *
         * A format that travels by drive is written STRAIGHT TO IT. ProRes at
         * 4K30 is 116MB a second, so recording to the phone and copying
         * afterwards needs the space twice over and takes as long again — and
         * the whole reason for a drive is that the phone cannot hold it.
         *
         * The pre-flight runs HERE, before `sink.begin`: discovering a drive is
         * unusable four seconds in has not produced a shorter take, it has
         * produced a corrupt one, and the moment is gone.
         */
        var url = FileManager.default.temporaryDirectory
            .appendingPathComponent("take-\(Int(Date().timeIntervalSince1970))-\(mode.id)."
                                    + mode.codec.fileExtension)
        if mode.transports.contains(.external) {
            guard #available(iOS 17.0, *) else {
                recordingProblem = "External storage recording needs iOS 17."
                restorePreset()
                return
            }
            let (found, why) = drive(for: mode)
            driveProblem = why
            externalDrive = found?.displayName
            driveFreeBytes = found.map { Int($0.freeSize) }
            if let why {
                recordingProblem = why
                restorePreset()
                return
            }
            guard let found,
                  let onDrive = (try? found.nextAvailableURLs(
                      withPathExtensions: [mode.codec.fileExtension]))?.first else {
                recordingProblem = "The drive would not give the take a name to be written under."
                restorePreset()
                return
            }
            url = onDrive
        }

        if let why = sink.begin(mode: mode, to: url, sound: recordsAudio) {
            restorePreset()
            recordingProblem = why
            return
        }
        recordingProblem = nil
        recordingMode = mode
        elapsedSeconds = 0
        lastTake = nil
        isRecording = true
        startTicking()
    }

    /// Stop the take and hand over the file.
    ///
    /// The completion is OPTIONAL because the budget stops takes too, and that
    /// caller is a timer with nothing to hand the file to — `lastTake` is where
    /// the file goes either way.
    func stopRecording(_ done: @escaping (URL?) -> Void = { _ in }) {
        guard isRecording else { done(nil); return }
        isRecording = false
        ticker?.cancel()
        ticker = nil
        sink.finish { [weak self] url, problem in
            Task { @MainActor in
                guard let self else { return }
                self.restorePreset()
                self.recordingMode = nil
                self.recordingProblem = problem
                self.lastTake = url
                done(url)
            }
        }
    }

    private func startTicking() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { return }
                await self?.tick()
            }
        }
    }

    /*
     * One second of the take, and the place the ceiling is ENFORCED.
     *
     * A countdown that reaches zero and keeps recording is advice nobody
     * applied: every second past it grows a file that already cannot be
     * uploaded. Showing the number and then letting the take run through it is
     * the same failure as never showing it, with more steps — so the budget
     * ends the take, and `lastTake` keeps what was shot up to that point.
     */
    private func tick() {
        guard isRecording, let mode = recordingMode else { return }
        elapsedSeconds += 1
        if RecordingBudget.remaining(mode, elapsed: elapsedSeconds, driveFreeBytes: driveFreeBytes) == 0 {
            recordingProblem = "The take reached the "
                + "\(RecordingBudget.maxSeconds(mode, driveFreeBytes: driveFreeBytes))s limit "
                + "for \(mode.id) and was stopped, so the clip can still be uploaded."
            stopRecording()
        }
    }

    private func restorePreset() {
        // The colour space first: it is what blocks the plate shutter, and it
        // must go back whether or not the preset needs restoring.
        restoreColorSpace()
        guard let before = presetBeforeRecording else { return }
        presetBeforeRecording = nil
        guard session.canSetSessionPreset(before) else { return }
        session.beginConfiguration()
        session.sessionPreset = before
        session.commitConfiguration()
        // Coming back is the same reconfiguration in the other direction: the
        // photo preset restores a longer maximum exposure, and a lock clamped
        // for 4K60 would otherwise stay clamped for every plate after the take.
        if let device = lens?.device { reapplyLocks(to: device) }
    }

    func shoot(_ done: @escaping (UIImage?) -> Void) {
        guard state == .ready else { done(nil); return }
        onCapture = done
        let settings = AVCapturePhotoSettings()
        settings.flashMode = .off               // a flash on a reference plate is a lighting decision
        output.capturePhoto(with: settings, delegate: self)
    }
}

extension PlateCameraModel: AVCaptureVideoDataOutputSampleBufferDelegate,
                            AVCaptureAudioDataOutputSampleBufferDelegate {
    nonisolated func captureOutput(_ output: AVCaptureOutput,
                                   didOutput sampleBuffer: CMSampleBuffer,
                                   from connection: AVCaptureConnection) {
        /*
         * ROUTED BY WHICH OUTPUT DELIVERED IT, before anything else happens.
         *
         * Both outputs call this one method with this one signature, so without
         * the comparison every sound sample would be handed to the picture
         * track — which refuses it, silently, leaving a mute clip with a
         * perfectly healthy video track. That is the failure mode this whole
         * task is about, and it is one line away at all times.
         *
         * Audio returns HERE. Everything below reads a pixel buffer, and an
         * audio sample has none: the monitoring path would find nil and do
         * nothing, which works today and would silently start analysing the
         * wrong thing the moment somebody made that guard less strict.
         */
        if output === audio {
            sink.append(sampleBuffer, to: .audio)
            return
        }
        /*
         * The recording is fed FIRST, and unconditionally.
         *
         * Below this line the monitoring path returns early when nothing is
         * reading frames — which is the common case, since peaking and the
         * exposure warning are both toggles. Feeding the writer after that
         * guard would mean a take recorded nothing whenever the director had
         * the monitoring tools switched off: a file that opens, plays as
         * nothing, and blames the camera.
         */
        sink.append(sampleBuffer, to: .video)

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

/// What a director is choosing between, and what each choice costs.
///
/// THE COST IS THE POINT, NOT THE LIST. "4K60" and "4K30 Apple Log" are two
/// equal-looking buttons until the durations are on them: 14 seconds against
/// 30, on the same phone, against the same ceiling. So every row carries its
/// price — MB a minute, how long a take may be, and how the file will travel.
///
/// A REFUSED FORMAT IS SHOWN, NOT HIDDEN. Dropping it would make a format that
/// needs a drive indistinguishable from one that was never built, and the
/// director would never learn that a drive is what closes it.
///
/// DERIVED from `RecordingMode.all`, never a typed list: a typed list is only
/// as complete as the afternoon it was written, and the format added next is
/// the one nobody can reach.
struct FormatPicker: View {
    @ObservedObject var camera: PlateCameraModel
    @State private var open = false

    private func clock(_ seconds: Int) -> String {
        String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    var body: some View {
        VStack(spacing: 6) {
            Button { open.toggle() } label: {
                HStack(spacing: 6) {
                    Image(systemName: "square.stack.3d.down.right")
                    Text(camera.selectedMode.label)
                        .font(.system(.footnote, design: .monospaced))
                    Image(systemName: open ? "chevron.up" : "chevron.down").font(.caption2)
                }
                .padding(.vertical, 7).padding(.horizontal, 12)
                .background(.white.opacity(0.18), in: Capsule())
                .foregroundStyle(.white)
            }
            .accessibilityLabel("Recording format, \(camera.selectedMode.label). Tap to change.")
            .disabled(camera.isRecording)

            if open && !camera.isRecording {
                VStack(spacing: 4) {
                    ForEach(RecordingMode.all, id: \.id) { mode in
                        Button {
                            if RecordingBudget.isOffered(mode, driveFreeBytes: camera.driveFreeBytes), camera.capabilityProblem[mode.id] == nil {
                                camera.selectedMode = mode; open = false
                            }
                        } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(mode.label)
                                    .font(.system(.footnote, design: .monospaced))
                                    .foregroundStyle(RecordingBudget.isOffered(mode, driveFreeBytes: camera.driveFreeBytes) && camera.capabilityProblem[mode.id] == nil
                                                     ? .white : .white.opacity(0.45))
                                // The price, on every row. Without it two
                                // formats are indistinguishable buttons.
                                // The hardware reason wins: "this phone cannot record it" is
                                // more useful than "it needs a drive" when both are true.
                                // Hardware first, then the drive, then the cost:
                                // "this phone cannot" beats "plug in a drive",
                                // and both beat a row that is greyed in silence.
                                Text(camera.capabilityProblem[mode.id]
                                     ?? (mode.transports == [.external] ? camera.driveProblem : nil)
                                     ?? (RecordingBudget.isOffered(mode, driveFreeBytes: camera.driveFreeBytes)
                                         ? "\(mode.megabytesPerMinute)MB/min · "
                                            + "\(clock(RecordingBudget.maxSeconds(mode, driveFreeBytes: camera.driveFreeBytes))) max · "
                                            + (mode.transport?.label ?? "")
                                         : (RecordingBudget.refusal(mode, driveFreeBytes: camera.driveFreeBytes) ?? "unavailable")))
                                    .font(.caption2)
                                    .foregroundStyle(RecordingBudget.isOffered(mode, driveFreeBytes: camera.driveFreeBytes) ? .white.opacity(0.7) : .orange)
                                    .multilineTextAlignment(.leading)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 6).padding(.horizontal, 12)
                            .background(mode.id == camera.selectedMode.id
                                        ? .white.opacity(0.22) : .white.opacity(0.08),
                                        in: RoundedRectangle(cornerRadius: 8))
                        }
                        .disabled(!RecordingBudget.isOffered(mode, driveFreeBytes: camera.driveFreeBytes) || camera.capabilityProblem[mode.id] != nil
                                  || (mode.transports == [.external] && camera.driveProblem != nil))
                        .accessibilityLabel(RecordingBudget.isOffered(mode, driveFreeBytes: camera.driveFreeBytes)
                            ? "\(mode.label), \(mode.megabytesPerMinute) megabytes a minute, "
                                + "\(RecordingBudget.maxSeconds(mode, driveFreeBytes: camera.driveFreeBytes)) seconds maximum"
                            : "\(mode.label), unavailable. \(RecordingBudget.refusal(mode, driveFreeBytes: camera.driveFreeBytes) ?? "")")
                    }
                }
                .padding(.horizontal, 20)
            }
        }
    }
}

/// Start, stop, elapsed, and how much of the budget is left.
///
/// The REMAINING figure is the one this exists for. A director shooting 4K60
/// has fourteen seconds before the clip can no longer be uploaded, and until
/// this row existed the only way to find that out was to shoot the take and be
/// refused afterwards. Elapsed alone would not do it: a stopwatch reading 0:12
/// says nothing unless you also know the budget is 0:14.
///
/// A separate control from the shutter, deliberately. FCC-001 kept the photo
/// output alive so stills were not traded for footage; replacing the shutter
/// here would complete that trade in the interface instead of in the session.
struct RecordingTransport: View {
    @ObservedObject var camera: PlateCameraModel
    let mode: RecordingMode

    /// mm:ss. A take is read in minutes and seconds, not in seconds.
    private func clock(_ seconds: Int) -> String {
        String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 14) {
                Button {
                    camera.isRecording ? camera.stopRecording() : camera.startRecording(mode.id)
                } label: {
                    ZStack {
                        Circle().strokeBorder(.white.opacity(0.9), lineWidth: 3)
                            .frame(width: 52, height: 52)
                        // A circle becomes a square while running: the shape
                        // says which state you are in from across a room, where
                        // a colour alone does not.
                        RoundedRectangle(cornerRadius: camera.isRecording ? 4 : 19)
                            .fill(.red)
                            .frame(width: camera.isRecording ? 22 : 38,
                                   height: camera.isRecording ? 22 : 38)
                    }
                }
                .accessibilityLabel(camera.isRecording
                    ? "Stop recording. \(camera.secondsRemaining ?? 0) seconds remaining."
                    : "Record \(mode.id). \(RecordingBudget.maxSeconds(mode, driveFreeBytes: camera.driveFreeBytes)) seconds available.")

                VStack(alignment: .leading, spacing: 1) {
                    Text(camera.isRecording ? clock(camera.elapsedSeconds) : mode.id)
                        .font(.system(.title3, design: .monospaced))
                        .foregroundStyle(camera.isRecording ? .red : .white)

                    // The budget, said BEFORE the take as well as during it —
                    // "14s at 4k60" is a shot-planning fact, not a warning.
                    Text(camera.isRecording
                         ? "\(clock(camera.secondsRemaining ?? 0)) left"
                         : "\(clock(RecordingBudget.maxSeconds(mode, driveFreeBytes: camera.driveFreeBytes))) max · \(mode.id)")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(camera.endInSight ? .orange : .white.opacity(0.7))
                }

                /*
                 * WHETHER THIS TAKE WILL HAVE SOUND, before it is shot.
                 *
                 * A mute clip is indistinguishable from a working one until
                 * somebody plays it back, by which point the take is over. MOS
                 * is a legitimate choice, so this states the fact rather than
                 * refusing to record — but it states it where the record button
                 * is, not in a log.
                 */
                if !camera.recordsAudio {
                    Image(systemName: "mic.slash.fill")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .accessibilityLabel("This take will have no sound")
                }
            }

            if !camera.recordsAudio, let why = camera.soundless {
                Text(why)
                    .font(.caption2).foregroundStyle(.orange)
                    .multilineTextAlignment(.center).padding(.horizontal, 24)
            }

            /*
             * A LOG TAKE THAT CAME BACK Rec.709 SAYS SO.
             *
             * It plays perfectly and is ungradeable, so there is nothing to
             * notice until somebody opens it in a grade — long after the shot.
             * Shown where the record button is, like the microphone warning,
             * rather than written to a log nobody reads.
             */
            if let why = camera.logUnavailable {
                Text(why)
                    .font(.caption2).foregroundStyle(.orange)
                    .multilineTextAlignment(.center).padding(.horizontal, 24)
            }

            if let problem = camera.recordingProblem {
                Text(problem)
                    .font(.caption2).foregroundStyle(.orange)
                    .multilineTextAlignment(.center).padding(.horizontal, 24)
            }
        }
        .padding(.vertical, 8).padding(.horizontal, 14)
        .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 14))
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
    var showZebras = false
    var clipped: [(x: Int, y: Int)] = []
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

        if showZebras, peakGrid.width > 0, peakGrid.height > 0 {
            // Amber rather than the peaking green: they can be on together, and
            // a director must be able to tell "sharp here" from "blown here".
            let sx = rect.width / CGFloat(peakGrid.width)
            let sy = rect.height / CGFloat(peakGrid.height)
            ctx.setFillColor(UIColor.systemOrange.withAlphaComponent(0.8).cgColor)
            for c in clipped {
                ctx.fill(CGRect(x: CGFloat(c.x) * sx, y: CGFloat(c.y) * sy,
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
    // OFF by default, like peaking and the grid: zebras stripe the subject a
    // director is judging.
    @State private var showZebras = false
    @State private var clipped: [(x: Int, y: Int)] = []
    @State private var clippedFraction: Double = 0
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
                        o.showZebras = showZebras; o.clipped = clipped
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
            // ONE subscription, because onFrame holds ONE closure — a second
            // assignment would silently replace this rather than add to it —
            // and ONE plane read, shared by both analyses.
            camera.onFrame = { pixels, plan in
                guard showPeaking || showZebras else { return }
                guard let f = FrameAnalysis.luma(from: pixels) else { return }

                let found = showPeaking
                    ? FocusPeaking.peaks(luma: f.bytes, width: f.width, height: f.height,
                                         bytesPerRow: f.bytesPerRow, stride: plan.stride)
                    : []
                let clip = ExposureWarning.clipped(luma: f.bytes, width: f.width, height: f.height,
                                                   bytesPerRow: f.bytesPerRow, stride: plan.stride)
                Task { @MainActor in
                    peaks = found
                    clipped = clip.points
                    clippedFraction = clip.fraction
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
                    guideToggle("zebras", "sun.max.trianglebadge.exclamationmark", $showZebras)
                }
                .padding(.bottom, 8)
                // A roll that cannot be computed says so. Pointing the phone
                // straight down at a prop is an ordinary shot, and a level
                // reading "0° — level" there would be a confident lie.
                // Two causes, two sentences. "Pointing straight up or down"
                // told a director holding the phone level to tilt it about,
                // when nothing was reading the phone at all.
                if showLevel && camera.levelUnavailable {
                    Text("No motion sensor on this device — the level cannot be read")
                        .font(.caption2).foregroundStyle(.white.opacity(0.6))
                        .padding(.bottom, 6)
                } else if showLevel && !camera.tilt.rollIsMeaningful {
                    Text("Level unavailable — the phone is pointing straight up or down")
                        .font(.caption2).foregroundStyle(.white.opacity(0.6))
                        .padding(.bottom, 6)
                }
            }

            // Zebras say WHERE the picture is blown; they do not say whether it
            // is too much. A director looking at a striped face still has to
            // decide, and the fraction is the fact that decides it.
            if pending == nil, clippedFraction >= ExposureWarning.warnFraction {
                Text(String(format: "%.0f%% of the frame is blown out",
                            clippedFraction * 100))
                    .font(.caption).foregroundStyle(.orange)
                    .padding(.vertical, 5).padding(.horizontal, 11)
                    .background(.black.opacity(0.5), in: Capsule())
                    .padding(.bottom, 8)
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

            /*
             * The transport sits above the shutter, where the lens picker and
             * the exposure chip already are, and is hidden while a still is
             * being reviewed for the same reason they are: pressing record over
             * a frozen frame would be acting on a camera nobody can see.
             *
             * The mode is `recommended` rather than chosen — FCC-006 builds the
             * picker. What matters here is that the budget is VISIBLE before
             * the take, which is the whole task.
             */
            if pending == nil {
                FormatPicker(camera: camera).padding(.bottom, 8)
                RecordingTransport(camera: camera, mode: camera.selectedMode)
                    .padding(.bottom, 14)
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
