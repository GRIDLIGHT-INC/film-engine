/**
 * Phase 0 acceptance suite — RED until lib/capability-payloads.js exists.
 *
 * Phase 0 claims one payload-construction path shared by the per-domain routes
 * and the orchestrator. Two live defects motivate it:
 *
 *   routes/pipeline.js:122   ships { shot_id, scene_id, project_id, step } to
 *                            every generator, so orchestrated runs generate
 *                            from an empty prompt with no consistency context.
 *   routes/storyboard.js:97  calls fetch(GRIDLIGHT_URL + '/image') directly, so
 *                            provider_config.image is ignored on the most
 *                            visible path in the product.
 *
 * The suite is SET-BASED over the orchestrator's own dispatch table. An
 * example-based version ("check the image payload has a prompt") would pass
 * with seven of eight capabilities still broken, which is the precise failure
 * this guards against — the defect being fixed IS a per-capability hole.
 *
 * Every case here is specified in docs/plans/phase0-acceptance-criteria.md and
 * indexed in docs/plans/phase0-test-matrix.json; ids below match that matrix.
 *
 * Fixtures are plain objects, never a temp database. That is a deliberate
 * constraint on the implementation, not a convenience: buildCapabilityPayload
 * must take a context argument rather than a shot id, so it can be exercised
 * without a DB. (loadShotContext does the reading, separately.) If this file
 * cannot be written without a database, the interface is wrong.
 */

const test = require('node:test');
/*
 * The local gateway is OFF unless switched on, so a suite that stands up a mock
 * Gridlight and generates against it has to enable it — exactly as an operator
 * running the real service does. Set before anything requires the provider
 * registry, which caches the answer.
 */
process.env.GRIDLIGHT_ENABLED = '1';
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PIPELINE_SRC = path.join(__dirname, '..', 'routes', 'pipeline.js');
const STORYBOARD_SRC = path.join(__dirname, '..', 'routes', 'storyboard.js');

// The module under test does not exist yet — that is the point of the RED phase.
let payloads = null;
let loadError = null;
try {
    payloads = require('../lib/capability-payloads');
} catch (err) {
    loadError = err;
}

function mod() {
    if (!payloads) {
        assert.fail(`lib/capability-payloads.js is not implemented yet: ${loadError && loadError.message}`);
    }
    return payloads;
}

/** Recover the orchestrator's dispatch table from source — the set under test. */
function stepCapabilityFromSource() {
    const src = fs.readFileSync(PIPELINE_SRC, 'utf8');
    const block = src.match(/const STEP_CAPABILITY\s*=\s*\{([\s\S]*?)\};/);
    assert.ok(block, 'could not locate STEP_CAPABILITY in routes/pipeline.js');
    const map = {};
    for (const m of block[1].matchAll(/(\w+)\s*:\s*'([a-z0-9]+)'/g)) map[m[1]] = m[2];
    return map;
}

const STEP_CAPABILITY = stepCapabilityFromSource();
const ORCHESTRATED = [...new Set(Object.values(STEP_CAPABILITY))];

// The four keys the broken orchestrator sends today. A payload equal to this
// set is the defect itself, so no capability may ever produce it.
const STUB_KEYS = ['project_id', 'scene_id', 'shot_id', 'step'];

// Required payload keys per capability, read off the builders and the routes
// that consume them (film_video_jobs / film_music_jobs INSERTs pin most).
/*
 * `emotion` was required here and was sent to no provider.
 *
 * ElevenLabs has no emotion field, so buildVoicePayload set it for four phases
 * and the adapter dropped it one function short of the request. This test
 * required its PRESENCE, which is how a dead field survives a parity suite: the
 * payload carried it, so the check passed, and nothing asked whether anything
 * read it. Direction now travels as an audio tag, a style value and a
 * stability value — things the provider actually reads — and the required set
 * says so.
 */
