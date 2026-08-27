/**
 * EVERY BUTTON THAT BUYS AN IMAGE OFFERS THE SAME THREE THINGS.
 *
 * "So I can go to any image generator button, click on it, select the model,
 *  and it will open the prompt edit which I can edit and then send it?"
 *
 * The answer was no on six of seven. The model picker was on the storyboard
 * regenerate path alone and the prompt was editable nowhere — while
 * `GET /shots/:id/prompt` had been showing the exact assembled text for weeks
 * and `regenerate` had been accepting it back as `prompt_override` for just as
 * long, with nothing between them.
 *
 * Set-based over the paid image routes, because that failure was PARTIAL: one
 * path had the picker and every check written against it passed while six
 * others had neither.
 *
 * Three things per route, and the third is the one that is easy to skip:
 *
 *   quality  — choose the model for this one generation without changing the
 *              project's standing setting.
 *   prompt   — take the composed prompt back and send it as written.
 *   preview  — a FREE route that shows what would be sent. Editing a prompt you
 *              cannot read first is not editing, it is guessing.
 */

/*
 * Isolated. This file inserts probe projects, and without FILM_DATA_DIR they
 * land in the developer's REAL database — three of them did, and only
 * test-isolation.test.js noticed. A test that writes to the live data is one
 * that quietly edits the work it is meant to be checking.
 */
const os = require('os');
process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || require('path').join(os.tmpdir(), 'film-engine-paidctl-' + Date.now());

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/**
 * The paid image routes. `promptEditable: false` must carry a REASON — a route
 * excused without one is a gap somebody closed by writing `false`.
 */
const PAID_IMAGE_ROUTES = [
    /*
     * VIDEO IS IN THIS SET TOO.
     *
     * "On every generation we should be able to select the image or video
     *  generator."
     *
     * It was true of pictures and false of footage — the more expensive half.
     * A clip is $0.48 where a frame is $0.13, so being stuck on whatever the
     * project happened to say costs more there, not less.
     */
    { fn: 'generateVideo', file: 'routes/video-gen.js', preview: 'preview',
      promptEditable: false,
      why: 'A clip prompt is composed from the shot card and the approved camera path; the '
        + 'editable-prompt work covered images only, and a motion prompt is a separate builder.' },
    { fn: 'generateVideoStream', file: 'routes/video-gen.js', preview: 'preview',
      promptEditable: false,
      why: 'The streaming twin of generateVideo — same payload, same reason.' },
    { fn: 'batchVideoStream', file: 'routes/video-gen.js', preview: 'preview',
      promptEditable: false,
      why: 'A batch composes a prompt PER SHOT, so there is no single text to edit.' },
    { fn: 'generateSequence', file: 'routes/sequences.js', preview: 'plan',
      promptEditable: false,
      why: 'A sequence composes one prompt per LEG from the shots it travels between.' },

    { fn: 'regenerateShot', file: 'routes/storyboard.js', preview: 'prompt' },
    { fn: 'refineShot', file: 'routes/storyboard.js', preview: 'refine-preview' },
    { fn: 'recomposeShot', file: 'routes/storyboard.js', preview: 'recompose-preview' },
    {
        fn: 'generateStoryboard', file: 'routes/storyboard.js', preview: 'prompt',
        promptEditable: false,
        why: 'A batch composes one prompt PER SHOT. There is no single text to edit — '
            + 'offering one would silently apply it to every frame in the film.',
    },
    { fn: 'generateSubjectPlate', file: 'routes/locations.js', preview: 'plate-preview' },
    { fn: 'refineSubjectPlate', file: 'routes/locations.js', preview: 'refine-preview' },
    // /film/characters/:id/refsheet/preview — the sub-path is 'preview' under
    // the refsheet route, matching how generate sits there.
    { fn: 'generateRefSheet', file: 'routes/characters.js', preview: 'preview' },
    { fn: 'generateMarketingAsset', file: 'routes/marketing.js', preview: 'preview' },
];

/** The body of one function, bounded by the next declaration. Comments stripped:
 *  a comment that NAMES the thing being checked reads as the thing itself. */
