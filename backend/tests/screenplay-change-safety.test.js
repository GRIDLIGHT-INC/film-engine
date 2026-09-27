/**
 * Nothing built on a screenplay may be destroyed, lost from view, or quietly
 * moved onto the wrong scene because the screenplay changed.
 *
 * `film_shots.scene_id` is ON DELETE CASCADE, so a deleted scene takes its
 * shots, their blocking, markup, clip coverage and video attempts with it; and
 * the board hides every shot whose scene is marked `removed`. Three ways a
 * change could still do one of those after the replace-by-default fix:
 *
 *   1. a PLAIN-TEXT upload (`content`, not `fountain_content`) into a project
 *      that already had scenes skipped the reconciler and deleted them all;
 *   2. deleting one scene and editing the next in the same save matched rows
 *      by NUMBER, so the deleted scene's row took the edited text and the
 *      edited scene's own shots went off the board on a "removed" row;
 *   3. editing a scene by id found it in the document by POSITION among the
 *      rows — and the editor's autosave changes the document without touching
 *      the rows, so a scene added above made the edit land on its neighbour.
 *
 * Set-based over every way the screenplay is written: each writer is run on a
 * production with a shot under every scene, and every shot must survive on a
 * scene that is still on the board. The writer list is held to the source, so
 * a new way to write the screenplay arrives covered or fails.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-change-safety-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const { handleScripts } = require('../routes/scripts');
const { handleScenes } = require('../routes/scenes');

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

const SCENES = [
    'INT. KITCHEN - DAY\n\nMaya pours coffee.',
    'EXT. STREET - DUSK\n\nA shadow crosses the road.',
    'INT. GARAGE - NIGHT\n\nRay works under the car.',
    'EXT. ROOF - NIGHT\n\nThe city hums below.',
];
const draft = scenes => scenes.join('\n\n') + '\n';

/** A project whose four scenes each carry one shot. */
async function production() {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Safety');
    const up = await call(handleScripts, 'POST', `/film/projects/${projectId}/script`, { fountain_content: draft(SCENES) });
    assert.strictEqual(up.status, 201, JSON.stringify(up.body));
    const scenes = db.prepare('SELECT * FROM film_scenes WHERE project_id = ? ORDER BY scene_number').all(projectId);
    assert.strictEqual(scenes.length, 4);
    const shots = scenes.map((sc, i) => {
        const id = generateId();
        db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
            .run(id, sc.id, `${i + 1}A`, JSON.stringify({ shot_code: `${i + 1}A`, description: sc.location }));
        db.prepare(`INSERT INTO film_previs_blocking (id, shot_id, camera_json, subject_json, stage_json)
                    VALUES (?, ?, '{}', '{}', '{}')`).run(generateId(), id);
        return { id, location: sc.location };
    });
    return { projectId, scenes, shots };
}

/** Where a shot now stands: does it exist, and is its scene still on the board? */
function whereIs(shotId) {
    return db.prepare(`SELECT sh.id, sc.status, sc.location, sc.description FROM film_shots sh
        JOIN film_scenes sc ON sc.id = sh.scene_id WHERE sh.id = ?`).get(shotId) || null;
}

function lostOrHidden(p) {
    return p.shots.filter(s => {
        const w = whereIs(s.id);
        const blocking = db.prepare('SELECT COUNT(*) c FROM film_previs_blocking WHERE shot_id = ?').get(s.id).c;
        return !w || w.status === 'removed' || !blocking;
    }).map(s => s.location);
}

/*
 * Every way the screenplay is written, each applying a change that keeps all
 * four scenes: every shot must come out the other side, visible.
 */
