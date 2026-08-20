/**
 * FILM-017: Storyboard Generation Endpoint
 * FILM-019: Storyboard Viewer Endpoint
 * FILM-020: Per-Shot Storyboard Regeneration
 *
 * POST /film/projects/:id/storyboard/generate          — Generate storyboard (sync)
 * POST /film/projects/:id/storyboard/generate/stream    — Generate storyboard (SSE)
 * GET  /film/projects/:id/storyboard                    — View storyboard frames
 * POST /film/shots/:id/storyboard/regenerate            — Regenerate single shot
 * GET  /film/storyboards/:projectId/:filename           — Serve storyboard image
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, generateId } = require('../db/database');
const { buildStoryboardPrompt, applyStyleLock } = require('../lib/storyboard-prompt');
const { GRIDLIGHT_URL, GRIDLIGHT_API_KEY } = require('../lib/gridlight-client');
const { buildShotReferencePayload, applyConsistencyToImagePayload, recordConsistencyCheck, auditProjectReadiness } = require('../lib/consistency-context');
const { resolveGenerator } = require('../lib/providers');
const { selectReferences } = require('../lib/reference-images');
const { generateImageWithFallback, imageProviderChain } = require('../lib/image-fallback');
const { endpointFor: gridlightEndpointFor } = require('../lib/providers/gridlight-adapter');
const { extractMediaUrl, resolveMediaUrl, isGatewayUrl } = require('../lib/provider-media');
const { imageRequestPayload, providerConfigOf } = require('../lib/capability-payloads');
const { loadBlocking, approvalState } = require('./previs');
const { effectiveCamera } = require('../lib/previs-blocking');
const { filmOptics } = require('../lib/look-development');

const os = require('os');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA_DIR = process.env.FILM_DATA_DIR || path.join(os.homedir(), '.gridlight', 'film-engine', 'data');

// ── Helpers ─────────────────────────────────────────────────────────

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function ensureStoryboardDir(projectId) {
    const dir = path.join(DATA_DIR, 'storyboards', projectId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

function storyboardImageUrl(projectId, shotCode) {
    return `/film/storyboards/${projectId}/${shotCode}.png`;
}

function storyboardImagePath(projectId, shotCode) {
    return path.join(DATA_DIR, 'storyboards', projectId, `${shotCode}.png`);
}

/**
 * Resolve an image URL from Gridlight response.
 * Handles full URLs, absolute paths, and bare filenames.
 */
function resolveImageUrl(imageUrl) {
    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        return imageUrl;
    }
    if (imageUrl.startsWith('/')) {
        return `${GRIDLIGHT_URL}${imageUrl}`;
    }
    return `${GRIDLIGHT_URL}/images/${imageUrl}`;
}

/**
 * Turn a provider's image response into PNG bytes.
 *
 * Adapters answer either with a Buffer (binary body) or with parsed JSON naming
 * a URL. provider-media already knows both shapes and how to resolve a bare
 * filename against the gateway's serving directory, so this is a thin adapter
 * from "generation result" to "the Buffer this route writes to disk".
 */
async function imageResultToBuffer(data) {
    if (Buffer.isBuffer(data)) return data;

    const imageUrl = extractMediaUrl(data);
    if (!imageUrl) {
        throw new Error('image provider returned neither image bytes nor an image URL');
    }

    const fetchUrl = resolveMediaUrl(imageUrl, 'images');
    const headers = {};
    // Only forward our credential to the gateway itself, never to a CDN a
    // provider might point us at. Origin comparison, not a prefix test: see
    // isGatewayUrl for why the two are not interchangeable.
    if (GRIDLIGHT_API_KEY && isGatewayUrl(fetchUrl)) {
        headers['Authorization'] = `Bearer ${GRIDLIGHT_API_KEY}`;
    }

    const imgRes = await fetch(fetchUrl, { headers });
    if (!imgRes.ok) {
        throw new Error(`Failed to fetch generated image: ${imgRes.status}`);
    }
    return Buffer.from(await imgRes.arrayBuffer());
}

/**
 * Generate a storyboard image. Returns a Buffer of PNG data.
 *
 * This used to POST straight to `${GRIDLIGHT_URL}/image`, which meant a project
 * whose provider_config selected Runway or OpenAI for `image` still had every
 * storyboard rendered by Gridlight — the provider layer was bypassed on the one
 * path users meet first. It now resolves the image capability like every other
 * generation route, and the request body is built by capability-payloads so the
 * route and the orchestrator cannot describe an image differently.
 *
 * @param {object} [projectConfig] - parsed film_projects.provider_config
 */
async function callImageGen(prompt, negativePrompt, seed, options, projectConfig) {
    const requestBody = imageRequestPayload({
        ...(options || {}),
        prompt,
        negative_prompt: negativePrompt,
        seed: seed || null,
    });

    // Walk the credentialed image providers rather than betting the shot on
    // one. Runway's moderation is non-deterministic on this material — the same
    // prompt for the same shot passed and then failed minutes apart — so a
    // refusal is a condition to route around, not a verdict on the shot.
    const result = await generateImageWithFallback(requestBody, projectConfig || {}, { timeout: 300000 });

    if (!result || !result.ok) {
        const tried = (result && result._chain || [])
            .map(a => `${a.provider}: ${a.error}`).join(' | ') || (result && result.error) || 'unknown error';
        const err = new Error(`ImageGen error: ${tried}`);
        err.status = result && result.status;
        err.providerChain = result && result._chain;
        throw err;
    }

    // Return provenance alongside the bytes. The render ledger exists to make a
    // frame reproducible, and it was recording the REQUESTED payload defaults
    // (`sdxl`, steps 30, guidance 7.5) rather than what ran -- parameters the
    // provider never received, naming a model it had rejected. A ledger that
    // cannot recreate its own output is worse than none, because it is trusted.
    return {
        // await matters: imageResultToBuffer is async (it may have to fetch a
        // provider URL). Returning it unawaited inside an object stores a
        // Promise where the caller expects bytes.
        buffer: await imageResultToBuffer(result.data),
        provider: result.provider || provider.id,
        model: result.provider_model || requestBody.model,
    };
}

/**
 * Call the ImageGen API with SSE streaming for progress updates.
 * Returns { buffer, metadata } where buffer is the PNG image data.
 * Calls onProgress callback with progress events during generation.
 */
