/**
 * FILM-004 + FILM-097 + FILM-098: Script upload/versioning endpoint (Fountain-aware)
 * POST /film/projects/:id/script — upload screenplay, auto-extract scenes
 * POST /film/projects/:id/script/import-fdx — import Final Draft XML
 * PUT  /film/projects/:id/script/:version — update existing script in-place
 * GET  /film/projects/:id/scripts — list script versions
 * GET  /film/projects/:id/scripts/:version — get specific version
 * GET  /film/projects/:id/script/latest/fountain — get raw Fountain of latest version
 */
const { db, generateId } = require('../db/database');
const { parseScreenplay } = require('../lib/screenplay-parser');
const { parseFountain, analyzeScreenplay } = require('../lib/fountain-parser');
const { parseFDX } = require('../lib/fdx-parser');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Estimate page count: ~55 lines per page in Fountain format
const LINES_PER_PAGE = 55;

function handleScripts(req, res, urlParts, query) {
    const projectId = urlParts[2];
    const sub = urlParts[3]; // 'script' or 'scripts'
    const versionOrKeyword = urlParts[4];
    const subPath = urlParts[5]; // 'fountain' for /script/latest/fountain

    if (!UUID_RE.test(projectId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project ID' }));
        return;
    }

    // Verify project exists
    const proj = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!proj) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    // GET /film/projects/:id/script/latest/fountain
    if (req.method === 'GET' && sub === 'script' && versionOrKeyword === 'latest' && subPath === 'fountain') {
        return getLatestFountain(req, res, projectId);
    }

    // POST /film/projects/:id/script/import-fdx — import Final Draft file
    if (req.method === 'POST' && sub === 'script' && versionOrKeyword === 'import-fdx') {
        return importFDX(req, res, projectId);
    }

    // POST /film/projects/:id/script — upload new version
    if (req.method === 'POST' && sub === 'script') {
        return uploadScript(req, res, projectId);
    }

    // PUT /film/projects/:id/script/:version — update existing version
    if (req.method === 'PUT' && sub === 'script' && versionOrKeyword) {
        const version = parseInt(versionOrKeyword);
        if (isNaN(version)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid version number' }));
            return;
        }
        return updateScript(req, res, projectId, version);
    }

    // GET /film/projects/:id/scripts — list versions
    if (req.method === 'GET' && sub === 'scripts' && !versionOrKeyword) {
        return listScripts(req, res, projectId);
    }

    // GET /film/projects/:id/scripts/:version — get specific version
    if (req.method === 'GET' && sub === 'scripts' && versionOrKeyword) {
        const version = parseInt(versionOrKeyword);
        if (isNaN(version)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid version number' }));
            return;
        }
        return getScript(req, res, projectId, version);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

/**
 * Process Fountain content and compute metadata
 */
function processFountainContent(fountainContent) {
    const parsed = parseFountain(fountainContent);
    const stats = analyzeScreenplay(parsed);

    // Estimate page count from line count
    const lineCount = fountainContent.split('\n').length;
    const pageCount = Math.ceil(lineCount / LINES_PER_PAGE);

    // Generate plaintext for backward compat
    const plaintextParts = [];
    for (const el of parsed.elements) {
        if (el.type === 'boneyard' || el.type === 'note') continue;
        if (el.text) plaintextParts.push(el.text);
    }
    const plaintext = plaintextParts.join('\n\n');

    return {
        parsed,
        stats,
        plaintext,
        pageCount,
        sceneCount: stats.scene_count,
        dialoguePercentage: stats.dialogue_percentage,
        titlePageJson: JSON.stringify(parsed.title_page || {})
    };
}

/**
 * Insert script elements into film_script_elements table
 */
function insertScriptElements(scriptId, elements) {
    // Delete existing elements for this script
    db.prepare('DELETE FROM film_script_elements WHERE script_id = ?').run(scriptId);

    const insert = db.prepare(`
        INSERT INTO film_script_elements
        (id, script_id, element_index, element_type, text, scene_number, depth, dual, meta, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const insertMany = db.transaction((elements) => {
        elements.forEach((el, index) => {
            insert.run(
                generateId(),
                scriptId,
                index,
                el.type,
                el.text || '',
                el.scene_number || null,
                el.depth || null,
                el.dual || null,
                JSON.stringify(el.meta || {})
            );
        });
    });

    insertMany(elements);
}

/**
 * Extract scenes from Fountain AST (more accurate than regex parser)
 */
function extractScenesFromFountain(parsed, projectId) {
    const scenes = [];
    let currentScene = null;
    const charactersSeen = new Set();

    for (const el of parsed.elements) {
        if (el.type === 'scene_heading') {
            // Save previous scene
            if (currentScene) {
                currentScene.characters_present = [...charactersSeen];
                scenes.push(currentScene);
            }

            // Start new scene
            currentScene = {
                scene_number: scenes.length + 1,
                int_ext: el.meta?.int_ext || '',
                location: el.meta?.location || el.text,
                time_of_day: el.meta?.time_of_day || '',
                description: '',
                characters_present: []
            };
            charactersSeen.clear();
        } else if (currentScene) {
            if (el.type === 'character') {
                charactersSeen.add(el.text);
            } else if (el.type === 'action') {
                if (currentScene.description) {
                    currentScene.description += '\n' + el.text;
                } else {
                    currentScene.description = el.text;
                }
            }
        }
    }

    // Save final scene
    if (currentScene) {
        currentScene.characters_present = [...charactersSeen];
        scenes.push(currentScene);
    }

    return scenes;
}

/**
 * FILM-120: Sync scenes with screenplay content
 * Matches scenes by number first, then by location+time similarity.
 * Creates new scenes, updates existing ones, marks deleted as 'removed'.
 */
function syncScenesWithScreenplay(projectId, parsedFountain) {
    const newScenes = extractScenesFromFountain(parsedFountain, projectId);

    // Get existing scenes for this project
    const existingScenes = db.prepare(`
        SELECT * FROM film_scenes
        WHERE project_id = ? AND status != 'removed'
        ORDER BY scene_number
    `).all(projectId);

    const report = {
        scenes_added: 0,
        scenes_updated: 0,
        scenes_removed: 0,
        characters_found: new Set()
    };

    // Track which existing scenes were matched
    const matchedExistingIds = new Set();
    const matchedNewIndices = new Set();

    // First pass: match by scene number
    for (let i = 0; i < newScenes.length; i++) {
        const newScene = newScenes[i];

        // Collect characters
        (newScene.characters_present || []).forEach(c => report.characters_found.add(c));

        // Find matching existing scene by scene_number
        const match = existingScenes.find(es =>
            es.scene_number === newScene.scene_number && !matchedExistingIds.has(es.id)
        );

        if (match) {
            matchedExistingIds.add(match.id);
            matchedNewIndices.add(i);

            // Update existing scene
            db.prepare(`
                UPDATE film_scenes SET
                    int_ext = ?,
                    location = ?,
                    time_of_day = ?,
                    description = ?,
                    characters_present = ?
                WHERE id = ?
            `).run(
                newScene.int_ext,
                newScene.location,
                newScene.time_of_day,
                (newScene.description || '').slice(0, 10000),
                JSON.stringify(newScene.characters_present || []),
                match.id
            );
            report.scenes_updated++;
        }
    }

    // Second pass: match remaining scenes by location + time_of_day similarity
    for (let i = 0; i < newScenes.length; i++) {
        if (matchedNewIndices.has(i)) continue;
        const newScene = newScenes[i];

        // Try to find similar scene by location and time
        const match = existingScenes.find(es => {
            if (matchedExistingIds.has(es.id)) return false;

            const locMatch = es.location && newScene.location &&
                es.location.toLowerCase() === newScene.location.toLowerCase();
            const timeMatch = es.time_of_day && newScene.time_of_day &&
                es.time_of_day.toLowerCase() === newScene.time_of_day.toLowerCase();

            return locMatch && timeMatch;
        });

        if (match) {
            matchedExistingIds.add(match.id);
            matchedNewIndices.add(i);

            // Update with new scene number
            db.prepare(`
                UPDATE film_scenes SET
                    scene_number = ?,
                    int_ext = ?,
                    location = ?,
                    time_of_day = ?,
                    description = ?,
                    characters_present = ?
                WHERE id = ?
            `).run(
                newScene.scene_number,
                newScene.int_ext,
                newScene.location,
                newScene.time_of_day,
                (newScene.description || '').slice(0, 10000),
                JSON.stringify(newScene.characters_present || []),
                match.id
            );
            report.scenes_updated++;
        }
    }

    // Create new scenes for unmatched new scenes
    const insertScene = db.prepare(`
        INSERT INTO film_scenes
        (id, project_id, scene_number, int_ext, location, time_of_day, description, characters_present, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    for (let i = 0; i < newScenes.length; i++) {
        if (matchedNewIndices.has(i)) continue;
        const newScene = newScenes[i];

        insertScene.run(
            generateId(),
            projectId,
            newScene.scene_number,
            newScene.int_ext,
            newScene.location,
            newScene.time_of_day,
            (newScene.description || '').slice(0, 10000),
            JSON.stringify(newScene.characters_present || [])
        );
        report.scenes_added++;
    }

    // Mark unmatched existing scenes as 'removed'
    for (const existing of existingScenes) {
        if (!matchedExistingIds.has(existing.id)) {
            db.prepare(`
                UPDATE film_scenes SET status = 'removed'
                WHERE id = ?
            `).run(existing.id);
            report.scenes_removed++;
        }
    }

    report.characters_found = [...report.characters_found];
    return report;
}

function uploadScript(req, res, projectId) {
    const body = req.body;

    // Check for fountain_content or regular content
    const hasFountain = body.fountain_content && typeof body.fountain_content === 'string' && body.fountain_content.trim().length > 0;
    const hasContent = body.content && typeof body.content === 'string' && body.content.trim().length > 0;

    if (!hasFountain && !hasContent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Script content is required (content or fountain_content)' }));
        return;
    }

    let content, fountainContent, format, pageCount, sceneCount, dialoguePercentage, titlePageJson, parsedFountain;

    if (hasFountain) {
        // Process Fountain content
        fountainContent = body.fountain_content;
        const processed = processFountainContent(fountainContent);
        content = processed.plaintext;
        format = 'fountain';
        pageCount = processed.pageCount;
        sceneCount = processed.sceneCount;
        dialoguePercentage = processed.dialoguePercentage;
        titlePageJson = processed.titlePageJson;
        parsedFountain = processed.parsed;
    } else {
        // Plain text upload
        content = body.content;
        fountainContent = '';
        format = 'plaintext';
        pageCount = Math.ceil(content.split('\n').length / LINES_PER_PAGE);
        sceneCount = 0;
        dialoguePercentage = 0;
        titlePageJson = '{}';
        parsedFountain = null;
    }

    const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;

    // Get next version number
    const verRow = db.prepare(
        'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM film_scripts WHERE project_id = ?'
    ).get(projectId);
    const nextVersion = verRow.next_version;

    const scriptId = generateId();
    const now = new Date().toISOString();

    // Insert script with Fountain-specific columns
    db.prepare(`
        INSERT INTO film_scripts
        (id, project_id, version, content, word_count, format, fountain_content, title_page_json, page_count, scene_count, dialogue_percentage, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scriptId, projectId, nextVersion, content, wordCount, format, fountainContent, titlePageJson, pageCount, sceneCount, dialoguePercentage, now);

    const scriptRow = db.prepare('SELECT * FROM film_scripts WHERE id = ?').get(scriptId);

    // Insert script elements if Fountain
    if (parsedFountain && parsedFountain.elements) {
        insertScriptElements(scriptId, parsedFountain.elements);
    }

    // Parse screenplay into scenes
    let parsedScenes;
    if (parsedFountain) {
        // Use Fountain AST for more accurate scene extraction
        parsedScenes = extractScenesFromFountain(parsedFountain, projectId);
    } else {
        // Fall back to old regex parser
        parsedScenes = parseScreenplay(content);
    }

    // If this is version 1 or explicit replace, clear old scenes for this project
    if (body.replace_scenes !== false) {
        db.prepare('DELETE FROM film_scenes WHERE project_id = ?').run(projectId);
    }

    // Insert extracted scenes
    const insertedScenes = [];
    const insertScene = db.prepare(`
        INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, description, characters_present, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const scene of parsedScenes) {
        const sceneId = generateId();
        const sceneNow = new Date().toISOString();
        insertScene.run(
            sceneId,
            projectId,
            scene.scene_number,
            scene.int_ext,
            scene.location,
            scene.time_of_day,
            (scene.description || '').slice(0, 10000),
            JSON.stringify(scene.characters_present),
            sceneNow
        );
        const row = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
        insertedScenes.push(row);
    }

    // Advance project status to 'script' if still in concept
    db.prepare(`
        UPDATE film_projects SET status = 'script', updated_at = datetime('now')
        WHERE id = ? AND status = 'concept'
    `).run(projectId);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        script: scriptRow,
        scenes_extracted: insertedScenes.length,
        scenes: insertedScenes
    }));
}

/**
 * Import Final Draft (.fdx) file and convert to Fountain
 */
function importFDX(req, res, projectId) {
    const body = req.body;

    if (!body.fdx_content || typeof body.fdx_content !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'fdx_content is required' }));
        return;
    }

    // Parse FDX to Fountain
    const parsed = parseFDX(body.fdx_content);

    if (parsed.metadata.error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: parsed.metadata.error }));
        return;
    }

    if (!parsed.fountain_text || parsed.fountain_text.trim().length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No content extracted from FDX file' }));
        return;
    }

    // Process the Fountain content
    const fountainContent = parsed.fountain_text;
    const processed = processFountainContent(fountainContent);

    const wordCount = processed.plaintext.split(/\s+/).filter(w => w.length > 0).length;

    // Get next version number
    const verRow = db.prepare(
        'SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM film_scripts WHERE project_id = ?'
    ).get(projectId);
    const nextVersion = verRow.next_version;

    const scriptId = generateId();
    const now = new Date().toISOString();

    // Insert script with Fountain-specific columns
    db.prepare(`
        INSERT INTO film_scripts
        (id, project_id, version, content, word_count, format, fountain_content, title_page_json, page_count, scene_count, dialogue_percentage, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        scriptId, projectId, nextVersion, processed.plaintext, wordCount,
        'fountain', fountainContent, processed.titlePageJson,
        processed.pageCount, processed.sceneCount, processed.dialoguePercentage, now
    );

    const scriptRow = db.prepare('SELECT * FROM film_scripts WHERE id = ?').get(scriptId);

    // Insert script elements
    if (processed.parsed && processed.parsed.elements) {
        insertScriptElements(scriptId, processed.parsed.elements);
    }

    // Extract scenes from Fountain AST
    const parsedScenes = extractScenesFromFountain(processed.parsed, projectId);

    // Replace scenes for this project
    if (body.replace_scenes !== false) {
        db.prepare('DELETE FROM film_scenes WHERE project_id = ?').run(projectId);
    }

    // Insert extracted scenes
    const insertedScenes = [];
    const insertScene = db.prepare(`
        INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, description, characters_present, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const scene of parsedScenes) {
        const sceneId = generateId();
        insertScene.run(
            sceneId,
            projectId,
            scene.scene_number,
            scene.int_ext,
            scene.location,
            scene.time_of_day,
            (scene.description || '').slice(0, 10000),
            JSON.stringify(scene.characters_present),
            new Date().toISOString()
        );
        const row = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(sceneId);
        insertedScenes.push(row);
    }

    // Advance project status to 'script' if still in concept
    db.prepare(`
        UPDATE film_projects SET status = 'script', updated_at = datetime('now')
        WHERE id = ? AND status = 'concept'
    `).run(projectId);

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        script: scriptRow,
        scenes_extracted: insertedScenes.length,
        scenes: insertedScenes,
        import_metadata: parsed.metadata
    }));
}

