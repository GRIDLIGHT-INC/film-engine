/**
 * RECORD TO EXTERNAL USB-C STORAGE — GRD-3805 / FCC-009.
 *
 * The transport five formats have been waiting on. FCC-006 declared `external`
 * present-but-unavailable so ProRes could be refused with a remedy rather than
 * offered or hidden; FCC-007 and FCC-008 then put five modes behind it. This is
 * the task that makes the remedy true.
 *
 * "THE DRIVE IS CHECKED FOR SPEED AND FORMAT BEFORE RECORDING STARTS, BECAUSE
 * DISCOVERING IT AFTERWARDS COSTS THE TAKE." That sentence is the acceptance.
 * A drive that turns out to be too slow four seconds into a ProRes take has not
 * produced a shorter take — it has produced a corrupt one, and the moment is
 * gone. Every check therefore runs before the writer is opened.
 *
 * THE SDK ALREADY ANSWERS MOST OF IT, which is worth knowing before hand-rolling
 * a benchmark. Probed out of AVExternalStorageDevice.h, ios(17.0):
 *
 *   isSupported ....................... class property; not every phone has it
 *   authorizationStatus / requestAccess  permission, exactly like the microphone
 *   externalStorageDevices ............ the discovery session's list
 *   isConnected ....................... whether it is still there
 *   isNotRecommendedForCaptureUse ..... APPLE'S OWN verdict on this drive
 *   freeSize / totalSize .............. bytes
 *   nextAvailableURLsWithPathExtensions: how you get somewhere to write
 *
 * `isNotRecommendedForCaptureUse` is the format-and-speed check. Writing our own
 * would mean timing a throwaway write on the director's drive before every take
 * — slower, less accurate than the OS's own answer, and wear on a drive somebody
 * paid for. What the OS cannot know is whether there is room for THIS take, so
 * that is the one check this task computes itself.
 *
 * AND THE CEILING MOVES, WHICH IS THE HALF THAT IS EASY TO MISS. Every duration
 * in this engine is computed against `bindingBytes()` — 100MB, the upload cap.
 * On a drive that is the wrong number by four orders of magnitude: ProRes 422 HQ
 * at 4K30 fits ZERO seconds against 100MB and about ninety on a 1TB disk. Making
 * the transport available without moving the ceiling would offer five formats
 * that all say "0s max", which reads as broken rather than as available.
 *
 * SET-BASED OVER TWO REGISTRIES:
 *
 *   1. `DRIVE_CHECKS` — the pre-flight. Every one must run BEFORE the writer
 *      opens and every one must name its own failure. A check that catches a
 *      missing drive and not a slow one loses the take it was written to save.
 *   2. The EXTERNAL-ONLY MODES — five of them. Every one must become reachable
 *      when a drive is present; unlocking 422 HQ and leaving ProRes RAW refused
 *      is the half-done fix, and RAW is the one a director plugged a drive in
 *      for.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');
const policy = require('../lib/capture-policy');
const { MODES, TRANSPORTS, DRIVE_CHECKS, formatChoices } = policy;

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

/** Every mode that can only travel by external storage. */
const externalOnly = () => Object.entries(MODES)
    .filter(([, m]) => (m.transports || []).length && m.transports.every((t) => t === 'external'))
    .map(([id]) => id);

/* ------------------------------------------------------------------ *
 * SET 1 — the pre-flight, all of it before the writer opens           *
 * ------------------------------------------------------------------ */

test('the pre-flight registry covers supply, permission, presence, speed and room', () => {
    assert.ok(DRIVE_CHECKS && typeof DRIVE_CHECKS === 'object',
        'capture-policy declares no DRIVE_CHECKS');
    const ids = Object.keys(DRIVE_CHECKS);
    assert.ok(ids.length >= 5,
        `only ${ids.length} pre-flight check(s): ${ids.join(', ')}. A drive can fail to be a `
        + 'usable recording target in more ways than one, and a check that catches a missing '
        + 'drive and not a slow one loses exactly the take it was written to save');
});

