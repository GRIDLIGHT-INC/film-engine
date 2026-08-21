/**
 * Inserting a scene in the middle, without rewriting everything below it.
 *
 * This was deferred as a BLOCKER, and the trace is worth keeping because the
 * failure is silent. `syncScenesWithScreenplay` matched by `scene_number`,
 * greedily, and then UPDATEd the row it matched — unconditionally, since
 * `moved()` only fed the report counters. Insert a scene after scene 2 of a ten
 * scene script and the new Fountain numbers 1, 2, NEW=3, old-3→4, old-4→5 …
 * Pass 1 then matched new #3 to old #3 and overwrote it with the NEW text, new
 * #4 to old #4 and overwrote it with old-3's text, and so on to the end. Pass 2
 * could rescue none of it: pass 1 had already consumed those rows by number.
 *
 * Every scene below the insertion point ended up holding its predecessor's text
 * with a moved fingerprint — which is exactly the harm the append work exists to
 * prevent, performed deterministically on every call.
 *
 * **The fix is identity, not ordering.** A scene's identity is its CONTENT, not
 * its position, so reconciliation matches on `sceneFingerprint` before it
 * matches on number. That is deliberately the same function that answers "has
 * this scene changed" — the two questions are one question asked from opposite
 * directions, and using one function for both is what stops them disagreeing.
 *
 * Set-based over the ways an insert can corrupt, because they are not one bug:
 * losing an id cascades shots away, losing text is silent data loss, and losing
 * a fingerprint is a false drift report. A test for any one of them passes while
 * the other two are broken.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-insert-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

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
            .catch(err => resolve({ status: 500, body: { error: err.message, stack: err.stack } }));
    });
}

/** Five scenes, each with text distinctive enough that a swap is obvious. */
const FIVE = `Title: From the Mist

EXT. HARBOUR - DAWN

Scene one. The water is gone.

EXT. SLUICE - MORNING

Scene two. Rust where water should be.

INT. SLUICE HOUSE - DAY

Scene three. The mechanism is dry.

EXT. THE FLATS - LATER

Scene four. Ground that was never ground.

EXT. ROAD BACK - DUSK

Scene five. She returns the way she came.
`;

const NEW_SCENE = `EXT. THE GATE - DAY

Scene NEW. Something stands in the channel.
`;

async function project() {
    const { handleScripts } = require('../routes/scripts');
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Insert Test');
    const r = await callRoute(handleScripts, 'POST', `/film/projects/${projectId}/script`,
        { fountain_content: FIVE });
    assert.ok(r.status < 400, `seed failed: ${JSON.stringify(r.body)}`);
    return projectId;
}

const scenes = pid => db.prepare(
    `SELECT * FROM film_scenes WHERE project_id = ? AND status != 'removed'
      ORDER BY CAST(scene_number AS INTEGER), scene_number`).all(pid);

async function insertAfter(projectId, index, fragment) {
    const { handleScripts } = require('../routes/scripts');
    return callRoute(handleScripts, 'POST', `/film/projects/${projectId}/script/insert`,
        { after_scene: index, fountain: fragment });
}

// ── The invariants an insert must preserve ──────────────────────────────

test('inserting adds exactly one scene', async () => {
    const pid = await project();
    const r = await insertAfter(pid, 1, NEW_SCENE);
    assert.ok(r.status < 400, JSON.stringify(r.body));
    assert.strictEqual(scenes(pid).length, 6);
});

