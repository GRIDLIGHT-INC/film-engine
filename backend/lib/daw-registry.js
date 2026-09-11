/**
 * WHICH DAW ADAPTERS THE ENGINE CAN REACH, AND HOW EACH IS CONFIGURED.
 *
 * MUS-018. The routes and the MCP tools never construct an adapter: they ask
 * here for one by id, so there is one place that knows where the Ableton
 * sidecar is and whether it is configured. An adapter that is not configured
 * answers with what to set and where the setup guide is, never with a
 * connection error that reads like Live being broken.
 *
 * `ABLETON_TOOLS` is the tool registry: every operation of the DAW contract
 * (`DAW_OPERATIONS` in lib/daw-adapter.js) has exactly one tool, and nothing
 * else does. There is no tool that takes an OSC address or a Live Object
 * Model property: the sidecar's allowlist is the most an agent can reach, and
 * only through the driver's rules.
 *
 * Configuration is the environment of the Film Engine process, deliberately
 * not the database: the token is a secret, and the sidecar is separately run.
 *   ABLETON_SIDECAR_URL    http://127.0.0.1:3190 by default; must be loopback
 *   ABLETON_SIDECAR_TOKEN  the token the sidecar was started with
 */

const { createAbletonAdapter } = require('./daw/ableton');

const ABLETON_TOOLS = Object.freeze({
    ableton_status: 'status',
    ableton_session_read: 'session_read',
    ableton_score_push_plan: 'push_plan',
    ableton_score_push: 'push',
    ableton_mix_pull_plan: 'pull_plan',
    ableton_mix_pull: 'pull',
    ableton_transport: 'transport',
});

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1'];
const GUIDE = 'docs/ableton-sidecar.md';

const ADAPTERS = Object.freeze({
    ableton: {
        label: 'Ableton Live (AbletonOSC sidecar)',
        guide: GUIDE,
        configure(env) {
            const token = env.ABLETON_SIDECAR_TOKEN || '';
            const url = (env.ABLETON_SIDECAR_URL || 'http://127.0.0.1:3190').replace(/\/+$/, '');
            if (!token) return { ok: false, error: `the Ableton sidecar is not configured: start it (node backend/ableton-sidecar.js) and give this server the same ABLETON_SIDECAR_TOKEN, plus ABLETON_SIDECAR_URL if it is not on port 3190 — see ${GUIDE}` };
            let host;
            try { host = new URL(url).hostname; } catch (_) { return { ok: false, error: `ABLETON_SIDECAR_URL '${url}' is not a URL — see ${GUIDE}` }; }
            if (!LOOPBACK_HOSTS.includes(host)) return { ok: false, error: `ABLETON_SIDECAR_URL points at ${host}: the sidecar runs on this machine and listens on 127.0.0.1 only, so the URL must be loopback — see ${GUIDE}` };
            return { ok: true, key: `${url}\n${token}`, create: () => createAbletonAdapter({ url, token }) };
        },
    },
});

const cache = new Map();
const overrides = new Map();

/** An adapter by id, or the reason there is none. */
function adapterFor(id, env) {
    if (overrides.has(id)) return { ok: true, adapter: overrides.get(id) };
    const spec = ADAPTERS[id];
    if (!spec) return { ok: false, status: 404, error: `no DAW adapter '${id}'; the engine knows ${Object.keys(ADAPTERS).join(', ')}` };
    const c = spec.configure(env || process.env);
    if (!c.ok) return { ok: false, status: 503, error: c.error, guide: spec.guide };
    const k = `${id}\n${c.key}`;
    if (!cache.has(k)) cache.set(k, c.create());
    return { ok: true, adapter: cache.get(k) };
}

/** Tests and harnesses: stand an adapter in for an id (null restores the configured one). */
function useAdapter(id, adapter) {
    if (adapter) overrides.set(id, adapter); else overrides.delete(id);
}

module.exports = { ABLETON_TOOLS, ADAPTERS, adapterFor, useAdapter };
