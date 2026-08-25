/**
 * A WARNING YOU CANNOT ACT ON IS ONE YOU LEARN TO IGNORE.
 *
 * "I got shots for all my views, but it still says generated work is behind
 * what it was made from... what does that mean?"
 *
 * It means what it says, and it is true: the payload IS the fingerprint, so a
 * week of genuine improvements to how prompts are built — references, plates,
 * the anchor, the prompt ceiling, the frame size — moves every stamp. A frame
 * generated on the 20th would come back different if generated today.
 *
 * That is correct and it is useless. Seventy-four items, each individually
 * acceptable through POST /assets/:id/accept, and no way to say "all of this is
 * still the film I want". Seventy-four clicks is not a workflow; it is how a
 * report gets dismissed permanently, and then the real warning is dismissed
 * with it.
 *
 * The fingerprint is NOT weakened to make the number smaller. It is honest, and
 * whether the work is still right is a claim only a director can make — the
 * same reasoning that makes screenplay-drift's baseline an explicit act rather
 * than something the engine decides.
 *
 * Set-based over the artefact kinds, because accepting keyframes while leaving
 * plates behind would leave the report just as un-clearable.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-accept-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const call = (handler, method, url, body) => new Promise(resolve => {
    const out = [];
    const res = {
        writeHead(s) { this.statusCode = s; return this; },
        end(p) { out.push(p || ''); resolve({ status: this.statusCode || 200, body: JSON.parse(out.join('') || '{}') }); },
    };
    Promise.resolve(handler({ method, url, body: body || {} }, res,
        url.split('?')[0].split('/').filter(Boolean), {}))
        .then(r => { if (r === false) resolve({ status: 404, body: {} }); })
        .catch(err => resolve({ status: 500, body: { error: err.message } }));
});

/** A project whose every stamped artefact is out of date. */
function staleProject() {
    const projectId = generateId();
    const sceneId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Behind');
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, ?)')
        .run(sceneId, projectId, '1');
    const shotId = generateId();
    db.prepare('INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, ?, ?)')
        .run(shotId, sceneId, '1A', JSON.stringify({ shot_code: '1A', description: 'x' }));

    /*
     * A plate is linked to its SUBJECT, not to a shot. Linking them all to the
     * shot made three of the four unacceptable — their inputs could not be read
     * — which looked like a partial accept and was a bad fixture.
     */
    const charId = generateId(), locId = generateId(), propId = generateId();
    db.prepare('INSERT INTO film_characters (id, project_id, name) VALUES (?, ?, ?)').run(charId, projectId, 'MAYA');
    db.prepare('INSERT INTO film_locations (id, project_id, name) VALUES (?, ?, ?)').run(locId, projectId, 'STREET');
    db.prepare('INSERT INTO film_props (id, project_id, name) VALUES (?, ?, ?)').run(propId, projectId, 'SEDAN');

    const kinds = [
        ['keyframe', 'shot_id', shotId],
        ['character_plate', 'character_id', charId],
        ['location_plate', 'location_id', locId],
        ['prop_plate', 'prop_id', propId],
    ];
    const ids = [];
    for (const [kind, column, owner] of kinds) {
        const id = generateId();
        ids.push(id);
        db.prepare(`INSERT INTO film_assets
            (id, project_id, ${column}, asset_type, file_path, file_name, format, version,
             input_fingerprint, artefact_kind, fingerprinted_at)
            VALUES (?, ?, ?, 'storyboard', ?, ?, 'png', 1, 'a-fingerprint-from-last-week', ?, datetime('now','-5 days'))`)
            .run(id, projectId, owner, `/tmp/${kind}.png`, `${kind}.png`, kind);
    }
    return { projectId, shotId, ids, kinds: kinds.map(k => k[0]) };
}

test('a whole project can be accepted as current, in one act', async () => {
    const reports = require('../routes/production-reports');
    const handler = reports.handleProductionReports || reports;
    const p = staleProject();

    const before = db.prepare(
        "SELECT input_fingerprint FROM film_assets WHERE project_id = ? AND artefact_kind IS NOT NULL")
        .all(p.projectId).map(r => r.input_fingerprint);
    assert.ok(before.every(f => f === 'a-fingerprint-from-last-week'), 'the fixture is not stale');

    const res = await call(handler, 'POST', `/film/projects/${p.projectId}/staleness/accept`, {});
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(Number(res.body.accepted) >= p.kinds.length,
        `accepted ${res.body.accepted} of ${p.kinds.length} — a partial accept leaves the report `
        + 'just as un-clearable as before');

    const after = db.prepare(
        "SELECT artefact_kind, input_fingerprint FROM film_assets WHERE project_id = ? AND artefact_kind IS NOT NULL")
        .all(p.projectId);
    const unmoved = after.filter(r => r.input_fingerprint === 'a-fingerprint-from-last-week')
        .map(r => r.artefact_kind);
    assert.deepStrictEqual(unmoved, [],
        `these kinds were left behind: ${unmoved.join(', ')}`);
});

test('accepting says what it is claiming, and does not touch unstamped work', async () => {
    const reports = require('../routes/production-reports');
    const handler = reports.handleProductionReports || reports;
    const p = staleProject();

    /*
     * NULL means "outside the workflow", never stale. Stamping those would
     * retroactively pull every hand-made or uploaded asset into a tracking
     * system nobody opted them into.
     */
    const outside = generateId();
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, version)
        VALUES (?, ?, ?, 'storyboard', '/tmp/u.png', 'u.png', 'png', 1)`)
        .run(outside, p.projectId, p.shotId);

    const res = await call(handler, 'POST', `/film/projects/${p.projectId}/staleness/accept`, {});
    assert.strictEqual(res.status, 200);

    const row = db.prepare('SELECT input_fingerprint, artefact_kind FROM film_assets WHERE id = ?').get(outside);
    assert.strictEqual(row.input_fingerprint, null,
        'an unstamped asset was pulled into the workflow by an accept it was never part of');

    // It must say what it did, in terms of the claim being made.
    assert.ok(/still|current|claim|regenerat/i.test(JSON.stringify(res.body)),
        `the response does not say what accepting means: ${JSON.stringify(res.body)}`);
});

test('an agent can do it too, and the tool says what it is for', () => {
    const tools = require('../lib/mcp-tools').listTools();
    const t = tools.find(x => x.name === 'staleness_accept');
    assert.ok(t, 'a director can accept a project and an agent cannot');
    assert.ok(/still|current|regenerat/i.test(t.description),
        'the tool does not say what the claim is');
});
