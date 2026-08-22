/**
 * Inserting a shot suffixes it, the way production does.
 *
 * A shot added after 2A becomes 2AA, and nothing else moves.
 *
 * The tidier alternative — call it 2B and shift 2B→2C — is what a clean-slate
 * tool would do, and production does not do it. The reason applies here
 * literally rather than by analogy: the existing codes are already on the
 * slate, the call sheet and the editor's bins, and in this app they are also
 * FILENAMES (2B_v11.png), rows in the render ledger, and the word a director
 * has been using for that shot all day. Renumbering means moving every file
 * every renamed shot ever generated, and a half-applied rename orphans frames
 * on a shot nobody touched.
 *
 * So the test that matters most here is the one asserting nothing else changed.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-insert-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const { handleShots } = require('../routes/shots');

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

function call(method, urlPath, body) {
    return new Promise(resolve => {
        const parts = urlPath.split('?')[0].split('/').filter(Boolean);
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (c) { this.statusCode = c; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            let out = Buffer.concat(chunks).toString();
            try { out = JSON.parse(out); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body: out });
        });
        Promise.resolve(handleShots({ method, body: body || {} }, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

/** Scene 2 with 2A, 2B, 2C — each carrying a live frame and one archived version. */
function scene(codes = ['2A', '2B', '2C']) {
    const projectId = generateId(), sceneId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Insert Test');
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, '2')").run(sceneId, projectId);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insert-'));
    const shots = {};
    codes.forEach((code, i) => {
        const id = generateId();
        shots[code] = id;
        db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms, sort_order)
                    VALUES (?, ?, ?, ?, 4000, ?)`)
            .run(id, sceneId, code, JSON.stringify({ shot_code: code, description: code }), i);
        for (const [name, v] of [[`${code}.png`, 2], [`${code}_v1.png`, 1]]) {
            const f = path.join(dir, name);
            fs.writeFileSync(f, PNG);
            db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version)
                        VALUES (?, ?, ?, 'storyboard', ?, ?, ?)`)
                .run(generateId(), projectId, id, name, f, v);
        }
    });
    return { projectId, sceneId, shots, dir };
}

const codesInScene = sceneId => db.prepare(
    'SELECT shot_code FROM film_shots WHERE scene_id = ? ORDER BY sort_order, shot_code').all(sceneId)
    .map(r => r.shot_code);

const orderInScene = sceneId => db.prepare(
    'SELECT shot_code FROM film_shots WHERE scene_id = ? ORDER BY sort_order').all(sceneId)
    .map(r => r.shot_code);

test('a shot inserted after 2A becomes 2AA', async () => {
    const { sceneId, shots } = scene();
    const r = await call('POST', `/film/shots/${shots['2A']}/insert-after`,
        { card: { description: 'MAYA turns, hearing it before she sees it.' } });
    assert.ok(r.status < 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.shot_code, '2AA', 'the insert did not follow the production convention');
    assert.deepStrictEqual(codesInScene(sceneId).sort(), ['2A', '2AA', '2B', '2C']);
});

test('nothing else is renamed, and no file moves', async () => {
    /*
     * The whole point. Every existing code stays pointing at the same picture,
     * so a shot list already written down, and every filename on disk, stays
     * true.
     */
    const { sceneId, shots, dir } = scene();
    const before = db.prepare(
        `SELECT shot_id, file_name, file_path FROM film_assets WHERE asset_type = 'storyboard'`).all()
        .map(a => `${a.file_name}`).sort();
    const codesBefore = Object.keys(shots);

    const r = await call('POST', `/film/shots/${shots['2A']}/insert-after`, { card: { description: 'x' } });
    assert.deepStrictEqual(r.body.renamed, [], 'something was renamed');

    for (const code of codesBefore) {
        assert.strictEqual(db.prepare('SELECT shot_code FROM film_shots WHERE id = ?').get(shots[code]).shot_code,
            code, `${code} was renamed`);
    }
    const after = db.prepare(
        `SELECT file_name FROM film_assets WHERE asset_type = 'storyboard'`).all()
        .map(a => a.file_name).sort();
    assert.deepStrictEqual(after, before, 'a file was renamed');
    for (const a of db.prepare(`SELECT file_path FROM film_assets WHERE asset_type = 'storyboard'`).all()) {
        assert.ok(fs.existsSync(a.file_path), `${a.file_path} is gone — a frame was orphaned`);
    }
});

