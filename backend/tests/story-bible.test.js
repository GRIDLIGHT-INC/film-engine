/**
 * The material a production is written from.
 *
 * A bible is prose, and no prose reaches an image model. Four fields do — a
 * character's appearance_prompt, a location's description, a prop's
 * visual_prompt, and the project's style_preset — and everything else in this
 * database is decoration as far as a generated frame is concerned. A place that
 * merely STORES a bible repeats the mood board's first mistake: it collects
 * writing nobody reads and calls it a feature, and a director pastes sixty
 * pages in believing their frames are now conditioned on it.
 *
 * What earns its place is the link back. An entity records which section its
 * description was written from, so revising that section flags the entity and
 * the plate built from it. Set-based over the three subject kinds, because the
 * link is per kind and a version that tracks characters while silently ignoring
 * props is indistinguishable from a working one until a prop changes.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-bible-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { SUBJECTS, listSections, writeSections, stampSubject, drift } = require('../lib/story-bible');

function seed() {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Bible Test');
    const ids = {};
    ids.character = generateId();
    db.prepare('INSERT INTO film_characters (id, project_id, name) VALUES (?, ?, ?)')
        .run(ids.character, projectId, 'MAYA');
    ids.location = generateId();
    db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, ?)')
        .run(ids.location, projectId, 'SUBURBAN STREET');
    ids.prop = generateId();
    db.prepare('INSERT INTO film_props (id, project_id, name) VALUES (?, ?, ?)')
        .run(ids.prop, projectId, 'SEDAN');
    return { projectId, ids };
}

test('every subject kind can be written from the bible and tracked', () => {
    const s = seed();
    writeSections(s.projectId, {
        MAYA: 'Thirties. Runs like someone who used to.',
        'SUBURBAN STREET': 'A cul-de-sac that has not changed since 1979.',
        SEDAN: 'Forest green, oxidised, one wheel trim missing.',
    });

    const untracked = SUBJECTS.filter(spec => {
        const section = { character: 'MAYA', location: 'SUBURBAN STREET', prop: 'SEDAN' }[spec.kind];
        return !stampSubject(spec.kind, s.ids[spec.kind], section);
    }).map(spec => spec.kind);

    assert.deepStrictEqual(untracked, [],
        `these kinds cannot record where their description came from: ${untracked.join(', ')}`);
    assert.deepStrictEqual(drift(s.projectId), [], 'freshly written entities are reported as behind');
});

test('revising one section flags only what was written from it', () => {
    // A single fingerprint over the whole bible would mark every character in
    // the film as behind the moment someone fixed a typo in the world rules,
    // and a warning that fires on work nobody needs to redo is one people
    // learn to dismiss.
    const s = seed();
    writeSections(s.projectId, { MAYA: 'Thirties.', SEDAN: 'Forest green.' });
    stampSubject('character', s.ids.character, 'MAYA');
    stampSubject('prop', s.ids.prop, 'SEDAN');

    writeSections(s.projectId, { MAYA: 'Thirties. A runner, before.' });

    const behind = drift(s.projectId);
    assert.strictEqual(behind.length, 1, `expected one entity behind, got ${behind.length}`);
    assert.strictEqual(behind[0].name, 'MAYA');
    assert.strictEqual(behind[0].kind, 'character');
});

test('writing a section with the same words flags nothing', () => {
    const s = seed();
    writeSections(s.projectId, { MAYA: 'Thirties.' });
    stampSubject('character', s.ids.character, 'MAYA');
    writeSections(s.projectId, { MAYA: 'Thirties.' });
    assert.deepStrictEqual(drift(s.projectId), []);
});

test('writing merges rather than replacing the rest of the bible', () => {
    // A caller fixing one section must not have to resend the others; that is
    // how a bible loses a chapter to a retry.
    const s = seed();
    writeSections(s.projectId, { MAYA: 'Thirties.', World: 'Dragons are weather.' });
    writeSections(s.projectId, { MAYA: 'Thirties, and tired.' });
    const names = listSections(s.projectId).map(x => x.section).sort();
    assert.deepStrictEqual(names, ['MAYA', 'World']);
});

test('an entity never written from the bible is never flagged', () => {
    // NULL means "not written from the bible", not "stale" — the same rule
    // every other fingerprint here follows, and what keeps this from
    // retroactively flagging every entity that predates it.
    const s = seed();
    writeSections(s.projectId, { MAYA: 'Thirties.' });
    writeSections(s.projectId, { MAYA: 'Completely different.' });
    assert.deepStrictEqual(drift(s.projectId), []);
});

test('a link to a section that does not exist is not recorded', () => {
    const s = seed();
    assert.strictEqual(stampSubject('character', s.ids.character, 'NOBODY'), null);
    assert.deepStrictEqual(drift(s.projectId), []);
});

test('deleting a section reports what was written from it', () => {
    // Silently unlinking would lose the only record that a description came
    // from something that no longer exists.
    const s = seed();
    writeSections(s.projectId, { MAYA: 'Thirties.' });
    stampSubject('character', s.ids.character, 'MAYA');
    db.prepare('DELETE FROM film_story_bible WHERE project_id = ? AND section = ?').run(s.projectId, 'MAYA');

    const behind = drift(s.projectId);
    assert.strictEqual(behind.length, 1);
    assert.match(behind[0].reason, /deleted/);
});

test('the report says whether a plate was built on the old words', () => {
    // "MAYA's section changed" and "and her plate was generated from the
    // previous version" are different sizes of problem.
    const s = seed();
    writeSections(s.projectId, { MAYA: 'Thirties.' });
    stampSubject('character', s.ids.character, 'MAYA');
    db.prepare(`INSERT INTO film_assets (id, project_id, character_id, asset_type, file_name)
                VALUES (?, ?, ?, 'character_sheet', 'maya_front.png')`)
        .run(generateId(), s.projectId, s.ids.character);

    writeSections(s.projectId, { MAYA: 'Forties.' });
    assert.strictEqual(drift(s.projectId)[0].plated, true, 'the generated plate is not reported');
});

test('the surface says what a bible does not do', () => {
    // The whole failure mode is a director pasting sixty pages in and believing
    // their frames are now conditioned on it.
    const { PRODUCTION_TOOLS } = require('../lib/mcp-tools');
    const get = PRODUCTION_TOOLS.find(t => t.name === 'bible_get');
    assert.ok(get, 'no bible_get tool');
    assert.match(get.description, /reaches no image model/i,
        'the tool does not say that a bible alone conditions nothing');
    for (const field of ['appearance_prompt', 'visual_prompt', 'style_preset']) {
        assert.ok(get.description.includes(field), `the tool never names ${field} as what actually generates`);
    }
});
