'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TEST_DIR = path.join(os.tmpdir(), `film-sequence-frames-${crypto.randomUUID().slice(0, 8)}`);
process.env.FILM_DATA_DIR = TEST_DIR;

const { planSequenceFrames, inbetweenPrompt } = require('../lib/sequence-frames');
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const { handleSequences } = require('../routes/sequences');

function call(method, url, body) {
    return new Promise(resolve => {
        const out = [];
        const res = {
            writeHead(status) { this.statusCode = status; return this; },
            end(value) {
                out.push(value || '');
                resolve({ status: this.statusCode || 200, body: JSON.parse(out.join('') || '{}') });
            },
        };
        Promise.resolve(handleSequences({ method, url, body: body || {} }, res,
            url.split('?')[0].split('/').filter(Boolean)))
            .then(value => { if (value === false) resolve({ status: 404, body: {} }); })
            .catch(error => resolve({ status: 500, body: { error: error.message } }));
    });
}

function shot(code, duration, extra) {
    return {
        id: `shot-${code}`,
        shot_code: code,
        duration_ms: duration * 1000,
        keyframe: `/tmp/${code}.png`,
        description: `${code} action`,
        camera: { shot_type: 'medium', movement: code === '1A' ? 'dolly-in' : 'static' },
        direction: `${code} direction`,
        ...(extra || {}),
    };
}

test('motion board samples an entire sequence into at most ten ordered frames', () => {
    const plan = planSequenceFrames([
        shot('1A', 4), shot('1B', 4), shot('1C', 2),
    ]);

    assert.equal(plan.refused, false);
    assert.equal(plan.duration_ms, 8000, 'the last selected board is an endpoint, not another segment');
    assert.equal(plan.frames.length, 8);
    assert.deepEqual(plan.frames.map(f => f.index), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.ok(plan.frames.every((f, i, all) => i === 0 || f.time_ms > all[i - 1].time_ms));
    assert.equal(plan.frames[0].source_shot_id, 'shot-1A');
    assert.equal(plan.frames.at(-1).source_shot_id, 'shot-1C');
    assert.equal(plan.frames.filter(f => f.kind === 'anchor').length, 3);
});

test('ten seconds becomes ten review images and reports the honest sampling interval', () => {
    const plan = planSequenceFrames([shot('1A', 10), shot('1B', 1)]);
    assert.equal(plan.frames.length, 10);
    assert.equal(plan.duration_ms, 10000);
    assert.equal(plan.interval_ms, 10000 / 9);
    assert.equal(plan.frames[0].time_ms, 0);
    assert.equal(plan.frames.at(-1).time_ms, 10000);
});

test('storyboard anchors follow cumulative shot timing instead of equal shot spacing', () => {
    const planned = planSequenceFrames([
        shot('WIDE', 8),
        shot('CUTAWAY', 1),
        shot('CLOSE', 1),
    ]);
    const anchors = planned.frames.filter(frame => frame.kind === 'anchor');
    assert.deepEqual(anchors.map(frame => frame.index), [0, 7, 8]);
    assert.deepEqual(anchors.map(frame => frame.source_shot_code), ['WIDE', 'CUTAWAY', 'CLOSE']);
});

test('every selected storyboard remains an anchor and more than ten is refused', () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => shot(`${i + 1}A`, 1));
    const plan = planSequenceFrames(tooMany);
    assert.equal(plan.refused, true);
    assert.match(plan.reason, /10/);
});

test('in-between prompt carries sequence, endpoint, camera and per-frame direction', () => {
    const from = shot('1A', 4);
    const to = shot('1B', 4);
    const prompt = inbetweenPrompt({
        sequenceDescription: 'Rainy continuous move.',
        frame: { index: 2, time_ms: 2200, progress: 0.55, direction: 'Keep her hand on the rail.' },
        from,
        to,
    });

    assert.match(prompt, /Rainy continuous move/);
    assert.match(prompt, /1A action/);
    assert.match(prompt, /1B action/);
    assert.match(prompt, /dolly-in/);
    assert.match(prompt, /Keep her hand on the rail/);
    assert.match(prompt, /same characters|continuous/i);
});

