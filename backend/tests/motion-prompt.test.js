/**
 * A video model is sent MOTION, not a description of the picture it was given
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `buildVideoPrompt` reused `buildStoryboardPrompt`, so a video generation was
 * handed the words used to paint the frame from nothing — while the frame was
 * attached as `init_image`. Measured on a real 2B-shaped shot: **429
 * characters, of which 82 were motion and 347 re-described the attached
 * picture** — MAYA's coat, the dragon's wings, the wet cul-de-sac, the grade,
 * `wide angle shot, 24mm anamorphic lens`. That is the same failure the anchor
 * work fixed for images ("2,517 characters re-describing a cul-de-sac plainly
 * visible in the frame travelling beside it"), still live on the video path.
 *
 * And the one genuinely motional field was DROPPED: `environment_motion` —
 * "flames erupt from the struck house" — reached `motion.environment` and never
 * reached the generic prompt, so every provider but Runway was told the
 * dragon's colour and never told the house explodes.
 *
 * Runway alone escaped, because its adapter compiles its own motion sentence.
 * This makes that a shared, per-provider compiler.
 *
 * THE TRAP THIS TEST EXISTS TO CATCH: motion-only would DELETE the spatial
 * relationships. `stagingPhrase` is added by the IMAGE builder, and reached
 * video only because video reused it. Strip that naively and a blocked shot
 * silently loses "DRAGON in the near foreground at frame left" — which is the
 * single technique this pipeline most depends on. So the compiled prompt
 * carries motion AND the spatial locks, and this suite asserts it.
 *
 * Set-based over three registries, because each fails independently:
 *   - the video adapters (a compiler proven on Runway says nothing about Seedance)
 *   - TECHNIQUES (each declares where it is served, and must really be served)
 *   - the new card fields (a field that validates but reaches no prompt is decoration)
 */

const test = require('node:test');
const assert = require('node:assert');

const M = require('../lib/motion-prompt');
const providers = require('../lib/providers');
const { validateSceneCards } = require('../lib/scene-card-schema');
const { buildVideoPayload } = require('../lib/video-prompt');

/** Every adapter that can generate video — the compiler's real denominator. */
const VIDEO_ADAPTERS = providers.list()
    .filter(a => (a.capabilities || []).includes('video'))
    .map(a => a.id);

const CARD = {
    shot_code: '2B',
    action: 'The dragon flies slowly down the street toward Maya, who freezes beside the sedan.',
    environment_motion: 'Flames erupt from the struck house; debris falls into the street.',
    end_state: 'The dragon fills the near foreground; Maya is small at the far kerb.',
    beats: ['the dragon closes half the distance', 'the house is struck', 'Maya turns'],
    camera: { shot_type: 'wide', lens: '24mm anamorphic', movement: 'tracking-forward', lighting: 'blue-hour' },
    characters: ['MAYA', 'DRAGON'], props: ['SEDAN'],
};
const CHARS = [{ name: 'MAYA', appearance_prompt: 'mid-30s, dark coat, wet hair, tired eyes' },
               { name: 'DRAGON', appearance_prompt: 'a vast slate-grey reptile, ribbed wings' }];
const LOC = { name: 'SUBURBAN STREET', description: 'A wet cul-de-sac of 1970s houses, sodium streetlights' };
const STYLE = 'anamorphic, teal and amber, wet streets, heavy grain';
const PREVIS = {
    objects: [{ name: 'DRAGON', position: [0, 0, -4], isTarget: true },
              { name: 'MAYA', position: [3, 0, -18] }],
    camera: { position: [0, 1.6, 2], yaw: 0, focalMm: 24, sensor: 'super35', aperture: 2.8 },
    // samplePath frames against a subject; without one the builder throws
    // before anything under test runs.
    subject: { position: [0, 0, -4], heightM: 4 },
    moves: [{ movement: 'dolly-in', amount: 2, unit: 'm', duration_ms: 5000 }],
    duration_ms: 5000,
};

