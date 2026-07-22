/**
 * Provider registry + resolution.
 *
 * resolve(capability, projectConfig) picks the adapter for a capability using:
 *   per-project provider_config  →  env override (PROVIDER_<CAP>)  →  gridlight default.
 *
 * In Phase 1 only the Gridlight adapter is registered, so resolution always
 * returns Gridlight and behavior is unchanged. Later phases register openai /
 * elevenlabs / artlist adapters, and a project can opt into them per capability.
 */

const { CAPABILITIES, DEFAULT_PROVIDER, isCapability } = require('./base');
const { gridlightAdapter } = require('./gridlight-adapter');

// id -> adapter
const _registry = new Map();

function register(adapter) {
    if (!adapter || !adapter.id) throw new Error('provider adapter must have an id');
    _registry.set(adapter.id, adapter);
    return adapter;
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
function resolveId(capability, projectConfig) {
    const cfg = projectConfig || {};
    if (cfg[capability]) return cfg[capability];
    const envKey = `PROVIDER_${String(capability).toUpperCase()}`;
    if (process.env[envKey]) return process.env[envKey];
    if (process.env.PROVIDER_DEFAULT) return process.env.PROVIDER_DEFAULT;
    return DEFAULT_PROVIDER;
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

// Register the default provider.
register(gridlightAdapter);

module.exports = { register, get, list, resolve, resolveId, CAPABILITIES };
