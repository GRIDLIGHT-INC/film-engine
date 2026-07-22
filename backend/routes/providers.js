/**
 * Provider Settings API (Phase 1).
 *
 * GET    /film/providers                              — provider catalog + credential status
 * PUT    /film/providers/:provider/credentials        — store an API key/meta (server-side only)
 * DELETE /film/providers/:provider/credentials        — remove stored credentials
 * GET    /film/projects/:id/providers                 — per-project capability→provider map
 * PUT    /film/projects/:id/providers                 — set per-project capability→provider map
 *
 * Credentials are NEVER returned in full to the SPA — reads report only
 * { set, last4 }. The key travels client→server only when the user saves it.
 */

const { db } = require('../db/database');
const providers = require('../lib/providers');
const { CAPABILITIES } = require('../lib/providers/base');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function credStatus(provider) {
    const row = db.prepare('SELECT api_key FROM film_provider_credentials WHERE provider = ?').get(provider);
    const key = row && row.api_key ? String(row.api_key) : '';
    return { set: !!key, last4: key ? key.slice(-4) : null };
}

function handleProviders(req, res, urlParts, query) {
    // /film/projects/:id/providers
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'providers') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });
        if (req.method === 'GET') return getProjectProviders(res, projectId);
        if (req.method === 'PUT') return setProjectProviders(req, res, projectId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/providers[...]
    if (urlParts[1] === 'providers') {
        // /film/providers/:provider/credentials
        if (urlParts[2] && urlParts[3] === 'credentials') {
            const provider = urlParts[2];
            if (!providers.get(provider)) return json(res, 404, { error: 'Unknown provider' });
            if (req.method === 'PUT') return setCredentials(req, res, provider);
            if (req.method === 'DELETE') return deleteCredentials(res, provider);
            return json(res, 405, { error: 'Method not allowed' });
        }
        // /film/providers
        if (!urlParts[2] && req.method === 'GET') return getCatalog(res);
        return json(res, 405, { error: 'Method not allowed' });
    }

    json(res, 404, { error: 'Not found' });
}

// -- Catalog -------------------------------------------------------------

function getCatalog(res) {
    const catalog = providers.list().map(a => ({
        id: a.id,
        kind: a.kind,
        label: a.label || a.id,
        capabilities: a.capabilities || [],
        requiresKey: !!a.requiresKey,
        credentials: a.requiresKey ? credStatus(a.id) : { set: true, last4: null },
    }));
    json(res, 200, { capabilities: CAPABILITIES, providers: catalog });
}

// -- Credentials ---------------------------------------------------------

function setCredentials(req, res, provider) {
    const body = req.body || {};
    const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
    const meta = body.meta && typeof body.meta === 'object' ? JSON.stringify(body.meta) : '{}';
    if (!apiKey) return json(res, 400, { error: 'api_key is required' });

    db.prepare(
        `INSERT INTO film_provider_credentials (provider, api_key, meta, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key, meta = excluded.meta, updated_at = datetime('now')`
    ).run(provider, apiKey, meta);

    // Never echo the key back.
    return json(res, 200, { provider, credentials: credStatus(provider) });
}

function deleteCredentials(res, provider) {
    db.prepare('DELETE FROM film_provider_credentials WHERE provider = ?').run(provider);
    return json(res, 200, { provider, credentials: { set: false, last4: null } });
}

// -- Per-project provider config ----------------------------------------

function getProjectProviders(res, projectId) {
    const project = db.prepare('SELECT provider_config FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });
    let config = {};
    try { config = JSON.parse(project.provider_config || '{}'); } catch (_) {}

    // Fill in the effective (resolved) provider per capability for the UI.
    const effective = {};
    for (const cap of CAPABILITIES) effective[cap] = providers.resolveId(cap, config);

    return json(res, 200, { project_id: projectId, capabilities: CAPABILITIES, config, effective });
}

function setProjectProviders(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const body = req.body || {};
    const incoming = body.config && typeof body.config === 'object' ? body.config : body;
    const clean = {};
    for (const cap of CAPABILITIES) {
        const pid = incoming[cap];
        if (typeof pid === 'string' && pid && providers.get(pid)) clean[cap] = pid;
    }

    db.prepare('UPDATE film_projects SET provider_config = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(JSON.stringify(clean), projectId);

    return getProjectProviders(res, projectId);
}

module.exports = { handleProviders };
