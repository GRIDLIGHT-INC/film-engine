/**
 * What a generation actually costs, per provider, in the provider's own units.
 *
 * The budget area was built for a live-action production — day rates, catering,
 * shooting days, a 10% contingency. None of that is what this pipeline spends.
 * It spends TOKENS at Anthropic, CREDITS at Meshy and Runway, CHARACTERS and
 * SECONDS at ElevenLabs, and per-image charges at OpenAI. Those are the line
 * items, and `lib/flow-cost.js` was the only thing in the repo that carried a
 * price at all — eleven round numbers, deliberately on the high side, existing
 * solely to refuse a run before it starts. It says so itself: "nothing here
 * claims to be a price list". This is the price list.
 *
 * Two units per capability, and the distinction is the whole design:
 *
 *   `unit`         what the ADAPTER can measure from a real request/response —
 *                  tokens returned in `usage`, characters of text sent, seconds
 *                  of media asked for, or (when a provider charges flat per
 *                  request) the call itself.
 *   `native_unit`  what the PROVIDER bills in, which is what the user tops up
 *                  and watches drain. Runway meters in seconds and bills in
 *                  credits; ElevenLabs meters in characters and bills in
 *                  credits. Reporting only dollars hides the number that
 *                  actually runs out.
 *
 * Keeping them separate means an adapter never has to know a price, and the
 * book never has to guess at a quantity. Neither can drift into the other's job.
 *
 * Every rate carries its SOURCE and the date it was checked. A rate with no
 * source cannot be re-verified when a provider changes its pricing, and an
 * un-recheckable number does not stay approximately right — it decays into a
 * confident lie, which is worse than no tracking at all because it gets
 * budgeted against. `film_provider_rates` (migration 076) overrides any entry
 * here per install, so a user on a different plan corrects their own book
 * without editing code and without losing the researched default underneath.
 */

const { CAPABILITIES } = require('./providers/base');

/** Units an adapter may meter in. A unit outside this list cannot be priced. */
const BILLING_UNITS = ['token', 'character', 'second', 'image', 'call'];

const M = 1 / 1_000_000;   // per-million-token rates, expressed per token

/**
 * Published rates, keyed `provider:capability`.
 *
 * `models` overrides any field of the parent entry for one model id. A model
 * the table does not name falls back to the parent — never to zero, because a
 * model that prices at nothing is indistinguishable from one nobody used.
 */
