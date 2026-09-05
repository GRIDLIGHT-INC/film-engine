const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * RBF-007 — two marks on the scrubber, and what they cost before anything is
 * spent.
 *
 * THE REAL WORK IS A UNIT CONVERSION, and that is where the bug would live.
 * Playback thinks in TIMELINE-ABSOLUTE milliseconds — `pb.localMs` plus the
 * entry's `start_ms` — while `planRepair` takes CLIP-RELATIVE seconds, because
 * ffmpeg seeks within one file. A mark at 00:41 of the film is 3.2s into shot
 * 2B, and sending 41 to the trim cuts a completely different piece of footage.
 * Nothing about that failure looks like a unit error: it produces a valid,
 * playable, wrong repair.
 *
 * So the rule lives in `lib/playback-marks.js` and is MIRRORED into the SPA,
 * on the precedent `screenplay-blocks.js` set — the page cannot require a node
 * module (`build.target: single-html`), and two rules that disagree is how a
 * fix survives in the tests and not on the screen. The two copies are held
 * equal here over a case table rather than by reading them side by side.
 */

const marks = require('../lib/playback-marks');
const { MIN_DURATION } = require('../lib/providers/seedance');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** A two-shot timeline, in the shape playback actually builds. */
const TIMELINE = [
    { shot_id: 's1', shot_code: '1A', start_ms: 0, end_ms: 6000, duration_ms: 6000 },
    { shot_id: 's2', shot_code: '1B', start_ms: 6000, end_ms: 15000, duration_ms: 9000 },
];

/*
 * The cases both implementations must agree on. Written as a table because the
 * failure is per-case: an implementation that handles the same-clip case and
 * gets the cross-clip offsets wrong passes any test written against one mark
 * pair.
 */
const CASES = [
    ['both marks inside the first clip', 1000, 5000],
    ['both marks inside the second clip', 7000, 14000],
    ['a mark on each clip', 4000, 9000],
    ['the very start', 0, 5000],
    ['the very end', 9000, 15000],
    ['a range under the floor', 2000, 3000],
    ['out before in', 5000, 1000],
    ['equal marks', 4000, 4000],
    ['past the end of the film', 1000, 99000],
    ['a negative mark', -500, 3000],
];

/* ── the conversion ────────────────────────────────────────────────────── */

test('marks inside one clip become that clip\'s own seconds', () => {
    const r = marks.resolveMarks(TIMELINE, 7000, 14000);
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.spans.length, 1);
    const s = r.spans[0];
    assert.strictEqual(s.shot_code, '1B');
    // 7000ms absolute is 1.0s into a clip that starts at 6000ms.
    assert.strictEqual(s.startSec, 1, `expected 1s into the clip, got ${s.startSec}`);
    assert.strictEqual(s.endSec, 8, `expected 8s into the clip, got ${s.endSec}`);
    assert.strictEqual(r.crossClip, false);
    assert.strictEqual(r.seconds, 7);
});

test('a mark on each clip reports both spans, each in its own clip\'s seconds', () => {
    /*
     * "In one clip or across two" is the epic's own wording. Across two, the
     * first span runs from the in-mark to the END of its clip and the second
     * from the START of the next to the out-mark — a single range in the film,
     * two ranges in two files.
     */
    const r = marks.resolveMarks(TIMELINE, 4000, 9000);
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.crossClip, true);
    assert.strictEqual(r.spans.length, 2);
    assert.deepStrictEqual(
        r.spans.map(s => [s.shot_code, s.startSec, s.endSec]),
        [['1A', 4, 6], ['1B', 0, 3]],
        'the cross-clip offsets are not each clip\'s own');
    assert.strictEqual(r.seconds, 5, 'the marked length is not the span across the cut');
});

