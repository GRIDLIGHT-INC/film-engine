const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

/*
 * Isolated before anything is required: file-storage captures DATA_DIR at
 * import time, and this test writes clips and registers assets.
 */
process.env.FILM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-repairrun-data-'));

const { runRepair, REPAIR_STAGES } = require('../lib/repair-run');
const { resolveFfmpeg, inspectMedia } = require('../lib/ffmpeg');
const { DATA_DIR } = require('../lib/file-storage');

/**
 * RBF-008 — run the plan.
 *
 * Everything this composes already exists and is tested on its own: extraction
 * (RBF-003), the splice (RBF-004), inspection (RBF-005), the plan (RBF-006),
 * the fetchable handle (RBF-011). What is new is the ORDER, what happens when
 * one step fails, and what is left behind afterwards.
 *
 * THE VERSION RULE IS THE ONE THAT COSTS REAL MONEY IF WRONG. Video is written
 * to `{shot_code}.mp4` — a fixed name — so a repair that writes there destroys
 * the take it was meant to improve, and the take cost money. "A repair is an
 * attempt, and the previous take must survive it" is the epic's own wording.
 *
 * The stage set is the module's own registry, and every stage must be able to
 * FAIL AND NAME ITSELF. A generic error sends a director to the database to
 * find out which of six steps went wrong.
 */

let TMP, PROJECT_ID, SHOT_ID;
const BASE = 'https://example.test';

function clip(p, { colour = 'red', secs = 12, w = 854, h = 480, fps = 24 } = {}) {
    execFileSync(resolveFfmpeg().bin, ['-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=${colour}:s=${w}x${h}:d=${secs + 1}`,
        '-frames:v', String(Math.round(secs * fps)), '-c:v', 'mpeg4', '-r', String(fps), p],
        { stdio: 'pipe', timeout: 60000 });
    return p;
}

/** A generator that behaves: returns a real clip of exactly the length asked for. */
function goodGenerator(seconds, colour) {
    return async () => {
        const out = path.join(TMP, `gen-${Math.random().toString(16).slice(2)}.mp4`);
        clip(out, { colour: colour || 'blue', secs: seconds, w: 854, h: 480, fps: 24 });
        return { ok: true, path: out };
    };
}

/** A minimal in-memory stand-in for the two tables this runner touches. */
function makeDb(opts) {
    /*
     * The shot ALREADY HAS A TAKE. That is the whole premise — a repair is an
     * attempt at footage that exists — so the fixture seeds the existing
     * version rather than starting from an empty table, where max+1 would be 1
     * and the assertion "it must be a NEW version" would pass over an
     * overwrite. `assets` stays the INSERT log, so counting it still counts
     * only what the repair wrote.
     */
    const existingVersion = (opts && opts.existingVersion) !== undefined ? opts.existingVersion : 1;
    const assets = [];
    return {
        assets,
        prepare(sql) {
            if (/SELECT budget_total/.test(sql)) return { get: () => ({ budget_total: 0 }) };
            if (/SUM\(amount\)/.test(sql)) return { get: () => ({ spent: 0 }) };
            if (/MAX\(version\)/i.test(sql)) {
                return { get: () => ({ v: assets.reduce((n, a) => Math.max(n, a.version || 0), existingVersion) }) };
            }
            if (/INSERT INTO film_assets/i.test(sql)) {
                /*
                 * The version's argument position is DERIVED by zipping the
                 * column list against the VALUES list and counting only the
                 * placeholders — several columns are literals. My first version
                 * counted by hand, indexed args[9] and read null; a hardcoded
                 * index also shifts silently the day a column is inserted,
                 * which would report a correct repair as unversioned.
                 */
                const cols = (/\(([^)]*?)\)\s*VALUES/is.exec(sql) || [, ''])[1]
                    .split(',').map(c => c.trim()).filter(Boolean);
                const vals = (/VALUES\s*\(([^)]*)\)/is.exec(sql) || [, ''])[1]
                    .split(',').map(c => c.trim());
                let argIndex = -1, vAt = -1;
                cols.forEach((col, i) => {
                    if (vals[i] !== '?') return;
                    argIndex += 1;
                    if (col === 'version') vAt = argIndex;
                });
                assert.ok(vAt >= 0, 'the fixture could not locate the version column');
                return { run: (...args) => { assets.push({ id: args[0], version: args[vAt], args }); } };
            }
            if (/FROM film_shots/i.test(sql)) {
                return { get: () => ({ id: SHOT_ID, project_id: PROJECT_ID, shot_code: '2B' }) };
            }
            return { get: () => null, run: () => {}, all: () => [] };
        },
    };
}

test.before(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-repairrun-'));
    PROJECT_ID = 'p-repair';
    SHOT_ID = 's-repair';
    fs.mkdirSync(path.join(DATA_DIR, 'video', PROJECT_ID), { recursive: true });
});
test.after(() => {
    for (const d of [TMP, DATA_DIR]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* temp */ }
    }
});

/** The source clip, stored where a real shot's footage lives. */
function storedSource(name = '2B.mp4') {
    const p = path.join(DATA_DIR, 'video', PROJECT_ID, name);
    return clip(p, { colour: 'red', secs: 12 });
}

