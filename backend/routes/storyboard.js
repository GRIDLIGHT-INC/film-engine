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
const { spendContext } = require('../lib/provider-config');
const { selectReferences } = require('../lib/reference-images');
const { generateImageWithFallback, imageProviderChain } = require('../lib/image-fallback');
// Moved to a lib so the orchestrated payload path can gather the same plates.
// While it lived here, only the three board paths could reach it, and every
// reference feature added since — plates, board style images, the scene anchor
// — reached three paths out of four.
const {
    gatherShotReferences, matchProps, matchCharacters, matchLocation,
} = require('../lib/shot-references');
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
 * Where a superseded attempt is kept.
 *
 * Every regeneration wrote to the same filename, so the asset ledger recorded
 * six versions of a frame and the disk held one. Five images that cost money
 * were gone, and the row that claimed each of them pointed at whichever picture
 * happened to be there last — which is worse than not recording them, because
 * A/B compare and the version list both read those rows and would show the
 * newest frame six times over.
 *
 * The current frame keeps the plain name, so nothing that links to
 * `{shot}.png` has to change; the version being replaced is copied aside first.
 */
function storyboardVersionPath(projectId, shotCode, version) {
    return path.join(DATA_DIR, 'storyboards', projectId, 'versions', `${shotCode}_v${version}.png`);
}

/**
 * Copy the frame that is about to be overwritten into the version store.
 *
 * Never throws: failing to archive an old attempt must not fail a generation
 * that has already succeeded and been paid for.
 */
