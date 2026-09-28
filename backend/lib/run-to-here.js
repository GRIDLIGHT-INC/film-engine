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
const TARGETS = Object.freeze({ shot: true, video: true, sequence: true, sound: true, link: false, audio: false });
const REFUSED = Object.freeze({
    link: 'A borrowed frame is not made; run to the sequence that uses it instead.',
    audio: 'A sound version is an output; run to its sound instead.',
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
    const add = it => { const id = `${it.stage}@${it.key}`; if (!seen.has(id)) { seen.add(id); items.push(it); } };
    const cardBehind = n => n.impact && (n.impact.cause === 'card' || n.impact.why === pg.IMPACT_WHY.card);

    /** Does this shot need its frame made? Pushes it (or a blocker). Returns false if blocked. */
    function needFrame(s) {
        if (cardBehind(s)) { blockers.push({ key: s.key, reason: `${s.shot_code}: ${pg.IMPACT_WHY.card} A person must edit the card first.` }); return false; }
        const missing = !s.frames || !s.frames.length;
        if (!missing && !behind(s)) return true;
        if (o.boardLocked) { blockers.push({ key: s.key, reason: `${s.shot_code}: the board is locked, so its frame cannot be made.` }); return false; }
        add({ stage: 'keyframe', key: s.key, shot_id: s.id, shot_code: s.shot_code, capability: 'image',
            cost: COST_PER_CALL.image || 0, why: missing ? 'no frame yet' : 'its frame is behind' });
        return true;
    }

    function planShot(s, clipBehind) {
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
        if (!root.selected_asset_id || behind(root)) {
            add({ stage: cap, key: root.key, cue_id: root.id, capability: cap, cost: COST_PER_CALL[cap] || 0,
                why: !root.selected_asset_id ? 'no sound yet' : 'what it was made from changed' });
        }
    }

    // A blocker upstream means the steps planned after it would build on nothing.
    const planned = blockers.length ? [] : items;
    const total = Number(planned.reduce((n, i) => n + i.cost, 0).toFixed(6));
    return {
        target: key, items: planned, blockers, total_cost: total,
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

module.exports = { planRunToHere, planForNode, TARGETS };
