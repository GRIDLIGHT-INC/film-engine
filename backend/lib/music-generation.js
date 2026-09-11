/**
 * FIVE WAYS TO MAKE MUSIC, AND A TAKE IS ADDED, NEVER SWAPPED IN.
 *
 * MUS-012. The generating workflows of the `music` capability — a whole cue,
 * the provider's native parts, a cue conditioned on a reference (audio or a
 * melody), a cue conditioned on the picture, and a selected range of an
 * existing cue regenerated in context — over one score session, through one
 * plan and one runner. Separation is the sixth workflow and has its own
 * module (lib/music-separation.js) because it is a DERIVATIVE of a recording
 * rather than a new performance; nothing here plans or runs it.
 *
 * Five rules carry it:
 *
 * THE PROVIDER'S OWN CONTRACT DECIDES (MUS-009). A workflow the project's
 * provider does not declare available is refused with that provider's reason,
 * never attempted — today every provider serves composition and nothing else,
 * and saying so is the whole feature for the other four until one does.
 *
 * NOTHING IS GENERATED FROM AN ARC NOBODY ACCEPTED (MUS-010). The accepted
 * emotional arc is the context; a proposal never reaches a request. With no
 * accepted arc the plan refuses EMOTION_NOT_ACCEPTED, and `ignore_emotion`
 * goes without one — said in the plan's warnings rather than assumed, on the
 * precedent every other gate here sets: a refusal you cannot get past is a
 * reason never to use the gate at all.
 *
 * THE SESSION'S CONTEXT TRAVELS. Tempo and meter from the session's own tempo
 * map, the key the caller states, the arc as time ranges, and — where the
 * provider declares section limits — the arc as the composition plan's
 * sections, so a cue opens out where the director said the feeling does.
 *
 * A TAKE IS ADDED. Every output is a new file, a new asset and a new clip.
 * On a track that already holds something the new clip is a CANDIDATE in the
 * same take group, so what was heard is still what is heard until a person
 * selects otherwise; on a new track, where there is nothing to replace, it is
 * selected. An inpainted range lands on the source track over exactly the
 * range it rewrites. The source file, its asset and its clip placement are
 * never touched.
 *
 * A NATIVE PART IS NOT A SEPARATED STEM. The clip's `source_kind` and the
 * asset's `metadata.kind` are the registry's own output taxonomy, so a part a
 * provider generated as its own file can never be mistaken for a stem split
 * out of a mix — the difference decides whether it may be re-balanced freely.
 *
 * All or nothing: a provider error, bytes that are not audio, or a failed
 * registration leaves a FAILED operation with the reason and nothing else.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { generateId } = require('../db/database');
const { saveFile, getFileUrl } = require('./file-storage');
const { resolveStored } = require('./data-paths');
const { MEDIA_KINDS } = require('./media-kinds');
const { providerConfigOf } = require('./provider-config');
const providers = require('./providers');
const caps = require('./music-capabilities');
const { VALIDATORS, toRow, fromRow, readScoreSession } = require('./music-session');
const { STEM_FORMATS, detectFormat, inspectStem } = require('./music-stems');
const { emotionForGeneration } = require('./music-emotion');
const { compileScoreContext } = require('./music-context');
const jobs = require('./music-jobs');

/** Every registry workflow that makes new music; separation is MUS-011's. */
const GENERATE_WORKFLOWS = Object.freeze(Object.keys(caps.WORKFLOWS).filter(w => w !== 'music_separate'));

const VIDEO_TYPES = new Set(['video_raw', 'video_synced', 'video_final']);
const TAKES = 'Each output is a new file, asset and clip — a candidate take beside what the track already holds (selected only when it lands on a new track, where there is nothing to replace). Nothing on the session is replaced, and every earlier take is kept.';

// ── The provider ───────────────────────────────────────────────────────────

/** The one place the music capability is resolved for generation (MUSIC_CALL_SITES). */
function musicProviderFor(config) {
    return providers.resolve('music', config);
}

const refuse = (status, error, extra) => ({ ok: false, status, error, ...(extra || {}) });

