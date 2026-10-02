/**
 * Higgsfield: one account, many image and video models.
 *
 *   POST https://api.higgsfield.ai/<endpoint id>       Authorization: Key <id>:<secret>
 *   GET  <status_url> until completed | failed | nsfw | canceled
 *
 * What each model takes is NOT typed here. Higgsfield's docs say the model
 * page is the authority ("use the exact schema documented on the selected
 * model page"), and every page carries its endpoint ID and request JSON
 * Schema, so `higgsfield-models.json` is a dated snapshot of all of them
 * (tests/refresh-higgsfield-contract.js). The request builder sends a field
 * only when that endpoint's schema has it, checks it against the schema's
 * enum or range, and drops it with a reason otherwise.
 *
 * A MODEL here is a family at a tier ("kling-3-pro", "seedance-2-5"), and the
 * WORKFLOW is chosen from what the payload carries, on the rule the MuAPI
 * adapter already states: a payload with a keyframe IS an image-to-video
 * request, one with only references IS reference-to-video, one with nothing
 * IS text-to-video. Letting a caller pick the endpoint would send pictures to
 * one that reads none.
 *
 * Inputs are URLs. A local picture (a data URI, or a file) goes up first
 * through Higgsfield's own presigned upload (POST /files/generate-upload-url,
 * then PUT with the returned headers and NOT the API credentials).
 *
 * Asynchronous: the submission answers with a request id, written down before
 * polling so an abandoned tool call can still collect it. A request can be
 * cancelled only while queued; once it has started it cannot, so this adapter
 * declares "stop waiting" rather than a cancel it can rarely perform.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getCredential } = require('./credentials');
const CONTRACT = require('./higgsfield-models.json');

const BASE_URL = (process.env.HIGGSFIELD_BASE_URL || 'https://api.higgsfield.ai').replace(/\/+$/, '');
const POLL_TIMEOUT_MS = Number(process.env.HIGGSFIELD_POLL_TIMEOUT_MS || 1800000);
const POLL_START_MS = () => Number(process.env.HIGGSFIELD_POLL_INTERVAL_MS || 2000);
const TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled']);

/* ── the model table, derived from the snapshot ─────────────────────────── */

/** What a workflow does, read from its documented name. */
function kindOf(workflow) {
    if (/first-last-frame/.test(workflow)) return 'first-last';
    if (/image-to-video/.test(workflow)) return 'image';
    if (/text-to-video/.test(workflow)) return 'text';
    if (/reference-to-video|image-reference/.test(workflow)) return 'reference';
    if (/text-to-image|^generate$|generate-and-edit|^flare$|^sunburst$/.test(workflow)) return 'text';
    if (/^edit$/.test(workflow)) return 'reference';
    return null;    // video edit, extend, motion transfer, restyle: they start from a clip
}