test('the floor comes from the provider, not a literal', () => {
    /*
     * Mutating MIN_DURATION in the adapter must move this. A copied 4 would
     * keep reporting a floor the model no longer has.
     */
    assert.strictEqual(marks.MARK_FLOOR_S, MIN_DURATION,
        'the mark floor does not match the model\'s minimum');
    /*
     * AND IT IS DERIVED, not merely equal. A literal `4` compares identical to
     * MIN_DURATION today and stops tracking it the day the model changes —
     * a mutation replacing the derivation with the same number survived every
     * value comparison, which is why the source is read here.
     */
    const libSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'playback-marks.js'), 'utf8');
    assert.match(libSrc, /const\s+MARK_FLOOR_S\s*=\s*MIN_DURATION\s*;/,
        'the mark floor is a hardcoded copy rather than the provider\'s own value');
    const under = marks.resolveMarks(TIMELINE, 1000, 1000 + (MIN_DURATION - 1) * 1000);
    assert.strictEqual(under.meetsFloor, false, 'a sub-floor range was reported as meeting the floor');
    const over = marks.resolveMarks(TIMELINE, 1000, 1000 + (MIN_DURATION + 1) * 1000);
    assert.strictEqual(over.meetsFloor, true);
    assert.strictEqual(over.floor, MIN_DURATION);
});

test('every refusal fires on the input that should trigger it', () => {
    assert.ok(marks.MARK_REFUSALS.length >= 4,
        `only ${marks.MARK_REFUSALS.length} refusals; this is not the real set`);
    const PROBES = {
        no_timeline: [[], 1000, 5000],
        marks_reversed: [TIMELINE, 5000, 1000],
        marks_empty: [TIMELINE, 4000, 4000],
        marks_outside: [TIMELINE, 1000, 99000],
        marks_too_far: [[...TIMELINE,
            { shot_id: 's3', shot_code: '1C', start_ms: 15000, end_ms: 20000, duration_ms: 5000 }],
            1000, 19000],
    };
    const unreachable = [];
    for (const r of marks.MARK_REFUSALS) {
        const probe = PROBES[r.code];
        if (!probe) { unreachable.push(`${r.code} (no probe: ${r.why})`); continue; }
        const got = marks.resolveMarks(...probe);
        if (got.ok !== false || got.code !== r.code) {
            unreachable.push(`${r.code} → ${got.ok ? 'ACCEPTED' : got.code}`);
        } else {
            assert.ok(typeof got.reason === 'string' && got.reason.length > 20,
                `${r.code} refuses without a usable reason: ${got.reason}`);
        }
    }
    assert.deepStrictEqual(unreachable, [], `refusals that do not fire: ${unreachable.join(', ')}`);
});

test('it never throws, whatever playback hands it', () => {
    for (const bad of [[undefined, 1, 2], [null, 1, 2], [TIMELINE, 'x', {}],
        [TIMELINE, NaN, NaN], [[{}], 0, 1], [TIMELINE, Infinity, -Infinity]]) {
        let r;
        assert.doesNotThrow(() => { r = marks.resolveMarks(...bad); }, `threw on ${JSON.stringify(bad)}`);
        assert.strictEqual(r.ok, false, `accepted ${JSON.stringify(bad)}`);
        assert.ok(r.code && r.reason, 'refused with no code or reason');
    }
});

/* ── the page carries the same rule ────────────────────────────────────── */

