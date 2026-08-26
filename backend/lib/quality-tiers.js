/**
 * QUALITY IS THE CHOICE. THE PROVIDER IS AN IMPLEMENTATION DETAIL.
 *
 * "I would not expose provider names prominently in the normal UI. I'd have
 *  Draft — Standard — Precision, with an optional Advanced → Model selector.
 *  That protects you when, six months from now, a new model beats Nano Banana:
 *  you change the routing table rather than redesigning Film Engine."
 *
 * That is exactly what this file is, and the reason it is a TABLE rather than a
 * set of conditionals scattered through the generation paths. Everything in this
 * engine already reaches a generator through resolve(capability, config); a tier
 * is one more thing that config can say. A router living anywhere else would be
 * a second way to choose a provider, and two ways to choose is precisely how the
 * board and the footage came to use different ones.
 *
 * ── What each tier is FOR ────────────────────────────────────────────────
 *
 *   draft      FLUX.2 Klein        cheap variations, thumbnails, exploring
 *   standard   Nano Banana 2       most storyboard frames
 *   precision  Nano Banana Pro     difficult continuity and blocking
 *
 * ── Meshy leads, and that is not a compromise ────────────────────────────
 *
 * Meshy PROXIES the same models: `nano-banana`, `nano-banana-2` and
 * `nano-banana-pro` are Google's, reached through an account that is already
 * credited here. Same three tiers, same three models, on credits already
 * bought — and priced per model rather than flat, so Draft genuinely costs a
 * third of Precision (3 credits against 9) instead of the difference being
 * notional.
 *
 * One real limitation, stated because it is invisible otherwise: Meshy's
 * adapter is `referenceMode: 'edit'` — it routes any reference to
 * `/image-to-image`. That is fine for a keyframe conditioned on plates, which
 * is what the board does all day, and it is why a NEW location view has to be
 * painted from words on this provider rather than turned from an existing
 * plate. A direct Google key is `condition` and does not have that limit; pin
 * it under Advanced if that trade matters more than the credits.
 *
 * with GPT Image as the alternate on every tier — the second opinion for when
 * one house's models keep refusing or keep getting the same thing wrong. That is
 * not redundancy for its own sake: the compass-view work established that a
 * provider's refusals are not deterministic, so "try elsewhere" is a routing
 * decision rather than a verdict on the shot.
 *
 * ── Why a tier FALLS THROUGH rather than failing ─────────────────────────
 *
 * A tier names an ORDER, not a provider. A director who has configured only
 * OpenAI must still be able to press Standard and get a frame — a menu whose
 * entries fail at generation time because a key is missing is worse than no
 * menu, because the failure arrives after the decision. So resolution walks the
 * order looking for a CREDENTIAL, and reports which it landed on and why.
 */

const providers = require('./providers');
const { hasCredential } = require('./providers/credentials');

/**
 * The routing table. Provider ids in preference order; the model each tier wants
 * from that provider named alongside, because "google" alone does not say
 * whether this is the cheap flash model or the pro one — and the whole point of
 * the tier is that difference.
 */
const IMAGE_TIERS = Object.freeze({
    draft: Object.freeze({
        label: 'Draft',
        why: 'Cheap variations and thumbnails — for exploring a composition before committing to it. '
            + 'Exploration has to be cheap, or nobody explores and every idea costs a finished frame.',
        order: ['meshy', 'bfl', 'google', 'openai', 'gridlight'],
        models: Object.freeze({
            meshy: 'nano-banana', bfl: 'flux-2-klein', google: 'gemini-3.1-flash-lite-image',
        }),
    }),
    standard: Object.freeze({
        label: 'Standard',
        why: 'Most storyboard frames. Built for reconciling several reference images at once, '
            + 'which is what a keyframe carrying a character plate, a location plate and an anchor actually is.',
        order: ['meshy', 'google', 'bfl', 'openai', 'runway', 'gridlight'],
        models: Object.freeze({
            meshy: 'nano-banana-2', google: 'gemini-3.1-flash-image', bfl: 'flux-2-pro',
        }),
    }),
    precision: Object.freeze({
        label: 'Precision',
        why: 'Difficult continuity and blocking — a frame that must hold an established location, '
            + 'a specific subject and a camera change together. Costs more per image and saves the retries.',
        order: ['meshy', 'google', 'bfl', 'openai', 'gridlight'],
        models: Object.freeze({
            meshy: 'nano-banana-pro', google: 'gemini-3-pro-image', bfl: 'flux-2-max',
        }),
    }),
});

const DEFAULT_TIER = 'standard';

/**
 * Which tier a request needs, judged from the request itself.
 *
 * "A simple new establishing shot might go straight to Nano Banana 2. But a
 *  request like the 3E dragon edit — the existing shot, another pose reference,
 *  established geography and a camera change — could automatically route to
 *  Nano Banana Pro."
 *
 * So the two things that make a request hard are how many references must be
 * RECONCILED and whether it is changing an existing frame rather than making a
 * new one. Both are already known at payload time; neither has to be asked.
 */
