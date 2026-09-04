/**
 * Worlds and their versions — the persistent set many shots are framed inside.
 *
 * A World is not a Shot. `film_previs_blocking` remains the one place a shot's
 * camera lives; this module owns the PLACE, and a shot joins the two by pinning
 * a version. That pin is explicit and is never moved automatically: a director's
 * approved shot must not silently re-render inside a world they have not seen.
 *
 * Three rules the rest of the file is arranged around:
 *
 *   A version is never overwritten. Improving a world creates version n+1 with
 *   a parent pointer, and version n keeps its assets, its bounds and its scale
 *   exactly as they were. Otherwise "2B is pinned to v3" stops meaning anything
 *   the moment somebody regenerates.
 *
 *   Scale is applied on READ. The factor lives on the version and is multiplied
 *   in by `worldGeometry` on the way out; the stored mesh is never rewritten.
 *   A mesh scaled twice is indistinguishable from one scaled once, so baking it
 *   in makes recalibration a corruption rather than a correction.
 *
 *   A lock refuses the destructive set and nothing else. Regenerating, rescaling
 *   and replacing the base world are refused; blocking shots, pinning them and
 *   rendering plates are not. A lock that freezes the work it was meant to
 *   protect is one nobody switches on.
 */

const scaleLib = require('./world-scale');
const assetsLib = require('./world-assets');
const { MODELS, DEFAULT_MODEL } = require('./providers/worldlabs');

const WORLD_ASSET_KINDS = assetsLib.WORLD_ASSET_KINDS;
const COPIED_KINDS = assetsLib.COPIED_KINDS;

function ids() { return require('../db/database'); }

function refuseIfLocked(db, worldId, what) {
    const w = db.prepare('SELECT locked_at FROM film_worlds WHERE id = ?').get(worldId);
    if (w && w.locked_at) {
        const err = new Error(`This world is locked — ${what} is refused. Unlock it first.`);
        err.code = 'WORLD_LOCKED';
        throw err;
    }
}

// ── worlds ──────────────────────────────────────────────────────────────────

