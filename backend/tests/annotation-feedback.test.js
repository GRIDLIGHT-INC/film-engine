/**
 * PAR-026 — markup that feeds the next generation, and does not until asked.
 *
 * Storyboard markup shipped as notation: arrows and notes stored against the
 * shot, drawn on the frame, and read by nothing in generation. Whether it
 * SHOULD drive the next prompt was Open Question 3 of the parity epic, and the
 * answer here is yes, opt-in, off by default.
 *
 * Two properties carry the whole feature, and they pull in opposite directions,
 * which is why both are tested set-based rather than by example:
 *
 *   1. **Off means byte-identical.** A project that has not opted in must build
 *      exactly the prompt it built yesterday, with marks all over its frames.
 *      Anything less makes the feature un-adoptable: a director cannot try it
 *      if shipping it already changed their board.
 *
 *   2. **On means every kind of mark is heard, or says why not.** Geometry says
 *      WHERE and never WHAT, so a shape with no note cannot reach a prompt —
 *      but it must be reported as not reaching it. Silence is what makes a
 *      director believe three arrows changed a frame when nothing did, which is
 *      the same failure mode as the storyboard panel that stored dialogue and
 *      never displayed it.
 *
 * Set-based over the six shape kinds because the failure would be per kind and
 * partial: an arrow that converts to words while a freehand silently produces
 * an empty clause passes any test written against arrows.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-annotfeed-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handleAnnotations, ANNOTATION_KINDS } = require('../routes/annotations');
const {
    regionOf, placePhrase, annotationDirectives, directionClause, refineInstruction,
} = require('../lib/annotation-prompt');
const { buildStoryboardPrompt } = require('../lib/storyboard-prompt');
const { loadShotContext, buildCapabilityPayload } = require('../lib/capability-payloads');
const INDEX_HTML = path.join(__dirname, '..', '..', 'src', 'index.html');

function callRoute(handler, method, urlPath, body) {
    return new Promise(resolve => {
        const u = urlPath.split('?');
        const parts = u[0].split('/').filter(Boolean);
        const query = {};
        for (const kv of (u[1] || '').split('&').filter(Boolean)) {
            const [k, v] = kv.split('=');
            query[k] = decodeURIComponent(v === undefined ? '' : v);
        }
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            let parsed = Buffer.concat(chunks).toString();
            try { parsed = JSON.parse(parsed); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body: parsed });
        });
        Promise.resolve(handler({ method, body: body || {} }, res, parts, query))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

function makeShot(opts) {
    const o = opts || {};
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, style_preset, annotation_feedback) VALUES (?, ?, ?, ?)')
        .run(projectId, 'Feedback Test', 'noir', o.feedback ? 1 : 0);
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'STREET')")
        .run(sceneId, projectId);
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '1A', JSON.stringify({
            shot_code: '1A', action: 'MAYA crosses the empty street.',
            camera: { shot_type: 'wide' }, characters: [], props: [],
        }));
    return { projectId, sceneId, shotId };
}

function addMark(shotId, kind, points, text) {
    db.prepare(`INSERT INTO film_storyboard_annotations (id, shot_id, kind, points_json, text)
                VALUES (?, ?, ?, ?, ?)`)
        .run(generateId(), shotId, kind, JSON.stringify(points), text || '');
}

/** One example per shape kind, in normalised coordinates. */
const SAMPLES = {
    arrow:    [[0.2, 0.5], [0.8, 0.9]],
    line:     [[0.1, 0.1], [0.9, 0.9]],
    rect:     [[0.2, 0.2], [0.6, 0.7]],
    ellipse:  [[0.3, 0.3], [0.6, 0.6]],
    freehand: [[0.1, 0.1], [0.2, 0.3], [0.35, 0.4]],
    text:     [[0.4, 0.8]],
};

const NOTE = 'move the car to the kerb';

// ── The vocabulary ──────────────────────────────────────────────────────