/**
 * Update an existing script version in-place (for auto-save)
 */
function updateScript(req, res, projectId, version) {
    const body = req.body;

    // Find existing script
    const existing = db.prepare(
        'SELECT * FROM film_scripts WHERE project_id = ? AND version = ?'
    ).get(projectId, version);

    if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Script version not found' }));
        return;
    }

    const hasFountain = body.fountain_content && typeof body.fountain_content === 'string';
    const hasContent = body.content && typeof body.content === 'string';

    if (!hasFountain && !hasContent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Script content is required (content or fountain_content)' }));
        return;
    }

    let content, fountainContent, format, pageCount, sceneCount, dialoguePercentage, titlePageJson, parsedFountain;

    if (hasFountain) {
        fountainContent = body.fountain_content;
        const processed = processFountainContent(fountainContent);
        content = processed.plaintext;
        format = 'fountain';
        pageCount = processed.pageCount;
        sceneCount = processed.sceneCount;
        dialoguePercentage = processed.dialoguePercentage;
        titlePageJson = processed.titlePageJson;
        parsedFountain = processed.parsed;
    } else {
        content = body.content;
        fountainContent = existing.fountain_content || '';
        format = existing.format || 'plaintext';
        pageCount = Math.ceil(content.split('\n').length / LINES_PER_PAGE);
        sceneCount = existing.scene_count || 0;
        dialoguePercentage = existing.dialogue_percentage || 0;
        titlePageJson = existing.title_page_json || '{}';
        parsedFountain = null;
    }

    const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;

    // Update script
    db.prepare(`
        UPDATE film_scripts
        SET content = ?, word_count = ?, format = ?, fountain_content = ?,
            title_page_json = ?, page_count = ?, scene_count = ?, dialogue_percentage = ?
        WHERE id = ?
    `).run(content, wordCount, format, fountainContent, titlePageJson, pageCount, sceneCount, dialoguePercentage, existing.id);

    // Update script elements if Fountain
    if (parsedFountain && parsedFountain.elements) {
        insertScriptElements(existing.id, parsedFountain.elements);
    }

    const updated = db.prepare('SELECT * FROM film_scripts WHERE id = ?').get(existing.id);

    let syncReport = null;

    // FILM-120: Sync scenes with screenplay (incremental update)
    if (body.sync_scenes && parsedFountain) {
        syncReport = syncScenesWithScreenplay(projectId, parsedFountain);
    }
    // Legacy: Replace all scenes if requested
    else if (body.update_scenes && parsedFountain) {
        db.prepare('DELETE FROM film_scenes WHERE project_id = ?').run(projectId);
        const parsedScenes = extractScenesFromFountain(parsedFountain, projectId);

        const insertScene = db.prepare(`
            INSERT INTO film_scenes (id, project_id, scene_number, int_ext, location, time_of_day, description, characters_present, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const scene of parsedScenes) {
            insertScene.run(
                generateId(),
                projectId,
                scene.scene_number,
                scene.int_ext,
                scene.location,
                scene.time_of_day,
                (scene.description || '').slice(0, 10000),
                JSON.stringify(scene.characters_present),
                new Date().toISOString()
            );
        }
    }

    const response = { script: updated };
    if (syncReport) {
        response.sync_report = syncReport;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
}

/**
 * Get raw Fountain content of latest version
 */
function getLatestFountain(req, res, projectId) {
    const row = db.prepare(`
        SELECT id, version, fountain_content, format, title_page_json, page_count, scene_count, dialogue_percentage
        FROM film_scripts
        WHERE project_id = ?
        ORDER BY version DESC
        LIMIT 1
    `).get(projectId);

    if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No scripts found for this project' }));
        return;
    }

    if (row.format !== 'fountain' || !row.fountain_content) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Latest script is not in Fountain format' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        script_id: row.id,
        version: row.version,
        fountain_content: row.fountain_content,
        title_page: JSON.parse(row.title_page_json || '{}'),
        page_count: row.page_count,
        scene_count: row.scene_count,
        dialogue_percentage: row.dialogue_percentage
    }));
}

function listScripts(req, res, projectId) {
    const rows = db.prepare(`
        SELECT id, project_id, version, word_count, format, page_count, scene_count, dialogue_percentage, created_at
        FROM film_scripts
        WHERE project_id = ?
        ORDER BY version DESC
    `).all(projectId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ scripts: rows }));
}

function getScript(req, res, projectId, version) {
    const row = db.prepare(
        'SELECT * FROM film_scripts WHERE project_id = ? AND version = ?'
    ).get(projectId, version);

    if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Script version not found' }));
        return;
    }

    // Parse title_page_json for convenience
    if (row.title_page_json) {
        try {
            row.title_page = JSON.parse(row.title_page_json);
        } catch (e) {
            row.title_page = {};
        }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

module.exports = { handleScripts };
