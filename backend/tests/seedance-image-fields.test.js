/**
 * Each Seedance workflow names its pictures differently, and MuAPI is the
 * authority on which
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Found while verifying an uncommitted change to this adapter. Probed against
 * MuAPI's live endpoints, which report their required and accepted fields for
 * free — an all-wrong-types body is refused before anything generates:
 *
 *     image-to-video     image_url      (a single URL)
 *     first-last-frame   images_list
 *     omni-reference     images_list
 *     video-edit         images_list  (+ video_url)
 *     text-to-video      no image field at all
 *
 * The adapter sent THREE names, and two of them exist nowhere in that table:
 * `first_frame_image` / `last_frame_image` for first-last-frame, and
 * `reference_images` for omni-reference. Both are refused outright —
 * `{"type":"missing","loc":["body","images_list"],"msg":"Field required"}` — so
 * the two-keyframe path and the thirty-reference path could not generate at
 * all. Omni-reference is the reason this adapter exists: Runway takes two
 * keyframes and Seedance takes thirty.
 *
 * Only `image_url` on image-to-video was right, which is why single-frame
 * generation worked and made the others look like a different problem.
 *
 * THE OPPOSITE FIX IS ALSO WRONG, and was sitting in the working tree:
 * standardising every workflow on `images_list` repairs three and breaks the
 * one that was working, because image-to-video does not accept it. MuAPI is not
 * uniform here, and assuming it is fails in whichever direction you guess.
 *
 * The contract is a FIXTURE with its date, refreshed by
 * tests/refresh-muapi-contract.js, on the rule the rate book already follows: a
 * live test fails on a train and passes in an office, and a suite that is red
 * for unrelated reasons is one people stop reading.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-sdf-' + crypto.randomUUID().slice(0, 8));

const { buildVideoRequest, WORKFLOWS } = require('../lib/providers/seedance');

/**
 * What MuAPI accepts, per workflow. Read from its own refusals on 2026-08-31.
 * A workflow added to WORKFLOWS without an entry here fails the first test,
 * rather than being sent whatever the last one used.
 */
const IMAGE_FIELD = Object.freeze({
    'text-to-video': null,
    'image-to-video': 'image_url',
    'first-last-frame': 'images_list',
    'omni-reference': 'images_list',
    'video-edit': 'images_list',
    'video-extend': 'images_list',
});

test('every workflow the adapter can choose has a declared image field', () => {
    const undeclared = Object.keys(WORKFLOWS).filter(w => !(w in IMAGE_FIELD));
    assert.deepStrictEqual(undeclared, [],
        `these workflows would be sent an unchecked field name: ${undeclared.join(', ')}`);
});


/**
 * A workflow the builder REFUSES, and why that is not a gap in the field map.
 *
 * ICP-015 retired `video-edit` as an edit on the RBF-001 evidence: its
 * images_list entries are style references rather than keyframes, so an edit
 * cannot be steered by them at all. The MuAPI field name is still recorded
 * above — the upscale reaches the same endpoint through buildPostRequest — but
 * it can no longer be reached through buildVideoRequest, so the field
 * assertions below cannot be made against it.
 *
 * DERIVED BY ATTEMPTING THE BUILD rather than listed, so lifting the refusal
 * brings the field checks back with nothing to remember.
 */
function buildOrRefusal(args) {
    try { return { built: buildVideoRequest(args) }; }
    catch (err) { return { refused: err.message }; }
}

test('a workflow the builder refuses says WHY, and points somewhere', () => {
    const refused = [];
    for (const workflow of Object.keys(IMAGE_FIELD)) {
        const r = buildOrRefusal({
            prompt: 'x', workflow, duration_s: 5,
            source_video: 'https://example.test/clip.mp4',
        });
        if (r.refused) refused.push([workflow, r.refused]);
    }
    // A refusal set that has quietly become empty means this policing nothing.
    assert.ok(refused.length >= 1,
        'no workflow is refused any more — if video-edit was deliberately re-opened, delete this '
        + 'test; if not, the refusal has been lost');
    for (const [workflow, why] of refused) {
        assert.match(why, /aleph/i, `${workflow} is refused and points nowhere: ${why}`);
        assert.match(why, /RBF-001/, `${workflow} is refused without citing the evidence`);
    }
});

const PICTURES = [
    'https://example.test/a.png', 'https://example.test/b.png',
    'https://example.test/c.png', 'https://example.test/d.png',
];

