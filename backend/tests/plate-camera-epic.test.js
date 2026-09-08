/**
 * THE PLATE CAMERA EPIC, HELD TO ITSELF AND TO THE CODE.
 *
 * An epic is read as the plan long after the code moved under it. This one is
 * checked two ways, on the pattern ios-previz-epic.test.js already set:
 *
 *   ITS OWN SHAPE — every task well formed, sized, and depending only on tasks
 *   that exist. A dependency on a task that was renamed is a plan that cannot
 *   be executed in order, and nobody notices until a dispatch picks it up.
 *
 *   ITS CLAIMS — every factual statement about the code carries a predicate.
 *   The Current State table is the part most likely to rot, because the epic
 *   exists precisely to change what it describes.
 *
 * CLAIMS ARE TYPED. `present` must stay true. `gap` is a fact the epic will
 * CLOSE, and it names the task that closes it — so when the work lands the
 * claim is reshaped rather than deleted. A gap pinned as permanent makes an
 * epic fail for succeeding, which this codebase has paid for six times.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EPIC = path.join(ROOT, 'docs', 'plans', 'plate-camera-controls-epic.md');
const doc = () => fs.readFileSync(EPIC, 'utf8');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Comments stripped — an epic that QUOTES a symbol must not count as using it. */
const code = (rel) => src(rel).split('\n')
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/* ── the epic's own shape ───────────────────────────────────────────────── */

const REQUIRED_SECTIONS = ['Overview', 'Business Goals', 'Current State', 'Target State',
                           'Constraints', 'Task Breakdown', 'Open Questions', 'Success Metrics'];

/** Every task row, parsed from the epic's own tables. */
function tasks() {
    return [...doc().matchAll(/^\|\s*(PCC-\d{3})\s*\|([^|]*)\|([^|]*)\|\s*([SML])\s*\|([^|]*)\|/gm)]
        .map(m => ({ id: m[1], title: m[2].trim(), description: m[3].trim(),
                     size: m[4], deps: m[5].trim() }));
}

/**
 * One section's body, bounded by its own heading and the next one.
 *
 * Bound by heading rather than a character count: a scan bounded by characters
 * does not fail loudly when it goes out of range, it silently stops matching
 * and then blames the code it can no longer see.
 */
function section(name) {
    const m = doc().match(new RegExp(`^##+\\s+${name}\\s*$([\\s\\S]*?)(?=^##+\\s|\\Z)`, 'm'));
    assert.ok(m, `the epic has no ${name} section`);
    return m[1];
}