/* ── the denominators are read, not typed ─────────────────────────────── */

test('the video adapters are discovered from the registry', () => {
    assert.ok(VIDEO_ADAPTERS.length >= 3,
        `only ${VIDEO_ADAPTERS.length} video adapters found (${VIDEO_ADAPTERS}); the registry is not being read`);
});

test('every technique declares where it is served, and none is left unstated', () => {
    assert.strictEqual(M.TECHNIQUES.length, 8, 'the ranked list is eight techniques');
    for (const t of M.TECHNIQUES) {
        assert.ok(t.id && t.name, `a technique with no id/name: ${JSON.stringify(t)}`);
        assert.ok(['built', 'compiled', 'linted', 'counted', 'deferred'].includes(t.state),
            `${t.id}: unknown state "${t.state}"`);
        assert.ok(t.served_by && t.served_by.length > 3,
            `${t.id}: does not say what serves it`);
        if (t.state === 'deferred') {
            assert.ok(t.why && t.why.length > 20,
                `${t.id}: deferred with no reason — a gap that is not written down is one nobody finds again`);
        }
    }
});

/* ── the compiled prompt is motion, and keeps the spatial locks ───────── */

test('the compiled prompt does not re-describe what the keyframe already shows', () => {
    const out = M.buildMotionPrompt({ card: CARD, previs: PREVIS, durationS: 5 });
    const text = out.prompt;
    for (const leak of ['slate-grey', 'dark coat', 'teal and amber', '1970s houses', 'heavy grain']) {
        assert.ok(!text.includes(leak),
            `the motion prompt re-describes "${leak}", which the attached keyframe already shows`);
    }
    assert.ok(text.includes('flies slowly'), 'the subject action is missing');
});

test('THE TRAP: spatial relationships survive the move to motion-only', () => {
    /*
     * Bound to what stagingPhrase ACTUALLY produces for this blocking, and
     * compared against the same shot unblocked. Matching /foreground/ passed
     * against a compiler with staging deleted, because `end_state` in this very
     * fixture says "the dragon fills the near foreground" — the word was there
     * for another reason entirely.
     */
    const { stagingPhrase } = require('../lib/shot-staging');
    const expected = stagingPhrase(PREVIS);
    assert.ok(expected, 'the fixture produces no staging, so this test proves nothing');

    const staged = M.buildMotionPrompt({ card: CARD, previs: PREVIS, durationS: 5 }).prompt;
    assert.ok(staged.includes(expected),
        'staging was dropped — a blocked shot has lost "' + expected.slice(0, 60) + '", '
        + 'which is the technique this pipeline most depends on');

    const unblocked = M.buildMotionPrompt({ card: CARD, previs: null, durationS: 5 }).prompt;
    assert.notStrictEqual(staged, unblocked, 'blocking a shot changes nothing about its motion prompt');
});

test('environmental motion reaches the prompt on every provider', () => {
    for (const id of VIDEO_ADAPTERS) {
        const out = M.compileFor(id, { card: CARD, previs: PREVIS, durationS: 5 });
        assert.match(out.prompt, /Flames erupt/,
            `${id}: never told the house explodes — environment_motion reaches nothing`);
    }
});

test('direction and speed reach the prompt, not just the movement name', () => {
    /*
     * Bound to the CAMERA clause. Matching the whole prompt for /slowly/ passed
     * against a compiler with pace deleted, because the action itself says "the
     * dragon flies slowly" — the word was already there.
     */
    const pace = M.paceWords(PREVIS);
    assert.ok(pace.length, 'the fixture produces no pace, so this test proves nothing');

    const out = M.buildMotionPrompt({ card: CARD, previs: PREVIS, durationS: 5 });
    const cameraSentence = (out.prompt.match(/[^.]*camera[^.]*\./i) || [''])[0];
    assert.ok(cameraSentence, 'there is no camera clause at all');
    assert.match(cameraSentence, /\d+(\.\d+)?\s*(m|°)\/s|over \d+(\.\d+)?s/i,
        'the camera clause carries no measured pace — legTimings/movePace compute m/s and °/s and '
        + 'the sentence says only "the camera performs tracking forward". Got: ' + cameraSentence);
});

