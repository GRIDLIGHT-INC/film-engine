/**
 * Topaz Labs — video finishing (Starlight, Astra, Proteus).
 *
 *   https://api.topazlabs.com/video/        header: X-API-Key
 *
 * The finishing pass. MuAPI already resells Topaz's OLDER video upscaler; this
 * adapter reaches Starlight Precise 2.6, Starlight Fast 3 and Astra 2, which
 * are only on Topaz's own API, at Topaz's published credit prices.
 *
 * The flow is Topaz's, and each step matters (docs: developer.topazlabs.com,
 * Video Quickstart; OpenAPI snapshot in tests/fixtures/topaz-contract.json):
 *
 *   1. POST /video/                      describe the source, the output and the
 *                                        filter; FREE, returns requestId + a
 *                                        credit estimate [low, high]
 *   2. PATCH /video/{id}/accept          reserves the credits, returns signed
 *                                        upload URL(s) — this is where it spends
 *   3. PUT the bytes to urls[i]          500 MB per URL; the ETag of each part
 *   4. PATCH /video/{id}/complete-upload starts processing
 *   5. GET /video/{id}/status            progress %, then download.url
 *   DELETE /video/{id}                   a REAL cancel: unstarted work is refunded
 *
 * The source is described by what the file IS, read by the encoder: Topaz
 * re-estimates once the file arrives and FAILS the request (refunding it) when
 * the two disagree, so a guessed frame count is a paid round trip for nothing.
 */

const fs = require('fs');
const path = require('path');
const { getCredential } = require('./credentials');

const BASE_URL = (process.env.TOPAZ_BASE_URL || 'https://api.topazlabs.com').replace(/\/+$/, '');
// Read on every poll, so a test (or an operator) can change it without a restart.
const pollIntervalMs = () => Number(process.env.TOPAZ_POLL_INTERVAL_MS || 4000);
const POLL_TIMEOUT_MS = Number(process.env.TOPAZ_POLL_TIMEOUT_MS || 1800000);   // Starlight is slow
const SEGMENT_BYTES = 500 * 1000 * 1000;     // Topaz's documented upload segment

/*
 * The models offered here, with Topaz's own pricing: FRAMES PER CREDIT at the
 * output size (1080p / 4K), from each model's page on 2026-09-30. A credit is
 * $0.12 on the Starter plan, $0.10 Developer, $0.08 Scale (topazlabs.com/api);
 * the rate book holds the Starter price, the ceiling, and an install on a
 * cheaper plan corrects it in film_provider_rates.
 *
 * `params` are the filter fields Topaz documents for that model, and nothing
 * else is sent: a field Topaz does not know is refused at create.
 */
const MODELS = Object.freeze({
    'slp-2.6': {
        label: 'Starlight Precise 2.6', family: 'Starlight', kind: 'generative',
        framesPerCredit: { '1080p': 26.0417, '4k': 11.9179 },
        maxLongEdge: 3840,
        params: { sharpness: [1, 5] },
        why: 'Diffusion upscale to 4K that restores faces, fabric and text; the best finish for generated footage.',
    },
    'slf-3': {
        label: 'Starlight Fast 3', family: 'Starlight', kind: 'generative',
        framesPerCredit: { '1080p': 26.0417, '4k': 11.9179 },
        maxLongEdge: 3840,
        params: {},
        why: 'Up to four times faster than Precise 2.6 at comparable 4K quality, same price.',
    },
    'ast-2': {
        label: 'Astra 2', family: 'Astra', kind: 'creative',
        framesPerCredit: { '1080p': 10, '4k': 6 },
        maxLongEdge: 3840,
        params: { creativity: [0, 1], realism: [0, 1], sharp: [0, 1], prompt: 'text' },
        why: 'Creative upscale: adds new detail and can be steered with a prompt. It changes the picture.',
    },
    'prob-4': {
        label: 'Proteus', family: 'Proteus', kind: 'precision',
        framesPerCredit: { '1080p': 150, '4k': 50 },
        maxLongEdge: 7680,
        params: {},
        why: 'Precision upscale that keeps the source as it is. Cheapest by far; adds no generated detail.',
    },
});
const DEFAULT_MODEL = process.env.TOPAZ_VIDEO_MODEL || 'slp-2.6';

