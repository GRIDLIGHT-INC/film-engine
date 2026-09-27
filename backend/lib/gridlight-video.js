/**
 * Gridlight video: the gateway's own contract, read from the gateway.
 *
 * The gateway serves several video models and they take different things:
 * Wan 2.2 one start image or clip, MiniMax H3 nothing, LTX-2.5 six kinds of
 * reference. `GET /media/capabilities` says which, per model, and it is the
 * ONLY statement of it here — a reference kind this file typed in itself would
 * be a second list that goes stale the day the gateway gains an adapter, and a
 * kind the model does not declare is a 422 that cost a round trip to learn.
 *
 * Everything the brief asks the app to do is done in this one module, so the
 * single-clip road, the stream road and the shot-list road cannot disagree:
 *
 *   discover   capabilities, cached; only `available: true` models are offered
 *   build      Film Engine's reference ROLES become the gateway's KINDS, filtered
 *              against the model's own inputs[] — every drop is reported with
 *              its reason, never silent
 *   validate   prompt, duration, fps, size, keyframe spacing and the body budget
 *              are refused HERE, before a byte is encoded onto the wire
 *   stream     fetch + a reader (EventSource can send no body and no header);
 *              a stream that ends without `completed` is a failure
 *   collect    `video_url` is gateway-relative and fetched with the same Bearer
 *   errors     every status the gateway documents mapped to what to do about it;
 *              429 waits `retry_after` and tries again, 502 retries once
 *   one at a   the agent renders one video at a time, so this process queues
 *   time       rather than earning a 429 for every second request
 *
 * `completed.mode` and `completed.resolution` are not trusted (the brief names
 * both as echoes of the request, not facts about the file): the mode is read
 * from what was SENT, and the resolution is measured from the file.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** The reference kinds the gateway defines, and what each one is made of. */
const KINDS = Object.freeze({
    keyframe: { source: 'image', max: 8, at: ['start', 'end', 'seconds'] },
    clip: { source: 'video', max: 2, at: ['start', 'end'] },
    character: { source: 'image', max: 4, sheet: true },
    location: { source: 'image', max: 2, sheet: true },
    prop: { source: 'image', max: 4, sheet: true },
    transform: { source: 'video', max: 1, alone: true },
});

/** Characters, locations and props share one reference sheet of this many panels. */
const SHEET_PANELS = 6;

/** The gateway's own limits, from the brief. The model's manifest can only tighten them. */
const LIMITS = Object.freeze({
    prompt_chars: 2000,
    max_duration_s: 60,
    min_fps: 8,
    max_fps: 30,
    max_width: 3840,
    max_height: 2160,
    size_multiple: 32,           // LTX-2.5 renders at multiples of 32 and rounds down
    keyframe_gap_frames: 8,      // two keyframes closer than this are refused
    clip_condition_frames: 33,   // the last (extend) or first (bridge) 33 frames of a clip
    max_body_bytes: 512 * 1024 * 1024,
    production_shots: [1, 20],
});

/** What Film Engine's video reference ROLES are, in the gateway's words. */
const ROLE_TO_KIND = Object.freeze({
    keyframe: 'keyframe',
    inbetween: 'keyframe',   // a station of the strip IS a keyframe pinned at a time
    character: 'character',
    creature: 'character',   // the gateway has no creature kind; it is a character panel
    location: 'location',
    prop: 'prop',
});

/** Roles the gateway refuses by name (422): "LTX-2.5 has no adapter for them yet". */
const REFUSED_ROLES = Object.freeze({
    style: 'the gateway refuses style references (422): LTX-2.5 has no adapter for them yet',
    motion: 'the gateway refuses motion references (422): LTX-2.5 has no adapter for them yet',
    audio: 'the gateway takes no audio reference',
});

/** Every status the gateway documents, and what the person should be told. */
const ERRORS = Object.freeze({
    400: { code: 'BAD_FIELD', say: 'the video request has a field the gateway refused', retry: 'none' },
    401: { code: 'TOKEN', say: 'the Gridlight token is missing or wrong — set GRIDLIGHT_API_KEY', retry: 'none' },
    413: { code: 'TOO_LARGE', say: 'the request is over the gateway\'s size limit — shrink or drop references', retry: 'none' },
    422: { code: 'REFERENCE_REFUSED', say: 'a reference the model cannot honour', retry: 'none' },
    424: { code: 'FEATURE_NOT_ENABLED', say: 'that feature is not enabled on this video server (an adapter licence has not been accepted)', retry: 'none' },
    429: { code: 'BUSY', say: 'the video server is busy with another video', retry: 'after' },
    502: { code: 'AGENT_FAILED', say: 'the video agent failed or is unreachable', retry: 'once' },
    503: { code: 'SERVER_OFF', say: 'the video server is off — its GPU box is stopped', retry: 'none' },
    507: { code: 'GPU_OUT_OF_MEMORY', say: 'the GPU ran out of memory — retry smaller (shorter, or a lower resolution)', retry: 'none' },
});

/** The SSE events the gateway sends, and what each one means for progress. */
const EVENTS = Object.freeze({
    started: 'queued',
    loading_model: 'warming up',
    model_loaded: 'warming up',
    generating: 'generating',
    progress: 'generating',
    encoding_video: 'finishing',
    nsfw_flagged: 'content filter notice',
    completed: 'done',
    error: 'failed',
    // shot-list mode
    production_started: 'queued',
    shot_started: 'generating',
    shot_completed: 'generating',
    stitching: 'finishing',
});

// -- configuration ------------------------------------------------------------

