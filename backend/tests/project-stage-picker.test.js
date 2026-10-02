/**
 * The project list's stage, changed where it is read.
 *
 * "Have the ability to select which stage the project is on the project list
 * by simply clicking on the stage on the project and through a dropdown
 * changing it."
 *
 * Set-based over the server's own VALID_STATUSES:
 *   - the dropdown offers exactly the stages the server accepts (it reads the
 *     Settings page's list, which is held to the same set here);
 *   - every stage saves through PUT /projects/:id and reads back;
 *   - a stage the project cannot be in is refused with the list, never
 *     answered 200 while nothing changed;
 * and the page: the badge opens the picker without opening the project, and
 * choosing a stage saves it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-stage-' + crypto.randomUUID().slice(0, 8));
const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();
const { handleProjects, VALID_STATUSES } = require('../routes/projects');
const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

function call(method, parts, body) {
    return new Promise(resolve => {
        const res = { code: 0, writeHead(c) { this.code = c; }, setHeader() {},
            end(b) { let j = null; try { j = JSON.parse(b); } catch (_) {} resolve({ code: this.code, json: j }); } };
        handleProjects({ method, headers: {}, body: body || {} }, res, parts, {});
    });
}

test('the dropdown offers exactly the stages the server accepts', () => {
    assert.ok(VALID_STATUSES.length >= 9);
    const sel = SPA.slice(SPA.indexOf('<select id="settingsStatus"'), SPA.indexOf('</select>', SPA.indexOf('<select id="settingsStatus"')));
    const offered = [...sel.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(offered, VALID_STATUSES, 'the page\'s stage list and the server\'s disagree');
    // The picker reads that list rather than holding a third copy.
    const fn = SPA.slice(SPA.indexOf('function projectStages()'), SPA.indexOf('function openStagePicker('));
    assert.match(fn, /getElementById\('settingsStatus'\)/);
});

test('every stage saves through the project update and reads back', async () => {
    const id = generateId();
    db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Stages')").run(id);
    for (const status of VALID_STATUSES) {
        const r = await call('PUT', ['film', 'projects', id], { status });
        assert.equal(r.code, 200, `${status}: ${JSON.stringify(r.json)}`);
        assert.equal(db.prepare('SELECT status FROM film_projects WHERE id = ?').get(id).status, status);
    }
});

test('a stage the project cannot be in is refused with the list, and nothing changes', async () => {
    const id = generateId();
    db.prepare("INSERT INTO film_projects (id, title, status) VALUES (?, 'Refuse', 'script')").run(id);
    const r = await call('PUT', ['film', 'projects', id], { status: 'shooting' });
    assert.equal(r.code, 400);
    assert.deepEqual(r.json.stages, VALID_STATUSES);
    assert.equal(db.prepare('SELECT status FROM film_projects WHERE id = ?').get(id).status, 'script');
});

test('on the list, the badge opens the picker without opening the project, and a choice saves', async () => {
    const card = SPA.slice(SPA.indexOf('<div class="project-card${p.archived_at'), SPA.indexOf('project-delete-btn', SPA.indexOf('<div class="project-card${p.archived_at')));
    assert.match(card, /onclick="event\.stopPropagation\(\); openStagePicker\('\$\{p\.id\}'\)"/, 'the badge opens the picker, and the click stops before the card opens the project');
    // Execute setProjectStage against a stub api and state.
    const body = SPA.slice(SPA.indexOf('    async function setProjectStage('), SPA.indexOf('\n    }\n', SPA.indexOf('    async function setProjectStage(')) + 6);
    const calls = [];
    const state = { projects: [{ id: 'p1', status: 'script' }], currentProject: { id: 'p1', status: 'script' } };
    let reloaded = 0;
    // eslint-disable-next-line no-new-func
    const setProjectStage = new Function('api', 'state', 'setStatus', 'loadProjects', body + '\nreturn setProjectStage;')(
        async (url, opts) => { calls.push({ url, opts }); return {}; }, state, () => {}, () => { reloaded++; });
    await setProjectStage('p1', 'production');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/projects/p1');
    assert.equal(calls[0].opts.method, 'PUT');
    assert.deepEqual(JSON.parse(calls[0].opts.body), { status: 'production' });
    assert.equal(state.projects[0].status, 'production');
    assert.equal(state.currentProject.status, 'production', 'the open project follows too');
    assert.equal(reloaded, 1, 'the list is redrawn');
});