test('the sample set covers every kind the route accepts', () => {
    const missing = ANNOTATION_KINDS.filter(k => !SAMPLES[k]);
    assert.deepStrictEqual(missing, [], `kinds with no coverage: ${missing.join(', ')}`);
    const extra = Object.keys(SAMPLES).filter(k => !ANNOTATION_KINDS.includes(k));
    assert.deepStrictEqual(extra, [], `samples for kinds the route rejects: ${extra.join(', ')}`);
});

test('every kind of mark converts to a place a model can read', () => {
    // A kind that produced an empty or coordinate-shaped phrase would reach the
    // prompt as noise, and the director would see the note ignored with no
    // explanation. Set-based: arrows worked first and are not evidence that
    // freehand does.
    const broken = [];
    for (const kind of ANNOTATION_KINDS) {
        const place = placePhrase(kind, SAMPLES[kind]);
        if (!place || !place.trim()) { broken.push(`${kind}: produced no place at all`); continue; }
        if (/\d\.\d/.test(place)) broken.push(`${kind}: leaked a raw coordinate — "${place}"`);
        if (!/left|right|centre|top|bottom|middle/.test(place)) {
            broken.push(`${kind}: says nothing about where in the frame — "${place}"`);
        }
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('a noted mark of any kind becomes a direction; an unnoted one says why not', () => {
    const broken = [];
    for (const kind of ANNOTATION_KINDS) {
        const noted = annotationDirectives([{ id: 'a', kind, points: SAMPLES[kind], text: NOTE }])[0];
        if (!noted.feeds) broken.push(`${kind}: a mark WITH a note did not become a direction`);
        else if (!noted.phrase.includes(NOTE)) broken.push(`${kind}: the note itself was lost from the phrase`);

        const bare = annotationDirectives([{ id: 'b', kind, points: SAMPLES[kind], text: '' }])[0];
        if (bare.feeds) broken.push(`${kind}: a mark with NO note reached the prompt as an instruction`);
        else if (!bare.reason) broken.push(`${kind}: dropped silently — no reason a director can act on`);
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('a point in each ninth of the frame is named differently', () => {
    // Three bands per axis. If two regions collapsed to the same words, an
    // arrow to the top left and one to the bottom right would say the same
    // thing, which is worse than saying nothing.
    const seen = new Map();
    for (const y of [0.1, 0.5, 0.9]) {
        for (const x of [0.1, 0.5, 0.9]) {
            const r = regionOf([x, y]);
            assert.ok(!seen.has(r), `two different ninths both read as "${r}"`);
            seen.set(r, [x, y]);
        }
    }
    assert.strictEqual(seen.size, 9);
});

test('an arrow keeps its direction; a line does not invent one', () => {
    // An arrow points, so its ends are ordered. A line divides, so they are
    // interchangeable — and phrasing a line as "from A toward B" would turn
    // "split the frame here" into "move this there".
    const arrow = placePhrase('arrow', [[0.1, 0.1], [0.9, 0.9]]);
    assert.match(arrow, /toward/, `an arrow lost its direction: "${arrow}"`);
    const line = placePhrase('line', [[0.1, 0.1], [0.9, 0.9]]);
    assert.ok(!/toward/.test(line), `a line was given a direction it does not have: "${line}"`);
});

test('marks keep the order they were drawn in', () => {
    const d = directionClause([
        { id: '1', kind: 'text', points: SAMPLES.text, text: 'first thought' },
        { id: '2', kind: 'text', points: SAMPLES.text, text: 'second thought' },
    ]);
    assert.ok(d.text.indexOf('first thought') < d.text.indexOf('second thought'),
        'the director’s second thought was placed before their first');
});

// ── Default off ─────────────────────────────────────────────────────────

test('marks change nothing until the project opts in', () => {
    // The whole safety argument. A board covered in markup must build exactly
    // the prompt it built before this feature existed.
    const card = { action: 'MAYA crosses the empty street.', camera: { shot_type: 'wide' }, characters: [] };
    const before = buildStoryboardPrompt(card, [], null, 'noir', {});
    const marks = ANNOTATION_KINDS.map((kind, i) => ({ id: String(i), kind, points: SAMPLES[kind], text: NOTE }));

    const withoutOptIn = buildStoryboardPrompt(card, [], null, 'noir', {});
    assert.strictEqual(withoutOptIn.prompt, before.prompt);

    const withMarks = buildStoryboardPrompt(card, [], null, 'noir', { annotations: marks });
    assert.notStrictEqual(withMarks.prompt, before.prompt,
        'opting in changed nothing, so the marks reach no provider');
    assert.ok(withMarks.prompt.includes('Direction:'),
        'the direction clause is not labelled, so it reads as part of the scene');
});

test('the image payload is byte-identical with markup on a project that has not opted in', () => {
    const off = makeShot({ feedback: false });
    for (const kind of ANNOTATION_KINDS) addMark(off.shotId, kind, SAMPLES[kind], NOTE);

    const clean = makeShot({ feedback: false });

    const a = buildCapabilityPayload('image', loadShotContext(off.shotId));
    const b = buildCapabilityPayload('image', loadShotContext(clean.shotId));
    assert.strictEqual(a.payload.prompt, b.payload.prompt,
        'six marks changed the payload of a project with annotation_feedback off');
});

test('the payload moves as soon as the project opts in, so staleness follows for free', () => {
    // The artefact fingerprint IS the payload. That is what makes markup a
    // tracked input with no second registry to drift from — but only if the
    // payload actually changes when a mark is added.
    const on = makeShot({ feedback: true });
    const bare = buildCapabilityPayload('image', loadShotContext(on.shotId)).payload.prompt;

    addMark(on.shotId, 'arrow', SAMPLES.arrow, NOTE);
    const marked = buildCapabilityPayload('image', loadShotContext(on.shotId)).payload.prompt;

    assert.notStrictEqual(bare, marked, 'adding a mark left the payload unchanged');
    assert.ok(marked.includes(NOTE), 'the note did not survive into the payload');
});

test('an unnoted mark does not move the payload even when the project has opted in', () => {
    // Otherwise every stray arrow marks its frame stale for a change that
    // reaches no model — a warning about work nobody needs to redo, which is
    // the fastest way to have warnings switched off.
    const on = makeShot({ feedback: true });
    const bare = buildCapabilityPayload('image', loadShotContext(on.shotId)).payload.prompt;
    addMark(on.shotId, 'rect', SAMPLES.rect, '');
    const after = buildCapabilityPayload('image', loadShotContext(on.shotId)).payload.prompt;
    assert.strictEqual(bare, after);
});

// ── Placement in the prompt ─────────────────────────────────────────────

test('direction never leads the prompt', () => {
    // Whatever leads a prompt is what the image is OF. "Remove the sprinkler"
    // at the head of a prompt makes the sprinkler the subject of the frame it
    // was asking to be rid of — the exact defect the scale notes were moved for.
    const card = { action: 'An empty cul-de-sac at dawn.', camera: { shot_type: 'establishing' }, characters: [] };
    const { prompt } = buildStoryboardPrompt(card, [], null, 'noir', {
        annotations: [{ id: '1', kind: 'rect', points: SAMPLES.rect, text: 'remove the sprinkler' }],
    });
    assert.ok(prompt.indexOf('An empty cul-de-sac') < prompt.indexOf('Direction:'),
        `direction led the prompt:\n${prompt}`);
});

test('direction cannot be trimmed away at all', () => {
    // This used to assert POSITION — direction ahead of the camera and the look
    // — because a provider truncates the tail and an explicit instruction is the
    // last thing that should be lost to a ceiling. Position was a proxy for
    // protection, and the prompt is now ranked: annotations are marked
    // `protected` in PROMPT_PRIORITY and are never cut, whatever their place.
    // Asserting the guarantee beats asserting the proxy for it.
    const { PROMPT_PRIORITY } = require('../lib/storyboard-prompt');
    const rank = PROMPT_PRIORITY.find(c => c.id === 'annotations');
    assert.ok(rank, 'annotations are no longer a ranked contributor');
    assert.strictEqual(rank.protected, true, 'a director\u2019s marks can be trimmed away');

    // And proven under real pressure rather than taken from the registry.
    const card = { action: 'A street.', camera: { shot_type: 'wide' }, characters: [] };
    const { prompt } = buildStoryboardPrompt(card, [], null, 'noir', {
        annotations: [{ id: '1', kind: 'text', points: SAMPLES.text, text: NOTE }],
        maxPromptChars: 260,
        prompt_additions: ['x'.repeat(4000)],
    });
    assert.ok(prompt.includes(NOTE), `the note was cut under pressure:\n${prompt}`);
});
test('a wall of marks is bounded rather than allowed to eat the prompt', () => {
    // An unbounded field ate the budget once already and amputated location and
    // style entirely. It only binds when the prompt overruns.
    const card = { action: 'A street.', camera: { shot_type: 'wide' }, characters: [] };
    const many = Array.from({ length: 40 }, (_, i) => ({
        id: String(i), kind: 'text', points: SAMPLES.text,
        text: `note number ${i} about something in this frame that matters`,
    }));
    const { prompt } = buildStoryboardPrompt(card, [], null, 'noir', { annotations: many, maxPromptChars: 1000 });
    assert.ok(prompt.length <= 1000, `prompt overran the ceiling at ${prompt.length}`);
    assert.ok(prompt.includes('film noir'), 'the look was pushed out by the markup');
    assert.ok(prompt.includes('wide angle shot'), 'the camera was pushed out by the markup');
});

// ── Refine reads the same marks differently ─────────────────────────────

test('refine gets the marks as an instruction, not as a Direction clause', () => {
    // Refine attaches the picture, so "move the car to the kerb" has something
    // to move and somewhere to move it. A regeneration from the card has no
    // previous frame, so the same words are a description of a target state.
    // Same marks, two readings — one builder each rather than one that pretends
    // the difference away.
    const marks = [{ id: '1', kind: 'arrow', points: SAMPLES.arrow, text: NOTE }];
    const refine = refineInstruction(marks);
    assert.ok(refine.text.includes(NOTE));
    assert.ok(!refine.text.includes('Direction:'),
        'the refine instruction carries a prompt label that belongs to the other path');
    assert.notStrictEqual(refine.text, directionClause(marks).text);
});

// ── What the director is told ───────────────────────────────────────────

test('the listing says, per mark, whether it reaches the prompt and why not', async () => {
    const off = makeShot({ feedback: false });
    addMark(off.shotId, 'arrow', SAMPLES.arrow, NOTE);
    addMark(off.shotId, 'rect', SAMPLES.rect, '');

    const r = await callRoute(handleAnnotations, 'GET', `/film/shots/${off.shotId}/annotations`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.feedback_enabled, false);
    for (const a of r.body.annotations) {
        assert.strictEqual(a.feeds, false, 'a mark claimed to feed a project that has not opted in');
        assert.ok(a.reason, `a mark that does not feed gave no reason: ${JSON.stringify(a)}`);
    }
    // "2 marks are notation" and "1 of them could never be anything else" are
    // different problems with different fixes.
    assert.strictEqual(r.body.would_feed, 1,
        'the listing did not distinguish the noted mark from the bare one');
});

test('with the project opted in, the noted mark reports as feeding and the bare one does not', async () => {
    const on = makeShot({ feedback: true });
    addMark(on.shotId, 'arrow', SAMPLES.arrow, NOTE);
    addMark(on.shotId, 'ellipse', SAMPLES.ellipse, '');

    const r = await callRoute(handleAnnotations, 'GET', `/film/shots/${on.shotId}/annotations`);
    assert.strictEqual(r.body.feedback_enabled, true);
    const byKind = Object.fromEntries(r.body.annotations.map(a => [a.kind, a]));
    assert.strictEqual(byKind.arrow.feeds, true);
    assert.strictEqual(byKind.ellipse.feeds, false);
    assert.match(byKind.ellipse.reason, /note/, 'the reason does not name the missing note');
});

test('the free preview shows the prompt with markup applied without turning it on', async () => {
    // Trying it is what makes it adoptable. Finding out by generating is how
    // one experiment becomes a budget decision — the argument previs already
    // made for its own preview.
    const { handleStoryboard } = require('../routes/storyboard');
    const off = makeShot({ feedback: false });
    addMark(off.shotId, 'arrow', SAMPLES.arrow, NOTE);

    const plain = await callRoute(handleStoryboard, 'GET', `/film/shots/${off.shotId}/prompt`);
    assert.strictEqual(plain.status, 200);
    assert.strictEqual(plain.body.direction.feedback_enabled, false);
    assert.strictEqual(plain.body.direction.applied, 0);
    assert.ok(!plain.body.prompt.includes(NOTE), 'markup reached a prompt on a project with it off');
    assert.ok(plain.body.direction.hint, 'nothing told the reader they could preview it');

    const previewed = await callRoute(handleStoryboard, 'GET',
        `/film/shots/${off.shotId}/prompt?use_annotations=true`);
    assert.strictEqual(previewed.status, 200);
    assert.strictEqual(previewed.body.direction.applied, 1);
    assert.ok(previewed.body.prompt.includes(NOTE), 'the preview did not apply the marks it claims to');

    // And previewing must not have changed the project.
    const row = db.prepare('SELECT annotation_feedback FROM film_projects WHERE id = ?').get(off.projectId);
    assert.ok(!row.annotation_feedback, 'a free preview switched the feature on');
});

test('the preview names the marks it cannot use', async () => {
    const { handleStoryboard } = require('../routes/storyboard');
    const s = makeShot({ feedback: true });
    addMark(s.shotId, 'freehand', SAMPLES.freehand, '');
    const r = await callRoute(handleStoryboard, 'GET', `/film/shots/${s.shotId}/prompt`);
    assert.strictEqual(r.body.direction.ignored.length, 1);
    assert.strictEqual(r.body.direction.ignored[0].kind, 'freehand');
    assert.ok(r.body.direction.ignored[0].reason);
});

// ── The switch is reachable everywhere it is decided ────────────────────

test('the project route can turn it on and off', async () => {
    const { handleProjects } = require('../routes/projects');
    const s = makeShot({ feedback: false });
    const on = await callRoute(handleProjects, 'PUT', `/film/projects/${s.projectId}`,
        { annotation_feedback: 1 });
    assert.strictEqual(on.status, 200);
    assert.strictEqual(
        db.prepare('SELECT annotation_feedback FROM film_projects WHERE id = ?').get(s.projectId).annotation_feedback, 1);

    await callRoute(handleProjects, 'PUT', `/film/projects/${s.projectId}`, { annotation_feedback: 0 });
    assert.strictEqual(
        db.prepare('SELECT annotation_feedback FROM film_projects WHERE id = ?').get(s.projectId).annotation_feedback, 0);
});

test('a new project has markup off', () => {
    // Not merely the column default: a project created through the route must
    // land off too, or the guarantee holds only for rows written by a migration.
    const { handleProjects } = require('../routes/projects');
    return callRoute(handleProjects, 'POST', '/film/projects', { title: 'Fresh' }).then(r => {
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        const row = db.prepare('SELECT annotation_feedback FROM film_projects WHERE id = ?').get(r.body.id);
        assert.ok(!row.annotation_feedback, 'a new project shipped with markup already steering generation');
    });
});

test('both generation tools can apply markup for one call, and say so', () => {
    const { listTools } = require('../lib/mcp-tools');
    const tools = Object.fromEntries(listTools().map(t => [t.name, t]));
    for (const name of ['storyboard_regenerate', 'storyboard_refine']) {
        const t = tools[name];
        assert.ok(t, `${name} is missing`);
        assert.ok(t.inputSchema.properties.use_annotations,
            `${name} cannot apply markup for a single call, so trying the feature means committing the project to it`);
    }
    assert.ok(tools.project_update.inputSchema.properties.annotation_feedback,
        'an agent can draw marks and cannot turn on the setting that makes them mean anything');
    // The description has to warn about the part that surprises people.
    assert.match(tools.shot_annotate.description, /annotation_feedback/,
        'shot_annotate does not say whether the mark it draws will reach a prompt');
});

// ── The page says which of the two things markup is ─────────────────────

test('the storyboard page carries the switch and a per-frame badge', () => {
    // A button wired to nothing looks identical to a working one until clicked,
    // and a badge that is never painted looks identical to "no marks".
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const missing = [];
    if (!html.includes('id="annotFeedbackToggle"')) missing.push('the toggle itself');
    if (!/onchange="setAnnotationFeedback/.test(html)) missing.push('the toggle is wired to nothing');
    if (!/function setAnnotationFeedback/.test(html)) missing.push('setAnnotationFeedback is not defined');
    if (!/annotation_feedback/.test(html)) missing.push('nothing writes the project field');
    if (!/function markupFeedBadge/.test(html)) missing.push('the per-frame badge is not built');
    if (!/markupPaintFeedBadge\(/.test(html)) missing.push('the per-frame badge is never painted');
    assert.deepStrictEqual(missing, [], `\n  ${missing.join('\n  ')}`);
});


// ── The clip is where direction has room ────────────────────────────────

test('markup reaches the footage, not only the frame', () => {
    // The board's instructions are meant to reach the footage generator. An
    // arrow is about what happens NEXT — "then dolly past the mailbox" — which
    // a still has no room for and a clip does.
    const { buildVideoPrompt } = require('../lib/video-prompt');
    const card = { action: 'A street.', camera: { shot_type: 'wide', movement: 'push-in' } };
    const marks = [{ id: '1', kind: 'arrow', points: [[0.5, 0.5], [0.2, 0.5]], text: 'dolly past the mailbox' }];

    const plain = buildVideoPrompt(card, [], null, '', {});
    assert.ok(!/Direction:/.test(plain.prompt), 'an unmarked shot picked up a direction clause');

    const marked = buildVideoPrompt(card, [], null, '', { annotations: marks });
    assert.ok(/Direction:/.test(marked.prompt), 'the board\u2019s markup never reaches the clip');
    assert.ok(marked.prompt.includes('dolly past the mailbox'), 'the note itself was lost');
    // The camera move from the card still travels alongside it.
    assert.ok(/pushing in toward subject/.test(marked.prompt),
        'the card\u2019s movement was displaced by the markup');
});

test('the clip carries no reference plates, on purpose', () => {
    // Image-to-video: the keyframe IS the init_image, and that frame was
    // generated FROM the plates, so everything they contribute is baked into
    // it. Sending them again puts a T-pose studio photograph on a seamless
    // backdrop beside a composed street and asks the model which is the truth.
    //
    // They were being sent as consistency rows carrying `file_path` and no
    // `uri`, so every adapter dropped them silently — the repair was to REMOVE
    // them, not to make them work.
    const src = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'lib', 'capability-payloads.js'), 'utf8');
    const video = src.slice(src.indexOf('    video(ctx) {'), src.indexOf('    /** One payload per dialogue line'));
    assert.ok(!/reference_images:/.test(video),
        'the clip attaches reference plates again, which fight the init_image it is generated from');
    assert.ok(/init_image: ctx.initImage/.test(video),
        'the clip is not generated from the board frame at all');
});
