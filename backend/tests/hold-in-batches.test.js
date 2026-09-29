/**
 * PGN-017 — honour the hold in every batch run.
 *
 * A held shot, sequence or cue is skipped, and REPORTED as skipped, by every
 * batch entry point: the four generators' batches and their streams, the
 * storyboard batch and its stream, the lip-sync and post batches, the pipeline
 * runner, the run plan, "Run what changed", "Run to here" and the page's
 * "Run pending". A held node is left out of a projected total and listed
 * beside it as held (decision 4). Conform and export never read the hold: a
 * held shot stays in the film.
 *
 * The denominator is DERIVED from the code — every batch-shaped function in
 * routes/ — and each must be registered in BATCH_ENTRY_POINTS or exempted by
 * name with a reason. A batch added later arrives covered or fails here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-hb-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const hold = require('../lib/graph-hold');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, '..', f), 'utf8');
function fnIn(src, name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
    if (!m) return null;
    let i = src.indexOf('(', m.index), parens = 0;
    for (; i < src.length; i++) { if (src[i] === '(') parens++; else if (src[i] === ')' && --parens === 0) { i++; break; } }
    let depth = 0;
    for (let j = src.indexOf('{', i); j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1); }
    return null;
}

// ---- the denominator ------------------------------------------------------------------
test('every batch-shaped function in routes/ is a registered entry point or exempted by name with why', () => {
    const derived = new Set();
    for (const f of fs.readdirSync(path.join(ROOT, 'routes')).filter(f => f.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(ROOT, 'routes', f), 'utf8');
        for (const m of src.matchAll(/^(?:async\s+)?function\s+(batch[A-Z]\w*|generateStoryboard(?:Stream)?|executeShots)\s*\(/gm)) derived.add(`backend/routes/${f}#${m[1]}`);
    }
    assert.ok(derived.size >= 12, `only ${derived.size} batch functions found — the scan is broken`);
    const registered = new Set(hold.BATCH_ENTRY_POINTS.map(e => `${e.file}#${e.fn}`));
    const exempt = new Map(hold.BATCH_EXEMPT.map(e => [`${e.file}#${e.fn}`, e.why]));
    const uncovered = [...derived].filter(k => !registered.has(k) && !exempt.has(k));
    assert.deepEqual(uncovered, [], 'batch functions that neither honour the hold nor say why not');
    for (const [k, why] of exempt) assert.ok(why && why.length > 20, `${k} is exempt with no reason`);
    // The epic's named entry points, plus the three runners and the page.
    for (const need of ['generateStoryboard', 'generateStoryboardStream', 'batchVideo', 'batchVideoStream', 'batchMusic',
        'batchMusicStream', 'batchVoice', 'batchVoiceStream', 'executeShots', 'buildRunPlan', 'planRunChanged', 'planRunToHere', 'pgRunPending']) {
        assert.ok(hold.BATCH_ENTRY_POINTS.some(e => e.fn === need), `${need} is not registered`);
    }
});

test('every registered entry point reads the hold and reports what it held back', () => {
    const bad = [];
    for (const e of hold.BATCH_ENTRY_POINTS) {
        const body = fnIn(read(e.file), e.fn);
        if (!body) { bad.push(`${e.fn}: not found in ${e.file}`); continue; }
        // Through one of graph-hold's readers, or the `held` a graph node carries.
        if (!/\b(?:splitShots|cueHeldFor|heldCues|heldIds)\(|\.held\b|held_at/.test(body)) bad.push(`${e.fn}: never reads the hold`);
        if (!/held/.test(body.replace(/\/\/.*$/gm, ''))) bad.push(`${e.fn}: reports nothing held`);
        if (/Stream$/.test(e.fn) && !/type:\s*'held'/.test(body)) bad.push(`${e.fn}: a stream that never sends a 'held' event`);
    }
    assert.deepEqual(bad, []);
});

test('conform and export never read the hold: a held shot stays in the film', () => {
    for (const f of hold.NEVER_READS) {
        const src = read(f);
        assert.doesNotMatch(src, /held_at|graph-hold|\.held\b/, `${f} reads the hold`);
    }
    assert.ok(hold.NEVER_READS.some(f => /conform/.test(f)) && hold.NEVER_READS.some(f => /nle-export/.test(f)));
});

// ---- behaviour ------------------------------------------------------------------------
const P = generateId(), SC = generateId(), A = generateId(), B = generateId(), CUE = generateId(), AMB = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Hold batches')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number, location) VALUES (?, ?, 1, 'DINER')").run(SC, P);
const card = JSON.stringify({ description: 'She waits.', dialogue: [{ character: 'MAYA', text: 'Hello.' }] });
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, '1A', ?)").run(A, SC, card);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml, held_at) VALUES (?, ?, '1B', ?, datetime('now'))").run(B, SC, card);
db.prepare("INSERT INTO film_music_cues (id, project_id, scene_id, cue_type, held_at) VALUES (?, ?, ?, 'score', datetime('now'))").run(CUE, P, SC);
db.prepare("INSERT INTO film_music_cues (id, project_id, scene_id, cue_type) VALUES (?, ?, ?, 'ambient')").run(AMB, P, SC);

test('splitShots keeps the unheld and names the held with the reason', () => {
    const rows = [{ shot_id: A, shot_code: '1A' }, { shot_id: B, shot_code: '1B' }];
    const out = hold.splitShots(db, rows);
    assert.deepEqual(out.run.map(r => r.shot_code), ['1A']);
    assert.equal(out.held.length, 1);
    assert.equal(out.held[0].id, B); assert.equal(out.held[0].label, '1B');
    assert.match(out.held[0].reason, /held/i); assert.match(out.held[0].reason, /stays in the film/i);
    assert.deepEqual(hold.splitShots(db, []).held, []);
});

test('a scene step acts on the cue music-gen would choose; held only when THAT cue is held', () => {
    assert.equal((hold.cueHeldFor(db, SC, 'music') || {}).id, CUE, 'the held score is not seen');
    assert.equal(hold.cueHeldFor(db, SC, 'ambient'), null, 'an unheld ambient cue read as held');
    assert.equal(hold.cueHeldFor(db, SC, 'keyframe'), null, 'a shot step read a cue');
});

test('the run plan leaves a held shot out of the work AND the total, and lists it as held with its would-be cost', () => {
    const { buildRunPlan } = require('../lib/run-plan');
    const plan = buildRunPlan(P, {});
    const codes = new Set(plan.strips.flatMap(s => s.items.map(i => i.shot_code || i.shotCode)));
    assert.ok(codes.has('1A')); assert.ok(!codes.has('1B'), 'a held shot was planned');
    assert.ok(Array.isArray(plan.held) && plan.held.some(h => h.id === B), 'the held shot is not listed');
    const h = plan.held.find(x => x.id === B);
    assert.ok(h.projected_cost > 0 && Array.isArray(h.steps) && h.steps.length, 'the held list does not say what it would have cost');
    db.prepare('UPDATE film_shots SET held_at = NULL WHERE id = ?').run(B);
    const all = buildRunPlan(P, {});
    db.prepare("UPDATE film_shots SET held_at = datetime('now') WHERE id = ?").run(B);
    assert.ok(all.projected_cost > plan.projected_cost, 'the held shot is still inside the projected total');
});

test('Run what changed lists held work apart from the rest, for shots and for a held cue\'s scene step', () => {
    const rc = require('../lib/run-changed');
    const ids = rc.heldIds(db, P);
    assert.ok(ids.has(B)); assert.ok(ids.has(`${SC}:music`), 'a held score cue does not hold its scene step');
    assert.ok(!ids.has(`${SC}:ambient`));
    const plan = rc.buildRunChangedPlan({
        report: { shots: [{ shot_id: B, shot_code: '1B', stages: [{ stage: 'keyframe', state: 'redo' }] },
            { shot_id: A, shot_code: '1A', stages: [{ stage: 'keyframe', state: 'redo' }] }] },
        scenes: { [SC]: { music: 'redo', ambient: 'redo' } },
        held: ids,
    });
    assert.deepEqual(plan.items.map(i => `${i.stage}@${i.shot_code || i.scene_id}`).sort(), [`ambient@${SC}`, 'keyframe@1A']);
    assert.deepEqual(plan.held.map(h => `${h.stage}@${h.shot_code || h.scene_id}`).sort(), ['keyframe@1B', `music@${SC}`]);
    assert.ok(plan.held.every(h => /held/.test(h.reason)));
});

test('Run to here leaves held nodes out of the steps and the total and names them; a held shot with no frame blocks', () => {
    const { planRunToHere } = require('../lib/run-to-here');
    const shot = (id, code, extra) => ({ key: 'shot:' + id, type: 'shot', id, shot_code: code, frames: [], videos: [], ...extra });
    const seq = { key: 'seq:q', type: 'sequence', id: 'q', name: 'Walk', shot_ids: ['a', 'b'], videos: [], joins: [], links: {} };
    // Held shot WITH a frame: its frame is used as it is; nothing of it runs.
    let graph = { nodes: [shot('a', '1A'), shot('b', '1B', { held: true, frames: [{ version: 1, selected: true }] }), seq] };
    let plan = planRunToHere(graph, 'seq:q');
    assert.ok(!plan.items.some(i => i.key === 'shot:b'), 'a held shot was planned');
    assert.ok((plan.held || []).some(h => h.key === 'shot:b'));
    // Held shot WITHOUT a frame: the sequence cannot be made, and says so.
    graph = { nodes: [shot('a', '1A'), shot('b', '1B', { held: true }), seq] };
    plan = planRunToHere(graph, 'seq:q');
    assert.match((plan.blockers[0] || {}).reason || '', /held/i);
    // A held sound: nothing to run, listed as held.
    graph = { nodes: [{ key: 'sound:c', type: 'sound', id: 'c', cue_type: 'score', held: true, selected_asset_id: null }] };
    plan = planRunToHere(graph, 'sound:c');
    assert.equal(plan.items.length, 0); assert.equal(plan.total_cost, 0);
    assert.ok(plan.held.some(h => h.key === 'sound:c'));
});

/** Through each module's own route handler, the way a request arrives. */
async function route(file, handler, parts, body = {}) {
    let status = 0, out = null;
    const res = { setHeader() {}, writeHead(s) { status = s; }, end(b) { out = b ? JSON.parse(b) : null; }, on() {}, write() {} };
    await require(`../routes/${file}`)[handler]({ method: 'POST', body }, res, parts, {});
    return { status, out };
}

