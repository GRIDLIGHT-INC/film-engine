/**
 * Location CRUD + props + reference image generation
 * POST/GET /film/projects/:id/locations
 * GET/PUT/DELETE /film/locations/:id
 * POST /film/locations/:id/image/generate  — Generate location reference image
 * GET  /film/locations/:id/image           — Get location image status
 * POST/GET /film/projects/:id/props
 * GET/PUT/DELETE /film/props/:id
 * POST /film/props/:id/image/generate      — Generate prop reference image
 * GET  /film/props/:id/image               — Get prop image status
 */
const { headlinePlate } = require('../lib/plate-views');
const { db, generateId } = require('../db/database');
const { stampSubject } = require('../lib/story-bible');
const { serviceUnavailableError } = require('../lib/gridlight-client');
const fs = require('fs');
const path = require('path');
const { saveFile, getFileUrl, ensureDir } = require('../lib/file-storage');
const { persistProviderMedia } = require('../lib/provider-media');
const { resolve } = require('../lib/providers');
const { spendContext } = require('../lib/provider-config');
const { providerConfigFor } = require('../lib/provider-config');
const { generatePlate, PLATE_KINDS } = require('../lib/reference-plates');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_ENDPOINT = '/image';

// One implementation, in lib/provider-config.js — it also tags the config
// with the project id so spend can be attributed. See that file for why.
const parseProjectConfig = providerConfigFor;

/**
 * Generate the reference plate for one location or prop.
 *
 * Characters have had this since FILM-014; locations and props never did, so
 * lib/reference-images.js could rank them as referenceable kinds while nothing
 * was able to produce a plate to rank. Both kinds share one implementation in
 * lib/reference-plates.js — a second copy is how the character path acquired a
 * moderation fallback the others would not have inherited.
 */
async function generateSubjectPlate(req, res, kind, subjectId) {
    const { PLATE_KINDS } = require('../lib/reference-plates');
    const spec = PLATE_KINDS[kind];
    const subject = db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(subjectId);
    if (!subject) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `${kind} not found` }));
    }

    const project = db.prepare('SELECT id, style_preset, aspect_ratio, target_resolution FROM film_projects WHERE id = ?')
        .get(subject.project_id);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Project not found' }));
    }

    /*
     * Which VIEW of this subject to photograph, and the existing plate to match
     * it against.
     *
     * Generated independently, four views of a cul-de-sac produce four
     * different cul-de-sacs — the blue house on the right of one is not the
     * blue house you see when you turn. Each new view is anchored on one that
     * already exists so the set agrees with itself, which is the whole reason
     * for having a set.
     */
    const body = req.body || {};
    const view = String(body.view || '').trim();
    let anchorPath = null;
    if (view) {
        const existing = db.prepare(
            `SELECT file_path FROM film_assets
              WHERE project_id = ? AND ${spec.fkColumn} = ?
                AND asset_type IN ('reference_image', 'character_sheet')
           ORDER BY created_at ASC LIMIT 1`).get(project.id, subjectId);
        anchorPath = (existing && existing.file_path) || null;
    }

    const { imageOverride, promptOverride } = require('../lib/generation-override');
    const tierOverride = imageOverride(req.body || {});
    const provider = resolve('image',
        spendContext(project, null, null, tierOverride) || parseProjectConfig(subject.project_id));
    const result = await generatePlate({
        promptOverride: promptOverride(req.body || {}),
        tierOverride,
        projectId: project.id,
        kind,
        subject,
        stylePreset: project.style_preset,
        aspectRatio: project.aspect_ratio,
        // The whole project, so the plate is generated at the delivery size the
        // frames referencing it will use.
        project,
        provider,
        view,
        anchorPath,
        // So the board's pinned look travels as a picture, not only as the
        // words it composed into style_preset.
        db,
    });

    if (!result.ok) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Plate generation failed', details: result.error, kind, [`${kind}_id`]: subjectId }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ kind, [`${kind}_id`]: subjectId, name: subject.name, ...result }));
}


/**
 * Photograph all four sides of a location from the one plate it already has.
 *
 * The director's report: "all the views are on the same side. We don't have a
 * single picture of the opposite side, which is what is needed for 2AA." Every
 * prose view they had written — "looking back across the bulb", "looking at
 * MAYA's house" — is a position relative to a scene the model cannot see, so it
 * re-photographed the half it could. See COMPASS_VIEWS for why the fix is a
 * bearing and a sentence about where the old content went.
 *
 * One press, three generations, and the whole place is covered. Anchored on the
 * existing plate every time — not on the previously generated side — so a drift
 * introduced in `east` cannot compound into `south`: each side is one turn away
 * from the picture the director actually approved.
 *
 * Sides are generated in SEQUENCE, not in parallel. Three concurrent image
 * calls against one provider is how a queue earns a 429, and the retry costs
 * more than the wait.
 */
/**
 * What a sweep would buy, without buying it.
 *
 * Free, because the sweep is the one control that spends three generations in a
 * press, and a confirmation that cannot name what it is about to cost teaches
 * people to click past it. Same planner the sweep itself runs, so the number in
 * the dialog is the number that will be charged.
 */
function compassPlan(res, locationId) {
    const { planCompassSweep } = require('../lib/reference-plates');
    const location = db.prepare('SELECT id, project_id, name FROM film_locations WHERE id = ?').get(locationId);
    if (!location) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'location not found' }));
    }
    const rows = db.prepare(
        `SELECT metadata FROM film_assets
          WHERE project_id = ? AND location_id = ?
            AND asset_type IN ('reference_image', 'character_sheet')`).all(location.project_id, locationId);
    const plan = planCompassSweep({
        existingViews: rows.map(r => {
            try { return String((JSON.parse(r.metadata || '{}').view) || '').trim(); }
            catch (_) { return ''; }
        }),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ location_id: locationId, location: location.name, ...plan }));
}