function config(opts) {
    const o = opts || {};
    const client = (() => { try { return require('./gridlight-client'); } catch (_) { return {}; } })();
    return {
        baseUrl: String(o.baseUrl || process.env.GRIDLIGHT_URL || client.GRIDLIGHT_URL || 'http://localhost:8080').replace(/\/+$/, ''),
        token: o.token !== undefined ? o.token : (process.env.GRIDLIGHT_API_KEY || client.GRIDLIGHT_API_KEY || ''),
        fetch: o.fetch || globalThis.fetch,
    };
}

function authHeaders(cfg, json) {
    const h = {};
    if (json) h['Content-Type'] = 'application/json';
    if (cfg.token) h.Authorization = `Bearer ${cfg.token}`;
    return h;
}

// -- errors -------------------------------------------------------------------

/** One failure shape for every road: status, code, the gateway's words, and what to do. */
function failure(status, message, extra) {
    const known = ERRORS[status] || null;
    const msg = String(message || '').trim();
    const error = known
        ? (msg && msg !== known.say ? `${known.say}: ${msg}` : known.say)
        : (msg || `the video server answered ${status}`);
    return { ok: false, status: status || 500, code: known ? known.code : 'FAILED',
        error, gateway_message: msg || null, ...(extra || {}) };
}

/** An error EVENT inside a stream. `507:` is the GPU; a licence message is a 424. */
function failureFromEvent(data) {
    const msg = String((data && (data.error || data.message)) || 'the video agent reported an error');
    if (/^\s*507\s*:/.test(msg)) return failure(507, msg.replace(/^\s*507\s*:\s*/, ''));
    if (/licen[cs]e|hugging\s*face|\b424\b/i.test(msg)) return failure(424, msg);
    return failure(502, msg, { code: 'AGENT_ERROR', stream_error: true });
}

async function readErrorBody(response) {
    let text = '';
    try { text = await response.text(); } catch (_) { return { message: '', retry_after: null }; }
    try {
        const j = JSON.parse(text);
        return { message: j.error || j.message || text, retry_after: j.retry_after, shot: j.shot, reference: j.reference };
    } catch (_) {
        return { message: text, retry_after: null };
    }
}

// -- capabilities -------------------------------------------------------------

const CAPS_TTL_MS = 60 * 1000;
let capsCache = null; // { at, key, value }

/**
 * The video models from a capabilities document, tolerant of the three shapes
 * a media manifest is commonly written in. Unknown shapes yield no models
 * rather than a guess.
 */
function videoModelsFrom(doc) {
    const d = doc || {};
    const media = d.media || d.mediums || d;
    let list = null;
    if (Array.isArray(media)) {
        const v = media.find(m => m && (m.medium === 'video' || m.id === 'video' || m.name === 'video'));
        list = v && (v.models || v.list);
    } else if (media && media.video) {
        list = Array.isArray(media.video) ? media.video : (media.video.models || media.video.list);
    } else if (Array.isArray(d.models)) {
        list = d.models.filter(m => !m.medium || m.medium === 'video');
    }
    const topBudget = Number(d.max_body_bytes) || null;
    return (Array.isArray(list) ? list : []).filter(m => m && (m.id || m.model || m.name)).map(m => normaliseModel(m, topBudget));
}

function normaliseModel(m, topBudget) {
    const inputs = (Array.isArray(m.inputs) ? m.inputs : []).map(i => ({
        id: i.id || i.kind,
        kind: i.kind || i.id,
        field: i.field || 'references',
        accepts: Array.isArray(i.accepts) ? i.accepts.map(String) : [],
        max: Number.isFinite(Number(i.max)) ? Number(i.max) : null,
        at: Array.isArray(i.at) ? i.at.map(String) : [],
        effects: Array.isArray(i.effects) ? i.effects.map(String) : [],
        excludes: Array.isArray(i.excludes) ? i.excludes.map(String) : [],
        max_body_bytes: Number(i.max_body_bytes) || null,
    }));
    const budgets = [Number(m.max_body_bytes) || null, ...inputs.map(i => i.max_body_bytes), topBudget].filter(Boolean);
    return {
        id: String(m.id || m.model || m.name),
        label: m.label || m.name || m.id,
        available: m.available === true,
        has_audio: !!m.has_audio,
        withheld_reason: m.withheld_reason || null,
        inputs,
        max_body_bytes: budgets.length ? Math.min(...budgets) : LIMITS.max_body_bytes,
    };
}

/**
 * `GET /media/capabilities`, cached for a minute. Free: it reads a manifest.
 * A gateway that is off answers here too, so the reason travels with the
 * empty list rather than reading as "no models exist".
 */
async function fetchCapabilities(opts) {
    const o = opts || {};
    const cfg = config(o);
    const key = `${cfg.baseUrl}|${cfg.token ? 'auth' : ''}`;
    if (!o.force && capsCache && capsCache.key === key && Date.now() - capsCache.at < CAPS_TTL_MS) {
        return capsCache.value;
    }
    let value;
    try {
        const response = await cfg.fetch(`${cfg.baseUrl}/media/capabilities`, { headers: authHeaders(cfg, false) });
        if (!response.ok) {
            const body = await readErrorBody(response);
            value = { ...failure(response.status, body.message), models: [] };
        } else {
            const models = videoModelsFrom(await response.json());
            value = { ok: true, models, available: models.filter(m => m.available).map(m => m.id), read_at: new Date().toISOString() };
        }
    } catch (err) {
        value = { ...failure(503, `could not reach the gateway at ${cfg.baseUrl}: ${err.message}`), models: [] };
    }
    if (value.ok) capsCache = { at: Date.now(), key, value };
    return value;
}

