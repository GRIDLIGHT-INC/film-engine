/**
 * One-choice image finishing through MuAPI's Topaz endpoints.
 *
 * The public operation deliberately asks for only an image and a delivery tier.
 * Topaz Precision / High Fidelity V3 is the faithful default. Precision stops at
 * 4x, so very small sources use MuAPI's legacy Topaz 8x endpoint rather than
 * returning an image that is still below the requested tier.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('../file-storage');
const { dimensionsOfBuffer } = require('../image-raster');
const { hostOne, parseDataUri } = require('./muapi-upload');

const BASE_URL = process.env.MUAPI_BASE_URL || 'https://api.muapi.ai/api/v1';
const PRECISION_SLUG = process.env.MUAPI_TOPAZ_PRECISION_SLUG || 'topaz-upscale-image-precision';
const LEGACY_SLUG = process.env.MUAPI_TOPAZ_IMAGE_SLUG || 'topaz-image-upscale';
const PRECISION_MODEL = 'High Fidelity V3';
const TARGETS = Object.freeze({ '2K': 2048, '4K': 4096 });
const POLL_MS = Number(process.env.MUAPI_POLL_MS || 1500);
const POLL_BUDGET_MS = Number(process.env.MUAPI_UPSCALE_TIMEOUT_MS || 54000);

function apiKey() {
    const direct = process.env.MUAPI_API_KEY || process.env.SEEDANCE_API_KEY;
    if (direct) return direct;
    const { getCredential } = require('./credentials');
    return (getCredential('muapi') || {}).apiKey || '';
}

function normalizeResolution(value) {
    const normalized = String(value || '').trim().toUpperCase();
    if (!TARGETS[normalized]) throw new Error(`resolution must be 2K or 4K (got '${value || ''}')`);
    return normalized;
}

function buildUpscaleRequest(input) {
    const resolution = normalizeResolution(input && input.resolution);
    const width = Number(input && input.width);
    const height = Number(input && input.height);
    const imageUrl = String((input && input.image_url) || '');
    if (!(width > 0) || !(height > 0)) throw new Error('the image dimensions could not be measured');
    if (!/^https?:\/\//i.test(imageUrl)) throw new Error('MuAPI needs a hosted image URL');

    const target = TARGETS[resolution];
    const longest = Math.max(width, height);
    const needed = Math.max(1, Math.ceil(target / longest));
    if (needed > 8) {
        throw new Error(`${width}x${height} is too small to reach ${resolution}; Topaz would need ${needed}x and MuAPI supports at most 8x`);
    }

    if (needed <= 4) {
        const factor = [1, 2, 3, 4].find(value => value >= needed);
        return {
            url: `${BASE_URL}/${PRECISION_SLUG}`,
            body: { image_url: imageUrl, model: PRECISION_MODEL, upscale_factor: factor, output_format: 'png' },
            endpoint: PRECISION_SLUG,
            model: `Topaz Precision — ${PRECISION_MODEL}`,
            factor,
            target_pixels: target,
            expected_long_edge: longest * factor,
            resolution,
        };
    }

    const factor = 8;
    return {
        url: `${BASE_URL}/${LEGACY_SLUG}`,
        body: { image_url: imageUrl, factor },
        endpoint: LEGACY_SLUG,
        model: `Topaz Image Upscale ${factor}x fallback`,
        factor,
        target_pixels: target,
        expected_long_edge: longest * factor,
        resolution,
    };
}

function detailOf(data, status) {
    const detail = data && (data.error || data.detail || data.message);
    return typeof detail === 'string' ? detail : (detail ? JSON.stringify(detail).slice(0, 300) : `HTTP ${status}`);
}

function resultUrl(data) {
    const out = data && (data.outputs || data.output || data.result);
    const candidate = (Array.isArray(out) && out[0])
        || (out && (out.image_url || out.url))
        || (data && (data.image_url || data.url))
        || (out && Array.isArray(out.images) && out.images[0]);
    return typeof candidate === 'string' ? candidate : (candidate && (candidate.url || candidate.image_url));
}

async function poll(requestId, key) {
    const deadline = Date.now() + POLL_BUDGET_MS;
    const url = `${BASE_URL}/predictions/${encodeURIComponent(requestId)}/result`;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
        let response;
        try {
            response = await fetch(url, { headers: { 'x-api-key': key, accept: 'application/json' } });
        } catch (error) {
            return { ok: false, status: 502, error: `MuAPI polling failed: ${error.message}` };
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return { ok: false, status: response.status, error: `MuAPI polling failed: ${detailOf(data, response.status)}` };
        const status = String(data.status || '').toLowerCase();
        if (['completed', 'succeeded', 'success'].includes(status)) {
            const url = resultUrl(data);
            return url ? { ok: true, url } : { ok: false, status: 502, error: 'MuAPI completed the upscale without an image URL' };
        }
        if (['failed', 'error', 'cancelled'].includes(status)) {
            return { ok: false, status: 422, error: `MuAPI upscale failed: ${detailOf(data, 422)}` };
        }
    }
    return { ok: false, status: 504, error: 'MuAPI did not finish the upscale before the MCP request timeout' };
}

function outputMime(response, bytes) {
    const header = String(response.headers && response.headers.get && response.headers.get('content-type') || '').split(';')[0];
    if (header === 'image/png' || header === 'image/jpeg' || header === 'image/webp') return header;
    if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    return 'application/octet-stream';
}

async function upscaleImage(input) {
    let resolution;
    try { resolution = normalizeResolution(input && input.resolution); }
    catch (error) { return { ok: false, status: 400, error: error.message }; }

    const parsed = parseDataUri(input && input.image);
    if (!parsed || !['image/png', 'image/jpeg'].includes(parsed.mime)) {
        return { ok: false, status: 400, error: 'image must be a PNG or JPEG base64 data URI' };
    }
    const source = dimensionsOfBuffer(parsed.bytes);
    if (!source) return { ok: false, status: 400, error: 'the PNG or JPEG dimensions could not be read' };

    const key = apiKey();
    if (!key) return { ok: false, status: 401, error: 'MuAPI API key is not configured' };
    const hosted = await hostOne(input.image, key);
    if (!hosted.ok) return { ok: false, status: 422, error: hosted.error };

    let request;
    try { request = buildUpscaleRequest({ ...source, resolution, image_url: hosted.url }); }
    catch (error) { return { ok: false, status: 400, error: error.message }; }

    let response;
    try {
        response = await fetch(request.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': key, accept: 'application/json' },
            body: JSON.stringify(request.body),
        });
    } catch (error) {
        return { ok: false, status: 502, error: `MuAPI upscale request failed: ${error.message}` };
    }
    const accepted = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, status: response.status, error: `MuAPI rejected the upscale: ${detailOf(accepted, response.status)}` };
    const requestId = accepted.request_id || accepted.id;
    if (!requestId) return { ok: false, status: 502, error: 'MuAPI accepted the upscale without returning a request id' };

    const completed = await poll(requestId, key);
    if (!completed.ok) return completed;

    let downloaded;
    try { downloaded = await fetch(completed.url); }
    catch (error) { return { ok: false, status: 502, error: `Could not download the finished upscale: ${error.message}` }; }
    if (!downloaded.ok) return { ok: false, status: downloaded.status, error: `Could not download the finished upscale (HTTP ${downloaded.status})` };
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    const mime = outputMime(downloaded, bytes);
    if (!mime.startsWith('image/')) return { ok: false, status: 502, error: 'MuAPI returned a result that is not an image' };
    const output = dimensionsOfBuffer(bytes);
    if (!output) return { ok: false, status: 502, error: 'The finished Topaz image has no readable dimensions' };

    const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
    const directory = path.join(DATA_DIR, 'upscaled');
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, `topaz-${resolution.toLowerCase()}-${crypto.randomUUID()}.${extension}`);
    fs.writeFileSync(filePath, bytes);

    return {
        ok: true,
        provider: 'MuAPI',
        model: request.model,
        resolution,
        scale: request.factor,
        source,
        output,
        file_path: filePath,
        request_id: String(requestId),
        images: [{ label: `${resolution} Topaz upscale`, data_uri: `data:${mime};base64,${bytes.toString('base64')}` }],
    };
}

module.exports = { TARGETS, PRECISION_MODEL, normalizeResolution, buildUpscaleRequest, upscaleImage };
