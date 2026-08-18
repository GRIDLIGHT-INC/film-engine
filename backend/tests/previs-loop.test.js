/**
 * The storyboard/previs iteration loop.
 *
 * Blocking now shapes the keyframe AND the clip, and /previs/apply writes the
 * staged camera back onto the card. That makes the two views agree at a moment
 * in time. It does not yet make them a LOOP.
 *
 * A director does not block once and shoot. They stage, look at the frame,
 * restage, look again, and only when the frame stops changing do they spend a
 * credit on footage. Three things that loop needs are missing, and each is
 * missing in a way an example-based test would not catch:
 *
 *   - You cannot get INTO the stage from what was written. /previs/solve takes
 *     shot_type and focal_mm from the request body, so a shot whose card
 *     already says "close-up, 50mm" makes the director retype both before the
 *     3D view shows anything. The loop has no entry edge.
 *
 *   - You cannot see the frame you generated while restaging it. The
 *     `imageplane` primitive exists and reads `o.src`, but nothing on the
 *     server ever tells the viewer where the shot's own keyframe is, so the one
 *     picture worth standing in the scene is the one you must go and find.
 *
 *   - Nothing records that you were happy. film_shots.status already permits
 *     'approved' and no generation path reads it. Approve a blocking, keep
 *     fiddling, generate — and you get footage of a shot you never approved,
 *     with nothing anywhere saying so.
 *
 * Set-based over the loop's directed edges rather than over one route, because
 * five of these eight edges already exist: a test that checked "previs reaches
 * the storyboard" passes today and would keep passing with the loop still open
 * at both ends. The registry below IS the claim.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-loop-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handlePrevis } = require('../routes/previs');
const { loadShotContext, buildCapabilityPayload } = require('../lib/capability-payloads');

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeShot(cameraCard) {
    const projectId = generateId();
    const sceneId = generateId();
    const shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Loop Test');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)')
        .run(sceneId, projectId, '1');
    const card = JSON.stringify({
        shot_code: '1A',
        description: 'She stops at the door.',
        camera: cameraCard || { shot_type: 'close-up', lens: '50mm', movement: 'dolly-in' },
    });
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms) VALUES (?, ?, ?, ?, ?)')
        .run(shotId, sceneId, 'SH01', card, 4000);
    return { projectId, sceneId, shotId };
}

function call(method, urlPath, body) {
    return new Promise(resolve => {
        const parts = urlPath.split('?')[0].split('/').filter(Boolean);
        const req = { method, body: body || {} };
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            const raw = Buffer.concat(chunks).toString();
            let parsed = raw;
            try { parsed = JSON.parse(raw); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body: parsed });
        });
        Promise.resolve(handlePrevis(req, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

const BLOCKING = {
    camera: { position: [0, 1.6, 3], rotation: [0, 0, 0], focalMm: 50, sensorId: 'super35', fStop: 2.8, focusDistanceM: 3 },
    subject: { position: [0, 0, 0], heightM: 1.7 },
    stage: { widthM: 12, depthM: 12 },
    rig: 'dolly',
    movement: 'dolly-in',
};

async function blockedShot(cameraCard) {
    const ids = makeShot(cameraCard);
    const saved = await call('PUT', `/film/shots/${ids.shotId}/previs`, BLOCKING);
    assert.ok(saved.status < 400, `fixture blocking did not save: ${JSON.stringify(saved.body)}`);
    return ids;
}

/**
 * The loop, as directed edges. Each `check` returns null when the edge is
 * carried and a string saying what is broken when it is not.
 *
 * Direction matters and is part of the identity: `blocking → card` existing
 * says nothing about `card → blocking`, and it was precisely the second one
 * that was missing while the first was called "the round trip".
 */
