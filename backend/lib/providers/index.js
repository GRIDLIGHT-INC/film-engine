/**
 * Provider registry + resolution.
 *
 * resolve(capability, projectConfig) picks the adapter for a capability using:
 *   per-project provider_config  →  env override (PROVIDER_<CAP>)  →  gridlight default.
 *
 * In Phase 1 only the Gridlight adapter is registered, so resolution always
 * returns Gridlight and behavior is unchanged. Later phases register openai /
 * elevenlabs / runway adapters, and a project can opt into them per capability.
 */

const fs = require('fs');
const path = require('path');
const { CAPABILITIES, DEFAULT_PROVIDER, isCapability } = require('./base');
const { gridlightAdapter } = require('./gridlight-adapter');

// id -> adapter
const _registry = new Map();

function register(adapter) {
    if (!adapter || !adapter.id) throw new Error('provider adapter must have an id');
    _registry.set(adapter.id, adapter);
    return adapter;
}

// Auto-load any adapter module in this directory. Each new provider is a single
// file exporting `.adapter` (e.g. providers/openai-image.js → module.exports.adapter),
// so adding a provider never requires editing this file — keeps parallel work
// conflict-free. Support files are skipped.
const _SKIP = new Set(['base.js', 'index.js', 'credentials.js', 'oauth.js']);
function _autoload() {
    let files = [];
    try { files = fs.readdirSync(__dirname); } catch (_) { return; }
    for (const file of files) {
        if (!file.endsWith('.js') || _SKIP.has(file)) continue;
        try {
            const mod = require(path.join(__dirname, file));
            const adapter = mod && mod.adapter;
            if (adapter && adapter.id && !_registry.has(adapter.id)) register(adapter);
        } catch (err) {
            console.error(`[providers] failed to load adapter ${file}:`, err.message);
        }
    }
}

function get(id) {
    return _registry.get(id) || null;
}

function list() {
    return Array.from(_registry.values());
}

/**
 * Resolve the configured provider id for a capability (no adapter lookup).
 * @param {string} capability
 * @param {object} [projectConfig] - parsed film_projects.provider_config
 * @returns {string} provider id
 */
/**
 * Capabilities that should prefer a specific provider over the default when
 * that provider is actually configured — used to favour a licensed catalog
 * over generation for things like ambient beds, where cleared rights matter
 * more than novelty.
 *
 * Empty since the licensed-catalog source adapter was removed: no provider
 * currently serves music/sfx/ambient from a rights-cleared library, so every
 * capability falls through to the normal default. The mechanism is kept
 * because resolveId() still honours it the moment a catalog provider is added
 * back, and an entry naming an unregistered provider would silently do nothing.
 */
/**
 * What a capability resolves to when a project has said nothing.
 *
 * This table existed, was consulted on every resolve, was documented, and was
 * EMPTY -- so it had never once fired. Every unconfigured capability fell to
 * DEFAULT_PROVIDER, meaning a project created today pointed every capability at a
 * local Gridlight service whether or not it was running and whether or not a
 * credentialed hosted adapter was sitting in the registry beside it. The only
 * symptom was a connection refused, at generation time, per capability.
 *
 * A preference only applies when the named provider actually holds a
 * credential (see resolveId), so this cannot swap a working local service for
 * an unusable hosted one. An explicit per-project choice still wins over it,
 * including choosing Gridlight back.
 *
 * Only capabilities with a non-Gridlight adapter appear. A capability is not
 * advertised until at least one adapter serves it; tests derive that invariant
 * from the registry rather than from this comment.
 */
const PREFERRED_WHEN_CONFIGURED = {
    // Text goes to Claude while Gridlight's /chat/intelligent is unusable: its
    // routing sends every question through Qdrant or Neo4j before it reaches a
    // model, so with no vector store up it 500s regardless of payload.
    llm: 'anthropic',
    // Images prefer Google — the Nano Banana models are built for reconciling
    // several reference pictures at once, which is what a keyframe carrying a
    // character plate, a location plate and a scene anchor actually is. This is
    // only the default when a project has expressed no opinion and Google holds
    // a key; an explicit choice and the quality tier both outrank it.
    /*
     * MIRRORS THE STANDARD TIER, and a test holds the two in lockstep.
     *
     * Two orderings for one capability is how the board and the footage came
     * to use different providers. This list cannot simply be derived from
     * lib/quality-tiers.js — that module requires this one to check a tier
     * points at a registered provider, and a top-level require would be a
     * cycle — so it is written out and pinned by assertion instead, the same
     * arrangement flow-seed has with PIPELINE_STEPS.
     */
    image: ['muapi', 'google', 'meshy', 'openai'],
    // Seedance 2.5 for footage. Runway's gen4.5 takes TWO keyframes, first and
    // last, which has been the ceiling on "generate this sequence from these
    // pictures"; Seedance's omni-reference workflow takes thirty. Runway stays
    // registered and any project that pinned it is unaffected.
    video: ['seedance', 'runway'],
    /*
     * The finishing pass. Footage is generated at Seedance's 480p tier to keep
     * exploring a shot affordable, and the pass that takes the finished cut
     * back up to delivery size is the same provider's video-edit workflow at a
     * larger tier -- so the draft and the finish are priced from one rate card
     * and cannot disagree about what a second costs.
     *
     * Before this, `post` fell to Gridlight, which does not implement
     * /postprocess: the cheap half of the plan worked and the half that
     * produces the deliverable did not exist.
     */
    post: 'seedance',
    music: 'elevenlabs',
    voice: 'elevenlabs',
    sfx: 'elevenlabs',
    ambient: 'elevenlabs',
    model3d: 'meshy',
    /*
     * Spatial worlds have exactly one adapter, and Gridlight — the default
     * everything else falls back to — does not serve `world` at all. Without an
     * entry here the capability resolved to NOTHING: the credential could be
     * set, the node listed and the tool exposed, and gen.world could never run.
     * A capability nothing resolves to is indistinguishable from one that was
     * never wired, which is the whole reason this table exists.
     */
    world: 'worldlabs',
};

