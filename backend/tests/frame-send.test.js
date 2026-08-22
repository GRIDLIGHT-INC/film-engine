/**
 * Sending a frame to another shot.
 *
 * "There is a shot I'd like to put to 2A from 2B."
 *
 * Generation is a coin flip you already paid for, and sometimes the picture
 * that comes back on 2B is the right shot for 2A — a better angle on the same
 * street, or simply the take that worked. Before this the only way to get it
 * there was to regenerate 2A and hope, which pays twice for a picture you
 * already have.
 *
 * Set-based over the guarantees a send must make, because the failure modes are
 * independent and each is silent: a send that moves the file breaks the source,
 * one that skips archiving destroys the target's current frame, and one that
 * shares a path makes deleting either shot break the other.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-send-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const { handleStoryboard } = require('../routes/storyboard');

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
        Promise.resolve(handleStoryboard({ method, body: body || {} }, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

/** A project with two shots; the source carries `versions` attempts. */
function twoShots(versions = 3, targetFrames = 1) {
    const projectId = generateId(), sceneId = generateId();
    const src = generateId(), dst = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Send Test');
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, '2')").run(sceneId, projectId);
    for (const [id, code] of [[src, '2B'], [dst, '2A']]) {
        db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms)
                    VALUES (?, ?, ?, ?, 4000)`)
            .run(id, sceneId, code, JSON.stringify({ shot_code: code, description: code }));
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-'));
    const add = (shotId, code, v) => {
        const f = path.join(dir, `${code}_v${v}.png`);
        fs.writeFileSync(f, Buffer.concat([PNG, Buffer.from(`${code}${v}`)]));
        db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version)
                    VALUES (?, ?, ?, 'storyboard', ?, ?, ?)`)
            .run(generateId(), projectId, shotId, `${code}_v${v}.png`, f, v);
        return f;
    };
    for (let v = 1; v <= versions; v++) add(src, '2B', v);
    for (let v = 1; v <= targetFrames; v++) add(dst, '2A', v);
    return { projectId, src, dst, dir };
}

const frames = shotId => call('GET', `/film/shots/${shotId}/frames`);

test('a version can be sent to another shot', async () => {
    const { src, dst } = twoShots();
    const r = await call('POST', `/film/shots/${src}/frames/2/send`, { target_shot_id: dst });
    assert.ok(r.status < 400, JSON.stringify(r.body));
    assert.strictEqual(r.body.to_shot_code, '2A');
    assert.strictEqual(r.body.from_version, 2);
});

test('the SOURCE keeps every version it had', async () => {
    // A send is a copy. Moving the file would take the picture off the shot
    // that generated it, which is a destructive verb hiding inside a helpful
    // one.
    const { src, dst } = twoShots();
    const before = (await frames(src)).body.versions.map(v => v.version).sort();
    await call('POST', `/film/shots/${src}/frames/2/send`, { target_shot_id: dst });
    const after = (await frames(src)).body.versions.map(v => v.version).sort();
    assert.deepStrictEqual(after, before, 'sending a frame changed the source shot');
});

test('the TARGET gains a version rather than silently overwriting', async () => {
    // On the receiving side this IS a new picture, so it is a new attempt — and
    // whatever the target was showing has to survive, or a send destroys work
    // in the one direction nobody is watching.
    const { src, dst } = twoShots(3, 2);
    const before = (await frames(dst)).body.versions.length;
    const r = await call('POST', `/film/shots/${src}/frames/2/send`, { target_shot_id: dst });
    const after = await frames(dst);
    assert.strictEqual(after.body.versions.length, before + 1,
        'the target did not gain a version');
    assert.strictEqual(after.body.versions.find(v => v.is_current).version, r.body.to_version,
        'the sent frame is not what the target shows');
});

test('the two shots never share a file', async () => {
    // Sharing a path means deleting either shot, or regenerating either, breaks
    // the other — and the damage surfaces on the shot nobody touched.
    const { src, dst } = twoShots();
    await call('POST', `/film/shots/${src}/frames/2/send`, { target_shot_id: dst });
    const paths = db.prepare(
        `SELECT shot_id, file_path FROM film_assets WHERE asset_type = 'storyboard'`).all();
    const byPath = new Map();
    for (const row of paths) {
        const key = path.resolve(row.file_path || '');
        if (byPath.has(key) && byPath.get(key) !== row.shot_id) {
            assert.fail(`two shots share ${key}`);
        }
        byPath.set(key, row.shot_id);
    }
});

test('the target records where the picture came from', async () => {
    // A frame on 2A that was generated from 2B's card is not stale, it is
    // BORROWED — and a director looking at it later needs to know that without
    // reconstructing it.
    const { src, dst } = twoShots();
    const r = await call('POST', `/film/shots/${src}/frames/2/send`, { target_shot_id: dst });
    const row = db.prepare(
        `SELECT metadata FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard'
          ORDER BY version DESC LIMIT 1`).get(dst);
    const meta = JSON.parse(row.metadata || '{}');
    assert.ok(meta.sent_from, 'the sent frame does not record its origin');
    assert.match(String(meta.sent_from), /2B/, `origin does not name the source shot: ${meta.sent_from}`);
    assert.ok(r.body.note, 'the response does not explain what was done');
});

test('sending to the same shot is refused', async () => {
    const { src } = twoShots();
    const r = await call('POST', `/film/shots/${src}/frames/2/send`, { target_shot_id: src });
    assert.ok(r.status >= 400, 'a shot could send a frame to itself');
});

test('sending across projects is refused', async () => {
    // Assets live under a project directory and a different project is a
    // different film. Allowing it would put a file where nothing expects it.
    const a = twoShots();
    const b = twoShots();
    const r = await call('POST', `/film/shots/${a.src}/frames/2/send`, { target_shot_id: b.dst });
    assert.ok(r.status >= 400, 'a frame was sent into another project');
    assert.match(JSON.stringify(r.body), /project/i, 'the refusal does not say why');
});

test('a version with no picture of its own cannot be sent', async () => {
    const { src, dst } = twoShots();
    db.prepare(`UPDATE film_assets SET file_path = '/nowhere/gone.png'
                 WHERE shot_id = ? AND version = 2`).run(src);
    const r = await call('POST', `/film/shots/${src}/frames/2/send`, { target_shot_id: dst });
    assert.ok(r.status >= 400, 'a missing picture was sent anyway');
});

test('a locked board refuses to receive', async () => {
    // The lock protects the pictures on a board. A send that lands on a locked
    // board replaces one of them, so it is exactly what the lock is for.
    const { projectId, src, dst } = twoShots();
    db.prepare('UPDATE film_projects SET board_locked_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);
    const r = await call('POST', `/film/shots/${src}/frames/2/send`, { target_shot_id: dst });
    assert.strictEqual(r.status, 423, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, 'BOARD_LOCKED');
});

test('the versions modal offers Send to, and picks a target', () => {
    const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    assert.ok(/sendFrameTo\(/.test(HTML), 'the versions modal has no Send to control');
    const fn = HTML.slice(HTML.indexOf('async function sendFrameTo('),
        HTML.indexOf('async function sendFrameTo(') + 2500);
    assert.ok(fn.length > 100, 'sendFrameTo is not defined');
    assert.ok(/frames\/\$\{version\}\/send|\/send`/.test(fn), 'it never calls the send route');
    assert.ok(/shot_code/.test(fn), 'the picker does not name the shots, so a target cannot be chosen');
});
