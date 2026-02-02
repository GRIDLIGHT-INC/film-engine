/**
 * Location CRUD + props
 * POST/GET /film/projects/:id/locations
 * GET/PUT/DELETE /film/locations/:id
 * POST/GET /film/projects/:id/props
 * GET/PUT/DELETE /film/props/:id
 */
const { db, generateId } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    // /film/locations/:id
    if (urlParts[1] === 'locations' && urlParts[2]) {
        const locId = urlParts[2];
        if (!UUID_RE.test(locId)) return badReq(res, 'Invalid location ID');
        if (req.method === 'GET') return getLocation(req, res, locId);
        if (req.method === 'PUT') return updateLocation(req, res, locId);
        if (req.method === 'DELETE') return deleteLocation(req, res, locId);
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

    // Attach scene count per location
    for (const loc of rows) {
        const count = db.prepare("SELECT COUNT(*) AS count FROM film_scenes WHERE project_id = ? AND location = ?").get(projectId, loc.name);
        loc.scene_count = count.count;
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
        (body.lighting_default || 'natural').slice(0, 50),
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
    const body = req.body;
    const fields = [];
    const values = [];

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

module.exports = { handleLocations };
