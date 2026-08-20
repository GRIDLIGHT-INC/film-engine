/**
 * A scene card can be edited in the app.
 *
 * There was no route to change one. PUT /shots/:id/order and /transition
 * existed; the card itself — the description every keyframe, clip and report is
 * built from — could only be written by whoever created the shot. So a director
 * looking at a frame that came back wrong had no way to change what it was
 * generated from: 1B asked for a shadow cast across house fronts, got a
 * bird-shaped silhouette floating on the sky, and the only remedy inside Film
 * Engine was to regenerate from the same words.
 *
 * Editing a card is not a convenience. It is the loop closing: look at the
 * frame, change the description, generate again. Without it the app can produce
 * a shot and cannot revise one.
 *
 * Set-based over the card fields a director actually edits, because a route
 * that saves the description and drops the camera is worse than none — it looks
 * like it worked.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-cardedit-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handleShots } = require('../routes/shots');

function call(method, urlPath, body) {
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
        Promise.resolve(handleShots({ method, body: body || {} }, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

function makeShot() {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Edit Test');
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, '1')").run(sceneId, projectId);
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms) VALUES (?, ?, ?, ?, 4000)')
        .run(shotId, sceneId, '1B', JSON.stringify({
            shot_code: '1B',
            description: 'An enormous slow shadow slides left to right.',
            camera: { shot_type: 'wide', lens: '24mm', movement: 'static' },
            lighting: { type: 'natural' },
            characters: ['MAYA'],
            dialogue: [{ character: 'MAYA', line: 'Get inside.' }],
        }));
    return { projectId, shotId };
}

/** The fields a director edits, and a changed value for each. */
const CARD_FIELDS = [
    { key: 'description', value: 'Light drops across the house fronts as something passes overhead, unseen.' },
    { key: 'camera', value: { shot_type: 'medium', lens: '50mm', movement: 'pan-left' } },
    { key: 'lighting', value: { type: 'practical' } },
    { key: 'characters', value: ['MAYA', 'DRAGON'] },
    { key: 'dialogue', value: [{ character: 'MAYA', line: 'GET INSIDE!' }] },
];

test('every card field a director edits can be saved', async () => {
    const broken = [];
    for (const field of CARD_FIELDS) {
        const { shotId } = makeShot();
        const r = await call('PUT', `/film/shots/${shotId}`, { [field.key]: field.value });
        if (r.status >= 400) { broken.push(`${field.key}: refused — ${JSON.stringify(r.body)}`); continue; }
        const card = JSON.parse(db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(shotId).scene_card_yaml);
        if (JSON.stringify(card[field.key]) !== JSON.stringify(field.value)) {
            broken.push(`${field.key}: saved ${JSON.stringify(card[field.key])}`);
        }
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('editing one field leaves the others alone', async () => {
    // A card is a whole document. A PUT that replaced it would quietly drop the
    // dialogue every time someone fixed a typo in the action.
    const { shotId } = makeShot();
    await call('PUT', `/film/shots/${shotId}`, { description: 'Rewritten action only.' });
    const card = JSON.parse(db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(shotId).scene_card_yaml);
    assert.strictEqual(card.description, 'Rewritten action only.');
    assert.deepStrictEqual(card.camera, { shot_type: 'wide', lens: '24mm', movement: 'static' }, 'camera was lost');
    assert.ok(card.dialogue && card.dialogue.length, 'dialogue was lost');
    assert.strictEqual(card.shot_code, '1B', 'the shot code was lost');
});

test('an edit that would break the card is refused', async () => {
    // The card is validated everywhere else it is written; an edit route that
    // skipped validation would be the one way to get a broken card in.
    const { shotId } = makeShot();
    const r = await call('PUT', `/film/shots/${shotId}`, { camera: 'not an object' });
    assert.ok(r.status >= 400, `accepted a malformed camera: ${JSON.stringify(r.body)}`);
});

test('editing the card makes what was generated from it stale', async () => {
    // The whole point of the edit is that the frame no longer matches. If
    // staleness did not notice, the board would keep showing a frame built from
    // words that no longer exist.
    const fp = require('../lib/artefact-fingerprint');
    const { projectId, shotId } = makeShot();
    const assetId = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name)
                VALUES (?, ?, ?, 'storyboard', '/tmp/1B.png', '1B.png')`).run(assetId, projectId, shotId);
    fp.stampAsset(assetId, 'keyframe', { shotId });

    const fresh = () => fp.isStale(
        db.prepare('SELECT input_fingerprint FROM film_assets WHERE id = ?').get(assetId),
        fp.fingerprintFor('keyframe', { shotId }));
    assert.strictEqual(fresh(), false, 'stale before anything changed');

    await call('PUT', `/film/shots/${shotId}`, { description: 'Something else entirely happens here.' });
    assert.strictEqual(fresh(), true, 'the card changed and the frame still claims to match it');
});