const REVISED = draft([SCENES[0], 'EXT. STREET - DUSK\n\nThe dragon lands in the road.', SCENES[2], SCENES[3]]);
const WRITERS = {
    uploadScript: p => call(handleScripts, 'POST', `/film/projects/${p.projectId}/script`, { fountain_content: REVISED }),
    uploadScriptPlainText: p => call(handleScripts, 'POST', `/film/projects/${p.projectId}/script`, { content: REVISED }),
    updateScript: p => call(handleScripts, 'PUT', `/film/projects/${p.projectId}/script/1`, { fountain_content: REVISED, update_scenes: true }),
    updateScriptAutosave: p => call(handleScripts, 'PUT', `/film/projects/${p.projectId}/script/1`, { fountain_content: REVISED }),
    importFDX: p => {
        const parser = require('../lib/fountain-parser');
        const ast = (parser.parse || parser.parseFountain || parser)(REVISED);
        const xml = require('../lib/fdx-generator').generateFDX(ast);
        return call(handleScripts, 'POST', `/film/projects/${p.projectId}/script/import-fdx`, { fdx_content: xml });
    },
    appendToScript: p => call(handleScripts, 'POST', `/film/projects/${p.projectId}/script/append`,
        { fountain: 'EXT. PIER - DAWN\n\nGulls.' }),
    insertIntoScript: p => call(handleScripts, 'POST', `/film/projects/${p.projectId}/script/insert`,
        { fountain: 'INT. HALL - DAY\n\nA door closes.', after_scene: 1 }),
    writeOutline: p => call(handleScripts, 'POST', `/film/projects/${p.projectId}/outline`,
        { section: 'Act One', synopsis: 'Where it starts.', before_scene: 0 }),
    updateScene: p => call(handleScenes, 'PUT', `/film/scenes/${p.scenes[1].id}`,
        { fountain: 'EXT. STREET - DUSK\n\nThe dragon lands in the road.' }),
    editScene: p => call(handleScenes, 'POST', `/film/scenes/${p.scenes[1].id}/edit`,
        { edits: [{ find: 'A shadow crosses the road.', replace: 'The dragon lands in the road.' }] }),
};

