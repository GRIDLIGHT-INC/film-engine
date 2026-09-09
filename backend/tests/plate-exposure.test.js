/**
 * EXPOSURE LOCK — GRD-3653 / PCC-002.
 *
 * Four views shot on autoexposure disagree about brightness, and the front
 * plate is attached to every frame the character appears in. So the exposure is
 * metered ONCE and held for the whole turnaround.
 *
 * THE HARD PART IS NOT THE LOCK, IT IS THE LENS CHANGE.
 *
 * `minISO`, `maxISO`, `minExposureDuration` and `maxExposureDuration` are
 * properties of `AVCaptureDeviceFormat` — verified against iPhoneOS26.1.sdk —
 * so they change when PCC-001's picker changes lens. An exposure metered on the
 * wide can be OUT OF RANGE on the telephoto, and AVCaptureDevice documents that
 * "only ISO values between activeFormat.minISO and activeFormat.maxISO are
 * supported": passing one outside raises NSInvalidArgumentException. Unhandled,
 * changing lens with the lock on does not produce a mismatched plate, it
 * crashes the camera.
 *
 * CLAMPING ALONE IS THE WRONG FIX, and that is the judgement this rests on.
 * Clamping ISO 400 to a telephoto's max of 200 makes that view a stop darker —
 * the views disagree about brightness, which is the exact failure the lock
 * exists to prevent. Exposure is duration x ISO, so the shortfall is moved into
 * the other term and the brightness is preserved. When BOTH terms are pinned it
 * cannot be preserved, and the residual is REPORTED in stops rather than
 * delivered silently.
 *
 * As in plate-lens.test.js, the pure arithmetic is extracted from the shipping
 * source and EXECUTED. A clamp can be present, well named and wrong in one
 * direction only.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');
const src = () => fs.readFileSync(SWIFT, 'utf8');

/** Cut a declaration out of the source by BRACE DEPTH — never a character window. */
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
 * Compile the real `ExposureLock` and run it over a set of cases.
 *
 * Foundation only: the type must not touch AVFoundation, or it cannot be
 * exercised off-device — and every property it reasons about is
 * API_UNAVAILABLE(macos).
 */
function fit(cases) {
    const body = extract('struct ExposureLock');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-exp-'));
    const file = path.join(dir, 'main.swift');
    const calls = cases.map(c =>
        `ExposureLock.fit(seconds: ${c.s}, iso: ${c.iso}, minSeconds: ${c.minS}, `
        + `maxSeconds: ${c.maxS}, minISO: ${c.minISO}, maxISO: ${c.maxISO})`).join(',\n  ');
    fs.writeFileSync(file, `import Foundation
${body}
let out = [
  ${calls}
]
print(out.map { "\\($0.seconds),\\($0.iso),\\($0.stopsOff)" }.joined(separator: ";"))
`);
    const bin = path.join(dir, 'probe');
    execFileSync('swiftc', ['-O', '-o', bin, file], { stdio: 'pipe' });
    return execFileSync(bin, { encoding: 'utf8' }).trim().split(';').map(r => {
        const [s, iso, stops] = r.split(',').map(Number);
        return { seconds: s, iso, stopsOff: stops };
    });
}

/** A realistic format range. The wide is generous; the telephoto is not. */
const WIDE = { minS: 1 / 8000, maxS: 1, minISO: 34, maxISO: 3072 };
const TELE = { minS: 1 / 8000, maxS: 1 / 3, minISO: 34, maxISO: 200 };

/**
 * The ways a metered exposure can fail to fit a format.
 *
 * SET-BASED because the failure is partial by nature: a clamp written with
 * `min(iso, maxISO)` handles the high side perfectly and does nothing at all on
 * the low side, and an example test built from one lens passes in that state.
 */
const VIOLATIONS = [
    { name: 'fits already',        s: 1 / 60,   iso: 400,  ...WIDE, expectStops: 0 },
    { name: 'iso above max',       s: 1 / 60,   iso: 400,  ...TELE, expectStops: 0 },
    { name: 'iso below min',       s: 1 / 60,   iso: 10,   ...WIDE, expectStops: 0 },
    { name: 'duration above max',  s: 2,        iso: 100,  ...WIDE, expectStops: 0 },
    { name: 'duration below min',  s: 1 / 20000, iso: 800, ...WIDE, expectStops: 0 },
    { name: 'both pinned high',    s: 1,        iso: 3072, ...TELE, expectStops: null }, // cannot preserve
];

