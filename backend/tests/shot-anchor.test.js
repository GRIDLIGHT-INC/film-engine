/**
 * The frame you are currently shooting from.
 *
 * Board generation never looked at another frame: a keyframe was conditioned on
 * character plates, a location plate and a mood-board image — every one a
 * picture of something in the abstract — so 1B rebuilt the street from scratch
 * and put the well, the cart and the light somewhere else than 1A had.
 *
 * Two design mistakes are pinned here as tests, because both looked right and
 * both were found by using the thing:
 *
 *   1. **The anchor was attached for GRADE**, with a negative refusing to reuse
 *      its composition. A director who wants 1B to keep 1A's street with the
 *      cart exactly where it was cannot get there from a colour swatch. It
 *      carries the world now, and the camera change is what stops it being a
 *      duplicate.
 *
 *   2. **It was a standing property of every SCENE**, derived automatically
 *      from the first shot with a frame — so anchoring 1A lit up an anchor on
 *      2A as well. Anchoring is something a director picks up while working on
 *      1B and 1C and puts down afterwards. Exactly one, explicit, cleared in a
 *      click.
 *
 * The third property is the one nobody would notice going wrong: it must
 * REPLACE the plates it makes redundant, or the whole point — three reference
 * slots spent on the scene rather than on descriptions of things already in it
 * — is lost while everything still appears to work.
 */

const test = require('node:test');
/*
 * These assert what an UNTAGGABLE provider receives, and the local gateway is
 * the untaggable one they use. It is off unless switched on, so without this
 * the config resolves to a refusing adapter and the assertions are about
 * nothing. Set before the registry is required, which caches the answer.
 */
process.env.GRIDLIGHT_ENABLED = '1';
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
    pickAnchor, anchorPhrase, anchorLeadPhrase, ANCHOR_NEGATIVE, activeAnchorFor,
    anchorCandidate, subjectsCoveredBy,
} = require('../lib/shot-anchor');
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
    db.prepare('INSERT INTO film_projects (id, title, provider_config) VALUES (?, ?, ?)')
        .run(projectId, 'Anchor Test', JSON.stringify(o.provider ? { image: o.provider } : {}));
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'STREET')")
        .run(sceneId, projectId);
    const shots = {};
    for (const code of shotCodes) {
        const id = generateId();
        db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
            .run(id, sceneId, code, JSON.stringify({ shot_code: code, action: 'A street.', camera: {} }));
        shots[code] = id;
        if ((framed || []).includes(code)) {
            // Written where the app really keeps a live frame, so `is_current`
            // — which compares the asset's path to the live one — means the
            // same thing here as it does in the product.
            const dir = path.join(process.env.FILM_DATA_DIR, 'storyboards', projectId);
            fs.mkdirSync(dir, { recursive: true });
            const live = path.join(dir, code + '.png');
            fs.writeFileSync(live, PNG);
            db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version)
                        VALUES (?, ?, ?, 'storyboard', ?, ?, 1)`)
                .run(generateId(), projectId, id, code + '.png', live);
        }
    }
    return { projectId, sceneId, shots };
}

/** Pick up the anchor, the way the route does. */
function anchorOn(projectId, shotId) {
    db.prepare('UPDATE film_projects SET anchor_shot_id = ? WHERE id = ?').run(shotId, projectId);
}

// ── One anchor, held deliberately ───────────────────────────────────────

test('nothing is an anchor until somebody sets one', () => {
    // The version this replaces DERIVED one per scene — the first shot with a
    // frame — so anchoring 1A lit up an anchor badge on 2A as well, because
    // scene 2 had quietly appointed its own. Anchoring is a tool a director
    // picks up and puts down, not a property every scene has.
    const r = pickAnchor(null, 'anything');
    assert.strictEqual(r.shot, null);
    assert.match(r.reason, /no anchor is set/);
});

test('the anchor shot generates from its own card, not from itself', () => {
    // A frame conditioned on itself is a loop: it could only reproduce itself,
    // so the one frame a director most wants to revise would be the one they
    // cannot.
    const r = pickAnchor('a', 'a');
    assert.strictEqual(r.shot, null);
    assert.match(r.reason, /IS the anchor/);
});

test('every other shot resolves to the one active anchor', () => {
    for (const target of ['b', 'c', 'z']) {
        assert.strictEqual(pickAnchor('a', target).shot.id, 'a',
            `${target} did not resolve to the active anchor`);
    }
});

test('each refusal says something different, because each needs a different action', () => {
    const reasons = [pickAnchor(null, 'x').reason, pickAnchor('a', 'a').reason];
    assert.ok(reasons.every(Boolean), 'a refusal gave no reason');
    assert.strictEqual(new Set(reasons).size, reasons.length,
        'two different refusals produced the same message');
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

test('the anchor resolves to a readable frame', () => {
    const { projectId, shots } = makeScene(['1A', '1B'], ['1A']);
    anchorOn(projectId, shots['1A']);
    const r = activeAnchorFor(db, shots['1B']);
    assert.strictEqual(r.shot.shot_code, '1A');
    assert.ok(r.asset && r.asset.file_path, 'no file was resolved for the anchor');
    assert.ok(anchorCandidate(r), 'the anchor did not become a reference candidate');
});

test('anchoring one shot leaves every other scene alone', () => {
    // The exact defect that prompted the rewrite: an anchor badge appearing on
    // 2A because scene 2 had derived its own.
    const { handleStoryboard } = require('../routes/storyboard');
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Two scenes');
    const shots = {};
    for (const [n, codes] of [['1', ['1A', '1B']], ['2', ['2A', '2B']]]) {
        const sceneId = generateId();
        db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, ?, ?)')
            .run(sceneId, projectId, n, 'STREET');
        for (const code of codes) {
            const id = generateId();
            db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
                .run(id, sceneId, code, JSON.stringify({ shot_code: code, action: 'x', camera: {} }));
            db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version)
                        VALUES (?, ?, ?, 'storyboard', ?, ?, 1)`)
                .run(generateId(), projectId, id, code + '.png', framePath(projectId + '-' + code));
            shots[code] = id;
        }
    }
    anchorOn(projectId, shots['1A']);

    return callRoute(handleStoryboard, 'GET', `/film/projects/${projectId}/storyboard`).then(r => {
        const flagged = r.body.frames.filter(f => f.anchor.is_anchor).map(f => f.shot_code);
        assert.deepStrictEqual(flagged, ['1A'],
            `anchoring 1A marked other frames as anchors too: ${flagged.join(', ')}`);
        assert.strictEqual(r.body.anchor_shot_id, shots['1A']);
    });
});

