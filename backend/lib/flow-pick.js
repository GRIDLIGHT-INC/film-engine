/**
 * A paused pick becomes pick-a-version (FOG-005, GRD-4586).
 *
 * A flow that fans out and meets a `tf.select` gate PAUSES so a person can
 * choose, and the gate kept every variation it waited on as a candidate on
 * the shot. Picking one:
 *
 *   1. is refused unless the run is still paused — a finished or cancelled run
 *      has no gate waiting, and "resuming" it would run its tail a second time;
 *   2. makes the chosen variation the shot's version of its kind — a picture
 *      becomes a new frame version on the board (archived first, exactly as an
 *      angle pick does), a clip becomes the shot's selected clip, a sound takes
 *      the type it was made as — so the choice is the one playback, the board
 *      and the conform already read;
 *   3. RESUMES the run from the gate: only the nodes downstream of it run, fed
 *      the chosen variation, and nothing upstream is generated again.
 *
 * The other variations stay as candidates: changing your mind is another
 * pick, not another purchase.
 */

const { FLOW_OUTPUT_KINDS } = require('./flow-outputs');

let contextFor = null;
/** Test hook: how a resumed run's context is built (the route builds it from the run's shot). */
function _setContextFor(fn) { contextFor = fn; }

const parseJson = (t, f) => { try { return t ? JSON.parse(t) : f; } catch (_) { return f; } };
const out = (status, body) => ({ status, body });

/** A Buffer that went through JSON comes back as {type:'Buffer', data:[…]}; give it back its bytes. */
function revive(v) {
    if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
    if (Array.isArray(v)) return v.map(revive);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = revive(v[k]); return o; }
    return v;
}

/**
 * Make a flow candidate the shot's version of its kind. Free: no generation.
 * @returns {{ok:true, kind:string, version?:number, asset_id:string}|{ok:false, status:number, error:string, code?:string}}
 */
function promoteCandidate(db, assetId, opts) {
    const o = opts || {};
    const row = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(assetId);
    const m = parseJson(row && row.metadata, {}) || {};
    if (!row || m.kind !== 'flow_output') return { ok: false, status: 404, error: 'That is not a flow variation.' };
    const kind = FLOW_OUTPUT_KINDS[m.output_kind] || {};
    if (!kind.version) return { ok: false, status: 400, error: `A ${m.output_kind || 'flow'} output has no version to pick: ${kind.why || ''}`.trim() };
    if (!row.shot_id) return { ok: false, status: 400, error: 'This variation belongs to no shot, so there is no version to make it.' };
    const fs = require('fs');
    if (!row.file_path || !fs.existsSync(row.file_path)) return { ok: false, status: 410, error: 'That variation is no longer on disk.' };
    const flowFrom = { run_id: m.run_id || null, flow_id: m.flow_id || null, apply_id: m.apply_id || null, branch: m.branch || null, asset_id: row.id };

    if (kind.version === 'frame') {
        const shot = db.prepare(`SELECT sh.id, sh.shot_code, s.project_id FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id WHERE sh.id = ?`).get(row.shot_id);
        if (!shot) return { ok: false, status: 404, error: 'The shot this variation was made for is gone.' };
        const project = db.prepare('SELECT board_locked_at FROM film_projects WHERE id = ?').get(shot.project_id) || {};
        if (project.board_locked_at && !o.ignoreLock) {
            return { ok: false, status: 423, code: 'BOARD_LOCKED',
                error: 'The board is locked, so a picked variation cannot replace its frame. Unlock the board, or pick with ignore_lock for this one frame.' };
        }
        const sb = require('../routes/storyboard');
        sb.ensureStoryboardDir(shot.project_id);
        const img = sb.storyboardImagePath(shot.project_id, shot.shot_code);
        sb.archiveExistingFrame(shot.project_id, shot.id, shot.shot_code);
        fs.copyFileSync(row.file_path, img);
        const asset = sb.registerStoryboardAsset(shot.project_id, shot.id, img, `${shot.shot_code}.png`, {
            provider: row.provider || null, provider_model: row.provider_model || null, flow_from: flowFrom,
            // Made by a flow from its own inputs, not from the card as it
            // stands — the keyframe fingerprint would call it current when it is not.
            skip_fingerprint: true,
        });
        db.prepare("UPDATE film_assets SET metadata = json_set(metadata, '$.picked_version', ?) WHERE id = ?").run(asset.version, row.id);
        return { ok: true, kind: 'frame', version: asset.version, asset_id: asset.id || null };
    }

    // A clip or a sound IS the version: it takes the type it was made as.
    db.prepare("UPDATE film_assets SET asset_type = ?, metadata = json_set(metadata, '$.picked', 1) WHERE id = ?")
        .run(m.as_type || kind.as_type, row.id);
    if (kind.version === 'clip') db.prepare('UPDATE film_shots SET selected_video_asset_id = ? WHERE id = ?').run(row.id, row.shot_id);
    return { ok: true, kind: kind.version, asset_id: row.id };
}

