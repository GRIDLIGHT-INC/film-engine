/**
 * The 4K finishing pass
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Footage is generated at 480p to keep exploration affordable — that is the
 * whole point of the draft tier, and at $0.17/s against $0.85 it makes trying a
 * shot three times cost less than getting it right once at delivery size. The
 * pass that takes the finished cut back up to 4K had NO PROVIDER AT ALL:
 * `post` is served by Gridlight alone, and Gridlight does not implement
 * `/postprocess`. So the cheap half of the plan worked and the half that
 * produces the deliverable did not exist.
 *
 * Seedance already documents the tier — 4k at $1.70/s, the same rate card the
 * 480p draft floor comes from — and a `video-edit` workflow that takes a
 * finished clip. The finishing pass is that workflow at that tier.
 *
 * Set-based over the four `post` sub-types, because this fails PARTIALLY: an
 * adapter that upscales and silently no-ops a colour grade reports success for
 * work it never did, which is the failure mode the whole spend audit exists to
 * catch.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-seedance-' + crypto.randomUUID().slice(0, 8));

const seedance = require('../lib/providers/seedance');
const { RESOLUTIONS } = seedance;

/** The four sub-types `post` declares, and what Seedance can honestly do. */
const POST_JOBS = [
    { type: 'upscale',      served: true,  why: 'the video-edit workflow at the 4k tier' },
    { type: 'face_restore', served: false, why: 'Seedance exposes no face-restoration workflow' },
    { type: 'color_grade',  served: false, why: 'Seedance exposes no grade workflow' },
    { type: 'composite',    served: false, why: 'compositing is an editorial act, not a generation' },
];

test('seedance declares the post capability, so the finishing pass has a provider at all', () => {
    assert.ok(seedance.adapter.capabilities.includes('video'),
        'seedance no longer serves video — this suite is reading a different adapter');
    assert.ok(seedance.adapter.capabilities.includes('post'),
        'seedance does not declare `post`, so the 4K finishing pass still resolves to Gridlight, '
        + 'which does not implement /postprocess — footage generated at 480p can never be '
        + 'finished at delivery size');
});

test('a 4k tier exists on the rate card the draft floor is read from', () => {
    /*
     * Derived from the adapter's own table rather than asserted as a literal:
     * the draft floor and the finishing tier must come from ONE rate card, or
     * they can disagree about what Seedance offers.
     */
    assert.ok(RESOLUTIONS['4k'], 'seedance no longer documents a 4k tier');
    assert.ok(RESOLUTIONS['480p'], 'seedance no longer documents a 480p tier');
    assert.ok(RESOLUTIONS['4k'].longEdge >= 3840,
        `the 4k tier reports a ${RESOLUTIONS['4k'].longEdge}px long edge, which is not 4K`);
    assert.ok(RESOLUTIONS['4k'].usdPerSecond > RESOLUTIONS['480p'].usdPerSecond,
        'the 4k tier is not priced above the draft tier — one of the two entries is wrong, and '
        + 'the saving the whole draft plan rests on cannot be verified');
});

test('an upscale goes to the 4k endpoint, carrying the finished clip', () => {
    const req = seedance.buildPostRequest({
        type: 'upscale',
        source_video: 'https://example.test/2A_final.mp4',
        duration_s: 8,
    });
    assert.ok(req.url.includes('4k'),
        `an upscale was routed to ${req.url} — it must use the 4k tier, or the "finishing pass" `
        + 'returns the same size it was given');
    assert.ok(/video-edit|video_edit/.test(req.url),
        `an upscale was routed to ${req.url} — the finished clip has to go through the workflow `
        + 'that takes a video, not one that generates from text');
    assert.strictEqual(req.body.video_url || req.body.source_video, 'https://example.test/2A_final.mp4',
        'the clip being finished never reaches the request');
});

test('an upscale with no clip is refused, not sent', () => {
    /*
     * Without a source the video-edit workflow has nothing to edit and would
     * generate something NEW from the prompt — a paid request returning a clip
     * that is not the film. Refused here, where it costs nothing.
     */
    assert.throws(() => seedance.buildPostRequest({ type: 'upscale' }),
        /source|clip|video/i,
        'an upscale with no source video is accepted, so the finishing pass would generate a '
        + 'brand-new clip and present it as the finished shot');
});

test('every post sub-type is either served or refused BY NAME', () => {
    for (const job of POST_JOBS) {
        if (job.served) {
            assert.doesNotThrow(() => seedance.buildPostRequest({
                type: job.type, source_video: 'https://example.test/a.mp4',
            }), `${job.type}: declared served and refused anyway`);
            continue;
        }
        /*
         * Refused with the sub-type named. Silently upscaling when asked to
         * grade is worse than refusing: it returns a file, reports success, and
         * the grade never happened.
         */
        assert.throws(() => seedance.buildPostRequest({
            type: job.type, source_video: 'https://example.test/a.mp4',
        }), new RegExp(job.type),
            `${job.type}: not refused by name — Seedance ${job.why}, so a caller asking for it `
            + 'must be told, never handed an upscale wearing its name');
    }
});

test('the finishing tier can be overridden, so a 1080p delivery is not billed at 4K', () => {
    /*
     * A 4K default is right for the plan as stated and wrong as a ceiling: a
     * spot delivered at 1080p would be billed at $1.70/s to produce pixels
     * nobody ships. An explicit resolution wins, exactly as it does on the
     * draft path.
     */
    const req = seedance.buildPostRequest({
        type: 'upscale', source_video: 'https://example.test/a.mp4', resolution: '1080p',
    });
    assert.ok(req.url.includes('1080p'),
        `an explicit 1080p finish was routed to ${req.url} — the override is ignored, so every `
        + 'finish is billed at the 4K rate');
});

test('generate() routes post through the post builder, not the video one', () => {
    /*
     * The capability being declared says nothing about DISPATCH: `post` could
     * be listed and still fall through to the video builder, which would read
     * an upscale as a text-to-video request and generate a brand-new clip.
     *
     * Probed with a sub-type the adapter REFUSES, because that refusal is
     * raised by the post builder and answered before the credential check --
     * so it proves which path was taken without a key, without a network call
     * and without a database. (Probing with `upscale` reaches getCredential,
     * which needs a migrated database this suite has no reason to build.)
     */
    return seedance.generate('post', { type: 'color_grade', source_video: 'https://example.test/a.mp4' })
        .then(res => {
            assert.strictEqual(res.ok, false, 'a grade is not something Seedance can do');
            assert.ok(/color_grade/.test(res.error),
                `post dispatch returned "${res.error}" — the post builder never ran, so the `
                + 'sub-type was not understood and an upscale would have been sent instead');
            assert.ok(!/not served here: post|nothing to generate from/.test(res.error),
                'generate() still refuses `post` outright or fell through to the video builder, '
                + 'so declaring the capability changed nothing');
        });
});