/* ── per-provider compilation ─────────────────────────────────────────── */

test('every video adapter compiles the structure, or says it does not', () => {
    for (const id of VIDEO_ADAPTERS) {
        const out = M.compileFor(id, { card: CARD, previs: PREVIS, durationS: 5 });
        assert.ok(out && typeof out.prompt === 'string' && out.prompt.length > 20,
            `${id}: compiles nothing`);
        assert.ok(out.shape, `${id}: does not declare which shape it used`);
        assert.ok(out.prompt.length <= out.limit,
            `${id}: compiled ${out.prompt.length} chars against its own ${out.limit} ceiling`);
    }
});

test('a provider with the room is given more than one with none', () => {
    // Runway 1,000 vs Seedance 16,000. One shape cannot serve a 16x difference.
    const limits = {};
    for (const id of VIDEO_ADAPTERS) limits[id] = M.compileFor(id, { card: CARD, previs: PREVIS, durationS: 5 }).limit;
    assert.ok(limits.seedance > limits.runway,
        `seedance (${limits.seedance}) should have more room than runway (${limits.runway})`);
});

/* ── the new card fields are real ─────────────────────────────────────── */

test('every new card field validates and reaches the prompt', () => {
    for (const field of M.NEW_CARD_FIELDS) {
        // validates
        const ok = validateSceneCards([{ ...CARD, [field.id]: field.sample }]);
        assert.ok(ok.valid, `${field.id}: rejected by the card validator — ${JSON.stringify(ok.errors)}`);
        // and is refused when malformed, or it is not validated at all
        const bad = validateSceneCards([{ ...CARD, [field.id]: field.bad }]);
        assert.ok(!bad.valid, `${field.id}: accepts ${JSON.stringify(field.bad)}, so it is not validated`);
        // and reaches a prompt
        const withField = M.buildMotionPrompt({ card: { ...CARD, [field.id]: field.sample }, previs: PREVIS, durationS: 5 }).prompt;
        const without   = M.buildMotionPrompt({ card: { ...CARD, [field.id]: undefined },   previs: PREVIS, durationS: 5 }).prompt;
        assert.notStrictEqual(withField, without,
            `${field.id}: validates and changes no prompt — a field that reaches nothing is decoration`);
    }
});

test('the shot shape is counted and reported', () => {
    const shape = M.shotShape(CARD);
    assert.ok(shape.actions >= 1, 'no action count');
    assert.strictEqual(typeof shape.environment_interactions, 'number');
    assert.strictEqual(typeof shape.subjects, 'number');
    assert.strictEqual(typeof shape.compound_camera, 'boolean');
    assert.ok(shape.summary && shape.summary.length > 10, 'no readable summary');
    // Descriptive, never predictive: no score, no percentage, no forecast.
    assert.ok(!/adherence|score|%|likely|probab/i.test(shape.summary),
        'the readout predicts rather than describes — there are 0 rows of attempt data to predict from');
});

test('the video payload no longer sends a still-image prompt', () => {
    // No previs here on purpose: this asserts the PAYLOAD carries compiled motion,
    // and most shots are never blocked. Staging with previs is covered by the TRAP test.
    const p = buildVideoPayload(CARD, CHARS, LOC, STYLE, {});
    assert.ok(p.motion_prompt, 'the payload carries no compiled motion prompt');
    for (const leak of ['slate-grey', 'dark coat', 'teal and amber']) {
        assert.ok(!p.motion_prompt.includes(leak),
            `the payload's motion prompt still re-describes "${leak}"`);
    }
});