async function callImageGenStream(prompt, negativePrompt, seed, options, onProgress, projectConfig) {
    const payload = imageRequestPayload({
        ...(options || {}),
        prompt,
        negative_prompt: negativePrompt,
        seed: seed || null,
    });
    payload.stream = true;

    const chain = imageProviderChain(projectConfig || {});
    const provider = chain[0] || resolveGenerator('image', projectConfig || {});

    // The progress-SSE contract parsed below is Gridlight's. Any other provider
    // generates non-streaming and reports a single completed step — the point
    // being that selecting Runway or OpenAI for `image` must actually reach
    // them, where before this whole function posted to Gridlight regardless.
    if (provider.id !== 'gridlight') {
        const { buffer, model } = await callImageGen(prompt, negativePrompt, seed, options, projectConfig);
        if (onProgress) onProgress({ type: 'progress', step: 1, total_steps: 1 });
        return {
            buffer,
            metadata: { provider: provider.id, provider_model: model, seed: payload.seed },
        };
    }

    const headers = { 'Content-Type': 'application/json' };
    if (GRIDLIGHT_API_KEY) {
        headers['Authorization'] = `Bearer ${GRIDLIGHT_API_KEY}`;
    }

    // Endpoint comes from the adapter's own capability map rather than being
    // spelled out here, so there is one definition of where `image` lives.
    const response = await fetch(`${GRIDLIGHT_URL}${gridlightEndpointFor('image')}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`ImageGen error ${response.status}: ${errText}`);
    }

    const contentType = response.headers.get('content-type') || '';

    // Handle SSE streaming response
    // Gridlight /image SSE format (plain data: lines, event type embedded in JSON):
    //   data: {"event":"progress","step":N,"total_steps":M}
    //   data: {"event":"completed","image_url":"http://...","seed":N,"generation_time_ms":N}
    if (contentType.includes('text/event-stream')) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let imageUrl = null;
        let metadata = {};

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const dataStr = line.slice(6).trim();
                if (!dataStr || dataStr === '[DONE]') continue;

                try {
                    const data = JSON.parse(dataStr);

                    if (data.event === 'progress' || (data.step !== undefined && data.total_steps !== undefined)) {
                        if (onProgress) onProgress({
                            type: 'progress',
                            step: data.step || 0,
                            total_steps: data.total_steps || payload.steps,
                        });
                    } else if (data.event === 'completed' && data.image_url) {
                        imageUrl = data.image_url;
                        metadata = {
                            seed: data.seed,
                            model: data.model || data.model_used,
                            generation_time_ms: data.generation_time_ms,
                        };
                    } else if (data.image_url || data.url) {
                        if (!imageUrl) imageUrl = data.image_url || data.url;
                        if (data.seed) metadata.seed = data.seed;
                        if (data.generation_time_ms) metadata.generation_time_ms = data.generation_time_ms;
                    } else if (data.image_urls && data.image_urls.length > 0) {
                        if (!imageUrl) imageUrl = data.image_urls[0];
                        if (data.seed) metadata.seed = data.seed;
                    } else if (data.error) {
                        throw new Error(data.error || 'Image generation failed');
                    }
                } catch (parseErr) {
                    if (parseErr.message && !parseErr.message.includes('JSON')) throw parseErr;
                }
            }
        }

        if (!imageUrl) {
            throw new Error('Image generation stream completed but no image URL received');
        }

        // Download the generated image
        const imgRes = await fetch(resolveImageUrl(imageUrl));
        if (!imgRes.ok) {
            throw new Error(`Failed to fetch generated image: ${imgRes.status}`);
        }

        return { buffer: Buffer.from(await imgRes.arrayBuffer()), metadata };
    }

    // Handle JSON response (non-streaming fallback)
    if (contentType.includes('application/json')) {
        const data = await response.json();
        const imageUrl = data.image_url || data.url || (data.image_urls && data.image_urls[0]) || data.filename;
        if (!imageUrl) throw new Error('No image_url in image response');

        const imgRes = await fetch(resolveImageUrl(imageUrl));
        if (!imgRes.ok) throw new Error(`Failed to fetch image: ${imgRes.status}`);

        return { buffer: Buffer.from(await imgRes.arrayBuffer()), metadata: data };
    }

    // Legacy: raw binary
    return { buffer: Buffer.from(await response.arrayBuffer()), metadata: {} };
}

/**
 * Load shots for a project, joined with scene data, ordered by scene_number + shot_code.
 */
function loadProjectShots(projectId) {
    return db.prepare(`
        SELECT s.id AS shot_id, s.shot_code, s.scene_card_yaml, s.duration_ms, s.status,
               s.scene_id, sc.scene_number, sc.int_ext, sc.location, sc.time_of_day,
               sc.description AS scene_description, sc.characters_present
        FROM film_shots s
        JOIN film_scenes sc ON s.scene_id = sc.id
        WHERE sc.project_id = ? AND sc.status != 'removed'
        ORDER BY sc.scene_number, s.shot_code
    `).all(projectId);
}

/**
 * Log a render to the render_ledger for reproducibility.
 */
function logToRenderLedger(shotId, params) {
    const id = generateId();
    const version = (db.prepare(
        'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM render_ledger WHERE shot_id = ?'
    ).get(shotId) || { v: 1 }).v;

    db.prepare(`
        INSERT INTO render_ledger (id, shot_id, version, step, model_id, seed, steps, guidance,
            lora_ids, prompt, negative_prompt, camera_params, lighting_params,
            output_path, resolution, mode, extra_params)
        VALUES (?, ?, ?, 'keyframe', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, shotId, version,
        // What RAN, not what was asked for. Defaulting to 'sdxl' here is how
        // the ledger came to name a model the provider had rejected.
        params.model || 'unrecorded',
        params.seed || -1,
        params.steps || 30,
        params.guidance || 7.5,
        JSON.stringify(params.lora_ids || []),
        params.prompt || '',
        params.negative_prompt || '',
        JSON.stringify(params.camera_params || {}),
        JSON.stringify(params.lighting_params || {}),
        params.output_path || '',
        params.resolution || '1024x1024',
        params.mode || 'creative',
        JSON.stringify({ provider: params.provider || null })
    );

    return { id, version };
}

/**
 * Register or update a storyboard asset in film_assets.
 */
function registerStoryboardAsset(projectId, shotId, filePath, fileName, options) {
    const opts = options || {};
    // Check for existing storyboard asset for this shot
    const existing = db.prepare(
        'SELECT id, version FROM film_assets WHERE shot_id = ? AND asset_type = \'storyboard\' ORDER BY version DESC LIMIT 1'
    ).get(shotId);

    const version = existing ? (existing.version || 0) + 1 : 1;
    const id = generateId();

    // Read the dimensions off the file rather than asserting 1024x1024, which
    // was wrong for every project that is not square -- and silently so, since
    // nothing downstream re-measures. A PNG's IHDR width/height are big-endian
    // uint32s at fixed offsets 16 and 20.
    let width = null, height = null;
    try {
        const head = Buffer.alloc(24);
        const fd = fs.openSync(filePath, 'r');
        try { fs.readSync(fd, head, 0, 24, 0); } finally { fs.closeSync(fd); }
        if (head.slice(1, 4).toString('ascii') === 'PNG') {
            width = head.readUInt32BE(16);
            height = head.readUInt32BE(20);
        }
    } catch (_) { /* leave null rather than record a guess */ }

    db.prepare(`
        INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name,
            format, mime_type, width, height, version, input_refs, provider, provider_model)
        VALUES (?, ?, ?, 'storyboard', ?, ?, 'png', 'image/png', ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, shotId, filePath, fileName, width, height, version,
        JSON.stringify(opts.input_refs || []), opts.provider || null, opts.provider_model || null);

    // Same kind the orchestrator records for its keyframe step, so a frame is
    // stale on the same terms however it was generated.
    require('../lib/artefact-fingerprint').stampAsset(id, 'keyframe', { shotId });

    return { id, version };
}

/**
 * Reference plates for one shot.
 *
 * Continuity by picture: an approved plate of Maya is exact where 240
 * characters describing her cardigan are approximate, and it costs the prompt
 * ~6 characters instead of ~240. Candidates are ranked and capped by
 * lib/reference-images (identity before place, three maximum), and a subject
 * with no plate simply falls back to its prose description — so a project that
 * has never generated a reference sheet behaves exactly as before.
 */
function gatherShotReferences(projectId, matchedChars, matchedLocation, sceneCardProps) {
    const candidates = [];

    for (const ch of matchedChars || []) {
        if (!ch || !ch.id) continue;
        const plate = db.prepare(
            `SELECT file_path, file_name FROM film_assets
             WHERE project_id = ? AND character_id = ?
               AND asset_type IN ('character_sheet', 'reference_image')
             ORDER BY version DESC, created_at DESC LIMIT 1`
        ).get(projectId, ch.id);
        if (plate) candidates.push({ name: ch.name, kind: 'character', file_path: plate.file_path });
    }

    if (matchedLocation && matchedLocation.id) {
        const plate = db.prepare(
            `SELECT file_path, file_name FROM film_assets
             WHERE project_id = ? AND location_id = ?
               AND asset_type IN ('reference_image', 'character_sheet')
             ORDER BY version DESC, created_at DESC LIMIT 1`
        ).get(projectId, matchedLocation.id);
        if (plate) candidates.push({ name: matchedLocation.name, kind: 'location', file_path: plate.file_path });
    }

    // The film's look, as a picture. lib/reference-images has had a `style`
    // rank since it was written and nothing ever filled it, so a frame pinned
    // to the mood board changed no output anywhere. Ranked below character and
    // location, so with three slots a look plate never displaces the actor — a
    // viewer notices a different face long before a different grade.
    try {
        for (const ref of require('../lib/look-development').styleReferences(db, projectId, 1)) {
            candidates.push(ref);
        }
    } catch (_) { /* a project with no board generates exactly as before */ }

    // Props named on the scene card. Ranked below character and location by
    // lib/reference-images, so with the 3-reference cap they only claim a slot
    // when there is one free — a prop displacing the actor would be the wrong
    // trade every time.
    const propNames = Array.isArray(sceneCardProps) ? sceneCardProps : [];
    for (const raw of propNames) {
        const name = typeof raw === 'string' ? raw : (raw && raw.name);
        if (!name) continue;
        const prop = db.prepare(
            'SELECT id, name FROM film_props WHERE project_id = ? AND UPPER(name) = UPPER(?) LIMIT 1'
        ).get(projectId, name);
        if (!prop) continue;
        const plate = db.prepare(
            `SELECT file_path FROM film_assets
             WHERE project_id = ? AND prop_id = ? AND asset_type IN ('reference_image', 'character_sheet')
             ORDER BY version DESC, created_at DESC LIMIT 1`
        ).get(projectId, prop.id);
        if (plate) candidates.push({ name: prop.name, kind: 'prop', file_path: plate.file_path });
    }

    return selectReferences(candidates);
}

// ── Route Handler ───────────────────────────────────────────────────

function handleStoryboard(req, res, urlParts, query) {
    // /film/storyboards/:projectId/:filename — serve static image
    if (urlParts[1] === 'storyboards' && urlParts[2] && urlParts[3]) {
        return serveStoryboardImage(res, urlParts[2], urlParts[3]);
    }

    // /film/projects/:id/storyboard[/generate[/stream]]
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'storyboard') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) {
            return json(res, 400, { error: 'Invalid project ID' });
        }

        const sub = urlParts[4]; // 'generate' or undefined

        if (sub === 'generate') {
            const stream = urlParts[5] === 'stream';
            // Allow GET for SSE stream (EventSource only supports GET)
            if (stream && (req.method === 'GET' || req.method === 'POST')) {
                return generateStoryboardStream(req, res, projectId, query);
            }
            if (req.method !== 'POST') {
                return json(res, 405, { error: 'Method not allowed' });
            }
            return generateStoryboard(req, res, projectId, query);
        }

        if (!sub) {
            if (req.method === 'GET') {
                return getStoryboard(req, res, projectId, query);
            }
            return json(res, 405, { error: 'Method not allowed' });
        }

        return json(res, 404, { error: 'Not found' });
    }

    // GET /film/shots/:id/prompt — what would be sent, and the room left.
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'prompt') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid shot ID' });
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        return shotPromptPreview(req, res, urlParts[2]);
    }

    // /film/shots/:id/storyboard/regenerate
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'storyboard') {
        const shotId = urlParts[2];
        if (!UUID_RE.test(shotId)) {
            return json(res, 400, { error: 'Invalid shot ID' });
        }

        if (urlParts[4] === 'regenerate' && req.method === 'POST') {
            return regenerateShot(req, res, shotId);
        }

        return json(res, 404, { error: 'Not found' });
    }

    json(res, 404, { error: 'Not found' });
}

// ── Serve Static Storyboard Image ──────────────────────────────────

function serveStoryboardImage(res, projectId, filename) {
    // Sanitize filename: only allow alphanumeric, hyphens, underscores, dots
    if (!/^[\w.-]+$/.test(filename)) {
        return json(res, 400, { error: 'Invalid filename' });
    }
    // Validate projectId shape so it can't be used to escape the data dir.
    if (!UUID_RE.test(projectId)) {
        return json(res, 400, { error: 'Invalid project ID' });
    }

    const filePath = path.join(DATA_DIR, 'storyboards', projectId, filename);
    // Defense-in-depth: ensure the resolved path stays inside DATA_DIR.
    const baseDir = path.resolve(DATA_DIR);
    if (!path.resolve(filePath).startsWith(baseDir + path.sep)) {
        return json(res, 400, { error: 'Invalid file path' });
    }
    if (!fs.existsSync(filePath)) {
        return json(res, 404, { error: 'Image not found' });
    }

    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
    };

    res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
}

// ── FILM-019: Get Storyboard ───────────────────────────────────────

/**
 * Whether a shot has been staged, and whether the sign-off still describes it.
 *
 * Three states, not two. "Approved" and "approved, then restaged" are the
 * distinction the whole iterate-until-happy loop turns on, and folding them
 * together is how a director ends up meeting a 409 at generation time for a
 * shot the board told them was signed off.
 */
function previsStateFor(shotId) {
    let blocking = null;
    try { blocking = loadBlocking(shotId); } catch (_) { blocking = null; }
    if (!blocking) return { blocked: false, approved: false, stale: false };
    let approval = { approved: false, stale: false, approved_at: null };
    try { approval = approvalState(shotId); } catch (_) { /* keep the default */ }
    return {
        blocked: true,
        approved: approval.approved,
        stale: approval.stale,
        approved_at: approval.approved_at,
        rig: blocking.rig,
        moves: Array.isArray(blocking.moves) ? blocking.moves.length : 0,
        duration_ms: blocking.durationMs || 0,
    };
}

/** The camera generation will use, through the one precedence rule. */
function cameraFor(shotId, sceneCard, optics) {
    let blocking = null;
    try { blocking = loadBlocking(shotId); } catch (_) { blocking = null; }
    return effectiveCamera(sceneCard.camera || {}, blocking, optics);
}

function getStoryboard(req, res, projectId, query) {
    const project = db.prepare('SELECT id, title, style_preset, provider_config, aspect_ratio FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        return json(res, 404, { error: 'Project not found' });
    }

    const shots = loadProjectShots(projectId);
    const optics = filmOptics(db, projectId);
    let totalDurationMs = 0;

    const frames = shots.map(shot => {
        let sceneCard = {};
        try {
            sceneCard = JSON.parse(shot.scene_card_yaml || '{}');
        } catch (_) { /* ignore parse errors */ }

        const duration = shot.duration_ms || sceneCard.duration_ms || 0;
        totalDurationMs += duration;

        // Check if storyboard image exists
        const imgPath = storyboardImagePath(projectId, shot.shot_code);
        const hasImage = fs.existsSync(imgPath);

        // Get latest asset info
        const asset = db.prepare(
            'SELECT id, version, created_at FROM film_assets WHERE shot_id = ? AND asset_type = \'storyboard\' ORDER BY version DESC LIMIT 1'
        ).get(shot.shot_id);

        return {
            shot_id: shot.shot_id,
            shot_code: shot.shot_code,
            scene_number: shot.scene_number,
            scene_id: shot.scene_id,
            description: sceneCard.action || sceneCard.description || shot.scene_description || '',
            duration_ms: duration,
            image_url: hasImage ? storyboardImageUrl(projectId, shot.shot_code) : null,
            dialogue: sceneCard.dialogue || [],
            camera: sceneCard.camera || {},
            lighting: sceneCard.lighting || {},
            status: shot.status,
            asset_version: asset ? asset.version : null,
            // What this frame will actually be generated with, and where each
            // facet came from. The board used to show the CARD's camera, which
            // on a blocked shot is precisely the set of values generation is
            // going to ignore — so a director who staged an angle, applied it
            // and looked at the board saw no evidence any of it had happened.
            effective: cameraFor(shot.shot_id, sceneCard, optics),
            previs: previsStateFor(shot.shot_id),
        };
    });

    json(res, 200, {
        project_id: projectId,
        project_title: project.title,
        frame_count: frames.length,
        total_duration_ms: totalDurationMs,
        frames,
    });
}

// ── FILM-017: Generate Storyboard (Sync) ───────────────────────────

async function generateStoryboard(req, res, projectId, query) {
    const project = db.prepare('SELECT id, title, style_preset, provider_config, aspect_ratio FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        return json(res, 404, { error: 'Project not found' });
    }

    const shots = loadProjectShots(projectId);
    if (shots.length === 0) {
        return json(res, 400, { error: 'No shots found for this project. Run screenplay breakdown first.' });
    }

    // Consistency readiness gate.
    //
    // Storyboard generation already CONSUMES locked identities — it builds a
    // reference payload and applies IP-adapter weights below. What it never did
    // was say anything when nothing is locked, so a batch would generate
    // silently and the same character would drift between shots. The keyframe
    // becomes the first frame of the video, so that drift propagates.
    //
    // Matches the pipeline's behaviour deliberately: warn always, block only
    // when strict is asked for. Rough keyframes before locking identity is a
    // legitimate thing to want, so blocking by default would fight the user.
    let readiness = { ready: true, missing: [], warnings: [] };
    try { readiness = auditProjectReadiness(projectId); } catch (_) { /* never block on an audit failure */ }
    const strict = !!((req.body && req.body.strict) || (query && query.strict === 'true'));
    if (strict && !readiness.ready) {
        return json(res, 409, {
            error: 'Consistency check blocked storyboard generation (strict mode). Lock the listed subjects in Consistency first.',
            readiness,
        });
    }

    // Load characters and locations for prompt building
    const characters = db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(projectId);
    const locations = db.prepare('SELECT * FROM film_locations WHERE project_id = ?').all(projectId);
    // Loaded alongside the others so a prop named in a description can be
    // matched to its plate. Without this the plates existed and attached to
    // nothing, because every card's props array was empty.
    const props = db.prepare('SELECT * FROM film_props WHERE project_id = ?').all(projectId);

    ensureStoryboardDir(projectId);

    const body = req.body || {};
    const results = [];
    let shotsCompleted = 0;
    let shotsFailed = 0;
    // Carried into the response so a non-strict run still tells the user what
    // is unlocked, rather than only failing loudly in strict mode.
    const consistencyWarning = readiness.ready ? null : readiness;

    // Track scenes for seed generation and status updates
    let currentSceneId = null;
    let baseSeed = 0;
    let shotIndexInScene = 0;

    for (let i = 0; i < shots.length; i++) {
        const shot = shots[i];

        // New scene — generate a new base seed
        if (shot.scene_id !== currentSceneId) {
            currentSceneId = shot.scene_id;
            baseSeed = body.seed || crypto.randomInt(0, 2 ** 31);
            shotIndexInScene = 0;
        }

        let sceneCard = {};
        try {
            sceneCard = JSON.parse(shot.scene_card_yaml || '{}');
        } catch (_) { /* skip */ }

        // Match characters and location
        const matchedChars = matchCharacters(sceneCard.characters, characters);
        const matchedLocation = matchLocation(shot.location, locations);
        const consistencyContext = buildShotReferencePayload(shot, { ...shot, id: shot.scene_id, project_id: projectId, location: shot.location }, project);

        // Reference image selection (IP-Adapter)
        const useReferences = body.use_references === true || (query && query.use_references === 'true');
        let refSelection = { ip_adapter_image: null, ip_adapter_weight: null, source: null };
        if (useReferences) {
            refSelection = selectReferenceImage(sceneCard, matchedChars, matchedLocation, projectId);
        }
        const consistencyPrimary = consistencyContext.references && consistencyContext.references[0];

        // Style lock
        const styleLockEnabled = sceneCard.style_lock !== false;
        const styleParams = applyStyleLock(baseSeed, shotIndexInScene, {
            styleLock: styleLockEnabled,
            consistencyWeight: refSelection.ip_adapter_weight || body.consistency_weight,
            ipAdapterImage: refSelection.ip_adapter_image || (consistencyPrimary && (consistencyPrimary.file_path || consistencyPrimary.file_name)) || body.ip_adapter_image || null,
        });
        if (styleParams.ip_adapter_image && !styleParams.ip_adapter_weight && consistencyPrimary) {
            styleParams.ip_adapter_weight = consistencyPrimary.weight || 0.7;
        }

        // Build prompt
        // Only tag when the provider that will actually run can receive the
        // pictures. Meshy's text-to-image has no reference field, so emitting
        // "@maya" there replaced 240 characters of appearance with a token
        // meaning nothing — eight frames of a different woman each time.
        // Attach pictures when the provider can receive them; NAME them only
        // when it can address them from the prompt. Runway takes { uri, tag }
        // and reads @tag; Meshy takes a plain array and cannot, so it needs the
        // prose kept alongside the images.
        const leadProvider = imageProviderChain(providerConfigOf(project))[0];
        const canAttach = !!(leadProvider && leadProvider.supportsReferenceImages);
        const canTag = !!(leadProvider && leadProvider.supportsReferenceTags);
        const shotRefs = canAttach
            ? gatherShotReferences(projectId, matchedChars, matchedLocation, matchProps(sceneCard, props))
            : [];
        const basePrompt = buildStoryboardPrompt(sceneCard, matchedChars, matchedLocation, project.style_preset,
            // The ceiling of the provider that will actually run, not a
            // constant. Meshy documents no prompt limit and routes to models
            // that take long ones; imposing Runway's 1000 on it threw away
            // description nobody asked to lose.
            {
                references: shotRefs, tagged: canTag,
                maxPromptChars: leadProvider && leadProvider.promptLimit,
                // Prop rows, for their declared dimensions. The builder has
                // never been handed props — they reach the prompt through the
                // consistency contract, which carries no measurements.
                props,
            });

        // Update shot status
        db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('generating', shot.shot_id);

        try {
            const imagePayload = applyConsistencyToImagePayload({
                prompt: basePrompt.prompt,
                negative_prompt: basePrompt.negative_prompt,
                seed: styleParams.seed,
                ip_adapter_image: styleParams.ip_adapter_image,
                ip_adapter_weight: styleParams.ip_adapter_weight,
                // The frame the project actually delivers. Without this the
                // payload falls back to a fixed 1024x1024, so a 2.39:1
                // production got square keyframes -- and a keyframe is the
                // init_image for the video pass, so the wrong shape propagates
                // into every clip.
                aspect_ratio: project.aspect_ratio,
                // Paired with the @tags buildStoryboardPrompt just emitted.
                reference_images: shotRefs,
            }, consistencyContext, { maxPromptChars: imagePromptLimitFor(project) });
            const { buffer: imageBuffer, provider: usedProvider, model: usedModel } =
                await callImageGen(imagePayload.prompt, imagePayload.negative_prompt, imagePayload.seed, imagePayload, providerConfigOf(project));

            // Save image to disk
            const imgPath = storyboardImagePath(projectId, shot.shot_code);
            fs.writeFileSync(imgPath, imageBuffer);

            // Register asset
            const asset = registerStoryboardAsset(projectId, shot.shot_id, imgPath, `${shot.shot_code}.png`, {
                input_refs: consistencyContext.input_refs,
                provider: usedProvider,
                provider_model: usedModel,
            });
            recordConsistencyCheck(
                { ...shot, id: shot.shot_id },
                { ...shot, id: shot.scene_id, project_id: projectId, location: shot.location },
                project,
                { context: consistencyContext, output_asset_id: asset.id, scorer: 'stub' }
            );

            // Log to render ledger
            logToRenderLedger(shot.shot_id, {
                model: usedModel,
                provider: usedProvider,
                seed: styleParams.seed,
                prompt: imagePayload.prompt,
                negative_prompt: imagePayload.negative_prompt,
                camera_params: sceneCard.camera,
                lighting_params: sceneCard.lighting,
                output_path: imgPath,
                mode: sceneCard.generation_mode || 'creative',
            });

            // Update shot status
            db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('complete', shot.shot_id);

            results.push({
                shot_id: shot.shot_id,
                shot_code: shot.shot_code,
                scene_number: shot.scene_number,
                status: 'complete',
                image_url: storyboardImageUrl(projectId, shot.shot_code),
            });
            shotsCompleted++;

        } catch (err) {
            db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('failed', shot.shot_id);
            results.push({
                shot_id: shot.shot_id,
                shot_code: shot.shot_code,
                scene_number: shot.scene_number,
                status: 'failed',
                error: err.message,
            });
            shotsFailed++;
        }

        shotIndexInScene++;

        // After processing all shots in a scene, update scene status
        const nextShot = shots[i + 1];
        if (!nextShot || nextShot.scene_id !== currentSceneId) {
            const failedInScene = results
                .filter(r => r.status === 'failed' && shots.find(s => s.shot_id === r.shot_id && s.scene_id === currentSceneId))
                .length;
            if (failedInScene === 0) {
                db.prepare('UPDATE film_scenes SET status = ? WHERE id = ?').run('storyboarded', currentSceneId);
            }
        }
    }

    json(res, 200, {
        project_id: projectId,
        shots_completed: shotsCompleted,
        shots_failed: shotsFailed,
        frames: results,
        // Null when everything in frame is locked. Present means the batch ran
        // with unlocked subjects and those shots may not match each other.
        consistency_warning: consistencyWarning,
    });
}

// ── FILM-017: Generate Storyboard (SSE Stream) ─────────────────────

async function generateStoryboardStream(req, res, projectId, query) {
    const project = db.prepare('SELECT id, title, style_preset, provider_config, aspect_ratio FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        return json(res, 404, { error: 'Project not found' });
    }

    const shots = loadProjectShots(projectId);
    if (shots.length === 0) {
        return json(res, 400, { error: 'No shots found for this project. Run screenplay breakdown first.' });
    }

    const characters = db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(projectId);
    const locations = db.prepare('SELECT * FROM film_locations WHERE project_id = ?').all(projectId);
    // Loaded alongside the others so a prop named in a description can be
    // matched to its plate. Without this the plates existed and attached to
    // nothing, because every card's props array was empty.
    const props = db.prepare('SELECT * FROM film_props WHERE project_id = ?').all(projectId);

    ensureStoryboardDir(projectId);

    // SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
    });

    // Disable socket timeout for long-running generation
    if (res.socket) res.socket.setTimeout(0);

    // Stop generating for the rest of the project if the client disconnects.
    let clientGone = false;
    res.on('close', () => { clientGone = true; });

    const sendEvent = (data) => {
        if (res.writableEnded) return;
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent({ type: 'status', phase: 'starting', total_shots: shots.length, project_id: projectId });

    const body = req.body || {};
    let shotsCompleted = 0;
    let shotsFailed = 0;

    let currentSceneId = null;
    let baseSeed = 0;
    let shotIndexInScene = 0;

    for (let i = 0; i < shots.length; i++) {
        if (clientGone || res.writableEnded) break; // client disconnected — abort remaining shots
        const shot = shots[i];

        if (shot.scene_id !== currentSceneId) {
            currentSceneId = shot.scene_id;
            baseSeed = body.seed || crypto.randomInt(0, 2 ** 31);
            shotIndexInScene = 0;

            sendEvent({
                type: 'scene',
                scene_number: shot.scene_number,
                scene_id: shot.scene_id,
                location: shot.location,
            });
        }

        let sceneCard = {};
        try {
            sceneCard = JSON.parse(shot.scene_card_yaml || '{}');
        } catch (_) { /* skip */ }

        const matchedChars = matchCharacters(sceneCard.characters, characters);
        const matchedLocation = matchLocation(shot.location, locations);
        const consistencyContext = buildShotReferencePayload(shot, { ...shot, id: shot.scene_id, project_id: projectId, location: shot.location }, project);

        // Reference image selection (IP-Adapter)
        const useReferences = body.use_references === true || (query && query.use_references === 'true');
        let refSelection = { ip_adapter_image: null, ip_adapter_weight: null, source: null };
        if (useReferences) {
            refSelection = selectReferenceImage(sceneCard, matchedChars, matchedLocation, projectId);
        }
        const consistencyPrimary = consistencyContext.references && consistencyContext.references[0];

        const styleLockEnabled = sceneCard.style_lock !== false;
        const styleParams = applyStyleLock(baseSeed, shotIndexInScene, {
            styleLock: styleLockEnabled,
            consistencyWeight: refSelection.ip_adapter_weight || body.consistency_weight,
            ipAdapterImage: refSelection.ip_adapter_image || (consistencyPrimary && (consistencyPrimary.file_path || consistencyPrimary.file_name)) || body.ip_adapter_image || null,
        });
        if (styleParams.ip_adapter_image && !styleParams.ip_adapter_weight && consistencyPrimary) {
            styleParams.ip_adapter_weight = consistencyPrimary.weight || 0.7;
        }

        // Only tag when the provider that will actually run can receive the
        // pictures. Meshy's text-to-image has no reference field, so emitting
        // "@maya" there replaced 240 characters of appearance with a token
        // meaning nothing — eight frames of a different woman each time.
        // Attach pictures when the provider can receive them; NAME them only
        // when it can address them from the prompt. Runway takes { uri, tag }
        // and reads @tag; Meshy takes a plain array and cannot, so it needs the
        // prose kept alongside the images.
        const leadProvider = imageProviderChain(providerConfigOf(project))[0];
        const canAttach = !!(leadProvider && leadProvider.supportsReferenceImages);
        const canTag = !!(leadProvider && leadProvider.supportsReferenceTags);
        const shotRefs = canAttach
            ? gatherShotReferences(projectId, matchedChars, matchedLocation, matchProps(sceneCard, props))
            : [];
        const basePrompt = buildStoryboardPrompt(sceneCard, matchedChars, matchedLocation, project.style_preset,
            // The ceiling of the provider that will actually run, not a
            // constant. Meshy documents no prompt limit and routes to models
            // that take long ones; imposing Runway's 1000 on it threw away
            // description nobody asked to lose.
            {
                references: shotRefs, tagged: canTag,
                maxPromptChars: leadProvider && leadProvider.promptLimit,
                // Prop rows, for their declared dimensions. The builder has
                // never been handed props — they reach the prompt through the
                // consistency contract, which carries no measurements.
                props,
            });

        sendEvent({
            type: 'progress',
            shot_index: i,
            total_shots: shots.length,
            shot_code: shot.shot_code,
            scene_number: shot.scene_number,
            phase: 'generating',
                    reference_source: refSelection.source,
                    consistency_refs: consistencyContext.input_refs,
                });

        db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('generating', shot.shot_id);

        try {
            const imagePayload = applyConsistencyToImagePayload({
                prompt: basePrompt.prompt,
                negative_prompt: basePrompt.negative_prompt,
                seed: styleParams.seed,
                ip_adapter_image: styleParams.ip_adapter_image,
                ip_adapter_weight: styleParams.ip_adapter_weight,
                // The frame the project actually delivers. Without this the
                // payload falls back to a fixed 1024x1024, so a 2.39:1
                // production got square keyframes -- and a keyframe is the
                // init_image for the video pass, so the wrong shape propagates
                // into every clip.
                aspect_ratio: project.aspect_ratio,
                // Paired with the @tags buildStoryboardPrompt just emitted.
                reference_images: shotRefs,
            }, consistencyContext, { maxPromptChars: imagePromptLimitFor(project) });
            const { buffer: imageBuffer, metadata } = await callImageGenStream(
                imagePayload.prompt, imagePayload.negative_prompt, imagePayload.seed,
                imagePayload,
                (progressData) => {
                    // Relay per-image generation progress to the client
                    sendEvent({
                        type: 'image_progress',
                        shot_index: i,
                        total_shots: shots.length,
                        shot_code: shot.shot_code,
                        scene_number: shot.scene_number,
                        ...progressData,
                    });
                },
                providerConfigOf(project)
            );

            const imgPath = storyboardImagePath(projectId, shot.shot_code);
            fs.writeFileSync(imgPath, imageBuffer);

            const asset = registerStoryboardAsset(projectId, shot.shot_id, imgPath, `${shot.shot_code}.png`, {
                input_refs: consistencyContext.input_refs,
                provider: metadata && metadata.provider,
                provider_model: metadata && metadata.provider_model,
            });
            recordConsistencyCheck(
                { ...shot, id: shot.shot_id },
                { ...shot, id: shot.scene_id, project_id: projectId, location: shot.location },
                project,
                { context: consistencyContext, output_asset_id: asset.id, scorer: 'stub' }
            );

            const actualSeed = (metadata && metadata.seed) || styleParams.seed;
            logToRenderLedger(shot.shot_id, {
                model: metadata && metadata.provider_model,
                provider: metadata && metadata.provider,
                seed: actualSeed,
                prompt: imagePayload.prompt,
                negative_prompt: imagePayload.negative_prompt,
                camera_params: sceneCard.camera,
                lighting_params: sceneCard.lighting,
                output_path: imgPath,
                mode: sceneCard.generation_mode || 'creative',
            });

            db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('complete', shot.shot_id);

            sendEvent({
                type: 'progress',
                shot_index: i,
                total_shots: shots.length,
                shot_code: shot.shot_code,
                scene_number: shot.scene_number,
                phase: 'complete',
                image_url: storyboardImageUrl(projectId, shot.shot_code),
                seed: actualSeed,
                generation_time_ms: metadata?.generation_time_ms,
            });
            shotsCompleted++;

        } catch (err) {
            db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('failed', shot.shot_id);

            sendEvent({
                type: 'progress',
                shot_index: i,
                total_shots: shots.length,
                shot_code: shot.shot_code,
                scene_number: shot.scene_number,
                phase: 'failed',
                error: err.message,
            });
            shotsFailed++;
        }

        shotIndexInScene++;

        // Update scene status after all its shots are processed
        const nextShot = shots[i + 1];
        if (!nextShot || nextShot.scene_id !== currentSceneId) {
            // Check if any shots in this scene failed
            const sceneShotIds = shots
                .filter(s => s.scene_id === currentSceneId)
                .map(s => s.shot_id);
            const failedCount = db.prepare(
                `SELECT COUNT(*) AS c FROM film_shots WHERE id IN (${sceneShotIds.map(() => '?').join(',')}) AND status = 'failed'`
            ).get(...sceneShotIds).c;

            if (failedCount === 0) {
                db.prepare('UPDATE film_scenes SET status = ? WHERE id = ?').run('storyboarded', currentSceneId);
                sendEvent({
                    type: 'scene_complete',
                    scene_number: shot.scene_number,
                    scene_id: currentSceneId,
                });
            }
        }
    }

    sendEvent({
        type: 'result',
        project_id: projectId,
        shots_completed: shotsCompleted,
        shots_failed: shotsFailed,
    });

    sendEvent({ type: 'done' });
    res.end();
}

// ── FILM-020: Regenerate Single Shot ───────────────────────────────

/**
 * What this shot would send, and how much room is left — without spending.
 *
 * GET /film/shots/:id/prompt
 *
 * The engine can hold a ceiling; it cannot decide what matters. Cutting a
 * subject's description at a clause boundary has no way of knowing that "one
 * wheel trim missing" is worth keeping and "bench seats in cracked tan vinyl"
 * is not — whoever is composing does. So this hands over the whole picture:
 * every contributor with its full length and how much of it survives, the
 * ceiling, the headroom, and which plates would attach. Compose a better prompt
 * from it and send it back through `prompt_override`.
 *
 * Spends nothing, which is what makes it usable. Finding out by generating is
 * how trying three phrasings becomes a budget decision.
 */
function shotPromptPreview(req, res, shotId) {
    const { loadShotContext, buildCapabilityPayload } = require('../lib/capability-payloads');

    let ctx;
    try { ctx = loadShotContext(shotId); } catch (err) {
        return json(res, err.code === 'PRECONDITION' ? 409 : 404, { error: err.message });
    }
    if (!ctx || !ctx.shot) return json(res, 404, { error: 'Shot not found' });

    let built;
    try { built = buildCapabilityPayload('image', ctx); } catch (err) {
        return json(res, 409, { error: err.message, code: err.code });
    }
    const payload = Array.isArray(built.payload) ? built.payload[0] : built.payload;
    const ceiling = imagePromptLimitFor(ctx.project);
    const prompt = String(payload.prompt || '');

    // Every locked subject that contributes prose, with what it wanted and what
    // it got. "Over by 946" is actionable; "the prompt was truncated" is not.
    const cc = ctx.consistency || {};
    const contributors = (cc.prompt_addition_items || []).map(item => {
        const kept = prompt.includes(item.text)
            ? item.text.length
            : longestPrefixIn(prompt, item.text);
        return {
            subject: item.subject_name,
            kind: item.profile_type,
            wrote: item.text.length,
            survived: kept,
            trimmed: item.text.length - kept,
        };
    });

    return json(res, 200, {
        shot_id: shotId,
        shot_code: ctx.shot.shot_code,
        prompt,
        negative_prompt: payload.negative_prompt || '',
        prompt_chars: prompt.length,
        ceiling,
        headroom: ceiling ? ceiling - prompt.length : null,
        // The plates that travel WITH the prompt. A subject whose picture is
        // attached needs identifying, not describing at length — which is where
        // most of the room goes.
        references: (payload.reference_images || []).map(r => ({
            subject: r.subject_name, kind: r.profile_type, role: r.role,
        })),
        contributors,
        card: ctx.sceneCard,
        note: 'Compose a better prompt from this and send it back to '
            + 'POST /shots/:id/storyboard/regenerate as prompt_override. Everything listed under '
            + 'references is attached as an image, so it needs naming rather than describing at length.',
    });
}

/** How much of `text` made it into `prompt`, when it was trimmed. */
function longestPrefixIn(prompt, text) {
    let lo = 0, hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (prompt.includes(text.slice(0, mid))) lo = mid; else hi = mid - 1;
    }
    return lo;
}

function imagePromptLimitFor(project) {
    try {
        const { resolveGenerator } = require('../lib/providers');
        let config = {};
        try { config = JSON.parse((project && project.provider_config) || '{}'); } catch (_) { config = {}; }
        const adapter = resolveGenerator('image', config);
        return (adapter && Number(adapter.promptLimit) > 0) ? Number(adapter.promptLimit) : null;
    } catch (_) { return null; }
}

async function regenerateShot(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) {
        return json(res, 404, { error: 'Shot not found' });
    }

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) {
        return json(res, 404, { error: 'Scene not found' });
    }

    const project = db.prepare('SELECT id, title, style_preset, provider_config, aspect_ratio FROM film_projects WHERE id = ?').get(scene.project_id);
    if (!project) {
        return json(res, 404, { error: 'Project not found' });
    }

    const body = req.body || {};
    const consistencyContext = buildShotReferencePayload(shot, scene, project);

    // Build or use override prompt
    let prompt, negative_prompt;

    if (body.prompt_override) {
        prompt = body.prompt_override;
        negative_prompt = body.negative_prompt || 'blurry, low quality, distorted, deformed';
    } else {
        let sceneCard = {};
        try {
            sceneCard = JSON.parse(shot.scene_card_yaml || '{}');
        } catch (_) { /* skip */ }

        const characters = db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(scene.project_id);
        const locations = db.prepare('SELECT * FROM film_locations WHERE project_id = ?').all(scene.project_id);

        const matchedChars = matchCharacters(sceneCard.characters, characters);
        const matchedLocation = matchLocation(scene.location, locations);

        const props = db.prepare('SELECT * FROM film_props WHERE project_id = ?').all(scene.project_id);
        const result = buildStoryboardPrompt(
            sceneCard, matchedChars, matchedLocation,
            body.style_override || project.style_preset,
            { props }
        );
        prompt = result.prompt;
        negative_prompt = result.negative_prompt;
    }

    const seed = body.seed || consistencyContext.locked_seed || crypto.randomInt(0, 2 ** 31);

    // Update status
    db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('generating', shotId);

    try {
        ensureStoryboardDir(project.id);

        /**
         * The same tagged, inlined plates the batch paths attach.
         *
         * This path never called gatherShotReferences. It relied on the
         * consistency context's references, which carry a `file_path` — a path
         * on OUR disk — and every image adapter reads `uri`/`url`, so they were
         * dropped on the floor. Regenerating one shot therefore ran
         * text-to-image with no plate conditioning at all, while regenerating
         * the whole board conditioned correctly. The frames still looked right
         * because the full prose contracts were carrying the subjects; the
         * moment those were shortened on the correct assumption that a picture
         * was attached, the subject had neither.
         */
        let shotRefs = [];
        try {
            const allProps = db.prepare('SELECT * FROM film_props WHERE project_id = ?').all(project.id);
            const chars = db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(project.id);
            const locs = db.prepare('SELECT * FROM film_locations WHERE project_id = ?').all(project.id);
            let card = {};
            try { card = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) { card = {}; }
            shotRefs = gatherShotReferences(
                project.id,
                matchCharacters(card.characters, chars),
                matchLocation(scene.location, locs),
                matchProps(card, allProps));
        } catch (_) { shotRefs = []; }

        const primaryRef = consistencyContext.references && consistencyContext.references[0];
        const imagePayload = applyConsistencyToImagePayload({
            prompt,
            negative_prompt,
            seed,
            reference_images: shotRefs,
            ip_adapter_image: primaryRef && (primaryRef.file_path || primaryRef.file_name),
            ip_adapter_weight: primaryRef && primaryRef.weight,
            aspect_ratio: project.aspect_ratio,
        }, consistencyContext, {
            maxPromptChars: imagePromptLimitFor(project),
            // An override is the WHOLE prompt, not a prefix. Appending contracts
            // to it silently made a 1,573-character composition into a
            // 5,024-character one, and a provider truncates the tail — so what
            // survived was the part the composer had deliberately cut.
            promptIsFinal: !!body.prompt_override,
        });
        const { buffer: imageBuffer, provider: usedProvider, model: usedModel } =
            await callImageGen(imagePayload.prompt, imagePayload.negative_prompt, imagePayload.seed, imagePayload, providerConfigOf(project));

        const imgPath = storyboardImagePath(project.id, shot.shot_code);
        fs.writeFileSync(imgPath, imageBuffer);

        const asset = registerStoryboardAsset(project.id, shotId, imgPath, `${shot.shot_code}.png`, {
            input_refs: consistencyContext.input_refs,
            provider: usedProvider,
            provider_model: usedModel,
        });
        recordConsistencyCheck(shot, scene, project, { context: consistencyContext, output_asset_id: asset.id, scorer: 'stub' });

        logToRenderLedger(shotId, {
            model: usedModel,
            provider: usedProvider,
            seed: imagePayload.seed,
            prompt: imagePayload.prompt,
            negative_prompt: imagePayload.negative_prompt,
            output_path: imgPath,
            mode: body.mode || 'creative',
        });

        db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('complete', shotId);

        json(res, 200, {
            shot_id: shotId,
            shot_code: shot.shot_code,
            status: 'complete',
            image_url: storyboardImageUrl(project.id, shot.shot_code),
            seed: imagePayload.seed,
            prompt: imagePayload.prompt,
        });

    } catch (err) {
        db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('failed', shotId);
        json(res, 502, {
            error: 'Image generation failed',
            details: err.message,
            shot_id: shotId,
            shot_code: shot.shot_code,
        });
    }
}

// ── Character / Location Matching ──────────────────────────────────

/**
 * The props actually in a shot.
 *
 * The card's `props` array is a hint, not the truth. On a real production every
 * card came back with `props: []` while the descriptions plainly named a
 * sprinkler and a grocery bag — so the prop plates a director had generated,
 * accepted and locked attached to nothing, and both objects were invented
 * per-frame instead.
 *
 * A prop the description names IS in the shot, whoever wrote the card. Same
 * reasoning that made scene presence read action lines rather than only
 * dialogue cues: the text is the evidence, the list is somebody's memory of it.
 *
 * Whole-word matching only — "bag" inside "baggage" is not the grocery bag, and
 * a plate attached on a coincidence puts the wrong object in frame.
 */
function matchProps(sceneCard, dbProps) {
    const card = sceneCard || {};
    const all = dbProps || [];
    const chosen = new Map();

    const take = (name) => {
        if (!name) return;
        const hit = all.find(p => p.name && p.name.toUpperCase() === String(name).toUpperCase());
        if (hit) chosen.set(hit.id || hit.name, hit);
    };

    for (const entry of (Array.isArray(card.props) ? card.props : [])) {
        take(typeof entry === 'string' ? entry : (entry && entry.name));
    }

    const text = String(card.description || card.action || '');
    if (text) {
        for (const prop of all) {
            if (!prop.name) continue;
            const escaped = String(prop.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) chosen.set(prop.id || prop.name, prop);
        }
    }
    return [...chosen.values()];
}

function matchCharacters(cardCharacters, dbCharacters) {
    if (!cardCharacters || !Array.isArray(cardCharacters)) return [];
    return cardCharacters
        .map(ch => {
            const name = typeof ch === 'string' ? ch : ch.name;
            if (!name) return null;
            return (dbCharacters || []).find(
                c => c.name && c.name.toUpperCase() === name.toUpperCase()
            );
        })
        .filter(Boolean);
}

function matchLocation(locationName, dbLocations) {
    if (!locationName) return null;
    return (dbLocations || []).find(
        l => l.name && l.name.toUpperCase() === locationName.toUpperCase()
    ) || null;
}

// ── Reference Image Selection for IP-Adapter ─────────────────────

const LOCATION_PRIORITY_SHOTS = new Set(['wide', 'establishing', 'aerial', 'crane']);
const CHARACTER_PRIORITY_SHOTS = new Set(['close-up', 'extreme-close-up', 'medium', 'over-the-shoulder', 'pov']);

/**
 * Find the latest reference asset for a character or location.
 */
function findLatestReferenceAsset(assetType, projectId, characterId, locationId) {
    if (characterId) {
        // Prefer front-view refsheet
        const frontView = db.prepare(
            "SELECT file_path, file_name, project_id FROM film_assets WHERE project_id = ? AND asset_type = ? AND metadata LIKE ? AND metadata LIKE ? ORDER BY created_at DESC LIMIT 1"
        ).get(projectId, assetType, `%"character_id":"${characterId}"%`, `%"view":"front"%`);
        if (frontView) return frontView;
        // Fall back to any refsheet for this character
        return db.prepare(
            "SELECT file_path, file_name, project_id FROM film_assets WHERE project_id = ? AND asset_type = ? AND metadata LIKE ? ORDER BY created_at DESC LIMIT 1"
        ).get(projectId, assetType, `%"character_id":"${characterId}"%`) || null;
    }
    if (locationId) {
        return db.prepare(
            "SELECT file_path, file_name, project_id FROM film_assets WHERE project_id = ? AND asset_type = 'reference_image' AND location_id = ? ORDER BY created_at DESC LIMIT 1"
        ).get(projectId, locationId) || null;
    }
    return null;
}

/**
 * Select the best reference image for a shot based on shot type and content.
 * Gridlight only accepts ONE ip_adapter_image, so we must choose.
 */
function selectReferenceImage(sceneCard, matchedChars, matchedLocation, projectId) {
    const shotType = sceneCard.camera && sceneCard.camera.shot_type;

    // For location-focused shots, prefer location reference
    if (LOCATION_PRIORITY_SHOTS.has(shotType) && matchedLocation) {
        const locAsset = findLatestReferenceAsset('reference_image', projectId, null, matchedLocation.id);
        if (locAsset) {
            return { ip_adapter_image: locAsset.file_path, ip_adapter_weight: 0.6, source: 'location:' + matchedLocation.name };
        }
    }

    // For character-focused shots, prefer primary character refsheet
    if (CHARACTER_PRIORITY_SHOTS.has(shotType) && matchedChars.length > 0) {
        const charAsset = findLatestReferenceAsset('reference_sheet', projectId, matchedChars[0].id, null);
        if (charAsset) {
            return { ip_adapter_image: charAsset.file_path, ip_adapter_weight: 0.7, source: 'character:' + matchedChars[0].name };
        }
    }

    // Fallback: try any matched character, then location
    for (const ch of matchedChars) {
        const charAsset = findLatestReferenceAsset('reference_sheet', projectId, ch.id, null);
        if (charAsset) {
            return { ip_adapter_image: charAsset.file_path, ip_adapter_weight: 0.65, source: 'character:' + ch.name };
        }
    }
    if (matchedLocation) {
        const locAsset = findLatestReferenceAsset('reference_image', projectId, null, matchedLocation.id);
        if (locAsset) {
            return { ip_adapter_image: locAsset.file_path, ip_adapter_weight: 0.5, source: 'location:' + matchedLocation.name };
        }
    }

    return { ip_adapter_image: null, ip_adapter_weight: null, source: null };
}

module.exports = { handleStoryboard, matchProps };
