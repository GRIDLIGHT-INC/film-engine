/**
 * DIRECT THE SHOT — the director states an intention, the MODEL proposes a
 * camera, the engine validates it, and nothing in between decides.
 *
 * The whole panel exists to keep that order. `cinematography.js` is pure by
 * construction — no database, no provider, no llm-client — and buildBrief ends
 * with "No camera is proposed here; that is what you are being asked for". The
 * temptation this test exists to catch is the design handoff's own demo table:
 * seven intents with lens, height and tilt values beside them, which look
 * exactly like an implementation. Copying them into the page would make the
 * panel DECIDE, in the vocabulary of a formula, and it would look like it
 * worked — the failure the style-preset note already records ("a rigid formula
 * gets switched off the first time it overrules a director").
 *
 * SET-BASED OVER THE TWO REGISTRIES THAT DEFINE THE SURFACE:
 *   INTENTS         — 7 presets; a chip missing for one is a direction a
 *                     director cannot ask for.
 *   PROPOSAL_FIELDS — 11 fields the contract permits; a page that accepts
 *                     three of them silently narrows what the model may say.
 *
 * Both are read from lib/cinematography.js, so an eighth intent or a twelfth
 * field is in the denominator with nothing to remember.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { INTENTS, PROPOSAL_FIELDS, BIAS } = require('../lib/cinematography');
const { UI, declSource, renderConsole } = require('./console-render');

const ROOT = path.join(__dirname, '..', '..');
const DESIGN = fs.readFileSync(
    path.join(ROOT, 'design_handoff_world_engine_previz', 'README.md'), 'utf8');
const WORLDS = fs.readFileSync(path.join(__dirname, '..', 'routes', 'worlds.js'), 'utf8');

const ALL_FLAGS = { world_engine: true, marble_generation: true, cinematography_ai: true,
                    reference_match: true, camera_explore: true, world_splats: true };

/** The panel's own markup, bounded by its builder. */
const panel = () => {
    const src = declSource('worldDirectPanelHtml');
    assert.ok(src, 'there is no Direct the Shot panel builder');
    return src;
};

/* ── 1 · the presets ────────────────────────────────────────────────────── */

test('EVERY intention the engine knows has a chip, and none is invented', () => {
    const html = renderConsole(ALL_FLAGS);
    const missing = INTENTS.filter(i => !html.includes(`worldDirectIntent('${i}')`));
    assert.deepStrictEqual(missing, [],
        `these intentions cannot be asked for from the page: ${missing.join(', ')}`);
    assert.strictEqual(INTENTS.length, 7, 'the design draws seven presets; re-derive this');

    // And nothing the engine does NOT know: an eighth chip is a direction the
    // route refuses, discovered after the director has chosen it.
    const offered = [...html.matchAll(/worldDirectIntent\('([a-z_]+)'\)/g)].map(m => m[1]);
    const unknown = offered.filter(i => !INTENTS.includes(i));
    assert.deepStrictEqual(unknown, [], `the page offers intentions the engine refuses: ${unknown.join(', ')}`);
});

test('the label a director reads is the design\'s, not the engine\'s enum', () => {
    // `cinematic_depth` is a key. "More cinematic depth" is what the design puts
    // on the chip, and a director should not be reading snake_case.
    const html = renderConsole(ALL_FLAGS);
    for (const want of ['More heroic', 'More cinematic depth']) {
        assert.ok(html.includes(want), `the chip for "${want}" is missing or unlabelled`);
    }
});

test('a custom direction can be typed, and it reaches the brief', () => {
    const html = renderConsole(ALL_FLAGS);
    assert.match(html, /id="weDirectCustom"/,
        'there is no custom direction input — the seven presets are the only things sayable');
    assert.match(panel(), /placeholder=/, 'the custom input offers no example of what to write');
});

/* ── 2 · the page must not DECIDE ───────────────────────────────────────── */

/** The demo delta rows the design ships, parsed from its own table. */
function demoDeltas() {
    const at = DESIGN.indexOf('| Intent | Applies | Shown deltas |');
    assert.ok(at > -1, 'the demo delta table is gone from the design; re-derive this test');
    const rows = DESIGN.slice(at).split('\n\n')[0].split('\n')
        .filter(l => l.startsWith('| ') && !/^\| Intent|^\|---/.test(l));
    assert.ok(rows.length >= 7, `the demo table scan found ${rows.length} rows — it is broken`);
    return rows.map(l => {
        const cells = l.split('|').map(c => c.trim());
        return { intent: cells[1], applies: cells[2] };
    });
}