/** The tier a workflow name carries once its kind is taken out: "pro-image-to-video" -> "pro". */
function tierOf(workflow) {
    return workflow.replace(/(image|text|reference)-to-(video|image)|first-last-frame|image-reference|generate-and-edit|generate|^edit$/g, '')
        .replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Models by capability: `{ id: { label, endpoints: { text, image, first-last, reference } } }`.
 * Workflows that start from an existing clip are not models of `video`: they
 * need a source this capability does not hand them, and are listed apart.
 */
function buildModels() {
    const out = { video: {}, image: {} };
    const sourceWorkflows = [];
    for (const [endpoint, m] of Object.entries(CONTRACT.models)) {
        const capability = m.output === 'video' ? 'video' : m.output === 'image' ? 'image' : null;
        if (!capability) continue;
        const kind = kindOf(m.workflow);
        const required = (m.schema.required || []);
        if (!kind || required.some(f => /^video_url|^video_urls$|^preset_id$/.test(f))) {
            sourceWorkflows.push({ endpoint, family: m.family, workflow: m.workflow, title: m.title });
            continue;
        }
        const tier = tierOf(m.workflow);
        const id = tier ? `${m.family}-${tier}` : m.family;
        const label = String(m.title || id).replace(/\s+API$/, '').replace(/\s+—\s+.*$/, '') + (tier ? ` (${tier})` : '');
        const entry = out[capability][id] || (out[capability][id] = { label, family: m.family, tier: tier || null, endpoints: {} });
        // Cinema Studio's one endpoint takes a prompt and optional pictures: it is every kind.
        if (m.workflow === 'generate' && capability === 'video') {
            for (const k of ['text', 'image', 'reference']) entry.endpoints[k] = endpoint;
        } else if (!entry.endpoints[kind]) entry.endpoints[kind] = endpoint;
    }
    return { models: out, sourceWorkflows };
}
const { models: MODELS, sourceWorkflows: SOURCE_WORKFLOWS } = buildModels();
const DEFAULT_VIDEO_MODEL = process.env.HIGGSFIELD_VIDEO_MODEL || 'seedance-2-5';
const DEFAULT_IMAGE_MODEL = process.env.HIGGSFIELD_IMAGE_MODEL || 'soul-2';

/* ── credentials ────────────────────────────────────────────────────────── */

/**
 * Higgsfield issues a key ID and a secret, and the header carries both as
 * `id:secret`. Stored as one string in that shape; the SDK's HF_CREDENTIALS
 * and the docs' HF_API_KEY_ID / HF_API_KEY_SECRET are read too.
 */
function credential() {
    const env = process.env.HF_CREDENTIALS
        || (process.env.HF_API_KEY_ID && process.env.HF_API_KEY_SECRET
            ? `${process.env.HF_API_KEY_ID}:${process.env.HF_API_KEY_SECRET}` : '');
    const stored = getCredential('higgsfield');
    const meta = stored.meta || {};
    // Setup stores the two halves as fields; one "id:secret" line (env or the key box) works too.
    const fromFields = meta.key_id && meta.key_secret ? `${String(meta.key_id).trim()}:${String(meta.key_secret).trim()}` : '';
    const key = String(env || stored.apiKey || fromFields || '').trim();
    if (!key) return { ok: false, status: 401, error: 'higgsfield: no API key configured — enter the key ID and secret from console.higgsfield.ai in Setup → API keys' };
    if (!/^[^:\s]+:[^:\s]+$/.test(key)) {
        return { ok: false, status: 401, error: 'higgsfield: the key must be the key ID and the secret joined by a colon ("KEY_ID:KEY_SECRET"), as the console shows them' };
    }
    return { ok: true, header: `Key ${key}` };
}

/* ── the request ────────────────────────────────────────────────────────── */

const first = (...vs) => vs.find(v => v !== undefined && v !== null && v !== '');
const uriOf = v => (typeof v === 'string' ? v : (v && (v.uri || v.url || v.image_url || v.src || v.image))) || null;

/** Keyframes in order, then references, as the payload carries them. */
function picturesOf(p) {
    const keys = [];
    if (p.init_image) keys.push(uriOf(p.init_image));
    for (const k of (p.keyframes || [])) keys.push(uriOf(k));
    if (p.last_frame) keys.push(uriOf(p.last_frame));
    const refs = (p.reference_images || []).map(uriOf);
    return { keys: keys.filter(Boolean), refs: refs.filter(Boolean) };
}

function nearestAspect(allowed, p) {
    const declared = String(p.aspect_ratio || '').trim();
    if (allowed.includes(declared)) return declared;
    const m = /^(\d+)\s*[x:]\s*(\d+)$/.exec(String(p.target_resolution || '')) || (p.width && p.height ? [0, p.width, p.height] : null);
    const want = m ? Number(m[1]) / Number(m[2]) : 16 / 9;
    let best = null, bestErr = Infinity;
    for (const a of allowed) {
        const r = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(a);
        if (!r) continue;
        const err = Math.abs(Number(r[1]) / Number(r[2]) - want);
        if (err < bestErr) { best = a; bestErr = err; }
    }
    return best;
}

/** The resolution tier, from the delivery's short edge: the largest at or below it, else the smallest. */
function pickResolution(allowed, p) {
    const asked = String(p.resolution || '');
    if (allowed.includes(asked)) return { value: asked };
    const m = /^(\d+)\s*[x:]\s*(\d+)$/.exec(String(p.target_resolution || ''));
    const short = m ? Math.min(Number(m[1]), Number(m[2])) : (Math.min(Number(p.width) || 0, Number(p.height) || 0) || 1080);
    const sizeOf = v => {
        const s = String(v).toLowerCase();
        if (/^\d+p$/.test(s)) return Number(s.slice(0, -1));
        if (/^(\d+)k$/.test(s)) return { 1: 1080, 2: 1440, 4: 2160 }[Number(s.slice(0, -1))] || Number(s.slice(0, -1)) * 540;
        return null;
    };
    const known = allowed.map(v => ({ v, n: sizeOf(v) })).filter(x => x.n);
    if (!known.length) return { value: null };
    known.sort((a, b) => a.n - b.n);
    const fit = known.filter(x => x.n <= short).pop();
    if (fit) return { value: fit.v };
    return { value: known[0].v };
}

function checkValue(spec, v) {
    if (!spec) return { ok: false, why: 'not a field of this endpoint' };
    if (Array.isArray(spec.enum)) return spec.enum.includes(v) ? { ok: true, v } : { ok: false, why: `must be one of ${spec.enum.join(', ')}` };
    if (spec.type === 'boolean') return { ok: true, v: v === true || v === 'true' || v === 1 };
    if (spec.type === 'integer' || spec.type === 'number') {
        let n = Number(v);
        if (!Number.isFinite(n)) return { ok: false, why: 'not a number' };
        if (spec.type === 'integer') n = Math.round(n);
        if (spec.minimum !== undefined && n < spec.minimum) n = spec.minimum;
        if (spec.maximum !== undefined && n > spec.maximum) n = spec.maximum;
        return { ok: true, v: n };
    }
    if (spec.type === 'string') return { ok: true, v: String(v) };
    return { ok: true, v };
}

/** Fields the engine fills itself; anything else on the payload with a schema name is a chosen option. */
const OWN = new Set(['prompt', 'duration', 'image_url', 'image_urls', 'end_image_url', 'last_image_url',
    'first_frame_url', 'last_frame_url', 'audio_urls', 'audio_url', 'resolution', 'aspect_ratio',
    'seed', 'negative_prompt', 'generate_audio', 'sound']);

/**
 * The request a generation would send, built from the endpoint's own schema.
 * Pure: the preview and the paid call read the same function.
 */
function buildRequest(capability, payload) {
    const p = payload || {};
    const table = MODELS[capability] || {};
    const fallback = capability === 'video' ? DEFAULT_VIDEO_MODEL : DEFAULT_IMAGE_MODEL;
    const modelId = table[p.model] ? p.model : (table[fallback] ? fallback : Object.keys(table)[0]);
    const model = table[modelId];
    if (!model) throw Object.assign(new Error(`higgsfield: no ${capability} model in the snapshot`), { status: 400 });
    const { keys, refs } = picturesOf(p);
    const dropped = [];

    // The workflow is what is attached.
    let kind;
    if (capability === 'image') kind = refs.length && model.endpoints.reference ? 'reference' : 'text';
    else if (keys.length >= 2 && model.endpoints['first-last']) kind = 'first-last';
    else if (keys.length && model.endpoints.image) kind = 'image';
    else if (keys.length && model.endpoints['first-last']) kind = 'first-last';
    else if ((keys.length || refs.length) && model.endpoints.reference) kind = 'reference';
    else if (model.endpoints.text) kind = 'text';
    else if (model.endpoints.reference) kind = 'reference';   // a prompt alone still reaches Kling Omni's reference endpoint
    else kind = Object.keys(model.endpoints)[0];
    if (!model.endpoints[kind]) kind = Object.keys(model.endpoints)[0];
    const endpoint = model.endpoints[kind];
    const schema = CONTRACT.models[endpoint].schema;
    const props = schema.properties || {};
    const body = {};
    const set = (field, value) => {
        if (value === undefined || value === null || value === '') return false;
        if (!props[field]) return false;
        const c = checkValue(props[field], value);
        if (!c.ok) { dropped.push({ field, why: c.why }); return false; }
        body[field] = c.v;
        return true;
    };

    const prompt = String(capability === 'video' ? first(p.motion_prompt, p.prompt, '') : first(p.prompt, '')).trim();
    if (prompt) {
        const max = props.prompt && props.prompt.maxLength;
        set('prompt', max && prompt.length > max ? prompt.slice(0, max) : prompt);
    }

    if (capability === 'video') {
        const d = Number(first(p.duration_s, p.duration, p.duration_ms ? p.duration_ms / 1000 : undefined, 5));
        const spec = props.duration;
        if (spec) {
            if (Array.isArray(spec.enum)) {
                const nums = spec.enum.map(Number);
                const near = nums.reduce((a, b) => (Math.abs(b - d) < Math.abs(a - d) ? b : a), nums[0]);
                body.duration = spec.enum[nums.indexOf(near)];
            } else set('duration', d);
        }
        // Pictures by the field this endpoint names them with.
        const firstKey = keys[0], lastKey = keys.length > 1 ? keys[keys.length - 1] : null;
        if (kind === 'first-last' || kind === 'image') {
            set('image_url', firstKey) || set('first_frame_url', firstKey);
            if (lastKey) set('end_image_url', lastKey) || set('last_image_url', lastKey) || set('last_frame_url', lastKey);
        }
        const pool = kind === 'reference' ? [...keys, ...refs] : refs;
        if (pool.length && props.image_urls) {
            const cap = props.image_urls.maxItems || pool.length;
            body.image_urls = pool.slice(0, cap);
            if (pool.length > cap) dropped.push({ field: 'image_urls', why: `${pool.length - cap} picture(s) over this model's ${cap}` });
        } else if (pool.length && kind === 'reference' && props.image_url) set('image_url', pool[0]);
        const audio = (p.audio_references || []).map(uriOf).filter(Boolean);
        if (audio.length) {
            if (props.audio_urls) body.audio_urls = audio.slice(0, props.audio_urls.maxItems || audio.length);
            else if (props.audio_url) set('audio_url', audio[0]);
            else dropped.push({ field: 'audio', why: 'this model takes no audio' });
        }
        /*
         * SILENT BY DEFAULT, as on MuAPI: Film Engine owns the sound, and a
         * provider bed under the picture is a second, unasked-for score.
         */
        const wantsAudio = first(p.generate_audio, p.audio, false);
        if (props.generate_audio) body.generate_audio = !!wantsAudio;
        if (props.sound) {
            const c = checkValue(props.sound, wantsAudio ? 'on' : 'off');
            if (c.ok) body.sound = c.v; else if (props.sound.type === 'boolean') body.sound = !!wantsAudio;
        }
    } else {
        if (refs.length) {
            if (props.image_urls) body.image_urls = refs.slice(0, props.image_urls.maxItems || refs.length);
            else if (props.image_reference_url) set('image_reference_url', refs[0]);
            else if (props.image_url) set('image_url', refs[0]);
            else dropped.push({ field: 'reference_images', why: 'this model takes no picture' });
        }
        if (props.batch_size) set('batch_size', 1);
    }

    if (props.aspect_ratio && Array.isArray(props.aspect_ratio.enum)) {
        const a = nearestAspect(props.aspect_ratio.enum, p);
        if (a) body.aspect_ratio = a;
    }
    if (props.resolution && Array.isArray(props.resolution.enum)) {
        const r = pickResolution(props.resolution.enum, p);
        if (r.value) body.resolution = r.value;
    }
    if (Number.isFinite(Number(p.seed)) && Number(p.seed) >= 0) set('seed', Number(p.seed));
    // Sent where the model's schema has the field; never folded into the prompt as "Avoid: …", which names each thing to the model.
    if (p.negative_prompt) {
        if (props.negative_prompt) set('negative_prompt', String(p.negative_prompt));
        else dropped.push({ field: 'negative_prompt', why: `${modelId} has no negative field` });
    }

    // Options chosen on the dialog: any other field of THIS endpoint's schema.
    const chosen = Object.assign({}, p.higgsfield_options || {});
    for (const [k, v] of Object.entries(p)) if (props[k] && !OWN.has(k) && !(k in chosen)) chosen[k] = v;
    for (const [k, v] of Object.entries(chosen)) {
        if (!props[k]) { dropped.push({ field: k, why: 'not a field of ' + endpoint }); continue; }
        set(k, v);
    }

    const missing = (schema.required || []).filter(f => body[f] === undefined);
    return { url: `${BASE_URL}/${endpoint}`, endpoint, model: modelId, workflow: kind, body, dropped, missing,
        notes: CONTRACT.models[endpoint].notes || [] };
}

/** The request with no pictures inlined, for a preview a person reads. */
function describeRequest(capability, payload) {
    const req = buildRequest(capability, payload);
    const short = v => (typeof v === 'string' && v.startsWith('data:') ? `(a ${Math.round(v.length * 0.75 / 1024)} KB picture, uploaded to Higgsfield first)` : v);
    const body = {};
    for (const [k, v] of Object.entries(req.body)) body[k] = Array.isArray(v) ? v.map(short) : short(v);
    return { ...req, body };
}

/**
 * The frame a clip will really come back at, asked for a size: the model's
 * largest resolution tier at or below the delivery's short edge, in the
 * delivery's shape; its smallest when every tier is above the ask. A model
 * whose schema documents no resolution is taken at 1080p and says so.
 */
function sizeOfTier(v) {
    const s = String(v).toLowerCase();
    if (/^\d+p$/.test(s)) return Number(s.slice(0, -1));
    if (/^(\d+)k$/.test(s)) return { 1: 1080, 2: 1440, 4: 2160 }[Number(s.slice(0, -1))] || null;
    return null;
}
function deliverableFrame(payload) {
    const p = payload || {};
    const m = /^(\d+)\s*[x:]\s*(\d+)$/.exec(String(p.target_resolution || ''));
    const w = Number(p.width) || (m ? Number(m[1]) : 1920), h = Number(p.height) || (m ? Number(m[2]) : 1080);
    const req = buildRequest('video', { ...p, prompt: p.prompt || 'x', target_resolution: `${w}x${h}` });
    const spec = CONTRACT.models[req.endpoint].schema.properties.resolution;
    const tier = req.body.resolution;
    const tierShort = (tier && sizeOfTier(tier)) || (/4k/.test(req.model) ? 2160 : 1080);
    const askShort = Math.min(w, h), ratio = Math.max(w, h) / askShort;
    const short = Math.min(tierShort, Math.max(...((spec && spec.enum) || [tierShort]).map(v => sizeOfTier(v) || tierShort)));
    const long = Math.round(short * ratio / 2) * 2;
    const frame = w >= h ? { width: long, height: short } : { width: short, height: long };
    const downgraded = Math.max(frame.width, frame.height) < Math.max(w, h);
    const offered = spec && spec.enum ? spec.enum.join(', ') : 'no resolution field (taken as 1080p)';
    return { ...frame, tier: tier || `${tierShort}p`, downgraded,
        why: downgraded ? `Higgsfield ${req.model} offers ${offered}; ${tier || tierShort + 'p'} is its largest at or below ${w}x${h}.` : null };
}

/**
 * What a clip would be sent and cost, in the shape every video preview reads:
 * the model, the length, whether the keyframe travels, and what was dropped.
 */
function describeVideoRequest(payload) {
    const p = payload || {};
    const req = describeRequest('video', p);
    const asked = Number(first(p.duration_s, p.duration, p.duration_ms ? p.duration_ms / 1000 : undefined, 5));
    const notes = [...req.notes];
    if (req.body.duration !== undefined && Number(req.body.duration) !== Math.round(asked)) {
        notes.push(`Length: ${asked}s is outside what ${req.model} takes — it will generate ${req.body.duration}s.`);
    }
    for (const d of req.dropped) notes.push(`${d.field}: ${d.why} — not sent.`);
    if (req.missing.length) notes.push(`${req.endpoint} needs ${req.missing.join(', ')}; this shot does not carry it.`);
    const pics = ['image_url', 'first_frame_url', 'image_urls'].some(f => req.body[f] !== undefined && (!Array.isArray(req.body[f]) || req.body[f].length));
    const seconds = Number(req.body.duration) || Math.max(1, Math.round(asked));
    let usd = null;
    try {
        const priced = require('../provider-pricing').priceUsage({ provider: 'higgsfield', capability: 'video', unit: 'second', quantity: seconds, model: req.model });
        usd = priced && Number.isFinite(priced.usd) ? Number(priced.usd.toFixed(2)) : null;
    } catch (_) { /* unpriced: said as unknown */ }
    return { provider: 'higgsfield', mode: req.workflow, endpoint: req.endpoint, model: req.model,
        duration_s: seconds, aspect_ratio: req.body.aspect_ratio || null, resolution: req.body.resolution || null,
        prompt: req.body.prompt || '', prompt_length: String(req.body.prompt || '').length,
        has_image: pics, audio: !!(req.body.generate_audio || req.body.sound === 'on' || req.body.sound === true),
        estimated_usd: usd, body: req.body, notes };
}

/* ── the wire ───────────────────────────────────────────────────────────── */

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function readJson(res) { try { return await res.json(); } catch (_) { return null; } }
function errorOf(status, body) {
    const d = body && (body.detail || body.error || body.message);
    const text = typeof d === 'string' ? d : (d ? JSON.stringify(d).slice(0, 400) : 'request refused');
    const why = { 401: ' (the key ID or secret is wrong)', 403: ' (not enough credits on the Higgsfield account)',
        404: ' (this model is not available to the account)', 423: ' (the model is temporarily blocked)',
        503: ' (the model is disabled or not ready)' }[status] || '';
    return `higgsfield ${status}: ${text}${why}`;
}

const CONTENT_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'audio/wav', 'audio/x-wav', 'video/mp4']);
const EXT_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.wav': 'audio/wav', '.mp4': 'video/mp4' };

