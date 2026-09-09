/**
 * RECORDING TRANSPORT — GRD-3798 / FCC-002.
 *
 * FCC-001 made the camera record. It records until somebody presses stop, and
 * nothing anywhere says how long that may be.
 *
 * THE NUMBER THIS TASK EXISTS FOR IS FOURTEEN SECONDS. `capture-policy.js`
 * puts the binding ceiling at 100MB, and 4K60 costs about 400MB a minute — so
 * a 4K60 take breaches it in 14 seconds. 4K30 gets 44. Today a director learns
 * that at UPLOAD, after the take, which is the exact failure `capture-policy`
 * was written to prevent and the reason the epic quotes the figure in its own
 * overview.
 *
 * THE ARITHMETIC IS MIRRORED, AND THAT IS DELIBERATE. Swift cannot require a
 * node module, so the budget exists twice — `capture-policy.js` for everything
 * server-side, `RecordingBudget` for the camera — on the precedent
 * `screenplay-pagination.js` and `shot-motion.js` already set in this codebase.
 * The mirror is only safe while something holds the two equal, which is what
 * this file is. Two budgets that disagree is worse than one that is wrong,
 * because the app then promises one duration and refuses a different one.
 *
 * SET-BASED OVER TWO CODE REGISTRIES, because both failures are partial and
 * silent:
 *
 *   1. `MODES` — 3 modes. A transport that counts down correctly for 1080p30
 *      and is wrong for 4k60 is wrong on the ONE mode where the ceiling
 *      actually bites, and an example test written against the first mode
 *      passes. The countdowns differ by an order of magnitude (133s vs 14s),
 *      so getting one right says nothing about the others.
 *   2. `CEILINGS` — 3 ceilings, and the transport must use the SMALLEST. The
 *      three are 150MB, 112.5MB and 100MB; picking the wrong one promises up
 *      to 50% more recording time than the clip can actually carry, and every
 *      take made on that promise is unusable. The minimum is computed here by
 *      iterating the registry rather than by naming the winner, so a fourth
 *      ceiling — or a change that makes a different one bind — is covered.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');
const { MODES, CEILINGS, maxSecondsFor, bindingBytes } = require('../lib/capture-policy');

const src = () => fs.readFileSync(SWIFT, 'utf8');
/** Comments stripped — a mention is not a use. */
const code = () => src().split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** Cut a declaration out by BRACE DEPTH — never a character window. */
function extract(header) {
    const s = src();
    const at = s.indexOf(header);
    assert.notStrictEqual(at, -1,
        `PlateCamera.swift declares no '${header}'. If it was renamed this test cannot see the `
        + 'arithmetic it exists to check, and would pass by finding nothing');
    /*
     * Skip the SIGNATURE before looking for the body.
     *
     * `func stopRecording(_ done: @escaping (URL?) -> Void = { _ in })` carries
     * a brace in its default value, and taking the first `{` extracted that
     * closure instead of the function — which silently turned every assertion
     * about the body into an assertion about `{ _ in }`, and reported a working
     * guard as missing. A declaration with no parameter list (a struct, an
     * enum) has no signature to skip.
     */
    const paren = s.indexOf('(', at);
    const brace = s.indexOf('{', at);
    let open;
    if (paren !== -1 && (brace === -1 || paren < brace)) {
        let p = 0, j = paren;
        for (; j < s.length; j++) {
            if (s[j] === '(') p++;
            else if (s[j] === ')' && --p === 0) break;
        }
        open = s.indexOf('{', j);
    } else {
        open = brace;
    }
    let depth = 0, i = open;
    for (; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}' && --depth === 0) break;
    }
    return s.slice(at, i + 1);
}

/**
 * Compile the REAL budget out of the app and run it over every mode.
 *
 * Reading the numbers with a regex would confirm the file contains some digits.
 * Executing it is what makes "the two budgets agree" a fact rather than a hope.
 */
let cached;
function swiftBudget() {
    if (cached) return cached;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcc-transport-'));
    const file = path.join(dir, 'main.swift');
    fs.writeFileSync(file, `${extract('struct RecordingMode')}
${extract('enum RecordingBudget')}
print("CEILING=\\(RecordingBudget.ceilingBytes)")
for m in RecordingMode.all {
    let max = RecordingBudget.maxSeconds(m)
    // remaining at: the start, one second in, the last second, exactly the
    // ceiling, and well past it.
    let probes = [0, 1, max - 1, max, max + 60]
        .map { "\\($0):\\(RecordingBudget.remaining(m, elapsed: $0))" }
        .joined(separator: ",")
    let warn = [0, max - 1, max]
        .map { "\\($0):\\(RecordingBudget.isEndInSight(m, elapsed: $0) ? 1 : 0)" }
        .joined(separator: ",")
    print("MODE=\\(m.id)|\\(max)|\\(probes)|\\(warn)")
}
`);
    const out = execFileSync('swift', [file], { encoding: 'utf8', timeout: 180000 });
    const lines = out.trim().split('\n');
    const ceiling = +lines.find((l) => l.startsWith('CEILING=')).slice('CEILING='.length);
    const modes = {};
    for (const l of lines.filter((x) => x.startsWith('MODE='))) {
        const [id, max, probes, warn] = l.slice('MODE='.length).split('|');
        const pairs = (s) => Object.fromEntries(s.split(',').map((p) => p.split(':').map(Number)));
        modes[id] = { max: +max, remaining: pairs(probes), warn: pairs(warn) };
    }
    cached = { ceiling, modes };
    return cached;
}