test('the design\'s demo numbers are NOT baked into the page', () => {
    /*
     * The failure this whole task is shaped to avoid. "More heroic → 21mm,
     * h 0.42m, tilt +17°" is DEMO DATA, said so twice in the handoff. A page
     * carrying that table proposes cameras itself, in a formula, and every
     * shot in every film gets the same heroic angle.
     */
    /*
     * SCANNED OVER THE WHOLE PAGE, not over the panel builder.
     *
     * The first version bounded this to worldDirectPanelHtml, and a mutation
     * that put `const HEROIC = { focalLengthMm: 21, cameraHeightM: 0.42,
     * tiltDeg: 17 }` a few lines above it passed — the exact defect this test
     * exists to catch, sitting outside the boundary. Fifth time this codebase
     * has paid for a bounded scan, and the first time it was mine.
     *
     * What identifies a baked formula is the three numbers appearing TOGETHER,
     * so the detector is a window over the whole page rather than a function
     * slice: a lens, a height and a tilt for one named intent, close enough to
     * be one declaration.
     */
    /*
     * COMMENTS STRIPPED FIRST. The comment in the page explaining WHY these
     * values must not be baked in quotes them — so the detector found its own
     * warning and reported the defect it exists to prevent. Line-based,
     * because the obvious block-comment regex once ate a declaration when a
     * `/*` appeared inside a string; every comment here is a whole-line one.
     */
    const CODE = UI.split('\n').filter(l => !/^\s*(\/\*|\*|\/\/)/.test(l)).join('\n');
    const baked = [];
    for (const row of demoDeltas()) {
        const nums = (row.applies.match(/-?\d+\.?\d*/g) || []).slice(0, 3);
        if (nums.length < 3) continue;
        const pats = nums.map(n => new RegExp(`(?<![\\d.])${n.replace('.', '\\.')}(?![\\d.])`, 'g'));
        const spots = pats.map(re => [...CODE.matchAll(re)].map(m => m.index));
        if (spots.some(list => !list.length)) continue;
        const together = spots[0].some(a =>
            spots[1].some(b => Math.abs(a - b) < 200) && spots[2].some(c => Math.abs(a - c) < 200));
        if (together) baked.push(`${row.intent}: ${row.applies}`);
    }
    assert.deepStrictEqual(baked, [],
        'the panel carries the design\'s demo camera values, so it proposes rather than asking:\n  '
        + baked.join('\n  '));
});

test('the panel computes no camera of its own', () => {
    /*
     * A weaker page would derive the proposal locally — "heroic means lower and
     * wider" — which is the engine's own BIAS text turned into arithmetic. The
     * bias is a DESCRIPTION handed to the model; the page may show it and must
     * not act on it.
     */
    const p = panel();
    for (const [intent] of Object.entries(BIAS)) {
        const arith = new RegExp(`${intent}[^\\n]{0,120}[-+*/]\\s*\\d`, 'i');
        assert.ok(!arith.test(p), `the panel does arithmetic for "${intent}" — it is deciding`);
    }
});

/* ── 3 · the route is the only source of a camera ───────────────────────── */

test('the brief is FETCHED, per intention, and it is free', () => {
    const p = panel() + declSource('worldDirectIntent');
    assert.match(p, /shots\/[^'"`]*\/direct/,
        'the panel never asks the engine for the brief, so the facts it shows are its own');
    assert.match(p, /intent=/, 'the brief is fetched without the chosen intention');
});

/**
 * A function's body plus, ONE LEVEL DOWN, anything it delegates to.
 *
 * `worldDirectCheck` is a one-line delegation to a shared sender — which is
 * the right shape, because a second sender is how the check and the apply come
 * to disagree about which route they use. Refusing to follow the call reports
 * a correct function as broken, the mistake manual-edit.test.js already
 * records. One level, not an unbounded walk: that eventually finds a POST in
 * something unrelated.
 */
function bodyWithDelegate(name) {
    const src = declSource(name) || '';
    const called = [...src.matchAll(/\b(world[A-Z][\w$]*)\s*\(/g)].map(m => m[1])
        .filter(n => n !== name);
    return src + called.map(n => declSource(n) || '').join('\n');
}

/**
 * Drive the panel's sender with a stubbed `api` and report what it asked for.
 *
 * BEHAVIOURAL, because check and apply share one sender — which is the right
 * shape, since a second sender is how the two come to disagree about which
 * route they use. That makes a text ban on "apply: true" unsatisfiable: the
 * flag is in the shared body. What can be checked is what each ACTUALLY sends.
 */
function driveDirect(which, proposal) {
    const names = ['worldDirectSend', 'worldDirectCheck', 'worldDirectApply', 'worldDirectProposal',
                   'worldDirectShowResult', 'directIntentLabel'];
    const seen = {};
    const pre = `
        const DIRECT = { intent: 'heroic', brief: null, proposal: null, result: null };
        const WORLD = { shotId: 'shot-1' };
        const AI_PATH = { connected: false };
        const esc = v => String(v == null ? '' : v);
        const BOX = { value: ${JSON.stringify(JSON.stringify(proposal))} };
        const document = { getElementById: (id) => (id === 'weDirectProposal' ? BOX
            : { innerHTML: '', value: '' }) };
        const CALLS = [];
        const api = async (url, opts) => { CALLS.push({ url, opts }); return { camera: {} }; };`;
    const src = names.map(n => declSource(n)).filter(Boolean).join('\n');
    const run = new Function(`${pre}\n${src}\nreturn (async () => { await ${which}(); return CALLS; })();`);
    return run().then(calls => Object.assign(seen, { calls }));
}

test('a proposal goes to camera_propose and comes back validated', async () => {
    const { calls } = await driveDirect('worldDirectCheck', { focalLengthMm: 40, rollDeg: -12 });
    assert.strictEqual(calls.length, 1, `check made ${calls.length} requests, expected exactly one`);
    assert.match(calls[0].url, /\/shots\/[^/]+\/direct$/,
        `check posted to ${calls[0].url}, which is not the directing route`);
    assert.strictEqual(calls[0].opts.method, 'POST', 'the proposal is not POSTed');

    const body = JSON.parse(calls[0].opts.body);
    assert.ok(!body.apply,
        'CHECK APPLIES THE CAMERA — the free look and the commit are the same act, so a director '
        + 'exploring an angle has already changed the shot');
    // The proposal travels whole: a field the model deliberately asked for
    // must not be dropped on the way.
    assert.strictEqual(body.focalLengthMm, 40);
    assert.strictEqual(body.rollDeg, -12, 'a roll the model asked for was dropped by the page');
});

test('APPLY goes through the SAME route, not a second path', async () => {
    const { calls } = await driveDirect('worldDirectApply', { focalLengthMm: 21 });
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].url, /\/shots\/[^/]+\/direct$/, 'apply uses a different route from check');
    assert.strictEqual(JSON.parse(calls[0].opts.body).apply, true,
        'apply does not ask the route to apply, so pressing it changes nothing');

    /*
     * A second apply path is how one of them comes to skip validateCamera —
     * the trap routes/worlds.js already names for match-reference. Apply must
     * be the same POST with apply:true.
     */
    const src = bodyWithDelegate('worldDirectApply');
    assert.ok(src, 'there is no way to apply a proposal');
    assert.match(src, /\/direct/, 'apply does not go through the directing route');
    // It must not write the camera itself.
    assert.ok(!/previs\/set|saveCamera|\/blocking/.test(src),
        'apply writes the camera by another path, which would bypass the geometry checks');
});

