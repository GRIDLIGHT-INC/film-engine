/**
 * Phase 3 — previs reaches the generator.
 *
 * Exit criterion, in two halves, and the second is the one that matters:
 *
 *   BLOCKED   a blocked shot emits a camera_control whose `type` is exactly the
 *             one CAMERA_CONTROL_MAP already sends for that movement, plus the
 *             sampled path.
 *   UNBLOCKED byte-identical output to before this phase existed.
 *
 * The second is checked against a GOLDEN FIXTURE captured from the code as it
 * stood before phase 3 was written — 54 payloads across every movement and
 * three framings. Asserting "the new code agrees with the new code" would be
 * worthless; the whole claim is that nothing changed for shots nobody has
 * blocked, and that can only be proven against a record of what the old code
 * actually produced. Regenerating the fixture to make this pass would be
 * deleting the guarantee, so don't.
 *
 * Previs that stops at a diagram is a drawing tool bolted to a film engine.
 * This is the phase that makes blocking mean something downstream.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-tovideo-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { buildVideoPayload, CAMERA_CONTROL_MAP } = require('../lib/video-prompt');
const { VALID_CAMERA_MOVES } = require('../lib/scene-card-schema');
const { defaultBlocking, samplePath, MOVEMENTS } = require('../lib/previs-blocking');
const { CAPABILITY_BUILDERS, loadShotContext } = require('../lib/capability-payloads');
const { handlePrevis } = require('../routes/previs');

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'video-payload-golden.json'), 'utf8'));

// Exactly the inputs the fixture was captured with.
function goldenCall(movement, shotType) {
    const card = {
        shot_code: 'SH01', action: 'Maya wipes the counter', duration_ms: 4000,
        camera: { shot_type: shotType, movement, lens: '50mm' },
        lighting: { type: 'neon' },
        characters: ['MAYA'],
    };
    return [card, [{ name: 'MAYA', appearance_prompt: 'tired, 30s' }],
        { name: 'DINER', lighting_default: 'neon' }, 'noir', { seed: 12345 }];
}

// ── The guarantee: nothing changes for unblocked shots ──────────────────────

test('the golden fixture covers every movement', () => {
    const covered = new Set(Object.keys(GOLDEN).map(k => k.split('|')[0]));
    const missing = VALID_CAMERA_MOVES.filter(m => !covered.has(m));
    assert.deepStrictEqual(missing, [], `fixture does not pin: ${missing.join(', ')}`);
    assert.strictEqual(Object.keys(GOLDEN).length, VALID_CAMERA_MOVES.length * 3);
});

test('an unblocked shot produces byte-identical output to before phase 3', () => {
    // Everything except the prompt STRING, which is compared by content below.
    //
    // The guarantee this fixture exists for is that previs blocking does not
    // leak into shots nobody has blocked, and camera_control is where that would
    // show. The prompt was later deliberately reordered — the shot now leads and
    // subject descriptions follow, because a prompt opening with a face produces
    // a portrait — so a byte comparison of the string would fail on a change
    // that has nothing to do with previs, and regenerating the fixture to hide
    // that would delete the real guarantee. Split rather than regenerated.
    const drift = [];
    for (const [key, expected] of Object.entries(GOLDEN)) {
        const [movement, shotType] = key.split('|');
        const actual = buildVideoPayload(...goldenCall(movement, shotType));
        /*
         * `model` is compared out, deliberately, and the fixture is NOT
         * regenerated — regenerating it would delete the guarantee it exists
         * for. The 54 payloads were captured when this builder hardcoded
         * `animatediff-sdxl`, a Gridlight name emitted for every provider, so
         * every Runway preview carried "you asked for a model this provider
         * does not offer" — the substitution notice firing on a request nobody
         * made. A model name is a fact about a provider and is now named by
         * the provider, so this field is the one thing in these payloads that
         * is SUPPOSED to have moved. Everything else stays pinned byte for byte.
         */
        /*
         * `motion_prompt` is stripped for the same reason as `prompt`, and the
         * fixture is again NOT regenerated. It is the compiled motion sentence
         * introduced when the video path stopped sending a still-image prompt —
         * a deliberate change to a STRING, with nothing to do with whether
         * previs leaks into an unblocked shot, which is the only thing these 54
         * payloads exist to guarantee. Split rather than regenerated.
         */
        const strip = o => { const { prompt, motion_prompt, model, ...rest } = o; return rest; };
        if (JSON.stringify(strip(actual)) !== JSON.stringify(strip(expected))) {
            drift.push({ key, expected: expected.camera_control, actual: actual.camera_control });
        }
    }
    assert.deepStrictEqual(drift, [],
        `phase 3 changed output for shots with no blocking:\n${JSON.stringify(drift.slice(0, 3), null, 1)}`);
});

