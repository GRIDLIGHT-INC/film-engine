/**
 * NLE Export Routes
 *
 * GET /film/projects/:id/export           — List available export formats
 * GET /film/projects/:id/export/fcpxml    — Download FCPXML 1.11
 * GET /film/projects/:id/export/edl       — Download CMX 3600 EDL
 * GET /film/projects/:id/export/premiere  — Download Premiere Pro XML
 */

const path = require('path');
const { db, generateId } = require('../db/database');
const { generateFCPXML, generateEDL, generatePremiereXML } = require('../lib/nle-export');
const { generateFDX } = require('../lib/fdx-generator');
const { parseFountain } = require('../lib/fountain-parser');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fetch shots for a project, ordered by scene_number then shot_code.
 */
function getProjectShots(projectId) {
    return db.prepare(`
        SELECT s.id, s.shot_code, s.duration_ms, s.scene_id, s.status,
               s.sort_order, s.transition_in_type, s.transition_in_duration_ms,
               s.transition_out_type, s.transition_out_duration_ms,
               sc.scene_number, sc.int_ext, sc.location, sc.time_of_day,
               sc.description, sc.characters_present
        FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id
        WHERE sc.project_id = ? AND sc.status != 'removed'
        ORDER BY ${require('../lib/running-order').orderBySql({ shots: 's', scenes: 'sc' })}
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

    // Verify project exists (include settings columns)
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
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
                { id: 'preflight', name: 'Export preflight (free — nothing is written)', extension: '', content_type: 'application/json' },
                { id: 'package', name: 'Packaged handover (XML + copied media)', extension: '/', content_type: 'application/json' },
                { id: 'fdx', name: 'Final Draft XML', extension: '.fdx', content_type: 'application/xml' },
            ],
        }));
        return;
    }

    // Generate export
    /*
     * Folded ONCE for all three formats.
     *
     * A clip that contains several shots is laid down at the first of them and
     * the rest are not cut to — otherwise the editor receives the same footage
     * three times, or three gaps where the covered shots have no media of their
     * own. Folded here rather than inside each generator because there are
     * three of them and a fix applied to two is worse than none: two formats
     * would agree with the film and the third would not, and only the editor
     * who opened that one would ever find out.
     */
    const { coverageFor, foldShots, measuredDurations } = require('../lib/clip-coverage');
    const shots = foldShots(getProjectShots(projectId), coverageFor(db, projectId),
        measuredDurations(db, projectId)).shots;
    const assets = getProjectAssets(projectId);
    const safeTitle = (project.title || 'timeline').replace(/[^a-zA-Z0-9_-]/g, '_');

    // Build settings object from project row
    const settings = {
        target_fps: project.target_fps,
        target_resolution: project.target_resolution,
        timecode_start: project.timecode_start,
        aspect_ratio: project.aspect_ratio,
        color_space: project.color_space,
    };

    /*
     * What is wrong with this export, before anyone is handed it. FREE, and it
     * leads: the first real project this ran against exported ZERO clips —
     * every shot has duration_ms = 0, so shootableShots disqualified all of
     * them — and the result was a well-formed file describing nothing. A blank
     * timeline is not something an editor can report back usefully.
     */
    if (format === 'preflight') {
        const { preflightExport } = require('../lib/export-package');
        const out = preflightExport(project, shots, assets, { settings });
        res.writeHead(out.ready ? 200 : 409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ project_id: projectId, ...out }));
        return;
    }

    /*
     * The XML plus the media it names, in one folder, with the paths rewritten.
     * An export references media by ABSOLUTE path, so handed to anybody else it
     * opens with every clip offline — the timeline is right and there is no
     * picture.
     */
    if (format === 'package') {
        const { packageExport } = require('../lib/export-package');
        const { ensureDir } = require('../lib/file-storage');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const dest = path.join(ensureDir(projectId, 'exports'), `${safeTitle}_${stamp}`);
        packageExport(project, shots, assets, { format: query.target || 'premiere', dest, settings })
            .then(out => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    project_id: projectId, path: out.dest, xml: path.basename(out.xml_path),
                    media: out.copied, preflight: out.preflight, format: out.format,
                }));
            })
            .catch(err => {
                res.writeHead(err.preflight ? 409 : 500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.code || 'PACKAGE_FAILED', message: err.message,
                    ...(err.preflight ? { preflight: err.preflight } : {}) }));
            });
        return;
    }

    /*
     * The deliverable set, if this project has one. A film has none and exports
     * exactly as it always did; a commercial gets one sequence per placement,
     * each at its own raster and rate.
     */
    const deliverables = db.prepare(
        'SELECT * FROM film_deliverables WHERE project_id = ? ORDER BY sort_order, created_at')
        .all(projectId);

    if (format === 'fcpxml') {
        const content = generateFCPXML(project, shots, assets, settings);
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
        // Assets travel in settings: generateEDL has no slot for them and needs
        // them to know which shots have footage.
        const content = generateEDL(project, shots, { ...settings, assets });
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
        const content = generatePremiereXML(project, shots, assets, settings, deliverables);
        const fileName = `${safeTitle}.prproj.xml`;
        registerExportAsset(projectId, 'premiere_xml', fileName, content);
        res.writeHead(200, {
            'Content-Type': 'application/xml',
            'Content-Disposition': `attachment; filename="${fileName}"`,
        });
        res.end(content);
        return;
    }

    if (format === 'fdx') {
        // Get latest script for this project
        const script = db.prepare(`
            SELECT fountain_content FROM film_scripts
            WHERE project_id = ? ORDER BY version DESC LIMIT 1
        `).get(projectId);

        let content;
        if (script && script.fountain_content) {
            const ast = parseFountain(script.fountain_content);
            content = generateFDX(ast, { title: project.title });
        } else {
            content = generateFDX(null);
        }

        const fileName = `${safeTitle}.fdx`;
        registerExportAsset(projectId, 'fdx', fileName, content);
        res.writeHead(200, {
            'Content-Type': 'application/xml',
            'Content-Disposition': `attachment; filename="${fileName}"`,
        });
        res.end(content);
        return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Unknown export format: ${format}. Valid formats: fcpxml, edl, premiere, fdx` }));
}

module.exports = { handleNLEExport };
