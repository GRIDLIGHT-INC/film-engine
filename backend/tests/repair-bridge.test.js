const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

process.env.FILM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-bridge-data-'));

const { planBridge, BRIDGE_REFUSALS } = require('../lib/repair-bridge');
const { resolveFfmpeg } = require('../lib/ffmpeg');
const { MIN_DURATION, MAX_DURATION, RESOLUTIONS } = require('../lib/providers/seedance');

/**
 * A FAULT THAT LIVES BETWEEN TWO SHOTS.
 *
 * The within-a-clip repair replaces a section of one file. This is a different
 * operation and it took a real project to see it: on DRIVE-IN the problem is
 * the TRANSITION — the join between two clips reads wrong, and neither clip is
 * individually at fault. An editor marks an out-point in the first, an in-point
 * in the second, and asks for the material between them to be made again.
 *
 * SO THE OUTPUT IS NOT A REPAIRED CLIP, IT IS A BRIDGE. What comes back
 * replaces the TAIL of the first shot and the HEAD of the second, which means
 * the deliverable is a new piece of footage plus two trim instructions — the
 * thing an editor drops on a track and tops-and-tails around. Splicing it into
 * one of the two clips would be a guess about which shot the fault belongs to,
 * and the whole premise is that it belongs to neither.
 */

let TMP;
const clip = (name, secs, colour) => {
    const p = path.join(TMP, name);
    execFileSync(resolveFfmpeg().bin, ['-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=${colour || 'red'}:s=854x480:d=${secs + 1}`,
        '-frames:v', String(Math.round(secs * 24)), '-c:v', 'mpeg4', '-r', '24', p],
        { stdio: 'pipe', timeout: 60000 });
    return p;
};

test.before(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-bridge-')); });
test.after(() => {
    for (const d of [TMP, process.env.FILM_DATA_DIR]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* temp */ }
    }
});

/** Two adjacent shots: A runs 10s, B runs 10s. Marks at 7s of A and 3s of B. */
const spans = (over) => ({
    spans: [
        { shotId: 'a', shotCode: '1A', sourcePath: clip('a.mp4', 10, 'red'), startSec: 7, endSec: 10, durationSeconds: 10 },
        { shotId: 'b', shotCode: '1B', sourcePath: clip('b.mp4', 10, 'blue'), startSec: 0, endSec: 3, durationSeconds: 10 },
    ],
    resolution: '480p',
    ...(over || {}),
});

/* ── what a bridge is ──────────────────────────────────────────────────── */

test('the bridge spans the cut, and its length is both halves together', () => {
    const p = planBridge(spans());
    assert.strictEqual(p.refused, false, p.reason);
    // 3s off the end of A plus 3s off the head of B.
    assert.strictEqual(p.generate.durationSeconds, 6,
        'the bridge must cover everything the marks remove from BOTH shots');
    assert.strictEqual(p.generate.workflow, 'first-last-frame');
});

test('it travels from a frame in the FIRST shot to a frame in the SECOND', () => {
    /*
     * The order is the meaning, as everywhere else: [0] is where it starts and
     * [1] where it must arrive. Here they come from DIFFERENT FILES, which is
     * the whole difference from a within-clip repair — and the reason the frame
     * each is taken from has to name its shot, or a reversed pair reads as the
     * model running the action backwards.
     */
    const p = planBridge(spans());
    assert.strictEqual(p.extract.length, 2);
    assert.deepStrictEqual(
        p.extract.map(e => [e.role, e.shot_code, e.atSeconds]),
        [['first', '1A', 7], ['last', '1B', 3]]);
});

test('it delivers a bridge plus the two trims, not a rewritten clip', () => {
    /*
     * THE EDITORIAL SHAPE. Splicing the result into either shot would be a
     * claim about which one was at fault, and the premise is that neither was.
     * What an editor needs is the new piece and where to top-and-tail around it.
     */
    const p = planBridge(spans());
    assert.strictEqual(p.delivery.kind, 'bridge');
    assert.deepStrictEqual(p.delivery.trim, [
        { shot_code: '1A', shot_id: 'a', new_out_sec: 7 },
        { shot_code: '1B', shot_id: 'b', new_in_sec: 3 },
    ], 'the trim instructions do not say where to cut each shot');
    assert.ok(!p.splice, 'a bridge must not claim to splice into one of the two shots');
});

