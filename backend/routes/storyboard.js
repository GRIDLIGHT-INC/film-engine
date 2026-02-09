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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA_DIR = process.env.FILM_DATA_DIR || path.join(__dirname, '..', '..', 'data');

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
 * Call the ImageGen API to generate an image (non-streaming).
 * Returns a Buffer of the image data (PNG).
 * API returns JSON with url field; image is fetched from GET /images/{filename}.
 */
async function callImageGen(prompt, negativePrompt, seed, options) {
    const opts = options || {};
    const payload = {
        prompt,
        negative_prompt: negativePrompt,
        model: opts.model || 'sdxl',
        width: opts.width || 1024,
        height: opts.height || 1024,
        steps: opts.steps || 30,
        guidance_scale: opts.guidance_scale || 7.5,
        seed: seed || null,
        stream: false,
    };

    // Include IP-Adapter fields if provided
    if (opts.ip_adapter_image) {
        payload.ip_adapter_image = opts.ip_adapter_image;
        payload.ip_adapter_weight = opts.ip_adapter_weight || 0.7;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (GRIDLIGHT_API_KEY) {
        headers['Authorization'] = `Bearer ${GRIDLIGHT_API_KEY}`;
    }

    const response = await fetch(`${GRIDLIGHT_URL}/image`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`ImageGen error ${response.status}: ${errText}`);
    }

    const contentType = response.headers.get('content-type') || '';

    // API returns JSON with url field (full URL or path or filename)
    if (contentType.includes('application/json')) {
        const data = await response.json();
        const imageUrl = data.url || data.image_url || data.filename;
        if (!imageUrl) {
            throw new Error('ImageGen returned JSON but no url field');
        }
        // Resolve to a fetchable URL
        let fetchUrl;
        if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
            fetchUrl = imageUrl;
        } else if (imageUrl.startsWith('/')) {
            fetchUrl = `${GRIDLIGHT_URL}${imageUrl}`;
        } else {
            fetchUrl = `${GRIDLIGHT_URL}/images/${imageUrl}`;
        }
        const imgRes = await fetch(fetchUrl);
        if (!imgRes.ok) {
            throw new Error(`Failed to fetch generated image: ${imgRes.status}`);
        }
        return Buffer.from(await imgRes.arrayBuffer());
    }

    // Legacy: raw binary response
    return Buffer.from(await response.arrayBuffer());
}

/**
 * Call the ImageGen API with SSE streaming for progress updates.
 * Returns { buffer, metadata } where buffer is the PNG image data.
 * Calls onProgress callback with progress events during generation.
 */