test('EVERY field the contract permits can be proposed through the page', () => {
    /*
     * PROPOSAL_FIELDS is the contract. A page that reads three of them narrows
     * what the model is allowed to say, silently — and the model has no way to
     * discover that its roll was dropped.
     */
    const p = panel() + (declSource('worldDirectProposal') || '');
    const missing = PROPOSAL_FIELDS.filter(f => !p.includes(f));
    assert.deepStrictEqual(missing, [],
        `the page cannot carry these parts of a proposal: ${missing.join(', ')}`);
});

/* ── 4 · a refusal is shown where the choice is made ────────────────────── */

test('the route refuses an unshootable camera, and the panel renders the reason', () => {
    // The route's contract, so the panel is rendering something real.
    assert.match(WORLDS, /this camera cannot be shot/,
        'the route no longer refuses an unshootable camera');
    assert.match(WORLDS, /failures/, 'the refusal carries no reasons');

    const src = bodyWithDelegate('worldDirectCheck') + bodyWithDelegate('worldDirectApply')
        + (declSource('worldDirectShowResult') || '');
    assert.match(src, /failures/,
        'the panel never reads the failures, so a refused camera reports only that it failed');
    assert.match(src, /weDirectResult|weDirectOut/,
        'the reason is not written into the panel — a 409 shown on the status bar is not "where '
        + 'the choice is made"');
});

test('a world with no scale is refused with its remedy, not reinterpreted', () => {
    // The 409 the route answers when a metric proposal has nowhere to land.
    assert.match(WORLDS, /no scale, so a camera given in metres cannot be placed/,
        'the uncalibrated-world refusal is gone from the route');
    const src = bodyWithDelegate('worldDirectCheck') + (declSource('worldDirectShowResult') || '');
    assert.match(src, /remedy/,
        'the panel drops the remedy, so a director is told the camera failed and not what to do');
});

/* ── 5 · it is a region of the design, gated and placed ─────────────────── */

test('the panel is behind its own flag, and hidden when the flag is off', () => {
    const on = renderConsole(ALL_FLAGS);
    const off = renderConsole({ ...ALL_FLAGS, cinematography_ai: false });
    assert.match(on, /DIRECT THE SHOT/, 'the panel does not render even with its flag on');
    assert.ok(!/DIRECT THE SHOT/.test(off),
        'the panel still renders with cinematography_ai switched off — the flag gates nothing');
});

test('no server-side model is reachable from this panel', () => {
    /*
     * The goal's stated rabbit hole. cinematography.js is pure and the route
     * never calls a model; the page must not offer a "generate it for me"
     * button that reaches one, because that is the fallback that spends a key
     * to answer a question the connected model has already read.
     */
    const p = panel() + (declSource('worldDirectIntent') || '') + (declSource('worldDirectCheck') || '');
    for (const forbidden of ['/screenplay-ai', '/llm', 'node_gen_llm']) {
        assert.ok(!p.includes(forbidden),
            `the panel reaches ${forbidden} — the proposal must come from the connected model`);
    }
    assert.match(p, /agent|model|MCP/i,
        'the panel never says where the proposal comes from, so a director has no idea what to do '
        + 'after choosing an intention');
});
