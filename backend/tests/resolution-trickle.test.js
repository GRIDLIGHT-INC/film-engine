/**
 * ONE RESOLUTION, SET ONCE, REACHING EVERY CREATIVE.
 *
 * "We need to send the proper resolutions to runway, right now apparently we
 * send 1280:720... what if I want to do 4K? We need to set it at the project
 * level and then it trickles down to all creatives (boards, plates, shots)."
 *
 * Measured before writing this:
 *
 *   footage      sized from film_projects.target_resolution   ✓
 *   board frame  sized from a FIXED 1024x1024 budget          ✗
 *   plate        never sees a resolution at all               ✗
 *
 * So the delivery size a director chose reached exactly one of the three
 * things they were choosing it for. A 4K project boarded at one megapixel and
 * plated at whatever the provider felt like.
 *
 * The other half of the answer is a ceiling that is real and must not be
 * papered over: no generator here produces 4K. Runway's image_to_video
 * documents 1280:720 and 1584:672; the image endpoints cap around one to two
 * megapixels. Asking for more gets a rejection at the provider — a paid failure
 * — so the request is CLAMPED and the clamp is REPORTED, because "I asked for
 * 4K and got 1080" must be visible rather than silent.
 *
 * Set-based over the image adapters, because each caps differently and one that
 * declares nothing would otherwise be assumed unlimited.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-res-' + crypto.randomUUID().slice(0, 8));

const { buildCapabilityPayload } = require('../lib/capability-payloads');

const ctxFor = (aspect, resolution) => ({
    shot: { id: 's1', shot_code: '1A', duration_ms: 5000 },
    sceneCard: { shot_code: '1A', description: 'The dragon moves toward MAYA.', camera: {} },
    scene: { id: 'sc1', project_id: 'p1' },
    project: { aspect_ratio: aspect, target_resolution: resolution, target_fps: 24 },
    keyframePath: null,
});

test('every image adapter declares how large an image it can produce', () => {
    const providers = require('../lib/providers');
    const image = providers.list().filter(e => (e.capabilities || []).includes('image'));
    assert.ok(image.length >= 3, `the image adapter set collapsed (${image.length})`);

    for (const entry of image) {
        assert.ok(Number.isInteger(entry.maxImagePixels) && entry.maxImagePixels > 0,
            `${entry.id} declares maxImagePixels ${JSON.stringify(entry.maxImagePixels)} — an adapter `
            + 'that does not say will be assumed able to produce anything, and asking for more than a '
            + 'provider allows is a rejection that costs a generation');
        // A sanity bound: nothing here makes 8K, and a number that says it does
        // is a typo that will be discovered as a failed paid request.
        assert.ok(entry.maxImagePixels <= 4096 * 4096,
            `${entry.id} claims it can produce ${entry.maxImagePixels} pixels`);
    }
});

/*
 * SUPERSEDED FOR IMAGES BY THE HOUSE STANDARD (lib/image-standard.js):
 *
 *   "When we create image storyboard shots, let's create them in 4K. Plates
 *    (location, characters, props) in 2K."
 *
 * The delivery resolution still sizes the footage and the exports. It no longer
 * sizes a picture: a board frame is 4K and a plate is 2K whatever the project
 * delivers at, in the shot's (or project's) own shape.
 */

test('the board frame is 4K in the shot’s shape, whatever the project delivers at', () => {
    const hd = buildCapabilityPayload('image', ctxFor('16:9', '1920x1080')).payload;
    const sd = buildCapabilityPayload('image', ctxFor('16:9', '1280x720')).payload;
    assert.deepStrictEqual([hd.width, hd.height], [3840, 2160], `a 1080p project boards at ${hd.width}x${hd.height}`);
    assert.deepStrictEqual([sd.width, sd.height], [3840, 2160], `a 720p project boards at ${sd.width}x${sd.height}`);

    const scope = buildCapabilityPayload('image', ctxFor('2.39:1', '1920x1080')).payload;
    assert.ok(scope.width <= 3840 && scope.width >= 3800, `scope boards ${scope.width} wide, not 4K`);
    assert.ok(Math.abs(scope.width / scope.height - 2.39) < 0.02, 'the scope frame lost its aspect');

    const vertical = buildCapabilityPayload('image', ctxFor('9:16', '1080x1920')).payload;
    assert.deepStrictEqual([vertical.width, vertical.height], [2160, 3840],
        `a vertical board is ${vertical.width}x${vertical.height}, not 4K on its side`);
});

test('a provider that cannot make 4K is clamped, and says so', () => {
    const uhd = buildCapabilityPayload('image', { ...ctxFor('16:9', '1920x1080'), maxImagePixels: 1920 * 1080 });
    const p = uhd.payload;

    assert.ok(p.width * p.height <= 1920 * 1080, `nothing clamped a 4K board on a 1080p provider: ${p.width}x${p.height}`);
    assert.ok(Math.abs(p.width / p.height - 16 / 9) < 0.02,
        `clamping changed the shape: ${p.width}x${p.height}`);

    /*
     * Reported, not silent. "The standard is 4K" and "this board is 4K" are
     * different claims, and a director who is not told will believe the second.
     */
    const said = JSON.stringify(uhd.meta || {});
    assert.ok(/clamp|max|provider/i.test(said),
        `the clamp is invisible: ${said}`);
});

test('every plate is 2K, whatever the project delivers at', () => {
    const plates = require('../lib/reference-plates');
    assert.strictEqual(typeof plates.plateImageSize, 'function',
        'nothing sizes a plate, so it generates at whatever the provider defaults to');

    for (const project of [
        { aspect_ratio: '16:9', target_resolution: '1920x1080' },
        { aspect_ratio: '16:9', target_resolution: '1280x720' },
        { aspect_ratio: '16:9', target_resolution: '3840x2160' },
        {},
    ]) {
        for (const kind of ['character', 'location', 'prop']) {
            const size = plates.plateImageSize(project, 4096 * 4096, kind);
            assert.ok(size && Math.max(size.width, size.height) === 2048,
                `${kind} plate for ${JSON.stringify(project)} is ${size && `${size.width}x${size.height}`}, not 2K`);
        }
    }
});