test('the shared payload names no provider-specific model', () => {
    /*
     * Stronger than pinning the old value: the builder is shared by every
     * provider, so ANY model name it emits is wrong for all but one of them.
     * Runway ignores a foreign name and warns, Seedance carries its model in
     * the route, and Gridlight passes it straight through — so a stray default
     * here is a false alarm on two adapters and a wrong request on the third.
     */
    const offenders = [];
    for (const [key] of Object.entries(GOLDEN)) {
        const [movement, shotType] = key.split('|');
        const built = buildVideoPayload(...goldenCall(movement, shotType));
        if ('model' in built) offenders.push(`${key} -> ${built.model}`);
    }
    assert.deepStrictEqual(offenders.slice(0, 3), [],
        `the shared video payload names a model nobody asked for: ${offenders.slice(0, 3).join(', ')}`);

    // An explicit request must still travel, or a caller cannot choose at all.
    const [mv, st] = Object.keys(GOLDEN)[0].split('|');
    const args = goldenCall(mv, st);
    const opts = { ...(args[args.length - 1] || {}), model: 'gen4.5' };
    const asked = buildVideoPayload(...args.slice(0, -1), opts);
    assert.strictEqual(asked.model, 'gen4.5', 'an explicitly chosen model was dropped');
});

test('the prompt still says the same things, in a deliberate order', () => {
    // The prompt was reordered, not rewritten. Every clause the old code
    // produced must still be present — a REORDER is a decision, a LOSS is a bug,
    // and a byte comparison cannot tell them apart.
    const missing = [];
    for (const [key, expected] of Object.entries(GOLDEN)) {
        const [movement, shotType] = key.split('|');
        const actual = buildVideoPayload(...goldenCall(movement, shotType));
        const clauses = expected.prompt.split(', ').map(c => c.trim()).filter(Boolean);
        for (const c of clauses) {
            if (!actual.prompt.includes(c)) missing.push(`${key}: lost "${c}"`);
        }
    }
    assert.deepStrictEqual(missing.slice(0, 5), [],
        `the reordering dropped clauses rather than moving them:\n  ${missing.slice(0, 5).join('\n  ')}`);
});

test('the shot leads the prompt, not the subject', () => {
    // What the reordering was FOR, pinned here so the video path cannot drift
    // back: a prompt that opens with "tired, 30s" is a request for a portrait.
    const payload = buildVideoPayload(...goldenCall('static', 'wide'));
    const head = payload.prompt.slice(0, 60);
    assert.ok(!/^tired, 30s/.test(head), `the video prompt still opens with a subject: ${head}`);
});

test('no previs key leaks into an unblocked payload', () => {
    // Not covered by the golden comparison alone: an added key with an
    // undefined value serialises away in some shapes and not others.
    for (const movement of VALID_CAMERA_MOVES) {
        const payload = buildVideoPayload(...goldenCall(movement, 'wide'));
        assert.deepStrictEqual(Object.keys(payload.camera_control).sort(), ['intensity', 'type'],
            `${movement}: camera_control grew a key without blocking`);
        assert.ok(!('previs' in payload), `${movement}: previs key on an unblocked payload`);
    }
});

// ── The feature: a blocked shot carries its path ────────────────────────────

test('every movement carries its sampled path when the shot is blocked', () => {
    const wrong = [];
    for (const movement of VALID_CAMERA_MOVES) {
        const [card, chars, loc, style, opts] = goldenCall(movement, 'wide');
        const blocking = { ...defaultBlocking(), movement };
        const payload = buildVideoPayload(card, chars, loc, style, { ...opts, previs: blocking });
        const cc = payload.camera_control;

        if (cc.type !== CAMERA_CONTROL_MAP[movement].type) {
            wrong.push(`${movement}: type ${cc.type} != ${CAMERA_CONTROL_MAP[movement].type}`);
        }
        if (cc.intensity !== CAMERA_CONTROL_MAP[movement].intensity) {
            wrong.push(`${movement}: previs changed the intensity`);
        }
        if (!Array.isArray(cc.path) || cc.path.length < 2) wrong.push(`${movement}: no sampled path`);
        if (!cc.rig) wrong.push(`${movement}: no rig recorded`);
    }
    assert.deepStrictEqual(wrong, [], wrong.slice(0, 5).join('; '));
});

test('the path a blocked payload carries is the one the blocking stored', () => {
    // Not resampled at payload time: the stored path is what was seen and
    // approved, and recomputing it would silently re-tune an approved shot.
    const blocking = { ...defaultBlocking(), movement: 'orbit' };
    const stored = samplePath('orbit', blocking, { frames: 24 });
    const [card, chars, loc, style, opts] = goldenCall('orbit', 'wide');

    const payload = buildVideoPayload(card, chars, loc, style,
        { ...opts, previs: { ...blocking, path: stored } });

    assert.strictEqual(payload.camera_control.path.length, stored.length);
    assert.deepStrictEqual(
        payload.camera_control.path[0].position.map(v => +v.toFixed(4)),
        stored[0].position.map(v => +v.toFixed(4)));
});

