/**
 * THE PREVENTION. A check nobody runs is a check that does not exist.
 *
 * This engine grew three free-standing checkers — `elements_list` reports
 * undescribed subjects, `scale_check` missing sizes, `prompt-lint` negative
 * phrasing. A sixteen-shot board was then audited BY HAND and found four
 * defects that all three had been quietly reporting nothing about. Not
 * because any was weak: because nothing made anybody look.
 *
 * So the audit runs at the one place a person passes on their way to spending
 * money, and its ERRORS refuse the run on exactly the terms compliance
 * already does.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-auditgate-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { buildRunPlan } = require('../lib/run-plan');

/** A project whose one card names a subject the project does not have. */
function seedWithGhost() {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Gate Test');
    const sceneId = generateId();
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, description)
                VALUES (?, ?, 1, 'EXT', 'AVENUE', 'NIGHT', 'A street.')`).run(sceneId, projectId);
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, sort_order)
                VALUES (?, ?, '1A', ?, 0)`).run(generateId(), sceneId, JSON.stringify({
        shot_code: '1A', description: 'He walks past it.', characters: ['GHOST'],
    }));
    return projectId;
}

function seedClean() {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Clean Test');
    const sceneId = generateId();
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, description)
                VALUES (?, ?, 1, 'EXT', 'AVENUE', 'NIGHT', 'A street.')`).run(sceneId, projectId);
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, sort_order)
                VALUES (?, ?, '1A', ?, 0)`).run(generateId(), sceneId, JSON.stringify({
        shot_code: '1A', description: 'An empty street.', characters: [], props: [],
    }));
    return projectId;
}

test('a plan REFUSES when a card names a subject the model would have to invent', () => {
    const plan = buildRunPlan(seedWithGhost(), {});
    assert.strictEqual(plan.blocked_by_audit, true,
        'a card naming an unresolvable subject did not block the run');
    assert.strictEqual(plan.refused, true,
        'the plan reports the block and lets the run proceed anyway');
    assert.ok(plan.audit && plan.audit.counts.error > 0, 'the plan carries no audit counts');
    assert.ok(plan.audit.errors.some(e => e.type === 'unresolved_subject'),
        'the refusal does not name what is wrong');
    assert.match(plan.audit.refusal, /ignore_audit/,
        'the refusal does not say how to override it deliberately');
});

test('a clean project is not blocked, and still gets the counts', () => {
    // A gate that fires on healthy work is one people switch off.
    const plan = buildRunPlan(seedClean(), {});
    assert.strictEqual(plan.blocked_by_audit, false, 'a clean board was refused');
    assert.ok(plan.audit && plan.audit.counts, 'a clean plan carries no audit summary at all');
    assert.strictEqual(plan.audit.counts.error, 0);
});

test('ignore_audit is a deliberate override, not a default', () => {
    const projectId = seedWithGhost();
    assert.strictEqual(buildRunPlan(projectId, {}).blocked_by_audit, true);
    assert.strictEqual(buildRunPlan(projectId, { ignore_audit: true }).blocked_by_audit, false,
        'a director cannot overrule the gate, which makes it a wall rather than a check');
});

test('warnings never block — only errors do', () => {
    /*
     * The compliance gate's own comment: "a warning that stops a run makes the
     * check something people switch off." The audit's warnings are real and
     * worth reading; none of them justifies refusing to spend.
     */
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Warn Test');
    const sceneId = generateId();
    db.prepare(`INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, description)
                VALUES (?, ?, 1, 'EXT', 'AVENUE', 'NIGHT', 'A street.')`).run(sceneId, projectId);
    db.prepare('INSERT INTO film_props (id, project_id, name, visual_prompt, height_m) VALUES (?,?,?,?,?)')
        .run(generateId(), projectId, 'THE CAR', 'a black car', 1.4);
    db.prepare(`INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, sort_order)
                VALUES (?, ?, '1A', ?, 0)`).run(generateId(), sceneId, JSON.stringify({
        shot_code: '1A', description: 'He steps past THE CAR.', characters: [], props: [],
    }));

    const plan = buildRunPlan(projectId, {});
    assert.ok(plan.audit.counts.warning > 0, 'no warning was produced, so this proves nothing');
    assert.strictEqual(plan.audit.counts.error, 0);
    assert.strictEqual(plan.blocked_by_audit, false, 'a warning refused a run');
});

test('an audit that throws never refuses a legitimate run', () => {
    /*
     * The audit exists to stop money being wasted. A crash inside it that
     * blocked a generation would be the check costing more than the bug it
     * was added to catch.
     */
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'run-plan.js'), 'utf8');
    const fn = src.slice(src.indexOf('function auditFor'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
    assert.ok(/try\s*\{/.test(body) && /catch/.test(body), 'auditFor can throw into the run plan');
    assert.match(body, /blocks:\s*false/, 'a failed audit does not fall back to letting the run through');
});
