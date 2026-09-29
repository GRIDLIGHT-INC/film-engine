/**
 * PGN-021 — MCP tools for every new action of the production graph.
 *
 * The connected agent IS the model here, so an action with no tool is one only
 * a person at the page can take. The denominator is DERIVED: every dispatch in
 * routes/production-graph.js (read off `req.method` lines), plus the job cancel
 * and the recipe this epic added elsewhere. Each maps to a tool, or is exempted
 * by name with why. Every tool dispatches THROUGH its route — none reimplements
 * one — and each is run for real here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-gmt-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();
const { db, generateId } = require('../db/database');
const mcp = require('../lib/mcp-tools');

const ROUTE_FILE = path.join(__dirname, '..', 'routes', 'production-graph.js');

/** Every dispatch in the file, as "<literal path words> <METHOD>". */
function derivedDispatches() {
    const src = fs.readFileSync(ROUTE_FILE, 'utf8');
    const body = src.slice(src.indexOf('function handleProductionGraph'));
    const out = new Set();
    let block = '';
    for (const line of body.split('\n')) {
        const top = line.match(/^\s{4}if \(parts\[1\] === '([a-z-]+)'.*?parts\[3\] === '([a-z-]+)'(?:.*?parts\[4\] === '([a-z-]+)')?/);
        if (top) block = [top[1], top[2], top[3]].filter(Boolean).join(' ');
        if (!/req\.method/.test(line)) continue;
        const methods = [...line.matchAll(/req\.method === '(\w+)'/g)].map(m => m[1]);
        const words = [...line.matchAll(/parts\[[4-7]\] === '([a-z-]+)'/g)].map(m => m[1]);
        const param = /parts\[5\] && parts\[5\] !== 'plan'/.test(line) ? [':id'] : [];
        for (const m of methods) out.add([block, ...(block.includes('production-graph') ? words : []), ...param, m].join(' ').trim());
    }
    return out;
}

/** Every derived dispatch → its tool, or an exemption with why. */
const COVERAGE = {
    'projects production-graph GET': 'production_graph_get',
    'projects production-graph running GET': 'production_graph_running',
    'projects production-graph queue GET': 'generation_queue',
    'projects production-graph run-changed plan GET': 'run_changed_plan',
    'projects production-graph run-changed POST': 'run_changed',
    'projects production-graph run-changed :id GET': 'run_changed_status',
    'projects production-graph nodes run-to-here plan GET': 'run_to_here_plan',
    'projects production-graph nodes run-to-here POST': 'run_to_here',
    'projects production-graph runs cancel POST': 'run_cancel',
    'projects production-graph patterns GET': 'pattern_list',
    'projects production-graph patterns preview GET': 'pattern_preview',
    'projects production-graph patterns POST': 'pattern_create',
    'shots video select POST': 'version_select',
    'shots video select DELETE': 'version_select',
    'music-cues select POST': 'version_select',
    'music-cues select DELETE': 'version_select',
};
const EXEMPT = {
    'projects production-graph match GET': 'the page hashes a file dropped from the desktop; an agent that knows the version reads its recipe with asset_provenance',
    'projects production-graph groups PUT': 'how the director’s canvas is drawn (a group collapsed); the agent reads the graph’s data, not its layout',
    'projects production-graph layout PUT': 'where the director dragged a node; the agent reads the graph’s data, not its layout',
    'projects production-graph tidy POST': 'rearranges the director’s canvas; the agent reads the graph’s data, not its layout',
};
// The two routes this epic added outside the graph module.
const ELSEWHERE = { 'generation-jobs cancel POST': 'generation_cancel', 'assets provenance GET': 'asset_provenance' };

test('every production-graph dispatch has a tool or a named exemption, and nothing is listed that is not dispatched', () => {
    const derived = derivedDispatches();
    assert.ok(derived.size >= 18, `only ${derived.size} dispatches found — the scan is broken: ${[...derived].join(' | ')}`);
    const covered = new Set([...Object.keys(COVERAGE), ...Object.keys(EXEMPT)]);
    assert.deepEqual([...derived].filter(d => !covered.has(d)), [], 'dispatches with neither a tool nor a reason');
    assert.deepEqual([...covered].filter(d => !derived.has(d)), [], 'the registry names a dispatch the route does not have');
    for (const [k, why] of Object.entries(EXEMPT)) assert.ok(why.length > 30, `${k}: no reason`);
});

test('every expected tool exists; the route tools dispatch through their route handler, never beside it', () => {
    const names = new Set(mcp.listTools().map(t => t.name));
    const want = [...new Set([...Object.values(COVERAGE), ...Object.values(ELSEWHERE), 'graph_hold'])];
    assert.deepEqual(want.filter(n => !names.has(n)), [], 'tools missing');
    const { handleProductionGraph } = require('../routes/production-graph');
    const { handleGenerationJobs } = require('../routes/generation-jobs');
    const { handleAssets } = require('../routes/assets');
    const byName = new Map(mcp.PRODUCTION_TOOLS.map(t => [t.name, t]));
    for (const n of Object.values(COVERAGE).filter(n => n !== 'version_select')) {
        assert.equal((byName.get(n) || {}).handler, handleProductionGraph, `${n} does not go through the graph route`);
    }
    assert.equal(byName.get('generation_cancel').handler, handleGenerationJobs);
    assert.equal(byName.get('asset_provenance').handler, handleAssets);
    for (const n of ['graph_hold', 'version_select']) {
        const t = mcp.BATCH_TOOLS.find(x => x.name === n);
        assert.ok(t && typeof t.run === 'function', `${n} is not a runnable tool`);
        assert.match(String(t.run), /callRoute\(/, `${n} does not dispatch through a route`);
    }
});

test('a tool that spends says so; every other one says it is free', () => {
    const all = new Map(mcp.listTools().map(t => [t.name, t]));
    for (const n of ['run_changed', 'run_to_here']) assert.match(all.get(n).description, /costs|spends/i, `${n} hides that it spends`);
    for (const n of ['production_graph_get', 'production_graph_running', 'generation_queue', 'run_changed_plan', 'run_changed_status',
        'run_to_here_plan', 'run_cancel', 'generation_cancel', 'asset_provenance', 'pattern_list', 'pattern_preview', 'pattern_create',
        'graph_hold', 'version_select']) {
        assert.match(all.get(n).description, /free|nothing is generated|spends nothing/i, `${n} does not say it is free`);
    }
});

// ---- run each for real ----------------------------------------------------------------
const P = generateId(), SC = generateId(), A = generateId(), SEQ = generateId(), CUE = generateId(), CLIP = generateId(), SOUND = generateId();
db.prepare("INSERT INTO film_projects (id, title) VALUES (?, 'Tools')").run(P);
db.prepare("INSERT INTO film_scenes (id, project_id, scene_number) VALUES (?, ?, 1)").run(SC, P);
db.prepare("INSERT INTO film_shots (id, scene_id, shot_code, sort_order, scene_card_yaml) VALUES (?, ?, '1A', 0, ?)").run(A, SC, JSON.stringify({ description: 'She waits.' }));
db.prepare("INSERT INTO film_sequences (id, project_id, name, shot_ids) VALUES (?, ?, 'Walk', ?)").run(SEQ, P, JSON.stringify([A]));
db.prepare("INSERT INTO film_music_cues (id, project_id, scene_id, cue_type) VALUES (?, ?, ?, 'score')").run(CUE, P, SC);
db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_name, file_path, version, provider)
    VALUES (?, ?, ?, 'video_raw', '1A.mp4', '/tmp/x-1A.mp4', 1, 'runway')`).run(CLIP, P, A);
db.prepare(`INSERT INTO film_assets (id, project_id, scene_id, asset_type, file_name, file_path, version, metadata)
    VALUES (?, ?, ?, 'audio_music', 's.mp3', '/tmp/x-s.mp3', 1, ?)`).run(SOUND, P, SC, JSON.stringify({ cue_id: CUE }));

const run = async (name, args) => mcp.presentResult(await mcp.callTool(name, args));

test('the reads answer for this project', async () => {
    const g = await run('production_graph_get', { project_id: P });
    assert.ok(g.nodes.some(n => n.key === 'shot:' + A));
    assert.ok(Array.isArray((await run('production_graph_running', { project_id: P })).running));
    const q = await run('generation_queue', { project_id: P });
    assert.ok(Array.isArray(q.running) && Array.isArray(q.failed));
    const plan = await run('run_changed_plan', { project_id: P });
    assert.ok('total_cost' in plan && Array.isArray(plan.items));
    const here = await run('run_to_here_plan', { project_id: P, node_key: 'shot:' + A });
    assert.ok(Array.isArray(here.items) && 'total_cost' in here, JSON.stringify(here));
    const recipe = await run('asset_provenance', { asset_id: CLIP });
    assert.equal(recipe.recipe.provider, 'runway');
});

test('refusals come back from the route by name', async () => {
    assert.equal((await run('run_changed_status', { project_id: P, run_id: 'nope' })).status, 404);
    assert.equal((await run('run_to_here_plan', { project_id: P, node_key: 'shot:' + generateId() })).status, 400);
    assert.equal((await run('run_to_here', { project_id: P, node_key: 'shot:' + generateId() })).status, 400);
    assert.equal((await run('run_cancel', { project_id: P, run_id: 'nope' })).status, 404);
    assert.equal((await run('generation_cancel', { job_id: 'nope' })).status, 404);
    assert.equal((await run('pattern_preview', { project_id: P, pattern: 'nope', after_shot_id: A })).status, 404);
});

test('Run what changed with nothing behind runs nothing and says so', async () => {
    const r = await run('run_changed', { project_id: P });
    assert.equal(r.run_id, null);
    assert.match(r.message || '', /nothing/i);
});

test('graph_hold holds and releases every holdable node type through that node’s own route', async () => {
    const hold = require('../lib/graph-hold');
    const ids = { shot: A, sequence: SEQ, sound: CUE };
    for (const h of hold.HOLDABLE) {
        const key = `${h.key_prefix}:${ids[h.node]}`;
        let r = await run('graph_hold', { node_key: key, held: true });
        assert.ok(!r.status, `${key}: ${JSON.stringify(r)}`);
        assert.ok(db.prepare(`SELECT held_at FROM ${h.table} WHERE id = ?`).get(ids[h.node]).held_at, `${key} not held`);
        r = await run('graph_hold', { node_key: key, held: false });
        assert.equal(db.prepare(`SELECT held_at FROM ${h.table} WHERE id = ?`).get(ids[h.node]).held_at, null, `${key} not released`);
    }
    assert.ok((await run('graph_hold', { node_key: 'ver:' + CLIP, held: true })).error, 'a version was held');
    assert.ok((await run('graph_hold', { node_key: 'shot:' + A, held: 'yes' })).status === 400);
});

test('version_select chooses and clears which version plays, for a shot clip and a sound', async () => {
    let r = await run('version_select', { asset_id: CLIP });
    assert.ok(!r.status && !r.error, JSON.stringify(r));
    assert.equal(db.prepare('SELECT selected_video_asset_id AS v FROM film_shots WHERE id = ?').get(A).v, CLIP);
    await run('version_select', { asset_id: CLIP, clear: true });
    assert.equal(db.prepare('SELECT selected_video_asset_id AS v FROM film_shots WHERE id = ?').get(A).v, null);
    r = await run('version_select', { asset_id: SOUND });
    assert.ok(!r.status && !r.error, JSON.stringify(r));
    assert.equal(db.prepare('SELECT generated_asset_id AS v FROM film_music_cues WHERE id = ?').get(CUE).v, SOUND);
    assert.ok((await run('version_select', { asset_id: generateId() })).error, 'an unknown version was selected');
});

test('patterns: list, free preview, create', async () => {
    const list = await run('pattern_list', { project_id: P });
    assert.ok(list.patterns.some(p => p.id === 'shot_reverse'));
    const preview = await run('pattern_preview', { project_id: P, pattern: 'shot_reverse', after_shot_id: A });
    assert.deepEqual(preview.shots.map(s => s.code), ['1AA', '1AB']);
    const made = await run('pattern_create', { project_id: P, pattern: 'shot_reverse', after_shot_id: A });
    assert.equal(made.shot_ids.length, 2);
});

test.after(() => { try { fs.rmSync(process.env.FILM_DATA_DIR, { recursive: true, force: true }); } catch (_) {} });