async function sweepCompassViews(req, res, locationId) {
    const { planCompassSweep, generatePlate } = require('../lib/reference-plates');
    const location = db.prepare('SELECT * FROM film_locations WHERE id = ?').get(locationId);
    if (!location) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'location not found' }));
    }
    const project = db.prepare('SELECT id, style_preset, aspect_ratio, target_resolution FROM film_projects WHERE id = ?')
        .get(location.project_id);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Project not found' }));
    }

    const plates = db.prepare(
        `SELECT file_path, metadata FROM film_assets
          WHERE project_id = ? AND location_id = ?
            AND asset_type IN ('reference_image', 'character_sheet')
       ORDER BY created_at ASC`).all(project.id, locationId);
    const viewOf = row => {
        try { return String((JSON.parse(row.metadata || '{}').view) || '').trim(); }
        catch (_) { return ''; }
    };
    const plan = planCompassSweep({
        existingViews: plates.map(viewOf),
        overwrite: !!(req.body && req.body.overwrite),
    });

    if (plan.refused) {
        // 409 rather than 502: nothing failed, the prerequisite is missing, and
        // the fix is one button away on the same page.
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'NO_ANCHOR_PLATE', ...plan, location: location.name }));
    }

    /*
     * The anchor is the DEFAULT plate — the one the director generated and
     * kept. Falling back to "whatever exists" would let a sweep re-run turn
     * from a generated side, and each generation is one more step away from the
     * place they signed off.
     */
    const anchorRow = plates.find(r => !viewOf(r)) || plates[0];
    const provider = resolve('image', parseProjectConfig(location.project_id));

    const generated = [];
    for (const side of plan.generate) {
        // eslint-disable-next-line no-await-in-loop
        const result = await generatePlate({
            projectId: project.id, kind: 'location', subject: location,
            stylePreset: project.style_preset, aspectRatio: project.aspect_ratio,
            provider, view: side.name, anchorPath: anchorRow.file_path, db,
        });
        generated.push({ view: side.name, bearing: side.bearing, ...result });
        // A provider that has started refusing will refuse the next two as
        // well; stopping reports the reason once instead of three times, and
        // does not spend the retry budget finding out.
        if (!result.ok) break;
    }

    const failed = generated.filter(g => !g.ok);
    res.writeHead(failed.length && !generated.some(g => g.ok) ? 502 : 200,
        { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        location_id: locationId, location: location.name,
        anchor: plan.anchor,
        generated,
        skipped: plan.skipped.map(v => v.name),
        not_attempted: plan.generate.slice(generated.length).map(v => v.name),
        note: `${plan.anchor} is the plate you already had — the other sides are turns from it. `
            + 'A shot picks the side it is pointed at in its scene card.',
    }));
}

/**
 * The views a location has been photographed from.
 *
 * A location owned exactly one plate and every shot got it, whichever way the
 * camera pointed — so a reverse angle was handed a picture of what was behind
 * it. A shot now says which view it is looking at, and this is what it chooses
 * between.
 *
 * The default, view-less plate is listed first and named plainly rather than
 * left blank: it is the one every existing project has, and an unlabelled row
 * in a dropdown reads as a bug.
 */
function listPlateViews(res, locationId) {
    const loc = db.prepare('SELECT id, project_id, name FROM film_locations WHERE id = ?').get(locationId);
    if (!loc) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Location not found' }));
    }
    const rows = db.prepare(
        `SELECT id, file_name, file_path, metadata, created_at FROM film_assets
          WHERE project_id = ? AND location_id = ?
            AND asset_type IN ('reference_image', 'character_sheet')
       ORDER BY created_at ASC`).all(loc.project_id, locationId);

    const views = rows.map(r => {
        let meta = {};
        try { meta = JSON.parse(r.metadata || '{}'); } catch (_) { meta = {}; }
        const view = String(meta.view || '').trim();
        /*
         * Whether the picture is really THERE.
         *
         * This selected no `file_path` and manufactured an `image_url`
         * unconditionally, so a row whose file is gone was offered as a normal
         * choice with a broken <img> — and a picker filtering on "has an
         * image_url" filtered on something always truthy, which made its
         * "only choosable if visible" guarantee fiction.
         *
         * The URL is derived from where the file actually is rather than an
         * assumed 'refsheets', because these rows may be `character_sheet` and
         * may live elsewhere.
         */
        let available = false;
        try { available = !!(r.file_path && fs.existsSync(r.file_path)); } catch (_) { available = false; }
        const subdir = (() => {
            try { return path.basename(path.dirname(path.dirname(r.file_path))); } catch (_) { return null; }
        })();
        return {
            asset_id: r.id,
            view,                       // '' is the default plate
            // The default plate IS the compass anchor. Naming it 'default view'
            // beside east, south and west reads as a fifth, different thing;
            // it is the side the others are turns from.
            label: view || 'north — the plate the other sides turn from',
            file_name: r.file_name,
            available,
            unavailable_reason: available ? null
                : 'Picture unavailable — photograph this view again.',
            // Busted on the row's own timestamp: a regenerated view overwrites the
            // same filename, so without this the browser serves the old picture.
            image_url: (available && subdir)
                ? getFileUrl(subdir, loc.project_id, r.file_name, r.created_at) : null,
            created_at: r.created_at,
        };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        location_id: locationId,
        location: loc.name,
        views,
        note: views.length > 1
            ? 'A shot picks the view it is pointed at. Anything else falls back to the default plate.'
            : 'One view so far. A shot looking the other way is handed this one, which is a picture '
              + 'of what is behind its camera — generate the view it needs.',
    }));
}

/**
 * A plate supplied from outside, for a location or a prop.
 *
 * Sits beside the generate route deliberately: an upload and a generation
 * produce the same thing, and separating them into different corners of the app
 * is how a director ends up believing the only way to get a plate is to buy one.
 *
 * The most authoritative picture of a place is usually a photograph of it.
 */
function importSubjectPlateRoute(req, res, kind, subjectId) {
    const body = req.body || {};
    if (!body.data) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'no image supplied' }));
    }
    try {
        const imported = require('../lib/media-imports').importMedia(`${kind}-plate`, {
            subjectId, data: body.data, view: body.view, name: body.name,
        });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ kind, ...imported }));
    } catch (err) {
        // Named, not flattened: an upload refused with "invalid image" sends a
        // director back to Photoshop with nothing to change.
        res.writeHead(/not found/i.test(err.message) ? 404 : 400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: err.message }));
    }
}

/**
 * Refine an existing plate: keep the picture, change one thing.
 *
 * The plate a director already accepted travels as the reference, so this is an
 * EDIT rather than a fresh generation — the operation an image-to-image
 * provider performs well, and the one the compass sweep could not use because a
 * new camera position is precisely what an edit cannot produce.
 *
 * Replaces the plate it refined, in place, for the same view: two plates of one
 * view is a subject with two current references and no way to tell which a shot
 * used. The previous file is gone, which is why the confirmation says so.
 */

/**
 * FREE. What generating (or refining) this plate would send.
 *
 * A prompt you cannot read before editing is a prompt you are guessing at, and
 * every other paid image path in the engine shows its request first. Plates
 * were the exception, which is odd given a plate conditions every frame its
 * subject appears in.
 */
