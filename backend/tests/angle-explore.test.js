/**
 * Four angles on one shot, and "I love B" makes B the shot.
 *
 * The director chose four SEPARATE generations over one 2x2 grid, so the
 * picked candidate is ready for the board as it is. Held here:
 *   - four distinct camera requests, one per angle, through the real route;
 *   - each at the PROJECT's resolution, which is the rule every image follows;
 *   - nothing reaches the board frame until a pick;
 *   - a pick makes a new frame version, archives what was showing, and names
 *     the exploration and the angle it came from;
 *   - a locked board refuses the pick, not the exploration.
 * A capturing adapter stands in for Nano Banana Pro, so nothing is bought.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-angles-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const providers = require('../lib/providers');
const { handleStoryboard } = require('../routes/storyboard');
const AE = require('../lib/angle-explore');

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');

const CAPTURED = [];
providers.register({
    id: 'angles-capture',
    label: 'Capture (test)',
    capabilities: ['image'],
    supportsReferenceImages: true,
    supportsReferenceTags: false,
    maxReferenceImages: 5,
    maxImagePixels: 3840 * 2160,
    promptLimit: 4000,
    supports(cap) { return cap === 'image'; },
    async generate(capability, payload) {
        CAPTURED.push(payload);
        return { ok: true, data: PNG, model: 'capture-1' };
    },
});

function call(method, urlPath, body) {
    return new Promise(resolve => {
        const [p, qs] = urlPath.split('?');
        const parts = p.split('/').filter(Boolean);
        const query = {};
        for (const kv of (qs || '').split('&').filter(Boolean)) {
            const [k, v] = kv.split('=');
            query[decodeURIComponent(k)] = decodeURIComponent(v || '');
        }
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
        Promise.resolve(handleStoryboard({ method, body: body || {} }, res, parts, query))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

function shotOn(resolution) {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare(`INSERT INTO film_projects (id, title, provider_config, aspect_ratio, target_resolution)
                VALUES (?, 'Angles', ?, '16:9', ?)`)
        .run(projectId, JSON.stringify({ image: 'angles-capture' }), resolution);
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, '1', 'DINER')")
        .run(sceneId, projectId);
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms)
                VALUES (?, ?, '1A', ?, 4000)`)
        .run(shotId, sceneId, JSON.stringify({ shot_code: '1A', description: 'She waits at the counter.',
            camera: { shot_type: 'medium' } }));
    return { projectId, shotId };
}

async function waitFor(shotId, token) {
    for (let i = 0; i < 200; i++) {
        const r = await call('GET', `/film/shots/${shotId}/storyboard/angles/${token}`);
        if (r.body && r.body.status && r.body.status !== 'running') return r.body;
        await new Promise(res => setTimeout(res, 25));
    }
    throw new Error('the exploration never finished');
}

test('four angles by default, each a different camera, the first as written', () => {
    const angles = AE.resolveAngles(null);
    assert.deepStrictEqual(angles.map(a => a.slot), ['A', 'B', 'C', 'D']);
    assert.strictEqual(angles[0].direction, '', 'A is the control: the shot as written');
    const directions = angles.slice(1).map(a => a.direction);
    assert.strictEqual(new Set(directions).size, 3, 'two angles ask for the same camera');
    const card = { description: 'x', direction: 'She is tired.', camera: { shot_type: 'medium' } };
    const low = AE.cardForAngle(card, angles[2]);
    assert.strictEqual(card.camera.height_m, undefined, 'the original card was changed');
    assert.ok(low.camera.height_m < 1, 'the low angle does not lower the camera');
    assert.match(low.direction, /^She is tired\. Camera:/, 'the director’s own direction does not lead');
});

test('named angles replace the defaults and are padded to four', () => {
    const angles = AE.resolveAngles(['over his shoulder, 85mm', { label: 'Top down', direction: 'directly overhead' }]);
    assert.strictEqual(angles.length, 4);
    assert.match(angles[0].direction, /over his shoulder/);
    assert.strictEqual(angles[1].label, 'Top down');
    assert.strictEqual(angles[2].named, false);
});

test('the contact sheet reads A B over C D', () => {
    const args = AE.sheetArgs(['a', 'b', 'c', 'd'], 'out.png', { width: 1280, height: 720 });
    const graph = args[args.indexOf('-filter_complex') + 1];
    assert.match(graph, /layout=0_0\|1280_0\|0_720\|1280_720/);
});

test('the preview is free, shows four prompts, and sizes them from the project', async () => {
    for (const [res, width] of [['1280x720', 1280], ['3840x2160', 3840]]) {
        const { shotId } = shotOn(res);
        const before = CAPTURED.length;
        const r = await call('GET', `/film/shots/${shotId}/storyboard/angles-preview`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(CAPTURED.length, before, 'the preview spent money');
        assert.strictEqual(r.body.angles.length, 4);
        assert.strictEqual(new Set(r.body.angles.map(a => a.prompt)).size, 4, 'two angles send the same prompt');
        for (const a of r.body.angles) assert.strictEqual(a.width, width, `${res}: ${a.slot} is ${a.width} wide`);
        assert.strictEqual(r.body.spend.images, 4);
    }
});

test('four generations, none on the board, then a pick makes B the frame', async () => {
    const { projectId, shotId } = shotOn('1280x720');
    const before = CAPTURED.length;
    const start = await call('POST', `/film/shots/${shotId}/storyboard/angles`, {});
    assert.strictEqual(start.status, 202, JSON.stringify(start.body));
    const done = await waitFor(shotId, start.body.token);
    assert.strictEqual(done.status, 'complete', JSON.stringify(done));

    const sent = CAPTURED.slice(before);
    assert.strictEqual(sent.length, 4, `${sent.length} generations for four angles`);
    assert.strictEqual(new Set(sent.map(p => p.prompt)).size, 4, 'the four requests were not four cameras');
    for (const p of sent) assert.deepStrictEqual([p.width, p.height], [1280, 720], 'not the project resolution');

    const live = path.join(process.env.FILM_DATA_DIR, 'storyboards', projectId, '1A.png');
    assert.ok(!fs.existsSync(live), 'an exploration wrote the board frame before anything was picked');
    assert.strictEqual(done.candidates.length, 4);
    assert.ok(done.sheet_url, 'the four were not joined into a contact sheet');

    const pick = await call('POST', `/film/shots/${shotId}/storyboard/angles/${start.body.token}/pick`, { slot: 'B' });
    assert.strictEqual(pick.status, 200, JSON.stringify(pick.body));
    assert.ok(fs.existsSync(live), 'the pick did not reach the board');
    const row = db.prepare(`SELECT version, metadata FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard'
        ORDER BY version DESC LIMIT 1`).get(shotId);
    assert.strictEqual(row.version, pick.body.version);
    assert.strictEqual(JSON.parse(row.metadata).angle_from.slot, 'B');

    // Changing your mind is another pick, not another purchase.
    const spent = CAPTURED.length;
    const again = await call('POST', `/film/shots/${shotId}/storyboard/angles/${start.body.token}/pick`, { slot: 'C' });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.version, pick.body.version + 1);
    assert.strictEqual(CAPTURED.length, spent, 'a pick spent money');
});

test('a locked board refuses the pick, not the exploration', async () => {
    const { projectId, shotId } = shotOn('1280x720');
    db.prepare("UPDATE film_projects SET board_locked_at = datetime('now') WHERE id = ?").run(projectId);
    const start = await call('POST', `/film/shots/${shotId}/storyboard/angles`, {});
    assert.strictEqual(start.status, 202, JSON.stringify(start.body));
    await waitFor(shotId, start.body.token);
    const pick = await call('POST', `/film/shots/${shotId}/storyboard/angles/${start.body.token}/pick`, { slot: 'A' });
    assert.strictEqual(pick.status, 423);
});
