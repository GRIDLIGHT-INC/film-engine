const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

/**
 * RBF-006 — marks in, plan out, spending nothing.
 *
 * The plan is what a director is shown BEFORE any generation is paid for, so it
 * cannot be the thing that costs money to raise. That is the whole reason for
 * the planner/executor split `lib/video-sequence.js` already follows, and this
 * mirrors it rather than inventing a second shape.
 *
 * THE FLOOR IS THE POINT. `MIN_DURATION` is 4 seconds and a fault is very often
 * shorter than that, so the commonest thing a director will mark cannot be
 * regenerated at its own length. Today that is invisible until a request comes
 * back refused, with the money for the attempt already gone.
 *
 * Both denominators are DERIVED. The refusals must be a superset of the
 * splice's own `SPLICE_REFUSALS`, so a rule added there is required here
 * without anybody remembering; and the cost is checked against every tier in
 * Seedance's own `RESOLUTIONS` table, so a new tier is priced or the test
 * fails.
 */

const { planRepair, REPAIR_REFUSALS, REPAIR_PLAN_FIELDS } = require('../lib/repair-plan');
const { SPLICE_REFUSALS, resolveFfmpeg } = require('../lib/ffmpeg');
const { RESOLUTIONS } = require('../lib/providers/seedance');

let TMP;
const clip = (name, { w = 854, h = 480, fps = 24, secs = 12 } = {}) => {
    const p = path.join(TMP, name);
    execFileSync(resolveFfmpeg().bin, ['-nostdin', '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=red:s=${w}x${h}:d=${secs + 1}`,
        '-frames:v', String(Math.round(secs * fps)), '-c:v', 'mpeg4', '-r', String(fps), p],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    return p;
};

test.before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-repair-')); });
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* temp */ } });

const base = () => ({ sourcePath: clip('base.mp4'), startSec: 2, endSec: 8 });

/* ── it spends nothing ─────────────────────────────────────────────────── */

test('the planner cannot spend, by construction', () => {
    /*
     * PROVEN BY THE SIGNATURE, not by a comment. Every paid path in this
     * codebase is asynchronous — a provider call is awaited — so a SYNCHRONOUS
     * planner cannot have made one. That is a stronger guarantee than scanning
     * for a provider import, which the next refactor routes around.
     */
    assert.strictEqual(planRepair.constructor.name, 'Function',
        'the planner is async, so it can await a provider and this guarantee is gone');
    const r = planRepair(base());
    assert.ok(!(r instanceof Promise), 'the planner returned a promise; it can spend');
});

test('the planner names no provider adapter', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'repair-plan.js'), 'utf8')
        .split('\n').map(l => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l)).join('\n');
    assert.ok(!/require\(['"]\.\/provider-config|\bresolveGenerator\b|\bproviders\.resolve\b/.test(src),
        'the planner resolves a provider; raising a plan would then be a billable act');
    // The rate CARD is a table, not a call. Reading it is free and is the point.
    assert.match(src, /RESOLUTIONS/, 'the planner prices nothing from the provider\'s own table');
});

/* ── refusals ──────────────────────────────────────────────────────────── */

test('every refusal the splice declares is also refused here', () => {
    /*
     * DERIVED SUPERSET. The planner wraps planSplice, so a rule added to the
     * splice must not be silently un-enforced one level up — which is exactly
     * what happens when two registries are maintained by hand.
     */
    const codes = new Set(REPAIR_REFUSALS.map(r => r.code));
    const missing = SPLICE_REFUSALS.map(r => r.code).filter(c => !codes.has(c));
    assert.deepStrictEqual(missing, [],
        `the splice refuses these and the planner does not: ${missing.join(', ')}`);
    assert.ok(REPAIR_REFUSALS.length > SPLICE_REFUSALS.length,
        'the planner adds no refusal of its own; the duration floor is its whole reason for existing');
    for (const r of REPAIR_REFUSALS) {
        assert.ok(r.code && typeof r.why === 'string' && r.why.length > 20,
            `${r.code} is declared without a reason anyone can check`);
    }
});

