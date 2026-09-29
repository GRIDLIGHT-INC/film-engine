/**
 * What a flow makes, kept as a CANDIDATE version on the shot it ran for
 * (FOG-004, GRD-4585).
 *
 * `out.asset` registered a row and never wrote the bytes: a provider hands back
 * a Buffer or a URL, neither has a `path`, so every flow output was a row
 * pointing at nothing. Now the bytes are saved through the one persister every
 * generation uses, and the row is registered as `other` with
 * `metadata.kind = 'flow_output'` — the precedent angle candidates set. That
 * is what makes "a new output never becomes the selected version by itself"
 * true everywhere rather than on one surface: the board takes the highest
 * frame version, playback and the conform take the best clip TYPE, a scene
 * bed takes the newest music of its type, and none of them reads `other`. The
 * type it WOULD be once somebody picks it is kept as `as_type`; picking one is
 * FOG-005's explicit act.
 *
 * FLOW_OUTPUT_KINDS is keyed by out.asset's own media input ports and says,
 * per port, which kind of version it is drawn as on the Production graph, or
 * why it is not drawn at all.
 */

const crypto = require('crypto');
const fs = require('fs');

const FLOW_OUTPUT_KINDS = Object.freeze({
    image: Object.freeze({ version: 'frame', subdir: 'storyboards', ext: 'png', as_type: 'keyframe' }),
    video: Object.freeze({ version: 'clip', subdir: 'video', ext: 'mp4', as_type: 'video_raw' }),
    audio: Object.freeze({ version: 'sound', subdir: 'audio', ext: 'mp3', as_type: 'audio_dialogue' }),
    model3d: Object.freeze({
        version: null, subdir: '3d', ext: 'glb', as_type: 'other',
        why: 'A mesh has no version node on the Production graph: it is saved and listed on the 3D page, where a model is staged.',
    }),
});

