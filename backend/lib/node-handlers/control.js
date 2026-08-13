/**
 * Control nodes: fan-out and select.
 *
 * Isolated because these are the only two handlers the executor treats
 * specially. Everything else is one-in-one-out; folding branch semantics into
 * generate.js would make the common path pay for the rare one.
 *
 * tf.fanout does not itself run N times — it runs ONCE and declares the
 * branches its dependants run across. Keeping the widening in the executor
 * means no generator handler ever has to know whether it is being fanned.
 */

const { PORT } = require('./port');

function passthrough(inputs) {
    const value = inputs && inputs.any;
    if (!value) return null;
    return Array.isArray(value) ? value[0] : value;
}

const handlers = {
    /**
     * N variants from one input.
     *
     * The variant axis is declared in config: seeds, prompt suffixes, or
     * providers. Each branch gets a distinct key, and the executor replays
     * everything downstream once per key.
     */
    'tf.fanout': {
        async execute(node, inputs, ctx) {
            const incoming = passthrough(inputs);
            if (!incoming) {
                return { ok: true, skipped: true, message: 'nothing to fan out', outputs: {} };
            }

            const config = node.config || {};
            const count = Math.max(1, Math.min(24, Number(config.count) || 1));

            // A single branch is not a fan-out; emitting one keeps the
            // unbranched path byte-identical to a flow with no fanout node.
            if (count === 1) {
                return { ok: true, outputs: { any: PORT(incoming.type || 'any', incoming.value) } };
            }

            const seeds = Array.isArray(config.seeds) ? config.seeds : [];
            const prompts = Array.isArray(config.prompts) ? config.prompts : [];
            const providers = Array.isArray(config.providers) ? config.providers : [];

            const branchKeys = [];
            const variants = {};
            for (let i = 0; i < count; i++) {
                const key = `${node.id}#${i + 1}`;
                branchKeys.push(key);
                variants[key] = {
                    seed: seeds[i],
                    prompt: prompts[i],
                    provider: providers[i],
                    index: i,
                };
            }

            return {
                ok: true,
                outputs: { any: PORT(incoming.type || 'any', incoming.value) },
                branchKeys,
                variants,
                message: `fanned into ${count} branches`,
            };
        },
    },

    /**
     * Human gate: collapse many branches back to one.
     *
     * With more than one branch reaching it, the run PAUSES — the whole point
     * is that a person looks at the variants. Auto-selecting would quietly
     * make the gate decorative. With a single branch there is nothing to
     * choose, so it passes straight through.
     */
    'tf.select': {
        async execute(node, inputs, ctx) {
            const incoming = passthrough(inputs);
            if (!incoming) {
                return { ok: true, skipped: true, message: 'nothing to select from', outputs: {} };
            }

            const config = node.config || {};
            const branch = ctx.branch || '';

            // An explicit choice (set by POST /flow-runs/:id/select) resolves it.
            if (config.selected_branch) {
                if (config.selected_branch !== branch) {
                    return { ok: true, skipped: true, message: `branch ${branch} not selected`, outputs: {} };
                }
                return { ok: true, outputs: { any: PORT(incoming.type || 'any', incoming.value) } };
            }

            // Unbranched: nothing to decide.
            if (!branch) {
                return { ok: true, outputs: { any: PORT(incoming.type || 'any', incoming.value) } };
            }

            return {
                ok: true,
                awaitSelection: true,
                branch,
                message: `waiting for a branch to be selected (${branch})`,
                outputs: { any: PORT(incoming.type || 'any', incoming.value) },
            };
        },
    },
};

module.exports = { handlers };