const CONTAINERS = new Set(['3gp', 'avi', 'dv', 'flv', 'm1v', 'm2t', 'm2ts', 'm2v', 'm4v', 'mkv', 'mov',
    'mp4', 'mpeg', 'mpg', 'mts', 'mxf', 'ser', 'ts', 'vob', 'webm', 'wmv']);

function parseSize(s) {
    const m = String(s || '').match(/(\d{2,5})\s*[x×]\s*(\d{2,5})/i);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}
const even4 = n => Math.max(4, Math.ceil(n / 4) * 4);   // Topaz rounds up to a multiple of 4

/**
 * The frame this pass will deliver: the source's own shape, grown until it
 * reaches the delivery size, never past what the model can make.
 *
 * Fitted by the SHORT edge of the target, so a 16:9 clip bound for 3840x2160
 * lands on 3840x2160 and a 2.39:1 clip lands on 5162x2160 — capped at the
 * model's long edge, with the cap said rather than hidden.
 */
function outputFrame(source, targetRes, model) {
    const m = MODELS[model] || MODELS[DEFAULT_MODEL];
    const t = parseSize(targetRes) || { width: 1920, height: 1080 };
    if (!source || !source.width || !source.height) {
        return { width: t.width, height: t.height, capped: false, note: 'The source was not measured, so the delivery size is asked for as it stands.' };
    }
    const landscape = source.width >= source.height;
    const targetShort = Math.min(t.width, t.height);
    let scale = targetShort / Math.min(source.width, source.height);
    if (scale < 1) scale = 1;                                  // never shrink a clip in a finishing pass
    let w = source.width * scale, h = source.height * scale;
    let capped = false;
    const long = Math.max(w, h);
    if (long > m.maxLongEdge) { const k = m.maxLongEdge / long; w *= k; h *= k; capped = true; }
    const out = { width: even4(Math.round(w)), height: even4(Math.round(h)), capped };
    if (capped) out.note = `${m.label} delivers at most ${m.maxLongEdge}px on the long edge, so this clip is finished at ${out.width}x${out.height}${landscape ? '' : ' (portrait)'}.`;
    return out;
}

/** Credits for a clip of `frames` frames at an output frame, from the model's own table. */
function creditsFor(model, frames, frame) {
    const m = MODELS[model] || MODELS[DEFAULT_MODEL];
    const long = frame ? Math.max(frame.width, frame.height) : 1920;
    // Above 1080p-class output the 4K rate applies; Topaz publishes those two.
    const fpc = long > 2048 ? m.framesPerCredit['4k'] : m.framesPerCredit['1080p'];
    return Math.max(1, Math.ceil((Number(frames) || 0) / fpc));
}

/**
 * The request this upscale would send, built from the MEASURED source. Pure:
 * the preview and the paid run read the same function, so the price shown is
 * the price asked for.
 */
