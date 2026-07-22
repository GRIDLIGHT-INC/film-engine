/**
 * Server-side credential access for provider adapters.
 *
 * Adapters call getCredential('openai') to read the key the user stored via the
 * Provider Settings panel (film_provider_credentials). Keys never leave the
 * server. Env vars override the DB so deployments can inject keys without the UI:
 *   <PROVIDER>_API_KEY  (e.g. OPENAI_API_KEY, ELEVENLABS_API_KEY)
 */

const { db } = require('../../db/database');

/**
 * @param {string} providerId
 * @returns {{ apiKey: string, meta: object }}
 */
function getCredential(providerId) {
    const envKey = process.env[`${String(providerId).toUpperCase()}_API_KEY`];
    let apiKey = envKey || '';
    let meta = {};
    if (!apiKey || true) {
        const row = db.prepare('SELECT api_key, meta FROM film_provider_credentials WHERE provider = ?').get(providerId);
        if (row) {
            if (!apiKey && row.api_key) apiKey = String(row.api_key);
            try { meta = JSON.parse(row.meta || '{}'); } catch (_) { meta = {}; }
        }
    }
    return { apiKey, meta };
}

/** Whether a usable credential exists (env or stored). */
function hasCredential(providerId) {
    return !!getCredential(providerId).apiKey;
}

module.exports = { getCredential, hasCredential };