test('blocking only ever adds to camera_control, never rewrites it', () => {
    // Still true, and still worth its own test: the movement type and intensity
    // are what the enum says a move IS, and a stage that re-tuned them would
    // make the same movement mean different things depending on whether anyone
    // had opened the 3D view.
    for (const movement of VALID_CAMERA_MOVES) {
        const [card, chars, loc, style, opts] = goldenCall(movement, 'wide');
        const plain = buildVideoPayload(card, chars, loc, style, opts);
        const blocked = buildVideoPayload(card, chars, loc, style,
            { ...opts, previs: { ...defaultBlocking(), movement } });

        for (const key of Object.keys(plain.camera_control)) {
            assert.strictEqual(blocked.camera_control[key], plain.camera_control[key],
                `${movement}: blocking changed camera_control.${key}`);
        }
    }
});

/*
 * This test used to also assert that everything OUTSIDE camera_control was
 * byte-identical when a shot was blocked. That was phase 3 being deliberately
 * conservative: blocking had just been allowed to reach the clip at all, and
 * confining it to one field was how that landed safely.
 *
 * It is no longer the behaviour we want, and the reason is the parity contract:
 * a decision the director makes in previs has to reach BOTH payloads or the two
 * surfaces disagree about the same shot. The image prompt has described staged
 * framing since previs/storyboard closed the loop -- staged beats written,
 * because the card is what was typed and the blocking is what was stood up and
 * looked at. A clip built from the same blocking describing it differently is
 * the divergence this whole exercise exists to remove.
 *
 * What is NOT relaxed: the unblocked golden fixture above. A shot nobody has
 * staged still produces byte-identical output to before phase 3 existed, and
 * that guarantee is the one that must never move -- it is what makes this a
 * feature for people who use previs rather than a change to everyone's films.
 */
test('a blocked shot describes its staged framing, and changes nothing else', () => {
    const wrong = [];
    for (const movement of VALID_CAMERA_MOVES) {
        const [card, chars, loc, style, opts] = goldenCall(movement, 'wide');
        const plain = buildVideoPayload(card, chars, loc, style, opts);
        const blocked = buildVideoPayload(card, chars, loc, style,
            { ...opts, previs: { ...defaultBlocking(), movement } });

        // Everything that is not the prompt and not camera_control is untouched.
        const stripPrompt = o => { const { prompt, camera_control, ...rest } = o; return rest; };
        try {
            assert.deepStrictEqual(stripPrompt(blocked), stripPrompt(plain));
        } catch (_) {
            wrong.push(`${movement}: blocking changed a payload field other than the prompt`);
        }

        // The prompt carries what was staged. Checked by CONTENT rather than by
        // difference: a prompt that merely differs could differ by having lost
        // something, which is the failure mode that matters here.
        if (blocked.prompt === plain.prompt) {
            wrong.push(`${movement}: the staged framing never reached the clip prompt`);
            continue;
        }
        const solved = /camera [\d.]+m from subject/.test(blocked.prompt);
        const lens = /\d+mm lens/.test(blocked.prompt);
        if (!solved) wrong.push(`${movement}: no solved camera distance in the clip prompt`);
        if (!lens) wrong.push(`${movement}: no focal length in the clip prompt`);
    }
    assert.deepStrictEqual(wrong, [], wrong.slice(0, 5).join('; '));
});

// ── Through the one payload path ────────────────────────────────────────────

function makeBlockedShot(movement) {
    const projectId = generateId();
    const sceneId = generateId();
    const shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Phase 3');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)').run(sceneId, projectId, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, 'SH01', JSON.stringify({
            shot_code: 'SH01', action: 'x', duration_ms: 4000,
            camera: { shot_type: 'wide', movement, lens: '50mm' },
        }));
    return { projectId, sceneId, shotId };
}

function callRoute(method, urlPath, body) {
    return new Promise(resolve => {
        const parts = urlPath.split('/').filter(Boolean);
        const res = {
            statusCode: 200,
            writeHead(c) { this.statusCode = c; return this; },
            end(p) { let b = p; try { b = JSON.parse(p); } catch (_) {} resolve({ status: this.statusCode, body: b }); },
        };
        Promise.resolve(handlePrevis({ method, body: body || {} }, res, parts, {}))
            .catch(e => resolve({ status: 500, body: { error: e.message } }));
    });
}

