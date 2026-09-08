/**
 * FRAME-ACCESSIBLE PREVIEW — GRD-3658 / PCC-007.
 *
 * Focus peaking and an exposure warning are computed by us, per frame: Apple
 * ships no API for either. Today the preview is an AVCaptureVideoPreviewLayer,
 * which displays frames and hands none of them over — so PCC-008 and PCC-009
 * are both blocked on this, and it is the only L in the epic.
 *
 * THE PREVIEW LAYER IS KEPT, AND THAT IS THE DESIGN DECISION.
 *
 * The obvious reading of "frame-accessible preview" is to replace the layer
 * with an MTKView and render the picture ourselves. That would delete the two
 * things PCC-004 and PCC-005 deliberately refused to hand-roll —
 * `captureDevicePointConverted(fromLayerPoint:)` and
 * `layerRectConverted(fromMetadataOutputRect:)`, six call sites between them —
 * and re-implementing Apple's gravity and orientation transforms is precisely
 * the "disagrees silently" failure both tasks named. So the layer keeps
 * DISPLAYING and an AVCaptureVideoDataOutput is added ALONGSIDE it, purely to
 * hand frames to the analysis. Nothing that works stops working.
 *
 * THE ARITHMETIC THAT MATTERS IS THE SUBSAMPLE, and its failure is a hang.
 * At `sessionPreset = .photo` a frame is 4032x3024 — 12.2 million pixels.
 * Reading all of them thirty times a second is not slow, it is impossible, so
 * analysis walks a stride. A stride computed as zero is not a wrong number: it
 * is an infinite loop, and the app stops responding with the camera open.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');
const src = () => fs.readFileSync(SWIFT, 'utf8');
/** Comments stripped — a mention is not a use; twelve false passes this session. */
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

/** Compile the real plan and run it over a set of frame sizes. */
function plans(cases) {
    const body = extract('enum FrameAnalysis');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-frames-'));
    const file = path.join(dir, 'main.swift');
    const calls = cases.map(c =>
        `FrameAnalysis.plan(width: ${c.w}, height: ${c.h}, budget: ${c.budget})`).join(',\n  ');
    fs.writeFileSync(file, `import Foundation
${body}
let out = [
  ${calls}
]
print(out.map { "\\($0.stride),\\($0.width),\\($0.height)" }.joined(separator: ";"))
`);
    const bin = path.join(dir, 'probe');
    execFileSync('swiftc', ['-O', '-o', bin, file], { stdio: 'pipe' });
    return execFileSync(bin, { encoding: 'utf8' }).trim().split(';').map(r => {
        const [stride, width, height] = r.split(',').map(Number);
        return { stride, width, height, pixels: width * height };
    });
}

/**
 * Real frame sizes, plus the ones that break a naive divisor.
 *
 * SET-BASED because the failure is size-dependent: a stride computed by
 * integer division is fine at 4032x3024 and lands on ZERO for anything already
 * under the budget — which is every frame on a lower preset, and a hang.
 */
const FRAMES = [
    { name: '.photo preset (12.2MP)', w: 4032, h: 3024, budget: 65536 },
    { name: '4K',                     w: 3840, h: 2160, budget: 65536 },
    { name: '1080p',                  w: 1920, h: 1080, budget: 65536 },
    { name: '720p',                   w: 1280, h: 720,  budget: 65536 },
    { name: 'already under budget',   w: 160,  h: 120,  budget: 65536 },
    { name: 'exactly one pixel',      w: 1,    h: 1,    budget: 65536 },
    /*
     * A size that does NOT divide evenly by its stride, and a budget that the
     * square root alone overshoots.
     *
     * Every other entry here is a clean power-friendly raster where ceil and
     * floor agree, so a plan using integer division instead of rounding up
     * passed the whole set — proven by mutation. These two are the only cases
     * that can tell the two apart.
     */
    { name: 'odd raster, awkward stride', w: 4031, h: 3023, budget: 65536 },
    { name: 'tight budget',               w: 1999, h: 1001, budget: 1000 },
];

