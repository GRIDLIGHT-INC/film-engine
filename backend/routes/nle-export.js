/**
 * NLE Export Routes
 *
 * GET /film/projects/:id/export           — List available export formats
 * GET /film/projects/:id/export/fcpxml    — Download FCPXML 1.11
 * GET /film/projects/:id/export/edl       — Download CMX 3600 EDL
 * GET /film/projects/:id/export/premiere  — Download Premiere Pro XML
 */

const { db, generateId } = require('../db/database');
const { generateFCPXML, generateEDL, generatePremiereXML } = require('../lib/nle-export');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fetch shots for a project, ordered by scene_number then shot_code.
 */
function getProjectShots(projectId) {
    return db.prepare(`
        SELECT s.id, s.shot_code, s.duration_ms, s.scene_id, s.status,
               sc.scene_number, sc.int_ext, sc.location, sc.time_of_day,
               sc.description, sc.characters_present
        FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id
        WHERE sc.project_id = ? AND sc.status != 'removed'
        ORDER BY sc.scene_number, s.shot_code
    `).all(projectId);
}

/**
 * Fetch all assets for a project.
 */
function getProjectAssets(projectId) {
    return db.prepare(`
        SELECT id, shot_id, asset_type, file_path, file_name, format,
               mime_type, size_bytes, duration_ms, width, height, metadata
        FROM film_assets
        WHERE project_id = ?
        ORDER BY created_at
    `).all(projectId);
}

/**
 * Register an export file as an asset in the registry.
 */
function registerExportAsset(projectId, assetType, fileName, content) {
    const id = generateId();
    db.prepare(`
        INSERT INTO film_assets (id, project_id, asset_type, file_name, file_path, format, size_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, assetType, fileName, '', assetType, Buffer.byteLength(content, 'utf8'));
    return id;
}

function handleNLEExport(req, res, urlParts, query) {
    const projectId = urlParts[2];
    const format = urlParts[4]; // 'fcpxml', 'edl', 'premiere', or undefined

    // Validate project ID
    if (!UUID_RE.test(projectId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project ID' }));
        return;
    }

    // Verify project exists
    const project = db.prepare('SELECT id, title, logline, genre, status FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    // List available formats
    if (!format) {
        const shots = getProjectShots(projectId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            project_id: projectId,
            project_title: project.title,
            shot_count: shots.length,
            formats: [
                { id: 'fcpxml', name: 'Final Cut Pro XML', extension: '.fcpxml', content_type: 'application/xml' },
                { id: 'edl', name: 'CMX 3600 EDL', extension: '.edl', content_type: 'text/plain' },
                { id: 'premiere', name: 'Premiere Pro XML', extension: '.xml', content_type: 'application/xml' },
            ],
        }));
        return;
    }

    // Generate export
    const shots = getProjectShots(projectId);
    const assets = getProjectAssets(projectId);
    const safeTitle = (project.title || 'timeline').replace(/[^a-zA-Z0-9_-]/g, '_');

    if (format === 'fcpxml') {
        const content = generateFCPXML(project, shots, assets);
        const fileName = `${safeTitle}.fcpxml`;
        registerExportAsset(projectId, 'fcpxml', fileName, content);
        res.writeHead(200, {
            'Content-Type': 'application/xml',
            'Content-Disposition': `attachment; filename="${fileName}"`,
        });
        res.end(content);
        return;
    }

    if (format === 'edl') {
        const content = generateEDL(project, shots);
        const fileName = `${safeTitle}.edl`;
        registerExportAsset(projectId, 'edl', fileName, content);
        res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Content-Disposition': `attachment; filename="${fileName}"`,
        });
        res.end(content);
        return;
    }

    if (format === 'premiere') {
        const content = generatePremiereXML(project, shots, assets);
        const fileName = `${safeTitle}.prproj.xml`;
        registerExportAsset(projectId, 'premiere_xml', fileName, content);
        res.writeHead(200, {
            'Content-Type': 'application/xml',
            'Content-Disposition': `attachment; filename="${fileName}"`,
        });
        res.end(content);
        return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Unknown export format: ${format}. Valid formats: fcpxml, edl, premiere` }));
}

module.exports = { handleNLEExport };
