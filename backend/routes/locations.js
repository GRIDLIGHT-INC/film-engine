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
const { serviceUnavailableError } = require('../lib/gridlight-client');
const { saveFile, getFileUrl, ensureDir } = require('../lib/file-storage');
const { resolve } = require('../lib/providers');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_ENDPOINT = '/image';

function parseProjectConfig(projectId) {
    const row = db.prepare('SELECT provider_config FROM film_projects WHERE id = ?').get(projectId);
    if (!row) return {};
    try { return JSON.parse(row.provider_config || '{}'); } catch (_) { return {}; }
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

    // Attach scene count and reference image per location
    const refImageQuery = db.prepare(
        "SELECT file_name, project_id FROM film_assets WHERE asset_type = 'reference_image' AND location_id = ? ORDER BY created_at DESC LIMIT 1"
    );
    for (const loc of rows) {
        const count = db.prepare("SELECT COUNT(*) AS count FROM film_scenes WHERE project_id = ? AND location = ?").get(projectId, loc.name);
        loc.scene_count = count.count;
        const refAsset = refImageQuery.get(loc.id);
        loc.reference_image_url = refAsset ? getFileUrl('loc-refs', refAsset.project_id, refAsset.file_name) : null;
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

    // Attach reference image per prop
    const refImageQuery = db.prepare(
        "SELECT file_name, project_id FROM film_assets WHERE asset_type = 'reference_image' AND metadata LIKE ? ORDER BY created_at DESC LIMIT 1"
    );
    for (const prop of rows) {
        const refAsset = refImageQuery.get(`%"prop_id":"${prop.id}"%`);
        prop.reference_image_url = refAsset ? getFileUrl('prop-refs', refAsset.project_id, refAsset.file_name) : null;
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
        let filePath = '';

        if (Buffer.isBuffer(result.data)) {
            filePath = saveFile(loc.project_id, 'loc-refs', filename, result.data);
        } else if (result.data && result.data.image_url) {
            // Provider returned a URL — fetch the image bytes into film_assets.
            const imgRes = await fetch(result.data.image_url);
            if (imgRes.ok) {
                filePath = saveFile(loc.project_id, 'loc-refs', filename, Buffer.from(await imgRes.arrayBuffer()));
            } else {
                filePath = result.data.image_url;
            }
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
        let filePath = '';

        if (Buffer.isBuffer(result.data)) {
            filePath = saveFile(prop.project_id, 'prop-refs', filename, result.data);
        } else if (result.data && result.data.image_url) {
            const imgRes = await fetch(result.data.image_url);
            if (imgRes.ok) {
                filePath = saveFile(prop.project_id, 'prop-refs', filename, Buffer.from(await imgRes.arrayBuffer()));
            } else {
                filePath = result.data.image_url;
            }
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
