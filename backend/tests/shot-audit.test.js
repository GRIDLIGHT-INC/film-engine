/**
 * The pre-flight, tested on the defects that produced it.
 *
 * Every one of these is a real finding from a hand audit of a sixteen-shot
 * commercial, done shot by shot with `shot_prompt` because nothing in the
 * engine would do it. Three existing reports called that board clean.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-audit-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { auditShots } = require('../lib/shot-audit');
const { subjectNameMatches, resolveCardSubjects } = require('../lib/shot-references');

function seed(cards, opts) {
    const o = opts || {};
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Audit Test');
    const sceneId = generateId();
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, description)
                VALUES (?, ?, 1, 'EXT', 'AVENUE', ?, 'A street.')`)
        .run(sceneId, projectId, o.time_of_day || 'NIGHT');

    for (const p of (o.props || [])) {
        db.prepare(`INSERT INTO film_props (id, project_id, name, visual_prompt, height_m)
                    VALUES (?, ?, ?, ?, ?)`)
            .run(generateId(), projectId, p.name, p.visual_prompt || '', p.height_m || null);
    }
    cards.forEach((card, i) => {
        db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, sort_order)
                    VALUES (?, ?, ?, ?, ?)`)
            .run(generateId(), sceneId, card.shot_code, JSON.stringify(card), i);
    });
    return { projectId, sceneId };
}

const findingsOf = (r, type) => r.findings.filter(f => f.type === type);

test('a plural in the action line still finds the singular subject', () => {
    /*
     * \bSWARMER\b does not match "SWARMERS" — R and S are both word
     * characters. A card named the creature, an approved plate sat on disk,
     * and the request carried neither the picture nor a description. The one
     * shot whose entire purpose was a five-rung scale ladder was going to be
     * generated with four rungs and an invented fifth.
     */
    assert.ok(subjectNameMatches('SWARMER', 'SWARMERS pouring over rubble'),
        'a plural in the prose loses the subject again');
    assert.ok(subjectNameMatches('BRUTE', 'a BRUTE shouldering through'), 'the singular broke');
    assert.ok(!subjectNameMatches('BRUTE', 'BRUTALLY cold'),
        'matching inside another word attaches the wrong plate, which is worse than a miss');
});

test('a subject the card names and the project cannot supply is an ERROR', () => {
    // The only failure that INVENTS a frame rather than degrading one: it
    // looks like a rendering choice, not a missing record.
    const { projectId } = seed([{ shot_code: '1A', description: 'He walks.', characters: ['GHOST'] }]);
    const r = auditShots(projectId);
    const errs = findingsOf(r, 'unresolved_subject');
    assert.strictEqual(errs.length, 1, `expected one unresolved subject, got ${JSON.stringify(r.findings)}`);
    assert.strictEqual(errs[0].severity, 'error');
    assert.ok(r.blocking, 'an unresolved subject must be able to stop a run');
});

test('a subject with a plate but no description is a warning, not an error', () => {
    const { projectId } = seed(
        [{ shot_code: '1A', description: 'The car waits.', props: ['THE CAR'] }],
        { props: [{ name: 'THE CAR', visual_prompt: '', height_m: 1.4 }] });
    const r = auditShots(projectId);
    // No plate AND no description is unresolvable; here there is neither, so
    // it is still an error. Pinned so the distinction cannot quietly invert.
    assert.ok(findingsOf(r, 'unresolved_subject').length === 1,
        'a subject with neither a plate nor a description must report as unresolved');
});

test('a subject in the frame only because the prose names it is flagged', () => {
    /*
     * Works today, breaks on the next rewrite. Reword the action and the
     * creature silently leaves the picture — a director changing prose does
     * not expect to be changing the cast.
     */
    const { projectId } = seed(
        [{ shot_code: '2A', description: 'He steps past THE NORTHLINE and keeps walking.', props: [] }],
        { props: [{ name: 'THE NORTHLINE', visual_prompt: 'a black car', height_m: 1.28 }] });
    const r = auditShots(projectId);
    const implicit = findingsOf(r, 'implicit_subject');
    assert.strictEqual(implicit.length, 1, JSON.stringify(r.findings));
    assert.strictEqual(implicit[0].subject, 'THE NORTHLINE');
});