function previewSubjectPlate(req, res, kind, subjectId, mode, query) {
    const { PLATE_KINDS, buildPlatePrompt, buildPlateRefinePrompt, REFINE_NEGATIVE, NEGATIVE }
        = require('../lib/reference-plates');
    const spec = PLATE_KINDS[kind];
    if (!spec) return badReq(res, `unknown plate kind '${kind}'`);
    const subject = db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(subjectId);
    if (!subject) return notFoundJson(res, `${kind} not found`);
    const project = db.prepare('SELECT id, style_preset, aspect_ratio, target_resolution FROM film_projects WHERE id = ?')
        .get(subject.project_id);

    const q = query || {};
    const { imageOverride } = require('../lib/generation-override');
    const tierOverride = imageOverride({ quality: q.quality, provider: q.provider, model: q.model });
    const providers = require('../lib/providers');
    const cfg = spendContext(project || { id: subject.project_id }, null, null, tierOverride);
    const adapter = providers.get(providers.resolveId('image', cfg));

    const view = q.view ? String(q.view) : null;
    const instruction = String(q.instruction || '').trim();
    const prompt = mode === 'refine'
        ? buildPlateRefinePrompt(kind, subject, instruction || '(no instruction yet)', view)
        : buildPlatePrompt(kind, subject, project && project.style_preset, view, false);

    const payload = require('../lib/capability-payloads').withTierModel(
        { prompt }, { project: project || { id: subject.project_id }, tierOverride }, adapter);

    let cost = null;
    try {
        const rate = require('../lib/provider-pricing').rateFor(adapter.id, 'image', payload.model);
        if (rate) cost = { usd: rate.usd_per_unit !== undefined ? rate.usd_per_unit : rate.usd_per_native,
            native: rate.native_per_unit, native_unit: rate.native_unit };
    } catch (_) { /* an unpriced pair must not break a free preview */ }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        subject_id: subjectId, kind, mode: mode || 'generate', view,
        provider: adapter && adapter.id, model: payload.model || null,
        prompt, prompt_length: prompt.length,
        negative_prompt: mode === 'refine' ? REFINE_NEGATIVE : NEGATIVE,
        ceiling: Number(adapter && adapter.promptLimit) || null,
        estimated_cost: cost,
        note: 'Nothing was generated and nothing was spent.',
    }));
}

function notFoundJson(res, msg) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

async function refineSubjectPlate(req, res, kind, subjectId) {
    const { PLATE_KINDS, buildPlateRefinePrompt, REFINE_NEGATIVE, plateFileName } = require('../lib/reference-plates');
    const spec = PLATE_KINDS[kind];
    const subject = db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(subjectId);
    if (!subject) return badReq(res, `${kind} not found`, 404);

    const body = req.body || {};
    const instruction = String(body.instruction || '').trim();
    if (!instruction) return badReq(res, 'Say what should change: a refine is one instruction.');

    const view = String(body.view || '').trim();
    const fileName = plateFileName(kind, subject.name, view);
    const existing = db.prepare(
        `SELECT id, file_path, file_name FROM film_assets
          WHERE project_id = (SELECT project_id FROM ${spec.table} WHERE id = ?)
            AND ${spec.fkColumn} = ? AND asset_type = ? AND file_name = ?`)
        .get(subjectId, subjectId, spec.assetType, fileName);
    if (!existing || !existing.file_path || !fs.existsSync(existing.file_path)) {
        // Nothing to refine is a different problem from a failed refine.
        return badReq(res, view
            ? `There is no "${view}" plate to refine yet. Generate that view first.`
            : 'There is no plate to refine yet. Generate one first.', 409);
    }

    const project = db.prepare('SELECT id, style_preset, aspect_ratio, target_resolution FROM film_projects WHERE id = ?')
        .get(subject.project_id);
    const { imageOverride, promptOverride } = require('../lib/generation-override');
    const tierOverride = imageOverride(body);
    const provider = resolve('image',
        spendContext({ id: subject.project_id }, null, null, tierOverride)
            || parseProjectConfig(subject.project_id));
    if (!provider || typeof provider.generate !== 'function') {
        return badReq(res, 'no image provider resolved', 502);
    }

    const { toDataUri } = require('../lib/reference-images');
    const uri = toDataUri(existing.file_path);
    if (!uri) return badReq(res, 'The existing plate could not be read from disk.', 500);

    // An edited prompt replaces the composed one whole. The negative stays:
    // it is what keeps a refine from drifting into a fresh generation.
    const prompt = promptOverride(body) || buildPlateRefinePrompt(kind, subject, instruction,
        body.apply_style ? project && project.style_preset : null);

    const refinePayload_ = {
        prompt,
        negative_prompt: REFINE_NEGATIVE,
        aspect_ratio: (project && project.aspect_ratio) || undefined,
        // ONE reference: the plate being changed. A second picture is another
        // opinion about what this is, and a refine has only one subject.
        reference_images: [{ name: subject.name, kind: 'refine', tag: 'plate', uri }],
    };
    // The tier names the model for whichever provider was resolved above, so a
    // refine honours a per-call quality exactly as a generation does.
    require('../lib/capability-payloads').withTierModel(
        refinePayload_, { project: project || { id: subject.project_id }, tierOverride }, provider);
    const result = await provider.generate('image', refinePayload_, { timeout: 300000 });

    if (!result.ok) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Refine failed', details: result.error }));
    }

    const { persistProviderMedia } = require('../lib/provider-media');
    const saved = await persistProviderMedia(project.id, spec.subdir, fileName, result.data,
        { serveDir: 'images' });
    const filePath = typeof saved === 'string' ? saved : (saved && saved.path) || '';

    db.prepare('DELETE FROM film_assets WHERE id = ?').run(existing.id);
    const assetId = generateId();
    db.prepare(
        `INSERT INTO film_assets (id, project_id, ${spec.fkColumn}, asset_type, file_path, file_name,
            format, mime_type, version, metadata, provider, provider_model)
         VALUES (?, ?, ?, ?, ?, ?, 'png', 'image/png', 1, ?, ?, ?)`)
        .run(assetId, project.id, subject.id, spec.assetType, filePath, fileName,
            JSON.stringify({ kind: `${kind}_plate`, refined: true, instruction,
                ...(view ? { view } : {}) }),
            result.provider || provider.id || null, result.provider_model || null);

    require('../lib/artefact-fingerprint').stampAsset(assetId, `${kind}_plate`,
        kind === 'location' ? { locId: subject.id } : { propId: subject.id });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        kind, [`${kind}_id`]: subjectId, name: subject.name,
        asset_id: assetId, file_name: fileName, view: view || null,
        image_url: getFileUrl(spec.subdir, project.id, fileName, Date.now()),
        instruction,
        note: 'The previous plate was replaced. Every shot referencing this subject uses the new one.',
    }));
}

/**
 * Delete one view of a location.
 *
 * A location's view set could only GROW. Four views were generated on the real
 * production, all four were the same side, and removing the three duplicates
 * meant editing the database by hand — while the compass sweep SKIPS a side
 * that already exists, so a bad side was permanent and blocked the good one
 * from ever being bought.
 *
 * The file goes with the row. Half a delete is worse than none: an orphan row
 * lists a view whose picture is gone, and an orphan file is disk nobody can
 * find.
 *
 * It does NOT rewrite the scene cards that named this view — it REPORTS them.
 * Which side a shot looks at is a decision the director made, and silently
 * repointing it at another direction is precisely the class of bug views exist
 * to prevent. Left alone the card falls back to the default plate, which is the
 * documented behaviour and is visible in the shot's own prompt preview.
 */