test('motion-board route persists storyboard anchors and missing in-betweens', async () => {
    const projectId = generateId();
    const sceneId = generateId();
    const sequenceId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, provider_config) VALUES (?, ?, ?)')
        .run(projectId, 'Motion board', JSON.stringify({ video: 'seedance' }));
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)')
        .run(sceneId, projectId, '1');
    const dir = path.join(TEST_DIR, 'storyboards', projectId);
    fs.mkdirSync(dir, { recursive: true });
    const ids = [];
    for (const code of ['1A', '1B']) {
        const shotId = generateId();
        const assetId = generateId();
        const fileName = `${code}.png`;
        const filePath = path.join(dir, fileName);
        fs.writeFileSync(filePath, Buffer.from('89504e470d0a1a0a', 'hex'));
        ids.push(shotId);
        db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, duration_ms, scene_card_yaml)
                    VALUES (?, ?, ?, 5000, ?)`).run(shotId, sceneId, code,
            JSON.stringify({ description: `${code} action`, camera: { movement: 'dolly-in' } }));
        db.prepare(`INSERT INTO film_assets
            (id, project_id, shot_id, asset_type, file_path, file_name, format, version)
            VALUES (?, ?, ?, 'storyboard', ?, ?, 'png', 1)`).run(
            assetId, projectId, shotId, filePath, fileName);
    }
    db.prepare(`INSERT INTO film_sequences (id, project_id, name, shot_ids, description)
                VALUES (?, ?, 'Crossing', ?, 'A continuous move.')`)
        .run(sequenceId, projectId, JSON.stringify(ids));

    const response = await call('GET', `/film/sequences/${sequenceId}/frames`);
    assert.equal(response.status, 200, response.body.error);
    assert.equal(response.body.frame_count, 5);
    assert.equal(response.body.frames[0].kind, 'anchor');
    assert.equal(response.body.frames[0].status, 'approved');
    assert.ok(response.body.frames[0].image_url);
    assert.equal(response.body.frames.at(-1).kind, 'anchor');
    assert.equal(response.body.frames.filter(f => f.kind === 'inbetween').length, 3);
    assert.ok(response.body.frames.filter(f => f.kind === 'inbetween').every(f => f.status === 'missing'));

    const middle = response.body.frames.find(f => f.kind === 'inbetween');
    const premature = await call('PUT', `/film/sequences/${sequenceId}/frames/${middle.index}`,
        { status: 'approved', direction: 'Keep the hand visible.' });
    assert.equal(premature.status, 409, 'a missing frame was approved without an image');

    const saved = await call('PUT', `/film/sequences/${sequenceId}/frames/${middle.index}`,
        { status: 'draft', direction: 'Keep the hand visible.' });
    assert.equal(saved.status, 200);
    const again = await call('GET', `/film/sequences/${sequenceId}/frames`);
    assert.equal(again.body.frames.length, 5, 'opening the board twice duplicated its rows');
    assert.equal(again.body.frames.find(f => f.index === middle.index).direction,
        'Keep the hand visible.');

    const replacementId = generateId();
    db.prepare(`INSERT INTO film_assets
        (id, project_id, shot_id, asset_type, file_path, file_name, format, version)
        VALUES (?, ?, ?, 'storyboard', ?, ?, 'png', 2)`).run(
        replacementId, projectId, ids[0], path.join(TEST_DIR, 'replacement.png'), 'replacement.png');
    db.prepare('UPDATE film_shots SET current_frame_version = 2 WHERE id = ?').run(ids[0]);
    const refreshed = await call('GET', `/film/sequences/${sequenceId}/frames`);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.frames[0].asset_id, replacementId,
        'changing the selected storyboard left a stale approved anchor');
    assert.ok(refreshed.body.frames.filter(f => f.kind === 'inbetween')
        .every(f => f.status === 'missing'), 'dependent in-betweens were not invalidated');
});

test('Video Shots exposes review, correction, approval and complete-image generation controls', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    for (const token of ['openMotionBoard(', 'generateMissingMotionFrames(', 'regenerateMotionFrame(',
        'setMotionFrameApproval(', 'generateMotionBoardVideo(']) {
        assert.ok(html.includes(token), `Video Shots is missing ${token}`);
    }
    assert.match(html, /Generate video from \$\{frames\.length\} images/,
        'the final action does not say the complete image count it sends');
});

test.after(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));
