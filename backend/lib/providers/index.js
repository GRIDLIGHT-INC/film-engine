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
 * DEFAULT_PROVIDER, meaning a project created today pointed all eleven at a
 * local Gridlight service whether or not it was running and whether or not a
 * credentialed hosted adapter was sitting in the registry beside it. The only
 * symptom was a connection refused, at generation time, per capability.
 *
 * A preference only applies when the named provider actually holds a
 * credential (see resolveId), so this cannot swap a working local service for
 * an unusable hosted one. An explicit per-project choice still wins over it,
 * including choosing Gridlight back.
 *
 * Only capabilities with a non-Gridlight adapter appear. lipsync, post and
 * stock have none, which is a gap in coverage rather than a gap in this table
 * -- tests/pipeline-readiness.test.js asserts that distinction from the
 * registry rather than from this comment.
 */
const PREFERRED_WHEN_CONFIGURED = {
    // Text goes to Claude while Gridlight's /chat/intelligent is unusable: its
    // routing sends every question through Qdrant or Neo4j before it reaches a
    // model, so with no vector store up it 500s regardless of payload.
    llm: 'anthropic',
    image: 'openai',
    video: 'runway',
    music: 'elevenlabs',
    voice: 'elevenlabs',
    sfx: 'elevenlabs',
    ambient: 'elevenlabs',
    model3d: 'meshy',
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
function defaultProviderConfig() {
    const config = {};
    for (const [capability, id] of Object.entries(PREFERRED_WHEN_CONFIGURED)) {
        if (isProviderConfigured(id)) config[capability] = id;
    }
    return config;
}

function resolveId(capability, projectConfig) {
    const cfg = projectConfig || {};
    // An explicit per-project choice always wins, including choosing Gridlight
    // back over the preferred default.
    if (cfg[capability]) return cfg[capability];
    const envKey = `PROVIDER_${String(capability).toUpperCase()}`;
    if (process.env[envKey]) return process.env[envKey];
    if (process.env.PROVIDER_DEFAULT) return process.env.PROVIDER_DEFAULT;

    const preferred = PREFERRED_WHEN_CONFIGURED[capability];
    if (preferred && isProviderConfigured(preferred)) return preferred;

    return DEFAULT_PROVIDER;
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
    if (!adapter.requiresKey && !needsFields) return true;   // e.g. gridlight

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
function resolve(capability, projectConfig) {
    if (!isCapability(capability)) {
        // Unknown capability: still hand back the default adapter; callers guard.
        return get(DEFAULT_PROVIDER) || gridlightAdapter;
    }
    const id = resolveId(capability, projectConfig);
    const adapter = get(id);
    if (adapter && (!adapter.supports || adapter.supports(capability))) return adapter;
    // Configured provider missing / unsupported → safe fallback.
    return get(DEFAULT_PROVIDER) || gridlightAdapter;
}

/**
 * Like resolve(), but guarantees a GENERATOR: if the configured provider for a
 * capability is a source/library adapter (no generate()) or otherwise can't
 * generate, fall back to the default generator so a bad per-capability choice
 * can never crash generation.
 */
function resolveGenerator(capability, projectConfig) {
    const adapter = resolve(capability, projectConfig);
    if (adapter && typeof adapter.generate === 'function') return adapter;
    return get(DEFAULT_PROVIDER) || gridlightAdapter;
}

// Register the default provider, then auto-load any additional adapters.
register(gridlightAdapter);
_autoload();

module.exports = { register, get, list, resolve, resolveId, resolveGenerator, isProviderConfigured, defaultProviderConfig, PREFERRED_WHEN_CONFIGURED, CAPABILITIES };