test('the phrasing lint is ONE note per shot, and never blocks', () => {
    /*
     * The first run of this audit returned thirty-two findings of which
     * twenty-four were this rule and several were false. A report that is
     * three-quarters one noisy rule teaches the reader to skim past the rule
     * that matters.
     */
    const { projectId } = seed([{
        shot_code: '1A',
        description: 'NO FLARE anywhere. No smoke either. Nothing moves.',
        direction: 'NO DIALOGUE in this shot.',
    }]);
    const r = auditShots(projectId);
    const lint = findingsOf(r, 'negative_phrasing');
    assert.ok(lint.length <= 1, `expected at most one lint note per shot, got ${lint.length}`);
    if (lint.length) {
        assert.strictEqual(lint[0].severity, 'info', 'phrasing must never be able to block a run');
        assert.ok(lint[0].count >= 2, 'the collapsed note must still say how many sentences it covers');
    }
});

test('a subject that leaves a continuous sequence and returns is reported', () => {
    /*
     * The hero car: established beside him, walked PAST at the top of the
     * next scene, and arrived at again several shots later. Either it
     * followed him or there are two of them — and the setup the film rests
     * on, the phone BECOMING this car, needs it to be one of them.
     */
    const { projectId } = seed([
        { shot_code: '1A', description: 'He stands beside THE NORTHLINE.', props: ['THE NORTHLINE'] },
        { shot_code: '1B', description: 'He walks. The avenue widens.', props: [] },
        { shot_code: '1C', description: 'Smoke on the skyline.', props: [] },
        { shot_code: '1D', description: 'He reaches THE NORTHLINE and pulls the door.', props: ['THE NORTHLINE'] },
    ], {
        time_of_day: 'CONTINUOUS',
        props: [{ name: 'THE NORTHLINE', visual_prompt: 'a black car', height_m: 1.28 }],
    });
    const r = auditShots(projectId);
    const tp = findingsOf(r, 'subject_teleport');
    assert.strictEqual(tp.length, 1, `expected one teleport, got ${JSON.stringify(tp)}`);
    assert.strictEqual(tp[0].subject, 'THE NORTHLINE');
    assert.strictEqual(tp[0].shot_code, '1D', 'the finding should sit on the shot it reappears in');
});

test('resolving a card writes the subjects down instead of rediscovering them', () => {
    // Resolution used to happen from the description on every request, which
    // made the cast of a frame a property of how a sentence was phrased.
    const { projectId } = seed([], {
        props: [{ name: 'SWARMER', visual_prompt: 'a low insectile thing', height_m: 0.7 }],
    });
    const resolved = resolveCardSubjects(db, projectId,
        { description: 'SWARMERS pour over the rubble.', characters: [], props: [] });
    assert.deepStrictEqual(resolved.props, ['SWARMER'],
        'the plural in the prose did not put the creature on the card');
    assert.deepStrictEqual(resolved.unresolved, []);
});

test('a creature filed under characters still resolves as the prop it is', () => {
    // Creatures and vehicles read as characters to whoever writes the card,
    // and the breakdown files them there. Only card.props was consulted.
    const { projectId } = seed([], {
        props: [{ name: 'COLOSSUS', visual_prompt: 'a vast silhouette', height_m: 90 }],
    });
    const resolved = resolveCardSubjects(db, projectId,
        { description: 'Something enormous crosses the far end.', characters: ['COLOSSUS'], props: [] });
    assert.deepStrictEqual(resolved.props, ['COLOSSUS']);
    assert.deepStrictEqual(resolved.characters, []);
    assert.deepStrictEqual(resolved.unresolved, [], 'a real prop was reported as unresolvable');
});
