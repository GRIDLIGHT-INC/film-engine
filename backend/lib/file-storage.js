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
function getFileUrl(subdir, projectId, filename) {
    return `/film/${subdir}/${projectId}/${filename}`;
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

    res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
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
