'use strict';

/**
 * -- Draft while working, finish at the end ---------------------------------
 *
 * "When we create video clips while we're working in the project, we'll always
 * do 480P to save, and then add at the end in the post section an upscale to 4K
 * pass once the film is done."
 *
 * The intent is exactly right and the number is not available everywhere, which
 * is worth stating rather than quietly rounding:
 *
 *   Runway gen4.5 / gen4_turbo   smallest documented raster is 1280x720.
 *                                There is no 480p. `image_to_video` takes a
 *                                RATIO string, so the size IS the ratio, and
 *                                asking for 854x480 snaps to 720p at best.
 *   Seedance 2.5                 480p is real and is $0.17/s against $0.85 at
 *                                1080p — five times cheaper.
 *
 * So draft mode asks for the smallest raster THE RESOLVED MODEL DOCUMENTS, and
 * SAYS which it got. Telling a director they are drafting at 480p while sending
 * 720p is the failure this whole preview effort exists to end.
 *
 * The saving on Runway comes from the model instead: gen4_turbo at 5 credits a
 * second against gen4.5, which is what the existing `draft` tier already says.
 */

const os = require('os');
const path = require('path');
const crypto = require('crypto');
process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'fe-draft-' + crypto.randomUUID().slice(0, 8));

const test = require('node:test');
const assert = require('node:assert');

const { draftFrameFor, DRAFT_FLOORS, upscaleTargetFor } = require('../lib/draft-video');
const { VIDEO_TIERS } = require('../lib/video-tiers');

test('every model declares the smallest raster it will actually accept', () => {
    /*
     * Set-based over the floors, because the failure is per-model: a draft
     * setting that is right for Seedance and wrong for Runway sends a size the
     * provider rejects, and a rejection is a paid generation that returns
     * nothing.
     */
    const runway = require('../lib/providers/runway');
    for (const [model, floor] of Object.entries(DRAFT_FLOORS)) {
        assert.ok(floor.width > 0 && floor.height > 0, `${model} has no draft raster`);
        assert.ok(floor.why, `${model} does not say why that is its floor`);

        // If the model is one Runway documents, the floor must be a ratio it
        // actually lists — anything else is a request built to be refused.
        const spec = (runway.RUNWAY_VIDEO_MODELS || {})[model];
        if (spec && Array.isArray(spec.ratios)) {
            // A model that takes aspect NAMES (Hailuo 3) is sized by its tier:
            // what must be listed is the floor's shape.
            const g = (x, y) => (y ? g(y, x % y) : x);
            const d = g(floor.width, floor.height);
            const named = spec.ratios.every(r => r.split(':').every(n => Number(n) < 100));
            const want = named ? `${floor.width / d}:${floor.height / d}` : `${floor.width}:${floor.height}`;
            assert.ok(spec.ratios.includes(want),
                `${model}'s draft floor ${floor.width}:${floor.height} is not one of its documented `
                + `ratios (${spec.ratios.join(', ')}) — the request would be refused`);
        }
    }
});

test('draft mode never claims a size the model cannot produce', () => {
    /*
     * The honesty requirement. A director told "drafting at 480p" who is
     * actually getting 720p has been given a number to plan a budget on that is
     * wrong by a factor of five.
     */
    const runwayDraft = draftFrameFor('gen4_turbo', { width: 1920, height: 1080 });
    assert.equal(`${runwayDraft.width}x${runwayDraft.height}`, '1280x720',
        'Runway has no 480p; the draft floor there is 720p');
    assert.ok(/no 480|720/.test(runwayDraft.note || ''),
        `the draft does not say what it actually got: ${runwayDraft.note}`);
    assert.equal(runwayDraft.requested_480p, false,
        'the result claims 480p on a model that does not offer it');

    /*
     * Seedance is the opposite case, and it is why the floor is per MODEL
     * rather than a single number: `lib/providers/seedance.js` reaches ByteDance
     * through MuAPI, documents a real 480p at $0.17/s against $0.85 at 1080p,
     * and takes `resolution` explicitly. 480p IS available — through that
     * adapter, not through Runway.
     */
    const seedanceDraft = draftFrameFor('seedance-2.5', { width: 1920, height: 1080 });
    assert.equal(seedanceDraft.requested_480p, true,
        'Seedance documents a 480p tier and the draft did not ask for it');
    assert.ok(seedanceDraft.height <= 480, `asked for ${seedanceDraft.height}p`);
    assert.equal(seedanceDraft.resolution, '480p',
        'the draft does not carry the resolution keyword the Seedance adapter reads');
});

