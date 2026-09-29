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

const handlers = {
    /**
     * Register the incoming value in film_assets so canvas output is
     * indistinguishable from pipeline output.
     */
    'out.asset': {
        /*
         * Save the incoming media and register it as a CANDIDATE version on
         * the shot the run is for (FOG-004): the bytes on disk, the row typed
         * `other` so nothing that picks "the newest frame" or "the best clip"
         * takes it by itself, and the type it would be once picked kept in
         * metadata. lib/flow-outputs.js says why, per port.
         */
        async execute(node, inputs, ctx) {
            const media = firstMedia(inputs || {});
            if (!media) {
                return { ok: true, skipped: true, message: 'nothing to save', outputs: {} };
            }
            const { db } = require('../../db/database');
            const r = await require('../flow-outputs').saveFlowOutput(db, { port: media.port, value: media.value, node, ctx: ctx || {} });
            if (!r.ok) return { ok: false, error: r.error };
            return { ok: true, outputs: {}, assetId: r.assetId };
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