const RATE_BOOK = {

    // ── Anthropic ─────────────────────────────────────────────────────────
    // Billed per token, input and output at different rates, so the price is
    // in `components` and the meter reports the split. A blended rate would be
    // wrong by 5x in either direction depending on the shape of the call.
    'anthropic:llm': {
        unit: 'token', native_unit: 'token', native_per_unit: 1,
        components: { input: 5.00 * M, output: 25.00 * M },
        models: {
            'claude-opus-5':    { components: { input: 5.00 * M,  output: 25.00 * M } },
            'claude-opus-4-8':  { components: { input: 5.00 * M,  output: 25.00 * M } },
            'claude-opus-4-7':  { components: { input: 5.00 * M,  output: 25.00 * M } },
            'claude-opus-4-6':  { components: { input: 5.00 * M,  output: 25.00 * M } },
            'claude-fable-5':   { components: { input: 10.00 * M, output: 50.00 * M } },
            'claude-sonnet-5':  { components: { input: 3.00 * M,  output: 15.00 * M } },
            'claude-sonnet-4-6':{ components: { input: 3.00 * M,  output: 15.00 * M } },
            'claude-haiku-4-5': { components: { input: 1.00 * M,  output: 5.00 * M } },
        },
        source: 'https://docs.claude.com/en/docs/about-claude/pricing',
        checked: '2026-08-22',
        note: 'Per-million-token list rates. Cache reads bill at ~0.1x and cache writes at ~1.25x; the meter records them separately when the response reports them.',
    },

    // ── OpenAI ────────────────────────────────────────────────────────────
    'openai:llm': {
        unit: 'token', native_unit: 'token', native_per_unit: 1,
        components: { input: 2.00 * M, output: 8.00 * M },
        models: {
            'gpt-4.1':      { components: { input: 2.00 * M, output: 8.00 * M } },
            'gpt-4.1-mini': { components: { input: 0.40 * M, output: 1.60 * M } },
            'gpt-4o':       { components: { input: 2.50 * M, output: 10.00 * M } },
        },
        source: 'https://platform.openai.com/docs/pricing',
        checked: '2026-08-22',
        note: 'Not on the preferred path for this install — llm resolves to Anthropic.',
    },
    // Charged per image, by quality and size, not per token.
    'openai:image': {
        unit: 'image', native_unit: 'image', native_per_unit: 1,
        usd_per_native: 0.042,
        models: {
            'gpt-image-1':      { usd_per_native: 0.042 },   // 1024x1024 medium
            'gpt-image-1-low':  { usd_per_native: 0.011 },
            'gpt-image-1-high': { usd_per_native: 0.167 },
        },
        source: 'https://platform.openai.com/docs/pricing',
        checked: '2026-08-22',
        note: 'gpt-image-1 at 1024x1024: low $0.011, medium $0.042, high $0.167 per image. Defaults to medium, which is what the adapter requests.',
    },

    // ── Runway ────────────────────────────────────────────────────────────
    // Video is credits per SECOND of output; images are credits per image. One
    // credit is one cent in the developer portal, which is a different pool
    // from a Runway app subscription.
    'runway:video': {
        unit: 'second', native_unit: 'credit', native_per_unit: 12, usd_per_native: 0.01,
        models: {
            'gen4.5':       { native_per_unit: 12 },
            'gen4_turbo':   { native_per_unit: 5 },
            'gen4':         { native_per_unit: 5 },
            'gen3a_turbo':  { native_per_unit: 5 },
            'act_two':      { native_per_unit: 5 },
            'veo3':         { native_per_unit: 12 },
        },
        source: 'https://docs.dev.runwayml.com/guides/pricing/',
        checked: '2026-08-22',
        note: 'gen4.5 is 12 credits/second — a 5s clip is $0.60. gen3a_turbo and veo3 are not in the published table; they inherit their tier and are flagged as inferred.',
        inferred_models: ['gen3a_turbo', 'veo3'],
    },
    'runway:image': {
        unit: 'image', native_unit: 'credit', native_per_unit: 5, usd_per_native: 0.01,
        models: {
            'gen4_image':        { native_per_unit: 5 },    // 720p; 1080p is 8
            'gen4_image_1080p':  { native_per_unit: 8 },
            'gen4_image_turbo':  { native_per_unit: 2 },
            'gemini_2.5_flash':  { native_per_unit: 5 },
        },
        source: 'https://docs.dev.runwayml.com/guides/pricing/',
        checked: '2026-08-22',
        note: 'gen4_image: 5 credits at 720p, 8 at 1080p. gemini_2.5_flash is unpublished and inherits the base rate.',
        inferred_models: ['gemini_2.5_flash'],
    },

    // ── Meshy ─────────────────────────────────────────────────────────────
    // Flat credits per call, by model. The USD value of a credit is not
    // published per-call; it comes from the plan — Pro is $20/mo for 1,000
    // credits, so $0.02. A user on another plan overrides it in
    // film_provider_rates rather than reading a wrong number forever.
    'meshy:image': {
        unit: 'call', native_unit: 'credit', native_per_unit: 9, usd_per_native: 0.02,
        models: {
            'nano-banana':     { native_per_unit: 3 },
            'nano-banana-2':   { native_per_unit: 3 },
            'nano-banana-pro': { native_per_unit: 9 },
            'gpt-image-2':     { native_per_unit: 9 },
        },
        source: 'https://docs.meshy.ai/en/api/pricing',
        checked: '2026-08-22',
        note: 'Credit costs are published; the USD value of a credit is not. $0.02 is the Pro plan rate ($20 / 1,000 credits). Override in Budget → Rates if you are on another plan.',
    },
    'meshy:model3d': {
        unit: 'call', native_unit: 'credit', native_per_unit: 20, usd_per_native: 0.02,
        models: {
            'meshy-5': { native_per_unit: 10 },
            'meshy-6': { native_per_unit: 20 },
            'meshy-7': { native_per_unit: 20 },
        },
        source: 'https://docs.meshy.ai/en/webapp/pricing',
        checked: '2026-08-22',
        note: 'Text-to-3D and image-to-3D: 20 credits on Meshy 6/7, 10 on Meshy 5. Remesh, rigging and animation are free.',
    },

    // ── ElevenLabs ────────────────────────────────────────────────────────
    // Speech bills per character; sound and music bill per second of output.
    'elevenlabs:voice': {
        unit: 'character', native_unit: 'credit', native_per_unit: 1, usd_per_native: 0.0001,
        models: {
            'eleven_multilingual_v2': { native_per_unit: 1,   usd_per_native: 0.0001 },
            'eleven_v3':              { native_per_unit: 1,   usd_per_native: 0.0001 },
            'eleven_flash_v2_5':      { native_per_unit: 0.5, usd_per_native: 0.0001 },
            'eleven_turbo_v2_5':      { native_per_unit: 0.5, usd_per_native: 0.0001 },
        },
        source: 'https://elevenlabs.io/pricing/api',
        checked: '2026-08-22',
        note: '$0.10 per 1,000 characters on Multilingual v2/v3 (1 credit per character); Flash and Turbo bill half a credit per character.',
    },
    'elevenlabs:sfx': {
        unit: 'second', native_unit: 'credit', native_per_unit: 40, usd_per_native: 0.00005,
        source: 'https://elevenlabs.io/docs/capabilities/sound-effects',
        checked: '2026-08-22',
        note: '40 credits per second when a duration is given, 200 flat when the model chooses. $0.12 per minute on the API.',
    },
    'elevenlabs:ambient': {
        unit: 'second', native_unit: 'credit', native_per_unit: 40, usd_per_native: 0.00005,
        source: 'https://elevenlabs.io/docs/capabilities/sound-effects',
        checked: '2026-08-22',
        note: 'Ambient is a looping sound-effect bed, billed as sound generation. The bed is at most 30s regardless of the shot length it is tiled across, so cost does not scale with shot duration.',
    },
    'elevenlabs:music': {
        unit: 'second', native_unit: 'credit', native_per_unit: 15, usd_per_native: 0.00016667,
        source: 'https://elevenlabs.io/pricing/api',
        checked: '2026-08-22',
        note: '$0.15 per minute on the API — about 900 credits per minute, i.e. 15 credits per second.',
    },

    // ── Gridlight ─────────────────────────────────────────────────────────
    // A local/self-hosted gateway. It bills nothing per call; the cost is the
    // machine it runs on. Priced at zero DELIBERATELY and said out loud, so a
    // zero in the report reads as "self-hosted" rather than "we forgot to
    // price this" — the two are indistinguishable otherwise, and the second
    // is the failure this whole file exists to prevent.
    'gridlight:*': {
        unit: 'call', native_unit: 'call', native_per_unit: 1, usd_per_native: 0,
        self_hosted: true,
        source: 'https://github.com/gridlight/film-engine#providers',
        checked: '2026-08-22',
        note: 'Self-hosted gateway: no per-call charge. Compute cost is the GPU it runs on, recorded as gpu_seconds rather than as a provider rate.',
    },
};