/**
 * The configuration a new project should be created with.
 *
 * Resolve-time preference already makes an empty config work, but an empty
 * column also makes the Provider Settings panel show nothing while generation
 * quietly uses something -- so the row is written with what it will actually
 * do. Derived from the same table, filtered to what is credentialed now, so a
 * project created before a key is added does not claim a provider it cannot
 * reach.
 */
/**
 * The choices a new project starts with.
 *
 * A PREFERENCE MAY BE A STRING OR AN ORDERED WALK, and this read only strings.
 * When `image` and `video` became walks — `["google","meshy","bfl","openai"]` —
 * `isProviderConfigured()` was handed an ARRAY, looked it up in the registry,
 * got undefined and answered false. So every project created after that change
 * was written with the six string-valued capabilities and **no image or video
 * choice at all**, silently.
 *
 * That is the visible half of a two-part failure: with nothing pinned, the
 * generation path falls through to the same walk and picks whatever is
 * credentialed first, so a project set up for one vendor generated on another
 * and the only symptom was an authentication error naming a company the
 * director never chose.
 *
 * `firstConfigured` is shared with resolveId rather than reimplemented — two
 * readings of one preference table is exactly how they came to disagree.
 */
function firstConfigured(preference) {
    for (const id of Array.isArray(preference) ? preference : [preference]) {
        if (typeof id === 'string' && isProviderConfigured(id)) return id;
    }
    return null;
}

function defaultProviderConfig() {
    const config = {};
    for (const [capability, preference] of Object.entries(PREFERRED_WHEN_CONFIGURED)) {
        const id = firstConfigured(preference);
        if (id) config[capability] = id;
    }
    return config;
}


/*
 * THE LOCAL GATEWAY IS OFF UNTIL SOMEBODY TURNS IT ON.
 *
 * Gridlight declares `requiresKey: false`, so isProviderConfigured() answered
 * TRUE for it whether or not anything was listening — and it is the floor every
 * resolution falls to. A capability with no hosted adapter therefore pointed at
 * a service that may not be running, and the only symptom was a connection
 * refused at generation time, per capability, after the work was committed to.
 *
 * Cached because resolveId runs on every generation and this is a database
 * read; refreshed explicitly when the setting is written, and by the settings
 * route, so turning it on does not need a restart.
 */
let _gatewayEnabled = null;

function localGatewayEnabled() {
    if (_gatewayEnabled !== null) return _gatewayEnabled;
    // The env var is a deployment override, the same shape credentials use: a
    // container that ships with the gateway should not need a UI click.
    if (process.env.GRIDLIGHT_ENABLED) {
        _gatewayEnabled = !/^(0|false|no|off)$/i.test(process.env.GRIDLIGHT_ENABLED);
        return _gatewayEnabled;
    }
    try {
        const { db } = require('../../db/database');
        const row = db.prepare("SELECT value FROM film_app_settings WHERE key = 'gridlight_enabled'").get();
        _gatewayEnabled = !!(row && String(row.value || '').trim());
    } catch (_) {
        // No database yet (a unit test, a first boot): off, because the safe
        // answer to "is a local service running" is no.
        _gatewayEnabled = false;
    }
    return _gatewayEnabled;
}

/** Called when the setting is written, so a restart is not needed. */
function refreshLocalGateway() { _gatewayEnabled = null; }


/**
 * The person's own default generator for a capability, or null.
 *
 * Cached per capability because resolveId runs on every generation and this is
 * a database read; the settings route clears it on write, so changing the
 * setting does not need a restart.
 */
const _accountDefaults = new Map();

function accountDefaultFor(capability) {
    if (capability !== 'image' && capability !== 'video') return null;
    if (_accountDefaults.has(capability)) return _accountDefaults.get(capability);
    let value = null;
    try {
        const { readSettings } = require('../../routes/app-settings');
        const settings = readSettings() || {};
        const raw = settings[`default_${capability}_provider`];
        value = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    } catch (_) { value = null; }
    _accountDefaults.set(capability, value);
    return value;
}

