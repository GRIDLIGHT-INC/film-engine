/**
 * Consistency Profiles API (Explore → Lock → Verify).
 *
 * A consistency profile pins the canonical identity of a subject (character /
 * location / prop / style / voice) for PRODUCTION: a canonical reference asset,
 * a prompt/negative contract, a locked seed, and reference weight. Draft profiles
 * are exploratory; locked profiles are what storyboard/video/voice generation
 * inject (see lib/consistency-context.js).
 *
 * GET    /film/projects/:id/consistency/profiles          - list profiles (+ readiness)
 * POST   /film/projects/:id/consistency/profiles          - create a profile
 * GET    /film/consistency/profiles/:id                   - get one (with refs)
 * PUT    /film/consistency/profiles/:id                   - update fields
 * POST   /film/consistency/profiles/:id/lock              - status → locked
 * POST   /film/consistency/profiles/:id/unlock            - status → draft
 * DELETE /film/consistency/profiles/:id                   - delete (+ cascade refs)
 * POST   /film/consistency/profiles/:id/refs              - attach a reference asset
 * DELETE /film/consistency/refs/:id                       - remove a reference
 * GET    /film/projects/:id/consistency/audit             - project readiness
 * GET    /film/shots/:id/consistency/audit                - shot readiness
 */

const { db, generateId } = require('../db/database');
const { auditShotReadiness, auditProjectReadiness } = require('../lib/consistency-context');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFILE_TYPES = ['character', 'location', 'prop', 'style', 'voice'];

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function handleConsistency(req, res, urlParts, query) {
    // /film/projects/:id/consistency[/profiles|/audit]
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'consistency') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });
        const sub = urlParts[4];
        if (sub === 'profiles') {
            if (req.method === 'GET') return listProfiles(res, projectId);
            if (req.method === 'POST') return createProfile(req, res, projectId);
        }
        if (sub === 'audit' && req.method === 'GET') return projectAudit(res, projectId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/shots/:id/consistency/audit
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'consistency' && urlParts[4] === 'audit') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid shot ID' });
        if (req.method === 'GET') return shotAudit(res, urlParts[2]);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/consistency/profiles/:id[/lock|/unlock|/refs] and /film/consistency/refs/:id
    if (urlParts[1] === 'consistency') {
        if (urlParts[2] === 'profiles' && urlParts[3]) {
            const id = urlParts[3];
            if (!UUID_RE.test(id)) return json(res, 400, { error: 'Invalid profile ID' });
            const action = urlParts[4];
            if (!action) {
                if (req.method === 'GET') return getProfile(res, id);
                if (req.method === 'PUT') return updateProfile(req, res, id);
                if (req.method === 'DELETE') return deleteProfile(res, id);
            }
            if (action === 'lock' && req.method === 'POST') return setStatus(res, id, 'locked');
            if (action === 'unlock' && req.method === 'POST') return setStatus(res, id, 'draft');
            if (action === 'refs' && req.method === 'POST') return addRef(req, res, id);
            return json(res, 405, { error: 'Method not allowed' });
        }
        if (urlParts[2] === 'refs' && urlParts[3]) {
            if (!UUID_RE.test(urlParts[3])) return json(res, 400, { error: 'Invalid ref ID' });
            if (req.method === 'DELETE') return deleteRef(res, urlParts[3]);
            return json(res, 405, { error: 'Method not allowed' });
        }
    }

    json(res, 404, { error: 'Not found' });
}

// -- Profiles ------------------------------------------------------------

function profileWithRefs(id) {
    const profile = db.prepare('SELECT * FROM film_consistency_profiles WHERE id = ?').get(id);
    if (!profile) return null;
    profile.refs = db.prepare('SELECT * FROM film_consistency_refs WHERE profile_id = ? ORDER BY created_at').all(id);
    return profile;
}

function listProfiles(res, projectId) {
    const profiles = db.prepare(
        'SELECT * FROM film_consistency_profiles WHERE project_id = ? ORDER BY profile_type, subject_name'
    ).all(projectId);
    const counts = { total: profiles.length, locked: profiles.filter(p => p.status === 'locked').length, draft: profiles.filter(p => p.status === 'draft').length };
    return json(res, 200, { project_id: projectId, profile_types: PROFILE_TYPES, counts, profiles });
}

