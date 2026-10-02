/**
 * World Engine API — the persistent set, its versions, and which one a shot is
 * framed inside.
 *
 * GET|POST   /film/projects/:id/worlds            list / create
 * GET        /film/worlds/media/:pid/:file        serve a copied world asset
 * GET|PATCH|DELETE /film/worlds/:id               read / rename / delete
 * POST|DELETE /film/worlds/:id/lock               lock / unlock
 * GET|POST   /film/worlds/:id/versions            list / improve (never overwrite)
 * POST       /film/worlds/:id/versions/import     a scene built in Blender (a GLB) as the next version, in metres
 * GET        /film/world-versions/:vid            read
 * POST       /film/world-versions/:vid/calibrate  set the scale
 * GET        /film/world-versions/:vid/geometry   collider, decimated, scaled on read
 * GET        /film/world-versions/:vid/splats     FREE — splat tiers + panorama, as loadable URLs
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
const refMatch = require('../lib/reference-match');
const complexity = require('../lib/shot-complexity');
const worldExport = require('../lib/world-export');

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/** Turn a thrown domain error into the status it deserves. */
function fail(res, err) {
    const msg = (err && err.message) || 'world request failed';
    if (err && err.code === 'WORLD_LOCKED') return json(res, 423, { error: msg, code: 'WORLD_LOCKED' });
    if (err && ['WORLD_IN_USE', 'WORLD_ARCHIVED'].includes(err.code)) return json(res, 409, { error: msg, code: err.code });
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

/**
 * The bytes of an imported file: sent in the body (base64 or a data URI), or
 * named by a path INSIDE THIS PROJECT'S OWN FOLDER, which is where Blender (or
 * an agent driving Blender) exports to. A path anywhere else is refused: this
 * server is unauthenticated, and "read any file the process can" is not a
 * feature an import may grow.
 */
function importedBytes(projectId, body, field, pathField, optional) {
    const b = body || {};
    const inline = b[field];
    if (typeof inline === 'string' && inline.trim()) {
        const m = inline.match(/^data:[^;,]*;base64,(.*)$/s);
        return Buffer.from(m ? m[1] : inline, 'base64');
    }
    const want = b[pathField];
    if (typeof want === 'string' && want.trim()) {
        const fs = require('fs');
        const path = require('path');
        const row = db.prepare('SELECT assets_dir FROM film_projects WHERE id = ?').get(projectId);
        if (!row || !row.assets_dir) {
            throw new Error('This project has no folder of its own, so a file can only be imported by sending its bytes.');
        }
        let root, target;
        try { root = fs.realpathSync(row.assets_dir); } catch (_) { throw new Error('The project folder cannot be read.'); }
        try { target = fs.realpathSync(path.resolve(root, want)); } catch (_) { throw new Error(`No file at ${want}.`); }
        if (target !== root && !target.startsWith(root + path.sep)) {
            throw new Error(`${want} is outside this project's folder (${row.assets_dir}). Export it there and import it again.`);
        }
        return fs.readFileSync(target);
    }
    if (optional) return null;
    throw new Error(`Send the scene as \`${field}\` (base64) or \`${pathField}\` (a file inside the project folder).`);
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

/*
 * The complexity inputs, DERIVED from what the engine already holds.
 *
 * Three of the seven can be read honestly and four cannot, and saying which is
 * the whole integrity of the number. Counting subjects from the blocking is a
 * fact; deciding that a description contains "four independent actions" is a
 * reading, and a regex that guessed would put a confident grade on a guess.
 *
 * So the derived ones come with their source named and the rest default to 0
 * and are marked `ask`, which is what the surface prompts for. A zero that is
 * declared as unknown is honest; a zero presented as measured is not.
 */
function complexityInputs(shotId, ctx) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId) || {};
    let card = {};
    try { card = JSON.parse(shot.scene_card_yaml || '{}') || {}; } catch (_) { card = {}; }

    const staged = (ctx.blocking && ctx.blocking.subjects) || [];
    const named = new Set([
        ...staged.map(x => String((x && x.name) || '').trim().toUpperCase()).filter(Boolean),
        ...(Array.isArray(card.characters) ? card.characters : [])
            .map(c => String(typeof c === 'string' ? c : (c && c.name) || '').trim().toUpperCase())
            .filter(Boolean),
    ]);

    const row = db.prepare('SELECT moves_json, movement FROM film_previs_blocking WHERE shot_id = ?').get(shotId);
    let legs = 0;
    if (row) {
        try { const m = JSON.parse(row.moves_json || '[]'); legs = Array.isArray(m) ? m.length : 0; }
        catch (_) { legs = 0; }
        if (!legs && row.movement && row.movement !== 'static') legs = 1;
    }
    if (!legs && card.camera && card.camera.movement && card.camera.movement !== 'static') legs = 1;

    const durationS = Number(shot.duration_ms) > 0 ? Number(shot.duration_ms) / 1000 : 0;

    return {
        values: {
            subjects: named.size,
            moving_subjects: 0,
            camera_movement: legs,
            environment_interactions: 0,
            occlusion: 0,
            duration_s: durationS,
            distinct_actions: 0,
        },
        sources: {
            subjects: 'the shot\'s blocking and its scene card',
            moving_subjects: 'ask — nothing here records which staged subjects move',
            camera_movement: 'the saved blocking\'s legs, else the card\'s movement',
            environment_interactions: 'ask — contact with the set is not modelled',
            occlusion: 'ask — staged boxes cannot say what passes behind what over time',
            duration_s: durationS ? 'the shot\'s own duration' : 'ask — this shot has no duration set',
            distinct_actions: 'ask — reading actions out of a description is a judgement, not a count',
        },
    };
}

