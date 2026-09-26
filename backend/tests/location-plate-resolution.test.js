/**
 * A location plate is generated at 2K or better, or it says why not.
 *
 * "Location plates should always go to at least 2K."
 *
 * A location plate is the one reference that is RE-SHOT FROM. A character or
 * prop plate is a close-up filling its own frame, so the subject occupies most
 * of the pixels; a location plate's subject is the whole environment, and any
 * given shot uses a fraction of it — a corner of the street, one house front,
 * the far kerb. Detail that is adequate on a portrait is mush on a crop.
 *
 * Set-based over the image adapters, because the honest answer differs per
 * provider: some can serve 2K and some cannot, and a floor that silently
 * delivers less on the ones that cannot is worse than no floor at all.
 */

const test = require('node:test');
const assert = require('node:assert');

const providers = require('../lib/providers');
const { plateImageSize, LOCATION_MIN_EDGE } = require('../lib/reference-plates');

/** Every adapter that can generate an image, with its declared ceiling. */
function imageAdapters() {
    return providers.list()
        .filter(a => (a.capabilities || []).includes('image'))
        .map(a => ({ id: a.id, maxPixels: a.maxImagePixels }));
}

const PROJECT = { aspect_ratio: '16:9', target_resolution: '1920x1080' };

test('2K is stated as a number, not spelled into the code', () => {
    assert.strictEqual(typeof LOCATION_MIN_EDGE, 'number');
    assert.ok(LOCATION_MIN_EDGE >= 2048, `${LOCATION_MIN_EDGE} is not 2K`);
});

test('a location plate reaches the floor wherever the provider allows it', () => {
    /*
     * Derived over the adapters. The two that cannot are not failures — they
     * are the reason this reports rather than promises.
     */
    const short = [];
    for (const a of imageAdapters()) {
        const size = plateImageSize(PROJECT, a.maxPixels, 'location');
        assert.ok(size, `${a.id}: no size produced for a location plate`);

        const longEdge = Math.max(size.width, size.height);
        const fits = (LOCATION_MIN_EDGE * (9 / 16)) * LOCATION_MIN_EDGE <= (a.maxPixels || Infinity);
        if (fits && longEdge < LOCATION_MIN_EDGE) {
            short.push(`${a.id}: ${size.width}x${size.height}, and its ceiling allows more`);
        }
        // Whatever the outcome, it must SAY whether the floor was met.
        assert.strictEqual(typeof size.below_floor, 'boolean',
            `${a.id}: the size does not report whether it reached 2K`);
    }
    assert.deepStrictEqual(short, [], `\n  ${short.join('\n  ')}`);
});

test('a provider that cannot reach 2K says so rather than quietly delivering less', () => {
    // openai caps at 1536x1024 and runway at 1920x1080 — neither reaches a
    // 2048 long edge, and a director choosing them should be told, not left to
    // measure the file.
    const cannot = imageAdapters().filter(a =>
        a.maxPixels && a.maxPixels < LOCATION_MIN_EDGE * Math.round(LOCATION_MIN_EDGE * 9 / 16));
    assert.ok(cannot.length, 'no adapter is below the floor — the reporting path is untested');

    for (const a of cannot) {
        const size = plateImageSize(PROJECT, a.maxPixels, 'location');
        assert.strictEqual(size.below_floor, true, `${a.id} claims it reached 2K`);
        assert.ok(size.floor_reason && size.floor_reason.length > 20,
            `${a.id}: below the floor with no reason a person can act on`);
        assert.ok(Math.max(size.width, size.height) < LOCATION_MIN_EDGE);
    }
});

test('the shape survives being raised to the floor', () => {
    /*
     * Scaling to reach 2K must not change the aspect. A location plate at a
     * different shape from the frames referencing it is the exact
     * board-versus-footage mismatch aspect-consistency exists to prevent.
     */
    for (const [aspect, ratio] of [['16:9', 16 / 9], ['2.39:1', 2.39], ['4:3', 4 / 3]]) {
        const size = plateImageSize({ aspect_ratio: aspect, target_resolution: '1920x1080' },
            4194304, 'location');
        const got = size.width / size.height;
        assert.ok(Math.abs(got - ratio) / ratio < 0.02,
            `${aspect}: raised to ${size.width}x${size.height}, which is ${got.toFixed(3)} not ${ratio.toFixed(3)}`);
    }
});

test('every plate kind is 2K, by the house standard', () => {
    /*
     * This used to hold the floor to LOCATIONS only, on the argument that a
     * character or prop fills its own frame. The house standard overrules it:
     * every plate — character, location, prop — is a 2048 long edge
     * (lib/image-standard.js), because a plate is what every frame is built from.
     */
    const roomy = 4194304;
    for (const kind of ['character', 'location', 'prop']) {
        const size = plateImageSize(PROJECT, roomy, kind);
        assert.strictEqual(Math.max(size.width, size.height), LOCATION_MIN_EDGE,
            `${kind} plate is ${size.width}x${size.height}, not 2K`);
    }
});

test('a project with no resolution still gets a 2K location plate', () => {
    /*
     * "Always" is the word in the request. Elsewhere a project with no
     * resolution deliberately gets NOTHING — the provider's own default is the
     * right answer when nobody has stated one. A floor is a different kind of
     * statement: someone HAS stated one, for this kind of plate, and it should
     * hold whether or not the project settings are filled in.
     */
    const size = plateImageSize({ aspect_ratio: '16:9' }, 4194304, 'location');
    assert.ok(size, 'no size at all for a project with no resolution');
    assert.ok(Math.max(size.width, size.height) >= LOCATION_MIN_EDGE,
        `${size.width}x${size.height} is below the floor`);

    // And so does every other kind: 2K is the house standard, not a project setting.
    const character = plateImageSize({ aspect_ratio: '16:9' }, 4194304, 'character');
    assert.ok(character && Math.max(character.width, character.height) === LOCATION_MIN_EDGE,
        'a character plate for a project with no resolution is not 2K');
});

test('the floor note never travels to a provider', () => {
    /*
     * The note is for the caller. The plate payload is spread straight into
     * provider.generate(), so an unrecognised field would be sent to Runway or
     * Meshy with the request — the kind of thing that is ignored right up until
     * a provider starts validating its input.
     */
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'reference-plates.js'), 'utf8');

    const at = src.indexOf("provider.generate('image'");
    assert.notStrictEqual(at, -1, 'the plate generator call is gone');
    const before = src.slice(0, at);
    assert.match(before, /delete basePayload\.__below_floor/,
        'the floor note is still on the payload when it is sent');

    // And it must be captured before it is deleted, or the report is lost.
    assert.match(before, /const belowFloor = basePayload\.__below_floor/,
        'the note is deleted without being kept, so nothing can report it');
});
