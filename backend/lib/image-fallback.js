/**
 * Falling through image providers on refusal.
 *
 * Three adapters serve `image`, and the pipeline used exactly one: whichever
 * resolveGenerator returned. So when Runway declined a prompt on moderation,
 * all eight shots failed together while two other credentialed image providers
 * sat in the registry untried.
 *
 * The refusal is not even deterministic — the same prompt for the same shot
 * passed and then failed minutes apart. That makes "the provider said no" a
 * condition to route around rather than a verdict on the shot, and it is why
 * this is a chain rather than a retry: re-sending to the same provider bets on
 * a coin flip, while advancing asks someone else.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It does not re-decide which provider a production uses. The project's
 *    explicit choice always leads; the rest are there for when that choice
 *    refuses, and provenance records which one actually served.
 *  - It does not replay a MALFORMED request. A 400 on a bad ratio is our bug,
 *    and sending it to three providers in turn buys three identical failures
 *    and three bills.
 */

const providers = require('./providers');

/**
 * Errors worth asking a different provider about.
 *
 * Refusals, exhausted credit, rate limits and outages are all "this provider
 * cannot do it right now" — a different one might. Validation errors are ours.
 */
const REFUSAL_PATTERNS = [
    /moderation/i,
    /content\s*polic/i,
    /safety/i,
    /refus/i,
    /\bblocked\b/i,
    // Providers word exhaustion differently: OpenAI says "no credits
    // remaining", Runway "do not have enough credits". Matching one phrasing
    // meant the chain stopped on a provider it should have walked past.
    /credit/i,
    /insufficient/i,
    /quota/i,
    /billing/i,
    /\b429\b/,
    /rate.?limit/i,
    /\b5\d\d\b/,
    /unavailable/i,
    /ECONNREFUSED/i,
    /timed? ?out/i,
];

/** Ours, not theirs — never worth replaying. */
const OUR_FAULT_PATTERNS = [
    /validation of body failed/i,
    /invalid option/i,
    /is required\b/i,
    /unsupported capability/i,
];

function isRefusal(error) {
    const text = String(error || '');
    if (!text.trim()) return false;
    if (OUR_FAULT_PATTERNS.some(re => re.test(text))) return false;
    return REFUSAL_PATTERNS.some(re => re.test(text));
}

/**
 * Ordered image providers to try.
 *
 * The project's configured provider leads — resolveGenerator already applies
 * per-project config, env and the preference table, so this respects every
 * layer of that decision and only appends alternatives behind it.
 *
 * Uncredentialed adapters are excluded rather than tried and failed: a chain
 * that spends a hop discovering a missing key is a slower way to reach the same
 * place. Gridlight is included when reachable-by-configuration, since it needs
 * no key by design.
 */
function imageProviderChain(projectConfig) {
    const preferred = providers.resolveGenerator('image', projectConfig || {});
    const chain = [];
    const seen = new Set();

    const usable = a => a
        && a.supports && a.supports('image')
        && providers.isProviderConfigured(a.id);

    if (usable(preferred)) {
        chain.push(preferred);
        seen.add(preferred.id);
    }

    for (const adapter of providers.list()) {
        if (seen.has(adapter.id) || !usable(adapter)) continue;
        chain.push(adapter);
        seen.add(adapter.id);
    }
    return chain;
}

/**
 * Generate an image, advancing through the chain on refusal.
 *
 * Returns the provider result with `_chain` describing what happened, so a
 * caller can report "runway declined, openai served this" rather than leaving
 * a director to wonder why two frames look different.
 *
 * Each provider is tried at most once, so worst-case spend is bounded by the
 * number of credentialed providers rather than by a retry count.
 */
async function generateImageWithFallback(payload, projectConfig, opts) {
    const chain = imageProviderChain(projectConfig);
    if (!chain.length) {
        return { ok: false, error: 'no credentialed image provider is available', _chain: [] };
    }

    const attempts = [];
    let last = null;

    for (const adapter of chain) {
        const result = await adapter.generate('image', payload, opts || {});
        attempts.push({ provider: adapter.id, ok: !!result.ok, error: result.ok ? null : result.error });

        if (result.ok) {
            return { ...result, provider: result.provider || adapter.id, _chain: attempts };
        }
        last = result;

        // Our own bad request will fail identically everywhere — stop.
        if (!isRefusal(result.error)) break;
    }

    return { ...(last || { ok: false, error: 'image generation failed' }), _chain: attempts };
}

module.exports = {
    imageProviderChain,
    generateImageWithFallback,
    isRefusal,
    REFUSAL_PATTERNS,
    OUR_FAULT_PATTERNS,
};
