/**
 * Consistency Verify read routes + ref-role vocabulary tests.
 *
 * Covers the "Verify" half of Explore→Lock→Generate→Verify: the GET read routes
 * that back the Studio Verify view, plus ref_role validation and the refs/roles
 * exposed for the multi-reference Studio UI.
 *
 * Drives the route handler directly with mock req/res and seeds rows via the DB
 * module, so the Verify read tests do not depend on the generator-side writer.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

// Must set the data dir BEFORE requiring database.js.
process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-verify-' + crypto.randomUUID().slice(0, 8));
fs.mkdirSync(process.env.FILM_DATA_DIR, { recursive: true });

const { ensureSchema } = require('../db/schema');
ensureSchema();
const { db, generateId } = require('../db/database');
const { handleConsistency } = require('../routes/consistency');

function mockRes() {
    return {
        _status: 0, _body: null,
        writeHead(status) { this._status = status; },
        end(payload) { try { this._body = JSON.parse(payload); } catch (_) { this._body = payload; } },
    };
}

// urlParts mirror server.js: pathname.split('/').filter(Boolean).
function call(method, pathname, body, query) {
    const parts = pathname.split('/').filter(Boolean);
    const res = mockRes();
    handleConsistency({ method, body: body || null }, res, parts, query || {});
    return res;
}

function seedProject() {
    const projectId = generateId();
    db.prepare("INSERT INTO film_projects (id, title, status) VALUES (?, ?, 'concept')").run(projectId, 'Verify Test');
    const sceneId = generateId();
    db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, 'TEST')").run(sceneId, projectId);
    const shotId = generateId();
    db.prepare("INSERT INTO film_shots (id, scene_id, shot_code) VALUES (?, ?, '1A')").run(shotId, sceneId);
    return { projectId, sceneId, shotId };
}

test('project checks: empty by default; 404 for unknown project', () => {
    const { projectId } = seedProject();
    const ok = call('GET', `/film/projects/${projectId}/consistency/checks`);
    assert.equal(ok._status, 200);
    assert.deepEqual(ok._body.checks, []);
    assert.deepEqual(ok._body.counts, { total: 0, ready: 0, warning: 0, blocked: 0 });

    const missing = call('GET', `/film/projects/${crypto.randomUUID()}/consistency/checks`);
    assert.equal(missing._status, 404);
});

test('project + shot checks return recorded rows with parsed JSON columns', () => {
    const { projectId, sceneId, shotId } = seedProject();
    const details = { subjects: [{ subject_name: 'JAX', profile_type: 'character', score: 0.91, status: 'ready' }], scorer: 'stub' };
    db.prepare(
        `INSERT INTO film_consistency_checks (id, project_id, shot_id, scene_id, status, missing, warnings, details)
         VALUES (?, ?, ?, ?, 'warning', ?, ?, ?)`
    ).run(generateId(), projectId, shotId, sceneId, JSON.stringify(['loc missing']), JSON.stringify(['low light']), JSON.stringify(details));

    const proj = call('GET', `/film/projects/${projectId}/consistency/checks`);
    assert.equal(proj._status, 200);
    assert.equal(proj._body.checks.length, 1);
    assert.equal(proj._body.counts.warning, 1);
    const c = proj._body.checks[0];
    assert.deepEqual(c.missing, ['loc missing']);
    assert.deepEqual(c.warnings, ['low light']);
    assert.equal(c.details.subjects[0].subject_name, 'JAX');
    assert.equal(c.details.subjects[0].score, 0.91);

    const shot = call('GET', `/film/shots/${shotId}/consistency/checks`);
    assert.equal(shot._status, 200);
    assert.equal(shot._body.checks.length, 1);

    const latest = call('GET', `/film/shots/${shotId}/consistency/checks/latest`);
    assert.equal(latest._status, 200);
    assert.ok(latest._body.check);
    assert.equal(latest._body.check.status, 'warning');
});

test('latest check is null when a shot has no checks; unknown shot 404s', () => {
    const { shotId } = seedProject();
    const latest = call('GET', `/film/shots/${shotId}/consistency/checks/latest`);
    assert.equal(latest._status, 200);
    assert.equal(latest._body.check, null);

    const unknown = call('GET', `/film/shots/${crypto.randomUUID()}/consistency/checks`);
    assert.equal(unknown._status, 404);
});

test('project checks respect the limit query param', () => {
    const { projectId, shotId, sceneId } = seedProject();
    for (let i = 0; i < 5; i++) {
        db.prepare(
            "INSERT INTO film_consistency_checks (id, project_id, shot_id, scene_id, status) VALUES (?, ?, ?, ?, 'ready')"
        ).run(generateId(), projectId, shotId, sceneId);
    }
    const limited = call('GET', `/film/projects/${projectId}/consistency/checks`, null, { limit: '2' });
    assert.equal(limited._body.checks.length, 2);
});

test('ref_role validation rejects unknown roles and accepts known ones', () => {
    const { projectId } = seedProject();
    const create = call('POST', `/film/projects/${projectId}/consistency/profiles`, { profile_type: 'character', subject_id: 'c1', subject_name: 'JAX' });
    assert.equal(create._status, 201);
    const profileId = create._body.id;
    const assetId = generateId();
    db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_name) VALUES (?, ?, 'reference_image', 'jax_front.png')").run(assetId, projectId);

    const bad = call('POST', `/film/consistency/profiles/${profileId}/refs`, { asset_id: assetId, ref_role: 'sideways' });
    assert.equal(bad._status, 400);
    assert.match(bad._body.error, /ref_role must be one of/);

    const good = call('POST', `/film/consistency/profiles/${profileId}/refs`, { asset_id: assetId, ref_role: 'front' });
    assert.equal(good._status, 201);
    assert.ok(good._body.refs.some(r => r.ref_role === 'front'));
});

test('unified vocab accepts face + the location/prop roles (wide/detail/color)', () => {
    const { projectId } = seedProject();
    const create = call('POST', `/film/projects/${projectId}/consistency/profiles`, { profile_type: 'character', subject_id: 'c1', subject_name: 'JAX' });
    const profileId = create._body.id;
    // Each new role needs its own asset (an asset can't be attached twice unused, but distinct assets are cleanest).
    for (const role of ['face', 'wide', 'detail', 'color']) {
        const assetId = generateId();
        db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_name) VALUES (?, ?, 'reference_image', ?)").run(assetId, projectId, `jax_${role}.png`);
        const res = call('POST', `/film/consistency/profiles/${profileId}/refs`, { asset_id: assetId, ref_role: role });
        assert.equal(res._status, 201, `role ${role} should validate`);
        assert.ok(res._body.refs.some(r => r.ref_role === role), `role ${role} should be attached`);
    }
});

test('listProfiles exposes ref_roles vocabulary and attaches refs', () => {
    const { projectId } = seedProject();
    const create = call('POST', `/film/projects/${projectId}/consistency/profiles`, { profile_type: 'prop', subject_id: 'p1', subject_name: 'SWORD' });
    const profileId = create._body.id;
    const assetId = generateId();
    db.prepare("INSERT INTO film_assets (id, project_id, asset_type, file_name) VALUES (?, ?, 'reference_image', 'sword.png')").run(assetId, projectId);
    call('POST', `/film/consistency/profiles/${profileId}/refs`, { asset_id: assetId, ref_role: 'canonical' });

    const list = call('GET', `/film/projects/${projectId}/consistency/profiles`);
    assert.equal(list._status, 200);
    // Unified vocab (single source of truth in consistency-context.js): canonical
    // first, face high (index 1) for close-up identity, then turnaround + scene roles.
    assert.deepEqual(list._body.ref_roles,
        ['canonical', 'face', 'front', 'side', 'back', 'full_body', 'expression', 'wide', 'detail', 'color']);
    const prof = list._body.profiles.find(p => p.id === profileId);
    assert.ok(prof && Array.isArray(prof.refs) && prof.refs.length === 1);
});