async function callImageGenStream(prompt, negativePrompt, seed, options, onProgress) {
    const opts = options || {};
    const payload = {
        prompt,
        negative_prompt: negativePrompt,
        model: opts.model || 'sdxl',
        width: opts.width || 1024,
        height: opts.height || 1024,
        steps: opts.steps || 30,
        guidance_scale: opts.guidance_scale || 7.5,
        seed: seed || null,
        stream: true,
    };

    if (opts.ip_adapter_image) {
        payload.ip_adapter_image = opts.ip_adapter_image;
        payload.ip_adapter_weight = opts.ip_adapter_weight || 0.7;
    }

    const headers = { 'Content-Type': 'application/json' };
    if (GRIDLIGHT_API_KEY) {
        headers['Authorization'] = `Bearer ${GRIDLIGHT_API_KEY}`;
    }

    const response = await fetch(`${GRIDLIGHT_URL}/image`, {
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
    // Gridlight sends named events: event: progress, event: image, event: done
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

            let currentEvent = '';
            for (const line of lines) {
                if (line.startsWith('event: ')) {
                    currentEvent = line.slice(7).trim();
                    continue;
                }
                if (!line.startsWith('data: ')) continue;
                const dataStr = line.slice(6).trim();
                if (!dataStr || dataStr === '[DONE]') continue;

                try {
                    const data = JSON.parse(dataStr);

                    if (currentEvent === 'progress') {
                        // Gridlight progress: { step, total_steps, percentage }
                        if (onProgress) onProgress({
                            type: 'progress',
                            step: data.step || 0,
                            total_steps: data.total_steps || payload.steps,
                        });
                    } else if (currentEvent === 'image') {
                        // Gridlight image event: { url, generated_at }
                        imageUrl = data.url || data.image_url;
                    } else if (currentEvent === 'done') {
                        // Gridlight done event: { status, url, seed }
                        if (!imageUrl) imageUrl = data.url || data.image_url;
                        metadata = {
                            seed: data.seed,
                            model: data.model,
                            generation_time_ms: data.generation_time_ms,
                        };
                    } else if (currentEvent === 'error') {
                        throw new Error(data.message || data.error || 'Image generation failed');
                    }
                } catch (parseErr) {
                    if (parseErr.message && !parseErr.message.includes('JSON')) throw parseErr;
                }
                currentEvent = '';
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
        const imageUrl = data.url || data.image_url || data.filename;
        if (!imageUrl) throw new Error('No url in image response');

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
            output_path, resolution, mode)
        VALUES (?, ?, ?, 'keyframe', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, shotId, version,
        params.model || 'sdxl',
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
        params.mode || 'creative'
    );

    return { id, version };
}

/**
 * Register or update a storyboard asset in film_assets.
 */
function registerStoryboardAsset(projectId, shotId, filePath, fileName) {
    // Check for existing storyboard asset for this shot
    const existing = db.prepare(
        'SELECT id, version FROM film_assets WHERE shot_id = ? AND asset_type = \'storyboard\' ORDER BY version DESC LIMIT 1'
    ).get(shotId);

    const version = existing ? (existing.version || 0) + 1 : 1;
    const id = generateId();

    db.prepare(`
        INSERT INTO film_assets (id, project_id, shot_id, asset_type, file_path, file_name,
            format, mime_type, width, height, version)
        VALUES (?, ?, ?, 'storyboard', ?, ?, 'png', 'image/png', 1024, 1024, ?)
    `).run(id, projectId, shotId, filePath, fileName, version);

    return { id, version };
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
                return generateStoryboardStream(req, res, projectId);
            }
            if (req.method !== 'POST') {
                return json(res, 405, { error: 'Method not allowed' });
            }
            return generateStoryboard(req, res, projectId);
        }

        if (!sub) {
            if (req.method === 'GET') {
                return getStoryboard(req, res, projectId, query);
            }
            return json(res, 405, { error: 'Method not allowed' });
        }

        return json(res, 404, { error: 'Not found' });
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

    const filePath = path.join(DATA_DIR, 'storyboards', projectId, filename);
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

function getStoryboard(req, res, projectId, query) {
    const project = db.prepare('SELECT id, title, style_preset FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        return json(res, 404, { error: 'Project not found' });
    }

    const shots = loadProjectShots(projectId);
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

async function generateStoryboard(req, res, projectId) {
    const project = db.prepare('SELECT id, title, style_preset FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        return json(res, 404, { error: 'Project not found' });
    }

    const shots = loadProjectShots(projectId);
    if (shots.length === 0) {
        return json(res, 400, { error: 'No shots found for this project. Run screenplay breakdown first.' });
    }

    // Load characters and locations for prompt building
    const characters = db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(projectId);
    const locations = db.prepare('SELECT * FROM film_locations WHERE project_id = ?').all(projectId);

    ensureStoryboardDir(projectId);

    const body = req.body || {};
    const results = [];
    let shotsCompleted = 0;
    let shotsFailed = 0;

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

        // Style lock
        const styleLockEnabled = sceneCard.style_lock !== false;
        const styleParams = applyStyleLock(baseSeed, shotIndexInScene, {
            styleLock: styleLockEnabled,
            consistencyWeight: body.consistency_weight,
            ipAdapterImage: body.ip_adapter_image || null,
        });

        // Build prompt
        const { prompt, negative_prompt } = buildStoryboardPrompt(
            sceneCard, matchedChars, matchedLocation, project.style_preset
        );

        // Update shot status
        db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('generating', shot.shot_id);

        try {
            const imageBuffer = await callImageGen(prompt, negative_prompt, styleParams.seed, {
                ip_adapter_image: styleParams.ip_adapter_image,
                ip_adapter_weight: styleParams.ip_adapter_weight,
            });

            // Save image to disk
            const imgPath = storyboardImagePath(projectId, shot.shot_code);
            fs.writeFileSync(imgPath, imageBuffer);

            // Register asset
            registerStoryboardAsset(projectId, shot.shot_id, imgPath, `${shot.shot_code}.png`);

            // Log to render ledger
            logToRenderLedger(shot.shot_id, {
                seed: styleParams.seed,
                prompt,
                negative_prompt,
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
    });
}

// ── FILM-017: Generate Storyboard (SSE Stream) ─────────────────────

async function generateStoryboardStream(req, res, projectId) {
    const project = db.prepare('SELECT id, title, style_preset FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        return json(res, 404, { error: 'Project not found' });
    }

    const shots = loadProjectShots(projectId);
    if (shots.length === 0) {
        return json(res, 400, { error: 'No shots found for this project. Run screenplay breakdown first.' });
    }

    const characters = db.prepare('SELECT * FROM film_characters WHERE project_id = ?').all(projectId);
    const locations = db.prepare('SELECT * FROM film_locations WHERE project_id = ?').all(projectId);

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

    const sendEvent = (data) => {
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

        const styleLockEnabled = sceneCard.style_lock !== false;
        const styleParams = applyStyleLock(baseSeed, shotIndexInScene, {
            styleLock: styleLockEnabled,
            consistencyWeight: body.consistency_weight,
            ipAdapterImage: body.ip_adapter_image || null,
        });

        const { prompt, negative_prompt } = buildStoryboardPrompt(
            sceneCard, matchedChars, matchedLocation, project.style_preset
        );

        sendEvent({
            type: 'progress',
            shot_index: i,
            total_shots: shots.length,
            shot_code: shot.shot_code,
            scene_number: shot.scene_number,
            phase: 'generating',
        });

        db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('generating', shot.shot_id);

        try {
            const { buffer: imageBuffer, metadata } = await callImageGenStream(
                prompt, negative_prompt, styleParams.seed,
                {
                    ip_adapter_image: styleParams.ip_adapter_image,
                    ip_adapter_weight: styleParams.ip_adapter_weight,
                },
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
                }
            );

            const imgPath = storyboardImagePath(projectId, shot.shot_code);
            fs.writeFileSync(imgPath, imageBuffer);

            registerStoryboardAsset(projectId, shot.shot_id, imgPath, `${shot.shot_code}.png`);

            const actualSeed = (metadata && metadata.seed) || styleParams.seed;
            logToRenderLedger(shot.shot_id, {
                seed: actualSeed,
                prompt,
                negative_prompt,
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

async function regenerateShot(req, res, shotId) {
    const shot = db.prepare('SELECT * FROM film_shots WHERE id = ?').get(shotId);
    if (!shot) {
        return json(res, 404, { error: 'Shot not found' });
    }

    const scene = db.prepare('SELECT * FROM film_scenes WHERE id = ?').get(shot.scene_id);
    if (!scene) {
        return json(res, 404, { error: 'Scene not found' });
    }

    const project = db.prepare('SELECT id, title, style_preset FROM film_projects WHERE id = ?').get(scene.project_id);
    if (!project) {
        return json(res, 404, { error: 'Project not found' });
    }

    const body = req.body || {};

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

        const result = buildStoryboardPrompt(
            sceneCard, matchedChars, matchedLocation,
            body.style_override || project.style_preset
        );
        prompt = result.prompt;
        negative_prompt = result.negative_prompt;
    }

    const seed = body.seed || crypto.randomInt(0, 2 ** 31);

    // Update status
    db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('generating', shotId);

    try {
        ensureStoryboardDir(project.id);

        const imageBuffer = await callImageGen(prompt, negative_prompt, seed);

        const imgPath = storyboardImagePath(project.id, shot.shot_code);
        fs.writeFileSync(imgPath, imageBuffer);

        registerStoryboardAsset(project.id, shotId, imgPath, `${shot.shot_code}.png`);

        logToRenderLedger(shotId, {
            seed,
            prompt,
            negative_prompt,
            output_path: imgPath,
            mode: body.mode || 'creative',
        });

        db.prepare('UPDATE film_shots SET status = ? WHERE id = ?').run('complete', shotId);

        json(res, 200, {
            shot_id: shotId,
            shot_code: shot.shot_code,
            status: 'complete',
            image_url: storyboardImageUrl(project.id, shot.shot_code),
            seed,
            prompt,
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

module.exports = { handleStoryboard };
