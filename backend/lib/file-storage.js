/**
 * File Storage Utilities
 *
 * Shared helpers for saving and serving generated files (images, audio,
 * video, 3D assets, exports) from the data/ directory.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = process.env.FILM_DATA_DIR || path.join(os.homedir(), '.gridlight', 'film-engine', 'data');

/**
 * Ensure a directory exists under data/{subdir}/{projectId}/
 * @param {string} projectId
 * @param {string} subdir - e.g. 'storyboards', 'audio', 'video', 'music', '3d', 'exports'
 * @returns {string} The full directory path
 */
function ensureDir(projectId, subdir) {
    const dir = path.join(DATA_DIR, subdir, projectId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

/**
 * Save a file to data/{subdir}/{projectId}/{filename}
 * @param {string} projectId
 * @param {string} subdir
 * @param {string} filename
 * @param {Buffer} buffer
 * @returns {string} The full file path
 */
function saveFile(projectId, subdir, filename, buffer) {
    const dir = ensureDir(projectId, subdir);
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

/**
 * Get the full disk path for a stored file.
 * @param {string} projectId
 * @param {string} subdir
 * @param {string} filename
 * @returns {string}
 */
function getFilePath(projectId, subdir, filename) {
    const projectDir = path.join(DATA_DIR, subdir, projectId);
    const full = path.join(projectDir, filename);

    // Containment lives here rather than in each caller. file_name reaches this
    // function straight off film_assets rows, and POST /projects/:id/assets
    // accepts that field from a request body with no sanitisation, so a value
    // like ../../../../etc/passwd would otherwise resolve outside the data
    // directory. Callers such as loadShotContext then base64 whatever they read
    // into a generation payload and send it to an external provider, turning a
    // local read into exfiltration.
    //
    // Throws rather than returning a corrected path: a caller asking for a file
    // outside its project is either a bug or an attack, and silently rewriting
    // the path would hide both.
    if (!isPathContained(full, projectDir)) {
        throw new Error(`refusing to resolve a path outside the project directory: ${subdir}/${filename}`);
    }
    return full;
}

/**
 * Get the URL path for serving a stored file via the Film Engine API.
 * @param {string} subdir
 * @param {string} projectId
 * @param {string} filename
 * @returns {string} e.g. '/film/video/abc-123/1A.mp4'
 */
function getFileUrl(subdir, projectId, filename, version) {
    /*
     * A REGENERATED PLATE HAS TO LOOK REGENERATED.
     *
     * A plate is written to the same per-view filename and overwrites, so the
     * URL never changes and the browser serves the copy it already has. A
     * successful, paid-for regeneration therefore left the page byte-identical
     * — which reads as "nothing happened" and invites pressing the button
     * again, paying twice.
     *
     * The storyboard frame learned this and busts on `asset_version`; every
     * plate URL was built here with no buster at all, so the same bug lived on
     * one subsystem over. Reported as "I had to hard refresh to see the
     * picture", which is exactly what it looks like from the outside.
     *
     * Keyed to the asset's own TIMESTAMP first, then its version. Every plate
     * row is written with `version` 1 — it is a constant here, so a buster
     * reading it produced `?v=1` on every plate forever and changed nothing.
     * `created_at` is what actually moves when a plate is regenerated.
     *
     * Not the clock: busting
     * on every render would re-download every unchanged plate on the board on
     * each refresh, which on a feature-length production is a lot of bytes
     * spent hiding one bug.
     */
    const base = `/film/${subdir}/${projectId}/${filename}`;
    if (version === undefined || version === null || version === '') return base;
    return `${base}?v=${encodeURIComponent(String(version).replace(/[^\w.:-]/g, ''))}`;
}

/**
 * Check if a file exists on disk.
 * @param {string} projectId
 * @param {string} subdir
 * @param {string} filename
 * @returns {boolean}
 */
function fileExists(projectId, subdir, filename) {
    // A path that escapes the project directory does not "exist" as far as
    // callers are concerned; getFilePath throws, and that is not a crash here.
    try {
        return fs.existsSync(getFilePath(projectId, subdir, filename));
    } catch (_) {
        return false;
    }
}

/**
 * Validate that a resolved path is contained within an allowed base directory.
 * Prevents path traversal attacks.
 * @param {string} filePath - The path to validate
 * @param {string} baseDir - The allowed base directory
 * @returns {boolean}
 */
function isPathContained(filePath, baseDir) {
    const resolved = path.resolve(filePath);
    const resolvedBase = path.resolve(baseDir);
    return resolved.startsWith(resolvedBase + path.sep) || resolved === resolvedBase;
}

/**
 * Serve a static file from data/{subdir}/{projectId}/{filename}.
 * Handles sanitization, 404s, and correct content types.
 * @param {http.ServerResponse} res
 * @param {string} projectId
 * @param {string} subdir
 * @param {string} filename
 */
function serveFile(res, projectId, subdir, filename, opts) {
    // Sanitize filename: only allow alphanumeric, hyphens, underscores, dots
    if (!/^[\w.-]+$/.test(filename)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid filename' }));
        return;
    }

    let filePath;
    try {
        filePath = getFilePath(projectId, subdir, filename);
    } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid file path' }));
        return;
    }
    if (!isPathContained(filePath, DATA_DIR)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid file path' }));
        return;
    }
    if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found' }));
        return;
    }

    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg',
        '.mid': 'audio/midi',
        '.ogg': 'audio/ogg',
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
        '.webm': 'video/webm',
        '.glb': 'model/gltf-binary',
        '.gltf': 'model/gltf+json',
        '.fbx': 'application/octet-stream',
        '.obj': 'text/plain',
        '.usdz': 'model/vnd.usdz+zip',
        '.json': 'application/json',
        '.xml': 'application/xml',
        '.edl': 'text/plain',
        '.zip': 'application/zip',
    };

    /*
     * A thumbnail when one was asked for.
     *
     * Handled HERE rather than in each media route because every surface that
     * paints a picture comes through this function — the board, the viewer,
     * previs, plates, the continuity board. A per-route thumbnail is how four
     * of five surfaces get one.
     *
     * Falls through to the original on any failure, including no encoder: a
     * thumbnail is an optimisation and must never be able to take down the
     * picture it is optimising.
     */
    const wanted = opts && opts.width;
    if (wanted) {
        const { thumbnailFor } = require('./thumbnails');
        thumbnailFor(filePath, wanted).then(thumb => {
            const serving = thumb || filePath;
            res.writeHead(200, {
                'Content-Type': thumb ? 'image/jpeg' : (mimeTypes[ext] || 'application/octet-stream'),
                // Immutable: the URL carries the frame version and the cache key
                // carries the source's identity, so this exact bytes-for-URL
                // pairing can never change.
                'Cache-Control': 'public, max-age=86400',
                'X-Thumbnail': thumb ? 'hit' : 'source',
            });
            fs.createReadStream(serving).pipe(res);
        }).catch(() => {
            res.writeHead(200, {
                'Content-Type': mimeTypes[ext] || 'application/octet-stream',
                'Cache-Control': 'public, max-age=3600',
            });
            fs.createReadStream(filePath).pipe(res);
        });
        return;
    }

    /*
     * Length and ranges, because media elements need both.
     *
     * Piped with no Content-Length, Node falls back to chunked transfer — and a
     * browser <audio> or <video> given a chunked response with no length cannot
     * compute a duration and stalls at readyState 0. The file serves perfectly
     * to curl the whole time, which is what made this look like a missing file
     * rather than a missing header: playback showed a shot with dialogue
     * attached and silence over it.
     *
     * Range support matters for the same reason: a media element asks for a
     * byte range to seek, and a server that answers 200 with the whole file
     * makes scrubbing re-download the lot.
     */
    const stat = fs.statSync(filePath);
    const range = res.req && res.req.headers && res.req.headers.range;
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range));

    if (m) {
        /*
         * A SUFFIX RANGE IS THE END OF THE FILE, NOT THE START.
         *
         * `bytes=-20000` means the LAST 20000 bytes (RFC 7233). This read the
         * empty first group as 0 and served the FIRST 20001, labelled
         * `bytes 0-20000/…` — and that is fatal for exactly the files this
         * engine produces. ffmpeg writes the `moov` atom at the END unless
         * asked for +faststart, measured at 99% of every clip here, so a
         * player's first move is a suffix range to go and find it. Handed the
         * head instead, it cannot parse the container and WAITS: a valid 206
         * full of real bytes is not an error, so nothing is ever reported.
         *
         * That was the black screen in playback — every clip, with the file
         * serving perfectly to curl the whole time.
         */
        let start, end;
        if (!m[1] && m[2]) {
            const wanted = parseInt(m[2], 10);
            /*
             * `bytes=-0` is unsatisfiable. Stated explicitly, though a mutation
             * proved it is behaviourally invisible: without it start becomes
             * size and the general start > end check below refuses it anyway.
             * Kept because the reader should not have to derive that.
             */
            if (!Number.isNaN(wanted) && wanted === 0) {
                res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
                res.end();
                return;
            }
            // A suffix longer than the file is the whole file, never a negative offset.
            start = Math.max(0, stat.size - wanted);
            end = stat.size - 1;
        } else {
            start = m[1] ? parseInt(m[1], 10) : 0;
            end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        }
        // A range past the end is clamped rather than refused; a player asking
        // for more than exists is asking for what exists.
        if (end >= stat.size) end = stat.size - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
            res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
            res.end();
            return;
        }
        res.writeHead(206, {
            'Content-Type': mimeTypes[ext] || 'application/octet-stream',
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=3600',
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
    }

    res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
}

module.exports = {
    ensureDir,
    saveFile,
    getFilePath,
    getFileUrl,
    fileExists,
    serveFile,
    isPathContained,
    DATA_DIR,
};
