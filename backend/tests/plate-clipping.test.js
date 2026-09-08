/**
 * EXPOSURE WARNING — GRD-3660 / PCC-009.
 *
 * An overexposed plate cannot be recovered: the detail is not dark, it is
 * absent, and every frame generated from that plate inherits the hole. Caught
 * before the upload it costs one more shot; caught afterwards it costs the
 * frames too.
 *
 * WHAT "OVEREXPOSED" MEANS AS A CHECKABLE NUMBER, which is the judgement here.
 * A pixel is clipped when its luma is at the top of what the format can
 * express. But SOME clipping is correct exposure — a specular highlight on an
 * eye, a chrome edge, a lamp in shot — so a warning that fires on any clipping
 * at all is a warning that is always on, and one nobody reads. The warning is
 * therefore on the FRACTION of the frame that is clipped, and the fraction is
 * stated rather than felt.
 *
 * THE FORMAT DECIDES THE CLIP POINT, AND GETTING IT WRONG IS SILENT.
 * PCC-007 requests 420YpCbCr8BiPlanar**FullRange**, where luma runs 0...255 and
 * white is 255. The video-range variant runs 16...235. A detector holding 255
 * against a video-range buffer never fires at all; one holding 235 against a
 * full-range buffer calls a normal bright wall blown out. The level is tied to
 * the format the session actually requests.
 *
 * AND ONE FRAME READ, TWO ANALYSES. `onFrame` is a single closure — PCC-008
 * already holds it, so a second assignment would silently REPLACE peaking
 * rather than run beside it. Reading the plane twice would also copy ~1.5MB
 * twice per frame, ~90MB/s for nothing.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');
const src = () => fs.readFileSync(SWIFT, 'utf8');
/** Comments stripped — a mention is not a use; sixteen false passes this session. */
const code = () => src().split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** Cut a declaration out by BRACE DEPTH — never a character window. */
function extract(header) {
    const s = src();
    const at = s.indexOf(header);
    assert.notStrictEqual(at, -1,
        `PlateCamera.swift declares no '${header}'. If it was renamed this test cannot see the `
        + 'arithmetic it exists to check, and would pass by finding nothing');
    const open = s.indexOf('{', at);
    let depth = 0, i = open;
    for (; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}' && --depth === 0) break;
    }
    return s.slice(at, i + 1);
}

/**
 * Pictures generated IN SWIFT, one compile for the whole file.
 *
 * PCC-008 learned this the expensive way: passing 3072-byte planes as Swift
 * array literals compiled a fresh binary per test and cost eleven seconds each.
 * Data in Swift, cases in JS.
 */
const HARNESS = `
func makePlane(width: Int, height: Int, pad: Int, fill: (Int, Int) -> UInt8) -> [UInt8] {
    let rowBytes = width + pad
    var b = [UInt8](repeating: 0, count: rowBytes * height)
    for y in 0..<height {
        for x in 0..<width { b[y * rowBytes + x] = fill(x, y) }
        // Padding at the CLIP LEVEL: a detector indexing by width instead of
        // bytesPerRow would report a perfectly exposed frame as blown out.
        for x in width..<rowBytes { b[y * rowBytes + x] = 255 }
    }
    return b
}
let W = 64, H = 48                       // 3072 pixels
func picture(_ name: String, pad: Int) -> [UInt8] {
    switch name {
    case "mid":       return makePlane(width: W, height: H, pad: pad) { _, _ in 128 }
    case "black":     return makePlane(width: W, height: H, pad: pad) { _, _ in 0 }
    // One specular highlight: 16 of 3072 pixels, about 0.5% — correct exposure.
    case "specular":  return makePlane(width: W, height: H, pad: pad) {
                          ($0 < 4 && $1 < 4) ? 255 : 110 }
    // A blown face: a quarter of the frame at the clip point.
    case "blown":     return makePlane(width: W, height: H, pad: pad) {
                          ($0 < W / 2 && $1 < H / 2) ? 255 : 110 }
    // VIDEO-RANGE white in a FULL-RANGE buffer: bright, and not clipped.
    case "videowhite": return makePlane(width: W, height: H, pad: pad) { _, _ in 235 }
    // Just under the clip point everywhere.
    case "nearly":    return makePlane(width: W, height: H, pad: pad) { _, _ in 248 }
    default: return []
    }
}
`;