const REQUIRED_KEYS = {
    image:   ['prompt', 'negative_prompt'],
    /*
     * Video carries NO model, deliberately, unlike the audio capabilities below.
     *
     * Those name a real model on the provider that serves them. This builder is
     * shared by every video provider, so any name it emits is wrong for all but
     * one: it said `animatediff-sdxl`, which is Gridlight's, and every Runway
     * preview reported a substitution for a request nobody had made. A warning
     * that fires every time is one people learn to scroll past.
     */
    video:   ['prompt', 'negative_prompt', 'width', 'height', 'num_frames', 'fps', 'camera_control'],
    voice:   ['text', 'model', 'language', 'output_format', 'sample_rate'],
    lipsync: ['video_url', 'audio_url', 'model', 'quality', 'output_format'],
    music:   ['prompt', 'model', 'duration_s'],
    sfx:     ['type', 'prompt', 'duration_s', 'model', 'category'],
    ambient: ['type', 'prompt', 'duration_s', 'bed_duration_s', 'loopable', 'crossfade_s'],
    post:    ['input_url', 'output_format'],
};

const MANY = new Set(['voice', 'sfx']);              // one input, N payloads out
const SCENE_SCOPED = new Set(['music', 'ambient']);   // need no shot

// ── Fixture ─────────────────────────────────────────────────────────────
// One shot with dialogue, an sfx cue, a keyframe, a rendered video and a
// dialogue track — enough that every capability's preconditions are met.

function fixtureCtx(overrides) {
    const project = {
        id: 'proj-1', name: 'Test Feature', style_preset: 'cinematic',
        provider_config: '{}', fps: 24, resolution: '1920x1080',
    };
    const scene = {
        id: 'scene-1', project_id: 'proj-1', scene_number: 1,
        heading: 'INT. WAREHOUSE - NIGHT', int_ext: 'INT', location_name: 'WAREHOUSE',
        time_of_day: 'NIGHT', location_id: 'loc-1', estimated_duration: 45000, mood: 'tense',
    };
    const shot = {
        id: 'shot-1', scene_id: 'scene-1', shot_code: '1A', shot_number: 1,
        duration_s: 4, scene_card_yaml: JSON.stringify({
            shot_type: 'medium', camera_movement: 'slow push in',
            lighting: 'low key, single practical', characters: ['RAY'],
            action: 'Ray steps out of the dark.',
            dialogue: [{ character: 'RAY', line: 'You should not have come here.', emotion: 'cold' }],
            sfx_cues: [{ description: 'distant train horn', duration_s: 2.5, category: 'ambience' }],
        }),
    };
    const base = {
        project, scene, shot,
        sceneCard: JSON.parse(shot.scene_card_yaml),
        characters: [{ id: 'char-1', project_id: 'proj-1', name: 'RAY', appearance_prompt: 'weathered man, grey coat', lora_id: 'ray-lora' }],
        location: { id: 'loc-1', project_id: 'proj-1', name: 'WAREHOUSE', lighting_defaults: 'sodium vapour spill' },
        voiceProfiles: [{ id: 'vp-1', character_id: 'char-1', voice_id: 'ray-voice', tts_model: 'qwen3-tts', language: 'en', speed: 1.0, voice_params: '{}' }],
        videoAsset: { id: 'asset-v', file_name: '1A.mp4', file_path: '/data/video/proj-1/1A.mp4' },
        audioAsset: { id: 'asset-a', file_name: '1A_RAY_0.wav', file_path: '/data/audio/proj-1/1A_RAY_0.wav' },
        keyframeAsset: { id: 'asset-k', file_name: '1A.png', file_path: '/data/storyboards/proj-1/1A.png' },
        musicCue: { id: 'cue-1', scene_id: 'scene-1', mood: 'tense', genre: 'score', description: 'low strings' },
        initImage: null,
        overrides: {},
    };
    return Object.assign(base, overrides || {});
}

const asArray = p => (Array.isArray(p) ? p : [p]);

// ── AC1 — every orchestrated capability has a registered builder ────────

test('AC1: CAPABILITY_BUILDERS covers every capability the orchestrator dispatches', () => {
    const { CAPABILITY_BUILDERS } = mod();
    const missing = ORCHESTRATED.filter(c => typeof CAPABILITY_BUILDERS[c] !== 'function');
    assert.deepStrictEqual(missing, [], `capabilities with no registered builder: ${missing.join(', ')}`);
});

