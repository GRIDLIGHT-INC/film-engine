/**
 * Continuity within a scene: one frame every other frame is measured against.
 *
 * Board generation never looked at another frame. A keyframe was conditioned on
 * character plates, a location plate and a mood-board image — all pictures of
 * things in the abstract — so two shots of the same street at the same hour
 * could come back with different light and a different grade, and the remedy
 * was to regenerate until they happened to agree.
 *
 * The obvious fix is to chain each shot to the one before it, and it is wrong
 * in two ways this file pins down. It COMPOUNDS: 1A→1B→1C means the eighth shot
 * is a copy of a copy, drift per step too small to see and drift across the
 * scene obvious. And it makes a frame's inputs depend on the order somebody
 * pressed the buttons in — regenerate 1C alone and it chains to whatever 1B is
 * at that moment. An anchor is fixed, so neither happens.
 *
 * The properties tested here are the ones that fail silently:
 *
 *   - off means the same references a board selected yesterday, exactly;
 *   - the anchor never moves as the board fills in, and never crosses a scene;
 *   - the anchor shot does not reference itself, which would be a loop that
 *     locks a frame against ever being revised;
 *   - it is attached for LIGHT and refuses composition, in the prompt and in
 *     the negative, because "every shot copies the establishing shot" is a
 *     worse failure than the drift it fixes.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-anchor-' + crypto.randomUUID().slice(0, 8));
// The provider chain only walks CREDENTIALED adapters, so with no keys in the
// environment every project resolves to gridlight — which takes pictures and
// cannot name them. A tag-capable provider has to be reachable for any test
// about tagging to mean anything.
process.env.RUNWAY_API_KEY = process.env.RUNWAY_API_KEY || 'test-key-not-used';

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const {
    pickAnchor, anchorPhrase, anchorLeadPhrase, ANCHOR_NEGATIVE, sceneAnchorFor,
    anchorCandidate, subjectsCoveredBy,
} = require('../lib/scene-anchor');
const { buildStoryboardPrompt } = require('../lib/storyboard-prompt');
const { shotReferencesFor } = require('../lib/shot-references');
const { selectReferences, KIND_RANK, MAX_REFERENCES } = require('../lib/reference-images');
const INDEX_HTML = path.join(__dirname, '..', '..', 'src', 'index.html');

function callRoute(handler, method, urlPath, body) {
    return new Promise(resolve => {
        const parts = urlPath.split('?')[0].split('/').filter(Boolean);
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
        Promise.resolve(handler({ method, body: body || {} }, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

/** A 1x1 PNG, so a plate resolves to a real data URI rather than being skipped. */
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64');

let tmpDir;
function framePath(name) {
    if (!tmpDir) {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-frames-'));
    }
    const p = path.join(tmpDir, name + '.png');
    fs.writeFileSync(p, PNG);
    return p;
}

