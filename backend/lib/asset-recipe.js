/**
 * How a version was made (PGN-013).
 *
 * One read per asset: provider, model, prompt, negative prompt, references,
 * seed, size, tier, whether its inputs are still current, the render-ledger
 * row, the cost, and when. Gathered from where each fact already lives — the
 * asset row, its metadata and input_refs, the render ledger, the meter, the
 * fingerprint — and NOTHING is guessed: a fact that cannot be found is null
 * and named in `unknown`, and a fact matched by time rather than identity says
 * so (`ledger_match` / `cost_match` = 'nearest').
 */

const RECIPE_FIELDS = Object.freeze(['provider', 'model', 'prompt', 'negative_prompt', 'references',
    'seed', 'size', 'tier', 'fingerprint', 'ledger', 'cost', 'made_at']);

/** Which ledger step made an asset of this type. */
const LEDGER_STEP = Object.freeze({
    storyboard: 'keyframe', keyframe: 'keyframe',
    video_raw: 'video', video_synced: 'lipsync', video_final: 'post',
    audio_dialogue: 'voice', audio_music: 'music', audio_sfx: 'sfx', audio_ambient: 'ambient',
});
const NEAR_SECONDS = 600;

/*
 * WHAT A FLOW MADE (FOG-008). A flow output's facts live in the flow run, not
 * on the asset: which flow and version, the node that saved it, the generating
 * node upstream of it and that node's provider and model, the run, the apply.
 * Each is read from where it lives and named in `unknown` when it is gone.
 */
const FLOW_RECIPE_FIELDS = Object.freeze(['flow', 'flow_version', 'node', 'generated_by', 'provider', 'model', 'run', 'apply']);

function flowProvenance(db, meta) {
    const from = meta && meta.flow_from;
    let m = meta || {};
    if (from) {
        // A frame picked from a flow: its facts are the candidate's.
        const cand = from.asset_id ? db.prepare('SELECT metadata FROM film_assets WHERE id = ?').get(from.asset_id) : null;
        m = Object.assign({}, parse(cand && cand.metadata, {}) || {}, from);
    } else if (m.source !== 'flow') return null;

    const run = m.run_id ? db.prepare('SELECT id, flow_id, status, graph_snapshot, apply_id, started_at, completed_at FROM film_flow_runs WHERE id = ?').get(m.run_id) : null;
    const flowId = m.flow_id || (run && run.flow_id) || null;
    const flow = flowId ? db.prepare('SELECT id, name, version FROM film_flows WHERE id = ?').get(flowId) : null;
    const applyId = m.apply_id || (run && run.apply_id) || null;
    const apply = applyId ? db.prepare('SELECT id, status, created_at FROM film_flow_applies WHERE id = ?').get(applyId) : null;

    // The generating node: walk upstream from the node that saved it, in the graph AS RUN.
    let gen = null, provider = null, model = null;
    const graph = run ? parse(run.graph_snapshot, null) : null;
    if (graph && m.node) {
        const byId = new Map((graph.nodes || []).map(n => [n.id, n]));
        const seen = new Set();
        const queue = [m.node];
        while (queue.length && !gen) {
            const id = queue.shift();
            for (const e of graph.edges || []) {
                if (e.to !== id || seen.has(e.from)) continue;
                seen.add(e.from);
                const n = byId.get(e.from);
                if (n && String(n.type).startsWith('gen.')) { gen = n; break; }
                queue.push(e.from);
            }
        }
        if (gen) {
            const nr = db.prepare(`SELECT nr.provider_id FROM film_flow_node_runs nr LEFT JOIN film_flow_branches b ON b.id = nr.branch_id
                WHERE nr.run_id = ? AND nr.node_id = ? AND (b.branch_key = ? OR nr.branch_id IS NULL) AND nr.provider_id != ''
                ORDER BY nr.branch_id IS NULL LIMIT 1`).get(run.id, gen.id, m.branch || '');
            provider = (nr && nr.provider_id) || null;
            model = (gen.config && gen.config.model) || null;
        }
    }
    const out = {
        flow: flow ? { id: flow.id, name: flow.name } : null,
        flow_version: flow && flow.version != null ? Number(flow.version) : null,
        node: m.node || null,
        generated_by: gen ? { id: gen.id, type: gen.type } : null,
        provider, model,
        run: run ? { id: run.id, status: run.status, started_at: run.started_at, completed_at: run.completed_at } : null,
        apply: apply ? { id: apply.id, status: apply.status, created_at: apply.created_at } : null,
        branch: m.branch || null,
    };
    out.unknown = FLOW_RECIPE_FIELDS.filter(f => out[f] === null || out[f] === undefined);
    return out;
}

const parse = (t, d) => { try { return t ? JSON.parse(t) : d; } catch (_) { return d; } };
const blank = v => v === undefined || v === null || v === '' || v === 'unrecorded';

