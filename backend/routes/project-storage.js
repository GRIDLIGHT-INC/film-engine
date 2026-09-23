/**
 * Project folders over HTTP.
 *
 *   GET  /film/storage/layout                what a project folder looks like, and where new ones go
 *   GET  /film/storage/suggest?title=&parent= the folder a new project would get (free, writes nothing)
 *   GET  /film/storage/browse?path=          the folders inside a folder, for choosing one
 *   GET  /film/projects/:id/storage          where this project's files are, folder by folder
 *   POST /film/projects/:id/storage/move     move them to a new folder, and repoint every record
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const folders = require('../lib/project-folders');
const storage = require('../lib/project-storage');

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/*
 * Browsing is bounded to the home folder and mounted drives. The server
 * answers anyone who can reach it, and a folder picker that lists the whole
 * disk is a directory listing of the machine handed to the network.
 */
function browsable(dir) {
    const roots = [os.homedir(), '/Volumes', folders.defaultProjectsRoot()];
    return roots.some(r => dir === path.resolve(r) || dir.startsWith(path.resolve(r) + path.sep));
}

function browse(req, res, query) {
    const asked = folders.expandHome((query && query.path) || os.homedir());
    const dir = path.resolve(asked);
    if (!browsable(dir)) return json(res, 403, { error: 'only folders inside your home folder or on a mounted drive can be browsed' });
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return json(res, 404, { error: `cannot open ${dir}: ${e.code || e.message}` }); }
    const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(dir);
    return json(res, 200, {
        path: dir,
        parent: parent !== dir && browsable(parent) ? parent : null,
        is_project: fs.existsSync(path.join(dir, folders.README_NAME)),
        dirs,
    });
}

function suggest(req, res, query) {
    const q = query || {};
    const title = q.title || 'Untitled Film';
    const v = storage.resolveRequested({ parent: q.parent || undefined, assets_dir: q.assets_dir || undefined }, title, q.project_id);
    return json(res, 200, {
        assets_dir: v.ok ? v.dir : null,
        valid: v.ok,
        error: v.ok ? null : v.error,
        parent: q.parent ? folders.expandHome(q.parent) : storage.defaultParent(),
    });
}

function layout(req, res) {
    return json(res, 200, {
        layout: folders.layoutList(),
        default_parent: storage.defaultParent(),
        readme: folders.README_NAME,
    });
}

async function handleProjectStorage(req, res, parts, query) {
    // /film/storage/:action
    if (parts[1] === 'storage') {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        if (parts[2] === 'layout') return layout(req, res);
        if (parts[2] === 'suggest') return suggest(req, res, query);
        if (parts[2] === 'browse') return browse(req, res, query);
        return json(res, 404, { error: 'Unknown storage route' });
    }

    // /film/projects/:id/storage[/move]
    const id = parts[2];
    if (req.method === 'GET' && !parts[4]) {
        const report = storage.storageReport(id);
        if (!report) return json(res, 404, { error: 'Project not found' });
        return json(res, 200, report);
    }
    if (req.method === 'POST' && parts[4] === 'move') {
        try {
            const result = await storage.moveProject(id, req.body || {});
            return json(res, 200, { ...result, storage: storage.storageReport(id) });
        } catch (e) {
            return json(res, e.status || 500, { error: e.message });
        }
    }
    return json(res, 405, { error: 'Method not allowed' });
}

module.exports = { handleProjectStorage };
