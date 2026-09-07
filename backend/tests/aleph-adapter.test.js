/**
 * THE FIRST VIDEO-TO-VIDEO PATH THIS ENGINE HAS EVER HAD.
 *
 * Eleven video models were registered and every one is image-to-video or
 * text-to-video, so "keep the actor, change the background" had no provider
 * path at all — not a weak one, none.
 *
 * Every fact here is asserted against the CONTRACT ICP-011 recorded from
 * Runway's own OpenAPI spec, never against a list typed in this file. That is
 * the whole reason the contract was verified first: the epic's own constraints
 * section says `frameImages` pinned to first/last, and Runway says `keyframes`
 * pinned by time. An adapter written from the epic would have been broken, and
 * a test written from the epic would have certified it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const runway = require('../lib/providers/runway');
const contract = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'aleph-contract.json'), 'utf8'));

const MODEL = contract.schema.model;
const entry = () => runway.RUNWAY_VIDEO_MODELS[MODEL];

test('the model the contract names is registered', () => {
    assert.ok(entry(), `${MODEL} is not in RUNWAY_VIDEO_MODELS`);
});

test('the registry entry matches the verified contract, field for field', () => {
    const e = entry();
    const wrong = [];
    if (e.endpoint !== 'video_to_video') wrong.push(`endpoint is ${e.endpoint}, not video_to_video`);
    if (e.duration.min !== contract.duration.min_seconds) {
        wrong.push(`duration.min ${e.duration.min} vs contract ${contract.duration.min_seconds}`);
    }
    if (e.duration.max !== contract.duration.max_seconds) {
        wrong.push(`duration.max ${e.duration.max} vs contract ${contract.duration.max_seconds}`);
    }
    if (e.creditsPerSecond !== contract.pricing.credits_per_second) {
        wrong.push(`creditsPerSecond ${e.creditsPerSecond} vs contract ${contract.pricing.credits_per_second}`);
    }
    if (e.minimumCredits !== contract.pricing.minimum_credits) {
        wrong.push(`minimumCredits ${e.minimumCredits} vs contract ${contract.pricing.minimum_credits}`);
    }
    if (e.maxKeyframes !== contract.references.max) {
        wrong.push(`maxKeyframes ${e.maxKeyframes} vs contract ${contract.references.max}`);
    }
    assert.deepStrictEqual(wrong, [], `\n  - ${wrong.join('\n  - ')}`);
});

test('the entry cites the contract, so a reader can re-check it', () => {
    assert.match(String(entry().source || ''), /runwayml\.com/,
        'the entry has no first-party source');
});

test('the adapter posts to the endpoint the contract names', () => {
    const req = runway.buildVideoRequest({
        model: MODEL, videoUri: 'https://x/clip.mp4', promptText: 'replace the background',
    });
    assert.match(req.url, /\/video_to_video$/,
        `an aleph request went to ${req.url} — the adapter has no video_to_video path`);
});

test('the request carries the field names Runway uses, not the aggregator\'s', () => {
    const req = runway.buildVideoRequest({
        model: MODEL, videoUri: 'https://x/clip.mp4', promptText: 'replace the background',
    });
    assert.strictEqual(req.body.videoUri, 'https://x/clip.mp4',
        'the source video is not sent as videoUri');
    assert.strictEqual(req.body.promptText, 'replace the background',
        'the prompt is not sent as promptText');
    for (const wrong of ['inputs', 'positivePrompt', 'frameImages', 'promptImage']) {
        assert.ok(!(wrong in req.body), `the request carries ${wrong}, which this endpoint does not have`);
    }
});

test('only what the contract requires is required', () => {
    /*
     * promptText is OPTIONAL — the aggregator said required. An adapter that
     * demanded it would refuse a legitimate keyframe-only edit.
     */
    const req = runway.buildVideoRequest({ model: MODEL, videoUri: 'https://x/clip.mp4' });
    assert.ok(req.body.videoUri && req.body.model, 'the required pair is not sent');
    for (const k of contract.schema.required) {
        assert.ok(k in req.body, `${k} is required by the contract and is not in the body`);
    }
});

test('keyframes are pinned by TIME, the way the contract says', () => {
    const req = runway.buildVideoRequest({
        model: MODEL, videoUri: 'https://x/clip.mp4',
        keyframes: [{ uri: 'https://x/a.png', seconds: 1.5 }],
    });
    assert.ok(Array.isArray(req.body.keyframes), 'keyframes did not survive');
    assert.strictEqual(req.body.keyframes[0].seconds, 1.5);
    assert.ok(!('position' in req.body.keyframes[0]),
        'a keyframe carries a first/last position, which this endpoint has no concept of');
});

test('more keyframes than the contract allows are REPORTED, not silently dropped', () => {
    const many = Array.from({ length: contract.references.max + 2 },
        (_, i) => ({ uri: `https://x/${i}.png`, seconds: i }));
    const req = runway.buildVideoRequest({ model: MODEL, videoUri: 'https://x/clip.mp4', keyframes: many });
    assert.strictEqual(req.body.keyframes.length, contract.references.max,
        'more keyframes were sent than the endpoint accepts — the request will be refused');
    assert.ok(req.dropped && req.dropped.length,
        'keyframes were dropped and nothing said so');
});

test('a source clip is NEVER sent as a data URI', () => {
    /*
     * The finding that changes the design. Runway caps a base64 data URI at
     * 5MB for videoUri, and a 2-30 second clip is nowhere near that — so a
     * source video cannot travel inline at all. It must be hosted.
     */
    assert.throws(
        () => runway.buildVideoRequest({
            model: MODEL, videoUri: `data:video/mp4;base64,${'A'.repeat(64)}`,
        }),
        /*
         * The message must name the 5MB CAP specifically. An earlier version
         * accepted any refusal, and the generic "not an https URL" branch also
         * rejects a data URI — so removing the data-URI check entirely left this
         * green while the actionable reason was gone. A director told only "that
         * is not a URL" does not learn that hosting is mandatory here.
         */
        (e) => /5 ?MB/.test(e.message) && /data URI/i.test(e.message),
        'a data-URI source video was accepted, or was refused without naming the 5MB cap that '
        + 'makes hosting mandatory');
});

test('a bare local path is refused with the remedy named', () => {
    assert.throws(
        () => runway.buildVideoRequest({ model: MODEL, videoUri: '/tmp/clip.mp4' }),
        (e) => /http|handle|reachable/i.test(e.message),
        'a local path was accepted — Runway cannot fetch this machine\'s disk');
});

test('the existing image-to-video models are untouched', () => {
    /*
     * Eleven models predate this. A new operation that changed where they post
     * would break every clip the engine can already make.
     */
    const req = runway.buildVideoRequest({
        model: 'gen4.5', promptImage: 'https://x/a.png', promptText: 'a push in', duration: 5,
    });
    assert.match(req.url, /\/image_to_video$/, 'an existing model was rerouted');
    assert.ok(!('videoUri' in req.body), 'an image-to-video request gained a videoUri');
});
