/**
 * FOCUS PEAKING — GRD-3659 / PCC-008.
 *
 * A plate that conditions a subject should not be soft. Apple ships no peaking
 * API — every implementation computes it per frame — so this reads the luma
 * plane PCC-007 now delivers and marks where the picture is sharp.
 *
 * THE WHOLE FEATURE IS THE DIFFERENCE BETWEEN A HARD EDGE AND A SOFT ONE.
 * A detector that fires on both is not a weak version of peaking, it is the
 * opposite of it: a director racks focus, the overlay does not change, and the
 * only information the tool exists to give is absent. So the test that matters
 * is not "does it find an edge" — it is "does it find the SHARP one and not the
 * blurred one", and that is why the threshold is ABSOLUTE.
 *
 * A relative threshold — peak the top N% of gradients — was considered and is
 * wrong for exactly this reason: it would show the same amount of peaking in
 * and out of focus, because it always finds a top N%. Sharpness is an absolute
 * property of the picture and is read as one. Exposure being locked (PCC-002)
 * is what makes that stable across a turnaround.
 *
 * AND THE MOST LIKELY DEFECT IS NOT THE MATHS, IT IS `bytesPerRow`.
 * CVPixelBuffer rows are padded to an alignment, so a plane's row stride is NOT
 * its width. Indexing `y * width + x` reads into the padding and then walks
 * progressively further out of line down the frame — the classic symptom is a
 * diagonal smear of phantom edges that looks like a real detection.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');
const src = () => fs.readFileSync(SWIFT, 'utf8');
/** Comments stripped — a mention is not a use; thirteen false passes this session. */
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
 * The pictures, generated IN SWIFT rather than baked in as array literals.
 *
 * The first version passed each 3072-byte plane as a Swift array literal and
 * compiled a fresh binary per test: correct, and ELEVEN SECONDS each, which
 * would have added seventy seconds to a ninety-second suite. Same pictures,
 * same padding, one compile.
 *
 * `pad` is filled with alternating extremes, so a detector indexing by width
 * instead of bytesPerRow reads a wall of contrast that is not in the picture.
 */
const HARNESS = `
func makePlane(width: Int, height: Int, pad: Int, fill: (Int) -> UInt8) -> [UInt8] {
    let rowBytes = width + pad
    var b = [UInt8](repeating: 0, count: rowBytes * height)
    for y in 0..<height {
        for x in 0..<width { b[y * rowBytes + x] = fill(x) }
        for x in width..<rowBytes { b[y * rowBytes + x] = x % 2 == 1 ? 255 : 0 }
    }
    return b
}
let W = 64, H = 48
func picture(_ name: String, pad: Int) -> [UInt8] {
    switch name {
    case "flat":  return makePlane(width: W, height: H, pad: pad) { _ in 128 }
    case "hard":  return makePlane(width: W, height: H, pad: pad) { $0 < W / 2 ? 16 : 240 }
    // 224 levels over 56 pixels: 4 per pixel, what a defocused edge looks like.
    case "soft":  return makePlane(width: W, height: H, pad: pad) {
                      UInt8(max(0, min(255, 16 + ($0 - 4) * 4))) }
    default: return []
    }
}
`;

/** Compile the harness once and count what the detector finds for each case. */
let CACHED = null;
function peaks(cases) {
    const body = extract('enum FocusPeaking');
    const key = JSON.stringify(cases);
    if (CACHED && CACHED.key === key) return CACHED.out;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-peak-'));
    const file = path.join(dir, 'main.swift');
    const calls = cases.map(c => {
        if (c.malformed) {
            return `FocusPeaking.peaks(luma: [UInt8](repeating: 0, count: ${c.malformed.count}), `
                + `width: ${c.malformed.width}, height: ${c.malformed.height}, `
                + `bytesPerRow: ${c.malformed.rowBytes}, stride: 1, threshold: 24).count`;
        }
        return `FocusPeaking.peaks(luma: picture("${c.name}", pad: ${c.pad ?? 0}), `
            + `width: W, height: H, bytesPerRow: W + ${c.pad ?? 0}, `
            + `stride: ${c.stride ?? 1}, threshold: ${c.threshold ?? 24}).count`;
    });
    fs.writeFileSync(file, `import Foundation
${body}
${HARNESS}
let out: [Int] = [
  ${calls.join(',\n  ')}
]
print(out.map(String.init).joined(separator: ","))
`);
    const bin = path.join(dir, 'probe');
    execFileSync('swiftc', ['-O', '-o', bin, file], { stdio: 'pipe' });
    const out = execFileSync(bin, { encoding: 'utf8' }).trim().split(',').map(Number);
    CACHED = { key, out };
    return out;
}

const W = 64, H = 48;

/**
 * The pictures a detector must tell apart.
 *
 * SET-BASED over the DISTINCTIONS, not over examples: "finds an edge" is
 * satisfied by a detector that finds everything, and "finds nothing on flat" by
 * one that finds nothing at all. Only the pair together says anything.
 */
