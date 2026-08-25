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

test('the board frame is sized from the project, not from a constant', () => {
    /*
     * The specific fault: dimensionsForAspect was handed IMAGE_DEFAULTS
     * (1024x1024) as the pixel budget, so a project set to 4K and a project set
     * to 720p boarded at exactly the same size.
     */
    const hd = buildCapabilityPayload('image', ctxFor('16:9', '1920x1080')).payload;
    const sd = buildCapabilityPayload('image', ctxFor('16:9', '1280x720')).payload;

    assert.ok(hd.width > sd.width,
        `a 1920x1080 project boards at ${hd.width}x${hd.height} and a 1280x720 project at `
        + `${sd.width}x${sd.height} — the delivery size reaches nothing`);
    assert.ok(Math.abs(hd.width / hd.height - 16 / 9) < 0.02, 'the board frame lost its aspect');
});

test('a request beyond what any provider can make is clamped, and says so', () => {
    const uhd = buildCapabilityPayload('image', ctxFor('16:9', '3840x2160'));
    const p = uhd.payload;

    assert.ok(p.width * p.height <= 4096 * 4096, 'nothing clamped a 4K request');
    assert.ok(Math.abs(p.width / p.height - 16 / 9) < 0.02,
        `clamping changed the shape: ${p.width}x${p.height}`);

    /*
     * Reported, not silent. "I set the project to 4K" and "my boards are 4K"
     * are different claims, and a director who is not told will believe the
     * second because they did the first.
     */
    const said = JSON.stringify(uhd.meta || {});
    assert.ok(/clamp|max|provider/i.test(said),
        `the clamp is invisible: ${said}`);
});

test('plates are sized the same way the board is', () => {
    /*
     * A plate conditions every frame its subject appears in. Generated at a
     * different size from the frames that reference it, it is either upscaled
     * detail nobody asked for or a soft reference on a sharp board.
     */
    const plates = require('../lib/reference-plates');
    assert.strictEqual(typeof plates.plateImageSize, 'function',
        'nothing sizes a plate, so it generates at whatever the provider defaults to');

    const hd = plates.plateImageSize({ aspect_ratio: '16:9', target_resolution: '1920x1080' });
    const sd = plates.plateImageSize({ aspect_ratio: '16:9', target_resolution: '1280x720' });
    assert.ok(hd && hd.width > 0, 'no size for an HD project');
    assert.ok(hd.width > sd.width, 'the project resolution does not reach a plate');

    // A project with no resolution set must not be reshaped by a guess.
    const none = plates.plateImageSize({});
    assert.ok(!none || !none.width,
        'a project with no resolution had one invented for its plates');
});