function refreshAccountDefaults() { _accountDefaults.clear(); }

function resolveIdWithReason(capability, projectConfig) {
    const cfg = projectConfig || {};
    /*
     * IMAGES DEFAULT TO THE HOUSE STANDARD, and a choice beats the default.
     *
     * "Any image prompt should be able to be sent to flux 2 dev or any of our
     *  other providers." So a provider somebody NAMED — the project's pin, or a
     * per-generation choice from the confirmation dialog, which arrives here as
     * the same `image` key — is what runs, whoever it names. Only a switched-off
     * local gateway is not reached by naming it: the switch exists to end
     * exactly that. With nothing named, Nano Banana Pro from the first vendor of
     * it that holds a key (MuAPI, then Google, then Meshy); and only when none
     * of them can run does resolution fall through to the ordinary rules.
     */
    if (capability === 'image') {
        const { STANDARD_PROVIDERS } = require('../image-standard');
        if (cfg.image && _registry.has(cfg.image)
            && (cfg.image !== DEFAULT_PROVIDER || localGatewayEnabled())) {
            return { id: cfg.image, source: 'project', explicit: true };
        }
        for (const id of STANDARD_PROVIDERS) {
            if (_registry.has(id) && isProviderConfigured(id)) {
                return { id, source: 'house_standard', explicit: true };
            }
        }
    }
    /*
     * An explicit per-project choice wins — EXCEPT a disabled local gateway.
     *
     * Otherwise the switch is advisory: a project pinned to gridlight before it
     * was switched off would go on using it, which is exactly the state the
     * switch exists to end.
     */
    if (cfg[capability]) {
        if (cfg[capability] !== DEFAULT_PROVIDER || localGatewayEnabled()) {
            return { id: cfg[capability], source: 'project', explicit: true };
        }
    }
    const envKey = `PROVIDER_${String(capability).toUpperCase()}`;
    if (process.env[envKey]) return { id: process.env[envKey], source: 'env', explicit: true };
    if (process.env.PROVIDER_DEFAULT) return { id: process.env.PROVIDER_DEFAULT, source: 'env', explicit: true };

    /*
     * THE QUALITY TIER, consulted here and nowhere else.
     *
     * A project says "precision" rather than "gemini-3-pro-image", so that when
     * a better model arrives the routing table changes and nothing else does.
     * It sits below an explicit pin and below the env override — both of those
     * are somebody stating a provider outright — and above the static
     * preference, which is only a guess about what a project with no opinion
     * would want.
     *
     * A tier that reached no resolution would be the mood-board defect over
     * again: a setting collected, validated, and consumed by nothing. This is
     * the single place every generation path obtains an adapter, so wiring it
     * here means the board, the plates, the orchestrator and the flow canvas
     * cannot disagree about which model a tier means.
     *
     * Required lazily: lib/quality-tiers.js requires THIS module to check that
     * a tier points at a registered provider, and a top-level require would be
     * a cycle resolving to a half-built registry.
     */
    /*
     * The tier governs images ALWAYS, defaulting when the project has said
     * nothing. Consulting it only when set left an un-opinionated project
     * resolving through the static preference instead — a second ordering,
     * which is the thing this table exists to collapse. It showed up
     * immediately: the picker said every tier used Meshy while the project
     * resolved to OpenAI, and both were telling the truth about different code.
     */
    /*
     * THE ACCOUNT DEFAULT OUTRANKS AN UNSET TIER, and loses to a set one.
     *
     * The tier below answers for images even when the project never chose one,
     * because a default tier is how an un-opinionated project gets a sensible
     * model. That is right when nobody has said anything at all — and wrong the
     * moment a person HAS said something, at the account level, about which
     * company they use. Placed after the tier it could never fire for images,
     * which is the whole capability the setting exists for.
     *
     * A tier the project actually set is a deliberate statement about this
     * film and still wins.
     */
    if (!cfg[`${capability}_quality`]) {
        const preset = accountDefaultFor(capability);
        if (preset && isProviderConfigured(preset)) {
            return { id: preset, source: 'account_default', explicit: true };
        }
    }

    if (capability === 'image') {
        try {
            const { resolveTier } = require('../quality-tiers');
            const chosen = resolveTier(cfg.image_quality, cfg);
            if (chosen && chosen.provider) {
                return {
                    id: chosen.provider,
                    // A tier nobody set is a default, not a decision. Reporting
                    // it as "chosen by the quality tier" is how a fallback
                    // reads as a choice in an error message.
                    source: cfg.image_quality ? 'quality_tier' : 'default_quality_tier',
                    explicit: !!cfg.image_quality,
                };
            }
        } catch (_) { /* a broken tier must never block a generation */ }
    }

    /*
     * An ORDERED preference, not a single name.
     *
     * A single name reintroduces the defect this table was populated to fix:
     * naming a provider that holds no key falls straight past every
     * credentialed adapter sitting in the registry beside it and lands on the
     * local gateway, which may not even be running. The only symptom is a
     * connection refused at generation time, per capability. So the preference
     * walks until it finds a provider that can actually run.
     *
     * A bare string is still accepted, because most capabilities have exactly
     * one hosted adapter and a list of one is noise.
     */
    /*
     * THE ACCOUNT DEFAULT, above the built-in walk.
     *
     * The walk below is a list of vendors ranked in this repository. It is a
     * defensible default for a shipped product and the wrong one for a
     * person's own machine, which has an obvious right answer: whoever they
     * actually use. Without this, a project that pinned nothing generated on
     * whichever company came first in an ordering it had never seen, and the
     * failure surfaced as an authentication error naming a vendor the director
     * had never chosen.
     *
     * Read lazily and never allowed to throw: this is on the path of every
     * generation, and a settings table that cannot be read must not stop a
     * render.
     */
    const accountDefault = accountDefaultFor(capability);
    if (accountDefault && isProviderConfigured(accountDefault)) {
        return { id: accountDefault, source: 'account_default', explicit: true };
    }

    const preferred = PREFERRED_WHEN_CONFIGURED[capability];
    for (const id of (Array.isArray(preferred) ? preferred : [preferred])) {
        if (id && isProviderConfigured(id)) return { id, source: 'built_in_preference', explicit: false };
    }

    /*
     * The floor. With the gateway off there is no floor — and NULL is the
     * honest answer, not a fallback: a capability nothing serves that reports a
     * provider is how a run gets started and dies at its last step.
     */
    return localGatewayEnabled()
        ? { id: DEFAULT_PROVIDER, source: 'local_gateway', explicit: false }
        : { id: null, source: 'none', explicit: false };
}

