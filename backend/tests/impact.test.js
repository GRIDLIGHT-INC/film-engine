/**
 * What one change breaks, all the way down.
 *
 * Every link in screenplay → card → keyframe → clip → lip-sync → post was
 * already tracked, and none of them were tracked together. `staleInputs` looks
 * exactly one level up, and only at generation time, so it answers "may I
 * generate this" and never "you just changed the storyboard, and 1B's footage
 * was built on the old frame".
 *
 * One level is not enough, for a precise reason. Change a keyframe and the
 * clip's inputs are visibly stale — but the lip-sync's are NOT, because its
 * input is the clip and the clip has not been regenerated yet, so its
 * fingerprint has not moved. Every stage below the second looks current right
 * up until you fix the one above it, at which point the next warning appears.
 * The director discovers the work one layer at a time, in the worst order,
 * having already re-run half of it.
 *
 * Set-based over the chain, because a report that walks four of six links is
 * indistinguishable from a correct one until the day it costs a re-render.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-impact-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { impact, chain } = require('../lib/impact');
const { ARTEFACT_KINDS } = require('../lib/artefact-fingerprint');
const { stampScene, stampShot } = require('../lib/screenplay-drift');

/** A shot with a keyframe, a clip and a lip-sync, all stamped as current. */
function seed() {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Impact Test');
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, description)
                VALUES (?, ?, '1', 'EXT', 'STREET', 'DUSK', 'The dragon passes overhead.')`)
        .run(sceneId, projectId);
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '1B', JSON.stringify({ shot_code: '1B', description: 'a shadow', camera: {} }));
    stampScene(sceneId);
    stampShot(shotId, sceneId);
    return { projectId, sceneId, shotId };
}

/** Register an artefact of `kind` as having been generated from `fingerprint`. */
function generated(seedIds, kind, fingerprint) {
    const id = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name,
                    artefact_kind, input_fingerprint, fingerprinted_at)
                VALUES (?, ?, ?, 'other', ?, ?, ?, datetime('now'))`)
        .run(id, seedIds.projectId, seedIds.shotId, `${kind}.bin`, kind, fingerprint);
    return id;
}

function stagesOf(report, shotCode) {
    const shot = report.shots.find(s => s.shot_code === shotCode);
    if (!shot) return {};
    return Object.fromEntries(shot.stages.map(s => [s.stage, s.state]));
}

test('the chain covers every generated kind the orchestrator sequences', () => {
    // A report that walks four of six links looks exactly like a correct one.
    const walked = new Set(chain().map(s => s.id));
    const sequenced = require('../lib/pipeline-engine').PIPELINE_STEPS
        .filter(s => ARTEFACT_KINDS[s.id]).map(s => s.id);
    const missing = sequenced.filter(id => !walked.has(id));
    assert.deepStrictEqual(missing, [],
        `these stages can never be reported as behind: ${missing.join(', ')}`);
    assert.ok(walked.has('scene_card'), 'the chain has no root, so a script change reaches nothing');
});

test('a project where nothing changed reports nothing', () => {
    const s = seed();
    const report = impact(s.projectId);
    assert.strictEqual(report.shots_affected, 0, JSON.stringify(report.shots));
});

test('changing the storyboard warns that the footage built on it needs redoing', () => {
    // The case exactly as a director states it: "I changed 1B's frame and there
    // is already footage — tell me the footage is now wrong."
    const s = seed();
    generated(s, 'keyframe', 'keyframe-as-generated');
    generated(s, 'video', 'video-built-on-the-old-frame');

    const state = stagesOf(impact(s.projectId), '1B');
    assert.strictEqual(state.keyframe, 'redo',
        'the keyframe does not match what it would be generated from, and was not flagged');
    assert.strictEqual(state.video, 'waiting',
        'the footage built on that frame was not flagged at all');
});

test('waiting work is named as waiting, not as work to do now', () => {
    // This split is the whole value. Reported as one undifferentiated pile, a
    // single change reads as "start again" — which is wrong, and the fastest
    // way to get the warnings switched off.
    const s = seed();
    generated(s, 'keyframe', 'stale');
    generated(s, 'video', 'stale');
    generated(s, 'lipsync', 'stale');

    const shot = impact(s.projectId).shots.find(x => x.shot_code === '1B');
    const redo = shot.stages.filter(r => r.state === 'redo').map(r => r.stage);
    assert.deepStrictEqual(redo, ['keyframe'],
        'more than one thing was presented as doable now, so the order is a guess');
    assert.ok(shot.next && shot.next.stage === 'keyframe', 'the report does not say what to do first');

    // Regenerating the clip here would build on the same old frame.
    const clip = shot.stages.find(r => r.stage === 'video');
    assert.strictEqual(clip.state, 'waiting');
    assert.match(clip.action, /Wait until/);
});

test('a script revision puts the whole shot downstream of the card', () => {
    const s = seed();
    generated(s, 'keyframe', 'was-current');
    generated(s, 'video', 'was-current');

    db.prepare('UPDATE film_scenes SET description = ? WHERE id = ?')
        .run('The dragon turns for her.', s.sceneId);
    stampScene(s.sceneId);

    const state = stagesOf(impact(s.projectId), '1B');
    assert.strictEqual(state.scene_card, 'redo', 'the rewritten scene did not reach its card');
    assert.strictEqual(state.keyframe, 'waiting',
        'the frame is downstream of a card that is being rewritten, and was told to regenerate now');
    assert.strictEqual(state.video, 'waiting');
});

test('stages that were never generated are not reported as work', () => {
    // An absent clip is not behind. Listing it would turn every unfinished
    // project into a wall of warnings about work nobody has started.
    const s = seed();
    generated(s, 'keyframe', 'stale');
    const shot = impact(s.projectId).shots.find(x => x.shot_code === '1B');
    const named = shot.stages.map(r => r.stage);
    assert.ok(!named.includes('post'), 'a stage that was never generated is reported as needing redoing');
    assert.ok(!named.includes('voice'));
});

test('an unstamped artefact is outside the workflow, not suspect', () => {
    // Same rule as every other fingerprint here: NULL means this predates
    // tracking, and flagging it would make the feature debut as a false alarm.
    const s = seed();
    const id = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, artefact_kind)
                VALUES (?, ?, ?, 'other', 'keyframe.png', 'keyframe')`)
        .run(id, s.projectId, s.shotId);
    assert.strictEqual(impact(s.projectId).shots_affected, 0);
});

test('the counts distinguish work to do from work to wait for', () => {
    const s = seed();
    generated(s, 'keyframe', 'stale');
    generated(s, 'video', 'stale');
    const report = impact(s.projectId);
    assert.strictEqual(report.redo_now, 1);
    assert.strictEqual(report.waiting, 1);
});

test('the board shows the impact where the frames are', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    assert.ok(/loadImpact\(\)/.test(html), 'the board never asks what a change has broken');
    assert.ok(/function impactTag\(/.test(html), 'no per-frame mark, so the report points nowhere');
});