test('each workflow carries its pictures under the name MuAPI actually requires', () => {
    const wrong = [];
    for (const [workflow, field] of Object.entries(IMAGE_FIELD)) {
        const allowed = (WORKFLOWS[workflow] || {}).images || 0;
        if (!allowed) continue;                        // nothing to carry
        const attempt = buildOrRefusal({
            prompt: 'a car turns into the lot',
            workflow,
            reference_images: PICTURES.slice(0, Math.min(allowed, PICTURES.length)),
            ...(workflow === 'video-edit' || workflow === 'video-extend'
                ? { source_video: 'https://example.test/clip.mp4' } : {}),
            duration_s: 5,
        });
        // video-edit is skipped above by declaring no images; routing through
        // the same helper means a refused workflow that later declares some
        // does not throw here instead of being reported.
        if (attempt.refused) continue;
        const body = attempt.built.body || {};

        if (!(field in body)) {
            wrong.push(`${workflow}: sends ${JSON.stringify(Object.keys(body).filter(k => /image|frame|reference/i.test(k)))} `
                + `— MuAPI requires "${field}"`);
            continue;
        }
        /* A single-URL field must be a string; a list must be a list. */
        if (field === 'image_url' && typeof body.image_url !== 'string') {
            wrong.push(`${workflow}: image_url is ${typeof body.image_url}, MuAPI takes one URL`);
        }
        if (field === 'images_list' && !Array.isArray(body.images_list)) {
            wrong.push(`${workflow}: images_list is ${typeof body.images_list}, MuAPI takes an ordered array`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});

test('no request carries a picture field its own workflow does not accept', () => {
    /*
     * The other direction, and the one the tree's uncommitted fix would have
     * broken: sending `images_list` to image-to-video is not a harmless extra,
     * it is a request with no picture at all, because the field it does read is
     * then absent.
     */
    const known = new Set(Object.values(IMAGE_FIELD).filter(Boolean));
    const stray = [];
    for (const [workflow, field] of Object.entries(IMAGE_FIELD)) {
        const allowed = (WORKFLOWS[workflow] || {}).images || 0;
        const attempt = buildOrRefusal({
            prompt: 'x', workflow,
            reference_images: PICTURES.slice(0, Math.max(1, Math.min(allowed, 4))),
            ...(workflow === 'video-edit' || workflow === 'video-extend'
                ? { source_video: 'https://example.test/clip.mp4' } : {}),
            duration_s: 5,
        });
        // Refused workflows are held to their refusal by the test above; there
        // is no request here to check a field name against.
        if (attempt.refused) continue;
        const req = attempt.built;
        for (const key of Object.keys(req.body || {})) {
            if (!known.has(key)) continue;
            if (key !== field) stray.push(`${workflow}: also sends "${key}", which it does not accept`);
        }
        if (!allowed && field === null) {
            for (const k of known) {
                if (k in (req.body || {})) stray.push(`${workflow}: takes no picture and sends "${k}"`);
            }
        }
    }
    assert.deepStrictEqual(stray, [], stray.join('\n  '));
});

test('first-last-frame keeps its order, because the order IS the meaning', () => {
    /*
     * `images_list` is an ORDERED array: [0] is the frame the clip starts on,
     * [1] is the frame it ends on. Reversed, the move runs backwards — and it
     * would look like a generation problem rather than a field-order one.
     */
    const req = buildVideoRequest({
        prompt: 'x', workflow: 'first-last-frame',
        init_image: 'https://example.test/first.png',
        last_frame: 'https://example.test/last.png',
        duration_s: 5,
    });
    assert.deepStrictEqual(req.body.images_list,
        ['https://example.test/first.png', 'https://example.test/last.png'],
        'the first and last frames are not in that order');
});

test('resolution is the ENDPOINT, never a field', () => {
    /*
     * MuAPI accepts no `resolution` on any seedance endpoint — the tier is in
     * the path (`-480p`, `-1080p`, `-4k`). The adapter already does this; the
     * check exists because sending one would be a setting that silently reaches
     * nothing, which is the defect this whole area has been paying for.
     */
    const req = buildVideoRequest({ prompt: 'x', target_resolution: '1920x1080', duration_s: 5 });
    assert.ok(!('resolution' in req.body),
        'a `resolution` field is being sent, and MuAPI reads none');
    assert.match(req.url, /seedance-2\.5-text-to-video-1080p$/,
        `the tier is not in the endpoint: ${req.url}`);
});
