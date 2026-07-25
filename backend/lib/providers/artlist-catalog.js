/**
 * Artlist Enterprise catalog source adapter.
 *
 * This adapter is for existing licensed catalog assets, not generation.
 * It uses Artlist's OAuth2 client-credentials flow, then searches/licenses
 * music, SFX, and stock footage results through configurable REST endpoints.
 */

const { getCredential } = require('./credentials');

const DEFAULT_BASE_URL = 'https://api.artlist.io';
const DEFAULT_TOKEN_PATH = '/oauth/token';

const _tokenCache = new Map();

function supports(capability) {
    return capability === 'music' || capability === 'sfx' || capability === 'stock';
}

function baseUrl(meta) {
    return (process.env.ARTLIST_BASE_URL || meta.base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function tokenPath(meta) {
    return meta.token_path || DEFAULT_TOKEN_PATH;
}

function missingCredentials() {
    return {
        ok: false,
        status: 401,
        error: 'artlist-catalog: missing client_id/client_secret. Save them in Provider Settings.',
    };
}

function normalizeError(prefix, status, body) {
    if (body && typeof body === 'object') {
        if (body.error_description) return `${prefix} ${status}: ${body.error_description}`;
        if (body.message) return `${prefix} ${status}: ${body.message}`;
        if (body.detail) return `${prefix} ${status}: ${body.detail}`;
        if (body.error) return `${prefix} ${status}: ${body.error}`;
    }
    return `${prefix} ${status}: ${String(body || 'request failed')}`;
}

async function parseResponse(response) {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch (_) { return text; }
}

function credentials() {
    const { meta } = getCredential('artlist-catalog');
    const clientId = process.env.ARTLIST_CLIENT_ID || meta.client_id || '';
    const clientSecret = process.env.ARTLIST_CLIENT_SECRET || meta.client_secret || '';
    return { meta, clientId, clientSecret };
}

async function fetchAccessToken(opts) {
    const { meta, clientId, clientSecret } = credentials();
    if (!clientId || !clientSecret) return missingCredentials();

    const cacheKey = `${baseUrl(meta)}:${clientId}`;
    const cached = _tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 30000) {
        return { ok: true, accessToken: cached.accessToken, expiresAt: cached.expiresAt };
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);

    const timeout = (opts && opts.timeout) || 300000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(`${baseUrl(meta)}${tokenPath(meta)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
            body: body.toString(),
            signal: controller.signal,
        });
        clearTimeout(timer);

        const parsed = await parseResponse(response);
        if (!response.ok) {
            return { ok: false, status: response.status, error: normalizeError('artlist-catalog token', response.status, parsed) };
        }
        if (!parsed || !parsed.access_token) {
            return { ok: false, status: 502, error: 'artlist-catalog token: response contained no access_token' };
        }

        const expiresIn = Number(parsed.expires_in || 3600);
        const token = { accessToken: parsed.access_token, expiresAt: Date.now() + Math.max(60, expiresIn) * 1000 };
        _tokenCache.set(cacheKey, token);
        return { ok: true, ...token };
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
            return { ok: false, status: 504, error: `artlist-catalog token: request timed out after ${timeout}ms` };
        }
        return { ok: false, status: 500, error: `artlist-catalog token: ${err.message}` };
    }
}

function searchPath(capability, meta) {
    const paths = meta.search_paths || {};
    if (paths[capability]) return paths[capability];
    if (capability === 'music') return '/search/song';
    if (capability === 'sfx') return '/search/sfx';
    return '/search/footage';
}

function licensePath(capability, assetId, meta) {
    const paths = meta.license_paths || {};
    const template = paths[capability] || (capability === 'music' ? '/song/{id}/download' : capability === 'sfx' ? '/sfx/{id}/download' : '/footage/{id}/download');
    return template.replace('{id}', encodeURIComponent(assetId));
}

function pick(obj, keys) {
    for (const key of keys) {
        if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
    }
    return '';
}

function normalizeList(body) {
    if (Array.isArray(body)) return body;
    if (!body || typeof body !== 'object') return [];
    if (Array.isArray(body.data)) return body.data;
    if (Array.isArray(body.items)) return body.items;
    if (Array.isArray(body.results)) return body.results;
    if (Array.isArray(body.songs)) return body.songs;
    if (Array.isArray(body.assets)) return body.assets;
    return [];
}

function normalizeAsset(item, capability) {
    const id = String(pick(item, ['id', 'asset_id', 'song_id', 'sfx_id', 'footage_id', 'providerAssetId']));
    const title = pick(item, ['title', 'name', 'song_name', 'asset_name']);
    const artist = pick(item, ['artist', 'artist_name', 'creator', 'author']);
    const preview = pick(item, ['preview_url', 'previewUrl', 'stream_url', 'streamUrl', 'audio_url', 'video_url']);
    const downloadUrl = pick(item, ['download_url', 'downloadUrl', 'file_url', 'fileUrl']);
    const duration = pick(item, ['duration', 'duration_seconds', 'duration_s', 'duration_ms']);
    return {
        providerAssetId: id,
        provider: 'artlist-catalog',
        capability,
        title: title || id,
        artist,
        preview,
        downloadUrl,
        duration,
        raw: item,
        license: {
            source: 'licensed_catalog',
            holder: 'Artlist',
            type: pick(item, ['license_type', 'licenseType']) || 'artlist_enterprise',
            status: pick(item, ['license_status', 'licenseStatus']) || 'available',
            territory: pick(item, ['territory']) || '',
            expiry: pick(item, ['license_expiry', 'licenseExpiry', 'expires_at']) || '',
        },
    };
}

function addQueryParam(params, key, value) {
    if (value === undefined || value === null || value === '') return;
    params.set(key, String(value));
}

function buildSearchUrl(capability, query, meta) {
    const q = query || {};
    const url = new URL(`${baseUrl(meta)}${searchPath(capability, meta)}`);
    addQueryParam(url.searchParams, 'query', q.query || q.q || q.prompt || '');
    addQueryParam(url.searchParams, 'category', q.category);
    addQueryParam(url.searchParams, 'vocal', q.vocal);
    addQueryParam(url.searchParams, 'duration', q.duration || q.duration_s);
    addQueryParam(url.searchParams, 'bpm', q.bpm || q.tempo_bpm);
    addQueryParam(url.searchParams, 'page', q.page || 1);
    addQueryParam(url.searchParams, 'limit', q.limit || q.per_page || 20);
    return url.toString();
}

async function apiGet(url, accessToken, opts) {
    const timeout = (opts && opts.timeout) || 300000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${accessToken}` },
            signal: controller.signal,
        });
        clearTimeout(timer);
        const parsed = await parseResponse(response);
        if (!response.ok) return { ok: false, status: response.status, error: normalizeError('artlist-catalog', response.status, parsed) };
        return { ok: true, status: response.status, data: parsed };
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') return { ok: false, status: 504, error: `artlist-catalog: request timed out after ${timeout}ms` };
        return { ok: false, status: 500, error: `artlist-catalog: ${err.message}` };
    }
}