function providerDecl(workflow, config, adapter) {
    if (adapter) {
        const contract = caps.contractOf(adapter);
        if (!contract) return { refusal: refuse(409, `${adapter.id || 'the provider'} declares no valid music contract, so nothing can be assumed about ${workflow}`, { code: 'UNSUPPORTED' }) };
        const decl = contract[workflow];
        if (!decl || decl.status !== 'available') {
            return { refusal: refuse(409, `${adapter.id} cannot ${workflow.replace('music_', '')} (${decl ? decl.status : 'unsupported'}): ${decl && decl.reason ? decl.reason : 'not declared'}.`, { code: 'UNSUPPORTED', workflow, provider: adapter.id, reason: decl && decl.reason }) };
        }
        return { id: adapter.id, decl, resolved: true, note: null };
    }
    const no = caps.unsupported(workflow, config);
    if (no) return { refusal: { ...no, status: no.http_status || 409 } };
    const found = caps.discoverMusicCapabilities(config);
    const adapterRow = providers.get(found.provider.id);
    return { id: found.provider.id, decl: adapterRow.music[workflow], resolved: found.provider.resolved, note: found.provider.note };
}

// ── The session's context ──────────────────────────────────────────────────

function tempoOf(session) {
    let map = [];
    try { map = JSON.parse(session.tempo_map_json || '[]'); } catch (_) { map = []; }
    const first = Array.isArray(map) && map.length ? map[0] : null;
    return {
        tempo_bpm: first && Number(first.bpm) > 0 ? Number(first.bpm) : null,
        time_signature: first && first.numerator && first.denominator ? `${first.numerator}/${first.denominator}` : null,
        tempo_changes: Array.isArray(map) ? Math.max(0, map.length - 1) : 0,
    };
}

function lengthOf(db, sessionId) {
    let compiled = null;
    try { compiled = compileScoreContext(db, { sessionId }); } catch (_) { compiled = null; }
    const fromBrief = compiled && compiled.brief && compiled.brief.length && Number(compiled.brief.length.ms);
    if (fromBrief > 0) return { ms: fromBrief, source: 'the picture the session covers' };
    const m = readScoreSession(db, sessionId);
    const ms = Number(m && m.duration_ms) || 0;
    return { ms, source: ms ? 'the session\'s own arrangement' : null };
}

/**
 * The accepted arc as composition-plan sections covering [0, length]: a gap
 * between ranges is held as its own section, a range too short for the
 * provider is folded into its neighbour, one too long is split.
 */
function arcSections(ranges, lengthMs, limits, prompt) {
    const min = Number(limits && limits.section_min_ms), max = Number(limits && limits.section_max_ms);
    if (!(min > 0 && max > 0) || !ranges.length || lengthMs < min) return null;
    const spans = [];
    let cursor = 0;
    for (const r of ranges) {
        const s = Math.max(cursor, Math.min(lengthMs, r.start_ms)), e = Math.min(lengthMs, r.end_ms);
        if (s > cursor) spans.push({ start: cursor, end: s, label: 'hold', r: null });
        if (e > s) spans.push({ start: s, end: e, label: r.label, r });
        cursor = Math.max(cursor, e);
    }
    if (cursor < lengthMs) spans.push({ start: cursor, end: lengthMs, label: 'hold', r: null });
    // Fold anything under the provider's minimum into its neighbour.
    for (let i = 0; i < spans.length; i++) {
        if (spans[i].end - spans[i].start >= min || spans.length === 1) continue;
        const into = i > 0 ? i - 1 : i + 1;
        spans[into] = { ...spans[into], start: Math.min(spans[into].start, spans[i].start), end: Math.max(spans[into].end, spans[i].end) };
        spans.splice(i, 1); i = -1;
    }
    const out = [];
    for (const sp of spans) {
        let len = sp.end - sp.start;
        const pieces = Math.ceil(len / max);
        for (let k = 0; k < pieces; k++) {
            const d = k === pieces - 1 ? len - Math.floor(len / pieces) * (pieces - 1) : Math.floor(len / pieces);
            const feel = sp.r ? `${sp.label} (valence ${sp.r.valence}, arousal ${sp.r.arousal}, intensity ${sp.r.intensity})` : 'hold the previous feeling';
            out.push({ section_name: sp.label, direction: `${feel}: ${prompt}`, duration_ms: d, positive_local_styles: sp.r ? [sp.label] : [], negative_local_styles: [] });
        }
    }
    return out;
}

