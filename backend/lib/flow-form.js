/**
 * A form view of a flow (FOG-009, GRD-4590).
 *
 * An input node marked `config.exposed` becomes a field on a form: a text box
 * for a prompt, an asset picker for an asset, a subject picker for a subject.
 * Filling the form in is how a director re-points a flow for this apply
 * without opening the canvas. The values travel as `inputs` through the
 * FOG-001/002 plan and apply — they override the exposed nodes' config for
 * this apply only, they are part of the plan's fingerprint, and a value that
 * could not be honoured is refused before anything is planned.
 *
 * FORM_INPUTS is keyed by the input node types in NODE_TYPES and says, per
 * type, which control it is and which config field it fills, or why it is not
 * a form field at all.
 */

const FORM_INPUTS = Object.freeze({
    'in.prompt': Object.freeze({ control: 'text', field: 'text' }),
    'in.asset': Object.freeze({ control: 'asset', field: 'asset_id' }),
    'in.subject': Object.freeze({ control: 'subject', field: 'subject_name' }),
    'in.scene': Object.freeze({ control: null, field: null,
        why: 'The scene input binds the shot the flow is applied to; there is nothing to fill in, and a different shot is chosen by applying to it.' }),
});

const exposed = n => !!(n && n.config && (n.config.exposed === true || n.config.exposed === 'true' || n.config.exposed === 1));

/** The form for a flow's graph: its fillable exposed inputs with their options, and the exposed ones that cannot be filled. */
function formOf(db, graph, projectId) {
    const fields = [], notFillable = [];
    let assets = null, subjects = null;
    for (const n of (graph && graph.nodes) || []) {
        const rule = FORM_INPUTS[n.type];
        if (!rule || !exposed(n)) continue;
        if (!rule.control) { notFillable.push({ node_id: n.id, type: n.type, label: n.label || n.id, why: rule.why }); continue; }
        const cfg = n.config || {};
        const field = { node_id: n.id, type: n.type, label: n.label || n.id, control: rule.control, field: rule.field, default: cfg[rule.field] || '' };
        if (rule.control === 'asset') {
            if (!assets) assets = projectId ? db.prepare(`SELECT id, asset_type, file_name FROM film_assets WHERE project_id = ?
                AND asset_type != 'other' ORDER BY created_at DESC LIMIT 200`).all(projectId) : [];
            field.options = assets.map(a => ({ id: a.id, name: a.file_name || a.id, asset_type: a.asset_type }));
        }
        if (rule.control === 'subject') {
            if (!subjects) {
                subjects = [];
                if (projectId) {
                    for (const [table, kind] of [['film_characters', 'character'], ['film_locations', 'location'], ['film_props', 'prop']]) {
                        try { for (const r of db.prepare(`SELECT name FROM ${table} WHERE project_id = ? ORDER BY name`).all(projectId)) subjects.push({ name: r.name, kind }); }
                        catch (_) { /* a table this build lacks offers nothing */ }
                    }
                }
            }
            field.options = (cfg.subject_type ? subjects.filter(s => s.kind === cfg.subject_type) : subjects).map(s => ({ ...s }));
        }
        fields.push(field);
    }
    return { fields, not_fillable: notFillable };
}

/**
 * Check form values against a flow's graph. Returns { ok, error } — a refusal
 * names the node and why, so nothing is planned from a value that would be
 * ignored or would point somewhere it must not.
 */
function checkInputs(db, graph, inputs, projectId) {
    const values = inputs && typeof inputs === 'object' ? inputs : {};
    const byId = new Map(((graph && graph.nodes) || []).map(n => [n.id, n]));
    for (const [id, value] of Object.entries(values)) {
        const n = byId.get(id);
        if (!n || !FORM_INPUTS[n.type]) return { ok: false, error: `The form names ${id}, and this flow has no input node by that id.` };
        const rule = FORM_INPUTS[n.type];
        if (!rule.control) return { ok: false, error: `${n.label || id} cannot be filled in from a form: ${rule.why}` };
        if (!exposed(n)) return { ok: false, error: `${n.label || id} is not exposed on this flow's form; mark it exposed on the canvas first.` };
        if (rule.control === 'asset' && value) {
            const a = db.prepare('SELECT project_id FROM film_assets WHERE id = ?').get(String(value));
            if (!a) return { ok: false, error: `${n.label || id}: asset ${value} does not exist.` };
            if (projectId && a.project_id !== projectId) return { ok: false, error: `${n.label || id}: that asset belongs to another project.` };
        }
    }
    return { ok: true };
}

/** A copy of the graph with the form's values written into the exposed nodes it names. Empty values keep the node's own. */
function withInputs(graph, inputs) {
    const values = inputs && typeof inputs === 'object' ? inputs : {};
    return {
        ...graph,
        nodes: ((graph && graph.nodes) || []).map(n => {
            const v = values[n.id];
            const rule = FORM_INPUTS[n.type];
            if (v === undefined || v === null || v === '' || !rule || !rule.control || !exposed(n)) return n;
            return { ...n, config: { ...(n.config || {}), [rule.field]: String(v), from_form: true } };
        }),
    };
}

module.exports = { FORM_INPUTS, formOf, checkInputs, withInputs, isExposed: exposed };