/** What the bytes are, when they say; otherwise the kind's own extension. */
function sniffExt(buf, fallback) {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return fallback;
    const hex = buf.subarray(0, 12).toString('hex');
    if (hex.startsWith('89504e47')) return 'png';
    if (hex.startsWith('ffd8ff')) return 'jpg';
    if (hex.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
    if (hex.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WAVE') return 'wav';
    if (hex.startsWith('494433') || hex.startsWith('fffb') || hex.startsWith('fff3')) return 'mp3';
    if (hex.startsWith('1a45dfa3')) return 'webm';
    if (buf.subarray(4, 8).toString() === 'ftyp') return 'mp4';
    if (hex.startsWith('676c5446')) return 'glb';
    return fallback;
}

const slug = s => String(s || '').replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 24) || 'x';

/** The flow and the apply a run belongs to, from the run row the executor wrote. */
function runOrigin(db, runId) {
    if (!runId) return { flow_id: null, apply_id: null };
    try {
        const r = db.prepare('SELECT flow_id, apply_id FROM film_flow_runs WHERE id = ?').get(runId);
        return { flow_id: (r && r.flow_id) || null, apply_id: (r && r.apply_id) || null };
    } catch (_) { return { flow_id: null, apply_id: null }; }
}

/**
 * Save one output and register it as a candidate.
 * @returns {Promise<{ok:true, assetId:string, path:string}|{ok:false, error:string}>}
 */
async function saveFlowOutput(db, { port, value, node, ctx, extra }) {
    const kind = FLOW_OUTPUT_KINDS[port];
    if (!kind) return { ok: false, error: `out.asset has no rule for a ${port} output` };
    const c = ctx || {};
    /*
     * A value that IS a flow candidate already — the variation a paused run
     * kept, handed on by the gate when the run resumes (FOG-005) — is that
     * candidate. Saving it again would put the same picture on the shot twice.
     */
    if (value && typeof value === 'object' && !Buffer.isBuffer(value) && value.asset_id) {
        const row = db.prepare("SELECT id, file_path FROM film_assets WHERE id = ? AND json_valid(metadata) AND json_extract(metadata, '$.kind') = 'flow_output'").get(value.asset_id);
        if (row) return { ok: true, assetId: row.id, path: row.file_path, reused: true };
    }
    const projectId = (c.scene && c.scene.project_id) || (c.project && c.project.id) || null;
    if (!projectId) return { ok: false, error: 'cannot register an asset without a project' };

    // A value that already names a file on disk is registered where it is.
    let filePath = value && typeof value === 'object' && !Buffer.isBuffer(value) ? (value.path || value.file_path || '') : '';
    if (filePath && !fs.existsSync(filePath)) filePath = '';
    if (!filePath) {
        const ext = sniffExt(value, kind.ext);
        const name = `flow_${slug(c.runId ? String(c.runId).slice(0, 8) : 'node')}_${slug(node && node.id)}_${slug(c.branch || 'root')}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
        try {
            // The house rule for a generated clip's sound applies here as it does
            // on every other road: kept only when the provider says audio was asked.
            const saved = await require('./provider-media').persistProviderMedia(projectId, kind.subdir, name, value);
            filePath = typeof saved === 'string' ? saved : (saved && saved.path) || '';
        } catch (err) {
            return { ok: false, error: `the ${port} output could not be saved: ${err.message}` };
        }
        if (!filePath) return { ok: false, error: `the ${port} output could not be saved` };
    }

    const cfg = (node && node.config) || {};
    const origin = runOrigin(db, c.runId);
    const { generateId } = require('../db/database');
    const assetId = generateId();
    db.prepare(
        `INSERT INTO film_assets (id, project_id, shot_id, scene_id, asset_type, file_path, file_name, version, provider, license_source, license_status, metadata)
         VALUES (?, ?, ?, ?, 'other', ?, ?, 1, ?, 'generated', 'generated', ?)`
    ).run(
        assetId, projectId, (c.shot && c.shot.id) || null, (c.scene && c.scene.id) || null,
        filePath, require('path').basename(filePath), c.providerId || '',
        JSON.stringify({
            source: 'flow', kind: 'flow_output', output_kind: port,
            as_type: cfg.asset_type || kind.as_type,
            flow_id: origin.flow_id, apply_id: origin.apply_id, run_id: c.runId || null,
            node: (node && node.id) || null, branch: c.branch || 'root', variant: c.variant != null ? c.variant : null,
            ...(extra || {}),
        })
    );
    return { ok: true, assetId, path: filePath };
}

/** A shot's flow outputs, oldest first, each with the kind it is drawn as. */
function flowOutputsOf(db, shotId) {
    let rows = [];
    try {
        rows = db.prepare(
            `SELECT a.id, a.file_path, a.provider, a.provider_model, a.created_at, a.metadata, r.status AS run_status
               FROM film_assets a LEFT JOIN film_flow_runs r ON r.id = json_extract(a.metadata, '$.run_id')
              WHERE a.shot_id = ? AND a.asset_type = 'other' AND json_valid(a.metadata)
                AND json_extract(a.metadata, '$.kind') = 'flow_output'
              ORDER BY a.created_at ASC, a.rowid ASC`).all(shotId);
    } catch (_) { return []; }
    return rows.map(r => {
        let m = {};
        try { m = JSON.parse(r.metadata) || {}; } catch (_) { /* unreadable metadata draws nothing */ }
        const kind = FLOW_OUTPUT_KINDS[m.output_kind] || {};
        return {
            asset_id: r.id, output_kind: m.output_kind || null, version: kind.version || null,
            path: r.file_path, provider: r.provider || null, model: r.provider_model || null, created_at: r.created_at,
            as_type: m.as_type || null, flow_id: m.flow_id || null, apply_id: m.apply_id || null,
            run_id: m.run_id || null, node: m.node || null, branch: m.branch || null, variant: m.variant != null ? m.variant : null,
            // A variation a paused gate is waiting on (FOG-005): pickable only
            // while its run is still paused — finished or cancelled, it is not.
            awaiting_pick: !!(m.awaiting_pick && r.run_status === 'paused'),
            run_status: r.run_status || null,
        };
    });
}

module.exports = { FLOW_OUTPUT_KINDS, saveFlowOutput, flowOutputsOf, sniffExt };