function buildVideoRequest(payload) {
    const p = payload || {};
    const model = MODELS[p.model] ? p.model : DEFAULT_MODEL;
    const spec = MODELS[model];
    const file = p.source_video || null;
    let size = Number(p.source_bytes) || 0;
    if (!size && file) { try { size = fs.statSync(file).size; } catch (_) { size = 0; } }
    const width = Number(p.source_width) || 0;
    const height = Number(p.source_height) || 0;
    const seconds = Number(p.source_seconds) || 0;
    const fps = Number(p.source_fps) || 24;
    const frameCount = Number(p.source_frames) || Math.max(1, Math.round(seconds * fps));
    const ext = file ? path.extname(file).slice(1).toLowerCase() : 'mp4';
    const container = CONTAINERS.has(ext) ? ext : 'mp4';
    const frame = outputFrame(width && height ? { width, height } : null, p.target_resolution, model);

    const filter = { model };
    for (const [k, range] of Object.entries(spec.params)) {
        if (p[k] === undefined || p[k] === null || p[k] === '') continue;
        if (range === 'text') { filter[k] = String(p[k]).slice(0, 1000); continue; }
        const v = Number(p[k]);
        if (Number.isFinite(v)) filter[k] = Math.min(range[1], Math.max(range[0], v));
    }
    const body = {
        source: {
            container, size, duration: seconds, frameCount, frameRate: fps,
            resolution: { width, height },
        },
        output: {
            resolution: { width: frame.width, height: frame.height },
            frameRate: fps,
            // The clip's own sound comes through untouched: a finishing pass
            // that dropped the dialogue would be a broken deliverable.
            audioTransfer: 'Copy', audioCodec: 'AAC',
            videoEncoder: 'H264', dynamicCompressionLevel: 'High', container: 'mp4',
        },
        filters: [filter],
    };
    const credits = creditsFor(model, frameCount, frame);
    const missing = [];
    if (!size) missing.push('the file size');
    if (!width || !height) missing.push('the frame size');
    if (!seconds) missing.push('the length');
    return {
        url: `${BASE_URL}/video/`, body, model, label: spec.label,
        reaches: `${frame.width}x${frame.height}`,
        note: frame.note || null,
        estimated_credits: missing.length ? null : credits,
        estimated_usd: missing.length ? null : Math.round(credits * usdPerCredit() * 100) / 100,
        estimate_unknown_why: missing.length ? `The clip could not be measured (${missing.join(', ')}), so Topaz's estimate is not known until it is.` : null,
        free_estimate: 'Topaz answers the create call with its own credit estimate before anything is reserved.',
    };
}