function bodyOf(file, fn) {
    const src = read(file);
    const at = src.indexOf(`function ${fn}(`);
    if (at < 0) return null;
    const rest = src.slice(at + fn.length + 10);
    const end = rest.search(/\n(?:async )?function /);
    return (end > 0 ? rest.slice(0, end) : rest)
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('every paid image route takes a per-generation model choice', () => {
    const missing = [];
    for (const r of PAID_IMAGE_ROUTES) {
        const body = bodyOf(r.file, r.fn);
        assert.ok(body, `${r.fn} is gone from ${r.file}`);
        // Either read inline or through the shared helper — the helper is the
        // better shape, and a test that only knows the inline form pushes
        // seven routes into seven hand-written readings, which is how three
        // accept `quality` and a fourth silently ignores it.
        /*
         * Read inline, or through one of the named helpers. Video resolves on
         * a `video` key rather than `image`, so it renames at the boundary —
         * a matcher that only knew the image helper reported four correctly
         * wired routes as stuck.
         */
        const reads = /body\.quality|image_quality|imageOverride\s*\(|videoOverrideOf\s*\(|seqConfig\s*\(/;
        if (!reads.test(body)) missing.push(`${r.fn} (${r.file})`);
    }
    assert.deepStrictEqual(missing, [],
        `these spend on an image and cannot be told which model to use, so they are stuck `
        + `on the project setting: ${missing.join(', ')}`);
});

test('every paid image route takes the prompt back, or says why it cannot', () => {
    const missing = [];
    for (const r of PAID_IMAGE_ROUTES) {
        if (r.promptEditable === false) {
            assert.ok(r.why && r.why.length > 40,
                `${r.fn} is excused from prompt editing with no reason given — an exemption `
                + 'without a reason is a gap somebody closed by writing false');
            continue;
        }
        const body = bodyOf(r.file, r.fn);
        if (!/prompt_override|promptOverride\s*\(|promptEdit/.test(body)) missing.push(`${r.fn} (${r.file})`);
    }
    assert.deepStrictEqual(missing, [],
        `these compose a prompt and will not accept an edited one: ${missing.join(', ')}`);
});

test('the shared override helper reads what the routes stop reading themselves', () => {
    /*
     * Seven routes now delegate to one helper, so the helper IS the contract.
     * If it stopped reading `quality`, every route would keep passing a check
     * that only looks for the call.
     */
    const { imageOverride, promptOverride } = require('../lib/generation-override');
    assert.deepStrictEqual(imageOverride({ quality: 'draft' }), { image_quality: 'draft' });
    assert.deepStrictEqual(imageOverride({ provider: 'meshy', model: 'nano-banana' }),
        { image: 'meshy', image_model: 'nano-banana' });
    assert.strictEqual(imageOverride({}), null, 'an empty body produced an override');
    assert.strictEqual(imageOverride({ quality: 'lavish' }), null, 'an unknown tier was accepted');
    assert.strictEqual(promptOverride({ prompt_override: '  x  ' }), 'x');
    assert.strictEqual(promptOverride({ prompt_override: '   ' }), null,
        'a blank override would replace the composed prompt with nothing');
});

test('the video helpers rename the override rather than reading it twice', () => {
    /*
     * Video resolves on a `video` key and images on `image`, so the shared
     * helper is renamed at the boundary instead of being re-read. Two readings
     * of the same request fields is how one path comes to accept `quality`
     * while another silently ignores it — which is the state video was in.
     */
    const fs2 = require('fs');
    const vg = fs2.readFileSync(path.join(__dirname, '..', 'routes', 'video-gen.js'), 'utf8');
    const sq = fs2.readFileSync(path.join(__dirname, '..', 'routes', 'sequences.js'), 'utf8');

    for (const [name, src] of [['video-gen', vg], ['sequences', sq]]) {
        assert.ok(/require\('\.\.\/lib\/generation-override'\)/.test(src),
            `${name} reads the override itself instead of through the shared helper`);
        assert.ok(/video:\s*o\.image|\.video\s*=\s*o\.image/.test(src),
            `${name} does not map the chosen provider onto the video capability, so the pick `
            + 'would be stored under a key nothing resolves on');
    }

    // And the ceiling lookup must not reference a request it was never given —
    // it sits inside a try/catch that turns any throw into "this provider takes
    // one keyframe", which silently degrades a sequence to a series of stills.
    assert.ok(/function keyframeCeiling\(projectId, req\)/.test(sq),
        'keyframeCeiling uses a request that is not one of its parameters');
});

test('every paid image route has a free preview to edit from', () => {
    /*
     * Editing a prompt you cannot read first is guessing. Each route names the
     * preview it is read from, and that preview has to be dispatched somewhere
     * — a named-but-unrouted preview is the same lie as a button wired to
     * nothing.
     */
    const missing = [];
    for (const r of PAID_IMAGE_ROUTES) {
        const src = read(r.file);
        if (!src.includes(`'${r.preview}'`)) missing.push(`${r.fn}: no '${r.preview}' route in ${r.file}`);
    }
    assert.deepStrictEqual(missing, [], missing.join('; '));
});

test('the page offers all three on every image control', () => {
    /*
     * The routes accepting a parameter is half of it. A control that never
     * sends one leaves the capability reachable only from curl — which is
     * exactly the state the model picker was in.
     */
    const html = read('../src/index.html');
    /*
     * The function that MAKES THE PURCHASE, not always the button handler.
     *
     * recomposeFrame is a two-line wrapper around runRecompose — the shared
     * runner both directing surfaces use — so checking the wrapper means
     * walking two call levels, and an unbounded walk follows onclick strings
     * into every button these functions render and reports a confirm() on an
     * unrelated delete as a gate on this one. Naming the spender is exact.
     */
    const CONTROLS = ['regenerateStoryboard', 'refineFrame', 'runRecompose',
        'generateAllStoryboards', 'regeneratePlate', 'refineLocationView', 'generateMarketingArt'];

    const bad = [];
    for (const fn of CONTROLS) {
        const at = html.indexOf(`function ${fn}(`);
        if (at < 0) { bad.push(`${fn}: gone from the page`); continue; }
        const rest = html.slice(at + fn.length + 12);
        const end = rest.search(/\n    (?:async )?function /);
        const body = (end > 0 ? rest.slice(0, end) : rest.slice(0, 6000))
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        /*
         * Follows ONE call level.
         *
         * recomposeFrame delegates to runRecompose and generateAllStoryboards
         * to its stream runner, so reading only the named function reports a
         * gated path as ungated — the same trap the clip-upload check fell
         * into, where the prompt() being one function away made a live bug
         * look fixed.
         *
         * One level, not an unbounded walk: an unbounded one follows the
         * refresh callbacks into every button these functions RENDER, and
         * reports a confirm() on an unrelated delete as a gate on this.
         */
        /*
         * Three shapes count, and they are not interchangeable by accident:
         *
         *   confirmPaidImage  — the generic dialog, for paths that had no rich
         *                       confirmation of their own.
         *   confirmGeneration — the storyboard regenerate dialog.
         *   confirmExtras     — the shared model picker and editable prompt,
         *                       dropped INTO refine's and recompose's own
         *                       confirmations. Those lead with film facts —
         *                       what is kept, which background — and replacing
         *                       them with the generic dialog would have lost
         *                       that, which is what the recompose suite caught.
         */
        let gated = /confirmPaidImage|confirmGeneration|confirmExtras/.test(body);
        if (!gated) {
            for (const callee of body.match(/\b([a-z][A-Za-z0-9_]{3,})\s*\(/g) || []) {
                const name = callee.replace(/\s*\($/, '');
                const cAt = html.indexOf(`function ${name}(`);
                if (cAt < 0) continue;
                const cRest = html.slice(cAt + name.length + 12);
                const cEnd = cRest.search(/\n    (?:async )?function /);
                const cBody = (cEnd > 0 ? cRest.slice(0, cEnd) : cRest.slice(0, 6000));
                if (/confirmPaidImage|confirmGeneration|confirmExtras/.test(cBody)) { gated = true; break; }
            }
        }
        if (!gated) bad.push(`${fn}: does not go through the shared pre-spend confirmation`);
    }
    assert.deepStrictEqual(bad, [], bad.join('; '));
});

test('a per-generation provider choice really changes the adapter, for image AND video', () => {
    /*
     * BEHAVIOURAL, because the source checks above passed while this was
     * broken. spendContext carried an allow-list of three image field names, so
     * a video override was accepted by the route, renamed correctly at the
     * boundary, and silently dropped one function later — every wiring
     * assertion green, and choosing Runway still resolved to Seedance.
     *
     * That is the "declared but never consumed" failure this codebase has now
     * shipped five times. A test that reads the call and not the outcome cannot
     * see it.
     */
    // An isolated data dir starts empty, so the schema has to be built before
    // anything can be inserted into it.
    require('../db/schema').ensureSchema();
    const { spendContext } = require('../lib/provider-config');
    const { db } = require('../db/database');
    const providersReg = require('../lib/providers');
    const crypto2 = require('crypto');

    const id = crypto2.randomUUID();
    db.prepare('INSERT INTO film_projects (id, title, provider_config) VALUES (?, ?, ?)')
        .run(id, 'override probe', '{}');
    for (const p of ['runway', 'seedance', 'meshy', 'google', 'bfl', 'openai']) {
        db.prepare(`INSERT INTO film_provider_credentials (provider, api_key, meta) VALUES (?, 'k', '{}')
                    ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key`).run(p);
    }
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(id);
    const resolveWith = (cap, ov) => providersReg.resolveId(cap, spendContext(project, null, null, ov));

    for (const [cap, choices] of [['video', ['runway', 'seedance']], ['image', ['meshy', 'bfl', 'openai']]]) {
        for (const choice of choices) {
            assert.strictEqual(resolveWith(cap, { [cap]: choice }), choice,
                `choosing ${choice} for one ${cap} generation resolved somewhere else`);
        }
        // Two different choices must give two different answers, or the
        // override is being ignored and happening to match the default.
        const seen = new Set(choices.map(c => resolveWith(cap, { [cap]: c })));
        assert.strictEqual(seen.size, choices.length,
            `${cap}: ${choices.length} choices produced ${seen.size} distinct providers`);
    }

    // And it must not become a pin: the next generation is unaffected.
    assert.strictEqual(
        db.prepare('SELECT provider_config FROM film_projects WHERE id = ?').get(id).provider_config,
        '{}', 'a per-generation choice was written to the project as a pin');
});
