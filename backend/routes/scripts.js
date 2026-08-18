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

// FILM-129: Standard revision colors in order
const REVISION_COLORS = [
    'white',      // Original (draft)
    'blue',       // 1st revision
    'pink',       // 2nd revision
    'yellow',     // 3rd revision
    'green',      // 4th revision
    'goldenrod',  // 5th revision
    'buff',       // 6th revision
    'salmon',     // 7th revision
    'cherry'      // 8th revision
];

function handleScripts(req, res, urlParts, query) {
    const projectId = urlParts[2];
    const sub = urlParts[3]; // 'script' or 'scripts' or 'screenplay'
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

    // FILM-121: GET /film/projects/:id/screenplay/suggestions
    if (req.method === 'GET' && sub === 'screenplay' && versionOrKeyword === 'suggestions') {
        return getScreenplaySuggestions(req, res, projectId);
    }

    // POST /film/projects/:id/screenplay/suggestions/apply — create the rows.
    if (req.method === 'POST' && sub === 'screenplay' && versionOrKeyword === 'suggestions' && subPath === 'apply') {
        return applyScreenplaySuggestions(req, res, projectId);
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
 * FILM-129: Get the next revision color in sequence
 */
function getNextRevisionColor(projectId) {
    // Get all existing revisions for this project
    const scripts = db.prepare(`
        SELECT revision_number, revision_color FROM film_scripts
        WHERE project_id = ? AND revision_number IS NOT NULL
        ORDER BY revision_number DESC
        LIMIT 1
    `).get(projectId);

    if (!scripts || !scripts.revision_number) {
        return { number: 1, color: REVISION_COLORS[1] }; // First revision is blue
    }

    const nextNumber = scripts.revision_number + 1;
    const colorIndex = Math.min(nextNumber, REVISION_COLORS.length - 1);
    return { number: nextNumber, color: REVISION_COLORS[colorIndex] };
}

/**
 * FILM-129: Detect which pages changed between two Fountain scripts
 * Returns array of page numbers (1-indexed) that have changes
 */
function detectChangedPages(oldFountain, newFountain) {
    if (!oldFountain || !newFountain) return [];

    const oldLines = oldFountain.split('\n');
    const newLines = newFountain.split('\n');

    // Determine pages (approximately LINES_PER_PAGE lines per page)
    const oldPages = [];
    const newPages = [];

    for (let i = 0; i < oldLines.length; i += LINES_PER_PAGE) {
        oldPages.push(oldLines.slice(i, i + LINES_PER_PAGE).join('\n'));
    }
    for (let i = 0; i < newLines.length; i += LINES_PER_PAGE) {
        newPages.push(newLines.slice(i, i + LINES_PER_PAGE).join('\n'));
    }

    // Find changed pages
    const changedPages = [];
    const maxPages = Math.max(oldPages.length, newPages.length);

    for (let i = 0; i < maxPages; i++) {
        const oldPage = oldPages[i] || '';
        const newPage = newPages[i] || '';

        if (oldPage !== newPage) {
            changedPages.push(i + 1); // 1-indexed
        }
    }

    return changedPages;
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

    // FILM-129: Handle revision marking
    let revisionNumber = null;
    let revisionColor = null;
    let revisionDate = null;
    let revisionPagesChanged = '[]';

    if (body.mark_as_revision) {
        const nextRevision = getNextRevisionColor(projectId);
        revisionNumber = nextRevision.number;
        revisionColor = nextRevision.color;
        revisionDate = now;

        // Detect changed pages from previous version
        const prevScript = db.prepare(`
            SELECT fountain_content FROM film_scripts
            WHERE project_id = ? ORDER BY version DESC LIMIT 1
        `).get(projectId);

        if (prevScript && prevScript.fountain_content) {
            const changedPages = detectChangedPages(prevScript.fountain_content, fountainContent);
            revisionPagesChanged = JSON.stringify(changedPages);
        }
    }

    // Insert script with Fountain-specific columns and revision tracking
    db.prepare(`
        INSERT INTO film_scripts
        (id, project_id, version, content, word_count, format, fountain_content, title_page_json, page_count, scene_count, dialogue_percentage, revision_number, revision_color, revision_date, revision_pages_changed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scriptId, projectId, nextVersion, content, wordCount, format, fountainContent, titlePageJson, pageCount, sceneCount, dialoguePercentage, revisionNumber, revisionColor, revisionDate, revisionPagesChanged, now);

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
        SELECT id, project_id, version, word_count, format, page_count, scene_count, dialogue_percentage,
               revision_number, revision_color, revision_date, revision_pages_changed, created_at
        FROM film_scripts
        WHERE project_id = ?
        ORDER BY version DESC
    `).all(projectId);

    // Parse revision_pages_changed JSON for each row
    for (const row of rows) {
        if (row.revision_pages_changed) {
            try {
                row.revision_pages_changed = JSON.parse(row.revision_pages_changed);
            } catch (e) {
                row.revision_pages_changed = [];
            }
        }
    }

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

    // FILM-129: Parse revision_pages_changed
    if (row.revision_pages_changed) {
        try {
            row.revision_pages_changed = JSON.parse(row.revision_pages_changed);
        } catch (e) {
            row.revision_pages_changed = [];
        }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

/**
 * Words that arrive in caps inside an action line and are not people.
 *
 * Screenplays introduce a character by putting their name in caps the first
 * time they appear — including characters who never speak. Detection keyed on
 * dialogue cues therefore misses exactly the ones a storyboard most needs
 * described: the creature, the corpse, the double. On Wingfall this was the
 * DRAGON, i.e. the title character, and the result was a different animal in
 * every frame.
 *
 * Caps in action are also used for sluglines, transitions, sounds and camera
 * instructions, so the pattern needs a stoplist rather than a cleverer regex.
 * Wrong inclusions here are cheap — a suggestion a user declines — while a
 * miss is a subject that gets re-invented per shot, so this leans permissive.
 */
const ACTION_CAPS_STOPWORDS = new Set([
    'INT', 'EXT', 'INT./EXT', 'EXT./INT', 'I/E', 'EST',
    'DAY', 'NIGHT', 'DUSK', 'DAWN', 'MORNING', 'AFTERNOON', 'EVENING', 'MIDNIGHT', 'NOON',
    'CONTINUOUS', 'LATER', 'MOMENTS', 'SAME', 'PRESENT', 'FLASHBACK', 'MONTAGE', 'INTERCUT',
    'CUT', 'FADE', 'DISSOLVE', 'SMASH', 'MATCH', 'JUMP', 'IRIS', 'TO', 'IN', 'OUT', 'ON', 'UP',
    'ANGLE', 'POV', 'SUPER', 'TITLE', 'INSERT', 'CLOSE', 'WIDE', 'PAN', 'TILT', 'ZOOM',
    'CONTD', "CONT'D", 'OS', 'VO', 'OC', 'BEAT', 'THE', 'AND', 'BUT', 'FOR', 'NOT',
    'END', 'THE END', 'CREDITS', 'BLACK', 'WHITE',
]);

const ACTION_CAPS_RE = /\b([A-Z][A-Z''\-]{2,}(?:\s+[A-Z][A-Z''\-]{2,})?)\b/g;

/**
 * Character names introduced in action lines.
 *
 * Returns a map keyed the same way dialogue-cue detection is, so the two
 * merge without either side knowing about the other.
 */
function actionIntroducedCharacters(parsed, knownLocations) {
    const found = {};
    let sceneNum = 0;
    for (const el of parsed.elements || []) {
        if (el.type === 'scene_heading') { sceneNum++; continue; }
        if (el.type !== 'action') continue;

        const text = String(el.text || '');
        let m;
        ACTION_CAPS_RE.lastIndex = 0;
        while ((m = ACTION_CAPS_RE.exec(text)) !== null) {
            const name = m[1].trim();
            if (ACTION_CAPS_STOPWORDS.has(name)) continue;
            // A location already named by a slugline is a place, not a person.
            if (knownLocations.has(name.toUpperCase())) continue;
            // A whole line in caps is a shout or a slug, not an introduction.
            if (text.trim() === text.trim().toUpperCase() && text.trim().length > name.length + 4) continue;
            if (!found[name]) found[name] = { name, mention_count: 0, first_scene: sceneNum, introduced_in: 'action' };
            found[name].mention_count++;
        }
    }
    return found;
}

/**
 * Turn the suggestions into rows.
 *
 * The suggestions endpoint has always returned `suggested_action: 'create'`
 * and then done nothing about it: INSERT INTO film_characters lives only in
 * the manual CRUD route and the demo seeder. So a screenplay upload produced
 * no entities at all, every one had to be typed, and whatever the user forgot
 * was silently re-invented by the image model on each shot — which is how a
 * production shipped eight frames with a different dragon in each.
 *
 * Creation is idempotent on name, so applying twice after a script revision
 * adds what is new instead of duplicating what is there. Descriptions are NOT
 * invented here: a skeleton with an honest empty description is filled by the
 * breakdown, and inventing one at this layer would produce exactly the
 * plausible-but-unauthored placeholder text this is meant to replace.
 *
 * The body may carry entities the pattern cannot see — props especially, which
 * come from reading the action rather than matching a slug — so an agent or the
 * breakdown can hand them in through the same path.
 */
const PROP_CATEGORIES = new Set([
    'generic', 'weapon', 'vehicle', 'technology', 'food',
    'document', 'furniture', 'clothing-accessory', 'musical-instrument', 'other',
]);

function applyScreenplaySuggestions(req, res, projectId) {
    const body = req.body || {};

    // Reuse the detector rather than reimplementing it: two lists of what a
    // screenplay contains would drift, and the drift would be invisible.
    let detected = { unmatched_characters: [], unmatched_locations: [] };
    const capture = {
        writeHead() { return this; },
        setHeader() {},
        end(payload) { try { detected = JSON.parse(payload); } catch (_) { /* leave empty */ } },
    };
    getScreenplaySuggestions(req, capture, projectId);

    const wanted = {
        character: Array.isArray(body.characters) ? body.characters : (detected.unmatched_characters || []),
        location: Array.isArray(body.locations) ? body.locations : (detected.unmatched_locations || []),
        prop: Array.isArray(body.props) ? body.props : [],
    };

    const created = { character: [], location: [], prop: [] };
    const skipped = { character: [], location: [], prop: [] };

    const exists = {
        character: db.prepare('SELECT id FROM film_characters WHERE project_id = ? AND UPPER(name) = UPPER(?)'),
        location: db.prepare('SELECT id FROM film_locations WHERE project_id = ? AND UPPER(name) = UPPER(?)'),
        prop: db.prepare('SELECT id FROM film_props WHERE project_id = ? AND UPPER(name) = UPPER(?)'),
    };

    const insert = {
        character: db.prepare(`INSERT INTO film_characters (id, project_id, name, description, appearance_prompt, age_range)
                               VALUES (?, ?, ?, ?, ?, ?)`),
        location: db.prepare(`INSERT INTO film_locations (id, project_id, name, description, lighting_default, time_of_day_default)
                              VALUES (?, ?, ?, ?, ?, ?)`),
        prop: db.prepare(`INSERT INTO film_props (id, project_id, name, description, visual_prompt, category)
                          VALUES (?, ?, ?, ?, ?, ?)`),
    };

    const tx = db.transaction(() => {
        for (const item of wanted.character) {
            const name = String((item && item.name) || '').trim();
            if (!name) continue;
            if (exists.character.get(projectId, name)) { skipped.character.push(name); continue; }
            const id = generateId();
            insert.character.run(id, projectId, name, String(item.description || ''),
                String(item.appearance_prompt || ''), String(item.age_range || ''));
            created.character.push({ id, name, introduced_in: item.introduced_in || 'dialogue' });
        }
        for (const item of wanted.location) {
            const name = String((item && item.name) || '').trim();
            if (!name) continue;
            if (exists.location.get(projectId, name)) { skipped.location.push(name); continue; }
            const id = generateId();
            // Deliberately NOT "EXT location (3 mentions in screenplay)". That
            // string was being written as a description and reaching the image
            // prompt as though it described a place.
            insert.location.run(id, projectId, name, String(item.description || ''),
                String(item.lighting_default || ''), String(item.time_of_day || ''));
            created.location.push({ id, name });
        }
        for (const item of wanted.prop) {
            const name = String((item && item.name) || '').trim();
            if (!name) continue;
            if (exists.prop.get(projectId, name)) { skipped.prop.push(name); continue; }
            const id = generateId();
            // category is CHECK-constrained. An unrecognised one is the
            // caller's guess at a taxonomy they cannot see, so it falls back
            // rather than failing the whole apply: losing one prop's category
            // is recoverable, losing the batch is not.
            const category = PROP_CATEGORIES.has(String(item.category || '')) ? item.category : 'generic';
            insert.prop.run(id, projectId, name, String(item.description || ''),
                String(item.visual_prompt || ''), category);
            created.prop.push({ id, name, category });
        }
    });
    tx();

    const total = created.character.length + created.location.length + created.prop.length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        project_id: projectId,
        created, skipped, created_count: total,
        // Said plainly, because a skeleton that never gets described generates
        // a bare name and looks like it worked.
        next: total ? 'Run the breakdown to describe these before generating.' : 'Nothing new to create.',
    }));
}

/**
 * FILM-121: Get screenplay entity suggestions
 * Analyzes the latest script and returns unmatched characters/locations
 */
function getScreenplaySuggestions(req, res, projectId) {
    // Get latest Fountain script
    const script = db.prepare(`
        SELECT id, fountain_content, format
        FROM film_scripts
        WHERE project_id = ?
        ORDER BY version DESC
        LIMIT 1
    `).get(projectId);

    if (!script || script.format !== 'fountain' || !script.fountain_content) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            unmatched_characters: [],
            unmatched_locations: [],
            message: 'No Fountain script found'
        }));
        return;
    }

    // Parse the Fountain content
    const parsed = parseFountain(script.fountain_content);

    // Collect all character names from character cues
    const characterMentions = {};
    let currentSceneNum = 0;
    for (const el of parsed.elements) {
        if (el.type === 'scene_heading') {
            currentSceneNum++;
        } else if (el.type === 'character') {
            const name = el.text.trim().toUpperCase();
            if (!characterMentions[name]) {
                characterMentions[name] = {
                    name: name,
                    mention_count: 0,
                    first_scene: currentSceneNum
                };
            }
            characterMentions[name].mention_count++;
        }
    }

    // Collect all locations from scene headings
    const locationMentions = {};
    for (const el of parsed.elements) {
        if (el.type === 'scene_heading' && el.meta && el.meta.location) {
            const loc = el.meta.location.trim().toUpperCase();
            if (!locationMentions[loc]) {
                locationMentions[loc] = {
                    name: el.meta.location.trim(),
                    mention_count: 0,
                    int_ext: el.meta.int_ext || '',
                    time_of_day: el.meta.time_of_day || ''
                };
            }
            locationMentions[loc].mention_count++;
        }
    }

    // Characters who are introduced in action and never speak. Merged after
    // locations are collected, because a slugline location also appears in caps
    // and must not be offered as a person.
    const knownLocationNames = new Set(Object.keys(locationMentions));
    for (const [name, rec] of Object.entries(actionIntroducedCharacters(parsed, knownLocationNames))) {
        const key = name.toUpperCase();
        if (characterMentions[key]) {
            characterMentions[key].mention_count += rec.mention_count;
        } else {
            characterMentions[key] = { ...rec, name: key };
        }
    }

    // Get existing characters
    const existingCharacters = db.prepare(`
        SELECT name FROM film_characters WHERE project_id = ?
    `).all(projectId);
    const existingCharNames = new Set(existingCharacters.map(c => c.name.toUpperCase()));

    // Get existing locations
    const existingLocations = db.prepare(`
        SELECT name FROM film_locations WHERE project_id = ?
    `).all(projectId);
    const existingLocNames = new Set(existingLocations.map(l => l.name.toUpperCase()));

    // Filter for unmatched
    const unmatchedCharacters = Object.values(characterMentions)
        .filter(c => !existingCharNames.has(c.name))
        .map(c => ({
            ...c,
            suggested_action: 'create'
        }))
        .sort((a, b) => b.mention_count - a.mention_count);

    const unmatchedLocations = Object.values(locationMentions)
        .filter(l => !existingLocNames.has(l.name.toUpperCase()))
        .map(l => ({
            ...l,
            suggested_action: 'create'
        }))
        .sort((a, b) => b.mention_count - a.mention_count);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        unmatched_characters: unmatchedCharacters,
        unmatched_locations: unmatchedLocations,
        total_characters_in_script: Object.keys(characterMentions).length,
        total_locations_in_script: Object.keys(locationMentions).length
    }));
}

