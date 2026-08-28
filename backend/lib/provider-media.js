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
const URL_FIELDS = ['video_url', 'audio_url', 'image_url', 'model_url', 'file_url', 'output_url', 'url'];
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
 * True when a URL points at the Gridlight gateway itself, and is therefore
 * allowed to receive our gateway credential.
 *
 * Compares parsed ORIGINS, never string prefixes. `fetchUrl.startsWith(GRIDLIGHT_URL)`
 * looks equivalent and is not: with a gateway of https://gw.example, all of
 * `https://gw.example@evil.tld/`, `https://gw.example.evil.tld/` and
 * `https://gw.example-evil.tld/` pass a prefix test while resolving to hosts the
 * operator does not control. Since the URL being tested comes from a provider's
 * response, that turns any malicious or compromised provider into gateway-key
 * exfiltration.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isGatewayUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
        const target = new URL(url);
        // Only ever speak HTTP(S); file:, javascript: and friends are never the gateway.
        if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
        return target.origin === new URL(GRIDLIGHT_URL).origin;
    } catch (_) {
        return false;
    }
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
    if (GRIDLIGHT_API_KEY && isGatewayUrl(fetchUrl)) {
        headers['Authorization'] = `Bearer ${GRIDLIGHT_API_KEY}`;
    }

    const response = await fetch(fetchUrl, { headers });
    if (!response.ok) {
        throw new Error(`failed to download generated media from ${fetchUrl}: ${response.status}`);
    }

    return saveFile(projectId, subdir, filename, Buffer.from(await response.arrayBuffer()));
}

module.exports = { persistProviderMedia, extractMediaUrl, resolveMediaUrl, isGatewayUrl };

/**
 * How much image a data: URI may carry.
 *
 * Runway documents 5MB ENCODED for an inline image — about 3.3MB of file. A
 * real keyframe here is 1.51MB (2.01MB encoded) and comfortably inside it, so
 * this is not what was breaking video; the envelope was. But a 2K location
 * plate can approach it, and sending anyway buys a rejection that reads like a
 * credential problem rather than a size one.
 *
 * Above this the documented path is Runway's ephemeral upload endpoint
 * (POST /v1/uploads → runway:// URI, 200MB), which is named in the refusal so
 * the message points at the fix.
 */
const DATA_URI_LIMIT = 5 * 1024 * 1024;

/** Is this inline image beyond what a provider will accept inline? */
function tooLargeForDataUri(uri, limit) {
    const s = String(uri || '');
    if (!s.startsWith('data:')) return false;
    const comma = s.indexOf(',');
    const payload = comma >= 0 ? s.length - comma - 1 : s.length;
    return payload > (Number(limit) || DATA_URI_LIMIT);
}

module.exports.DATA_URI_LIMIT = DATA_URI_LIMIT;
module.exports.tooLargeForDataUri = tooLargeForDataUri;

