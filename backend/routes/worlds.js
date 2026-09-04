/**
 * World Engine API — the persistent set, its versions, and which one a shot is
 * framed inside.
 *
 * GET|POST   /film/projects/:id/worlds            list / create
 * GET        /film/worlds/media/:pid/:file        serve a copied world asset
 * GET|PATCH|DELETE /film/worlds/:id               read / rename / delete
 * POST|DELETE /film/worlds/:id/lock               lock / unlock
 * GET|POST   /film/worlds/:id/versions            list / improve (never overwrite)
 * GET        /film/world-versions/:vid            read
 * POST       /film/world-versions/:vid/calibrate  set the scale
 * GET        /film/world-versions/:vid/geometry   collider, decimated, scaled on read
 * GET        /film/world-versions/:vid/plan       FREE — what generating would cost
 * POST       /film/world-versions/:vid/generate   SPENDS
 * POST|DELETE /film/shots/:id/world               pin / unpin
 *
 * Only `generate` spends. Everything else reads rows or does arithmetic, and
 * `plan` says so in its own response — a director should be able to ask what a
 * world costs without being billed for the question.
 *
 * DISPATCH ORDER MATTERS. `/film/worlds/media/...` is matched before
 * `/film/worlds/:id`, or the media path resolves as a world id and 404s. This
 * module is itself registered before the project and shot catch-alls in
 * server.js, on the `/film/locations/:id` trap that already cost once: a
 * handler that exists and is never reached looks exactly like a missing feature.
 */

const { db } = require('../db/database');
const worlds = require('../lib/worlds');
const worldAssets = require('../lib/world-assets');
const { serveFile } = require('../lib/file-storage');
const cine = require('../lib/cinematography');
const validateCam = require('../lib/camera-validate');
const genPlate = require('../lib/generation-plate');

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/** Turn a thrown domain error into the status it deserves. */
function fail(res, err) {
    const msg = (err && err.message) || 'world request failed';
    if (err && err.code === 'WORLD_LOCKED') return json(res, 423, { error: msg, code: 'WORLD_LOCKED' });
    if (err && err.code === 'NO_COLLIDER') return json(res, 409, { error: msg, code: 'NO_COLLIDER' });
    if (/not found/i.test(msg)) return json(res, 404, { error: msg });
    return json(res, 400, { error: msg });
}

function versionPayload(v) {
    if (!v) return null;
    const { describeScale } = require('../lib/world-scale');
    return Object.assign({}, v, {
        bounds: v.bounds_json ? JSON.parse(v.bounds_json) : null,
        // Stated in words as well as a number, because a null factor is a
        // different claim from a factor of one and must read that way.
        scale_state: describeScale(v),
    });
}

function worldPayload(w) {
    if (!w) return null;
    const versions = worlds.versionsFor(db, w.id);
    return Object.assign({}, w, {
        locked: !!w.locked_at,
        versions: versions.map(versionPayload),
        version_count: versions.length,
    });
}

/**
 * Everything the directing layer reasons over, gathered once.
 *
 * The world comes from the shot's PIN, not from the newest version: a director
 * directing inside v3 must be told about v3's geometry, whatever has been
 * generated since.
 */
function directingContext(shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) { const e = new Error('shot not found'); throw e; }
    const row = db.prepare('SELECT * FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    /*
     * JSON.parse('null') SUCCEEDS and returns null, so a try/catch fallback
     * never fires for it — and `director_json` is null on every shot nobody has
     * written a director intent for, which is most of them. The coalesce is the
     * fix; the catch only ever covered malformed JSON.
     */
    const parse = (v, d) => {
        try { const out = JSON.parse(v); return out == null ? d : out; }
        catch (_) { return d; }
    };
    const blocking = {
        camera: row ? parse(row.camera_json, {}) : {},
        subjects: row ? parse(row.subjects_json, []) : [],
    };
    let world = null;
    if (row && row.world_version_id) {
        const v = worlds.getVersion(db, row.world_version_id);
        if (v) world = { bounds: parse(v.bounds_json, null), scale_factor: v.scale_factor };
    }
    const director = row ? parse(row.director_json, {}) : {};
    return {
        shotId, blocking, world: world || { bounds: null, scale_factor: null },
        worldVersionId: (row && row.world_version_id) || null,
        axis: director.axis || null,
        establishedSide: director.established_side || null,
    };
}

