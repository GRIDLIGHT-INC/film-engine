/**
 * WHITE BALANCE LOCK — GRD-3654 / PCC-003.
 *
 * A plate that matches on brightness and not colour still disagrees, so the
 * white balance locks and releases WITH the exposure by default. PCC-002 made
 * four views agree about how bright they are; this makes them agree about what
 * colour the light was.
 *
 * THE RULES ARE APPLE'S AND THEY ARE UNUSUAL. Verified against
 * iPhoneOS26.1.sdk, AVCaptureDevice.h:1795 —
 *
 *   "Gain values are normalized to the minimum channel value to avoid
 *    brightness changes (e.g. R:2 G:2 B:4 will be normalized to R:1 G:1 B:2).
 *    For each channel ... only values between 1.0 and maxWhiteBalanceGain AFTER
 *    NORMALIZATION are supported. This method throws an NSRangeException if any
 *    of the whiteBalanceGains are set to an unsupported level."
 *
 * Three consequences drive everything below. Normalisation is to the MINIMUM
 * channel, not to green and not to 1.0 flat. The range is checked AFTER it. And
 * a violation is a THROWN EXCEPTION, so an unfitted gain crashes the camera
 * rather than tinting a plate.
 *
 * AND THE LIMIT MOVES WITH THE LENS. `maxWhiteBalanceGain` is a property of
 * AVCaptureDevice, not of the format — so PCC-001's picker changes it, exactly
 * as the exposure ranges moved in PCC-002. A cast metered on the wide can be
 * inexpressible on the telephoto.
 *
 * As in plate-lens and plate-exposure, the arithmetic is extracted from the
 * shipping source and EXECUTED: a normalisation can be present, well named, and
 * dividing by the wrong channel.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');
const src = () => fs.readFileSync(SWIFT, 'utf8');
/** Comments stripped: a mention is not a use, which has cost four false passes here. */
const code = () => src().split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** Cut a declaration out by BRACE DEPTH — never by a character window. */
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

/** Compile the real WhiteBalanceLock and run it. Foundation only — it must be pure. */
function fit(cases) {
    const body = extract('struct WhiteBalanceLock');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-wb-'));
    const file = path.join(dir, 'main.swift');
    const calls = cases.map(c =>
        `WhiteBalanceLock.fit(red: ${c.r}, green: ${c.g}, blue: ${c.b}, maxGain: ${c.max})`).join(',\n  ');
    fs.writeFileSync(file, `import Foundation
${body}
let out = [
  ${calls}
]
print(out.map { "\\($0.red),\\($0.green),\\($0.blue),\\($0.stopsOff)" }.joined(separator: ";"))
`);
    const bin = path.join(dir, 'probe');
    execFileSync('swiftc', ['-O', '-o', bin, file], { stdio: 'pipe' });
    return execFileSync(bin, { encoding: 'utf8' }).trim().split(';').map(r => {
        const [red, green, blue, stopsOff] = r.split(',').map(Number);
        return { red, green, blue, stopsOff, gains: [red, green, blue] };
    });
}

/**
 * The ways a metered white balance can fail to fit a device.
 *
 * SET-BASED because the failure is partial by nature: normalising without
 * clamping crashes only on a wide cast, and clamping without normalising
 * crashes only on gains that arrive un-normalised — and an example built from
 * one lens passes in either state.
 */
const CASES = [
    // Apple's own worked example, quoted verbatim from the header.
    { name: "Apple's example R:2 G:2 B:4", r: 2, g: 2, b: 4, max: 4, expect: [1, 1, 2], exact: true },
    { name: 'already normalised',          r: 1, g: 1, b: 2, max: 4, expect: [1, 1, 2], exact: true },
    { name: 'neutral',                     r: 1, g: 1, b: 1, max: 4, expect: [1, 1, 1], exact: true },
    // Normalisation is to the MINIMUM channel, not to green: green is 3 here.
    { name: 'green is not the minimum',    r: 1.5, g: 3, b: 6, max: 8, expect: [1, 2, 4], exact: true },
    // A cast wider than this device can express: must clamp AND report.
    { name: 'exceeds maxGain',             r: 1, g: 1, b: 6, max: 4, expect: null, exact: false },
    // Gains arriving below 1.0 are invalid input; normalisation lifts them.
    { name: 'below 1.0',                   r: 0.5, g: 0.5, b: 1, max: 4, expect: [1, 1, 2], exact: true },
];