function archiveExistingFrame(projectId, shotId, shotCode) {
    try {
        const current = storyboardImagePath(projectId, shotCode);
        if (!fs.existsSync(current)) return null;
        const row = db.prepare(
            `SELECT id, version FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard'
              ORDER BY version DESC LIMIT 1`).get(shotId);
        if (!row) return null;
        const dest = storyboardVersionPath(projectId, shotCode, row.version);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(current, dest);
        // The row now points at the copy, so the ledger and the disk agree
        // about which picture that version WAS.
        db.prepare('UPDATE film_assets SET file_path = ?, file_name = ? WHERE id = ?')
            .run(dest, path.basename(dest), row.id);
        return dest;
    } catch (_) { return null; }
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
 * A locked board refuses anything that would replace a picture on it.
 *
 * One helper rather than a check per route, because the failure mode is partial
 * coverage: a lock that catches Regen and misses "Generate All" teaches a
 * director the board is safe and then lets one button replace all of it.
 *
 * It guards the PICTURES only. Editing a card, previewing a prompt and reading
 * the board stay free — otherwise "done" means "frozen", and a director stops
 * locking anything. And it is overridable per call, because one frame on a
 * finished board genuinely does need redoing sometimes, and a refusal you
 * cannot get past is a reason to never lock at all.
 */
function boardLocked(project, body) {
    if (!project || !project.board_locked_at) return null;
    if (body && (body.ignore_lock === true || body.ignore_lock === 'true')) return null;
    return {
        error: 'This board is locked.',
        code: 'BOARD_LOCKED',
        locked_at: project.board_locked_at,
        hint: 'Unlock the board to generate again (DELETE /film/projects/:id/board-lock, or the '
            + 'lock button on the board), or pass ignore_lock to replace this one frame deliberately.',
    };
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

    /*
     * How this attempt came to exist, kept with it.
     *
     * `restored_from` and `instruction` were passed by their callers and thrown
     * away here — the column was never written — so every restore was
     * anonymous. That is why the version list could not tell one attempt from
     * another: v6 carried no record that it was v3's picture, so the card said
     * "v6" over a frame from three attempts ago with nothing to explain it.
     *
     * Only what the caller supplied is stored. An absent key means the caller
     * did not know, which is different from a value of none.
     */
    const metadata = {};
    if (opts.restored_from !== undefined) metadata.restored_from = opts.restored_from;
    if (opts.refined_from !== undefined) metadata.refined_from = opts.refined_from;
    if (opts.instruction !== undefined) metadata.instruction = opts.instruction;
    /*
     * Which mode produced this frame.
     *
     * 2B accumulated twelve attempts before one was right, and the version list
     * — whose whole job is "which of these am I looking at" — could not say
     * that eleven were built from prose and the twelfth from a locked scene.
     * A director comparing them is comparing pictures with no record of what
     * was different about the request, which is how the same failed approach
     * gets tried again.
     */
    /*
     * Where a BORROWED picture came from.
     *
     * A frame sent from another shot was generated from that shot's card, not
     * this one's. It is not stale and it is not wrong — it is borrowed, and a
     * director looking at it three days later needs to know that without
     * reconstructing it from timestamps.
     */
    if (opts.sent_from !== undefined) metadata.sent_from = opts.sent_from;
    if (opts.sent_from_shot_id !== undefined) metadata.sent_from_shot_id = opts.sent_from_shot_id;
    if (opts.sent_from_version !== undefined) metadata.sent_from_version = opts.sent_from_version;
    if (opts.direction_mode) metadata.direction_mode = opts.direction_mode;
    if (opts.anchor_shot_code) metadata.anchor_shot_code = opts.anchor_shot_code;
    if (opts.provider) metadata.provider = opts.provider;
    if (opts.provider_model) metadata.provider_model = opts.provider_model;

    db.prepare(`
        INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name,
            format, mime_type, width, height, version, input_refs, provider, provider_model, metadata)
        VALUES (?, ?, ?, 'storyboard', ?, ?, 'png', 'image/png', ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, shotId, filePath, fileName, width, height, version,
        JSON.stringify(opts.input_refs || []), opts.provider || null, opts.provider_model || null,
        JSON.stringify(metadata));

    /*
     * A new generation is what the shot now shows, so any selection is spent.
     * Cleared rather than set to the new number: NULL already means "the
     * highest", so one rule covers both a fresh shot and a regenerated one, and
     * there is no second place for the two to disagree.
     */
    try {
        db.prepare('UPDATE film_shots SET current_frame_version = NULL WHERE id = ?').run(shotId);
    } catch (_) { /* a pointer that cannot be cleared must not fail a paid generation */ }

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
    // GET  /film/shots/:id/frames
    // POST /film/shots/:id/frames/:version/restore
    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'frames') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid shot ID' });
        if (urlParts[4] && urlParts[5] === 'restore' && req.method === 'POST') {
            return restoreShotFrame(req, res, urlParts[2], urlParts[4]);
        }
        if (urlParts[4] && urlParts[5] === 'send' && req.method === 'POST') {
            return sendFrameToShot(req, res, urlParts[2], urlParts[4]);
        }
        if (req.method === 'GET') return listShotFrames(req, res, urlParts[2]);
        return json(res, 405, { error: 'Method not allowed' });
    }

    if (urlParts[1] === 'shots' && urlParts[2] && urlParts[3] === 'prompt') {
        if (!UUID_RE.test(urlParts[2])) return json(res, 400, { error: 'Invalid shot ID' });
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
        return shotPromptPreview(req, res, urlParts[2], query);
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

        // POST /film/shots/:id/storyboard/refine — change one thing, keep the rest.
        if (urlParts[4] === 'refine' && req.method === 'POST') {
            return refineShot(req, res, shotId);
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

    /*
     * Two places a frame can live, and this route knew only one.
     *
     * `archiveExistingFrame` copies the outgoing picture to
     * `{project}/versions/{code}_v{n}.png`; the live frame stays at
     * `{project}/{code}.png`. The URL is built from `file_name`, which carries
     * no directory — so the archive and the server disagreed about where a
     * version lives and nothing connected them. On a real shot, 9 of 11
     * thumbnails 404'd and the version modal was a grid of broken images.
     *
     * The project root is tried first, so the live frame costs one stat and the
     * common case is unchanged.
     */
    const projectDir = path.join(DATA_DIR, 'storyboards', projectId);
    const candidates = [
        path.join(projectDir, filename),
        path.join(projectDir, 'versions', filename),
    ];

    // Containment is checked on the RESOLVED path of whichever candidate is
    // used, not on the input. Widening where a route looks is exactly when a
    // traversal creeps back in, and `filename` is already restricted to
    // [\w.-]+ above — which excludes `/` and so cannot reach a sibling
    // project, but the check stays because the sanitiser and this are
    // independent defences and should not become one.
    const baseDir = path.resolve(projectDir);
    const filePath = candidates.find(p =>
        path.resolve(p).startsWith(baseDir + path.sep) && fs.existsSync(p));

    if (!filePath) {
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
    const project = db.prepare('SELECT id, title, style_preset, provider_config, aspect_ratio, annotation_feedback, anchor_shot_id, board_locked_at FROM film_projects WHERE id = ?').get(projectId);
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
        /*
         * The version this shot is SHOWING, not the newest one it has.
         *
         * Selecting an earlier attempt moves a pointer and copies that picture
         * to the live file. This asked for the highest version and keyed the
         * board's image URL to it — so after selecting v13 of 17 the picture on
         * disk was v13 and the page requested `?v=17`, which the browser
         * already had cached from when v17 was current. It served the frame you
         * had just moved away from, silently, which looks exactly like
         * selecting not working.
         */
        const showing = currentFrameVersion(shot.shot_id || shot.id);
        const asset = db.prepare(
            `SELECT id, shot_id, version, created_at, metadata FROM film_assets
              WHERE shot_id = ? AND asset_type = 'storyboard'
                AND (? IS NULL OR version = ?)
           ORDER BY version DESC LIMIT 1`
        ).get(shot.shot_id, showing, showing);

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
            // Restoring moves FORWARD — v3 comes back as v6, so v4 and v5 are
            // not destroyed to undo one choice. That is right, and it makes the
            // version number stop describing the picture: the card said "v6"
            // while showing v3's frame, with nothing to say so. The number is
            // the attempt; this is the picture it is of.
            asset_shows_version: asset ? (assetShowsVersion(asset) || asset.version) : null,
            // What this frame will actually be generated with, and where each
            // facet came from. The board used to show the CARD's camera, which
            // on a blocked shot is precisely the set of values generation is
            // going to ignore — so a director who staged an angle, applied it
            // and looked at the board saw no evidence any of it had happened.
            effective: cameraFor(shot.shot_id, sceneCard, optics),
            previs: previsStateFor(shot.shot_id),
            // Which frame this shot's scene is measured against, and whether
            // THIS is it. Per frame rather than per scene, because the board is
            // read as frames and a director marking one as the establishing
            // shot is looking at that picture when they decide.
            anchor: anchorStateFor(shot.shot_id, project.anchor_shot_id),
        };
    });

    json(res, 200, {
        project_id: projectId,
        project_title: project.title,
        frame_count: frames.length,
        total_duration_ms: totalDurationMs,
        // The frame currently being shot from, and whether markup steers a
        // prompt — so the page can say what is on without a second request.
        anchor_shot_id: project.anchor_shot_id || null,
        annotation_feedback: !!project.annotation_feedback,
        frames,
    });
}

// ── FILM-017: Generate Storyboard (Sync) ───────────────────────────

async function generateStoryboard(req, res, projectId, query) {
    const project = db.prepare('SELECT id, title, style_preset, provider_config, aspect_ratio, annotation_feedback, anchor_shot_id, board_locked_at FROM film_projects WHERE id = ?').get(projectId);
    const _lock = boardLocked(project, req.body || {});
    if (_lock) return json(res, 423, _lock);
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
        const leadProvider = imageProviderChain(spendContext(project, shot))[0];
        const canAttach = !!(leadProvider && leadProvider.supportsReferenceImages);
        const canTag = !!(leadProvider && leadProvider.supportsReferenceTags);
        const anchorState = activeAnchorFor_(shot.shot_id, project, body, canAttach);
        const shotRefs = canAttach
            ? gatherShotReferences(projectId, matchedChars, matchedLocation,
                matchProps(sceneCard, props), anchorState.anchor,
                // The ceiling of the provider that will actually run. A shot
                // naming five subjects sent three because MAX_REFERENCES was
                // Runway's limit applied to everyone.
                { limit: leadProvider && leadProvider.maxReferenceImages })
            : [];
        const anchorState_ = anchorIn(shotRefs, canTag);
        const shotMarks = annotationsFor(shot.shot_id, project, body);
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
                // PAR-026. The board path honours markup for the same reason
                // it honours plates: a regenerate-one that conditions
                // differently from a generate-all is how a board comes to
                // disagree with itself, and the plate bug that cost a day was
                // exactly that shape.
                annotations: shotMarks.enabled ? shotMarks.marks : undefined,
                // Only when the anchor actually claimed one of the three slots.
                // Naming a tag the payload does not carry is strictly worse than
                // saying nothing — the same defect as a prompt carrying @maya
                // with no matching image.
                ...anchorState_,
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
            }, consistencyContext, {
                maxPromptChars: imagePromptLimitFor(project),
                // Subjects standing in the attached frame keep their NAME and
                // lose their paragraph.
                anchorCovers: anchorCoversFor(anchorState, anchorState_.anchorAttached),
            });
            const { buffer: imageBuffer, provider: usedProvider, model: usedModel } =
                await callImageGen(imagePayload.prompt, imagePayload.negative_prompt, imagePayload.seed, imagePayload, spendContext(project, shot));

            // Save image to disk
            const imgPath = storyboardImagePath(projectId, shot.shot_code);
            // Keep what is about to be replaced. Every attempt cost money.
            archiveExistingFrame(projectId, shot.shot_id, shot.shot_code);
            fs.writeFileSync(imgPath, imageBuffer);

            // Register asset
            const asset = registerStoryboardAsset(projectId, shot.shot_id, imgPath, `${shot.shot_code}.png`, {
                input_refs: consistencyContext.input_refs,
                provider: usedProvider,
                provider_model: usedModel,
                // Whole-board generation builds every frame from its card, so
                // the mode is always 'action'. Recorded rather than left off:
                // absent has to keep meaning "made before this was tracked".
                direction_mode: 'action',
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
    const project = db.prepare('SELECT id, title, style_preset, provider_config, aspect_ratio, annotation_feedback, anchor_shot_id, board_locked_at FROM film_projects WHERE id = ?').get(projectId);
    const _lock = boardLocked(project, req.body || {});
    if (_lock) return json(res, 423, _lock);
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
        const leadProvider = imageProviderChain(spendContext(project, shot))[0];
        const canAttach = !!(leadProvider && leadProvider.supportsReferenceImages);
        const canTag = !!(leadProvider && leadProvider.supportsReferenceTags);
        const anchorState = activeAnchorFor_(shot.shot_id, project, body, canAttach);
        const shotRefs = canAttach
            ? gatherShotReferences(projectId, matchedChars, matchedLocation,
                matchProps(sceneCard, props), anchorState.anchor,
                // The ceiling of the provider that will actually run. A shot
                // naming five subjects sent three because MAX_REFERENCES was
                // Runway's limit applied to everyone.
                { limit: leadProvider && leadProvider.maxReferenceImages })
            : [];
        const anchorState_ = anchorIn(shotRefs, canTag);
        const shotMarks = annotationsFor(shot.shot_id, project, body);
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
                // PAR-026. The board path honours markup for the same reason
                // it honours plates: a regenerate-one that conditions
                // differently from a generate-all is how a board comes to
                // disagree with itself, and the plate bug that cost a day was
                // exactly that shape.
                annotations: shotMarks.enabled ? shotMarks.marks : undefined,
                // Only when the anchor actually claimed one of the three slots.
                // Naming a tag the payload does not carry is strictly worse than
                // saying nothing — the same defect as a prompt carrying @maya
                // with no matching image.
                ...anchorState_,
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
            }, consistencyContext, {
                maxPromptChars: imagePromptLimitFor(project),
                // Subjects standing in the attached frame keep their NAME and
                // lose their paragraph.
                anchorCovers: anchorCoversFor(anchorState, anchorState_.anchorAttached),
            });
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
                spendContext(project, shot)
            );

            const imgPath = storyboardImagePath(projectId, shot.shot_code);
            // Keep what is about to be replaced. Every attempt cost money.
            archiveExistingFrame(projectId, shot.shot_id, shot.shot_code);
            fs.writeFileSync(imgPath, imageBuffer);

            const asset = registerStoryboardAsset(projectId, shot.shot_id, imgPath, `${shot.shot_code}.png`, {
                input_refs: consistencyContext.input_refs,
                provider: metadata && metadata.provider,
                provider_model: metadata && metadata.provider_model,
                direction_mode: 'action',
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
 * Which attempt's PICTURE a version is showing.
 *
 * Usually itself. After a restore it is an older one — v3's frame arriving as
 * v6 — because restore moves forward rather than rewinding: truncating history
 * to undo one choice would destroy v4 and v5, which is the mistake this whole
 * feature exists to avoid.
 *
 * The consequence is that a version NUMBER stops describing the picture, and
 * the card said "v6" over v3's frame with nothing to explain it. Follows the
 * chain, so a restore of a restore still names the attempt the picture came
 * from rather than the last hop.
 */
function assetShowsVersion(asset) {
    let meta = {};
    try { meta = JSON.parse(asset.metadata || '{}'); } catch (_) { return null; }
    if (!meta.restored_from) return null;
    // Bounded: a corrupt chain must not spin.
    let from = meta.restored_from;
    for (let hops = 0; hops < 20; hops++) {
        const prev = db.prepare(
            `SELECT metadata FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard' AND version = ?`)
            .get(asset.shot_id, from);
        if (!prev) break;
        let m = {};
        try { m = JSON.parse(prev.metadata || '{}'); } catch (_) { break; }
        if (!m.restored_from) break;
        from = m.restored_from;
    }
    return from;
}

/**
 * Every attempt at this shot, and the way back to one.
 *
 * Regeneration overwrites the frame at a fixed name, and `archiveExistingFrame`
 * has been copying the outgoing picture to `{code}_v{n}.png` and repointing its
 * asset row for a while — so the attempts were all on disk and in the ledger,
 * and there was no way to look at them or go back to one. Kept and unreachable
 * is barely better than not kept: the reason you keep them is that generation
 * is a coin flip you already paid for, and v2 is often the one you wanted.
 *
 * GET /film/shots/:id/frames
 */
function listShotFrames(req, res, shotId) {
    const shot = db.prepare('SELECT id, shot_code, scene_id FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });
    const scene = db.prepare('SELECT project_id FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    const rows = db.prepare(
        `SELECT id, shot_id, version, file_name, file_path, created_at, metadata FROM film_assets
          WHERE shot_id = ? AND asset_type = 'storyboard' ORDER BY version DESC`).all(shotId);

    const current = storyboardImagePath(scene.project_id, shot.shot_code);

    /*
     * `is_current` is the version the shot POINTS AT, not the highest.
     *
     * It was the highest, because selecting an earlier attempt used to create a
     * new one — v3 chosen became v6. That kept history and made the count a
     * lie: five generations and a selection read as six attempts. Selecting is
     * a pointer now, so after choosing v3 the highest is still 5 and the
     * current is 3, and those are genuinely different facts.
     *
     * It cannot be inferred from the file either. Comparing paths looked right
     * and was wrong on every project predating the archiver: versions written
     * before it existed still name the live filename, which on a real shot made
     * SIX of seven versions claim to be on the board — and the modal hides
     * Restore on the current one, so six attempts became unselectable.
     */
    const currentVersion = currentFrameVersion(shotId);

    const versions = rows.map(r => {
        let meta = {};
        try { meta = JSON.parse(r.metadata || '{}'); } catch (_) { meta = {}; }

        const isCurrent = r.version === currentVersion;
        const onDisk = safeExists(r.file_path);
        // A row still naming the live file is an attempt whose own picture was
        // never kept — the live file is now some LATER attempt. Only the current
        // version may legitimately point there.
        const overwritten = !isCurrent && path.resolve(r.file_path || '') === path.resolve(current);

        return {
            version: r.version,
            is_current: isCurrent,
            // Restorable and existing are different questions. A file can be on
            // disk and still not be this version's picture.
            restorable: !isCurrent && onDisk && !overwritten,
            exists: onDisk,
            reason: isCurrent ? null
                : overwritten
                    ? 'this attempt was never archived — its picture was overwritten by a later one, '
                        + 'so there is nothing to restore'
                    : (!onDisk ? 'the file for this version is no longer on disk' : null),
            // What tells one attempt from another. The number alone does not.
            url: `/film/storyboards/${scene.project_id}/${encodeURIComponent(r.file_name)}`,
            created_at: r.created_at,
            provider: meta.provider || null,
            provider_model: meta.provider_model || null,
            // How it came to exist, which is often the thing you remember about
            // an attempt when you cannot remember its number.
            origin: meta.sent_from ? `sent from ${meta.sent_from}`
                : meta.restored_from ? `restored from v${meta.restored_from}`
                : meta.refined_from ? `refine (${meta.refined_from})`
                : meta.instruction ? 'refine'
                : 'generated',
            // A borrowed frame is a different thing from a generated one: it
            // was made from another shot's card, so the card and the picture
            // here describe different shots and that is not a fault to fix.
            sent_from: meta.sent_from || null,
            restored_from: meta.restored_from || null,
            // Which attempt's picture this version is actually of. Differs from
            // `version` only after a restore, which is exactly when a number
            // alone misleads.
            shows_version: meta.restored_from
                ? (assetShowsVersion(r) || meta.restored_from) : r.version,
        };
    });

    const lost = versions.filter(v => !v.restorable && !v.is_current).length;
    return json(res, 200, {
        shot_id: shotId, shot_code: shot.shot_code, versions,
        current_version: currentVersion,
        restorable_count: versions.filter(v => v.restorable).length,
        note: 'Every attempt is kept. Restoring one copies it back to the live frame as a NEW '
            + 'version — nothing is deleted and nothing is rewound, so the attempt you are '
            + 'leaving is still here if you change your mind again.'
            + (lost ? ` ${lost} earlier attempt(s) predate per-version archiving and cannot be restored; `
                + 'they are listed because they are real history, not because they can be chosen.' : ''),
    });
}

function safeExists(p) {
    try { return !!p && fs.existsSync(p); } catch (_) { return false; }
}

/**
 * Put an earlier attempt back on the board.
 *
 * POST /film/shots/:id/frames/:version/restore
 *
 * Forward, never backward. The restored picture becomes a new highest version
 * rather than truncating the history to the one being restored: rewinding would
 * destroy the attempts made after it, which is the same mistake as deleting a
 * frame to regenerate it, and it would make "restore" a destructive verb on a
 * list whose whole purpose is that nothing is lost.
 *
 * Costs nothing — it is a file copy, not a generation.
 */
function restoreShotFrame(req, res, shotId, version) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });
    const scene = db.prepare('SELECT project_id FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) return json(res, 404, { error: 'Scene not found' });

    /*
     * Selecting a frame is free and forward-only, and it still changes which
     * picture the shot SHOWS — which is exactly what a lock exists to hold
     * still. Guarded rather than exempted: a locked board that can be silently
     * re-pointed at a different attempt is not locked.
     */
    {
        // provider_config comes along not because this resolves a provider — it
        // does not — but because the guard keeping every project fetch honest
        // cannot tell the two apart, and relaxing a guard to fit new code is
        // how it stops protecting the case it was written for.
        const project = db.prepare(
            'SELECT board_locked_at, provider_config FROM film_projects WHERE id = ?')
            .get(scene.project_id);
        const lk = boardLocked(project, req.body || {});
        if (lk) return json(res, 423, lk);
    }

    const wanted = Number(version);
    const row = db.prepare(
        `SELECT id, version, file_path FROM film_assets
          WHERE shot_id = ? AND asset_type = 'storyboard' AND version = ?`).get(shotId, wanted);
    if (!row) return json(res, 404, { error: `This shot has no version ${wanted}` });

    /*
     * Moving a pointer, not making a version.
     *
     * This used to copy the chosen attempt to a NEW highest version — v3
     * selected became v6 — so that nothing was ever destroyed. Nothing was, and
     * the count became a lie: five generations and one selection read as six
     * attempts, and "which am I on" stopped having an answer. Versions are the
     * GENERATIONS; which one is on the board is a pointer, and moving it
     * creates nothing.
     *
     * The live file is still written, because every consumer — the board, the
     * viewer, previs, the video pass — reads {code}.png. What is NOT written is
     * a row.
     */
    const live = storyboardImagePath(scene.project_id, shot.shot_code);

    /*
     * A row still naming the LIVE file is an attempt whose own picture was
     * never kept aside — the file at that path is now some later attempt. It
     * exists, so a bare existsSync says yes and the copy would silently write
     * the current picture onto itself and report success. `listShotFrames`
     * already calls these `overwritten` and refuses to offer Restore; the route
     * has to agree, or the API accepts what the UI knows is impossible.
     */
    const namesLiveFile = row.file_path
        && path.resolve(row.file_path) === path.resolve(live);
    const src = (!namesLiveFile && row.file_path && fs.existsSync(row.file_path))
        ? row.file_path : null;
    if (!src) {
        return json(res, 409, {
            error: namesLiveFile
                ? `Version ${wanted}'s own picture was never kept — that row names the live file, `
                  + 'which now holds a later attempt.'
                : `The file for version ${wanted} is no longer on disk.`,
            hint: 'The row survives, so the attempt is recorded — but the picture cannot be shown.',
        });
    }

    const current = currentFrameVersion(shotId);
    if (current === wanted) {
        return json(res, 200, {
            shot_id: shotId, version: wanted, changed: false,
            note: 'That version is already the frame on the board.',
        });
    }

    try {
        /*
         * Before pointing elsewhere, make sure the picture currently on the
         * board is stored under its own version. A freshly generated frame
         * lives only at {code}.png until something archives it, so switching
         * away without this would lose the newest attempt — the one thing this
         * list exists to prevent.
         */
        archiveExistingFrame(scene.project_id, shotId, shot.shot_code);
        fs.copyFileSync(src, live);
        db.prepare('UPDATE film_shots SET current_frame_version = ? WHERE id = ?').run(wanted, shotId);
    } catch (err) {
        return json(res, 500, { error: 'Could not restore that version: ' + err.message });
    }

    return json(res, 200, {
        shot_id: shotId,
        shot_code: shot.shot_code,
        version: wanted,
        changed: true,
        versions_total: db.prepare(
            `SELECT COUNT(*) n FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard'`)
            .get(shotId).n,
        note: `Now showing version ${wanted}. No new version was created — selecting an attempt `
            + 'moves which one is on the board, it does not make another.',
        image_url: storyboardImageUrl(scene.project_id, shot.shot_code),
    });
}