test('every declared refusal fires on the input that should trigger it', () => {
    const src = clip('ref.mp4');
    const PROBES = {
        no_source: { sourcePath: path.join(TMP, 'gone.mp4') },
        range_negative: { startSec: -1, endSec: 5 },
        range_reversed: { startSec: 8, endSec: 2 },
        range_empty: { startSec: 4, endSec: 4 },
        range_past_end: { startSec: 2, endSec: 999 },
        length_mismatch: { replacementDuration: 99 },
        range_below_floor: { startSec: 2, endSec: 4 },
        range_above_ceiling: { startSec: 0, endSec: 31, sourceDuration: 40 },
    };
    const unreachable = [];
    for (const r of REPAIR_REFUSALS) {
        const probe = PROBES[r.code];
        if (!probe) { unreachable.push(`${r.code} (no probe: ${r.why})`); continue; }
        const got = planRepair({ sourcePath: src, startSec: 2, endSec: 8, ...probe });
        if (got.refused !== true || got.code !== r.code) {
            unreachable.push(`${r.code} → ${got.refused ? got.code : 'ACCEPTED'}`);
        } else {
            assert.ok(typeof got.reason === 'string' && got.reason.length > 20,
                `${r.code} refuses without a reason a director can act on: ${got.reason}`);
        }
    }
    assert.deepStrictEqual(unreachable, [],
        `declared refusals that do not fire: ${unreachable.join(', ')}`);
});

test('a range under the four-second floor is refused with BOTH remedies named', () => {
    /*
     * THE ACCEPTANCE CRITERION, and the reason it says both: widening changes
     * what the director marked, and generating four seconds to trim back pays
     * for footage nobody sees. Which one is right is the epic's open question 3
     * and belongs to a person. Naming one would be this function choosing.
     */
    const r = planRepair({ sourcePath: clip('short.mp4'), startSec: 3, endSec: 5.5 });
    assert.strictEqual(r.refused, true);
    assert.strictEqual(r.code, 'range_below_floor');
    assert.match(r.reason, /2\.5/, `the reason does not name the marked length: ${r.reason}`);
    // `\b4\b` cannot match "4s" — 4 and s are both word characters, so there is
    // no boundary between them. The message named the floor the whole time.
    assert.match(r.reason, /\b4s\b|\b4 seconds\b/, `the reason does not name the floor: ${r.reason}`);
    assert.match(r.reason, /widen/i, `the reason does not offer widening: ${r.reason}`);
    assert.match(r.reason, /trim/i, `the reason does not offer trimming back: ${r.reason}`);
    // And it must say what widening would cost, or "widen it" is advice with no price.
    assert.ok(/\$\s*\d/.test(r.reason) || (r.widen && r.widen.cost_usd > 0),
        'widening is offered without saying what it would cost');
});

test('a range longer than the model will generate is refused', () => {
    const r = planRepair({ sourcePath: clip('long.mp4', { secs: 40 }), startSec: 0, endSec: 31 });
    assert.strictEqual(r.refused, true);
    assert.strictEqual(r.code, 'range_above_ceiling');
    assert.match(r.reason, /30/, `the reason does not name the ceiling: ${r.reason}`);
});

/* ── what the plan reports ─────────────────────────────────────────────── */

test('the plan reports every field it declares', () => {
    assert.ok(Array.isArray(REPAIR_PLAN_FIELDS) && REPAIR_PLAN_FIELDS.length >= 5,
        `only ${(REPAIR_PLAN_FIELDS || []).length} plan fields declared; this is not the real set`);
    const r = planRepair(base());
    assert.strictEqual(r.refused, false, r.reason);
    const missing = REPAIR_PLAN_FIELDS.filter(f => r[f.id] === undefined).map(f => f.id);
    assert.deepStrictEqual(missing, [], `declared and never reported: ${missing.join(', ')}`);
    for (const f of REPAIR_PLAN_FIELDS) {
        assert.ok(typeof f.why === 'string' && f.why.length > 20, `${f.id} has no stated reason`);
    }
});