test('EVERY case normalises to the MINIMUM channel, as the header specifies', () => {
    const got = fit(CASES);
    const bad = [];
    CASES.forEach((c, i) => {
        const g = got[i];
        if (Math.abs(Math.min(...g.gains) - 1) > 1e-4) {
            bad.push(`${c.name}: smallest channel is ${Math.min(...g.gains)}, must be exactly 1.0 `
                     + 'after normalisation');
        }
        if (c.expect) {
            const off = c.expect.map((v, k) => Math.abs(g.gains[k] - v)).filter(d => d > 1e-3);
            if (off.length) bad.push(`${c.name}: got [${g.gains}], expected [${c.expect}]`);
        }
    });
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('EVERY case lands inside [1, maxGain] — outside is a thrown NSRangeException', () => {
    const got = fit(CASES);
    const bad = [];
    CASES.forEach((c, i) => {
        for (const [k, v] of Object.entries(got[i].gains)) {
            if (v < 1 - 1e-4 || v > c.max + 1e-4) {
                bad.push(`${c.name}: channel ${k} is ${v}, outside [1, ${c.max}] — this THROWS on `
                         + 'the device rather than tinting a plate');
            }
        }
    });
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('the COLOUR is preserved wherever the device can express it', () => {
    /*
     * Normalisation must not change the cast — only the scale. The ratios
     * between channels ARE the colour, so a fit that alters them has silently
     * changed the white balance it was asked to hold.
     */
    const got = fit(CASES);
    const bad = CASES.map((c, i) => [c, got[i]]).filter(([c]) => c.exact).map(([c, g]) => {
        const want = [c.r, c.g, c.b];
        const k = g.gains[0] / want[0];
        const drift = want.map((w, j) => Math.abs(w * k - g.gains[j])).filter(d => d > 1e-3);
        return drift.length ? `${c.name}: ratios changed — [${want}] became [${g.gains}]` : null;
    }).filter(Boolean);
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('a cast the device cannot express is REPORTED, not delivered silently', () => {
    const i = CASES.findIndex(c => c.exact === false);
    const g = fit(CASES)[i];
    assert.ok(Math.abs(g.stopsOff) > 0.1,
        `the cast was clamped and stopsOff is ${g.stopsOff} — a quietly warmer plate looks like `
        + 'the lock worked, and the mismatch is found after the frames are generated');
    assert.ok(Number.isFinite(g.stopsOff), 'stopsOff is not finite');
});

test('an exactly-expressible cast reports NO shift', () => {
    // The other half: a fit that always reports a shift is a warning nobody reads.
    const got = fit(CASES);
    const bad = CASES.map((c, i) => [c, got[i]]).filter(([c, g]) => c.exact && Math.abs(g.stopsOff) > 0.01)
        .map(([c, g]) => `${c.name}: reports ${g.stopsOff} stops off but was expressible exactly`);
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('degenerate gains answer safely rather than trapping', () => {
    /*
     * Dividing by the minimum channel is a division by zero when a channel is
     * zero, and NaN propagates straight into setWhiteBalanceModeLocked. The
     * same "0 means unknown" convention has now bitten videoFieldOfView in
     * PCC-001 and the exposure ranges in PCC-002.
     */
    const got = fit([
        { r: 0, g: 0, b: 0, max: 4 },
        { r: -1, g: 2, b: 3, max: 4 },
        { r: 1, g: 1, b: 2, max: 0 },        // a device reporting no headroom
    ]);
    for (const g of got) {
        for (const v of g.gains) {
            assert.ok(Number.isFinite(v) && v >= 1 - 1e-4,
                `a degenerate input produced gain ${v}; every channel must stay >= 1 and finite`);
        }
        assert.ok(Number.isFinite(g.stopsOff), `stopsOff ${g.stopsOff} is not finite`);
    }
});

test('the fit is pure — it cannot reach AVFoundation or a device', () => {
    const body = extract('struct WhiteBalanceLock');
    for (const forbidden of ['AVCapture', 'session', 'device.']) {
        assert.ok(!body.includes(forbidden),
            `WhiteBalanceLock touches ${forbidden}; it must be arithmetic, or it cannot be tested here`);
    }
});

/* ── the wiring ─────────────────────────────────────────────────────────── */

test('the lock is applied through the only API that can set it, and support is checked', () => {
    const s = code();
    assert.match(s, /setWhiteBalanceModeLocked\(with:/,
        'nothing calls setWhiteBalanceModeLocked — deviceWhiteBalanceGains is READ-ONLY, so no '
        + 'other call can set it');
    assert.match(s, /[lL]ockingWhiteBalanceWithCustomDeviceGainsSupported/,   // Swift getter is isLocking…
        'support is not checked. AVCaptureDevice.h:1715 is explicit: where this is NO, passing '
        + 'anything but AVCaptureWhiteBalanceGainsCurrent RESULTS IN AN EXCEPTION');
});

test('white balance locks and releases WITH exposure', () => {
    /*
     * The epic's own reasoning: a plate that matches on brightness and not
     * colour still disagrees. Two separate affordances would let a director
     * lock one and not the other and believe the turnaround is held.
     */
    const s = code();
    /*
     * Requires the APPLY CALL, not a mention. The first version matched
     * /whiteBalance/ over the body and survived deleting the call, because
     * `whiteBalance = WhiteBalanceLock(...)` still mentions it — a lock that is
     * recorded in state and never pushed to the device.
     */
    const lock = s.slice(s.indexOf('func lockExposure'), s.indexOf('func unlockExposure'));
    assert.match(lock, /applyWhiteBalance\(/,
        'locking the exposure records a white balance but never applies it to the device');
    /*
     * Requires the DEVICE to be put back on auto. Clearing the published
     * properties alone leaves the hardware locked while the UI says otherwise —
     * and `whiteBalance = nil` satisfies any check that only looks for the word.
     * Bounded by brace depth from the declaration, never a character count.
     */
    const uAt = s.indexOf('func unlockExposure');
    let d = 0, uEnd = s.indexOf('{', uAt);
    for (let i = uEnd; i < s.length; i++) {
        if (s[i] === '{') d++; else if (s[i] === '}' && --d === 0) { uEnd = i; break; }
    }
    const unlock = s.slice(uAt, uEnd);
    assert.match(unlock, /whiteBalanceMode\s*=\s*\.continuousAutoWhiteBalance/,
        'releasing does not put the DEVICE back on auto white balance, so the colour stays pinned '
        + 'in hardware after the director has asked for auto');
});

test('the lock is re-applied after a lens change, refitted to the NEW device', () => {
    /*
     * maxWhiteBalanceGain is a property of the DEVICE, so the picker changes
     * it. Same interaction as the exposure ranges in PCC-002, and the same
     * consequence: not a mismatched plate but a thrown exception.
     */
    const s = code();
    const at = s.indexOf('func select(');
    assert.notStrictEqual(at, -1, 'no select(); PCC-001 is not in place');
    const body = s.slice(at, s.indexOf('\n    }', at));
    assert.match(body, /whiteBalance/i,
        'select() never re-applies the white balance lock — changing lens drops the colour lock '
        + 'while the UI still reads LOCK');
});

test('the held colour is shown as a temperature, not as raw gains', () => {
    const s = code();
    assert.match(s, /temperatureAndTintValues/,
        'the gains are never converted; "R:1 G:1 B:2" is not something a director can judge');
    const overlay = s.slice(s.indexOf('private var overlay: some View'),
                            s.indexOf('private func take'));
    /*
     * Bound to the RENDERED text. The first version matched
     * `camera.whiteBalance` anywhere in the overlay and survived removing the
     * label from the chip, because the accessibility string still mentions it —
     * a value announced to VoiceOver and invisible to everyone else.
     */
    /*
     * Both bounds relative to the exposure chip. The end bound was originally
     * `overlay.indexOf('.accessibilityLabel')` — the FIRST one in the overlay —
     * and PCC-004 added a focus chip ABOVE this one, so that index moved before
     * the start and the slice became empty. An empty slice fails, which is the
     * safe direction, but the check was measuring the wrong region either way.
     */
    const chip = overlay.indexOf('Text(camera.exposure');
    assert.notStrictEqual(chip, -1, 'the exposure chip is gone; re-derive this check');
    const rendered = overlay.slice(chip, overlay.indexOf('.accessibilityLabel', chip));
    assert.match(rendered, /whiteBalanceLabel/,
        'the chip never renders the held white balance; a colour lock nobody can see is one a '
        + 'director cannot check before shooting four views with it');
});