/* ------------------------------------------------------------------ *
 * SET 1 — the ceiling, iterated rather than named                     *
 * ------------------------------------------------------------------ */

test('the camera budgets against the SMALLEST ceiling, not a chosen one', () => {
    const all = Object.entries(CEILINGS);
    assert.ok(all.length >= 3,
        `capture-policy declares only ${all.length} ceilings; the registry read is broken, and a `
        + 'minimum taken over almost nothing is not the binding one');

    const smallest = Math.min(...all.map(([, c]) => c.bytes));
    assert.strictEqual(smallest, bindingBytes(), 'the test computes a different minimum than the module');

    assert.strictEqual(swiftBudget().ceiling, smallest,
        `the camera budgets against ${swiftBudget().ceiling} bytes and the binding ceiling is `
        + `${smallest} (${all.map(([k, c]) => `${k}=${c.bytes}`).join(', ')}). Budgeting against a `
        + 'larger ceiling promises recording time the clip cannot carry — every take made on that '
        + 'promise is refused at upload, which is precisely what this task exists to prevent');
});

/* ------------------------------------------------------------------ *
 * SET 2 — every mode the registry declares                            *
 * ------------------------------------------------------------------ */

test('EVERY mode gets the same maximum duration the server would give it', () => {
    const ids = Object.keys(MODES);
    assert.ok(ids.length >= 3, `only ${ids.length} modes; the registry read is broken`);

    const wrong = [];
    for (const id of ids) {
        const swift = swiftBudget().modes[id];
        if (!swift) { wrong.push(`${id}: the camera has no budget for it`); continue; }
        const js = maxSecondsFor(id);
        if (swift.max !== js) {
            wrong.push(`${id}: the camera allows ${swift.max}s, the server allows ${js}s`);
        }
    }
    assert.deepStrictEqual(wrong, [],
        'the camera and the server disagree about how long a take may be. The director is shown '
        + 'one number and the upload enforces another, so a take that the transport said was '
        + `fine is refused after it was shot:\n  ${wrong.join('\n  ')}`);
});

test('EVERY mode counts down from its own maximum, one second at a time', () => {
    const wrong = [];
    for (const id of Object.keys(MODES)) {
        const m = swiftBudget().modes[id];
        if (!m) continue;                        // owned by the test above
        if (m.remaining[0] !== m.max) {
            wrong.push(`${id}: shows ${m.remaining[0]}s remaining before recording starts, not ${m.max}s`);
        }
        if (m.remaining[1] !== m.max - 1) {
            wrong.push(`${id}: after one second it shows ${m.remaining[1]}s, not ${m.max - 1}s`);
        }
        if (m.remaining[m.max - 1] !== 1) {
            wrong.push(`${id}: at the last second it shows ${m.remaining[m.max - 1]}s, not 1s`);
        }
    }
    assert.deepStrictEqual(wrong, [], `the countdown is wrong:\n  ${wrong.join('\n  ')}`);
});

test('EVERY mode clamps at zero — a countdown never goes negative', () => {
    const wrong = [];
    for (const id of Object.keys(MODES)) {
        const m = swiftBudget().modes[id];
        if (!m) continue;
        if (m.remaining[m.max] !== 0) {
            wrong.push(`${id}: at the ceiling it shows ${m.remaining[m.max]}s`);
        }
        if (m.remaining[m.max + 60] !== 0) {
            wrong.push(`${id}: a minute past the ceiling it shows ${m.remaining[m.max + 60]}s`);
        }
    }
    assert.deepStrictEqual(wrong, [],
        '"-12s remaining" is not a duration, and on the mode where the ceiling actually bites it '
        + `is what a director would be looking at:\n  ${wrong.join('\n  ')}`);
});