const LOOP_EDGES = [
    {
        id: 'card->blocking',
        what: 'a written shot can seed the 3D stage without retyping it',
        async check() {
            const { shotId } = makeShot({ shot_type: 'close-up', lens: '85mm', movement: 'pan-left' });
            const r = await call('POST', `/film/shots/${shotId}/previs/from-card`);
            if (r.status === 404 || r.status === 405) return 'no /previs/from-card route';
            if (r.status >= 400) return `from-card refused: ${JSON.stringify(r.body)}`;
            const got = await call('GET', `/film/shots/${shotId}/previs`);
            const cam = (got.body && got.body.blocking && got.body.blocking.camera) || {};
            if (Math.round(Number(cam.focalMm)) !== 85) return `card said 85mm, stage got ${cam.focalMm}`;
            if (got.body.blocking.movement !== 'pan-left') return `card movement not carried (${got.body.blocking.movement})`;
            return null;
        },
    },
    {
        id: 'blocking->card',
        what: 'what was staged is written back onto the scene card',
        async check() {
            const { shotId } = await blockedShot();
            const r = await call('POST', `/film/shots/${shotId}/previs/apply`);
            if (r.status >= 400) return `apply refused: ${JSON.stringify(r.body)}`;
            const row = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(shotId);
            const card = JSON.parse(row.scene_card_yaml || '{}');
            if (!card.camera || card.camera.lens !== '50mm') return `card lens not updated: ${JSON.stringify(card.camera)}`;
            return null;
        },
    },
    {
        id: 'blocking->image-payload',
        what: 'the keyframe is generated from the blocking, not the written card',
        async check() {
            const { shotId } = await blockedShot();
            const ctx = loadShotContext(shotId);
            if (!ctx || !ctx.previs) return 'loadShotContext does not carry previs';
            const { payload } = buildCapabilityPayload('image', ctx);
            if (!/50mm/.test(payload.prompt || '')) return `image prompt does not carry the staged lens: ${payload.prompt}`;
            return null;
        },
    },
    {
        id: 'blocking->image-preview',
        what: 'the image payload can be previewed before spending a credit',
        async check() {
            const { shotId } = await blockedShot();
            const r = await call('POST', `/film/shots/${shotId}/previs/to-storyboard`);
            if (r.status >= 400) return `to-storyboard refused: ${JSON.stringify(r.body)}`;
            if (!r.body || !r.body.payload) return 'no payload returned';
            return null;
        },
    },
    {
        id: 'blocking->video-payload',
        what: 'the clip is generated from the blocking',
        async check() {
            const { shotId } = await blockedShot();
            const ctx = loadShotContext(shotId);
            const { payload } = buildCapabilityPayload('video', ctx);
            const cc = payload.camera_control || {};
            if (!cc.rig && !cc.path) return 'camera_control carries neither rig nor path';
            return null;
        },
    },
    {
        id: 'blocking->video-preview',
        what: 'the clip payload can be previewed before spending a credit',
        async check() {
            const { shotId } = await blockedShot();
            const r = await call('POST', `/film/shots/${shotId}/previs/to-video`);
            if (r.status >= 400) return `to-video refused: ${JSON.stringify(r.body)}`;
            const p = r.body && (r.body.payload || r.body);
            if (!p || !p.prompt) return 'no payload returned';
            return null;
        },
    },
    {
        id: 'keyframe->stage',
        what: 'the generated frame can stand in the stage you are restaging',
        async check() {
            const { projectId, shotId } = await blockedShot();
            const assetId = generateId();
            db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name)
                        VALUES (?, ?, ?, 'storyboard', ?, ?)`)
                .run(assetId, projectId, shotId, `/tmp/${shotId}.png`, 'SH01.png');
            const r = await call('GET', `/film/shots/${shotId}/previs`);
            if (r.status >= 400) return `GET previs refused: ${JSON.stringify(r.body)}`;
            if (!('keyframe' in (r.body || {}))) return 'blocking response never mentions the shot keyframe';
            if (!r.body.keyframe || !r.body.keyframe.src) return 'keyframe present but carries no src for an image card';
            return null;
        },
    },
    {
        id: 'approval->generation',
        what: 'footage is not generated from a blocking that changed after approval',
        async check() {
            const { shotId } = await blockedShot();
            const ok = await call('POST', `/film/shots/${shotId}/previs/approve`);
            if (ok.status === 404 || ok.status === 405) return 'no /previs/approve route';
            if (ok.status >= 400) return `approve refused: ${JSON.stringify(ok.body)}`;

            // Approved, then restaged. This is the loop's actual failure: the
            // frame that gets shot is not the frame that was signed off.
            const moved = { ...BLOCKING, camera: { ...BLOCKING.camera, focalMm: 24 } };
            const changed = await call('PUT', `/film/shots/${shotId}/previs`, moved);
            if (changed.status >= 400) return `restage refused: ${JSON.stringify(changed.body)}`;

            const gen = await call('POST', `/film/shots/${shotId}/previs/to-video`);
            if (gen.status < 400) return 'stale approval generated anyway (no gate)';
            const forced = await call('POST', `/film/shots/${shotId}/previs/to-video`, { ignore_approval: true });
            if (forced.status >= 400) return 'the gate cannot be overridden, so a wrong fingerprint is unrecoverable';
            return null;
        },
    },
];

test('the loop registry describes distinct directed edges', () => {
    const ids = LOOP_EDGES.map(e => e.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate edge ids');
    assert.ok(ids.includes('card->blocking') && ids.includes('blocking->card'),
        'a round trip needs both directions named separately');
});

test('every edge of the storyboard/previs loop is carried', async () => {
    const broken = [];
    for (const edge of LOOP_EDGES) {
        let why;
        try { why = await edge.check(); } catch (err) { why = `threw: ${err.message}`; }
        if (why) broken.push(`${edge.id} (${edge.what}): ${why}`);
    }
    assert.deepStrictEqual(broken, [],
        `the loop is open at ${broken.length}/${LOOP_EDGES.length} edges:\n  ${broken.join('\n  ')}`);
});

test('an unapproved shot is never gated, so nothing that worked stops working', async () => {
    const { shotId } = await blockedShot();
    const r = await call('POST', `/film/shots/${shotId}/previs/to-video`);
    assert.ok(r.status < 400,
        `a shot that was never approved must generate exactly as before, got ${r.status}`);
});