function deletePlateView(res, locationId, rawView) {
    const loc = db.prepare('SELECT id, project_id, name FROM film_locations WHERE id = ?').get(locationId);
    if (!loc) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Location not found' }));
    }
    // The default plate has no view string, so it needs a name that can travel
    // in a URL path. An empty segment would be indistinguishable from a
    // malformed request.
    const wanted = rawView === '__default__' ? '' : String(rawView || '').trim();

    const rows = db.prepare(
        `SELECT id, file_name, file_path, metadata FROM film_assets
          WHERE project_id = ? AND location_id = ?
            AND asset_type IN ('reference_image', 'character_sheet')`).all(loc.project_id, locationId);
    const viewOf = row => {
        try { return String((JSON.parse(row.metadata || '{}').view) || '').trim(); }
        catch (_) { return ''; }
    };
    const matched = rows.filter(r => viewOf(r).toLowerCase() === wanted.toLowerCase());
    if (!matched.length) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            error: 'view not found',
            view: wanted,
            available: rows.map(viewOf).map(v => v || '(default)'),
        }));
    }

    // Whoever is pointed here, named rather than repointed.
    const shots = db.prepare(
        `SELECT sh.shot_code, sh.scene_card_yaml AS card
           FROM film_shots sh JOIN film_scenes sc ON sc.id = sh.scene_id
          WHERE sc.project_id = ?`).all(loc.project_id)
        .filter(row => {
            try { return String((JSON.parse(row.card || '{}').location_view) || '').trim().toLowerCase() === wanted.toLowerCase() && wanted; }
            catch (_) { return false; }
        })
        .map(row => row.shot_code);

    for (const r of matched) {
        try { if (r.file_path) fs.unlinkSync(r.file_path); } catch (_) { /* already gone is fine */ }
        db.prepare('DELETE FROM film_assets WHERE id = ?').run(r.id);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        location_id: locationId, location: loc.name,
        deleted: matched.length, view: wanted || null,
        was_default: !wanted,
        shots_pointing_here: shots,
        note: shots.length
            ? `${shots.join(', ')} named this view. Their cards are unchanged and now fall back to the `
              + 'default plate — point them at another side, or photograph this one again.'
            : (!wanted
                ? 'That was the plate the other sides turn from. Photograph the location again before '
                  + 'sweeping the compass: without it there is nothing to keep the sides continuous.'
                : 'Nothing was pointed at this view.'),
    }));
}

/** The current plate, if one has been generated. */
function getSubjectPlate(res, kind, subjectId) {
    const { PLATE_KINDS } = require('../lib/reference-plates');
    const spec = PLATE_KINDS[kind];
    /*
     * "The current plate" is the DEFAULT one, not the newest.
     *
     * The same bug as the list route, one function down: after a compass sweep
     * this reported whichever side was written last as the subject's plate.
     * The shared rule is the point — three sites answered this question and
     * two of them were wrong in the same way.
     */
    const asset = headlinePlate(db.prepare(
        `SELECT id, file_name, provider, provider_model, metadata, created_at
         FROM film_assets WHERE ${spec.fkColumn} = ? AND asset_type = ?
         ORDER BY created_at DESC`
    ).all(subjectId, spec.assetType));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ kind, [`${kind}_id`]: subjectId, plate: asset || null }));
}

function handleLocations(req, res, urlParts, query) {
    // /film/projects/:id/locations
    if (urlParts[1] === 'projects' && urlParts[3] === 'locations') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');
        if (req.method === 'GET') return listLocations(req, res, projectId);
        if (req.method === 'POST') return createLocation(req, res, projectId);
    }

    // /film/projects/:id/props
    if (urlParts[1] === 'projects' && urlParts[3] === 'props') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');
        if (req.method === 'GET') return listProps(req, res, projectId);
        if (req.method === 'POST') return createProp(req, res, projectId);
    }

    // /film/locations/:id/plate/generate — the canonical reference plate a shot
    // attaches as an image, distinct from /image which is a one-off render.
    if (urlParts[1] === 'locations' && urlParts[2] && urlParts[3] === 'plate') {
        const locId = urlParts[2];
        if (!UUID_RE.test(locId)) return badReq(res, 'Invalid location ID');
        if (urlParts[4] === 'generate' && req.method === 'POST') return generateSubjectPlate(req, res, 'location', locId);
        // Keep the picture, change one thing.
        if (urlParts[4] === 'refine' && req.method === 'POST') return refineSubjectPlate(req, res, 'location', locId);
        if (urlParts[4] === 'plate-preview' && req.method === 'GET') return previewSubjectPlate(req, res, 'location', locId, 'generate', query);
        if (urlParts[4] === 'refine-preview' && req.method === 'GET') return previewSubjectPlate(req, res, 'location', locId, 'refine', query);
        // A picture made outside Film Engine, landing where a generated one would.
        if (urlParts[4] === 'import' && req.method === 'POST') return importSubjectPlateRoute(req, res, 'location', locId);
        // /film/locations/:id/plate/views — what a shot can choose between.
        if (urlParts[4] === 'views' && !urlParts[5] && req.method === 'GET') return listPlateViews(res, locId);
        // Remove one view. The set could only grow, so a bad side was permanent.
        if (urlParts[4] === 'views' && urlParts[5] && req.method === 'DELETE') {
            return deletePlateView(res, locId, decodeURIComponent(urlParts[5]));
        }
        // All four sides from the one plate this location already has.
        if (urlParts[4] === 'compass' && urlParts[5] === 'plan' && req.method === 'GET') return compassPlan(res, locId);
        if (urlParts[4] === 'compass' && req.method === 'POST') return sweepCompassViews(req, res, locId);
        if (req.method === 'GET') return getSubjectPlate(res, 'location', locId);
    }

    // /film/props/:id/plate/generate
    if (urlParts[1] === 'props' && urlParts[2] && urlParts[3] === 'plate') {
        const propId = urlParts[2];
        if (urlParts[4] === 'plate-preview' && req.method === 'GET') return previewSubjectPlate(req, res, 'prop', propId, 'generate', query);
        if (urlParts[4] === 'refine-preview' && req.method === 'GET') return previewSubjectPlate(req, res, 'prop', propId, 'refine', query);
        if (!UUID_RE.test(propId)) return badReq(res, 'Invalid prop ID');
        if (urlParts[4] === 'import' && req.method === 'POST') return importSubjectPlateRoute(req, res, 'prop', propId);
        if (urlParts[4] === 'generate' && req.method === 'POST') return generateSubjectPlate(req, res, 'prop', propId);
        // Keep the picture, change one thing.
        if (urlParts[4] === 'refine' && req.method === 'POST') return refineSubjectPlate(req, res, 'prop', propId);
        if (req.method === 'GET') return getSubjectPlate(res, 'prop', propId);
    }

    // /film/locations/:id/image[/generate]
    if (urlParts[1] === 'locations' && urlParts[2] && urlParts[3] === 'image') {
        const locId = urlParts[2];
        if (!UUID_RE.test(locId)) return badReq(res, 'Invalid location ID');
        if (urlParts[4] === 'generate' && req.method === 'POST') return generateLocationImage(req, res, locId);
        if (req.method === 'GET') return getLocationImageStatus(req, res, locId);
    }

    // /film/locations/:id
    if (urlParts[1] === 'locations' && urlParts[2]) {
        const locId = urlParts[2];
        if (!UUID_RE.test(locId)) return badReq(res, 'Invalid location ID');
        if (req.method === 'GET') return getLocation(req, res, locId);
        if (req.method === 'PUT') return updateLocation(req, res, locId);
        if (req.method === 'DELETE') return deleteLocation(req, res, locId);
    }

    // /film/props/:id/image[/generate]
    if (urlParts[1] === 'props' && urlParts[2] && urlParts[3] === 'image') {
        const propId = urlParts[2];
        if (!UUID_RE.test(propId)) return badReq(res, 'Invalid prop ID');
        if (urlParts[4] === 'generate' && req.method === 'POST') return generatePropImage(req, res, propId);
        if (req.method === 'GET') return getPropImageStatus(req, res, propId);
    }

    // /film/props/:id
    if (urlParts[1] === 'props' && urlParts[2]) {
        const propId = urlParts[2];
        if (!UUID_RE.test(propId)) return badReq(res, 'Invalid prop ID');
        if (req.method === 'GET') return getProp(req, res, propId);
        if (req.method === 'PUT') return updateProp(req, res, propId);
        if (req.method === 'DELETE') return deleteProp(req, res, propId);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

// A status may be supplied: 409 for "nothing to refine yet" is a different
// answer from 400 "you asked for it wrong", and collapsing them tells a
// director to fix their request when the request was fine.
function badReq(res, msg, status = 400) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

// --- Locations ---

function listLocations(req, res, projectId) {
    const rows = db.prepare('SELECT * FROM film_locations WHERE project_id = ? ORDER BY name').all(projectId);
    /*
     * Whether each subject has a reference plate, from the SAME query the
     * gatherer uses to attach one. The picker that shows this had three
     * invented field names and reported "no plate" for every subject in every
     * project — telling a director their cast would be invented fresh in each
     * frame when it was already plated, which is misinformation in the
     * direction that costs money to act on.
     */
    try {
        const { platedSubjects } = require('../lib/shot-references');
        const plated = platedSubjects(db, projectId).locations;
        const byId = new Map(plated.map(p => [p.id, p.has_plate]));
        for (const r of rows) r.has_plate = !!byId.get(r.id);
    } catch (_) { /* the list is still a list without it */ }


    // Attach scene count and reference image per location
    const refImageQuery = db.prepare(
        /*
         * EVERY plate, not the newest one.
         *
         * This took `ORDER BY created_at DESC LIMIT 1`, so after a compass
         * sweep wrote east and south, the location's headline plate became
         * SOUTH — the last side written, and west had it completed. The master
         * on disk was untouched; only the pointer moved. A compass side is an
         * additional view, not a replacement.
         *
         * version and created_at are selected because the URL builder busts
         * the browser cache with them; omitted, they are silently undefined
         * and a regenerated plate serves the cached picture.
         */
        "SELECT file_name, project_id, version, created_at, metadata FROM film_assets "
        + "WHERE asset_type = 'reference_image' AND location_id = ? ORDER BY created_at DESC"
    );
    for (const loc of rows) {
        const count = db.prepare("SELECT COUNT(*) AS count FROM film_scenes WHERE project_id = ? AND location = ?").get(projectId, loc.name);
        loc.scene_count = count.count;
        // One rule, shared with gatherShotReferences — two paths deciding this
        // separately is what let the display disagree with the generator.
        const refAsset = headlinePlate(refImageQuery.all(loc.id));
        // The subdir comes from the plate builder's own registry, never a
        // literal. These two lists each hardcoded their own directory while the
        // builder wrote somewhere else, so the row was found, a URL was
        // returned, and it pointed at a directory the file was not in — a plate
        // that existed, was correctly linked, and rendered as nothing.
        loc.reference_image_url = refAsset
            ? getFileUrl(PLATE_KINDS.location.subdir, refAsset.project_id, refAsset.file_name,
                refAsset.created_at || refAsset.version) : null;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ locations: rows }));
}