/**
 * Handle screenplay comment routes:
 *   POST /film/scripts/:id/comments — add comment
 *   GET  /film/scripts/:id/comments — list comments
 *   PUT  /film/comments/:id — edit/resolve
 *   DELETE /film/comments/:id — delete
 */
function handleComments(req, res, urlParts, query) {
    // /film/scripts/:id/comments
    if (urlParts[1] === 'scripts' && urlParts[2] && urlParts[3] === 'comments') {
        const scriptId = urlParts[2];

        if (req.method === 'GET') {
            const rows = db.prepare(`
                SELECT * FROM film_screenplay_comments
                WHERE script_id = ? ORDER BY element_index, start_offset
            `).all(scriptId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ comments: rows }));
            return;
        }

        if (req.method === 'POST') {
            try {
                const data = req.body || {};
                const id = generateId();
                db.prepare(`
                    INSERT INTO film_screenplay_comments (id, script_id, element_index, start_offset, end_offset, content, author)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(id, scriptId, data.element_index || 0, data.start_offset || 0, data.end_offset || 0, data.content || '', data.author || 'user');
                const comment = db.prepare('SELECT * FROM film_screenplay_comments WHERE id = ?').get(id);
                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(comment));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
            return;
        }

        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    // /film/comments/:id
    if (urlParts[1] === 'comments' && urlParts[2]) {
        const commentId = urlParts[2];

        if (req.method === 'PUT') {
            try {
                const data = req.body || {};
                const sets = [];
                const vals = [];
                if (data.content !== undefined) { sets.push('content = ?'); vals.push(data.content); }
                if (data.resolved !== undefined) { sets.push('resolved = ?'); vals.push(data.resolved ? 1 : 0); }
                if (sets.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'No fields to update' }));
                    return;
                }
                sets.push("updated_at = datetime('now')");
                vals.push(commentId);
                db.prepare(`UPDATE film_screenplay_comments SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
                const comment = db.prepare('SELECT * FROM film_screenplay_comments WHERE id = ?').get(commentId);
                if (!comment) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Comment not found' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(comment));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
            return;
        }

        if (req.method === 'DELETE') {
            const result = db.prepare('DELETE FROM film_screenplay_comments WHERE id = ?').run(commentId);
            if (result.changes === 0) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Comment not found' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ deleted: true }));
            return;
        }

        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
}

module.exports = { handleScripts, handleComments };
