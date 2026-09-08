/**
 * Option B — the app shell on a phone.
 *
 * The feasibility assessment (docs/plans/mobile-feasibility.md) measured six
 * media queries, NONE of which touch the app shell: the context panel is a
 * fixed 232px, `.main` is offset past it, and `body.fe` is `overflow:hidden`.
 * At 390px that leaves 128px of page.
 *
 * These tests are written against COMPUTED VALUES at a viewport width, not
 * against the presence of a media query. A grep for "@media (max-width:700px)"
 * passes the moment a query exists and says nothing about whether it wins —
 * and it would NOT have caught the `!important` on `.status-bar { left }`,
 * which beats any ordinary override written later in the file.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');

const PHONE = 390;   // iPhone 15/16 logical width, the narrowest common target
const DESKTOP = 1440;

const { CSS, RULES, declared, varValue, px } = require('./css-cascade');

/* ── the shell offsets, DERIVED ──────────────────────────────────────────
 * Every declaration that positions something by the panel or the rail. A
 * fourth one added later is in the denominator with nothing to remember —
 * which is the whole reason this is not a hand-typed list of three.
 */
const SHELL_OFFSETS = (() => {
    const out = [];
    for (const r of RULES) {
        if (r.media) continue;                       // the desktop statement
        for (const d of r.decls) {
            if (!/var\(\s*--fe-(panel|rail)\s*\)/.test(d.value)) continue;
            for (const s of r.selectors) out.push({ selector: s, prop: d.prop });
        }
    }
    return out;
})();

test('the shell offsets are derived from the CSS, and there are some', () => {
    assert.ok(SHELL_OFFSETS.length >= 3,
        `expected the panel/rail offsets to be found in the CSS, got ${SHELL_OFFSETS.length}`);
    const sels = new Set(SHELL_OFFSETS.map(o => o.selector));
    for (const must of ['.fe-panel', '.main', '.status-bar'])
        assert.ok(sels.has(must), `${must} should offset by the panel`);
});

test('desktop is byte-for-byte the layout it was: the panel is still 232px', () => {
    assert.strictEqual(px('var(--fe-panel)', DESKTOP), 232);
    assert.strictEqual(px(declared('.main', 'left', DESKTOP), DESKTOP), 262);
});

// `.fe-panel` is position:fixed, so its own width never pushes the page — what
// must collapse is everything that offsets PAST it. Exempt by name with a
// reason, never by pattern: a pattern would quietly excuse the next selector
// that gets this wrong.
const OFFSET_EXEMPT = new Set(['.fe-panel']);

test('the exemption set stays exactly one, and is the fixed-position panel', () => {
    assert.deepStrictEqual([...OFFSET_EXEMPT], ['.fe-panel']);
    assert.strictEqual(declared('.fe-panel', 'position', DESKTOP), 'fixed',
        'the exemption only holds while the panel is out of flow');
});

test('on a phone every panel offset collapses — set-based, not one example', () => {
    for (const { selector, prop } of SHELL_OFFSETS) {
        if (OFFSET_EXEMPT.has(selector)) continue;
        const value = px(declared(selector, prop, PHONE), PHONE);
        assert.ok(Number.isFinite(value), `${selector}{${prop}} did not resolve at ${PHONE}px`);
        assert.ok(value <= 24,
            `${selector}{${prop}} is ${value}px at ${PHONE}px — the panel still takes the screen`);
    }
});

test('the page is wider than it is tall-and-thin: main gets most of a 390px screen', () => {
    const left = px(declared('.main', 'left', PHONE), PHONE);
    const right = px(declared('.main', 'right', PHONE), PHONE);
    const width = PHONE - left - right;
    assert.ok(width >= 340, `.main is only ${width}px wide at ${PHONE}px`);
});

