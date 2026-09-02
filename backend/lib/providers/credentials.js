/**
 * Server-side credential access for provider adapters.
 *
 * Adapters call getCredential('openai') to read the key the user stored via the
 * Provider Settings panel (film_provider_credentials). Keys never leave the
 * server. Env vars override the DB so deployments can inject keys without the UI:
 *   <PROVIDER>_API_KEY  (e.g. OPENAI_API_KEY, ELEVENLABS_API_KEY)
 */

/**
 * Lazily, because a lib module required by a test that never opens a database
 * must not open one — the rule `generation-jobs` already follows. Requiring the
 * database at load time meant importing ANY adapter imported the whole store,
 * so the pure parts of an adapter (its request builder, its result parser)
 * could not be tested without one. That is not an inconvenience: the parser bug
 * that lost a paid clip lived in exactly that untestable region.
 */
const database = () => require('../../db/database').db;

/**
 * @param {string} providerId
 * @returns {{ apiKey: string, meta: object }}
 */
/**
 * Adapters that share ONE account, and therefore one key.
 *
 * A MuAPI account key reaches the Nano Banana image models and the Seedance
 * video ones alike -- it is one subscription, not two -- so asking a director
 * to paste the same string twice is asking them to keep two rows in step by
 * hand. They drift, and the drift surfaces as a 401 on whichever adapter was
 * not updated.
 *
 * An alias is deliberately NOT a rename: `seedance` is the id every existing
 * project, rate-book entry and stored provider_config already names, and
 * renaming it would silently unconfigure them all. Both ids resolve; whichever
 * row exists answers for both.
 */
const SHARED_ACCOUNT = Object.freeze({
    muapi: ['seedance'],
    seedance: ['muapi'],
});

function getCredential(providerId) {
    const envKey = process.env[`${String(providerId).toUpperCase()}_API_KEY`];
    let apiKey = envKey || '';
    let meta = {};
    if (!apiKey || true) {
        const db = database();
        let row = db.prepare('SELECT api_key, meta FROM film_provider_credentials WHERE provider = ?').get(providerId);
        /*
         * Fall back to a sibling on the same account. Only when this id has no
         * key of its own, so an explicitly stored one always wins.
         */
        if (!row || !row.api_key) {
            for (const sibling of (SHARED_ACCOUNT[providerId] || [])) {
                const alt = db.prepare('SELECT api_key, meta FROM film_provider_credentials WHERE provider = ?').get(sibling);
                if (alt && alt.api_key) { row = alt; break; }
            }
        }
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
