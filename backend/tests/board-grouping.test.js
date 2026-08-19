/**
 * Phase 3 — grouping a board, and grouping shots into setups.
 *
 * Two different questions that look alike.
 *
 * PANEL GROUPING is for reading. A flat grid of 200 frames is a contact sheet;
 * a director reads a board scene by scene, or by location when deciding what a
 * day covers. StudioBinder groups by scene, location or shooting day.
 *
 * SETUP GROUPING is for working. On a set, a camera setup is a lighting and
 * camera position you shoot several shots from before moving — you group by it
 * because MOVING is what costs. Here nothing moves, so the cost is elsewhere:
 * shots that share a plate, a style and a lens reuse the same conditioning, and
 * grouping them is what makes a run cheap and a look consistent. Same word,
 * different expense, and copying the set meaning literally would produce
 * grouping that saves nothing.
 *
 * Set-based over the grouping axes, because a board that groups by scene and
 * silently ignores location sends the director back to the flat grid.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-group-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { groupFrames, GROUP_AXES, buildSetups } = require('../lib/board-grouping');

function makeProject() {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title, style_preset) VALUES (?, ?, ?)')
        .run(projectId, 'Grouping Test', 'teal and amber, anamorphic');

    const mk = (sceneNo, location, shots) => {
        const sceneId = generateId();
        db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, location, time_of_day)
                    VALUES (?, ?, ?, ?, 'DUSK')`).run(sceneId, projectId, sceneNo, location);
        for (const [code, card] of shots) {
            db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
                .run(generateId(), sceneId, code, JSON.stringify({ shot_code: code, camera: {}, ...card }));
        }
        return sceneId;
    };

    mk('1', 'SUBURBAN STREET', [
        ['1A', { description: 'wide', camera: { shot_type: 'wide', lens: '24mm' }, characters: ['MAYA'] }],
        ['1B', { description: 'also wide', camera: { shot_type: 'wide', lens: '24mm' }, characters: ['MAYA'] }],
        ['1C', { description: 'close', camera: { shot_type: 'close-up', lens: '85mm' }, characters: ['MAYA'] }],
    ]);
    mk('2', 'KITCHEN', [
        ['2A', { description: 'kitchen wide', camera: { shot_type: 'wide', lens: '24mm' }, characters: ['MAYA'] }],
    ]);
    return projectId;
}

test('the axes registry matches what the grouper accepts', () => {
    assert.ok(GROUP_AXES.includes('scene'), 'no scene axis');
    assert.ok(GROUP_AXES.includes('location'), 'no location axis');
    assert.ok(GROUP_AXES.length >= 2, 'a single axis is not a choice');
});

test('every axis groups the whole board, losing no frame', () => {
    const projectId = makeProject();
    const total = db.prepare(
        `SELECT COUNT(*) c FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id WHERE s.project_id = ?`)
        .get(projectId).c;

    const broken = [];
    for (const axis of GROUP_AXES) {
        const groups = groupFrames(projectId, axis);
        const counted = groups.reduce((n, g) => n + g.frames.length, 0);
        if (counted !== total) broken.push(`${axis}: grouped ${counted} of ${total} frames`);
        if (!groups.length) broken.push(`${axis}: produced no groups at all`);
        if (groups.some(g => !g.label)) broken.push(`${axis}: a group has no label to read`);
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('grouping by scene and by location give different shapes here', () => {
    // Both scenes are DUSK but in different places, so an axis that collapsed
    // them would be indistinguishable from the flat grid.
    const projectId = makeProject();
    const byScene = groupFrames(projectId, 'scene').map(g => g.label);
    const byLocation = groupFrames(projectId, 'location').map(g => g.label);
    assert.notDeepStrictEqual(byScene, byLocation, 'the axes are the same grouping under two names');
    assert.ok(byLocation.some(l => /KITCHEN/i.test(l)), `location grouping lost the kitchen: ${byLocation}`);
});

test('setups group shots that reuse the same conditioning', () => {
    // 1A and 1B are the same framing and lens in the same scene: one setup.
    // 1C is a different lens, so it is its own. 2A matches 1A's optics but is a
    // different location, so it cannot reuse the plate.
    const projectId = makeProject();
    const setups = buildSetups(projectId);
    const of = code => setups.find(s => s.shots.some(x => x.shot_code === code));

    assert.ok(of('1A'), '1A is in no setup');
    assert.strictEqual(of('1A').id, of('1B').id, '1A and 1B share optics and location and were split');
    assert.notStrictEqual(of('1A').id, of('1C').id, '1C is a different lens and was merged anyway');
    assert.notStrictEqual(of('1A').id, of('2A').id, 'a different location cannot reuse the same plate');
});

test('every shot lands in exactly one setup', () => {
    const projectId = makeProject();
    const setups = buildSetups(projectId);
    const codes = setups.flatMap(s => s.shots.map(x => x.shot_code));
    assert.strictEqual(new Set(codes).size, codes.length, `a shot is in two setups: ${codes.join(', ')}`);
    const total = db.prepare(
        `SELECT COUNT(*) c FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id WHERE s.project_id = ?`)
        .get(projectId).c;
    assert.strictEqual(codes.length, total, 'a shot belongs to no setup');
});

test('a setup says what it shares, so the saving is legible', () => {
    const projectId = makeProject();
    const setup = buildSetups(projectId).find(s => s.shots.length > 1);
    assert.ok(setup, 'nothing grouped, so there is no saving to show');
    assert.ok(setup.shared && setup.shared.lens, 'the setup does not say which lens it shares');
    assert.ok(setup.shots.length >= 2);
});