function autoTier(request) {
    const r = request || {};
    // Exploring is a stated intent and outranks everything: the director has
    // said they are trying things, and trying things must stay cheap.
    if (r.exploring) return 'draft';

    const refs = Number(r.referenceCount || 0);
    /*
     * Editing an existing frame while reconciling other pictures is the hard
     * case by construction — the frame must survive AND the references must
     * land. Three is the threshold because that is where the old reference
     * ceiling sat: below it, every provider here could hold the request.
     */
    if (r.editingExistingFrame && refs >= 3) return 'precision';
    if (refs >= 5) return 'precision';
    return DEFAULT_TIER;
}

/**
 * Resolve a tier to a provider that can actually run.
 *
 * @param {string} tier              draft | standard | precision | auto
 * @param {object} config            the project's provider_config
 * @param {object} [request]         what auto judges from
 * @returns {{provider, model, tier, reason, pinned, fallback}}
 */
function resolveTier(tier, config, request) {
    const cfg = config || {};

    /*
     * AN EXPLICIT CHOICE BEATS THE TABLE, ALWAYS.
     *
     * The Advanced escape hatch. A director who has learned that one model
     * handles their dragon must not be quietly overruled by a routing rule —
     * and a table that cannot be overridden is a reason to stop using tiers at
     * all, the same argument every ignore_* override in this codebase rests on.
     */
    if (cfg.image && providers.get(cfg.image)) {
        /*
         * Pinning a PROVIDER is not pinning a MODEL.
         *
         * A project that chose Google and asked for Precision wants Nano Banana
         * Pro, not "Google, model unspecified" — dropping the tier here made
         * Standard and Precision produce byte-identical requests on a pinned
         * project, which is the feature failing silently on exactly the
         * configuration a deliberate user ends up with.
         */
        const tierName = String(tier || cfg.image_quality || '').toLowerCase();
        const spec = IMAGE_TIERS[tierName === 'auto' ? autoTier(request) : tierName];
        const model = cfg.image_model || (spec && spec.models[cfg.image]) || null;
        return {
            provider: cfg.image,
            model,
            tier: spec ? (tierName === 'auto' ? autoTier(request) : tierName) : null,
            pinned: true,
            reason: `This project explicitly chose ${cfg.image}`
                + (model ? `, and ${spec && spec.models[cfg.image] === model && !cfg.image_model ? 'the ' + spec.label.toLowerCase() + ' tier asks it for ' : 'it is pinned to '}${model}.` : ', so the quality tier was not consulted.'),
        };
    }

    const wanted = String(tier || cfg.image_quality || DEFAULT_TIER).toLowerCase();
    const resolved = wanted === 'auto' ? autoTier(request) : wanted;
    const spec = IMAGE_TIERS[resolved] || IMAGE_TIERS[DEFAULT_TIER];
    const name = IMAGE_TIERS[resolved] ? resolved : DEFAULT_TIER;

    const skipped = [];
    for (const id of spec.order) {
        const adapter = providers.get(id);
        if (!adapter) continue;
        // Gridlight is the local gateway and needs no key — it is the floor of
        // every order so a tier can never resolve to nothing.
        if (adapter.requiresKey && !hasCredential(id)) { skipped.push(id); continue; }
        const first = spec.order.find(x => providers.get(x));
        return {
            provider: id,
            model: spec.models[id] || null,
            tier: name,
            pinned: false,
            fallback: id !== first,
            reason: skipped.length
                ? `${spec.label} prefers ${skipped.join(', ')}, which ${skipped.length > 1 ? 'have' : 'has'} no API key here, so it used ${id}.`
                : `${spec.label} routes to ${id}${spec.models[id] ? ' (' + spec.models[id] + ')' : ''}.`,
        };
    }

    // Nothing in the order is registered at all. Say so rather than returning a
    // provider that does not exist — a resolution that lies fails at spend time.
    return {
        provider: null,
        model: null,
        tier: name,
        pinned: false,
        reason: `${spec.label} has no usable provider: ${spec.order.join(', ')} are unregistered or uncredentialed.`,
    };
}

/** What the UI shows: the tiers, and what each would actually use right now. */
function tierMenu(config) {
    return Object.entries(IMAGE_TIERS).map(([id, spec]) => {
        const r = resolveTier(id, { ...(config || {}), image: undefined });
        return {
            id,
            label: spec.label,
            why: spec.why,
            resolves_to: r.provider,
            model: r.model,
            available: !!r.provider,
            reason: r.reason,
        };
    });
}

module.exports = { IMAGE_TIERS, DEFAULT_TIER, autoTier, resolveTier, tierMenu };
