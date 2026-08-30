'use strict';

/**
 * -- The brand library, and the claims register -----------------------------
 *
 * A brand OUTLIVES a project: one client buys many spots, and a kit that dies
 * with the project is one that is re-uploaded every time that client comes
 * back. There is no `project_id` on `film_brands`, and a project delete must
 * leave it standing — the `film_refsheet_jobs` trap of migration 067, where a
 * CASCADE deleted a library as a side effect of tidying up one film.
 *
 * Claims are the opposite: they are about one job's copy, so they cascade.
 *
 * HTTP dispatch and persistence only. The decisions are in `lib/brand-kit.js`
 * and `lib/compliance.js`, which are pure.
 */

const { db, generateId } = require('../db/database');
const { BRAND_FIELDS, validateBrand } = require('../lib/brand-kit');
const { findingsFor, blocks } = require('../lib/compliance');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

/** Derived from the field registry, so a field added there is writable here. */
const EDITABLE = BRAND_FIELDS.map(f => f.id);
const CLAIM_EDITABLE = ['claim', 'substantiation', 'status', 'approved_by'];
const CLAIM_STATUSES = ['unsubstantiated', 'substantiated', 'withdrawn'];

function listBrands(res) {
    const rows = db.prepare('SELECT * FROM film_brands ORDER BY name, created_at').all();
    json(res, 200, {
        brands: rows,
        count: rows.length,
        // The field registry travels with the list: the page builds its form
        // from it, so a field added to the kit gets a control without a second
        // edit — and each says what it reaches, which is the difference between
        // a brand kit and a form.
        fields: BRAND_FIELDS,
    });
}

function getBrand(res, id) {
    const row = db.prepare('SELECT * FROM film_brands WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Brand not found' });
    json(res, 200, { brand: row, fields: BRAND_FIELDS });
}

function createBrand(req, res) {
    const body = req.body || {};
    const check = validateBrand(body);
    if (!check.valid) return json(res, 400, { error: 'Invalid brand', details: check.errors });
    const id = generateId();
    const cols = EDITABLE.filter(f => body[f] !== undefined);
    db.prepare(`INSERT INTO film_brands (id${cols.length ? ', ' + cols.join(', ') : ''})
                VALUES (?${cols.map(() => ', ?').join('')})`)
        .run(id, ...cols.map(f => (typeof body[f] === 'object' ? JSON.stringify(body[f]) : body[f])));
    json(res, 201, { brand: db.prepare('SELECT * FROM film_brands WHERE id = ?').get(id) });
}

/** MERGES. A kit is a whole document; a replace would drop what it was not asked about. */
function updateBrand(req, res, id) {
    const row = db.prepare('SELECT * FROM film_brands WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Brand not found' });
    const body = req.body || {};
    const merged = { ...row };
    for (const f of EDITABLE) if (body[f] !== undefined) merged[f] = body[f];
    const check = validateBrand(merged);
    if (!check.valid) return json(res, 400, { error: 'Invalid brand', details: check.errors });

    const sets = [];
    const vals = [];
    for (const f of EDITABLE) {
        if (body[f] === undefined) continue;
        sets.push(`${f} = ?`);
        vals.push(typeof body[f] === 'object' ? JSON.stringify(body[f]) : body[f]);
    }
    if (!sets.length) return json(res, 400, { error: 'No fields to update' });
    vals.push(id);
    db.prepare(`UPDATE film_brands SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals);
    json(res, 200, { brand: db.prepare('SELECT * FROM film_brands WHERE id = ?').get(id) });
}

function deleteBrand(res, id) {
    const row = db.prepare('SELECT * FROM film_brands WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Brand not found' });
    /*
     * A project pointing at this brand keeps its pointer rather than being
     * edited: the projects are not ours to change from here, and a dangling
     * brand_id reads as "the kit was deleted", which is true. Reported so the
     * caller knows what they just orphaned.
     */
    const used = db.prepare('SELECT COUNT(*) n FROM film_projects WHERE brand_id = ?').get(id).n;
    db.prepare('DELETE FROM film_brands WHERE id = ?').run(id);
    json(res, 200, { deleted: true, id, projects_referencing: used });
}

// ── Claims ──────────────────────────────────────────────────────────────────

function listClaims(res, projectId) {
    const rows = db.prepare('SELECT * FROM film_claims WHERE project_id = ? ORDER BY created_at').all(projectId);
    json(res, 200, { project_id: projectId, claims: rows, count: rows.length, statuses: CLAIM_STATUSES });
}

function createClaim(req, res, projectId) {
    const body = req.body || {};
    if (!String(body.claim || '').trim()) {
        return json(res, 400, { error: 'A claim row needs the claim itself' });
    }
    if (body.status && !CLAIM_STATUSES.includes(body.status)) {
        return json(res, 400, { error: `Invalid status. One of: ${CLAIM_STATUSES.join(', ')}` });
    }
    const id = generateId();
    db.prepare(`INSERT INTO film_claims (id, project_id, claim, substantiation, status, approved_by)
                VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, projectId, body.claim, body.substantiation || '',
            body.status || 'unsubstantiated', body.approved_by || '');
    json(res, 201, { claim: db.prepare('SELECT * FROM film_claims WHERE id = ?').get(id) });
}

