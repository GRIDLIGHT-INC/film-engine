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
const oauth = require('../lib/providers/oauth');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function getMeta(provider) {
    const row = db.prepare('SELECT meta FROM film_provider_credentials WHERE provider = ?').get(provider);
    if (!row) return {};
    try { return JSON.parse(row.meta || '{}'); } catch (_) { return {}; }
}

function saveMeta(provider, metaObj, apiKey) {
    const row = db.prepare('SELECT api_key FROM film_provider_credentials WHERE provider = ?').get(provider);
    const key = apiKey !== undefined ? apiKey : (row ? row.api_key : '');
    db.prepare(
        `INSERT INTO film_provider_credentials (provider, api_key, meta, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key, meta = excluded.meta, updated_at = datetime('now')`
    ).run(provider, key || '', JSON.stringify(metaObj || {}));
}

// Masked status the SPA is allowed to see: whether a key/token is set + which
// declared connection fields have values (never the values themselves).
function credStatus(provider) {
    const row = db.prepare('SELECT api_key FROM film_provider_credentials WHERE provider = ?').get(provider);
    const key = row && row.api_key ? String(row.api_key) : '';
    const meta = getMeta(provider);
    const adapter = providers.get(provider);
    const fields = {};
    const declared = adapter && adapter.connection && adapter.connection.fields;
    if (Array.isArray(declared)) for (const f of declared) fields[f.key] = !!meta[f.key];
    const connected = !!meta.access_token; // OAuth-connected
    return {
        set: !!key || connected || Object.values(fields).some(Boolean),
        last4: key ? key.slice(-4) : null,
        // Rows written before the write-time check existed. Reported rather
        // than silently treated as unset: the key IS stored, and telling
        // someone "not set" when they can see it there is its own confusion.
        suspect: !!key && key.length < 8,
        fields,
        connected,
    };
}

/**
 * What the Gridlight gateway's video models accept, read from the gateway
 * (`GET /media/capabilities`). Free. A gateway that is off answers with its
 * reason and status rather than an empty list that reads as "no models".
 */
async function gridlightVideoCapabilities(res, query) {
    const gv = require('../lib/gridlight-video');
    const caps = await gv.fetchCapabilities({ force: !!(query && (query.refresh === '1' || query.refresh === 'true')) });
    if (!caps.ok) return json(res, caps.status || 503, { error: caps.error, code: caps.code, models: [] });
    return json(res, 200, {
        models: caps.models.map(m => ({ id: m.id, label: m.label, available: m.available, has_audio: m.has_audio,
            withheld_reason: m.withheld_reason, max_body_bytes: m.max_body_bytes, inputs: m.inputs })),
        available: caps.available, read_at: caps.read_at,
        limits: gv.LIMITS, kinds: gv.KINDS, sheet_panels: gv.SHEET_PANELS,
        roles: gv.ROLE_TO_KIND, refused_roles: gv.REFUSED_ROLES,
    });
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
        const provider = urlParts[2];
        const sub = urlParts[3];
        if (provider && sub) {
            if (!providers.get(provider)) return json(res, 404, { error: 'Unknown provider' });
            if (sub === 'credentials') {
                if (req.method === 'PUT') return setCredentials(req, res, provider);
                if (req.method === 'DELETE') return deleteCredentials(res, provider);
            }
            if (sub === 'connect' && req.method === 'GET') return connectProvider(req, res, provider);
            if (sub === 'callback' && req.method === 'GET') return oauthCallback(req, res, provider, query);
            if (sub === 'disconnect' && req.method === 'POST') return disconnectProvider(res, provider);
            if (sub === 'release-client' && req.method === 'POST') return releaseRegisteredClient(res, provider);
            if (sub === 'search' && req.method === 'GET') return sourceSearch(res, provider, query);
            if (sub === 'license' && req.method === 'POST') return sourceLicense(req, res, provider);
            // FREE: the gateway's own manifest of what each video model takes.
            if (provider === 'gridlight' && sub === 'video-capabilities' && req.method === 'GET') {
                return gridlightVideoCapabilities(res, query);
            }
            return json(res, 405, { error: 'Method not allowed' });
        }
        // /film/providers
        if (!provider && req.method === 'GET') return getCatalog(res);
        return json(res, 405, { error: 'Method not allowed' });
    }

    json(res, 404, { error: 'Not found' });
}

