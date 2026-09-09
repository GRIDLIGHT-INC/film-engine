/**
 * SYNC SOUND WITH THE FOOTAGE — GRD-3799 / FCC-003.
 *
 * FCC-001 built a writer with ONE input. Every clip the camera has produced is
 * silent, and `NSMicrophoneUsageDescription` has been sitting in Info.plist
 * describing a capability that does not exist — the task's own words: the key
 * is declared, the capture is not.
 *
 * EVERY FAILURE IN THIS TASK IS SILENT, IN BOTH SENSES. A clip with no audio
 * track writes successfully, plays perfectly, reports a correct duration, and
 * opens in an NLE. Nothing errors. This codebase has already paid for exactly
 * that once — `stitchClips` synthesised silence for every join for months
 * because a stream-detection regex never matched, and the note it left says
 * the only honest test is MEASURING THE VOLUME rather than asking whether a
 * stream exists.
 *
 * A test here cannot measure volume: it cannot run an iOS capture session. So
 * it does the next strongest thing — it iterates the operations that must
 * happen PER TRACK and refuses a writer that does any of them for the picture
 * and not for the sound. That is the shape the failure actually takes.
 *
 * SET-BASED OVER TWO REGISTRIES, both derived from the code:
 *
 *   1. THE WRITER'S TRACKS — {video, audio}, crossed with the four things the
 *      sink does to a track: declare an input, add it to the writer, append
 *      buffers to it, mark it finished. Eight checks. Miss `markAsFinished` on
 *      the audio input alone and the file still finishes, still plays, and its
 *      sound is truncated or absent — which is indistinguishable from a
 *      microphone problem and gets blamed on the phone.
 *
 *   2. THE MEDIA TYPES THE SESSION CAPTURES — discovered by reading which
 *      `AVCaptureDevice` media types the camera builds inputs from, so a third
 *      one added later is in the denominator with nothing to remember. Each
 *      must be AUTHORISED. A session that adds a microphone input without
 *      asking for microphone permission is the worst case in this whole file:
 *      iOS grants the input, delivers no samples, and the take comes back
 *      mute with no error anywhere.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');
const PLIST = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'Info.plist');

const src = () => fs.readFileSync(SWIFT, 'utf8');
/** Comments stripped — a mention is not a use. */
const code = () => src().split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/**
 * Cut a declaration out by BRACE DEPTH, skipping the signature.
 *
 * The signature has to be skipped because a defaulted closure parameter puts a
 * brace in it — `func stopRecording(_ done: ... = { _ in })` — and taking the
 * first brace extracted that closure instead of the body, which silently turned
 * every assertion about the body into an assertion about `{ _ in }`.
 */