test('the writer list is every function that writes the screenplay or its scenes', () => {
    const src = ['routes/scripts.js', 'routes/scenes.js']
        .map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
    // A function that writes a script version, rebuilds scenes, or splices the document.
    const found = new Set();
    const re = /^(?:async\s+)?function\s+(\w+)\s*\(/gm;
    const starts = [...src.matchAll(re)];
    for (let i = 0; i < starts.length; i++) {
        const body = src.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : src.length);
        const name = starts[i][1];
        if (/^(handleScripts|handleScenes|uploadScript|reconcileOrReplaceScenes|syncScenesWithScreenplay|insertScriptElements|processFountainContent|extractScenesFromFountain)$/.test(name)) continue;
        if (/uploadScript\(|reconcileOrReplaceScenes\(|UPDATE film_scripts\s+SET/.test(body)
            || /handleScripts\(\s*\{\s*method:\s*'POST'/.test(body)
            || /INSERT INTO film_scripts/.test(body)) found.add(name);
    }
    found.add('uploadScript');
    const covered = new Set(Object.keys(WRITERS).map(k => k.replace(/PlainText|Autosave$/, '')));
    const missing = [...found].filter(n => !covered.has(n));
    assert.deepStrictEqual(missing, [], `writers with no safety case: ${missing.join(', ')}`);
    assert.ok(found.size >= 6, `the scan found only ${found.size} writers — it is not reading the source`);
});

for (const [name, write] of Object.entries(WRITERS)) {
    test(`${name}: every shot survives, still on the board`, async () => {
        const p = await production();
        const r = await write(p);
        assert.ok(r.status < 300, `${name} failed: ${r.status} ${JSON.stringify(r.body)}`);
        assert.deepStrictEqual(lostOrHidden(p), [], `${name} destroyed or hid the shots of these scenes`);
    });
}

test('deleting a scene and editing the next in one save keeps each shot with its own scene', async () => {
    const p = await production();
    // Scene 2 (STREET) deleted; scene 3 (GARAGE) rewritten; 1 and 4 untouched.
    const next = draft([SCENES[0], 'INT. GARAGE - NIGHT\n\nRay slides out from under the car, bleeding.', SCENES[3]]);
    const r = await call(handleScripts, 'POST', `/film/projects/${p.projectId}/script`, { fountain_content: next });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));

    const garage = whereIs(p.shots[2].id);
    assert.ok(garage, 'the garage shot was deleted');
    assert.notStrictEqual(garage.status, 'removed', 'the edited scene’s shot is off the board, on a removed row');
    assert.match(garage.description, /bleeding/, 'the garage shot is not under the garage scene’s new text');

    const street = whereIs(p.shots[1].id);
    assert.ok(street, 'the deleted scene’s shot was destroyed rather than kept on a removed scene');
    assert.strictEqual(street.status, 'removed', 'the deleted scene’s row was reused for another scene’s text');
    assert.strictEqual(street.location, 'STREET', 'the deleted scene’s row took another scene’s heading');
});

test('editing a scene by id after an autosave added a scene above edits THAT scene', async () => {
    const p = await production();
    // The editor's autosave: a new scene at the top, rows not synced.
    const withNew = draft(['INT. HALLWAY - DAY\n\nA phone rings.', ...SCENES]);
    const save = await call(handleScripts, 'PUT', `/film/projects/${p.projectId}/script/1`, { fountain_content: withNew });
    assert.strictEqual(save.status, 200, JSON.stringify(save.body));

    // Now edit GARAGE (scene 3 by id).
    const r = await call(handleScenes, 'PUT', `/film/scenes/${p.scenes[2].id}`,
        { fountain: 'INT. GARAGE - NIGHT\n\nRay throws the wrench.' });
    assert.ok(r.status < 300 || r.status === 409, JSON.stringify(r.body));
    const latest = db.prepare('SELECT fountain_content FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1')
        .get(p.projectId).fountain_content;
    for (const untouched of ['A phone rings.', 'Maya pours coffee.', 'A shadow crosses the road.', 'The city hums below.']) {
        assert.ok(latest.includes(untouched), `the edit overwrote another scene: "${untouched}" is gone`);
    }
    if (r.status < 300) {
        assert.ok(latest.includes('Ray throws the wrench.'), 'the edit reported success and did not land');
        assert.ok(!latest.includes('Ray works under the car.'), 'the garage still holds its old text');
    }
});

test('a phrase edit after an autosave added a scene above edits THAT scene too', async () => {
    const p = await production();
    const withNew = draft(['INT. HALLWAY - DAY\n\nA phone rings.', ...SCENES]);
    await call(handleScripts, 'PUT', `/film/projects/${p.projectId}/script/1`, { fountain_content: withNew });
    const r = await call(handleScenes, 'POST', `/film/scenes/${p.scenes[2].id}/edit`,
        { edits: [{ find: 'Ray works under the car.', replace: 'Ray throws the wrench.' }] });
    assert.ok(r.status < 300, `the phrase edit could not find its own scene: ${JSON.stringify(r.body)}`);
    const latest = db.prepare('SELECT fountain_content FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1')
        .get(p.projectId).fountain_content;
    for (const untouched of ['A phone rings.', 'Maya pours coffee.', 'A shadow crosses the road.', 'The city hums below.']) {
        assert.ok(latest.includes(untouched), `the phrase edit overwrote another scene: "${untouched}" is gone`);
    }
    assert.ok(latest.includes('Ray throws the wrench.'));
});

test('an out-of-step edit that cannot find its scene changes nothing and says why', async () => {
    const p = await production();
    // The garage scene is gone from the document, rows not synced.
    const without = draft([SCENES[0], SCENES[1], SCENES[3]]);
    await call(handleScripts, 'PUT', `/film/projects/${p.projectId}/script/1`, { fountain_content: without });
    const before = db.prepare('SELECT COUNT(*) c FROM film_scripts WHERE project_id = ?').get(p.projectId).c;
    const r = await call(handleScenes, 'PUT', `/film/scenes/${p.scenes[2].id}`,
        { fountain: 'INT. GARAGE - NIGHT\n\nRay throws the wrench.' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'SCENES_OUT_OF_STEP');
    const after = db.prepare('SELECT COUNT(*) c FROM film_scripts WHERE project_id = ?').get(p.projectId).c;
    assert.strictEqual(after, before, 'a refused edit still saved a version');
});
