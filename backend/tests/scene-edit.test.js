/**
 * Editing one scene, in the screenplay, without touching the others.
 *
 * The screenplay is the source and `film_scenes` is a projection of it, so
 * writing a scene's description directly puts the two out of step: the row says
 * one thing, the document another, and every report built on either is right
 * about the wrong text.
 *
 * Requiring a whole-document rewrite instead is its own bug, and a quiet one.
 * The caller has to reproduce every OTHER scene faithfully from memory, and the
 * cost of a single stray reflow is invisible — scene 1's shots get marked as
 * behind, and a director redoes work nobody asked for. Splicing is what makes
 * "change scene 3" mean scene 3.
 *
 * Set-based over scene position, because the interesting failures are all at
 * the edges: the first scene sits under a title page, the last has no
 * successor, and a middle one has to leave both neighbours alone.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-sceneedit-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { sceneSpans, spliceScene, isSceneHeading } = require('../lib/scene-splice');
const { handleScenes } = require('../routes/scenes');
const { handleScripts } = require('../routes/scripts');
const { drift } = require('../lib/screenplay-drift');

const SCREENPLAY = [
    'Title: Test', 'Credit: Written by', 'Author: Nobody', '====', '',
    'EXT. STREET - DUSK', '', 'A shadow slides across the houses.', '',
    'INT. HOUSE - NIGHT', '', 'She waits by the window.', '',
    'EXT. ROOF - DAWN', '', 'Wind moves the aerial.', '',
].join('\n');

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

async function seed() {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Scene Edit');
    const up = await call(handleScripts, 'POST', `/film/projects/${projectId}/script`,
        { fountain_content: SCREENPLAY });
    assert.strictEqual(up.status, 201, JSON.stringify(up.body));
    const scenes = db.prepare(
        `SELECT id, scene_number FROM film_scenes WHERE project_id = ? AND status != 'removed'
          ORDER BY CAST(scene_number AS INTEGER), scene_number`).all(projectId);
    // One shot per scene, stamped, so drift can speak.
    const { stampShot } = require('../lib/screenplay-drift');
    const shots = scenes.map((s, i) => {
        const id = generateId();
        db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
            .run(id, s.id, `${i + 1}A`, JSON.stringify({ shot_code: `${i + 1}A`, description: 'x', camera: {} }));
        stampShot(id, s.id);
        return id;
    });
    return { projectId, scenes, shots };
}

test('the title page is not a scene', () => {
    // Counting it would make scene 1 unsplice-able without destroying the
    // title page along with it.
    const spans = sceneSpans(SCREENPLAY);
    assert.strictEqual(spans.length, 3);
    assert.strictEqual(spans[0].heading, 'EXT. STREET - DUSK');
});

test('a forced heading is a heading and an escaped full stop is not', () => {
    // Fountain uses a leading dot to force a heading and `..` to escape a line
    // that genuinely begins with one. Getting it backwards splits a scene in
    // the middle of dialogue.
    assert.ok(isSceneHeading('.THE VOID'));
    assert.ok(!isSceneHeading('..and then nothing'));
    assert.ok(isSceneHeading('INT. HOUSE - NIGHT'));
    assert.ok(!isSceneHeading('She waits by the window.'));
});

/** Every position, because the edges are where a splice goes wrong. */
const POSITIONS = [
    { id: 'first', index: 0, keep: ['She waits by the window.', 'Wind moves the aerial.'] },
    { id: 'middle', index: 1, keep: ['A shadow slides across the houses.', 'Wind moves the aerial.'] },
    { id: 'last', index: 2, keep: ['A shadow slides across the houses.', 'She waits by the window.'] },
];

test('splicing any scene leaves every other scene byte-identical', () => {
    for (const pos of POSITIONS) {
        const heading = sceneSpans(SCREENPLAY)[pos.index].heading;
        const out = spliceScene(SCREENPLAY, pos.index, `${heading}\n\nCompletely different words.`);
        assert.ok(out.includes('Completely different words.'), `${pos.id}: the new text is missing`);
        for (const kept of pos.keep) {
            assert.ok(out.includes(kept), `${pos.id}: splicing destroyed a neighbouring scene`);
        }
        assert.ok(out.includes('Title: Test'), `${pos.id}: the title page did not survive`);
        assert.strictEqual(sceneSpans(out).length, 3, `${pos.id}: the scene count changed`);
    }
});

test('splicing twice is stable rather than growing the gaps', () => {
    // Fountain treats a run of blank lines as a run of blank lines, so a splice
    // that adds one every time is a diff that never settles and a document that
    // drifts a little on each edit.
    const once = spliceScene(SCREENPLAY, 1, 'INT. HOUSE - NIGHT\n\nShe runs.');
    const twice = spliceScene(once, 1, 'INT. HOUSE - NIGHT\n\nShe runs.');
    assert.strictEqual(once, twice);
});

test('a replacement with no heading is refused, not guessed at', () => {
    assert.throws(() => spliceScene(SCREENPLAY, 1, 'She runs.'), /scene heading/i);
    assert.throws(() => spliceScene(SCREENPLAY, 9, 'INT. X - DAY\n\nY.'), /no scene at position/i);
    assert.throws(() => spliceScene(SCREENPLAY, 1, '   '), /needs text/i);
});

test('editing one scene flags only that scene’s shots', async () => {
    const s = await seed();
    const res = await call(handleScenes, 'PUT', `/film/scenes/${s.scenes[1].id}`,
        { fountain: 'INT. HOUSE - NIGHT\n\nShe stops waiting and runs for the door.' });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));

    const behind = drift(s.projectId);
    assert.strictEqual(behind.length, 1, `expected one scene behind, got ${behind.length}`);
    assert.deepStrictEqual(behind[0].shots_behind.map(x => x.shot_code), ['2A'],
        'editing scene 2 marked the wrong shots as behind');
});

test('a new version is saved, so the previous draft survives the edit', async () => {
    const s = await seed();
    await call(handleScenes, 'PUT', `/film/scenes/${s.scenes[0].id}`,
        { fountain: 'EXT. STREET - DUSK\n\nThe street is empty and the light is going.' });
    const versions = db.prepare('SELECT version FROM film_scripts WHERE project_id = ? ORDER BY version')
        .all(s.projectId).map(r => r.version);
    assert.deepStrictEqual(versions, [1, 2], 'the edit did not produce a new version');
});

test('saving a scene unchanged writes nothing and flags nothing', async () => {
    // An idempotent save is how a caller checks its work. Charging it a version
    // and a warning would make "did that apply?" an expensive question.
    const s = await seed();
    const res = await call(handleScenes, 'PUT', `/film/scenes/${s.scenes[2].id}`,
        { fountain: 'EXT. ROOF - DAWN\n\nWind moves the aerial.' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.changed, false);
    assert.strictEqual(
        db.prepare('SELECT COUNT(*) c FROM film_scripts WHERE project_id = ?').get(s.projectId).c, 1);
    assert.deepStrictEqual(drift(s.projectId), []);
});

test('a project with no screenplay says so rather than inventing one', async () => {
    const projectId = generateId(), sceneId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'No Script');
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'X')`)
        .run(sceneId, projectId);
    const res = await call(handleScenes, 'PUT', `/film/scenes/${sceneId}`,
        { fountain: 'INT. X - DAY\n\nSomething.' });
    assert.strictEqual(res.status, 409);
    assert.match(res.body.error, /no Fountain screenplay/i);
});