/**
 * WHERE THE ANSWER CAME FROM, not just what it is.
 *
 * A provider id alone cannot distinguish "this project chose Runway" from
 * "nothing was set, so a list in this repository picked one" — and those two
 * produce identical, confident errors when the pick is wrong. A plate that
 * failed on an account set up for Meshy reported `google: API_KEY_INVALID`,
 * which reads as a broken key and was actually a project with no image pin
 * falling through a vendor ranking it had never seen.
 *
 * `explicit` is the load-bearing field: true when a person stated this
 * somewhere, false when we guessed. An error carrying it can say so.
 */
function resolveId(capability, projectConfig) {
    return resolveIdWithReason(capability, projectConfig).id;
}

/** One sentence a person can act on, for an error message. */
function describeResolution(capability, projectConfig) {
    const r = resolveIdWithReason(capability, projectConfig);
    if (!r.id) return `no ${capability} provider is available — nothing serves it and the local gateway is off`;
    const why = {
        project: 'pinned by this project',
        env: 'set by an environment variable',
        house_standard: 'the house image standard — Nano Banana Pro',
        quality_tier: 'chosen by the quality tier',
        account_default: 'your account default',
        default_quality_tier: 'FALLBACK — this project pins no provider and set no quality, '
            + 'so the default tier picked one',
        built_in_preference: 'FALLBACK — this project pins no provider, so a built-in preference order picked one',
        local_gateway: 'FALLBACK — the local gateway, because nothing else is configured',
    }[r.source] || r.source;
    return `resolved provider: ${r.id} (${why})`;
}


/**
 * True when the provider has usable credentials.
 *
 * Checks stored fields as well as an API key: field-based providers that
 * authenticate with something other than a single key (a client id and secret,
 * say) never set api_key, so an apiKey-only check would report them
 * unconfigured no matter what the user had entered.
 */
function isProviderConfigured(id) {
    const adapter = _registry.get(id);
    if (!adapter) return false;

    const needsFields = !!(adapter.connection && Array.isArray(adapter.connection.fields) && adapter.connection.fields.length);
    if (!adapter.requiresKey && !needsFields) {
        // "Nothing to configure" and "switched off" are different answers, and
        // reading the first as ready is what made every readiness check report
        // a gateway that may not be running as available.
        if (id === DEFAULT_PROVIDER) return localGatewayEnabled();
        // A local renderer with nothing to paste is ready only when what it runs on is
        // present: read as ready without asking, a readiness report says go for a
        // render that will produce silence.
        if (typeof adapter.available === 'function') {
            try { return !!adapter.available().ok; } catch (_) { return false; }
        }
        return true;
    }

    try {
        const { getCredential } = require('./credentials');
        const { apiKey, meta } = getCredential(id);
        if (apiKey) return true;
        if (needsFields) {
            // Every REQUIRED field must be present — a client id without its
            // secret cannot authenticate. Optional fields such as a base URL
            // override must not make a valid configuration look incomplete.
            const required = adapter.connection.fields.filter(f => typeof f === 'string' || f.required !== false);
            if (!required.length) return false;
            return required.every(f => {
                const key = typeof f === 'string' ? f : f.key || f.name;
                return key ? !!(meta && meta[key]) : false;
            });
        }
        return false;
    } catch (_) {
        return false;
    }
}