const PICTURES = [
    { name: 'flat', expect: 'none',
      why: 'a detector that marks a blank wall is marking noise' },
    { name: 'hard', expect: 'some',
      why: 'the sharp transition is exactly what peaking exists to show' },
    { name: 'soft', expect: 'none',
      why: 'THE test. A defocused edge must NOT peak, or racking focus changes nothing' },
    { name: 'hard', pad: 16, expect: 'some',
      why: 'the real buffer shape; a detector indexing by width reads the padding' },
    { name: 'flat', pad: 16, expect: 'none',
      why: 'the killer: indexing by width finds a wall of phantom edges in the padding' },
];

/** Every case this file drives, compiled in ONE binary. */
const CASES = [
    ...PICTURES.map(p => ({ name: p.name, pad: p.pad })),          // 0..4
    { name: 'hard', threshold: 8 },                                 // 5
    { name: 'hard', threshold: 250 },                               // 6
    { name: 'hard', stride: 1 },                                    // 7
    { name: 'hard', stride: 4 },                                    // 8
    { malformed: { count: 3, width: 64, height: 48, rowBytes: 64 } },   // 9
    { malformed: { count: 100, width: 0, height: 0, rowBytes: 0 } },    // 10
    { malformed: { count: 100, width: 10, height: 10, rowBytes: 4 } },  // 11
];
const ALL = () => peaks(CASES);