/**
 * POST /film/shots/:id/frames/:version/send — put this picture on another shot.
 *
 * "There is a shot I'd like to put to 2A from 2B."
 *
 * Generation is a coin flip you already paid for, and sometimes the frame that
 * came back on 2B is the right shot for 2A. Without this the only route there
 * was to regenerate 2A and hope — paying a second time for a picture already
 * sitting on the board.
 *
 * It is a COPY, in every sense that matters:
 *
 *   the source keeps every version it had. Moving the file would take the
 *   picture off the shot that generated it, which is a destructive verb hiding
 *   inside a helpful one.
 *
 *   the target gains a version rather than overwriting. On the receiving side
 *   this genuinely is a new attempt, and whatever the target was showing has to
 *   survive — a send that silently replaced it would destroy work in the one
 *   direction nobody is watching.
 *
 *   the file is duplicated, never shared. Two rows pointing at one path means
 *   deleting either shot, or regenerating either, breaks the other, and the
 *   damage surfaces on the shot nobody touched.
 */
function sendFrameToShot(req, res, shotId, version) {
    const body = req.body || {};
    const targetId = String(body.target_shot_id || '').trim();
    if (!targetId) {
        return json(res, 400, { error: 'Name the shot to send this frame to (target_shot_id).' });
    }
    if (targetId === shotId) {
        return json(res, 400, {
            error: 'That is the shot the frame is already on.',
            hint: 'To put an earlier attempt back on THIS shot, select it in the versions list.',
        });
    }

    const source = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    const target = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(targetId);
    if (!source) return json(res, 404, { error: 'Shot not found' });
    if (!target) return json(res, 404, { error: 'That target shot does not exist.' });

    const srcScene = db.prepare('SELECT project_id FROM film_scenes WHERE id = ?').get(source.scene_id);
    const dstScene = db.prepare('SELECT project_id FROM film_scenes WHERE id = ?').get(target.scene_id);
    if (!srcScene || !dstScene) return json(res, 404, { error: 'Scene not found' });
    if (srcScene.project_id !== dstScene.project_id) {
        // Assets live under a project directory and a different project is a
        // different film; allowing this would put a file where nothing expects
        // to find it, and would carry one production's look into another.
        return json(res, 400, {
            error: 'That shot is in a different project.',
            hint: 'Frames can only be sent between shots in the same film.',
        });
    }
    const projectId = srcScene.project_id;

    const project = db.prepare(
        'SELECT board_locked_at, provider_config FROM film_projects WHERE id = ?').get(projectId);
    const lk = boardLocked(project, body);
    if (lk) return json(res, 423, lk);

    const wanted = Number(version);
    const row = db.prepare(
        `SELECT id, version, file_path, metadata FROM film_assets
          WHERE shot_id = ? AND asset_type = 'storyboard' AND version = ?`).get(shotId, wanted);
    if (!row) return json(res, 404, { error: `This shot has no version ${wanted}` });

    // A row still naming the live file has no picture of its own — the file
    // there is now some later attempt. Same rule the versions list applies.
    const srcLive = storyboardImagePath(projectId, source.shot_code);
    const namesLiveFile = row.file_path && path.resolve(row.file_path) === path.resolve(srcLive);
    const from = (!namesLiveFile && row.file_path && fs.existsSync(row.file_path)) ? row.file_path : null;
    if (!from) {
        return json(res, 409, {
            error: namesLiveFile
                ? `Version ${wanted}'s own picture was never kept aside, so there is nothing to send.`
                : `The file for version ${wanted} is no longer on disk.`,
        });
    }

    try {
        ensureStoryboardDir(projectId);
        // Keep what the target is showing before pointing it at something else.
        archiveExistingFrame(projectId, targetId, target.shot_code);

        const live = storyboardImagePath(projectId, target.shot_code);
        fs.copyFileSync(from, live);

        const asset = registerStoryboardAsset(projectId, targetId, live, `${target.shot_code}.png`, {
            provider: 'sent',
            sent_from: `${source.shot_code} v${wanted}`,
            sent_from_shot_id: shotId,
            sent_from_version: wanted,
        });

        // The picture is now BOTH the live file and its own version, so archive
        // it immediately — otherwise the next generation on the target would
        // overwrite it before anything had kept a copy.
        archiveExistingFrame(projectId, targetId, target.shot_code);

        return json(res, 200, {
            from_shot_id: shotId,
            from_shot_code: source.shot_code,
            from_version: wanted,
            to_shot_id: targetId,
            to_shot_code: target.shot_code,
            to_version: asset.version,
            note: `${source.shot_code} v${wanted} is now ${target.shot_code} v${asset.version}. `
                + `${source.shot_code} keeps all of its own versions, and ${target.shot_code}'s `
                + 'previous frame is still in its history.',
            // A borrowed frame was not generated from the target's card. That is
            // not a fault, but it is worth knowing before wondering why the card
            // and the picture describe different things.
            caution: `This picture was generated from ${source.shot_code}'s card, not `
                + `${target.shot_code}'s.`,
            image_url: storyboardImageUrl(projectId, target.shot_code),
        });
    } catch (err) {
        return json(res, 500, { error: 'Could not send that frame: ' + err.message });
    }
}