/**
 * Resolve the adapter for a capability. Falls back to Gridlight if the
 * configured provider is unknown or does not support the capability, so a bad
 * config can never break generation.
 * @returns {object} adapter
 */

/**
 * The adapter returned when NOTHING serves a capability.
 *
 * `resolveId` answers null in that case, and null is the honest answer — but
 * thirty-one call sites do `resolve(cap, cfg).generate(...)`, so returning it
 * would turn a missing provider into a TypeError with a stack trace instead of
 * a sentence a director can act on.
 *
 * So the shape stays an adapter and the refusal is the behaviour: every
 * generate answers with what is missing and how to fix it. That is strictly
 * better than the old floor, which handed back a local gateway that may not
 * have been running and failed at the socket.
 */
/**
 * Which models this adapter offers FOR THIS CAPABILITY.
 *
 * There was one flat `adapter.models` per adapter, and four adapters here serve
 * more than one capability -- so the video dialog was handed Runway's IMAGE
 * models, the 3D dialog was handed Meshy's image models, and the llm dialog was
 * handed OpenAI's. A model id only means anything relative to a capability: the
 * same adapter refuses `gen4_image` for a clip and accepts it for a frame.
 *
 * `modelsByCapability` is the statement; `models` stays as the shorthand for the
 * single-capability adapters, which are most of them, so nothing has to be
 * rewritten to keep working. An adapter that says nothing about a capability
 * offers no model choice there, which is different from offering the wrong one.
 *
 * ONE RULE, ONE PLACE. Five call sites were each doing
 * `Object.keys(adapter.models)` to answer this, which is how two of them come to
 * disagree about whether a pinned model is legal.
 */
function modelsFor(adapterOrId, capability) {
    const a = typeof adapterOrId === 'string' ? get(adapterOrId) : adapterOrId;
    if (!a) return null;
    const cap = String(capability || '').trim();
    const byCap = a.modelsByCapability;
    if (byCap && cap) {
        if (!(cap in byCap)) return null;
        return byCap[cap] || null;
    }
    // Single-capability adapters may use the shorthand. An adapter serving
    // several and declaring only a flat list is a bug the tests refuse, but
    // reading it here would still be better than answering "no models".
    return a.models || null;
}

/** The model ids offered for a capability, or null when there is no choice. */
function modelIdsFor(adapterOrId, capability) {
    const m = modelsFor(adapterOrId, capability);
    if (!m) return null;
    const ids = Array.isArray(m)
        ? m.map(x => (typeof x === 'string' ? x : (x && (x.id || x.name)))).filter(Boolean)
        : Object.keys(m);
    return ids.length ? ids : null;
}

/**
 * The model a project pinned for a capability, if the provider that will run it
 * offers that model; otherwise null.
 *
 * A pin (`video_model`, `music_model`, …) is saved in Setup beside the
 * provider. It only means anything relative to the provider it was chosen for,
 * so a pin that the resolving provider does not offer is ignored rather than
 * sent — an unknown name reaches most adapters as their own default, which is
 * a different (often dearer) model than anybody chose.
 */
function pinnedModelFor(capability, projectConfig, adapterOrId) {
    const cfg = projectConfig || {};
    const want = cfg[`${capability}_model`];
    if (typeof want !== 'string' || !want.trim()) return null;
    const adapter = adapterOrId ? (typeof adapterOrId === 'string' ? get(adapterOrId) : adapterOrId)
        : get(resolveId(capability, cfg));
    const offered = adapter ? modelIdsFor(adapter, capability) : null;
    return offered && offered.includes(want.trim()) ? want.trim() : null;
}

function unavailableAdapter(capability) {
    const hosted = list()
        .filter(a => a.id !== DEFAULT_PROVIDER && (a.capabilities || []).includes(capability))
        .map(a => a.id);
    const remedy = hosted.length
        ? `Add an API key for ${hosted.join(' or ')} in Provider Settings`
        : 'No hosted provider serves this capability';
    const error = `nothing is configured to generate ${capability}. ${remedy}, `
        + 'or switch on the local Gridlight endpoints in Settings.';
    return {
        id: null,
        kind: 'unavailable',
        label: `No provider for ${capability}`,
        capabilities: [capability],
        unavailable: true,
        supports: c => c === capability,
        generate: async () => ({ ok: false, status: 503, error }),
        generateStream: async () => ({ ok: false, status: 503, error }),
        meter: () => null,
        health: async () => ({ ok: false, error }),
    };
}