function createProfile(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const b = req.body || {};
    if (!PROFILE_TYPES.includes(b.profile_type)) {
        return json(res, 400, { error: `profile_type must be one of: ${PROFILE_TYPES.join(', ')}` });
    }
    if (b.canonical_asset_id && !db.prepare('SELECT id FROM film_assets WHERE id = ?').get(b.canonical_asset_id)) {
        return json(res, 400, { error: 'canonical_asset_id does not reference a known asset' });
    }
    // One profile per (project, type, subject) — reuse if it exists.
    if (b.subject_id) {
        const existing = db.prepare(
            'SELECT id FROM film_consistency_profiles WHERE project_id = ? AND profile_type = ? AND subject_id = ?'
        ).get(projectId, b.profile_type, b.subject_id);
        if (existing) return getProfile(res, existing.id);
    }

    const id = generateId();
    db.prepare(
        `INSERT INTO film_consistency_profiles
           (id, project_id, profile_type, subject_id, subject_name, status, canonical_asset_id,
            prompt_contract, negative_contract, provider, provider_model, locked_seed, reference_weight, required_roles, settings, notes)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        id, projectId, b.profile_type, b.subject_id || '', b.subject_name || '',
        b.canonical_asset_id || null, b.prompt_contract || '', b.negative_contract || '',
        b.provider || '', b.provider_model || '',
        Number.isInteger(b.locked_seed) ? b.locked_seed : null,
        typeof b.reference_weight === 'number' ? b.reference_weight : 0.7,
        JSON.stringify(b.required_roles || []), JSON.stringify(b.settings || {}), b.notes || ''
    );
    return getProfile(res, id, 201);
}

function getProfile(res, id, status) {
    const profile = profileWithRefs(id);
    if (!profile) return json(res, 404, { error: 'Profile not found' });
    return json(res, status || 200, profile);
}

const UPDATABLE = ['subject_name', 'canonical_asset_id', 'prompt_contract', 'negative_contract', 'provider', 'provider_model', 'locked_seed', 'reference_weight', 'required_roles', 'settings', 'notes'];

function updateProfile(req, res, id) {
    const profile = db.prepare('SELECT id FROM film_consistency_profiles WHERE id = ?').get(id);
    if (!profile) return json(res, 404, { error: 'Profile not found' });

    const b = req.body || {};
    if (b.canonical_asset_id && !db.prepare('SELECT id FROM film_assets WHERE id = ?').get(b.canonical_asset_id)) {
        return json(res, 400, { error: 'canonical_asset_id does not reference a known asset' });
    }
    const sets = [], vals = [];
    for (const k of UPDATABLE) {
        if (!(k in b)) continue;
        let v = b[k];
        if (k === 'required_roles' || k === 'settings') v = JSON.stringify(v || (k === 'required_roles' ? [] : {}));
        sets.push(`${k} = ?`);
        vals.push(v);
    }
    if (sets.length === 0) return getProfile(res, id);
    sets.push("updated_at = datetime('now')");
    db.prepare(`UPDATE film_consistency_profiles SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return getProfile(res, id);
}

function setStatus(res, id, status) {
    const profile = profileWithRefs(id);
    if (!profile) return json(res, 404, { error: 'Profile not found' });
    // Locking requires a canonical reference so production has something to inject.
    if (status === 'locked' && !profile.canonical_asset_id && !(profile.refs || []).some(r => r.ref_role === 'canonical')) {
        return json(res, 400, { error: 'Cannot lock: set a canonical reference asset first.' });
    }
    db.prepare("UPDATE film_consistency_profiles SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
    return getProfile(res, id);
}

function deleteProfile(res, id) {
    db.prepare('DELETE FROM film_consistency_refs WHERE profile_id = ?').run(id);
    db.prepare('DELETE FROM film_consistency_profiles WHERE id = ?').run(id);
    return json(res, 200, { deleted: id });
}

// -- Refs ----------------------------------------------------------------

function addRef(req, res, profileId) {
    const profile = db.prepare('SELECT project_id FROM film_consistency_profiles WHERE id = ?').get(profileId);
    if (!profile) return json(res, 404, { error: 'Profile not found' });
    const b = req.body || {};
    if (!b.asset_id) return json(res, 400, { error: 'asset_id is required' });
    if (!db.prepare('SELECT id FROM film_assets WHERE id = ?').get(b.asset_id)) {
        return json(res, 400, { error: 'asset_id does not reference a known asset' });
    }

    const id = generateId();
    db.prepare(
        `INSERT INTO film_consistency_refs (id, project_id, profile_id, asset_id, ref_role, weight, is_required, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, profile.project_id, profileId, b.asset_id, b.ref_role || 'canonical',
        typeof b.weight === 'number' ? b.weight : 0.7, b.is_required ? 1 : 0, b.notes || '');
    // A 'canonical' ref also sets the profile's canonical_asset_id for convenience.
    if ((b.ref_role || 'canonical') === 'canonical') {
        db.prepare("UPDATE film_consistency_profiles SET canonical_asset_id = ?, updated_at = datetime('now') WHERE id = ?").run(b.asset_id, profileId);
    }
    return getProfile(res, profileId, 201);
}

function deleteRef(res, id) {
    db.prepare('DELETE FROM film_consistency_refs WHERE id = ?').run(id);
    return json(res, 200, { deleted: id });
}

// -- Audit (delegates to consistency-context) ----------------------------

function projectAudit(res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });
    try {
        return json(res, 200, auditProjectReadiness(projectId));
    } catch (err) {
        return json(res, 500, { error: `audit failed: ${err.message}` });
    }
}

function shotAudit(res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    const project = scene ? db.prepare('SELECT * FROM film_projects WHERE id = ?').get(scene.project_id) : null;
    try {
        return json(res, 200, { shot_id: shotId, ...auditShotReadiness(shot, scene, project) });
    } catch (err) {
        return json(res, 500, { error: `audit failed: ${err.message}` });
    }
}

module.exports = { handleConsistency };
