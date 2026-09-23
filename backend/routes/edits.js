/**
 * Edits made outside Film Engine, over HTTP.
 *
 *   GET    /film/projects/:id/edits              every version, newest first
 *   POST   /film/projects/:id/edits/import       a new version: { data | upload_id, name?, notes?, cut?, sequence? }
 *   GET    /film/edits/:id                       one version, with its cut list
 *   PUT    /film/edits/:id                       rename, notes
 *   DELETE /film/edits/:id[?force=true]          refused while a score is written against it
 *   POST   /film/edits/:id/cut                   the XML or EDL it was cut from: { text | data, sequence? }
 *   POST   /film/edits/:id/cut/rematch           match the stored cut against the shots as they are now
 *   GET    /film/edits/:projectId/:file          the picture itself (and the cut file)
 */

const edits = require('../lib/edits');
const { serveFile } = require('../lib/file-storage');

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function attempt(res, status, fn) {
    try { return json(res, status, fn()); }
    catch (e) { return json(res, e.status || 500, { error: e.message, ...(e.code ? { code: e.code } : {}), ...(e.sessions ? { sessions: e.sessions } : {}) }); }
}

async function handleEdits(req, res, parts, query) {
    // /film/projects/:id/edits[/import]
    if (parts[1] === 'projects') {
        const projectId = parts[2];
        if (!parts[4] && req.method === 'GET') return attempt(res, 200, () => ({ project_id: projectId, edits: edits.listEdits(projectId) }));
        if (parts[4] === 'import' && req.method === 'POST') {
            const b = req.body || {};
            // A raw-bytes body (a media content type) is the file itself.
            const input = b.__raw ? { bytes: b.__raw, name: query && query.name } : b;
            return attempt(res, 201, () => ({ edit: edits.importEdit(projectId, input) }));
        }
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/edits/:projectId/:file — the picture, served like any stored file.
    if (parts[2] && parts[3] && !['cut'].includes(parts[3]) && req.method === 'GET') {
        return serveFile(res, parts[2], edits.SUBDIR, parts[3], { width: query && query.w });
    }

    const id = parts[2];
    if (!id) return json(res, 404, { error: 'Not found' });
    if (parts[3] === 'cut' && parts[4] === 'rematch' && req.method === 'POST') return attempt(res, 200, () => ({ edit: edits.rematchCut(id) }));
    if (parts[3] === 'cut' && !parts[4] && req.method === 'POST') {
        const b = req.body || {};
        return attempt(res, 200, () => ({ edit: edits.attachCut(id, { text: b.text, data: b.data, sequence: b.sequence, name: b.name }) }));
    }
    if (!parts[3] && req.method === 'GET') return attempt(res, 200, () => ({ edit: edits.getEdit(id) }));
    if (!parts[3] && req.method === 'PUT') return attempt(res, 200, () => ({ edit: edits.updateEdit(id, req.body) }));
    if (!parts[3] && req.method === 'DELETE') {
        const force = (query && (query.force === 'true' || query.force === '1')) || (req.body && req.body.force === true);
        return attempt(res, 200, () => edits.deleteEdit(id, { force }));
    }
    return json(res, 405, { error: 'Method not allowed' });
}

module.exports = { handleEdits };