// The batches that answer with a list of the work, not a stream.
const LISTING = [
    { file: 'video-gen', handler: 'handleVideoGen', seg: 'video', list: 'shots', held: () => B },
    { file: 'voice', handler: 'handleVoice', seg: 'voice', list: 'shots', held: () => B, body: { plan_only: true } },
    { file: 'post-production', handler: 'handlePostProduction', seg: 'post', list: 'shots', held: () => B },
    { file: 'lipsync', handler: 'handleLipsync', seg: 'lipsync', list: 'shots', held: () => B },
    { file: 'music-gen', handler: 'handleMusicGen', seg: 'music', list: 'scenes', held: () => CUE },
];

test('the listing batches name held shots and cues and leave them out of the work', async () => {
    for (const t of LISTING) {
        const r = await route(t.file, t.handler, ['film', 'projects', P, t.seg, 'batch'], t.body || {});
        assert.equal(r.status, 200, `${t.file}: ${JSON.stringify(r.out)}`);
        assert.ok(!JSON.stringify(r.out[t.list] || []).includes(t.held()), `${t.file}: a held item is in the work`);
        assert.ok((r.out.held || []).some(h => h.id === t.held()), `${t.file}: the held item is not reported`);
    }
});

test('the storyboard batch with every shot held generates nothing and says why, instead of "no shots found"', async () => {
    db.prepare("UPDATE film_shots SET held_at = datetime('now') WHERE id = ?").run(A);
    const r = await route('storyboard', 'handleStoryboard', ['film', 'projects', P, 'storyboard', 'generate']);
    db.prepare('UPDATE film_shots SET held_at = NULL WHERE id = ?').run(A);
    assert.equal(r.status, 200, JSON.stringify(r.out));
    assert.equal(r.out.shots_completed, 0);
    assert.equal((r.out.held || []).length, 2);
});

test('the page\'s Run pending skips held nodes and says how many', () => {
    const src = fnIn(fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8'), 'pgRunPending');
    assert.match(src, /pending_held|\.held\b/);
    assert.match(src, /held/i);
    const pg = require('../lib/production-graph');
    const graph = pg.buildGraph(db, P);
    const pending = pg.pendingWork(graph);
    assert.ok(!pending.some(p => p.key === 'shot:' + B), 'pendingWork offers a held shot');
    assert.ok(!pending.some(p => p.key === 'sound:' + CUE), 'pendingWork offers a held cue');
    const heldList = pg.pendingHeld(graph);
    assert.ok(heldList.some(p => p.key === 'sound:' + CUE));
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
