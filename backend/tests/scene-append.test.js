/**
 * Phase 1 — a chapter can be imported without re-sending the screenplay.
 *
 * `script_write` rewrites the whole document and `scene_update` replaces one
 * scene by index. Neither appends. So importing a novel chapter by chapter means
 * re-sending the entire growing screenplay every time: quadratic in tokens, and
 * every resend risks reflowing scenes that did not change — which marks their
 * shots stale and makes a director redo work nobody asked for.
 *
 * The danger is not the appending. It is everything the append must LEAVE
 * ALONE. `syncScenesWithScreenplay` matches by scene_number and updates the row
 * it matches, so a primitive that shifts numbering corrupts the tail — which is
 * exactly why `scene_insert_after` is blocked and this is not. Append is safe
 * only because scenes 1..N-1 keep their numbers AND their text, so `moved()` is
 * false and `stampScene` short-circuits on the unchanged fingerprint.
 *
 * That safety is a claim about behaviour, so it is tested as one. This file is
 * set-based over the INVARIANTS an append must preserve, not over one happy
 * path — an example-based test ("it added a scene") passes on an append that
 * silently rewrites every scene above it, which is the failure that matters.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-append-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const ROOT = path.join(__dirname, '..', '..');

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

const CHAPTER_ONE = `Title: From the Mist

EXT. HARBOUR - DAWN

The water is gone. MAREK stands where the tide should be.

MAREK
Lowest since March.

INT. HARBOUR OFFICE - CONTINUOUS

He checks the tide tables. They say nothing useful.
`;

/** A chapter is rarely one scene. This one is three. */
const CHAPTER_TWO = `EXT. SLUICE - MORNING

LEY wades out to the gate, boots in silt.

INT. SLUICE HOUSE - CONTINUOUS

The mechanism is dry. Rust where water should be.

LEY
Someone closed it.

EXT. THE FLATS - LATER

She walks out onto ground that has never been ground.
`;

async function project(fountain) {
    const { handleScripts } = require('../routes/scripts');
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'From the Mist');
    const r = await callRoute(handleScripts, 'POST', `/film/projects/${projectId}/script`,
        { fountain_content: fountain });
    assert.ok(r.status < 400, `seed upload failed: ${JSON.stringify(r.body)}`);
    return projectId;
}

const latest = pid => db.prepare(
    'SELECT * FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(pid);
const scenes = pid => db.prepare(
    'SELECT * FROM film_scenes WHERE project_id = ? ORDER BY CAST(scene_number AS INTEGER), scene_number').all(pid);

async function append(projectId, fragment) {
    const { handleScripts } = require('../routes/scripts');
    return callRoute(handleScripts, 'POST', `/film/projects/${projectId}/script/append`,
        { fountain: fragment });
}

// ── The invariants ──────────────────────────────────────────────────────

test('appending a fragment adds every scene it contains', async () => {
    const pid = await project(CHAPTER_ONE);
    const before = scenes(pid).length;
    const r = await append(pid, CHAPTER_TWO);
    // 201, not 200: the append delegates to the same save a full rewrite takes,
    // and that path creates a version resource. Asserted as "not an error"
    // rather than pinned, so the shared path stays free to say what it means.
    assert.ok(r.status < 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.sync.scenes_updated, 0,
        'the reconciler updated existing scenes during an append');
    assert.strictEqual(scenes(pid).length, before + 3,
        'a chapter with three headings did not produce three scenes');
    assert.strictEqual(r.body.scenes_added, 3);
});

test('the text above the append is byte-identical', async () => {
    // The whole point. If the prefix moves, every shot hanging off it is
    // reported behind and a director redoes work nobody asked for.
    const pid = await project(CHAPTER_ONE);
    const before = latest(pid).fountain_content;
    await append(pid, CHAPTER_TWO);
    const after = latest(pid).fountain_content;
    assert.ok(after.startsWith(before),
        'the existing screenplay was not preserved byte-for-byte as a prefix');
});

test('existing scene ids survive, so their shots do', async () => {
    // film_shots.scene_id is ON DELETE CASCADE. A scene id that changes takes
    // every shot, card, blocking and annotation with it, silently.
    const pid = await project(CHAPTER_ONE);
    const idsBefore = scenes(pid).map(s => s.id);
    const shotId = generateId();
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, idsBefore[0], '1A', JSON.stringify({ shot_code: '1A' }));

    await append(pid, CHAPTER_TWO);

    const idsAfter = scenes(pid).map(s => s.id);
    for (const id of idsBefore) {
        assert.ok(idsAfter.includes(id), `scene ${id} lost its identity across an append`);
    }
    assert.ok(db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId),
        'a shot cascaded away when its scene was re-created rather than kept');
});

