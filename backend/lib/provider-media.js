/**
 * Persisting provider-generated media to local storage.
 *
 * Providers answer a generation call in one of two shapes, and gridlight-client
 * hands them back differently (see _callGridlightInner):
 *
 *   binary body              -> result.data is a Buffer
 *   application/json + URL   -> result.data is the parsed object
 *
 * Gridlight's generation endpoints use the JSON+URL shape — POST /video returns
 * { video_url }, POST /music returns { audio_url }, POST /image returns
 * { image_urls } (GRIDLIGHT_API_REFERENCE.md). Only the GET /videos/:file,
 * /music/:file and /images/:file *serving* endpoints return binary.
 *
 * Routes used to write result.data straight into film_assets.file_path when it
 * wasn't a Buffer, which stored a remote URL and never downloaded anything. The
 * media then existed only on the provider: NLE exports emitted
 * <pathurl>file:///http://host/videos/x.mp4</pathurl>, in-app /film/video/...
 * links 404'd, and project bundles had no media to copy. The storyboard route
 * always did the right thing by downloading the returned URL; this module is
 * that behaviour, shared.
 */

const { GRIDLIGHT_URL, GRIDLIGHT_API_KEY } = require('./gridlight-client');
const { saveFile } = require('./file-storage');

// Single-value URL fields, most specific first.
const URL_FIELDS = ['video_url', 'audio_url', 'image_url', 'file_url', 'output_url', 'url'];
// Array forms (Gridlight's /image returns image_urls).
const URL_ARRAY_FIELDS = ['image_urls', 'video_urls', 'audio_urls'];

/**
 * Pull the media URL out of a provider's JSON response.
 * @returns {string|null}
 */
function extractMediaUrl(data) {
    if (!data || typeof data !== 'object') return null;
    for (const field of URL_FIELDS) {
        if (typeof data[field] === 'string' && data[field]) return data[field];
    }
    for (const field of URL_ARRAY_FIELDS) {
        const value = data[field];
        if (Array.isArray(value) && typeof value[0] === 'string' && value[0]) return value[0];
    }
    // Some responses name the file only; resolveMediaUrl turns it into a path.
    if (typeof data.filename === 'string' && data.filename) return data.filename;
    return null;
}

/**
 * Turn whatever URL form the provider returned into something fetchable.
 * Mirrors the storyboard route: absolute URLs pass through, root-relative paths
 * hang off the gateway, and a bare filename resolves under the serving dir.
 * @param {string} mediaUrl
 * @param {string} serveDir - gateway serving directory, e.g. 'videos', 'music'
 */
function resolveMediaUrl(mediaUrl, serveDir) {
    if (/^https?:\/\//i.test(mediaUrl)) return mediaUrl;
    if (mediaUrl.startsWith('/')) return `${GRIDLIGHT_URL}${mediaUrl}`;
    return `${GRIDLIGHT_URL}/${serveDir}/${mediaUrl}`;
}

/**
 * Save provider-generated media under data/{subdir}/{projectId}/{filename},
 * downloading it first when the provider returned a URL instead of bytes.
 *
 * Throws rather than returning a non-local path: an asset row pointing at a URL
 * (or at nothing) is what broke the Premiere handoff, so a generation that
 * cannot be persisted locally must fail loudly and mark its job failed.
 *
 * @param {string} projectId
 * @param {string} subdir - local storage dir: 'video' | 'audio' | 'music'
 * @param {string} filename
 * @param {Buffer|object} data - result.data from a provider adapter
 * @param {{serveDir?: string}} [opts] - gateway serving dir for bare filenames
 * @returns {Promise<string>} absolute path to the saved file
 */
async function persistProviderMedia(projectId, subdir, filename, data, opts) {
    if (Buffer.isBuffer(data)) return saveFile(projectId, subdir, filename, data);

    const mediaUrl = extractMediaUrl(data);
    if (!mediaUrl) {
        throw new Error(`provider returned neither media bytes nor a media URL for ${filename}`);
    }

    const serveDir = (opts && opts.serveDir) || subdir;
    const fetchUrl = resolveMediaUrl(mediaUrl, serveDir);

    // Only forward our credential to the gateway itself — never to a third-party
    // CDN a provider might point us at.
    const headers = {};
    if (GRIDLIGHT_API_KEY && fetchUrl.startsWith(GRIDLIGHT_URL)) {
        headers['Authorization'] = `Bearer ${GRIDLIGHT_API_KEY}`;
    }

    const response = await fetch(fetchUrl, { headers });
    if (!response.ok) {
        throw new Error(`failed to download generated media from ${fetchUrl}: ${response.status}`);
    }

    return saveFile(projectId, subdir, filename, Buffer.from(await response.arrayBuffer()));
}

module.exports = { persistProviderMedia, extractMediaUrl, resolveMediaUrl };
