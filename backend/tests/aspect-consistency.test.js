/**
 * THE BOARD AND THE FOOTAGE ARE THE SAME SHAPE.
 *
 * "Does the aspect ratio and resolution for the board shots and then for the
 * footage generated from Runway stay consistent, and is it derived from the
 * mood board? It needs consistency and already had some issues there."
 *
 * It did. The IMAGE payload derived its shape from film_projects.aspect_ratio
 * and the VIDEO payload derived its shape from film_projects.target_resolution
 * — two independent columns with nothing reconciling them. On Wingfall they
 * agreed by luck, because 16:9 and 1920x1080 are the same shape. Set the mood
 * board's 2.39:1 and press Apply look, and:
 *
 *   board   1584x664  = 2.39:1
 *   footage 1920x1080 = 1.78:1
 *
 * A storyboard in scope and footage in widescreen, with nothing said. The
 * defect was armed and waiting for the director to use a feature we shipped.
 *
 * The aspect ratio is the CREATIVE decision and the resolution is the DELIVERY
 * SIZE, so the frame is the resolution's pixel budget reshaped to the aspect —
 * the reconciliation dimensionsForAspect already performed for images. Both
 * then agree by construction rather than by an operator keeping two columns in
 * step in their head.
 *
 * Set-based over the aspect ratios the project settings actually offer, because
 * agreeing at 16:9 is exactly the case that hid this.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-aspect-' + crypto.randomUUID().slice(0, 8));

const { buildCapabilityPayload } = require('../lib/capability-payloads');
const presets = require('../lib/project-presets');

function payloadsFor(aspect, resolution) {
    const ctx = {
        shot: { id: 's1', shot_code: '1A', duration_ms: 5000 },
        sceneCard: { shot_code: '1A', description: 'The dragon moves toward MAYA.', camera: {} },
        scene: { id: 'sc1', project_id: 'p1' },
        /*
         * `video_draft: 0` on purpose. This file tests the DELIVERY contract —
         * that a board and its footage come out the same shape at the size the
         * project states — and draft mode deliberately overrides that size
         * while a cut is being found. Leaving it on would make every assertion
         * here about the draft floor instead, which is a different question and
         * has its own file.
         *
         * The shape under draft is asserted below, because that is the part
         * that must survive: a vertical shot drafted landscape is a different
         * shot, not a cheaper one.
         */
        project: {
            aspect_ratio: aspect, target_resolution: resolution, target_fps: 24, video_draft: 0,
        },
        keyframePath: null,
    };
    return {
        image: buildCapabilityPayload('image', ctx).payload,
        video: buildCapabilityPayload('video', ctx).payload,
    };
}

const ratioOf = p => p.width / p.height;

test('a project that already agrees is left exactly as it was', () => {
    /*
     * The guarantee that makes this safe to ship: every project today is 16:9
     * at a 16:9 resolution, and a change that moved any of their frames by a
     * pixel would be a change nobody asked for.
     */
    const { image, video } = payloadsFor('16:9', '1920x1080');
    assert.strictEqual(video.width, 1920, 'a 16:9 project no longer generates at its own resolution');
    assert.strictEqual(video.height, 1080);
    assert.ok(Math.abs(ratioOf(image) - 16 / 9) < 0.01,
        `the board frame drifted off 16:9: ${image.width}x${image.height}`);
});

test('every aspect the settings offer produces a board and a clip of the same shape', () => {
    const ids = presets.ASPECT_RATIO_IDS || [];
    assert.ok(ids.length >= 6, `the aspect registry collapsed (${ids.length})`);

    const wrong = [];
    for (const aspect of ids) {
        const m = String(aspect).match(/^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/);
        if (!m) continue;                       // named preset, not a ratio
        const intended = Number(m[1]) / Number(m[2]);

        // Deliberately a 16:9 delivery size against every aspect — the exact
        // state a director lands in by changing the aspect on the mood board
        // and leaving the resolution alone, which is what happened here.
        const { image, video } = payloadsFor(aspect, '1920x1080');

        const boardOff = Math.abs(ratioOf(image) - intended);
        const clipOff = Math.abs(ratioOf(video) - intended);
        if (boardOff > 0.02 || clipOff > 0.02) {
            wrong.push(`${aspect}: board ${image.width}x${image.height} (${ratioOf(image).toFixed(2)}), `
                + `clip ${video.width}x${video.height} (${ratioOf(video).toFixed(2)})`);
        }
    }
    assert.deepStrictEqual(wrong, [],
        'the storyboard and the footage are different shapes:\n  ' + wrong.join('\n  '));
});