function arcText(ranges) {
    return ranges.map(r => `${Math.round(r.start_ms / 1000)}–${Math.round(r.end_ms / 1000)}s ${r.label}`).join('; ');
}

// ── Inputs ─────────────────────────────────────────────────────────────────

function assetInProject(db, projectId, id) {
    const a = id ? db.prepare('SELECT * FROM film_assets WHERE id = ? AND project_id = ?').get(id, projectId) : null;
    if (!a) return { error: refuse(404, `asset ${id || '(none)'} not found in this project`) };
    const p = resolveStored(a.file_path);
    if (!p || !fs.existsSync(p)) return { error: refuse(409, `the file for ${a.file_name || a.id} is not on disk; it is missing, so there is nothing to send`) };
    return { asset: a, path: p };
}

function ownedTrack(db, sessionId, trackId) {
    return db.prepare('SELECT * FROM film_music_tracks WHERE id = ? AND session_id = ?').get(trackId, sessionId);
}

// ── The free plan ──────────────────────────────────────────────────────────

/**
 * What a generation would do, for nothing. A refusal carries an HTTP `status`,
 * a `code` where one applies, and the reason.
 */
function planGeneration(db, sessionId, workflow, input, opts) {
    const i = input || {};
    const o = opts || {};
    const session = db.prepare('SELECT * FROM film_music_sessions WHERE id = ?').get(sessionId);
    if (!session) return refuse(404, 'Score session not found');
    if (workflow === 'music_separate') return refuse(400, 'separation is a derivative of a recording, not a generation: plan it with music_separate_plan', { code: 'WRONG_WORKFLOW' });
    if (!GENERATE_WORKFLOWS.includes(workflow)) return refuse(400, `${workflow || '(none)'} is not a generating workflow; the five are ${GENERATE_WORKFLOWS.join(', ')}`, { code: 'UNKNOWN_WORKFLOW' });

    const project = db.prepare('SELECT id, provider_config FROM film_projects WHERE id = ?').get(session.project_id);
    const config = providerConfigOf(project);
    const p = providerDecl(workflow, config, o.adapter);
    if (p.refusal) return p.refusal;
    const limits = p.decl.limits || {};

    // The arc: accepted only, or none on purpose.
    const warnings = [];
    const gate = emotionForGeneration(db, sessionId);
    const ignoreEmotion = i.ignore_emotion === true || i.ignore_emotion === 'true' || i.ignore_emotion === 1;
    if (!gate.ok && !ignoreEmotion) return refuse(409, gate.error, { code: gate.code, pending: gate.pending.length });
    const ranges = gate.ok && !ignoreEmotion ? gate.accepted.map(r => ({ start_ms: r.start_ms, end_ms: r.end_ms, label: r.label, valence: r.valence, arousal: r.arousal, intensity: r.intensity })) : [];
    if (!ranges.length) warnings.push(gate.ok ? 'generating without the accepted arc, as asked' : 'no accepted emotional arc: generating without one, as asked (ignore_emotion)');
    if (gate.pending && gate.pending.length) warnings.push(`${gate.pending.length} proposed emotion range(s) are not accepted and do not reach this request`);

    const tempo = tempoOf(session);
    const context = {
        tempo_bpm: Number(i.tempo_bpm) > 0 ? Number(i.tempo_bpm) : tempo.tempo_bpm,
        time_signature: tempo.time_signature,
        key: i.key ? String(i.key) : null,
        emotion: ranges,
        sample_rate: session.sample_rate,
    };
    if (tempo.tempo_changes) warnings.push(`the session's tempo map changes ${tempo.tempo_changes} time(s); only the opening tempo is sent, since no provider takes a map`);

    // What is being made from, and where it lands.
    const sources = {};
    let placement = null;
    let durationMs = null;
    if (workflow === 'music_inpaint') {
        const clip = i.clip_id ? db.prepare(`SELECT c.* FROM film_music_clips c JOIN film_music_tracks t ON t.id = c.track_id WHERE c.id = ? AND t.session_id = ?`).get(i.clip_id, sessionId) : null;
        if (!clip) return refuse(404, 'Clip not found in this session');
        if (!clip.asset_id) return refuse(409, `the clip '${clip.name || clip.id}' has no audio to inpaint`);
        const src = assetInProject(db, session.project_id, clip.asset_id);
        if (src.error) return src.error;
        const r = i.range || {};
        const s = Number(r.start_ms), e = Number(r.end_ms);
        if (!(Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e > s)) return refuse(400, 'range must be { start_ms, end_ms } inside the clip, with end_ms after start_ms', { field: 'range' });
        if (e > clip.duration_ms) return refuse(400, `the range ends at ${e} ms, past the end of the clip (${clip.duration_ms} ms); a range is measured inside the clip`, { field: 'range' });
        sources.source = { asset: src.asset, path: src.path, clip };
        sources.range = { start_ms: clip.source_offset_ms + s, end_ms: clip.source_offset_ms + e };
        durationMs = e - s;
        placement = { track_id: clip.track_id, start_ms: clip.start_ms + s, duration_ms: e - s, new_track: false, take_group: clip.take_group || `takes:${clip.id}` };
    } else {
        const len = Number(i.duration_ms) > 0 ? { ms: Number(i.duration_ms), source: 'asked for' } : lengthOf(db, sessionId);
        if (!(len.ms > 0)) return refuse(400, 'duration_ms is required: the session has no picture and no arrangement to measure a length from', { field: 'duration_ms' });
        durationMs = len.ms;
        if (workflow === 'music_reference') {
            const ref = assetInProject(db, session.project_id, i.reference_asset_id);
            if (ref.error) return ref.error;
            if (!detectFormat(fs.readFileSync(ref.path))) return refuse(400, `the reference ${ref.asset.file_name} is not audio a provider can read`, { field: 'reference_asset_id' });
            sources.reference = ref;
            if (limits.max_reference_ms && Number(ref.asset.duration_ms) > limits.max_reference_ms) return refuse(400, `the reference runs ${ref.asset.duration_ms} ms, over ${p.id}'s max_reference_ms ${limits.max_reference_ms}`, { field: 'reference_asset_id' });
        }
        if (workflow === 'music_video') {
            const pic = assetInProject(db, session.project_id, i.video_asset_id);
            if (pic.error) return pic.error;
            if (!VIDEO_TYPES.has(pic.asset.asset_type)) return refuse(400, `${pic.asset.file_name} is ${pic.asset.asset_type}, not a picture: video_asset_id must be a clip or the conformed film`, { field: 'video_asset_id' });
            if (Array.isArray(limits.video_formats) && limits.video_formats.length && !limits.video_formats.includes(String(pic.asset.format || '').toLowerCase())) return refuse(400, `${p.id} takes video as ${limits.video_formats.join(', ')}, not ${pic.asset.format}`, { field: 'video_asset_id' });
            sources.video = pic;
        }
        if (i.track_id) {
            const t = ownedTrack(db, sessionId, i.track_id);
            if (!t) return refuse(404, 'Track not found in this session');
            placement = { track_id: t.id, start_ms: Number(i.start_ms) || 0, duration_ms: durationMs, new_track: false };
        } else {
            placement = { track_id: null, start_ms: Number(i.start_ms) || 0, duration_ms: durationMs, new_track: true };
        }
    }

    const v = caps.validatePlan(workflow, { session_id: sessionId, ...i, duration_ms: workflow === 'music_inpaint' ? undefined : durationMs }, p.decl);
    if (!v.ok) return refuse(400, v.errors.map(e => e.message).join('; '), { errors: v.errors });

    const kind = caps.WORKFLOWS[workflow].output_kind;
    const count = workflow === 'music_parts' ? i.parts.length : 1;
    const sections = workflow === 'music_compose' ? arcSections(ranges, durationMs, limits, String(i.prompt || '')) : null;
    const cost = caps.costHint(p.id, workflow, p.decl);
    const seconds = durationMs / 1000;
    return {
        ok: true, free: true, writes_nothing: true, workflow,
        provider: { id: p.id, model: i.model || p.decl.default_model || (Array.isArray(p.decl.models) && p.decl.models[0]) || null, resolved: p.resolved, note: p.note },
        duration_ms: durationMs,
        outputs: { kind, source_kind: caps.OUTPUT_KINDS[kind].source_kind, count, what: caps.OUTPUT_KINDS[kind].what,
            parts: workflow === 'music_parts' ? i.parts.map(x => (typeof x === 'string' ? x : x.role)) : undefined },
        context, sections,
        sources: {
            reference: sources.reference ? { asset_id: sources.reference.asset.id, file_name: sources.reference.asset.file_name, kind: i.reference_kind } : undefined,
            video: sources.video ? { asset_id: sources.video.asset.id, file_name: sources.video.asset.file_name } : undefined,
            source: sources.source ? { asset_id: sources.source.asset.id, clip_id: sources.source.clip.id, range: sources.range } : undefined,
        },
        placement,
        limits,
        cost_hint: cost.hint ? { usd: Math.round(cost.hint.usd_per_unit * seconds * count * 1e6) / 1e6, seconds: seconds * count, ...cost.hint } : null,
        cost_note: cost.note,
        takes: TAKES,
        warnings,
        _sources: sources, _input: i,
    };
}

