/**
 * FILM-161: Auto-backup system
 *
 * POST /film/projects/:id/backups — create backup
 * GET  /film/projects/:id/backups — list backups
 * GET  /film/backups/:id — get backup metadata
 * GET  /film/backups/:id/download — download backup JSON
 * POST /film/backups/:id/restore — restore from backup
 * DELETE /film/backups/:id — delete backup
 * GET  /film/backups/folder — the scheduled folder backups: where, when, what is there (free)
 * POST /film/backups/folder/run — write a database snapshot to that folder now
 */
const fs = require('fs');
const path = require('path');
const { db, generateId } = require('../db/database');
const { exportProjectData, importProjectData } = require('../lib/backup');
const { isPathContained } = require('../lib/file-storage');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');

function handleBackups(req, res, urlParts, query) {
    // /film/projects/:id/backups
    if (urlParts[1] === 'projects' && urlParts[3] === 'backups') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid project ID' }));
            return;
        }
        if (req.method === 'GET') return listBackups(req, res, projectId);
        if (req.method === 'POST') return createBackup(req, res, projectId);
    }

    /*
     * /film/backups/folder — the scheduled backups to the folder a person chose
     * (lib/backup-folder.js). GET is the status, free; POST …/run writes one now.
     */
    if (urlParts[1] === 'backups' && urlParts[2] === 'folder') {
        const bf = require('../lib/backup-folder');
        const send = (c, body) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        if (!urlParts[3] && req.method === 'GET') return send(200, bf.backupStatus());
        if (urlParts[3] === 'run' && req.method === 'POST') {
            try { return send(200, bf.runBackup(db)); }
            catch (err) { return send(err.code === 'NO_BACKUP_DIR' ? 409 : 500, { error: err.code || 'BACKUP_FAILED', message: err.message }); }
        }
        return send(405, { error: 'Method not allowed' });
    }

    // /film/backups/:id[/download|/restore]
    if (urlParts[1] === 'backups' && urlParts[2]) {
        const backupId = urlParts[2];
        if (!UUID_RE.test(backupId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid backup ID' }));
            return;
        }

        if (urlParts[3] === 'download' && req.method === 'GET') return downloadBackup(req, res, backupId);
        if (urlParts[3] === 'restore' && req.method === 'POST') return restoreBackup(req, res, backupId);
        if (!urlParts[3] && req.method === 'GET') return getBackup(req, res, backupId);
        if (!urlParts[3] && req.method === 'DELETE') return deleteBackup(req, res, backupId);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function listBackups(req, res, projectId) {
    const rows = db.prepare(
        'SELECT * FROM film_backups WHERE project_id = ? ORDER BY created_at DESC'
    ).all(projectId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ backups: rows, count: rows.length }));
}

function createBackup(req, res, projectId) {
    const project = db.prepare('SELECT id, title FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const body = req.body || {};
    const result = exportProjectData(projectId);
    if (!result) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to export project data' }));
        return;
    }

    const backupId = generateId();
    const now = new Date().toISOString();
    const safeName = (project.title || 'project').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const fileName = `backup_${safeName}_${now.replace(/[:.]/g, '-')}.json`;

    // Ensure backup directory exists
    if (!fs.existsSync(BACKUP_DIR)) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const filePath = path.join(BACKUP_DIR, fileName);
    const jsonStr = JSON.stringify(result.data, null, 2);
    fs.writeFileSync(filePath, jsonStr, 'utf8');

    db.prepare(`
        INSERT INTO film_backups (id, project_id, backup_type, file_path, file_size, tables_included, row_counts, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        backupId, projectId,
        body.backup_type || 'manual',
        fileName,
        Buffer.byteLength(jsonStr, 'utf8'),
        JSON.stringify(result.tablesIncluded),
        JSON.stringify(result.rowCounts),
        (body.notes || '').slice(0, 2000),
        now,
    );

    const row = db.prepare('SELECT * FROM film_backups WHERE id = ?').get(backupId);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

function getBackup(req, res, backupId) {
    const row = db.prepare('SELECT * FROM film_backups WHERE id = ?').get(backupId);
    if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Backup not found' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

/**
 * Resolve backup file_path from DB to an absolute path within BACKUP_DIR.
 * Handles both old absolute paths and new relative filenames.
 * Returns null if the resolved path escapes BACKUP_DIR.
 */
function resolveBackupPath(storedPath) {
    // If it's just a filename (new format), join with BACKUP_DIR
    const resolved = path.isAbsolute(storedPath)
        ? path.resolve(storedPath)
        : path.resolve(BACKUP_DIR, storedPath);
    if (!isPathContained(resolved, BACKUP_DIR)) return null;
    return resolved;
}

function downloadBackup(req, res, backupId) {
    const row = db.prepare('SELECT * FROM film_backups WHERE id = ?').get(backupId);
    if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Backup not found' }));
        return;
    }

    const filePath = resolveBackupPath(row.file_path);
    if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Backup file not found on disk' }));
        return;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const fileName = path.basename(filePath);
    res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${fileName}"`,
    });
    res.end(content);
}

function restoreBackup(req, res, backupId) {
    const row = db.prepare('SELECT * FROM film_backups WHERE id = ?').get(backupId);
    if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Backup not found' }));
        return;
    }

    const filePath = resolveBackupPath(row.file_path);
    if (!filePath || !fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Backup file not found on disk' }));
        return;
    }

    let backupData;
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        backupData = JSON.parse(content);
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to parse backup file' }));
        return;
    }

    const result = importProjectData(backupData);
    if (!result.success) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.error }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ restored: true, imported: result.imported }));
}

function deleteBackup(req, res, backupId) {
    const row = db.prepare('SELECT * FROM film_backups WHERE id = ?').get(backupId);
    if (!row) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Backup not found' }));
        return;
    }

    // Delete file from disk if it exists
    const filePath = resolveBackupPath(row.file_path);
    if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }

    db.prepare('DELETE FROM film_backups WHERE id = ?').run(backupId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

module.exports = { handleBackups };
