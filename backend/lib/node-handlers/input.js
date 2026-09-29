/**
 * Source nodes: where values enter a flow.
 *
 * Grouped in one file because all five share context loading and none of them
 * calls a generator.
 */

const { PORT } = require('./port');

/** Substitute {{name}} from upstream text values and node config. */
function interpolate(template, inputs, config) {
    if (typeof template !== 'string' || !template.includes('{{')) return template;

    const upstream = inputs && inputs.text
        ? (Array.isArray(inputs.text) ? inputs.text.map(v => v.value).join(', ') : inputs.text.value)
        : '';

    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key) => {
        if (config && config[key] !== undefined) return String(config[key]);
        if (upstream) return String(upstream);
        return whole;   // leave an unresolved placeholder visible rather than blanking it
    });
}

const handlers = {
    /**
     * A literal prompt. Interpolation is what lets one flow be re-run across
     * many shots instead of being rewritten for each.
     */
    'in.prompt': {
        async execute(node, inputs, ctx) {
            const config = node.config || {};
            const text = interpolate(config.text || '', inputs, { ...config, ...(ctx.vars || {}) });
            return { ok: true, outputs: { text: PORT('text', text) } };
        },
    },

    /** An existing registered asset, or one supplied in node config. */
    'in.asset': {
        async execute(node, inputs, ctx) {
            const config = node.config || {};
            let asset = null;

            if (config.asset_id && ctx.loadAsset) {
                asset = ctx.loadAsset(config.asset_id);
            } else if (config.asset_id) {
                const { db } = require('../../db/database');
                asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(config.asset_id) || null;
            }

            if (!asset) {
                // A source node with nothing selected yet is not an error — the
                // canvas lets you place a node before choosing its asset.
                return { ok: true, skipped: true, message: 'no asset selected', outputs: {} };
            }

            const PORT_BY_TYPE = {
                keyframe: 'image', storyboard: 'image', reference_image: 'image', character_sheet: 'image',
                video_raw: 'video', video_synced: 'video', video_final: 'video',
                audio_dialogue: 'audio', music: 'audio', sfx: 'audio', ambient: 'audio',
            };
            const port = PORT_BY_TYPE[asset.asset_type] || 'image';

            return {
                ok: true,
                outputs: { [port]: PORT(port, { assetId: asset.id, path: asset.file_path, file_name: asset.file_name }) },
            };
        },
    },

    /**
     * Character / location / prop identity as a typed value.
     *
     * This is the node a general-purpose canvas cannot offer: identity travels
     * down the graph as data instead of being re-pasted into every prompt.
     */
    'in.subject': {
        async execute(node, inputs, ctx) {
            const config = node.config || {};
            const consistency = ctx.consistency || null;

            // With no subject named, the run takes the shot card's first
            // character — the binding lib/flow-apply.js plans for, so a plan
            // never describes a run that does not happen.
            const card = ctx.sceneCard || {};
            const fromCard = Array.isArray(card.characters) && card.characters.length ? String(card.characters[0]) : '';
            const subject = {
                name: config.subject_name || fromCard,
                type: config.subject_type || 'character',
                consistency,
            };

            const outputs = { subject: PORT('subject', subject) };

            const primary = consistency && Array.isArray(consistency.references) ? consistency.references[0] : null;
            if (primary) {
                outputs.image = PORT('image', { path: primary.file_path || primary.url, weight: primary.weight });
            }
            return { ok: true, outputs };
        },
    },

    /** Story data: binds a flow to a scene or shot. */
    'in.scene': {
        async execute(node, inputs, ctx) {
            const card = ctx.sceneCard || {};
            const parts = [card.action, card.shot_type, card.lighting].filter(Boolean);

            const outputs = { text: PORT('text', parts.join(', ')) };
            if (Array.isArray(card.characters) && card.characters.length) {
                outputs.subject = PORT('subject', { name: card.characters[0], type: 'character', consistency: ctx.consistency || null });
            }
            return { ok: true, outputs };
        },
    },
};

module.exports = { handlers, interpolate };