function publicPlan(plan) {
    if (!plan || !plan.ok) return plan;
    const { _sources, _input, ...rest } = plan;
    return rest;
}

// ── The run ────────────────────────────────────────────────────────────────

function dropFiles(paths) {
    for (const x of paths) { try { fs.unlinkSync(x); } catch (_) { /* already gone */ } }
}

function fileOf(src) {
    return { bytes: fs.readFileSync(src.path), name: src.asset.file_name || path.basename(src.path), mime: src.asset.mime_type || 'application/octet-stream' };
}

/**
 * Generate. Returns `{ ok, operation_id, outputs: [{ asset_id, track_id, clip_id, url, role }], warnings }`,
 * or a refusal, or `{ ok: false, status: 'failed', operation_id, error }`.
 */
async function generate(db, sessionId, workflow, input, opts) {
    const o = opts || {};
    const plan = planGeneration(db, sessionId, workflow, input, o);
    if (!plan.ok) return plan;
    const i = plan._input;
    const session = db.prepare('SELECT * FROM film_music_sessions WHERE id = ?').get(sessionId);
    const project = db.prepare('SELECT id, provider_config FROM film_projects WHERE id = ?').get(session.project_id);
    const adapter = o.adapter || musicProviderFor(providerConfigOf(project));

    // One parent, one child per expected output (MUS-013): the parent's status
    // is derived from its children, so a failed output cannot leave it complete.
    const srcOf = plan._sources.source || plan._sources.reference || plan._sources.video || null;
    const sourceFingerprint = srcOf ? crypto.createHash('sha256').update(fs.readFileSync(srcOf.path)).digest('hex') : '';
    const contextFingerprint = contextFingerprintOf(db, sessionId, plan.context);
    const labels = workflow === 'music_parts' ? plan.outputs.parts.slice() : [workflow.replace('music_', '')];
    const operationId = jobs.openJob(db, sessionId, {
        kind: 'generate', provider: plan.provider.id || '', model: plan.provider.model || '', live: true,
        parent_id: o.parent_id || null, attempt: o.attempt || 1, expected: labels.length,
        source_asset_id: srcOf ? srcOf.asset.id : null, source_fingerprint: sourceFingerprint, context_fingerprint: contextFingerprint,
        params: { workflow, input: i, prompt: i.prompt || '', context: plan.context, placement: plan.placement, outputs_expected: plan.outputs, sections: plan.sections, ignore_emotion: !plan.context.emotion.length },
    });
    const childIds = labels.map((label, seq) => jobs.addChild(db, operationId, { seq, label }));
    try {
        return await runGeneration();
    } finally {
        jobs.release(operationId);
    }

    async function runGeneration() {
    /*
     * A failure fails the children it belongs to and cancels the rest — none
     * of them is registered, because registration is all or nothing — and the
     * parent is rolled up from them, so its reason names the child.
     */
    const fail = (error, status, bad) => {
        for (const c of jobs.childrenOf(db, operationId).filter(k => k.status === 'running' || k.status === 'planned')) {
            if (!bad) jobs.settleChild(db, c.id, { status: 'failed', error });
            else if (c.seq === bad.seq) jobs.settleChild(db, c.id, { status: 'failed', error: bad.error || error });
            else jobs.settleChild(db, c.id, { status: 'cancelled', error: `not registered: ${labels[bad.seq] || 'an output'} (#${bad.seq}) failed` });
        }
        jobs.rollup(db, operationId, { error });
        return { ok: false, status: 'failed', http_status: status || 502, operation_id: operationId, error };
    };
    if (!adapter || typeof adapter.generate !== 'function') return fail(`no music provider could be resolved for ${plan.provider.id || 'this project'}`, 409);

    const ctx = plan.context;
    const described = [i.prompt, ctx.tempo_bpm ? `${ctx.tempo_bpm} BPM` : null, ctx.time_signature ? `in ${ctx.time_signature}` : null, ctx.key ? `in ${ctx.key}` : null,
        ctx.emotion.length ? `emotional arc: ${arcText(ctx.emotion)}` : null].filter(Boolean).join('. ');
    const payload = {
        workflow, prompt: described, model: plan.provider.model || undefined,
        duration_ms: plan.duration_ms, duration_s: plan.duration_ms / 1000,
        tempo_bpm: ctx.tempo_bpm, time_signature: ctx.time_signature, key: ctx.key, emotion: ctx.emotion,
    };
    if (plan.sections) payload.composition_plan = { positive_global_styles: [], negative_global_styles: [], sections: plan.sections };
    if (workflow === 'music_parts') payload.parts = i.parts;
    if (plan._sources.reference) { payload.reference = fileOf(plan._sources.reference); payload.reference_kind = i.reference_kind; }
    if (plan._sources.video) payload.video = fileOf(plan._sources.video);
    if (plan._sources.source) {
        payload.source = fileOf(plan._sources.source);
        payload.range = plan._sources.range;
        // How much surrounding audio the provider reads, from its own declared limit.
        payload.context_ms = Number(plan.limits.context_ms) || 0;
    }

    let result;
    try { result = await adapter.generate('music', payload); }
    catch (e) { return fail(`${plan.provider.id}: ${e.message}`); }
    if (!result || !result.ok) return fail((result && result.error) || `${plan.provider.id} returned nothing`, result && result.status === 401 ? 401 : 502);

    const pieces = workflow === 'music_parts'
        ? (Array.isArray(result.parts) ? result.parts : [])
        : [{ role: null, data: result.data }];
    if (!pieces.length) return fail(`${plan.provider.id} returned no parts`);
    if (pieces.length < labels.length) {
        const missing = pieces.length;
        return fail(`${plan.provider.id} returned ${pieces.length} of the ${labels.length} parts asked for; nothing was registered`, 502, { seq: missing, error: `${plan.provider.id} returned no ${labels[missing]}` });
    }
    // More than was asked for: each extra is a child of its own, named.
    for (let k = labels.length; k < pieces.length; k++) {
        const role = pieces[k].role || `extra ${k + 1}`;
        labels.push(role); childIds.push(jobs.addChild(db, operationId, { seq: k, label: role }));
        plan.warnings.push(`${plan.provider.id} returned ${role}, which was not asked for; it is registered and named`);
    }

    const kind = caps.WORKFLOWS[workflow].output_kind;
    const media = MEDIA_KINDS.music;
    const written = [];
    const staged = [];
    try {
        for (const [n, piece] of pieces.entries()) {
            const bytes = Buffer.isBuffer(piece.data) ? piece.data : Buffer.from(piece.data || []);
            const fmt = detectFormat(bytes);
            const label = piece.role || workflow.replace('music_', '');
            if (!fmt) { dropFiles(written); const why = `${plan.provider.id} returned something that is not audio for ${label}; nothing was registered`; return fail(why, 502, { seq: n, error: why }); }
            const spec = STEM_FORMATS[fmt];
            const assetId = generateId();
            const fileName = `${workflow.replace('music_', '')}_${String(label).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_${assetId.slice(0, 8)}.${spec.ext}`;
            const filePath = saveFile(session.project_id, media.subdir, fileName, bytes);
            written.push(filePath);
            const seen = inspectStem(filePath, spec);
            if (!seen.ok) { dropFiles(written); const why = `${label}: ${seen.error}; nothing was registered`; return fail(why, 502, { seq: n, error: why }); }
            staged.push({ n, role: piece.role || null, bytes, fmt, spec, assetId, fileName, filePath, tech: seen.tech, hash: crypto.createHash('sha256').update(bytes).digest('hex') });
        }
    } catch (e) {
        dropFiles(written);
        return fail(`the output could not be written: ${e.message}; nothing was registered`);
    }

    const outputs = [];
    const derivedFrom = (plan._sources.source && plan._sources.source.asset.id) || (plan._sources.reference && plan._sources.reference.asset.id) || (plan._sources.video && plan._sources.video.asset.id) || null;
    const register = db.transaction(() => {
        let order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM film_music_tracks WHERE session_id = ?').get(sessionId).m + 1;
        const newTrack = (name, role) => {
            const tv = VALIDATORS.film_music_tracks({ name, role_kind: 'instrument', role, sort_order: order++ });
            if (!tv.ok) throw new Error(tv.errors.map(e => e.message).join('; '));
            const t = toRow('film_music_tracks', tv.value);
            const id = generateId();
            db.prepare(`INSERT INTO film_music_tracks (id, session_id, name, role_kind, role, sort_order, color, gain_db, pan, muted, soloed, output_track_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(id, sessionId, t.name, t.role_kind, t.role, t.sort_order, t.color, t.gain_db, t.pan, t.muted, t.soloed, t.output_track_id);
            return id;
        };
        // One take group per existing track: a new take is an alternative to what it already holds.
        const groupFor = (trackId) => {
            const held = db.prepare("SELECT take_group FROM film_music_clips WHERE track_id = ? AND take_group != '' LIMIT 1").get(trackId);
            const g = held ? held.take_group : `takes:${trackId}`;
            db.prepare("UPDATE film_music_clips SET take_group = ? WHERE track_id = ? AND take_group = ''").run(g, trackId);
            return g;
        };
        if (workflow === 'music_inpaint') {
            const src = plan._sources.source.clip;
            if (!src.take_group) db.prepare("UPDATE film_music_clips SET take_group = ? WHERE id = ? AND take_group = ''").run(plan.placement.take_group, src.id);
        }
        for (const s of staged) {
            let trackId, takeGroup = '', takeStatus = 'selected';
            if (workflow === 'music_parts') trackId = newTrack(s.role || `part ${s.n + 1}`, s.role || '');
            else if (workflow === 'music_inpaint') { trackId = plan.placement.track_id; takeGroup = plan.placement.take_group; takeStatus = 'candidate'; }
            else if (plan.placement.new_track) trackId = newTrack(workflow.replace('music_', ''), 'score');
            else { trackId = plan.placement.track_id; takeGroup = groupFor(trackId); takeStatus = 'candidate'; }

            const clipId = generateId();
            const meta = {
                kind, workflow, operation_id: operationId, session_id: sessionId, track_id: trackId, clip_id: clipId, role: s.role,
                derived_from: derivedFrom, context: plan.context, provider: plan.provider.id, model: result.provider_model || plan.provider.model || null,
                format: s.fmt, lossless: s.spec.lossless, hash: s.hash, tech: s.tech,
            };
            db.prepare(`INSERT INTO film_assets (id, project_id, asset_type, file_path, file_name, format, mime_type, size_bytes, duration_ms, metadata, license_source, license_status, provider)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generated', 'unknown', ?)`)
                .run(s.assetId, session.project_id, media.assetType, s.filePath, s.fileName, s.spec.ext, s.spec.mime, s.bytes.length, s.tech.duration_ms, JSON.stringify(meta), plan.provider.id || '');
            const length = workflow === 'music_inpaint' ? Math.min(plan.placement.duration_ms, s.tech.duration_ms) : s.tech.duration_ms;
            const cv = VALIDATORS.film_music_clips({
                name: s.role || workflow.replace('music_', ''), asset_id: s.assetId, source_operation_id: operationId,
                source_kind: caps.OUTPUT_KINDS[kind].source_kind, start_ms: plan.placement.start_ms, duration_ms: length, source_offset_ms: 0,
                take_group: takeGroup, take_status: takeStatus,
            });
            if (!cv.ok) throw new Error(cv.errors.map(e => e.message).join('; '));
            const c = toRow('film_music_clips', cv.value);
            db.prepare(`INSERT INTO film_music_clips (id, track_id, asset_id, source_operation_id, name, source_kind, start_ms, duration_ms, source_offset_ms, gain_db, fade_in_ms, fade_out_ms, loop_policy, warp_policy, take_group, take_status)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(clipId, trackId, c.asset_id, c.source_operation_id, c.name, c.source_kind, c.start_ms, c.duration_ms, c.source_offset_ms,
                    c.gain_db, c.fade_in_ms, c.fade_out_ms, c.loop_policy, c.warp_policy, c.take_group, c.take_status);
            // The take number is this clip's place in its take group, counting what the group already held.
            const takeNumber = takeGroup ? db.prepare('SELECT COUNT(*) AS n FROM film_music_clips WHERE take_group = ? AND track_id = ?').get(takeGroup, trackId).n : 1;
            jobs.settleChild(db, childIds[s.n], {
                status: 'complete', output_asset_id: s.assetId, output_clip_id: clipId, take_number: takeNumber,
                job_ref: result.provider_job_id || '', model: result.provider_model || plan.provider.model || '',
                cost_usd: plan.cost_hint && plan.cost_hint.usd ? plan.cost_hint.usd / staged.length : 0,
            });
            outputs.push({ asset_id: s.assetId, track_id: trackId, clip_id: clipId, role: s.role, take_status: takeStatus, take_group: takeGroup, take_number: takeNumber,
                source_kind: c.source_kind, url: getFileUrl(media.serveDir, session.project_id, s.fileName), duration_ms: s.tech.duration_ms, hash: s.hash });
        }
        jobs.rollup(db, operationId, { params: { outputs, warnings: plan.warnings }, job_ref: result.provider_job_id || '' });
    });
    try { register(); } catch (e) {
        dropFiles(written);
        return fail(`the output could not be registered: ${e.message}; nothing was recorded`);
    }
    return { ok: true, status: 'complete', operation_id: operationId, workflow, outputs, warnings: plan.warnings };
    }
}

/** A fingerprint of the context actually SENT, bound to the session brief it came from. */
function contextFingerprintOf(db, sessionId, sent) {
    let brief = null;
    try { const c = compileScoreContext(db, { sessionId }); brief = c && c.fingerprints ? c.fingerprints.context : null; } catch (_) { brief = null; }
    return crypto.createHash('sha256').update(JSON.stringify({ brief, sent })).digest('hex');
}

// ── Reading ────────────────────────────────────────────────────────────────

function present(row) {
    const op = fromRow('film_music_operations', row);
    const p = op.params || {};
    return {
        operation_id: row.id, session_id: row.session_id, status: row.status, workflow: p.workflow || null,
        provider: row.provider, model: row.model, source_asset_id: row.source_asset_id,
        outputs: p.outputs || [], warnings: p.warnings || [], context: p.context || null, placement: p.placement || null,
        cost_usd: row.cost_usd, error_message: row.error_message, started_at: row.started_at, completed_at: row.completed_at,
    };
}

function listGenerations(db, sessionId) {
    return db.prepare("SELECT * FROM film_music_operations WHERE session_id = ? AND kind = 'generate' AND group_id IS NULL ORDER BY created_at DESC, rowid DESC").all(sessionId).map(present);
}

function getGeneration(db, sessionId, opId) {
    const row = db.prepare("SELECT * FROM film_music_operations WHERE id = ? AND session_id = ? AND kind = 'generate' AND group_id IS NULL").get(opId, sessionId);
    return row ? present(row) : null;
}

module.exports = { GENERATE_WORKFLOWS, TAKES, planGeneration, publicPlan, generate, listGenerations, getGeneration, arcSections, musicProviderFor };