/** A data URI or local file, put on Higgsfield's storage; a URL is returned as it is. */
async function hostOne(uri, auth) {
    if (/^https?:\/\//i.test(uri)) return { ok: true, url: uri };
    let mime, bytes;
    const m = /^data:([^;,]+);base64,(.+)$/i.exec(uri);
    if (m) { mime = m[1].toLowerCase(); bytes = Buffer.from(m[2], 'base64'); }
    else if (fs.existsSync(uri)) { mime = EXT_TYPES[path.extname(uri).toLowerCase()]; bytes = fs.readFileSync(uri); }
    else return { ok: false, error: 'neither a URL, a data URI nor a file' };
    if (!CONTENT_TYPES.has(mime)) return { ok: false, error: `Higgsfield uploads take jpeg, png, webp, gif, wav and mp4; got ${mime || 'an unknown type'}` };
    let res, up;
    try {
        res = await fetch(`${BASE_URL}/files/generate-upload-url`, {
            method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content_type: mime }),
        });
        up = await readJson(res);
    } catch (err) { return { ok: false, error: `requesting an upload URL failed — ${err.message}` }; }
    if (!res.ok || !up || !up.upload_url || !up.public_url) return { ok: false, error: errorOf(res.status, up) };
    try {
        // The presigned PUT carries the headers it was signed with, and never the API key.
        const put = await fetch(up.upload_url, { method: 'PUT', headers: { ...(up.upload_headers || { 'Content-Type': mime }) }, body: bytes });
        if (!put.ok) return { ok: false, error: `the upload URL refused the file (HTTP ${put.status})` };
    } catch (err) { return { ok: false, error: `uploading failed — ${err.message}` }; }
    return { ok: true, url: up.public_url, uploaded: true };
}