/** A scene with N shots; `framed` lists which shot codes have a generated frame. */
function makeScene(shotCodes, framed, opts) {
    const o = opts || {};
    const projectId = generateId(), sceneId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, scene_anchor_refs, provider_config) VALUES (?, ?, ?, ?)')
        .run(projectId, 'Anchor Test', o.enabled ? 1 : 0,
            JSON.stringify(o.provider ? { image: o.provider } : {}));
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'STREET')")
        .run(sceneId, projectId);
    const shots = {};
    for (const code of shotCodes) {
        const id = generateId();
        db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
            .run(id, sceneId, code, JSON.stringify({ shot_code: code, action: 'A street.', camera: {} }));
        shots[code] = id;
        if ((framed || []).includes(code)) {
            db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version)
                        VALUES (?, ?, ?, 'storyboard', ?, ?, 1)`)
                .run(generateId(), projectId, id, code + '.png', framePath(projectId + '-' + code));
        }
    }
    return { projectId, sceneId, shots };
}

// ── The rule, without a database ────────────────────────────────────────

test('the anchor is the first framed shot in the scene, not the most recent', () => {
    // "Most recent" would move as the board fills in, which makes a shot's
    // inputs depend on when it was generated — the same defect as chaining.
    const shots = [
        { id: 'a', shot_code: '1A', has_frame: true },
        { id: 'b', shot_code: '1B', has_frame: true },
        { id: 'c', shot_code: '1C', has_frame: false },
    ];
    assert.strictEqual(pickAnchor(shots, 'c', null).shot.shot_code, '1A');
    assert.strictEqual(pickAnchor(shots, 'b', null).shot.shot_code, '1A');
});

test('the anchor does not move as the rest of the scene is generated', () => {
    // The whole reason for an anchor over a chain. Generating 1B and 1C must
    // not change what 1D is conditioned on.
    const early = [{ id: 'a', shot_code: '1A', has_frame: true }, { id: 'd', shot_code: '1D', has_frame: false }];
    const later = [
        { id: 'a', shot_code: '1A', has_frame: true },
        { id: 'b', shot_code: '1B', has_frame: true },
        { id: 'c', shot_code: '1C', has_frame: true },
        { id: 'd', shot_code: '1D', has_frame: false },
    ];
    assert.strictEqual(pickAnchor(early, 'd', null).shot.id, pickAnchor(later, 'd', null).shot.id);
});

test('the anchor shot does not reference itself', () => {
    // A frame conditioned on itself is a loop: regenerating it can only
    // reproduce it, so the one frame a director most wants to revise is the one
    // they cannot.
    const shots = [{ id: 'a', shot_code: '1A', has_frame: true }];
    const r = pickAnchor(shots, 'a', null);
    assert.strictEqual(r.shot, null);
    assert.match(r.reason, /IS the scene anchor/);
});

test('every refusal carries a reason a director can act on', () => {
    // "No anchor" and "no anchor because you are standing on it" and "your pin
    // has no frame yet" need three different actions, and a bare null makes
    // them look identical.
    const cases = [
        // Nothing in the scene is generated yet.
        pickAnchor([{ id: 'a', shot_code: '1A', has_frame: false }], 'a', null),
        // This shot is itself the anchor.
        pickAnchor([{ id: 'a', shot_code: '1A', has_frame: true }], 'a', null),
        // The pinned shot has no frame to be an anchor with.
        pickAnchor([{ id: 'a', shot_code: '1A', has_frame: false }, { id: 'b', shot_code: '1B', has_frame: true }], 'b', 'a'),
        // The pin points at a shot that is not in this scene.
        pickAnchor([{ id: 'a', shot_code: '1A', has_frame: true }], 'a', 'gone'),
    ];
    const bad = cases.filter(c => c.shot === null && !c.reason);
    assert.strictEqual(bad.length, 0, 'a refusal gave no reason');
    // And they are not all the same sentence.
    assert.strictEqual(new Set(cases.map(c => c.reason)).size, cases.length,
        'two different refusals produced the same message');
});

test('a pin overrides the derived choice', () => {
    const shots = [
        { id: 'a', shot_code: '1A', has_frame: true },
        { id: 'b', shot_code: '1B', has_frame: true },
    ];
    assert.strictEqual(pickAnchor(shots, 'b', null).shot.shot_code, '1A');
    const pinned = pickAnchor(shots, 'a', 'b');
    assert.strictEqual(pinned.shot.shot_code, '1B');
    assert.strictEqual(pinned.pinned, true);
});

// ── What it says, and what it refuses to say ────────────────────────────

test('the anchor is the scene, not a colour swatch', () => {
    // This was first built the other way round — attached for grade only, with
    // a negative refusing to reuse its composition. A director who wants 1B to
    // keep 1A's street with the car exactly where it was cannot get there from
    // a swatch, and telling the model to ignore the placement throws away the
    // only thing the frame was attached for.
    const lead = anchorLeadPhrase('1a');
    assert.match(lead, /same location/i, 'the lead phrase does not carry the location');
    assert.match(lead, /set dressing/i, 'the lead phrase does not carry the dressing');
    assert.match(lead, /where they stand/i, 'the lead phrase does not carry subject placement');

    // And it must say it is a NEW camera, or "same scene as this picture" is
    // read as "reproduce this picture" and the camera facets arrive as
    // decoration on a copy.
    assert.match(lead, /re-shot|new camera/i,
        `nothing tells the model this is a different camera: "${lead}"`);

    // The negative refuses discontinuity, which is the failure mode now.
    for (const breaker of ['different location', 'rearranged props', 'different time of day']) {
        assert.ok(ANCHOR_NEGATIVE.includes(breaker),
            `the negative does not refuse "${breaker}"`);
    }
    assert.ok(!/copying the reference composition/.test(ANCHOR_NEGATIVE),
        'the negative still refuses the composition, which is what the anchor is FOR');
});

test('the anchor leads the prompt, and the new shot follows it', () => {
    // The order is the instruction. Whatever leads a prompt is what the image
    // is OF — and here that is true: the image IS that location with those
    // things in those places. What follows is the new camera on it.
    const card = {
        action: "The dragon's shadow sweeps across the street below.",
        camera: { shot_type: 'low-angle', lens: '24mm' }, characters: [],
    };
    const { prompt, negative_prompt } = buildStoryboardPrompt(card, [], null, 'noir',
        { anchorAttached: true, anchorTag: '1a' });

    assert.ok(prompt.indexOf('@1a') === 0 || prompt.indexOf('same scene') < 40,
        `the anchor does not lead the prompt:\n${prompt}`);
    assert.ok(prompt.indexOf('same location') < prompt.indexOf("dragon's shadow"),
        'the new action was stated before the world it happens in');
    assert.ok(prompt.indexOf("dragon's shadow") < prompt.indexOf('low angle shot'),
        'the camera change was stated before what the shot is of');
    assert.ok(prompt.includes('24mm lens'), 'the new lens never reached the prompt');
    assert.ok(negative_prompt.includes('different location'),
        'nothing refuses the scene quietly becoming a different one');
});

test('a shot with no anchor is untouched', () => {
    const card = { action: 'A street.', camera: { shot_type: 'wide' }, characters: [] };
    const without = buildStoryboardPrompt(card, [], null, 'noir', {});
    assert.ok(!/same scene as/i.test(without.prompt));
    assert.ok(!without.negative_prompt.includes('different location'),
        'the anchor negative was applied to a shot with no anchor');
});

test('an attached frame is addressed by tag, or as the first reference', () => {
    // It ranks first, so "the first reference image" is unambiguous — which is
    // what lets an untaggable provider use the anchor at all. Emitting "@1a"
    // there would put a literal token in the prompt beside an unexplained
    // picture.
    const card = { action: 'A street.', camera: {}, characters: [] };
    const tagged = buildStoryboardPrompt(card, [], null, 'noir', { anchorAttached: true, anchorTag: '1a' });
    assert.ok(tagged.prompt.includes('@1a'));

    const untagged = buildStoryboardPrompt(card, [], null, 'noir', { anchorAttached: true, anchorTag: null });
    assert.ok(!/@/.test(untagged.prompt), `a tag was emitted with no tag support: ${untagged.prompt}`);
    assert.ok(untagged.prompt.includes('first reference image'),
        'the untagged prompt never says which picture it means');
});

// ── Three slots ─────────────────────────────────────────────────────────

test('the anchor leads every plate, because it is not one', () => {
    // A plate says what a subject looks like in the abstract. The anchor has
    // already answered that for every subject in it — in situ, at the right
    // scale, lit the way the scene is lit — so ranking it behind the plates
    // would spend the slots re-establishing what the first reference fixed.
    assert.strictEqual(KIND_RANK.anchor, 0, 'a plate outranks the scene itself');
    assert.ok(KIND_RANK.character < KIND_RANK.location, 'a face is worth less than a porch');
    assert.ok(KIND_RANK.location < KIND_RANK.prop);
    assert.ok(KIND_RANK.prop < KIND_RANK.style);
});

test('a board with no anchor selects exactly the references it selected before', () => {
    // Adding a rank in the middle moves every rank below it. The RELATIVE order
    // is what selection depends on, so this must be a no-op for every project
    // that never turns the feature on.
    const candidates = [
        { name: 'STREET', kind: 'location', file_path: framePath('rank-loc') },
        { name: 'SPRINKLER', kind: 'prop', file_path: framePath('rank-prop') },
        { name: 'MAYA', kind: 'character', file_path: framePath('rank-char') },
        { name: 'BOARD', kind: 'style', file_path: framePath('rank-style') },
    ];
    const picked = selectReferences(candidates).map(r => r.kind);
    assert.deepStrictEqual(picked, ['character', 'location', 'prop']);
});

test('with more candidates than slots, the anchor takes the first', () => {
    const picked = selectReferences([
        { name: 'STREET', kind: 'location', file_path: framePath('slot-loc') },
        { name: '1A', kind: 'anchor', file_path: framePath('slot-anchor') },
        { name: 'MAYA', kind: 'character', file_path: framePath('slot-char') },
        { name: 'SPRINKLER', kind: 'prop', file_path: framePath('slot-prop') },
    ]).map(r => r.kind);
    assert.strictEqual(picked.length, MAX_REFERENCES);
    assert.deepStrictEqual(picked, ['anchor', 'character', 'location']);
});

test('the anchor is tagged by the shot it is, so two scenes cannot collide', () => {
    const refs = selectReferences([
        { name: '1A', kind: 'anchor', file_path: framePath('tag-1a') },
        { name: '2A', kind: 'anchor', file_path: framePath('tag-2a') },
    ]);
    assert.strictEqual(refs[0].tag, '1a');
    assert.notStrictEqual(refs[0].tag, refs[1].tag);
});

// ── Against a real database ─────────────────────────────────────────────

test('the anchor resolves to a readable frame in the same scene', () => {
    const { shots } = makeScene(['1A', '1B', '1C'], ['1A', '1B'], { enabled: true });
    const r = sceneAnchorFor(db, shots['1C']);
    assert.strictEqual(r.shot.shot_code, '1A');
    assert.ok(r.asset && r.asset.file_path, 'no file was resolved for the anchor');
    assert.ok(anchorCandidate(r), 'the anchor did not become a reference candidate');
});

test('an anchor never crosses a scene', () => {
    const a = makeScene(['1A', '1B'], ['1A'], { enabled: true });
    const b = makeScene(['2A', '2B'], ['2A'], { enabled: true });
    assert.strictEqual(sceneAnchorFor(db, a.shots['1B']).shot.shot_code, '1A');
    assert.strictEqual(sceneAnchorFor(db, b.shots['2B']).shot.shot_code, '2A');
});

test('a scene with no generated frame has no anchor, and says why', () => {
    const { shots } = makeScene(['1A', '1B'], [], { enabled: true });
    const r = sceneAnchorFor(db, shots['1B']);
    assert.strictEqual(r.shot, null);
    assert.match(r.reason, /no frame/);
});

test('pinning is refused for a shot in another scene', async () => {
    const { handleScenes } = require('../routes/scenes');
    const a = makeScene(['1A', '1B'], ['1A'], { enabled: true });
    const b = makeScene(['2A'], ['2A'], { enabled: true });
    const r = await callRoute(handleScenes, 'PUT', `/film/scenes/${a.sceneId}/anchor`,
        { shot_id: b.shots['2A'] });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /not in this scene/);
});

test('pinning changes which frame a scene is measured against, and unpinning restores the derived one', async () => {
    const { handleScenes } = require('../routes/scenes');
    const { sceneId, shots } = makeScene(['1A', '1B', '1C'], ['1A', '1B'], { enabled: true });
    assert.strictEqual(sceneAnchorFor(db, shots['1C']).shot.shot_code, '1A');

    const set = await callRoute(handleScenes, 'PUT', `/film/scenes/${sceneId}/anchor`, { shot_id: shots['1B'] });
    assert.strictEqual(set.status, 200);
    const pinned = sceneAnchorFor(db, shots['1C']);
    assert.strictEqual(pinned.shot.shot_code, '1B');
    assert.strictEqual(pinned.pinned, true);

    const cleared = await callRoute(handleScenes, 'DELETE', `/film/scenes/${sceneId}/anchor`);
    assert.strictEqual(cleared.status, 200);
    assert.strictEqual(sceneAnchorFor(db, shots['1C']).shot.shot_code, '1A');
});

test('deleting the pinned shot falls back rather than refusing the delete', () => {
    // ON DELETE SET NULL. A pin that blocked a delete, or that survived as a
    // pointer to a shot that is gone, would both be worse than falling back.
    const { sceneId, shots } = makeScene(['1A', '1B', '1C'], ['1A', '1B'], { enabled: true });
    db.prepare('UPDATE film_scenes SET anchor_shot_id = ? WHERE id = ?').run(shots['1B'], sceneId);
    db.prepare('DELETE FROM film_shots WHERE id = ?').run(shots['1B']);
    const row = db.prepare('SELECT anchor_shot_id FROM film_scenes WHERE id = ?').get(sceneId);
    assert.strictEqual(row.anchor_shot_id, null, 'the pin outlived the shot it pointed at');
    assert.strictEqual(sceneAnchorFor(db, shots['1C']).shot.shot_code, '1A');
});

// ── It replaces the plates it makes redundant ───────────────────────────

test('a subject standing in the anchor does not also get a plate', () => {
    // The point of anchoring 1B on 1A is that 1A already shows MAYA on that
    // street. Sending her plate as well spends one of three slots telling the
    // model what she looks like in the abstract — a slot a subject who is NOT
    // in 1A could have used, and those are the ones that still need one.
    const { shots, projectId } = makeScene(['1A', '1B'], ['1A'], { enabled: true, provider: 'runway' });

    // MAYA is on 1A's card and has a plate. THE DRAGON is new in 1B.
    const maya = generateId(), dragon = generateId();
    for (const [id, name] of [[maya, 'MAYA'], [dragon, 'DRAGON']]) {
        db.prepare('INSERT INTO film_characters (id, project_id, name, appearance_prompt) VALUES (?, ?, ?, ?)')
            .run(id, projectId, name, name + ' looks a certain way');
        db.prepare(`INSERT INTO film_assets (id, project_id, character_id, asset_type, file_name, file_path, version)
                    VALUES (?, ?, ?, 'character_sheet', ?, ?, 1)`)
            .run(generateId(), projectId, id, name + '.png', framePath('cover-' + name));
    }
    db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?')
        .run(JSON.stringify({ shot_code: '1A', action: 'Wide.', characters: ['MAYA'] }), shots['1A']);

    const anchor = sceneAnchorFor(db, shots['1B']);
    const covered = subjectsCoveredBy(db, anchor);
    assert.ok(covered.has('MAYA'), 'the anchor card lists MAYA and she was not counted as covered');
    assert.ok(!covered.has('DRAGON'), 'a subject absent from the anchor was treated as covered');

    const { references } = shotReferencesFor(db, {
        projectId, providerConfig: { image: 'runway' }, anchor,
        characters: [
            { id: maya, name: 'MAYA' },
            { id: dragon, name: 'DRAGON' },
        ],
    });
    const kinds = references.map(r => `${r.kind}:${r.name}`);
    assert.ok(kinds.includes('anchor:1A'), 'the anchor frame was not attached');
    assert.ok(!kinds.includes('character:MAYA'),
        `MAYA is in the anchor and her plate went too: ${kinds.join(', ')}`);
    assert.ok(kinds.includes('character:DRAGON'),
        `the subject that is NOT in the anchor lost its plate: ${kinds.join(', ')}`);
});

test('a covered subject keeps its words even though its plate went', () => {
    // A redundant description costs room; a missing one costs the shot. Only
    // the PLATE is dropped — the appearance still travels, because the anchor
    // covering a subject is inferred from a card rather than seen in a picture.
    const card = { action: 'MAYA turns.', characters: ['MAYA'], camera: {} };
    const chars = [{ id: 'm', name: 'MAYA', appearance_prompt: 'rust-orange cardigan, dark bob' }];
    const { prompt } = buildStoryboardPrompt(card, chars, null, 'noir',
        { anchorAttached: true, anchorTag: '1a' });
    assert.ok(prompt.includes('rust-orange cardigan'),
        'a subject whose plate was dropped for the anchor lost its description too');
});

test('the location plate stands down entirely for an anchor', () => {
    // The anchor IS the location, rendered. Its plate is the most redundant of
    // all when a frame of the place is already attached.
    const { shots, projectId } = makeScene(['1A', '1B'], ['1A'], { enabled: true, provider: 'runway' });
    const locId = generateId();
    db.prepare('INSERT INTO film_locations (id, project_id, name, description) VALUES (?, ?, ?, ?)')
        .run(locId, projectId, 'STREET', 'a cul-de-sac');
    db.prepare(`INSERT INTO film_assets (id, project_id, location_id, asset_type, file_name, file_path, version)
                VALUES (?, ?, ?, 'reference_image', 'street.png', ?, 1)`)
        .run(generateId(), projectId, locId, framePath('cover-street'));

    const anchor = sceneAnchorFor(db, shots['1B']);
    const withAnchor = shotReferencesFor(db, {
        projectId, providerConfig: { image: 'runway' }, anchor,
        location: { id: locId, name: 'STREET' },
    }).references.map(r => r.kind);
    assert.deepStrictEqual(withAnchor, ['anchor'], 'the location plate rode along beside the anchor');

    const withoutAnchor = shotReferencesFor(db, {
        projectId, providerConfig: { image: 'runway' }, anchor: null,
        location: { id: locId, name: 'STREET' },
    }).references.map(r => r.kind);
    assert.deepStrictEqual(withoutAnchor, ['location'],
        'with no anchor the location plate must still go');
});

// ── Default off, and reported ───────────────────────────────────────────

test('a new project has no scene anchor', () => {
    const { handleProjects } = require('../routes/projects');
    return callRoute(handleProjects, 'POST', '/film/projects', { title: 'Fresh' }).then(r => {
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        const row = db.prepare('SELECT scene_anchor_refs FROM film_projects WHERE id = ?').get(r.body.id);
        assert.ok(!row.scene_anchor_refs, 'a new project shipped conditioning frames on other frames');
    });
});

test('the project route can turn it on and off', async () => {
    const { handleProjects } = require('../routes/projects');
    const { projectId } = makeScene(['1A'], ['1A'], { enabled: false });
    await callRoute(handleProjects, 'PUT', `/film/projects/${projectId}`, { scene_anchor_refs: 1 });
    assert.strictEqual(db.prepare('SELECT scene_anchor_refs FROM film_projects WHERE id = ?').get(projectId).scene_anchor_refs, 1);
    await callRoute(handleProjects, 'PUT', `/film/projects/${projectId}`, { scene_anchor_refs: 0 });
    assert.strictEqual(db.prepare('SELECT scene_anchor_refs FROM film_projects WHERE id = ?').get(projectId).scene_anchor_refs, 0);
});

test('the board says which frame each scene is measured against', async () => {
    const { handleStoryboard } = require('../routes/storyboard');
    const { projectId, shots } = makeScene(['1A', '1B'], ['1A', '1B'], { enabled: true });
    const r = await callRoute(handleStoryboard, 'GET', `/film/projects/${projectId}/storyboard`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.scene_anchor_refs, true);
    const byCode = Object.fromEntries(r.body.frames.map(f => [f.shot_code, f]));
    assert.strictEqual(byCode['1A'].anchor.is_anchor, true, '1A is the first framed shot and is not marked as the anchor');
    assert.strictEqual(byCode['1B'].anchor.is_anchor, false);
    assert.strictEqual(byCode['1B'].anchor.shot_code, '1A', 'a non-anchor frame does not say which frame is');
    assert.ok(shots['1A']);
});

test('the free preview reports the anchor and does not pretend to apply it', async () => {
    const { handleStoryboard } = require('../routes/storyboard');
    const { shots } = makeScene(['1A', '1B'], ['1A'], { enabled: true, provider: 'runway' });
    const r = await callRoute(handleStoryboard, 'GET', `/film/shots/${shots['1B']}/prompt`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.scene_anchor.shot_code, '1A');
    assert.strictEqual(r.body.scene_anchor.attached, true,
        'the anchor was resolved but never claimed a reference slot');
    assert.ok(r.body.scene_anchor.adds.includes('light'),
        'the preview does not show the phrase the anchor adds');
    // The prompt IS what generation sends now that the shared payload gathers
    // plates, so the preview must not be reporting something the prompt lacks.
    assert.ok(r.body.prompt.includes('@' + r.body.scene_anchor.shot_code.toLowerCase()),
        'the preview reports an anchor its own prompt does not name');
    assert.ok(r.body.scene_anchor.note, 'the preview does not say how its prompt relates to generation');
});

test('an untaggable provider gets the picture but never the tag', () => {
    // Two gates that fail differently. Without a slot the tag points at
    // nothing; without tag support the model reads "@1a" as literal text and
    // the picture arrives unexplained beside the plates. The route paths gate
    // before resolving, so this pins the rule for the shared gatherer that the
    // orchestrated path uses — where it was missing, and a live run emitted
    // "@1a" to a provider that cannot read one.
    const { shotReferencesFor } = require('../lib/shot-references');
    const { shots, projectId } = makeScene(['1A', '1B'], ['1A'], { enabled: true });
    const anchor = sceneAnchorFor(db, shots['1B']);
    assert.ok(anchor.shot, 'the fixture produced no anchor to test with');

    // gridlight takes reference images and cannot name them; runway can.
    const untagged = shotReferencesFor(db, { projectId, providerConfig: { image: 'gridlight' }, anchor });
    assert.ok(untagged.references.some(r => r.kind === 'anchor'),
        'the picture was withheld from a provider that can take pictures');
    assert.strictEqual(untagged.anchorTag, null,
        'a tag was emitted to a provider that reads it as literal text');

    const tagged = shotReferencesFor(db, { projectId, providerConfig: { image: 'runway' }, anchor });
    assert.strictEqual(tagged.anchorTag, '1a', 'a tag-capable provider was not given the tag');
});

// ── The page ────────────────────────────────────────────────────────────

test('the board carries the switch and a per-frame anchor control', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const missing = [];
    if (!html.includes('id="sceneAnchorToggle"')) missing.push('the toggle itself');
    if (!/onchange="setSceneAnchorRefs/.test(html)) missing.push('the toggle is wired to nothing');
    if (!/function setSceneAnchorRefs/.test(html)) missing.push('setSceneAnchorRefs is not defined');
    if (!/scene_anchor_refs/.test(html)) missing.push('nothing writes the project field');
    if (!/function anchorButton/.test(html)) missing.push('the per-frame control is not built');
    if (!/\$\{anchorButton\(f\)\}/.test(html)) missing.push('the per-frame control is never rendered');
    for (const fn of ['pinSceneAnchor', 'clearSceneAnchor']) {
        if (!new RegExp('function ' + fn).test(html)) missing.push(fn + ' is not defined');
    }
    assert.deepStrictEqual(missing, [], `\n  ${missing.join('\n  ')}`);
});
