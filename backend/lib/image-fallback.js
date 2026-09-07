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
function imageProviderChain(projectConfig, opts) {
    const preferred = providers.resolveGenerator('image', projectConfig || {});
    /*
     * Carried so a failure can say WHERE the provider came from.
     *
     * A plate that failed on an account set up for Meshy reported
     * `google: API_KEY_INVALID` — which reads as a broken key and was really a
     * project with no image pin falling through a vendor ranking written in
     * this repository. The key was beside the point; the routing was the fault,
     * and nothing in the message could tell them apart.
     */
    const resolution = providers.resolveIdWithReason('image', projectConfig || {});
    const chain = [];
    const seen = new Set();

    const usable = a => a
        && a.supports && a.supports('image')
        && providers.isProviderConfigured(a.id);

    if (usable(preferred)) {
        chain.push(preferred);
        seen.add(preferred.id);
    }
    chain.resolution = resolution;

    for (const adapter of providers.list()) {
        if (seen.has(adapter.id) || !usable(adapter)) continue;
        // providers.list() hands back RAW adapters — resolveGenerator is what
        // installs metering, and only the lead provider comes through it. Left
        // alone, every image served AFTER a refusal would be free in the
        // report, which is precisely the shot a director paid twice for.
        chain.push(providers.metered(adapter, projectConfig || {}));
        seen.add(adapter.id);
    }

    /*
     * A LOCATION PLATE NEEDS A PROVIDER THAT CAN BE TOLD A SIZE.
     *
     * Reaching the 2048 floor is a provider choice, not a setting: a
     * `ratio-only` adapter turns a width and height into an aspect ratio and
     * picks the pixels itself, so asking harder achieves nothing. When a floor
     * is required, capable providers lead.
     *
     * STABLE, and only when a floor is asked for. Reordering every image
     * request would silently move a whole production's frames to another
     * vendor, which is the "spend that goes somewhere nobody chose" defect this
     * codebase has already paid for once.
     *
     * And a demotion is REPORTED. If the project pinned a provider that cannot
     * serve the floor, the plate is generated somewhere the director did not
     * choose — defensible, and it has to be said, or a bill arrives from a
     * company nobody signed up with.
     */
    const needsPixels = opts && Number(opts.needsPixels) > 0 ? Number(opts.needsPixels) : 0;
    if (!needsPixels) return chain;
    return orderForFloor(chain, needsPixels);
}

/**
 * Put the providers that can serve a floor at the front, and say if that moved
 * anything.
 *
 * PURE, and separate from imageProviderChain, so the ordering can be exercised
 * over a known set of adapters. Testing it through the live chain makes the
 * check depend on which credentials happen to be present in the shell — and a
 * check that only runs when there happens to be data is a check that does not
 * run. On this machine that chain is EMPTY, so every assertion about ordering
 * would have passed over nothing.
 */