async function hostBody(body, auth, opts) {
    const fields = ['image_url', 'end_image_url', 'last_image_url', 'first_frame_url', 'last_frame_url',
        'image_reference_url', 'audio_url', 'image_urls', 'audio_urls'];
    let uploading = false;
    for (const f of fields) {
        if (body[f] === undefined) continue;
        const list = Array.isArray(body[f]) ? body[f] : [body[f]];
        const out = [];
        for (const v of list) {
            if (!/^https?:\/\//i.test(v) && !uploading) {
                uploading = true;
                require('../generation-progress').emit(opts, { phase: 'uploading' });
            }
            const h = await hostOne(v, auth);
            if (!h.ok) return { ok: false, status: 422, error: `higgsfield: ${f}: ${h.error}` };
            out.push(h.url);
        }
        body[f] = Array.isArray(body[f]) ? out : out[0];
    }
    return { ok: true };
}

/** Poll the status URL with the documented backoff until a terminal state. */
async function awaitResult(statusUrl, auth, deadline, opts) {
    const { emit } = require('../generation-progress');
    let delay = POLL_START_MS();
    let failures = 0;
    while (Date.now() < deadline) {
        let res, body;
        try {
            res = await fetch(statusUrl, { headers: { Authorization: auth, accept: 'application/json' } });
            body = await readJson(res);
        } catch (err) {
            if (++failures > 5) return { ok: false, status: 502, error: `higgsfield: polling failed — ${err.message}` };
            await sleep(delay); continue;
        }
        if (res.status >= 500) { if (++failures > 5) return { ok: false, status: 502, error: errorOf(res.status, body) }; await sleep(delay); continue; }
        if (!res.ok) return { ok: false, status: res.status, error: errorOf(res.status, body) };
        failures = 0;
        const status = String(body && body.status || '');
        if (status === 'completed') {
            const url = (body.video && body.video.url) || (Array.isArray(body.images) && body.images[0] && body.images[0].url)
                || (body.audio && body.audio.url);
            if (!url) return { ok: false, status: 502, error: 'higgsfield: completed with no output URL' };
            let file;
            try { file = await fetch(url); } catch (err) { return { ok: false, status: 502, error: `higgsfield: downloading the result failed — ${err.message}` }; }
            if (!file.ok) return { ok: false, status: 502, error: `higgsfield: the result URL returned ${file.status}` };
            return { ok: true, data: Buffer.from(await file.arrayBuffer()), url };
        }
        // Failed and NSFW requests are refunded by Higgsfield; both are said as refusals.
        if (status === 'nsfw') return { ok: false, status: 422, error: 'higgsfield: refused by content moderation (nsfw) — not charged' };
        if (status === 'failed') return { ok: false, status: 422, error: `higgsfield: generation failed${body.error ? ' — ' + body.error : ''} (not charged)` };
        if (status === 'canceled') return { ok: false, status: 409, error: 'higgsfield: the request was cancelled' };
        emit(opts, { phase: status === 'queued' ? 'queued' : 'generating' });
        await sleep(delay + Math.random() * 500);
        delay = Math.min(delay * 1.5, 10000);
    }
    return { ok: false, status: 504, error: 'higgsfield: timed out waiting for the result' };
}

