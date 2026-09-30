/**
 * Magnific (formerly the Freepik API) — video upscaling.
 *
 *   https://api.magnific.com/v1/ai/...        header: x-magnific-api-key
 *
 * Four video upscalers, each its own endpoint (docs.magnific.com, read
 * 2026-09-30; tests/fixtures/magnific-contract.json):
 *
 *   video-upscaler            creative: creativity 0-100, flavor vivid|natural
 *   video-upscaler/turbo      the same controls, faster, premium quality built in
 *   video-upscaler-precision  faithful: strength 0-100 blends original and upscale
 *   video-upscaler-topaz      Topaz Starlight (precise 2.5 / fast 2) through
 *                             Magnific, with optional frame interpolation
 *
 * All take `video` as a public URL or a Magnific upload, and an output tier of
 * 720p / 1k / 2k / 4k. The clip goes up through Magnific's OWN upload step
 * (POST /v1/ai/uploads/request-url, then PUT), so nothing else has to host it.
 *
 * Asynchronous: a create answers with a task id, polled on the same path until
 * COMPLETED, whose `generated` holds the URL. Magnific documents no cancel, so
 * stopping leaves the task running and collectable.
 */

const fs = require('fs');
const path = require('path');
const { getCredential } = require('./credentials');

const BASE_URL = (process.env.MAGNIFIC_BASE_URL || 'https://api.magnific.com').replace(/\/+$/, '');
const pollIntervalMs = () => Number(process.env.MAGNIFIC_POLL_INTERVAL_MS || 4000);
const POLL_TIMEOUT_MS = Number(process.env.MAGNIFIC_POLL_TIMEOUT_MS || 1800000);

/*
 * The upscalers. `params` are the fields Magnific documents for each endpoint,
 * with their ranges; nothing else is sent.
 */
const MODELS = Object.freeze({
    'magnific-video-upscaler': {
        label: 'Magnific Video Upscaler', endpoint: '/v1/ai/video-upscaler', kind: 'creative',
        params: { creativity: [0, 100], sharpen: [0, 100], smart_grain: [0, 100], fps_boost: 'bool', flavor: ['vivid', 'natural'] },
        why: 'Magnific\'s creative upscale: adds detail as it enlarges; creativity and flavor steer how much.',
    },
    'magnific-video-upscaler-turbo': {
        label: 'Magnific Video Upscaler Turbo', endpoint: '/v1/ai/video-upscaler/turbo', kind: 'creative',
        params: { creativity: [0, 100], sharpen: [0, 100], smart_grain: [0, 100], fps_boost: 'bool', flavor: ['vivid', 'natural'] },
        why: 'The creative upscale, faster, with premium quality built in.',
    },
    'magnific-video-upscaler-precision': {
        label: 'Magnific Video Upscaler Precision', endpoint: '/v1/ai/video-upscaler-precision', kind: 'precision',
        params: { strength: [0, 100], sharpen: [0, 100], smart_grain: [0, 100], fps_boost: 'bool' },
        why: 'Faithful upscale that adds nothing generated; strength blends the original with the upscale.',
    },
    'magnific-video-upscaler-topaz': {
        label: 'Topaz Starlight via Magnific', endpoint: '/v1/ai/video-upscaler-topaz', kind: 'generative',
        params: { enhancement_model: ['starlight_precise_2_5', 'starlight_fast_2'], noise: [0, 1], target_fps: [15, 60] },
        why: 'Topaz Starlight on your Magnific account (Precise 2.5 or Fast 2), for those without a Topaz key.',
    },
});
const DEFAULT_MODEL = process.env.MAGNIFIC_VIDEO_MODEL || 'magnific-video-upscaler-precision';

/* Output tiers, smallest first, by the short edge each delivers. */
const TIERS = Object.freeze([
    { id: '720p', short: 720, long: 1280 },
    { id: '1k', short: 1080, long: 1920 },
    { id: '2k', short: 1440, long: 2560 },
    { id: '4k', short: 2160, long: 3840 },
]);

/*
 * Price per output frame by tier. Magnific does not publish its per-frame API
 * rate; Runway resells the creative video upscaler at these (Runway API
 * pricing, 2026-09-29), so they are held here as the best public figure and
 * marked INFERRED in the rate book.
 */
const USD_PER_FRAME = Object.freeze({ '720p': 0.007, '1k': 0.007, '2k': 0.009, '4k': 0.012 });