function createWorld(db, input) {
    const o = input || {};
    if (!o.projectId) throw new Error('projectId is required');
    const name = String(o.name || '').trim();
    if (!name) throw new Error('a world needs a name');
    const { generateId } = ids();
    const id = generateId();
    db.prepare(
        `INSERT INTO film_worlds (id, project_id, scene_id, location_id, name, description)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, o.projectId, o.sceneId || null, o.locationId || null, name, String(o.description || ''));
    return getWorld(db, id);
}

function getWorld(db, id) {
    return db.prepare('SELECT * FROM film_worlds WHERE id = ?').get(id) || null;
}

function worldsFor(db, projectId) {
    return db.prepare('SELECT * FROM film_worlds WHERE project_id = ? ORDER BY created_at').all(projectId);
}

function updateWorld(db, id, patch) {
    const w = getWorld(db, id);
    if (!w) return null;
    const p = patch || {};
    const name = p.name === undefined ? w.name : String(p.name).trim();
    if (!name) throw new Error('a world needs a name');
    db.prepare("UPDATE film_worlds SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?")
        .run(name, p.description === undefined ? w.description : String(p.description), id);
    return getWorld(db, id);
}

function deleteWorld(db, id) {
    const w = getWorld(db, id);
    if (!w) return false;
    db.prepare('DELETE FROM film_worlds WHERE id = ?').run(id);
    return true;
}

function lockWorld(db, id, locked) {
    const w = getWorld(db, id);
    if (!w) return null;
    db.prepare("UPDATE film_worlds SET locked_at = ?, updated_at = datetime('now') WHERE id = ?")
        .run(locked ? new Date().toISOString() : null, id);
    return getWorld(db, id);
}

// ── versions ────────────────────────────────────────────────────────────────

function newVersion(db, worldId, input) {
    const o = input || {};
    const world = getWorld(db, worldId);
    if (!world) throw new Error('world not found');
    refuseIfLocked(db, worldId, 'creating a new version');

    const model = o.model === undefined ? DEFAULT_MODEL : String(o.model);
    if (!MODELS[model]) {
        throw new Error(`Unknown world model '${model}'. Known: ${Object.keys(MODELS).join(', ')}`);
    }

    const { generateId } = ids();
    const next = (db.prepare('SELECT MAX(version) v FROM film_world_versions WHERE world_id = ?')
        .get(worldId).v || 0) + 1;
    const id = generateId();
    db.prepare(
        `INSERT INTO film_world_versions (id, world_id, version, parent_version_id, model, reason, provider)
         VALUES (?, ?, ?, ?, ?, ?, 'worldlabs')`
    ).run(id, worldId, next, o.parentVersionId || null, model, String(o.reason || ''));

    // The newest version is what a new shot should pin to; existing pins do not move.
    db.prepare("UPDATE film_worlds SET active_version_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(id, worldId);
    return getVersion(db, id);
}

function getVersion(db, id) {
    return db.prepare('SELECT * FROM film_world_versions WHERE id = ?').get(id) || null;
}

function versionsFor(db, worldId) {
    return db.prepare('SELECT * FROM film_world_versions WHERE world_id = ? ORDER BY version').all(worldId);
}

function worldOf(db, versionId) {
    const v = getVersion(db, versionId);
    return v ? getWorld(db, v.world_id) : null;
}

function calibrateVersion(db, versionId, input) {
    const v = getVersion(db, versionId);
    if (!v) throw new Error('world version not found');
    refuseIfLocked(db, v.world_id, 'changing the scale');
    const c = scaleLib.calibrate(input);
    db.prepare(
        `UPDATE film_world_versions
         SET scale_factor = ?, scale_source = ?, scale_known_m = ?, scale_measured = ?
         WHERE id = ?`
    ).run(c.factor, c.source, c.knownMeters, c.measuredUnits, versionId);
    return Object.assign(getVersion(db, versionId), { scale: scaleLib.describeScale({ scale_factor: c.factor }) });
}

// ── ingestion ───────────────────────────────────────────────────────────────

async function ingestWorld(db, versionId, providerWorld, opts) {
    const v = getVersion(db, versionId);
    if (!v) throw new Error('world version not found');
    const world = getWorld(db, v.world_id);
    const o = opts || {};

    const stored = await assetsLib.ingestAssets(db, versionId, providerWorld, {
        projectId: o.projectId || world.project_id,
        fetchImpl: o.fetchImpl,
        includeSplats: o.includeSplats === true,
    });

    // Bounds come from the collider, which is the only asset that carries them.
    let bounds = null;
    try {
        const geo = rawGeometry(db, versionId);
        bounds = geo && geo.bounds;
    } catch (_) { /* an unreadable collider is reported on read, not here */ }

    db.prepare('UPDATE film_world_versions SET provider_world_id = ?, caption = ?, bounds_json = ? WHERE id = ?')
        .run((providerWorld && providerWorld.id) || null,
             (providerWorld && providerWorld.caption) || null,
             bounds ? JSON.stringify(bounds) : null, versionId);

    return { assets: stored, bounds, caption: (providerWorld && providerWorld.caption) || null };
}

// ── geometry ────────────────────────────────────────────────────────────────

function rawGeometry(db, versionId) {
    const bytes = assetsLib.localBytes(db, versionId, 'collider');
    if (!bytes) {
        const err = new Error('This world version has no collider mesh stored, so it cannot be measured or blocked in.');
        err.code = 'NO_COLLIDER';
        throw err;
    }
    // parseGlb refuses by NAME — a required extension, a truncated file and a
    // non-GLB each carry their own remedy. Never flattened to "invalid GLB".
    return require('./glb-parser').parseGlb(bytes);
}

/**
 * The collider, decimated to a stage budget, with scale applied on the way out.
 *
 * `scale` is null on an uncalibrated world rather than 1 — the caller has to
 * decide what to show rather than being handed a plausible metre figure.
 */
function worldGeometry(db, versionId, opts) {
    const v = getVersion(db, versionId);
    if (!v) throw new Error('world version not found');
    const o = opts || {};
    const geo = rawGeometry(db, versionId);

    /*
     * TWO CONSUMERS, TWO BUDGETS.
     *
     * The stage is interactive — repainted on every drag — so it takes a small
     * even sample and 2500 is the right default. The GENERATION PLATE is
     * rendered once and must be SOLID, and a solid render of an evenly
     * decimated mesh is not a room with fewer triangles: it is a field of
     * disconnected shards, because the survivors no longer share edges.
     * Measured on the Glass Harbour diner, 20000 of 111649 filled as confetti
     * while the same 20000 stroked as wireframe was legible.
     *
     * So the ceiling admits the whole mesh when a caller explicitly asks for
     * it. The default is unchanged, which is what keeps the stage exactly as
     * fast as it was.
     */
    const budget = Math.max(50, Math.min(250000, Number(o.budget) || 2500));
    const drawn = require('./glb-parser').decimate(geo, budget);

    const f = Number(v.scale_factor);
    const usable = Number.isFinite(f) && f > 0 ? f : null;
    const apply = (t) => (usable ? t.map(n => n * usable) : t.slice());

    return {
        world_version_id: versionId,
        vertices: usable ? drawn.vertices.map(p => p.map(n => n * usable)) : drawn.vertices,
        triangles: drawn.triangles,
        bounds: { min: apply(drawn.bounds.min), max: apply(drawn.bounds.max) },
        size: apply(drawn.size),
        // NULL, never 1 — see world-scale.js.
        scale: usable,
        scale_state: scaleLib.describeScale(v),
        triangles_total: geo.triangles.length,
        triangles_dropped: drawn.dropped,
    };
}

// ── pinning ─────────────────────────────────────────────────────────────────

function pinShot(db, shotId, versionId) {
    const v = getVersion(db, versionId);
    if (!v) throw new Error('world version not found');
    const shot = db.prepare('SELECT id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) throw new Error('shot not found');

    const existing = db.prepare('SELECT id FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    if (existing) {
        db.prepare("UPDATE film_previs_blocking SET world_version_id = ?, world_pinned_at = datetime('now') WHERE shot_id = ?")
            .run(versionId, shotId);
    } else {
        const { generateId } = ids();
        db.prepare(`INSERT INTO film_previs_blocking (id, shot_id, world_version_id, world_pinned_at)
                    VALUES (?, ?, ?, datetime('now'))`).run(generateId(), shotId, versionId);
    }
    return pinFor(db, shotId);
}

function unpinShot(db, shotId) {
    db.prepare('UPDATE film_previs_blocking SET world_version_id = NULL, world_pinned_at = NULL WHERE shot_id = ?')
        .run(shotId);
    return pinFor(db, shotId);
}

/**
 * What world a shot is pinned to — and whether a newer one exists.
 *
 * Reporting the newer version rather than moving to it is the whole rule: a
 * director is told, and decides.
 */
function pinFor(db, shotId) {
    const row = db.prepare('SELECT world_version_id, world_pinned_at FROM film_previs_blocking WHERE shot_id = ?')
        .get(shotId);
    if (!row || !row.world_version_id) return { shot_id: shotId, world_version_id: null, world_pinned_at: null };
    const v = getVersion(db, row.world_version_id);
    const newest = v && db.prepare('SELECT id, version FROM film_world_versions WHERE world_id = ? ORDER BY version DESC LIMIT 1')
        .get(v.world_id);
    return {
        shot_id: shotId,
        world_version_id: row.world_version_id,
        world_pinned_at: row.world_pinned_at,
        version: v && v.version,
        world_id: v && v.world_id,
        newer_version_id: newest && newest.id !== row.world_version_id ? newest.id : null,
        newer_version: newest && newest.id !== row.world_version_id ? newest.version : null,
    };
}

// ── generation ──────────────────────────────────────────────────────────────

/** What a generation would cost, before anything is spent. */
function planVersion(db, versionId, opts) {
    const v = getVersion(db, versionId);
    if (!v) throw new Error('world version not found');
    const model = (opts && opts.model) || v.model || DEFAULT_MODEL;
    if (!MODELS[model]) throw new Error(`Unknown world model '${model}'. Known: ${Object.keys(MODELS).join(', ')}`);
    return {
        world_version_id: versionId,
        model,
        credits: MODELS[model].credits,
        // Priced through the same table the run bills from, so the number in
        // the confirmation is the number that gets charged.
        free: true,
        note: 'This estimate costs nothing. Generating spends the credits above.',
    };
}

/**
 * Generate a world for a version.
 *
 * The provider is resolved through the registry so `onHandle` is injected at
 * resolve() — the operation id is written to film_generation_jobs BEFORE
 * polling, which is what makes a host teardown recoverable rather than a paid
 * world with nowhere to be delivered.
 */
async function generateVersion(db, versionId, payload, opts) {
    const v = getVersion(db, versionId);
    if (!v) throw new Error('world version not found');
    const world = getWorld(db, v.world_id);
    refuseIfLocked(db, v.world_id, 'regenerating');
    const o = opts || {};
    const projectId = o.projectId || world.project_id;

    let provider = o.provider;
    if (!provider) {
        const providers = require('./providers');
        const { providerConfigFor } = require('./provider-config');
        provider = providers.resolveGenerator('world', providerConfigFor(projectId));
    }

    const request = Object.assign({}, payload, { model: v.model || DEFAULT_MODEL });

    /*
     * The handle is recorded HERE as well as by the registry's own wrapper.
     *
     * "An abandoned world is recoverable" must not depend on which code path
     * resolved the provider — a caller that injects an adapter directly (a
     * batch, a test, a future second provider) would otherwise lose the only
     * reference to a job the provider is already billing for. `record` is
     * idempotent on (provider, request_id), so the two writes cannot duplicate.
     */
    const jobs = require('./generation-jobs');
    const onHandle = (requestId, meta) => {
        try {
            const job = jobs.record({
                provider: provider.id || 'worldlabs', capability: 'world',
                requestId, projectId, meta: Object.assign({ world_version_id: versionId }, meta || {}),
            });
            if (job && job.id) db.prepare('UPDATE film_world_versions SET job_id = ? WHERE id = ?').run(job.id, versionId);
        } catch (_) { /* never fail a paid call over bookkeeping */ }
    };

    let result;
    try {
        result = await provider.generate('world', request, { onHandle });
    } catch (err) {
        db.prepare("UPDATE film_world_versions SET status = 'failed' WHERE id = ?").run(versionId);
        throw err;
    }

    // A timeout is PENDING, not failed: the provider very likely finished and
    // billed for it, and the id is what makes it collectable.
    if (result && result.pending) {
        return { pending: true, handle: result.handle, world_version_id: versionId,
                 message: result.error || 'Still generating — collect it with the operation id.' };
    }
    if (!result || !result.world) {
        db.prepare("UPDATE film_world_versions SET status = 'failed' WHERE id = ?").run(versionId);
        const err = new Error((result && result.error) || 'world generation returned nothing');
        err.code = 'WORLD_FAILED';
        throw err;
    }

    const ingested = await ingestWorld(db, versionId, result.world, {
        projectId, fetchImpl: o.fetchImpl, includeSplats: o.includeSplats,
    });
    return { pending: false, world_version_id: versionId, usage: result.usage || null, ...ingested };
}

/**
 * Write an applied camera back onto the shot's blocking.
 *
 * The camera lives in film_previs_blocking and nowhere else — D1. A directing
 * proposal that created its own store would be the second answer to "where is
 * the camera for this shot" that this whole design exists to avoid.
 */
function saveCamera(db, shotId, camera) {
    const existing = db.prepare('SELECT id FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    const json = JSON.stringify(camera || {});
    if (existing) {
        db.prepare("UPDATE film_previs_blocking SET camera_json = ?, updated_at = datetime('now') WHERE shot_id = ?")
            .run(json, shotId);
    } else {
        const { generateId } = ids();
        db.prepare('INSERT INTO film_previs_blocking (id, shot_id, camera_json) VALUES (?, ?, ?)')
            .run(generateId(), shotId, json);
    }
    return camera;
}

module.exports = {
    WORLD_ASSET_KINDS, COPIED_KINDS,
    createWorld, getWorld, worldsFor, updateWorld, deleteWorld, lockWorld,
    newVersion, getVersion, versionsFor, worldOf, calibrateVersion,
    ingestWorld, worldGeometry, rawGeometry,
    pinShot, unpinShot, pinFor,
    planVersion, generateVersion, saveCamera,
};
