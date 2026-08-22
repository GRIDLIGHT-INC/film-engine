/**
 * Who gets the prompt when there is not enough of it.
 *
 * Reported from a real shot: 2B, where the camera had to sit on the far side of
 * the street with the dragon's back to us and MAYA facing camera. Four attempts,
 * none of them right. The card was meticulous — 1,253 characters describing
 * exactly that — and the generations show why it failed:
 *
 *   - 88% of the direction was cut. 156 of 1,253 characters survived, and what
 *     went was every word about the dragon's back and "we never see its face".
 *   - The prompt OPENED with a character's face: "Woman in her mid-thirties,
 *     lean and slightly angular, olive skin…". Whatever leads a prompt is what
 *     the image is of, so a request for a wide shot read as a request for a
 *     portrait.
 *   - 7,295 characters of locked contracts compete for a 4,000 ceiling. Today
 *     the base prompt is 3,836 and NO contract fits at all; in the ledger runs
 *     the contracts won and the direction lost. Which one happens depends on
 *     lengths nobody is watching.
 *
 * The last point is the actual defect. Prompt assembly is an automatic
 * negotiation between a dozen contributors with no stated order, so the director
 * cannot see it, cannot control it, and the outcome flips silently.
 *
 * So: contributors are RANKED, the ranking is a registry, and trimming walks it
 * backwards. The shot is what you asked for; the subjects are what happen to be
 * in it, and a prompt that describes subjects at length and the shot briefly
 * produces a picture of the subjects.
 *
 * Set-based over that registry rather than over an example prompt, because the
 * failure is per-contributor: a fix that saves the direction and still leads
 * with a face passes any test written about truncation.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-ctrl-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const { buildStoryboardPrompt, PROMPT_PRIORITY } = require('../lib/storyboard-prompt');

function callRoute(handler, method, urlPath, body) {
    return new Promise(resolve => {
        const u = urlPath.split('?');
        const parts = u[0].split('/').filter(Boolean);
        const query = {};
        for (const kv of (u[1] || '').split('&').filter(Boolean)) {
            const [k, v] = kv.split('='); query[k] = decodeURIComponent(v === undefined ? '' : v);
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
            .catch(err => resolve({ status: 500, body: { error: err.message, stack: err.stack } }));
    });
}

/** 2B, near enough: a long direction, two described subjects, a long contract. */
const DIRECTION = 'Tracking wide shot from the FAR side of the cul-de-sac: the camera is across the '
    + 'street, on the side of the house being hit, looking back toward MAYA\'s side. The DRAGON is in '
    + 'the near foreground with its BACK TO CAMERA, seen from behind and slightly below, moving away '
    + 'from us low over the rooftops. We never see its face. Beyond the creature, small and clear '
    + 'across the wet asphalt, MAYA stands at the end of her driveway facing camera, not running.';

const CARD = {
    shot_code: '2B',
    description: DIRECTION,
    camera: { shot_type: 'tracking', lens: '35mm anamorphic', movement: 'tracking-right' },
    characters: ['MAYA', 'DRAGON'],
    props: ['SEDAN'],
    lighting: { type: 'blue-hour' },
};

const CHARS = [
    { name: 'MAYA', appearance_prompt: 'Woman in her mid-thirties, lean and slightly angular, olive skin '
        + 'with a warm undertone that goes sallow in low light. '.repeat(6) },
    { name: 'DRAGON', appearance_prompt: 'Tan wing membranes thin enough to go translucent where light '
        + 'passes through them, showing a branching amber vessel network. '.repeat(6) },
];
const LOC = { name: 'SUBURBAN STREET', description: 'Late-1970s North American cul-de-sac, '.repeat(20) };

// ── The registry ────────────────────────────────────────────────────────

test('every prompt contributor has a declared rank', () => {
    // The point of the registry: a thirteenth contributor added later must be
    // given a place in the order, rather than landing wherever the code happens
    // to push it and quietly outranking the director.
    assert.ok(Array.isArray(PROMPT_PRIORITY), 'PROMPT_PRIORITY is not exported');
    assert.ok(PROMPT_PRIORITY.length >= 10,
        `only ${PROMPT_PRIORITY.length} contributors ranked — the prompt has more than that`);

    const seen = new Set();
    for (const c of PROMPT_PRIORITY) {
        assert.ok(c.id, 'a contributor has no id');
        assert.ok(!seen.has(c.id), `${c.id} is ranked twice`);
        seen.add(c.id);
        assert.ok(typeof c.protected === 'boolean', `${c.id} does not say whether it can be cut`);
        assert.ok(c.why, `${c.id} does not say why it sits where it does`);
    }
});