test('the page mirrors the resolver, and the two agree on every case', () => {
    /*
     * EXECUTED, not grepped. A mirrored rule that has drifted looks identical
     * in source — the same function name, the same shape — and only differs in
     * an offset. Running both over the case table is the only thing that
     * catches it.
     */
    const at = SPA.indexOf('function pbResolveMarks');
    assert.ok(at > 0, 'the page carries no mirror of the mark resolver');
    let depth = 0, end = at;
    for (let i = SPA.indexOf('{', at); i < SPA.length; i++) {
        if (SPA[i] === '{') depth++;
        else if (SPA[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    const body = SPA.slice(at, end);
    assert.ok(body.length > 200, 'the mirrored resolver is too small to be the rule');

    /*
     * The page declares its floor at module level, so the extracted function
     * body alone does not run. Hoisting it is also the stronger check: the
     * page's own constant is asserted against the provider's MIN_DURATION, so
     * a mirror that keeps working while the floor drifts still fails.
     */
    const floorDecl = /const\s+PB_MARK_FLOOR_S\s*=\s*(\d+)\s*;/.exec(SPA);
    assert.ok(floorDecl, 'the page declares no mark floor');
    assert.strictEqual(Number(floorDecl[1]), MIN_DURATION,
        `the page's mark floor is ${floorDecl[1]}s and the model's is ${MIN_DURATION}s`);

    // eslint-disable-next-line no-new-func
    const pageResolve = new Function(`${floorDecl[0]}\n${body}; return pbResolveMarks;`)();
    const disagreed = [];
    for (const [name, a, b] of CASES) {
        const mine = marks.resolveMarks(TIMELINE, a, b);
        const theirs = pageResolve(TIMELINE, a, b);
        if (JSON.stringify(mine) !== JSON.stringify(theirs)) {
            disagreed.push(`${name}: lib ${JSON.stringify(mine)} vs page ${JSON.stringify(theirs)}`);
        }
    }
    assert.deepStrictEqual(disagreed, [],
        `the page and the engine disagree about the marks:\n  ${disagreed.join('\n  ')}`);
});

/* ── the surface ───────────────────────────────────────────────────────── */

test('every mark operation has a control bound to something clickable', () => {
    /*
     * The rule `previs-explore-ui` established: a control that exists, reaches
     * its handler, and is bound to something a person can press. A handler
     * wired to nothing looks identical to a working page until it is clicked.
     */
    assert.ok(marks.MARK_OPERATIONS.length >= 3,
        `only ${marks.MARK_OPERATIONS.length} operations declared`);
    const unbound = [];
    for (const op of marks.MARK_OPERATIONS) {
        assert.ok(typeof op.why === 'string' && op.why.length > 20, `${op.id} has no stated reason`);
        if (!new RegExp(`function\\s+${op.handler}\\s*\\(`).test(SPA)) {
            unbound.push(`${op.id}: ${op.handler} is not defined`); continue;
        }
        if (!new RegExp(`onclick="${op.handler}\\(`).test(SPA)) {
            unbound.push(`${op.id}: ${op.handler} is bound to nothing clickable`);
        }
    }
    assert.deepStrictEqual(unbound, [], `mark operations with no way in: ${unbound.join(', ')}`);
});

test('the surface shows the length, the floor and the cost before spending', () => {
    /*
     * The three acceptance criteria, each checked as a thing the page RENDERS
     * rather than a thing it could compute. A cost the page can work out and
     * never paints is a cost nobody sees.
     */
    const at = SPA.indexOf('function pbRenderMarks');
    assert.ok(at > 0, 'nothing renders the marks');
    let depth = 0, end = at;
    for (let i = SPA.indexOf('{', at); i < SPA.length; i++) {
        if (SPA[i] === '{') depth++;
        else if (SPA[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    const body = SPA.slice(at, end);
    assert.match(body, /seconds|length/i, 'the marked length is never rendered');
    /*
     * Bound to the VALUE and the COMPARISON, not to a word. Matching
     * /floor/i passed against a version that had been blanked to `''` — the
     * variable was still called floorNote, so the identifier satisfied the
     * grep while nothing about the floor reached the screen.
     */
    assert.match(body, /r\.floor/, 'the floor value is never rendered');
    assert.match(body, /meetsFloor/, 'the marked length is never compared against the floor');
    assert.match(body, /cost|usd|\$/i, 'the projected cost is never rendered');
});

test('the cost comes from the engine rather than a rate table in the page', () => {
    /*
     * A second rate card in the SPA is how the page and the bill come to
     * disagree. The page asks the free plan route and paints what it says.
     */
    assert.match(SPA, /repair-plan/,
        'the page never asks for a plan, so any cost it shows was invented locally');
    assert.ok(!/usdPerSecond|0\.17.*0\.34.*0\.85/s.test(SPA.slice(SPA.indexOf('function pbRenderMarks'),
        SPA.indexOf('function pbRenderMarks') + 3000)),
        'the page carries its own per-second rates');
});

test('the plan route is free, and reachable', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /repair-plan/, 'server.js never dispatches the repair plan route');
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'approvals.js'), 'utf8');
    assert.match(route, /planRepair/, 'the route does not call the planner');
    // Free: nothing in the route may resolve a provider or generate.
    const stripped = route.split('\n').map(l => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l)).join('\n');
    assert.ok(!/resolveGenerator|provider\.generate|providers\.resolve|require\(['"][^'"]*provider/.test(stripped),
        'the plan route reaches provider machinery; raising a plan would be a billable act');
});