function getLocation(req, res, locId) {
    const loc = db.prepare('SELECT * FROM film_locations WHERE id = ?').get(locId);
    if (!loc) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Location not found' }));
        return;
    }

    // Include scenes at this location
    loc.scenes = db.prepare(
        "SELECT id, scene_number, int_ext, time_of_day, status FROM film_scenes WHERE project_id = ? AND location = ? ORDER BY scene_number"
    ).all(loc.project_id, loc.name);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loc));
}

function createLocation(req, res, projectId) {
    const body = req.body;
    if (!body.name || !body.name.trim()) return badReq(res, 'Location name is required');

    // Reject a duplicate name rather than silently creating a second record.
    // Screenplays are edited and re-edited, and the same location comes back
    // every pass — without this, each pass could add another copy, and every
    // downstream reference (consistency profile, reference images, shots)
    // would then be split across duplicates that look identical in the UI.
    // Case- and whitespace-insensitive, because "KITCHEN" and "Kitchen " are the
    // same place to everyone except a database.
    const existing = db.prepare(
        'SELECT * FROM film_locations WHERE project_id = ? AND UPPER(TRIM(name)) = UPPER(TRIM(?))'
    ).get(projectId, body.name);
    if (existing) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: 'Location "' + existing.name + '" already exists in this project.',
            code: 'duplicate_name',
            existing,
            // Named, or a caller with nothing else to try simply tries again —
            // which is exactly how props ended up duplicated.
            hint: 'Use location_update to change it, or location_delete to remove it first.',
        }));
        return;
    }

    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_locations (id, project_id, name, description, reference_prompt,
            reference_images, lighting_default, time_of_day_default, atmosphere_notes,
            sound_notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, projectId,
        body.name.trim().slice(0, 300),
        (body.description || '').slice(0, 5000),
        (body.reference_prompt || '').slice(0, 2000),
        JSON.stringify(body.reference_images || []),
        // 500, not 50: this reaches the prompt, and a lighting note worth
        // writing does not fit in fifty characters.
        (body.lighting_default || 'natural').slice(0, 500),
        (body.time_of_day_default || '').slice(0, 50),
        (body.atmosphere_notes || '').slice(0, 2000),
        (body.sound_notes || '').slice(0, 2000),
        now, now
    );

    const row = db.prepare('SELECT * FROM film_locations WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function updateLocation(req, res, locId) {
    // Which part of the story bible this description was written from.
    //
    // Recorded here rather than inferred later, because only the person writing
    // the words knows which section they were reading. Without it a bible
    // revision can say "something changed" and never "and MAYA's appearance came
    // from it", which is the difference between a note and an instruction.
    if (req.body && req.body.bible_section) {
        stampSubject('location', locId, String(req.body.bible_section));
    }
    const body = req.body;
    const propagateToScreenplay = body.propagate_to_screenplay !== false;

    // Get current location to check for name changes
    const currentLoc = db.prepare('SELECT * FROM film_locations WHERE id = ?').get(locId);
    if (!currentLoc) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Location not found' }));
        return;
    }

    const fields = [];
    const values = [];

    const textFields = {
        name: 300, description: 5000, reference_prompt: 2000,
        lighting_default: 50, time_of_day_default: 50,
        atmosphere_notes: 2000, sound_notes: 2000,
        // What must stay true across every shot here, once something has been
        // moved, broken or repainted. The sheet's own region — see
        // lib/subject-sheets.js.
        continuity_notes: 2000,
        location_type: 100,
    };

    for (const [field, maxLen] of Object.entries(textFields)) {
        if (body[field] !== undefined) {
            fields.push(`${field} = ?`);
            values.push(String(body[field]).slice(0, maxLen));
        }
    }
    if (body.reference_images !== undefined) {
        fields.push('reference_images = ?');
        values.push(JSON.stringify(body.reference_images));
    }

    // Recording where a description came from is a change in itself, and does
    // not require rewriting the description to say it. Refusing a link-only
    // update would mean an agent that has just read the bible has to touch the
    // text to record that it did.
    if (fields.length === 0 && req.body && req.body.bible_section) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ linked: true, bible_section: String(req.body.bible_section) }));
    }
    if (fields.length === 0) return badReq(res, 'No valid fields to update');

    fields.push("updated_at = datetime('now')");
    values.push(locId);

    const result = db.prepare(`UPDATE film_locations SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const row = db.prepare('SELECT * FROM film_locations WHERE id = ?').get(locId);

    // FILM-122: Propagate name change to screenplay if name was changed
    let screenplayUpdate = null;
    if (propagateToScreenplay && body.name && body.name !== currentLoc.name) {
        screenplayUpdate = propagateLocationRename(
            currentLoc.project_id,
            currentLoc.name,
            body.name
        );
    }

    const response = { ...row };
    if (screenplayUpdate) {
        response.screenplay_update = screenplayUpdate;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
}

/**
 * FILM-122: Propagate location rename to screenplay
 * Finds all occurrences of old location in scene headings and replaces with new name
 */
function propagateLocationRename(projectId, oldName, newName) {
    // Get latest Fountain script
    const script = db.prepare(`
        SELECT id, version, fountain_content, format
        FROM film_scripts
        WHERE project_id = ?
        ORDER BY version DESC
        LIMIT 1
    `).get(projectId);

    if (!script || script.format !== 'fountain' || !script.fountain_content) {
        return { updated: false, reason: 'No Fountain script found' };
    }

    const oldNameUpper = oldName.toUpperCase();
    const newNameUpper = newName.toUpperCase();
    const lines = script.fountain_content.split('\n');
    let replacementCount = 0;

    // Replace location in scene headings
    const sceneHeadingPattern = /^(\.)?(?:\s)*(INT|EXT|EST|INT\.?\/?EXT|EXT\.?\/?INT|I\/E)[\.\s]+/i;

    const newLines = lines.map(line => {
        const trimmed = line.trim();

        // Check if this is a scene heading
        if (sceneHeadingPattern.test(trimmed)) {
            // Scene heading format: INT./EXT. LOCATION - TIME
            const match = trimmed.match(/^(\.)?(?:\s)*(INT|EXT|EST|INT\.?\/?EXT|EXT\.?\/?INT|I\/E)([\.\s]+)(.+)$/i);
            if (match) {
                const prefix = match[2];
                const separator = match[3];
                const rest = match[4];

                // Check if location matches (before the dash)
                const dashIndex = rest.indexOf(' - ');
                const locationPart = dashIndex >= 0 ? rest.slice(0, dashIndex) : rest;
                const timePart = dashIndex >= 0 ? rest.slice(dashIndex) : '';

                if (locationPart.toUpperCase() === oldNameUpper) {
                    replacementCount++;
                    return prefix + separator + newNameUpper + timePart;
                }
            }
        }

        return line;
    });

    if (replacementCount === 0) {
        return { updated: false, reason: 'No occurrences found in screenplay', occurrences: 0 };
    }

    // Save as new script version
    const newFountain = newLines.join('\n');
    const nextVersion = script.version + 1;
    const wordCount = newFountain.split(/\s+/).filter(w => w.length > 0).length;

    const scriptId = generateId();
    db.prepare(`
        INSERT INTO film_scripts
        (id, project_id, version, content, word_count, format, fountain_content, created_at)
        VALUES (?, ?, ?, ?, ?, 'fountain', ?, datetime('now'))
    `).run(scriptId, projectId, nextVersion, newFountain, wordCount, newFountain);

    return {
        updated: true,
        occurrences: replacementCount,
        new_version: nextVersion,
        old_name: oldName,
        new_name: newName
    };
}

function deleteLocation(req, res, locId) {
    const result = db.prepare('DELETE FROM film_locations WHERE id = ?').run(locId);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Location not found' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

// --- Props ---

function listProps(req, res, projectId) {
    const rows = db.prepare('SELECT * FROM film_props WHERE project_id = ? ORDER BY name').all(projectId);
    /*
     * Whether each subject has a reference plate, from the SAME query the
     * gatherer uses to attach one. The picker that shows this had three
     * invented field names and reported "no plate" for every subject in every
     * project — telling a director their cast would be invented fresh in each
     * frame when it was already plated, which is misinformation in the
     * direction that costs money to act on.
     */
    try {
        const { platedSubjects } = require('../lib/shot-references');
        const plated = platedSubjects(db, projectId).props;
        const byId = new Map(plated.map(p => [p.id, p.has_plate]));
        for (const r of rows) r.has_plate = !!byId.get(r.id);
    } catch (_) { /* the list is still a list without it */ }


    // Attach reference image per prop
    // The prop_id COLUMN, not a LIKE against metadata. Migration 061 added the
    // column precisely so a prop plate had somewhere to link, and the plate
    // builder writes it — but this query still searched the metadata blob,
    // where nothing puts a prop_id. So a generated prop plate existed, was
    // correctly linked, and was invisible.
    const refImageQuery = db.prepare(
        "SELECT file_name, project_id, version, created_at, metadata FROM film_assets "
        + "WHERE asset_type = 'reference_image' AND prop_id = ? ORDER BY created_at DESC"
    );
    for (const prop of rows) {
        const refAsset = headlinePlate(refImageQuery.all(prop.id));
        prop.reference_image_url = refAsset
            ? getFileUrl(PLATE_KINDS.prop.subdir, refAsset.project_id, refAsset.file_name,
                refAsset.created_at || refAsset.version) : null;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ props: rows }));
}

function getProp(req, res, propId) {
    const prop = db.prepare('SELECT * FROM film_props WHERE id = ?').get(propId);
    if (!prop) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Prop not found' }));
        return;
    }

    // Include scene appearances
    prop.scenes = db.prepare(`
        SELECT sp.scene_id, s.scene_number, s.location, sp.notes
        FROM film_scene_props sp JOIN film_scenes s ON sp.scene_id = s.id
        WHERE sp.prop_id = ? ORDER BY s.scene_number
    `).all(propId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(prop));
}

function createProp(req, res, projectId) {
    const body = req.body;
    if (!body.name || !body.name.trim()) return badReq(res, 'Prop name is required');

    // Characters and locations have refused a duplicate name since they were
    // written; props never did, and props were the only kind that duplicated.
    // Two rows with one name is worse than an error: the gather query resolves
    // it by picking one, so the other silently rots and a plate is generated
    // from a description nobody is reading.
    const existing = db.prepare(
        'SELECT id, name FROM film_props WHERE project_id = ? AND UPPER(name) = UPPER(?)')
        .get(projectId, body.name.trim());
    if (existing) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            error: `Prop "${existing.name}" already exists in this project.`,
            code: 'duplicate_name',
            existing,
            // Named, or a caller with nothing else to try simply tries again.
            hint: 'Use prop_update to change it, or prop_delete to remove it first.',
        }));
    }

    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_props (id, project_id, name, description, visual_prompt,
            category, reference_images, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, projectId,
        body.name.trim().slice(0, 200),
        (body.description || '').slice(0, 2000),
        (body.visual_prompt || '').slice(0, 2000),
        (body.category || 'generic').slice(0, 50),
        JSON.stringify(body.reference_images || []),
        (body.notes || '').slice(0, 2000),
        now
    );

    const row = db.prepare('SELECT * FROM film_props WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function updateProp(req, res, propId) {
    // Which part of the story bible this description was written from.
    //
    // Recorded here rather than inferred later, because only the person writing
    // the words knows which section they were reading. Without it a bible
    // revision can say "something changed" and never "and MAYA's appearance came
    // from it", which is the difference between a note and an instruction.
    if (req.body && req.body.bible_section) {
        stampSubject('prop', propId, String(req.body.bible_section));
    }
    const body = req.body;
    const fields = [];
    const values = [];

    // Dimensions in metres. Validated as numbers rather than length-capped
    // strings: a size is the one field here that has to survive as a number,
    // because the prompt divides by it.
    for (const field of ['height_m', 'width_m', 'length_m']) {
        if (body[field] === undefined) continue;
        const n = Number(body[field]);
        if (!Number.isFinite(n) || n <= 0) {
            return badReq(res, `${field} must be a positive number of metres`);
        }
        fields.push(`${field} = ?`);
        values.push(n);
    }

    // Whether it has to WORK on camera. A practical is built differently and
    // is a production constraint, not a note; stored as 0/1 because SQLite has
    // no boolean and a string "false" is truthy everywhere that reads it.
    if (body.practical !== undefined) {
        fields.push('practical = ?');
        values.push(body.practical ? 1 : 0);
    }
    if (body.quantity !== undefined) {
        const n = Math.round(Number(body.quantity));
        if (!Number.isFinite(n) || n < 0) return badReq(res, 'quantity must be a whole number');
        fields.push('quantity = ?');
        values.push(n);
    }
    /*
     * Clean, chipped, burnt — the versions of one object.
     *
     * Refused rather than repaired: a state with no name is a row a director
     * cannot refer to afterwards, and storing it bent means the sheet lists
     * something nobody can identify.
     */
    if (body.continuity_states !== undefined) {
        const raw = Array.isArray(body.continuity_states) ? body.continuity_states : [];
        const clean = raw.map(st => ({
            name: String((st && st.name) || '').slice(0, 120),
            what: String((st && st.what) || '').slice(0, 500),
            scene: String((st && st.scene) || '').slice(0, 120),
        }));
        if (clean.some(st => !st.name)) return badReq(res, 'every continuity state needs a name');
        fields.push('continuity_states = ?');
        values.push(JSON.stringify(clean));
    }

    for (const [field, maxLen] of Object.entries({
        name: 200, description: 2000, visual_prompt: 2000, category: 50, notes: 2000,
        // The sheet's own fields — see lib/subject-sheets.js.
        materials: 1000, period: 120, constraints: 1000,
    })) {
        if (body[field] !== undefined) {
            fields.push(`${field} = ?`);
            values.push(String(body[field]).slice(0, maxLen));
        }
    }
    if (body.reference_images !== undefined) {
        fields.push('reference_images = ?');
        values.push(JSON.stringify(body.reference_images));
    }
    // Recording where a description came from is a change in itself, and does
    // not require rewriting the description to say it. Refusing a link-only
    // update would mean an agent that has just read the bible has to touch the
    // text to record that it did.
    if (fields.length === 0 && req.body && req.body.bible_section) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ linked: true, bible_section: String(req.body.bible_section) }));
    }
    if (fields.length === 0) return badReq(res, 'No valid fields to update');

    values.push(propId);
    const result = db.prepare(`UPDATE film_props SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Prop not found' }));
        return;
    }

    const row = db.prepare('SELECT * FROM film_props WHERE id = ?').get(propId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function deleteProp(req, res, propId) {
    const result = db.prepare('DELETE FROM film_props WHERE id = ?').run(propId);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Prop not found' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

// --- Location Image Generation ---

function buildLocationPrompt(location) {
    const parts = ['detailed environment concept art'];
    if (location.reference_prompt) parts.push(location.reference_prompt);
    if (location.description) parts.push(location.description.slice(0, 500));
    if (location.lighting_default && location.lighting_default !== 'natural') parts.push(location.lighting_default + ' lighting');
    if (location.atmosphere_notes) parts.push(location.atmosphere_notes.slice(0, 300));
    if (location.time_of_day_default) parts.push(location.time_of_day_default);
    parts.push('masterpiece, high quality, cinematic');
    return parts.join(', ');
}

async function generateLocationImage(req, res, locId) {
    const loc = db.prepare('SELECT * FROM film_locations WHERE id = ?').get(locId);
    if (!loc) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Location not found' }));
    }

    const seed = (req.body && req.body.seed) || null;
    /*
     * No default model.
     *
     * This named a model none of the image providers wired here offers, so
     * Meshy fell through to its own default of nano-banana-pro at 9 credits —
     * silently buying the most expensive model in the catalogue while ignoring
     * the project's quality tier entirely.
     *
     * The job row keeps a readable value; the PAYLOAD gets nothing unless a
     * caller asked, which lets the tier decide.
     */
    const model = (req.body && req.body.model) || null;

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_location_image_jobs (id, project_id, location_id, status, model, seed)
         VALUES (?, ?, ?, 'processing', ?, ?)`
    ).run(jobId, loc.project_id, locId, model, seed);

    const prompt = buildLocationPrompt(loc);
    const negativePrompt = 'blurry, low quality, distorted, text, watermark, people, characters';

    const payload = {
        prompt,
        negative_prompt: negativePrompt,
        // Absent rather than null: a null falls through to the provider's own
        // default, which is the most expensive model it sells.
        ...(model ? { model } : {}),
        width: 1024,
        height: 1024,
        steps: 30,
        guidance_scale: 7.5,
        seed,
    };

    try {
        const result = await resolve('image', parseProjectConfig(loc.project_id)).generate('image', payload, { timeout: 300000 });
        if (!result.ok) {
            db.prepare('UPDATE film_location_image_jobs SET status = ?, error_message = ? WHERE id = ?')
                .run('failed', result.error, jobId);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Image generation failed', details: result.error }));
        }

        const safeName = loc.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `${safeName}.png`;
        let filePath;
        try {
            filePath = await persistProviderMedia(loc.project_id, 'loc-refs', filename, result.data, { serveDir: 'images' });
        } catch (err) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Reference image generated but could not be stored', details: err.message }));
        }

        const assetId = generateId();
        db.prepare(
            `INSERT OR REPLACE INTO film_assets (
                id, project_id, asset_type, file_path, file_name, format, mime_type, location_id, version, metadata,
                provider, provider_model, provider_job_id, license_source, license_status
             )
             VALUES (?, ?, 'reference_image', ?, ?, 'png', 'image/png', ?, 1, ?, ?, ?, ?, 'generated', 'generated')`
        ).run(
            assetId, loc.project_id, filePath, filename, locId, JSON.stringify({ location_id: locId }),
            result.provider || '', result.provider_model || '', result.provider_job_id || ''
        );

        db.prepare('UPDATE film_location_image_jobs SET status = ?, output_path = ? WHERE id = ?')
            .run('complete', filePath, jobId);

        const imageUrl = getFileUrl('loc-refs', loc.project_id, filename, Date.now());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            location_id: locId, location_name: loc.name, job_id: jobId,
            status: 'complete', image_url: imageUrl,
        }));
    } catch (err) {
        if (err.message && err.message.includes('ECONNREFUSED')) {
            db.prepare('UPDATE film_location_image_jobs SET status = ?, error_message = ? WHERE id = ?')
                .run('failed', 'Image generation service unavailable', jobId);
            res.writeHead(503, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(serviceUnavailableError(IMAGE_ENDPOINT, 'image generation')));
        }
        db.prepare('UPDATE film_location_image_jobs SET status = ?, error_message = ? WHERE id = ?')
            .run('failed', err.message, jobId);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Image generation failed', details: err.message }));
    }
}

function getLocationImageStatus(req, res, locId) {
    const jobs = db.prepare('SELECT * FROM film_location_image_jobs WHERE location_id = ? ORDER BY created_at DESC').all(locId);
    const assets = db.prepare(
        "SELECT * FROM film_assets WHERE asset_type = 'reference_image' AND location_id = ? ORDER BY created_at DESC"
    ).all(locId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        location_id: locId, jobs,
        images: assets.map(a => ({
            asset_id: a.id, file_name: a.file_name,
            image_url: a.file_name ? getFileUrl('loc-refs', a.project_id, a.file_name, a.created_at || a.version) : null,
        })),
    }));
}

// --- Prop Image Generation ---

function buildPropPrompt(prop) {
    const parts = ['product photography, isolated object, clean background'];
    if (prop.visual_prompt) parts.push(prop.visual_prompt);
    if (prop.description) parts.push(prop.description.slice(0, 500));
    if (prop.category && prop.category !== 'generic') parts.push(prop.category);
    parts.push('masterpiece, high quality, detailed');
    return parts.join(', ');
}

async function generatePropImage(req, res, propId) {
    const prop = db.prepare('SELECT * FROM film_props WHERE id = ?').get(propId);
    if (!prop) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Prop not found' }));
    }

    const seed = (req.body && req.body.seed) || null;
    /*
     * No default model.
     *
     * This named a model none of the image providers wired here offers, so
     * Meshy fell through to its own default of nano-banana-pro at 9 credits —
     * silently buying the most expensive model in the catalogue while ignoring
     * the project's quality tier entirely.
     *
     * The job row keeps a readable value; the PAYLOAD gets nothing unless a
     * caller asked, which lets the tier decide.
     */
    const model = (req.body && req.body.model) || null;

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_prop_image_jobs (id, project_id, prop_id, status, model, seed)
         VALUES (?, ?, ?, 'processing', ?, ?)`
    ).run(jobId, prop.project_id, propId, model, seed);

    const prompt = buildPropPrompt(prop);
    const negativePrompt = 'blurry, low quality, distorted, text, watermark, multiple objects, cluttered background';

    const payload = {
        prompt,
        negative_prompt: negativePrompt,
        // Absent rather than null: a null falls through to the provider's own
        // default, which is the most expensive model it sells.
        ...(model ? { model } : {}),
        width: 1024,
        height: 1024,
        steps: 30,
        guidance_scale: 7.5,
        seed,
    };

    try {
        const result = await resolve('image', parseProjectConfig(prop.project_id)).generate('image', payload, { timeout: 300000 });
        if (!result.ok) {
            db.prepare('UPDATE film_prop_image_jobs SET status = ?, error_message = ? WHERE id = ?')
                .run('failed', result.error, jobId);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Image generation failed', details: result.error }));
        }

        const safeName = prop.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `${safeName}.png`;
        let filePath;
        try {
            filePath = await persistProviderMedia(prop.project_id, 'prop-refs', filename, result.data, { serveDir: 'images' });
        } catch (err) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Reference image generated but could not be stored', details: err.message }));
        }

        const assetId = generateId();
        db.prepare(
            `INSERT OR REPLACE INTO film_assets (
                id, project_id, asset_type, file_path, file_name, format, mime_type, version, metadata,
                provider, provider_model, provider_job_id, license_source, license_status
             )
             VALUES (?, ?, 'reference_image', ?, ?, 'png', 'image/png', 1, ?, ?, ?, ?, 'generated', 'generated')`
        ).run(
            assetId, prop.project_id, filePath, filename, JSON.stringify({ prop_id: propId }),
            result.provider || '', result.provider_model || '', result.provider_job_id || ''
        );

        db.prepare('UPDATE film_prop_image_jobs SET status = ?, output_path = ? WHERE id = ?')
            .run('complete', filePath, jobId);

        const imageUrl = getFileUrl('prop-refs', prop.project_id, filename, Date.now());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            prop_id: propId, prop_name: prop.name, job_id: jobId,
            status: 'complete', image_url: imageUrl,
        }));
    } catch (err) {
        if (err.message && err.message.includes('ECONNREFUSED')) {
            db.prepare('UPDATE film_prop_image_jobs SET status = ?, error_message = ? WHERE id = ?')
                .run('failed', 'Image generation service unavailable', jobId);
            res.writeHead(503, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(serviceUnavailableError(IMAGE_ENDPOINT, 'image generation')));
        }
        db.prepare('UPDATE film_prop_image_jobs SET status = ?, error_message = ? WHERE id = ?')
            .run('failed', err.message, jobId);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Image generation failed', details: err.message }));
    }
}

function getPropImageStatus(req, res, propId) {
    const jobs = db.prepare('SELECT * FROM film_prop_image_jobs WHERE prop_id = ? ORDER BY created_at DESC').all(propId);
    const assets = db.prepare(
        "SELECT * FROM film_assets WHERE asset_type = 'reference_image' AND metadata LIKE ? ORDER BY created_at DESC"
    ).all(`%"prop_id":"${propId}"%`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        prop_id: propId, jobs,
        images: assets.map(a => ({
            asset_id: a.id, file_name: a.file_name,
            image_url: a.file_name ? getFileUrl('prop-refs', a.project_id, a.file_name, a.created_at || a.version) : null,
        })),
    }));
}

module.exports = { handleLocations };
