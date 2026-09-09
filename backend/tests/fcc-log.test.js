/**
 * HEVC APPLE LOG AS THE DEFAULT — GRD-3801 / FCC-005.
 *
 * Everything the camera has recorded so far is Rec.709 — a display-referred
 * picture with the grade baked in. That is fine for a reference plate and wrong
 * for footage: a shot that has to be graded alongside generated material needs
 * the latitude, and Apple Log is the only gradeable format that fits the
 * existing upload pipe. ProRes is roughly seven gigabytes a minute and is
 * inseparable from external storage (FCC-007, FCC-009).
 *
 * TWO WAYS THIS FAILS SILENTLY, AND BOTH ARE WHY THE TASK EXISTS.
 *
 * 1. THE SESSION OVERRIDES IT. `AVCaptureSession` sets the device's colour
 *    space itself unless `automaticallyConfiguresCaptureDeviceForWideColor` is
 *    turned off first. Assign `.appleLog`, leave that flag alone, and the
 *    session quietly puts it back — the take records Rec.709, looks completely
 *    normal, and is ungradeable. Nothing errors. The task names this exact
 *    property for exactly this reason.
 *
 * 2. THE RATE CHANGES AND THE BUDGET DOES NOT KNOW. `capture-policy.js` prices
 *    4K30 at Apple's nominal HEVC figure of 135 MB/min. The epic's own number
 *    for Apple Log at 4K30 is ~200 MB/min — 48% more. Recording log against the
 *    Rec.709 budget promises a 44-second take and delivers about 30, and the
 *    director discovers it at upload. That is precisely the invariant FCC-001
 *    pinned: the camera must record at the rate the budget was computed from.
 *
 * SET-BASED OVER TWO REGISTRIES, both of which GROW because of this task:
 *
 *   1. `MODES` — 3 before, 4 after. Every mode must agree with the camera about
 *      its rate AND its colour space, in both directions. A log mode priced at
 *      the Rec.709 rate is the second failure above; a mode the camera records
 *      in log while the budget thinks it is Rec.709 is the same thing wearing a
 *      different hat.
 *   2. The claim registries that pin `activeColorSpace` as ABSENT — 4 claims
 *      across 4 files, three of them SPLIT out of the old AVAssetWriter claims
 *      by FCC-001 precisely so they would still say something true today. Every
 *      one fires when this lands, and reshaping one while three stay red is the
 *      half-done fix this file refuses.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');
const { MODES } = require('../lib/capture-policy');

const src = () => fs.readFileSync(SWIFT, 'utf8');
/** Comments stripped — a mention is not a use. */
const code = () => src().split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** Cut a declaration out by BRACE DEPTH, skipping the signature's own braces. */
function extract(header, from) {
    const s = from || src();
    const at = s.indexOf(header);
    if (at === -1) return null;
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

/** Compile the REAL mode table out of the app and run it. */
let cached;
function swiftModes() {
    if (cached) return cached;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcc-log-'));
    const file = path.join(dir, 'main.swift');
    fs.writeFileSync(file, `${extract('struct RecordingMode')}
for m in RecordingMode.all {
    print("\\(m.id)|\\(m.bytesPerSecond)|\\(m.colorSpace)|\\(m.isGradeable)")
}
`);
    const out = execFileSync('swift', [file], { encoding: 'utf8', timeout: 180000 });
    cached = out.trim().split('\n').map((r) => {
        const [id, bytes, colorSpace, gradeable] = r.split('|');
        return { id, bytesPerSecond: +bytes, colorSpace, gradeable: gradeable === 'true' };
    });
    return cached;
}

/* ------------------------------------------------------------------ *
 * SET 1 — the mode registry, which grows from three to four           *
 * ------------------------------------------------------------------ */

test('the budget prices a colour space for EVERY mode', () => {
    const ids = Object.keys(MODES);
    assert.ok(ids.length >= 4,
        `capture-policy declares ${ids.length} modes. Apple Log at 4K30 costs about half as much `
        + 'again as Rec.709, so it cannot share a Rec.709 mode\'s price — it needs its own entry '
        + 'or every duration the app promises for it is wrong');

    const missing = ids.filter((id) => !MODES[id].color_space);
    assert.deepStrictEqual(missing, [],
        `these modes state no colour space: ${missing.join(', ')}. Without it the camera and the `
        + 'budget cannot be held to recording the same thing, and a log take priced as Rec.709 '
        + 'promises 48% more recording time than it has');
});

test('EVERY mode agrees with the camera about its rate AND its colour space', () => {
    const swift = swiftModes();
    const js = Object.keys(MODES).sort();
    assert.deepStrictEqual(swift.map((m) => m.id).sort(), js,
        `the camera records ${swift.map((m) => m.id).join(', ')} and the budget prices `
        + `${js.join(', ')}. One of them knows about a format the other does not`);

    const wrong = [];
    for (const m of swift) {
        const budget = MODES[m.id];
        if (!budget) continue;
        if (m.bytesPerSecond !== budget.bytes_per_second) {
            wrong.push(`${m.id}: records ${m.bytesPerSecond} B/s, budget assumes `
                + `${budget.bytes_per_second} B/s`);
        }
        if (m.colorSpace !== budget.color_space) {
            wrong.push(`${m.id}: records ${m.colorSpace}, budget prices ${budget.color_space}`);
        }
    }
    assert.deepStrictEqual(wrong, [],
        'the camera and the budget disagree about what is being recorded. Every "seconds '
        + 'remaining" the transport shows is computed from capture-policy, so a mismatch is a '
        + `promise the recorder breaks silently:\n  ${wrong.join('\n  ')}`);
});

test('a log mode costs MORE than the same raster in Rec.709', () => {
    /*
     * The check that catches the tempting shortcut: adding a log mode by
     * copying the Rec.709 entry and changing its name. It would pass every
     * agreement test above — the two registries would agree perfectly with each
     * other and both be wrong about the file.
     */
    const log = swiftModes().filter((m) => m.gradeable);
    assert.ok(log.length >= 1, 'no gradeable mode — Apple Log was not added');

    const wrong = [];
    for (const m of log) {
        const raster = m.id.replace(/-\w+$/, '');
        const plain = swiftModes().find((x) => x.id === raster && !x.gradeable);
        if (!plain) continue;
        if (m.bytesPerSecond <= plain.bytesPerSecond) {
            wrong.push(`${m.id} is priced at ${m.bytesPerSecond} B/s and ${plain.id} at `
                + `${plain.bytesPerSecond} B/s — log cannot cost the same or less`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('EVERY mode id names its own colour space, and the two agree', () => {
    const wrong = [];
    for (const m of swiftModes()) {
        const spec = /^(\d+)(?:p|k)(\d+)(?:-(\w+))?$/.exec(m.id);
        assert.ok(spec, `mode id ${m.id} does not name a resolution and a rate`);
        const suffix = spec[3];
        if (m.gradeable && !suffix) {
            wrong.push(`${m.id} records log and its id does not say so — a director choosing from `
                + 'a list cannot tell it apart from the Rec.709 mode beside it');
        }
        if (!m.gradeable && suffix) {
            wrong.push(`${m.id} carries the suffix "${suffix}" and is not gradeable`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

/* ------------------------------------------------------------------ *
 * SET 2 — the session must be stopped from overriding it              *
 * ------------------------------------------------------------------ */

test('the session is told NOT to configure the colour space itself', () => {
    /*
     * THE defect this task names. Without it, assigning `.appleLog` is undone
     * by the session and the take records Rec.709 — normal-looking, ungradeable
     * footage, no error anywhere.
     */
    const cam = code();
    assert.ok(/automaticallyConfiguresCaptureDeviceForWideColor\s*=\s*false/.test(cam),
        'the session still configures the device for wide colour, so it overrides any colour '
        + 'space the camera sets. Apple Log would be assigned and silently replaced');

    const configure = extract('private func configure');
    assert.ok(configure && /automaticallyConfiguresCaptureDeviceForWideColor/.test(configure),
        'the flag is not set during configure(). It has to be off before the session starts '
        + 'running, or the first thing the session does is override the colour space');
});

test('the colour space is applied only where the mode asks for it', () => {
    const start = extract('func startRecording');
    assert.ok(start, 'startRecording is gone');
    assert.ok(/activeColorSpace/.test(start) || /applyColorSpace|colourSpace|colorSpace/.test(start),
        'nothing in startRecording consults the mode\'s colour space, so choosing a log mode '
        + 'records Rec.709 under a log name');

    const cam = code();
    assert.ok(/supportedColorSpaces/.test(cam),
        'the format is never asked whether it supports the colour space. Assigning an unsupported '
        + 'one raises, and the raise happens at the moment the director presses record');
    assert.ok(/#available\(iOS 17/.test(cam),
        'Apple Log is iOS 17+ and this target is iOS 16, so the symbol needs an availability '
        + 'branch or the app does not build for its own deployment target');
});

test('a take that could NOT record log says so, rather than looking normal', () => {
    /*
     * The same rule the microphone follows. A log take that came back Rec.709
     * is ungradeable footage that plays perfectly — indistinguishable from a
     * successful one until somebody tries to grade it, by which point the shot
     * is over. An older phone degrading is legitimate; degrading in silence is
     * not.
     */
    const cam = code();
    assert.ok(/logUnavailable|notGradeable|colorSpaceProblem|ungradeable/i.test(cam),
        'nothing records why log could not be used, so a director cannot be told what they are '
        + 'not getting');
    const surface = extract('struct RecordingTransport');
    assert.ok(surface && /logUnavailable|notGradeable|colorSpaceProblem|ungradeable/i.test(surface),
        'the transport does not show that a log take is recording Rec.709. A take that is '
        + 'silently ungradeable is the whole failure this task exists to close');
});

test('the colour space is set AFTER the preset and BEFORE the locks are re-applied', () => {
    /*
     * Order, and both halves matter.
     *
     * AFTER the preset: which colour spaces exist is a property of the FORMAT,
     * and the session picks the format when the configuration commits. Asking
     * the old format whether it supports Apple Log answers about the format
     * being left behind.
     *
     * BEFORE the locks: FCC-004 re-applies exposure, white balance and focus
     * refitted to the current format. Changing the colour space afterwards
     * would reconfigure the device again underneath locks that were just
     * restored.
     */
    const start = extract('func startRecording');
    const commit = start.indexOf('commitConfiguration');
    const colour = start.search(/activeColorSpace|applyColorSpace|colourSpace|colorSpace/);
    const locks = start.search(/reapplyLocks\(/);

    assert.notStrictEqual(commit, -1, 'startRecording no longer commits a configuration');
    assert.ok(colour > commit,
        'the colour space is chosen before the configuration commits, so it is decided against '
        + 'the format being left behind');
    assert.ok(locks === -1 || colour < locks,
        'the colour space changes after the locks are restored, which reconfigures the device '
        + 'underneath them');
});

/* ------------------------------------------------------------------ *
 * SET 3 — every tripwire this task trips                              *
 * ------------------------------------------------------------------ */

/**
 * Four documents pin "there is no log colour space" as a GAP. Three of them
 * were SPLIT out of the old AVAssetWriter claims by FCC-001, deliberately, so
 * they would keep saying something true after recording landed. All four fire
 * now.
 */
const CLAIM_FILES = [
    'film-engine-camera-brief.test.js',
    'fcc-parity-epic.test.js',
    'fcc-parity-brief.test.js',
    'plate-camera-epic.test.js',
];

test('every claim registry that pinned activeColorSpace as absent has been RESHAPED', () => {
    const stale = [];
    let scanned = 0;
    for (const f of CLAIM_FILES) {
        const p = path.join(__dirname, f);
        assert.ok(fs.existsSync(p),
            `${f} is gone. It held a claim about this task; a scan that cannot find its subject `
            + 'reports the reshaping as done by looking at nothing');
        scanned++;
        fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
            /*
             * The absence idiom. `!cam.includes('activeColorSpace')` and
             * `['activeColorSpace'].filter(x => cam.includes(x))` are both
             * claims that it is missing; `filter(x => !cam.includes(x))` is a
             * PRESENCE check listing what has gone, and must not be flagged.
             */
            if (!line.includes('activeColorSpace')) return;
            if (/!\s*\w+\.includes\(['"]activeColorSpace/.test(line)
                || /\.filter\([^)]*=>\s*[A-Za-z]+\.includes/.test(line)) {
                stale.push(`${f}:${i + 1} still claims activeColorSpace is absent`);
            }
        });
    }
    assert.strictEqual(scanned, CLAIM_FILES.length, 'not every claim file was scanned');
    assert.deepStrictEqual(stale, [],
        'a document still claims there is no log colour space, and there is one. Reshape the '
        + `claim to pin what was BUILT rather than deleting it:\n  ${stale.join('\n  ')}`);
});

test('and each of those registries still MENTIONS the colour space', () => {
    /*
     * The pair matters, not either half. The test above says no registry claims
     * it is absent; this says every registry still talks about it. Deleting the
     * claim would satisfy the first perfectly, which is the reshaping this task
     * is supposed to do INSTEAD of deletion.
     */
    const missing = CLAIM_FILES.filter(
        (f) => !fs.readFileSync(path.join(__dirname, f), 'utf8').includes('activeColorSpace'));
    assert.deepStrictEqual(missing, [],
        `these dropped their colour-space claim instead of reshaping it: ${missing.join(', ')}. `
        + 'A deleted claim loses the record that the thing was built and stops anything noticing '
        + 'if it is removed again');
});