/**
 * Which version a shot is currently showing.
 *
 * NULL means the highest, which is what a freshly generated shot shows and what
 * every shot showed before selection existed — so the absence of a pointer is a
 * meaningful default rather than missing data.
 */
function currentFrameVersion(shotId) {
    const shot = db.prepare('SELECT current_frame_version FROM film_shots WHERE id = ?').get(shotId);
    if (shot && shot.current_frame_version != null) return shot.current_frame_version;
    const top = db.prepare(
        `SELECT MAX(version) v FROM film_assets WHERE shot_id = ? AND asset_type = 'storyboard'`)
        .get(shotId);
    return top ? top.v : null;
}

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
function shotPromptPreview(req, res, shotId, query) {
    const { loadShotContext, buildCapabilityPayload } = require('../lib/capability-payloads');

    let ctx;
    try { ctx = loadShotContext(shotId); } catch (err) {
        return json(res, err.code === 'PRECONDITION' ? 409 : 404, { error: err.message });
    }
    if (!ctx || !ctx.shot) return json(res, 404, { error: 'Shot not found' });

    // PAR-026: preview the frame WITH the marks applied without turning the
    // feature on and without generating. Trying it is what makes it adoptable —
    // finding out by generating is how one experiment becomes a budget
    // decision, which is the same argument previs made for its own preview.
    const wants = query && (query.use_annotations === 'true' || query.use_annotations === '1');
    if (wants) ctx.useAnnotations = true;
    if (query && (query.use_annotations === 'false' || query.use_annotations === '0')) ctx.useAnnotations = false;

    /*
     * The mode this preview is FOR. It was hardcoded to 'action', so the free
     * dry-run could only ever show the mode that was already working — and the
     * mode that costs money to try was the one you could not look at first.
     * That inverts the reason this route exists.
     *
     * The anchor requirement is reported rather than refused. A 409 is right at
     * generation time, where running anyway spends money producing the drift
     * camera mode exists to prevent; here it would mean answering "what would
     * this cost me" with an error instead of the answer.
     */
    const { DIRECTION_MODES } = require('../lib/storyboard-prompt');
    const directionMode = String((query && query.direction_mode) || 'action');
    if (!DIRECTION_MODES[directionMode]) {
        return json(res, 400, {
            error: `Unknown direction_mode '${directionMode}'.`,
            modes: Object.keys(DIRECTION_MODES),
        });
    }
    ctx.directionMode = directionMode;
    const modeNeedsAnchor = !!DIRECTION_MODES[directionMode].requires_anchor;

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
        // Two shapes reach this list and only one was being read. A gathered
        // plate is { name, kind, tag, uri }; a consistency reference is
        // { subject_name, profile_type, role }. Reporting only the second
        // rendered every gathered plate as `{}` — a report that says a
        // subject's picture is attached, and cannot say which subject.
        references: (payload.reference_images || []).map(r => ({
            subject: r.name || r.subject_name || null,
            kind: r.kind || r.profile_type || null,
            tag: r.tag || null,
            role: r.role || null,
        })),
        contributors,
        /*
         * The prompt budget, contributor by contributor: what each wanted, what
         * it got, and whether it could have been cut. This is the answer to
         * "it does a lot in the background" — the negotiation is visible, so a
         * shot that came back wrong can be diagnosed rather than re-rolled.
         */
        budget: (built.meta && built.meta.budget) || [],
        direction_mode: directionMode,
        // Named here rather than refused, because this route spends nothing:
        // the honest answer to "what would camera mode give me" on a shot with
        // no anchor is "an unlocked scene, and here is why", not a 409.
        direction_mode_ready: !modeNeedsAnchor || !!(built.payload
            && (built.payload.reference_images || []).some(r => r.kind === 'anchor')),
        direction_mode_blocked: (modeNeedsAnchor
            && !(built.payload && (built.payload.reference_images || []).some(r => r.kind === 'anchor')))
            ? 'Camera mode keeps the scene from an existing frame, and none is attached. '
              + 'Set an anchor first, or this generation would be refused.'
            : null,
        direction_modes: Object.entries(require('../lib/storyboard-prompt').DIRECTION_MODES)
            .map(([id, m]) => ({ id, label: m.label, description: m.description,
                requires_anchor: !!m.requires_anchor })),
        // What the director drew, and what it is doing. Three separate facts —
        // is the feature on, which marks carry a note, and what sentence they
        // produce — because each has a different fix and folding them into one
        // count tells a director nothing about which to do.
        direction: (() => {
            const { directionClause } = require('../lib/annotation-prompt');
            const d = directionClause(ctx.annotations || []);
            return {
                feedback_enabled: !!ctx.useAnnotations,
                marks: (ctx.annotations || []).length,
                applied: ctx.useAnnotations ? d.used : 0,
                clause: ctx.useAnnotations ? d.text : '',
                ignored: d.directives.filter(x => !x.feeds)
                    .map(x => ({ id: x.id, kind: x.kind, reason: x.reason })),
                hint: ctx.useAnnotations
                    ? undefined
                    : 'Add ?use_annotations=true to see this prompt with the markup applied. '
                        + 'Costs nothing.',
            };
        })(),
        // Which frame this scene is measured against.
        //
        // The frame this shot is being generated from, as it will actually be
        // used. The shared payload gathers plates now, so the prompt above is
        // the prompt — this block explains it rather than standing in for it.
        anchor: (() => {
            const { activeAnchorFor, anchorPhrase } = require('../lib/shot-anchor');
            const resolved = activeAnchorFor(db, shotId);
            return {
                shot_code: resolved.shot ? resolved.shot.shot_code : null,
                // Whether it actually claimed one of the three slots, which is
                // a different question from whether an anchor is set.
                attached: !!ctx.anchorAttached,
                reason: resolved.shot ? null : resolved.reason,
                cross_scene: resolved.cross_scene || null,
                adds: ctx.anchorAttached ? anchorPhrase(ctx.anchorTag) : '',
                note: 'This shot is generated FROM that frame: the same location, dressing and '
                    + 'subject placement, re-shot on this card\u2019s own lens and angle. Plates '
                    + 'for subjects already standing in it are not sent.',
            };
        })(),
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

/**
 * Is this frame the one the project is currently shooting from?
 *
 * One boolean, read from one column. The version this replaces DERIVED an
 * anchor per scene — the first shot in it with a frame — so anchoring 1A lit up
 * an anchor badge on 2A as well, because scene 2 had appointed its own. There
 * is nothing to derive now.
 */
function anchorStateFor(shotId, activeShotId) {
    return { is_anchor: !!activeShotId && activeShotId === shotId };
}

/**
 * The project's active anchor for this shot, and whether this call attaches it.
 *
 * There is no separate on/off setting to consult any more — an anchor being set
 * IS it being on. `use_anchor: false` on a single call skips it, which is the
 * "generate this one from plates without putting the anchor down" case.
 *
 * The provider gate is about whether the picture can be SENT, not whether it
 * can be named: the anchor ranks first among references, so a provider that
 * cannot read tags is told "the first reference image" and that is unambiguous.
 * A provider that takes no reference images at all has no way to receive the
 * frame, and the reason is reported rather than the anchor silently dropped.
 */
function activeAnchorFor_(shotId, project, body, canAttach) {
    const requested = body && body.use_anchor;
    if (requested === false) {
        return { enabled: false, anchor: null, reason: 'use_anchor: false — generated from plates' };
    }
    if (!canAttach) {
        return { enabled: true, anchor: null,
            reason: 'the image provider does not take reference images, so there is no way '
                + 'to send the frame — not attached' };
    }
    const { activeAnchorFor } = require('../lib/shot-anchor');
    const resolved = activeAnchorFor(db, shotId);
    return {
        enabled: true,
        anchor: resolved.shot ? resolved : null,
        reason: resolved.reason,
        cross_scene: resolved.cross_scene || null,
    };
}

/**
 * The subjects an attached anchor already shows, for the contract trimmer.
 *
 * Empty unless the frame actually claimed a slot: shortening a subject's
 * description because of a picture that is not in the payload is the exact
 * failure the contract shortening was reverted for.
 */
function anchorCoversFor(anchorState, attached) {
    if (!attached || !anchorState || !anchorState.anchor) return [];
    return [...require('../lib/shot-anchor').subjectsCoveredBy(db, anchorState.anchor)];
}

/** Did the anchor claim a reference slot, and may the prompt name it? */
function anchorIn(refs, canTag) {
    const ref = (refs || []).find(r => r && r.kind === 'anchor');
    return { anchorAttached: !!ref, anchorTag: (ref && canTag) ? ref.tag : null };
}

/**
 * The marks on a shot, and whether this call should generate from them.
 *
 * PAR-026. Three-way precedence and only one of the three can turn it ON by
 * itself without somebody saying so: an explicit `use_annotations` on the
 * request wins, otherwise the project's standing choice, otherwise off. A
 * default that switches itself on would silently change what every existing
 * board produces, which is the reason this is a column rather than a constant.
 */
function annotationsFor(shotId, project, body) {
    const requested = body && body.use_annotations;
    const enabled = requested === undefined || requested === null
        ? !!(project && project.annotation_feedback)
        : !!requested;

    let marks = [];
    try {
        marks = db.prepare(
            'SELECT * FROM film_storyboard_annotations WHERE shot_id = ? ORDER BY created_at').all(shotId)
            .map(r => {
                let points = [];
                try { const v = JSON.parse(r.points_json || '[]'); if (Array.isArray(v)) points = v; } catch (_) { points = []; }
                return { id: r.id, kind: r.kind, points, text: r.text, color: r.color };
            });
    } catch (_) { marks = []; }

    const { annotationDirectives } = require('../lib/annotation-prompt');
    const directives = annotationDirectives(marks);
    return {
        enabled,
        marks,
        directives,
        // Marks that WOULD feed, whether or not this call is applying them.
        noted: directives.filter(d => d.feeds).length,
        unnoted: directives.filter(d => !d.feeds).length,
        applied: enabled ? directives.filter(d => d.feeds).length : 0,
    };
}

/** What a caller is told about the marks, on every path that can use them. */
function annotationReport(a) {
    return {
        feedback_enabled: a.enabled,
        applied: a.applied,
        // Named individually. "1 mark was ignored" sends a director back to the
        // frame to work out which one.
        ignored: a.directives.filter(d => !d.feeds).map(d => ({ id: d.id, kind: d.kind, reason: d.reason })),
    };
}

/**
 * Change one thing about a frame you already have.
 *
 * POST /film/shots/:id/storyboard/refine  { instruction, version? }
 *
 * Everything else here regenerates from the card: the whole prompt is rebuilt,
 * every subject reasserts itself, and the result is a NEW picture that happens
 * to be of the same shot. That is the wrong tool for "this one, but without the
 * sprinkler" — you spend a generation and lose the composition you liked in
 * order to change one object in it.
 *
 * So this sends the frame itself as the reference and says only what to change.
 * The prompt is deliberately SHORT: the picture carries the scene, the grade and
 * the placement, and a long prompt beside it re-describes everything and pulls
 * the result back toward a fresh generation — which is the failure this exists
 * to avoid.
 *
 * A past version can be refined too, so a composition three attempts ago is
 * still reachable rather than being something you have to regenerate your way
 * back to.
 */
async function refineShot(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) return json(res, 404, { error: 'Shot not found' });
    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    const project = scene && db.prepare(
        'SELECT id, title, style_preset, provider_config, aspect_ratio, annotation_feedback, anchor_shot_id, board_locked_at FROM film_projects WHERE id = ?')
        .get(scene.project_id);
    const _lock = boardLocked(project, req.body || {});
    if (_lock) return json(res, 423, _lock);
    if (!project) return json(res, 404, { error: 'Project not found' });

    const body = req.body || {};
    let instruction = String(body.instruction || '').trim();

    /**
     * Marks are at their strongest here (PAR-026).
     *
     * Refine attaches the picture, so "move the car to the kerb" means exactly
     * what it says: the thing being moved is on screen and so is the place. On
     * a regeneration from the card there is no previous frame and "move" has
     * nothing to move from, which is why the two paths read the same marks
     * through different builders rather than one that pretends the difference
     * away.
     *
     * An instruction typed by hand still LEADS. The marks were drawn earlier;
     * the sentence someone just wrote is the current thought, and burying it
     * behind three older notes would invert that.
     */
    const annots = annotationsFor(shotId, project, body);
    if (annots.enabled && annots.applied) {
        const { refineInstruction } = require('../lib/annotation-prompt');
        const fromMarks = refineInstruction(annots.marks).text;
        instruction = instruction ? `${instruction}. ${fromMarks}` : fromMarks;
    }

    if (!instruction) {
        return json(res, 400, {
            error: 'instruction is required: what to change about this frame, in a sentence',
            hint: 'e.g. "remove the sprinkler" or "move the car to the kerb on the right"',
            marks: annots.marks.length
                ? (annots.enabled
                    ? 'This shot has markup, but none of it carries a note — a shape says where, not what.'
                    : 'This shot has markup that is not being applied. Pass use_annotations: true, '
                        + 'or turn on annotation_feedback for the project.')
                : undefined,
        });
    }

    // Which picture to work from. Default is what is on screen now.
    let source = storyboardImagePath(project.id, shot.shot_code);
    let fromVersion = null;
    if (body.version) {
        const row = db.prepare(
            `SELECT version, file_path FROM film_assets
              WHERE shot_id = ? AND asset_type = 'storyboard' AND version = ?`).get(shotId, Number(body.version));
        if (!row || !fs.existsSync(row.file_path)) {
            return json(res, 404, { error: `No stored image for version ${body.version}` });
        }
        source = row.file_path;
        fromVersion = row.version;
    }
    if (!fs.existsSync(source)) {
        return json(res, 409, { error: 'This shot has no frame yet. Generate one before refining it.' });
    }

    // The frame as a data URI, which is how every adapter reads a local image —
    // no provider can read our disk.
    const { toDataUri } = require('../lib/reference-images');
    let uri;
    try {
        uri = toDataUri(source);
    } catch (err) {
        return json(res, 500, { error: `Could not read the frame: ${err.message}` });
    }
    if (!uri) return json(res, 409, { error: 'That frame could not be inlined as a reference.' });
    const reference = { name: shot.shot_code, kind: 'style', tag: 'frame', uri, file_path: source, weight: 0.9 };

    /*
     * A second reference: the anchor, for continuity a refine cannot see.
     *
     * Refine sent exactly one picture — this frame — so "make the street match
     * 1A" was unsayable: the only thing the model could look at was the shot
     * being changed. Attaching the anchor gives it the scene to be continuous
     * WITH.
     *
     * Opt-in rather than automatic, and that is the whole safety argument.
     * Refine's contract is "keep this picture, change one thing", enforced by a
     * negative that refuses a different composition. A second picture arriving
     * uninvited is exactly what pulls a refine back toward a fresh generation —
     * so it attaches only when asked, and the prompt names each image by its
     * JOB: the first is the frame to keep, the second is the scene to match.
     * Without that the model gets two pictures and no idea which one it is
     * supposed to be reproducing.
     */
    let anchorRef = null;
    if (body.use_anchor === true || body.use_anchor === 'true') {
        try {
            // The same resolver every generation path uses, so refine can never
            // disagree with the board about which frame the anchor is.
            const { activeAnchorFor } = require('../lib/shot-anchor');
            const resolved = activeAnchorFor(db, shotId);
            const src = resolved && resolved.asset && resolved.asset.file_path;
            if (resolved && resolved.shot && src && fs.existsSync(src)) {
                const auri = toDataUri(src);
                if (auri) {
                    anchorRef = {
                        name: resolved.shot.shot_code, kind: 'anchor', tag: 'scene',
                        uri: auri, file_path: src, weight: 0.6,
                    };
                }
            }
        } catch (_) { anchorRef = null; }
        if (!anchorRef) {
            return json(res, 409, {
                error: 'No anchor frame is available to match against.',
                code: 'NO_ANCHOR',
                hint: 'Set an anchor on a shot that already has a generated frame (the ⚓ button), '
                    + 'then refine again with use_anchor.',
            });
        }
    }

    // Short on purpose. The picture is the description.
    const prompt = anchorRef
        ? `${instruction}. Keep everything else in the FIRST reference image exactly as it is: `
          + 'the same composition, framing, camera position and lens. '
          + 'Match the SECOND reference image for continuity only — the same location, set dressing, '
          + 'time of day, lighting and colour grade — without copying its composition or camera angle.'
        : `${instruction}. Keep everything else in the reference image exactly as it is: `
          + 'the same composition, framing, camera position, lighting and colour grade.';

    db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('generating', shotId);
    try {
        ensureStoryboardDir(project.id);
        const payload = {
            prompt,
            negative_prompt: 'different composition, different camera angle, different framing, '
                + 'recropped, restyled, different time of day',
            reference_images: anchorRef ? [reference, anchorRef] : [reference],
            aspect_ratio: project.aspect_ratio,
        };
        const { buffer, provider, model } = await callImageGen(
            payload.prompt, payload.negative_prompt, undefined, payload, spendContext(project, shot));

        const imgPath = storyboardImagePath(project.id, shot.shot_code);
        archiveExistingFrame(project.id, shotId, shot.shot_code);
        fs.writeFileSync(imgPath, buffer);
        // What this frame IS: a refine of a specific earlier version, with the
        // sentence that asked for it. Both fields were already accepted by
        // registerStoryboardAsset and travelled only in the JSON response, so
        // the asset itself recorded nothing — a refined frame sat in the
        // version list indistinguishable from a plain regeneration.
        const asset = registerStoryboardAsset(project.id, shotId, imgPath, `${shot.shot_code}.png`,
            {
                provider, provider_model: model,
                refined_from: fromVersion === null ? 'current' : `v${fromVersion}`,
                instruction,
                anchor_shot_code: anchorRef ? anchorRef.name : null,
            });
        db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('complete', shotId);

        return json(res, 200, {
            shot_id: shotId, shot_code: shot.shot_code,
            refined_from: fromVersion === null ? 'current' : `v${fromVersion}`,
            instruction, version: asset.version, provider,
            // Named, because "matched against 1A" and "matched against nothing"
            // produce different pictures and look identical afterwards.
            matched_against: anchorRef ? anchorRef.name : null,
            image_url: storyboardImageUrl(project.id, shot.shot_code),
            annotations: annotationReport(annots),
        });
    } catch (err) {
        db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('failed', shotId);
        return json(res, 502, { error: `Refine failed: ${err.message}` });
    }
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

    const project = db.prepare('SELECT id, title, style_preset, provider_config, aspect_ratio, annotation_feedback, anchor_shot_id, board_locked_at FROM film_projects WHERE id = ?').get(scene.project_id);
    const _lock = boardLocked(project, req.body || {});
    if (_lock) return json(res, 423, _lock);
    if (!project) {
        return json(res, 404, { error: 'Project not found' });
    }

    const body = req.body || {};
    const consistencyContext = buildShotReferencePayload(shot, scene, project);

    // PAR-026: what the director drew, if this project or this call says so.
    const annots = annotationsFor(shotId, project, body);

    /*
     * What the director is doing to this shot right now.
     *
     * Blocking the ACTION and blocking the CAMERA are different jobs, and one
     * prompt shape cannot serve both: "put the camera on the other side of the
     * street" kept producing a different scene because the prompt rebuilt every
     * subject from prose each time. Camera mode locks the scene to a frame that
     * already exists and spends the prompt on where the camera stands.
     */
    const { DIRECTION_MODES } = require('../lib/storyboard-prompt');
    const directionMode = String(body.direction_mode || 'action');
    if (!DIRECTION_MODES[directionMode]) {
        return json(res, 400, {
            error: `Unknown direction_mode '${directionMode}'.`,
            modes: Object.entries(DIRECTION_MODES).map(([id, m]) => ({ id, label: m.label, description: m.description })),
        });
    }

    /**
     * The plates, resolved BEFORE the prompt rather than after it.
     *
     * The order matters now: the scene anchor is attached for its light and the
     * prompt has to name it by the tag the gatherer assigned, so a prompt built
     * first could only name a tag it had not yet seen. Everything else about
     * this gather is unchanged.
     *
     * Note what is deliberately NOT passed to the builder: the full reference
     * set. Handing it `references` would switch every character from prose to
     * `@maya`, which was tried, shipped and reverted — the picture does not
     * always arrive, and a subject that travels with neither words nor image
     * comes back as something else entirely. Only the anchor tag goes, because
     * an anchor has no prose form to fall back on.
     */
    const lead = imageProviderChain(spendContext(project, shot))[0];
    const canAttach = !!(lead && lead.supportsReferenceImages);
    const canTag = !!(lead && lead.supportsReferenceTags);
    const anchorState = activeAnchorFor_(shotId, project, body, canAttach);
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
            matchProps(card, allProps),
            anchorState.anchor,
            { limit: lead && lead.maxReferenceImages });
    } catch (_) { shotRefs = []; }
    const { anchorAttached, anchorTag } = anchorIn(shotRefs, canTag);

    // Camera mode keeps a scene, so there has to BE one. Locking a scene you
    // have not generated is not a mode, it is a mistake — and running anyway
    // would spend money producing exactly the drift the mode exists to prevent.
    if (DIRECTION_MODES[directionMode].requires_anchor && !anchorAttached) {
        return json(res, 409, {
            error: 'Camera mode keeps the scene from an existing frame, and none is attached.',
            reason: anchorState.reason,
            hint: 'Generate a frame you like, set it as the anchor (anchor_set), then direct the camera '
                + 'from there. Without an anchor there is no scene to keep, so this would be an ordinary '
                + 'regeneration with a camera instruction — which is direction_mode "action".',
        });
    }

    // Build or use override prompt
    let prompt, negative_prompt;

    if (body.prompt_override) {
        prompt = body.prompt_override;
        negative_prompt = body.negative_prompt || 'blurry, low quality, distorted, deformed';
        // An override is the WHOLE prompt. Appending direction to it is the same
        // mistake `promptIsFinal` exists to stop: the composer already had the
        // marks in front of them (shot_prompt reports them) and either used
        // them or decided not to. Reported as not applied, never silently
        // stapled on.
        annots.applied = 0;
        annots.overridden = true;
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
            {
                props,
                annotations: annots.enabled ? annots.marks : undefined,
                anchorAttached, anchorTag,
                // The same plates the board path names. This path used to build
                // its prompt in prose while attaching the pictures anyway, so
                // two shots on one board generated two ways described their
                // subjects differently — the divergence this work exists to
                // remove, surviving inside the one route that does both.
                //
                // Safe only because the plates are gathered ABOVE and go on the
                // payload below: a subject shortened to @maya with no picture
                // attached travels with neither words nor image, which is the
                // failure the contract-shortening revert was about.
                references: shotRefs, tagged: canTag,
                maxPromptChars: imagePromptLimitFor(project),
                // Which job the director is doing, and — in camera mode — which
                // subjects the locked frame already carries, so they travel as
                // names rather than paragraphs.
                directionMode,
                anchorCovers: anchorCoversFor(anchorState, anchorAttached),
            }
        );
        prompt = result.prompt;
        negative_prompt = result.negative_prompt;
    }

    const seed = body.seed || consistencyContext.locked_seed || crypto.randomInt(0, 2 ** 31);

    // Update status
    db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('generating', shotId);

    try {
        ensureStoryboardDir(project.id);

        // The tagged, inlined plates gathered above. This path used to rely on
        // the consistency context's references, which carry a `file_path` — a
        // path on OUR disk — while every image adapter reads `uri`/`url`, so
        // they were dropped on the floor and regenerating one shot ran
        // text-to-image with no plate conditioning at all.

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
            // Subjects standing in the attached frame keep their NAME and lose
            // their paragraph. On a real shot that was 2,517 of 3,990
            // characters describing a street, a sprinkler and a car all plainly
            // visible in the picture travelling beside them.
            anchorCovers: anchorCoversFor(anchorState, anchorAttached),
        });
        const { buffer: imageBuffer, provider: usedProvider, model: usedModel } =
            await callImageGen(imagePayload.prompt, imagePayload.negative_prompt, imagePayload.seed, imagePayload, spendContext(project, shot));

        const imgPath = storyboardImagePath(project.id, shot.shot_code);
        // Keep what is about to be replaced. Every attempt cost money.
        archiveExistingFrame(project.id, shotId, shot.shot_code);
        fs.writeFileSync(imgPath, imageBuffer);

        const asset = registerStoryboardAsset(project.id, shotId, imgPath, `${shot.shot_code}.png`, {
            input_refs: consistencyContext.input_refs,
            provider: usedProvider,
            provider_model: usedModel,
            direction_mode: directionMode,
            anchor_shot_code: anchorAttached
                ? ((anchorState.anchor && anchorState.anchor.shot_code) || null) : null,
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
            anchor: {
                shot_code: anchorState.anchor && anchorState.anchor.shot ? anchorState.anchor.shot.shot_code : null,
                attached: !!anchorAttached,
                reason: anchorAttached ? null : anchorState.reason,
                cross_scene: anchorState.cross_scene || null,
            },
            annotations: {
                ...annotationReport(annots),
                ...(annots.overridden
                    ? { note: 'prompt_override is the whole prompt, so markup was not appended to it.' }
                    : {}),
            },
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