test('EVERY check says what it asks, and what a director is told when it fails', () => {
    const wrong = [];
    for (const [id, c] of Object.entries(DRIVE_CHECKS)) {
        if (!c.label) wrong.push(`${id}: has no label`);
        if (!c.asks || c.asks.length < 15) {
            wrong.push(`${id}: does not say what it asks the drive. "Checked for speed and format" `
                + 'is the acceptance of this task and has to be checkable');
        }
        if (!c.refusal || c.refusal.length < 30) {
            wrong.push(`${id}: has no refusal sentence. A drive rejected without a reason sends a `
                + 'director to buy another one at random');
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('EVERY check names a real API, and the camera actually calls it', () => {
    /*
     * Probed out of AVExternalStorageDevice.h rather than recalled. Requiring
     * the call is what stops "the drive is checked" being a sentence in a
     * comment.
     */
    const cam = code();
    const wrong = [];
    for (const [id, c] of Object.entries(DRIVE_CHECKS)) {
        if (!c.symbol) { wrong.push(`${id}: names no API`); continue; }
        if (!cam.includes(c.symbol)) {
            wrong.push(`${id}: the camera never calls ${c.symbol}, so nothing performs this check`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('EVERY check runs BEFORE the writer is opened — the whole point of the task', () => {
    /*
     * "Discovering it afterwards costs the take." A drive that turns out to be
     * too slow four seconds in has not produced a shorter take, it has produced
     * a corrupt one, and the moment is gone.
     */
    /*
     * COMMENTS STRIPPED, and this file's own first draft is why. `extract`
     * reads raw source, so a comment saying "the pre-flight runs HERE, before
     * `sink.begin`" was found as the position the writer opens — putting the
     * gate after it and reporting correct code as broken. A mention is not a
     * use, in a test as much as in the thing it tests.
     */
    const start = extract('func startRecording', code());
    assert.ok(start, 'startRecording is gone');
    const openWriter = start.indexOf('sink.begin');
    assert.notStrictEqual(openWriter, -1, 'startRecording no longer opens the writer');

    const gate = start.search(/\bdriveProblem\b|\bcheckDrive\b|\bpreflightDrive\b/);
    assert.notStrictEqual(gate, -1,
        'nothing checks the drive in startRecording, so a take begins and finds out later');
    assert.ok(gate < openWriter,
        'the drive is checked AFTER the writer is opened. By then the take has started, and a '
        + 'drive that fails now costs the moment rather than preventing it');
});

test('the speed and format verdict is the OS\'s own, not a benchmark we invented', () => {
    /*
     * `isNotRecommendedForCaptureUse` is Apple's answer to exactly this
     * question. Timing a throwaway write before every take would be slower,
     * less accurate, and wear on a drive somebody paid for.
     */
    const cam = code();
    assert.ok(cam.includes('isNotRecommendedForCaptureUse') || cam.includes('notRecommendedForCaptureUse'),
        'the camera does not ask the OS whether the drive is suitable for capture, so either the '
        + 'check is missing or it was hand-rolled');
    assert.ok(!/measureWriteSpeed|benchmarkDrive|timedWrite/i.test(cam),
        'a write benchmark was hand-rolled. The OS already answers this, and ours would cost time '
        + 'and wear on the director\'s drive before every take');
});

test('permission is asked for, because a refused prompt looks like no drive', () => {
    /*
     * The same trap the microphone had: without permission the discovery
     * session lists nothing, which is indistinguishable from nothing being
     * plugged in — and the director is told to check a cable that is fine.
     */
    const cam = code();
    assert.ok(/AVExternalStorageDevice(DiscoverySession)?\.requestAccess|requestAccess\s*\{/.test(cam)
        || cam.includes('requestAccessWithCompletionHandler') || cam.includes('AVExternalStorageDeviceDiscoverySession'),
        'nothing asks for external-storage permission');
    assert.ok(/authorizationStatus/.test(cam),
        'nothing checks the authorisation status first, so the prompt is raised on every launch');
});

/* ------------------------------------------------------------------ *
 * SET 2 — the five modes that have been waiting for this              *
 * ------------------------------------------------------------------ */

test('there really are external-only modes waiting on this transport', () => {
    const ids = externalOnly();
    assert.ok(ids.length >= 5,
        `only ${ids.length} external-only mode(s): ${ids.join(', ')}. FCC-007 and FCC-008 put `
        + 'five behind this transport; a set test over fewer reports a partial unlock as complete');
});

test('EVERY external-only mode is still REFUSED when no drive is present', () => {
    const offered = formatChoices().filter((c) => externalOnly().includes(c.id) && c.offered);
    assert.deepStrictEqual(offered.map((c) => c.id), [],
        'these are offered with no drive attached, so the refusal FCC-006 built has been lost and '
        + 'a take would be started with nowhere to write it');
});

test('EVERY external-only mode becomes OFFERED once a drive is present', () => {
    /*
     * The half-done fix this refuses: unlocking ProRes 422 HQ and leaving
     * ProRes RAW refused. RAW is the one a director plugged a drive in for.
     */
    const drive = { transports: ['upload', 'external'], external_free_bytes: 1024 ** 4 };
    const still = formatChoices([], drive)
        .filter((c) => externalOnly().includes(c.id) && !c.offered)
        .map((c) => `${c.id}: ${c.refusal}`);
    assert.deepStrictEqual(still, [],
        'a drive is attached and these are still refused. Every one of them was put behind this '
        + `transport precisely so that plugging a drive in would unlock it:\n  ${still.join('\n  ')}`);
});

test('a format on a drive is priced against the DRIVE, not the upload ceiling', () => {
    /*
     * The half that is easy to miss. Every duration in this engine is computed
     * against the 100MB upload cap; on a disk that is wrong by four orders of
     * magnitude. ProRes 422 HQ at 4K30 fits ZERO seconds against 100MB and
     * about ninety on a terabyte — so making the transport available without
     * moving the ceiling offers five formats that all read "0s max", which
     * looks broken rather than available.
     */
    const terabyte = 1024 ** 4;
    const drive = { transports: ['upload', 'external'], external_free_bytes: terabyte };
    const wrong = [];
    for (const id of externalOnly()) {
        const on = formatChoices([], drive).find((c) => c.id === id);
        const expected = Math.floor(terabyte / MODES[id].bytes_per_second);
        if (on.max_seconds !== expected) {
            wrong.push(`${id}: says ${on.max_seconds}s on a 1TB drive, and ${expected}s fit`);
        }
        if (on.max_seconds <= policy.maxSecondsFor(id)) {
            wrong.push(`${id}: a terabyte buys no more than the 100MB upload ceiling did, so the `
                + 'ceiling never moved');
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('a drive with no room refuses, rather than starting a take that cannot finish', () => {
    const tiny = { transports: ['upload', 'external'], external_free_bytes: 1024 * 1024 };
    const offered = formatChoices([], tiny)
        .filter((c) => externalOnly().includes(c.id) && c.offered)
        .map((c) => `${c.id}: offered with ${c.max_seconds}s`);
    assert.deepStrictEqual(offered, [],
        'a megabyte of free space is enough to offer ProRes. The take starts, fills the drive in '
        + `well under a second, and the moment is gone:\n  ${offered.join('\n  ')}`);
});

test('the upload formats are untouched by any of this', () => {
    /*
     * A drive appearing must not change what the ordinary HEVC modes cost or
     * how long they may be — they do not travel by it.
     */
    const drive = { transports: ['upload', 'external'], external_free_bytes: 1024 ** 4 };
    const before = formatChoices().filter((c) => !externalOnly().includes(c.id));
    const after = formatChoices([], drive).filter((c) => !externalOnly().includes(c.id));
    assert.deepStrictEqual(after, before,
        'plugging a drive in changed a format that does not travel by it');
});

/* ------------------------------------------------------------------ *
 * SET 3 — the transport declares that its answer comes from the phone *
 * ------------------------------------------------------------------ */

test('external declares that its availability is a runtime fact, not a constant', () => {
    const t = TRANSPORTS.external;
    assert.ok(t, 'the external transport is gone');
    assert.strictEqual(t.device_reported, true,
        'external still declares a static availability. Whether a drive is plugged in is a fact '
        + 'about this moment, and a constant either offers ProRes with no drive or refuses it '
        + 'with one');
    assert.ok(t.remedy && t.remedy.length > 30,
        'the remedy is gone. It is what a director reads when no drive is attached, and it is the '
        + 'whole reason FCC-006 declared this transport before it existed');
});

test('the camera reports which drive it will write to, and why not when it will not', () => {
    const cam = code();
    assert.ok(/driveProblem|driveStatus|externalDrive/i.test(cam),
        'nothing on the model records the drive or the reason there is none, so a director cannot '
        + 'be told what is wrong before they press record');
    const picker = extract('struct FormatPicker') || '';
    const transport = extract('struct RecordingTransport') || '';
    assert.ok(/driveProblem|driveStatus|externalDrive/i.test(picker + transport),
        'no surface shows it. A ProRes row that is greyed with no reason sends a director to buy '
        + 'a drive they may already have');
});

test('the take is written to the DRIVE, not to the phone and copied afterwards', () => {
    /*
     * ProRes at 4K30 is 116MB a second. Writing to the phone first and moving
     * it afterwards needs the space twice over and takes as long again — and
     * the whole reason for a drive is that the phone cannot hold it.
     */
    const cam = code();
    assert.ok(cam.includes('nextAvailableURLs'),
        'the writer does not ask the drive for a URL. AVExternalStorageDevice hands one out for '
        + 'exactly this, and anything else means recording to the phone and copying');
    /*
     * THE RESOLVED URL MUST REACH THE WRITER, not merely be resolved. The first
     * version asked only that `nextAvailableURLs` appear — and deleting the one
     * line that assigns its result passed, leaving a take that asks the drive
     * politely where to write and then writes to the phone anyway. Resolved and
     * discarded looks identical to resolved and used.
     */
    const start = extract('func startRecording', code()) || '';
    const arg = /sink\.begin\([^)]*\bto:\s*(\w+)/.exec(start);
    assert.ok(arg, 'startRecording no longer hands the writer a URL');
    const target = arg[1];

    const resolved = start.indexOf('nextAvailableURLs');
    assert.notStrictEqual(resolved, -1,
        'startRecording never resolves a URL on the drive, so an external take lands on the phone');

    /*
     * Searched AFTER the resolve, because the FIRST assignment to `url` is the
     * phone's own temporary path — the correct default for a format that does
     * not need a drive. What must exist is a SECOND assignment, between asking
     * the drive for a URL and handing one to the writer.
     */
    const after = start.slice(resolved);
    const rel = after.search(new RegExp(`\\b${target}\\s*=\\s*\\w`));
    const assigned = rel === -1 ? -1 : resolved + rel;
    assert.ok(assigned > resolved && assigned < start.indexOf('sink.begin'),
        `the drive hands out a URL and nothing assigns it to \`${target}\`, which is what the `
        + 'writer is given. The take is written to the phone — needing the space twice over for a '
        + 'format the phone cannot hold, which is the entire reason for the drive');
});
