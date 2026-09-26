/**
 * FILM-029-035: Video Generation Pipeline
 *
 * POST /film/shots/:id/video/generate          - Generate video from storyboard keyframe
 * POST /film/shots/:id/video/generate/stream    - SSE streaming
 * POST /film/projects/:id/video/batch           - Batch all shots
 * POST /film/projects/:id/video/batch/stream    - SSE batch
 * GET  /film/shots/:id/video                    - Get video job status
 * GET  /film/projects/:id/video                 - List all video jobs
 * GET  /film/video/:projectId/:filename         - Serve video files
 */

const fs = require('fs');
const { db, generateId } = require('../db/database');
const { callGridlight, serviceUnavailableError } = require('../lib/gridlight-client');
const { saveFile, getFileUrl, getFilePath, ensureDir, serveFile } = require('../lib/file-storage');
const { persistProviderMedia } = require('../lib/provider-media');
const { loadShotContext, buildCapabilityPayload } = require('../lib/capability-payloads');
const { needsStitching, planClips, buildStitchPayload, calculateTransitions } = require('../lib/video-stitcher');
const { resolve } = require('../lib/providers');
const { providerConfigFor, spendContext } = require('../lib/provider-config');
/*
 * The same per-generation override the image paths read. Video was stuck on
 * whatever the project happened to say, so "select the generator on every
 * generation" was true of pictures and false of footage — which is the more
 * expensive half.
 */
const { imageOverride } = require('../lib/generation-override');
const { buildShotReferencePayload, recordConsistencyCheck } = require('../lib/consistency-context');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIDEO_ENDPOINT = '/video';
const STITCH_ENDPOINT = '/video/stitch';

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// One implementation, in lib/provider-config.js — it also tags the config
// with the project id so spend can be attributed. See that file for why.
const parseProjectConfig = providerConfigFor;

function resultModel(result, payload) {
    return (result && result.provider_model) || (payload && payload.model) || '';
}

function resultJobId(result) {
    return (result && result.provider_job_id) || '';
}

// -- Route Handler -------------------------------------------------------

/**
 * What a video generation would SEND, without sending it. Free.
 *
 * The image paths have had this since shot_prompt, and video never did: the
 * only preview was /previs/to-video, which is previs-scoped and refuses on a
 * stale approval, so a shot nobody has blocked — which is most of them — had no
 * answer at all to "what would this cost and contain".
 *
 * The director's own words for the consequence: "I generated the first two
 * videos directly on runway and not through the engine as credits are super
 * precious and didn't want to waste them." Someone who cannot see what will be
 * sent does not spend, and the feature fails for a reason that has nothing to
 * do with how good the generation is.
 */

/**
 * Which generator this ONE clip is made on.
 *
 * `video` is a capability like any other, so the override reuses the image
 * helper and is renamed at the boundary — a second reader would be a second
 * place for "provider" and "quality" to mean subtly different things.
 */
/**
 * The tier this generation is being made at.
 *
 * A tier is POLICY — how cheap, how good, how many attempts are reasonable —
 * and it supplies a model only until a router can choose one from real
 * acceptance data. An explicit `model` always wins over the tier's preference:
 * a default that beats a deliberate choice is worse than no default.
 */
function videoTierOf(req, query) {
    const { resolveVideoTier } = require('../lib/video-tiers');
    const src = { ...(query || {}), ...((req && req.body) || {}) };
    return resolveVideoTier(src.tier);
}

/** What the tier contributes, without overriding anything explicitly asked for. */
function applyTier(tier, req, query) {
    const src = { ...(query || {}), ...((req && req.body) || {}) };
    return {
        model: src.model || tier.preferredModel || undefined,
        durationSeconds: Number(src.duration_s) || tier.durationSeconds || undefined,
        resolution: src.resolution || tier.resolution || undefined,
        tierId: tier.id,
    };
}

function videoOverrideOf(req, query) {
    const src = { ...(query || {}), ...((req && req.body) || {}) };
    const o = imageOverride(src);
    if (!o) return null;
    // imageOverride speaks in image_* keys; video resolves on `video`.
    const out = {};
    if (o.image) out.video = o.image;
    if (o.image_model) out.video_model = o.image_model;
    return Object.keys(out).length ? out : null;
}

/** The project's provider choices, in the shape resolveGenerator reads. */
function providerConfigFor_(ctx) {
    try { return JSON.parse((ctx && ctx.project && ctx.project.provider_config) || '{}'); }
    catch (_) { return {}; }
}