/** Every node downstream of `from`, in the graph's own execution order. */
function downstreamOf(graph, from) {
    const seen = new Set();
    const stack = [from];
    while (stack.length) {
        const id = stack.pop();
        for (const e of graph.edges || []) if (e.from === id && !seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
    }
    const { topoSort } = require('./flow-graph');
    const order = topoSort(graph);
    const ids = Array.isArray(order) ? order : (order && order.order) || [];
    return ids.map(x => (typeof x === 'string' ? x : x.id)).filter(id => seen.has(id));
}

/**
 * Pick a branch of a paused run: promote it, then resume the run from the gate.
 * @returns {Promise<{status:number, body:object}>}
 */
async function pickBranch(db, runId, branchKey, opts) {
    const run = db.prepare('SELECT * FROM film_flow_runs WHERE id = ?').get(runId);
    if (!run) return out(404, { error: 'Run not found' });
    if (run.status !== 'paused') {
        return out(409, { code: 'NOT_PAUSED', status: run.status,
            error: `This run is ${run.status}, not paused: no gate is waiting for a pick. Its variations stay on the shot as candidates.` });
    }
    const branch = db.prepare('SELECT * FROM film_flow_branches WHERE run_id = ? AND branch_key = ?').get(runId, branchKey);
    if (!branch) return out(404, { error: 'Branch not found for this run' });

    const graph = parseJson(run.graph_snapshot, null);
    const gates = db.prepare("SELECT node_id FROM film_flow_node_runs WHERE run_id = ? AND node_type = 'tf.select' AND status = 'pending'").all(runId);
    const gateId = gates.length ? gates[0].node_id : null;
    if (!graph || !gateId) return out(409, { code: 'NOT_PAUSED', error: 'This run records no gate waiting for a pick.' });

    // The chosen variation: its candidate on the shot, else what the gate recorded.
    const candidate = db.prepare(`SELECT id, file_path, metadata FROM film_assets WHERE json_valid(metadata)
        AND json_extract(metadata, '$.kind') = 'flow_output' AND json_extract(metadata, '$.run_id') = ?
        AND json_extract(metadata, '$.branch') = ? AND json_extract(metadata, '$.awaiting_pick') = ?`).get(runId, branchKey, gateId);
    let promoted = null;
    if (candidate) {
        promoted = promoteCandidate(db, candidate.id, { ignoreLock: opts && opts.ignoreLock });
        if (!promoted.ok) return out(promoted.status || 400, { error: promoted.error, code: promoted.code });
    }
    const nodeRun = db.prepare(`SELECT nr.outputs FROM film_flow_node_runs nr JOIN film_flow_branches b ON b.id = nr.branch_id
        WHERE nr.run_id = ? AND nr.node_id = ? AND b.branch_key = ?`).get(runId, gateId, branchKey);
    const recorded = revive(parseJson(nodeRun && nodeRun.outputs, {}) || {});
    const port = recorded.any || null;
    const value = candidate
        ? { asset_id: candidate.id, path: candidate.file_path, file_path: candidate.file_path }
        : (port ? port.value : null);
    const type = (port && port.type) || (candidate && (parseJson(candidate.metadata, {}) || {}).output_kind) || 'any';

    db.prepare('UPDATE film_flow_branches SET selected = 0 WHERE run_id = ?').run(runId);
    db.prepare('UPDATE film_flow_branches SET selected = 1 WHERE id = ?').run(branch.id);

    // ── resume from the gate ──
    const ex = require('./flow-executor');
    const { PORT } = require('./node-handlers/port');
    const branches = db.prepare('SELECT branch_key FROM film_flow_branches WHERE run_id = ?').all(runId).map(b => b.branch_key);
    for (const k of branches) ex.finishNodeRun(runId, gateId, { key: k }, k === branchKey ? 'complete' : 'skipped', k === branchKey ? recorded : {}, {});
    ex.setRunStatus(runId, 'running', '');

    // What every node before the gate already produced, unbranched — read, not regenerated.
    const flat = {};
    for (const r of db.prepare("SELECT node_id, outputs FROM film_flow_node_runs WHERE run_id = ? AND status = 'complete' AND branch_id IS NULL").all(runId)) {
        flat[r.node_id] = revive(parseJson(r.outputs, {}) || {});
    }
    flat[gateId] = { any: PORT(type, value) };

    let ctx;
    try {
        if (contextFor) ctx = contextFor(run);
        else {
            const resolved = require('../routes/flows').runContext({ shot_id: run.shot_id, project_id: run.project_id, vars: (parseJson(run.params, {}) || {}).vars || {} });
            if (resolved.error) throw new Error(resolved.error);
            ctx = resolved.ctx;
        }
    } catch (err) {
        ex.setRunStatus(runId, 'failed', `could not resume: ${err.message}`);
        return out(500, { run_id: runId, selected: branchKey, picked: promoted, status: 'failed', error: `The pick was made, but the run could not resume: ${err.message}` });
    }

    const failed = [];
    for (const id of downstreamOf(graph, gateId)) {
        const node = graph.nodes.find(n => n.id === id);
        ex.startNodeRun(runId, node, { key: '' });
        const inputs = ex.resolveNodeInputs(graph, id, flat);
        let result;
        try { result = await ex.executeNode(node, inputs, { ...ctx, runId, branch: '' }); }
        catch (err) { result = { ok: false, error: err.message }; }
        if (!result.ok) { failed.push({ node: id, error: result.error }); ex.finishNodeRun(runId, id, { key: '' }, 'failed', {}, result); continue; }
        flat[id] = result.outputs || {};
        ex.finishNodeRun(runId, id, { key: '' }, result.skipped ? 'skipped' : 'complete', result.outputs, result);
    }
    const status = failed.length ? 'failed' : 'complete';
    ex.setRunStatus(runId, status, failed.length ? `${failed.length} node(s) failed after the pick` : '');
    return out(200, { run_id: runId, selected: branchKey, status, picked: promoted, failed });
}

module.exports = { pickBranch, promoteCandidate, downstreamOf, _setContextFor };