async function generate(capability, payload, opts) {
    if (capability !== 'video' && capability !== 'image') return { ok: false, status: 400, error: `higgsfield: ${capability} is not served here` };
    const cred = credential();
    if (!cred.ok) return cred;
    let req;
    try { req = buildRequest(capability, payload); }
    catch (err) { return { ok: false, status: err.status || 400, error: err.message }; }
    if (req.missing.length) return { ok: false, status: 400, error: `higgsfield: ${req.endpoint} needs ${req.missing.join(', ')}` };
    const hosted = await hostBody(req.body, cred.header, opts);
    if (!hosted.ok) return hosted;

    // One idempotency key for the submission and its one retry, so a timeout never buys twice.
    const idem = crypto.randomUUID();
    let res, body;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            res = await fetch(req.url, {
                method: 'POST',
                headers: { Authorization: cred.header, 'Content-Type': 'application/json', 'Idempotency-Key': idem, accept: 'application/json' },
                body: JSON.stringify(req.body),
            });
            body = await readJson(res);
        } catch (err) {
            if (attempt === 0) continue;
            return { ok: false, status: 502, error: `higgsfield: ${err.message}` };
        }
        if (res.status >= 500 && attempt === 0) continue;
        break;
    }
    if (!res.ok || !body || !body.request_id) return { ok: false, status: res.status || 502, error: errorOf(res.status, body) };
    const statusUrl = body.status_url || `${BASE_URL}/requests/${body.request_id}/status`;
    // Written down before polling: an abandoned call can still collect it.
    if (opts && typeof opts.onHandle === 'function') {
        try { opts.onHandle(body.request_id, { capability, model: req.model }); } catch (_) { /* never blocks a paid call */ }
    }
    require('../generation-progress').emit(opts, { phase: 'queued' });
    const timeout = require('../generation-jobs').budgetFor((opts && opts.timeout) || POLL_TIMEOUT_MS);
    const out = await awaitResult(statusUrl, cred.header, Date.now() + timeout, opts);
    if (!out.ok && out.status === 504 && opts && opts.onTimeout) return opts.onTimeout(body.request_id, timeout);
    if (!out.ok) return out;
    return { ok: true, data: out.data, provider: 'higgsfield', provider_model: req.model,
        provider_endpoint: req.endpoint, provider_job_id: body.request_id };
}

