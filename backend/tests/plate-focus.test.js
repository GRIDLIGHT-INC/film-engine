/**
 * FOCUS LOCK — GRD-3655 / PCC-004.
 *
 * A plate that conditions a subject should not be soft, and autofocus on a
 * featureless prop hunts — so the director taps the thing that matters and the
 * focus is held for the whole turnaround.
 *
 * THIS TASK BREAKS THE PATTERN OF THE TWO BEFORE IT, and that is the finding it
 * rests on. PCC-002 and PCC-003 carry a VALUE across a lens change: an exposure
 * and a colour mean the same thing on any lens, refitted to its limits.
 * AVCaptureDevice.h:1265 says a lens position does not —
 *
 *   "Note that a given lens position value does not correspond to an exact
 *    physical distance, nor does it represent a consistent focus distance from
 *    device to device."
 *
 * So 0.6 on the wide is a different physical distance from 0.6 on the
 * telephoto, and carrying the number across a lens change focuses somewhere
 * nobody chose. What IS meaningful across lenses is the POINT — the same part
 * of the frame — so the point is carried and the position is re-derived by
 * focusing again.
 *
 * AND SETTING THE POINT DOES NOTHING ON ITS OWN. :1155 is explicit: "setting
 * focusPointOfInterest alone does not initiate a focus operation. After setting
 * focusPointOfInterest, call -setFocusMode: to apply the new point of
 * interest." A tap that sets only the point is a silent no-op — the most
 * expensive kind, because the UI shows a focus square and nothing focuses.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');
const src = () => fs.readFileSync(SWIFT, 'utf8');
/** Comments stripped — a mention is not a use, which has cost seven false passes here. */
const code = () => src().split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** Cut a declaration out by BRACE DEPTH — never by a character window. */
function extract(header) {
    const s = src();
    const at = s.indexOf(header);
    assert.notStrictEqual(at, -1,
        `PlateCamera.swift declares no '${header}'. If it was renamed this test cannot see the `
        + 'code it exists to check, and would pass by finding nothing');
    const open = s.indexOf('{', at);
    let depth = 0, i = open;
    for (; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}' && --depth === 0) break;
    }
    return s.slice(at, i + 1);
}

/** Compile the real FocusLock and run it. Foundation only — it must stay pure. */
function fit(points) {
    const body = extract('struct FocusLock');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-focus-'));
    const file = path.join(dir, 'main.swift');
    const calls = points.map(p => `FocusLock.point(x: ${p.x}, y: ${p.y})`).join(',\n  ');
    fs.writeFileSync(file, `import Foundation
${body}
let out = [
  ${calls}
]
print(out.map { "\\($0.x),\\($0.y)" }.joined(separator: ";"))
`);
    const bin = path.join(dir, 'probe');
    execFileSync('swiftc', ['-O', '-o', bin, file], { stdio: 'pipe' });
    return execFileSync(bin, { encoding: 'utf8' }).trim().split(';').map(r => {
        const [x, y] = r.split(',').map(Number);
        return { x, y };
    });
}

/**
 * The ways a converted tap can land outside what the device accepts.
 *
 * SET-BASED over both axes and both directions, because the failure is partial:
 * a clamp written `min(x, 1)` handles the far edge and lets a negative through,
 * and a tap at the near edge is exactly what rounding produces.
 */
const TAPS = [
    { name: 'centre',            x: 0.5,   y: 0.5,   expect: [0.5, 0.5] },
    { name: 'top-left corner',   x: 0,     y: 0,     expect: [0, 0] },
    { name: 'bottom-right',      x: 1,     y: 1,     expect: [1, 1] },
    { name: 'x just over',       x: 1.0001, y: 0.5,  expect: [1, 0.5] },
    { name: 'x just under',      x: -0.0001, y: 0.5, expect: [0, 0.5] },
    { name: 'y just over',       x: 0.5,   y: 1.2,   expect: [0.5, 1] },
    { name: 'y just under',      x: 0.5,   y: -0.3,  expect: [0.5, 0] },
    { name: 'both wild',         x: -9,    y: 42,    expect: [0, 1] },
];

