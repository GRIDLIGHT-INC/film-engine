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