function assetRecipe(db, assetId) {
    const a = assetId ? db.prepare('SELECT * FROM film_assets WHERE id = ?').get(assetId) : null;
    if (!a) return null;
    const meta = parse(a.metadata, {}) || {};
    const frameMeta = meta.storyboard_frame || {};

    // The ledger row: exact by output path, else the nearest row of the same step.
    let ledger = null, ledgerMatch = null;
    const step = LEDGER_STEP[a.asset_type];
    if (a.shot_id && step) {
        try {
            const exact = db.prepare('SELECT * FROM render_ledger WHERE shot_id = ? AND step = ? AND output_path = ? ORDER BY created_at DESC LIMIT 1')
                .get(a.shot_id, step, a.file_path || '');
            if (exact) { ledger = exact; ledgerMatch = 'exact'; }
            else if (a.created_at) {
                const near = db.prepare(`SELECT *, ABS(julianday(created_at) - julianday(?)) * 86400 AS gap FROM render_ledger
                    WHERE shot_id = ? AND step = ? ORDER BY gap LIMIT 1`).get(a.created_at, a.shot_id, step);
                if (near && near.gap <= NEAR_SECONDS) { ledger = near; ledgerMatch = 'nearest'; }
            }
        } catch (_) { ledger = null; }
    }

    // The cost: the meter's entry for this shot nearest the moment the file was made.
    let cost = null, costMatch = null;
    if (a.shot_id && a.created_at) {
        try {
            const c = db.prepare(`SELECT *, ABS(julianday(created_at) - julianday(?)) * 86400 AS gap FROM film_cost_entries
                WHERE project_id = ? AND shot_id = ? ORDER BY gap LIMIT 1`).get(a.created_at, a.project_id, a.shot_id);
            if (c && c.gap <= NEAR_SECONDS) {
                cost = { amount: Number(c.amount), currency: c.currency || 'USD', model: c.model_used || null, entry_id: c.id };
                costMatch = 'nearest';
            }
        } catch (_) { cost = null; }
    }

    // References the version was made from, with a picture of each where one exists.
    const refs = [];
    for (const r of parse(a.input_refs, []) || []) {
        const id = typeof r === 'string' ? r : (r && (r.asset_id || r.id));
        if (!id) continue;
        const row = db.prepare('SELECT id, asset_type, file_name, file_path FROM film_assets WHERE id = ?').get(id);
        if (!row) { refs.push({ asset_id: id, missing: true, thumb: null }); continue; }
        let thumb = null;
        try { thumb = require('./file-storage').urlForPath(row.file_path) || null; } catch (_) { thumb = null; }
        refs.push({ asset_id: row.id, asset_type: row.asset_type, file_name: row.file_name, thumb });
    }

    // Are its inputs still what they were?
    let fingerprint = { state: 'untracked', recorded: null, current: null };
    if (a.input_fingerprint && a.artefact_kind) {
        let current = null;
        try { current = require('./artefact-fingerprint').fingerprintFor(a.artefact_kind, { shotId: a.shot_id }); } catch (_) { current = null; }
        fingerprint = { state: current === null ? 'unknown' : (current === a.input_fingerprint ? 'current' : 'behind'),
            recorded: a.input_fingerprint, current };
    }

    const size = !blank(ledger && ledger.resolution) ? ledger.resolution
        : (meta.width && meta.height ? `${meta.width}x${meta.height}` : (meta.size || meta.raster || null));
    const seed = ledger && Number(ledger.seed) >= 0 ? Number(ledger.seed)
        : (!blank(meta.seed) ? meta.seed : (!blank(frameMeta.seed) ? frameMeta.seed : null));
    const flow = flowProvenance(db, meta);
    const out = {
        asset_id: a.id, asset_type: a.asset_type, shot_id: a.shot_id || null,
        // A flow output's generator is the flow node's, read from its run.
        provider: a.provider || (ledger && parse(ledger.extra_params, {}).provider) || (flow && flow.provider) || null,
        model: !blank(a.provider_model) ? a.provider_model : (ledger && !blank(ledger.model_id) ? ledger.model_id : (flow && flow.model) || null),
        prompt: (ledger && !blank(ledger.prompt) && ledger.prompt) || meta.prompt || frameMeta.prompt || null,
        negative_prompt: (ledger && !blank(ledger.negative_prompt) && ledger.negative_prompt) || meta.negative_prompt || frameMeta.negative_prompt || null,
        references: refs,
        seed,
        size,
        tier: meta.tier || meta.quality || null,
        fingerprint,
        ledger: ledger ? { id: ledger.id, version: ledger.version, step: ledger.step, mode: ledger.mode, created_at: ledger.created_at } : null,
        cost,
        made_at: a.created_at || null,
        ledger_match: ledgerMatch,
        cost_match: costMatch,
        flow,
    };
    // Whether the provider honours a seed at all — read from the adapter, so
    // "make another like this" never promises the same again from a provider
    // that ignores the number. Null when there is no provider to ask.
    out.seed_honoured = null;
    if (out.provider) {
        try { const ad = require('./providers').get(out.provider); if (ad && typeof ad.supportsSeed === 'boolean') out.seed_honoured = ad.supportsSeed; }
        catch (_) { out.seed_honoured = null; }
    }
    out.unknown = RECIPE_FIELDS.filter(f => out[f] === null || (Array.isArray(out[f]) && !out[f].length));
    return out;
}

module.exports = { assetRecipe, RECIPE_FIELDS, FLOW_RECIPE_FIELDS, LEDGER_STEP };