function orderForFloor(chain, needsPixels) {
    const { canReachFloor, capableProviders } = require('./reference-plates');
    const able = chain.filter(a => canReachFloor(a, needsPixels));
    const rest = chain.filter(a => !canReachFloor(a, needsPixels));
    const ordered = able.concat(rest);
    ordered.resolution = chain.resolution;

    const wasFirst = chain[0] && chain[0].id;
    const nowFirst = ordered[0] && ordered[0].id;
    const moved = wasFirst && nowFirst && wasFirst !== nowFirst;
    ordered.floor = {
        needed_pixels: needsPixels,
        capable: capableProviders(needsPixels),
        moved: moved ? { from: wasFirst, to: nowFirst } : null,
        why: moved
            ? `${wasFirst} cannot be told an image size, or cannot reach `
              + `${needsPixels.toLocaleString()} pixels, so this plate is generated on ${nowFirst} `
              + 'instead. A location plate is re-shot from by every shot in the scene, so it is the '
              + 'one plate where the size has to be real.'
            : null,
    };
    return ordered;
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
/**
 * Walk a chain, asking for the payload each adapter should receive.
 *
 * `payloadOrFactory` is either a function — called once per adapter, so the
 * caller can rebuild the request against THAT adapter's ceiling — or a single
 * prebuilt payload for callers that predate the factory.
 *
 * The flat form cannot be rebudgeted. By the time a payload exists the prompt
 * is one string with its contributor boundaries, priorities and shot context
 * gone, so the only thing an implementation could do is slice it — which is the
 * mid-clause amputation the ceiling work exists to remove. So a flat payload
 * that overruns an adapter's declared limit SKIPS that adapter and says why.
 * That sacrifices fallback coverage and lies about nothing.
 *
 * Injectable so it can be exercised over fakes. The test that used to observe
 * this had to patch real credentialed adapters, bound its patch to objects the
 * metered chain never called, and billed a live generation while proving
 * nothing.
 */

/** This adapter's IMAGE model ids, via the registry's one rule. */
function imageModelIds(adapter) {
    try { return require('./providers').modelIdsFor(adapter, 'image'); }
    catch (_) { return adapter && adapter.models ? Object.keys(adapter.models) : null; }
}

async function runImageFallbackChain(chain, payloadOrFactory, opts) {
    const adapters = Array.isArray(chain) ? chain : [];
    if (!adapters.length) {
        return { ok: false, error: 'no credentialed image provider is available', _chain: [] };
    }
    const factory = typeof payloadOrFactory === 'function' ? payloadOrFactory : null;

    const attempts = [];
    let last = null;

    for (const adapter of adapters) {
        const payload = factory ? factory(adapter) : payloadOrFactory;
        const limit = Number(adapter && adapter.promptLimit) || 0;
        const chars = String((payload && payload.prompt) || '').length;

        // Only the flat path can overrun: a factory is expected to build to fit.
        if (limit && chars > limit) {
            attempts.push({ provider: adapter.id, ok: false, skipped: true,
                error: `skipped: prompt is ${chars} characters against this provider's `
                    + `${limit}-character limit, and a prebuilt prompt cannot be rebudgeted `
                    + 'without cutting it mid-clause' });
            continue;
        }

        /*
         * A MODEL BELONGS TO ONE PROVIDER.
         *
         * The chain deliberately walks past a provider that declines, which
         * means the adapter changes mid-flight while the payload does not.
         * Carrying "gemini-3-pro-image" onward to OpenAI is a rejected request
         * — and it would be rejected for a reason that looks nothing like the
         * refusal that started the walk, so the fallback would appear broken
         * rather than the model name being wrong. Strip a model that is not
         * this adapter's; the tier names the right one below.
         */
        if (payload && payload.model
            && ((payload.__model_for && payload.__model_for !== adapter.id)
                || (imageModelIds(adapter) && !imageModelIds(adapter).includes(payload.model)))) {
            delete payload.model;
            delete payload.__model_for;
        }

        const result = await adapter.generate('image', payload, opts || {});
        attempts.push({ provider: adapter.id, ok: !!result.ok, error: result.ok ? null : result.error });

        if (result.ok) {
            return { ...result, provider: result.provider || adapter.id, _chain: attempts };
        }
        last = result;

        // Our own bad request will fail identically everywhere — stop.
        if (!isRefusal(result.error)) break;
    }

    /*
     * A FAILURE SAYS WHICH PROVIDER RAN AND WHY IT WAS CHOSEN.
     *
     * Without this the message is the upstream one — "google:
     * API_KEY_INVALID" — which blames a credential when the real fault may be
     * that nothing pinned a provider and a built-in ordering picked a company
     * the director never named. The two need different fixes and read
     * identically.
     */
    const failed = { ...(last || { ok: false, error: 'image generation failed' }), _chain: attempts };
    const r = chain && chain.resolution;
    if (r && !r.explicit) {
        failed.resolution = r;
        failed.error = `${failed.error || 'image generation failed'} — resolved provider: ${r.id} `
            + '(FALLBACK: this project pins no image provider, so it was chosen for you). '
            + 'Set one in Provider Settings, or set an account default.';
    } else if (r) {
        failed.resolution = r;
    }
    return failed;
}

async function generateImageWithFallback(payloadOrFactory, projectConfig, opts) {
    const chain = imageProviderChain(projectConfig);
    if (!chain.length) {
        // Naming the capability and the remedy, rather than letting this
        // surface as a 502 wrapping a truncated upstream payload.
        return {
            ok: false,
            error: 'no image provider is configured — set one in Provider Settings, '
                + 'add an account default, or switch on the local gateway',
            resolution: chain.resolution || { id: null, source: 'none', explicit: false },
            _chain: [],
        };
    }
    return runImageFallbackChain(chain, payloadOrFactory, opts);
}

module.exports = {
    orderForFloor,
    runImageFallbackChain,
    imageProviderChain,
    generateImageWithFallback,
    isRefusal,
    REFUSAL_PATTERNS,
    OUR_FAULT_PATTERNS,
};