test('the new shot sits in the right PLACE even though codes did not move', async () => {
    // Order is what actually changed. If sort_order did not move, the insert is
    // just a shot appended with a confusing name.
    const { sceneId, shots } = scene();
    await call('POST', `/film/shots/${shots['2A']}/insert-after`, { card: { description: 'x' } });
    assert.deepStrictEqual(orderInScene(sceneId), ['2A', '2AA', '2B', '2C'],
        'the inserted shot is not between 2A and 2B in running order');
});

test('a second insert after the same shot walks the suffix', async () => {
    const { sceneId, shots } = scene();
    await call('POST', `/film/shots/${shots['2A']}/insert-after`, { card: { description: 'first' } });
    const r = await call('POST', `/film/shots/${shots['2A']}/insert-after`, { card: { description: 'second' } });
    assert.strictEqual(r.body.shot_code, '2AB', 'a second insert collided with the first');
    assert.deepStrictEqual(orderInScene(sceneId), ['2A', '2AB', '2AA', '2B', '2C'],
        'the newest insert did not land immediately after the shot it follows');
});

test('inserting after the last shot works too', async () => {
    const { sceneId, shots } = scene();
    const r = await call('POST', `/film/shots/${shots['2C']}/insert-after`, { card: { description: 'x' } });
    assert.strictEqual(r.body.shot_code, '2CA');
    assert.deepStrictEqual(orderInScene(sceneId), ['2A', '2B', '2C', '2CA']);
});

test('only this scene is touched', async () => {
    const a = scene(['2A', '2B']);
    const other = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, '3')")
        .run(other, a.projectId);
    const s3 = generateId();
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms)
                VALUES (?, ?, '3A', ?, 4000)`).run(s3, other, JSON.stringify({ shot_code: '3A' }));

    await call('POST', `/film/shots/${a.shots['2A']}/insert-after`, { card: { description: 'x' } });
    assert.strictEqual(db.prepare('SELECT shot_code FROM film_shots WHERE id = ?').get(s3).shot_code, '3A');
    assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM film_shots WHERE scene_id = ?').get(other).n, 1,
        'a shot landed in the wrong scene');
});

test('a shot with no description is refused', async () => {
    // It would generate from nothing, which is a frame nobody can use and a
    // credit spent finding that out.
    const { shots } = scene();
    const r = await call('POST', `/film/shots/${shots['2A']}/insert-after`, { card: {} });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
});

test('the response explains why nothing was renamed', async () => {
    /*
     * Checked on the RESPONSE, not the source. The first version grepped
     * routes/shots.js for "script supervisor" and failed while the note said
     * exactly that — the phrase is split across two concatenated string
     * literals. A test that reads source text is testing how the code is
     * formatted; what matters is what the caller receives.
     */
    const { shots } = scene();
    const r = await call('POST', `/film/shots/${shots['2A']}/insert-after`, { card: { description: 'x' } });
    assert.ok(r.body.note, 'the response says nothing about what it did');
    assert.match(r.body.note, /script supervisor/,
        'the note does not say this is a convention, so it reads as the feature being unfinished');
    assert.match(r.body.note, /Nothing else was renamed/,
        'the note does not state the guarantee a director is relying on');

    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'shots.js'), 'utf8');
    const at = src.indexOf('function insertShotAfter(');
    let i2 = src.indexOf('{', at), depth = 0, end = -1;
    for (let j = i2; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    assert.ok(!/renameSync/.test(src.slice(at, end)),
        'the insert moves files, which is what the suffix convention exists to avoid');
});