test('AC1: buildCapabilityPayload rejects a capability it cannot build', () => {
    const { buildCapabilityPayload } = mod();
    assert.throws(
        () => buildCapabilityPayload('not-a-capability', fixtureCtx()),
        /capability/i,
        'an unknown capability must throw, not return an empty payload'
    );
});

// ── AC2 — payloads carry real content, never the four-key stub ──────────

for (const capability of ORCHESTRATED) {
    test(`AC2: ${capability} payload is never the four-key stub`, () => {
        const { buildCapabilityPayload } = mod();
        const { payload } = buildCapabilityPayload(capability, fixtureCtx());
        for (const p of asArray(payload)) {
            const keys = Object.keys(p).sort();
            assert.notDeepStrictEqual(keys, STUB_KEYS,
                `${capability} produced the stub payload the orchestrator ships today`);
        }
    });

    test(`AC2: ${capability} payload carries every required key`, () => {
        const { buildCapabilityPayload } = mod();
        const { payload } = buildCapabilityPayload(capability, fixtureCtx());
        const items = asArray(payload);
        assert.ok(items.length > 0, `${capability} produced no payload from a fully-populated fixture`);
        for (const p of items) {
            const missing = REQUIRED_KEYS[capability].filter(k => p[k] === undefined || p[k] === null || p[k] === '');
            assert.deepStrictEqual(missing, [], `${capability} payload missing: ${missing.join(', ')}`);
        }
    });
}

// ── AC3 — the orchestrator and the route agree, byte for byte ───────────

for (const capability of ORCHESTRATED) {
    test(`AC3: ${capability} payload is identical whichever caller builds it`, () => {
        const { buildCapabilityPayload } = mod();
        const viaOrchestrator = buildCapabilityPayload(capability, fixtureCtx());
        const viaRoute = buildCapabilityPayload(capability, fixtureCtx());
        assert.deepStrictEqual(viaOrchestrator.payload, viaRoute.payload,
            `${capability} payload is not deterministic for identical context`);
    });
}

test('AC3: image payload equals what buildStoryboardPrompt produces for the same context', () => {
    const { buildCapabilityPayload } = mod();
    const { buildStoryboardPrompt } = require('../lib/storyboard-prompt');
    const ctx = fixtureCtx();
    const expected = buildStoryboardPrompt(ctx.sceneCard, ctx.characters, ctx.location, ctx.project.style_preset);
    const { payload } = buildCapabilityPayload('image', ctx);
    assert.strictEqual(payload.prompt, expected.prompt, 'image prompt drifted from buildStoryboardPrompt');
    assert.strictEqual(payload.negative_prompt, expected.negative_prompt, 'image negative_prompt drifted');
});

test('AC3: video payload equals what buildVideoPayload produces for the same context', () => {
    const { buildCapabilityPayload } = mod();
    const { buildVideoPayload } = require('../lib/video-prompt');
    const ctx = fixtureCtx();
    const expected = buildVideoPayload(ctx.sceneCard, ctx.characters, ctx.location, ctx.project.style_preset, {});
    const { payload } = buildCapabilityPayload('video', ctx);
    assert.strictEqual(payload.prompt, expected.prompt, 'video prompt drifted from buildVideoPayload');
    assert.strictEqual(payload.camera_control.type, expected.camera_control.type, 'camera_control drifted');
});

test('AC3: ambient payload keeps the loop/bed split intact', () => {
    const { buildCapabilityPayload } = mod();
    const { payload } = buildCapabilityPayload('ambient', fixtureCtx());
    assert.ok(payload.duration_s <= 30, 'ambient duration_s must stay a loop, not a full render');
    assert.strictEqual(payload.bed_duration_s, 45, 'bed_duration_s must reflect scene.estimated_duration (45000ms)');
    assert.strictEqual(payload.loopable, true, 'ambient must remain loopable or the mixer cannot tile it');
});

// ── AC4 — consistency context reaches every capability that supports it ─

