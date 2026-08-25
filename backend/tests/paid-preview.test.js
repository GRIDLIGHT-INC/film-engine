/**
 * NOTHING SPENDS WITHOUT SHOWING WHAT IT WILL SEND.
 *
 * "I generated the first two videos directly on runway and not through the
 * engine as credits are super precious and didn't want to waste them."
 *
 * That is the whole feature failing for a reason unrelated to generation
 * quality: a director who cannot see what the engine would send will not trust
 * it with credits, and goes elsewhere. CLAUDE.md already claims "every paid
 * path now goes through ONE confirmation" — which was true of the image paths
 * and was never true of video, audio or 3D.
 *
 * Derived from the PAGE rather than from the claim: enumerate the controls that
 * reach a paid generator and require each to reach a confirmation before its
 * network call. Six of twelve were silent when this was written.
 *
 * Follows one call level and strips comments first, both learned the hard way
 * on the upload-gate check: a gate one function away reads as absent, and a
 * comment naming confirm() reads as present.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-paid-' + crypto.randomUUID().slice(0, 8));

const ROOT = path.join(__dirname, '..');
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const UI = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Every UI control that reaches a paid generator.
 *
 * Listed here rather than derived from a registry because the page has no
 * registry of "what costs money" — which is itself why six of them were silent.
 * The set is checked against the generating ROUTES below, so a new paid route
 * with no control here fails rather than being quietly exempt.
 */
const PAID_ACTIONS = [
    'generateVideoFor', 'generateAllVideos',
    'generateModelFor', 'generateAllModels',
    'generateScoreFor', 'generateAmbientFor',
    'generateSequence', 'refineFrame',
    'generateLocationImage', 'generateCharacterImage', 'generatePropImage',
    'sweepLocationCompass',
];

function bodyOf(name) {
    const at = UI.indexOf(`function ${name}(`);
    if (at < 0) return null;
    return UI.slice(at, UI.indexOf('\n    }', at));
}