/** Finish a request from its id, with the same poll. Free: it was already paid for. */
async function collect(handle, opts) {
    const cred = credential();
    if (!cred.ok) return cred;
    const budget = require('../generation-jobs').budgetFor((opts && opts.timeout) || POLL_TIMEOUT_MS);
    return awaitResult(`${BASE_URL}/requests/${encodeURIComponent(String(handle))}/status`, cred.header, Date.now() + budget, opts);
}

/**
 * Is the key right? Free: asks the status of a request that does not exist.
 * A good key gets 404 (no such request on this account), a bad one 401.
 */
async function checkCredential() {
    const cred = credential();
    if (!cred.ok) return { ok: false, error: cred.error };
    let res, body;
    try {
        res = await fetch(`${BASE_URL}/requests/00000000-0000-4000-8000-000000000000/status`, { headers: { Authorization: cred.header } });
        body = await readJson(res);
    } catch (err) { return { ok: false, error: `higgsfield: could not reach ${BASE_URL} — ${err.message}` }; }
    if (res.status === 401) return { ok: false, status: 401, error: errorOf(401, body) };
    if (res.status === 404 || res.ok) return { ok: true, note: 'Higgsfield accepted the key.' };
    return { ok: false, status: res.status, error: errorOf(res.status, body) };
}

