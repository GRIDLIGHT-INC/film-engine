/**
 * PRORES RAW, APPLE LOG 2, OPEN GATE — GRD-3804 / FCC-008.
 *
 * The iPhone 17 Pro features, and the task's acceptance is not the features:
 * it is the GATE. "Gated on the device reporting the capability rather than on
 * a model string, so a 15 Pro Max degrades with a reason instead of failing."
 *
 * A MODEL STRING IS THE WRONG GATE, AND IT FAILS IN BOTH DIRECTIONS. It is
 * wrong the day a model ships that the list has never heard of — the newest
 * phone, which is exactly the one that has the feature — and it is wrong again
 * when Apple brings a capability to hardware nobody re-listed. Asking the
 * DEVICE is right on both counts and needs no maintenance.
 *
 * EVERY SYMBOL HERE WAS PROBED OUT OF THE INSTALLED SDK RATHER THAN RECALLED,
 * on the precedent this codebase set with MuAPI — "the provider was asked
 * rather than read about". From
 * `$(xcrun --sdk iphoneos --show-sdk-path)/System/Library/Frameworks/AVFoundation.framework/Headers`:
 *
 *   AVCaptureColorSpace_AppleLog2 ......... ios(26.0), = 4
 *   AVVideoCodecTypeAppleProResRAW ........ ios(26.0), NS_SWIFT_NAME(proResRAW)
 *   availableVideoCodecTypesForAssetWriterWithOutputFileType: ... ios(11.0)
 *   open gate .............................. NO SYMBOL EXISTS
 *
 * That last line is a finding, not an omission. There is no `isOpenGateSupported`
 * anywhere in AVFoundation, so open gate cannot be a flag — it is a FORMAT, and
 * the only honest gate is asking the device which formats it has and looking
 * for the full-sensor one. Which also means its raster must be read from the
 * device rather than typed: this repo does not have a published pixel count for
 * it, and inventing one is the trap FCC-005 and FCC-007 both named.
 *
 * AND THE PROBE FOUND A LIVE DEFECT FCC-005 SHIPPED. The same headers say:
 * "Photo capture is not supported when AVCaptureDevice has selected
 * AVCaptureColorSpace_AppleLog or AVCaptureColorSpace_AppleLog2 as color
 * space." FCC-005 sets `.appleLog` when a log take starts and never puts it
 * back — so after one log take the plate shutter is dead for the rest of the
 * session. Nothing errors; stills simply stop. That silently undoes the
 * guarantee FCC-001 exists for, and it is in this task's set because this task
 * adds the second colour space with the same consequence.
 *
 * SET-BASED OVER TWO REGISTRIES:
 *
 *   1. `CAPABILITIES` — the three features. Each must declare what it is, the
 *      iOS it needs, how the DEVICE is asked, and what a phone without it is
 *      told. A gate that catches Log 2 and lets ProRes RAW through fails on
 *      the one that throws rather than degrades.
 *   2. The colour spaces that DISABLE PHOTO CAPTURE — two after this task.
 *      Every one must be restored when the take ends. Catching one and missing
 *      the other loses stills on exactly the newer phone this task is about.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');
const { CAPABILITIES, MODES, CODECS } = require('../lib/capture-policy');

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

/* ------------------------------------------------------------------ *
 * SET 1 — the three capabilities, each gated on the device            *
 * ------------------------------------------------------------------ */

test('the capability registry names all three features this task is about', () => {
    assert.ok(CAPABILITIES && typeof CAPABILITIES === 'object',
        'capture-policy declares no CAPABILITIES');
    const ids = Object.keys(CAPABILITIES).sort();
    assert.deepStrictEqual(ids, ['apple_log2', 'open_gate', 'prores_raw'],
        `the task names ProRes RAW, Apple Log 2 and open gate; the registry declares ${ids.join(', ')}. `
        + 'A gate that covers two of three fails on whichever one was left out, and it fails by '
        + 'throwing rather than degrading');
});