test('EVERY way an exposure can miss a format is fitted, not passed through', () => {
    const got = fit(VIOLATIONS);
    const bad = [];
    VIOLATIONS.forEach((v, i) => {
        const g = got[i];
        if (!(g.seconds >= v.minS - 1e-12 && g.seconds <= v.maxS + 1e-12)) {
            bad.push(`${v.name}: duration ${g.seconds} outside [${v.minS}, ${v.maxS}] — this raises `
                     + 'NSInvalidArgumentException on the device');
        }
        if (!(g.iso >= v.minISO - 1e-4 && g.iso <= v.maxISO + 1e-4)) {
            bad.push(`${v.name}: iso ${g.iso} outside [${v.minISO}, ${v.maxISO}] — this raises `
                     + 'NSInvalidArgumentException on the device');
        }
    });
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('brightness is PRESERVED wherever the format leaves room', () => {
    /*
     * Exposure is duration x ISO. Clamping one term and leaving the other alone
     * changes the brightness, so the very lens change the picker now permits
     * would produce the mismatched plate this lock exists to prevent.
     */
    const got = fit(VIOLATIONS);
    const bad = VIOLATIONS.map((v, i) => [v, got[i]])
        .filter(([v, g]) => v.expectStops === 0 && Math.abs(g.stopsOff) > 0.01)
        .map(([v, g]) => `${v.name}: ${g.stopsOff.toFixed(3)} stops off, and the format had room`);
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('when it CANNOT be preserved the shortfall is reported, not swallowed', () => {
    /*
     * A silently darker plate is worse than a reported one: it looks like the
     * lock worked, and the mismatch is found after the frames are generated.
     */
    const i = VIOLATIONS.findIndex(v => v.expectStops === null);
    const g = fit(VIOLATIONS)[i];
    assert.ok(Math.abs(g.stopsOff) > 0.5,
        `both terms are pinned and stopsOff is ${g.stopsOff} — the shortfall must be reported`);
    assert.ok(Number.isFinite(g.stopsOff), 'stopsOff is not a finite number');
});

test('a degenerate format answers safely rather than trapping', () => {
    /*
     * log2(0) is -Infinity and 0/0 is NaN; either reaching setExposureModeCustom
     * is a crash. A format reporting zeroes is not hypothetical — the same
     * "0 means unknown" convention bit PCC-001 on videoFieldOfView.
     */
    const got = fit([
        { name: 'zero range', s: 0, iso: 0, minS: 0, maxS: 0, minISO: 0, maxISO: 0 },
        { name: 'inverted',   s: 1 / 60, iso: 400, minS: 1, maxS: 1 / 8000, minISO: 3072, maxISO: 34 },
    ]);
    for (const g of got) {
        assert.ok(Number.isFinite(g.seconds) && g.seconds >= 0, `duration ${g.seconds} is not usable`);
        assert.ok(Number.isFinite(g.iso) && g.iso >= 0, `iso ${g.iso} is not usable`);
        assert.ok(Number.isFinite(g.stopsOff), `stopsOff ${g.stopsOff} is not finite`);
    }
});

test('the fit is pure — it cannot reach AVFoundation or a device', () => {
    const body = extract('struct ExposureLock');
    for (const forbidden of ['AVCapture', 'session', 'device.']) {
        assert.ok(!body.includes(forbidden),
            `ExposureLock touches ${forbidden}; it must be arithmetic, or it cannot be tested here`);
    }
});

/* ── the wiring ─────────────────────────────────────────────────────────── */

test('the lock is applied through the only API that can set it', () => {
    const s = src();
    assert.match(s, /setExposureModeCustom\(duration:[\s\S]{0,200}?iso:/,
        'nothing calls setExposureModeCustom — exposureDuration and ISO are READ-ONLY, so no other '
        + 'call can set them');
    assert.match(s, /isExposureModeSupported\(\.custom\)/,
        'support is not checked; a format that cannot do custom exposure must degrade, not fail');
    assert.match(s, /lockForConfiguration/,
        'the device is mutated without lockForConfiguration');
});

/**
 * `select()`'s body, PLUS the body of any helper in this file that it calls.
 *
 * FOLLOWS ONE CALL LEVEL, widened by FCC-004 (GRD-3800). select() used to hold
 * its own copy of the three re-apply lines. FCC-002 then added two more
 * reconfiguration sites — `startRecording` and `restorePreset`, both of which
 * change `sessionPreset` and so release every lock — and all three now share a
 * single `reapplyLocks` helper, because three copies is exactly how one of them
 * comes to carry the focus lock and the others do not.
 *
 * A call-site match reported that refactor as a LOST LOCK. This is strictly
 * stronger than the literal it replaces: it fails when select re-applies
 * nothing, and it also fails when the helper select delegates to drops a lock —
 * which a call-site match could never see.
 *
 * ONE level, and only functions declared in this file: an unbounded walk
 * eventually reaches something unrelated that mentions the lock and reports a
 * broken re-apply as covered.
 */
function selectRegion(s) {
    const at = s.indexOf('func select(');
    assert.notStrictEqual(at, -1, 'no select(); PCC-001 is not in place');
    const body = s.slice(at, s.indexOf('\n    }', at));
    let region = body;
    for (const m of body.matchAll(/\b([a-z]\w+)\(/g)) {
        const h = s.indexOf(`func ${m[1]}(`);
        if (h !== -1) region += '\n' + s.slice(h, s.indexOf('\n    }', h));
    }
    return region;
}

test('the lock is re-applied after a lens change, refitted to the NEW format', () => {
    /*
     * The interaction that made PCC-001 a prerequisite. A lock is set on the
     * AVCaptureDevice; selecting another lens is a different device with a
     * different format, so the lock is both DROPPED and potentially illegal.
     */
    /*
     * COMMENTS STRIPPED, and an actual CALL required. The first version matched
     * /apply|exposure/i over the raw body and passed with the re-apply line
     * deleted — the comment explaining the mechanism was enough to satisfy it.
     * Third time in this session that a mention has been mistaken for a use.
     */
    const s = src().split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const body = selectRegion(s);
    assert.match(body, /apply\([^)]*,\s*to:/,
        'select() never CALLS apply(_:to:) — changing lens silently drops the lock, and the next '
        + 'plate is metered automatically while the UI still reads LOCK');
    assert.match(body, /exposure/,
        'select() does not consult the held exposure at all');
});

test('the lock is metered once and survives the walk, releasable per view', () => {
    const s = src();
    assert.match(s, /func lockExposure|func meterAndLock/,
        'there is no way to take the lock');
    assert.match(s, /func unlockExposure|func releaseExposure/,
        'there is no way to release it — a subject that genuinely needs re-metering is stranded');
    assert.ok(!/advance\(\)[\s\S]{0,200}unlockExposure/.test(s),
        'advancing a view releases the lock, which is exactly what must NOT happen: the lock is '
        + 'held ACROSS the turnaround');
});

test('the locked state is visible, with the values it is holding', () => {
    /*
     * Bound to the VIEW BODY with comments stripped, because the first version
     * of this check passed against a source that had no UI at all — the words
     * LOCK and ISO both appear in the comments explaining the mechanism. A
     * mention is not a control; this codebase has now paid for that three
     * times in one session.
     */
    const s = src();
    const at = s.indexOf('private var overlay: some View');
    assert.notStrictEqual(at, -1, 'no overlay to render the lock into');
    const body = s.slice(at, s.indexOf('\n    private func take', at))
        .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    assert.match(body, /camera\.exposure/,
        'the overlay never reads camera.exposure; an invisible lock is indistinguishable from '
        + 'none, and a director re-meters by habit');
    assert.match(body, /\.label/,
        'the held values are not shown, so a wrong lock cannot be spotted before the plate is shot');
    assert.match(body, /lockExposure|unlockExposure/,
        'there is no control to take or release the lock');
    assert.match(body, /exposureWarning/,
        'the overlay never shows exposureWarning — a lens that cannot reach the held exposure '
        + 'would deliver a quietly darker plate');
});
