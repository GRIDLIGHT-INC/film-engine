/**
 * PGN-008 — "Run to here": the free plan.
 *
 * Point at a clip, a sequence or a sound and ask what it still needs: every
 * missing or out-of-date step it depends on, frames before clips, a frame
 * borrowed from another sequence traced back to what would make it, each step
 * priced from the run plan's table, and a total. Nothing is generated.
 *
 * Blockers are named rather than planned around: a card only a person can
 * rewrite, frames while the board is locked, a node type that makes nothing.
 * Set-based over the target node types the graph draws.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-rth-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const rth = require('../lib/run-to-here');
const { COST_PER_CALL } = require('../lib/flow-cost');

const imp = state => ({ state });
const shotN = (id, o = {}) => Object.assign({ key: 'shot:' + id, type: 'shot', id, shot_code: id.toUpperCase(),
    frames: [{ asset_id: 'f-' + id, selected: true }], videos: [], impact: imp('current') }, o);
const seqN = (id, shotIds, o = {}) => Object.assign({ key: 'seq:' + id, type: 'sequence', id, name: 'Seq ' + id,
    shot_ids: shotIds, joins: [], links: { start: null, end: null, stale: false }, videos: [], impact: imp('never') }, o);
const graph = nodes => ({ nodes });
const stages = plan => plan.items.map(i => `${i.stage}@${i.key}`);

test('every node type either can be a target or is refused with a reason', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'production-graph.js'), 'utf8');
    const types = [...new Set([...src.matchAll(/type: '([a-z]+)'/g)].map(m => m[1]))];
    assert.ok(types.length >= 6);
    for (const t of types) {
        assert.ok(rth.TARGETS[t] !== undefined, `no decision for node type ${t}`);
        if (rth.TARGETS[t] === false) {
            const p = rth.planRunToHere(graph([{ key: 'x:1', type: t }]), 'x:1');
            assert.ok(p.error && p.error.length > 10, `${t}: refused without a reason`);
        }
    }
    assert.ok(['shot', 'video', 'sequence', 'sound'].every(t => rth.TARGETS[t] === true));
});

test('a shot with no frame: the frame, then the clip, priced and totalled', () => {
    const p = rth.planRunToHere(graph([shotN('a', { frames: [], impact: imp('never') })]), 'shot:a');
    assert.deepEqual(stages(p), ['keyframe@shot:a', 'video@shot:a']);
    assert.equal(p.items[0].cost, COST_PER_CALL.image);
    assert.equal(p.items[1].cost, COST_PER_CALL.video);
    assert.equal(p.total_cost, Number((COST_PER_CALL.image + COST_PER_CALL.video).toFixed(6)));
});

test('a shot whose frame is current and has no clip: only the clip; one whose frame is behind: both', () => {
    assert.deepEqual(stages(rth.planRunToHere(graph([shotN('a')]), 'shot:a')), ['video@shot:a']);
    assert.deepEqual(stages(rth.planRunToHere(graph([shotN('a', { impact: imp('redo') })]), 'shot:a')), ['keyframe@shot:a', 'video@shot:a']);
});

test('a shot with a current clip on a current frame: nothing to do, said plainly', () => {
    const g = graph([shotN('a', { videos: [{ asset_id: 'v1', selected: true }] }), { key: 'ver:v1', type: 'video', parent: 'shot:a', asset_id: 'v1', impact: imp('current') }]);
    const p = rth.planRunToHere(g, 'shot:a');
    assert.deepEqual(p.items, []);
    assert.match(p.summary, /nothing/i);
});

test('a clip version as the target plans for its shot; a behind clip is redone', () => {
    const g = graph([shotN('a', { videos: [{ asset_id: 'v1', selected: true }] }), { key: 'ver:v1', type: 'video', parent: 'shot:a', asset_id: 'v1', impact: imp('redo') }]);
    assert.deepEqual(stages(rth.planRunToHere(g, 'ver:v1')), ['video@shot:a']);
});

test('a behind card blocks: only a person can rewrite it; a locked board blocks frames', () => {
    const card = rth.planRunToHere(graph([shotN('a', { impact: { state: 'redo', why: 'The screenplay was revised after this shot\'s card was written.' } })]), 'shot:a', {});
    assert.ok(card.blockers.some(b => /card/i.test(b.reason)), 'a behind card is not named as a blocker');
    assert.deepEqual(card.items, []);
    const locked = rth.planRunToHere(graph([shotN('a', { frames: [], impact: imp('never') })]), 'shot:a', { boardLocked: true });
    assert.ok(locked.blockers.some(b => /locked/i.test(b.reason)));
    assert.deepEqual(locked.items, [], 'a clip is not planned over a frame that cannot be made');
});

test('a sequence: every missing member frame first, then the sequence clip priced per generated leg', () => {
    const g = graph([shotN('a', { frames: [], impact: imp('never') }), shotN('b'), shotN('c', { frames: [], impact: imp('never') }),
        seqN('s', ['a', 'b', 'c'], { joins: [{ type: 'continuous' }, { type: 'cut' }] })]);
    const p = rth.planRunToHere(g, 'seq:s');
    assert.deepEqual(stages(p), ['keyframe@shot:a', 'keyframe@shot:c', 'sequence@seq:s']);
    const seq = p.items.find(i => i.stage === 'sequence');
    assert.equal(seq.legs, 1, 'a cut join generates nothing, so only one leg is priced');
    assert.equal(seq.cost, COST_PER_CALL.video * 1);
});

test('a borrowed frame is traced to what would make it: a source shot frame, or a source sequence clip', () => {
    const shotImage = graph([shotN('x', { frames: [], impact: imp('never') }), seqN('src', ['x']), shotN('a'),
        seqN('s', ['a'], { links: { start: { ref: { sequence_id: 'src', mode: 'shot_image', shot_id: 'x' }, ok: false, reason: 'X has no frame yet' }, end: null } })]);
    assert.deepEqual(stages(rth.planRunToHere(shotImage, 'seq:s')), ['keyframe@shot:x', 'sequence@seq:s']);

    const lastFrame = graph([shotN('y'), seqN('src', ['y']), shotN('a'),
        seqN('s', ['a'], { links: { start: { ref: { sequence_id: 'src', mode: 'video_last_frame' }, ok: false, reason: 'no video' }, end: null } })]);
    assert.deepEqual(stages(rth.planRunToHere(lastFrame, 'seq:s')), ['sequence@seq:src', 'sequence@seq:s']);
});

test('a cycle of borrowed frames is refused, not followed forever', () => {
    const g = graph([shotN('a'), shotN('b'),
        seqN('s1', ['a'], { links: { start: { ref: { sequence_id: 's2', mode: 'video_last_frame' }, ok: false }, end: null } }),
        seqN('s2', ['b'], { links: { start: { ref: { sequence_id: 's1', mode: 'video_last_frame' }, ok: false }, end: null } })]);
    const p = rth.planRunToHere(g, 'seq:s1');
    assert.ok(p.blockers.some(b => /cycle|each other/i.test(b.reason)));
});

test('a sound: its own generation, priced by what kind of cue it is', () => {
    for (const [cueType, cap] of Object.entries(require('../lib/production-graph').SOUND_KIND)) {
        const p = rth.planRunToHere(graph([{ key: 'sound:q', type: 'sound', id: 'q', cue_type: cueType, selected_asset_id: null, impact: imp('never') }]), 'sound:q');
        assert.equal(p.items.length, 1, cueType);
        assert.equal(p.items[0].cost, COST_PER_CALL[cap], `${cueType} priced as ${cap}`);
    }
    const current = rth.planRunToHere(graph([{ key: 'sound:q', type: 'sound', id: 'q', cue_type: 'score', selected_asset_id: 'm', impact: imp('current') }]), 'sound:q');
    assert.deepEqual(current.items, []);
});

test('an unknown node is refused, not planned as empty', () => {
    const p = rth.planRunToHere(graph([]), 'shot:nope');
    assert.match(p.error, /no such node|not on the graph/i);
});

// ---- the route, over a real project ----------------------------------------------

const P = generateId(), SC = generateId(), SH = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Run to here')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)").run(SC, P);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, scene_card_yaml) VALUES (?, ?, '1A', ?)").run(SH, SC, JSON.stringify({ description: 'A woman waits.' }));

test('GET …/production-graph/nodes/:key/run-to-here/plan returns the plan and spends nothing', async () => {
    const { handleProductionGraph } = require('../routes/production-graph');
    let status = 0, out = null;
    const res = { setHeader() {}, writeHead(s) { status = s; }, end(b) { out = JSON.parse(b); } };
    const before = db.prepare('SELECT COUNT(*) n FROM film_generation_jobs').get().n;
    await handleProductionGraph({ method: 'GET' }, res, ['film', 'projects', P, 'production-graph', 'nodes', 'shot:' + SH, 'run-to-here', 'plan'], {});
    assert.equal(status, 200);
    assert.deepEqual(out.items.map(i => i.stage), ['keyframe', 'video']);
    assert.ok(out.budget, 'the budget verdict is included');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM film_generation_jobs').get().n, before);
    await handleProductionGraph({ method: 'GET' }, res, ['film', 'projects', P, 'production-graph', 'nodes', 'link:' + SH + ':start', 'run-to-here', 'plan'], {});
    assert.equal(status, 400);
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
