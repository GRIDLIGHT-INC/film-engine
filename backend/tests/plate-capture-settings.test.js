/**
 * WHAT EACH PLATE WAS SHOT AT — GRD-3657 / PCC-006.
 *
 * A plate conditions every generated frame of its subject. When one comes back
 * wrong the question is always the same — which lens, how bright, what colour —
 * and until now the only answer was to shoot it again and watch. The lens, ISO,
 * shutter and white balance travel with the upload and are stored on the asset,
 * so a bad plate can be diagnosed rather than re-shot blind.
 *
 * TWO RULES CARRY THIS, AND BOTH ARE ABOUT NOT LOSING A PHOTOGRAPH.
 *
 *   A BAD FIELD IS DROPPED, NEVER THE UPLOAD. These settings are a diagnostic
 *   aid. Refusing a plate because the ISO arrived as a string would lose a
 *   photograph the director has just taken and cannot retake — the light has
 *   moved, the subject has gone. Same reasoning as a refused clip coverage
 *   being reported ALONGSIDE a successful upload.
 *
 *   ABSENT MEANS ABSENT. A plate shot before this existed, or uploaded from the
 *   photo library, has no settings — and must not acquire invented ones. This
 *   is the "NULL means outside the workflow" rule the fingerprint work already
 *   established, and inventing a plausible ISO would be worse than the gap,
 *   because it would be believed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// A temp data directory, before anything touches the database — the same
// isolation plate-upload.test.js uses. tests/test-isolation.test.js refuses any
// test that opens the real one.
process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-capture-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const { CAPTURE_FIELDS, captureSettings } = require('../lib/capture-settings');
const { importMedia } = require('../lib/media-imports');

/** The smallest thing that decodes as a PNG. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
    + 'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A project and a character to hang plates on. */
function subject(name) {
    const projectId = generateId(), characterId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, name);
    db.prepare('INSERT INTO film_characters (id, project_id, name) VALUES (?, ?, ?)')
        .run(characterId, projectId, 'MAYA');
    return { projectId, characterId };
}

const metaOf = (assetId) => JSON.parse(
    db.prepare('SELECT metadata FROM film_assets WHERE id = ?').get(assetId).metadata || '{}');

/* ── the registry, and what it must reject ─────────────────────────────── */

/**
 * SET-BASED over CAPTURE_FIELDS itself, so a fifth setting added later is
 * covered with nothing to remember. Each field declares its own probes, because
 * "out of range" means something different for a shutter speed than for a
 * Kelvin temperature and a shared example would test neither properly.
 */
test('EVERY declared field states what it is and why it is kept', () => {
    const names = Object.keys(CAPTURE_FIELDS);
    assert.ok(names.length >= 4,
        `only ${names.length} fields declared; the task names lens, ISO, shutter and white balance`);
    for (const [name, f] of Object.entries(CAPTURE_FIELDS)) {
        assert.ok(f.why && f.why.length > 25, `${name}: no real reason recorded for keeping it`);
        assert.ok(f.type === 'string' || f.type === 'number', `${name}: unknown type ${f.type}`);
        assert.ok(Array.isArray(f.good) && f.good.length,
            `${name}: declares no valid probe, so nothing proves it is ever kept`);
        assert.ok(Array.isArray(f.bad) && f.bad.length >= 2,
            `${name}: declares fewer than two rejectable probes; one direction is not a range`);
    }
});

