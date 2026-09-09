/**
 * RECORD VIDEO AT ALL — GRD-3797 / FCC-001.
 *
 * Film Engine could generate footage and could not shoot any. The camera built
 * by the PCC epic is a stills camera: `AVCapturePhotoOutput` for the plate, and
 * an `AVCaptureVideoDataOutput` whose frames reach the monitoring tools and are
 * written NOWHERE. This task adds an `AVAssetWriter` fed from that same data
 * output, so the frames already arriving become a file.
 *
 * THE PHOTO OUTPUT STAYS, and that is a requirement rather than a courtesy.
 * Since iOS 16 a photo output and a video data output may both be active on one
 * session, so nothing about recording requires losing the plate camera — and an
 * epic that silently deleted stills would have traded one capability for
 * another rather than adding one.
 *
 * THE ASSERTION THAT MATTERS IS THE RATE, and its failure is invisible.
 *
 * `lib/capture-policy.js` already computes how many seconds fit under the
 * binding ceiling, from a per-mode `bytes_per_second`. Those numbers only mean
 * anything if the camera actually records at them. A recorder that encodes
 * 1080p30 at, say, twice the registry's rate produces a file that is fine, plays
 * fine, and blows the ceiling at half the duration the app promised — and the
 * director discovers it at upload, which is the exact failure `capture-policy`
 * was written to prevent. So the Swift rate table and the JS budget table are
 * held to EXACT equality here, in both directions.
 *
 * SET-BASED OVER TWO REGISTRIES, because both failures are partial:
 *
 *   1. `MODES` in capture-policy.js — 3 modes. A recorder that resolves 4k30
 *      and falls back for 4k60 records the wrong thing for one mode in three,
 *      silently, and an example test written against 1080p30 passes.
 *   2. The claim registries that pin AVAssetWriter as ABSENT — 5 claims across
 *      4 files. They are tripwires, deliberately placed, and every one of them
 *      fires when this lands. Reshaping one and leaving three red is the
 *      half-done fix this file exists to refuse.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SWIFT = path.join(ROOT, 'ios', 'FilmEngine', 'PlateCamera.swift');
const { MODES } = require('../lib/capture-policy');

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
    const open = s.indexOf('{', at);
    let depth = 0, i = open;
    for (; i < s.length; i++) {
        if (s[i] === '{') depth++;
        else if (s[i] === '}' && --depth === 0) break;
    }
    return s.slice(at, i + 1);
}

/**
 * Compile the REAL rate table out of the app and run it.
 *
 * Reading the numbers with a regex would check that the file contains some
 * digits. Executing it checks what the app will actually do, which is the
 * precedent `plate-frames.test.js` set for exactly this reason.
 */
let cached;
function swiftModes() {
    if (cached) return cached;
    const body = extract('struct RecordingMode');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcc-recording-'));
    const file = path.join(dir, 'main.swift');
    fs.writeFileSync(file, `${body}
let all = RecordingMode.all.map { m in
    "\\(m.id)|\\(m.width)|\\(m.height)|\\(m.fps)|\\(m.bitsPerSecond)|\\(m.bytesPerSecond)"
}
print(all.joined(separator: "\\n"))
print("UNKNOWN=" + (RecordingMode.mode("no-such-mode") == nil ? "nil" : "resolved"))
`);
    const out = execFileSync('swift', [file], { encoding: 'utf8', timeout: 180000 });
    const rows = out.trim().split('\n');
    const unknown = rows.pop();
    cached = {
        unknownResolves: unknown !== 'UNKNOWN=nil',
        modes: rows.map((r) => {
            const [id, width, height, fps, bits, bytes] = r.split('|');
            return {
                id,
                width: +width,
                height: +height,
                fps: +fps,
                bitsPerSecond: +bits,
                bytesPerSecond: +bytes,
            };
        }),
    };
    return cached;
}

/* ------------------------------------------------------------------ *
 * SET 1 — every mode the budget registry declares                     *
 * ------------------------------------------------------------------ */

test('the Swift rate table and the budget registry declare the SAME modes', () => {
    const js = Object.keys(MODES).sort();
    assert.ok(js.length >= 3,
        `capture-policy declares only ${js.length} modes; the registry read is broken, and a set `
        + 'test over almost nothing reports a partial recorder as complete');

    const swift = swiftModes().modes.map((m) => m.id).sort();
    assert.deepStrictEqual(swift, js,
        'the camera records modes the budget does not price, or the budget prices modes the '
        + `camera cannot record. Swift: ${swift.join(', ')} — capture-policy: ${js.join(', ')}`);
});