function resolveAdapter_(capability, projectConfig) {
    if (!isCapability(capability)) {
        /*
         * An unknown capability. This handed back the local gateway, which was
         * defensible while the gateway was always there and is not now: it
         * would be the one branch that still routes to a service nobody
         * enabled. A refusal names the capability, which is more use than a
         * connection error against an endpoint that was never going to serve it.
         */
        if (!localGatewayEnabled()) return metered(unavailableAdapter(capability), projectConfig);
        return metered(get(DEFAULT_PROVIDER) || gridlightAdapter, projectConfig);
    }
    const id = resolveId(capability, projectConfig);
    // Nothing serves it: refuse in words rather than falling to a gateway that
    // may not be running, which is what the old floor did.
    if (id === null) return metered(unavailableAdapter(capability), projectConfig);
    const adapter = get(id);
    if (adapter && (!adapter.supports || adapter.supports(capability))) return metered(adapter, projectConfig);
    // A configured provider that is missing or cannot serve this capability.
    if (!localGatewayEnabled()) return metered(unavailableAdapter(capability), projectConfig);
    return metered(get(DEFAULT_PROVIDER) || gridlightAdapter, projectConfig);
}

/**
 * Like resolve(), but guarantees a GENERATOR: if the configured provider for a
 * capability is a source/library adapter (no generate()) or otherwise can't
 * generate, fall back to the default generator so a bad per-capability choice
 * can never crash generation.
 */
/**
 * WHERE THIS CHOICE CAME FROM, in a form something can print.
 *
 * `resolveIdWithReason` has always returned a `source` and an `explicit` flag,
 * and `describeResolution` has always turned them into the right sentence.
 * NOTHING CONSUMED EITHER. Every generation went through `resolveId`, which
 * throws the reason away on its only line -- so a project that lost its `image`
 * pin mid-session fell through the preference walk onto a different vendor, on a
 * different account, and reported nothing at all. It was discovered when that
 * vendor's billing rejected it.
 *
 * `explicit` is the load-bearing field, not the provider name: a project pinned
 * to Google is fine, and a project that pins nothing and silently lands on
 * Google is the failure. Both resolve to the string "google".
 */
function resolutionOf(capability, projectConfig) {
    const r = resolveIdWithReason(capability, projectConfig || {});
    return {
        capability,
        provider: r.id || null,
        source: r.source || null,
        explicit: !!r.explicit,
        note: describeResolution(capability, projectConfig || {}),
    };
}

/** The same answer for every capability, for a settings or preflight panel. */
function resolutionReport(projectConfig) {
    const out = {};
    for (const cap of CAPABILITIES) out[cap] = resolutionOf(cap, projectConfig);
    return out;
}

/**
 * The adapter, carrying its own provenance.
 *
 * Stamped HERE because `resolve()` is the one funnel every generation goes
 * through -- the per-domain routes, the orchestrator and the flow canvas all
 * obtain their adapter from it. Attaching it at each caller instead is how one
 * path reports the reroute and the other three stay silent.
 *
 * NON-ENUMERABLE, exactly as `__project_id` is: a provider_config is
 * round-tripped through the settings panel, and a diagnostic field that rode
 * along would be written back into the column on the next save.
 *
 * It must never be the reason a generation cannot happen, so the stamp is
 * guarded -- the rule metering and fingerprinting already follow.
 */
/**
 * The adapter, with its bookkeeping attached.
 *
 * `onHandle` and `onTimeout` are injected HERE rather than passed by each
 * route, for the reason the provenance stamp above is: `resolve()` is the one
 * funnel every generation goes through, and threading a callback through the
 * per-domain routes, the orchestrator and the flow canvas is how two of the
 * three end up not recording anything.
 *
 * The project, shot and scene come from the config the caller already tagged --
 * `provider-config.tag()` attaches them non-enumerably, and `metered()` reads
 * the same three fields to attribute spend. So a handle is attributed exactly
 * as its cost is, from one source.
 */
