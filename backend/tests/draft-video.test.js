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
            assert.ok(spec.ratios.includes(`${floor.width}:${floor.height}`),
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
     * And Seedance 2.5 is the same, which is the finding: its 480p tier is
     * priced on the MuAPI path and the Runway adapter this engine uses
     * documents 1280:720 as its smallest for that model too. There is currently
     * no 480p anywhere in this pipeline, and the floor table has to say so
     * rather than send a size that would be refused.
     */
    const seedanceDraft = draftFrameFor('seedance2_5', { width: 1920, height: 1080 });
    assert.equal(seedanceDraft.requested_480p, false,
        'the table still claims 480p on a path where it cannot be requested');
    assert.ok(/MuAPI|not wired/.test(seedanceDraft.why),
        `the floor does not explain why 480p is unavailable: ${seedanceDraft.why}`);
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
