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

// ── Everything a person can import, an agent can import ─────────────────
//
// "Can I generate and upload storyboard images myself? Yes — with one missing
// connection... There is no general storyboard_upload MCP tool, even though the
// underlying import route already exists."
//
// Exactly right, and it is three tools rather than one. MEDIA_IMPORTS has
// thirteen targets; the four plates reach an agent through plate_upload and the
// seven media kinds through media_upload, and storyboard-image, previs-image
// and three-d-model reach it through nothing at all. The routes have existed
// the whole time.
//
// That matters more than convenience: the connected model IS the LLM here, so a
// capability it cannot reach is one that has to be done by hand or paid for at
// a provider. Generating a frame in the conversation and putting it on the
// board is the difference between spending image credits and not.
//
// Derived from MEDIA_IMPORTS so a fourteenth target cannot arrive unreachable.

test('every import target is reachable from an agent', () => {
    const { MEDIA_IMPORTS } = require('../lib/media-imports');
    const tools = require('../lib/mcp-tools').listTools();
    const names = new Set(tools.map(t => t.name));

    /*
     * Which tool covers which target, stated rather than guessed. A target with
     * no entry fails as an unknown rather than being silently assumed covered —
     * that assumption is how three of them stayed unreachable.
     */
    const COVERED_BY = {
        'character-plate': 'plate_upload',
        'location-plate': 'plate_upload',
        'prop-plate': 'plate_upload',
        'mood-board-image': 'plate_upload',
        'storyboard-image': 'storyboard_upload',
        'previs-image': 'previs_image_upload',
        'three-d-model': 'model_upload',
        'continuity-ref': 'continuity_upload',
        'marketing-asset': 'marketing_upload',
    };

    const unreachable = [];
    for (const target of Object.keys(MEDIA_IMPORTS)) {
        const tool = /-media$/.test(target) ? 'media_upload' : COVERED_BY[target];
        assert.ok(tool, `${target} is an import target this test does not know about — name the tool `
            + 'that covers it, or it ships reachable only by hand');
        if (!names.has(tool)) unreachable.push(`${target} (needs ${tool})`);
    }
    assert.deepStrictEqual(unreachable, [],
        `a person can import these and an agent cannot: ${unreachable.join(', ')}`);
});

test('storyboard_upload puts a frame on the board and keeps the one it replaced', async () => {
    const { callTool } = require('../lib/mcp-tools');

    const projectId = generateId();
    const sceneId = generateId();
    const shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Agent frames');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)')
        .run(sceneId, projectId, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '1A', JSON.stringify({ shot_code: '1A', description: 'x' }));

    const PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64');
    const uri = `data:image/png;base64,${PNG.toString('base64')}`;

    const first = await callTool('storyboard_upload', { shot_id: shotId, image: uri });
    assert.ok(first && !first.error, `first upload failed: ${JSON.stringify(first)}`);

    const second = await callTool('storyboard_upload', { shot_id: shotId, image: uri });
    assert.ok(second && !second.error, `second upload failed: ${JSON.stringify(second)}`);

    /*
     * The frame it replaced must survive. A director who has an agent generate
     * three attempts needs the two they did not keep, and an upload that
     * overwrites is the one destructive verb hiding in a helpful one.
     */
    const versions = db.prepare(
        "SELECT version, file_name FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard' ORDER BY version")
        .all(shotId);
    assert.ok(versions.length >= 2,
        `the second upload replaced the first instead of versioning it (${versions.length} kept)`);
    assert.ok(versions.some(v => /_v1\.png$/.test(v.file_name)),
        'the previous frame was not archived under its own version');
});

test('a locked board refuses an agent upload the same way it refuses a person', async () => {
    /*
     * A lock exists to stop a finished board being replaced, and an agent route
     * that ignores it is a hole in the lock rather than a convenience. Same
     * refusal, same override.
     */
    const { callTool } = require('../lib/mcp-tools');
    const projectId = generateId();
    const sceneId = generateId();
    const shotId = generateId();
    db.prepare("INSERT INTO film_projects (id, title, board_locked_at) VALUES (?, ?, datetime('now'))")
        .run(projectId, 'Locked');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)')
        .run(sceneId, projectId, '1');
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '1A', JSON.stringify({ shot_code: '1A' }));

    const PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64');
    const uri = `data:image/png;base64,${PNG.toString('base64')}`;

    const refused = await callTool('storyboard_upload', { shot_id: shotId, image: uri });
    const text = JSON.stringify(refused);
    assert.ok(/lock/i.test(text), `a locked board accepted an agent upload: ${text}`);

    const forced = await callTool('storyboard_upload', { shot_id: shotId, image: uri, force: true });
    assert.ok(forced && !forced.error, `the documented override does not work: ${JSON.stringify(forced)}`);
});

// ── The Direct modal, from an agent ─────────────────────────────────────
//
// "Does MCP give access to the Direct modal, so I can ask an LLM to build the
// description?"
//
// Nearly. shot_update covered nine of the twelve fields routes/shots.js
// accepts, and the three missing ones include `direction` — the field a
// DIRECTOR adds on top of the screenplay, which is precisely the thing you
// would want written in conversation. Also missing: location_view, which side
// of a location the shot looks at, and sfx_cues.
//
// The body builder forwards everything it is given, so those fields were
// reachable by an agent that guessed the name and invisible to one reading the
// schema. Derived from EDITABLE so the next field added to the route cannot
// arrive unreachable.

