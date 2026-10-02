'use strict';

/**
 * In-betweens between two key shots, over HTTP.
 *
 *   GET    /film/projects/:id/inbetweens           every span in the project
 *   POST   /film/projects/:id/inbetweens           { from_shot_id, to_shot_id, gap_s?, count? | every_s? } (free)
 *   GET    /film/inbetweens/:id                    the span: keys, frames with their pictures, ranges, approval
 *   PUT    /film/inbetweens/:id                    { gap_s?, count? | every_s?, frames?, ranges? } (free)
 *   DELETE /film/inbetweens/:id                    the span; its pictures stay on disk and in the asset list
 *   GET    /film/inbetweens/:id/generate           FREE: what generating frames would send and cost
 *   POST   /film/inbetweens/:id/generate           { from_index?, only? } SPENDS: each frame from the one before it
 *   POST   /film/inbetweens/:id/frames/:i/select   { asset_id } which take of a frame is used
 *   POST   /film/inbetweens/:id/approve            sign off the strip
 *   GET    /film/inbetweens/:id/video              FREE: what the clip would send and cost
 *   POST   /film/inbetweens/:id/video              SPENDS: the clip from 1A through every frame to 1B
 *
 * Pure decisions live in lib/inbetween-span.js; this reads rows, buys pictures
 * and footage through the one image funnel and the video adapter, and files them.
 */

const fs = require('fs');
const path = require('path');
const { db, generateId } = require('../db/database');
const span_ = require('../lib/inbetween-span');

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}
function fail(res, err) {
    return json(res, err.status || 500, { error: err.code || 'INBETWEENS_FAILED', message: err.message,
        ...(err.field ? { field: err.field } : {}) });
}
const parse = (t, f) => { try { const v = JSON.parse(t || ''); return v == null ? f : v; } catch (_) { return f; } };
const secs = ms => (Math.round(Number(ms) / 100) / 10).toFixed(1);