/*
 * The bytes each export output would carry.
 *
 * Newest first per kind, because a plate is re-rendered against the same shot
 * and a package must carry the one on screen rather than the first ever made.
 */
/**
 * The images and video a generation runs on.
 *
 * By default, exactly what the caller sent — every world generated before this
 * passed its own bytes, and making stored captures mandatory would break them.
 * With `use_captures: true` the world's LOCATION supplies them instead: the
 * panorama or orbit clip a director actually shot of the place, already
 * uploaded, rather than re-sending bytes the engine is holding.
 *
 * Nothing is silently dropped. Whatever is not used comes back as
 * `captures_excluded` with a reason, because a scan that vanishes looks exactly
 * like a capture that failed to upload.
 */
function captureInputs(db, versionId, body) {
    if (!body || body.use_captures !== true) {
        return { images: body && body.images, video: body && body.video };
    }
    const worlds = require('../lib/worlds');
    const v = worlds.getVersion(db, versionId);
    const world = v && worlds.getWorld(db, v.world_id);
    const locationId = world && world.location_id;
    if (!locationId) {
        return { images: body.images, video: body.video, capture_note: 'This world is not linked to a location, so it has no stored captures.' };
    }
    const rows = db.prepare(
        `SELECT id, file_path, file_name, size_bytes, metadata
           FROM film_assets WHERE location_id = ? ORDER BY created_at DESC`).all(locationId);
    const captures = rows.map(r => {
        let m = {};
        try { m = JSON.parse(r.metadata || '{}'); } catch (_) { m = {}; }
        return m.kind === 'world_capture'
            ? { id: r.id, file_path: r.file_path, file_name: r.file_name, size_bytes: r.size_bytes,
                capture_kind: m.capture_kind, is_pano: m.is_pano, view: m.view }
            : null;
    }).filter(Boolean);

    const plan = require('../lib/capture-to-world').planFromCaptures(captures);
    return {
        images: plan.images.length ? plan.images : undefined,
        video: plan.video || undefined,
        is_pano: plan.is_pano,
        capture_note: plan.empty
            ? 'This location has no stored captures yet. Upload one with world_capture_upload.'
            : plan.why || null,
        captures_excluded: plan.excluded,
    };
}