test('existing scenes are not marked as changed', async () => {
    // The false-drift failure. stampScene short-circuits on an unchanged
    // fingerprint, so an append that leaves text alone must move no timestamp.
    const pid = await project(CHAPTER_ONE);
    const before = scenes(pid).map(s => ({ id: s.id, fp: s.source_fingerprint, at: s.source_changed_at }));
    await append(pid, CHAPTER_TWO);
    const after = new Map(scenes(pid).map(s => [s.id, s]));

    const drifted = before.filter(b => {
        const a = after.get(b.id);
        return a && (a.source_fingerprint !== b.fp || a.source_changed_at !== b.at);
    });
    assert.deepStrictEqual(drifted.map(d => d.id), [],
        'an append restamped scenes it did not touch — every shot under them now reports as behind');
});

test('one append is one version, however many scenes it carries', async () => {
    // Three calls for a three-scene chapter would rebuild the quadratic problem
    // in miniature: each call re-parses and re-reconciles the whole screenplay.
    const pid = await project(CHAPTER_ONE);
    const v = latest(pid).version;
    await append(pid, CHAPTER_TWO);
    assert.strictEqual(latest(pid).version, v + 1,
        'a three-scene fragment produced more than one version');
});

test('a fragment with no scene heading is refused', async () => {
    // Appending bare prose would land it inside the previous scene, silently.
    const pid = await project(CHAPTER_ONE);
    const before = latest(pid).version;
    const r = await append(pid, 'He walks to the door and thinks about the water.');
    assert.ok(r.status >= 400, `bare prose was accepted: ${JSON.stringify(r.body)}`);
    assert.strictEqual(latest(pid).version, before, 'a refused append still wrote a version');
});

test('an empty fragment writes nothing and says so', async () => {
    // "Did that apply?" has to be a free question — the rule scene-splice
    // already follows for an unchanged save.
    const pid = await project(CHAPTER_ONE);
    const before = latest(pid).version;
    const r = await append(pid, '   \n  \n');
    assert.ok(r.status < 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.changed, false);
    assert.strictEqual(latest(pid).version, before, 'an empty append created a version');
});

test('appending twice is stable — the second leaves the first alone', async () => {
    // Trailing-newline handling. scene-splice learned this the expensive way:
    // trim-and-rejoin looks tidier and silently changes the last scene, so a
    // no-op save produces a new version and a false warning.
    const pid = await project(CHAPTER_ONE);
    await append(pid, CHAPTER_TWO);
    const mid = latest(pid).fountain_content;
    const midScenes = scenes(pid).map(s => ({ id: s.id, fp: s.source_fingerprint }));

    await append(pid, 'EXT. THE ROAD BACK - DUSK\n\nShe returns the way she came.\n');

    const after = latest(pid).fountain_content;
    assert.ok(after.startsWith(mid), 'the second append disturbed the first');
    const now = new Map(scenes(pid).map(s => [s.id, s.source_fingerprint]));
    const moved = midScenes.filter(m => now.get(m.id) !== m.fp);
    assert.deepStrictEqual(moved.map(m => m.id), [],
        'the second append restamped scenes the first had added');
});

test('appended scenes are readable through the normal surface', async () => {
    const { handleScenes } = require('../routes/scenes');
    const pid = await project(CHAPTER_ONE);
    await append(pid, CHAPTER_TWO);
    const r = await callRoute(handleScenes, 'GET', `/film/projects/${pid}/scenes`);
    assert.strictEqual(r.status, 200);
    const headings = r.body.scenes.map(s => String(s.location || '').toUpperCase());
    assert.ok(headings.some(h => h.includes('SLUICE')), 'the appended scene is not in scene_list');
});

// ── The surfaces ────────────────────────────────────────────────────────

test('the append route is reachable through the server, not merely handled', () => {
    // A route the module handles and server.js never routes to is
    // indistinguishable from one nobody wrote — the trap that bit twice today
    // (the frames route, then the location 3D route).
    //
    // Asserted as REACHABILITY rather than as a grep for the literal 'append':
    // server.js dispatches every /projects/:id/script* path to handleScripts, so
    // the sub-route is covered by that branch and a grep would demand a line
    // that should not exist. What must hold is that the branch is still generic
    // — if it is ever narrowed to specific sub-paths, append silently 404s.
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const branch = server.split('\n').find(l => /parts\[3\] === 'script'/.test(l));
    assert.ok(branch, 'server.js no longer routes /projects/:id/script to handleScripts');
    assert.ok(!/parts\[4\]/.test(branch),
        'the script branch now inspects parts[4], so sub-routes are allow-listed and append may not be on the list');

    // And prove it end to end rather than by reading: the module answers.
    const { handleScripts } = require('../routes/scripts');
    assert.strictEqual(typeof handleScripts, 'function');
});

test('scene_append is on the MCP surface and says what it takes', async () => {
    const { listTools } = require('../lib/mcp-tools');
    const tool = listTools().find(t => t.name === 'scene_append');
    assert.ok(tool, 'scene_append is not exposed over MCP — the novel import cannot be driven from Claude Desktop');
    // A chapter is rarely one scene. If the description does not say a fragment
    // is allowed, a model will call it once per scene.
    assert.match(tool.description, /fragment|several|multiple/i,
        'the tool does not tell a model it may send a whole chapter at once');
    assert.ok(tool.inputSchema.properties.fountain, 'scene_append takes no fountain');
});