test('an anchor in another scene is allowed and said out loud', () => {
    // Two scenes in one location is a real reason to anchor across them; two
    // scenes in different locations is how a director gets the wrong street
    // back and cannot see why. Said rather than refused, because only they know
    // which case it is.
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Cross');
    const mk = (n, code) => {
        const sceneId = generateId(), id = generateId();
        db.prepare('INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, ?, ?)')
            .run(sceneId, projectId, n, 'STREET');
        db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
            .run(id, sceneId, code, JSON.stringify({ shot_code: code, camera: {} }));
        db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version)
                    VALUES (?, ?, ?, 'storyboard', ?, ?, 1)`)
            .run(generateId(), projectId, id, code + '.png', framePath(projectId + '-' + code));
        return id;
    };
    const a1 = mk('1', '1A'), b1 = mk('2', '2A');
    anchorOn(projectId, a1);
    const r = activeAnchorFor(db, b1);
    assert.strictEqual(r.shot.shot_code, '1A', 'a cross-scene anchor was silently dropped');
    assert.ok(r.cross_scene, 'nothing warned that the anchor is from another scene');
    assert.match(r.cross_scene, /scene/);
});

test('an anchor whose frame is gone falls back rather than pretending', () => {
    const { projectId, shots } = makeScene(['1A', '1B'], []);
    anchorOn(projectId, shots['1A']);
    const r = activeAnchorFor(db, shots['1B']);
    assert.strictEqual(r.shot, null);
    assert.match(r.reason, /no generated frame/);
});

test('deleting the anchored shot clears the anchor rather than refusing the delete', () => {
    const { projectId, shots } = makeScene(['1A', '1B'], ['1A']);
    anchorOn(projectId, shots['1A']);
    db.prepare('DELETE FROM film_shots WHERE id = ?').run(shots['1A']);
    const row = db.prepare('SELECT anchor_shot_id FROM film_projects WHERE id = ?').get(projectId);
    assert.strictEqual(row.anchor_shot_id, null, 'the anchor outlived the shot it pointed at');
});

// ── It replaces the plates it makes redundant ───────────────────────────

test('a subject standing in the anchor does not also get a plate', () => {
    // The point of anchoring 1B on 1A is that 1A already shows MAYA on that
    // street. Sending her plate as well spends one of three slots telling the
    // model what she looks like in the abstract — a slot a subject who is NOT
    // in 1A could have used, and those are the ones that still need one.
    const { shots, projectId } = makeScene(['1A', '1B'], ['1A'], { provider: 'runway' });
    anchorOn(projectId, shots['1A']);

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

    const anchor = activeAnchorFor(db, shots['1B']);
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
    const { shots, projectId } = makeScene(['1A', '1B'], ['1A'], { provider: 'runway' });
    anchorOn(projectId, shots['1A']);
    const locId = generateId();
    db.prepare('INSERT INTO film_locations (id, project_id, name, description) VALUES (?, ?, ?, ?)')
        .run(locId, projectId, 'STREET', 'a cul-de-sac');
    db.prepare(`INSERT INTO film_assets (id, project_id, location_id, asset_type, file_name, file_path, version)
                VALUES (?, ?, ?, 'reference_image', 'street.png', ?, 1)`)
        .run(generateId(), projectId, locId, framePath('cover-street'));

    const anchor = activeAnchorFor(db, shots['1B']);
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

test('a subject standing in the anchor keeps its name and loses its paragraph', () => {
    // Dropping the PLATE was only half of it. The locked contracts are appended
    // later by applyConsistencyToImagePayload, which knew nothing about the
    // anchor — so a real 1B sent 3,990 characters against a 4,000 ceiling, of
    // which 2,517 described a street, a sprinkler and a car all plainly visible
    // in the frame travelling beside them. Two pictures saved, the entire
    // budget spent re-describing what they showed.
    const { applyConsistencyToImagePayload } = require('../lib/consistency-apply');
    const items = [
        { subject_name: 'SEDAN', profile_type: 'prop',
          text: 'Late-1970s full-size four-door sedan. Dark forest green enamel, oxidised to '
              + 'chalky matte across the hood. Rust blistering along the lower door seams and '
              + 'both rear wheel arches, edges lifted and flaking to orange-brown.' },
        { subject_name: 'DRAGON', profile_type: 'character',
          text: 'Ash-grey scales over a lean frame. Torn wing membrane, the tear old and '
              + 'healed at the edges. Amber eye with a slit pupil.' },
    ];
    // The flat array is what gates the append; the items carry the per-subject
    // detail the trimmer works from. Both travel, as the routes send them.
    const ctx = { prompt_addition_items: items, prompt_additions: items.map(i => i.text) };
    const base = { prompt: 'A street.', negative_prompt: '' };

    const full = applyConsistencyToImagePayload(base, ctx, { maxPromptChars: 4000 });
    const short = applyConsistencyToImagePayload(base, ctx, {
        maxPromptChars: 4000, anchorCovers: ['SEDAN'],
    });

    assert.ok(short.prompt.length < full.prompt.length,
        'the covered subject was not shortened at all');
    assert.ok(short.prompt.includes('SEDAN'),
        'the covered subject lost its NAME — it now travels as nothing, which is the '
        + 'failure the contract shortening was reverted for');
    assert.ok(!short.prompt.includes('Rust blistering'),
        'the paragraph describing what the anchor already shows was still sent');
    assert.ok(short.prompt.includes('Torn wing membrane'),
        'a subject the anchor does NOT show lost its description too');
});

test('the place is covered too, but only when the anchor is in the same scene', () => {
    // The anchor covers the location most completely of all — it is a
    // photograph of it rather than a description. Its PLATE already stands down
    // for an anchor, and leaving its paragraph in was an inconsistency that
    // cost 856 characters on a real shot.
    //
    // Across scenes the anchor is a picture of a DIFFERENT place, so dropping
    // this location's description would leave the one thing the frame does not
    // show travelling as a bare name.
    const { projectId, shots } = makeScene(['1A', '1B'], ['1A']);
    anchorOn(projectId, shots['1A']);
    const same = subjectsCoveredBy(db, activeAnchorFor(db, shots['1B']));
    assert.ok(same.has('STREET'), 'the location was not covered by an anchor of the same scene');

    const anchor = activeAnchorFor(db, shots['1B']);
    const across = subjectsCoveredBy(db, { ...anchor, cross_scene: 'different scene' });
    assert.ok(!across.has('STREET'),
        'a cross-scene anchor dropped the description of a place it does not show');
});

test('nothing is shortened unless the anchor really travelled', () => {
    // Shortening against a picture that is not in the payload leaves the
    // subject with neither words nor image. The caller passes anchorCovers only
    // when the frame actually claimed a slot; this pins the default.
    const { applyConsistencyToImagePayload } = require('../lib/consistency-apply');
    const items = [{
        subject_name: 'SEDAN', profile_type: 'prop',
        text: 'Late-1970s sedan. Rust blistering along the lower door seams.',
    }];
    const ctx = { prompt_addition_items: items, prompt_additions: items.map(i => i.text) };
    const p = applyConsistencyToImagePayload({ prompt: 'A street.', negative_prompt: '' }, ctx,
        { maxPromptChars: 4000 });
    assert.ok(p.prompt.includes('Rust blistering'),
        'a contract was shortened with no anchor in the payload');
});

// ── Setting it is turning it on ─────────────────────────────────────────

test('a new project has no anchor', () => {
    const { handleProjects } = require('../routes/projects');
    return callRoute(handleProjects, 'POST', '/film/projects', { title: 'Fresh' }).then(r => {
        assert.strictEqual(r.status, 201, JSON.stringify(r.body));
        const row = db.prepare('SELECT anchor_shot_id FROM film_projects WHERE id = ?').get(r.body.id);
        assert.strictEqual(row.anchor_shot_id, null, 'a new project shipped already shooting from a frame');
    });
});

test('setting an anchor replaces the last one', async () => {
    // One at a time is the whole model. Two live anchors is the state the
    // per-scene version produced and nobody could reason about.
    const { handleProjects } = require('../routes/projects');
    const { projectId, shots } = makeScene(['1A', '1B', '1C'], ['1A', '1B']);

    let r = await callRoute(handleProjects, 'PUT', `/film/projects/${projectId}/anchor`, { shot_id: shots['1A'] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.shot_code, '1A');

    r = await callRoute(handleProjects, 'PUT', `/film/projects/${projectId}/anchor`, { shot_id: shots['1B'] });
    assert.strictEqual(r.body.shot_code, '1B');
    assert.strictEqual(
        db.prepare('SELECT anchor_shot_id FROM film_projects WHERE id = ?').get(projectId).anchor_shot_id,
        shots['1B'], 'setting a second anchor left the first one live');
});

test('anchoring a frame that does not exist yet is refused, not accepted and ignored', async () => {
    // Accepted-and-ignored looks exactly like the feature not working: the
    // badge appears and generation quietly falls back to plates.
    const { handleProjects } = require('../routes/projects');
    const { projectId, shots } = makeScene(['1A', '1B'], ['1A']);
    const r = await callRoute(handleProjects, 'PUT', `/film/projects/${projectId}/anchor`, { shot_id: shots['1B'] });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /no generated frame/);
    assert.ok(r.body.hint, 'the refusal does not say what to do about it');
});

test('a shot from another project cannot be anchored', async () => {
    const { handleProjects } = require('../routes/projects');
    const a = makeScene(['1A'], ['1A']);
    const b = makeScene(['9A'], ['9A']);
    const r = await callRoute(handleProjects, 'PUT', `/film/projects/${a.projectId}/anchor`, { shot_id: b.shots['9A'] });
    assert.strictEqual(r.status, 400);
});

test('clearing puts it down and the shots go back to plates', async () => {
    const { handleProjects } = require('../routes/projects');
    const { projectId, shots } = makeScene(['1A', '1B'], ['1A']);
    anchorOn(projectId, shots['1A']);
    const r = await callRoute(handleProjects, 'DELETE', `/film/projects/${projectId}/anchor`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.anchor_shot_id, null);
    assert.strictEqual(activeAnchorFor(db, shots['1B']).shot, null);
});

test('one call can skip the anchor without putting it down', async () => {
    // "Generate this one from plates" is a different action from "stop working
    // this way", and folding them together means clearing and re-setting the
    // anchor to try one shot.
    const { handleStoryboard } = require('../routes/storyboard');
    const { projectId, shots } = makeScene(['1A', '1B'], ['1A'], { provider: 'runway' });
    anchorOn(projectId, shots['1A']);
    const r = await callRoute(handleStoryboard, 'GET', `/film/shots/${shots['1B']}/prompt`);
    assert.strictEqual(r.body.anchor.attached, true, 'the anchor did not reach the shot at all');
    // The route flag is read by the generation paths; the preview reports the
    // standing state, which is what a director checks before pressing Regen.
    assert.ok(r.body.anchor.note);
});

test('the free preview reports the frame and the prompt names it', async () => {
    const { handleStoryboard } = require('../routes/storyboard');
    const { projectId, shots } = makeScene(['1A', '1B'], ['1A'], { provider: 'runway' });
    anchorOn(projectId, shots['1A']);
    const r = await callRoute(handleStoryboard, 'GET', `/film/shots/${shots['1B']}/prompt`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.anchor.shot_code, '1A');
    assert.strictEqual(r.body.anchor.attached, true);
    assert.ok(r.body.anchor.adds.includes('light'));
    assert.ok(r.body.prompt.includes('@1a'),
        'the preview reports an anchor its own prompt does not name');
});

test('the anchor itself previews with no anchor, and says why', async () => {
    const { handleStoryboard } = require('../routes/storyboard');
    const { projectId, shots } = makeScene(['1A', '1B'], ['1A'], { provider: 'runway' });
    anchorOn(projectId, shots['1A']);
    const r = await callRoute(handleStoryboard, 'GET', `/film/shots/${shots['1A']}/prompt`);
    assert.strictEqual(r.body.anchor.attached, false);
    assert.match(r.body.anchor.reason, /IS the anchor/);
    assert.ok(!r.body.prompt.includes('@1a'), 'the anchor frame was conditioned on itself');
});

test('an untaggable provider gets the picture but never the tag', () => {
    // Two gates that fail differently. Without a slot the tag points at
    // nothing; without tag support the model reads "@1a" as literal text.
    const { shotReferencesFor } = require('../lib/shot-references');
    const { projectId, shots } = makeScene(['1A', '1B'], ['1A']);
    anchorOn(projectId, shots['1A']);
    const anchor = activeAnchorFor(db, shots['1B']);
    assert.ok(anchor.shot, 'the fixture produced no anchor to test with');

    const untagged = shotReferencesFor(db, { projectId, providerConfig: { image: 'gridlight' }, anchor });
    assert.ok(untagged.references.some(r => r.kind === 'anchor'),
        'the picture was withheld from a provider that can take pictures');
    assert.strictEqual(untagged.anchorTag, null,
        'a tag was emitted to a provider that reads it as literal text');

    const tagged = shotReferencesFor(db, { projectId, providerConfig: { image: 'runway' }, anchor });
    assert.strictEqual(tagged.anchorTag, '1a', 'a tag-capable provider was not given the tag');
});

// ── The page ────────────────────────────────────────────────────────────

test('the board can pick the anchor up, show it, and put it down', () => {
    // A button wired to nothing looks identical to a working one until clicked.
    // There is no on/off checkbox any more: setting the anchor IS turning it
    // on, so the page must not have re-grown one.
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const missing = [];
    if (!/function anchorButton/.test(html)) missing.push('the per-frame control is not built');
    if (!/\$\{anchorButton\(f\)\}/.test(html)) missing.push('the per-frame control is never rendered');
    for (const fn of ['setAnchor', 'clearAnchor', 'renderAnchorChip']) {
        if (!new RegExp('function ' + fn).test(html)) missing.push(fn + ' is not defined');
    }
    if (!/onclick="setAnchor\(/.test(html)) missing.push('nothing picks the anchor up');
    if (!/onclick="clearAnchor\(/.test(html)) missing.push('nothing puts the anchor down');
    if (!html.includes('id="anchorChip"')) missing.push('nothing says which frame is being shot from');
    if (/scene_anchor_refs|sceneAnchorToggle/.test(html)) {
        missing.push('the retired per-scene switch is still on the page');
    }
    assert.deepStrictEqual(missing, [], `\n  ${missing.join('\n  ')}`);
});


// ── Every attempt, and the way back to one ──────────────────────────────

test('selecting a version changes what is shown and destroys nothing', async () => {
    /*
     * Selecting must not truncate history to the version chosen: that would
     * destroy the attempts made after it, and make selecting destructive on the
     * one list whose whole purpose is that nothing is lost.
     *
     * It used to protect that by moving FORWARD — copying the chosen attempt to
     * a new highest version. History was safe and the count became a lie: three
     * generations plus one selection read as four attempts. Selecting is a
     * pointer now, so the count keeps meaning "images generated" and the
     * attempts are all still there.
     */
    const { handleStoryboard } = require('../routes/storyboard');
    const os_ = require('os');
    const { projectId, shots } = makeScene(['1A'], ['1A']);
    const shotId = shots['1A'];

    const dir = fs.mkdtempSync(path.join(os_.tmpdir(), 'restore-'));
    for (const v of [2, 3]) {
        const f = path.join(dir, `1A_v${v}.png`);
        fs.writeFileSync(f, PNG);
        db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version)
                    VALUES (?, ?, ?, 'storyboard', ?, ?, ?)`)
            .run(generateId(), projectId, shotId, `1A_v${v}.png`, f, v);
    }

    const before = await callRoute(handleStoryboard, 'GET', `/film/shots/${shotId}/frames`);
    assert.strictEqual(before.status, 200);
    assert.strictEqual(before.body.versions.length, 3, 'not every attempt was listed');
    assert.ok(before.body.note, 'the list does not say what selecting does');

    const r = await callRoute(handleStoryboard, 'POST', `/film/shots/${shotId}/frames/2/restore`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.version, 2, 'selecting v2 reported a different version');

    const after = await callRoute(handleStoryboard, 'GET', `/film/shots/${shotId}/frames`);
    assert.strictEqual(after.body.versions.length, before.body.versions.length,
        'selecting an attempt changed how many attempts exist');
    assert.deepStrictEqual(
        after.body.versions.map(v => v.version).sort((a, b) => a - b),
        before.body.versions.map(v => v.version).sort((a, b) => a - b),
        'selecting an attempt changed WHICH attempts exist');
    assert.strictEqual(after.body.versions.find(v => v.is_current).version, 2,
        'the board is not showing the version that was selected');
});