test('every field the shot route accepts is offered to an agent', () => {
    const routeSrc = fs.readFileSync(path.join(ROOT, 'routes', 'shots.js'), 'utf8');
    const m = /const EDITABLE\s*=\s*\[([\s\S]*?)\]/.exec(routeSrc);
    assert.ok(m, 'routes/shots.js no longer declares what a card edit may change');
    const editable = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    assert.ok(editable.length >= 10, `the editable set collapsed (${editable.length})`);

    const toolSrc = fs.readFileSync(path.join(ROOT, 'lib', 'mcp-tools.js'), 'utf8');
    const at = toolSrc.indexOf("name: 'shot_update'");
    assert.ok(at > 0, 'shot_update is gone');
    const schemaAt = toolSrc.indexOf('schema: {', at);
    const block = toolSrc.slice(schemaAt, toolSrc.indexOf('\n        },', schemaAt));

    const missing = editable.filter(f => !new RegExp(`\\b${f}:`).test(block));
    assert.deepStrictEqual(missing, [],
        `a person can set these on the Direct panel and an agent reading the schema cannot see them: `
        + `${missing.join(', ')}`);
});

// ── Nothing is cut from a motion prompt while it still fits ─────────────
//
// "Film Engine sends each shot's action field to Runway as the primary motion
// instruction, capped at roughly 500 characters. Why are we capping the main
// motion instructions?"
//
// Substantially correct, and the cap has no justification. buildVideoPrompt
// sliced motion.subject to 500 and motion.environment to 300 unconditionally,
// and buildRunwayMotionPrompt then assembled them and applied the REAL ceiling
// of 1000. On a real shot that produced 503 characters against a 1000-character
// limit: 497 characters of the director's own motion description discarded with
// half the budget unused.
//
// This is the same defect the image prompt had and it was fixed there once
// already: "an allowance is a rule for deciding what to cut when something must
// be cut, and it was being read as a target to shrink every field to."
//
// The subject is the PRIMARY instruction, so when something genuinely must go
// it is the last thing cut.

test('a long motion description is not trimmed while it fits', () => {
    const { buildVideoPrompt } = require('../lib/video-prompt');
    const runway = require('../lib/providers/runway');

    // 800 characters of motion: well over the old 500 cap, well under the real
    // ceiling once assembled.
    const action = ('The dragon climbs down from the shattered house and drives forward into the '
        + 'narrow street, claws skidding on wet asphalt, wings half-open, tail whipping rainwater. ')
        .repeat(4).slice(0, 800);

    // (sceneCard, characters, location, stylePreset, options) — positional.
    const built = buildVideoPrompt(
        { shot_code: '2B', action, camera: { movement: 'tracking-forward' } }, [], null, null, {});
    assert.ok(built.motion && built.motion.subject, 'no motion subject was built');
    assert.strictEqual(built.motion.subject.length, action.length,
        `the action was cut to ${built.motion.subject.length} of ${action.length} characters before `
        + 'anything knew whether it would fit');

    const sent = runway.buildVideoRequest({ ...built, duration_s: 5, width: 1280, height: 720 });
    const limit = runway.promptLimit || 1000;
    assert.ok(sent.body.promptText.length <= limit,
        `the assembled prompt is ${sent.body.promptText.length}, over the ${limit} ceiling`);
    assert.ok(sent.body.promptText.includes(action.slice(0, 700)),
        'the motion description was cut even though the whole thing fits inside the ceiling');
});

test('when it genuinely does not fit, the subject is the last thing cut', () => {
    const { buildVideoPrompt } = require('../lib/video-prompt');
    const runway = require('../lib/providers/runway');

    /*
     * Over the ceiling on purpose. Something has to go, and it must not be the
     * primary instruction — cutting the thing the shot is ABOUT to keep an
     * atmosphere note is the wrong trade every time.
     */
    const action = 'A '.repeat(600);                  // 1200 chars
    const environment = 'rain falls steadily. '.repeat(30);
    const built = buildVideoPrompt(
        { shot_code: '2B', action, environment_motion: environment, camera: { movement: 'dolly-in' } },
        [], null, null, {});
    const sent = runway.buildVideoRequest({ ...built, duration_s: 5, width: 1280, height: 720 });
    const limit = runway.promptLimit || 1000;

    assert.ok(sent.body.promptText.length <= limit,
        `${sent.body.promptText.length} characters sent against a ${limit} ceiling`);
    assert.ok(sent.body.promptText.includes('A A A'),
        'the subject was dropped to make room for something else');
    // The camera move is short and load-bearing; it survives too.
    assert.ok(/camera performs/i.test(sent.body.promptText),
        'the camera instruction was cut, so the clip has no move');
});

test('the ceiling comes from the adapter, not from a number in the builder', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'providers', 'runway.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const fn = src.slice(src.indexOf('function buildRunwayMotionPrompt('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.ok(!/\.slice\(0,\s*1000\)/.test(body),
        'the motion prompt still carries a hardcoded ceiling — the same literal that made the image '
        + 'prompt trim against a limit belonging to a provider it never called');

    const video = fs.readFileSync(path.join(ROOT, 'lib', 'video-prompt.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/slice\(0,\s*500\)/.test(video) && !/slice\(0,\s*300\)/.test(video),
        'the unconditional per-field caps are still applied before anything knows whether they fit');
});