let CACHED = null;
/** Compile once; every case in one binary. */
function clips(cases) {
    const key = JSON.stringify(cases);
    if (CACHED && CACHED.key === key) return CACHED.out;
    const body = extract('enum ExposureWarning');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-clip-'));
    const file = path.join(dir, 'main.swift');
    const calls = cases.map(c => {
        if (c.malformed) {
            return `ExposureWarning.clipped(luma: [UInt8](repeating: 0, count: ${c.malformed.count}), `
                + `width: ${c.malformed.width}, height: ${c.malformed.height}, `
                + `bytesPerRow: ${c.malformed.rowBytes}, stride: 1)`;
        }
        return `ExposureWarning.clipped(luma: picture("${c.name}", pad: ${c.pad ?? 0}), `
            + `width: W, height: H, bytesPerRow: W + ${c.pad ?? 0}, stride: ${c.stride ?? 1})`;
    });
    fs.writeFileSync(file, `import Foundation
${body}
${HARNESS}
let out = [
  ${calls.join(',\n  ')}
]
print(out.map { "\\($0.points.count),\\($0.fraction)" }.joined(separator: ";"))
`);
    const bin = path.join(dir, 'probe');
    execFileSync('swiftc', ['-O', '-o', bin, file], { stdio: 'pipe' });
    const out = execFileSync(bin, { encoding: 'utf8' }).trim().split(';').map(r => {
        const [count, fraction] = r.split(',').map(Number);
        return { count, fraction };
    });
    CACHED = { key, out };
    return out;
}

/**
 * SET-BASED over EXPOSURE CONDITIONS, not examples.
 *
 * "Finds clipping" is satisfied by a detector that reports everything clipped,
 * and "reports none on mid-grey" by one that reports nothing ever. Only the set
 * together says anything — and `videowhite` is the one that separates a
 * correct clip level from a plausible wrong one.
 */
const PICTURES = [
    { name: 'mid',        clipped: false, warn: false, why: 'mid-grey is not clipped by any reading' },
    { name: 'black',      clipped: false, warn: false, why: 'crushed blacks are not an exposure warning' },
    { name: 'specular',   clipped: true,  warn: false,
      why: 'a highlight on an eye IS correct exposure; warning here is a warning always on' },
    { name: 'blown',      clipped: true,  warn: true,
      why: 'a quarter of the frame at the clip point is the case this exists for' },
    { name: 'videowhite', clipped: false, warn: false,
      why: 'THE format test. 235 is white in VIDEO range and merely bright in the full range '
         + 'PCC-007 requests; a detector clipping at 235 calls a bright wall blown out' },
    { name: 'nearly',     clipped: false, warn: false,
      why: 'just below the clip point still holds detail; clipping is a ceiling, not a slope' },
];

const CASES = [
    ...PICTURES.map(p => ({ name: p.name })),                 // 0..5
    { name: 'blown', pad: 16 },                               // 6
    { name: 'mid',   pad: 16 },                               // 7
    { name: 'blown', stride: 4 },                             // 8
    { malformed: { count: 3, width: 64, height: 48, rowBytes: 64 } },   // 9
    { malformed: { count: 100, width: 0, height: 0, rowBytes: 0 } },    // 10
    { malformed: { count: 100, width: 10, height: 10, rowBytes: 4 } },  // 11
];
const ALL = () => clips(CASES);