test('EVERY mode records at exactly the rate its budget is computed from', () => {
    const wrong = [];
    for (const m of swiftModes().modes) {
        const budget = MODES[m.id];
        if (!budget) continue;                     // the set test above owns that failure
        if (m.bytesPerSecond !== budget.bytes_per_second) {
            wrong.push(`${m.id}: records ${m.bytesPerSecond} B/s, budget assumes `
                + `${budget.bytes_per_second} B/s`);
        }
    }
    assert.deepStrictEqual(wrong, [],
        'the camera records at a rate the budget does not assume. Every "seconds remaining" the '
        + 'app shows is computed from capture-policy, so a mismatch is a promise the recorder '
        + `breaks silently and the director discovers at upload:\n  ${wrong.join('\n  ')}`);
});

test('EVERY mode carries the raster and frame rate its own id names', () => {
    const wrong = [];
    for (const m of swiftModes().modes) {
        const spec = /^(\d+)(?:p|k)(\d+)$/.exec(m.id);
        assert.ok(spec, `mode id ${m.id} does not name a resolution and a rate`);
        const [, res, fps] = spec;
        if (m.fps !== +fps) wrong.push(`${m.id}: records at ${m.fps}fps`);
        // "1080p" is the SHORT edge; "4k" is the long one.
        const expected = m.id.includes('k') ? +res * 1000 : +res;
        const got = m.id.includes('k') ? m.width : m.height;
        // 4K here is 3840, which "4k" rounds to a thousand of.
        if (Math.abs(got - expected) > 200) {
            wrong.push(`${m.id}: records ${m.width}x${m.height}`);
        }
    }
    assert.deepStrictEqual(wrong, [],
        `a mode records something other than what it is called:\n  ${wrong.join('\n  ')}`);
});

test('a mode the registry does not declare is REFUSED, never defaulted', () => {
    assert.strictEqual(swiftModes().unknownResolves, false,
        'RecordingMode.mode() resolved an unknown id. Falling back to a default records footage '
        + 'at a rate nobody chose, against a budget computed for a different one — and it looks '
        + 'like it worked');
});

/* ------------------------------------------------------------------ *
 * SET 2 — the recording spine itself                                  *
 * ------------------------------------------------------------------ */

test('the writer is fed from the EXISTING data output, not a second movie output', () => {
    const cam = code();
    assert.ok(cam.includes('AVAssetWriter'),
        'no AVAssetWriter — nothing records. FCC-001 is the whole spine of this epic');
    assert.ok(!cam.includes('AVCaptureMovieFileOutput'),
        'an AVCaptureMovieFileOutput was added. The epic says the writer is fed from the '
        + 'EXISTING AVCaptureVideoDataOutput — a movie file output is a second, separate capture '
        + 'path, and the monitoring tools that read those frames would be recording something '
        + 'other than what is written');
    assert.ok(cam.includes('AVCaptureVideoDataOutput'),
        'the data output the writer is supposed to be fed from is gone');
});