function withJobRecording_(adapter, capability, projectConfig) {
    /*
     * EVERY GENERATION IS A ROW WHILE IT RUNS (PGN-001), not only the async
     * ones. The Production graph reads film_generation_jobs to learn what is
     * running, and a synchronous image or voice line with no row was running
     * invisibly. A refusal (the unavailable adapter) is not a generation, and
     * an llm call is reasoning rather than something a director queues.
     */
    if (!adapter || typeof adapter.generate !== 'function' || !adapter.id || adapter.unavailable) return adapter;
    if (capability === 'llm') return adapter;
    const cfg = projectConfig || {};
    const jobs = require('../generation-jobs');
    const progress = require('../generation-progress');
    const inner = adapter.generate.bind(adapter);
    const innerStream = typeof adapter.generateStream === 'function' ? adapter.generateStream.bind(adapter) : null;

    const open = (cap, o) => progress.start({
        provider: adapter.id, capability: cap || capability,
        projectId: cfg.__project_id || null,
        shotId: cfg.__shot_id || null,
        sceneId: cfg.__scene_id || null,
        meta: Object.assign({}, (o && o.jobMeta) || {}),
    });

    /*
     * A settled row, from a result. `pending` means the provider still holds a
     * job this call stopped waiting for: the row stays open and collectable. A
     * row left pending after a call that plainly finished would offer a collect
     * for a job already delivered, which is how a frame gets paid for twice.
     */
    const settle = (jobId, result) => {
        try {
            progress.flush(jobId);
            if (!jobId) return;
            if (result && result.ok) jobs.complete(jobId, {});
            else if (!(result && result.pending)) jobs.fail(jobId, result && result.error);
        } catch (_) { /* bookkeeping never fails a generation */ }
    };

    const wrapped = Object.create(adapter);
    wrapped.generate = async (cap, payload, opts) => {
        /*
         * THE PROJECT'S PINNED MODEL, applied once for every capability.
         *
         * Setup lets a project pin a model per capability. Every route builds
         * its own payload, so reading the pin at each of them is how three of
         * nine end up honouring it. Here, at the one funnel: a payload that
         * names no model gets the pinned one, when this adapter offers it. A
         * model the caller named (a per-generation choice, a tier, the house
         * image standard) is never overwritten.
         */
        try {
            if (payload && typeof payload === 'object' && !Array.isArray(payload) && !payload.model) {
                const pinned = pinnedModelFor(cap || capability, cfg, adapter);
                if (pinned) payload.model = pinned;
            }
        } catch (_) { /* a pin that cannot be read never blocks a generation */ }
        const o = Object.assign({}, opts || {});
        let jobId = open(cap, o);
        /*
         * PROGRESS REACHES THE ROW (PGN-002). Every adapter reports through
         * opts.onProgress({ percent, phase }); the funnel writes it to the job
         * row the page reads, and still hands it to the caller's own painter.
         */
        const theirProgress = o.onProgress;
        o.onProgress = evt => {
            try { if (jobId && evt) progress.report(jobId, evt); } catch (_) { /* never fails a render */ }
            if (typeof theirProgress === 'function') { try { theirProgress(evt); } catch (_) { /* the caller's painter */ } }
        };
        if (adapter.asyncGeneration) {
            const theirs = o.onHandle;
            o.onHandle = (requestId, meta) => {
                /*
                 * WHAT THIS WILL COST, WORKED OUT WHILE THE PAYLOAD IS STILL HERE.
                 *
                 * Metering happens on the RESULT — and a generation that
                 * outruns the host's 60-second window never produces one here.
                 * It is delivered later by `generation_collect`, which has the
                 * handle and not the payload. An adapter's `meter()` is a pure
                 * function of the payload for everything priced per second or
                 * per call, so the answer is knowable NOW, and stamped onto the
                 * handle `collect` can post the spend without the request.
                 */
                let meterPlan = null;
                try {
                    if (typeof adapter.meter === 'function') {
                        const u = adapter.meter(cap || capability, payload, null);
                        if (u && Number(u.quantity) > 0) {
                            meterPlan = { unit: u.unit, quantity: u.quantity, model: u.model || null,
                                          parts: u.parts || null };
                        }
                    }
                } catch (_) { /* a price that cannot be worked out is not a blocker */ }
                /*
                 * WHAT THIS GENERATION IS, not just which capability it used:
                 * the caller's jobMeta says which sequence leg or shot, so a
                 * collected result can be FILED. Adapter facts win on a clash.
                 */
                const m = Object.assign({}, o.jobMeta || {}, meta || {}, meterPlan ? { meter: meterPlan } : {});
                // The row opened at the start becomes the handle; if that write
                // failed, record() still files the handle on its own.
                jobId = jobId
                    ? progress.attachHandle(jobId, requestId, m)
                    : jobs.record({ provider: adapter.id, capability: cap || capability, requestId,
                        projectId: cfg.__project_id || null, shotId: cfg.__shot_id || null,
                        sceneId: cfg.__scene_id || null, meta: m });
                if (typeof theirs === 'function') { try { theirs(requestId, meta); } catch (e) { console.error('[providers] an onHandle callback threw:', e.message); } }
                return jobId;
            };
            o.onTimeout = (requestId, waitedMs) =>
                jobs.timedOut({ provider: adapter.id, jobId, requestId, waitedMs });
        }
        let result;
        try { result = await inner(cap, payload, o); }
        catch (err) { settle(jobId, { ok: false, error: err && err.message }); throw err; }
        settle(jobId, result);
        /*
         * ONE RESULT SHAPE FOR THE SAVE. Every route persists `result.data`,
         * and the async adapters (Runway, Seedance/MuAPI) answer with a
         * top-level `url` and no `data` — so their finished, paid-for clip
         * reached the saver as nothing and was refused as "neither media bytes
         * nor a media URL". Filled here, once, rather than at 28 call sites.
         */
        if (result && result.ok && result.data === undefined && typeof result.url === 'string' && result.url) {
            result.data = { url: result.url };
        }
        return result;
    };
    if (innerStream) {
        wrapped.generateStream = async (cap, payload, res, callbacks) => {
            const jobId = open(cap, null);
            const cb = Object.assign({}, callbacks || {});
            const theirs = cb.onProgress;
            cb.onProgress = evt => {
                try {
                    const e = evt || {};
                    const pct = e.percent !== undefined ? e.percent
                        : (Number(e.total) > 0 && Number(e.step) >= 0 ? (Number(e.step) / Number(e.total)) * 100 : undefined);
                    if (jobId) progress.report(jobId, { percent: pct, phase: e.phase || e.event });
                } catch (_) { /* never fails a render */ }
                if (typeof theirs === 'function') return theirs(evt);
            };
            let result;
            try { result = await innerStream(cap, payload, res, cb); }
            catch (err) { settle(jobId, { ok: false, error: err && err.message }); throw err; }
            settle(jobId, result);
            return result;
        };
    }
    return wrapped;
}