test('EVERY frame size yields a stride of at least 1 — a zero stride is a HANG', () => {
    /*
     * Not a wrong number: `for x in stride(from: 0, to: w, by: 0)` does not
     * terminate. The app freezes with the camera open and the only symptom is
     * that the shutter stops responding.
     */
    const got = plans(FRAMES);
    const bad = FRAMES.map((c, i) => got[i].stride >= 1 && Number.isFinite(got[i].stride)
        ? null : `${c.name}: stride ${got[i].stride}`).filter(Boolean);
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('EVERY frame is brought under the analysis budget', () => {
    const got = plans(FRAMES);
    const bad = FRAMES.map((c, i) => got[i].pixels <= c.budget
        ? null
        : `${c.name}: ${got[i].pixels} sampled pixels against a budget of ${c.budget}`).filter(Boolean);
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('a frame already under budget is NOT subsampled', () => {
    /*
     * The other half. A plan that always strides throws away resolution it did
     * not need to, and peaking on a 160x120 preview would be useless.
     */
    const got = plans([{ w: 160, h: 120, budget: 65536 }, { w: 1, h: 1, budget: 65536 }]);
    assert.strictEqual(got[0].stride, 1, 'a small frame was subsampled for no reason');
    assert.strictEqual(got[0].width, 160);
    assert.strictEqual(got[0].height, 120);
    assert.strictEqual(got[1].stride, 1);
});

test('the sampled dimensions match the stride that was chosen', () => {
    /*
     * width and height are what the analysis will actually walk. If they
     * disagree with the stride, every consumer reading them allocates the wrong
     * buffer — and PCC-008 and PCC-009 are both consumers.
     */
    const got = plans(FRAMES);
    const bad = FRAMES.map((c, i) => {
        const g = got[i];
        const w = Math.ceil(c.w / g.stride), h = Math.ceil(c.h / g.stride);
        return (g.width === w && g.height === h) ? null
            : `${c.name}: reports ${g.width}x${g.height}, stride ${g.stride} gives ${w}x${h}`;
    }).filter(Boolean);
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('a degenerate frame answers safely rather than dividing by zero', () => {
    const got = plans([
        { w: 0, h: 0, budget: 65536 },
        { w: -100, h: 50, budget: 65536 },
        { w: 1920, h: 1080, budget: 0 },      // a caller asking for nothing
        { w: 1920, h: 1080, budget: -1 },
    ]);
    for (const g of got) {
        assert.ok(g.stride >= 1 && Number.isFinite(g.stride), `stride ${g.stride}`);
        assert.ok(g.width >= 0 && g.height >= 0 && Number.isFinite(g.width),
            `dimensions ${g.width}x${g.height}`);
    }
});

test('the plan is pure — it cannot reach AVFoundation or a device', () => {
    const body = extract('enum FrameAnalysis')
        .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const forbidden of ['AVCapture', 'CMSampleBuffer', 'session', 'device.']) {
        assert.ok(!body.includes(forbidden),
            `FrameAnalysis touches ${forbidden}; it must be arithmetic, or it cannot be tested here`);
    }
});

/* ── the pipeline ──────────────────────────────────────────────────────── */

test('THE PREVIEW LAYER SURVIVES, with both of its converters', () => {
    /*
     * The decision this task turns on. PCC-004 and PCC-005 each refused to
     * hand-roll Apple's transform, and both refusals live on this layer.
     * Replacing it with an MTKView deletes them.
     */
    const s = code();
    assert.match(s, /AVCaptureVideoPreviewLayer/,
        'the preview layer is gone — with it go captureDevicePointConverted and '
        + 'layerRectConverted, and PCC-004 and PCC-005 would have to re-implement Apple\'s '
        + 'gravity and orientation transforms, which is what they exist to avoid');
    for (const c of ['captureDevicePointConverted', 'layerRectConverted']) {
        assert.match(s, new RegExp(c), `${c} no longer has a caller; a conversion was hand-rolled`);
    }
});

test('frames are delivered on a SERIAL queue that is not the main one', () => {
    /*
     * AVCaptureVideoDataOutput.h:56 — "A serial dispatch queue MUST be used to
     * guarantee that video frames will be delivered in order", and a nil queue
     * "throws an NSInvalidArgumentException".
     *
     * Not main, because :52 says a blocked queue drops frames — and blocking
     * main to analyse a 12-megapixel frame stutters every control on screen.
     */
    const s = code();
    assert.match(s, /setSampleBufferDelegate\(/,
        'nothing subscribes to frames, so the preview is still write-only');
    assert.match(s, /DispatchQueue\(label:/,
        'no dedicated queue is created; a serial queue is required and nil throws');
    const at = s.indexOf('setSampleBufferDelegate(');
    const call = s.slice(at, s.indexOf(')', at) + 1);
    assert.ok(!/DispatchQueue\.main/.test(call),
        'frames are delivered on the main queue — analysing a 12MP frame there stutters the UI '
        + 'and drops frames');
    assert.ok(!/attributes:\s*\.concurrent/.test(s),
        'the frame queue is concurrent; the header requires a SERIAL queue for ordered delivery');
});

test('late frames are discarded rather than queued', () => {
    /*
     * :52 — an unblocked-but-slow consumer otherwise accumulates buffers, and
     * the memory grows until the app is killed. For MONITORING the newest frame
     * is the only one worth having; a stale one is a lie about what the camera
     * is pointing at.
     */
    assert.match(code(), /alwaysDiscardsLateVideoFrames\s*=\s*true/,
        'late frames are retained; monitoring wants the newest frame and nothing else');
});

test('the pixel format is stated rather than inherited', () => {
    /*
     * Without it the device hands over whatever it prefers, which differs by
     * hardware — so the analysis would read a plane layout it was not written
     * for, and produce a plausible wrong answer rather than an error.
     */
    assert.match(code(), /kCVPixelBufferPixelFormatTypeKey|videoSettings/,
        'the pixel format is not stated, so the plane layout varies by device');
});

test('the data output does not displace the photo output', () => {
    /*
     * A plate is still a PHOTOGRAPH. If this task quietly turned capture into a
     * video frame grab, every plate would lose the full-sensor resolution the
     * .photo preset exists for.
     */
    const s = code();
    assert.match(s, /AVCapturePhotoOutput/, 'the photo output is gone; plates would be frame grabs');
    assert.match(s, /sessionPreset = \.photo/,
        'the session preset changed; a plate is cropped from the full sensor later');
});

test('frames stop when the camera does', () => {
    /*
     * A delegate left attached keeps a strong reference and keeps the queue
     * awake after the sheet is dismissed — the camera light stays on.
     */
    const s = code();
    const at = s.indexOf('func stop()');
    assert.notStrictEqual(at, -1, 'there is no stop()');
    const body = s.slice(at, s.indexOf('\n    }', at));
    assert.match(body, /setSampleBufferDelegate\(nil/,
        'stop() leaves the frame delegate attached, so frames keep arriving after the camera '
        + 'is dismissed');
});

test('there is a hook PCC-008 and PCC-009 can consume', () => {
    /*
     * The whole point of the task. A data output whose frames reach nothing is
     * the same write-only preview in a more expensive form.
     */
    const s = code();
    assert.match(s, /var onFrame|onFrame\s*[:=]/,
        'nothing can subscribe to the analysed frames, so peaking and the exposure warning have '
        + 'nothing to read');
    assert.match(s, /FrameAnalysis\.plan\(/,
        'the delegate never plans a subsample, so a consumer would walk 12 million pixels a frame');
});

test('state shared between the main actor and the frame queue is SYNCHRONISED', () => {
    /*
     * `onFrame` is written on the main actor (stop() clears it, the view sets
     * it) and read on the serial frame queue thirty times a second. That is a
     * data race: releasing a closure reference while another thread is loading
     * it can crash, and it will do so rarely and under load — the worst shape
     * of bug to find.
     *
     * `nonisolated(unsafe)` is not a fix. It is the compiler saying it CANNOT
     * PROVE this is safe, and the author replying that it is. Here that reply
     * would be false, so the marker is refused outright and the access has to
     * be synchronised for real.
     */
    const s = code();
    /*
     * Scoped to the LINE the property is declared on. A window of preceding
     * characters caught the private backing field, where the marker is
     * legitimate precisely BECAUSE every access to it goes through the lock —
     * so the check reported a correct implementation as unsafe.
     */
    const line = s.split('\n').find(l => /\bvar onFrame\b/.test(l));
    assert.ok(line, 'onFrame is gone; re-derive this check');
    assert.ok(!/nonisolated\(unsafe\)/.test(line),
        'the onFrame CALLERS touch is marked nonisolated(unsafe) — the compiler cannot prove it '
        + 'is safe and it is not: written on the main actor, read on the frame queue');

    // And the accessor must actually lock, not merely exist near a lock.
    const at = s.indexOf(line);
    const accessor = s.slice(at, s.indexOf('\n    }', at));
    assert.match(accessor, /lock\(\)/,
        'onFrame is a plain stored property with no synchronisation; the lock in this file guards '
        + 'something else');
    assert.match(accessor, /unlock\(\)/, 'the accessor locks and never unlocks — a deadlock');
});