function parseSize(s) {
    const m = String(s || '').match(/(\d{2,5})\s*[x×]\s*(\d{2,5})/i);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** The smallest tier whose short edge reaches the delivery's; 4K when nothing smaller does. */
function tierFor(targetRes) {
    const t = parseSize(targetRes) || { width: 1920, height: 1080 };
    const need = Math.min(t.width, t.height);
    return TIERS.find(x => x.short >= need) || TIERS[TIERS.length - 1];
}

/**
 * The request this upscale would send. Pure: the preview and the paid run read
 * the same function, so the price shown is the price asked for.
 */
function buildVideoRequest(payload) {
    const p = payload || {};
    const model = MODELS[p.model] ? p.model : DEFAULT_MODEL;
    const spec = MODELS[model];
    const tier = tierFor(p.target_resolution);
    const body = { video: p.video_url || '(the clip, uploaded to Magnific first)', resolution: tier.id };
    for (const [k, range] of Object.entries(spec.params)) {
        const v = p[k];
        if (v === undefined || v === null || v === '') continue;
        if (range === 'bool') { body[k] = v === true || v === 'true' || v === 1; continue; }
        if (Array.isArray(range) && typeof range[0] === 'string') { if (range.includes(String(v))) body[k] = String(v); continue; }
        const n = Number(v);
        if (Number.isFinite(n)) body[k] = Math.round(Math.min(range[1], Math.max(range[0], n)) * 1000) / 1000;
    }
    if (model === 'magnific-video-upscaler-topaz' && !body.enhancement_model) body.enhancement_model = 'starlight_precise_2_5';
    const seconds = Number(p.source_seconds) || 0;
    const fps = Number(p.source_fps) || 24;
    const frames = Math.round(seconds * fps);
    const target = parseSize(p.target_resolution);
    const shortOf = target && tier.short < Math.min(target.width, target.height);
    return {
        url: `${BASE_URL}${spec.endpoint}`, body, model, label: spec.label,
        reaches: `${tier.id} (${tier.short}p)`,
        note: shortOf ? `Magnific's largest tier is 4K, short of ${target.width}x${target.height}.` : null,
        estimated_usd: frames ? Math.round(frames * USD_PER_FRAME[tier.id] * 100) / 100 : null,
        estimate_unknown_why: frames ? null : 'The clip could not be measured, so the price is not known until it is.',
        inferred_price: true,
    };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const headers = key => ({ 'x-magnific-api-key': key, 'content-type': 'application/json', accept: 'application/json' });
async function readJson(res) { try { return await res.json(); } catch (_) { return null; } }
function errorOf(status, body) {
    const d = body && (body.message || body.error || body.detail || (body.data && body.data.message));
    return `magnific ${status}: ${typeof d === 'string' ? d : (d ? JSON.stringify(d).slice(0, 300) : 'request refused')}`;
}
/** Magnific wraps a task in `data`; read either shape. */
const taskOf = body => (body && body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data : (body || {});

const CONTENT_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

/** Put the clip on Magnific through its own upload step; returns the URL to hand the upscaler. */
async function uploadClip(file, key) {
    const contentType = CONTENT_TYPES[path.extname(file).toLowerCase()] || 'video/mp4';
    let res, data;
    try {
        res = await fetch(`${BASE_URL}/v1/ai/uploads/request-url`, {
            method: 'POST', headers: headers(key), body: JSON.stringify({ files: [{ content_type: contentType }] }),
        });
        data = await readJson(res);
    } catch (err) { return { ok: false, status: 502, error: `magnific: requesting an upload URL failed — ${err.message}` }; }
    const f = data && Array.isArray(data.files) && data.files[0];
    if (!res.ok || !f || !f.upload_url) return { ok: false, status: res.status || 502, error: errorOf(res.status, data) };
    try {
        // The signed PUT goes straight to storage: the returned headers are part
        // of the signature, and the API key is NOT sent there.
        const put = await fetch(f.upload_url, { method: 'PUT', headers: { ...(f.headers || { 'Content-Type': contentType }) }, body: fs.readFileSync(file) });
        if (!put.ok) return { ok: false, status: put.status, error: `magnific: the upload URL refused the clip (HTTP ${put.status})` };
    } catch (err) { return { ok: false, status: 502, error: `magnific: uploading the clip failed — ${err.message}` }; }
    return { ok: true, url: f.asset_url || f.file_id, file_id: f.file_id || null };
}

/** Poll a task on its own endpoint until it ends, then fetch the result. */
async function awaitResult(endpoint, taskId, key, deadline, opts) {
    const { emit } = require('../generation-progress');
    while (Date.now() < deadline) {
        let res, body;
        try {
            res = await fetch(`${BASE_URL}${endpoint}/${encodeURIComponent(taskId)}`, { headers: headers(key) });
            body = await readJson(res);
        } catch (err) { return { ok: false, status: 502, error: `magnific: polling failed — ${err.message}` }; }
        if (res && !res.ok) return { ok: false, status: res.status, error: errorOf(res.status, body) };
        const t = taskOf(body);
        const status = String(t.status || '').toUpperCase();
        if (status === 'COMPLETED') {
            const out = Array.isArray(t.generated) ? t.generated[0] : (t.generated || t.video || t.url);
            const url = typeof out === 'string' ? out : (out && (out.url || out.video));
            if (!url) return { ok: false, status: 502, error: 'magnific: finished with no video URL' };
            let file;
            try { file = await fetch(url); } catch (err) { return { ok: false, status: 502, error: `magnific: downloading the result failed — ${err.message}` }; }
            if (!file.ok) return { ok: false, status: 502, error: `magnific: the result URL returned ${file.status}` };
            return { ok: true, data: Buffer.from(await file.arrayBuffer()) };
        }
        if (status === 'FAILED') return { ok: false, status: 422, error: `magnific: failed${t.error ? ' — ' + (t.error.message || t.error) : ''}` };
        emit(opts, { phase: status === 'CREATED' ? 'queued' : 'upscaling' });
        await sleep(pollIntervalMs());
    }
    return { ok: false, status: 504, error: 'magnific: timed out waiting for the clip' };
}

async function generate(capability, payload, opts) {
    if (capability !== 'post') return { ok: false, status: 400, error: `magnific: ${capability} is not served here` };
    const { apiKey } = getCredential('magnific');
    if (!apiKey) return { ok: false, status: 401, error: 'magnific: no API key configured' };
    const p = { ...(payload || {}) };
    if (!p.video_url) {
        if (!p.source_video || !fs.existsSync(p.source_video)) return { ok: false, status: 400, error: 'magnific: there is no clip on disk to upscale' };
        const { emit } = require('../generation-progress');
        emit(opts, { phase: 'uploading' });
        const up = await uploadClip(p.source_video, apiKey);
        if (!up.ok) return up;
        p.video_url = up.url;
    }
    const req = buildVideoRequest(p);
    let res, body;
    try {
        res = await fetch(req.url, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(req.body) });
        body = await readJson(res);
    } catch (err) { return { ok: false, status: 502, error: `magnific: ${err.message}` }; }
    const task = taskOf(body);
    if (!res.ok || !task.task_id) return { ok: false, status: res.status || 502, error: errorOf(res.status, body) };
    const endpoint = MODELS[req.model].endpoint.replace(/\/turbo$/, '');   // turbo tasks are read on the standard path
    // Written down before polling, with the endpoint it is read on.
    const handle = `${endpoint}|${task.task_id}`;
    if (opts && typeof opts.onHandle === 'function') {
        try { opts.onHandle(handle, { capability, model: req.model }); } catch (_) { /* never blocks a paid call */ }
    }
    const timeout = require('../generation-jobs').budgetFor((opts && opts.timeout) || POLL_TIMEOUT_MS);
    const out = await awaitResult(endpoint, task.task_id, apiKey, Date.now() + timeout, opts);
    if (!out.ok && out.status === 504 && opts && opts.onTimeout) return opts.onTimeout(handle, timeout);
    if (!out.ok) return out;
    return { ok: true, data: out.data, provider: 'magnific', provider_model: req.model, provider_job_id: task.task_id };
}

/** Finish a task from its handle (`<endpoint>|<task id>`), with the same poll. */
async function collect(handle, opts) {
    const { apiKey } = getCredential('magnific');
    if (!apiKey) return { ok: false, status: 401, error: 'magnific: no API key configured' };
    const [endpoint, taskId] = String(handle).includes('|') ? String(handle).split('|') : [MODELS[DEFAULT_MODEL].endpoint, String(handle)];
    const budget = require('../generation-jobs').budgetFor((opts && opts.timeout) || POLL_TIMEOUT_MS);
    return awaitResult(endpoint, taskId, apiKey, Date.now() + budget, opts);
}

/**
 * What the call consumed: seconds of source as 30fps-equivalent seconds, so a
 * per-frame price prices every clip. The tier rides on the model id
 * (`…@4k`) because the rate depends on it.
 */
function meterMagnific(capability, payload, result) {
    if (capability !== 'post') return null;
    const p = payload || {};
    const model = (result && result.provider_model) || (MODELS[p.model] ? p.model : DEFAULT_MODEL);
    const seconds = Number(p.source_seconds) || (Number(p.duration_ms) / 1000) || Number(p.duration_s) || 0;
    if (!seconds) return null;
    const fps = Number(p.source_fps) || 30;
    return { unit: 'second', quantity: Math.max(0.01, seconds * fps / 30), model: `${model}@${tierFor(p.target_resolution).id}` };
}

const magnificAdapter = {
    id: 'magnific',
    kind: 'generator',
    label: 'Magnific (video upscaling)',
    requiresKey: true,
    capabilities: ['post'],
    supports: capability => capability === 'post',
    models: Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, { label: m.label, note: m.why }])),
    defaultModel: DEFAULT_MODEL,
    MODELS, TIERS, USD_PER_FRAME,
    meter: meterMagnific,
    asyncGeneration: true,
    /** A task reports CREATED / IN_PROGRESS / COMPLETED and no percentage. */
    reportsProgress: 'phase',
    /** Magnific documents no cancel: stopping leaves the task running and collectable. */
    cancel: 'stop_waiting',
    buildVideoRequest,
    tierFor,
    generate,
    collect,
    connection: {
        instructions: 'Create an API key in your Magnific account (the API was formerly the Freepik API). API calls always spend credits, even on plans with unlimited web-app use.',
        helpUrl: 'https://www.magnific.com/api',
    },
};

module.exports = { adapter: magnificAdapter, magnificAdapter, MODELS, TIERS, USD_PER_FRAME, DEFAULT_MODEL, buildVideoRequest, tierFor, generate, collect };