test('the photo output stays active, so stills are not lost', () => {
    const cam = code();
    assert.ok(cam.includes('AVCapturePhotoOutput'),
        'the photo output was removed. Since iOS 16 both outputs may be active at once, so '
        + 'recording never required losing the plate camera — this would trade a capability for '
        + 'another rather than adding one');
    assert.ok(/func shoot\(/.test(cam),
        'shoot() is gone — the plate camera cannot take a picture any more');
});

test('the session is started from the FIRST BUFFER\'S timestamp, never zero', () => {
    const cam = code();
    assert.ok(cam.includes('startSession(atSourceTime:'),
        'the writer never starts a session. Appending without one produces a file with no '
        + 'samples, which writes successfully and plays as nothing');
    assert.ok(!/startSession\(atSourceTime:\s*\.zero\)/.test(cam),
        'the session starts at .zero while buffers carry the host clock. Every sample then lands '
        + 'hours into the timeline: the file is valid, its duration is absurd, and an NLE shows '
        + 'a clip that is almost entirely empty');
    assert.ok(/CMSampleBufferGetPresentationTimeStamp|\.presentationTimeStamp/.test(cam),
        'nothing reads a presentation timestamp, so the session cannot be anchored to the '
        + 'buffers it is about to be fed');
});

test('the input is configured for REAL-TIME capture and never blocks the frame queue', () => {
    const cam = code();
    assert.ok(/expectsMediaDataInRealTime\s*=\s*true/.test(cam),
        'expectsMediaDataInRealTime is not set. AVAssetWriterInput then assumes it can make the '
        + 'caller wait, and the frame queue — which also carries peaking and the exposure '
        + 'warning — stalls behind the encoder');
    assert.ok(cam.includes('isReadyForMoreMediaData'),
        'frames are appended without asking whether the input can take one. append() returns '
        + 'false and the sample is lost, but the writer keeps its status, so the clip quietly '
        + 'drops frames rather than failing');
});

test('the codec is HEVC, which is what the budget prices', () => {
    const cam = code();
    assert.ok(/AVVideoCodecType\.hevc/.test(cam),
        'the writer does not ask for HEVC. capture-policy prices every mode at Apple\'s nominal '
        + 'HEVC rate, so recording H.264 makes every duration the app promises wrong');
});

test('starting twice and stopping when idle are both refused', () => {
    const start = extract('func startRecording');
    const stop = extract('func stopRecording');
    assert.ok(/guard\s+.*(isRecording|writer\s*==\s*nil|recording)/.test(start),
        'startRecording does not guard on already recording. A second writer over the same '
        + 'output abandons the first file mid-take — the take is gone, and nothing said so');
    assert.ok(/guard\s+/.test(stop),
        'stopRecording does not guard on there being a recording. finishWriting on a writer that '
        + 'was never started raises, and it raises from the frame queue');
});

/* ------------------------------------------------------------------ *
 * SET 3 — every tripwire this task trips                              *
 * ------------------------------------------------------------------ */

/**
 * Four documents pin "there is no AVAssetWriter path" as a GAP, each with the
 * same idiom: an array containing the symbol, filtered against the source, and
 * required to come back empty. Every one of them fires the moment this lands —
 * which is what they are for. What they must not do is stay pinned, because a
 * gap pinned as permanent makes a document fail for succeeding.
 */
const CLAIM_FILES = [
    'film-engine-camera-brief.test.js',
    'fcc-parity-epic.test.js',
    'fcc-parity-brief.test.js',
    'plate-camera-epic.test.js',
];

test('every claim registry that pinned AVAssetWriter as absent has been RESHAPED', () => {
    const stale = [];
    let scanned = 0;
    for (const f of CLAIM_FILES) {
        const p = path.join(__dirname, f);
        assert.ok(fs.existsSync(p),
            `${f} is gone. It held a claim about this task; a scan that cannot find its subject `
            + 'reports the reshaping as done by looking at nothing');
        const lines = fs.readFileSync(p, 'utf8').split('\n');
        scanned++;
        lines.forEach((line, i) => {
            /*
             * The ABSENCE idiom, and the only one used across all four:
             *   ['AVAssetWriter', ...].filter(s => cam.includes(s))  → length === 0
             *
             * The negated form — `.filter(s => !cam.includes(s))` — is the
             * opposite claim, a PRESENCE check listing what has gone missing,
             * and must not be flagged. Matching on `.filter(` alone caught both
             * and reported a correct present-claim as stale, which is how a
             * check like this gets relaxed until it protects nothing.
             */
            if (line.includes("'AVAssetWriter'")
                && /\.filter\([^)]*=>\s*[A-Za-z]+\.includes/.test(line)) {
                stale.push(`${f}:${i + 1} still filters for AVAssetWriter's absence`);
            }
        });
    }
    assert.strictEqual(scanned, CLAIM_FILES.length, 'not every claim file was scanned');
    assert.deepStrictEqual(stale, [],
        'a document still claims there is no AVAssetWriter path, and there is one. Reshape the '
        + 'claim to pin what was BUILT — splitting it where it also covered something still '
        + `absent, which is the precedent these files already set:\n  ${stale.join('\n  ')}`);
});

test('and each of those registries still MENTIONS the recorder, rather than dropping it', () => {
    /*
     * The pair matters, not either half. The test above says no registry claims
     * AVAssetWriter is absent; this one says every registry still talks about
     * it. Together: each file pins the recorder, and none of them pins it as
     * missing.
     *
     * Deleting the claim would satisfy the first test perfectly — nothing left
     * to filter for — which is precisely the reshaping this task is supposed to
     * do INSTEAD of deletion. A deleted claim loses the record that the thing
     * was built and stops anything noticing when it is removed again.
     *
     * Deliberately a mention rather than one fixed idiom: three of these files
     * assert presence by listing what has gone MISSING
     * (`filter(s => !cam.includes(s))`), which is a perfectly good presence
     * check and one a stricter pattern would report as a dropped claim.
     */
    const missing = CLAIM_FILES.filter((f) => {
        const s = fs.readFileSync(path.join(__dirname, f), 'utf8');
        return !s.includes("'AVAssetWriter'");
    });
    assert.deepStrictEqual(missing, [],
        'these documents dropped their AVAssetWriter claim instead of reshaping it. Deleting a '
        + 'claim loses the record that the thing was built and stops anything noticing if it is '
        + `removed again: ${missing.join(', ')}`);
});
