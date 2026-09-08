/**
 * LENS SELECTION — GRD-3652 / PCC-001.
 *
 * A plate conditions every generated frame of its subject, and a plate shot on
 * the ultra-wide is barrel-distorted at the edges. The camera could only ever
 * use `builtInWideAngleCamera`, hardcoded, so the choice did not exist.
 *
 * WHY THIS TEST COMPILES SWIFT RATHER THAN READING IT.
 *
 * Most of this file's siblings assert on Swift SOURCE TEXT, because there is no
 * Swift test target here. That is the right tool for wiring — "is the picker
 * bound to the model" — and the wrong one for ARITHMETIC: a formula can be
 * present, well named, and wrong. The 35mm conversion is pure maths over a
 * Float, so this extracts the real function out of the shipping source and
 * RUNS it. Change the formula and the numbers move; the test fails on the
 * numbers.
 *
 * THE API THE TASK NAMED DOES NOT EXIST, and that is the finding this rests on.
 * PCC-001 says "label in millimetres from `focalLengthIn35mmFilm`". Verified
 * against iPhoneOS26.1.sdk: that symbol appears nowhere in AVFoundation. It is
 * an EXIF key (`kCGImagePropertyExifFocalLenIn35mmFilm`, ImageIO) written onto
 * a photograph that has ALREADY been taken — so it cannot label a picker, which
 * is read before anything is shot. What a format does publish is
 * `AVCaptureDeviceFormat.videoFieldOfView`, documented "if field of view is
 * unknown, a value of 0 is returned", and the geometry from there is exact.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');
const src = () => fs.readFileSync(SWIFT, 'utf8');

/* ── the pure conversion, extracted and executed ────────────────────────── */

/**
 * Cut the pure function out of the shipping source by BRACE DEPTH from its
 * declaration.
 *
 * Never by a character window: this codebase has paid four times for a bounded
 * character count, and its failure mode is the worst available — the scan
 * silently stops matching and then blames the code it can no longer see.
 */
function extractFunc(name) {
    const s = src();
    const at = s.indexOf(`static func ${name}`);
    assert.notStrictEqual(at, -1,
        `PlateCamera.swift declares no 'static func ${name}' — if it was renamed, this test cannot `
        + 'see the arithmetic it exists to check, and would pass by finding nothing');
    const open = s.indexOf('{', at);
    let depth = 0, i = open;
    for (; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}' && --depth === 0) break;
    }
    return s.slice(at, i + 1);
}

let RESULTS = null;   // computed once; swiftc is slow and the answers do not change

/**
 * Compile the extracted function against a set of field-of-view inputs and
 * return what it really answers. Deliberately imports Foundation only — the
 * function must not depend on AVFoundation, or it cannot be tested off-device,
 * and `videoFieldOfView` is itself API_UNAVAILABLE(macos).
 */
function run(inputs) {
    if (RESULTS) return RESULTS;
    const body = extractFunc('equivalentFocalMM');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-lens-'));
    const swift = path.join(dir, 'main.swift');
    fs.writeFileSync(swift, `import Foundation
enum Probe {
${body}
}
let inputs: [Float] = [${inputs.join(', ')}]
print(inputs.map { f -> String in
    if let mm = Probe.equivalentFocalMM(fovDegrees: f) { return String(mm) }
    return "nil"
}.joined(separator: ","))
`);
    const bin = path.join(dir, 'probe');
    execFileSync('swiftc', ['-O', '-o', bin, swift], { stdio: 'pipe' });
    const out = execFileSync(bin, { encoding: 'utf8' }).trim();
    RESULTS = out.split(',').map(v => (v === 'nil' ? null : Number(v)));
    return RESULTS;
}

/**
 * The horizontal field of view a lens of this 35mm-equivalent focal length has.
 * A 35mm frame is 36mm wide, so half of it subtends atan(18/f).
 *
 * Derived rather than typed: quoting FOV figures for a phone I cannot measure
 * would test my memory of Apple's spec sheet, not the code. This round-trips —
 * feed in the FOV a 24mm lens must have, and 24 must come back.
 */
const fovFor = (mm) => (2 * Math.atan(18 / mm) * 180) / Math.PI;

/** The three PHYSICAL rear cameras, with the 15 Pro Max's equivalents. */
const LENSES = [
    { type: 'builtInUltraWideCamera', mm: 13 },
    { type: 'builtInWideAngleCamera', mm: 24 },
    { type: 'builtInTelephotoCamera', mm: 120 },
];