test('EVERY field keeps a value it should keep', () => {
    const bad = [];
    for (const [name, f] of Object.entries(CAPTURE_FIELDS)) {
        for (const v of f.good) {
            const got = captureSettings({ [name]: v });
            if (!got || got[name] === undefined) {
                bad.push(`${name}: dropped a legitimate ${JSON.stringify(v)}`);
            }
        }
    }
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('EVERY field rejects what it should reject, in BOTH directions', () => {
    /*
     * Both directions, because a guard written `iso > 0` accepts an ISO of four
     * million and a guard written `iso < 1e6` accepts a negative one. A single
     * probe passes against either half.
     */
    const bad = [];
    for (const [name, f] of Object.entries(CAPTURE_FIELDS)) {
        for (const v of f.bad) {
            const got = captureSettings({ [name]: v }) || {};
            if (got[name] !== undefined) {
                bad.push(`${name}: kept ${JSON.stringify(v)}, which is not a usable value`);
            }
        }
    }
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('a bad field is dropped and its NEIGHBOURS survive', () => {
    /*
     * The rule that keeps a photograph. One malformed setting must not take the
     * other three with it, and must not take the upload with it either.
     */
    const got = captureSettings({ lens: '24mm', iso: 'four hundred', shutter_s: 1 / 60,
                                  white_balance_k: 5600 });
    assert.ok(got, 'a partly-bad payload produced nothing at all');
    assert.strictEqual(got.iso, undefined, 'a non-numeric ISO was kept');
    assert.strictEqual(got.lens, '24mm', 'a good neighbour was dropped with the bad field');
    assert.strictEqual(got.white_balance_k, 5600, 'a good neighbour was dropped');
});

test('nothing at all yields NOTHING, never an empty object', () => {
    /*
     * Absent means absent. An empty `capture` key on the asset says "we
     * recorded the settings and there were none", which is a different and
     * false claim — and it is what a plate uploaded from the photo library
     * would carry.
     */
    for (const input of [undefined, null, {}, { nonsense: 1 }, 'not an object', 42]) {
        assert.strictEqual(captureSettings(input), null,
            `${JSON.stringify(input)} produced a settings object rather than null`);
    }
});

test('unknown keys are dropped — the caller cannot stuff the asset metadata', () => {
    /*
     * The body is unauthenticated and reaches a column that is read back and
     * rendered. An allow-list, never a copy.
     */
    const got = captureSettings({ lens: '24mm', evil: '<script>', __proto__: { x: 1 }, notes: 'x' });
    assert.deepStrictEqual(Object.keys(got), ['lens'],
        `kept keys it does not declare: ${Object.keys(got).join(', ')}`);
});

test('a string field is trimmed and length-capped rather than truncating silently', () => {
    const f = CAPTURE_FIELDS.lens;
    const got = captureSettings({ lens: '  24mm  ' });
    assert.strictEqual(got.lens, '24mm', 'a padded value was not trimmed');
    const over = captureSettings({ lens: 'x'.repeat(f.max + 50) });
    assert.strictEqual((over || {}).lens, undefined,
        'an over-long lens was truncated rather than refused; a trimmed label is a value the '
        + 'camera never reported');
});

/* ── it reaches the asset ──────────────────────────────────────────────── */

test('the settings are stored on the asset, and their absence is too', () => {
    /*
     * The half that matters: a normaliser nobody calls is a validated value
     * that never reaches the database. Driven through the REAL import.
     */
    const { projectId, characterId } = subject('PCC-006 settings');

    const withSettings = importMedia('character-plate', {
        subjectId: characterId, data: PNG, view: 'front',
        capture: { lens: '24mm', iso: 400, shutter_s: 1 / 60, white_balance_k: 5600 },
    });
    const meta = metaOf(withSettings.asset_id);
    assert.ok(meta.capture, 'the settings never reached film_assets.metadata');
    assert.strictEqual(meta.capture.lens, '24mm');
    assert.strictEqual(meta.capture.iso, 400);
    assert.strictEqual(meta.capture.shutter_s, 1 / 60);
    assert.strictEqual(meta.capture.white_balance_k, 5600);

    // And a plate with none — the state every existing plate is in.
    const without = importMedia('character-plate', {
        subjectId: characterId, data: PNG, view: 'back',
    });
    assert.strictEqual(metaOf(without.asset_id).capture, undefined,
        'a plate with no settings acquired a capture key; absent must mean absent, or a reader '
        + 'cannot tell "not recorded" from "recorded as nothing"');
    assert.ok(projectId, 'project fixture');
});

test('a malformed capture block never fails the upload', () => {
    /*
     * The photograph is the thing that cannot be retaken — the light has moved
     * and the subject has gone. Same rule a refused clip coverage follows:
     * report it, keep the file.
     */
    const { characterId } = subject('PCC-006 bad settings');
    for (const bad of ['not an object at all', 42, [], { iso: 'four hundred' }]) {
        const r = importMedia('character-plate', {
            subjectId: characterId, data: PNG, view: 'front', capture: bad,
        });
        assert.ok(r.asset_id,
            `capture: ${JSON.stringify(bad)} lost the photograph; the settings are a diagnostic `
            + 'aid and must never cost an upload');
    }
});

test('what survived is REPORTED back, so a silent drop is visible', () => {
    const { characterId } = subject('PCC-006 report');
    const r = importMedia('character-plate', {
        subjectId: characterId, data: PNG, view: 'front',
        capture: { lens: '24mm', iso: 'nonsense' },
    });
    assert.ok(r.capture, 'the result does not say what was recorded');
    assert.strictEqual(r.capture.lens, '24mm');
    assert.strictEqual(r.capture.iso, undefined,
        'a dropped field is reported as kept; a director would believe it was recorded');
});

/* ── the camera records what it ACTUALLY shot at ───────────────────────── */

const SWIFT = path.join(__dirname, '..', '..', 'ios', 'FilmEngine', 'PlateCamera.swift');
const swift = () => fs.readFileSync(SWIFT, 'utf8')
    .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('the uploader sends the settings', () => {
    const s = swift();
    const send = s.slice(s.indexOf('static func send('), s.indexOf('let (body, response)'));
    assert.match(send, /"capture"/,
        'PlateUploader never sends a capture block, so nothing reaches the route');
});

test('the settings come from the PHOTO, not from the locks', () => {
    /*
     * A plate shot on full auto is still worth diagnosing, so what is recorded
     * is what the exposure ACTUALLY was — not what was locked. AVCapturePhoto
     * carries the EXIF for that specific frame.
     *
     * This closes a loop from PCC-001: `focalLengthIn35mmFilm` is exactly the
     * EXIF key that could not label a picker because it is written AFTER the
     * shot. Here the shot has happened, so it is the right source.
     */
    const s = swift();
    /*
     * Bound to the READ, not to a mention. The first version matched
     * `kCGImagePropertyExif*` anywhere and survived replacing the dictionary
     * lookup with nil — the KEY constants further down still matched, so the
     * check passed over a function that reads nothing from the photo at all.
     */
    assert.match(s, /photo\.metadata\[kCGImagePropertyExifDictionary/,
        'the EXIF dictionary is never read from the photo, so a plate shot on auto records '
        + 'whatever the locks happened to hold — or nothing');
    assert.match(s, /exif\?\[kCGImagePropertyExifISOSpeedRatings/,
        'the ISO is not read from the frame');
    assert.match(s, /exif\?\[kCGImagePropertyExifFocalLenIn35mmFilm/,
        'the lens is not read from the frame; this is the EXIF key PCC-001 could not use for the '
        + 'picker precisely because it is written AFTER the shutter — here it is the right source');
});