// -- Catalog -------------------------------------------------------------

function getCatalog(res) {
    const catalog = providers.list().map(a => {
        const needsSetup = !!a.requiresKey || !!a.connection;
        return {
            id: a.id,
            kind: a.kind,
            label: a.label || a.id,
            capabilities: a.capabilities || [],
            requiresKey: !!a.requiresKey,
            connection: a.connection || null, // { instructions, fields?, oauth? } — what the user must provide
            /*
             * A keyless provider is not automatically ready.
             *
             * The local gateway needs no credential, so this reported it as
             * `set: true` — "nothing to configure" read as "available" — which
             * is the opposite of the truth once it is switched off. It reports
             * what isProviderConfigured() actually answers, and says why.
             */
            credentials: needsSetup
                ? credStatus(a.id)
                : { set: providers.isProviderConfigured(a.id), last4: null, fields: {}, connected: false },
            enabled: providers.isProviderConfigured(a.id),
            needs_enabling: !needsSetup && !providers.isProviderConfigured(a.id),
        };
    });
    json(res, 200, { capabilities: CAPABILITIES, providers: catalog });
}

// -- Credentials ---------------------------------------------------------

function setCredentials(req, res, provider) {
    const body = req.body || {};
    const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
    // Multi-field connection values (e.g. client_id / client_secret) merge into meta.
    const fields = (body.fields && typeof body.fields === 'object') ? body.fields
        : (body.meta && typeof body.meta === 'object') ? body.meta : null;

    if (!apiKey && !fields) return json(res, 400, { error: 'api_key or fields required' });

    /*
     * A PLACEHOLDER IS NOT A CREDENTIAL.
     *
     * Six providers were stored holding the single character `k`. Everything
     * downstream reported them configured — `isProviderConfigured` asks only
     * whether the string is non-empty, the settings panel showed
     * "set ••••k", the readiness check passed, and the resolver happily chose
     * them. The first sign was a 401 at generation time, on a job the director
     * had already committed to, with a message blaming the vendor.
     *
     * Refused at the WRITE, where it is cheap and unambiguous. No real provider
     * key is under eight characters — the shortest here is an ElevenLabs `sk_`
     * plus 48 — so this cannot reject something legitimate, while it does stop
     * the state that made every readiness signal lie.
     */
    const MIN_KEY = 8;
    if (apiKey && apiKey.length < MIN_KEY) {
        return json(res, 400, {
            error: `That does not look like an API key — it is ${apiKey.length} character`
                + `${apiKey.length === 1 ? '' : 's'} long.`,
            hint: 'Paste the whole key. A placeholder stored here reports as configured everywhere '
                + 'and fails as a 401 at generation time, long after you have committed to a run.',
            provider,
        });
    }

    const existing = getMeta(provider);
    const merged = { ...existing };
    if (fields) {
        for (const [k, v] of Object.entries(fields)) {
            if (typeof v === 'string' && v.trim()) merged[k] = v.trim();
        }
    }
    saveMeta(provider, merged, apiKey || undefined);

    // Never echo secrets back.
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
    try { config = JSON.parse(project.provider_config || '{}'); } catch (e) { console.error('[providers] stored config is not valid JSON; using the default:', e.message); }

    // Fill in the effective (resolved) provider per capability for the UI.
    const effective = {};
    for (const cap of CAPABILITIES) effective[cap] = providers.resolveId(cap, config);

    /*
     * AND WHO CHOSE IT.
     *
     * `effective` names a provider and says nothing about where that answer
     * came from, which is exactly the state that let a project lose its `image`
     * pin and silently bill a different vendor on a different account. The
     * provider name is identical in both cases -- only `explicit` separates
     * "this project chose Google" from "nobody chose anything and Google won a
     * preference walk".
     */
    const resolution = providers.resolutionReport(config);

    /*
     * The quality tiers, and what each would ACTUALLY use on this install right
     * now. The menu is the point: a director chooses Draft, Standard or
     * Precision, and the provider behind it is an implementation detail that
     * can change when a better model ships. `resolves_to` is included because a
     * tier whose preferred provider has no key here silently falls through, and
     * a menu that hid that would be promising a model it cannot run.
     */
    const { tierMenu, DEFAULT_TIER } = require('../lib/quality-tiers');
    /*
     * What a pre-spend dialog may offer, PER CAPABILITY.
     *
     * `image_tiers` was the only menu served, and the confirmation fetched it
     * whatever was being generated -- so a video or music confirmation showed
     * image tiers, or nothing at all. VIDEO_TIERS existed in lib/video-tiers.js
     * and reached no surface.
     *
     * Served rather than typed into the page, on the card-vocabulary rule: a
     * page holding its own list offers choices the resolver refuses, and the
     * refusal reads as the generation being broken.
     */
    const { generationOptions } = require('../lib/generation-override');
    const generation = {};
    for (const cap of CAPABILITIES) {
        const opts = generationOptions(cap);
        if (opts) generation[cap] = opts;
    }

    return json(res, 200, {
        project_id: projectId, capabilities: CAPABILITIES, config, effective, resolution,
        unpinned: CAPABILITIES.filter(c => resolution[c] && resolution[c].provider && !resolution[c].explicit),
        image_quality: config.image_quality || DEFAULT_TIER,
        image_tiers: tierMenu(config),
        generation,
    });
}