/**
 * The published rate for a pair, with a model override applied.
 *
 * Returns null when the pair is unpriced, so the caller can report the gap
 * rather than silently bill it at zero.
 */
function rateFor(provider, capability, model, overrides) {
    const base = RATE_BOOK[`${provider}:${capability}`] || RATE_BOOK[`${provider}:*`];
    if (!base) return null;

    const perModel = (model && base.models && base.models[model]) || {};
    const override = lookupOverride(provider, capability, model, overrides);
    const rate = { ...base, ...perModel, ...override, provider, capability, model: model || null };

    // The single figure the gate and the estimator want: USD per metered unit.
    // Component-priced entries (input/output tokens) have no single rate, so
    // the higher of the two stands in — an estimate that leans expensive fails
    // closed, which is the safe direction for a budget guard.
    rate.usd_per_unit = rate.components
        ? Math.max(rate.components.input, rate.components.output)
        : (rate.native_per_unit || 1) * (rate.usd_per_native || 0);

    rate.inferred = Array.isArray(base.inferred_models) && base.inferred_models.includes(model);
    return rate;
}

/** A per-install rate override from film_provider_rates, if one is stored. */
function lookupOverride(provider, capability, model, overrides) {
    if (!overrides) return {};
    const exact = overrides[`${provider}:${capability}:${model}`];
    const any = overrides[`${provider}:${capability}`];
    return exact || any || {};
}

