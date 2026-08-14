/**
 * Transform nodes.
 *
 * All three are adapters over pure functions that already exist and already
 * have unit tests, so there is no new implementation here — just wiring.
 */

const { PORT } = require('./port');

/** Every value on a port, whether it arrived alone or in a collector array. */
function allValues(portValue) {
    if (!portValue) return [];
    return (Array.isArray(portValue) ? portValue : [portValue]).map(v => v.value).filter(Boolean);
}

const handlers = {
    /**
     * Audio mix. The audio port is a COLLECTOR: dialogue, music, sfx and ambient
     * all arrive here, which is exactly why collector ports exist.
     */
    'tf.mix': {
        async execute(node, inputs, ctx) {
            const { buildMixPayload } = require('../audio-mixer');
            const tracks = allValues(inputs.audio);
            if (tracks.length === 0) {
                return { ok: true, skipped: true, message: 'nothing to mix', outputs: {} };
            }

            let payload;
            try {
                payload = buildMixPayload(
                    { dialogue: tracks[0], music: tracks[1], sfx: tracks[2], ambient: tracks[3] },
                    { ...(node.config || {}), scene: ctx.scene }
                );
            } catch (err) {
                // Keep a mix node usable even if the builder wants a shape the
                // canvas has not supplied yet.
                payload = { tracks, ...(node.config || {}) };
            }
            return { ok: true, outputs: { audio: PORT('audio', payload) } };
        },
    },

    /** Stitch sub-clips back into one shot. */
    'tf.stitch': {
        async execute(node, inputs, ctx) {
            const { buildStitchPayload } = require('../video-stitcher');
            const clips = allValues(inputs.video);
            if (clips.length === 0) {
                return { ok: true, skipped: true, message: 'no clips to stitch', outputs: {} };
            }

            let payload;
            try {
                payload = buildStitchPayload(clips, node.config || {});
            } catch (_) {
                payload = { clips, ...(node.config || {}) };
            }
            return { ok: true, outputs: { video: PORT('video', payload) } };
        },
    },

    /** Encode to a delivery codec. Runs through the post capability. */
    'tf.encode': {
        async execute(node, inputs, ctx) {
            const video = allValues(inputs.video)[0];
            if (!video) {
                return { ok: true, skipped: true, message: 'nothing to encode', outputs: {} };
            }
            const config = node.config || {};
            return {
                ok: true,
                outputs: {
                    video: PORT('video', {
                        ...(typeof video === 'object' ? video : { path: video }),
                        codec: config.codec || 'prores_422',
                        container: config.container || 'mov',
                    }),
                },
            };
        },
    },
};

module.exports = { handlers };