test('the panel becomes a drawer: off-canvas by default, on-canvas when opened', () => {
    const shut = declared('.fe-panel', 'transform', PHONE);
    assert.ok(shut && /translateX\(\s*-/.test(shut),
        `.fe-panel should be pushed off-canvas at ${PHONE}px, got ${shut}`);
    const open = declared('body.fe-drawer .fe-panel', 'transform', PHONE);
    assert.ok(open && /translateX\(\s*0/.test(open),
        `opening the drawer should bring .fe-panel back, got ${open}`);
    assert.strictEqual(declared('.fe-panel', 'transform', DESKTOP), null,
        'the drawer transform must not exist on desktop');
});

test('the drawer toggle exists, is wired, and never shows on desktop', () => {
    const btn = HTML.match(/<button[^>]*class="fe-burger"[^>]*>/);
    assert.ok(btn, 'no .fe-burger button in the markup');
    const onclick = btn[0].match(/onclick="([a-zA-Z0-9_]+)\(/);
    assert.ok(onclick, 'the burger has no handler');
    assert.ok(new RegExp('function\\s+' + onclick[1] + '\\s*\\(').test(HTML),
        `${onclick[1]}() is not defined — a button wired to nothing looks identical to a working one`);
    assert.strictEqual(declared('.fe-burger', 'display', DESKTOP), 'none',
        'the burger must be hidden on desktop');
    assert.notStrictEqual(declared('.fe-burger', 'display', PHONE), 'none',
        'the burger must be visible on a phone');
});

test('picking a page closes the drawer', () => {
    // Bounded by brace depth from the declaration, not by text adjacency:
    // a close call sitting NEXT to navigateTo is not a close call INSIDE it.
    const start = HTML.search(/function\s+navigateTo\s*\(/);
    assert.ok(start > 0, 'navigateTo not found');
    let depth = 0, i = HTML.indexOf('{', start), end = i;
    for (; i < HTML.length; i++) {
        if (HTML[i] === '{') depth++;
        else if (HTML[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    const body = HTML.slice(start, end);
    assert.ok(/closeDrawer\s*\(/.test(body),
        'navigateTo must close the drawer — otherwise you tap a page and keep staring at the menu');
    assert.ok(/function\s+closeDrawer\s*\(\)\s*\{[^}]*fe-drawer/.test(HTML),
        'closeDrawer must actually remove the drawer class');
});

test('a modal fits the screen it is opened on', () => {
    const max = px(declared('.modal', 'max-width', PHONE), PHONE);
    assert.ok(max <= PHONE, `.modal is capped at ${max}px on a ${PHONE}px screen`);
    assert.strictEqual(px(declared('.modal', 'max-width', DESKTOP), DESKTOP), 520,
        'desktop modals must be untouched');
});

test('the entity grid does not force a sideways scroll', () => {
    const minCol = Number((declared('.entity-grid', 'grid-template-columns', PHONE) || '')
        .match(/minmax\(\s*(\d+)px/)?.[1]);
    assert.ok(Number.isFinite(minCol), 'could not read the entity-grid minimum column');
    const pad = px(declared('.main', 'padding', PHONE), PHONE);
    const left = px(declared('.main', 'left', PHONE), PHONE);
    const right = px(declared('.main', 'right', PHONE), PHONE);
    const inner = PHONE - left - right - (Number.isFinite(pad) ? pad * 2 : 48);
    assert.ok(minCol <= inner,
        `cards need ${minCol}px and only ${inner}px is available — the page will scroll sideways`);
});

/* ── the phone-good pages stay reachable ──────────────────────────────── */
const PHONE_GOOD = ['storyboard', 'playback', 'notes', 'characters', 'locations',
    'props', 'stylebook', 'jobsqueue', 'moodboard', 'dashboard', 'shotboard'];

test('every page the assessment called phone-good is reachable from the drawer', () => {
    for (const page of PHONE_GOOD) {
        assert.ok(new RegExp(`data-page="${page}"`).test(HTML),
            `no nav entry for ${page}, which the assessment classified as phone-good`);
        assert.ok(new RegExp(`id="page-${page}"`).test(HTML), `no page body for ${page}`);
    }
});

test('the phase track survives on a phone — it is the primary navigation', () => {
    // Hiding it would strand the user in whatever phase they loaded on: the
    // panel lists the CURRENT phase's pages and the track is what changes it.
    assert.strictEqual((HTML.match(/class="fe-track"/g) || []).length, 1,
        'there must be exactly one phase track — a second renderer is how two copies come to disagree');
    assert.ok(/function\s+applyShellMode\s*\(/.test(HTML),
        'no applyShellMode() to relocate the track into the drawer');
    const start = HTML.search(/function\s+applyShellMode\s*\(/);
    let depth = 0, i = HTML.indexOf('{', start), end = i;
    for (; i < HTML.length; i++) {
        if (HTML[i] === '{') depth++;
        else if (HTML[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    const body = HTML.slice(start, end);
    assert.ok(/fe-track/.test(body) && /appendChild|insertBefore/.test(body),
        'applyShellMode must MOVE the existing track, not render a second one');
    assert.notStrictEqual(declared('.fe-track', 'display', PHONE), 'none',
        'the track must not simply be hidden on a phone');
});

/* ── the transport ────────────────────────────────────────────────────── */
test('the API base follows the host the page was served from', () => {
    // The blocker that would make every other fix invisible: a page loaded on
    // the phone from 192.168.x.x calling http://localhost:3100 reaches the
    // PHONE, fails, and surfaces as "Backend offline" — indistinguishable
    // from a dead server.
    // Extracted as a FUNCTION rather than by evaluating the assignment's
    // right-hand side: the expression was inlined once and is now named, and a
    // test that can only read one of those two shapes reports a working page as
    // broken the moment somebody tidies it. The behaviour is what is pinned.
    const start = HTML.search(/function\s+defaultApiBase\s*\(/);
    assert.ok(start > -1, 'defaultApiBase() not found');
    let depth = 0, i = HTML.indexOf('{', start), end = i;
    for (; i < HTML.length; i++) {
        if (HTML[i] === '{') depth++;
        else if (HTML[i] === '}') { depth--; if (!depth) { end = i + 1; break; } }
    }
    const fn = Function('"use strict";' + HTML.slice(start, end) + ';return defaultApiBase;')();
    const evalWith = hostname => fn({ hostname, protocol: 'http:' });
    assert.strictEqual(evalWith('localhost'), 'http://localhost:3100',
        'the laptop must keep working exactly as before');
    assert.strictEqual(evalWith('192.168.1.42'), 'http://192.168.1.42:3100',
        'a phone must call the machine that served it the page');
    // Native shells load the page over a custom scheme with no host worth
    // calling; they inject film_api_url instead, so guessing a base from
    // film-engine://app would be a request to nothing.
    assert.strictEqual(fn({ hostname: 'app', protocol: 'film-engine:' }), '',
        'a non-http origin has no host to derive an API base from');
    assert.ok(/const DEFAULT_API_BASE\s*=\s*defaultApiBase\(/.test(HTML),
        'DEFAULT_API_BASE must come from that function, not a second copy of the rule');
    /*
     * THE ORDER, not the mechanism. This asserted the literal
     * `localStorage.getItem('film_api_url') ||` and so broke when the read was
     * routed through a helper that cannot throw — reporting a fix as a
     * regression. What must stay true is the PRECEDENCE, and there are now
     * three sources: a native shell injects a global that cannot fail, the
     * stored override is the fallback, and the derived default is last.
     */
    const CODE = HTML.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const at = CODE.indexOf('let API_BASE');
    assert.ok(at > -1, 'API_BASE is gone; re-derive this test');
    const decl = CODE.slice(at, CODE.indexOf(';', at) + 1);
    const order = ['__filmEngineApiBase', 'film_api_url', 'DEFAULT_API_BASE']
        .map(k => decl.indexOf(k));
    assert.ok(order.every(i => i > -1),
        `API_BASE no longer consults all three sources: ${decl}`);
    assert.deepStrictEqual([...order].sort((a, b) => a - b), order,
        'the sources are consulted in the wrong order — an injected address must beat a stored '
        + `one, and both must beat the derived default: ${decl}`);
});

test('the page server binds loopback unless told otherwise, and says what it did', () => {
    const dev = require('../dev-server.js');
    assert.strictEqual(typeof dev.bindHost, 'function',
        'dev-server should expose how it chooses a host, so it can be tested');
    assert.strictEqual(dev.bindHost({}), '127.0.0.1',
        'default must stay loopback — binding an unauthenticated server to the LAN is the owner\'s call');
    assert.strictEqual(dev.bindHost({ FILM_ENGINE_HOST: '0.0.0.0' }), '0.0.0.0');
    const src = fs.readFileSync(path.join(__dirname, '../dev-server.js'), 'utf8');
    assert.ok(/unauthenticated/i.test(src),
        'exposing the page to the LAN must print what that means');
});