test('EVERY exposure condition is read correctly', () => {
    const got = ALL();
    const bad = [];
    PICTURES.forEach((c, i) => {
        const hasClip = got[i].count > 0;
        if (hasClip !== c.clipped) {
            bad.push(`${c.name}: ${hasClip ? 'found' : 'found no'} clipping — ${c.why}`);
        }
    });
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('the WARNING fires on a blown frame and not on a specular highlight', () => {
    /*
     * The distinction the whole feature turns on. Both frames contain clipped
     * pixels; only one is a problem. A detector that cannot separate them
     * either cries wolf on every well-exposed shot or never fires at all.
     */
    /*
     * The threshold is read FROM THE SWIFT SOURCE, not restated in a Node
     * module. The warning happens entirely on the phone and nothing
     * server-side consumes it, so a JS copy would exist only for this test to
     * read — and two literals is how they come to disagree.
     */
    const m = extract('enum ExposureWarning').match(/warnFraction\s*=\s*([0-9.]+)/);
    assert.ok(m, 'ExposureWarning declares no warnFraction; the warning has no stated threshold');
    const WARN_FRACTION = Number(m[1]);
    assert.ok(WARN_FRACTION > 0 && WARN_FRACTION < 1, `warnFraction is ${WARN_FRACTION}`);
    const got = ALL();
    const specular = got[2].fraction, blown = got[3].fraction;
    assert.ok(specular > 0, 'the specular highlight was not detected as clipped at all');
    assert.ok(specular < WARN_FRACTION,
        `a specular highlight clips ${(specular * 100).toFixed(2)}% and the warning fires at `
        + `${(WARN_FRACTION * 100).toFixed(2)}% — a warning on every well-exposed frame is one `
        + 'nobody reads');
    assert.ok(blown >= WARN_FRACTION,
        `a blown quarter-frame clips ${(blown * 100).toFixed(2)}% and does not reach the warning `
        + 'threshold — the case this exists for is silent');
});

test('the fraction is the FRACTION, not a count', () => {
    /*
     * A quarter of the frame is a quarter whatever the frame size, and a
     * consumer comparing a raw count against a threshold would warn on a big
     * frame and stay silent on a small one for the same picture.
     */
    const got = ALL();
    assert.ok(Math.abs(got[3].fraction - 0.25) < 0.02,
        `a quarter-blown frame reports ${got[3].fraction}; expected about 0.25`);
    assert.strictEqual(got[0].fraction, 0, 'mid-grey reports a non-zero clipped fraction');
});

test('padding NEVER changes the answer', () => {
    /*
     * The padding is filled AT THE CLIP LEVEL, so a detector indexing by width
     * instead of bytesPerRow reports a perfectly exposed frame as blown out.
     * Same defect PCC-008 guards, pointed at a different reader.
     */
    const got = ALL();
    assert.strictEqual(got[7].count, got[0].count,
        `a padded mid-grey frame found ${got[7].count} clipped pixels against ${got[0].count} `
        + 'unpadded — the detector is reading the row padding');
    assert.ok(Math.abs(got[6].fraction - got[3].fraction) < 0.02,
        `a padded blown frame reports ${got[6].fraction} against ${got[3].fraction} unpadded`);
});

test('the stride is honoured and does not distort the fraction', () => {
    /*
     * A quarter of the frame is a quarter however densely it is sampled. A
     * fraction computed against the FULL pixel count while sampling a strided
     * subset would under-report by the square of the stride — silently, and in
     * the safe-looking direction.
     */
    const got = ALL();
    assert.ok(got[8].count < got[3].count, 'the stride is ignored; every pixel is being walked');
    assert.ok(Math.abs(got[8].fraction - got[3].fraction) < 0.05,
        `strided sampling reports ${got[8].fraction} where dense reports ${got[3].fraction}; the `
        + 'fraction is being divided by the wrong total');
});

test('a short or malformed buffer is refused rather than read past the end', () => {
    for (const g of ALL().slice(9)) {
        assert.ok(Number.isFinite(g.count) && g.count >= 0, `count ${g.count}`);
        assert.ok(Number.isFinite(g.fraction) && g.fraction >= 0 && g.fraction <= 1,
            `fraction ${g.fraction}`);
    }
});

test('the clip level is tied to the format the session requests', () => {
    /*
     * Not a free-floating constant. PCC-007 asks for FullRange; if that ever
     * becomes the video-range variant, a level of 255 never fires and the
     * warning silently stops working.
     */
    const s = code();
    assert.match(s, /kCVPixelFormatType_420YpCbCr8BiPlanarFullRange/,
        'the session no longer requests a full-range format; the clip level must move with it');
    const body = extract('enum ExposureWarning');
    assert.match(body, /FullRange|full range|full-range/i,
        'the clip level does not say which format it belongs to, so a format change would leave '
        + 'it silently wrong');
});

test('the detector is pure — it cannot reach AVFoundation or CoreVideo', () => {
    const body = extract('enum ExposureWarning')
        .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const forbidden of ['AVCapture', 'CVPixelBuffer', 'session', 'device.']) {
        assert.ok(!body.includes(forbidden),
            `ExposureWarning touches ${forbidden}; it must be arithmetic over bytes`);
    }
});

/* ── one frame read, two analyses ──────────────────────────────────────── */

test('BOTH analyses run from ONE subscription and ONE plane read', () => {
    /*
     * `onFrame` is a single closure. A second `camera.onFrame = { ... }` does
     * not add a consumer, it REPLACES peaking — silently, and the symptom is
     * that peaking stops working when the exposure warning is switched on.
     *
     * And the plane copy is ~1.5MB per frame; doing it twice is ~90MB/s of
     * memory traffic for nothing.
     */
    const s = code();
    const subs = (s.match(/camera\.onFrame\s*=\s*\{/g) || []).length;
    assert.strictEqual(subs, 1,
        `${subs} closures are assigned to camera.onFrame — it holds ONE, so the later assignment `
        + 'silently replaces the earlier and one analysis stops running');

    const reads = (s.match(/CVPixelBufferGetBaseAddressOfPlane/g) || []).length;
    assert.strictEqual(reads, 1,
        `the luma plane is read in ${reads} places; one read feeds both analyses, or ~1.5MB is `
        + 'copied twice per frame');
});

test('peaking still runs — this task must not displace it', () => {
    const s = code();
    /*
     * Bound to the frame HOOK, not to the file. `peaks(luma:` matched the
     * detector's own DECLARATION, so removing the call from the hook left the
     * check passing over a view that never runs peaking.
     */
    const at = s.indexOf('camera.onFrame = {');
    assert.notStrictEqual(at, -1, 'nothing subscribes to onFrame');
    const hook = s.slice(at, s.indexOf('\n        }', at));
    assert.match(hook, /FocusPeaking\.peaks\(luma:/,
        'the frame hook no longer runs focus peaking; the exposure warning displaced it');
    assert.match(hook, /ExposureWarning\.clipped\(luma:/,
        'the frame hook never runs the clipping detector');
});

test('zebras draw in the EXISTING overlay, with their own switch', () => {
    const s = code();
    const at = s.indexOf('final class GuideOverlay');
    let d = 0, end = s.indexOf('{', at);
    for (let i = end; i < s.length; i++) {
        if (s[i] === '{') d++; else if (s[i] === '}' && --d === 0) { end = i; break; }
    }
    const cls = s.slice(at, end);
    const draw = cls.slice(cls.indexOf('override func draw('));
    assert.match(draw, /if showZebras\b/, 'draw() never consults the zebra switch');
    assert.match(draw, /for [a-z]+ in clipped[\s\S]{0,300}?ctx\.fill\(/,
        'draw() never fills anything from the clipped points');
    assert.ok(!/final class \w*Zebra\w*|class ClippingView/.test(s), 'a second overlay was added');
    assert.match(s, /@State private var showZebras\s*=\s*false/,
        'zebras are on by default; they stripe the subject a director is judging');
    const tAt = s.indexOf('guideToggle(');
    assert.match(s.slice(s.lastIndexOf('HStack', tAt), tAt + 700), /"zebras"/,
        'zebras have no control a person can press');
});

test('the warning is stated in words, not only striped', () => {
    /*
     * Zebras say WHERE; they do not say "this is too much". A director looking
     * at a face full of stripes still has to decide, and the fraction is the
     * fact that decides it.
     */
    const s = code();
    /*
     * Bound to a rendered Text gated on the THRESHOLD. Matching
     * /clippedFraction/ anywhere passed with the warning disabled, because the
     * @State property still carried the name — a fraction computed every frame
     * and shown to nobody.
     */
    assert.match(s, /clippedFraction\s*>=\s*ExposureWarning\.warnFraction/,
        'nothing compares the clipped fraction against the threshold, so the warning either never '
        + 'fires or fires always');
    const wAt = s.search(/clippedFraction\s*>=\s*ExposureWarning\.warnFraction/);
    assert.match(s.slice(wAt, wAt + 400), /Text\(/,
        'the threshold is consulted and nothing is rendered; zebras say WHERE, not how much');
});
