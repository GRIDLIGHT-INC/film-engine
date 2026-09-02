/**
 * Getting a picture to MuAPI, which will not take one inline.
 *
 * MuAPI's models are addressed by URL, never by bytes. Every endpoint on the
 * platform — the nano image models and Seedance alike — validates `images_list`
 * as a list of URLs and refuses a data URI outright:
 *
 *   {"type":"url_too_long","loc":["body","images_list",0],
 *    "msg":"URL should have at most 2083 characters",
 *    "input":"data:image/png;base64,iVBORw0KGgo…"}
 *
 * This engine holds its plates and keyframes as local files and inlines them as
 * base64, which is right for every other vendor and impossible for this one. So
 * the bytes go up first and the URL goes in the payload.
 *
 * FREE, and deliberately so: MuAPI documents `upload_file` as costing no
 * credits. A generation that fails on its references has already been paid for,
 * which is why this runs before the request rather than after a refusal.
 *
 * The returned URL is presigned and expires in about an hour. That is not a
 * problem to solve — the generation is submitted seconds later, and a link that
 * dies afterwards is a feature for a reference that was never meant to persist.
 * It does mean these URLs must never be STORED as if they were assets.
 */

const { getCredential } = require('./credentials');

const BASE_URL = process.env.MUAPI_BASE_URL || 'https://api.muapi.ai/api/v1';

/** Images MuAPI accepts, and the ceiling it documents. */
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 10 * 1024 * 1024;

/** One MuAPI key serves images, video and uploads; seedance is where it lives. */
function muapiKey() {
    const own = getCredential('muapi');
    if (own && own.apiKey) return own.apiKey;
    return (getCredential('seedance') || {}).apiKey || '';
}

function parseDataUri(uri) {
    const m = /^data:([^;,]+);base64,(.+)$/i.exec(String(uri || ''));
    if (!m) return null;
    return { mime: m[1].toLowerCase(), bytes: Buffer.from(m[2], 'base64') };
}

/**
 * Upload one data URI and return the URL MuAPI will fetch it from.
 * Anything already addressable is returned untouched.
 */
async function hostOne(uri, apiKey) {
    if (typeof uri !== 'string') return { ok: false, error: 'not a string' };
    if (/^https?:\/\//i.test(uri)) return { ok: true, url: uri, uploaded: false };

    const parsed = parseDataUri(uri);
    if (!parsed) return { ok: false, error: 'neither a URL nor a base64 data URI' };
    if (!ACCEPTED.has(parsed.mime)) {
        return { ok: false, error: `muapi accepts jpg, png and webp; got ${parsed.mime}` };
    }
    if (parsed.bytes.length > MAX_BYTES) {
        return { ok: false, error: `image is ${Math.round(parsed.bytes.length / 1048576)}MB; muapi accepts 10MB` };
    }

    const ext = parsed.mime === 'image/jpeg' ? 'jpg' : parsed.mime.split('/')[1];
    const form = new FormData();
    form.append('file', new Blob([parsed.bytes], { type: parsed.mime }), `reference.${ext}`);

    let res;
    try {
        res = await fetch(`${BASE_URL}/upload_file`, {
            method: 'POST',
            headers: { 'x-api-key': apiKey, accept: 'application/json' },
            body: form,
        });
    } catch (err) {
        return { ok: false, error: `upload failed — ${err.message}` };
    }

    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.url) {
        const detail = (data && (data.error || data.detail || data.message)) || `HTTP ${res.status}`;
        return { ok: false, error: `upload rejected — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200)}` };
    }
    return { ok: true, url: data.url, uploaded: true };
}

/**
 * Host every picture in a list, in order.
 *
 * ORDER IS PRESERVED because order is meaning: on a first-last-frame request
 * [0] is the frame the clip starts on and [1] is where it ends. A list that
 * came back reordered would generate the move backwards.
 *
 * REFUSES rather than dropping. A reference that silently failed to upload is a
 * clip generated without its keyframe — which looks like a bad generation and
 * is really a missing input, the most expensive kind of failure to diagnose.
 */
async function hostImages(uris, apiKey) {
    const key = apiKey || muapiKey();
    if (!key) return { ok: false, error: 'muapi: no API key configured' };

    const list = Array.isArray(uris) ? uris : [uris];
    const urls = [];
    let uploaded = 0;
    for (let i = 0; i < list.length; i++) {
        const out = await hostOne(list[i], key);
        if (!out.ok) return { ok: false, error: `muapi: reference ${i + 1} of ${list.length} — ${out.error}` };
        urls.push(out.url);
        if (out.uploaded) uploaded++;
    }
    return { ok: true, urls, uploaded };
}

module.exports = { hostImages, hostOne, parseDataUri, ACCEPTED, MAX_BYTES };