test('the shot outranks what is in it', () => {
    // The whole correction. A prompt that describes subjects at length and the
    // shot briefly produces a picture of the subjects.
    const rank = id => PROMPT_PRIORITY.findIndex(c => c.id === id);
    for (const shotPart of ['camera_note', 'direction', 'camera']) {
        for (const subjectPart of ['appearance', 'location', 'contracts']) {
            assert.ok(rank(shotPart) < rank(subjectPart),
                `${subjectPart} outranks ${shotPart} — the subjects win over the shot`);
        }
    }
});

test('the direction and the camera are never cut', () => {
    const protectedIds = PROMPT_PRIORITY.filter(c => c.protected).map(c => c.id);
    for (const id of ['camera_note', 'direction', 'camera']) {
        assert.ok(protectedIds.includes(id), `${id} can still be trimmed away`);
    }
    // And something must be cuttable, or the ceiling cannot be honoured.
    assert.ok(PROMPT_PRIORITY.some(c => !c.protected), 'nothing can be cut, so the ceiling cannot hold');
});

// ── What actually happens under pressure ────────────────────────────────

test('a long direction survives a crowded prompt whole', () => {
    // The 2B failure, as a test. 88% of the direction was cut while 3,217
    // characters of subject prose survived.
    const { prompt } = buildStoryboardPrompt(CARD, CHARS, LOC, 'teal and amber, wet streets', {
        maxPromptChars: 4000,
        prompt_additions: ['SEDAN: ' + 'dark forest green enamel, oxidised to chalky matte. '.repeat(30)],
    });
    assert.ok(prompt.length <= 4000, `prompt overran the ceiling at ${prompt.length}`);
    assert.ok(prompt.includes(DIRECTION),
        'the direction was trimmed — the one thing the director actually wrote');
});

test('the prompt does not open with a face', () => {
    // Whatever leads is what the image is OF. The generations opened with
    // "Woman in her mid-thirties…" and produced portraits.
    const { prompt } = buildStoryboardPrompt(CARD, CHARS, LOC, 'noir', { maxPromptChars: 4000 });
    const head = prompt.slice(0, 200);
    assert.ok(!/Woman in her mid-thirties/.test(head),
        `the prompt still opens with a character description:\n  ${head}`);
    assert.ok(/Tracking wide shot|tracking shot|camera/i.test(head),
        `the prompt does not open with the shot:\n  ${head}`);
});

test('subject prose is what gives way, not the shot', () => {
    const { prompt } = buildStoryboardPrompt(CARD, CHARS, LOC, 'noir', {
        maxPromptChars: 1500,   // deliberately tight
        prompt_additions: ['SEDAN: ' + 'x'.repeat(2000)],
    });
    assert.ok(prompt.length <= 1500);
    assert.ok(prompt.includes('BACK TO CAMERA'),
        'under pressure the direction was cut before the subject prose');
});

// ── camera_note: short, protected, and it leads ─────────────────────────

test('a camera note leads the prompt and is never trimmed', () => {
    const note = 'Camera on the far side of the street looking back; dragon\'s back to camera; MAYA faces us.';
    const card = { ...CARD, camera: { ...CARD.camera, note } };
    const { prompt } = buildStoryboardPrompt(card, CHARS, LOC, 'noir', {
        maxPromptChars: 1200,
        prompt_additions: ['x'.repeat(3000)],
    });
    assert.ok(prompt.startsWith(note), `the camera note does not lead:\n  ${prompt.slice(0, 120)}`);
    assert.ok(prompt.includes(note), 'the camera note was trimmed');
});

test('a camera note is capped so that "never trimmed" is affordable', () => {
    const { validateSceneCard } = require('../lib/scene-card-schema');
    const long = { shot_code: '1A', camera: { note: 'x'.repeat(2000) } };
    const r = validateSceneCard(long);
    assert.ok(!r.valid, 'a 2,000-character camera note was accepted as never-trimmed');
    assert.ok(r.errors.some(e => /note/.test(e)), `the error does not name the field: ${r.errors.join('; ')}`);
});

// ── Direction modes ─────────────────────────────────────────────────────

test('every direction mode is declared and does something different', () => {
    const { DIRECTION_MODES } = require('../lib/storyboard-prompt');
    assert.ok(DIRECTION_MODES, 'DIRECTION_MODES is not exported');
    const ids = Object.keys(DIRECTION_MODES);
    assert.ok(ids.length >= 2, `only ${ids.length} mode(s)`);
    for (const id of ids) {
        assert.ok(DIRECTION_MODES[id].label, `${id} has no label`);
        assert.ok(DIRECTION_MODES[id].description, `${id} does not say what it does`);
    }
    assert.ok(ids.includes('action'), 'there is no action mode');
    assert.ok(ids.includes('camera'), 'there is no camera mode');
});