test('the delivery size still decides how big the clip is', () => {
    /*
     * Reshaping must not quietly downgrade the delivery. 2.39:1 out of a 4K
     * budget has to stay a 4K-sized frame, or a scope film is delivered at
     * half the pixels it asked for.
     */
    const hd = payloadsFor('2.39:1', '1920x1080').video;
    const uhd = payloadsFor('2.39:1', '3840x2160').video;
    assert.ok(uhd.width > hd.width * 1.8,
        `a 4K project generated at ${uhd.width}x${uhd.height} against HD's ${hd.width}x${hd.height}`);

    // Dimensions a video encoder will accept: even, and not absurd.
    for (const p of [hd, uhd]) {
        assert.strictEqual(p.width % 2, 0, `odd width ${p.width}`);
        assert.strictEqual(p.height % 2, 0, `odd height ${p.height}`);
    }
});

test('an unset or unparseable aspect falls back to the delivery size untouched', () => {
    /*
     * A project with no aspect must not be reshaped by a guess. Absent means
     * "use what is delivered", which is what every project had before the
     * mood board could set one.
     */
    for (const aspect of [null, undefined, '', 'widescreen']) {
        const { video } = payloadsFor(aspect, '1920x1080');
        assert.strictEqual(video.width, 1920, `aspect ${JSON.stringify(aspect)} reshaped the frame`);
        assert.strictEqual(video.height, 1080);
    }
});

test('a DRAFT keeps the shape the delivery would have had', () => {
    /*
     * Draft mode changes the size and must never change the shape. A vertical
     * shot drafted landscape is a different shot — the framing cannot be
     * recovered afterwards, which is the whole reason a per-shot ratio exists.
     */
    const { buildCapabilityPayload: build } = require('../lib/capability-payloads');
    for (const [aspect, resolution] of [['16:9', '1920x1080'], ['9:16', '1920x1080'],
        ['4:5', '1920x1080'], ['2.39:1', '3840x2160'], ['1:1', '1920x1080']]) {
        const ctx = {
            shot: { id: 's1', shot_code: '1A', duration_ms: 5000 },
            sceneCard: { shot_code: '1A', description: 'x', camera: {} },
            scene: { id: 'sc1', project_id: 'p1' },
            project: { aspect_ratio: aspect, target_resolution: resolution, target_fps: 24, draft_video: 1 },
            keyframePath: null,
        };
        const delivered = build('video', { ...ctx, project: { ...ctx.project, draft_video: 0 } }).payload;
        const drafted = build('video', ctx).payload;

        assert.ok(drafted.draft && drafted.draft.active, `${aspect}: draft mode did not engage`);
        /*
         * Never LARGER. A 9:16 shot in a landscape delivery raster fits to
         * 608x1080, and a 720p floor applied to that shape is 720x1280 — so
         * drafting would cost MORE than delivering. In that case the draft
         * stands down and says so, rather than quietly generating a bigger
         * frame than the film needs.
         */
        assert.ok(drafted.width <= delivered.width && drafted.height <= delivered.height,
            `${aspect}: the draft ${drafted.width}x${drafted.height} is LARGER than the `
            + `delivery ${delivered.width}x${delivered.height}`);
        if (drafted.width === delivered.width && drafted.height === delivered.height) {
            assert.ok(/No draft/.test(drafted.draft.note),
                `${aspect}: the draft changed nothing and did not say why`);
            continue;
        }
        assert.ok(Math.abs((drafted.width / drafted.height) - (delivered.width / delivered.height)) < 0.02,
            `${aspect}: drafted ${drafted.width}x${drafted.height} is a different shape from `
            + `the delivery ${delivered.width}x${delivered.height}`);
    }
});
