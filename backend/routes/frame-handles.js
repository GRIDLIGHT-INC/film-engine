/**
 * Serve one frame, to whoever holds the handle.
 *
 *   GET /film/frame-handle/:id
 *
 * UNAUTHENTICATED BY NECESSITY. The consumer is a provider's fetcher, which
 * carries none of our credentials — so the id IS the credential. That is why it
 * is 128 bits from the CSPRNG, why it expires, and why it is scoped to one
 * plan: a bearer token with no expiry is a public file.
 *
 * NOTHING FROM THE REQUEST BECOMES A PATH. The id is looked up in a map this
 * process filled from paths it resolved itself, so there is no string
 * concatenation between the URL and the filesystem at all. The alternative —
 * signing or encoding a path — means the route eventually decodes something a
 * caller supplied, which is the shape that turned an unvalidated `file_path`
 * into a deletion primitive one feature over.
 *
 * READ ONLY. This module can hand a file out and do nothing else.
 */

const fs = require('fs');
const { resolveHandle } = require('../lib/frame-handles');

const TYPES = Object.freeze({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
});

function deny(res, status, message) {
    /*
     * The same body for unknown and expired, and no hint about whether a file
     * exists. A caller guessing ids learns nothing from the difference, and the
     * operator gets the real reason from the plan that minted the handle rather
     * than from a public endpoint.
     */
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
}

function handleFrameHandles(req, res, urlParts) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return deny(res, 405, 'Method not allowed');
    }
    const found = resolveHandle(urlParts[2]);
    if (!found.ok) return deny(res, 404, 'No such frame');

    let stat;
    try { stat = fs.statSync(found.path); } catch (_) { return deny(res, 404, 'No such frame'); }
    if (!stat.isFile()) return deny(res, 404, 'No such frame');

    const dot = found.path.lastIndexOf('.');
    const type = TYPES[found.path.slice(dot).toLowerCase()] || 'application/octet-stream';
    /*
     * Content-Length is sent because a media fetcher given a chunked response
     * with no length cannot size what it is receiving — the same fault that
     * left dialogue audio stalled at readyState 0 until it was fixed.
     *
     * `no-store` because the handle expires: a cached copy sitting in an
     * intermediary would outlive the window this whole design rests on.
     */
    res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        // A frame handed to a provider is not a page, and nothing should ever
        // render it in a browsing context on our behalf.
        'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(found.path).pipe(res);
}

module.exports = { handleFrameHandles };