async function previewVideo(res, shotId, previewOverride, tierChoice) {
    const { loadShotContext, buildCapabilityPayload } = require('../lib/capability-payloads');
    const { estimateVideoCost } = require('../lib/video-cost');

    let ctx;
    try { ctx = await loadShotContext(shotId); }
    catch (err) { return json(res, 404, { error: err.message }); }
    if (!ctx || !ctx.shot) return json(res, 404, { error: 'Shot not found' });

    let payload, meta;
    try { ({ payload, meta } = buildCapabilityPayload('video', ctx)); }
    catch (err) {
        // A precondition is an ANSWER here, not a failure: "this needs a
        // keyframe first" is exactly what a director is asking.
        return json(res, 200, {
            shot_id: shotId, shot_code: ctx.shot.shot_code,
            can_generate: false,
            warnings: [err.message],
            note: 'Nothing can be generated for this shot yet.',
        });
    }

    const provider = resolve('video',
        spendContext({ id: ctx.scene && ctx.scene.project_id }, null, null, previewOverride));

    /*
     * WHAT THE ADAPTER WILL SEND, not what the payload asked for.
     *
     * The first version reported the payload's own fields as fact, so a shot
     * whose payload carries a local Gridlight checkpoint name — hardcoded in
     * lib/video-prompt.js, a name Runway has never heard of — was previewed as
     * generating on it while the adapter silently substituted its
     * default. The one dialog a director is asked to trust before spending
     * named a model that would never be sent.
     *
     * An adapter that cannot describe itself is marked UNVERIFIED rather than
     * having its payload reported as fact: falling back silently is how this
     * returns the moment a new adapter arrives.
     */
    /*
     * What the button costs, worked out here rather than asked of a provider:
     * a local estimate works before there is an account and when the network is
     * down, and cannot fail in the way that would block the check it exists to
     * provide. The lines matter as much as the total — the one a director needs
     * to see is the one they did not expect, which is nearly always reference
     * video.
     */
    const chosen = tierChoice || { model: payload.model, durationSeconds: payload.duration_s };
    const refs = Array.isArray(payload.video_references) ? payload.video_references : [];
    const estimate = estimateVideoCost({
        model: chosen.model || payload.model,
        resolution: chosen.resolution,
        durationSeconds: chosen.durationSeconds || payload.duration_s,
        imageReferences: refs.filter(r => (r.sourceType || 'image') === 'image').length,
        videoReferenceSeconds: refs.filter(r => r.sourceType === 'video')
            .reduce((n, r) => n + (Number(r.durationSeconds) || 0), 0),
    });

    let sent = null, unverified = false;
    if (provider && typeof provider.describeVideoRequest === 'function') {
        try { sent = provider.describeVideoRequest(payload); }
        catch (_) { sent = null; unverified = true; }
    } else {
        unverified = true;
    }

    /*
     * The warnings are the point. A prompt reads perfectly while the keyframe
     * that would have made the clip match the board is absent — the words look
     * right and the footage comes back as a different place.
     */
    const warnings = [];
    if (!payload.init_image) {
        warnings.push('No keyframe is attached, so this generates from words alone and will not match '
            + 'the storyboard frame. Generate the frame first if you want the clip to look like the board.');
    }
    if (!ctx.previs) {
        warnings.push('This shot has no applied blocking, so the motion prompt has no approved camera choreography. '
            + 'Apply it in Previs before generating.');
    }
    try {
        const lint = require('../lib/prompt-lint').lintPrompt(payload.prompt || '');
        for (const w of (lint.findings || lint || [])) {
            if (w && w.phrase) warnings.push(`"${w.phrase}" — ${w.why || 'an image model draws what you name'}`);
        }
    } catch (_) { /* the lint is advice, never a gate */ }

    /*
     * The adapter's own notes are WARNINGS, not footnotes: "you asked for a
     * model this provider does not offer" is exactly the sort of thing a
     * director needs before spending, and burying it under a heading nobody
     * reads is how the original lie went unnoticed.
     */
    for (const note of (sent && sent.notes) || []) warnings.push(note);
    if (unverified) {
        warnings.push('This provider cannot report what it will actually send, so the model and '
            + 'length below are what is being ASKED for rather than what will run — unverified.');
    }

    return json(res, 200, {
        shot_id: shotId, shot_code: ctx.shot.shot_code,
        can_generate: true,
        provider: (provider && provider.id) || 'unresolved',
        // The adapter's answer wins wherever it has one.
        model: sent ? sent.model : (payload.model || null),
        model_unverified: unverified || undefined,
        prompt: sent && sent.prompt ? sent.prompt : payload.prompt,
        negative_prompt: payload.negative_prompt || null,
        // Whether the board's frame is going, which is the single biggest
        // difference between a clip that matches the storyboard and one that
        // does not — reported as a fact, never as bytes.
        init_image: sent ? sent.has_image : !!payload.init_image,
        camera_control: payload.camera_control || null,
        camera_control_delivery: payload.camera_control && payload.camera_control.path
            ? 'translated-to-prompt-text' : 'movement-text-only',
        duration_s: sent && sent.duration_s ? sent.duration_s : payload.duration_s,
        ratio: sent ? sent.ratio : null,
        outbound: sent && sent.outbound ? sent.outbound : null,
        // The adapter's own figure, kept as corroboration.
        estimated_credits: sent && sent.estimated_credits !== undefined ? sent.estimated_credits : null,
        estimated_usd: sent && sent.estimated_usd !== undefined ? sent.estimated_usd : null,
        /*
         * The local estimate, which is the one a director reads: it models the
         * three things that make a figure wrong — resolution changing the rate,
         * reference VIDEO billed per second, and minimum charges — and returns
         * the lines, because a total with no breakdown cannot be checked.
         */
        estimate,
        tier: tierChoice ? tierChoice.tierId : null,
        references: {
            sending: refs.length,
            roles: refs.map(r => r.role),
            dropped: (payload.references_dropped || []).map(d => ({ role: d.role, subject: d.subject, reason: d.reason })),
        },
        width: payload.width, height: payload.height, fps: payload.fps,
        /*
         * WHAT WILL COME BACK, beside what we composed.
         *
         * `width`/`height` are the frame this engine built the shot in. On an
         * adapter whose model is chosen by resolution TIER rather than by a
         * size field, they are not what the vendor produces -- Seedance holds
         * the tier's pixel budget and reshapes it to the aspect it is working
         * in. Quoting only ours meant every preview named a frame that would
         * never arrive, and nobody could see it without measuring a file.
         *
         * Reported rather than reconciled: both numbers are true about
         * different things, and a director deciding what to buy should see the
         * one that lands.
         */
        ...(function () {
            try {
                const a = require('../lib/providers').resolveGenerator('video',
                    providerConfigFor_(ctx));
                if (!a || typeof a.predictedFrame !== 'function') return {};
                const f = a.predictedFrame(payload);
                if (!f || !(f.width > 0)) return {};
                const differs = f.width !== payload.width || f.height !== payload.height;
                return { output_frame: { ...f, differs_from_composed: differs } };
            } catch (_) { return {}; }
        }()),
        seed: payload.seed === undefined ? null : payload.seed,
        warnings,
        meta: meta || null,
        note: 'Nothing was generated and nothing was spent.',
    });
}