/** The last capabilities read in this process, or null. The free preview uses it without waiting. */
function cachedCapabilities() {
    return capsCache ? capsCache.value : null;
}

function clearCapabilitiesCache() { capsCache = null; }

/**
 * Which model to run. The one asked for, when the gateway serves it; else the
 * operator's GRIDLIGHT_VIDEO_MODEL; else the first available model that takes a
 * keyframe (this engine generates from a board), else the first available.
 * A named model the gateway withholds is refused WITH its reason — silently
 * running another model would be the "whatever the box defaults to" the brief
 * warns about, one layer up.
 */
function pickModel(models, wanted) {
    const list = Array.isArray(models) ? models : [];
    const byId = id => list.find(m => m.id === id);
    const asked = wanted && byId(String(wanted));
    if (asked) {
        if (asked.available) return { ok: true, model: asked, substituted: false };
        return { ...failure(503, `model ${asked.id} is not available${asked.withheld_reason ? `: ${asked.withheld_reason}` : ''}`),
            code: 'MODEL_UNAVAILABLE' };
    }
    const available = list.filter(m => m.available);
    const envModel = process.env.GRIDLIGHT_VIDEO_MODEL && byId(process.env.GRIDLIGHT_VIDEO_MODEL);
    const chosen = (envModel && envModel.available && envModel)
        || available.find(m => m.inputs.some(i => i.kind === 'keyframe'))
        || available[0];
    if (!chosen) {
        const withheld = list.filter(m => !m.available)
            .map(m => `${m.id}${m.withheld_reason ? ` (${m.withheld_reason})` : ''}`);
        return { ...failure(503, withheld.length ? `no video model is available: ${withheld.join(', ')}` : 'the gateway lists no video model'),
            code: 'NO_MODEL' };
    }
    return { ok: true, model: chosen, substituted: !!wanted, asked: wanted || null };
}

// -- bytes --------------------------------------------------------------------