test('EVERY picture is read correctly — sharp peaks, flat and soft do not', () => {
    const got = ALL();
    const bad = [];
    PICTURES.forEach((c, i) => {
        const n = got[i];
        if (c.expect === 'none' && n > 0) bad.push(`${c.name}: found ${n} peaks — ${c.why}`);
        if (c.expect === 'some' && n === 0) bad.push(`${c.name}: found nothing — ${c.why}`);
    });
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('a SHARP edge peaks far more than a soft one at the same contrast', () => {
    /*
     * Both pictures span the same range of brightness; only the distance over
     * which they cross it differs. That difference IS focus, and a detector
     * that does not separate them is showing a director nothing.
     */
    const got = ALL();
    const hard = got[1], soft = got[2];
    assert.ok(hard > soft * 4,
        `a hard edge found ${hard} peaks and a defocused ramp found ${soft} — peaking must `
        + 'separate them, or racking focus changes nothing on screen');
});

test('padding NEVER produces peaks', () => {
    /*
     * Directly: the same picture with and without padded rows must give the
     * same answer. A detector using width instead of bytesPerRow reads
     * alternating 0 and 255 down every row and reports a wall of edges.
     */
    const got = ALL();
    const plainFlat = got[0], plainEdge = got[1], paddedEdge = got[3], paddedFlat = got[4];
    assert.strictEqual(paddedFlat, plainFlat,
        `a padded flat field found ${paddedFlat} peaks against ${plainFlat} unpadded — the `
        + 'detector is indexing by width and reading the row padding');
    assert.strictEqual(paddedEdge, plainEdge,
        `a padded edge found ${paddedEdge} against ${plainEdge} unpadded — same defect`);
});

test('the threshold decides, in both directions', () => {
    /*
     * A threshold consulted in name only would give the same count whatever it
     * is set to — and then peaking could never be tuned.
     */
    const got = ALL();
    const low = got[5], high = got[6];
    assert.ok(low > high, `threshold 8 found ${low} and threshold 250 found ${high}; the `
        + 'threshold is not being applied');
    assert.strictEqual(high, 0, 'a threshold above any possible gradient still found peaks');
});

test('the stride is honoured, so the plan from PCC-007 means something', () => {
    /*
     * PCC-007 exists to bound the work. A detector ignoring the stride walks
     * 12.2 million pixels a frame whatever the plan said.
     */
    const got = ALL();
    const dense = got[7], sparse = got[8];
    assert.ok(sparse < dense,
        `stride 1 found ${dense} and stride 4 found ${sparse}; the stride is ignored and the `
        + 'subsample plan reaches nothing');
    assert.ok(sparse > 0, 'striding lost the edge entirely');
});

test('a short or malformed buffer is refused rather than read past the end', () => {
    /*
     * Reading past a plane is not a wrong answer, it is a crash — and it would
     * happen on whichever device reports a geometry this was not written for.
     */
    for (const n of ALL().slice(9)) assert.ok(Number.isFinite(n) && n >= 0, `returned ${n}`);
});

test('the detector is pure — it cannot reach AVFoundation or CoreVideo', () => {
    const body = extract('enum FocusPeaking')
        .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const forbidden of ['AVCapture', 'CVPixelBuffer', 'session', 'device.']) {
        assert.ok(!body.includes(forbidden),
            `FocusPeaking touches ${forbidden}; it must be arithmetic over bytes, or it cannot be `
            + 'tested without a camera');
    }
});

/* ── the wiring ────────────────────────────────────────────────────────── */

test('it reads the LUMA plane, not chroma', () => {
    /*
     * 420YpCbCr8BiPlanarFullRange: plane 0 is full-resolution luma, plane 1 is
     * interleaved CbCr at half resolution. Reading plane 1 gives colour edges at
     * half the detail — plausible on screen and wrong.
     */
    const s = code();
    assert.match(s, /GetBaseAddressOfPlane\(\s*\w+\s*,\s*0\s*\)/,
        'the luma plane is not read explicitly as plane 0');
    assert.match(s, /GetBytesPerRowOfPlane\(\s*\w+\s*,\s*0\s*\)/,
        'the row stride is not read from plane 0; using the buffer-wide bytesPerRow is the same '
        + 'padding bug in a different disguise');
});

test('the pixel buffer is LOCKED while it is read', () => {
    /*
     * CVPixelBufferGetBaseAddressOfPlane is documented as valid only between
     * lock and unlock. Reading outside that is undefined — and it works right
     * up until the frame is recycled under you.
     */
    const s = code();
    assert.match(s, /CVPixelBufferLockBaseAddress/, 'the buffer is read without locking it');
    assert.match(s, /CVPixelBufferUnlockBaseAddress/, 'the buffer is locked and never unlocked');
    assert.match(s, /\.readOnly/,
        'the lock is not read-only; a write lock on a capture buffer forces a copy per frame');
});

test('peaking draws into the EXISTING overlay, not a second one', () => {
    /*
     * GuideOverlay already covers the preview and already converts capture
     * space. A second overlay would fight it for the same rect and would have
     * to re-derive the same transform.
     */
    const s = code();
    const at = s.indexOf('final class GuideOverlay');
    assert.notStrictEqual(at, -1, 'GuideOverlay is gone; re-derive this check');
    let d = 0, end = s.indexOf('{', at);
    for (let i = end; i < s.length; i++) {
        if (s[i] === '{') d++; else if (s[i] === '}' && --d === 0) { end = i; break; }
    }
    /*
     * Bound to draw(), and to a FILL. Matching /peak/i over the whole class
     * passed with the drawing disabled, because the stored properties still
     * mention it — an overlay that holds the peaks and paints none of them.
     */
    const cls = s.slice(at, end);
    const dAt = cls.indexOf('override func draw(');
    assert.notStrictEqual(dAt, -1, 'GuideOverlay has no draw(); re-derive this check');
    const draw = cls.slice(dAt);
    assert.match(draw, /if showPeaking\b/,
        'draw() never consults showPeaking, so the switch reaches nothing');
    assert.match(draw, /for p in peaks[\s\S]{0,300}?ctx\.fill\(/,
        'draw() never fills anything from the peaks; the overlay holds them and paints none');
    assert.ok(!/final class \w*Peak\w*Overlay|class PeakingView/.test(s),
        'a second overlay class was added');
});

test('peaking has its own switch and is OFF by default', () => {
    /*
     * It is an aid while focusing, not part of the plate — and a shimmer over
     * the subject you are judging is noise. Off by default, like the grid.
     */
    const s = code();
    assert.match(s, /showPeaking/, 'there is no peaking switch');
    assert.match(s, /@State private var showPeaking\s*=\s*false/,
        'peaking is on by default; it draws over the subject a director is judging');
    const at = s.indexOf('guideToggle(');
    const row = s.slice(s.lastIndexOf('HStack', at), at + 600);
    assert.match(row, /"peaking"/, 'peaking has no control a person can press');
});

test('the frame hook is consumed, and the subsample plan with it', () => {
    const s = code();
    /*
     * Assigned a CLOSURE, not merely assigned. `camera.onFrame = nil` in
     * onDisappear satisfied the first version of this check, so it passed
     * against a view that unsubscribes and never subscribes.
     */
    assert.match(s, /camera\.onFrame\s*=\s*\{/,
        'nothing subscribes to onFrame with a handler, so PCC-007 delivers frames to no one');
    assert.match(s, /camera\.onFrame\s*=\s*nil/,
        'the subscription is never released, so frames keep arriving after the sheet is gone');
    /*
     * The CHAIN, not one literal spelling. The first version demanded
     * `FocusPeaking.peaks(` and failed against a correct implementation, because
     * inside `extension FocusPeaking` the call is unqualified.
     */
    /*
     * RE-POINTED BY PCC-009 (GRD-3660). The CoreVideo read moved from
     * FocusPeaking.read to FrameAnalysis.luma when the exposure warning needed
     * the same frame: onFrame holds ONE closure, so a second subscriber would
     * have replaced peaking, and the plane copy is ~1.5MB a frame. Every defect
     * this check was written to catch is still caught — the detector must still
     * be called, and still with the plan's stride.
     */
    assert.match(s, /FrameAnalysis\.luma\(from:/,
        'the frame hook never reads the luma plane');
    const at = s.indexOf('camera.onFrame = {');
    assert.notStrictEqual(at, -1, 'nothing subscribes to onFrame; re-derive this check');
    let d = 0, end = s.indexOf('{', at);
    for (let i = end; i < s.length; i++) {
        if (s[i] === '{') d++; else if (s[i] === '}' && --d === 0) { end = i; break; }
    }
    assert.match(s.slice(at, end), /\bpeaks\(luma:/,
        'the frame hook never calls the detector, so frames are copied and thrown away');
    assert.match(s.slice(at, end), /plan\.stride/,
        'the hook ignores the subsample plan, so it walks every pixel whatever PCC-007 decided');
});