const adapter = {
    id: 'artlist-catalog',
    kind: 'source',
    label: 'Artlist Catalog',
    requiresKey: false,
    // Ambient beds are library audio in the same sense music and SFX are —
    // a licensed room tone or rain wash beats a generated one, and the search
    // and licensing path is identical.
    capabilities: ['music', 'sfx', 'ambient', 'stock'],
    connection: {
        instructions: 'Requires Artlist Enterprise Catalog API credentials. This connects licensed catalog search/download, not the Artlist AI Toolkit MCP generator.',
        fields: [
            { key: 'client_id', label: 'Client ID', type: 'text', required: true },
            { key: 'client_secret', label: 'Client Secret', type: 'password', required: true },
            { key: 'base_url', label: 'Base URL', type: 'text', required: false },
        ],
    },

    supports,

    async search(capability, query, opts) {
        if (!supports(capability)) return { ok: false, status: 400, error: `artlist-catalog: unsupported capability '${capability}'` };
        const { meta } = credentials();
        const token = await fetchAccessToken(opts);
        if (!token.ok) return token;

        const result = await apiGet(buildSearchUrl(capability, query, meta), token.accessToken, opts);
        if (!result.ok) return result;
        return {
            ok: true,
            status: result.status,
            results: normalizeList(result.data).map(item => normalizeAsset(item, capability)),
            raw: result.data,
        };
    },

    async license(capability, providerAssetId, opts) {
        if (!supports(capability)) return { ok: false, status: 400, error: `artlist-catalog: unsupported capability '${capability}'` };
        if (!providerAssetId) return { ok: false, status: 400, error: 'artlist-catalog: providerAssetId is required' };
        const { meta } = credentials();
        const token = await fetchAccessToken(opts);
        if (!token.ok) return token;

        const url = `${baseUrl(meta)}${licensePath(capability, providerAssetId, meta)}`;
        const result = await apiGet(url, token.accessToken, opts);
        if (!result.ok) return result;
        const normalized = normalizeAsset({ id: providerAssetId, ...(result.data || {}) }, capability);
        return {
            ok: true,
            status: result.status,
            providerAssetId,
            downloadUrl: normalized.downloadUrl || pick(result.data, ['url', 'download', 'stream_url']),
            preview: normalized.preview,
            license: normalized.license,
            raw: result.data,
        };
    },

    _clearTokenCache() {
        _tokenCache.clear();
    },
};

module.exports = {
    adapter,
    buildSearchUrl,
    fetchAccessToken,
    normalizeAsset,
    normalizeList,
};
