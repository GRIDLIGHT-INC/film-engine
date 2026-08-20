/**
 * Every spec on the mood board changes something that gets generated.
 *
 * A board that collects choices nobody reads is a form. The lens/sensor/aperture
 * trio was exactly that for a while: validated, stored, and consulted only by
 * previs/from-card — so it applied to whichever shots someone had opened the 3D
 * stage for, and the rest of the film generated on a default belonging to no
 * production.
 *
 * So this does not check that a spec is STORED. Storage was never the problem.
 * For each kind it changes the value and asserts that a real payload — the
 * thing a provider or an editor actually receives — comes out different. A spec
 * that can be changed without changing any output is decoration, and this test
 * exists to say so by name.
 *
 * Set-based over SPEC_KINDS, because the failure was per-kind: three of eight
 * reached nothing while the other five worked, and nothing was checking the
 * eight together.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-spec-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const look = require('../lib/look-development');
const { buildCapabilityPayload, loadShotContext } = require('../lib/capability-payloads');

function makeProduction() {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId(), charId = generateId();
    db.prepare(`INSERT INTO film_projects (id, title, style_preset, aspect_ratio, target_resolution, target_fps, color_space, provider_config)
                VALUES (?, 'Spec Test', 'teal and amber', '16:9', '1920x1080', 24, 'Rec.709', ?)`)
        .run(projectId, JSON.stringify({ image: 'meshy', video: 'runway' }));
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location, time_of_day) VALUES (?, ?, '1', 'STREET', 'DUSK')")
        .run(sceneId, projectId);
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms)
                VALUES (?, ?, '1A', ?, 4000)`)
        .run(shotId, sceneId, JSON.stringify({
            shot_code: '1A', description: 'She stops.',
            // Camera deliberately EMPTY: a spec that only shows up when the card
            // is silent is exactly the case that was broken.
            camera: {}, lighting: { type: 'natural' }, characters: ['MAYA'],
        }));
    db.prepare('INSERT INTO film_characters (id, project_id, name, appearance_prompt) VALUES (?, ?, ?, ?)')
        .run(charId, projectId, 'MAYA', 'mid-30s woman, rust cardigan');
    return { projectId, sceneId, shotId };
}

function setSpec(projectId, kind, value) {
    db.prepare('DELETE FROM film_mood_board WHERE project_id = ? AND spec_kind = ?').run(projectId, kind);
    db.prepare(`INSERT INTO film_mood_board (id, project_id, kind, note, spec_kind, spec_value)
                VALUES (?, ?, 'lens', '', ?, ?)`).run(generateId(), projectId, kind, String(value));
}

/**
 * Two legal values per kind, and the OUTPUT each is supposed to move.
 *
 * `observe` returns something a provider or an editor receives. If both values
 * produce the same observation, the spec reached nothing.
 */
const SPEC_EFFECTS = {
    lens: {
        a: 40, b: 135,
        observe: ids => buildCapabilityPayload('image', loadShotContext(ids.shotId)).payload.prompt,
        reaches: 'the image prompt, when the card names no lens',
    },
    sensor: {
        a: 'super35', b: 'fullframe',
        observe: ids => JSON.stringify(look.filmOptics(db, ids.projectId)),
        reaches: 'previs, as the sensor a stage is seeded with',
    },
    aperture: {
        a: 2.8, b: 8,
        observe: ids => JSON.stringify(look.filmOptics(db, ids.projectId)),
        reaches: 'previs, as the stop a stage is seeded with',
    },
    aspect_ratio: {
        a: '16:9', b: '2.39:1',
        observe: ids => JSON.stringify(buildCapabilityPayload('image', loadShotContext(ids.shotId)).payload),
        reaches: 'the image payload, which sizes the frame that is generated',
    },
    resolution: {
        a: '1080p', b: '4k_uhd',
        observe: ids => db.prepare('SELECT target_resolution FROM film_projects WHERE id = ?').get(ids.projectId).target_resolution,
        reaches: 'target_resolution, which the NLE export and the conform read',
    },
    frame_rate: {
        a: 24, b: 25,
        observe: ids => {
            const ctx = loadShotContext(ids.shotId);
            return JSON.stringify(buildCapabilityPayload('video', ctx).payload);
        },
        reaches: 'the video payload fps, and the NLE export timebase',
    },
    color_space: {
        a: 'Rec.709', b: 'DCI-P3',
        observe: ids => db.prepare('SELECT color_space FROM film_projects WHERE id = ?').get(ids.projectId).color_space,
        reaches: 'color_space, which the NLE export and the QA rubric read',
    },
    style_preset: {
        a: 'noir', b: 'anime',
        observe: ids => buildCapabilityPayload('image', loadShotContext(ids.shotId)).payload.prompt,
        reaches: 'the image prompt, as the look every frame is generated in',
    },
};

