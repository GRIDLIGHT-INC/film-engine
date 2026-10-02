/**
 * THE PROJECT LIST: DRAGGED INTO ORDER, FILTERED BY STAGE, ARCHIVED NOT DELETED.
 *
 * "I'd like to be able to move projects (dragging and dropping), filter
 * projects by status and archive them (they won't show on the list but are
 * recoverable instead of deleted)."
 *
 * Through the real route: the order a person sets is the order the list
 * answers in; an archived project leaves the list and Delete All, keeps every
 * row under it, and comes back whole; the stage filter and its counts. The
 * page's drop arithmetic is executed from the page itself.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-projlist-' + crypto.randomUUID().slice(0, 8));
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const { handleProjects } = require('../routes/projects');
const { UI, declSource } = require('./console-render');

function call(method, urlPath, body) {
    return new Promise(resolve => {
        const [p, qs] = urlPath.split('?');
        const parts = p.split('/').filter(Boolean);
        const query = Object.fromEntries(new URLSearchParams(qs || ''));
        const req = { method, body: body || {}, headers: {} };
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            let b = Buffer.concat(chunks).toString();
            try { b = JSON.parse(b); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body: b });
        });
        Promise.resolve(handleProjects(req, res, parts, query)).catch(e => resolve({ status: 500, body: { error: e.message } }));
    });
}

function project(title, status) {
    const id = generateId();
    db.prepare('INSERT INTO film_projects (id, title, status) VALUES (?, ?, ?)').run(id, title, status || 'script');
    return id;
}

test('the list answers in the order dragged, and an unplaced project comes after', async () => {
    const a = project('A'), b = project('B'), c = project('C');
    let r = await call('POST', '/film/projects/reorder', { ids: [c, a, b] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const d = project('D, never placed');
    r = await call('GET', '/film/projects');
    const order = r.body.projects.map(p => p.id).filter(id => [a, b, c, d].includes(id));
    assert.deepStrictEqual(order, [c, a, b, d]);
});

test('a reorder naming an unknown or repeated project changes nothing', async () => {
    const a = project('A2'), b = project('B2');
    await call('POST', '/film/projects/reorder', { ids: [a, b] });
    const before = db.prepare('SELECT id, sort_order FROM film_projects ORDER BY id').all();
    assert.strictEqual((await call('POST', '/film/projects/reorder', { ids: [b, 'nope'] })).status, 404);
    assert.strictEqual((await call('POST', '/film/projects/reorder', { ids: [b, b] })).status, 400);
    assert.deepStrictEqual(db.prepare('SELECT id, sort_order FROM film_projects ORDER BY id').all(), before);
});

test('archiving takes a project off the list, keeps everything in it, and restoring puts it back', async () => {
    const id = project('Archive me');
    const scene = generateId();
    db.prepare('INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)').run(scene, id);
    const r = await call('POST', `/film/projects/${id}/archive`);
    assert.strictEqual(r.body.archived, true);
    assert.ok(!(await call('GET', '/film/projects')).body.projects.some(p => p.id === id), 'still on the list');
    const only = (await call('GET', '/film/projects?archived=only')).body;
    assert.ok(only.projects.some(p => p.id === id), 'not in the archive view');
    assert.ok(only.projects.every(p => p.archived_at), 'the archive view lists a project that is not archived');
    assert.ok(db.prepare('SELECT 1 FROM film_scenes WHERE id = ?').get(scene), 'archiving deleted a scene');
    assert.strictEqual((await call('GET', `/film/projects/${id}`)).status, 200, 'an archived project cannot be opened');
    await call('POST', `/film/projects/${id}/unarchive`);
    assert.ok((await call('GET', '/film/projects')).body.projects.some(p => p.id === id), 'restore did not put it back');
});

test('Delete All never sweeps up an archived project', async () => {
    const kept = project('Kept in the archive');
    await call('POST', `/film/projects/${kept}/archive`);
    const gone = project('On the list');
    const r = await call('DELETE', '/film/projects');
    assert.strictEqual(r.status, 200);
    assert.ok(db.prepare('SELECT 1 FROM film_projects WHERE id = ?').get(kept), 'Delete All deleted an archived project');
    assert.ok(!db.prepare('SELECT 1 FROM film_projects WHERE id = ?').get(gone));
});

test('the stage filter, and the counts the chips are drawn from', async () => {
    const p1 = project('In production', 'production'), p2 = project('Also production', 'production');
    const p3 = project('Archived production', 'production');
    await call('POST', `/film/projects/${p3}/archive`);
    const r = (await call('GET', '/film/projects?status=production')).body;
    assert.deepStrictEqual(r.projects.map(p => p.id).sort(), [p1, p2].sort());
    assert.strictEqual(r.status_counts.production, 2, 'the count includes an archived project');
    assert.ok(r.archived_count >= 1);
    assert.ok(Array.isArray(r.statuses) && r.statuses.includes('production'));
});

test('the page drops a card where it was dropped, and draws the filter, archive and drag controls', () => {
    const src = declSource('projectOrderAfterDrop');
    assert.ok(src, 'projectOrderAfterDrop is gone');
    const f = new Function(`${src}; return projectOrderAfterDrop;`)();
    assert.deepStrictEqual(f(['a', 'b', 'c', 'd'], 'd', 'a', 'before'), ['d', 'a', 'b', 'c']);
    assert.deepStrictEqual(f(['a', 'b', 'c', 'd'], 'a', 'c', 'after'), ['b', 'c', 'a', 'd']);
    assert.deepStrictEqual(f(['a', 'b'], 'a', 'a', 'after'), ['a', 'b']);
    for (const hook of ['setProjectFilter(', 'toggleArchivedView()', "setProjectArchived('", 'projectDrop(event', "'/projects/reorder'"]) {
        assert.ok(UI.includes(hook), `the project list has lost ${hook}`);
    }
});

test('an agent can archive, restore, reorder and filter', () => {
    const { listTools } = require('../lib/mcp-tools');
    const names = new Set(listTools().map(t => t.name));
    for (const n of ['project_archive', 'project_unarchive', 'project_reorder', 'project_list']) assert.ok(names.has(n), `${n} missing`);
});