test('EVERY capability says what it is, what it needs, and what a phone without it is told', () => {
    const wrong = [];
    for (const [id, c] of Object.entries(CAPABILITIES)) {
        if (!c.label) wrong.push(`${id}: has no label, so nothing can name it to a director`);
        if (!c.min_ios) {
            wrong.push(`${id}: states no minimum iOS. Every one of these is an iOS 26 symbol `
                + 'against a deployment target of 16, so an unguarded reference does not build');
        }
        if (!c.probe || c.probe.length < 15) {
            wrong.push(`${id}: does not say how the DEVICE is asked. "Gated on the device `
                + 'reporting the capability" is the whole acceptance of this task');
        }
        if (!c.degrade || c.degrade.length < 30) {
            wrong.push(`${id}: has no degrade sentence — a phone without it fails silently `
                + 'instead of being told what it is not getting');
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('EVERY capability is probed on the device, and the probe is a real API', () => {
    /*
     * The probes were read out of the installed SDK, not recalled. Naming them
     * in the registry and requiring the camera to actually call them is what
     * stops "gated on the device" being a sentence in a comment.
     */
    const cam = code();
    const wrong = [];
    for (const [id, c] of Object.entries(CAPABILITIES)) {
        if (!c.probe_symbol) { wrong.push(`${id}: names no API to probe with`); continue; }
        if (!cam.includes(c.probe_symbol)) {
            wrong.push(`${id}: the camera never calls ${c.probe_symbol}, so nothing asks the `
                + 'device whether it has this');
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('NOTHING gates on a model string — the failure this task exists to avoid', () => {
    /*
     * Wrong in BOTH directions: a list has never heard of the phone that
     * shipped this morning — which is exactly the one with the feature — and it
     * goes stale again when Apple brings a capability to older hardware.
     */
    const cam = code();
    const found = [];
    for (const pattern of [
        /\butsname\b/,                    // the usual way a model id is read
        /\bmodelIdentifier\b/,
        /sysctlbyname\s*\(\s*"hw\.machine"/,
        /"iPhone1[0-9],[0-9]/,            // a literal model identifier
        /iPhone\s*1[0-9]\s*Pro/i,         // a marketing name used as a gate
    ]) {
        if (pattern.test(cam)) found.push(String(pattern));
    }
    assert.deepStrictEqual(found, [],
        'the camera identifies the phone by model rather than asking it what it can do. That is '
        + `wrong the day a newer model ships and wrong again when an older one gains the feature:\n  `
        + found.join('\n  '));
});

test('EVERY capability is guarded by the iOS it declares', () => {
    const cam = code();
    const wrong = [];
    for (const [id, c] of Object.entries(CAPABILITIES)) {
        const major = String(c.min_ios).split('.')[0];
        if (!new RegExp(`#available\\(iOS ${major}`).test(cam)) {
            wrong.push(`${id}: needs iOS ${c.min_ios} and nothing guards on it. The deployment `
                + 'target is 16, so an unguarded symbol does not compile at all');
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('a capability the device lacks is REPORTED, never silently skipped', () => {
    const cam = code();
    assert.ok(/capabilityProblem|unsupportedReason|tierUnavailable|logUnavailable/i.test(cam),
        'nothing on the model records why an advanced format was not used, so a director cannot '
        + 'be told what they are not getting');
    const surface = extract('struct RecordingTransport') || '';
    const picker = extract('struct FormatPicker') || '';
    assert.ok(/capabilityProblem|unsupportedReason|tierUnavailable|logUnavailable|refusal/i
        .test(surface + picker),
        'no surface shows it. A format that quietly records something else is the whole family of '
        + 'failure this epic keeps closing');
});

/* ------------------------------------------------------------------ *
 * SET 2 — open gate is READ from the device, never typed              *
 * ------------------------------------------------------------------ */

test('open gate has no API flag, so its raster comes from the device', () => {
    /*
     * Probed: there is no `isOpenGateSupported` anywhere in AVFoundation. It is
     * a FORMAT, so the gate is asking the device which formats it has — and the
     * raster must be read from the one it reports. This repo has no published
     * pixel count for it, and typing one is the trap FCC-005 and FCC-007 both
     * named.
     */
    const cam = code();
    assert.ok(/device\.formats|activeFormat|formatDescription|CMVideoFormatDescriptionGetDimensions/
        .test(cam),
        'nothing reads the device\'s own formats, so open gate could only have been hardcoded');

    const typed = Object.entries(MODES)
        .filter(([, m]) => (m.requires || []).includes('open_gate'))
        .map(([id]) => id);
    assert.deepStrictEqual(typed, [],
        `these modes claim an open-gate raster in the static registry: ${typed.join(', ')}. Its `
        + 'dimensions are a property of the sensor, so a fixed entry is an invented number for '
        + 'hardware nobody here has measured');
});

/* ------------------------------------------------------------------ *
 * SET 3 — every colour space that kills stills is put back            *
 * ------------------------------------------------------------------ */

/**
 * From the SDK, verbatim: "Photo capture is not supported when AVCaptureDevice
 * has selected AVCaptureColorSpace_AppleLog or AVCaptureColorSpace_AppleLog2
 * as color space."
 *
 * FCC-001's guarantee is that stills survive recording. FCC-005 set `.appleLog`
 * and never put it back, so after one log take the plate shutter is dead for
 * the rest of the session — nothing errors, stills simply stop. This task adds
 * the second such colour space, so the rule is set-based rather than a fix for
 * the one that was found.
 */
const PHOTO_BLOCKING = ['appleLog', 'appleLog2'];

test('EVERY colour space that disables photo capture is restored when the take ends', () => {
    const cam = code();
    /*
     * BOUND TO WHAT THE CAMERA CAN SELECT, not to one assignment shape. The
     * first version matched `activeColorSpace = .appleLog` literally and then
     * reported a working camera as broken the moment the degrade path routed
     * the choice through a variable — the same coupling-to-a-call-shape this
     * codebase already paid for once with `shot-anchor`.
     */
    const selectable = PHOTO_BLOCKING.filter((s) => new RegExp(`\\.${s}\\b`).test(cam));
    assert.deepStrictEqual(selectable, PHOTO_BLOCKING,
        `the camera can select ${selectable.join(', ') || 'no'} log colour space(s); it must be `
        + `able to reach all of ${PHOTO_BLOCKING.join(', ')}, because each one disables photo `
        + 'capture and each one therefore has to be put back');

    /*
     * Restoration is a real code path, not a comment: something must put the
     * colour space back, and it must run when a take ends.
     */
    /*
     * A CALL, not a declaration — and this had to be strengthened after a
     * mutation walked through it. The first version accepted the EXISTENCE of
     * `restoreColorSpace`, so deleting the one line that invokes it passed:
     * the function sat there, correct and unreachable, while the plate shutter
     * died after every log take. "A handler wired to nothing looks identical to
     * a working one until it is pressed."
     *
     * Bound to the STOP PATH by brace depth, following one call level —
     * stopRecording delegates the tidy-up to restorePreset, which is where the
     * preset is put back for the same reason.
     */
    assert.ok(/private func restoreColorSpace/.test(cam),
        'nothing restores the colour space at all');

    const stopPath = (extract('func stopRecording') || '') + (extract('private func restorePreset') || '');
    assert.ok(/\brestoreColorSpace\s*\(/.test(stopPath),
        'the colour space is set for a take and nothing on the stop path puts it back. The SDK '
        + 'says photo capture is unsupported while a log space is selected, so after one log take '
        + 'the plate shutter is dead for the rest of the session — and nothing errors');

    const restore = extract('private func restoreColorSpace') || '';
    assert.ok(/colorSpaceBeforeRecording/.test(restore),
        'the restoration does not read what was remembered, so it puts back a guess');
});

test('the photo output is still what makes this matter', () => {
    // If stills had been dropped, the rule above would be pointless — and the
    // FCC-001 guarantee it protects would already be gone.
    const cam = code();
    assert.ok(cam.includes('AVCapturePhotoOutput') && /func shoot\(/.test(cam),
        'the plate camera can no longer take a picture, so the colour-space restoration is '
        + 'protecting something that is not there');
});

/* ------------------------------------------------------------------ *
 * SET 4 — the new formats are declared, priced and honest             *
 * ------------------------------------------------------------------ */

test('the codecs and colour spaces the capabilities unlock are declared', () => {
    assert.ok(CODECS.prores_raw,
        'ProRes RAW is a capability with no codec, so nothing could ever select it');
    const spaces = new Set(Object.values(MODES).map((m) => m.color_space));
    assert.ok(spaces.has('apple_log2'),
        'Apple Log 2 is a capability with no mode, so nothing could ever select it');
});

test('EVERY mode that needs a capability declares which one', () => {
    const wrong = [];
    for (const [id, m] of Object.entries(MODES)) {
        const needsLog2 = m.color_space === 'apple_log2';
        const needsRaw = /raw/i.test(m.codec || '');
        const declared = m.requires || [];
        if (needsLog2 && !declared.includes('apple_log2')) {
            wrong.push(`${id}: records Apple Log 2 and requires nothing — it would be offered on a `
                + 'phone that cannot record it, and fail at the moment the director presses record');
        }
        if (needsRaw && !declared.includes('prores_raw')) {
            wrong.push(`${id}: records ProRes RAW and requires nothing`);
        }
        for (const need of declared) {
            if (!CAPABILITIES[need]) wrong.push(`${id}: requires "${need}", which is not declared`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('EVERY new rate is anchored or flagged, in both directions', () => {
    /*
     * The rule FCC-007 had to strengthen after a mutation walked through it:
     * a flagged rate must explain itself AND a derived rate must be flagged.
     * Nothing publishes an iPhone figure for ProRes RAW or Apple Log 2, so
     * every rate added here is derived from an anchored sibling and says so.
     */
    const added = Object.entries(MODES)
        .filter(([, m]) => m.color_space === 'apple_log2' || /raw/i.test(m.codec || ''));
    assert.ok(added.length >= 2, `only ${added.length} new format(s); the registry read is broken`);

    const wrong = [];
    for (const [id, m] of added) {
        if (!m.source) { wrong.push(`${id}: states no source for its rate`); continue; }
        const saysDerived = /\bderived\b|\bratio\b|times the pixels|same rate as/i.test(m.source);
        if (m.inferred && !saysDerived) wrong.push(`${id}: flagged inferred and does not say from what`);
        if (saysDerived && !m.inferred) {
            wrong.push(`${id}: its source says DERIVED and it is not flagged inferred, so a later `
                + 'task reads a computed number as a published one');
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});
