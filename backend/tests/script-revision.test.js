/**
 * Revising a story must not destroy the production built on it.
 *
 * `film_shots.scene_id` is declared ON DELETE CASCADE, and `uploadScript`
 * cleared every scene in the project by default. On a first upload that is
 * correct and costs nothing — there is nothing hanging off the scenes yet. On
 * the SECOND upload it takes the entire film: every shot, every scene card,
 * every blocking, every annotation, every asset row. Nothing errors. The only
 * signal is a shot list that has quietly become empty, discovered by whoever
 * next opens the board.
 *
 * That path was reachable from the UI and, once `script_write` shipped, from an
 * agent — which is the worse of the two, because "rewrite scene 3" is a
 * sentence a director says casually.
 *
 * Set-based over the child tables a revision must not orphan, because a
 * cascade is only safe if EVERY child survives: one that checks shots alone
 * passes while previs blocking is silently swept away with them.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-revision-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handleScripts } = require('../routes/scripts');

function call(handler, method, urlPath, body) {
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

const DRAFT_ONE = `INT. KITCHEN - DAY

Maya pours coffee.

MAYA
Morning.

EXT. STREET - DUSK

A shadow crosses the road.
`;

// Scene 2's action is rewritten; the headings are untouched, which is what a
// surgical revision looks like.
const DRAFT_TWO = `INT. KITCHEN - DAY

Maya pours coffee.

MAYA
Morning.

EXT. STREET - DUSK

The dragon turns and comes for her. She runs for the sewer plate.
`;

/** A project with a script, scenes, and real work hanging off one of them. */
async function seedProduction() {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Revision Test');
    const up = await call(handleScripts, 'POST', `/film/projects/${projectId}/script`,
        { fountain_content: DRAFT_ONE });
    assert.strictEqual(up.status, 201, JSON.stringify(up.body));

    const scenes = db.prepare('SELECT * FROM film_scenes WHERE project_id = ? ORDER BY scene_number').all(projectId);
    assert.ok(scenes.length >= 2, `expected the draft to yield scenes, got ${scenes.length}`);

    const shotId = generateId();
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, scenes[1].id, '2A', JSON.stringify({ shot_code: '2A', description: 'a street', camera: {} }));
    db.prepare(`INSERT INTO film_previs_blocking (id, shot_id, camera_json, subject_json, stage_json)
                VALUES (?, ?, '{}', '{}', '{}')`).run(generateId(), shotId);
    db.prepare(`INSERT INTO film_storyboard_annotations (id, shot_id, kind, points_json, text, color)
                VALUES (?, ?, 'arrow', '[[0.1,0.1],[0.4,0.4]]', '', '#f59e0b')`).run(generateId(), shotId);

    return { projectId, shotId, scenes };
}

/** The children a revision must not sweep away, and how to count them. */
const CHILDREN = [
    { id: 'shots', count: s => db.prepare('SELECT COUNT(*) c FROM film_shots WHERE id = ?').get(s.shotId).c },
    { id: 'previs blocking', count: s => db.prepare('SELECT COUNT(*) c FROM film_previs_blocking WHERE shot_id = ?').get(s.shotId).c },
    { id: 'annotations', count: s => db.prepare('SELECT COUNT(*) c FROM film_storyboard_annotations WHERE shot_id = ?').get(s.shotId).c },
];

test('a revision keeps every child of the scenes it revises', async () => {
    const seed = await seedProduction();
    for (const child of CHILDREN) {
        assert.strictEqual(child.count(seed), 1, `${child.id} was not seeded`);
    }

    const res = await call(handleScripts, 'POST', `/film/projects/${seed.projectId}/script`,
        { fountain_content: DRAFT_TWO, sync_scenes: true });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    const lost = CHILDREN.filter(c => c.count(seed) === 0).map(c => c.id);
    assert.deepStrictEqual(lost, [],
        `revising the screenplay destroyed: ${lost.join(', ')} — a cascade through film_scenes`);
});

test('the reconciler reports what it did, rather than doing it silently', async () => {
    const seed = await seedProduction();
    const res = await call(handleScripts, 'POST', `/film/projects/${seed.projectId}/script`,
        { fountain_content: DRAFT_TWO, sync_scenes: true });
    assert.ok(res.body.sync, 'no sync report, so a revision cannot be checked');
    for (const key of ['scenes_added', 'scenes_updated', 'scenes_removed']) {
        assert.ok(typeof res.body.sync[key] === 'number', `the report never says ${key}`);
    }
});

test('scene ids survive a revision, which is what keeps the shots attached', async () => {
    const seed = await seedProduction();
    const before = db.prepare('SELECT id FROM film_scenes WHERE project_id = ? ORDER BY scene_number')
        .all(seed.projectId).map(r => r.id);

    await call(handleScripts, 'POST', `/film/projects/${seed.projectId}/script`,
        { fountain_content: DRAFT_TWO, sync_scenes: true });

    const after = db.prepare("SELECT id FROM film_scenes WHERE project_id = ? AND status != 'removed' ORDER BY scene_number")
        .all(seed.projectId).map(r => r.id);
    // Matched by number then location+time. New ids would mean new scenes, and
    // the old shots would be hanging off rows nothing lists any more.
    assert.deepStrictEqual(after, before,
        'the reconciler rebuilt the scenes instead of updating them');
});

test('the destructive path still exists, and is still destructive', async () => {
    // Not a bug — starting a project over is a real thing to want. It must be
    // asked for explicitly, and this pins that it is not what a plain revision
    // does.
    const seed = await seedProduction();
    const res = await call(handleScripts, 'POST', `/film/projects/${seed.projectId}/script`,
        { fountain_content: DRAFT_TWO, replace_scenes: true });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(
        db.prepare('SELECT COUNT(*) c FROM film_shots WHERE id = ?').get(seed.shotId).c, 0,
        'replace_scenes no longer replaces, so the deliberate reset is broken');
});

test('the agent tool defaults to the safe path', () => {
    const { listTools } = require('../lib/mcp-tools');
    const tool = listTools().find(t => t.name === 'script_write');
    assert.ok(tool, 'no script_write tool');
    // "rewrite scene 3" is a sentence a director says casually, and it must not
    // be able to mean "delete the film".
    const props = tool.inputSchema.properties || {};
    assert.ok(!props.replace_scenes,
        'the raw destructive flag is exposed to the model under its own name');
    assert.ok(/DESTRUCTIVE/.test(JSON.stringify(props.replace_everything || {})),
        'the reset flag does not say what it destroys');
    assert.ok(/reconcil/i.test(tool.description),
        'the tool never tells the model that scenes are reconciled rather than rebuilt');
});