/** The MIME type the BYTES say, never the name. */
function sniffMime(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG') return 'image/png';
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
    if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    if (buf.slice(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
    return null;
}

/** A reference's bytes, from a Buffer, a data: URI, bare base64 or a file on disk. */
function bytesOf(src) {
    if (!src) return null;
    if (Buffer.isBuffer(src)) return src;
    const s = String(src);
    if (s.startsWith('data:')) {
        const comma = s.indexOf(',');
        return comma >= 0 ? Buffer.from(s.slice(comma + 1), 'base64') : null;
    }
    if (/^https?:\/\//i.test(s)) return null; // a URL is not bytes; the caller must resolve it first
    try {
        if (s.length < 4096 && fs.existsSync(s) && fs.statSync(s).isFile()) return fs.readFileSync(s);
    } catch (_) { /* fall through to base64 */ }
    if (/^[A-Za-z0-9+/=\s]+$/.test(s) && s.length > 16) return Buffer.from(s, 'base64');
    return null;
}

/** Encoded size of `n` raw bytes as base64: raw × 4/3, rounded up to the padding. */
function base64Size(n) { return 4 * Math.ceil((Number(n) || 0) / 3); }

// -- building a request -------------------------------------------------------

/**
 * Film Engine's payload, restated as the gateway's candidate references.
 * Nothing is filtered here — that is the model's job, below — so the report
 * can say which reference the MODEL refused rather than which one this file
 * forgot to translate.
 */
function candidatesFrom(payload) {
    const p = payload || {};
    const out = [];
    const seen = new Set();
    const push = c => {
        const k = `${c.kind}|${c.at}|${typeof c.src === 'string' ? c.src.slice(0, 200) : c.label || ''}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push(c);
    };
    const start = p.init_image || p.image_url;
    if (start) push({ kind: 'keyframe', src: start, at: 'start', from: 'init_image' });
    const end = p.end_image || p.last_frame || p.last_frame_image;
    if (end) push({ kind: 'keyframe', src: end, at: 'end', from: 'end_image' });
    if (p.init_video) push({ kind: 'clip', src: p.init_video, at: 'start', from: 'init_video' });

    for (const r of Array.isArray(p.video_references) ? p.video_references : []) {
        if (!r) continue;
        const src = r.uri || r.url || r.data || r.file_path;
        if (r.role === 'keyframe' && start && (src === start)) continue;
        if (REFUSED_ROLES[r.role]) {
            out.push({ kind: r.role, src, refused: REFUSED_ROLES[r.role], from: `video_references:${r.role}`, label: r.label || r.name || null });
            continue;
        }
        const kind = ROLE_TO_KIND[r.role];
        if (!kind) {
            out.push({ kind: r.role, src, refused: `Film Engine role "${r.role}" has no gateway kind`, from: `video_references:${r.role}` });
            continue;
        }
        const at = r.role === 'inbetween'
            ? Number(r.at !== undefined ? r.at : (r.seconds !== undefined ? r.seconds : r.at_s))
            : (r.role === 'keyframe' ? (r.at || 'start') : undefined);
        push({ kind, src, at, strength: r.strength, label: r.label || r.name || r.tag || null,
            from: `video_references:${r.role}` });
    }
    for (const c of Array.isArray(p.clips) ? p.clips : []) {
        if (c) push({ kind: 'clip', src: c.data || c.uri || c.file_path, at: c.at || 'start', strength: c.strength, label: c.label || null, from: 'clips' });
    }
    if (p.transform) {
        const t = p.transform;
        push({ kind: 'transform', src: t.data || t.uri || t.file_path, effect: t.effect, strength: t.strength, from: 'transform' });
    }
    // Already in the gateway's words: passed through the same filter.
    for (const r of Array.isArray(p.references) ? p.references : []) {
        if (r && r.kind) push({ kind: r.kind, src: r.data || r.uri, at: r.at, strength: r.strength, label: r.label || null, effect: r.effect, from: 'references' });
    }
    return out;
}

/** Seconds, from `start` / `end` / a number, for spacing and clamping. */
function secondsOf(at, duration) {
    if (at === 'start' || at === undefined) return 0;
    if (at === 'end') return duration;
    return Number(at);
}

/**
 * The references this model will honour, and every one it will not — each
 * with its reason. Returns the gateway `references` array, any legacy field
 * (`init_image` / `init_video`) a model reads instead, and the bytes it adds.
 */
function referencesFor(payload, model, frame) {
    const f = frame || {};
    const duration = Number(f.duration_seconds) || 5;
    const fps = Number(f.fps) || 24;
    const minGap = LIMITS.keyframe_gap_frames / fps;
    const inputs = new Map(((model && model.inputs) || []).map(i => [i.kind, i]));
    const kept = [];
    const dropped = [];
    const warnings = [];
    const drop = (c, reason) => dropped.push({ kind: c.kind, from: c.from, label: c.label || null, at: c.at === undefined ? null : c.at, reason });

    // A transform is only ever asked for explicitly and must stand alone, so
    // it is considered FIRST: everything it excludes then yields to it.
    const ordered = candidatesFrom(payload).sort((a, b) => (b.kind === 'transform') - (a.kind === 'transform'));
    for (const c of ordered) {
        if (c.refused) { drop(c, c.refused); continue; }
        const input = inputs.get(c.kind);
        if (!input) { drop(c, `${model ? model.id : 'this model'} declares no ${c.kind} input`); continue; }
        const bytes = bytesOf(c.src);
        if (!bytes) { drop(c, 'its picture could not be read as bytes (a URL must be fetched first)'); continue; }
        const mime = sniffMime(bytes);
        if (input.accepts.length && !input.accepts.includes(mime)) {
            drop(c, `${mime || 'an unrecognised file'} is not one of ${input.accepts.join(', ')}`);
            continue;
        }
        let at = c.at;
        if (typeof at === 'number' || (at !== undefined && at !== 'start' && at !== 'end')) {
            const n = Number(at);
            if (!Number.isFinite(n)) { drop(c, `"${at}" is not a time`); continue; }
            if (input.at.length && !input.at.includes('seconds')) { drop(c, `${c.kind} can only be placed at ${input.at.join(' or ')}`); continue; }
            at = Math.max(0, Math.min(duration, n));
            if (at !== n) warnings.push(`${c.kind} at ${n}s was clamped to ${at}s — the video is ${duration}s`);
        } else if (at !== undefined && input.at.length && !input.at.includes(at)) {
            drop(c, `${c.kind} cannot be placed at ${at}; the model allows ${input.at.join(', ')}`);
            continue;
        }
        if (c.kind === 'transform') {
            if (input.effects.length && !input.effects.includes(c.effect)) {
                drop(c, `effect "${c.effect || '(none)'}" is not one of ${input.effects.join(', ')}`);
                continue;
            }
        }
        const cap = input.max !== null ? input.max : (KINDS[c.kind] ? KINDS[c.kind].max : Infinity);
        if (kept.filter(k => k.kind === c.kind).length >= cap) { drop(c, `the model takes at most ${cap} ${c.kind} reference${cap === 1 ? '' : 's'}`); continue; }
        if (KINDS[c.kind] && KINDS[c.kind].sheet && kept.filter(k => KINDS[k.kind] && KINDS[k.kind].sheet).length >= SHEET_PANELS) {
            drop(c, `the reference sheet holds ${SHEET_PANELS} panels (characters, locations and props together)`);
            continue;
        }
        const clash = kept.find(k => (inputs.get(k.kind).excludes || []).includes(c.kind) || input.excludes.includes(k.kind));
        if (clash) { drop(c, `${c.kind} cannot be combined with ${clash.kind} on this model`); continue; }
        kept.push({ ...c, at, bytes, mime, input });
    }

    // A transform must be the only reference. It is only ever explicit, so it wins.
    if (kept.some(k => k.kind === 'transform' || (KINDS[k.kind] && KINDS[k.kind].alone))) {
        for (const k of kept.filter(x => x.kind !== 'transform')) drop(k, 'a transform must be the only reference');
        kept.splice(0, kept.length, ...kept.filter(x => x.kind === 'transform'));
    }

    // Keyframe spacing: at least 8 frames apart. start/end are fixed; a timed
    // keyframe that collides with a neighbour is dropped and said.
    const frames = kept.filter(k => k.kind === 'keyframe')
        .map(k => ({ k, t: secondsOf(k.at, duration), fixed: k.at === 'start' || k.at === 'end' || k.at === undefined }))
        .sort((a, b) => a.t - b.t || (b.fixed - a.fixed));
    const placed = [];
    for (const fr of frames) {
        const near = placed.find(p => Math.abs(p.t - fr.t) < minGap - 1e-9);
        if (near) {
            const loser = fr.fixed && !near.fixed ? near : fr;
            drop(loser.k, `keyframes must be at least ${LIMITS.keyframe_gap_frames} frames apart (${minGap.toFixed(2)}s at ${fps}fps)`);
            kept.splice(kept.indexOf(loser.k), 1);
            if (loser === near) { placed.splice(placed.indexOf(near), 1); placed.push(fr); }
            continue;
        }
        placed.push(fr);
    }
    if (kept.some(k => k.kind === 'clip')) {
        warnings.push(`a clip conditions on its last (extend) or first (bridge) ${LIMITS.clip_condition_frames} frames, about ${(LIMITS.clip_condition_frames / fps).toFixed(1)}s`);
    }

    const references = [];
    const fields = {};
    let bytes = 0;
    for (const k of kept) {
        const data = k.bytes.toString('base64');
        bytes += data.length;
        if (k.input.field && k.input.field !== 'references') {
            if (!fields[k.input.field]) fields[k.input.field] = data;
            continue;
        }
        const ref = { kind: k.kind, data };
        if (k.at !== undefined && k.kind !== 'character' && k.kind !== 'location' && k.kind !== 'prop' && k.kind !== 'transform') ref.at = k.at;
        if (k.strength !== undefined && k.strength !== null && Number.isFinite(Number(k.strength))) {
            ref.strength = Math.max(0, Math.min(1, Number(k.strength)));
        }
        if (k.label && KINDS[k.kind] && KINDS[k.kind].sheet) ref.label = String(k.label).slice(0, 200);
        if (k.kind === 'transform') ref.effect = k.effect;
        references.push(ref);
    }
    return {
        references, fields, dropped, warnings, encoded_bytes: bytes,
        sent: kept.map(k => ({ kind: k.kind, from: k.from, at: k.at === undefined ? null : k.at, label: k.label || null,
            mime: k.mime, field: k.input.field || 'references' })),
    };
}

/** Width and height the model can actually render: inside 3840x2160, down to a multiple of 32. */
function snapSize(width, height) {
    let w = Number(width) || 0;
    let h = Number(height) || 0;
    if (!w || !h) return { width: undefined, height: undefined, note: null };
    const scale = Math.min(1, LIMITS.max_width / w, LIMITS.max_height / h);
    const m = LIMITS.size_multiple;
    const sw = Math.max(m, Math.floor((w * scale) / m) * m);
    const sh = Math.max(m, Math.floor((h * scale) / m) * m);
    const note = (sw !== w || sh !== h)
        ? `${w}x${h} sent as ${sw}x${sh}: the model renders inside ${LIMITS.max_width}x${LIMITS.max_height} at multiples of ${m}` : null;
    return { width: sw, height: sh, note };
}

/**
 * The whole `POST /video` body for a Film Engine payload, and every reason it
 * differs from what was asked. Pure: no network, so the free preview and the
 * paid path describe the same request.
 */
function buildVideoRequest(payload, modelIn, opts) {
    // A manifest entry straight off the wire is normalised here too, so every
    // caller reads the same shape whatever it was handed.
    const model = modelIn && (modelIn.inputs || []).every(i => Array.isArray(i.at) && Array.isArray(i.excludes))
        && modelIn.max_body_bytes ? modelIn : normaliseModel(modelIn || { id: 'unknown' }, null);
    const p = payload || {};
    const o = opts || {};
    const warnings = [];
    const prompt = String(p.prompt || '').trim();
    if (!prompt) return { ...failure(400, 'a prompt is required'), code: 'BAD_FIELD', field: 'prompt' };
    if (prompt.length > LIMITS.prompt_chars) {
        return { ...failure(400, `the prompt is ${prompt.length} characters; the gateway takes ${LIMITS.prompt_chars}`), field: 'prompt' };
    }
    const durationIn = Number(p.duration_seconds !== undefined ? p.duration_seconds : (p.duration_s !== undefined ? p.duration_s : p.duration));
    if (Number.isFinite(durationIn) && (durationIn <= 0 || durationIn > LIMITS.max_duration_s)) {
        return { ...failure(400, `duration ${durationIn}s is outside 0–${LIMITS.max_duration_s}s`), field: 'duration_seconds' };
    }
    const fpsIn = Number(p.fps);
    if (Number.isFinite(fpsIn) && p.fps !== undefined && (fpsIn < LIMITS.min_fps || fpsIn > LIMITS.max_fps)) {
        return { ...failure(400, `fps ${fpsIn} is outside ${LIMITS.min_fps}–${LIMITS.max_fps}`), field: 'fps' };
    }
    const size = snapSize(p.width, p.height);
    if (size.note) warnings.push(size.note);

    const frame = { duration_seconds: Number.isFinite(durationIn) ? durationIn : 5, fps: Number.isFinite(fpsIn) && p.fps !== undefined ? fpsIn : 24 };
    const refs = referencesFor(p, model, frame);
    warnings.push(...refs.warnings);

    const body = { prompt, model: model.id, stream: o.stream !== false };
    if (size.width) { body.width = size.width; body.height = size.height; }
    if (p.fps !== undefined && Number.isFinite(fpsIn)) body.fps = fpsIn;
    if (Number.isFinite(durationIn)) body.duration_seconds = durationIn;
    if (p.negative_prompt) body.negative_prompt = String(p.negative_prompt);
    if (p.seed !== undefined && p.seed !== null && Number.isFinite(Number(p.seed))) body.seed = Number(p.seed);
    if (refs.references.length) body.references = refs.references;
    Object.assign(body, refs.fields);

    // The budget, pre-checked in ENCODED bytes, the way the gateway counts it.
    const estimate = refs.encoded_bytes + Buffer.byteLength(JSON.stringify({ ...body, references: undefined,
        init_image: undefined, init_video: undefined }), 'utf8') + 256 * (refs.references.length + 1);
    const budget = model.max_body_bytes || LIMITS.max_body_bytes;
    if (estimate > budget) {
        return { ...failure(413, `the request would be about ${(estimate / 1048576).toFixed(1)} MB encoded; `
            + `the gateway takes ${(budget / 1048576).toFixed(0)} MB`), estimated_bytes: estimate, max_body_bytes: budget,
            refused_locally: true };
    }
    return {
        ok: true, body, warnings,
        references_sent: refs.sent, references_dropped: refs.dropped,
        estimated_bytes: estimate, max_body_bytes: budget,
        // Read from what was SENT: completed.mode ignores references.
        mode: refs.sent.some(r => r.kind === 'transform') ? 'transform'
            : refs.sent.some(r => r.kind === 'clip') ? 'video_to_video'
                : refs.sent.some(r => r.kind === 'keyframe') ? 'image_to_video' : 'text_to_video',
    };
}

// -- the stream ---------------------------------------------------------------

/**
 * Read a gateway SSE response to its end. `data: {json}` lines carry an
 * `event` (or an `event:` line names it); keep-alive comments are ignored.
 * Only a `completed` event is success — a stream that just stops is a failure,
 * even with no `error` event, because the file it promised does not exist.
 */
async function readEvents(response, onEvent) {
    const events = [];
    let completed = null;
    let errorEvent = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let named = '';
    const handle = line => {
        if (!line || line.startsWith(':')) return;
        if (line.startsWith('event:')) { named = line.slice(6).trim(); return; }
        if (!line.startsWith('data:')) return;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') return;
        let data;
        try { data = JSON.parse(raw); } catch (_) { named = ''; return; }
        const event = data.event || named || data.type || 'message';
        named = '';
        const evt = { ...data, event, phase: EVENTS[event] || null };
        events.push(event);
        if (event === 'completed') completed = evt;
        if (event === 'error') errorEvent = evt;
        if (onEvent) { try { onEvent(evt); } catch (_) { /* a progress painter must not end the render */ } }
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const l of lines) handle(l);
    }
    if (buffer) handle(buffer);
    if (errorEvent) return { ...failureFromEvent(errorEvent), events };
    if (!completed) return { ...failure(502, 'the stream ended without a completed event, so no video was made'), code: 'STREAM_INCOMPLETE', events };
    return { ok: true, completed, events };
}

// -- one at a time --------------------------------------------------------------

let queueTail = Promise.resolve();
let queued = 0;

/** The agent renders one video at a time; so does this process. */
function serialised(fn) {
    queued += 1;
    const run = queueTail.then(fn, fn);
    queueTail = run.then(() => { queued -= 1; }, () => { queued -= 1; });
    return run;
}

function queueDepth() { return queued; }

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * POST and read, with the retries the brief names: 429 waits `retry_after`
 * (60s) and tries again, 502 is retried once, nothing else is retried — a 422
 * or a 400 is our request and replaying it buys the same refusal twice.
 */
async function postAndStream(endpoint, body, opts) {
    const o = opts || {};
    const cfg = config(o);
    const max429 = Number.isFinite(o.max429) ? o.max429 : 10;
    const retryScale = Number.isFinite(o.retryAfterMs) ? o.retryAfterMs : 1000; // ms per second of retry_after
    let busy = 0;
    let failed502 = 0;
    for (;;) {
        let response;
        try {
            response = await cfg.fetch(`${cfg.baseUrl}${endpoint}`, {
                method: 'POST', headers: authHeaders(cfg, true), body: JSON.stringify(body), signal: o.signal,
            });
        } catch (err) {
            if (err && err.name === 'AbortError') return { ...failure(499, 'the request was cancelled'), code: 'CANCELLED' };
            return failure(503, `could not reach the gateway at ${cfg.baseUrl}: ${err.message}`);
        }
        if (response.status === 429 && busy < max429) {
            const b = await readErrorBody(response);
            busy += 1;
            const wait = Number(b.retry_after) > 0 ? Number(b.retry_after) : 60;
            if (o.onEvent) o.onEvent({ event: 'queued_locally', phase: 'queued', retry_after: wait, attempt: busy });
            await sleep(wait * retryScale);
            continue;
        }
        if (response.status === 502 && failed502 < 1) {
            await readErrorBody(response);
            failed502 += 1;
            continue;
        }
        if (!response.ok) {
            const b = await readErrorBody(response);
            return failure(response.status, b.message, {
                ...(b.retry_after ? { retry_after: b.retry_after } : {}),
                ...(b.shot !== undefined ? { shot: b.shot } : {}),
                ...(b.reference !== undefined ? { reference: b.reference } : {}),
            });
        }
        const type = String(response.headers.get('content-type') || '');
        if (!type.includes('text/event-stream')) {
            // A non-streamed answer: the completed object itself.
            let j = null;
            try { j = await response.json(); } catch (_) { j = null; }
            if (j && j.video_url) return { ok: true, completed: { event: 'completed', ...j }, events: ['completed'] };
            return { ...failure(502, 'the gateway answered without a video_url'), code: 'STREAM_INCOMPLETE' };
        }
        const read = await readEvents(response, o.onEvent);
        if (!read.ok && read.status === 502 && read.stream_error && failed502 < 1) { failed502 += 1; continue; }
        return read;
    }
}

/** `video_url` is gateway-relative: fetched from the same gateway with the same Bearer. */
async function download(videoUrl, opts) {
    const cfg = config(opts);
    const url = /^https?:\/\//i.test(videoUrl) ? videoUrl : `${cfg.baseUrl}${videoUrl.startsWith('/') ? '' : '/'}${videoUrl}`;
    let sameGateway = true;
    try { sameGateway = new URL(url).origin === new URL(cfg.baseUrl).origin; } catch (_) { sameGateway = false; }
    const response = await cfg.fetch(url, { headers: sameGateway ? authHeaders(cfg, false) : {} });
    if (!response.ok) {
        const b = await readErrorBody(response);
        // A 502 whatever the gateway answered: the render SUCCEEDED, so this is
        // an upstream fault in handing it over, never a problem with our request.
        return { ...failure(502, `the video was made but could not be fetched from ${videoUrl}, so it could not be stored: ${b.message || response.status}`),
            code: 'DOWNLOAD_FAILED', upstream_status: response.status };
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (sniffMime(data) !== 'video/mp4') return { ...failure(502, 'the gateway\'s video_url did not return an MP4'), code: 'NOT_A_VIDEO' };
    return { ok: true, data };
}

/**
 * The size the file actually IS. `completed.resolution` echoes the request and
 * LTX rounds down to 32, so the only honest answer is the file's own header.
 * Best effort: no encoder here is not a failed generation.
 */
function measure(buf) {
    let tmp = null;
    try {
        const { inspectMedia } = require('./ffmpeg');
        tmp = path.join(os.tmpdir(), `gl-video-${process.pid}-${Date.now()}.mp4`);
        fs.writeFileSync(tmp, buf);
        const info = inspectMedia(tmp);
        if (!info || !info.ok) return null;
        return { width: info.width || null, height: info.height || null,
            duration_ms: Number.isFinite(info.durationSeconds) ? Math.round(info.durationSeconds * 1000) : null,
            fps: info.fps || null, has_audio: !!info.hasAudio };
    } catch (_) {
        return null;
    } finally {
        if (tmp) { try { fs.unlinkSync(tmp); } catch (_) { /* gone already */ } }
    }
}

// -- the two roads --------------------------------------------------------------

/**
 * One clip. Returns `{ ok, status: 200, data: <mp4 Buffer>, ... }` — bytes, so
 * every route that persists a provider result stores it unchanged.
 */
async function generateVideo(payload, opts) {
    const o = opts || {};
    const caps = await fetchCapabilities(o);
    if (!caps.ok) return caps;
    const pick = pickModel(caps.models, payload && payload.model);
    if (!pick.ok) return pick;
    const built = buildVideoRequest(payload, pick.model, o);
    if (!built.ok) return { ...built, provider: 'gridlight', provider_model: pick.model.id };

    return serialised(async () => {
        const started = Date.now();
        const streamed = await postAndStream('/video', built.body, o);
        if (!streamed.ok) {
            return { ...streamed, provider: 'gridlight', provider_model: pick.model.id,
                references_sent: built.references_sent, references_dropped: built.references_dropped };
        }
        const c = streamed.completed;
        const got = await download(String(c.video_url || ''), o);
        if (!got.ok) return { ...got, provider: 'gridlight', provider_model: c.model || pick.model.id, seed: c.seed };
        const measured = o.measure === false ? null : measure(got.data);
        const meta = {
            provider: 'gridlight',
            provider_model: c.model || pick.model.id,
            model_substituted: pick.substituted ? { asked: pick.asked, ran: pick.model.id } : null,
            seed: c.seed === undefined ? null : c.seed,
            duration_s: c.duration_seconds === undefined ? null : c.duration_seconds,
            fps: c.fps === undefined ? null : c.fps,
            has_audio: c.has_audio === undefined ? pick.model.has_audio : !!c.has_audio,
            resolution_requested: c.resolution || (built.body.width ? `${built.body.width}x${built.body.height}` : null),
            resolution: measured && measured.width ? `${measured.width}x${measured.height}` : null,
            measured,
            mode: built.mode,
            generation_time_ms: c.generation_time_ms === undefined ? Date.now() - started : c.generation_time_ms,
            nsfw_flagged: streamed.events.includes('nsfw_flagged'),
            references_sent: built.references_sent,
            references_dropped: built.references_dropped,
            warnings: built.warnings,
            video_url: c.video_url,
        };
        // Carried ON the buffer, so a caller persisting `data` keeps the bytes
        // and a caller reading `data.seed` keeps the take reproducible.
        Object.assign(got.data, { seed: meta.seed, provider_model: meta.provider_model });
        return { ok: true, status: 200, data: got.data, ...meta };
    });
}

const TRANSITIONS = Object.freeze(['cut', 'crossfade', 'fade_black']);

/** A Film Engine join, in the shot list's words. Anything the list has no word for is a cut. */
function transitionFor(join) {
    const t = String((join && (join.type || join)) || 'cut');
    if (TRANSITIONS.includes(t)) return t;
    if (t === 'dissolve' || t === 'morph') return 'crossfade';
    if (t === 'fade' || t === 'fade_to_black') return 'fade_black';
    return 'cut';
}

/**
 * The shot list: `POST /video/production`, 1–20 shots, one stitched MP4. Each
 * shot follows every rule of a single clip; a shot with no `start` reference
 * inherits the previous shot's last frame from the gateway. Built locally
 * shot by shot so the drops are reported per shot, before the gateway refuses
 * the whole list for one of them.
 */
async function generateProduction(spec, opts) {
    const o = opts || {};
    const s = spec || {};
    const shots = Array.isArray(s.shots) ? s.shots : [];
    const [lo, hi] = LIMITS.production_shots;
    if (shots.length < lo || shots.length > hi) return failure(400, `a shot list takes ${lo}–${hi} shots; this one has ${shots.length}`);
    const caps = await fetchCapabilities(o);
    if (!caps.ok) return caps;
    const pick = pickModel(caps.models, s.model);
    if (!pick.ok) return pick;
    const fps = s.fps !== undefined ? Number(s.fps) : 24;
    if (!Number.isFinite(fps) || fps < LIMITS.min_fps || fps > LIMITS.max_fps) return failure(400, `fps ${s.fps} is outside ${LIMITS.min_fps}–${LIMITS.max_fps}`);
    const size = snapSize(s.width, s.height);

    const body = { model: pick.model.id, stream: true, fps, shots: [] };
    if (size.width) { body.width = size.width; body.height = size.height; }
    const report = [];
    let bytes = 0;
    for (let i = 0; i < shots.length; i++) {
        const shot = shots[i] || {};
        const built = buildVideoRequest({ ...shot, fps, width: undefined, height: undefined }, pick.model, o);
        if (!built.ok) return { ...built, shot: i, error: `shot ${i + 1}${shot.label ? ` (${shot.label})` : ''}: ${built.error}` };
        const out = { prompt: built.body.prompt };
        for (const k of ['duration_seconds', 'negative_prompt', 'seed', 'references']) if (built.body[k] !== undefined) out[k] = built.body[k];
        if (i > 0) {
            out.transition = transitionFor(shot.transition);
            if (shot.transition_frames !== undefined) out.transition_frames = Number(shot.transition_frames);
        }
        bytes += built.estimated_bytes;
        body.shots.push(out);
        report.push({ shot: i, label: shot.label || null, references_sent: built.references_sent,
            references_dropped: built.references_dropped, warnings: built.warnings,
            inherits_start: !built.references_sent.some(r => r.at === 'start') });
    }
    const budget = pick.model.max_body_bytes || LIMITS.max_body_bytes;
    if (bytes > budget) return { ...failure(413, `the shot list would be about ${(bytes / 1048576).toFixed(1)} MB encoded; the gateway takes ${(budget / 1048576).toFixed(0)} MB`), refused_locally: true };

    return serialised(async () => {
        const streamed = await postAndStream('/video/production', body, o);
        if (!streamed.ok) return { ...streamed, provider: 'gridlight', provider_model: pick.model.id, shots: report };
        const c = streamed.completed;
        const got = await download(String(c.video_url || ''), o);
        if (!got.ok) return { ...got, provider: 'gridlight', shots: report };
        const measured = o.measure === false ? null : measure(got.data);
        return { ok: true, status: 200, data: got.data, provider: 'gridlight', provider_model: c.model || pick.model.id,
            total_shots: c.total_shots === undefined ? shots.length : c.total_shots, seed: c.seed === undefined ? null : c.seed,
            has_audio: c.has_audio === undefined ? pick.model.has_audio : !!c.has_audio, measured,
            shots_completed: streamed.events.filter(e => e === 'shot_completed').length, shots: report };
    });
}

/**
 * What the gateway WOULD be sent, for the free preview — read from the last
 * capabilities this process fetched, and saying so when there are none yet,
 * rather than inventing a model list to describe against.
 */
function describe(payload) {
    const caps = cachedCapabilities();
    if (!caps || !caps.ok) {
        return { known: false, note: 'The gateway\'s video capabilities have not been read yet, so which references this model takes is not known here. It is read on the first generation.' };
    }
    const pick = pickModel(caps.models, payload && payload.model);
    if (!pick.ok) return { known: true, error: pick.error, models: caps.available };
    const built = buildVideoRequest(payload, pick.model, {});
    if (!built.ok) return { known: true, model: pick.model.id, error: built.error };
    return {
        known: true, model: pick.model.id, model_substituted: pick.substituted ? { asked: pick.asked, ran: pick.model.id } : null,
        has_audio: pick.model.has_audio, mode: built.mode, width: built.body.width || null, height: built.body.height || null,
        references_sent: built.references_sent, references_dropped: built.references_dropped, warnings: built.warnings,
        estimated_bytes: built.estimated_bytes, max_body_bytes: built.max_body_bytes,
    };
}

/**
 * The reference contract Film Engine's payload builder offers against. It is
 * the gateway's documented ceiling — the most any model there takes — and the
 * MODEL's own inputs[] cut it down at generation time, where every cut is
 * reported. Static because the builder is synchronous; never the last word.
 */
const REFERENCE_CONTRACT = Object.freeze({
    roles: Object.freeze(Object.keys(ROLE_TO_KIND)),
    maxImages: KINDS.keyframe.max + SHEET_PANELS,
    maxVideos: 0,
    maxAudio: 0,
    why: 'the Gridlight gateway takes up to 8 keyframes and a 6-panel reference sheet on LTX-2.5; '
        + 'the chosen model\'s own inputs[] from /media/capabilities decide what is actually sent',
});

module.exports = {
    KINDS, SHEET_PANELS, LIMITS, ROLE_TO_KIND, REFUSED_ROLES, ERRORS, EVENTS, TRANSITIONS, REFERENCE_CONTRACT,
    config, failure, failureFromEvent, videoModelsFrom, fetchCapabilities, cachedCapabilities, clearCapabilitiesCache,
    pickModel, sniffMime, bytesOf, base64Size, candidatesFrom, referencesFor, snapSize, buildVideoRequest,
    readEvents, postAndStream, download, measure, serialised, queueDepth, generateVideo, generateProduction,
    transitionFor, describe,
};