/**
 * What a call consumed: seconds of video or one image, under the model id the
 * rate book prices (a family's tiers share their family's row when they have none).
 */
function meterHiggsfield(capability, payload, result) {
    const model = (result && result.provider_model) || (payload && payload.model) || null;
    if (capability === 'image') return { unit: 'image', quantity: 1, model: model || DEFAULT_IMAGE_MODEL };
    if (capability !== 'video') return null;
    const p = payload || {};
    const s = Number(first(p.duration_s, p.duration, p.duration_ms ? p.duration_ms / 1000 : undefined, 5));
    return { unit: 'second', quantity: Math.max(1, s), model: model || DEFAULT_VIDEO_MODEL };
}

const modelList = cap => Object.fromEntries(Object.entries(MODELS[cap]).map(([id, m]) => [id,
    { label: m.label, note: `Workflows: ${Object.keys(m.endpoints).join(', ')} — chosen from what the shot carries.` }]));

const higgsfieldAdapter = {
    id: 'higgsfield',
    kind: 'generator',
    label: 'Higgsfield (image and video models)',
    account: 'Higgsfield',
    requiresKey: true,
    capabilities: ['video', 'image'],
    supports: capability => capability === 'video' || capability === 'image',
    modelsByCapability: { video: modelList('video'), image: modelList('image') },
    // One flat list as well, so a pinned model can be checked against this provider.
    models: { ...modelList('video'), ...modelList('image') },
    deliverableFrame,
    defaultModel: DEFAULT_VIDEO_MODEL,
    defaultImageModel: DEFAULT_IMAGE_MODEL,
    MODELS, SOURCE_WORKFLOWS, CONTRACT_CHECKED: CONTRACT.checked,
    meter: meterHiggsfield,
    asyncGeneration: true,
    /** A request reports queued / in_progress and no percentage. */
    reportsProgress: 'phase',
    /** Cancellable only while queued; once started it runs, so stopping leaves it collectable. */
    cancel: 'stop_waiting',

    /*
     * The image contract every image adapter states. A size is a ratio and a
     * tier on every Higgsfield image endpoint, never pixels.
     */
    sizeControl: 'snapped',
    sizeControlReason: 'Higgsfield image models take an aspect ratio and a resolution tier; the pixel size is the tier’s.',
    promptLimit: 4000,
    supportsNegativePrompt: false,
    negativePromptReason: 'Sent only to the models whose schema has a negative_prompt field (Kling 2.5, PixVerse, Wan, Qwen); dropped with the reason otherwise.',
    supportsSeed: true,
    referenceMode: 'condition',
    maxReferenceImages: 4,
    supportsReferenceImages: true,
    supportsReferenceTags: false,
    maxImagePixels: 3840 * 2160,
    maxKeyframes: 2,
    keyframeNote: 'Image-to-video endpoints take a first frame and, on most models, an end frame (end_image_url / last_image_url).',

    buildRequest,
    // The request builder the image probes read: the same function, for the image capability.
    buildImageRequest: p => buildRequest('image', p),
    describeRequest,
    describeVideoRequest,
    describeImageRequest: p => describeRequest('image', p),
    generate,
    collect,
    checkCredential,
    awaitResult,
    connection: {
        instructions: 'In console.higgsfield.ai create an API key: it comes as a key ID and a secret. Enter both. Pay-as-you-go; failed and moderated requests are not charged.',
        helpUrl: 'https://console.higgsfield.ai',
        fields: [
            { key: 'key_id', label: 'API key ID', placeholder: 'from console.higgsfield.ai' },
            { key: 'key_secret', label: 'API key secret', type: 'password' },
        ],
    },
};

module.exports = { adapter: higgsfieldAdapter, higgsfieldAdapter, MODELS, SOURCE_WORKFLOWS, buildRequest, deliverableFrame,
    describeRequest, generate, collect, checkCredential, credential, kindOf, tierOf };
