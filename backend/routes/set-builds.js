/**
 * A location's set, built in Blender from its own plates.
 *
 *   GET  /film/locations/:id/set-build/brief     free: the plates, the words, the vocabulary
 *   GET  /film/locations/:id/set-builds          every attempt, newest first
 *   POST /film/locations/:id/set-builds          { layout, note } → build headless, render, compare (free)
 *   GET  /film/set-builds/:id                    one attempt
 *   GET  /film/set-builds/:id/files/:name        a comparison sheet
 *   POST /film/set-builds/:id/finish             project, export, world version, 3D asset (free)
 *
 * The layout is written by the connected agent; see lib/set-build.js for why
 * the engine never writes it.
 */
const fs = require('fs');
const path = require('path');
const setBuild = require('../lib/set-build');

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function fail(res, err) {
    const status = err.status || (err.code === 'NO_BLENDER' ? 503 : 500);
    return json(res, status, { error: err.message, ...(err.errors ? { errors: err.errors } : {}),
        ...(err.code ? { code: err.code } : {}), ...(err.build ? { build: err.build } : {}) });
}

/** The URL segments this router answers, so server.js can dispatch before the location catch-all. */
const LOCATION_TAILS = Object.freeze(['set-build', 'set-builds']);

async function handleSetBuilds(req, res, urlParts, query) {
    const q = query || {};
    const body = req.body || {};
    try {
        if (urlParts[1] === 'locations') {
            const locationId = urlParts[2];
            if (urlParts[3] === 'set-build' && urlParts[4] === 'brief' && req.method === 'GET') {
                const b = setBuild.brief(locationId, { withImages: q.images === '1' || q.images === 'true' });
                return b ? json(res, 200, b) : json(res, 404, { error: 'Location not found' });
            }
            if (urlParts[3] === 'set-builds' && !urlParts[4]) {
                if (req.method === 'GET') return json(res, 200, { builds: setBuild.listBuilds(locationId) });
                if (req.method === 'POST') {
                    const out = await setBuild.renderAttempt(locationId, body.layout,
                        { note: body.note, withImages: !!body.with_images });
                    return json(res, out.refused ? 422 : 201, out);
                }
            }
            return json(res, 405, { error: 'Method not allowed' });
        }

        // /film/set-builds/:id[/finish|/files/:name]
        const buildId = urlParts[2];
        if (!urlParts[3] && req.method === 'GET') {
            const b = setBuild.getBuild(buildId);
            return b ? json(res, 200, b) : json(res, 404, { error: 'Set build not found' });
        }
        if (urlParts[3] === 'finish' && req.method === 'POST') {
            return json(res, 200, await setBuild.finishAttempt(buildId, { style: body.style }));
        }
        if (urlParts[3] === 'files' && urlParts[4] && req.method === 'GET') {
            const name = urlParts[4];
            if (!/^compare_[\w-]+\.png$/.test(name)) return json(res, 400, { error: 'Invalid file name' });
            const row = require('../db/database').db.prepare('SELECT out_dir FROM film_set_builds WHERE id = ?').get(buildId);
            if (!row || !row.out_dir) return json(res, 404, { error: 'Set build not found' });
            const file = path.join(row.out_dir, name);
            if (!fs.existsSync(file)) return json(res, 404, { error: 'No such sheet' });
            const bytes = fs.readFileSync(file);
            res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
            return res.end(bytes);
        }
        return json(res, 405, { error: 'Method not allowed' });
    } catch (err) {
        return fail(res, err);
    }
}

module.exports = { handleSetBuilds, LOCATION_TAILS };