test('EVERY mode warns before the end, and is quiet at the start', () => {
    /*
     * The threshold has to SCALE with the mode or it is useless at one end.
     * 4k60 gets 14 seconds and 1080p30 gets 133: a fixed ten-second warning is
     * lit for most of the 4k60 budget — which is noise, and noise is what makes
     * a real warning unreadable — and is a rounding error on 1080p30.
     */
    const wrong = [];
    for (const id of Object.keys(MODES)) {
        const m = swiftBudget().modes[id];
        if (!m) continue;
        if (m.warn[0] !== 0) {
            wrong.push(`${id}: warns at the very start of a ${m.max}s budget, which is always-on`);
        }
        if (m.warn[m.max - 1] !== 1) {
            wrong.push(`${id}: does not warn with one second left`);
        }
        if (m.warn[m.max] !== 1) {
            wrong.push(`${id}: stops warning once the budget is spent`);
        }
    }
    assert.deepStrictEqual(wrong, [],
        `the end-in-sight warning is wrong:\n  ${wrong.join('\n  ')}`);
});

/* ------------------------------------------------------------------ *
 * SET 3 — the transport, and every operation the task names           *
 * ------------------------------------------------------------------ */

/**
 * The four the task names: "Start, stop, elapsed, and REMAINING against the
 * budget for the chosen format."
 *
 * Each needs BOTH halves. A model that computes remaining and shows it nowhere
 * is the failure this codebase has paid for repeatedly — a capability with no
 * control is indistinguishable from one that was never built. A control wired
 * to nothing looks identical to a working page until it is pressed.
 */
const TRANSPORT = [
    {
        op: 'start',
        model: /func startRecording\(/,
        surface: /startRecording\(/,
        why: 'nothing can begin a take',
    },
    {
        op: 'stop',
        model: /func stopRecording\(/,
        surface: /stopRecording\s*[({]/,
        why: 'a take can be started and never ended',
    },
    {
        op: 'elapsed',
        model: /var elapsedSeconds\b/,
        surface: /elapsedSeconds\b/,
        why: 'the director cannot see how long the take has been running',
    },
    {
        op: 'remaining',
        model: /var secondsRemaining\b/,
        surface: /secondsRemaining\b/,
        why: 'the whole point of the task — the clip end arrives unannounced',
    },
];

/** The view layer only, so a model symbol cannot satisfy a surface check. */
function transportView() {
    return extract('struct RecordingTransport');
}

test('EVERY transport operation exists on the MODEL', () => {
    const cam = code();
    const missing = TRANSPORT.filter((t) => !t.model.test(cam))
        .map((t) => `${t.op}: ${t.why}`);
    assert.deepStrictEqual(missing, [],
        `the transport model is incomplete:\n  ${missing.join('\n  ')}`);
});

test('EVERY transport operation reaches the SURFACE', () => {
    const view = transportView();
    const missing = TRANSPORT.filter((t) => !t.surface.test(view))
        .map((t) => `${t.op}: computed and never shown — ${t.why}`);
    assert.deepStrictEqual(missing, [],
        'the transport view does not use what the model computes. A number the model holds and '
        + 'the view never paints is indistinguishable from one that was never computed:\n  '
        + missing.join('\n  '));
});

test('the transport is actually placed on the camera, not merely declared', () => {
    const cam = code();
    assert.ok(/RecordingTransport\s*\(/.test(cam),
        'RecordingTransport is declared and never constructed. A view nothing places is a view '
        + 'nobody sees — the same defect as a button wired to nothing, one level up');
});

test('the record control is separate from the stills shutter', () => {
    /*
     * The plate camera's shutter must keep taking plates. FCC-001 kept the
     * photo output alive precisely so stills were not traded for footage, and a
     * transport that replaced the shutter would complete that trade in the UI
     * instead of in the capture session.
     */
    const cam = code();
    assert.ok(/func shoot\(/.test(cam) && /func take\(\)/.test(cam),
        'the stills path lost its shutter when the transport arrived');
});

/* ------------------------------------------------------------------ *
 * SET 4 — the ceiling is ENFORCED, not merely displayed               *
 * ------------------------------------------------------------------ */

test('the take stops itself at the ceiling', () => {
    /*
     * A countdown that reaches zero and keeps recording is advice nobody
     * enforced: every second after it produces a file that is already too big
     * to upload. Showing the number and then letting the take run past it is
     * the same failure as not showing it, with more steps.
     */
    const tick = extract('private func tick');
    assert.ok(/stopRecording/.test(tick),
        'the ticker never stops the take. The countdown reaches zero and the camera keeps '
        + 'recording into a file that can no longer be uploaded');
    assert.ok(/secondsRemaining|remaining/.test(tick),
        'the ticker does not consult the remaining time, so whatever stops the take is not the '
        + 'budget');
});

test('the ticker is cancelled when the take ends, not left running', () => {
    const stop = extract('func stopRecording');
    assert.ok(/ticker/.test(stop),
        'stopRecording does not touch the ticker. A timer left running after the take keeps the '
        + 'elapsed count climbing against a recording that no longer exists');
});