async function handleWorlds(req, res, urlParts, query) {
    const q = query || {};
    const body = req.body || {};

    // ── /film/projects/:id/worlds ───────────────────────────────────────────
    if (urlParts[1] === 'projects' && urlParts[3] === 'worlds' && !urlParts[4]) {
        const projectId = urlParts[2];
        if (req.method === 'GET') {
            return json(res, 200, { worlds: worlds.worldsFor(db, projectId).map(worldPayload) });
        }
        if (req.method === 'POST') {
            const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
            if (!project) return json(res, 404, { error: 'Project not found' });
            try {
                const w = worlds.createWorld(db, {
                    projectId,
                    name: body.name,
                    description: body.description,
                    sceneId: body.scene_id,
                    locationId: body.location_id,
                });
                return json(res, 201, { world: worldPayload(w) });
            } catch (err) { return fail(res, err); }
        }
        return json(res, 405, { error: 'Method not allowed' });
    }

    // ── /film/worlds/media/:projectId/:file — BEFORE /film/worlds/:id ────────
    if (urlParts[1] === 'worlds' && urlParts[2] === 'media' && urlParts[3] && urlParts[4]) {
        return serveFile(res, urlParts[3], worldAssets.SUBDIR, urlParts[4], { width: q.w });
    }

    // ── /film/worlds/:id[/lock|/versions] ───────────────────────────────────
    if (urlParts[1] === 'worlds' && urlParts[2]) {
        const worldId = urlParts[2];
        const tail = urlParts[3];

        if (!tail) {
            const w = worlds.getWorld(db, worldId);
            if (!w) return json(res, 404, { error: 'World not found' });
            if (req.method === 'GET') return json(res, 200, { world: worldPayload(w) });
            if (req.method === 'PATCH') {
                try { return json(res, 200, { world: worldPayload(worlds.updateWorld(db, worldId, body)) }); }
                catch (err) { return fail(res, err); }
            }
            if (req.method === 'DELETE') {
                worlds.deleteWorld(db, worldId);
                // Shots keep their blocking; the pin is simply cleared.
                return json(res, 200, { deleted: true, note: 'Blocking authored in this world is kept; its world pin is cleared.' });
            }
            return json(res, 405, { error: 'Method not allowed' });
        }

        if (tail === 'lock') {
            if (!worlds.getWorld(db, worldId)) return json(res, 404, { error: 'World not found' });
            if (req.method === 'POST') return json(res, 200, { world: worldPayload(worlds.lockWorld(db, worldId, true)) });
            if (req.method === 'DELETE') return json(res, 200, { world: worldPayload(worlds.lockWorld(db, worldId, false)) });
            return json(res, 405, { error: 'Method not allowed' });
        }

        if (tail === 'versions') {
            if (!worlds.getWorld(db, worldId)) return json(res, 404, { error: 'World not found' });
            if (req.method === 'GET') {
                return json(res, 200, { versions: worlds.versionsFor(db, worldId).map(versionPayload) });
            }
            if (req.method === 'POST') {
                try {
                    const v = worlds.newVersion(db, worldId, {
                        parentVersionId: body.parent_version_id,
                        reason: body.reason,
                        model: body.model,
                    });
                    return json(res, 201, { version: versionPayload(v) });
                } catch (err) { return fail(res, err); }
            }
            return json(res, 405, { error: 'Method not allowed' });
        }
        return json(res, 404, { error: 'Unknown world route' });
    }

    // ── /film/world-versions/:id[/calibrate|/geometry|/plan|/generate] ───────
    if (urlParts[1] === 'world-versions' && urlParts[2]) {
        const versionId = urlParts[2];
        const tail = urlParts[3];
        const v = worlds.getVersion(db, versionId);
        if (!v) return json(res, 404, { error: 'World version not found' });

        if (!tail && req.method === 'GET') return json(res, 200, { version: versionPayload(v) });

        if (tail === 'calibrate' && req.method === 'POST') {
            try {
                const out = worlds.calibrateVersion(db, versionId, {
                    source: body.source,
                    knownMeters: body.known_meters,
                    measuredUnits: body.measured_units,
                });
                return json(res, 200, { version: versionPayload(out) });
            } catch (err) { return fail(res, err); }
        }

        if (tail === 'geometry' && req.method === 'GET') {
            try { return json(res, 200, worlds.worldGeometry(db, versionId, { budget: q.budget })); }
            catch (err) { return fail(res, err); }
        }

        if (tail === 'plan' && req.method === 'GET') {
            try { return json(res, 200, worlds.planVersion(db, versionId, { model: q.model })); }
            catch (err) { return fail(res, err); }
        }

        if (tail === 'generate' && req.method === 'POST') {
            try {
                const out = await worlds.generateVersion(db, versionId, {
                    prompt: body.prompt,
                    images: body.images,
                    video: body.video,
                }, { includeSplats: body.include_splats === true });
                return json(res, out.pending ? 202 : 200, out);
            } catch (err) { return fail(res, err); }
        }
        return json(res, 405, { error: 'Method not allowed' });
    }

    // ── /film/shots/:id/direct[/explore] — the directing layer ──────────────
    //
    // FREE, and it never calls a model. `brief` hands the facts to whoever
    // asked; `propose` takes their camera back and refuses what the geometry
    // will not accept. The judgement in between is the connected model's.
    if (urlParts[1] === 'shots' && urlParts[3] === 'direct') {
        const shotId = urlParts[2];
        const tail = urlParts[4];
        let ctx;
        try { ctx = directingContext(shotId); }
        catch (err) { return fail(res, err); }

        if (!tail && req.method === 'GET') {
            return json(res, 200, cine.buildBrief(Object.assign({}, ctx, { intent: q.intent })));
        }
        if (tail === 'explore' && req.method === 'GET') {
            return json(res, 200, cine.exploreBrief(ctx));
        }
        if (!tail && req.method === 'POST') {
            const check = cine.validateProposal(body, cine.buildBrief(ctx));
            if (!check.ok) return json(res, 400, { error: check.errors.join(' · '), errors: check.errors });
            const camera = cine.applyProposal(ctx.blocking.camera, body);
            const blocking = Object.assign({}, ctx.blocking, { camera });
            const verdict = validateCam.validateCamera(camera, ctx.world, blocking,
                { axis: ctx.axis, establishedSide: ctx.establishedSide, strict: body.strict === true });
            // A camera that cannot be shot is REFUSED with the check that
            // caught it; an advisory one is applied and reported.
            if (verdict.blocking) {
                return json(res, 409, { error: 'this camera cannot be shot', failures: verdict.failures });
            }
            if (body.apply === true) worlds.saveCamera(db, shotId, camera);
            return json(res, 200, {
                camera, applied: body.apply === true,
                warnings: verdict.failures,
                // A check that could not run is reported, never folded into a pass.
                checked: verdict.checked, not_checked: verdict.skipped,
            });
        }
        if (tail === 'explore' && req.method === 'POST') {
            return json(res, 200, cine.acceptCandidates(body.candidates || [], ctx));
        }
        return json(res, 405, { error: 'Method not allowed' });
    }

    // ── /film/shots/:id/generation-plate — the bridge to generation ─────────
    //
    // FREE. It records what the plate WOULD be rendered from and what it will
    // carry; the browser renders the pixels from the stage it already draws,
    // and posts them back through the existing media-import path. Nothing here
    // resolves a provider.
    if (urlParts[1] === 'shots' && urlParts[3] === 'generation-plate') {
        const shotId = urlParts[2];
        if (req.method !== 'GET' && req.method !== 'POST') {
            return json(res, 405, { error: 'Method not allowed' });
        }
        let ctx;
        try { ctx = directingContext(shotId); }
        catch (err) { return fail(res, err); }

        const shot = db.prepare(`SELECT s.*, sc.project_id FROM film_shots s
            JOIN film_scenes sc ON sc.id = s.scene_id WHERE s.id = ?`).get(shotId);
        const project = shot
            ? db.prepare('SELECT * FROM film_projects WHERE id = ?').get(shot.project_id) : {};

        const record = genPlate.buildPlateRecord({
            shotId,
            worldVersionId: ctx.blocking && ctx.worldVersionId,
            camera: ctx.blocking.camera,
            subjects: ctx.blocking.subjects,
            project: project || {},
            aspectOverride: body.aspect || (shot && shot.aspect_ratio) || null,
        });

        // A plate whose world version has been deleted is DETACHED, not stale:
        // you cannot re-render against geometry that no longer exists.
        const world = record.world_version_id
            ? { exists: !!worlds.getVersion(db, record.world_version_id) } : { exists: false };

        return json(res, 200, {
            plate: record,
            state: genPlate.plateState(record, world),
            outputs: genPlate.PLATE_OUTPUTS,
            prompt_lead: genPlate.platePromptLead({ tag: null }),
            move: genPlate.moveProse(body.move || {}),
            free: true,
            note: 'Rendering a plate spends nothing. Post the rendered PNG back through '
                + '/film/shots/:id/media/image/import to attach it.',
        });
    }

    // ── /film/shots/:id/world ───────────────────────────────────────────────
    if (urlParts[1] === 'shots' && urlParts[3] === 'world') {
        const shotId = urlParts[2];
        if (req.method === 'GET') return json(res, 200, worlds.pinFor(db, shotId));
        if (req.method === 'POST') {
            try { return json(res, 200, worlds.pinShot(db, shotId, body.world_version_id)); }
            catch (err) { return fail(res, err); }
        }
        if (req.method === 'DELETE') return json(res, 200, worlds.unpinShot(db, shotId));
        return json(res, 405, { error: 'Method not allowed' });
    }

    return json(res, 404, { error: 'Unknown world route' });
}

module.exports = { handleWorlds };
