/**
 * WHAT A CAPTURE MAY BE, DERIVED FROM THE CEILINGS THAT ACTUALLY BIND IT.
 *
 * Three separate limits sit between a phone and a reconstructed world, and they
 * are not the same number: the transport ceiling this engine enforces, the
 * transport ceiling AFTER base64 inflation, and Marble's own cap on a video.
 * An iPhone shooting 4K60 produces about 400MB a minute, so it breaches the
 * smallest of them in roughly fifteen seconds — which is shorter than any orbit
 * worth reconstructing from.
 *
 * The policy is therefore DERIVED, never typed: a duration cap is a function of
 * the bitrate and the binding byte ceiling, so a cap stated as a constant would
 * be wrong the moment any of the three moved. Every figure names the ceiling it
 * respects and where that ceiling comes from.
 *
 * Set-based over the ceilings and over the capture modes, because the failure is
 * partial by nature: a policy right about 1080p and silent about 4K sends
 * somebody out to shoot a clip that cannot be uploaded.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const limits = require('../lib/body-limit');
const contract = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'marble-contract.json'), 'utf8'));
const policy = require('../lib/capture-policy');

test('every ceiling the policy rests on is read from where it is defined', () => {
    const c = policy.CEILINGS;
    assert.ok(c && Object.keys(c).length >= 3,
        'the policy does not enumerate the ceilings that bind a capture');
    // Not a copy: the numbers must BE the ones the rest of the engine enforces.
    assert.strictEqual(c.transport_raw.bytes, limits.FILE_LIMIT,
        'the raw transport ceiling is a second copy of FILE_LIMIT and can drift from it');
    assert.strictEqual(c.transport_base64.bytes, Math.floor(limits.FILE_LIMIT * 3 / 4),
        'the base64 ceiling is not three quarters of the body ceiling');
    assert.strictEqual(c.marble_video.bytes, contract.limits.video_max_bytes,
        "the Marble cap disagrees with the contract ICP-004 recorded");
    for (const [name, spec] of Object.entries(c)) {
        assert.ok(String(spec.source || '').length > 15,
            `${name} does not say where its number comes from`);
    }
});

test('raw upload really is the larger ceiling — that is the point of it', () => {
    assert.ok(policy.CEILINGS.transport_raw.bytes > policy.CEILINGS.transport_base64.bytes,
        'a raw upload buys nothing, so there is no reason to have built it');
});

test('every capture mode gets a duration cap, and it is computed not typed', () => {
    const modes = policy.MODES;
    assert.ok(Object.keys(modes).length >= 3,
        `only ${Object.keys(modes).length} capture modes — a policy silent about 4K sends `
        + 'somebody out to shoot a clip that cannot be uploaded');
    for (const [id, m] of Object.entries(modes)) {
        assert.ok(m.bytes_per_second > 0, `${id}: no bitrate`);
        assert.ok(String(m.source || '').length > 10, `${id}: the bitrate has no source`);
        const cap = policy.maxSecondsFor(id);
        /*
         * ZERO IS A REAL ANSWER, and FCC-007 made it reachable: ProRes 422 HQ
         * at 4K30 is 116MB a second against a 100MB ceiling, so it does not fit
         * one frame that could travel. The rule that mattered was never "the
         * cap is positive" — it is that the cap is COMPUTED, and that a format
         * which fits no seconds is REFUSED rather than offered. Requiring
         * positivity would have forced either an invented rate or a format
         * quietly dropped from the registry.
         */
        assert.ok(Number.isFinite(cap) && cap >= 0, `${id}: no duration cap`);
        if (cap === 0) {
            const choice = policy.formatChoices().find((c) => c.id === id);
            assert.strictEqual(choice && choice.offered, false,
                `${id}: fits zero seconds and is offered — a button that cannot produce one frame`);
        }
        /*
         * Derived: the cap must equal the ceiling that binds THIS mode's own
         * route, divided by the rate.
         *
         * It used to be the blind minimum over every ceiling, which is the
         * defect FCC-011 removed — the smallest is World Labs' cap on a video
         * handed to Marble, and a shot recorded for the cut never goes there.
         * Re-derived rather than exempted: the rule is still "computed, never
         * typed", and only the question it asks has changed.
         */
        const binding = policy.bindingBytesFor(policy.routeFor(m));
        assert.strictEqual(cap, Math.floor(binding / m.bytes_per_second),
            `${id}: the cap is not the binding ceiling divided by the bitrate — it has been typed`);
    }
});

test('the binding ceiling for a WORLD capture is Marble, and for footage it is not', () => {
    /*
     * Worth asserting rather than assuming, and the two halves are the point.
     * Marble binds a clip handed to World Labs — if the transport ever became
     * the smaller one there, the advice for a capture would change. It binds
     * NOTHING that goes into the cut, and asserting that keeps the two apart:
     * they were one number for as long as this module had a blind minimum, and
     * every take in the film was a third shorter for it.
     */
    const c = policy.CEILINGS;
    assert.ok(c.marble_video.bytes < c.transport_base64.bytes,
        'the transport now binds before Marble does — the recommendation needs revisiting');

    const forWorld = policy.bindingCeilingFor({ destination: 'world', kind: 'video' });
    assert.strictEqual(forWorld.id, 'marble_video',
        `a world capture is bound by ${forWorld.id}, so a clip Marble will refuse is accepted here`);

    const forFilm = policy.bindingCeilingFor({ destination: 'footage', kind: 'video' });
    assert.strictEqual(forFilm.id, 'transport_raw',
        `footage is bound by ${forFilm.id}. A shot for the cut never reaches World Labs, and `
        + "pricing it against World Labs' cap is what cost a third of every take");
});

