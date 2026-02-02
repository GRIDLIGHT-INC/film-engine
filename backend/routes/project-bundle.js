/**
 * Project Bundle Routes
 *
 * GET  /film/projects/:id/bundle         — Export project as .tar.gz download
 * POST /film/projects/import             — Import project from .tar.gz upload
 */

const { db } = require('../db/database');
const { exportProject, importProject } = require('../lib/project-bundle');
const fs = require('fs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Handle project bundle export/import routes.
 * Called from server.js for /film/projects/:id/bundle and /film/projects/import
 */
function handleProjectBundle(req, res, urlParts, query) {
    // POST /film/projects/import
    if (urlParts[2] === 'import' && req.method === 'POST') {
        return handleImport(req, res);
    }

    // GET /film/projects/:id/bundle
    const projectId = urlParts[2];
    if (!UUID_RE.test(projectId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project ID' }));
        return;
    }

    if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    return handleExport(req, res, projectId);
}

function handleExport(req, res, projectId) {
    try {
        const { archivePath, manifest, archiveName } = exportProject(projectId);

        const stat = fs.statSync(archivePath);
        res.writeHead(200, {
            'Content-Type': 'application/gzip',
            'Content-Disposition': `attachment; filename="${archiveName}"`,
            'Content-Length': stat.size,
        });
        const stream = fs.createReadStream(archivePath);
        stream.pipe(res);
        stream.on('end', () => {
            // Clean up the archive file after sending
            try { fs.unlinkSync(archivePath); } catch (_) {}
        });
    } catch (err) {
        if (err.message === 'Project not found') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Project not found' }));
        } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Export failed', details: err.message }));
        }
    }
}

function handleImport(req, res) {
    // req.body is already parsed as JSON by server.js readBody().
    // For binary upload, we need the raw buffer — but readBody() parses as JSON.
    // The import endpoint expects a base64-encoded bundle in the JSON body.
    try {
        const body = req.body;
        if (!body || !body.bundle) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing "bundle" field (base64-encoded .tar.gz)' }));
            return;
        }

        const buffer = Buffer.from(body.bundle, 'base64');
        const result = importProject(buffer);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            message: 'Project imported successfully',
            project: result.project,
            stats: result.stats,
            id_map: result.id_map,
        }));
    } catch (err) {
        const status = err.message.includes('Invalid bundle') || err.message.includes('Unsupported') ? 400 : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Import failed', details: err.message }));
    }
}

module.exports = { handleProjectBundle };