test('EVERY lens round-trips: the FOV it must have yields the focal length back', () => {
    /*
     * Set-based over the three device types, because the failure is partial by
     * nature — a formula with the wrong constant is close enough to look right
     * at 24mm and badly wrong at 120mm, where the tangent is steep.
     */
    const got = run(LENSES.map(l => fovFor(l.mm)));
    const wrong = LENSES.map((l, i) => [l, got[i]])
        .filter(([l, g]) => g !== l.mm)
        .map(([l, g]) => `${l.type}: ${fovFor(l.mm).toFixed(2)}° should read ${l.mm}mm, got ${g}`);
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('an unknown field of view answers nothing, and does not trap', () => {
    /*
     * The header is explicit: "if field of view is unknown, a value of 0 is
     * returned". tan(0) is 0, and 18/0 is infinity — and `Int(Float.infinity)`
     * TRAPS in Swift. So the naive formula does not mislabel a lens, it crashes
     * the camera, on exactly the device whose format cannot report a FOV.
     */
    RESULTS = null;
    const got = run([0, -1, 180, 179.9999, 1e9]);
    RESULTS = null;
    assert.deepStrictEqual(got, [null, null, null, null, null],
        `a degenerate field of view must answer nil; got ${JSON.stringify(got)}`);
});

test('the conversion is pure — it cannot reach AVFoundation or a device', () => {
    // If it could, it would be untestable off-device, and the check above would
    // have to be deleted rather than fixed.
    const body = extractFunc('equivalentFocalMM');
    for (const forbidden of ['AVCapture', 'self.', 'device', 'session']) {
        assert.ok(!body.includes(forbidden),
            `equivalentFocalMM touches ${forbidden}; it must be arithmetic over a Float`);
    }
});

/* ── the wiring, which source text is the right tool for ────────────────── */

test('EVERY physical rear camera is discovered', () => {
    const s = src();
    /*
     * Bound to the deviceTypes array of the discovery call, NOT to the file.
     * Every one of these names also appears in `fallbackName`'s switch, so a
     * file-wide search passes with a camera removed from discovery entirely —
     * proven by mutation, which is the only reason this is written this way.
     */
    const at = s.indexOf('DiscoverySession(');
    assert.notStrictEqual(at, -1, 'no DiscoverySession call to read');
    const types = s.slice(s.indexOf('deviceTypes:', at), s.indexOf(']', s.indexOf('deviceTypes:', at)));
    const missing = LENSES.filter(l => !types.includes(l.type)).map(l => l.type);
    assert.deepStrictEqual(missing, [],
        `not in the DiscoverySession's deviceTypes, so it can never be offered: ${missing.join(', ')}`);
    assert.match(s, /DiscoverySession/,
        'lenses are not discovered — AVCaptureDevice.default returns one fixed camera, which is '
        + 'the state PCC-001 exists to end');
    assert.match(s, /position:\s*\.back/,
        'the discovery is not restricted to the rear cameras; a plate is a photograph of a thing '
        + 'in the world, never of the person holding the phone');
});

test('only lenses the device really has are offered', () => {
    /*
     * `DiscoverySession` returns what is present, so asking for three types on a
     * two-lens phone yields two. The failure to guard against is the opposite:
     * building the picker from the REQUESTED list rather than the DISCOVERED
     * one, which offers a telephoto that is not there and fails at selection.
     */
    const s = src();
    assert.match(s, /\.devices\b/,
        'nothing reads DiscoverySession.devices, so the offer cannot be what the device has');
    assert.ok(!/lenses\s*=\s*\[\s*PlateLens\(/.test(s),
        'the lens list is built from literals rather than from what was discovered');
});

test('a device with one lens shows no picker rather than a broken one', () => {
    const s = src();
    assert.match(s, /lenses\.count\s*>\s*1/,
        'the picker is not conditioned on there being more than one lens — a single-lens phone '
        + 'gets a control with one option, which reads as broken');
});

test('selecting a lens reconfigures the session atomically', () => {
    /*
     * Swapping an input outside begin/commitConfiguration drops frames and can
     * leave the session with no input at all — a black preview with a working
     * shutter, which is the exact failure this file's header calls out.
     */
    const s = src();
    const at = s.indexOf('func select(');
    assert.notStrictEqual(at, -1, 'there is no select(); a discovered lens cannot be chosen');
    const body = s.slice(at, s.indexOf('\n    }', at));
    for (const need of ['beginConfiguration', 'commitConfiguration', 'removeInput', 'addInput']) {
        assert.ok(body.includes(need), `select() never calls ${need}`);
    }
});

test('the reason the named API was not used is recorded in the source', () => {
    /*
     * `focalLengthIn35mmFilm` is what the task asked for and it does not exist
     * in AVFoundation. Without the reason written down, the next reader "fixes"
     * this back to the API named in the ticket and discovers why at runtime.
     */
    const s = src();
    assert.match(s, /focalLengthIn35mmFilm/,
        'nothing records why the API the task named is not used');
    assert.match(s, /EXIF|kCGImagePropertyExif/,
        'the source does not say that focalLengthIn35mmFilm is EXIF, written after capture');
    assert.match(s, /videoFieldOfView/, 'the real source of the angle is not named');
});
