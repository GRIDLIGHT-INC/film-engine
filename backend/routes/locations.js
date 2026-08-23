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
const { db, generateId } = require('../db/database');
const { stampSubject } = require('../lib/story-bible');
const { serviceUnavailableError } = require('../lib/gridlight-client');
const { saveFile, getFileUrl, ensureDir } = require('../lib/file-storage');
const { persistProviderMedia } = require('../lib/provider-media');
const { resolve } = require('../lib/providers');
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

    const project = db.prepare('SELECT id, style_preset, aspect_ratio FROM film_projects WHERE id = ?')
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

    const provider = resolve('image', parseProjectConfig(subject.project_id));
    const result = await generatePlate({
        projectId: project.id,
        kind,
        subject,
        stylePreset: project.style_preset,
        aspectRatio: project.aspect_ratio,
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
        `SELECT id, file_name, metadata, created_at FROM film_assets
          WHERE project_id = ? AND location_id = ?
            AND asset_type IN ('reference_image', 'character_sheet')
       ORDER BY created_at ASC`).all(loc.project_id, locationId);

    const views = rows.map(r => {
        let meta = {};
        try { meta = JSON.parse(r.metadata || '{}'); } catch (_) { meta = {}; }
        const view = String(meta.view || '').trim();
        return {
            asset_id: r.id,
            view,                       // '' is the default plate
            label: view || 'default view',
            file_name: r.file_name,
            image_url: getFileUrl('refsheets', loc.project_id, r.file_name),
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

/** The current plate, if one has been generated. */
function getSubjectPlate(res, kind, subjectId) {
    const { PLATE_KINDS } = require('../lib/reference-plates');
    const spec = PLATE_KINDS[kind];
    const asset = db.prepare(
        `SELECT id, file_name, provider, provider_model, metadata, created_at
         FROM film_assets WHERE ${spec.fkColumn} = ? AND asset_type = ?
         ORDER BY created_at DESC LIMIT 1`
    ).get(subjectId, spec.assetType);

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
        // /film/locations/:id/plate/views — what a shot can choose between.
        if (urlParts[4] === 'views' && req.method === 'GET') return listPlateViews(res, locId);
        if (req.method === 'GET') return getSubjectPlate(res, 'location', locId);
    }

    // /film/props/:id/plate/generate
    if (urlParts[1] === 'props' && urlParts[2] && urlParts[3] === 'plate') {
        const propId = urlParts[2];
        if (!UUID_RE.test(propId)) return badReq(res, 'Invalid prop ID');
        if (urlParts[4] === 'generate' && req.method === 'POST') return generateSubjectPlate(req, res, 'prop', propId);
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

function badReq(res, msg) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
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
        "SELECT file_name, project_id FROM film_assets WHERE asset_type = 'reference_image' AND location_id = ? ORDER BY created_at DESC LIMIT 1"
    );
    for (const loc of rows) {
        const count = db.prepare("SELECT COUNT(*) AS count FROM film_scenes WHERE project_id = ? AND location = ?").get(projectId, loc.name);
        loc.scene_count = count.count;
        const refAsset = refImageQuery.get(loc.id);
        // The subdir comes from the plate builder's own registry, never a
        // literal. These two lists each hardcoded their own directory while the
        // builder wrote somewhere else, so the row was found, a URL was
        // returned, and it pointed at a directory the file was not in — a plate
        // that existed, was correctly linked, and rendered as nothing.
        loc.reference_image_url = refAsset
            ? getFileUrl(PLATE_KINDS.location.subdir, refAsset.project_id, refAsset.file_name) : null;
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
        atmosphere_notes: 2000, sound_notes: 2000
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
        "SELECT file_name, project_id FROM film_assets WHERE asset_type = 'reference_image' AND prop_id = ? ORDER BY created_at DESC LIMIT 1"
    );
    for (const prop of rows) {
        const refAsset = refImageQuery.get(prop.id);
        prop.reference_image_url = refAsset
            ? getFileUrl(PLATE_KINDS.prop.subdir, refAsset.project_id, refAsset.file_name) : null;
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

    for (const [field, maxLen] of Object.entries({ name: 200, description: 2000, visual_prompt: 2000, category: 50, notes: 2000 })) {
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
    const model = (req.body && req.body.model) || 'sdxl';

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
        model,
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

        const imageUrl = getFileUrl('loc-refs', loc.project_id, filename);
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
            image_url: a.file_name ? getFileUrl('loc-refs', a.project_id, a.file_name) : null,
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
    const model = (req.body && req.body.model) || 'sdxl';

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
        model,
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

        const imageUrl = getFileUrl('prop-refs', prop.project_id, filename);
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
            image_url: a.file_name ? getFileUrl('prop-refs', a.project_id, a.file_name) : null,
        })),
    }));
}

module.exports = { handleLocations };
