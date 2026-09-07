/**
 * A CAPTURE NOBODY CAN GENERATE FROM IS A FILE, NOT AN INPUT.
 *
 * ICP-005 registered `world-capture` so a panorama, an orbit clip or a LiDAR
 * scan of the real place could be stored against a location. Nothing consumed
 * it: `routes/worlds.js` takes `images` and `video` from the REQUEST BODY, so a
 * caller had to re-send the bytes it had already uploaded, and someone standing
 * in the diner with a phone could not build a world from what they shot.
 *
 * The mapping is DERIVED from the capture target's own declared kinds, and the
 * interesting part is that they do not all map the same way:
 *
 *   image  -> Marble, as a panorama or a still
 *   video  -> Marble, as a walkthrough
 *   model  -> NOT Marble. A GLB is already geometry; it goes to the previs
 *             stage through glb-parser. Sending it to a reconstruction service
 *             is asking a photogrammetry model to re-derive what it was handed.
 *
 * Saying that third case out loud is the point. Silently dropping a scan looks
 * exactly like a capture that failed to upload.
 */

const test = require('node:test');
const assert = require('node:assert');

const { MEDIA_IMPORTS } = require('../lib/media-imports');
const worlds = require('../lib/capture-to-world');

const CAPTURE_KINDS = MEDIA_IMPORTS['world-capture'].kinds;

const cap = (kind, over) => ({
    id: `a-${kind}`, capture_kind: kind, file_path: `/tmp/x.${kind}`,
    file_name: `x.${kind}`, mime_type: kind === 'video' ? 'video/mp4' : 'image/png',
    size_bytes: 1024, ...over,
});

test('every kind a capture can be is accounted for — none silently ignored', () => {
    assert.ok(CAPTURE_KINDS.length >= 3, 'the capture target declares fewer kinds than expected');
    const plan = worlds.planFromCaptures(CAPTURE_KINDS.map((k) => cap(k)));
    const mentioned = new Set([
        ...plan.images.map((i) => i.capture_kind || 'image'),
        ...(plan.video ? ['video'] : []),
        ...plan.excluded.map((e) => e.capture_kind),
    ]);
    const missing = CAPTURE_KINDS.filter((k) => !mentioned.has(k));
    assert.deepStrictEqual(missing, [],
        `these capture kinds are neither sent nor excluded, so they vanish: ${missing.join(', ')}`);
});

test('a panorama becomes a Marble image input', () => {
    const plan = worlds.planFromCaptures([cap('image')]);
    assert.strictEqual(plan.images.length, 1, 'an image capture did not become an image input');
    assert.ok(plan.images[0].uri || plan.images[0].data || plan.images[0].file,
        'the image input carries no bytes and no reference');
});

test('an orbit clip becomes the walkthrough, not one more still', () => {
    const plan = worlds.planFromCaptures([cap('video')]);
    assert.ok(plan.video, 'a video capture did not become the walkthrough');
    assert.strictEqual(plan.images.length, 0,
        'a clip was also added as a still — Marble would read it as a frame, not a walk');
});

test('a scan is EXCLUDED with a reason, never silently dropped', () => {
    const plan = worlds.planFromCaptures([cap('model')]);
    assert.strictEqual(plan.images.length, 0);
    assert.ok(!plan.video);
    assert.strictEqual(plan.excluded.length, 1, 'the scan vanished instead of being excluded');
    const e = plan.excluded[0];
    assert.strictEqual(e.capture_kind, 'model');
    assert.ok(String(e.why).length > 40, 'the exclusion gives no reason');
    assert.match(e.why, /previs|geometry|glb/i,
        'the reason does not say where a scan DOES go — an exclusion with no alternative reads as a bug');
});

test('the clip wins when a location has both — a walk beats a still', () => {
    /*
     * Marble takes ONE prompt shape. A location with both a panorama and an
     * orbit clip has to resolve to one, and the walkthrough carries more
     * spatial information than a single frame. Stated rather than left to
     * whichever row came back first.
     */
    const plan = worlds.planFromCaptures([cap('image'), cap('video')]);
    assert.ok(plan.video, 'the walkthrough was not chosen');
    assert.ok(String(plan.why).length > 20, 'the choice between two inputs is not explained');
});

test('a capture too large for the provider is refused before it is sent', () => {
    const policy = require('../lib/capture-policy');
    const tooBig = policy.CEILINGS.marble_video.bytes + 1;
    const plan = worlds.planFromCaptures([cap('video', { size_bytes: tooBig })]);
    assert.ok(!plan.video, 'an oversize clip was queued for a provider that will refuse it');
    assert.strictEqual(plan.excluded.length, 1);
    assert.match(plan.excluded[0].why, /100 ?MB|Marble|large/i,
        'the refusal does not name the ceiling it hit');
});

test('no captures at all is not an error — the request body still works', () => {
    /*
     * Every world generated before this passed its own images. Making stored
     * captures mandatory would break that; they are an ADDITIONAL source.
     */
    const plan = worlds.planFromCaptures([]);
    assert.strictEqual(plan.images.length, 0);
    assert.ok(!plan.video);
    assert.deepStrictEqual(plan.excluded, []);
    assert.strictEqual(plan.empty, true, 'an empty plan does not say it is empty');
});

test('a capture whose file is gone is named, not treated as usable', () => {
    const plan = worlds.planFromCaptures([cap('image', { file_path: null })]);
    assert.strictEqual(plan.images.length, 0, 'a capture with no file was queued as an input');
    assert.strictEqual(plan.excluded.length, 1);
    assert.match(plan.excluded[0].why, /file|missing|gone/i);
});

test('a panorama is declared as one, using the domain ICP-004 recorded', () => {
    /*
     * is_pano is the lever that most improves a reconstruction, and a capture
     * shot deliberately as a 360 is exactly when it should be true — but only
     * when it was actually shot that way. Guessing is how a wide frame gets
     * read as a panorama.
     */
    const { PANO_VALUES } = require('../lib/providers/worldlabs');
    const pano = worlds.planFromCaptures([cap('image', { is_pano: true })]);
    assert.strictEqual(pano.is_pano, true);
    assert.ok(PANO_VALUES.includes(pano.is_pano), 'a value outside the provider domain was chosen');
    const plain = worlds.planFromCaptures([cap('image')]);
    assert.strictEqual(plain.is_pano, 'auto',
        'a capture that never said it was a panorama was declared one');
});