test('exactly one listed version is the frame on the board', () => {
    // "Which of these am I looking at" is the question the list exists to
    // answer, and after a restore the highest version is NOT the newest
    // picture — so it cannot be inferred from the number.
    const { handleStoryboard } = require('../routes/storyboard');
    const { shots } = makeScene(['1A'], ['1A']);
    return callRoute(handleStoryboard, 'GET', `/film/shots/${shots['1A']}/frames`).then(r => {
        const current = r.body.versions.filter(v => v.is_current);
        assert.strictEqual(current.length, 1,
            `${current.length} versions claim to be the one on the board`);
    });
});

test('restoring a version whose file is gone is refused, not half-done', async () => {
    const { handleStoryboard } = require('../routes/storyboard');
    const { projectId, shots } = makeScene(['1A'], ['1A']);
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version)
                VALUES (?, ?, ?, 'storyboard', '1A_v9.png', '/nowhere/1A_v9.png', 9)`)
        .run(generateId(), projectId, shots['1A']);
    const r = await callRoute(handleStoryboard, 'POST', `/film/shots/${shots['1A']}/frames/9/restore`);
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /no longer on disk/);
});

test('the board offers a way into the attempts, and a way back', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const missing = [];
    if (!/onclick="openFrameVersions\(/.test(html)) missing.push('no control opens the attempts');
    for (const fn of ['openFrameVersions', 'restoreFrameVersion', 'closeFrameVersions']) {
        if (!new RegExp('function ' + fn).test(html)) missing.push(fn + ' is not defined');
    }
    if (!html.includes('id="frameVersionsModal"')) missing.push('the attempts modal is not in the page');
    if (!/onclick="restoreFrameVersion\(/.test(html)) missing.push('nothing restores a version');
    // A modal-overlay is shown by `.open`; `.active` shows a page, so the wrong
    // class here builds a modal that is present and invisible.
    if (!/frameVersionsModal'\)\.classList\.add\('open'\)/.test(html)) {
        missing.push('the attempts modal is never actually shown');
    }
    assert.deepStrictEqual(missing, [], `\n  ${missing.join('\n  ')}`);
});

test('every shot subroute the storyboard module handles is dispatched by the server', () => {
    // The frames route existed, loaded, and returned 405 in the browser: the
    // module handled `urlParts[3] === "frames"` and server.js never sent it
    // there. A route nothing dispatches to is indistinguishable from a route
    // that was never written, and no unit test sees it because the module is
    // called directly.
    //
    // Derived from the module's own routing rather than listed, so the next
    // subroute is checked without anyone remembering to.
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'storyboard.js'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    const subs = new Set();
    for (const m of routeSrc.matchAll(/urlParts\[1\] === 'shots'[\s\S]{0,160}?urlParts\[3\] === '(\w+)'/g)) {
        subs.add(m[1]);
    }
    assert.ok(subs.size >= 2, `found only ${subs.size} shot subroutes — the scan is broken`);

    const undispatched = [...subs].filter(sub =>
        !new RegExp(`sub === '${sub}'`).test(serverSrc)
        && !new RegExp(`parts\\[3\\] === '${sub}'`).test(serverSrc));
    assert.deepStrictEqual(undispatched, [],
        `routes/storyboard.js handles these and server.js never routes to them: ${undispatched.join(', ')}`);
});