test('it names the two frames to extract, at the marks', () => {
    /*
     * The mechanism this epic is built on: `first-last-frame` takes exactly two
     * pictures, ORDERED — [0] the frame it starts on, [1] the frame it ends on.
     * Reversed, the move runs backwards and reads as a model fault.
     */
    const r = planRepair({ ...base(), startSec: 2, endSec: 8 });
    assert.strictEqual(r.refused, false, r.reason);
    assert.strictEqual(r.extract.length, 2, `expected two frames, got ${r.extract.length}`);
    assert.strictEqual(r.extract[0].atSeconds, 2, 'the first frame is not the in-mark');
    assert.strictEqual(r.extract[1].atSeconds, 8, 'the second frame is not the out-mark');
    assert.ok(r.extract[0].role && r.extract[1].role, 'the frames carry no role, so their order is an accident');
});

test('what is generated is the range, at a real duration and a real raster', () => {
    const r = planRepair({ ...base(), startSec: 2, endSec: 8 });
    assert.strictEqual(r.generate.durationSeconds, 6);
    assert.strictEqual(r.generate.workflow, 'first-last-frame',
        'a repair between two marks is not a first-last-frame generation');
    assert.ok(r.generate.resolution, 'no resolution is stated, so the cost below means nothing');
    assert.ok(r.generate.width > 0 && r.generate.height > 0,
        'the plan states no raster; the repair would be generated at a size nobody chose');
});

test('the resolution follows the source rather than a constant', () => {
    /*
     * Read from the FILE by RBF-005. A repair generated at a different raster
     * from the footage around it is the seam this epic names as its main risk,
     * and defaulting to one tier would produce it on every other project.
     */
    const small = planRepair({ sourcePath: clip('sd.mp4', { w: 854, h: 480 }), startSec: 1, endSec: 6 });
    const large = planRepair({ sourcePath: clip('hd.mp4', { w: 1920, h: 1080 }), startSec: 1, endSec: 6 });
    assert.strictEqual(small.generate.resolution, '480p', `read ${small.generate.resolution}`);
    assert.strictEqual(large.generate.resolution, '1080p', `read ${large.generate.resolution}`);
});

test('every resolution tier is priced from the provider\'s own table', () => {
    /*
     * Set-based over Seedance's RESOLUTIONS, so a tier added there is priced or
     * this fails — rather than silently costing whatever the last tier did.
     */
    const tiers = Object.keys(RESOLUTIONS);
    assert.ok(tiers.length >= 4, `only ${tiers.length} tiers; this scan is broken`);
    for (const tier of tiers) {
        const r = planRepair({ ...base(), startSec: 2, endSec: 8, resolution: tier });
        assert.strictEqual(r.refused, false, `${tier}: ${r.reason}`);
        const want = 6 * RESOLUTIONS[tier].usdPerSecond;
        assert.ok(Math.abs(r.cost.usd - want) < 0.001,
            `${tier}: expected $${want.toFixed(2)} for 6s, plan says $${r.cost.usd}`);
        assert.strictEqual(r.cost.resolution, tier);
    }
});

/* ── the split, and robustness ─────────────────────────────────────────── */

test('planning writes nothing to disk', () => {
    const before = fs.readdirSync(TMP).length;
    planRepair(base());
    planRepair({ ...base(), resolution: '4k' });
    // base() builds one fixture per call; nothing else may appear.
    assert.ok(fs.readdirSync(TMP).length <= before + 2,
        'the planner produced files; planning and execution are not separate');
});

test('it never throws, whatever it is handed', () => {
    for (const bad of [undefined, null, {}, { sourcePath: 42 },
        { sourcePath: '/nope.mp4', startSec: 'x', endSec: NaN },
        { sourcePath: '/nope.mp4', startSec: Infinity, endSec: -Infinity }]) {
        let r;
        assert.doesNotThrow(() => { r = planRepair(bad); }, `threw on ${JSON.stringify(bad)}`);
        assert.strictEqual(r.refused, true, `accepted ${JSON.stringify(bad)}`);
        assert.ok(r.code && r.reason, `refused with no code or reason: ${JSON.stringify(r)}`);
    }
});