/**
 * Turn one metered call into money and into the provider's own units.
 *
 * `parts` carries an input/output token split where a capability has one; a
 * usage without it is priced at the flat rate. Everything returned is stored,
 * because a row that keeps only dollars cannot answer "how many credits did
 * that burn", which is the number a prepaid account actually runs out of.
 */
function priceUsage({ provider, capability, model, unit, quantity, parts }, overrides) {
    const rate = rateFor(provider, capability, model, overrides);
    if (!rate) {
        return { amount_usd: 0, native_unit: null, native_quantity: 0, unit_rate: 0,
                 priced: false, reason: `no published rate for ${provider}:${capability}` };
    }

    const qty = Math.max(0, Number(quantity) || 0);
    let amount;

    if (rate.components && parts) {
        // Input and output are different prices. Charging the whole token
        // count at either one is wrong by up to 5x.
        amount = (Number(parts.input) || 0) * rate.components.input
               + (Number(parts.output) || 0) * rate.components.output
               + (Number(parts.cache_read) || 0) * rate.components.input * 0.1
               + (Number(parts.cache_write) || 0) * rate.components.input * 1.25;
    } else {
        amount = qty * rate.usd_per_unit;
    }

    return {
        amount_usd: round6(amount),
        native_unit: rate.native_unit,
        native_quantity: round6(qty * (rate.native_per_unit || 1)),
        unit_rate: rate.usd_per_unit,
        unit,
        priced: true,
        self_hosted: !!rate.self_hosted,
        inferred: !!rate.inferred,
        source: rate.source,
    };
}

function round6(n) {
    return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

/** The whole book, flattened for the settings UI and the rates endpoint. */
function listRates(overrides) {
    const out = [];
    for (const key of Object.keys(RATE_BOOK)) {
        const [provider, capability] = key.split(':');
        const base = RATE_BOOK[key];
        const rate = rateFor(provider, capability, null, overrides);
        out.push({
            provider, capability,
            unit: rate.unit, native_unit: rate.native_unit,
            native_per_unit: rate.native_per_unit,
            usd_per_native: rate.usd_per_native,
            usd_per_unit: rate.usd_per_unit,
            components: rate.components || null,
            models: Object.entries(base.models || {}).map(([id, m]) => ({
                model: id,
                native_per_unit: m.native_per_unit != null ? m.native_per_unit : rate.native_per_unit,
                usd_per_native: m.usd_per_native != null ? m.usd_per_native : rate.usd_per_native,
                components: m.components || null,
                inferred: (base.inferred_models || []).includes(id),
            })),
            self_hosted: !!base.self_hosted,
            source: base.source, checked: base.checked, note: base.note,
            overridden: !!lookupOverride(provider, capability, null, overrides).usd_per_native,
        });
    }
    return out;
}

/**
 * A capability nobody priced bills at zero, and a report of zero is read as
 * "this stage is free" rather than "this stage is untracked". Fail at load,
 * the way flow-cost.js does, rather than at the end of a month.
 */
(function assertCoverage() {
    const providers = require('./providers');
    const gaps = [];
    for (const adapter of providers.list()) {
        for (const capability of adapter.capabilities || []) {
            if (!rateFor(adapter.id, capability)) gaps.push(`${adapter.id}:${capability}`);
        }
    }
    if (gaps.length) throw new Error(`provider-pricing: no rate for ${gaps.join(', ')}`);
})();

module.exports = { BILLING_UNITS, RATE_BOOK, rateFor, priceUsage, listRates, CAPABILITIES };