test('every control that spends money warns before it spends', () => {
    const bodies = new Map();
    for (const m of UI.matchAll(/function ([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (!bodies.has(m[1])) bodies.set(m[1], UI.slice(m.index, UI.indexOf('\n    }', m.index)));
    }

    const silent = [];
    for (const name of PAID_ACTIONS) {
        const body = bodyOf(name);
        assert.ok(body, `${name} is gone from the page`);

        /*
         * The gate has to come BEFORE the request. A confirmation after the
         * spend is a receipt, not a gate.
         */
        const send = body.search(/await api\(|_shotAction\(|streamPost\(/);
        const before = send > 0 ? body.slice(0, send) : body;

        /*
         * The guard must be INSIDE the function.
         *
         * A first attempt inserted the confirm after the opening line of two
         * ONE-LINE functions, which put it outside the body entirely: a
         * top-level `return` that breaks the whole SPA at load. Source-text
         * matching reported both as gated, because the text was adjacent. So
         * the body is bounded by brace depth from the declaration rather than
         * by a fixed slice.
         */
        const open = UI.indexOf('{', UI.indexOf(`function ${name}(`));
        let depth = 0, close = open;
        for (; close < UI.length; close += 1) {
            if (UI[close] === '{') depth += 1;
            else if (UI[close] === '}') { depth -= 1; if (!depth) break; }
        }
        const realBody = UI.slice(open, close);
        assert.ok(/confirm\(|preview/i.test(realBody),
            `${name}'s guard is not inside the function body — it will not run, and may not parse`);

        const reaches = new Set([before]);
        for (const m of before.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
            if (bodies.has(m[1])) reaches.add(bodies.get(m[1]));
        }
        const warned = [...reaches].some(src => /confirm\(|Preview|preview/.test(src));
        if (!warned) silent.push(name);
    }

    assert.deepStrictEqual(silent, [],
        `these spend credits with no warning and no preview: ${silent.join(', ')}. A director who `
        + 'cannot see what will be sent generates somewhere else instead.');
});

test('a shot can be previewed before its video is bought, without previs', () => {
    /*
     * /previs/to-video exists and is previs-scoped: it refuses on a stale
     * approval and assumes the shot has been blocked. Most shots never are. So
     * the ordinary path — look at what this clip would cost and contain — had
     * no answer at all, which is the free-preview parity the image paths have
     * had since shot_prompt.
     */
    const { handleVideoGen } = require('../routes/video-gen');

    const projectId = generateId();
    const sceneId = generateId();
    const shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, target_fps, target_resolution) VALUES (?, ?, 24, ?)')
        .run(projectId, 'Preview', '1920x1080');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, ?, ?)')
        .run(sceneId, projectId, '1', 'STREET');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, duration_ms, scene_card_yaml) VALUES (?, ?, ?, ?, ?)')
        .run(shotId, sceneId, '1A', 5000, JSON.stringify({
            shot_code: '1A', description: 'The dragon moves toward MAYA.',
            camera: { shot_type: 'wide', movement: 'dolly-in', lens: '40mm' },
        }));

    return new Promise(resolve => {
        const out = [];
        const res = {
            writeHead(s) { this.statusCode = s; return this; },
            end(p) {
                out.push(p || '');
                const body = JSON.parse(out.join('') || '{}');
                assert.strictEqual(this.statusCode || 200, 200, JSON.stringify(body));

                // What a director needs to decide: the words, the picture, the
                // cost and what is missing.
                assert.ok(body.prompt && body.prompt.length > 10,
                    'the preview does not show the prompt that will be sent');
                assert.ok(Object.prototype.hasOwnProperty.call(body, 'init_image'),
                    'the preview never says whether a keyframe is attached — the single biggest '
                    + 'difference between a clip that matches the board and one that does not');
                assert.ok(body.provider, 'the preview does not say who would generate it');
                assert.ok(Number(body.duration_s) > 0, 'the preview does not state the length');
                assert.ok(Array.isArray(body.warnings),
                    'the preview cannot tell a director what is missing');

                // It must cost nothing. A preview that generates is not a preview.
                assert.ok(!body.asset_id && !body.job_id,
                    'the preview produced an asset — it is a generation with a different name');
                resolve();
            },
        };
        handleVideoGen({ method: 'GET', url: `/film/shots/${shotId}/video/preview`, body: {} },
            res, ['film', 'shots', shotId, 'video', 'preview'], {});
    });
});

test('a location plate can be refined, not only regenerated', () => {
    /*
     * Storyboard frames have refine — keep the picture, change one thing — and
     * plates had none, so a location could only be regenerated wholesale from
     * words. Every attempt at "the same street but wetter" was a fresh roll of
     * the dice on a plate that conditions every frame the location appears in.
     *
     * And refine is precisely what an edit-mode provider is FOR. A new VIEW had
     * to drop its references because an edit cannot move the camera; a refine
     * keeps the camera and changes one thing, which is the operation
     * /image-to-image actually performs well.
     */
    const plates = require('../lib/reference-plates');
    assert.ok(typeof plates.buildPlateRefinePrompt === 'function',
        'nothing builds a plate refine, so a plate can only be rolled again');

    const subject = { id: 'l1', name: 'SUBURBAN STREET', description: 'A quiet cul-de-sac.' };
    const prompt = plates.buildPlateRefinePrompt('location', subject, 'make the road wet');

    // The instruction LEADS. Whatever leads a prompt is what the image is of,
    // and continuity language in front of the change is what returned the
    // source unchanged three times during the compass work.
    assert.ok(prompt.toLowerCase().indexOf('make the road wet') < 90,
        `the change does not lead the prompt: ${prompt.slice(0, 120)}`);

    // And it must NOT re-describe the subject. The picture is attached; saying
    // it again in words pulls the result back toward a fresh generation, which
    // is the whole difference between a refine and a regeneration.
    assert.ok(!prompt.includes(subject.description),
        'the refine re-describes the location, so it is a regeneration wearing a different name');
    assert.ok(prompt.length < 400,
        `a refine carries the picture plus one instruction; this is ${prompt.length} characters`);

    // The route has to exist too, or the builder is unreachable.
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'locations.js'), 'utf8');
    assert.ok(/'refine'/.test(src), 'no route dispatches a plate refine');
});

// ── A preview must report what the ADAPTER sends, not what it was asked ──
//
// Found live on Wingfall 2A after the preview shipped: it reported
// provider=runway, model=animatediff-sdxl. Runway has never heard of that model
// — lib/video-prompt.js hardcodes it, it is a Gridlight name — and
// pickModel() silently maps anything unknown to the default. So the dialog
// whose entire purpose is "see exactly what will be sent" named a model that
// would never be sent.
//
// A preview that is confidently wrong is worse than no preview: it is the one
// thing a director is being asked to trust before spending. Set-based over the
// video adapters, because each transforms the payload differently — model
// mapping, duration clamping, ratio snapping — and an adapter added later that
// transforms silently would restore exactly this fault.

test('every video adapter can say what it would actually send', () => {
    const providers = require('../lib/providers');
    const video = providers.list().filter(e => (e.capabilities || []).includes('video'));
    assert.ok(video.length >= 2, `the video adapter set collapsed (${video.length})`);

    for (const entry of video) {
        /*
         * Resolved THROUGH THE REGISTRY, never required from the module.
         *
         * The first version of this check required the module and passed while
         * the feature was dead: resolve() hands back the ADAPTER OBJECT, and a
         * describer exported only from module.exports is invisible to every
         * caller. The preview marked both providers unverified and fell back to
         * reporting the payload as fact — exactly the bug being fixed — with
         * this test green.
         */
        const adapter = providers.get
            ? providers.get(entry.id)
            : providers.resolve('video', { video: entry.id });
        assert.ok(adapter, `${entry.id}: not resolvable through the registry`);
        assert.strictEqual(typeof adapter.describeVideoRequest, 'function',
            `${entry.id} cannot say what it would send, so a preview can only repeat the payload back `
            + 'and call it fact');

        // Pure: describing must never reach the network or need a credential.
        const described = adapter.describeVideoRequest({
            prompt: 'the dragon moves toward MAYA',
            model: 'animatediff-sdxl',          // the hardcoded default nothing hosted knows
            duration_s: 47,                      // beyond every documented limit
            width: 1920, height: 1080,
            init_image: 'data:image/png;base64,AAA',
        });
        assert.ok(described && typeof described === 'object', `${entry.id}: described nothing`);
        for (const field of ['model', 'duration_s', 'has_image']) {
            assert.ok(Object.prototype.hasOwnProperty.call(described, field),
                `${entry.id}: does not report ${field}`);
        }
        assert.strictEqual(described.has_image, true, `${entry.id}: lost the keyframe`);
    }
});

test('runway reports the model it will really use, not the one it was handed', () => {
    /*
     * The DESCRIBER comes from the registry, because that is the object every
     * caller gets. The BUILDER is internal and comes from the module — the
     * whole point of this test is that those two agree, so they are deliberately
     * fetched by different routes.
     */
    const providers = require('../lib/providers');
    const runway = providers.get('runway');
    const internals = require('../lib/providers/runway');
    const asked = { prompt: 'x', model: 'animatediff-sdxl', duration_s: 5, width: 1280, height: 720 };

    const described = runway.describeVideoRequest(asked);
    const actual = internals.buildVideoRequest(asked);

    assert.strictEqual(described.model, actual.body.model,
        'the description and the request disagree about the model — the preview is a separate '
        + 'implementation and will drift from what is sent');
    assert.notStrictEqual(described.model, 'animatediff-sdxl',
        'the preview still reports a model runway has never heard of');

    // And it must SAY that it substituted, or a director reads the swap as
    // their own choice having been honoured.
    assert.ok(described.notes && described.notes.some(n => /animatediff-sdxl/.test(n)),
        `nothing tells the director their model was replaced: ${JSON.stringify(described.notes)}`);

    // Duration is clamped too, and silently clamping is the same class of lie.
    const long = runway.describeVideoRequest({ ...asked, duration_s: 47 });
    assert.strictEqual(long.duration_s, internals.buildVideoRequest({ ...asked, duration_s: 47 }).body.duration);
    assert.ok(long.notes.some(n => /47/.test(n)), 'the clamped duration is not reported');
});

test('the video preview reports the adapter’s answer, not the payload', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes', 'video-gen.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const fn = src.slice(src.indexOf('async function previewVideo('));
    const body = fn.slice(0, fn.indexOf('\n}'));

    assert.ok(/describeVideoRequest/.test(body),
        'the preview still reports payload fields directly, so every adapter transformation — model '
        + 'mapping, duration clamping, ratio snapping — is invisible to the director');

    /*
     * And an adapter that cannot describe itself must be marked UNVERIFIED
     * rather than have its payload reported as fact. Falling back silently is
     * how this bug would return the moment a new adapter arrives.
     */
    assert.ok(/unverified/i.test(body),
        'an adapter with no describer has its payload reported as fact');
});