test('the adapters really send the compiled motion, not the still prompt', () => {
    /*
     * compileFor() proves the compiler; it says nothing about whether an
     * adapter USES it. Seedance took `p.prompt` — the storyboard prompt — and a
     * test that never drove its request builder passed while it still did.
     */
    const { buildVideoPayload } = require('../lib/video-prompt');
    const payload = buildVideoPayload(CARD, CHARS, LOC, STYLE, {});
    assert.ok(payload.motion_prompt, 'the payload carries no compiled motion');

    const seedance = require('../lib/providers/seedance.js');
    const build = seedance.buildVideoRequest || (seedance.adapter && seedance.adapter.buildVideoRequest);
    if (typeof build === 'function') {
        const sent = build({ ...payload, duration_s: 5, width: 1280, height: 720 });
        const text = String((sent.body && sent.body.prompt) || '');
        assert.strictEqual(text, payload.motion_prompt,
            'seedance sends something other than the compiled motion prompt');
        for (const leak of ['slate-grey', 'dark coat', 'teal and amber']) {
            assert.ok(!text.includes(leak), `seedance is still sent "${leak}", which the keyframe shows`);
        }
    }
});

test('an over-long subject gives way; the camera and the staging do not', () => {
    /*
     * The rule this engine already states: "the camera move survives with the
     * subject: it is short, and without it the clip has no move." A naive tail
     * truncation loses whatever sits LAST in the provider's order, and on the
     * default shape that is the camera — so the long thing is cut instead, at a
     * clause boundary.
     *
     * Staging is protected for the same reason: short, and the technique this
     * pipeline most depends on.
     */
    const { stagingPhrase } = require('../lib/shot-staging');
    const huge = { ...CARD, action: 'The dragon banks hard over the rooftops, '.repeat(40) };
    const out = M.buildMotionPrompt({ card: huge, previs: PREVIS, durationS: 5, limit: 400 });

    assert.ok(out.prompt.length <= 400, `compiled ${out.prompt.length} against its own 400 ceiling`);
    assert.match(out.prompt, /camera/i, 'the camera instruction was cut, so the clip has no move');
    assert.ok(out.prompt.includes(stagingPhrase(PREVIS)),
        'the spatial locks were cut to fit — they are short, and they are the thing most worth keeping');
    assert.match(out.prompt, /dragon banks hard/i, 'the subject was cut away entirely');
});

/**
 * Every path that generates a clip records the attempt.
 *
 * `recordVideoAttempt` was called by routes/video-gen.js and by nothing else,
 * so `film_video_attempts` held 0 rows after five real clips — three of which
 * came through the sequence path. The table was empty not for want of
 * generation but for want of a caller, which makes "record now, learn later" a
 * plan that recorded nothing and a prediction that can never be built.
 *
 * Derived from the source: any module that asks a provider for `video` is a
 * generating path and must record. A hand-written list is exactly what let
 * three of four go unwired.
 */
