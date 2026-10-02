/**
 * "Run to here" — the free plan (PGN-008).
 *
 * Point at a clip, a sequence or a sound and ask what it still needs. Read off
 * the Production graph as it is — frames, clips, borrowed-frame links and the
 * impact state PGN-004 attached — so the plan cannot disagree with what the
 * canvas shows. Frames come before the clip built on them; a frame borrowed
 * from another sequence is traced to what would make it (a source shot's
 * frame, or a source sequence's clip). Each step is priced from the run plan's
 * table; the plan spends nothing.
 *
 * What cannot be planned around is NAMED as a blocker rather than silently
 * dropped: a card only a person can rewrite, frames while the board is locked,
 * a cycle of borrowed frames.
 */

const { COST_PER_CALL, budgetStatus } = require('./flow-cost');

/** Which node types can be pointed at. `false` means refused, with why. */
const TARGETS = Object.freeze({ shot: true, video: true, sequence: true, sound: true, link: false, audio: false, inbetween: false });
const REFUSED = Object.freeze({
    link: 'A borrowed frame is not made; run to the sequence that uses it instead.',
    audio: 'A sound version is an output; run to its sound instead.',
    inbetween: 'In-betweens are made from their own node (Make the frames, then Make the clip); run to either of the two shots instead.',
});

const behind = n => !!(n && n.impact && (n.impact.state === 'redo' || n.impact.state === 'waiting'));

