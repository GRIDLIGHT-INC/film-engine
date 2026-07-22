/**
 * Minimal OAuth 2.1 (PKCE) + MCP auth-discovery helpers for connecting the
 * Film Engine backend to a remote MCP server as an OAuth client.
 *
 * Follows the MCP authorization spec: discover the protected-resource metadata
 * from the MCP URL, find the authorization server, (optionally) dynamically
 * register a client, run the authorization-code + PKCE flow, and exchange the
 * code for tokens. Dependency-free (fetch only).
 *
 * NOTE: exact endpoints are DISCOVERED from the server at runtime, so this works
 * against any spec-compliant MCP server (e.g. Artlist's) without hardcoding URLs.
 */

const crypto = require('crypto');

function base64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a PKCE code_verifier / code_challenge (S256) pair + a state token. */
function makePkce() {
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(16));
    return { verifier, challenge, state };
}

function originOf(url) {
    try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch (_) { return null; }
}

async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`${res.status} ${url}: ${text.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

/**
 * Discover the authorization-server metadata for a given MCP server URL.
 * Tries protected-resource metadata first, then falls back to the origin's
 * well-known authorization-server metadata.
 * @returns {{ authorization_endpoint, token_endpoint, registration_endpoint? }}
 */
async function discover(mcpUrl) {
    const origin = originOf(mcpUrl);
    if (!origin) throw new Error('oauth: invalid MCP URL');

    // 1) Protected-resource metadata → authorization server(s).
    let authServer = origin;
    try {
        const prm = await fetchJson(`${origin}/.well-known/oauth-protected-resource`);
        if (prm && Array.isArray(prm.authorization_servers) && prm.authorization_servers[0]) {
            authServer = prm.authorization_servers[0];
        }
    } catch (_) { /* fall back to origin */ }

    // 2) Authorization-server metadata.
    const asOrigin = originOf(authServer) || authServer;
    let meta;
    try {
        meta = await fetchJson(`${asOrigin}/.well-known/oauth-authorization-server`);
    } catch (_) {
        // OpenID fallback.
        meta = await fetchJson(`${asOrigin}/.well-known/openid-configuration`);
    }
    if (!meta || !meta.authorization_endpoint || !meta.token_endpoint) {
        throw new Error('oauth: authorization server metadata missing endpoints');
    }
    return meta;
}

/** RFC 7591 dynamic client registration (if supported). Returns { client_id, client_secret? }. */
async function registerClient(registrationEndpoint, redirectUri, clientName) {
    const body = {
        client_name: clientName || 'Film Engine',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
    };
    return fetchJson(registrationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/** Build the authorize URL the user opens in the browser. */
function buildAuthorizeUrl(meta, { clientId, redirectUri, challenge, state, scope }) {
    const u = new URL(meta.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('state', state);
    if (scope) u.searchParams.set('scope', scope);
    return u.toString();
}

/** Exchange an authorization code for tokens. */
async function exchangeCode(meta, { code, clientId, clientSecret, redirectUri, verifier }) {
    const params = new URLSearchParams();
    params.set('grant_type', 'authorization_code');
    params.set('code', code);
    params.set('redirect_uri', redirectUri);
    params.set('client_id', clientId);
    params.set('code_verifier', verifier);
    if (clientSecret) params.set('client_secret', clientSecret);
    return fetchJson(meta.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
    });
}

/** Refresh an access token. */
async function refreshToken(meta, { clientId, clientSecret, refresh_token }) {
    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refresh_token);
    params.set('client_id', clientId);
    if (clientSecret) params.set('client_secret', clientSecret);
    return fetchJson(meta.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
    });
}

module.exports = { makePkce, discover, registerClient, buildAuthorizeUrl, exchangeCode, refreshToken, base64url, originOf };