/** A shot's selected board frame: the pointer, else the newest. */
function keyFrame(shotId) {
    const shot = db.prepare('SELECT id, shot_code, current_frame_version, duration_ms, scene_card_yaml FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return null;
    const rows = db.prepare(`SELECT id, file_path, file_name, version, project_id FROM film_assets
        WHERE shot_id = ? AND asset_type IN ('storyboard', 'keyframe') ORDER BY version DESC, created_at DESC`).all(shotId);
    const chosen = (shot.current_frame_version && rows.find(r => r.version === shot.current_frame_version)) || rows[0] || null;
    return { shot, frame: chosen && chosen.file_path && fs.existsSync(chosen.file_path) ? chosen : null };
}

function shotLength(shot) {
    const card = parse(shot && shot.scene_card_yaml, {});
    return Number(shot && shot.duration_ms) || Number(card.duration_ms) || 5000;
}

/** Every take of every frame of a span, newest first. */
function frameAssets(row) {
    return db.prepare(`SELECT id, file_path, file_name, metadata, created_at FROM film_assets
        WHERE project_id = ? AND json_extract(metadata, '$.kind') = 'inbetween_frame'
          AND json_extract(metadata, '$.inbetween_id') = ? ORDER BY created_at DESC, rowid DESC`).all(row.project_id, row.id)
        .map(a => ({ ...a, meta: parse(a.metadata, {}) }));
}

function urlOf(projectId, a) {
    return a ? require('../lib/file-storage').getFileUrl('storyboards', projectId, a.file_name) : null;
}

/** The span as one object: what lib/inbetween-span reasons over, plus what is on disk. */
function load(id) {
    const row = db.prepare('SELECT * FROM film_inbetweens WHERE id = ?').get(id);
    if (!row) return null;
    const from = keyFrame(row.from_shot_id), to = keyFrame(row.to_shot_id);
    const stored = parse(row.frames_json, []);
    const takes = frameAssets(row);
    const frames = stored.map((f, i) => {
        const here = takes.filter(t => Number(t.meta.at_ms) === f.at_ms);
        const picked = (f.asset_id && here.find(t => t.id === f.asset_id)) || here[0] || null;
        return { index: i, at_ms: f.at_ms, direction: f.direction || '', asset_id: picked ? picked.id : null,
            image_path: picked ? picked.file_path : null, url: urlOf(row.project_id, picked),
            takes: here.map(t => ({ asset_id: t.id, url: urlOf(row.project_id, t), created_at: t.created_at,
                direction: t.meta.direction || '', selected: picked && t.id === picked.id })) };
    });
    const span = {
        id: row.id, project_id: row.project_id, gap_ms: row.gap_ms,
        from_shot_id: row.from_shot_id, to_shot_id: row.to_shot_id,
        from_code: from && from.shot ? from.shot.shot_code : '?', to_code: to && to.shot ? to.shot.shot_code : '?',
        frames, ranges: parse(row.ranges_json, []),
    };
    const fp = span_.spanFingerprint(span, frames.map(f => f.asset_id));
    return {
        row, span, from, to,
        approval: row.approved_fingerprint
            ? { approved: true, stale: row.approved_fingerprint !== fp, approved_at: row.approved_at }
            : { approved: false, stale: false },
        fingerprint: fp,
    };
}

function present(l) {
    const { span, from, to, row } = l;
    const key = (k, at) => ({ shot_id: k && k.shot ? k.shot.id : null, shot_code: k && k.shot ? k.shot.shot_code : null,
        at_ms: at, url: k && k.frame ? require('../lib/file-storage').getFileUrl('storyboards', row.project_id, k.frame.file_name) : null,
        has_frame: !!(k && k.frame) });
    return {
        id: span.id, project_id: span.project_id, gap_ms: span.gap_ms,
        from: key(from, 0), to: key(to, span.gap_ms),
        frames: span.frames, ranges: span.ranges, lanes: span_.LANES,
        made: span.frames.filter(f => f.asset_id).length,
        approval: l.approval, fingerprint: l.fingerprint,
        clip_asset_id: row.clip_asset_id || null,
        limits: { max_frames: span_.MAX_FRAMES, max_ranges: span_.MAX_RANGES },
    };
}

/** Frames to keep when the count changes: the new moments, each keeping the direction nearest it. */
function respace(oldFrames, times) {
    return times.map(at => {
        const near = oldFrames.reduce((b, f) => (!b || Math.abs(f.at_ms - at) < Math.abs(b.at_ms - at) ? f : b), null);
        return { at_ms: at, direction: near && Math.abs(near.at_ms - at) < 250 ? (near.direction || '') : '' };
    });
}

function create(req, res, projectId) {
    const b = req.body || {};
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });
    const shotIn = id => db.prepare(`SELECT sh.* FROM film_shots sh JOIN film_scenes s ON s.id = sh.scene_id
        WHERE sh.id = ? AND s.project_id = ?`).get(id, projectId);
    const a = shotIn(b.from_shot_id), z = shotIn(b.to_shot_id);
    if (!a || !z) return json(res, 400, { error: 'from_shot_id and to_shot_id must be two shots of this project' });
    if (a.id === z.id) return json(res, 400, { error: 'An in-between joins two different shots' });
    const existing = db.prepare('SELECT id FROM film_inbetweens WHERE from_shot_id = ? AND to_shot_id = ?').get(a.id, z.id);
    if (existing) return json(res, 409, { error: 'EXISTS', message: `${a.shot_code} → ${z.shot_code} already has in-betweens`, ...present(load(existing.id)) });
    try {
        const gap = b.gap_s != null ? Math.round(Number(b.gap_s) * 1000) : shotLength(a);
        if (!(gap > 0)) throw Object.assign(new Error('gap_s must be more than zero'), { status: 400 });
        const count = b.every_s != null ? span_.countForEvery(gap, Number(b.every_s) * 1000) : (b.count != null ? Number(b.count) : 4);
        const frames = span_.validateFrames(span_.evenTimes(gap, count).map(at => ({ at_ms: at, direction: '' })), gap);
        const id = generateId();
        db.prepare(`INSERT INTO film_inbetweens (id, project_id, from_shot_id, to_shot_id, gap_ms, frames_json)
            VALUES (?, ?, ?, ?, ?, ?)`).run(id, projectId, a.id, z.id, gap, JSON.stringify(frames));
        return json(res, 201, present(load(id)));
    } catch (err) { return fail(res, err); }
}