function exportAssets(db_, shotId, version) {
    const out = {};
    const shotRows = db_.prepare(
        `SELECT id, file_path, metadata FROM film_assets
          WHERE shot_id = ? AND json_valid(metadata)
          ORDER BY created_at DESC`).all(shotId);
    for (const r of shotRows) {
        let kind = null;
        try { kind = (JSON.parse(r.metadata) || {}).kind || null; } catch (_) { kind = null; }
        if (kind && !out[kind]) out[kind] = { file_path: r.file_path };
    }
    // The shot's current storyboard frame, which is a plain asset type rather
    // than a metadata kind.
    if (!out.storyboard) {
        const f = db_.prepare(
            `SELECT file_path FROM film_assets
              WHERE shot_id = ? AND asset_type = 'storyboard'
              ORDER BY version DESC, created_at DESC LIMIT 1`).get(shotId);
        if (f) out.storyboard = { file_path: f.file_path };
    }
    if (version) {
        /*
         * A world asset is EITHER copied or recorded — `asset_id` for the three
         * heavy kinds we hold, `remote_url` for the splats we deliberately do
         * not. Joining to film_assets is what turns the first into a path; the
         * second has none, and giving it one would put a broken file reference
         * in a manifest handed to another department.
         */
        const rows = db_.prepare(
            `SELECT wa.kind, wa.remote_url, a.file_path
               FROM film_world_assets wa
               LEFT JOIN film_assets a ON a.id = wa.asset_id
              WHERE wa.world_version_id = ?`).all(version.id);
        for (const r of rows) {
            if (out[r.kind]) continue;
            if (!r.file_path && !r.remote_url) continue;
            out[r.kind] = { file_path: r.file_path || null, url: r.remote_url || null };
        }
    }
    return out;
}

