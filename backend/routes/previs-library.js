/**
 * The Previs library over HTTP: free low-poly furniture and people.
 *
 *   GET /film/previs-library[?category=]   every entry, free
 *   GET /film/previs-library/:id/file      the GLB
 */
const fs = require('fs');
const lib = require('../lib/previs-library');

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function handlePrevisLibrary(req, res, urlParts, query) {
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    const id = urlParts[2];
    if (!id) {
        const cat = (query || {}).category;
        if (cat && !lib.CATEGORIES.includes(cat)) return json(res, 400, { error: `Unknown category '${cat}'. Known: ${lib.CATEGORIES.join(', ')}` });
        return json(res, 200, { categories: lib.CATEGORIES, entries: lib.list(cat) });
    }
    const e = lib.get(id);
    if (!e) return json(res, 404, { error: `No library entry '${id}'` });
    if (urlParts[3] === 'file') {
        const bytes = fs.readFileSync(e.file);
        res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': bytes.length, 'Cache-Control': 'public, max-age=86400' });
        return res.end(bytes);
    }
    const { file, ...rest } = e;
    return json(res, 200, rest);
}

module.exports = { handlePrevisLibrary };