// Visual capabilities take identity as references + a locked seed.
for (const capability of ['image', 'video']) {
    test(`AC4: ${capability} payload carries the consistency references it is given`, () => {
        const { buildCapabilityPayload } = mod();
        const ctx = fixtureCtx({
            consistency: {
                locked_seed: 424242,
                prompt_additions: ['consistent facial structure'],
                negative_additions: ['face drift'],
                references: [{ role: 'face', url: '/refs/ray_face.png', weight: 0.8 }],
                input_refs: ['ray_face'],
            },
        });
        const { payload } = buildCapabilityPayload(capability, ctx);
        const serialized = JSON.stringify(asArray(payload));
        assert.ok(
            serialized.includes('424242') || serialized.includes('ray_face') || serialized.includes('consistent facial structure'),
            `${capability} dropped the consistency context entirely — this is the orchestrator bug in miniature`
        );
    });
}

// Voice identity is NOT a seed or an image reference — it is a voice id and its
// settings, keyed by character (applyConsistencyToVoicePayload reads
// context.voice.by_character). Asserting the visual shape here would demand that
// a TTS request carry an image reference, so this pins the real contract and
// checks exact propagation rather than a substring appearing somewhere.
test('AC4: voice payload carries the locked voice profile for the speaking character', () => {
    const { buildCapabilityPayload } = mod();
    const ctx = fixtureCtx({
        consistency: {
            voice: {
                by_character: {
                    RAY: {
                        profile_id: 'vp-locked-1',
                        voice_id: 'ray-locked-voice',
                        provider_model: 'eleven_v3',
                        settings: { language: 'fr', speed: 0.9, stability: 0.6, similarity_boost: 0.85 },
                    },
                },
            },
        },
    });
    const { payload } = buildCapabilityPayload('voice', ctx);
    assert.strictEqual(payload[0].voice_id, 'ray-locked-voice', 'locked voice id did not reach the payload');
    assert.strictEqual(payload[0].consistency_profile_id, 'vp-locked-1', 'profile id was not recorded on the payload');
    assert.strictEqual(payload[0].language, 'fr', 'locked language was not applied');
    assert.strictEqual(payload[0].speed, 0.9, 'locked speed was not applied');
    assert.strictEqual(payload[0].similarity_boost, 0.85, 'locked similarity_boost was not applied');
});

test('AC4: voice consistency for a different character leaves this payload untouched', () => {
    const { buildCapabilityPayload } = mod();
    const ctx = fixtureCtx({
        consistency: { voice: { by_character: { NADIA: { profile_id: 'vp-2', voice_id: 'nadia-voice' } } } },
    });
    const { payload } = buildCapabilityPayload('voice', ctx);
    assert.strictEqual(payload[0].voice_id, 'ray-voice', 'RAY was given another character\'s locked voice');
    assert.strictEqual(payload[0].consistency_profile_id, undefined, 'an unrelated profile id was stamped on the payload');
});

// ── AC5 — cardinality and scope are honoured ───────────────────────────

for (const capability of ORCHESTRATED) {
    test(`AC5: ${capability} returns ${MANY.has(capability) ? 'an array' : 'a single payload'}`, () => {
        const { buildCapabilityPayload } = mod();
        const { payload } = buildCapabilityPayload(capability, fixtureCtx());
        if (MANY.has(capability)) {
            assert.ok(Array.isArray(payload), `${capability} is one-to-many and must return an array`);
        } else {
            assert.ok(!Array.isArray(payload), `${capability} is one-to-one and must not return an array`);
        }
    });
}

test('AC5: voice emits exactly one payload per dialogue line', () => {
    const { buildCapabilityPayload } = mod();
    const ctx = fixtureCtx();
    ctx.sceneCard.dialogue.push({ character: 'RAY', line: 'Turn around.', emotion: 'flat' });
    const { payload } = buildCapabilityPayload('voice', ctx);
    assert.strictEqual(payload.length, 2, 'voice must fan out per dialogue line, not per shot');
    assert.strictEqual(payload[1].text, 'Turn around.');
});

for (const capability of SCENE_SCOPED) {
    test(`AC5: ${capability} builds from scene context with no shot present`, () => {
        const { buildCapabilityPayload } = mod();
        const ctx = fixtureCtx();
        delete ctx.shot;
        delete ctx.sceneCard;
        const { payload } = buildCapabilityPayload(capability, ctx);
        assert.ok(payload && payload.prompt, `${capability} is scene-scoped and must not require a shot`);
    });
}