function handleVideoGen(req, res, urlParts, query) {
    // /film/video/:projectId/:filename
    if (urlParts[1] === 'video' && urlParts[2] && urlParts[3] && !['shots', 'projects'].includes(urlParts[1])) {
        return serveFile(res, urlParts[2], 'video', urlParts[3]);
    }

    // /film/shots/:id/video[/generate[/stream]]
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'video') {
        const shotId = urlParts[2];
        if (!UUID_RE.test(shotId)) return json(res, 400, { error: 'Invalid shot ID' });

        const sub = urlParts[4];
        // What this clip would cost and contain. Free. Under /video/ because
        // the dispatch above scopes on urlParts[3] === 'video'; a sibling
        // segment never reaches this handler at all.
        if (sub === 'preview' && req.method === 'GET') {
            const tier = videoTierOf(req, query);
            return previewVideo(res, shotId, videoOverrideOf(req, query), applyTier(tier, req, query));
        }
        if (sub === 'generate' && req.method === 'POST') {
            if (urlParts[5] === 'stream') return generateVideoStream(req, res, shotId);
            return generateVideo(req, res, shotId);
        }
        /*
         * BACKGROUND REPLACEMENT — the only path here that EDITS footage
         * rather than making some. Free preview and paid generate are separate
         * verbs on separate sub-paths: a preview that could spend is not a
         * preview, and the confirmation reads this one before the money goes.
         */
        if (sub === 'background' && urlParts[5] === 'preview' && req.method === 'GET') {
            return previewBackground(res, shotId, query);
        }
        if (sub === 'background' && urlParts[5] === 'generate' && req.method === 'POST') {
            return replaceBackground(req, res, shotId);
        }
        if (sub === 'stitch' && req.method === 'POST') return stitchVideo(req, res, shotId);
        if (!sub && req.method === 'GET') return getVideoStatus(req, res, shotId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/projects/:id/video[/batch[/stream]]
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'video') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });

        const sub = urlParts[4];
        if (sub === 'batch' && req.method === 'POST') {
            if (urlParts[5] === 'stream') return batchVideoStream(req, res, projectId, query);
            return batchVideo(req, res, projectId);
        }
        if (!sub && req.method === 'GET') return listVideoJobs(req, res, projectId, query);
        return json(res, 405, { error: 'Method not allowed' });
    }

    json(res, 404, { error: 'Not found' });
}

// -- Generate Video for a Shot -------------------------------------------

/**
 * The name and version of a shot's next clip.
 *
 * The name was the shot code alone on every path, so each generation wrote
 * over the one before: the rows said "three versions" and the disk held one
 * clip, which made choosing between them meaningless. The first keeps its old
 * name, so a project with one clip per shot is unchanged on disk.
 */
function nextClip(shotId, shotCode) {
    const made = db.prepare(`SELECT COUNT(*) AS n FROM film_assets WHERE shot_id = ?
        AND asset_type IN ('video_raw', 'video_synced', 'video_final')`).get(shotId).n;
    const version = made + 1;
    return { version, filename: version === 1 ? `${shotCode}.mp4` : `${shotCode}_v${version}.mp4` };
}

