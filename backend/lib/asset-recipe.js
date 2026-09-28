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
    const out = {
        asset_id: a.id, asset_type: a.asset_type,
        provider: a.provider || (ledger && parse(ledger.extra_params, {}).provider) || null,
        model: !blank(a.provider_model) ? a.provider_model : (ledger && !blank(ledger.model_id) ? ledger.model_id : null),
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
    };
    out.unknown = RECIPE_FIELDS.filter(f => out[f] === null || (Array.isArray(out[f]) && !out[f].length));
    return out;
}

module.exports = { assetRecipe, RECIPE_FIELDS, LEDGER_STEP };