test('a draft keeps the SHAPE it will be finished in', () => {
    /*
     * A vertical shot drafted landscape is not a cheap version of the shot, it
     * is a different shot — and the whole point of the per-shot ratio work is
     * that the framing cannot be recovered by cropping afterwards.
     */
    for (const model of Object.keys(DRAFT_FLOORS)) {
        const vertical = draftFrameFor(model, { width: 1080, height: 1920 });
        assert.ok(vertical.height > vertical.width,
            `${model} drafted a vertical shot as landscape — the framing is lost, not merely smaller`);
        const square = draftFrameFor(model, { width: 1080, height: 1080 });
        assert.ok(Math.abs(square.width - square.height) <= 2,
            `${model} drafted a square shot as ${square.width}x${square.height}`);
    }
});

test('the finishing pass targets the delivery size, not a constant', () => {
    /*
     * "Upscale to 4K at the end" is the intent; the actual target is whatever
     * the project is delivered at. A hardcoded 4K would upscale a 1080p
     * deliverable past its own spec and quadruple the post bill for nothing.
     */
    assert.deepEqual(upscaleTargetFor({ target_resolution: '3840x2160' }), { width: 3840, height: 2160 });
    assert.deepEqual(upscaleTargetFor({ target_resolution: '1920x1080' }), { width: 1920, height: 1080 });
    // No delivery size set: nothing is invented.
    assert.equal(upscaleTargetFor({}), null);
    assert.equal(upscaleTargetFor({ target_resolution: 'nonsense' }), null);
});

test('draft is a tier that already exists, not a second idea about cheapness', () => {
    // The saving on Runway is the MODEL, not the raster: gen4_turbo at 5
    // credits a second is what makes trying three angles a question of taste.
    assert.ok(VIDEO_TIERS.draft, 'the draft tier is gone');
    assert.equal(VIDEO_TIERS.draft.preferredModel, 'gen4_turbo',
        'the draft tier no longer prefers the cheap model, so draft mode saves nothing on Runway');
});

test('the draft resolution the adapter is told is one it documents', () => {
    /*
     * Bound to the adapter's OWN table, not to a number written here. Seedance
     * takes `resolution` as a keyword and builds the model into the URL — the
     * endpoint IS the model — so a keyword it does not know is a 404 rather
     * than a parameter it quietly ignores.
     */
    const { RESOLUTIONS } = require('../lib/providers/seedance');
    const draft = draftFrameFor('seedance-2.5', { width: 1920, height: 1080 });
    assert.ok(RESOLUTIONS[draft.resolution],
        `"${draft.resolution}" is not one of Seedance's documented resolutions `
        + `(${Object.keys(RESOLUTIONS).join(', ')}) — the request would 404`);
    assert.equal(RESOLUTIONS[draft.resolution].usdPerSecond, 0.17,
        'the draft is not asking for the cheapest tier');

    // And the cheapest tier really is the cheapest, from the adapter's table.
    const cheapest = Object.entries(RESOLUTIONS).sort((a, b) => a[1].usdPerSecond - b[1].usdPerSecond)[0][0];
    assert.equal(draft.resolution, cheapest, `draft asks for ${draft.resolution}, not ${cheapest}`);
});

test('a draft on a model with no cheaper tier costs what it always did', () => {
    // Runway has no 480p, so draft mode there must not invent one — the saving
    // is the MODEL (gen4_turbo at 5 credits/second), not the raster.
    const before = draftFrameFor('gen4_turbo', { width: 1920, height: 1080 });
    assert.equal(`${before.width}x${before.height}`, '1280x720');
    assert.equal(before.resolution, null,
        'a resolution keyword was sent to a provider that does not take one');
});