function update(req, res, id) {
    const l = load(id);
    if (!l) return json(res, 404, { error: 'In-betweens not found' });
    const b = req.body || {};
    try {
        const gap = b.gap_s != null ? Math.round(Number(b.gap_s) * 1000) : l.row.gap_ms;
        if (!(gap > 0)) throw Object.assign(new Error('gap_s must be more than zero'), { status: 400, field: 'gap_s' });
        let frames = parse(l.row.frames_json, []);
        if (Array.isArray(b.frames)) frames = b.frames;
        else if (b.every_s != null || b.count != null || gap !== l.row.gap_ms) {
            const count = b.every_s != null ? span_.countForEvery(gap, Number(b.every_s) * 1000)
                : (b.count != null ? Number(b.count) : frames.length);
            frames = respace(frames.map(f => ({ ...f, at_ms: Math.round(f.at_ms * gap / l.row.gap_ms) })), span_.evenTimes(gap, count));
        }
        // A take chosen for a frame stays chosen while the frame stays at its moment.
        const kept = new Map(parse(l.row.frames_json, []).map(f => [f.at_ms, f.asset_id]));
        frames = span_.validateFrames(frames, gap).map(f => ({ ...f, ...(kept.get(f.at_ms) ? { asset_id: kept.get(f.at_ms) } : {}) }));
        const ranges = Array.isArray(b.ranges) ? span_.validateRanges(b.ranges, gap)
            : span_.validateRanges(parse(l.row.ranges_json, []).filter(r => r.end_ms <= gap), gap);
        db.prepare(`UPDATE film_inbetweens SET gap_ms = ?, frames_json = ?, ranges_json = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(gap, JSON.stringify(frames), JSON.stringify(ranges), id);
        return json(res, 200, present(load(id)));
    } catch (err) { return fail(res, err); }
}

/** What one image costs on the project's image generator, or null when it cannot be worked out. */
function imagePrice(projectId) {
    try {
        const { resolve } = require('../lib/providers');
        const { providerConfigFor } = require('../lib/provider-config');
        const adapter = resolve('image', providerConfigFor(projectId));
        if (!adapter || typeof adapter.meter !== 'function') return null;
        const u = adapter.meter('image', {}, null);
        const p = u && require('../lib/provider-pricing').priceUsage({ provider: adapter.id, capability: 'image', ...u });
        return p && p.priced ? { usd: Number(p.amount_usd.toFixed(3)), provider: adapter.id, model: u.model || null } : null;
    } catch (_) { return null; }
}

function generatePlan(l, q) {
    const { span } = l;
    const only = q.only === true || q.only === 'true' || q.only === '1';
    const run = span_.framesToRun(span.frames.length, q.from_index != null ? Number(q.from_index) : 0, only);
    const price = imagePrice(span.project_id);
    const blockers = [];
    if (!l.from || !l.from.frame) blockers.push(`${span.from_code} has no board frame yet; in-betweens start from the picture you approved.`);
    if (!l.to || !l.to.frame) blockers.push(`${span.to_code} has no board frame yet; the frames are drawn toward it.`);
    if (!span.frames.length) blockers.push('There are no frames to make; set how many first.');
    const frames = run.map(i => ({
        index: i, at_ms: span.frames[i].at_ms,
        instruction: span_.frameInstruction(span, i),
        references: [i === 0 ? `${span.from_code} (board frame)` : `in-between at ${secs(span.frames[i - 1].at_ms)} s`,
            `${span.to_code} (board frame)`],
        replaces_take: !!span.frames[i].asset_id,
    }));
    return {
        id: span.id, spends: frames.length > 0, frames, count: frames.length,
        chain: !only && run.length > 1,
        note: only
            ? 'Only this frame is made. The frames after it keep their pictures.'
            : 'Each frame is made from the one before it, so later frames follow the change.',
        price_each: price, estimated_usd: price ? Number((price.usd * frames.length).toFixed(2)) : null,
        blockers, ready: !blockers.length && frames.length > 0,
        prompt: frames[0] ? frames[0].instruction : '',
        provider: price && price.provider, model: price && price.model,
    };
}

async function generate(req, res, id) {
    const l = load(id);
    if (!l) return json(res, 404, { error: 'In-betweens not found' });
    const b = req.body || {};
    const plan = generatePlan(l, b);
    if (!plan.ready) return json(res, 409, { error: 'NOT_READY', message: plan.blockers.join(' ') || 'Nothing to make.', plan });
    const { callImageGen, ensureStoryboardDir } = require('./storyboard');
    const { spendContext } = require('../lib/provider-config');
    const { imageOverride } = require('../lib/generation-override');
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(l.row.project_id);
    const shot = l.from.shot;
    const { span } = l;
    const dir = ensureStoryboardDir(project.id);
    const made = [];
    let previous = plan.frames[0].index === 0 ? l.from.frame.file_path : span.frames[plan.frames[0].index - 1].image_path;
    if (!previous) return json(res, 409, { error: 'NOT_READY', message: `The frame before ${secs(span.frames[plan.frames[0].index].at_ms)} s has no picture yet; make it first.` });
    for (const f of plan.frames) {
        try {
            const payload = {
                prompt: f.instruction,
                negative_prompt: 'different location, different person, different wardrobe, different lighting, copied composition of the second picture',
                reference_images: [{ uri: null, path: previous, name: 'before' }, { uri: null, path: l.to.frame.file_path, name: span.to_code }],
                aspect_ratio: project.aspect_ratio,
            };
            const { buffer, provider, model } = await callImageGen(payload.prompt, payload.negative_prompt, undefined, payload,
                spendContext(project, shot, null, imageOverride(b)));
            const stamp = Date.now().toString(36);
            const fileName = `${span.from_code}-${span.to_code}.ib${String(f.index + 1).padStart(2, '0')}.${stamp}.png`;
            const filePath = path.join(dir, fileName);
            fs.writeFileSync(filePath, buffer);
            const assetId = generateId();
            const fr = span.frames[f.index];
            db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, mime_type, size_bytes, provider, metadata)
                VALUES (?, ?, ?, 'other', ?, ?, 'png', 'image/png', ?, ?, ?)`)
                .run(assetId, project.id, shot.id, filePath, fileName, buffer.length, provider || null, JSON.stringify({
                    kind: 'inbetween_frame', inbetween_id: span.id, at_ms: fr.at_ms, frame_index: f.index,
                    direction: fr.direction || '', instruction: f.instruction, provider_model: model || null,
                    from_shot_id: span.from_shot_id, to_shot_id: span.to_shot_id }));
            made.push({ index: f.index, at_ms: fr.at_ms, asset_id: assetId });
            previous = filePath;
            // A new take is the one used: pick it for the frame.
            const stored = parse(l.row.frames_json, []);
            if (stored[f.index]) { stored[f.index].asset_id = assetId; l.row.frames_json = JSON.stringify(stored); }
            db.prepare(`UPDATE film_inbetweens SET frames_json = ?, updated_at = datetime('now') WHERE id = ?`).run(l.row.frames_json, span.id);
        } catch (err) {
            const notAttempted = plan.frames.filter(x => x.index > f.index).map(x => x.index);
            return json(res, made.length ? 207 : 502, { error: 'STOPPED', message: `The frame at ${secs(f.at_ms)} s was refused: ${err.message}`,
                ...present(load(id)), generated: made, not_attempted: notAttempted, hint: 'Nothing after the refused frame was attempted or charged.' });
        }
    }
    return json(res, 200, { ...present(load(id)), generated: made });
}