function resolve(capability, projectConfig) {
    const adapter = withJobRecording_(resolveAdapter_(capability, projectConfig), capability, projectConfig);
    try {
        if (adapter && !Object.prototype.hasOwnProperty.call(adapter, '__resolution')) {
            Object.defineProperty(adapter, '__resolution', {
                value: resolutionOf(capability, projectConfig),
                enumerable: false, configurable: true, writable: true,
            });
        } else if (adapter) {
            adapter.__resolution = resolutionOf(capability, projectConfig);
        }
    } catch (_) { /* provenance is a diagnostic, never a blocker */ }
    return adapter;
}

function resolveGenerator(capability, projectConfig) {
    const adapter = resolve(capability, projectConfig);
    if (adapter && typeof adapter.generate === 'function') return adapter;
    if (!localGatewayEnabled()) return metered(unavailableAdapter(capability), projectConfig);
    return metered(get(DEFAULT_PROVIDER) || gridlightAdapter, projectConfig);
}

/**
 * Wrap an adapter so the call it is about to make is recorded.
 *
 * This is THE choke point. Thirty-one call sites across routes/ and lib/ reach
 * a provider, and every one of them gets its adapter from resolve() or
 * resolveGenerator() — so metering installed here covers all of them, and a
 * route added next month inherits it with nothing to remember. Instrumenting
 * the call sites individually is how twenty-nine of thirty-one end up
 * instrumented, and the gap is invisible: an untracked generation looks exactly
 * like one that never ran.
 *
 * Attribution rides in on the config object. Every call site already writes
 * `resolve('video', providerConfigFor(scene.project_id))` — the project id is
 * right there and was being discarded one line before it was needed.
 * lib/provider-config.js stamps it on, so the meter reads it with no call-site
 * edit at all.
 *
 * Loaded lazily because lib/usage-meter.js requires the pricing book, which
 * asserts its coverage against THIS registry at load — requiring it at the top
 * would be a cycle that resolves to a half-built registry and passes vacuously.
 */
function metered(adapter, projectConfig) {
    if (!adapter) return adapter;
    try {
        const { meterAdapter } = require('../usage-meter');
        const cfg = projectConfig || {};
        if (!cfg.__project_id) return meterAdapter(adapter, {});
        return meterAdapter(adapter, {
            projectId: cfg.__project_id,
            shotId: cfg.__shot_id || null,
            sceneId: cfg.__scene_id || null,
        });
    } catch (_) {
        // Metering must never be the reason a generation cannot happen.
        return adapter;
    }
}

// Register the default provider, then auto-load any additional adapters.
register(gridlightAdapter);
_autoload();

/**
 * FEM-001: the self-hosted models in gridlight's catalog, resolved through this
 * registry under Film Engine's own capability names. They sit BESIDE the
 * adapters rather than inside any adapter's model list, so no existing
 * provider's models change; the adapter that dispatches them arrives with
 * FEM-003 and reads this. Whether a model may actually run is
 * `model-catalog.admits`, which fails closed.
 */
function catalogModelIds(capability) {
    const cat = require('../model-catalog').current();
    if (!cat || !Array.isArray(cat.models)) return [];
    return cat.models.filter(m => Array.isArray(m.capabilities) && m.capabilities.includes(capability)).map(m => m.id);
}
function resolveCatalogModel(capability, modelId) {
    const mc = require('../model-catalog');
    const cat = mc.current();
    const m = mc.findModel(cat, modelId);
    if (!m || !Array.isArray(m.capabilities) || !m.capabilities.includes(capability)) return null;
    return { capability, model: m, catalog_version: cat.catalog_version, source: 'gridlight-catalog' };
}

module.exports = {
    modelsFor, modelIdsFor, pinnedModelFor, catalogModelIds, resolveCatalogModel,
    firstConfigured, resolveIdWithReason, resolutionOf, resolutionReport, describeResolution, accountDefaultFor, refreshAccountDefaults, register, get, list, resolve, resolveId, resolveGenerator, metered, withJobRecording: withJobRecording_, isProviderConfigured, defaultProviderConfig, localGatewayEnabled, refreshLocalGateway, PREFERRED_WHEN_CONFIGURED, CAPABILITIES };