async function generateVideo(req, res, shotId) {
    const ctx = loadShotContext(shotId);
    if (!ctx) return json(res, 404, { error: 'Shot not found' });

    const { shot, scene, sceneCard, characters, location, project, initImage } = ctx;
    const videoProvider = resolve('video',
        spendContext({ id: scene.project_id }, shot, scene, videoOverrideOf(req)));
    const consistencyContext = buildShotReferencePayload(shot, scene, project);

    ctx.consistency = consistencyContext;
    const tier = videoTierOf(req, null);
    const chosen = applyTier(tier, req, null);
    ctx.overrides = {
        seed: req.body && req.body.seed ? req.body.seed : consistencyContext.locked_seed,
        // The tier supplies a model only when the caller named none: a default
        // that beats a deliberate choice is worse than no default.
        model: chosen.model,
    };
    const payload = buildCapabilityPayload('video', ctx).payload;
    /*
     * An edited prompt replaces the composed one WHOLE — the rule an image
     * override already follows. The production graph's shot drawer shows the
     * prompt the preview composed and lets it be edited; without this the edit
     * reached nothing and the clip was generated from the words it replaced.
     */
    const override = req.body && typeof req.body.prompt_override === 'string' ? req.body.prompt_override.trim() : '';
    if (override) payload.prompt = override.slice(0, 16000);
    const startedAt = Date.now();
    const videoRefs = Array.isArray(payload.video_references) ? payload.video_references : [];
    const estimate = require('../lib/video-cost').estimateVideoCost({
        model: chosen.model || payload.model,
        resolution: chosen.resolution,
        durationSeconds: chosen.durationSeconds || payload.duration_s,
        imageReferences: videoRefs.filter(r => (r.sourceType || 'image') === 'image').length,
    });

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_video_jobs (id, project_id, shot_id, keyframe_asset_id, status, prompt, negative_prompt, model, seed, num_frames, fps, width, height, camera_control)
         VALUES (?, ?, ?, ?, 'generating', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(jobId, scene.project_id, shotId, ctx.keyframeAsset ? ctx.keyframeAsset.id : null,
        payload.prompt, payload.negative_prompt, payload.model, payload.seed,
        payload.num_frames, payload.fps, payload.width, payload.height,
        JSON.stringify(payload.camera_control));

    try {
        const result = await videoProvider.generate('video', payload, { timeout: 300000 });

        if (!result.ok) {
            db.prepare('UPDATE film_video_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
            if (videoProvider.id === 'gridlight' && result.status === 503) return json(res, 503, serviceUnavailableError(VIDEO_ENDPOINT, 'video'));
            return json(res, result.status || 500, { error: result.error });
        }

        /*
         * A NEW FILE PER CLIP. The name was the shot code alone, so every
         * generation wrote over the one before: the rows said "three versions"
         * and the disk held one picture, which made choosing between them
         * meaningless. Numbered by what the shot already has.
         */
        const { version: clipVersion, filename } = nextClip(shotId, shot.shot_code);
        ensureDir(scene.project_id, 'video');

        let filePath;
        try {
            filePath = await persistProviderMedia(scene.project_id, 'video', filename, result.data, { serveDir: 'videos' });
        } catch (err) {
            db.prepare('UPDATE film_video_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
            return json(res, 502, { error: `video generated but could not be stored: ${err.message}` });
        }

        const durationMs = payload.duration_s * 1000;

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (
                id, project_id, shot_id, asset_type, file_path, file_name,
                format, mime_type, duration_ms, version,
                provider, provider_model, provider_job_id, license_source, license_status, input_refs
             )
             VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 'video/mp4', ?, ?, ?, ?, ?, 'generated', 'generated', ?)`
        ).run(
            assetId, scene.project_id, shotId, filePath, filename, durationMs, clipVersion,
            videoProvider.id, resultModel(result, payload), resultJobId(result), JSON.stringify(consistencyContext.input_refs || [])
        );
        // What it was made with, so the version drawer can show the prompt and
        // the seed rather than reconstructing them.
        db.prepare('UPDATE film_assets SET metadata = ? WHERE id = ?')
            .run(JSON.stringify({ prompt: payload.prompt, seed: payload.seed === undefined ? null : payload.seed,
                edited_prompt: !!override }), assetId);
        // The newest clip plays, as the newest frame does — a new generation
        // clears the frame pointer for the same reason.
        db.prepare('UPDATE film_shots SET selected_video_asset_id = ? WHERE id = ?').run(assetId, shotId);
        /*
         * Every attempt, recorded with the SHAPE of the shot. Without this the
         * eventual router has nothing to learn from, and the shape cannot be
         * reconstructed after the fact.
         */
        require('../lib/video-attempt').recordVideoAttempt(db, {
            shotId, projectId: scene.project_id, shotVersion: shot.current_frame_version,
            provider: videoProvider.id, model: resultModel(result, payload), tier: chosen.tierId,
            durationSeconds: payload.duration_s, resolution: chosen.resolution || '',
            referenceImages: videoRefs.filter(r => (r.sourceType || 'image') === 'image').length,
            referenceVideos: videoRefs.filter(r => r.sourceType === 'video').length,
            referenceAudio: videoRefs.filter(r => r.sourceType === 'audio').length,
            referenceRoles: videoRefs.map(r => r.role),
            estimatedCredits: estimate.credits, generationMs: Date.now() - startedAt,
            sceneCard, assetId,
        });
        recordConsistencyCheck(shot, scene, { id: scene.project_id }, {
            context: consistencyContext,
            output_asset_id: assetId,
            scorer: 'stub',
        });

        db.prepare(
            `INSERT INTO render_ledger (id, shot_id, version, step, model_id, prompt, seed, sampler, steps, guidance, mode)
             VALUES (?, ?, 1, 'video', ?, ?, ?, 'euler_a', ?, ?, 'creative')`
        ).run(generateId(), shotId, payload.model, payload.prompt, payload.seed, payload.steps, payload.guidance_scale);

        db.prepare('UPDATE film_video_jobs SET status = ?, output_path = ?, duration_ms = ? WHERE id = ?')
            .run('complete', filePath, durationMs, jobId);

        json(res, 200, {
            shot_id: shotId, shot_code: shot.shot_code, job_id: jobId, status: 'complete',
            video_url: getFileUrl('video', scene.project_id, filename), duration_ms: durationMs,
        });
    } catch (err) {
        db.prepare('UPDATE film_video_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
        if (videoProvider.id === 'gridlight' && err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(VIDEO_ENDPOINT, 'video'));
        json(res, 500, { error: err.message });
    }
}

// -- SSE Streaming Video Generation --------------------------------------

async function generateVideoStream(req, res, shotId) {
    const ctx = loadShotContext(shotId);
    if (!ctx) return json(res, 404, { error: 'Shot not found' });

    const { shot, scene, sceneCard, characters, location, project, initImage } = ctx;
    const videoProvider = resolve('video',
        spendContext({ id: scene.project_id }, shot, scene, videoOverrideOf(req)));
    const consistencyContext = buildShotReferencePayload(shot, scene, project);
    ctx.consistency = consistencyContext;
    ctx.overrides = { seed: consistencyContext.locked_seed };
    const payload = buildCapabilityPayload('video', ctx).payload;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    if (res.socket) res.socket.setTimeout(0);

    const sendEvent = (data) => { if (res.writableEnded) return; res.write(`data: ${JSON.stringify(data)}\n\n`); };
    sendEvent({ type: 'status', phase: 'starting', shot_id: shotId, shot_code: shot.shot_code });

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_video_jobs (id, project_id, shot_id, status, prompt, model) VALUES (?, ?, ?, 'generating', ?, ?)`
    ).run(jobId, scene.project_id, shotId, payload.prompt, payload.model);

    try {
        // onComplete is invoked synchronously by the SSE relay, so the media
        // download can't happen inside it. Capture what we inserted and persist
        // once the stream resolves — otherwise the asset keeps an empty
        // file_path and the clip reaches Premiere with no media reference.
        let streamedAsset = null;

        const { ok, finalData, error } = await videoProvider.generateStream('video', payload, res, {
            onComplete: (data) => {
                const { version: clipVersion, filename } = nextClip(shotId, shot.shot_code);
                ensureDir(scene.project_id, 'video');

                const assetId = generateId();
                streamedAsset = { assetId, filename, data };
                db.prepare(
                    `INSERT INTO film_assets (
                        id, project_id, shot_id, asset_type, file_name, format, mime_type, version,
                        provider, provider_model, provider_job_id, license_source, license_status, input_refs
                     )
                     VALUES (?, ?, ?, 'video_raw', ?, 'mp4', 'video/mp4', ?, ?, ?, ?, 'generated', 'generated', ?)`
                ).run(
                    assetId, scene.project_id, shotId, filename, clipVersion,
                    videoProvider.id, resultModel(data, payload), resultJobId(data), JSON.stringify(consistencyContext.input_refs || [])
                );
                recordConsistencyCheck(shot, scene, { id: scene.project_id }, {
                    context: consistencyContext,
                    output_asset_id: assetId,
                    scorer: 'stub',
                });

                db.prepare('UPDATE film_video_jobs SET status = ?, output_path = ? WHERE id = ?')
                    .run('complete', data.video_url || filename, jobId);
            },
            onError: (data) => {
                db.prepare('UPDATE film_video_jobs SET status = ?, error_message = ? WHERE id = ?')
                    .run('failed', data.error || 'Unknown error', jobId);
            },
        });

        if (!ok) {
            sendEvent({ type: 'error', error: error || 'Video generation failed' });
            db.prepare('UPDATE film_video_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', error, jobId);
        } else if (streamedAsset) {
            try {
                const filePath = await persistProviderMedia(
                    scene.project_id, 'video', streamedAsset.filename, streamedAsset.data, { serveDir: 'videos' }
                );
                db.prepare('UPDATE film_assets SET file_path = ? WHERE id = ?').run(filePath, streamedAsset.assetId);
            } catch (err) {
                db.prepare('DELETE FROM film_assets WHERE id = ?').run(streamedAsset.assetId);
                db.prepare('UPDATE film_video_jobs SET status = ?, error_message = ? WHERE id = ?')
                    .run('failed', `media not stored: ${err.message}`, jobId);
                sendEvent({ type: 'error', error: `video generated but could not be stored: ${err.message}` });
            }
        }
    } catch (err) {
        sendEvent({ type: 'error', error: err.message });
        db.prepare('UPDATE film_video_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
    }

    sendEvent({ type: 'done' });
    res.end();
}

// -- Batch Video Generation ----------------------------------------------

async function batchVideoStream(req, res, projectId, query) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });
    const videoProvider = resolve('video',
        spendContext({ id: projectId }, null, null, videoOverrideOf(req, query)));

    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    if (res.socket) res.socket.setTimeout(0);

    let clientGone = false;
    res.on('close', () => { clientGone = true; });

    const sendEvent = (data) => { if (res.writableEnded) return; res.write(`data: ${JSON.stringify(data)}\n\n`); };

    const shots = db.prepare(
        `SELECT s.id AS shot_id, s.shot_code FROM film_shots s
         JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId);

    sendEvent({ type: 'status', phase: 'starting', total_shots: shots.length, project_id: projectId });
    let completed = 0, failed = 0;

    for (const shot of shots) {
        if (clientGone || res.writableEnded) break; // client disconnected — stop firing video jobs
        const ctx = loadShotContext(shot.shot_id);
        if (!ctx) { failed++; continue; }

        sendEvent({ type: 'shot_start', shot_id: shot.shot_id, shot_code: shot.shot_code });
        const consistencyContext = buildShotReferencePayload(ctx.shot, ctx.scene, project);

        ctx.consistency = consistencyContext;
        ctx.overrides = { seed: consistencyContext.locked_seed };
        const payload = buildCapabilityPayload('video', ctx).payload;

        try {
            const result = await videoProvider.generate('video', payload, { timeout: 300000 });
            if (!result.ok) throw new Error(result.error);

            const { version: clipVersion, filename } = nextClip(shot.shot_id, shot.shot_code);
            ensureDir(projectId, 'video');
            const filePath = await persistProviderMedia(projectId, 'video', filename, result.data, { serveDir: 'videos' });

            const assetId = generateId();
            db.prepare(
                `INSERT INTO film_assets (
                    id, project_id, shot_id, asset_type, file_path, file_name,
                    format, mime_type, version,
                    provider, provider_model, provider_job_id, license_source, license_status, input_refs
                 )
                 VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 'video/mp4', ?, ?, ?, ?, 'generated', 'generated', ?)`
            ).run(
                assetId, projectId, shot.shot_id, filePath, filename, clipVersion,
                videoProvider.id, resultModel(result, payload), resultJobId(result), JSON.stringify(consistencyContext.input_refs || [])
            );
            recordConsistencyCheck(
                { ...shot, id: shot.shot_id },
                { ...shot, id: shot.scene_id, project_id: projectId, location: shot.location },
                project,
                { context: consistencyContext, output_asset_id: assetId, scorer: 'stub' }
            );

            sendEvent({ type: 'shot_complete', shot_code: shot.shot_code, video_url: getFileUrl('video', projectId, filename) });
            completed++;
        } catch (err) {
            sendEvent({ type: 'shot_failed', shot_code: shot.shot_code, error: err.message });
            failed++;
        }
    }

    sendEvent({ type: 'result', project_id: projectId, shots_completed: completed, shots_failed: failed });
    sendEvent({ type: 'done' });
    res.end();
}

async function batchVideo(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const shots = db.prepare(
        `SELECT s.id AS shot_id, s.shot_code, s.scene_card_yaml FROM film_shots s
         JOIN film_scenes sc ON s.scene_id = sc.id
         WHERE sc.project_id = ? ORDER BY sc.scene_number, s.shot_code`
    ).all(projectId);

    json(res, 200, {
        project_id: projectId, total_shots: shots.length,
        shots: shots.map(s => ({ shot_id: s.shot_id, shot_code: s.shot_code })),
        hint: 'Use POST /film/projects/:id/video/batch/stream for actual generation with progress',
    });
}

// -- Status & Listing ----------------------------------------------------

function getVideoStatus(req, res, shotId) {
    const jobs = db.prepare('SELECT * FROM film_video_jobs WHERE shot_id = ? ORDER BY created_at DESC').all(shotId);
    const assets = db.prepare("SELECT * FROM film_assets WHERE shot_id = ? AND asset_type = 'video_raw' ORDER BY created_at DESC").all(shotId);

    json(res, 200, {
        shot_id: shotId, jobs,
        videos: assets.map(a => ({
            asset_id: a.id, file_name: a.file_name,
            video_url: a.file_name ? getFileUrl('video', a.project_id, a.file_name) : null,
            duration_ms: a.duration_ms,
            provider: a.provider, provider_model: a.provider_model, provider_job_id: a.provider_job_id,
            license_source: a.license_source, license_status: a.license_status,
        })),
    });
}

function listVideoJobs(req, res, projectId, query) {
    const status = query.status || null;
    let jobs;
    if (status) {
        jobs = db.prepare('SELECT * FROM film_video_jobs WHERE project_id = ? AND status = ? ORDER BY created_at DESC').all(projectId, status);
    } else {
        jobs = db.prepare('SELECT * FROM film_video_jobs WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
    }
    // Generation jobs are only one way a clip can enter Film Engine. Imported
    // footage deliberately has no fake provider job, so the production page
    // must read the asset slots as well or a successful upload refreshes back
    // to "no video" and looks broken.
    const assets = db.prepare(`SELECT * FROM film_assets
        WHERE project_id = ? AND asset_type IN
            ('storyboard','keyframe','video_raw','audio_dialogue','audio_sfx','video_synced','video_final')
        ORDER BY created_at DESC`).all(projectId).map(a => ({
        ...a,
        url: a.file_name ? getFileUrl(
            ['storyboard', 'keyframe'].includes(a.asset_type) ? 'storyboards'
                : a.asset_type.startsWith('audio_')
                    ? (a.asset_type === 'audio_dialogue' ? 'audio' : 'music') : 'video',
            a.project_id, a.file_name) : null,
    }));
    json(res, 200, { project_id: projectId, total: jobs.length, jobs, assets });
}

// -- FILM-033: Multi-Clip Stitching for Long Shots -----------------------

/* ── Background replacement ──────────────────────────────────────────────
 *
 * "Keep the actor in the scene but change the background."
 *
 * The one operation that takes footage which already exists and changes a
 * single thing about it. Every rule about clips, models, windows, prices,
 * hosting and versioning lives in lib/video-edit.js — this file only finds
 * the shot's current clip and hands it over, because a second implementation
 * is how the route gets a fix the MCP tool does not.
 */
function shotWithProject(shotId) {
    // JOINED TO THE SCENE: film_shots has no project_id. A bare SELECT * reads
    // undefined and then resolves a path under the directory "undefined",
    // which fails as a missing clip rather than as the schema mistake it is.
    return db.prepare(`SELECT s.*, sc.project_id FROM film_shots s
        JOIN film_scenes sc ON sc.id = s.scene_id WHERE s.id = ?`).get(shotId);
}

/** The cut a background replacement edits: the best one this shot has. */
function currentClipFor(shotId) {
    return db.prepare(
        `SELECT * FROM film_assets WHERE shot_id = ?
            AND asset_type IN ('video_final','video_synced','video_raw')
          ORDER BY CASE asset_type WHEN 'video_final' THEN 0 WHEN 'video_synced' THEN 1 ELSE 2 END,
                   version DESC, created_at DESC LIMIT 1`).get(shotId);
}

function backgroundSource(shotId) {
    const shot = shotWithProject(shotId);
    if (!shot) return { error: 404, why: 'Shot not found' };
    const clip = currentClipFor(shotId);
    if (!clip) return { shot, clip: null, sourcePath: null };
    return { shot, clip, sourcePath: getFilePath(shot.project_id, 'video', clip.file_name) };
}

/**
 * What this edit would send and what it would cost. FREE.
 *
 * Answers in the shape the shared confirmation reads — prompt, provider,
 * model, estimated_cost, notes — so a background replacement goes through the
 * same gate as everything else that spends rather than a second dialog.
 */
async function previewBackground(res, shotId, query) {
    const { planBackgroundEdit, EDIT_MODEL, buildBackgroundPrompt } = require('../lib/video-edit');
    const src = backgroundSource(shotId);
    if (src.error) return json(res, src.error, { error: src.why });

    const instruction = String((query && query.instruction) || '').trim();
    const provider = 'runway';
    /*
     * A refusal is a 200 CARRYING ITS REASON, not a 4xx. "This shot has no
     * footage yet" is an ANSWER to the question the dialog is asking, and a
     * 4xx would have the page report it as a failure to reach the engine.
     * The prompt is still built, because the gate shows the prompt and an
     * empty one reads as the preview having broken.
     */
    const plan = planBackgroundEdit({
        sourcePath: src.sourcePath,
        // The gate opens before a director has typed anything, so the preview
        // has to describe the operation rather than refuse to describe it.
        instruction: instruction || 'the new background you describe below',
    });

    const notes = [];
    if (!src.clip) notes.push('This shot has no footage yet. Generate or upload a clip first — a '
        + 'background replacement edits footage that already exists.');
    if (plan.refused) notes.push(plan.reason);
    if (!instruction) notes.push('Describe the new background in the prompt below. The performance '
        + 'is preserved by the model, so do not describe the people — saying them again is what '
        + 'makes it re-render them.');

    return json(res, 200, {
        shot_id: shotId, shot_code: src.shot.shot_code,
        capability: 'video',
        can_generate: !plan.refused && !!src.clip,
        provider, model: EDIT_MODEL,
        prompt: plan.refused ? buildBackgroundPrompt(instruction || 'the new background you describe') : plan.prompt,
        ceiling: 1000,
        source: plan.refused ? null : plan.source,
        estimated_cost: plan.refused || !plan.quote.known ? null : {
            usd: plan.quote.usd, native: plan.quote.credits, native_unit: 'credits',
        },
        notes,
        note: 'Runway bills this by the length of the clip handed IN, not the length asked for, '
            + 'so a longer source costs more even though nothing else changes.',
    });
}

/** SPENDS. One generation, landing as a new version on this shot. */
async function replaceBackground(req, res, shotId) {
    const { runBackgroundEdit } = require('../lib/video-edit');
    const src = backgroundSource(shotId);
    if (src.error) return json(res, src.error, { error: src.why });

    // server.js has already parsed it; every other handler in this file reads
    // req.body, and a second reader is one more thing to disagree.
    const body = (req && req.body) || {};
    const result = await runBackgroundEdit({
        db, projectId: src.shot.project_id, shotId, shotCode: src.shot.shot_code,
        sourcePath: src.sourcePath,
        instruction: String(body.instruction || body.prompt_override || ''),
        ignoreBudget: !!body.ignore_budget,
    });
    // 402 is what every other budget gate here answers, and an agent branches
    // on it; every other refusal is a 200 naming its stage.
    if (!result.ok && result.code === 'over_budget') return json(res, 402, result);
    return json(res, 200, result);
}

async function stitchVideo(req, res, shotId) {
    const ctx = loadShotContext(shotId);
    if (!ctx) return json(res, 404, { error: 'Shot not found' });

    const { shot, scene, sceneCard, characters, location, project, initImage } = ctx;
    const durationMs = sceneCard.duration_ms || shot.duration_ms || 4000;

    if (!needsStitching(durationMs)) {
        return json(res, 200, {
            shot_id: shotId, message: 'Shot duration does not require stitching',
            duration_ms: durationMs, needs_stitching: false,
        });
    }

    const clips = planClips(durationMs, req.body);
    const transitions = calculateTransitions(clips);

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_stitch_jobs (id, project_id, shot_id, status, clip_count, transition_type, total_duration_ms, params)
         VALUES (?, ?, ?, 'processing', ?, ?, ?, ?)`
    ).run(jobId, scene.project_id, shotId, clips.length,
        (req.body && req.body.transition) || 'cross-dissolve', durationMs,
        JSON.stringify({ clips, transitions }));

    // Generate each clip
    const stylePreset = project ? project.style_preset : null;
    ensureDir(scene.project_id, 'video');
    const clipResults = [];

    for (const clip of clips) {
        const clipCard = { ...sceneCard, duration_ms: clip.duration_ms };
        const clipCtx = {
            ...ctx, sceneCard: clipCard,
            overrides: { seed: req.body && req.body.seed ? req.body.seed + clip.index : null },
        };
        const payload = buildCapabilityPayload('video', clipCtx).payload;

        try {
            const result = await callGridlight(VIDEO_ENDPOINT, payload);
            if (!result.ok) {
                clipResults.push({ index: clip.index, status: 'failed', error: result.error });
                continue;
            }

            const filename = `${shot.shot_code}_clip_${clip.index}.mp4`;
            await persistProviderMedia(scene.project_id, 'video', filename, result.data, { serveDir: 'videos' });
            clip.clip_url = getFileUrl('video', scene.project_id, filename);
            clipResults.push({ index: clip.index, status: 'complete', clip_url: clip.clip_url });
        } catch (err) {
            if (err.message.includes('ECONNREFUSED')) {
                db.prepare('UPDATE film_stitch_jobs SET status = ?, error_message = ? WHERE id = ?')
                    .run('failed', 'Service unavailable', jobId);
                return json(res, 503, serviceUnavailableError(VIDEO_ENDPOINT, 'video'));
            }
            clipResults.push({ index: clip.index, status: 'failed', error: err.message });
        }
    }

    // Stitch clips together
    const successClips = clipResults.filter(c => c.status === 'complete');
    if (successClips.length < clips.length) {
        db.prepare('UPDATE film_stitch_jobs SET status = ?, error_message = ? WHERE id = ?')
            .run('completed_with_errors', `${clips.length - successClips.length} clips failed`, jobId);

        return json(res, 200, {
            shot_id: shotId, job_id: jobId, status: 'completed_with_errors',
            clips: clipResults, transitions,
        });
    }

    // Call stitch endpoint to join clips
    const stitchPayload = buildStitchPayload(clips, scene.project_id, shot.shot_code, req.body);

    try {
        const stitchResult = await callGridlight(STITCH_ENDPOINT, stitchPayload);

        const filename = `${shot.shot_code}_stitched.mp4`;
        if (!stitchResult.ok) throw new Error(stitchResult.error || 'stitch failed');
        const filePath = await persistProviderMedia(scene.project_id, 'video', filename, stitchResult.data, { serveDir: 'videos' });

        const assetId = generateId();
        db.prepare(
            `INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name, format, mime_type, duration_ms, version)
             VALUES (?, ?, ?, 'video_raw', ?, ?, 'mp4', 'video/mp4', ?, 1)`
        ).run(assetId, scene.project_id, shotId, filePath, filename, durationMs);

        db.prepare('UPDATE film_stitch_jobs SET status = ?, output_path = ? WHERE id = ?')
            .run('complete', filePath, jobId);

        json(res, 200, {
            shot_id: shotId, shot_code: shot.shot_code, job_id: jobId, status: 'complete',
            video_url: getFileUrl('video', scene.project_id, filename),
            clip_count: clips.length, duration_ms: durationMs, transitions,
        });
    } catch (err) {
        db.prepare('UPDATE film_stitch_jobs SET status = ?, error_message = ? WHERE id = ?')
            .run('failed', err.message, jobId);
        json(res, 500, { error: err.message });
    }
}

module.exports = { handleVideoGen };