function selectTake(req, res, id, index) {
    const l = load(id);
    if (!l) return json(res, 404, { error: 'In-betweens not found' });
    const i = Number(index);
    const f = l.span.frames[i];
    if (!f) return json(res, 404, { error: `There is no frame ${i + 1}` });
    const assetId = (req.body || {}).asset_id;
    if (!f.takes.some(t => t.asset_id === assetId)) return json(res, 400, { error: 'That take is not one of this frame\'s' });
    const stored = parse(l.row.frames_json, []);
    stored[i].asset_id = assetId;
    db.prepare(`UPDATE film_inbetweens SET frames_json = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(stored), id);
    return json(res, 200, present(load(id)));
}

function approve(req, res, id) {
    const l = load(id);
    if (!l) return json(res, 404, { error: 'In-betweens not found' });
    const missing = l.span.frames.filter(f => !f.asset_id);
    if (missing.length) {
        return json(res, 409, { error: 'STRIP_INCOMPLETE',
            message: `${missing.length} frame(s) have no picture yet (${missing.map(f => secs(f.at_ms) + ' s').join(', ')}). Approving them would sign off pictures nobody has seen.` });
    }
    db.prepare(`UPDATE film_inbetweens SET approved_fingerprint = ?, approved_at = datetime('now') WHERE id = ?`).run(l.fingerprint, id);
    return json(res, 200, present(load(id)));
}

/*
 * ── The clip ───────────────────────────────────────────────────────────────
 *
 * Two shapes, chosen by what the video model can take:
 *   ONE  every picture goes in one generation, as ordered references, for the
 *        whole gap. Only a model whose own contract takes in-between pictures.
 *   LEGS a clip between each pair of neighbouring pictures, first and last
 *        frame exact, joined into one file with no cut between them.
 */
function videoProvider(projectId, body) {
    const { resolve } = require('../lib/providers');
    const { seqConfig } = require('./sequences');
    return resolve('video', seqConfig(projectId, { body: body || {} }));
}

function priceVideo(provider, payload) {
    try {
        if (provider.id === 'runway') {
            const est = require('../lib/video-cost').estimateVideoCost({ model: payload.model || process.env.RUNWAY_VIDEO_MODEL || 'gen4.5', durationSeconds: payload.duration_s });
            return Number.isFinite(est.usd) ? est.usd : null;
        }
        if (typeof provider.meter !== 'function') return null;
        const u = provider.meter('video', payload, null);
        const p = u && require('../lib/provider-pricing').priceUsage({ provider: provider.id, capability: 'video', ...u });
        return p && p.priced ? Number(p.amount_usd.toFixed(2)) : null;
    } catch (_) { return null; }
}

function videoPlan(l, body) {
    const { span } = l;
    const b = body || {};
    let provider = null, unresolved = null;
    try { provider = videoProvider(span.project_id, b); } catch (err) { unresolved = err.message; }
    const blockers = [];
    if (unresolved || !provider) blockers.push(`No video generator resolves for this project: ${unresolved || 'none configured'}.`);
    if (!l.from.frame) blockers.push(`${span.from_code} has no board frame.`);
    if (!l.to.frame) blockers.push(`${span.to_code} has no board frame.`);
    const missing = span.frames.filter(f => !f.asset_id);
    if (missing.length) blockers.push(`${missing.length} in-between(s) have no picture yet (${missing.map(f => secs(f.at_ms) + ' s').join(', ')}).`);
    if (l.approval.stale && !b.ignore_approval) blockers.push('The strip changed after it was approved. Approve it again, or send ignore_approval.');
    const contract = provider && provider.referenceContract;
    const canOne = !!(contract && (contract.roles || []).includes('inbetween') && (contract.maxImages || 0) >= span.frames.length + 2);
    const maxKeys = provider ? Math.max(1, Number(provider.maxKeyframes) || 1) : 1;
    const shape = b.shape === 'legs' || b.shape === 'one' ? b.shape : (canOne ? 'one' : 'legs');
    if (shape === 'one' && !canOne) blockers.push(`${provider ? provider.id : 'This generator'} cannot take every picture in one clip. Use legs.`);
    if (shape === 'legs' && maxKeys < 2) blockers.push(`${provider ? provider.id : 'This generator'} takes one picture per clip, so a leg cannot end on the next frame. Pick a generator that takes a first and last frame.`);
    const points = [{ at_ms: 0, label: span.from_code, path: l.from.frame && l.from.frame.file_path },
        ...span.frames.map(f => ({ at_ms: f.at_ms, label: `${secs(f.at_ms)} s`, path: f.image_path })),
        { at_ms: span.gap_ms, label: span.to_code, path: l.to.frame && l.to.frame.file_path }];
    const base = String(b.prompt || '').trim() || null;
    const calls = shape === 'one'
        ? [{ from: span.from_code, to: span.to_code, from_ms: 0, to_ms: span.gap_ms, duration_s: span.gap_ms / 1000,
            prompt: span_.wholePrompt(span, base), pictures: points.map(p => p.label) }]
        : points.slice(0, -1).map((p, i) => ({ from: p.label, to: points[i + 1].label, from_ms: p.at_ms, to_ms: points[i + 1].at_ms,
            duration_s: Math.round((points[i + 1].at_ms - p.at_ms) / 100) / 10,
            prompt: span_.legPrompt(span, p.at_ms, points[i + 1].at_ms, base), pictures: [p.label, points[i + 1].label] }));
    let usd = 0, priced = !!provider;
    if (provider) for (const c of calls) { const p = priceVideo(provider, { duration_s: c.duration_s, prompt: c.prompt }); if (p == null) priced = false; else usd += p; }
    return {
        id: span.id, spends: true, shape, provider: provider ? provider.id : null,
        calls, count: calls.length, points: points.map(({ path: _p, ...rest }) => rest),
        estimated_usd: priced ? Number(usd.toFixed(2)) : null,
        blockers, ready: !blockers.length,
        note: shape === 'one'
            ? 'Every picture goes in one generation as ordered references; the first and last are references too, not frame-exact.'
            : `${calls.length} clips, each starting and ending exactly on its two pictures, joined into one file with no cut between them.`,
        prompt: calls.map(c => c.prompt).join('\n\n'),
        _points: points,
    };
}

async function makeVideo(req, res, id) {
    const l = load(id);
    if (!l) return json(res, 404, { error: 'In-betweens not found' });
    const b = req.body || {};
    const plan = videoPlan(l, b);
    if (!plan.ready) { const { _points, ...p } = plan; return json(res, 409, { error: 'NOT_READY', message: plan.blockers.join(' '), plan: p }); }
    const provider = videoProvider(l.span.project_id, b);
    const { toDataUri } = require('../lib/reference-images');
    const { persistProviderMedia } = require('../lib/provider-media');
    const { sequenceFrame } = require('./sequences');
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(l.row.project_id);
    const frame = sequenceFrame(project, provider);
    const pts = plan._points;
    const clips = [];
    const fileDir = require('../lib/file-storage').ensureDir(project.id, 'video');
    const stem = `${l.span.from_code}-${l.span.to_code}_inbetweens_${Date.now().toString(36)}`;
    for (const [i, c] of plan.calls.entries()) {
        const payload = plan.shape === 'one'
            ? { workflow: 'omni-reference', prompt: c.prompt, reference_images: pts.map(p => ({ uri: toDataUri(p.path), role: 'inbetween' })), duration_s: c.duration_s }
            : { prompt: c.prompt, keyframes: [{ uri: toDataUri(pts[i].path), position: 'first' }, { uri: toDataUri(pts[i + 1].path), position: 'last' }], duration_s: c.duration_s };
        const result = await provider.generate('video', { ...payload, ...frame,
            ...(project.target_fps ? { target_fps: project.target_fps } : {}) },
            { timeout: 600000, jobMeta: { inbetween_id: l.span.id, from: c.from, to: c.to } });
        if (!result || !result.ok) {
            return json(res, clips.length ? 207 : 502, { error: 'STOPPED', message: `${c.from} → ${c.to} was refused: ${(result && result.error) || 'no answer'}`,
                made: clips.map(x => x.label), not_attempted: plan.calls.slice(i + 1).map(x => `${x.from} → ${x.to}`) });
        }
        const fileName = `${stem}_${String(i + 1).padStart(2, '0')}.mp4`;
        const saved = await persistProviderMedia(project.id, 'video', fileName, Buffer.isBuffer(result.data) ? result.data : result, { serveDir: 'videos' });
        const filePath = typeof saved === 'string' ? saved : (saved && saved.path) || path.join(fileDir, fileName);
        clips.push({ file_path: filePath, label: `${c.from} → ${c.to}`, file_name: fileName });
    }
    // One file: the single clip, or the legs joined.
    let finalPath = clips[0].file_path, finalName = clips[0].file_name, joined = null;
    if (clips.length > 1) {
        finalName = `${stem}.mp4`;
        finalPath = path.join(fileDir, finalName);
        joined = await require('../lib/ffmpeg').stitchClips(clips, finalPath, { fps: Number(project.target_fps) || 24 });
        if (!joined.ok) {
            return json(res, 502, { error: 'NOT_JOINED', message: `The ${clips.length} clips were made but could not be joined: ${joined.error || joined.state}`,
                clips: clips.map(c => c.file_name) });
        }
    }
    let durationMs = 0;
    try { durationMs = require('../lib/media-imports').measureDurationMs(finalPath) || 0; } catch (_) { durationMs = 0; }
    const assetId = generateId();
    const size = fs.existsSync(finalPath) ? fs.statSync(finalPath).size : null;
    const version = (db.prepare(`SELECT MAX(version) v FROM film_assets WHERE shot_id = ? AND asset_type = 'video_raw'`).get(l.span.from_shot_id).v || 0) + 1;
    db.prepare(`INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, mime_type, size_bytes, duration_ms, version, provider, metadata)
        VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 'video/mp4', ?, ?, ?, ?, ?)`)
        .run(assetId, project.id, l.span.from_shot_id, finalPath, finalName, size, durationMs || l.span.gap_ms, version, provider.id,
            JSON.stringify({ kind: 'inbetween_clip', inbetween_id: l.span.id, shape: plan.shape, from: l.span.from_code, to: l.span.to_code,
                pictures: pts.map(p => p.label), legs: clips.length > 1 ? clips.map(c => c.file_name) : undefined }));
    // The new clip is the one that plays, as a new frame is on the board.
    db.prepare('UPDATE film_shots SET selected_video_asset_id = ? WHERE id = ?').run(assetId, l.span.from_shot_id);
    db.prepare(`UPDATE film_inbetweens SET clip_asset_id = ?, updated_at = datetime('now') WHERE id = ?`).run(assetId, l.span.id);
    return json(res, 200, { asset_id: assetId, shape: plan.shape, clips: clips.length, duration_ms: durationMs,
        url: require('../lib/file-storage').getFileUrl('video', project.id, finalName),
        note: `${l.span.from_code} now plays this clip; the frames it was made from are kept.` });
}

async function handleInbetweens(req, res, parts, query) {
    const q = query || {};
    if (parts[1] === 'projects' && parts[3] === 'inbetweens') {
        const pid = parts[2];
        if (req.method === 'GET') {
            const rows = db.prepare('SELECT id FROM film_inbetweens WHERE project_id = ? ORDER BY created_at').all(pid);
            return json(res, 200, { inbetweens: rows.map(r => present(load(r.id))), image_price: imagePrice(pid) });
        }
        if (req.method === 'POST') return create(req, res, pid);
        return json(res, 405, { error: 'Method not allowed' });
    }
    const id = parts[2];
    const sub = parts[3];
    if (!sub) {
        if (req.method === 'GET') { const l = load(id); return l ? json(res, 200, present(l)) : json(res, 404, { error: 'In-betweens not found' }); }
        if (req.method === 'PUT') return update(req, res, id);
        if (req.method === 'DELETE') {
            const r = db.prepare('DELETE FROM film_inbetweens WHERE id = ?').run(id);
            return r.changes ? json(res, 200, { deleted: id, note: 'The pictures it made stay in the asset list.' }) : json(res, 404, { error: 'In-betweens not found' });
        }
    }
    const l = () => load(id);
    if (sub === 'generate') {
        if (req.method === 'GET') { const x = l(); return x ? json(res, 200, generatePlan(x, q)) : json(res, 404, { error: 'In-betweens not found' }); }
        if (req.method === 'POST') return generate(req, res, id);
    }
    if (sub === 'frames' && parts[5] === 'select' && req.method === 'POST') return selectTake(req, res, id, parts[4]);
    if (sub === 'approve' && req.method === 'POST') return approve(req, res, id);
    if (sub === 'video') {
        if (req.method === 'GET') { const x = l(); if (!x) return json(res, 404, { error: 'In-betweens not found' }); const { _points, ...p } = videoPlan(x, q); return json(res, 200, p); }
        if (req.method === 'POST') return makeVideo(req, res, id);
    }
    return json(res, 405, { error: 'Method not allowed' });
}

module.exports = { handleInbetweens, load, generatePlan, videoPlan };
