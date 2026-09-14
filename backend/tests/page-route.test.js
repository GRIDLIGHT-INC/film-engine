/**
 * A REFRESH KEEPS THE PAGE YOU WERE ON.
 *
 * "Whenever I refresh in a page it goes back to the project list." Every reload
 * cost the page being worked on, so checking a change meant walking back to it
 * through the project list — which is how a shipped change reads as not
 * shipped, and it did: a piano roll under the lane was reported missing by
 * somebody who reloaded onto the project list and never got back to the Score.
 *
 * The functions are EXECUTED against a fake location and history, because a
 * grep cannot tell a hash that is written from one that is read back, and the
 * loop between them (write → hashchange → navigate → write) is the whole risk.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    if (!m) return null;
    let depth = 0;
    for (let j = SPA.indexOf('{', m.index); j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1);
    }
    return null;
}
function constSource(name) {
    const m = new RegExp(`\\bconst\\s+${name}\\s*=`).exec(SPA);
    if (!m) return null;
    let depth = 0;
    for (let j = m.index; j < SPA.length; j++) {
        const ch = SPA[j];
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        else if (ch === ';' && depth === 0) return SPA.slice(m.index, j + 1);
    }
    return null;
}

const PROJECT = '1b148030-ff97-4dc0-96c1-c0fe8f3b8e92';

/** The real readRoute / writeRoute / applyRoute over a fake browser. */
function router(start = { hash: '', project: null, page: 'projects' }) {
    for (const n of ['writeRoute', 'readRoute', 'applyRoute']) assert.ok(fnSource(n), `no ${n} on the page`);
    assert.ok(constSource('ROUTE'), 'no ROUTE on the page');
    const sandbox = `
        const location = { hash: ${JSON.stringify(start.hash)} };
        const history = { replaceState: (a, b, url) => { location.hash = url; calls.replaceState++; } };
        const calls = { replaceState: 0, navigateTo: [], openProject: [], backToList: 0 };
        const state = { currentProject: ${start.project ? `{ id: '${start.project}' }` : 'null'}, currentPage: ${JSON.stringify(start.page)} };
        function navigateTo(page) { calls.navigateTo.push(page); state.currentPage = page; writeRoute(); }
        function openProject(id, page) { calls.openProject.push([id, page]); state.currentProject = { id }; navigateTo(page || 'dashboard'); }
        function backToProjectList() { calls.backToList++; state.currentProject = null; navigateTo('projects'); }
        ${constSource('ROUTE')}
        ${fnSource('writeRoute')}
        ${fnSource('readRoute')}
        ${fnSource('applyRoute')}
        return { location, state, calls, writeRoute, readRoute, applyRoute, navigateTo };`;
    // eslint-disable-next-line no-new-func
    return new Function(sandbox)();
}

test('the URL says which project and which page, and a reload lands back there', () => {
    // What a person is looking at is what the URL says.
    const r = router({ hash: '', project: PROJECT, page: 'musicws' });
    r.writeRoute();
    assert.strictEqual(r.location.hash, `#/${PROJECT}/musicws`, 'the page being worked on is not in the URL');

    // ...and that URL, opened cold, restores both.
    const back = router({ hash: `#/${PROJECT}/musicws`, project: null, page: 'projects' });
    assert.strictEqual(back.applyRoute(), true, 'a URL naming a project and page was ignored');
    assert.deepStrictEqual(back.calls.openProject, [[PROJECT, 'musicws']],
        'a reload did not reopen the project on the page it named');
    assert.strictEqual(back.state.currentPage, 'musicws', 'a reload landed somewhere else');
});

test('every page a person can reach is reachable by URL, and no page is special', () => {
    // Derived from the app's own loader map: a page added later is covered.
    const loaders = fnSource('navigateTo');
    const pages = [...loaders.matchAll(/^\s{12}(\w+):\s*(?:load|show)\w+/gm)].map(m => m[1]);
    assert.ok(pages.length >= 20, `only ${pages.length} pages found — the loader scan is broken`);
    for (const page of pages) {
        const r = router({ hash: `#/${PROJECT}/${page}`, project: null, page: 'projects' });
        assert.strictEqual(r.applyRoute(), true, `${page}: its URL does nothing`);
        assert.strictEqual(r.state.currentPage, page, `${page}: its URL lands elsewhere`);
    }
});

test('writing the route never re-enters itself', () => {
    /*
     * navigateTo writes the hash and a hashchange applies the hash: without a
     * guard that is a loop, and it is the reason this is replaceState rather
     * than assigning location.hash — clicking through four pages must not put
     * four entries in the back button either.
     */
    const r = router({ hash: '', project: PROJECT, page: 'dashboard' });
    r.navigateTo('musicws');
    const after = r.calls.replaceState;
    r.writeRoute();
    assert.strictEqual(r.calls.replaceState, after, 'writing the same route again touched history');
    assert.strictEqual(r.calls.navigateTo.length, 1, 'writing the route navigated');
    // The guard is readable, so a hashchange raised by our own write is ignored.
    assert.match(fnSource('writeRoute'), /ROUTE\.writing\s*=\s*true/, 'writeRoute does not mark its own write');
    assert.match(SPA, /hashchange[\s\S]{0,120}ROUTE\.writing/, 'a hashchange from our own write is not ignored');
});

test('a URL with no project goes back to the list rather than showing a project page empty', () => {
    const r = router({ hash: '#/projects', project: PROJECT, page: 'musicws' });
    assert.strictEqual(r.applyRoute(), true);
    assert.strictEqual(r.calls.backToList, 1, 'leaving the project in the URL did not leave the project');
});

test('a hash the app does not recognise is left alone, never acted on', () => {
    for (const hash of ['', '#', '#not-a-route', '#/']) {
        const r = router({ hash, project: null, page: 'projects' });
        assert.strictEqual(r.applyRoute(), false, `${hash || '(empty)'}: was treated as a route`);
        assert.deepStrictEqual(r.calls.navigateTo, [], `${hash || '(empty)'}: navigated anyway`);
    }
});

test('the app applies the URL at boot, and falls back to writing one', () => {
    const boot = /loadProjects\(\)\.then\(\(\)\s*=>\s*\{\s*if\s*\(!applyRoute\(\)\)\s*writeRoute\(\);\s*\}\)/;
    assert.match(SPA, boot, 'boot does not apply the URL before deciding where to land');
    // And the project opener can be told which page to land on, or the restore
    // would always drop onto the dashboard.
    assert.match(fnSource('openProject'), /function openProject\(id,\s*page\)/, 'openProject cannot land on a named page');
    assert.match(fnSource('openProject'), /navigateTo\(page \|\| 'dashboard'\)/, 'openProject ignores the page it was given');
});
