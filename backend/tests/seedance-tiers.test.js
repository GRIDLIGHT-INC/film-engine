/**
 * Seedance 2.5 for both halves, traced rather than asserted
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "Are we on Seedance 2.5 for both upscale and 480p?" is two questions, and
 * they had two different answers.
 *
 * The FINISH was wired: `post` resolves to Seedance and buildPostRequest
 * defaults to the 4k tier. The DRAFT was not, for a reason no example test
 * would have caught — `draftFrameFor(built.model, ...)` is handed the payload's
 * model, and nothing ever sets one. A video payload carries `model` only when a
 * caller passes `opts.model`, so the lookup received `undefined`, missed the
 * `'seedance-2.5'` floor entirely, and fell to DEFAULT_FLOOR:
 *
 *     model      : undefined
 *     resolution : undefined
 *     frame      : 1280x720
 *     draft      : "Drafting at 720p — this model has no 480p."
 *
 * Nothing failed. The clip generated, the draft flag said active, and the bill
 * was 720p — twice the draft rate — while every surface reported drafting was
 * on. That is the shape this codebase keeps paying for: a value declared in one
 * module and never reaching the one that consumes it.
 *
 * So the denominator is DERIVED FROM THE REGISTRY: every adapter that serves
 * `video` must name the model it generates with, and that name must have a
 * draft floor. A fourth video adapter added later either declares one or fails
 * here — rather than silently drafting at the conservative default, which is
 * the most expensive way to be wrong.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-tiers-' + crypto.randomUUID().slice(0, 8));

const providers = require('../lib/providers');
const { DRAFT_FLOORS, draftFrameFor } = require('../lib/draft-video');
const seedance = require('../lib/providers/seedance');
const { buildCapabilityPayload } = require('../lib/capability-payloads');
const pricing = require('../lib/provider-pricing');

/** Derived: every registered adapter that can generate footage. */
const VIDEO_ADAPTERS = providers.list().filter(a => (a.capabilities || []).includes('video'));

/** A project set up the way the commercial work is: 4K delivery, drafting on. */
function draftCtx(extra) {
    return {
        project: {
            id: 'p1', aspect_ratio: '16:9', target_resolution: '3840x2160', video_draft: 1,
            provider_config: JSON.stringify({ video: 'seedance', post: 'seedance' }),
            ...(extra || {}),
        },
        scene: { id: 's1' },
        shot: { id: 'sh1', shot_code: '2A', duration_ms: 6000 },
        sceneCard: { shot_code: '2A', description: 'a dolly in', camera: { movement: 'dolly-in' } },
    };
}

test('every adapter that generates footage names the model it generates with', () => {
    assert.ok(VIDEO_ADAPTERS.length >= 3,
        `only ${VIDEO_ADAPTERS.length} video adapters found — this suite is reading a different registry`);

    for (const a of VIDEO_ADAPTERS) {
        assert.ok(a.defaultModel,
            `${a.id} declares no defaultModel, so the draft path cannot know which floor applies `
            + 'and falls to the conservative 720p default — drafting is reported as active while '
            + 'the clip is billed at twice the draft rate');
    }
});

test('every declared default model has a draft floor, so no adapter drafts by accident', () => {
    for (const a of VIDEO_ADAPTERS) {
        assert.ok(Object.prototype.hasOwnProperty.call(DRAFT_FLOORS, a.defaultModel),
            `${a.id}: its default model "${a.defaultModel}" has no DRAFT_FLOORS entry, so it `
            + 'silently drafts at DEFAULT_FLOOR rather than at the smallest raster it documents');
    }
});

test('seedance names a 2.5 model, and that model floors at 480p', () => {
    const sd = VIDEO_ADAPTERS.find(a => a.id === 'seedance');
    assert.ok(sd, 'seedance is not registered as a video provider');
    assert.match(sd.defaultModel, /2\.?5/,
        `seedance's default model is "${sd.defaultModel}" — Seedance 2.0 and 2.5 are different `
        + 'products at different rates, and 2.0 documents no 480p tier');

    const floor = DRAFT_FLOORS[sd.defaultModel];
    assert.strictEqual(floor.resolution, '480p',
        `seedance's floor resolves to ${floor.resolution || floor.width + 'x' + floor.height} `
        + 'rather than 480p — this is the tier the whole draft plan rests on');
});

