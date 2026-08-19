/**
 * Phase 2 — the two reports a production actually asks for.
 *
 * Sides (each performer's own lines, scene by scene) and DOOD (who is needed
 * where) are the reports StudioBinder names and we had neither. They matter
 * here for reasons the paper versions do not have: sides are what a director
 * reviews before spending on voice generation, and DOOD is what says which
 * characters need a reference plate and what each one will cost.
 *
 * Both are reports over presence, and presence was broken in a way that made
 * them worse than useless: it was keyed on dialogue cues, so a character
 * introduced in action was present in no scene. On Wingfall that meant the
 * DRAGON — the title creature, in most of the film — appeared in no report at
 * all. A DOOD that silently omits the most expensive subject in the production
 * is more dangerous than no DOOD, because it looks complete.
 *
 * Set-based over the report kinds, and each report is checked for the
 * non-speaking case specifically, because that is the failure that hides.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-reports-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const reports = require('../lib/production-reports');

function makeProduction() {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Wingfall');

    // Scene 1: MAYA speaks. Scene 2: the DRAGON appears and never speaks.
    const s1 = generateId(), s2 = generateId();
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, characters_present)
                VALUES (?, ?, '1', 'EXT', 'SUBURBAN STREET', 'DUSK', ?)`)
        .run(s1, projectId, JSON.stringify(['MAYA']));
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, characters_present)
                VALUES (?, ?, '2', 'EXT', 'SUBURBAN STREET', 'CONTINUOUS', ?)`)
        .run(s2, projectId, JSON.stringify(['MAYA', 'DRAGON']));

    const shot = (sceneId, code, card) => {
        const id = generateId();
        db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, duration_ms) VALUES (?, ?, ?, ?, 4000)')
            .run(id, sceneId, code, JSON.stringify(card));
        return id;
    };
    shot(s1, '1A', { shot_code: '1A', description: 'She stops.', camera: {},
        dialogue: [{ character: 'MAYA', line: 'Get inside. GET INSIDE!' }] });
    shot(s2, '2A', { shot_code: '2A', description: 'The DRAGON shears a roofline.', camera: {} });
    shot(s2, '2B', { shot_code: '2B', description: 'She runs.', camera: {},
        dialogue: [{ character: 'MAYA', line: 'Oh, you have got to be kidding me.' }] });

    for (const name of ['MAYA', 'DRAGON']) {
        db.prepare('INSERT INTO film_characters (id, project_id, name, appearance_prompt) VALUES (?, ?, ?, ?)')
            .run(generateId(), projectId, name, `${name} looks like this`);
    }
    return { projectId };
}

/** The reports, and what each must not silently omit. */
const REPORTS = [
    {
        id: 'sides',
        build: projectId => reports.buildSides(projectId),
        // A performer's sides are their lines. A character with none should
        // still appear, or a director cannot tell "no lines" from "not in it".
        mustCover: ['MAYA', 'DRAGON'],
    },
    {
        id: 'dood',
        build: projectId => reports.buildDOOD(projectId),
        mustCover: ['MAYA', 'DRAGON'],
    },
    {
        id: 'breakdown_summary',
        build: projectId => reports.buildBreakdownSummary(projectId),
        mustCover: ['MAYA', 'DRAGON', 'SUBURBAN STREET'],
    },
    {
        id: 'elements_list',
        build: projectId => reports.buildElementsList(projectId),
        mustCover: ['MAYA', 'DRAGON', 'SUBURBAN STREET'],
    },
];

test('the report registry covers the four StudioBinder names', () => {
    const ids = REPORTS.map(r => r.id).sort();
    assert.deepStrictEqual(ids, ['breakdown_summary', 'dood', 'elements_list', 'sides']);
});

