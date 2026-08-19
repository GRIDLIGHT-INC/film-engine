/**
 * The project-level reports: what is stale, who is in the film, and what a run
 * would cost.
 *
 * GET /film/projects/:id/staleness
 * GET /film/projects/:id/sides
 * GET /film/projects/:id/dood
 * GET /film/projects/:id/run-plan
 *
 * A gate the director cannot see is a gate that ambushes them at generation
 * time. The fingerprint work makes staleness knowable; this makes it visible,
 * before a run rather than during one.
 *
 * Reports only what was stamped. An asset with no fingerprint predates the
 * feature and is reported as `unknown`, not as fresh and not as stale — saying
 * "fresh" would be a claim we cannot support, and saying "stale" would
 * invalidate every existing project at once.
 */

const { db } = require('../db/database');
const { ARTEFACT_KINDS, fingerprintFor, isStale } = require('../lib/artefact-fingerprint');
const { buildSides, buildDOOD } = require('../lib/production-reports');
const { buildRunPlan } = require('../lib/run-plan');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/** The ids a kind needs, resolved from the asset row it is attached to. */
function idsForAsset(row) {
    return {
        shotId: row.shot_id || null,
        charId: row.character_id || null,
        locId: row.location_id || null,
        propId: row.prop_id || null,
    };
}

function projectStaleness(req, res, projectId) {
    const project = db.prepare('SELECT id, title FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const rows = db.prepare(
        `SELECT id, asset_type, artefact_kind, input_fingerprint, file_name,
                shot_id, character_id, location_id, prop_id, fingerprinted_at
           FROM film_assets WHERE project_id = ?`).all(projectId);

    const stale = [], fresh = [], unknown = [];
    for (const row of rows) {
        if (!row.artefact_kind || !row.input_fingerprint) {
            unknown.push({ asset_id: row.id, asset_type: row.asset_type, file_name: row.file_name });
            continue;
        }
        let current = null;
        try { current = fingerprintFor(row.artefact_kind, idsForAsset(row)); } catch (_) { current = null; }
        const entry = {
            asset_id: row.id,
            kind: row.artefact_kind,
            file_name: row.file_name,
            shot_id: row.shot_id || undefined,
            fingerprinted_at: row.fingerprinted_at,
        };
        // Inputs that can no longer be read (a deleted character, say) are
        // reported as stale rather than fresh: something it was built from is
        // gone, which is the strongest possible reason to regenerate.
        if (current === null) { stale.push({ ...entry, reason: 'inputs could not be read' }); continue; }
        if (isStale(row, current)) stale.push({ ...entry, reason: 'inputs changed since it was generated' });
        else fresh.push(entry);
    }

    return json(res, 200, {
        project_id: projectId,
        project_title: project.title,
        summary: { stale: stale.length, fresh: fresh.length, unknown: unknown.length, total: rows.length },
        stale,
        fresh,
        // Named, not hidden: an unstamped asset is a gap in coverage, and
        // rolling it into "fresh" would make the report look better than it is.
        unknown,
        kinds: Object.keys(ARTEFACT_KINDS),
    });
}

function handleProductionReports(req, res, urlParts, query) {
    // Sides and DOOD live here rather than in their own module: all three are
    // read-only reports over a project's own data, and a route file per report
    // would be ceremony.
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'sides') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid project ID' });
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        return json(res, 200, buildSides(urlParts[2]));
    }
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'dood') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid project ID' });
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        return json(res, 200, buildDOOD(urlParts[2]));
    }

    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'run-plan') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid project ID' });
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        const q = query || {};
        const plan = buildRunPlan(urlParts[2], { order: q.order, ignore_budget: q.ignore_budget === 'true' });
        // 402 when refused, matching the flow budget guard: a plan that would
        // overspend must not read as a successful plan you happened not to run.
        return json(res, plan.refused ? 402 : 200, plan);
    }

    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'staleness') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid project ID' });
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        return projectStaleness(req, res, urlParts[2]);
    }
    return json(res, 404, { error: 'Not found' });
}

module.exports = { handleProductionReports, projectStaleness };