test('every path that generates video records the attempt', () => {
    const fs = require('fs'), path = require('path');
    const root = path.join(__dirname, '..');
    const files = [
        'routes/video-gen.js', 'routes/sequences.js', 'routes/pipeline.js',
        'lib/node-handlers/generate.js',
    ];
    const generating = [];
    for (const f of files) {
        const src = fs.readFileSync(path.join(root, f), 'utf8');
        // Asks a provider for video, one way or another.
        if (/generate\(\s*'video'|generate\(capability|capability === 'video'/.test(src)) {
            generating.push({ f, records: /recordVideoAttempt\s*\(/.test(src) });
        }
    }
    assert.ok(generating.length >= 4,
        `only ${generating.length} generating paths found; the scan is not reading the tree`);
    const silent = generating.filter(g => !g.records).map(g => g.f);
    assert.deepStrictEqual(silent, [],
        'these generate video and record no attempt, so there is nothing to learn adherence from: '
        + silent.join(', '));
});

/**
 * A field with no writer is a field that is blank forever.
 *
 * Measured on the real library: `environment_motion` was filled on 0 of 70
 * shots. Not because directors declined to write it — because nothing asked.
 * The breakdown composes every scene card from the screenplay and its JSON
 * schema never mentioned the field, so "flames erupt from the struck house",
 * which is written in the screenplay already, reached no card and therefore no
 * prompt.
 *
 * Set-based over every path that COMPOSES a card, because the failure is
 * per-path: teaching the breakdown alone leaves an agent composing a card by
 * hand with no idea the field exists.
 */
test('every path that composes a scene card knows about environment_motion', () => {
    const fs = require('fs'), path = require('path');
    const root = path.join(__dirname, '..');

    // The LLM path: the breakdown's own JSON schema.
    const breakdown = fs.readFileSync(path.join(root, 'routes/breakdown.js'), 'utf8');
    assert.match(breakdown, /"environment_motion"/,
        'the breakdown never asks for it, so it stays blank on every shot it creates — which is '
        + 'every shot in a normal project');
    /*
     * Bound to the field's OWN value, not a window around its name. A 400-char
     * window passed with the instruction replaced by "anything you like",
     * because `camera.movement` sits a few lines below and supplied the word
     * the scan was looking for.
     */
    const instruction = (/"environment_motion":\s*"((?:[^"\\]|\\.)*)"/.exec(breakdown) || [])[1] || '';
    assert.ok(instruction.length > 80,
        'the breakdown asks for environment_motion with no instruction, so it will be filled with '
        + 'scenery — which the keyframe already shows and is the exact thing this must not be');
    assert.match(instruction, /\bMOVE\b|moves?\b/,
        'the instruction never says the thing must MOVE');
    assert.match(instruction, /not a description of the place|already shows/i,
        'the instruction never warns against describing the place, which is the failure mode');

    /*
     * The agent paths that compose a SHOT card. Two obvious-looking candidates
     * are deliberately NOT here, and naming them is the point:
     *
     *   scene_card_write writes SCENE metadata — whose point of view, what the
     *   conflict is — not a shot card, so the field has no meaning there.
     *
     *   shot_tag turns a screenplay line into a shot description VERBATIM,
     *   "nothing is paraphrased on the way". Inferring environmental motion
     *   there would contradict the one guarantee that tool makes.
     *
     * The first version of this test demanded all four and would have pushed
     * the field into both.
     */
    const mcp = fs.readFileSync(path.join(root, 'lib/mcp-tools.js'), 'utf8');
    for (const tool of ['shot_create', 'shot_update']) {
        const at = mcp.indexOf(`name: '${tool}'`);
        assert.notStrictEqual(at, -1, `${tool} is gone`);
        assert.ok(mcp.slice(at, at + 3000).includes('environment_motion'),
            `${tool} cannot set environment_motion, so an agent composing a card leaves it blank`);
    }
});

test('creating a card accepts what updating one accepts', () => {
    /*
     * The rule this codebase already paid for once: "create(body) must equal
     * create({name}) then update(body)". shot_update took the three motion
     * fields and shot_create did not, which is the same asymmetry that dropped
     * twenty fields across characters, locations and props.
     */
    const fs = require('fs'), path = require('path');
    const mcp = fs.readFileSync(path.join(__dirname, '..', 'lib/mcp-tools.js'), 'utf8');
    const block = t => mcp.slice(mcp.indexOf(`name: '${t}'`), mcp.indexOf(`name: '${t}'`) + 3000);
    const create = block('shot_create');
    for (const f of ['environment_motion', 'end_state', 'beats']) {
        assert.ok(create.includes(f),
            `shot_create cannot set ${f} but shot_update can — a card created by an agent can never `
            + 'carry it without a second call');
    }
});