async function handleWorlds(req, res, urlParts, query) {
    const q = query || {};
    const body = req.body || {};

    // ── /film/projects/:id/worlds ───────────────────────────────────────────
    if (urlParts[1] === 'projects' && urlParts[3] === 'worlds' && !urlParts[4]) {
        const projectId = urlParts[2];
        if (req.method === 'GET') {
            return json(res, 200, { worlds: worlds.worldsFor(db, projectId, { archived: q.archived }).map(worldPayload) });
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

        if (tail === 'versions' && urlParts[4] === 'import') {
            const w = worlds.getWorld(db, worldId);
            if (!w) return json(res, 404, { error: 'World not found' });
            if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
            try {
                const glb = importedBytes(w.project_id, body, 'glb', 'file_path');
                const panorama = importedBytes(w.project_id, body, 'panorama', 'panorama_path', true);
                const v = worlds.importVersion(db, worldId, {
                    glb, panorama, source: body.source, reason: body.reason, caption: body.caption,
                });
                return json(res, 201, {
                    version: versionPayload(v),
                    triangles: v.triangles,
                    size_m: v.size_m,
                    note: 'In metres (glTF\'s own unit), so lens, height and distance are true without calibrating. '
                        + 'Pin a shot to this version to frame it here; shots pinned to older versions stay where they are.',
                });
            } catch (err) { return fail(res, err); }
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

        /*
         * WHAT THE LOOK VIEW CAN DRAW (ADR-008). Every splat tier this version
         * recorded, smallest first, plus the panorama — each as a URL the page
         * can load: our own copy when one was made, the provider's CDN
         * otherwise (served with CORS, measured). FREE: nothing is fetched here.
         *
         * Gated by world_splats, and the answer says so rather than 404ing, so
         * the console can tell "switched off" from "this world has none".
         */
        if (tail === 'splats' && req.method === 'GET') {
            const { readSettings } = require('./app-settings');
            const enabled = !!readSettings().world_splats;
            const world = db.prepare('SELECT project_id FROM film_worlds WHERE id = ?').get(v.world_id) || {};
            const rows = db.prepare(
                `SELECT wa.kind, wa.remote_url, wa.bytes, wa.asset_id
                   FROM film_world_assets wa WHERE wa.world_version_id = ?`).all(versionId);
            const order = ['splat_100k', 'splat_500k', 'splat_full'];
            const url = r => (r.asset_id && world.project_id)
                ? worldAssets.servedUrlFor(world.project_id, versionId, r.kind) : r.remote_url;
            const splats = rows.filter(r => order.includes(r.kind))
                .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
                .map(r => ({ kind: r.kind, url: url(r), local: !!r.asset_id, bytes: r.bytes || null }));
            const pano = rows.find(r => r.kind === 'panorama');
            /*
             * A scene built in Blender carries its own materials: the collider IS
             * the textured set, so the Look view draws it directly. It is not
             * gated by world_splats, because it is not a splat.
             */
            const coll = rows.find(r => r.kind === 'collider');
            const imported = worlds.IMPORT_SOURCES[v.provider];
            const mesh = imported && coll && coll.asset_id && world.project_id
                ? { url: worldAssets.servedUrlFor(world.project_id, versionId, 'collider'), source: v.provider } : null;
            return json(res, 200, {
                world_version_id: versionId, enabled, mesh,
                scale_factor: Number(v.scale_factor) > 0 ? Number(v.scale_factor) : 1,
                splats: enabled ? splats : [],
                available: splats.map(s => s.kind),
                panorama: pano ? { url: url(pano), local: !!pano.asset_id } : null,
                note: enabled ? null : 'world_splats is off — switch it on in Setup to render the Look view.',
            });
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
                    ...captureInputs(db, versionId, body),
                    /*
                     * Whether a single image is a 360 panorama. Marble's own
                     * docs call a panorama the most accurate spatial
                     * representation, and until this was carried through, every
                     * world was built on 'auto' because nothing could say
                     * otherwise. Undefined still means auto; the adapter
                     * refuses anything outside the recorded domain.
                     */
                    is_pano: body.is_pano,
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
            const camera = cine.applyProposal(ctx.blocking.camera, body, ctx.world);
            /*
             * A metric proposal needs a calibrated world to land in. Refused
             * with the remedy rather than reinterpreted: metres read as world
             * units is a camera in the wrong place that looks deliberate.
             */
            if (camera === null) {
                return json(res, 409, {
                    error: 'this world has no scale, so a camera given in metres cannot be placed',
                    remedy: 'calibrate the world version first: POST /film/world-versions/:id/calibrate',
                });
            }
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
        /*
         * ── /direct/compare — two cameras on the same axes ──────────────
         *
         * `compareCameras` was written, exported, unit-tested and REACHABLE
         * FROM NOWHERE — the declared-and-unread shape this codebase has paid
         * for under five other names. Exposing it is what stops the page
         * computing its own comparison, which is how the two come to disagree
         * about what "distance" means.
         *
         * FREE: it reads two cameras and does arithmetic. Each side may carry
         * its own blocking and occupancy, because a camera compared against
         * the wrong subject distance is a confidently wrong number.
         */
        if (tail === 'compare' && req.method === 'POST') {
            const side = (x) => {
                if (!x) return null;
                // A bare camera is accepted, so a caller holding two proposals
                // does not have to reconstruct a blocking to compare them.
                const camera = x.camera || x;
                return { camera, blocking: x.blocking || Object.assign({}, ctx.blocking, { camera }),
                         occupancy: x.occupancy == null ? null : x.occupancy };
            };
            const a = side(body.a), b = side(body.b);
            if (!a || !b) {
                return json(res, 400, {
                    error: 'a comparison needs two cameras: pass `a` and `b`',
                });
            }
            return json(res, 200, Object.assign(cine.compareCameras(a, b), {
                names: [body.a_name || 'A', body.b_name || 'B'],
            }));
        }
        return json(res, 405, { error: 'Method not allowed' });
    }

    /*
     * ── /film/shots/:id/match-reference ─────────────────────────────────
     *
     * FREE, and manual-assist only. It takes the MARKS a director drew on a
     * reference frame — never the frame — so there is nothing here that could
     * detect anything, which is what makes "V1 claims no computer vision" a
     * property of the route rather than a sentence in its docs.
     *
     * Applying is a SEPARATE, deliberate act, and it goes through the same
     * proposal validator every other camera goes through: a composition copied
     * from a still can still put the camera inside a wall, and a second apply
     * path is how one of them comes to skip the checks.
     */
    if (urlParts[1] === 'shots' && urlParts[3] === 'match-reference') {
        const shotId = urlParts[2];
        if (req.method !== 'POST' && req.method !== 'GET') {
            return json(res, 405, { error: 'Method not allowed' });
        }
        let ctx;
        try { ctx = directingContext(shotId); }
        catch (err) { return fail(res, err); }

        if (req.method === 'GET') {
            // What can be marked and what each mark buys — so a surface can be
            // built from the registry rather than from a screenshot.
            return json(res, 200, {
                marks: refMatch.MARKS, estimates: refMatch.ESTIMATES,
                applies: refMatch.APPLIES, never_applies: refMatch.NEVER_APPLIES,
                free: true,
            });
        }

        const solved = refMatch.solveMatch(body.marks || body, {
            sensor: body.sensor || null,
        });
        const proposal = refMatch.proposalFrom(solved, { pinOccupancy: body.pin_occupancy === true });

        if (body.apply !== true) {
            return json(res, 200, { match: solved, proposal, applied: false, free: true });
        }

        // Nothing to apply is refused rather than reported as an apply that
        // did nothing — the two look identical afterwards.
        if (!Object.keys(proposal.changes).length) {
            return json(res, 400, {
                error: 'this solve determined no camera field, so there is nothing to apply',
                match: solved,
            });
        }
        const check = cine.validateProposal(proposal, cine.buildBrief(ctx));
        if (!check.ok) return json(res, 400, { error: check.errors.join(' · '), errors: check.errors });

        const camera = cine.applyProposal(ctx.blocking.camera, proposal, ctx.world);
        if (camera === null) {
            return json(res, 409, {
                error: 'this world has no scale, so a camera height in metres cannot be placed',
                remedy: 'calibrate the world version first: POST /film/world-versions/:id/calibrate',
                match: solved,
            });
        }
        const blocking = Object.assign({}, ctx.blocking, { camera });
        const verdict = validateCam.validateCamera(camera, ctx.world, blocking,
            { axis: ctx.axis, establishedSide: ctx.establishedSide, strict: body.strict === true });
        if (verdict.blocking) {
            return json(res, 409, { error: 'this camera cannot be shot', failures: verdict.failures, match: solved });
        }
        worlds.saveCamera(db, shotId, camera);
        return json(res, 200, {
            match: solved, proposal, camera, applied: true,
            warnings: verdict.failures, checked: verdict.checked, not_checked: verdict.skipped,
        });
    }

    /*
     * ── /film/shots/:id/complexity ──────────────────────────────────────
     *
     * FREE, and it belongs before a generation rather than after it — the
     * whole value is that the remedy is to SPLIT THE SHOT, which no amount of
     * prompt wording achieves and which nobody does once the money is spent.
     *
     * Inputs are DERIVED from what the engine already holds and every one can
     * be overridden, because the engine cannot read "she pushes the door while
     * he turns away" out of a description and pretending otherwise would put a
     * confident number on a guess.
     */
    if (urlParts[1] === 'shots' && urlParts[3] === 'complexity') {
        const shotId = urlParts[2];
        if (req.method !== 'GET' && req.method !== 'POST') {
            return json(res, 405, { error: 'Method not allowed' });
        }
        let ctx;
        try { ctx = directingContext(shotId); }
        catch (err) { return fail(res, err); }

        const derived = complexityInputs(shotId, ctx);
        const given = (req.method === 'POST' ? (body.inputs || body) : q) || {};
        const merged = Object.assign({}, derived.values);
        for (const spec of complexity.INPUTS) {
            if (given[spec.id] !== undefined && given[spec.id] !== '') {
                merged[spec.id] = Number(given[spec.id]);
            }
        }
        const scored = complexity.scoreShot(merged);
        return json(res, 200, Object.assign(scored, {
            derived_from: derived.sources,
            free: true,
        }));
    }

    /*
     * ── /film/shots/:id/world-export ────────────────────────────────────
     *
     * The manifest, not the bytes. Whether each output EXISTS is the question
     * a director needs answered before handing anything over, and it can be
     * answered without copying 25 MB of splat.
     */
    if (urlParts[1] === 'shots' && urlParts[3] === 'world-export') {
        const shotId = urlParts[2];
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        let ctx;
        try { ctx = directingContext(shotId); }
        catch (err) { return fail(res, err); }

        const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
        if (!shot) return json(res, 404, { error: 'Shot not found' });

        const version = ctx.worldVersionId ? worlds.getVersion(db, ctx.worldVersionId) : null;
        const world = version ? worlds.getWorld(db, version.world_id) : null;
        let bounds = null, size = null;
        if (version) {
            try {
                const geo = worlds.worldGeometry(db, version.id, { budget: 50 });
                bounds = geo.bounds; size = geo.size;
            } catch (_) { bounds = null; size = null; }
        }
        return json(res, 200, Object.assign(
            worldExport.buildExport({
                world, version, shot, bounds, size,
                blocking: ctx.blocking,
                assets: exportAssets(db, shotId, version),
            }),
            { free: true }));
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

        /*
         * A RENDERED plate arrives here. The pixels are drawn client-side from
         * the previs stage — there is nothing for a server route to generate —
         * so this stores what it is given and stays free.
         *
         * It REPLACES rather than accumulating: two plates for one shot means
         * "the plate" is whichever row the query happens to return, which is
         * the six-rows-for-three-files bug plate views already paid for.
         */
        if (req.method === 'POST' && body.image) {
            const decoded = genPlate.decodePlateImage(body.image);
            if (!decoded.ok) return json(res, 400, { error: decoded.error });

            const { generateId } = require('../db/database');
            const { saveFile } = require('../lib/file-storage');
            const projectId = shot && shot.project_id;
            if (!projectId) return json(res, 404, { error: 'Shot not found' });

            /*
             * ONE STORE PATH FOR EVERY PLATE OUTPUT.
             *
             * `PLATE_OUTPUTS` declares image, depth and segmentation, and for
             * a while only the image existed — a registry naming three things
             * where one is real is how the export came to report a file nobody
             * could produce. The depth pass arrives on the same request,
             * because it is the same render read a different way and posting
             * it separately is how the two come to describe different cameras.
             */
            const store = (kind, dec) => {
                const outSpec = genPlate.PLATE_OUTPUTS.find(x => x.assetKind === kind);
                const name = `${kind}_${shotId}${(outSpec && outSpec.ext) || '.png'}`;
                const path_ = saveFile(projectId, 'refsheets', name, dec.bytes);
                // REPLACES rather than accumulating: two plates for one shot
                // means "the plate" is whichever row the query returns.
                const prior = db.prepare(`SELECT id FROM film_assets
                    WHERE shot_id = ? AND json_valid(metadata)
                      AND json_extract(metadata, '$.kind') = ?`).all(shotId, kind);
                for (const old_ of prior) db.prepare('DELETE FROM film_assets WHERE id = ?').run(old_.id);

                const id = generateId();
                db.prepare(`INSERT INTO film_assets
                    (id, project_id, shot_id, asset_type, file_path, file_name, format, mime_type,
                     size_bytes, version, metadata)
                    VALUES (?, ?, ?, 'other', ?, ?, 'png', 'image/png', ?, 1, ?)`)
                    .run(id, projectId, shotId, path_, name, dec.bytes.length,
                         JSON.stringify(Object.assign({ kind }, record)));
                return { kind, asset_id: id, file_name: name, bytes: dec.bytes.length };
            };

            const stored = [store('plate_image', decoded)];

            if (body.depth) {
                const dep = genPlate.decodePlateImage(body.depth);
                // A bad depth pass must not lose the plate that decoded fine.
                if (dep.ok) stored.push(store('plate_depth', dep));
                else return json(res, 400, { error: `depth: ${dep.error}`, stored });
            }

            return json(res, 200, {
                stored: stored[0],
                outputs: stored,
                plate: record,
                state: genPlate.plateState(record, world),
                free: true,
                note: 'Stored. It now leads this shot\'s reference list on every generation path.',
            });
        }

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

/*
 * The shot tails this module answers, DECLARED rather than re-typed in
 * server.js.
 *
 * That list was hand-written, and adding a route here without adding it there
 * produces a handler that exists and is never reached — which looks exactly
 * like a missing feature and answers 405. It cost this phase once already:
 * match-reference, complexity and world-export were all live and unreachable.
 * Derived, the seventh arrives wired with nothing to remember.
 */
const SHOT_TAILS = Object.freeze([
    'world', 'direct', 'generation-plate',
    'match-reference', 'complexity', 'world-export',
]);

module.exports = { handleWorlds, SHOT_TAILS };