test('every spec kind on the board is covered here', () => {
    const kinds = Object.keys(look.SPEC_KINDS).sort();
    const covered = Object.keys(SPEC_EFFECTS).sort();
    assert.deepStrictEqual(covered, kinds,
        `a spec kind with no proof of consumption: ${kinds.filter(k => !covered.includes(k)).join(', ')}`);
    assert.strictEqual(kinds.length, 8);
});

test('changing any spec changes something that gets generated', () => {
    const dead = [];
    for (const [kind, spec] of Object.entries(SPEC_EFFECTS)) {
        const ids = makeProduction();

        setSpec(ids.projectId, kind, spec.a);
        if (look.SPEC_KINDS[kind].target === 'project') {
            look.applyProjectSpecs(db, ids.projectId, [{ kind, value: spec.a }]);
        }
        if (kind === 'style_preset') {
            db.prepare('UPDATE film_projects SET style_preset = ? WHERE id = ?').run(spec.a, ids.projectId);
        }
        let before;
        try { before = spec.observe(ids); } catch (err) { dead.push(`${kind}: observing threw — ${err.message}`); continue; }

        setSpec(ids.projectId, kind, spec.b);
        if (look.SPEC_KINDS[kind].target === 'project') {
            look.applyProjectSpecs(db, ids.projectId, [{ kind, value: spec.b }]);
        }
        if (kind === 'style_preset') {
            db.prepare('UPDATE film_projects SET style_preset = ? WHERE id = ?').run(spec.b, ids.projectId);
        }
        let after;
        try { after = spec.observe(ids); } catch (err) { dead.push(`${kind}: observing threw — ${err.message}`); continue; }

        if (String(before) === String(after)) {
            dead.push(`${kind}: changing it changed nothing — it should reach ${spec.reaches}`);
        }
    }
    assert.deepStrictEqual(dead, [], `\n  ${dead.join('\n  ')}`);
});

test('the three previs specs reach a shot nobody has blocked', () => {
    // The specific regression. These were only read by previs/from-card, so a
    // film where one shot of eight had been staged had seven shots generating
    // on a lens belonging to no production.
    const ids = makeProduction();
    for (const [kind, value] of [['lens', 135], ['sensor', 'fullframe'], ['aperture', 8]]) {
        setSpec(ids.projectId, kind, value);
    }
    const blocked = db.prepare('SELECT COUNT(*) c FROM film_previs_blocking WHERE shot_id = ?').get(ids.shotId).c;
    assert.strictEqual(blocked, 0, 'fixture accidentally blocked the shot, which is the case that already worked');

    const prompt = buildCapabilityPayload('image', loadShotContext(ids.shotId)).payload.prompt;
    assert.match(prompt, /135\s*mm/, `the film's lens never reached an unblocked shot: ${prompt}`);
});

test('a spec never overrides a choice the scene card already made', () => {
    // The board says what the production shoots on; the card says what THIS
    // shot does. A default that outranks an explicit choice is worse than none.
    const ids = makeProduction();
    setSpec(ids.projectId, 'lens', 135);
    db.prepare('UPDATE film_shots SET scene_card_yaml = ? WHERE id = ?').run(JSON.stringify({
        shot_code: '1A', description: 'She stops.', camera: { lens: '24mm' }, lighting: { type: 'natural' },
    }), ids.shotId);

    const prompt = buildCapabilityPayload('image', loadShotContext(ids.shotId)).payload.prompt;
    assert.match(prompt, /24\s*mm/, 'the card lost to the production default');
    assert.ok(!/135\s*mm/.test(prompt), 'both lenses reached the prompt');
});