test('the recommendation is a mode a director can actually shoot with', () => {
    const rec = policy.recommended();
    assert.ok(policy.MODES[rec.mode], `recommended mode ${rec.mode} is not a declared mode`);
    assert.ok(rec.max_seconds >= 30,
        `the recommended mode allows only ${rec.max_seconds}s — too short for an orbit of a room`);
    assert.ok(String(rec.why).length > 30, 'the recommendation does not say why');
});

test('4K60 is named as unshootable for a capture, not silently omitted', () => {
    /*
     * The default on a modern iPhone. A policy that simply does not mention it
     * lets somebody shoot a minute of 4K60 and discover at upload that it was
     * never going to work.
     */
    /*
     * FOR A CAPTURE, so the route says so: this test is about a clip handed to
     * Marble, and that is a different number from the same mode shot for the
     * cut — 14 seconds against 22. Asking without a route was how the two
     * became one answer.
     */
    const cap = policy.maxSecondsFor('4k60', { destination: 'world' });
    assert.ok(cap < 30, `4K60 allows ${cap}s, which contradicts ~400MB/min`);
    assert.ok(policy.maxSecondsFor('4k60') > cap,
        'a 4K60 take for the cut fits no longer than one handed to Marble, so the destination is '
        + 'reaching nothing and the ceilings have collapsed back into one');
    const rec = policy.recommended();
    assert.notStrictEqual(rec.mode, '4k60', '4K60 cannot be the recommendation at that bitrate');
});

test('a clip is refused against the binding ceiling, with the number named', () => {
    const tooBig = policy.CEILINGS.marble_video.bytes + 1;
    const verdict = policy.checkCapture({ kind: 'video', bytes: tooBig });
    assert.strictEqual(verdict.ok, false, 'a clip over the Marble cap was accepted');
    assert.match(verdict.why, /100 ?MB|Marble/i, 'the refusal does not name the ceiling it hit');
    assert.ok(policy.checkCapture({ kind: 'video', bytes: 1024 }).ok, 'a small clip was refused');
});

test('a still is bound by the transport, not by the video cap', () => {
    /*
     * A panorama is an image. Holding it to Marble's VIDEO ceiling would refuse
     * a perfectly good 120MB pano, and holding a clip to the transport ceiling
     * would accept one Marble then rejects.
     */
    const between = policy.CEILINGS.marble_video.bytes + 1024;
    assert.ok(policy.checkCapture({ kind: 'image', bytes: between }).ok,
        'a still was held to the video cap');
    assert.strictEqual(policy.checkCapture({ kind: 'video', bytes: between }).ok, false);
});

test('the oversize refusal still arrives before the socket closes', () => {
    /*
     * Pinned, not rebuilt: this was fixed once, and the failure it prevents is
     * a 413 that reaches the browser as "Backend offline". Order is the whole
     * property — writeHead must precede req.destroy().
     */
    const src = fs.readFileSync(path.join(ROOT, 'backend', 'server.js'), 'utf8');
    const head = src.indexOf('res.writeHead(413');
    const destroy = src.indexOf('req.destroy()', head);
    assert.ok(head > 0, 'nothing answers 413');
    assert.ok(destroy > head, 'the socket is destroyed before the 413 is written');
});

test('a binary upload is read as bytes and never base64-decoded', () => {
    const src = fs.readFileSync(path.join(ROOT, 'backend', 'server.js'), 'utf8');
    assert.match(src, /Buffer\.concat/,
        'readBody still accumulates into a string, so every upload must be base64-encoded');
    assert.match(src, /__raw|rawBody/,
        'nothing carries raw bytes to a route, so the binary path cannot be consumed');
});

test('the import path accepts raw bytes as well as a data URI', () => {
    /*
     * Behavioural, not a grep. The first version matched the literal
     * `input.bytes` and failed against a function that names its parameter
     * differently — reporting a working path as broken, which is the grep trap
     * this codebase keeps paying for.
     */
    const { bytesFrom } = require('../lib/media-imports');
    assert.strictEqual(typeof bytesFrom, 'function',
        'nothing turns a request body into bytes, so a raw upload has nowhere to land');
    const raw = bytesFrom({ bytes: Buffer.from([1, 2, 3]), mime: 'video/mp4' });
    assert.strictEqual(raw.mime, 'video/mp4');
    assert.strictEqual(raw.bytes.length, 3);
    // and the data-URI form still works, unchanged
    const uri = bytesFrom({ data: 'data:image/png;base64,aGVsbG8=' });
    assert.strictEqual(uri.mime, 'image/png');
    assert.strictEqual(uri.bytes.toString(), 'hello');
    // an empty body is refused rather than stored as a zero-byte asset
    assert.throws(() => bytesFrom({ bytes: Buffer.alloc(0), mime: 'video/mp4' }), /empty/i);
});

test('the raw branch is narrow — an ordinary POST still parses as JSON', () => {
    /*
     * The condition is the whole safety of this change. Widening it to "not
     * application/json" would send every body with no content-type down the
     * binary path, and every route that reads req.body.x would start seeing a
     * Buffer.
     */
    const src = fs.readFileSync(path.join(ROOT, 'backend', 'server.js'), 'utf8');
    const m = /const isRaw = ([^;]+);/.exec(src);
    assert.ok(m, 'readBody does not decide the raw path from an explicit condition');
    // eslint-disable-next-line no-new-func
    const decide = new Function('contentType', `return ${m[1]};`);
    for (const ct of ['image/png', 'video/mp4', 'model/gltf-binary', 'application/octet-stream']) {
        assert.ok(decide(ct), `${ct} should be read as bytes`);
    }
    for (const ct of ['', 'application/json', 'application/x-www-form-urlencoded', 'text/plain']) {
        assert.ok(!decide(ct), `${ct} must still parse as JSON`);
    }
});
