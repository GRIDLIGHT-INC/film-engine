/**
 * FEM-001 (GRD-4565) — the self-hosted model catalog, served to the page and
 * to an agent. All FREE: nothing here dispatches a job.
 *
 * GET /film/model-catalog                 — the catalog in force, and whether it validates
 * GET /film/model-catalog/audit           — every recorded change, newest first
 * GET /film/model-catalog/:id/controls    — one model's control schema, for the Production client
 * GET /film/model-catalog/grants          — every licence grant recorded, revoked ones included
 * POST /film/model-catalog/grants         — record this organisation's own licence for a model
 * POST /film/model-catalog/grants/:gid/revoke — revoke one; the record stays
 *
 * Not under /film/models/: that prefix is the 3D routes' (/film/models/:assetId/rig …).
 *
 * The catalog is authored in gridlight and vendored here
 * (lib/model-catalog.snapshot.json); this route never edits it.
 */
const catalog = require('../lib/model-catalog');

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

async function readBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    return new Promise(resolve => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve({}); } });
    });
}

const STATUS = { NOT_IN_CATALOG: 404, NOT_FOUND: 404, INVALID_GRANT: 400, ALREADY_REVOKED: 409 };

async function handleGrants(req, res, parts) {
    try {
        if (!parts[3] && req.method === 'GET') return json(res, 200, { grants: catalog.grantsFor(null) });
        if (!parts[3] && req.method === 'POST') return json(res, 201, { grant: catalog.recordGrant(await readBody(req)) });
        if (parts[3] && parts[4] === 'revoke' && !parts[5] && req.method === 'POST') {
            const body = await readBody(req);
            return json(res, 200, { grant: catalog.revokeGrant(Number(parts[3]), { revoked_by: body.revoked_by }) });
        }
        return json(res, 405, { error: 'method not allowed' });
    } catch (e) {
        if (STATUS[e.code]) return json(res, STATUS[e.code], { error: e.message, code: e.code });
        throw e;
    }
}

async function handleModelCatalog(req, res, parts) {
    // parts: ['film', 'model-catalog', ...]
    if (parts[2] === 'grants') return handleGrants(req, res, parts);
    if (req.method !== 'GET') return json(res, 405, { error: 'the model catalog is read-only here: it is authored in gridlight' });
    const cat = catalog.current();

    if (!parts[2]) {
        if (!cat) return json(res, 503, { error: 'no model catalog is vendored yet (lib/model-catalog.snapshot.json)', models: [] });
        return json(res, 200, { ...cat, errors: catalog.validateCatalog(cat), fingerprint: catalog.fingerprint(cat) });
    }
    if (parts[2] === 'audit' && !parts[3]) {
        return json(res, 200, { changes: catalog.auditLog() });
    }
    if (parts[2] && parts[3] === 'controls' && !parts[4]) {
        const m = catalog.findModel(cat, decodeURIComponent(parts[2]));
        if (!m) return json(res, 404, { error: `${parts[2]} is not in the model catalog` });
        return json(res, 200, {
            id: m.id, capabilities: m.capabilities, controls: m.controls,
            duration: m.duration, output_formats: m.output_formats,
            catalog_version: cat.catalog_version,
        });
    }
    return json(res, 404, { error: 'not found' });
}

module.exports = { handleModelCatalog };