test('the elements list groups by element type, not one flat bag', () => {
    // The point of an elements list is answering "what props do we need" in one
    // look. A single undifferentiated array is a database dump.
    const { projectId } = makeProduction();
    const el = reports.buildElementsList(projectId);
    for (const type of ['characters', 'locations', 'props']) {
        assert.ok(Array.isArray(el.elements[type]), `elements list has no ${type} group`);
    }
    const names = el.elements.characters.map(c => c.name);
    assert.ok(names.includes('DRAGON'), 'the non-speaking character is missing from the elements list');
});

test('the breakdown summary counts per scene, and covers every scene', () => {
    const { projectId } = makeProduction();
    const bs = reports.buildBreakdownSummary(projectId);
    const sceneCount = db.prepare('SELECT COUNT(*) c FROM film_scenes WHERE project_id = ?').get(projectId).c;
    assert.strictEqual(bs.scenes.length, sceneCount, 'a scene is missing from the breakdown summary');
    for (const sc of bs.scenes) {
        assert.ok(typeof sc.shot_count === 'number', `scene ${sc.scene}: no shot count`);
        assert.ok(Array.isArray(sc.characters), `scene ${sc.scene}: no character list`);
    }
    const s2 = bs.scenes.find(x => x.scene === '2');
    assert.ok(s2.characters.includes('DRAGON'), 'scene 2 does not list the creature that is in it');
});

test('every report generates with no manual data entry', () => {
    const { projectId } = makeProduction();
    const broken = [];
    for (const r of REPORTS) {
        let out;
        try { out = r.build(projectId); } catch (err) { broken.push(`${r.id}: threw — ${err.message}`); continue; }
        if (!out) broken.push(`${r.id}: produced nothing`);
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('no report silently omits a non-speaking character', () => {
    // The failure that hides. A DOOD missing the most expensive subject in the
    // production still looks like a complete document.
    const { projectId } = makeProduction();
    const broken = [];
    for (const r of REPORTS) {
        const out = JSON.stringify(r.build(projectId));
        for (const name of r.mustCover) {
            if (!out.includes(name)) broken.push(`${r.id}: ${name} appears nowhere in the report`);
        }
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('sides carry the actual lines, per character', () => {
    const { projectId } = makeProduction();
    const sides = reports.buildSides(projectId);
    const maya = sides.characters.find(c => c.character === 'MAYA');
    assert.ok(maya, 'MAYA has no sides');
    assert.strictEqual(maya.line_count, 2, `expected 2 lines, got ${maya.line_count}`);
    assert.ok(JSON.stringify(maya).includes('GET INSIDE'), 'the dialogue itself is missing');

    const dragon = sides.characters.find(c => c.character === 'DRAGON');
    assert.ok(dragon, 'the non-speaking character has no entry at all');
    assert.strictEqual(dragon.line_count, 0, 'a creature that never speaks was given lines');
});

test('DOOD says which scenes and shots each character is needed for', () => {
    const { projectId } = makeProduction();
    const dood = reports.buildDOOD(projectId);
    const dragon = dood.characters.find(c => c.character === 'DRAGON');
    assert.ok(dragon, 'DRAGON is absent from the DOOD');
    assert.deepStrictEqual(dragon.scenes, ['2'], `expected DRAGON in scene 2, got ${JSON.stringify(dragon.scenes)}`);
    assert.ok(dragon.shot_count >= 1, 'DRAGON is in a scene but no shots');

    const maya = dood.characters.find(c => c.character === 'MAYA');
    assert.deepStrictEqual(maya.scenes, ['1', '2'], `MAYA should span both scenes, got ${JSON.stringify(maya.scenes)}`);
});

test('DOOD reports what each character still needs generating', () => {
    // The AI reading of a DOOD: not "book the actor for 3 days" but "this
    // subject needs a reference plate before any of its shots can be
    // consistent". That is the number that predicts spend.
    const { projectId } = makeProduction();
    const dood = reports.buildDOOD(projectId);
    for (const c of dood.characters) {
        assert.ok(typeof c.has_plate === 'boolean', `${c.character}: no plate status`);
        assert.ok(typeof c.shot_count === 'number', `${c.character}: no shot count`);
    }
});