function planRunToHere(graph, key, opts) {
    const o = opts || {};
    const pg = require('./production-graph');
    const byKey = new Map(((graph && graph.nodes) || []).map(n => [n.key, n]));
    const root = byKey.get(key);
    if (!root) return { error: `${key} is not on the graph (no such node)` };
    if (TARGETS[root.type] !== true) return { error: REFUSED[root.type] || `A ${root.type} node cannot be run to.` };

    const items = [];
    const blockers = [];
    const seen = new Set();
    // Held nodes (PGN-017): left out of the steps and the total, listed apart.
    const { HELD_REASON } = require('./graph-hold');
    const heldOut = new Map();
    const noteHeld = n => { if (!heldOut.has(n.key)) heldOut.set(n.key, { key: n.key, kind: n.type, id: n.id,
        label: n.shot_code || n.name || n.title || n.type, reason: HELD_REASON }); };
    const add = it => { const id = `${it.stage}@${it.key}`; if (!seen.has(id)) { seen.add(id); items.push(it); } };
    const cardBehind = n => n.impact && (n.impact.cause === 'card' || n.impact.why === pg.IMPACT_WHY.card);

    /** Does this shot need its frame made? Pushes it (or a blocker). Returns false if blocked. */
    function needFrame(s) {
        if (s.held) {
            // A held shot's frame is used as it stands; with no frame at all,
            // nothing built on it can be made, and that is said.
            if (!s.frames || !s.frames.length) {
                blockers.push({ key: s.key, reason: `${s.shot_code} is held and has no frame yet — release it, or give it a frame, before anything built on it can be made.` });
                return false;
            }
            noteHeld(s);
            return true;
        }
        if (cardBehind(s)) { blockers.push({ key: s.key, reason: `${s.shot_code}: ${pg.IMPACT_WHY.card} A person must edit the card first.` }); return false; }
        const missing = !s.frames || !s.frames.length;
        if (!missing && !behind(s)) return true;
        if (o.boardLocked) { blockers.push({ key: s.key, reason: `${s.shot_code}: the board is locked, so its frame cannot be made.` }); return false; }
        add({ stage: 'keyframe', key: s.key, shot_id: s.id, shot_code: s.shot_code, capability: 'image',
            cost: COST_PER_CALL.image || 0, why: missing ? 'no frame yet' : 'its frame is behind' });
        return true;
    }

    function planShot(s, clipBehind) {
        if (s.held) { if (!s.frames || !s.frames.length) needFrame(s); else noteHeld(s); return; }
        const hadFrame = s.frames && s.frames.length && !behind(s);
        if (!needFrame(s)) return;
        const sel = (s.videos || []).find(v => v.selected) || (s.videos || [])[0];
        const selNode = sel ? byKey.get('ver:' + sel.asset_id) : null;
        const needClip = !hadFrame || !sel || clipBehind || behind(selNode);
        if (needClip) add({ stage: 'video', key: s.key, shot_id: s.id, shot_code: s.shot_code, capability: 'video',
            cost: COST_PER_CALL.video || 0, why: !sel ? 'no clip yet' : 'its clip is behind' });
    }

    function planSequence(q, visiting) {
        if (visiting.has(q.key)) { blockers.push({ key: q.key, reason: `${q.name}: borrowed frames form a cycle — these sequences borrow from each other.` }); return false; }
        visiting.add(q.key);
        if (q.held) { noteHeld(q); visiting.delete(q.key); return true; }
        const before = items.length;
        let ok = true;
        for (const id of q.shot_ids || []) { const s = byKey.get('shot:' + id); if (s && !needFrame(s)) ok = false; }
        for (const side of ['start', 'end']) {
            const l = q.links && q.links[side];
            if (!l || l.ok !== false) continue;
            const ref = l.ref || {};
            const src = byKey.get('seq:' + ref.sequence_id);
            if (!src) { blockers.push({ key: q.key, reason: `${q.name}: ${l.reason || 'the borrowed frame cannot be found'}` }); ok = false; continue; }
            if (ref.mode === 'video_last_frame') {
                if (!planSequence(src, visiting)) ok = false;
            } else {
                const ids = src.shot_ids || [];
                const shotId = ref.shot_id && ids.includes(ref.shot_id) ? ref.shot_id : (side === 'end' ? ids[0] : ids[ids.length - 1]);
                const s = shotId && byKey.get('shot:' + shotId);
                if (!s) { blockers.push({ key: q.key, reason: `${q.name}: ${l.reason || 'no shot to borrow a frame from'}` }); ok = false; continue; }
                if (!needFrame(s)) ok = false;
            }
        }
        visiting.delete(q.key);
        if (!ok) return false;
        const joins = q.joins || [];
        const pairs = Math.max(0, (q.shot_ids || []).length - 1);
        const legs = Math.max(1, Array.from({ length: pairs }, (_, i) => (joins[i] || {}).type).filter(t => t !== 'cut').length);
        const needClip = !(q.videos || []).length || behind(q) || items.length > before;
        if (needClip) add({ stage: 'sequence', key: q.key, sequence_id: q.id, name: q.name, capability: 'video', legs,
            cost: Number(((COST_PER_CALL.video || 0) * legs).toFixed(6)), why: !(q.videos || []).length ? 'no clip yet' : 'what it is built from changed' });
        return true;
    }

    if (root.type === 'shot') planShot(root, false);
    else if (root.type === 'video') {
        const parent = byKey.get(root.parent);
        if (parent && parent.type === 'shot') planShot(parent, behind(root));
        else if (parent && parent.type === 'sequence') planSequence(parent, new Set());
        else return { error: 'This clip belongs to nothing on the graph.' };
    } else if (root.type === 'sequence') planSequence(root, new Set());
    else if (root.type === 'sound') {
        const cap = pg.SOUND_KIND[root.cue_type] || 'music';
        if (root.held) noteHeld(root);
        else if (!root.selected_asset_id || behind(root)) {
            add({ stage: cap, key: root.key, cue_id: root.id, capability: cap, cost: COST_PER_CALL[cap] || 0,
                why: !root.selected_asset_id ? 'no sound yet' : 'what it was made from changed' });
        }
    }

    // A blocker upstream means the steps planned after it would build on nothing.
    const planned = blockers.length ? [] : items;
    const total = Number(planned.reduce((n, i) => n + i.cost, 0).toFixed(6));
    return {
        target: key, items: planned, blockers, total_cost: total, held: [...heldOut.values()],
        summary: blockers.length ? `Blocked: ${blockers[0].reason}`
            : planned.length ? `${planned.length} step${planned.length === 1 ? '' : 's'}, about $${total.toFixed(2)}`
            : 'Nothing to do: everything this needs is already made and current.',
    };
}

/** For a real project: the graph as it stands, the board lock and the budget. */
function planForNode(projectId, key) {
    const { db } = require('../db/database');
    const pg = require('./production-graph');
    const graph = pg.buildGraph(db, projectId);
    if (!graph) return null;
    const plan = planRunToHere(graph, key, { boardLocked: !!graph.board_locked });
    if (plan.error) return plan;
    const budget = budgetStatus(db, projectId, plan.total_cost);
    return { project_id: projectId, ...plan, budget, refused: !!budget.wouldExceed };
}