test('the total running time is unchanged', () => {
    /*
     * 10s + 10s in, and 7 + bridge + 7 out. A bridge that changes the duration
     * shifts every cut after it — the same rule the within-clip repair follows,
     * and the reason a length mismatch is refused rather than absorbed.
     */
    const p = planBridge(spans());
    const before = 10 + 10;
    const after = 7 + p.generate.durationSeconds + (10 - 3);
    assert.strictEqual(after, before, `the film would change length: ${before}s becomes ${after}s`);
});

/* ── the raster and the cost ───────────────────────────────────────────── */

test('the bridge is generated at the raster of the shots it sits between', () => {
    const p = planBridge(spans());
    assert.ok(p.generate.width > 0 && p.generate.height > 0);
    assert.strictEqual(p.generate.resolution, '480p');
});

test('every resolution tier prices from the provider\'s own table', () => {
    for (const tier of Object.keys(RESOLUTIONS)) {
        const p = planBridge(spans({ resolution: tier }));
        assert.strictEqual(p.refused, false, `${tier}: ${p.reason}`);
        const want = 6 * RESOLUTIONS[tier].usdPerSecond;
        assert.ok(Math.abs(p.cost.usd - want) < 0.001, `${tier}: $${p.cost.usd} not $${want}`);
    }
});

/* ── refusals ──────────────────────────────────────────────────────────── */

test('every declared refusal fires on the input that should trigger it', () => {
    assert.ok(BRIDGE_REFUSALS.length >= 4, `only ${BRIDGE_REFUSALS.length} refusals declared`);
    const two = spans().spans;
    const PROBES = {
        not_two_shots: { spans: [two[0]] },
        below_floor: { spans: [
            { ...two[0], startSec: 9, endSec: 10 },
            { ...two[1], startSec: 0, endSec: 1 },
        ] },                                            // 1 + 1 = 2s, under the 4s floor
        above_ceiling: { spans: [
            { ...two[0], startSec: 0, endSec: 10, durationSeconds: 10 },
            { ...two[1], startSec: 0, endSec: 25, durationSeconds: 30 },
        ] },                                            // 10 + 25 = 35s, over 30
        no_source: { spans: [{ ...two[0], sourcePath: path.join(TMP, 'gone.mp4') }, two[1]] },
        gap_in_the_middle: { spans: [
            { ...two[0], endSec: 8 },                   // does not run to the end of A
            two[1],
        ] },
    };
    const unreachable = [];
    for (const r of BRIDGE_REFUSALS) {
        const probe = PROBES[r.code];
        if (!probe) { unreachable.push(`${r.code} (no probe: ${r.why})`); continue; }
        const got = planBridge({ ...spans(), ...probe });
        if (got.refused !== true || got.code !== r.code) {
            unreachable.push(`${r.code} → ${got.refused ? got.code : 'ACCEPTED'}`);
        } else {
            assert.ok(typeof got.reason === 'string' && got.reason.length > 20,
                `${r.code} refuses without a usable reason`);
        }
    }
    assert.deepStrictEqual(unreachable, [], `refusals that do not fire: ${unreachable.join(', ')}`);
});

test('a sub-floor bridge names both remedies, priced', () => {
    const p = planBridge({ ...spans(), spans: [
        { ...spans().spans[0], startSec: 9, endSec: 10 },
        { ...spans().spans[1], startSec: 0, endSec: 1 },
    ] });
    assert.strictEqual(p.refused, true);
    assert.strictEqual(p.code, 'below_floor');
        assert.ok(p.reason.includes(MIN_DURATION + "s"),
        `the floor is not named: ${p.reason}`);
    assert.match(p.reason, /widen/i);
    assert.ok(p.widen && p.widen.cost_usd > 0, 'widening is offered with no price');
});

test('it never throws, whatever it is handed', () => {
    for (const bad of [undefined, null, {}, { spans: 'x' }, { spans: [{}, {}] },
        { spans: [{ startSec: NaN, endSec: Infinity }, {}] }]) {
        let p;
        assert.doesNotThrow(() => { p = planBridge(bad); }, `threw on ${JSON.stringify(bad)}`);
        assert.strictEqual(p.refused, true);
        assert.ok(p.code && p.reason, 'refused with no code or reason');
    }
});

test('planning a bridge spends nothing, by construction', () => {
    assert.ok(!(planBridge(spans()) instanceof Promise),
        'the bridge planner is async, so it can await a provider');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'repair-bridge.js'), 'utf8');
    assert.ok(!/resolveGenerator|providers\.resolve|require\(['"][^'"]*provider-config/.test(src),
        'the bridge planner reaches provider machinery');
});