const baseOpts = (extra) => ({
    db: makeDb(),
    projectId: PROJECT_ID,
    shotId: SHOT_ID,
    shotCode: '2B',
    sourcePath: storedSource(),
    startSec: 2,
    endSec: 8,
    publicBase: BASE,
    generate: goodGenerator(6),
    ...(extra || {}),
});

/* ── it runs ───────────────────────────────────────────────────────────── */

test('the plan runs end to end and produces a playable repaired clip', async () => {
    const opts = baseOpts();
    const r = await runRepair(opts);
    assert.strictEqual(r.ok, true, `failed at ${r.stage}: ${r.reason}`);
    assert.ok(fs.existsSync(r.output), 'no repaired file on disk');
    const seen = inspectMedia(r.output);
    assert.strictEqual(seen.ok, true, `the repaired clip is not playable: ${seen.reason}`);
    assert.ok(Math.abs(seen.durationSeconds - 12) < 0.5,
        `a repair must preserve the clip's length; source 12s, result ${seen.durationSeconds}s`);
    // Every stage that ran is reported, so a director can see what happened.
    assert.ok(Array.isArray(r.stages) && r.stages.length >= 5,
        `only ${(r.stages || []).length} stages reported`);
});

test('the previous take survives, and the repair is a NEW version', async () => {
    /*
     * THE RULE THAT COSTS MONEY IF WRONG. Video is written to `{shot_code}.mp4`,
     * a fixed name, so a repair writing there overwrites footage that was paid
     * for. The original file must still be on disk, byte-identical, and the new
     * row must carry a higher version rather than replacing the old one.
     */
    const opts = baseOpts();
    const before = fs.readFileSync(opts.sourcePath);
    const r = await runRepair(opts);
    assert.strictEqual(r.ok, true, `failed at ${r.stage}: ${r.reason}`);

    assert.ok(fs.existsSync(opts.sourcePath), 'the original take was deleted');
    assert.ok(fs.readFileSync(opts.sourcePath).equals(before),
        'the original take was overwritten — the repair destroyed what it was improving');
    assert.notStrictEqual(path.resolve(r.output), path.resolve(opts.sourcePath),
        'the repair wrote over the source path');

    assert.strictEqual(opts.db.assets.length, 1, 'the repair registered no asset');
    assert.ok(opts.db.assets[0].version > 1,
        `the repair registered version ${opts.db.assets[0].version}; it must be a new version`);
});

/* ── every stage names itself ──────────────────────────────────────────── */

test('every declared stage can fail, and names itself when it does', async () => {
    /*
     * SET-BASED OVER THE MODULE'S OWN REGISTRY. A runner that names the stage
     * for the two failures somebody thought of, and reports "repair failed" for
     * the rest, sends a director to the database — which is the third
     * acceptance criterion, stated the other way round.
     *
     * A stage with no probe FAILS THIS TEST rather than being skipped: a stage
     * nothing can make fail is a stage whose error path has never run.
     */
    assert.ok(REPAIR_STAGES.length >= 5, `only ${REPAIR_STAGES.length} stages declared`);
    const PROBES = {
        plan: () => baseOpts({ startSec: 5, endSec: 6 }),          // under the 4s floor
        budget: () => baseOpts({
            db: Object.assign(makeDb(), {
                prepare(sql) {
                    if (/SELECT budget_total/.test(sql)) return { get: () => ({ budget_total: 0.01 }) };
                    if (/SUM\(amount\)/.test(sql)) return { get: () => ({ spent: 0 }) };
                    return makeDb().prepare(sql);
                },
            }),
        }),
        extract: () => baseOpts({ extractFrame: () => ({ ok: false, reason: 'no encoder' }) }),
        host: () => baseOpts({ publicBase: '' }),                   // no fetchable address
        generate: () => baseOpts({ generate: async () => ({ ok: false, reason: 'the provider refused' }) }),
        splice: () => baseOpts({ generate: goodGenerator(2) }),     // wrong length for the range
        register: () => baseOpts({
            db: Object.assign(makeDb(), {
                prepare(sql) {
                    if (/INSERT INTO film_assets/i.test(sql)) {
                        return { run: () => { throw new Error('disk full'); } };
                    }
                    return makeDb().prepare(sql);
                },
            }),
        }),
    };

    const wrong = [];
    for (const stage of REPAIR_STAGES) {
        assert.ok(typeof stage.why === 'string' && stage.why.length > 20,
            `stage ${stage.id} is declared without a reason anyone can check`);
        const probe = PROBES[stage.id];
        if (!probe) { wrong.push(`${stage.id}: no probe — its error path has never run`); continue; }
        const r = await runRepair(probe());
        if (r.ok !== false) { wrong.push(`${stage.id}: the probe succeeded`); continue; }
        if (r.stage !== stage.id) { wrong.push(`${stage.id}: reported stage "${r.stage}"`); continue; }
        if (!(typeof r.reason === 'string' && r.reason.length > 15)) {
            wrong.push(`${stage.id}: failed without a usable reason`);
        }
    }
    assert.deepStrictEqual(wrong, [], `stages that do not name themselves:\n  ${wrong.join('\n  ')}`);
});

