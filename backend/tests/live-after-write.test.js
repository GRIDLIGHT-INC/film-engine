/**
 * A WRITE REACHES THE SCREEN, INCLUDING OUR OWN.
 *
 * "The problem isn't just the score page, it's every screen that doesn't update
 * as soon as there is new data or a UI update."
 *
 * SQLite's data_version moves only when ANOTHER connection commits, so the SSE
 * channel correctly says nothing about this page's own POSTs — which left every
 * write to be followed by a re-read the calling function had to remember.
 * Measured at the time: 81 of 236 mutating call sites did not, so a third of the
 * app's own writes left the screen showing the state before them.
 *
 * api() is EXECUTED here against a fake fetch, because a grep cannot tell a
 * refresh that is scheduled from one that is dropped by a throttle — and the
 * throttle dropping it was half the bug.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/*
 * The parameter list is skipped by PAREN depth before the body is read by BRACE
 * depth. Taking the first `{` after the name reads a default parameter as the
 * body — `function api(path, opts = {})` truncated to `function api(path, opts =
 * {}`, which fails as a syntax error inside the sandbox and reads as the page
 * being broken rather than the extractor.
 */
function fnSource(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SPA);
    if (!m) return null;
    let i = SPA.indexOf('(', m.index), parens = 0;
    for (; i < SPA.length; i++) {
        if (SPA[i] === '(') parens++;
        else if (SPA[i] === ')' && --parens === 0) { i++; break; }
    }
    let depth = 0;
    for (let j = SPA.indexOf('{', i); j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1);
    }
    return null;
}

/** A top-level `const NAME = …;`, read from the page rather than redeclared. */
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

/** api() over a fake fetch, with the refresh chain real and the reload counted. */
function harness({ busy = false, method = 'POST', refresh, status = 200 } = {}) {
    for (const n of ['api', 'refreshAfterWrite', 'refreshCurrentPage', 'liveBusy']) {
        assert.ok(fnSource(n), `no ${n} on the page`);
    }
    const sandbox = `
        const calls = { reload: 0, timers: [] };
        const timers = [];
        function setTimeout_(fn, ms) { timers.push({ fn, ms }); return timers.length; }
        function clearTimeout_(id) { if (timers[id - 1]) timers[id - 1].dead = true; }
        const setTimeout = setTimeout_, clearTimeout = clearTimeout_;
        const document = {
            activeElement: ${busy ? '{ tagName: "INPUT" }' : 'null'},
            querySelector: () => null, addEventListener: () => {},
        };
        const state = { currentProject: { id: 'p1' }, currentPage: 'storyboard' };
        let PAGE_RELOAD = () => { calls.reload++; };
        let LAST_RELOAD = 0;
        const RELOAD_THROTTLE_MS = 3000;
        const BUSY = { count: 0, pending: false };
        let TRAILING = null;
        ${constSource('AFTER_WRITE')}
        const LIVE = { pending: false };
        function API() { return ''; }
        function spendsOnThisCall() { return false; }
        function beginGenerationBusy() { return () => {}; }
        const fetch = async () => ({ status: ${status}, ok: ${status} < 400, json: async () => ({ ok: true }) });
        ${fnSource('liveBusy')}
        ${fnSource('refreshCurrentPage')}
        ${fnSource('refreshAfterWrite')}
        ${fnSource('api')}
        return { calls, timers, state,
            run: () => api('/film/shots/x', { method: ${JSON.stringify(method)}${refresh === undefined ? '' : ', refresh: ' + refresh} }),
            fire: () => { for (const t of timers) if (!t.dead && !t.done) { t.done = true; t.fn(); } } };`;
    // eslint-disable-next-line no-new-func
    return new Function(sandbox)();
}

test('a write the page makes itself refreshes the page', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const h = harness({ method });
        await h.run();
        assert.strictEqual(h.calls.reload, 0, `${method}: refreshed before the burst settled`);
        h.fire();
        assert.strictEqual(h.calls.reload, 1, `${method}: the screen was left showing the state before the write`);
    }
});

test('a read never refreshes — a background reload on every GET is noise', async () => {
    const h = harness({ method: 'GET' });
    await h.run();
    h.fire();
    assert.strictEqual(h.calls.reload, 0, 'reading the page reloaded it');
});

test('a burst of writes is one refresh, not one per row', async () => {
    const h = harness();
    await h.run(); await h.run(); await h.run();
    h.fire();
    assert.strictEqual(h.calls.reload, 1, 'a batch write reloaded the page once per row');
});

test('a 204 refreshes too — a delete answers with no body', async () => {
    const h = harness({ method: 'DELETE', status: 204 });
    await h.run();
    h.fire();
    assert.strictEqual(h.calls.reload, 1, 'deleting something left it on the screen');
});

test('the throttle COALESCES rather than dropping: a second write still lands', () => {
    /*
     * This was half the defect. refreshCurrentPage returned early inside the
     * window, so a burst of changes produced NO refresh at all — the throttle
     * turned "too often" into "never", which is the opposite of its job.
     */
    const src = fnSource('refreshCurrentPage');
    assert.match(src, /TRAILING\s*=\s*setTimeout/, 'a throttled refresh is dropped rather than scheduled');
    assert.ok(!/if \(now - LAST_RELOAD < RELOAD_THROTTLE_MS\) return;/.test(src),
        'the throttle still drops a refresh it should have coalesced');
});

test('a refresh is deferred while a field is focused, and never lost', async () => {
    const h = harness({ busy: true });
    await h.run();
    h.fire();
    assert.strictEqual(h.calls.reload, 0, 'the page reloaded under a focused field');
    // ...and something catches up when the busy state ends.
    assert.match(SPA, /focusout[\s\S]{0,140}flushAfterWrite\(\)/, 'a deferred refresh is never flushed on blur');
    assert.match(fnSource('flushAfterWrite') || '', /refreshAfterWrite\(\)/, 'the flush does not re-arm the refresh');
});

test('every opt-out is named with a reason, and there are few of them', () => {
    // `refresh: false` is for paths that repaint themselves. Unexplained, it is
    // how a screen quietly goes back to being stale.
    const sites = [...SPA.matchAll(/refresh:\s*false/g)].map(m => m.index);
    const optOuts = sites.filter(i => !/^\s*(\/\/|\*)/.test(SPA.slice(SPA.lastIndexOf('\n', i) + 1, i)));
    assert.ok(optOuts.length <= 4, `${optOuts.length} paths opt out of refreshing — that is a policy, not an exception`);
    for (const i of optOuts) {
        const before = SPA.slice(Math.max(0, i - 400), i);
        assert.match(before, /\/\/[^\n]*refresh: false|repaints? (itself|its own)|while somebody is typing/,
            `an opt-out at ${i} does not say why it does not refresh`);
    }
});

test('the project list is a page too: creating one reaches the screen that lists them', () => {
    const src = fnSource('refreshCurrentPage');
    assert.ok(!/if \(!PAGE_RELOAD \|\| !state\.currentProject\) return;/.test(src),
        'a write with no project open still cannot refresh the project list');
    assert.match(src, /currentPage !== 'projects'/, 'the project list is not exempted from the project guard');
});