function extract(header) {
    const s = src();
    const at = s.indexOf(header);
    assert.notStrictEqual(at, -1,
        `PlateCamera.swift declares no '${header}'. If it was renamed this test cannot see what it `
        + 'exists to check, and would pass by finding nothing');
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

const sink = () => extract('final class RecordingSink');

/* ------------------------------------------------------------------ *
 * SET 1 — every track the file must carry                             *
 * ------------------------------------------------------------------ */

/**
 * A clip is a picture AND a sound. Both, or the take is half a take.
 *
 * Each operation is listed with what its absence looks like from OUTSIDE,
 * because that is the whole difficulty: none of them produces an error.
 */
const TRACKS = ['video', 'audio'];

const TRACK_OPS = [
    {
        op: 'an input is declared for it',
        // The media type is the identity, so this one needs no naming convention.
        re: (t) => new RegExp(`AVAssetWriterInput\\(mediaType:\\s*\\.${t}\\b`),
        where: () => sink(),
        looksLike: 'the file simply has no track of that kind, and plays',
    },
    {
        /*
         * BOUND TO THE FUNCTION BODY, never to a character window.
         *
         * The first version of this matched `${t}Input` within 200 characters
         * of `.append(` — and a comment between them pushed it out of range, so
         * it reported a working writer as broken. That is the third time this
         * codebase has paid for a bounded window; the rule is to bound by brace
         * depth, which `extract` already does.
         */
        op: 'the append path can reach it',
        re: (t) => new RegExp(`\\b${t}Input\\b`),
        where: () => extract('func append'),
        looksLike: 'the track is declared and empty — a silent audio track is still a track',
    },
    {
        op: 'it is marked finished before the file closes',
        re: (t) => new RegExp(`\\b${t}Input\\??\\.markAsFinished\\(\\)`),
        where: () => extract('func finish'),
        looksLike: 'the file still finishes and the track is truncated or dropped',
    },
];

test('EVERY track gets EVERY lifecycle operation the writer performs', () => {
    const missing = [];
    for (const track of TRACKS) {
        for (const { op, re, where, looksLike } of TRACK_OPS) {
            if (!re(track).test(where())) missing.push(`${track}: ${op} — without it, ${looksLike}`);
        }
    }
    assert.deepStrictEqual(missing, [],
        'the writer treats one track differently from the other, and every one of these fails '
        + `SILENTLY — the clip writes, plays and reports a correct duration:\n  ${missing.join('\n  ')}`);
});

test('EVERY input the writer declares is actually ADDED to it', () => {
    /*
     * Counted rather than name-matched, so this cannot be satisfied by a
     * spelling. An input that is built, configured and never added receives
     * buffers into nothing: the writer finishes happily and the track is
     * missing from the file.
     */
    const begin = extract('func begin');
    const declared = [...begin.matchAll(/AVAssetWriterInput\(mediaType:/g)].length;
    const added = [...begin.matchAll(/\bw\.add\(/g)].length;
    assert.ok(declared >= 2,
        `begin() declares ${declared} writer input(s); a clip needs a picture and a sound`);
    assert.strictEqual(added, declared,
        `begin() builds ${declared} writer inputs and adds ${added} of them to the writer. The `
        + 'one left out is a track that receives buffers and reaches no file');
});

test('the writer declares exactly the tracks a clip needs, and no others', () => {
    const declared = [...sink().matchAll(/AVAssetWriterInput\(mediaType:\s*\.(\w+)/g)]
        .map((m) => m[1]).sort();
    assert.deepStrictEqual([...new Set(declared)].sort(), [...TRACKS].sort(),
        `the writer declares tracks ${declared.join(', ')}. A track this test does not know about `
        + 'is one nothing here checks the lifecycle of');
});

/* ------------------------------------------------------------------ *
 * SET 2 — the routing, which is where audio goes wrong quietly        *
 * ------------------------------------------------------------------ */

test('a buffer cannot be appended without saying which track it belongs to', () => {
    /*
     * BEFORE this task the delegate called `sink.append(sampleBuffer)` for
     * every buffer it received. An audio output delivers through the SAME
     * callback signature, so the moment audio was added, sound samples would
     * have been handed to the video input — which rejects them, silently, and
     * the clip comes back mute with a perfectly healthy-looking video track.
     *
     * The fix is a signature a caller cannot get wrong by accident, which is
     * why this asks for a named track rather than a boolean: `append(buf,
     * true)` reads the same whichever way round it is.
     */
    const body = sink();
    assert.ok(/func append\([^)]*\b(to|track)\s*:/.test(body),
        'RecordingSink.append does not take a track. One append for two kinds of buffer means the '
        + 'routing decision is made somewhere else, or not at all');
    assert.ok(/enum Track|case video/.test(body),
        'the track is not a named case. A boolean parameter reads identically whichever way round '
        + 'it is passed, and getting it backwards produces a mute clip rather than an error');
});

test('the delegate routes by WHICH OUTPUT delivered the buffer', () => {
    const cam = code();
    const delegate = extract('nonisolated func captureOutput');
    assert.ok(/===\s*audio|audio\s*===|output\s*==\s*audio/i.test(delegate),
        'captureOutput does not distinguish the audio output from the video one. Both outputs '
        + 'deliver through this single callback, so without the comparison every sound sample is '
        + 'handed to the picture track');
    assert.ok(/AVCaptureAudioDataOutputSampleBufferDelegate/.test(cam),
        'the model does not conform to the audio delegate protocol, so the audio output has '
        + 'nowhere to deliver and the track is created and never fed');
});

test('the session is anchored on the PICTURE, and early sound is counted not hidden', () => {
    /*
     * Whichever buffer starts the session decides where the clip begins. Audio
     * arrives on its own schedule and can precede the first frame; anchoring on
     * it would begin the clip on sound with no picture. Anchoring on video
     * means the handful of audio samples that arrive first fall outside the
     * session — which is correct, and must be COUNTED, because "a few samples
     * dropped at the head" and "the microphone is not working" look identical
     * from a waveform.
     */
    const body = sink();
    assert.ok(/startSession\(atSourceTime:/.test(body), 'the writer never starts a session');

    /*
     * The guard must name the video track. Starting on whichever buffer happens
     * to arrive first is a coin toss decided by the audio hardware's warm-up,
     * so the same take begins on a frame or on 30ms of sound over a black
     * picture depending on the run — and it is not reproducible.
     */
    const at = body.indexOf('startSession');
    const before = body.slice(Math.max(0, at - 400), at);
    assert.ok(/\.video\b/.test(before),
        'nothing restricts the session start to the video track, so whichever buffer arrives '
        + 'first anchors the clip — a race decided by microphone warm-up');

    assert.ok(/dropped/.test(body),
        'nothing counts dropped samples, so audio lost before the session opened is invisible');
});

/* ------------------------------------------------------------------ *
 * SET 3 — every media type the session captures must be authorised    *
 * ------------------------------------------------------------------ */

/**
 * DISCOVERED from the source rather than listed, so a third capture device
 * added later is in the denominator with nothing to remember.
 */
function capturedMediaTypes() {
    const cam = code();
    const found = new Set();
    for (const m of cam.matchAll(/AVCaptureDevice\.default\(for:\s*\.(\w+)\)/g)) found.add(m[1]);
    for (const m of cam.matchAll(/AVCaptureDevice\.DiscoverySession\([\s\S]{0,300}?mediaType:\s*\.(\w+)/g)) {
        found.add(m[1]);
    }
    return [...found].sort();
}

test('EVERY media type the session captures is one the app asks permission for', () => {
    const types = capturedMediaTypes();
    assert.ok(types.length >= 2,
        `only ${types.length} captured media type(s) discovered (${types.join(', ') || 'none'}). `
        + 'A clip needs a picture and a sound, and a scan that finds one reports a mute camera as '
        + 'complete');

    const cam = code();
    const unasked = types.filter((t) => !new RegExp(`requestAccess\\(for:\\s*\\.${t}\\b`).test(cam));
    assert.deepStrictEqual(unasked, [],
        'the session builds an input for these and never asks for permission: '
        + `${unasked.join(', ')}. iOS grants the input, delivers no samples, and the take comes `
        + 'back missing that track with no error anywhere — which gets blamed on the hardware');

    const unchecked = types.filter((t) => !new RegExp(`authorizationStatus\\(for:\\s*\\.${t}\\b`).test(cam));
    assert.deepStrictEqual(unchecked, [],
        `these are captured without ever checking authorisation first: ${unchecked.join(', ')}. `
        + 'Asking every launch is a prompt a director has already answered');
});

test('EVERY media type the session captures has a usage string, or iOS kills the app', () => {
    const plist = fs.readFileSync(PLIST, 'utf8');
    const KEY = { video: 'NSCameraUsageDescription', audio: 'NSMicrophoneUsageDescription' };
    const missing = capturedMediaTypes()
        .filter((t) => KEY[t] && !plist.includes(`<key>${KEY[t]}</key>`))
        .map((t) => KEY[t]);
    assert.deepStrictEqual(missing, [],
        `Info.plist declares no ${missing.join(', ')}. iOS TERMINATES the app the moment capture `
        + 'starts, which reads as a crash rather than as a missing key');
});

/* ------------------------------------------------------------------ *
 * SET 4 — a mute take says so                                         *
 * ------------------------------------------------------------------ */

test('recording without sound is allowed, and is never silent about being silent', () => {
    /*
     * Refusing to record because the microphone is off would be wrong — MOS is
     * a real thing a director chooses. Producing a mute file and saying nothing
     * is the failure: it is indistinguishable from a broken microphone, and the
     * clip is already shot by the time anyone plays it back.
     */
    const cam = code();
    assert.ok(/recordsAudio|audioUnavailable|withoutSound|silentReason/i.test(cam),
        'nothing on the model records whether this take will have sound. A director cannot be '
        + 'told what they are not getting');
    const surface = extract('struct RecordingTransport');
    assert.ok(/recordsAudio|audioUnavailable|withoutSound|silentReason/i.test(surface),
        'the transport does not show whether sound is being recorded. A mute take that looks '
        + 'exactly like a normal one is the whole defect this task exists to close');
});

test('the audio output does not share the queue that carries the frame analysis', () => {
    /*
     * Peaking and the exposure warning walk a multi-megapixel frame on the
     * video queue. Audio buffers arrive roughly every 20ms and are dropped if
     * nothing takes them in time, so putting them behind that analysis loses
     * sound in exactly the moments a director has the monitoring tools on.
     */
    const cam = code();
    assert.ok(/audioQueue/.test(cam),
        'the audio output has no queue of its own. Sharing the video queue puts every sound '
        + 'buffer behind a frame analysis that walks millions of pixels');
    assert.ok(/DispatchQueue\(label:\s*"[^"]*audio/.test(cam),
        'audioQueue is not its own serial DispatchQueue');
});