// ── AC6 — missing preconditions fail loudly, never silently ────────────

test('AC6: lipsync refuses to build without a video asset', () => {
    const { buildCapabilityPayload } = mod();
    const ctx = fixtureCtx({ videoAsset: null });
    assert.throws(() => buildCapabilityPayload('lipsync', ctx), /video/i,
        'lipsync without video must throw, not emit a payload with an undefined video_url');
});

test('AC6: lipsync refuses to build without a dialogue audio asset', () => {
    const { buildCapabilityPayload } = mod();
    const ctx = fixtureCtx({ audioAsset: null });
    assert.throws(() => buildCapabilityPayload('lipsync', ctx), /audio/i,
        'lipsync without audio must throw, not emit a payload with an undefined audio_url');
});

test('AC6: post refuses to build without a source video', () => {
    const { buildCapabilityPayload } = mod();
    const ctx = fixtureCtx({ videoAsset: null });
    assert.throws(() => buildCapabilityPayload('post', ctx), /video/i,
        'post without a source video must throw rather than send an undefined input_url');
});

test('AC6: voice yields no payloads when the shot has no dialogue', () => {
    const { buildCapabilityPayload } = mod();
    const ctx = fixtureCtx();
    ctx.sceneCard.dialogue = [];
    const { payload } = buildCapabilityPayload('voice', ctx);
    assert.deepStrictEqual(payload, [], 'a dialogue-free shot must yield zero voice payloads, not one empty one');
});

test('AC6: sfx yields no payloads when the scene card declares no cues', () => {
    const { buildCapabilityPayload } = mod();
    const ctx = fixtureCtx();
    delete ctx.sceneCard.sfx_cues;
    const { payload } = buildCapabilityPayload('sfx', ctx);
    assert.deepStrictEqual(payload, [], 'no cues must mean no payloads');
});

for (const capability of ORCHESTRATED) {
    test(`AC6: ${capability} throws a useful message on an empty context`, () => {
        const { buildCapabilityPayload } = mod();
        assert.throws(
            () => buildCapabilityPayload(capability, {}),
            err => err instanceof Error && err.message.length > 10,
            `${capability} must fail with a diagnosable error on empty context, not return undefined`
        );
    });
}

// ── Global cases — the two defects, pinned directly ────────────────────

test('global.stub-payload-gone: routes/pipeline.js no longer builds a payload inline', () => {
    const src = fs.readFileSync(PIPELINE_SRC, 'utf8');
    assert.ok(
        !/const payload\s*=\s*\{\s*shot_id/.test(src),
        'routes/pipeline.js still constructs the four-key stub payload inline'
    );
    assert.ok(
        /buildCapabilityPayload/.test(src),
        'routes/pipeline.js must obtain its payload from buildCapabilityPayload'
    );
});

test('global.storyboard-uses-provider-registry: routes/storyboard.js no longer calls Gridlight directly', () => {
    const src = fs.readFileSync(STORYBOARD_SRC, 'utf8');
    assert.ok(
        !/fetch\(`\$\{GRIDLIGHT_URL\}\/image`/.test(src),
        'routes/storyboard.js still hard-codes fetch(GRIDLIGHT_URL + "/image"), bypassing provider_config'
    );
    assert.ok(
        /resolve(Generator)?\(\s*'image'/.test(src),
        'routes/storyboard.js must resolve the image capability through the provider registry'
    );
});

test('global.no-inline-payloads: no generation route constructs a provider payload inline', () => {
    const ROUTES_DIR = path.join(__dirname, '..', 'routes');
    const offenders = [];
    for (const file of fs.readdirSync(ROUTES_DIR).filter(f => f.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8');
        if (!/resolveGenerator|\.generate\('/.test(src)) continue;
        // A route that still assembles a literal with prompt+model+stream is
        // building a provider payload rather than delegating to the builder.
        if (/const payload\s*=\s*\{[^}]*\bstream\s*:/s.test(src)) offenders.push(file);
    }
    assert.deepStrictEqual(offenders, [],
        `routes still building provider payloads inline: ${offenders.join(', ')}`);
});