test('THE DRAFT: a real video payload comes out 480p on a Seedance project', () => {
    /*
     * Behavioural, through the ONE payload path every generation surface uses.
     * Asserting that draftFrameFor returns 480p when handed 'seedance-2.5'
     * would have passed the whole time it was being handed undefined.
     */
    const built = buildCapabilityPayload('video', draftCtx()).payload;

    assert.strictEqual(built.resolution, '480p',
        `the payload carries resolution=${JSON.stringify(built.resolution)} — Seedance builds the `
        + 'tier into its URL, so without the keyword the request goes to the 720p endpoint');
    assert.ok(built.width <= 854 && built.height <= 480,
        `the draft frame is ${built.width}x${built.height}, not a 480p raster`);
    assert.ok(built.draft && built.draft.active, 'the payload does not report itself as a draft');
    assert.match(String(built.draft.note), /480/,
        `the draft note says "${built.draft.note}" — it must state the tier actually used, or a `
        + 'director reading it is told drafting is on while paying the 720p rate');
});

test('THE DRAFT: the floor follows the RESOLVED provider, not a constant', () => {
    /*
     * Differential, and it is what stops the fix being a hardcoded
     * 'seedance-2.5'. Runway documents no 480p tier at all and takes no
     * resolution keyword, so a Runway project drafting at 480p would be asking
     * for a raster the model does not offer and sending a field it ignores --
     * which is exactly the over-claiming the floor table exists to prevent.
     */
    const onRunway = draftCtx({ provider_config: JSON.stringify({ video: 'runway' }) });
    const built = buildCapabilityPayload('video', onRunway).payload;

    assert.strictEqual(built.resolution, undefined,
        `a Runway draft carries resolution=${JSON.stringify(built.resolution)} — Runway takes no `
        + 'such field, so the model is not being resolved per provider');
    assert.ok(built.width >= 1280,
        `a Runway draft is ${built.width}x${built.height} — Runway's smallest gen4.5 ratio is `
        + '1280:720, so this is asking for a raster it does not document');
});

test('THE DRAFT: that payload builds a Seedance 2.5 480p URL', () => {
    const built = buildCapabilityPayload('video', draftCtx()).payload;
    const req = seedance.buildVideoRequest(built);
    assert.match(req.url, /seedance-2\.5/,
        `the draft request goes to ${req.url} — that is not a Seedance 2.5 endpoint`);
    assert.match(req.url, /-480p$/,
        `the draft request goes to ${req.url} — it must end at the 480p tier`);
});

test('THE FINISH: the upscale builds a Seedance 2.5 4K video-edit URL', () => {
    const req = seedance.buildPostRequest({
        type: 'upscale', source_video: 'file:///2A_final.mp4', duration_s: 6,
    });
    assert.match(req.url, /seedance-2\.5/,
        `the finish goes to ${req.url} — that is not a Seedance 2.5 endpoint`);
    assert.match(req.url, /video-edit/,
        `the finish goes to ${req.url} — an upscale must go through the workflow that takes a clip`);
    assert.match(req.url, /-4k$/,
        `the finish goes to ${req.url} — the finishing pass must reach the 4K tier`);
});

test('both tiers are priced, so neither half reports as free', () => {
    /*
     * Set-based over the two operations. An unpriced generation reports zero,
     * which on the most expensive dial in the engine is the worst place for it.
     */
    const OPS = [
        { capability: 'video', model: 'seedance-2.5-480p',          expect: 0.17, what: 'the 480p draft' },
        { capability: 'post',  model: 'seedance-2.5-video-edit-4k', expect: 1.70, what: 'the 4K finish' },
    ];
    for (const op of OPS) {
        const rate = pricing.rateFor('seedance', op.capability, op.model);
        assert.ok(rate, `${op.what}: seedance:${op.capability} has no rate for ${op.model}`);
        assert.strictEqual(rate.usd_per_native, op.expect,
            `${op.what}: priced at $${rate.usd_per_native}/s, expected $${op.expect}/s`);
    }
});

test('no Seedance endpoint is silently 2.0', () => {
    /*
     * `seedance2` (2.0) is registered separately at different rates and
     * documents no 480p tier. Every URL this adapter builds must say 2.5, or a
     * request is being priced against one product and served by another.
     */
    const urls = [
        seedance.buildVideoRequest({ prompt: 'x', resolution: '480p' }).url,
        seedance.buildVideoRequest({ prompt: 'x', resolution: '1080p' }).url,
        seedance.buildPostRequest({ type: 'upscale', source_video: 'file:///a.mp4' }).url,
    ];
    for (const u of urls) {
        assert.match(u, /seedance-2\.5/, `${u} is not a Seedance 2.5 endpoint`);
        assert.ok(!/seedance-2\.0|seedance-2-/.test(u), `${u} points at Seedance 2.0`);
    }
});