function setProjectProviders(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const body = req.body || {};
    const incoming = body.config && typeof body.config === 'object' ? body.config : body;

    /*
     * MERGE, never replace.
     *
     * This built a fresh object and wrote it over the column, which was
     * harmless while the only caller was a page that re-sends every field —
     * and destructive the moment anything sent one. An agent setting the
     * quality tier would have silently cleared every per-capability provider
     * choice on the project, and nothing would have failed: the next
     * generation would simply resolve somewhere else.
     *
     * Same rule the scene card follows, for the same reason: a partial write
     * is the normal case, and a swap loses whatever the caller did not
     * happen to know about.
     */
    let clean = {};
    try { clean = JSON.parse(
        (db.prepare('SELECT provider_config FROM film_projects WHERE id = ?').get(projectId) || {}).provider_config || '{}'
    ) || {}; } catch (_) { clean = {}; }
    for (const cap of CAPABILITIES) {
        const pid = incoming[cap];

        /*
         * CLEARING IS SAID WITH null, NOT WITH AN EMPTY STRING.
         *
         * Unpinning has to be possible — otherwise "let the quality tier
         * decide" is unsayable and the tier picker's own advice points at
         * something that cannot be done. But an empty string carried that
         * meaning, and the page sends EVERY capability on EVERY save, so any
         * moment a select reads blank — rendered before its options arrived,
         * rendered for a different project, a capability whose provider list
         * came back empty — silently deleted a pin the director had chosen.
         *
         * The two states are genuinely different and were spelled the same:
         *   null  — "remove this pin", said deliberately
         *   ""    — "I have no opinion about this one", which is what a blank
         *           control in a bulk payload actually means
         * so "" now leaves the stored value alone. A partial write is the
         * normal case, and the destructive reading was the default.
         */
        if (pid === null) { delete clean[cap]; continue; }
        if (typeof pid !== 'string') continue;
        if (!pid.trim()) continue;               // no opinion — keep what is stored
        if (providers.get(pid)) clean[cap] = pid;
    }

    /*
     * The quality tier rides in the same config object.
     *
     * It has to be carried through EXPLICITLY: the loop above keeps only keys
     * named in CAPABILITIES, so a tier arriving here would be dropped on save
     * and the setting would appear to work while reaching nothing — the
     * mood-board defect, one subsystem over. Validated against the table rather
     * than stored as free text, because a misspelled tier falls back to
     * standard silently and looks exactly like the choice not being applied.
     */
    const { IMAGE_TIERS } = require('../lib/quality-tiers');
    const tier = String(incoming.image_quality || '').toLowerCase();
    if (IMAGE_TIERS[tier]) clean.image_quality = tier;
    else if (tier === 'auto') clean.image_quality = 'auto';
    /*
     * A MODEL PER CAPABILITY, pinned beside the provider.
     *
     * `image_model` was the only one, so a director could choose which company
     * made a clip or a cue and never which of its models. Every capability now
     * takes `<capability>_model`: present but blank stops pinning; otherwise it
     * is CHECKED against the provider that would run it, because an unknown
     * name reaches most adapters as their own default (on Meshy its dearest
     * model) and the failure is invisible.
     */
    for (const cap of CAPABILITIES) {
        // Not the LLM: the reasoning is the connected agent's, so a model
        // pinned here would be a setting that reaches nothing.
        if (cap === 'llm') continue;
        const key = `${cap}_model`;
        if (typeof incoming[key] !== 'string') continue;
        const m = incoming[key].trim();
        if (!m) { delete clean[key]; continue; }
        const target = clean[cap] || providers.resolveId(cap, clean);
        const adapter = providers.get(target);
        // Checked for THIS capability: an adapter serving several must not have
        // another capability's models accepted here.
        const known = adapter ? providers.modelIdsFor(adapter, cap) : null;
        if (known && !known.includes(m)) {
            return json(res, 400, {
                error: `${target} does not offer a ${cap} model called "${m}"`,
                provider: target, capability: cap,
                available_models: known,
                hint: cap === 'image' ? 'Leave the model blank to let the quality tier choose.' : 'Leave the model blank to use the provider\'s default.',
            });
        }
        clean[key] = m.slice(0, 80);
    }

    db.prepare('UPDATE film_projects SET provider_config = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(JSON.stringify(clean), projectId);

    return getProjectProviders(res, projectId);
}

// -- OAuth connect flow (for any provider declaring connection.oauth) -----
// Generic and provider-agnostic. Nothing bundled uses it today — Runway
// authenticates with an API key — but it stays wired so an OAuth/MCP provider
// only has to declare connection.oauth to become connectable.

function redirectUriFor(req, provider) {
    if (process.env.FILM_OAUTH_REDIRECT_BASE) {
        return `${process.env.FILM_OAUTH_REDIRECT_BASE.replace(/\/+$/, '')}/film/providers/${provider}/callback`;
    }
    const host = (req.headers && req.headers.host) || 'localhost:3100';
    const proto = (req.headers && req.headers['x-forwarded-proto']) || 'http';
    return `${proto}://${host}/film/providers/${provider}/callback`;
}

function connectHtml(ok, message) {
    const color = ok ? '#16a34a' : '#dc2626';
    return `<!doctype html><meta charset="utf-8"><title>Provider Connect</title>
<body style="font-family:system-ui;background:#0b0b12;color:#e8e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center;max-width:420px;padding:24px">
  <div style="font-size:40px">${ok ? '&#9989;' : '&#9888;&#65039;'}</div>
  <h2 style="color:${color}">${ok ? 'Connected' : 'Connection failed'}</h2>
  <p style="color:#9aa">${String(message || '').replace(/</g, '&lt;')}</p>
  <p style="color:#667;font-size:13px">You can close this window.</p>
</div>
<script>try{if(window.opener){window.opener.postMessage({type:'provider-oauth',ok:${ok ? 'true' : 'false'}},'*');}}catch(e){}</script>`;
}

function html(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
}

async function connectProvider(req, res, provider) {
    const adapter = providers.get(provider);
    const oa = adapter && adapter.connection && adapter.connection.oauth;
    if (!oa) return json(res, 400, { error: 'Provider does not support OAuth connect' });

    const serverUrl = oa.mcpUrl || oa.serverUrl;
    if (!serverUrl) return json(res, 400, { error: 'Provider OAuth is missing a server URL' });

    try {
        const meta = await oauth.discover(serverUrl);
        const redirectUri = redirectUriFor(req, provider);
        const existing = getMeta(provider);

        let clientId = existing.client_id;
        let clientSecret = existing.client_secret || '';
        if (!clientId) {
            if (!meta.registration_endpoint) {
                return json(res, 400, { error: 'No dynamic registration endpoint. Paste an existing OAuth Client ID in Settings to connect.' });
            }
            try {
                const reg = await oauth.registerClient(meta.registration_endpoint, redirectUri, 'Film Engine');
                clientId = reg.client_id;
                clientSecret = reg.client_secret || '';
                // Persist the registered client immediately so we reuse it next
                // time instead of creating another entity — and keep the RFC
                // 7592 management credentials, which are the only way to delete
                // this client later and free the slot it occupies. Without them
                // a capped account has no self-serve path back.
                saveMeta(provider, {
                    ...existing,
                    client_id: clientId,
                    client_secret: clientSecret,
                    registration_access_token: reg.registration_access_token || '',
                    registration_client_uri: reg.registration_client_uri || '',
                });
            } catch (regErr) {
                if (/too_many_entities|reached the limit|\b403\b/.test(regErr.message)) {
                    return json(res, 409, {
                        error: `${provider} accepted OAuth discovery, but dynamic client registration is capped for your account (too_many_entities). Options, in order of least effort: (1) if Film Engine registered a client here before, use "Release registered client" to delete it and free a slot, then reconnect; (2) paste an existing OAuth Client ID/Secret under "Advanced" to skip registration entirely; (3) ask the provider to reset the client-registration limit for its registration endpoint. Note that clients registered before Film Engine started storing management tokens cannot be released automatically.`,
                        code: 'too_many_entities',
                    });
                }
                throw regErr;
            }
        }

        const { verifier, challenge, state } = oauth.makePkce();
        const scopes = Array.isArray(meta.resource_scopes_supported) && meta.resource_scopes_supported.length
            ? meta.resource_scopes_supported
            : meta.scopes_supported;
        const scope = Array.isArray(scopes) ? scopes.filter(s => s === 'openid' || s === 'offline_access').join(' ') : undefined;
        const authorizeUrl = oauth.buildAuthorizeUrl(meta, { clientId, redirectUri, challenge, state, scope, resource: meta.resource });

        saveMeta(provider, {
            ...existing,
            server_url: serverUrl,
            mcp_url: serverUrl,
            client_id: clientId,
            client_secret: clientSecret,
            token_endpoint: meta.token_endpoint,
            authorization_endpoint: meta.authorization_endpoint,
            resource: meta.resource || '',
            resource_name: meta.resource_name || '',
            scopes: scope || '',
            _pkce_verifier: verifier,
            _oauth_state: state,
            _redirect_uri: redirectUri,
        });

        return json(res, 200, { authorize_url: authorizeUrl });
    } catch (err) {
        return json(res, 502, { error: `connect failed: ${err.message}` });
    }
}

async function oauthCallback(req, res, provider, query) {
    if (query.error) return html(res, 400, connectHtml(false, query.error_description || query.error));
    const code = query.code;
    const state = query.state;
    const m = getMeta(provider);
    if (!code) return html(res, 400, connectHtml(false, 'missing authorization code'));
    if (!m._oauth_state || state !== m._oauth_state) return html(res, 400, connectHtml(false, 'state mismatch — retry connect'));

    try {
        const tokens = await oauth.exchangeCode(
            { token_endpoint: m.token_endpoint },
            { code, clientId: m.client_id, clientSecret: m.client_secret, redirectUri: m._redirect_uri, verifier: m._pkce_verifier, resource: m.resource }
        );
        const clean = {
            ...m,
            access_token: tokens.access_token || '',
            refresh_token: tokens.refresh_token || m.refresh_token || '',
            token_type: tokens.token_type || 'Bearer',
            expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : '',
        };
        delete clean._pkce_verifier;
        delete clean._oauth_state;
        saveMeta(provider, clean);

        // Best-effort: discover the provider's tool catalog so generation can map to it.
        const adapter = providers.get(provider);
        if (adapter && typeof adapter.listTools === 'function' && clean.access_token) {
            try {
                const t = await adapter.listTools(clean.access_token);
                if (t.ok) { clean.tools = (t.tools || []).map(x => ({ name: x.name })); saveMeta(provider, clean); }
            } catch (_) { /* non-fatal */ }
        }

        return html(res, 200, connectHtml(true, 'Connected to ' + (adapter.label || provider) + '.'));
    } catch (err) {
        return html(res, 502, connectHtml(false, err.message));
    }
}

function disconnectProvider(res, provider) {
    db.prepare('DELETE FROM film_provider_credentials WHERE provider = ?').run(provider);
    return json(res, 200, { provider, credentials: credStatus(provider) });
}

/**
 * Release the OAuth client Film Engine registered with this provider.
 *
 * Distinct from disconnect: disconnect forgets our copy of the credentials,
 * which leaves the client still registered on the provider's side, still
 * consuming one of the account's limited slots. This deletes it there too.
 *
 * That distinction is the whole point — an account can hit a registration cap
 * purely from repeated connect attempts, with no way to see or clear the
 * clients piling up.
 */
async function releaseRegisteredClient(res, provider) {
    const meta = getMeta(provider);
    if (!meta.client_id) {
        return json(res, 400, { error: 'No registered client is stored for this provider.' });
    }
    if (!meta.registration_client_uri || !meta.registration_access_token) {
        // Clients registered before we started keeping management tokens are
        // unreachable. Say so plainly instead of pretending to release them.
        return json(res, 409, {
            error: 'This client was registered before Film Engine stored management tokens, so it cannot be deleted remotely. Paste an existing OAuth client under Advanced, or ask the provider to reset your registration limit.',
            client_id: meta.client_id,
        });
    }

    const result = await oauth.deregisterClient(meta.registration_client_uri, meta.registration_access_token);
    if (!result.ok) {
        return json(res, 502, { error: result.error, client_id: meta.client_id });
    }

    // Drop our copy only after the provider confirmed — otherwise a failed
    // delete would leave an orphaned client we can no longer address.
    const { client_id, client_secret, registration_access_token, registration_client_uri, ...rest } = meta;
    saveMeta(provider, rest);

    return json(res, 200, {
        provider,
        released: true,
        message: 'Registered client deleted at the provider. A registration slot is now free — try connecting again.',
    });
}

// -- Source adapters (search/license for licensed catalogs) ---------------
// No source adapter ships today; these stay because they are capability-guarded
// (a provider without search()/license() gets a 400) and are the contract any
// future licensed catalog plugs into.

async function sourceSearch(res, provider, query) {
    const adapter = providers.get(provider);
    if (!adapter || typeof adapter.search !== 'function') return json(res, 400, { error: 'Provider is not a searchable source' });
    const capability = query.capability || 'music';
    try {
        const results = await adapter.search(capability, query, {});
        return json(res, 200, { provider, capability, results: Array.isArray(results) ? results : (results && results.results) || [] });
    } catch (err) {
        return json(res, 502, { error: `search failed: ${err.message}` });
    }
}

async function sourceLicense(req, res, provider) {
    const adapter = providers.get(provider);
    if (!adapter || typeof adapter.license !== 'function') return json(res, 400, { error: 'Provider cannot license assets' });
    const body = req.body || {};
    const capability = body.capability || 'music';
    if (!body.providerAssetId) return json(res, 400, { error: 'providerAssetId is required' });
    try {
        const licensed = await adapter.license(capability, body.providerAssetId, {});
        // Return license terms + a URL; do not stream binaries through this endpoint.
        return json(res, 200, { provider, capability, license: licensed && licensed.license, downloadUrl: licensed && licensed.downloadUrl });
    } catch (err) {
        return json(res, 502, { error: `license failed: ${err.message}` });
    }
}

module.exports = { handleProviders };