test('camera mode locks the scene and gives the room to the camera', () => {
    // What 2B needed: keep the street, the people and the props exactly as they
    // are, and change only where the camera is. Subjects shorten to names
    // because the attached frame carries them — the same rule the anchor uses,
    // and only safe because camera mode REQUIRES that frame.
    const opts = {
        maxPromptChars: 4000,
        anchorAttached: true, anchorTag: '2a',
        anchorCovers: ['MAYA', 'DRAGON', 'SEDAN', 'SUBURBAN STREET'],
        directionMode: 'camera',
        prompt_additions: ['SEDAN: ' + 'chrome and rust. '.repeat(80)],
    };
    const { prompt } = buildStoryboardPrompt(CARD, CHARS, LOC, 'noir', opts);

    assert.ok(prompt.includes(DIRECTION), 'the direction was cut in camera mode');
    assert.ok(!/Woman in her mid-thirties/.test(prompt),
        'camera mode still re-describes a subject the locked frame already shows');
    assert.ok(/MAYA/.test(prompt), 'the subject lost its name as well as its description');
});

test('camera mode refuses when there is no scene to keep', async () => {
    // Locking a scene you have not generated is not a mode, it is a mistake.
    const { handleStoryboard } = require('../routes/storyboard');
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Modes');
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '2', 'STREET')")
        .run(sceneId, projectId);
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '2B', JSON.stringify(CARD));

    const r = await callRoute(handleStoryboard, 'POST', `/film/shots/${shotId}/storyboard/regenerate`,
        { direction_mode: 'camera' });
    assert.ok(r.status >= 400, `camera mode ran with no anchor: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.match(JSON.stringify(r.body), /anchor|frame/i,
        'the refusal does not say what is missing');
});

// ── Seeing it ───────────────────────────────────────────────────────────

test('shot_prompt reports the budget, contributor by contributor', async () => {
    // "It does a lot without my control in the background." The fix for that is
    // not a better default — it is being able to see the negotiation.
    const { handleStoryboard } = require('../routes/storyboard');
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Budget');
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '2', 'STREET')")
        .run(sceneId, projectId);
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '2B', JSON.stringify(CARD));

    const r = await callRoute(handleStoryboard, 'GET', `/film/shots/${shotId}/prompt`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.ok(Array.isArray(r.body.budget), 'shot_prompt does not report a budget breakdown');
    assert.ok(r.body.budget.length >= 3, `only ${(r.body.budget || []).length} contributors reported`);
    for (const b of r.body.budget) {
        assert.ok(b.contributor, 'a budget line has no contributor');
        assert.ok(b.chars !== undefined, `${b.contributor} does not report its size`);
        assert.ok(b.protected !== undefined, `${b.contributor} does not say whether it can be cut`);
    }
    assert.ok(r.body.direction_mode, 'shot_prompt does not say which mode would be used');
});

/**
 * Every generated frame says how it was directed.
 *
 * Derived over the registration call sites rather than listed, because the gap
 * this closes was itself a "the path nobody thought about" bug: 2B accumulated
 * twelve attempts and the version list — whose whole job is "which of these am
 * I looking at" — could not say that eleven were built from prose and the
 * twelfth from a locked scene.
 *
 * The classifier is `provider`. A call site that records which provider made
 * the picture GENERATED it and must say how it was directed; one that does not
 * is a file copy (restore), where no mode applies and `restored_from` is the
 * honest record.
 */
test('every path that generates a frame records how it was directed', () => {
    const fs = require('fs'), pathMod = require('path');
    const src = fs.readFileSync(pathMod.join(__dirname, '..', 'routes', 'storyboard.js'), 'utf8');

    // Each registerStoryboardAsset call and the options object it passes.
    const sites = [];
    const re = /registerStoryboardAsset\(/g;
    let m;
    while ((m = re.exec(src))) {
        const line = src.slice(0, m.index).split('\n').length;
        // The options object is whatever follows, up to the closing of the call.
        const tail = src.slice(m.index, m.index + 600);
        const end = tail.indexOf(');');
        sites.push({ line, opts: end === -1 ? tail : tail.slice(0, end) });
    }
    assert.ok(sites.length >= 4, `expected several registration sites, found ${sites.length}`);

    const generated = sites.filter(s => /provider[:,]/.test(s.opts));
    assert.ok(generated.length >= 3,
        `expected several GENERATING sites, found ${generated.length}`);

    // `sent_from` counts: a borrowed frame was directed on ANOTHER shot, and
    // naming where it came from says more than a mode would.
    const silent = generated.filter(s =>
        !/direction_mode/.test(s.opts) && !/refined_from/.test(s.opts) && !/sent_from/.test(s.opts));
    assert.deepStrictEqual(silent.map(s => s.line), [],
        'these paths generate a frame and record nothing about how it was directed, '
        + `so its version cannot be told apart from any other: lines ${silent.map(s => s.line).join(', ')}`);
});
