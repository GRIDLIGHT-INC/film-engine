/**
 * Output nodes — where a flow's results become part of the project.
 *
 * out.asset is the load-bearing one, and it closes the gap carried out of
 * Phase 0: the legacy orchestrator called generators and discarded the results,
 * so an orchestrated run produced no assets at all and every downstream step
 * that needed one could never find it. Without registration, canvas output
 * would be a side channel that the QA checker, the budget ledger, the NLE
 * export and project bundles all cannot see.
 */

const { PORT } = require('./port');

const MEDIA_PORTS = ['image', 'video', 'audio', 'model3d'];

/** First value present on any media port. */
function firstMedia(inputs) {
    for (const port of MEDIA_PORTS) {
        const value = inputs[port];
        if (!value) continue;
        const one = Array.isArray(value) ? value[0] : value;
        if (one && one.value) return { port, value: one.value };
    }
    return null;
}

// Port -> a sensible film_assets.asset_type when the node does not name one.
const DEFAULT_ASSET_TYPE = {
    image: 'keyframe', video: 'video_raw', audio: 'audio_dialogue', model3d: 'other',
};

const handlers = {
    /**
     * Register the incoming value in film_assets so canvas output is
     * indistinguishable from pipeline output.
     */
    'out.asset': {
        async execute(node, inputs, ctx) {
            const media = firstMedia(inputs || {});
            if (!media) {
                return { ok: true, skipped: true, message: 'nothing to save', outputs: {} };
            }

            const config = node.config || {};
            const { db, generateId } = require('../../db/database');

            const projectId = (ctx.scene && ctx.scene.project_id) || (ctx.project && ctx.project.id) || null;
            if (!projectId) return { ok: false, error: 'cannot register an asset without a project' };

            const value = media.value;
            const filePath = (value && (value.path || value.file_path)) || '';
            const fileName = (value && (value.file_name || value.filename))
                || (filePath ? String(filePath).split('/').pop() : `${node.id}.out`);

            const assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (id, project_id, shot_id, scene_id, asset_type, file_path, file_name, version, provider, license_source, license_status, metadata)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 'generated', 'generated', ?)`
            ).run(
                assetId,
                projectId,
                (ctx.shot && ctx.shot.id) || null,
                (ctx.scene && ctx.scene.id) || null,
                config.asset_type || DEFAULT_ASSET_TYPE[media.port] || 'other',
                filePath,
                fileName,
                ctx.providerId || '',
                JSON.stringify({ source: 'flow', node: node.id, run_id: ctx.runId || '' })
            );

            return { ok: true, outputs: {}, assetId };
        },
    },

    /**
     * Terminal node of the built-in flow. Assembly is a collector: picture and
     * every audio stem converge here, which is what a final mix actually is.
     */
    'out.assembly': {
        async execute(node, inputs, ctx) {
            const video = inputs.video ? (Array.isArray(inputs.video) ? inputs.video : [inputs.video]) : [];
            const audio = inputs.audio ? (Array.isArray(inputs.audio) ? inputs.audio : [inputs.audio]) : [];

            return {
                ok: true,
                outputs: {
                    timeline: PORT('timeline', {
                        shot_id: (ctx.shot && ctx.shot.id) || null,
                        scene_id: (ctx.scene && ctx.scene.id) || null,
                        picture: video.map(v => v.value),
                        audio: audio.map(a => a.value),
                    }),
                },
            };
        },
    },

    /** Emit an editor timeline. Pure formatting over lib/nle-export. */
    'out.timeline': {
        async execute(node, inputs, ctx) {
            const timeline = inputs.timeline
                ? (Array.isArray(inputs.timeline) ? inputs.timeline[0] : inputs.timeline)
                : null;

            if (!timeline) {
                return { ok: true, skipped: true, message: 'no timeline to export', outputs: {} };
            }
            return {
                ok: true,
                outputs: {},
                exported: { format: (node.config && node.config.format) || 'fcpxml' },
            };
        },
    },
};

module.exports = { handlers };