test('the finishing pass scales a draft to the delivery size, not by a constant', () => {
    /*
     * The other half of "draft while working, finish at the end", and it was
     * the half that did not work: the upscale payload carried `scale_factor: 2`
     * regardless of what it was scaling. A 480p draft finished at 960x540 —
     * which is not a deliverable, and looks like a successful post pass.
     *
     * Real-ESRGAN takes INTEGER factors, so the needed factor is rounded UP to
     * one the model offers and the result is reported. Rounding down would
     * deliver under spec silently, which is the failure this whole delivery
     * effort exists to end.
     */
    const { upscaleFactorFor } = require('../lib/draft-video');

    // 854x480 draft -> 1920x1080 delivery needs 2.25x, so 3x (or the next the
    // model offers) rather than 2x, which would land at 1708x960.
    const toHD = upscaleFactorFor({ width: 854, height: 480 }, { width: 1920, height: 1080 });
    assert.ok(toHD.factor * 480 >= 1080,
        `a ${toHD.factor}x pass on a 480p draft reaches ${toHD.factor * 480}p, under a 1080p delivery`);

    /*
     * And a 480p draft CANNOT reach 4K in one pass: 480x4 is 1920 against 2160,
     * and the model takes whole factors. Reporting that as finished would
     * deliver 1920p against a 4K spec and look successful, so it is named
     * instead — with the two ways out, because which one a director wants
     * depends on how much footage they are throwing away.
     */
    const to4K = upscaleFactorFor({ width: 854, height: 480 }, { width: 3840, height: 2160 });
    assert.equal(to4K.short_of_target, true,
        'a 480p draft was reported as reaching 4K in one pass, which it cannot');
    assert.ok(/second pass|720p/.test(to4K.why), `the shortfall names no remedy: ${to4K.why}`);

    // 720p does reach 4K in one 3x pass, which is what makes the remedy real.
    const from720 = upscaleFactorFor({ width: 1280, height: 720 }, { width: 3840, height: 2160 });
    assert.equal(from720.short_of_target, false,
        `720p should reach 4K in one pass and reported ${JSON.stringify(from720.reaches)}`);
    assert.equal(from720.factor, 3);

    // Already at or above delivery: no pass at all. Upscaling a 1080p clip to a
    // 1080p deliverable spends money to change nothing.
    const none = upscaleFactorFor({ width: 1920, height: 1080 }, { width: 1920, height: 1080 });
    assert.equal(none.needed, false, 'a clip already at delivery size was upscaled anyway');

    // Unknown source size: refuses to guess rather than picking a factor that
    // might overshoot into a bigger bill or undershoot the spec.
    const unknown = upscaleFactorFor(null, { width: 3840, height: 2160 });
    assert.equal(unknown.needed, false);
    assert.ok(unknown.why, 'an unmeasurable clip does not say why it was skipped');
});

test('two projects of the same shape draft to the SAME frame', () => {
    /*
     * A fitted raster is rounded to even at its own scale, so a 4K and an HD
     * project both set to 2.39:1 arrive as 3840x1606 and 1920x804 — ratios that
     * differ in the fourth decimal and, before this, produced draft frames 2px
     * apart. Two projects with the same stated shape must draft identically, or
     * the board and the footage disagree for a reason nobody chose.
     */
    const { buildCapabilityPayload } = require('../lib/capability-payloads');
    const shot = { id: 's1', shot_code: '1A', duration_ms: 5000 };
    const card = { shot_code: '1A', description: 'x', camera: {} };

    for (const aspect of ['16:9', '2.39:1', '4:5', '1:1']) {
        const at = res => {
            const { payload } = buildCapabilityPayload('video', {
                shot, sceneCard: card, scene: { id: 'sc1', project_id: 'p1' },
                project: { aspect_ratio: aspect, target_resolution: res, target_fps: 24, draft_video: 1 },
                keyframePath: null,
            });
            return `${payload.width}x${payload.height}`;
        };
        assert.equal(at('3840x2160'), at('1920x1080'),
            `${aspect}: a 4K project and an HD project drafted to different frames`);
    }
});

test('the post payload carries the DERIVED factor, not a constant', () => {
    /*
     * upscaleFactorFor being right is half of it. The payload that actually
     * reaches the provider has to use it — the constant `scale_factor: 2` is
     * what finished a 480p draft at 960x540 and called it done.
     */
    const { buildCapabilityPayload } = require('../lib/capability-payloads');
    const base = {
        shot: { id: 's1', shot_code: '1A', duration_ms: 5000 },
        sceneCard: { shot_code: '1A', description: 'x', camera: {} },
        scene: { id: 'sc1', project_id: 'p1' },
        overrides: { job_type: 'upscale' },
        videoAsset: { id: 'v1', file_name: '1A.mp4', file_path: '/m/1A.mp4', width: 854, height: 480 },
    };

    const to4K = buildCapabilityPayload('post', {
        ...base, project: { id: 'p1', target_resolution: '3840x2160' },
    }).payload;
    assert.ok(to4K.scale_factor > 2,
        `a 480p clip bound for 4K was scaled ${to4K.scale_factor}x, which lands at `
        + `${480 * to4K.scale_factor}p`);
    assert.ok(to4K.upscale_plan, 'the payload does not carry what the pass will reach');
    assert.equal(to4K.upscale_plan.short_of_target, true,
        'the payload claims one pass reaches 4K from 480p');

    const toHD = buildCapabilityPayload('post', {
        ...base, project: { id: 'p1', target_resolution: '1920x1080' },
    }).payload;
    assert.ok(toHD.scale_factor * 480 >= 1080,
        `a ${toHD.scale_factor}x pass lands at ${toHD.scale_factor * 480}p, under HD`);

    // An explicit factor still wins: the director's choice outranks the
    // derivation, which is the rule every override here follows.
    const forced = buildCapabilityPayload('post', {
        ...base, project: { id: 'p1', target_resolution: '3840x2160' },
        overrides: { job_type: 'upscale', scale_factor: 2 },
    }).payload;
    assert.equal(forced.scale_factor, 2, 'an explicit scale factor was overruled by the derivation');
});
