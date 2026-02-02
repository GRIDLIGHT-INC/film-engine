/**
 * File Storage Utilities
 *
 * Shared helpers for saving and serving generated files (images, audio,
 * video, 3D assets, exports) from the data/ directory.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.FILM_DATA_DIR || path.join(__dirname, '..', '..', 'data');

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
    return path.join(DATA_DIR, subdir, projectId, filename);
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
    return fs.existsSync(getFilePath(projectId, subdir, filename));
}

/**
 * Serve a static file from data/{subdir}/{projectId}/{filename}.
 * Handles sanitization, 404s, and correct content types.
 * @param {http.ServerResponse} res
 * @param {string} projectId
 * @param {string} subdir
 * @param {string} filename
 */
function serveFile(res, projectId, subdir, filename) {
    // Sanitize filename: only allow alphanumeric, hyphens, underscores, dots
    if (!/^[\w.-]+$/.test(filename)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid filename' }));
        return;
    }

    const filePath = getFilePath(projectId, subdir, filename);
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
    DATA_DIR,
};
