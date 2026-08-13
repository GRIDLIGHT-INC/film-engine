/**
 * 3D Asset Generation Pipeline
 *
 * Proxies Gridlight /3d endpoints. Follows the established proxy/BFF pattern:
 * gridlight-client → this route → film_3d_jobs table → film_assets registry.
 *
 * POST /film/characters/:id/model/generate[/stream]     - text -> mesh from character
 * POST /film/characters/:id/model/from-image[/stream]   - reference image -> mesh
 * POST /film/props/:id/model/generate[/stream]          - text -> mesh from prop
 * POST /film/props/:id/model/from-image[/stream]        - reference image -> mesh
 * POST /film/models/:assetId/rig                        - auto-rig an existing mesh
 * POST /film/models/:assetId/retexture                  - regenerate textures
 * POST /film/models/:assetId/animate                    - apply an animation clip
 * GET  /film/models/:assetId/animations                 - list available animations
 * POST /film/projects/:id/models/batch[/stream]         - all characters + props
 * GET  /film/projects/:id/models                        - list model jobs + assets
 * GET  /film/models/job/:jobId                          - single job status
 * GET  /film/3d/:projectId/:filename                    - serve .glb/.gltf/.fbx/.obj/.usdz
 */

const fs = require('fs');
const { db, generateId } = require('../db/database');
const { callGridlight, relayGridlightSSE, serviceUnavailableError, THREED_ENDPOINTS } = require('../lib/gridlight-client');
const { saveFile, getFileUrl, getFilePath, ensureDir, serveFile } = require('../lib/file-storage');
const { persistProviderMedia } = require('../lib/provider-media');
const {
    normalizeSubject,
    build3DPayload,
    buildFromImagePayload,
    buildRigPayload,
    buildRetexturePayload,
    buildAnimatePayload,
} = require('../lib/threed-prompt');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBDIR = '3d';

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function safeName(name) {
    return String(name || 'model').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ── Route Handler ───────────────────────────────────────────────────────

function handleThreeD(req, res, urlParts, query) {
    // /film/3d/:projectId/:filename — serve model files
    if (urlParts[1] === '3d' && urlParts[2] && urlParts[3]) {
        return serveFile(res, urlParts[2], SUBDIR, urlParts[3]);
    }

    // /film/characters|props/:id/model[/generate|from-image[/stream]]
    if ((urlParts[1] === 'characters' || urlParts[1] === 'props') && urlParts[2] && urlParts[3] === 'model') {
        const kind = urlParts[1] === 'props' ? 'prop' : 'character';
        const subjectId = urlParts[2];
        if (!UUID_RE.test(subjectId)) return json(res, 400, { error: 'Invalid subject ID' });

        const sub = urlParts[4];
        const stream = urlParts[5] === 'stream';
        if (req.method === 'POST' && sub === 'generate') return generateModel(req, res, kind, subjectId, stream);
        if (req.method === 'POST' && sub === 'from-image') return generateFromImage(req, res, kind, subjectId, stream);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/models/:assetId/{rig|retexture|animate|animations} and /film/models/job/:jobId
    if (urlParts[1] === 'models' && urlParts[2]) {
        if (urlParts[2] === 'job' && urlParts[3]) {
            if (!UUID_RE.test(urlParts[3])) return json(res, 400, { error: 'Invalid job ID' });
            if (req.method === 'GET') return getJob(req, res, urlParts[3]);
            return json(res, 405, { error: 'Method not allowed' });
        }

        const assetId = urlParts[2];
        if (!UUID_RE.test(assetId)) return json(res, 400, { error: 'Invalid asset ID' });
        const op = urlParts[3];
        if (req.method === 'POST' && op === 'rig') return meshOp(req, res, assetId, 'rig');
        if (req.method === 'POST' && op === 'retexture') return meshOp(req, res, assetId, 'retexture');
        if (req.method === 'POST' && op === 'animate') return meshOp(req, res, assetId, 'animate');
        if (req.method === 'GET' && op === 'animations') return listAnimations(req, res, assetId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/projects/:id/models[/batch[/stream]]
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'models') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });

        const sub = urlParts[4];
        if (req.method === 'POST' && sub === 'batch') {
            if (urlParts[5] === 'stream') return batchModelsStream(req, res, projectId);
            return batchModels(req, res, projectId);
        }
        if (req.method === 'GET' && !sub) return listModelJobs(req, res, projectId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    json(res, 404, { error: 'Not found' });
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Load a character or prop row + its project id. */
function loadSubject(kind, id) {
    if (kind === 'prop') {
        const prop = db.prepare('SELECT * FROM film_props WHERE id = ?').get(id);
        if (!prop) return null;
        return { row: prop, projectId: prop.project_id };
    }
    const ch = db.prepare('SELECT * FROM film_characters WHERE id = ?').get(id);
    if (!ch) return null;
    return { row: ch, projectId: ch.project_id };
}

/**
 * Persist a completed model: write the mesh to local storage, register a
 * film_assets row (asset_type='other', metadata.kind discriminator), and link
 * it back to the job.
 *
 * The service may answer inline binary or `{ model_url }`. Storing the URL
 * left no mesh on disk, so `GET /film/3d/...` 404'd and bundles had nothing to
 * copy; persistProviderMedia downloads it. It throws when the mesh can't be
 * stored — every caller is inside a try/catch that marks the job failed, which
 * is the right outcome rather than recording a model that isn't there.
 *
 * @returns {Promise<{assetId:string, filePath:string, modelUrl:string, filename:string}>}
 */
async function registerModel(projectId, subject, kind, format, data, jobId, metaKind) {
    const filename = `${safeName(subject.name)}.${format}`;
    ensureDir(projectId, SUBDIR);

    const filePath = await persistProviderMedia(projectId, SUBDIR, filename, data);

    const assetId = generateId();
    const metadata = {
        kind: metaKind || 'model_3d',
        subject_kind: kind,
        format,
        character_id: kind === 'character' ? subject.id : null,
        prop_id: kind === 'prop' ? subject.id : null,
    };
    db.prepare(
        `INSERT INTO film_assets (id, project_id, character_id, asset_type, file_path, file_name, format, mime_type, version, metadata)
         VALUES (?, ?, ?, 'other', ?, ?, ?, ?, 1, ?)`
    ).run(
        assetId,
        projectId,
        kind === 'character' ? subject.id : null,
        filePath,
        filename,
        format,
        mimeFor(format),
        JSON.stringify(metadata)
    );

    if (jobId) {
        db.prepare('UPDATE film_3d_jobs SET output_asset_id = ?, output_path = ? WHERE id = ?')
            .run(assetId, filePath || filename, jobId);
    }

    return { assetId, filePath, modelUrl: getFileUrl(SUBDIR, projectId, filename), filename };
}

function mimeFor(format) {
    const map = {
        glb: 'model/gltf-binary', gltf: 'model/gltf+json',
        fbx: 'application/octet-stream', obj: 'text/plain', usdz: 'model/vnd.usdz+zip',
    };
    return map[String(format).toLowerCase()] || 'application/octet-stream';
}

// ── Generate (text -> mesh) ───────────────────────────────────────────────

async function generateModel(req, res, kind, subjectId, stream) {
    const loaded = loadSubject(kind, subjectId);
    if (!loaded) return json(res, 404, { error: `${kind} not found` });

    const { row, projectId } = loaded;
    const subject = { ...normalizeSubject(row, kind), id: subjectId };
    const opts = req.body || {};
    const payload = build3DPayload(subject, opts);
    const format = payload.format;

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_3d_jobs (id, project_id, character_id, prop_id, subject_kind, gen_type, status, model, format, seed, prompt, params)
         VALUES (?, ?, ?, ?, ?, 'generate', 'generating', ?, ?, ?, ?, ?)`
    ).run(
        jobId, projectId,
        kind === 'character' ? subjectId : null,
        kind === 'prop' ? subjectId : null,
        kind, payload.model, format, payload.seed, payload.prompt, JSON.stringify(payload)
    );

    if (stream) {
        return runGenerateStream(res, THREED_ENDPOINTS.generate, payload, {
            projectId, subject, kind, format, jobId, metaKind: 'model_3d',
        });
    }
    return runGenerateSync(res, THREED_ENDPOINTS.generate, payload, {
        projectId, subject, kind, format, jobId, subjectId, metaKind: 'model_3d',
    });
}

// ── Generate (reference image -> mesh) ────────────────────────────────────

async function generateFromImage(req, res, kind, subjectId, stream) {
    const loaded = loadSubject(kind, subjectId);
    if (!loaded) return json(res, 404, { error: `${kind} not found` });

    const { row, projectId } = loaded;
    const subject = { ...normalizeSubject(row, kind), id: subjectId };
    const opts = req.body || {};

    // Resolve an init image: explicit body ref, else the subject's newest reference asset on disk.
    let imageRef = opts.init_image || null;
    if (!imageRef) {
        const refAsset = db.prepare(
            `SELECT * FROM film_assets
             WHERE project_id = ? AND (character_id = ? OR file_name LIKE ?)
               AND asset_type IN ('reference_image','character_sheet','reference_sheet','storyboard')
             ORDER BY created_at DESC LIMIT 1`
        ).get(projectId, kind === 'character' ? subjectId : '', `${safeName(subject.name)}%`);
        // Defense-in-depth: only read a DB-sourced file_name that is a plain
        // basename (no separators / traversal) before touching the disk.
        if (refAsset && refAsset.file_name && /^[\w.-]+$/.test(refAsset.file_name)) {
            // Try known image subdirs.
            for (const dir of ['refsheets', 'loc-refs', 'prop-refs', 'storyboards']) {
                // The regex above admits ".." — getFilePath is what actually
                // enforces containment, so a refusal just means "not here".
                let p;
                try { p = getFilePath(projectId, dir, refAsset.file_name); } catch (_) { continue; }
                if (fs.existsSync(p)) { imageRef = fs.readFileSync(p).toString('base64'); break; }
            }
        }
    }
    if (!imageRef) {
        return json(res, 400, { error: 'No reference image available. Generate a reference image/sheet first or pass init_image.' });
    }

    const payload = buildFromImagePayload(imageRef, opts);
    const format = payload.format;

    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_3d_jobs (id, project_id, character_id, prop_id, subject_kind, gen_type, status, model, format, seed, params)
         VALUES (?, ?, ?, ?, ?, 'from_image', 'generating', ?, ?, ?, ?)`
    ).run(
        jobId, projectId,
        kind === 'character' ? subjectId : null,
        kind === 'prop' ? subjectId : null,
        kind, payload.model, format, payload.seed, JSON.stringify({ ...payload, init_image: '<omitted>' })
    );

    if (stream) {
        return runGenerateStream(res, THREED_ENDPOINTS.fromImage, payload, {
            projectId, subject, kind, format, jobId, metaKind: 'model_3d',
        });
    }
    return runGenerateSync(res, THREED_ENDPOINTS.fromImage, payload, {
        projectId, subject, kind, format, jobId, subjectId, metaKind: 'model_3d',
    });
}

// ── Shared generate runners ───────────────────────────────────────────────

async function runGenerateSync(res, endpoint, payload, ctx) {
    try {
        const result = await callGridlight(endpoint, payload);
        if (!result.ok) {
            db.prepare('UPDATE film_3d_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, ctx.jobId);
            if (result.status === 503) return json(res, 503, serviceUnavailableError(endpoint, '3d'));
            return json(res, result.status || 500, { error: result.error });
        }

        // Async job handoff: service returned a job id instead of a mesh.
        if (result.data && result.data.job_id && !Buffer.isBuffer(result.data) && !result.data.model_url && !result.data.url) {
            db.prepare('UPDATE film_3d_jobs SET upstream_job_id = ? WHERE id = ?').run(String(result.data.job_id), ctx.jobId);
            return json(res, 202, {
                job_id: ctx.jobId, upstream_job_id: result.data.job_id, status: 'generating',
                subject_id: ctx.subjectId, poll: `/film/models/job/${ctx.jobId}`,
            });
        }

        const reg = await registerModel(ctx.projectId, ctx.subject, ctx.kind, ctx.format, result.data, ctx.jobId, ctx.metaKind);
        db.prepare('UPDATE film_3d_jobs SET status = ? WHERE id = ?').run('complete', ctx.jobId);

        return json(res, 200, {
            job_id: ctx.jobId, status: 'complete', subject_id: ctx.subjectId,
            asset_id: reg.assetId, model_url: reg.modelUrl, format: ctx.format,
        });
    } catch (err) {
        db.prepare('UPDATE film_3d_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, ctx.jobId);
        if (err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(endpoint, '3d'));
        return json(res, 500, { error: err.message });
    }
}

async function runGenerateStream(res, endpoint, payload, ctx) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    if (res.socket) res.socket.setTimeout(0);

    let clientGone = false;
    res.on('close', () => { clientGone = true; });
    const sendEvent = (data) => { if (res.writableEnded) return; res.write(`data: ${JSON.stringify(data)}\n\n`); };

    sendEvent({ type: 'status', phase: 'starting', job_id: ctx.jobId, subject_id: ctx.subject.id });

    try {
        // The SSE relay invokes onComplete synchronously, so the mesh download
        // can't happen inside it. Capture the payload and persist once the
        // stream resolves — the response is still open, so the complete event
        // is emitted in the same order the client expects.
        let completedData = null;

        const { ok, error } = await relayGridlightSSE(endpoint, payload, res, {
            onComplete: (data) => {
                if (clientGone) return;
                completedData = data;
            },
            onError: (data) => {
                db.prepare('UPDATE film_3d_jobs SET status = ?, error_message = ? WHERE id = ?')
                    .run('failed', data.error || 'Unknown', ctx.jobId);
            },
        });

        if (!ok && !clientGone) {
            sendEvent({ type: 'error', error: error || '3D generation failed' });
            db.prepare('UPDATE film_3d_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', error || 'failed', ctx.jobId);
        } else if (completedData && !clientGone) {
            try {
                const reg = await registerModel(ctx.projectId, ctx.subject, ctx.kind, ctx.format, completedData, ctx.jobId, ctx.metaKind);
                db.prepare('UPDATE film_3d_jobs SET status = ? WHERE id = ?').run('complete', ctx.jobId);
                sendEvent({ type: 'complete', asset_id: reg.assetId, model_url: reg.modelUrl, format: ctx.format });
            } catch (err) {
                db.prepare('UPDATE film_3d_jobs SET status = ?, error_message = ? WHERE id = ?')
                    .run('failed', `mesh not stored: ${err.message}`, ctx.jobId);
                sendEvent({ type: 'error', error: `3D model generated but could not be stored: ${err.message}` });
            }
        }
    } catch (err) {
        sendEvent({ type: 'error', error: err.message });
        db.prepare('UPDATE film_3d_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, ctx.jobId);
    }

    sendEvent({ type: 'done' });
    if (!res.writableEnded) res.end();
}

// ── Mesh operations: rig / retexture / animate ────────────────────────────

async function meshOp(req, res, assetId, op) {
    const asset = db.prepare("SELECT * FROM film_assets WHERE id = ?").get(assetId);
    if (!asset) return json(res, 404, { error: 'Model asset not found' });

    let meta = {};
    try { meta = JSON.parse(asset.metadata || '{}'); } catch (_) {}
    if (meta.kind && !String(meta.kind).startsWith('model')) {
        return json(res, 400, { error: 'Asset is not a 3D model' });
    }

    // Reference the upstream model: prefer a stored upstream id, else the served URL.
    const assetRef = meta.upstream_asset_id || asset.file_path || getFileUrl(SUBDIR, asset.project_id, asset.file_name);
    const opts = req.body || {};

    let endpoint, payload, genType, metaKind;
    if (op === 'rig') {
        endpoint = THREED_ENDPOINTS.rig; payload = buildRigPayload(assetRef, opts);
        genType = 'rig'; metaKind = 'model_rigged';
    } else if (op === 'retexture') {
        endpoint = THREED_ENDPOINTS.retexture; payload = buildRetexturePayload(assetRef, opts);
        genType = 'retexture'; metaKind = 'model_3d';
    } else {
        endpoint = THREED_ENDPOINTS.animate; payload = buildAnimatePayload(assetRef, opts.animation, opts);
        genType = 'animate'; metaKind = 'model_animated';
    }

    const format = asset.format || 'glb';
    const jobId = generateId();
    db.prepare(
        `INSERT INTO film_3d_jobs (id, project_id, character_id, subject_kind, gen_type, status, source_asset_id, model, format, params)
         VALUES (?, ?, ?, ?, ?, 'generating', ?, ?, ?, ?)`
    ).run(jobId, asset.project_id, asset.character_id, meta.subject_kind || 'character', genType, assetId, payload.model, format, JSON.stringify(payload));

    try {
        const result = await callGridlight(endpoint, payload);
        if (!result.ok) {
            db.prepare('UPDATE film_3d_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', result.error, jobId);
            if (result.status === 503) return json(res, 503, serviceUnavailableError(endpoint, '3d'));
            return json(res, result.status || 500, { error: result.error });
        }

        const subject = { id: asset.character_id, name: (asset.file_name || 'model').replace(/\.[^.]+$/, '') + `_${genType}` };
        const reg = await registerModel(asset.project_id, subject, meta.subject_kind || 'character', format, result.data, jobId, metaKind);
        db.prepare('UPDATE film_3d_jobs SET status = ? WHERE id = ?').run('complete', jobId);

        return json(res, 200, {
            job_id: jobId, status: 'complete', operation: op,
            source_asset_id: assetId, asset_id: reg.assetId, model_url: reg.modelUrl,
        });
    } catch (err) {
        db.prepare('UPDATE film_3d_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
        if (err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(endpoint, '3d'));
        return json(res, 500, { error: err.message });
    }
}

async function listAnimations(req, res, assetId) {
    const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(assetId);
    if (!asset) return json(res, 404, { error: 'Model asset not found' });

    try {
        const assetRef = asset.file_path || getFileUrl(SUBDIR, asset.project_id, asset.file_name);
        const result = await callGridlight(THREED_ENDPOINTS.animations, { asset: assetRef });
        if (!result.ok) {
            if (result.status === 503) return json(res, 503, serviceUnavailableError(THREED_ENDPOINTS.animations, '3d'));
            return json(res, result.status || 500, { error: result.error });
        }
        const animations = (result.data && (result.data.animations || result.data)) || [];
        return json(res, 200, { asset_id: assetId, animations });
    } catch (err) {
        if (err.message.includes('ECONNREFUSED')) return json(res, 503, serviceUnavailableError(THREED_ENDPOINTS.animations, '3d'));
        return json(res, 500, { error: err.message });
    }
}

// ── Batch ─────────────────────────────────────────────────────────────────

function collectSubjects(projectId) {
    const characters = db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(projectId)
        .map(r => ({ kind: 'character', row: r, id: r.id }));
    const props = db.prepare('SELECT * FROM film_props WHERE project_id = ?').all(projectId)
        .map(r => ({ kind: 'prop', row: r, id: r.id }));
    return [...characters, ...props];
}

async function batchModels(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const subjects = collectSubjects(projectId);
    return json(res, 200, {
        project_id: projectId, total_subjects: subjects.length,
        subjects: subjects.map(s => ({ kind: s.kind, id: s.id, name: s.row.name })),
        hint: 'Use POST /film/projects/:id/models/batch/stream for actual generation with progress',
    });
}

async function batchModelsStream(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return json(res, 404, { error: 'Project not found' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    if (res.socket) res.socket.setTimeout(0);

    let clientGone = false;
    res.on('close', () => { clientGone = true; });
    const sendEvent = (data) => { if (res.writableEnded) return; res.write(`data: ${JSON.stringify(data)}\n\n`); };

    const subjects = collectSubjects(projectId);
    sendEvent({ type: 'status', phase: 'starting', total_subjects: subjects.length, project_id: projectId });
    let completed = 0, failed = 0;

    for (const s of subjects) {
        if (clientGone || res.writableEnded) break; // client disconnected — stop firing 3D jobs
        const subject = { ...normalizeSubject(s.row, s.kind), id: s.id };
        const payload = build3DPayload(subject, req.body || {});
        const format = payload.format;

        sendEvent({ type: 'subject_start', kind: s.kind, id: s.id, name: subject.name });

        const jobId = generateId();
        db.prepare(
            `INSERT INTO film_3d_jobs (id, project_id, character_id, prop_id, subject_kind, gen_type, status, model, format, seed, prompt, params)
             VALUES (?, ?, ?, ?, ?, 'generate', 'generating', ?, ?, ?, ?, ?)`
        ).run(
            jobId, projectId,
            s.kind === 'character' ? s.id : null,
            s.kind === 'prop' ? s.id : null,
            s.kind, payload.model, format, payload.seed, payload.prompt, JSON.stringify(payload)
        );

        try {
            const result = await callGridlight(THREED_ENDPOINTS.generate, payload);
            if (!result.ok) throw new Error(result.error);

            const reg = await registerModel(projectId, subject, s.kind, format, result.data, jobId, 'model_3d');
            db.prepare('UPDATE film_3d_jobs SET status = ? WHERE id = ?').run('complete', jobId);
            sendEvent({ type: 'subject_complete', kind: s.kind, id: s.id, asset_id: reg.assetId, model_url: reg.modelUrl });
            completed++;
        } catch (err) {
            db.prepare('UPDATE film_3d_jobs SET status = ?, error_message = ? WHERE id = ?').run('failed', err.message, jobId);
            sendEvent({ type: 'subject_failed', kind: s.kind, id: s.id, error: err.message });
            failed++;
        }
    }

    sendEvent({ type: 'result', project_id: projectId, subjects_completed: completed, subjects_failed: failed });
    sendEvent({ type: 'done' });
    if (!res.writableEnded) res.end();
}

// ── Status & Listing ──────────────────────────────────────────────────────

function getJob(req, res, jobId) {
    const job = db.prepare('SELECT * FROM film_3d_jobs WHERE id = ?').get(jobId);
    if (!job) return json(res, 404, { error: 'Job not found' });

    let model_url = null;
    if (job.output_asset_id) {
        const asset = db.prepare('SELECT * FROM film_assets WHERE id = ?').get(job.output_asset_id);
        if (asset && asset.file_name) model_url = getFileUrl(SUBDIR, job.project_id, asset.file_name);
    }
    return json(res, 200, { ...job, model_url });
}

function listModelJobs(req, res, projectId) {
    const jobs = db.prepare('SELECT * FROM film_3d_jobs WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
    const assets = db.prepare(
        `SELECT * FROM film_assets WHERE project_id = ? AND asset_type = 'other'
           AND json_extract(metadata, '$.kind') LIKE 'model%' ORDER BY created_at DESC`
    ).all(projectId).map(a => ({
        asset_id: a.id, file_name: a.file_name, format: a.format,
        model_url: a.file_name ? getFileUrl(SUBDIR, projectId, a.file_name) : null,
        metadata: safeParse(a.metadata),
    }));

    return json(res, 200, { project_id: projectId, total_jobs: jobs.length, jobs, models: assets });
}

function safeParse(s) { try { return JSON.parse(s || '{}'); } catch (_) { return {}; } }

module.exports = { handleThreeD };
