/**
 * A project can be deleted, including one that has actually been worked on.
 *
 * DELETE /projects/:id returned 500 on any project that had generated a
 * character reference sheet: film_refsheet_jobs declared its foreign keys with
 * no ON DELETE action, so removing a character it referenced was refused, and
 * the refusal cascaded up to the project delete.
 *
 * It stayed invisible because the only projects anyone had deleted were empty
 * ones. The first attempt to delete a project with real work in it hit it
 * immediately — and the failure mode was the worst kind: the rename that was
 * meant to accompany the delete succeeded, so the picker ended up with two
 * projects of the same name and no way to remove either.
 *
 * Set-based over the tables a worked-on project accumulates, because deleting
 * one is only safe if EVERY child goes with it — a delete that leaves rows
 * behind is a slow leak that shows up much later as orphaned assets.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-del-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

/** Every table a project with real work in it puts rows in. */
const CHILD_TABLES = [
    'film_scripts', 'film_scenes', 'film_characters', 'film_locations', 'film_props',
    'film_assets', 'film_refsheet_jobs', 'film_mood_board', 'film_milestones',
];

function makeWorkedProject() {
    const projectId = generateId(), sceneId = generateId(), shotId = generateId(), charId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Doomed');
    db.prepare("INSERT INTO film_scripts (id, project_id, version, content) VALUES (?, ?, 1, 'x')").run(generateId(), projectId);
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, '1')").run(sceneId, projectId);
    db.prepare("INSERT INTO film_shots (id, scene_id, shot_code) VALUES (?, ?, '1A')").run(shotId, sceneId);
    db.prepare('INSERT INTO film_characters (id, project_id, name) VALUES (?, ?, ?)').run(charId, projectId, 'MAYA');
    db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, ?)').run(generateId(), projectId, 'STREET');
    db.prepare('INSERT INTO film_props (id, project_id, name) VALUES (?, ?, ?)').run(generateId(), projectId, 'BAG');
    db.prepare(`INSERT INTO film_assets (id, project_id, character_id, asset_type, file_path, file_name)
                VALUES (?, ?, ?, 'character_sheet', '/tmp/a.png', 'a.png')`).run(generateId(), projectId, charId);
    // The row that made the whole thing undeletable.
    db.prepare(`INSERT INTO film_refsheet_jobs (id, project_id, character_id, status)
                VALUES (?, ?, ?, 'complete')`).run(generateId(), projectId, charId);
    db.prepare(`INSERT INTO film_mood_board (id, project_id, kind, note) VALUES (?, ?, 'palette', 'teal')`)
        .run(generateId(), projectId);
    db.prepare(`INSERT INTO film_milestones (id, project_id, title) VALUES (?, ?, 'Lock picture')`)
        .run(generateId(), projectId);
    return { projectId, charId };
}

test('a project that has generated a reference sheet can be deleted', () => {
    const { projectId } = makeWorkedProject();
    db.pragma('foreign_keys = ON');
    assert.doesNotThrow(() => db.prepare('DELETE FROM film_projects WHERE id = ?').run(projectId),
        'deleting a worked-on project is still refused');
});

test('deleting a project takes every child row with it', () => {
    const { projectId } = makeWorkedProject();
    db.pragma('foreign_keys = ON');

    const before = {};
    for (const t of CHILD_TABLES) {
        before[t] = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE project_id = ?`).get(projectId).c;
    }
    assert.ok(Object.values(before).every(n => n > 0), `fixture did not populate: ${JSON.stringify(before)}`);

    db.prepare('DELETE FROM film_projects WHERE id = ?').run(projectId);

    const left = CHILD_TABLES
        .map(t => [t, db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE project_id = ?`).get(projectId).c])
        .filter(([, n]) => n > 0);
    assert.deepStrictEqual(left, [], `rows survived the delete: ${JSON.stringify(left)}`);
});

test('shots go too, though they hang off the scene rather than the project', () => {
    const { projectId } = makeWorkedProject();
    db.pragma('foreign_keys = ON');
    const count = () => db.prepare(
        `SELECT COUNT(*) c FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id WHERE s.project_id = ?`)
        .get(projectId).c;
    assert.ok(count() > 0, 'fixture has no shots');
    db.prepare('DELETE FROM film_projects WHERE id = ?').run(projectId);
    assert.strictEqual(count(), 0, 'shots survived their project');
});