function updateClaim(req, res, id) {
    const row = db.prepare('SELECT * FROM film_claims WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Claim not found' });
    const body = req.body || {};
    if (body.status !== undefined && !CLAIM_STATUSES.includes(body.status)) {
        return json(res, 400, { error: `Invalid status. One of: ${CLAIM_STATUSES.join(', ')}` });
    }
    const sets = [];
    const vals = [];
    for (const f of CLAIM_EDITABLE) {
        if (body[f] === undefined) continue;
        sets.push(`${f} = ?`);
        vals.push(body[f]);
    }
    if (!sets.length) return json(res, 400, { error: 'No fields to update' });
    vals.push(id);
    db.prepare(`UPDATE film_claims SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...vals);
    json(res, 200, { claim: db.prepare('SELECT * FROM film_claims WHERE id = ?').get(id) });
}

function deleteClaim(res, id) {
    const row = db.prepare('SELECT * FROM film_claims WHERE id = ?').get(id);
    if (!row) return json(res, 404, { error: 'Claim not found' });
    db.prepare('DELETE FROM film_claims WHERE id = ?').run(id);
    json(res, 200, { deleted: true, id });
}

/**
 * The findings. FREE — reads rows, spends nothing, generates nothing.
 *
 * This is the surface the gate reads, and it comes before the money: after
 * generation the frames exist and the spend is gone.
 */
function complianceRoute(res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const brand = project.brand_id
        ? db.prepare('SELECT * FROM film_brands WHERE id = ?').get(project.brand_id) : null;
    const claims = db.prepare('SELECT * FROM film_claims WHERE project_id = ?').all(projectId);
    const rights = db.prepare('SELECT * FROM film_rights WHERE project_id = ?').all(projectId);
    const deliverables = db.prepare('SELECT * FROM film_deliverables WHERE project_id = ?').all(projectId);

    /*
     * The copy is the SCREENPLAY plus every scene card's dialogue: a claim can
     * be spoken as easily as written, and checking only the script would miss a
     * line a director typed onto a card.
     */
    const script = db.prepare(
        'SELECT content FROM film_scripts WHERE project_id = ? ORDER BY version DESC LIMIT 1').get(projectId);
    const cards = db.prepare(`
        SELECT sh.scene_card_yaml FROM film_shots sh
          JOIN film_scenes s ON sh.scene_id = s.id WHERE s.project_id = ?`).all(projectId);
    const spoken = cards.map(c => {
        try {
            const card = JSON.parse(c.scene_card_yaml || '{}');
            return [card.description, card.action, ...(card.dialogue || []).map(d => d && d.line)]
                .filter(Boolean).join(' ');
        } catch (_) { return ''; }
    }).join(' ');

    const findings = findingsFor({
        script: `${(script && script.content) || ''} ${spoken}`,
        brand, claims, rights, deliverables,
    });

    json(res, 200, {
        project_id: projectId,
        findings,
        blocks: blocks(findings),
        errors: findings.filter(f => f.severity === 'error').length,
        warnings: findings.filter(f => f.severity === 'warning').length,
        brand: brand ? { id: brand.id, name: brand.name } : null,
        free: true,
    });
}

function handleBrands(req, res, urlParts, query) {
    // /film/brands[/:id]
    if (urlParts[1] === 'brands') {
        const id = urlParts[2];
        if (!id) {
            if (req.method === 'GET') return listBrands(res);
            if (req.method === 'POST') return createBrand(req, res);
            return json(res, 405, { error: 'Method not allowed' });
        }
        if (req.method === 'GET') return getBrand(res, id);
        if (req.method === 'PUT') return updateBrand(req, res, id);
        if (req.method === 'DELETE') return deleteBrand(res, id);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/projects/:id/claims and /compliance
    if (urlParts[1] === 'projects' && urlParts[2]) {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });
        if (urlParts[3] === 'claims' && !urlParts[4]) {
            if (req.method === 'GET') return listClaims(res, projectId);
            if (req.method === 'POST') return createClaim(req, res, projectId);
            return json(res, 405, { error: 'Method not allowed' });
        }
        if (urlParts[3] === 'compliance' && req.method === 'GET') return complianceRoute(res, projectId);
    }

    // /film/claims/:id
    if (urlParts[1] === 'claims' && urlParts[2]) {
        if (req.method === 'PUT') return updateClaim(req, res, urlParts[2]);
        if (req.method === 'DELETE') return deleteClaim(res, urlParts[2]);
        if (req.method === 'GET') {
            const row = db.prepare('SELECT * FROM film_claims WHERE id = ?').get(urlParts[2]);
            return row ? json(res, 200, { claim: row }) : json(res, 404, { error: 'Claim not found' });
        }
        return json(res, 405, { error: 'Method not allowed' });
    }

    return json(res, 404, { error: 'Not found' });
}

module.exports = { handleBrands, EDITABLE, CLAIM_EDITABLE };