/**
 * RUN TO HERE (PGN-009): each planned step through its EXISTING generate path.
 * A frame or a shot's clip goes through the pipeline's executeStep (stale-input
 * gate, persistence, fingerprint); a sequence through its own generate route;
 * a sound through its cue's generate route — the routes the page and the MCP
 * tools already use, reached in-process through the MCP layer's shim.
 */
function defaultDeps() {
    return {
        executeStep: (...a) => require('../routes/pipeline').executeStep(...a),
        callRoute: (...a) => require('./mcp-tools').callRoute(...a),
        loadShot: id => {
            const { db } = require('../db/database');
            const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(id);
            const scene = shot && db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
            const project = scene && db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id);
            return shot && scene && project ? { shot, scene, project } : null;
        },
    };
}

const routeResult = (r, what) => {
    const status = (r && r._status) || 500;
    const body = (r && r.body) || {};
    if (status < 300 && body.ok !== false) return { ok: true, status, body };
    return { ok: false, code: body.code || null, error: body.error || `${what} answered ${status}` };
};

async function executeRunToHereItem(item, deps) {
    const d = Object.assign(defaultDeps(), deps || {});
    const { SOUND_KIND } = require('./production-graph');
    if (item.stage === 'keyframe' || item.stage === 'video') {
        const rows = d.loadShot(item.shot_id);
        if (!rows) return { ok: false, error: `${item.stage}: the shot no longer exists` };
        return d.executeStep(item.stage, rows.shot, rows.scene, rows.project);
    }
    if (item.stage === 'sequence') {
        const r = await d.callRoute('POST', `/film/sequences/${item.sequence_id}/generate`, {},
            (...a) => require('../routes/sequences').handleSequences(...a));
        return routeResult(r, 'the sequence');
    }
    if (Object.values(SOUND_KIND).includes(item.stage)) {
        const r = await d.callRoute('POST', `/film/music-cues/${item.cue_id}/generate`, {},
            (...a) => require('../routes/music-gen').handleMusicGen(...a));
        return routeResult(r, 'the cue');
    }
    return { ok: false, error: `${item.stage} is not a step "Run to here" can make` };
}

/** Run a node's plan: re-planned after each step, stopping at the first refusal (the PGN-007 runner). */
function runToHere(projectId, key, opts, deps) {
    const d = deps || {};
    const rc = require('./run-changed');
    return rc.runChanged(projectId, Object.assign({}, opts, { kind: 'run_to_here', target: key }), {
        plan: d.plan || (() => planForNode(projectId, key)),
        execute: d.execute || (item => executeRunToHereItem(item)),
    });
}

let last = null;
function startRunToHere(projectId, key, opts, deps) {
    const rc = require('./run-changed');
    const d = deps || {};
    if (!rc.projectExists(projectId)) return { status: 404, body: { error: 'Project not found' } };
    const plan = d.plan ? d.plan() : planForNode(projectId, key);
    if (!plan) return { status: 404, body: { error: 'Project not found' } };
    if (plan.error) return { status: 400, body: plan };
    if ((plan.blockers || []).length) {
        return { status: 409, body: { error: plan.blockers[0].reason, blockers: plan.blockers, plan } };
    }
    if (plan.refused && !(opts && opts.ignore_budget)) {
        return { status: 402, body: { refused: true, budget: plan.budget || null, plan,
            error: 'This would take the project over its budget. Nothing was run.' } };
    }
    if (!(plan.items || []).length) return { status: 200, body: { run_id: null, plan, message: plan.summary || 'Nothing to do.' } };
    const runId = rc._recordRun(projectId, { total: plan.items.length, params: { kind: 'run_to_here', target: key } });
    last = runToHere(projectId, key, Object.assign({}, opts, { run_id: runId }), d).catch(err => ({ ok: false, error: err.message }));
    return { status: 202, body: { run_id: runId, plan } };
}
function _lastRun() { return last; }

module.exports = { planRunToHere, planForNode, TARGETS, executeRunToHereItem, runToHere, startRunToHere, _lastRun };