test('loadShotContext carries blocking so every caller sees it', async () => {
    // The Phase 0 discipline: one payload path. If blocking only reached the
    // per-domain route, the orchestrator would generate a different shot.
    const { shotId } = makeBlockedShot('dolly-in');
    const before = loadShotContext(shotId);
    assert.strictEqual(before.previs, null, 'unblocked context should say so plainly');

    db.prepare(`INSERT INTO film_previs_blocking (id, shot_id, camera_json, subject_json, stage_json, rig, movement, path_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(generateId(), shotId, JSON.stringify(defaultBlocking().camera),
            JSON.stringify(defaultBlocking().subject), JSON.stringify(defaultBlocking().stage),
            'dolly', 'dolly-in', JSON.stringify(samplePath('dolly-in', defaultBlocking(), { frames: 8 })));

    // Durable callers see APPLIED blocking only, so committing it is part of
    // stating this guarantee rather than a weakening of it: what a director
    // staged and applied must reach every caller, exactly as before.
    await callRoute('POST', `/film/shots/${shotId}/previs/apply`);

    const after = loadShotContext(shotId);
    assert.ok(after.previs, 'blocking did not reach the shot context');
    assert.strictEqual(after.previs.movement, 'dolly-in');
    assert.strictEqual(after.previs.path.length, 8);
});

test('the shared video builder emits the path for a blocked shot', async () => {
    const { shotId } = makeBlockedShot('crane-up');
    db.prepare(`INSERT INTO film_previs_blocking (id, shot_id, camera_json, subject_json, stage_json, rig, movement, path_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(generateId(), shotId, JSON.stringify(defaultBlocking().camera),
            JSON.stringify(defaultBlocking().subject), JSON.stringify(defaultBlocking().stage),
            'crane', 'crane-up', JSON.stringify(samplePath('crane-up', defaultBlocking(), { frames: 12 })));

    await callRoute('POST', `/film/shots/${shotId}/previs/apply`);

    const ctx = loadShotContext(shotId);
    const payload = CAPABILITY_BUILDERS.video(ctx);
    assert.strictEqual(payload.camera_control.type, CAMERA_CONTROL_MAP['crane-up'].type);
    assert.strictEqual(payload.camera_control.path.length, 12);
    assert.strictEqual(payload.camera_control.rig, 'crane');
});

test('the shared video builder is untouched for an unblocked shot', () => {
    const { shotId } = makeBlockedShot('pan-left');
    const payload = CAPABILITY_BUILDERS.video(loadShotContext(shotId));
    assert.deepStrictEqual(Object.keys(payload.camera_control).sort(), ['intensity', 'type']);
});

// ── The route ───────────────────────────────────────────────────────────────

test('to-video returns the payload the generator would receive', async () => {
    const { shotId } = makeBlockedShot('tracking-left');
    await callRoute('PUT', `/film/shots/${shotId}/previs`,
        { ...defaultBlocking(), rig: 'dolly', movement: 'tracking-left' });

    const res = await callRoute('POST', `/film/shots/${shotId}/previs/to-video`, {});
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.camera_control.type, 'tracking-left');
    assert.ok(res.body.camera_control.path.length >= 2);
    assert.ok(typeof res.body.prompt === 'string' && res.body.prompt.length > 0,
        'the preview should show the whole payload, not just the camera');
});

test('to-video on an unblocked shot says so rather than inventing a path', async () => {
    const { shotId } = makeBlockedShot('static');
    const res = await callRoute('POST', `/film/shots/${shotId}/previs/to-video`, {});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.blocked, false);
    assert.ok(!res.body.camera_control.path, 'an unblocked shot must not carry a path');
});

test('every movement survives the whole route round trip', async () => {
    const failures = [];
    for (const movement of VALID_CAMERA_MOVES) {
        const { shotId } = makeBlockedShot(movement);
        const rig = MOVEMENTS[movement].rigs[0];
        const saved = await callRoute('PUT', `/film/shots/${shotId}/previs`,
            { ...defaultBlocking(), rig, movement });
        if (saved.status !== 200) { failures.push(`${movement}: save ${saved.status}`); continue; }

        const res = await callRoute('POST', `/film/shots/${shotId}/previs/to-video`, {});
        if (res.status !== 200) { failures.push(`${movement}: to-video ${res.status}`); continue; }
        if (res.body.camera_control.type !== CAMERA_CONTROL_MAP[movement].type) {
            failures.push(`${movement}: type ${res.body.camera_control.type}`);
        }
        if (!res.body.blocked) failures.push(`${movement}: not reported as blocked`);
    }
    assert.deepStrictEqual(failures, [], failures.slice(0, 5).join('; '));
});

test('the plan records phase 3 as built', () => {
    const t = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'docs', 'plans', 'previs-camera-taxonomy.json'), 'utf8'));
    const unbuilt = t.plan.modules.filter(m => m.phase === 3 && m.status === 'new');
    assert.deepStrictEqual(unbuilt.map(m => m.path), []);
});