function usdPerCredit() {
    try {
        const r = require('../provider-pricing').rateFor('topaz', 'post', null);
        return (r && r.usd_per_native) || 0.12;
    } catch (_) { return 0.12; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const headers = (key, json) => ({ 'X-API-Key': key, accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) });

async function readJson(res) { try { return await res.json(); } catch (_) { return null; } }
function errorOf(status, body) {
    const d = body && (body.message || body.error || body.detail || body.errors);
    return `topaz ${status}: ${typeof d === 'string' ? d : (d ? JSON.stringify(d).slice(0, 300) : 'request refused')}`;
}

/** PUT the file to Topaz's signed URL(s), in 500 MB segments, collecting each part's ETag. */
async function uploadParts(file, urls) {
    const buf = fs.readFileSync(file);
    const n = urls.length;
    const seg = n <= 1 ? buf.length : Math.max(SEGMENT_BYTES, Math.ceil(buf.length / n));
    const results = [];
    for (let i = 0; i < n; i++) {
        const part = n <= 1 ? buf : buf.subarray(i * seg, Math.min(buf.length, (i + 1) * seg));
        let res;
        try { res = await fetch(urls[i], { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: part }); }
        catch (err) { return { ok: false, status: 502, error: `topaz: uploading the clip failed — ${err.message}` }; }
        if (!res.ok) return { ok: false, status: res.status, error: `topaz: the upload URL refused part ${i + 1} (HTTP ${res.status})` };
        results.push({ partNum: i + 1, eTag: String(res.headers.get('etag') || 'unused').replace(/"/g, '') });
    }
    return { ok: true, results };
}

/** Poll a request to its end and fetch the finished file (the URL lives 7 days; the bytes are fetched now). */
async function awaitResult(requestId, key, deadline, opts) {
    const { emit } = require('../generation-progress');
    while (Date.now() < deadline) {
        let res, data;
        try {
            res = await fetch(`${BASE_URL}/video/${encodeURIComponent(requestId)}/status`, { headers: headers(key) });
            data = await readJson(res);
        } catch (err) { return { ok: false, status: 502, error: `topaz: polling failed — ${err.message}` }; }
        if (res && !res.ok) return { ok: false, status: res.status, error: errorOf(res.status, data) };
        const status = String((data && data.status) || '');
        if (status === 'complete') {
            const url = data.download && data.download.url;
            if (!url) return { ok: false, status: 502, error: 'topaz: finished with no download URL' };
            let file;
            try { file = await fetch(url); } catch (err) { return { ok: false, status: 502, error: `topaz: downloading the result failed — ${err.message}` }; }
            if (!file.ok) return { ok: false, status: 502, error: `topaz: the download URL returned ${file.status}` };
            return { ok: true, data: Buffer.from(await file.arrayBuffer()) };
        }
        if (status === 'failed' || status === 'canceled' || status === 'canceling') {
            return { ok: false, status: status === 'failed' ? 422 : 409,
                error: `topaz: ${status}${data.errorCode ? ` (${data.errorCode})` : ''}${data.message ? ' — ' + data.message : ''}` };
        }
        const pct = Number(data && data.progress);
        emit(opts, { percent: Number.isFinite(pct) ? pct : undefined, phase: status || 'processing' });
        await sleep(pollIntervalMs());
    }
    return { ok: false, status: 504, error: 'topaz: timed out waiting for the clip' };
}

async function generate(capability, payload, opts) {
    if (capability !== 'post') return { ok: false, status: 400, error: `topaz: ${capability} is not served here` };
    const { apiKey } = getCredential('topaz');
    if (!apiKey) return { ok: false, status: 401, error: 'topaz: no API key configured' };
    const p = payload || {};
    if (!p.source_video || !fs.existsSync(p.source_video)) {
        return { ok: false, status: 400, error: 'topaz: there is no clip on disk to upscale' };
    }
    // Measured here when the caller did not: Topaz fails a request whose
    // description disagrees with the file, so it must be the file's own facts.
    if (!p.source_width || !p.source_seconds || !p.source_fps) {
        const m = require('../ffmpeg').inspectMedia(p.source_video);
        if (m.ok) {
            p.source_width = p.source_width || m.width; p.source_height = p.source_height || m.height;
            p.source_seconds = p.source_seconds || Number(m.durationSeconds) || 0;
            p.source_fps = p.source_fps || m.fps || 24;
        }
    }
    const req = buildVideoRequest(p);
    const { emit } = require('../generation-progress');

    // 1. Create — free; Topaz answers with its own estimate.
    let res, data;
    try {
        res = await fetch(req.url, { method: 'POST', headers: headers(apiKey, true), body: JSON.stringify(req.body) });
        data = await readJson(res);
    } catch (err) { return { ok: false, status: 502, error: `topaz: ${err.message}` }; }
    if (!res.ok || !data || !data.requestId) return { ok: false, status: res.status || 502, error: errorOf(res.status, data) };
    const requestId = data.requestId;
    const estimate = data.estimates && Array.isArray(data.estimates.cost) ? data.estimates.cost : null;

    // 2. Accept — reserves the credits and hands back the upload URL(s).
    try {
        res = await fetch(`${BASE_URL}/video/${encodeURIComponent(requestId)}/accept`, { method: 'PATCH', headers: headers(apiKey) });
        data = await readJson(res);
    } catch (err) { return { ok: false, status: 502, error: `topaz: ${err.message}` }; }
    if (!res.ok || !data || !Array.isArray(data.urls) || !data.urls.length) {
        return { ok: false, status: res.status || 502, error: errorOf(res.status, data) };
    }

    // 3. Upload, then 4. complete — processing starts here.
    emit(opts, { phase: 'uploading' });
    const up = await uploadParts(p.source_video, data.urls);
    if (!up.ok) return up;
    try {
        res = await fetch(`${BASE_URL}/video/${encodeURIComponent(requestId)}/complete-upload/`, {
            method: 'PATCH', headers: headers(apiKey, true),
            body: JSON.stringify({ uploadResults: up.results }),
        });
        if (!res.ok) return { ok: false, status: res.status, error: errorOf(res.status, await readJson(res)) };
    } catch (err) { return { ok: false, status: 502, error: `topaz: ${err.message}` }; }

    // The job is Topaz's now and billed: its id is written down before polling,
    // so an abandoned wait can still be collected.
    if (opts && typeof opts.onHandle === 'function') {
        try { opts.onHandle(requestId, { capability, model: req.model, estimated_credits: estimate }); } catch (_) { /* never blocks a paid call */ }
    }
    const timeout = require('../generation-jobs').budgetFor((opts && opts.timeout) || POLL_TIMEOUT_MS);
    emit(opts, { phase: 'queued' });
    const out = await awaitResult(requestId, apiKey, Date.now() + timeout, opts);
    if (!out.ok && out.status === 504 && opts && opts.onTimeout) return opts.onTimeout(requestId, timeout);
    if (!out.ok) return out;
    return { ok: true, data: out.data, provider: 'topaz', provider_model: req.model, provider_job_id: requestId,
        estimated_credits: estimate };
}

/** Finish a job from its handle — the same poll the live path uses. */
async function collect(handle, opts) {
    const { apiKey } = getCredential('topaz');
    if (!apiKey) return { ok: false, status: 401, error: 'topaz: no API key configured' };
    const budget = require('../generation-jobs').budgetFor((opts && opts.timeout) || POLL_TIMEOUT_MS);
    return awaitResult(String(handle), apiKey, Date.now() + budget, opts);
}

/**
 * What the call consumed, as seconds of SOURCE at the model's 1080p rate,
 * scaled to what the output frame and frame rate really cost.
 *
 * Topaz bills credits per frame of output, at a rate that depends on the model
 * and the output size. The rate book prices a credit; this turns the clip into
 * the equivalent 1080p/30fps seconds so one per-second row per model can price
 * every size honestly.
 */
function meterTopaz(capability, payload, result) {
    if (capability !== 'post') return null;
    const p = payload || {};
    const model = (result && result.provider_model) || (MODELS[p.model] ? p.model : DEFAULT_MODEL);
    // The measured source first; a post payload may carry its length as
    // duration_ms or duration_s instead, and a length is a length.
    const seconds = Number(p.source_seconds) || (Number(p.duration_ms) / 1000) || Number(p.duration_s) || 0;
    if (!seconds) return null;
    const fps = Number(p.source_fps) || 24;
    const frame = outputFrame(p.source_width && p.source_height ? { width: p.source_width, height: p.source_height } : null,
        p.target_resolution, model);
    const credits = creditsFor(model, seconds * fps, frame);
    const perSecond1080 = 30 / MODELS[model].framesPerCredit['1080p'];
    return { unit: 'second', quantity: Math.max(0.01, credits / perSecond1080), model,
        estimate_basis: `${credits} credits at ${frame.width}x${frame.height}` };
}

const topazAdapter = {
    id: 'topaz',
    kind: 'generator',
    label: 'Topaz Labs (Starlight, Astra)',
    requiresKey: true,
    capabilities: ['post'],
    supports: capability => capability === 'post',
    models: Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, { label: m.label, note: m.why }])),
    defaultModel: DEFAULT_MODEL,
    MODELS,
    meter: meterTopaz,
    asyncGeneration: true,
    /** Topaz's status carries a real percentage while a clip processes. */
    reportsProgress: 'percent',
    /** Topaz documents DELETE /video/{id}: work not yet processed is refunded. */
    cancel: 'provider',
    async cancelJob(requestId) {
        const { apiKey } = getCredential('topaz');
        if (!apiKey) return { ok: false, status: 401, error: 'topaz: no API key configured' };
        try {
            const res = await fetch(`${BASE_URL}/video/${encodeURIComponent(requestId)}`, { method: 'DELETE', headers: headers(apiKey) });
            if (res.ok) return { ok: true };
            return { ok: false, status: res.status, error: errorOf(res.status, await readJson(res)) };
        } catch (err) { return { ok: false, status: 502, error: `topaz: could not cancel — ${err.message}` }; }
    },
    buildVideoRequest,
    outputFrame,
    generate,
    collect,
    connection: {
        instructions: 'Create a key in your Topaz Labs account under API Keys. Credits are prepaid: $0.12 each on Starter, $0.10 on Developer, $0.08 on Scale.',
        helpUrl: 'https://account.topazlabs.com/manage-api',
    },
};

module.exports = { adapter: topazAdapter, topazAdapter, MODELS, DEFAULT_MODEL, buildVideoRequest, outputFrame, creditsFor, generate, collect };