test('the epic exists and carries every section the format asks for', () => {
    assert.ok(fs.existsSync(EPIC), `no epic at ${path.relative(ROOT, EPIC)}`);
    const have = new Set([...doc().matchAll(/^##+\s+(.+)$/gm)].map(m => m[1].trim()));
    const missing = REQUIRED_SECTIONS.filter(s => !have.has(s));
    assert.deepStrictEqual(missing, [], `the epic omits: ${missing.join(', ')}`);
});

test('EVERY task is well formed — id, title, description, size, dependencies', () => {
    const all = tasks();
    assert.ok(all.length >= 10,
        `only ${all.length} tasks parsed — the scan is broken, and one that finds too few reports `
        + 'the plan as smaller than it is');
    const bad = [];
    for (const t of all) {
        if (!t.title) bad.push(`${t.id}: no title`);
        if (t.description.length < 40) bad.push(`${t.id}: the description says nothing usable`);
    }
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

test('task ids are unique and unbroken', () => {
    const ids = tasks().map(t => t.id);
    assert.deepStrictEqual([...new Set(ids)], ids, 'a task id is used twice');
    const nums = ids.map(i => Number(i.slice(4)));
    for (let i = 0; i < nums.length; i++) {
        assert.strictEqual(nums[i], i + 1,
            `task numbering jumps at ${ids[i]} — a gap reads as a task that was dropped`);
    }
});

test('EVERY dependency names a task that exists', () => {
    /*
     * The failure this catches is silent: a renamed task leaves a dependency
     * pointing at nothing, and the plan cannot be executed in order. Nobody
     * finds out until a dispatch picks up a task whose prerequisite is a
     * typo.
     */
    const ids = new Set(tasks().map(t => t.id));
    const dangling = [];
    for (const t of tasks()) {
        if (/^none$/i.test(t.deps)) continue;
        for (const dep of t.deps.split(/[,\s]+/).filter(d => /^PCC-\d{3}/.test(d))) {
            // A range like PCC-001..PCC-009 names its endpoints.
            for (const one of dep.split('..')) {
                if (!ids.has(one)) dangling.push(`${t.id} depends on ${one}, which does not exist`);
            }
        }
    }
    assert.deepStrictEqual(dangling, [], dangling.join('\n  '));
});

test('no task depends on itself or on something later', () => {
    // A forward dependency is a plan that deadlocks on first execution.
    const order = new Map(tasks().map((t, i) => [t.id, i]));
    const bad = [];
    for (const t of tasks()) {
        if (/^none$/i.test(t.deps)) continue;
        for (const dep of (t.deps.match(/PCC-\d{3}/g) || [])) {
            if (dep === t.id) bad.push(`${t.id} depends on itself`);
            else if (order.get(dep) > order.get(t.id)) bad.push(`${t.id} depends on later ${dep}`);
        }
    }
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

/* ── the user's direction, which is not re-openable ─────────────────────── */

test('the epic holds the scope the user actually chose', () => {
    /*
     * "Phase A only — plates. No transport work, no Log/ProRes, no footage
     * capture. Strike the four iPhone 17 Pro features from scope."
     *
     * An epic that quietly re-admitted any of those would be planning work
     * nobody asked for, which is the most expensive kind.
     */
    const t = tasks().map(x => `${x.title} ${x.description}`).join(' ').toLowerCase();
    const forbidden = ['prores', 'apple log', 'genlock', 'open gate', 'chunked', 'resumable'];
    const admitted = forbidden.filter(f => t.includes(f));
    assert.deepStrictEqual(admitted, [],
        `these are out of scope by the user's direction and a task proposes them: ${admitted.join(', ')}`);

    /*
     * And the exclusion must be STATED where an executor reads scope, not
     * merely absent. A later reader has to be able to tell "decided against"
     * from "forgotten", and the difference is worth four tasks nobody asked
     * for.
     *
     * Bound to the CONSTRAINTS section by its own heading — never by a
     * character window, which this codebase has paid for four times. An
     * alternation over three phrasings anywhere in the document was the first
     * version and it survived deleting one of them: two statements existed and
     * either satisfied it.
     */
    const constraints = section('Constraints');
    for (const struck of ['ProRes RAW', 'Apple Log 2', 'open gate', 'genlock']) {
        assert.ok(constraints.includes(struck),
            `Constraints never mentions ${struck}, so nothing says it is out of scope`);
    }
    assert.match(constraints, /struck, not deferred/i,
        'Constraints does not say the four top-tier features are struck RATHER THAN DEFERRED, so a '
        + 'later reader will carry them as unfinished work');
});

/* ── claims about the code ──────────────────────────────────────────────── */

const CLAIMS = [
    {
        id: 'camera-line-count',
        kind: 'present',
        why: 'the Current State table quotes a size, and a size in prose is the first thing to rot',
        holds() {
            const lines = src('ios/FilmEngine/PlateCamera.swift').split('\n').length - 1;
            return doc().includes(`${lines} lines`)
                || `PlateCamera.swift is ${lines} lines and the epic says otherwise`;
        },
    },
    {
        id: 'exposure-lock-built',
        kind: 'present',
        why: 'RESHAPED from `no-manual-control-apis` when PCC-002 landed (GRD-3653). The exposure '
            + 'half is built and must stay so; the focus and white-balance halves are still gaps '
            + 'and are tracked separately below',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            const missing = ['setExposureModeCustom', 'isExposureModeSupported', 'ExposureLock']
                .filter(s => !cam.includes(s));
            return missing.length === 0 || `the exposure lock has lost: ${missing.join(', ')}`;
        },
    },
    {
        id: 'white-balance-lock-built',
        kind: 'present',
        why: 'RESHAPED from `no-wb-focus-or-footage-apis` when PCC-003 landed (GRD-3654). It '
            + 'locks and releases WITH the exposure, which is the epic\'s own reasoning: a plate '
            + 'that matches on brightness and not colour still disagrees',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            const missing = ['setWhiteBalanceModeLocked', 'WhiteBalanceLock',
                             'LockingWhiteBalanceWithCustomDeviceGainsSupported']
                .filter(s => !cam.includes(s));
            return missing.length === 0 || `the white balance lock has lost: ${missing.join(', ')}`;
        },
    },
    {
        id: 'focus-lock-built',
        kind: 'present',
        why: 'RESHAPED from `no-focus-or-footage-apis` when PCC-004 landed (GRD-3655). With this '
            + 'the three manual controls of Phase 1 are all built, so nothing is left of the '
            + 'original manual-control gap except the footage pair',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            const missing = ['setFocusModeLocked', 'FocusLock', 'focusPointOfInterest',
                             'captureDevicePointConverted'].filter(s => !cam.includes(s));
            return missing.length === 0 || `the focus lock has lost: ${missing.join(', ')}`;
        },
    },
    {
        id: 'no-footage-apis',
        kind: 'gap',
        /*
         * No task closes this, and that is CORRECT: footage capture is Phase B,
         * struck from this epic by the user's direction. The claim is kept as a
         * tripwire — if an AVAssetWriter path ever appears, the scope changed
         * and somebody should say so deliberately.
         */
        outOfScope: 'Phase B — footage capture, struck from this epic by the user\'s direction',
        why: 'all that remains of the original manual-control claim after PCC-002, PCC-003 and '
            + 'PCC-004 each closed a third. Phase B is out of scope by the user\'s direction, so '
            + 'this stays a gap deliberately rather than being scheduled',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            const present = ['activeColorSpace', 'AVCaptureVideoDataOutput', 'AVAssetWriter']
                .filter(s => cam.includes(s));
            return present.length === 0
                || `footage capture has landed (${present.join(', ')}) — reshape this claim`;
        },
    },
    {
        id: 'preview-is-a-layer',
        kind: 'gap',
        closes: 'PCC-007',
        why: 'PCC-007 is sized L because the preview has no access to frames; if that changed the '
            + 'sizing is wrong',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            return cam.includes('AVCaptureVideoPreviewLayer')
                || 'the preview is no longer a layer — PCC-007 may already be done, reshape this';
        },
    },
    {
        id: 'session-walk-still-works',
        kind: 'present',
        why: 'every task extends the existing walk; if Skip, Retake or per-view failure naming were '
            + 'lost, the epic would be building on something that no longer exists',
        holds() {
            const cam = code('ios/FilmEngine/PlateCamera.swift');
            const missing = ['Retake', 'Skip', 'result.failed'].filter(s => !cam.includes(s));
            return missing.length === 0 || `the session walk has lost: ${missing.join(', ')}`;
        },
    },
    {
        id: 'turnaround-views-are-the-engines-own',
        kind: 'present',
        why: 'the epic says four views describe one subject; those view names must remain ones the '
            + 'engine ranks, or no shot can select the plate',
        holds() {
            const { VIEW_RANK } = require('../lib/plate-views');
            const need = ['front', 'side-left', 'side-right', 'back'];
            const unknown = need.filter(v => !(v in VIEW_RANK));
            return unknown.length === 0
                || `the engine no longer ranks ${unknown.join(', ')}, so the turnaround is not selectable`;
        },
    },
    {
        id: 'headline-plate-attaches-the-front-view',
        kind: 'present',
        why: 'the business case rests on the front plate reaching every frame of its subject; if '
            + 'nothing consumed it the goals would be overstated',
        holds() {
            const consumers = ['lib/shot-references.js']
                .filter(f => code(`backend/${f}`).includes('headlinePlate'));
            return consumers.length >= 1
                || 'nothing consumes headlinePlate any more, so the epic overstates its value';
        },
    },
];

test('EVERY claim the epic rests on is still true of the code', () => {
    const broken = CLAIMS.map(c => [c.id, c.holds()]).filter(([, r]) => r !== true)
        .map(([id, r]) => `${id}: ${r}`);
    assert.deepStrictEqual(broken, [],
        'the epic has drifted from the code:\n  ' + broken.join('\n  '));
});

test('every claim states why, and every gap names the task that closes it', () => {
    for (const c of CLAIMS) {
        assert.ok(c.why && c.why.length > 40, `${c.id}: states no real reason`);
        if (c.kind === 'gap') {
            /*
             * A gap must name the task that closes it, so the claim gets
             * RESHAPED when the work lands rather than failing for succeeding.
             *
             * The one exception is a gap that nothing in this epic will ever
             * close, because the work was struck from scope. That has to be
             * DECLARED, and it has to give a reason — otherwise "out of scope"
             * becomes the cheap way to keep a stale gap alive for ever.
             */
            if (c.outOfScope) {
                assert.ok(c.outOfScope.length > 30,
                    `${c.id} claims to be out of scope and gives no real reason`);
                assert.ok(!/PCC-\d{3}/.test(c.closes || ''),
                    `${c.id} is both out of scope and closed by a task; it cannot be both`);
                continue;
            }
            assert.ok(/PCC-\d{3}/.test(c.closes || ''),
                `${c.id} is a gap and names no task that closes it — a gap pinned as permanent makes `
                + 'the epic fail for succeeding');
            const ids = new Set(tasks().map(t => t.id));
            for (const dep of c.closes.match(/PCC-\d{3}/g)) {
                assert.ok(ids.has(dep), `${c.id} says ${dep} closes it, and no such task exists`);
            }
        }
    }
    assert.ok(CLAIMS.length >= 6, `only ${CLAIMS.length} claims pinned; the epic rests on more`);
});

test('the epic plans for the constraints that will actually bite', () => {
    /*
     * Three existing tests constrain any change here, and an epic that does not
     * mention them plans work that will fail on contact.
     */
    const c = doc();
    assert.match(c, /byte-identical/,
        'the epic does not mention that the bundled page must stay byte-identical to src/index.html');
    assert.match(c, /gap.*reshap|reshap.*gap/is,
        'the epic does not say the gap claims must be reshaped when the work lands');
    assert.match(c, /simulator/i,
        'the epic does not acknowledge that a simulator has no camera, which is how it must be tested');
});