test('EVERY tap lands inside the 0...1 the device documents', () => {
    /*
     * :1155 — (0,0) is the top left of the image and (1,1) the bottom right,
     * and setFocusPointOfInterest throws where the point is unsupported. A
     * converted tap at the very edge is exactly what rounding pushes out.
     */
    const got = fit(TAPS);
    const bad = [];
    TAPS.forEach((t, i) => {
        const g = got[i];
        if (g.x < 0 || g.x > 1 || g.y < 0 || g.y > 1) {
            bad.push(`${t.name}: (${g.x}, ${g.y}) is outside 0...1`);
        }
        if (Math.abs(g.x - t.expect[0]) > 1e-6 || Math.abs(g.y - t.expect[1]) > 1e-6) {
            bad.push(`${t.name}: got (${g.x}, ${g.y}), expected (${t.expect})`);
        }
    });
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('a tap inside the frame is passed through untouched', () => {
    // The other half: a clamp that always returns the centre is "in range" and
    // focuses on the wrong thing every time.
    const got = fit([{ x: 0.25, y: 0.75 }, { x: 0.9, y: 0.1 }]);
    assert.deepStrictEqual(got, [{ x: 0.25, y: 0.75 }, { x: 0.9, y: 0.1 }],
        'an in-range tap was moved; the director tapped a thing and the camera focused elsewhere');
});

test('a non-finite tap answers the centre rather than propagating NaN', () => {
    /*
     * NaN reaching setFocusPointOfInterest is undefined at best. The centre is
     * the documented default, so it is the honest fallback for "we do not know
     * where you tapped".
     */
    const got = fit([{ x: 'Double.nan', y: 0.5 }, { x: 0.5, y: 'Double.infinity' }]);
    for (const g of got) {
        assert.ok(Number.isFinite(g.x) && Number.isFinite(g.y),
            `a non-finite tap produced (${g.x}, ${g.y})`);
        assert.ok(g.x >= 0 && g.x <= 1 && g.y >= 0 && g.y <= 1, 'fallback is out of range');
    }
});

test('the point maths is pure — it cannot reach AVFoundation or a device', () => {
    // Comments stripped first: the doc comment ends a sentence with "into the
    // device.", which a naive substring search reads as a property access.
    const body = extract('struct FocusLock')
        .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const forbidden of ['AVCapture', 'session', 'device.']) {
        assert.ok(!body.includes(forbidden),
            `FocusLock touches ${forbidden}; it must be arithmetic, or it cannot be tested here`);
    }
});

/* ── the wiring, where this task's real risk lives ──────────────────────── */

test('the point is converted by the PREVIEW LAYER, not by hand', () => {
    /*
     * `captureDevicePointConverted(fromLayerPoint:)` accounts for videoGravity
     * (.resizeAspectFill CROPS the preview) and for orientation. Hand-rolling
     * that is a second implementation of Apple's transform that can disagree
     * with the picture on screen — and it disagrees silently, by focusing a
     * little way from where the director tapped.
     */
    const s = code();
    assert.match(s, /captureDevicePointConverted\(fromLayerPoint:/,
        'the tap is converted by hand rather than by the preview layer, which is the only thing '
        + 'that knows the gravity and the orientation');
});

test('setting the point is followed by setting the MODE', () => {
    /*
     * :1155 — "setting focusPointOfInterest alone does not initiate a focus
     * operation." A tap that sets only the point draws a focus square and
     * focuses nothing, which is indistinguishable from the feature working.
     */
    const s = code();
    const at = s.indexOf('focusPointOfInterest =');
    assert.notStrictEqual(at, -1, 'the focus point is never set');
    /*
     * Requires .autoFocus specifically. A generic /focusMode =/ was satisfied
     * by the `.locked` fallback further down and survived deleting the autofocus
     * step entirely — which IS the documented no-op, since locking pins the lens
     * where it already was and never focuses on the point just set.
     *
     * Bounded by the enclosing function's braces, never a character count.
     */
    const fnAt = s.lastIndexOf('func applyFocus', at);
    assert.notStrictEqual(fnAt, -1, 'the point is set outside applyFocus; re-derive this check');
    let d = 0, end = s.indexOf('{', fnAt);
    for (let i = end; i < s.length; i++) {
        if (s[i] === '{') d++; else if (s[i] === '}' && --d === 0) { end = i; break; }
    }
    const after = s.slice(at, end);
    assert.match(after, /focusMode\s*=\s*\.autoFocus/,
        'focusPointOfInterest is set and .autoFocus is never applied after it — the documented '
        + 'no-op: a focus square appears and nothing focuses, because locking alone pins the lens '
        + 'where it already was');
});

test('support is checked before both the point and a custom position', () => {
    const s = code();
    assert.match(s, /isFocusPointOfInterestSupported/,
        'the point is set without checking support; :1155 throws NSInvalidArgumentException where '
        + 'it is unsupported');
    assert.match(s, /[lL]ockingFocusWithCustomLensPositionSupported/,
        ':1125 — where this is false, setFocusModeLocked may only be called with '
        + 'AVCaptureLensPositionCurrent, and anything else throws');
});

test('a LENS CHANGE re-focuses at the point and does NOT carry the position', () => {
    /*
     * THE DECISION THIS TASK TURNS ON, and it is the opposite of PCC-002 and
     * PCC-003. :1265 — a lens position "does not represent a consistent focus
     * distance from device to device", so re-applying the number after a lens
     * change focuses at a distance nobody chose. The point is what survives.
     */
    const s = code();
    const at = s.indexOf('func select(');
    assert.notStrictEqual(at, -1, 'no select(); PCC-001 is not in place');
    const body = s.slice(at, s.indexOf('\n    }', at));
    assert.match(body, /[fF]ocus/,
        'select() ignores the focus lock entirely, so changing lens leaves the new lens on '
        + 'autofocus while the UI still shows a held focus');
    assert.ok(!/lensPosition:\s*(?!AVCaptureLensPositionCurrent)[a-z]/i.test(body),
        'select() re-applies a stored lensPosition. That number is not comparable across lenses '
        + '(:1265) — re-focus at the point instead');
});

test('the lock survives the WALK, and is releasable', () => {
    const s = code();
    assert.match(s, /func lockFocus|func focusAndLock|func focus\(/,
        'there is no way to take a focus lock');
    assert.match(s, /func unlockFocus|func releaseFocus/,
        'there is no way to release it — a view that genuinely needs re-focusing is stranded');
    const adv = s.slice(s.indexOf('private func advance()'), s.indexOf('private func advance()') + 300);
    assert.ok(!/unlockFocus|releaseFocus/.test(adv),
        'advancing a view releases the focus lock, which is exactly what must NOT happen: four '
        + 'views are meant to share a focal plane');
});

test('the tap target is on screen and the held state is visible', () => {
    const s = code();
    const overlay = s.slice(s.indexOf('private var overlay: some View'),
                            s.indexOf('private func take'));
    assert.match(overlay, /focus/i,
        'the overlay never mentions focus; a lock nobody can see is one a director cannot check');
    /*
     * UIKit as well as SwiftUI: the preview is a UIViewRepresentable, so the
     * correct mechanism there is a UITapGestureRecognizer. The first version of
     * this list was SwiftUI-only and reported a working tap target as missing.
     */
    assert.match(s, /onTapGesture|DragGesture|spatialTap|UITapGestureRecognizer/i,
        'there is no tap target, so the focus point can never be chosen');
    assert.match(s, /lockFocus\(at:/,
        'nothing hands a tapped point to the model, so the gesture reaches nothing');
});