/* ── what it leaves behind ─────────────────────────────────────────────── */

test('the frames it exposed are revoked, whether it succeeds or fails', async () => {
    /*
     * "The frames of one plan, not the media tree" is RBF-011's acceptance
     * criterion, and this is the half that ends early. A handle left live after
     * the repair finishes is a file on the public internet nobody is tracking —
     * and the failure path is the one that gets forgotten, because the happy
     * path is the one people test.
     */
    const handles = require('../lib/frame-handles');
    for (const [what, opts] of [
        ['a successful repair', baseOpts()],
        ['a failed generation', baseOpts({ generate: async () => ({ ok: false, reason: 'refused' }) })],
    ]) {
        const r = await runRepair(opts);
        assert.ok(Array.isArray(r.handles) && r.handles.length >= 1,
            `${what}: no handles were minted, so this check is vacuous`);
        for (const id of r.handles) {
            assert.strictEqual(handles.resolveHandle(id).ok, false,
                `${what}: a handle is still live after the repair finished`);
        }
    }
});

test('it leaves no scratch files behind, on either path', async () => {
    /*
     * WRITTEN AFTER A MUTATION SURVIVED. This checked only a temp workDir that
     * is undefined in the normal path, so deleting the frame cleanup entirely
     * left it green. The frames HAVE to be written inside the data tree — only
     * stored media is mintable — so that is the directory that fills up, two
     * PNGs at a time, silently.
     */
    const repairs = path.join(DATA_DIR, 'repairs', PROJECT_ID);
    const left = () => (fs.existsSync(repairs) ? fs.readdirSync(repairs) : []);

    for (const [what, opts] of [
        ['a successful repair', baseOpts()],
        ['a failed generation', baseOpts({ generate: async () => ({ ok: false, reason: 'refused' }) })],
    ]) {
        const r = await runRepair(opts);
        assert.ok(!r.workDir || !fs.existsSync(r.workDir), `${what}: the temp work directory survives`);
        assert.deepStrictEqual(left(), [],
            `${what}: extracted frames were left in the data tree: ${left().join(', ')}`);
    }
});

test('a frame taken from the wrong place is refused rather than generated against', async () => {
    /*
     * extractFrame hands back FRAME ZERO when a seek runs past the end — right
     * for sampling a clip, and wrong here: generating between the wrong two
     * pictures produces a repair that looks fine, is of somewhere else, and
     * costs money to discover. planRepair already refuses a range past the end,
     * so this cannot be reached by marking badly; it guards the case where a
     * container's reported duration and what it will actually seek to disagree,
     * which is ordinary on variable-frame-rate footage.
     *
     * Injected, because that disagreement cannot be manufactured reliably in a
     * fixture — and a guard whose error path never runs is a guard nobody has
     * checked.
     */
    let generated = false;
    const r = await runRepair(baseOpts({
        extractFrame: (src, opt) => ({ ok: true, path: opt.out, fellBack: true, atSeconds: 0 }),
        generate: async () => { generated = true; return { ok: true, path: 'unused' }; },
    }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'extract');
    assert.match(r.reason, /past the end|start of it/i,
        `the refusal does not explain what was wrong with the frame: ${r.reason}`);
    assert.strictEqual(generated, false, 'it generated against a frame from the wrong place');
});

test('it never throws, whatever it is handed', async () => {
    for (const bad of [undefined, null, {}, { db: makeDb() },
        { db: makeDb(), sourcePath: '/nope.mp4', startSec: 'x', endSec: NaN }]) {
        let r;
        await assert.doesNotReject(async () => { r = await runRepair(bad); },
            `threw on ${JSON.stringify(bad)}`);
        assert.strictEqual(r.ok, false, `accepted ${JSON.stringify(bad)}`);
        assert.ok(r.stage && r.reason, `refused with no stage or reason: ${JSON.stringify(r)}`);
    }
});

test('an over-budget repair is refused before anything is generated', async () => {
    /*
     * The gate belongs with the thing that SPENDS. A budget consulted by the
     * planner and not the executor is a gate in name only — anything holding a
     * plan could run straight past it.
     */
    let generated = false;
    const opts = baseOpts({
        generate: async () => { generated = true; return { ok: false, reason: 'should never run' }; },
        db: Object.assign(makeDb(), {
            prepare(sql) {
                if (/SELECT budget_total/.test(sql)) return { get: () => ({ budget_total: 0.01 }) };
                if (/SUM\(amount\)/.test(sql)) return { get: () => ({ spent: 0 }) };
                return makeDb().prepare(sql);
            },
        }),
    });
    const r = await runRepair(opts);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.stage, 'budget');
    assert.strictEqual(generated, false, 'the generator ran despite the budget refusal');
    assert.match(r.reason, /budget|\$/i, `the refusal does not say it is about money: ${r.reason}`);

    // And it is passable, on the precedent of every other gate here.
    const forced = await runRepair({ ...opts, ignoreBudget: true });
    assert.notStrictEqual(forced.stage, 'budget', 'ignore_budget did not lift the refusal');
});
