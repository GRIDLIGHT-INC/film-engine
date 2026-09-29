/**
 * Back to the project list, and the left panel must come back with you.
 *
 * Reported: "when we go to the main menu where we see the projects the left
 * menu stays on the previous screen". The chrome's panel only ever drew a
 * PHASE — its kicker, title, blurb and page list — and the project list
 * belongs to no phase, so refresh() found nothing to switch to and left the
 * last phase's pages (and the graph's shot outline) standing beside a list of
 * projects, every one of them a link into a film that is no longer open.
 *
 * Set-based over every page of every phase: open a project on it, go back to
 * the list, and the panel must show the project list rather than that phase;
 * reopen, and it must show the phase again. Runs the chrome's own functions,
 * cut out of the page by brace depth, against a stubbed DOM.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
function fnSource(name) {
    const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(SPA);
    if (!m) return null;
    let depth = 0;
    for (let j = SPA.indexOf('{', m.index); j < SPA.length; j++) {
        if (SPA[j] === '{') depth++; else if (SPA[j] === '}' && --depth === 0) return SPA.slice(m.index, j + 1);
    }
    return null;
}
function constSource(name) {
    const m = new RegExp(`var\\s+${name}\\s*=`).exec(SPA);
    let depth = 0;
    for (let j = m.index; j < SPA.length; j++) {
        const ch = SPA[j];
        if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--;
        else if (ch === ';' && depth === 0) return SPA.slice(m.index, j + 1);
    }
}

const PHASES = new Function(`${constSource('PHASES')} return PHASES;`)();

function el() {
    const cls = new Set();
    return { textContent: '', style: {}, dataset: {}, classList: { toggle(c, on) { on ? cls.add(c) : cls.delete(c); }, add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) },
        querySelector() { return { textContent: '', style: {} }; }, has: c => cls.has(c) };
}

/** The chrome, wired to a stub DOM. `page` is what currentPage() answers; `win.state` is the app. */
function chrome() {
    const els = { kicker: el(), title: el(), blurb: el(), list: { children: [] }, track: { children: [] }, rail: { children: [], querySelector: () => null } };
    for (const p of PHASES) {
        const t = el(); t.dataset.phase = p.id; els.track.children.push(t);
        for (const pg of p.pages) { const b = el(); b.dataset.fePhase = p.id; b.dataset.page = pg; els.list.children.push(b); }
    }
    const side = el(); side.dataset.fePhase = 'production'; side.id = 'pgSidePanel'; els.list.children.push(side);
    const nm = el(), sub = el();
    const env = { page: 'dashboard', win: { state: { currentProject: null } } };
    const document = {
        querySelector: s => s === '#feProjName' ? nm : s === '#feProjSub' ? sub : null,
        querySelectorAll: () => [],
        body: { classList: { toggle() {} } },
    };
    const names = ['showPhase', 'refresh', 'showNoProject'].filter(fnSource);
    const api = new Function('PHASES', 'els', 'document', 'window', 'env', `
        var phaseOf = {}; PHASES.forEach(function (p) { p.pages.forEach(function (pg) { phaseOf[pg] = p.id; }); });
        var current = 'plan';
        function currentPage() { return env.page; }
        function progress() { return null; }
        ${names.map(fnSource).join('\n')}
        return { refresh: refresh, showPhase: showPhase, current: function () { return current; } };`)(PHASES, els, document, env.win, env);
    api.showPhase('plan', false);   // what build() does before the first refresh
    return { els, env, api, nm, sub };
}
const shown = els => els.list.children.filter(b => b.style.display !== 'none');

test('the chrome has a state for "no film open", not only a phase', () => {
    assert.ok(fnSource('showNoProject'), 'no showNoProject(): the panel can only ever draw a phase');
});

for (const phase of PHASES) {
    for (const page of phase.pages) {
        test(`${phase.id} · ${page}: back to the project list clears the panel, and reopening restores it`, () => {
            const c = chrome();
            c.env.win.state.currentProject = { id: 'p', title: 'Wingfall' };
            c.env.page = page;
            c.api.refresh();
            assert.equal(c.els.title.textContent, phase.label, 'the panel does not show the phase of the page that is open');
            assert.ok(shown(c.els).some(b => b.dataset.page === page), `${page} is not listed while it is open`);

            c.env.win.state.currentProject = null;
            c.env.page = 'projects';
            c.api.refresh();
            assert.deepEqual(shown(c.els).map(b => b.dataset.page || b.id), [], 'the last film\'s pages stay beside the project list');
            assert.notEqual(c.els.title.textContent, phase.label, 'the panel still names the phase you left');
            assert.ok(!c.els.track.children.some(t => t.has('on')), 'a phase is still lit in the track with no film open');
            assert.equal(c.nm.textContent, 'Film Engine');

            c.env.win.state.currentProject = { id: 'p', title: 'Wingfall' };
            c.env.page = page;
            c.api.refresh();
            assert.equal(c.els.title.textContent, phase.label, 'reopening the film did not bring its phase back');
            assert.ok(shown(c.els).some(b => b.dataset.page === page), 'reopening the film did not list its pages again');
        });
    }
}