test('no existing scene is given another scene’s text', async () => {
    // THE bug. Every scene below the insertion point used to end up holding its
    // predecessor's words.
    const pid = await project();
    const before = new Map(scenes(pid).map(s => [s.id, s.description]));
    await insertAfter(pid, 1, NEW_SCENE);

    const wrong = [];
    for (const s of scenes(pid)) {
        if (!before.has(s.id)) continue;               // the new one
        if (before.get(s.id) !== s.description) {
            wrong.push(`${s.location}: "${before.get(s.id)}" became "${s.description}"`);
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

test('every existing scene keeps its id, so its shots survive', async () => {
    // film_shots.scene_id is ON DELETE CASCADE. A scene re-created rather than
    // kept takes every shot, card, blocking and annotation with it.
    const pid = await project();
    const idsBefore = scenes(pid).map(s => s.id);
    // A shot on the LAST scene — the one furthest from the insertion point and
    // therefore the most shifted.
    const shotId = generateId();
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, idsBefore[idsBefore.length - 1], '5A', JSON.stringify({ shot_code: '5A' }));

    await insertAfter(pid, 1, NEW_SCENE);

    const after = scenes(pid).map(s => s.id);
    const lost = idsBefore.filter(id => !after.includes(id));
    assert.deepStrictEqual(lost, [], `scenes lost their identity across an insert: ${lost.join(', ')}`);
    assert.ok(db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId),
        'a shot on the last scene cascaded away when the scene was re-created');
});

test('no existing scene is reported as changed', async () => {
    // The false-drift failure: an insert used to restamp the entire tail, so
    // every shot below it reported as behind.
    const pid = await project();
    const before = new Map(scenes(pid).map(s => [s.id, s.source_fingerprint]));
    await insertAfter(pid, 1, NEW_SCENE);

    const drifted = scenes(pid)
        .filter(s => before.has(s.id) && before.get(s.id) !== s.source_fingerprint)
        .map(s => s.location);
    assert.deepStrictEqual(drifted, [],
        `an insert restamped scenes it did not touch: ${drifted.join(', ')}`);
});

test('the inserted scene lands in the right place', async () => {
    // `after_scene` counts the way scene_list reports: 2 means after the second
    // scene. The parameter was originally called `after_scene_index`, and that
    // name was enough to make me write this expectation off by one against my
    // own implementation — which is why it was renamed rather than documented.
    const pid = await project();
    await insertAfter(pid, 2, NEW_SCENE);
    const order = scenes(pid).map(s => s.location);
    assert.strictEqual(order[2], 'THE GATE',
        `inserted after scene 2 but the order is ${order.join(' → ')}`);
    assert.deepStrictEqual(order,
        ['HARBOUR', 'SLUICE', 'THE GATE', 'SLUICE HOUSE', 'THE FLATS', 'ROAD BACK']);
});

test('inserting at the very front works', async () => {
    // after_scene 0 means "before scene 1" — the boundary most likely to be off
    // by one, and the one that would silently destroy a title page.
    const pid = await project();
    const r = await insertAfter(pid, 0, NEW_SCENE);
    assert.ok(r.status < 400, JSON.stringify(r.body));
    const order = scenes(pid).map(s => s.location);
    assert.strictEqual(order[0], 'THE GATE', `order is ${order.join(' → ')}`);
    const { handleScripts } = require('../routes/scripts');
    const f = await callRoute(handleScripts, 'GET', `/film/projects/${pid}/script/latest/fountain`);
    assert.match(f.body.fountain_content, /^Title: From the Mist/,
        'inserting at the front destroyed the title page');
});

test('inserting past the end is the same as appending', async () => {
    const pid = await project();
    const r = await insertAfter(pid, 5, NEW_SCENE);
    assert.ok(r.status < 400, JSON.stringify(r.body));
    assert.strictEqual(scenes(pid).map(s => s.location).pop(), 'THE GATE');
});

test('an out-of-range index is refused rather than guessed', async () => {
    const pid = await project();
    const r = await insertAfter(pid, 99, NEW_SCENE);
    assert.ok(r.status >= 400, `an index past the end was silently accepted: ${JSON.stringify(r.body)}`);
});

test('a real edit is STILL reported as changed', async () => {
    // The fix must not make drift invisible. Matching by content means an
    // unchanged scene matches; an EDITED scene must fall through to the number
    // match, be updated, and be restamped — or the whole drift system goes
    // quiet and a director never learns their cards are behind.
    const { handleScenes } = require('../routes/scenes');
    const pid = await project();
    const target = scenes(pid)[2];
    const before = target.source_fingerprint;

    const r = await callRoute(handleScenes, 'PUT', `/film/scenes/${target.id}`,
        { fountain: 'INT. SLUICE HOUSE - DAY\n\nScene three, REWRITTEN. The mechanism turns.\n' });
    assert.ok(r.status < 400, JSON.stringify(r.body));

    const after = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(target.id);
    assert.strictEqual(after.id, target.id, 'editing a scene changed its id');
    assert.notStrictEqual(after.source_fingerprint, before,
        'an edited scene was not restamped — content matching has made drift invisible');
    assert.match(after.description, /REWRITTEN/);
});

test('insert and append agree about what they do not touch', async () => {
    // Both primitives make the same promise. Asserted together so they cannot
    // drift apart: append was safe by accident of numbering, insert is safe by
    // identity, and only one of those survives a refactor unless both are held.
    const pid = await project();
    const before = new Map(scenes(pid).map(s => [s.id, s.source_fingerprint]));

    await insertAfter(pid, 2, NEW_SCENE);
    const { handleScripts } = require('../routes/scripts');
    await callRoute(handleScripts, 'POST', `/film/projects/${pid}/script/append`,
        { fountain: 'EXT. THE TOWER - NIGHT\n\nScene last. A light that should not be lit.\n' });

    const drifted = scenes(pid)
        .filter(s => before.has(s.id) && before.get(s.id) !== s.source_fingerprint)
        .map(s => s.location);
    assert.deepStrictEqual(drifted, [],
        `an insert followed by an append disturbed: ${drifted.join(', ')}`);
    assert.strictEqual(scenes(pid).length, 7);
});

test('scene_insert_after is on the MCP surface', () => {
    const { listTools } = require('../lib/mcp-tools');
    const tool = listTools().find(t => t.name === 'scene_insert_after');
    assert.ok(tool, 'scene_insert_after is not exposed over MCP');
    assert.ok(tool.inputSchema.properties.after_scene !== undefined,
        'the tool does not say where to insert');
    assert.ok(tool.inputSchema.properties.fountain, 'the tool takes no fountain');
});
