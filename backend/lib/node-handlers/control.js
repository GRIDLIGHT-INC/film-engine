/**
 * Control nodes: fan-out and select.
 *
 * Isolated in their own file because these are the only two handlers the
 * executor treats specially — everything else is one-in-one-out, and folding
 * branch semantics into generate.js would make the common path pay for the
 * rare one.
 *
 * Phase 2 registers them so every node type resolves to a handler and a flow
 * containing one still runs. Branch persistence and the human gate land in
 * Phase 3 (migration 056); until then fan-out passes its input through
 * unchanged and select takes the first branch, both of which are the
 * single-branch case and therefore correct rather than merely harmless.
 */

const { PORT } = require('./port');

function passthrough(inputs) {
    const value = inputs && inputs.any;
    if (!value) return null;
    return Array.isArray(value) ? value[0] : value;
}

const handlers = {
    /** N variants from one input. Phase 3 widens the frontier; here N = 1. */
    'tf.fanout': {
        async execute(node, inputs, ctx) {
            const incoming = passthrough(inputs);
            if (!incoming) {
                return { ok: true, skipped: true, message: 'nothing to fan out', outputs: {} };
            }
            const requested = Number((node.config || {}).count) || 1;
            return {
                ok: true,
                outputs: { any: PORT(incoming.type || 'any', incoming.value) },
                branches: requested,
                message: requested > 1
                    ? `fan-out of ${requested} requested; branch execution lands in Phase 3`
                    : '',
            };
        },
    },

    /** Human gate. Phase 3 pauses the run here; with one branch there is no choice to make. */
    'tf.select': {
        async execute(node, inputs, ctx) {
            const incoming = passthrough(inputs);
            if (!incoming) {
                return { ok: true, skipped: true, message: 'nothing to select from', outputs: {} };
            }
            return { ok: true, outputs: { any: PORT(incoming.type || 'any', incoming.value) } };
        },
    },
};

module.exports = { handlers };
