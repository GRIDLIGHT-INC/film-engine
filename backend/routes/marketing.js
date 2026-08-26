/**
 * Marketing assets
 * GET/POST /film/projects/:id/marketing
 * GET/PUT/DELETE /film/marketing/:id
 * POST /film/marketing/:id/generate
 */
const { db, generateId } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_TYPES = ['poster', 'key_art', 'banner', 'social_card', 'still', 'thumbnail', 'logo'];
const VALID_STATUSES = ['planned', 'generating', 'generated', 'approved', 'rejected'];

function handleMarketing(req, res, urlParts, query) {
    // /film/projects/:id/marketing
    if (urlParts[1] === 'projects' && urlParts[3] === 'marketing') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');
        if (req.method === 'GET') return listMarketingAssets(req, res, projectId, query);
        if (req.method === 'POST') return createMarketingAsset(req, res, projectId);
    }

    // /film/marketing/:id[/generate]
    if (urlParts[1] === 'marketing' && urlParts[2]) {
        const assetId = urlParts[2];
        if (!UUID_RE.test(assetId)) return badReq(res, 'Invalid marketing asset ID');

        if (urlParts[3] === 'import' && req.method === 'POST') {
            return importMarketingImage(req, res, assetId);
        }
        if (urlParts[3] === 'preview' && req.method === 'GET') {
            return previewMarketingAsset(req, res, assetId, query);
        }
        if (urlParts[3] === 'generate' && req.method === 'POST') {
            return generateMarketingAsset(req, res, assetId);
        }

        if (req.method === 'GET') return getMarketingAsset(req, res, assetId);
        if (req.method === 'PUT') return updateMarketingAsset(req, res, assetId);
        if (req.method === 'DELETE') return deleteMarketingAsset(req, res, assetId);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function badReq(res, msg) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

function notFound(res) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Marketing asset not found' }));
}

// --- List ---

function listMarketingAssets(req, res, projectId, query) {
    let sql = 'SELECT * FROM film_marketing_assets WHERE project_id = ?';
    const params = [projectId];

    if (query.type && VALID_TYPES.includes(query.type)) {
        sql += ' AND type = ?';
        params.push(query.type);
    }
    if (query.status && VALID_STATUSES.includes(query.status)) {
        sql += ' AND status = ?';
        params.push(query.status);
    }

    sql += ' ORDER BY created_at DESC';

    const rows = db.prepare(sql).all(...params);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ marketing_assets: rows, count: rows.length }));
}

// --- Get ---

function getMarketingAsset(req, res, assetId) {
    const asset = db.prepare('SELECT * FROM film_marketing_assets WHERE id = ?').get(assetId);
    if (!asset) return notFound(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(asset));
}

// --- Create ---

function createMarketingAsset(req, res, projectId) {
    const body = req.body;
    if (!body.title || !body.title.trim()) return badReq(res, 'title is required');
    if (!body.type || !VALID_TYPES.includes(body.type)) {
        return badReq(res, `type is required. Valid: ${VALID_TYPES.join(', ')}`);
    }

    const status = body.status && VALID_STATUSES.includes(body.status) ? body.status : 'planned';
    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_marketing_assets (id, project_id, type, title, description,
            prompt, aspect_ratio, resolution, image_path, status, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, projectId,
        body.type,
        body.title.trim().slice(0, 500),
        (body.description || '').slice(0, 2000),
        (body.prompt || '').slice(0, 5000),
        (body.aspect_ratio || '').slice(0, 20),
        (body.resolution || '').slice(0, 20),
        (body.image_path || '').slice(0, 1000),
        status,
        (body.notes || '').slice(0, 2000),
        now
    );

    const row = db.prepare('SELECT * FROM film_marketing_assets WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

// --- Update ---

function updateMarketingAsset(req, res, assetId) {
    const existing = db.prepare('SELECT * FROM film_marketing_assets WHERE id = ?').get(assetId);
    if (!existing) return notFound(res);

    const body = req.body;
    const fields = [];
    const params = [];

    if (body.title !== undefined) {
        fields.push('title = ?');
        params.push(body.title.trim().slice(0, 500));
    }
    if (body.type !== undefined) {
        if (!VALID_TYPES.includes(body.type)) {
            return badReq(res, `Invalid type. Valid: ${VALID_TYPES.join(', ')}`);
        }
        fields.push('type = ?');
        params.push(body.type);
    }
    if (body.description !== undefined) {
        fields.push('description = ?');
        params.push(body.description.slice(0, 2000));
    }
    if (body.prompt !== undefined) {
        fields.push('prompt = ?');
        params.push(body.prompt.slice(0, 5000));
    }
    if (body.aspect_ratio !== undefined) {
        fields.push('aspect_ratio = ?');
        params.push(body.aspect_ratio.slice(0, 20));
    }
    if (body.resolution !== undefined) {
        fields.push('resolution = ?');
        params.push(body.resolution.slice(0, 20));
    }
    if (body.image_path !== undefined) {
        fields.push('image_path = ?');
        params.push(body.image_path.slice(0, 1000));
    }
    if (body.status !== undefined) {
        if (!VALID_STATUSES.includes(body.status)) {
            return badReq(res, `Invalid status. Valid: ${VALID_STATUSES.join(', ')}`);
        }
        fields.push('status = ?');
        params.push(body.status);
    }
    if (body.notes !== undefined) {
        fields.push('notes = ?');
        params.push(body.notes.slice(0, 2000));
    }

    if (fields.length === 0) return badReq(res, 'No fields to update');

    params.push(assetId);
    db.prepare(`UPDATE film_marketing_assets SET ${fields.join(', ')} WHERE id = ?`).run(...params);

    const row = db.prepare('SELECT * FROM film_marketing_assets WHERE id = ?').get(assetId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

// --- Delete ---

function deleteMarketingAsset(req, res, assetId) {
    const result = db.prepare('DELETE FROM film_marketing_assets WHERE id = ?').run(assetId);
    if (result.changes === 0) return notFound(res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

// --- Generate ---

const reply = (res, code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
};

/**
 * A poster, key art or social card made somewhere else.
 *
 * `image_path` could only be set by POSTing a STRING — a path on the server's
 * own disk — so from a browser this surface could not hold a picture at all.
 * Marketing art is usually made in a design tool, which makes the upload the
 * ordinary path here rather than the escape hatch.
 */
function importMarketingImage(req, res, assetId) {
    const asset = db.prepare('SELECT * FROM film_marketing_assets WHERE id = ?').get(assetId);
    if (!asset) return notFound(res);
    const body = req.body || {};
    if (!body.data) return reply(res, 400, { error: 'no image supplied' });
    try {
        const { importMedia } = require('../lib/media-imports');
        const imported = importMedia('marketing-asset', {
            projectId: asset.project_id, data: body.data, name: body.name || asset.title,
        });
        db.prepare("UPDATE film_marketing_assets SET image_path = ?, status = 'generated' WHERE id = ?")
            .run(imported.file_name, assetId);
        return reply(res, 201, {
            asset: db.prepare('SELECT * FROM film_marketing_assets WHERE id = ?').get(assetId),
            ...imported,
        });
    } catch (err) {
        return reply(res, /not found/i.test(err.message) ? 404 : 400, { error: err.message });
    }
}

/**
 * What a poster is made from.
 *
 * The asset's own prompt leads, because it is the only statement of what this
 * piece of art IS. The film's style preset follows: a poster that does not look
 * like the film is a poster for a different film, and the preset is the one
 * place that look is written down. It is a KEY ART brief rather than a frame,
 * so it explicitly asks for no scene furniture — a poster generated as though
 * it were a storyboard panel comes back as a screenshot.
 */
function buildMarketingPrompt(asset, project) {
    const parts = [];
    const own = String(asset.prompt || '').trim();
    if (own) parts.push(own);
    else parts.push(`${String(asset.type || 'poster').replace(/_/g, ' ')} for the film`
        + (project && project.title ? ` "${project.title}"` : ''));
    if (asset.description) parts.push(String(asset.description).trim());
    const style = project && String(project.style_preset || '').trim();
    if (style) parts.push(style);
    parts.push('key art composition, poster framing, clean negative space for titles');
    return parts.filter(Boolean).join(', ');
}

const MARKETING_NEGATIVE = 'storyboard panel, screenshot, film still, letterboxing, '
    + 'watermark, existing title text, lorem ipsum, gibberish lettering, credit block';

/** Dimensions the asset asks for, or the ratio's own default. */
function marketingSize(asset) {
    const m = /^(\d+)\s*[x:]\s*(\d+)$/i.exec(String(asset.resolution || ''));
    if (m) return { width: Number(m[1]), height: Number(m[2]) };
    return { width: 1080, height: 1620 };
}

/**
 * FREE. What would be sent, before anything is bought.
 *
 * Every paid path in this engine shows its request first; a poster costs the
 * same as a storyboard frame and there is no reason for it to be the exception.
 */
function previewMarketingAsset(req, res, assetId, query) {
    const asset = db.prepare('SELECT * FROM film_marketing_assets WHERE id = ?').get(assetId);
    if (!asset) return notFound(res);
    const project = db.prepare('SELECT id, title, style_preset, provider_config FROM film_projects WHERE id = ?')
        .get(asset.project_id);
    const providers = require('../lib/providers');
    const { spendContext } = require('../lib/provider-config');
    const { withTierModel } = require('../lib/capability-payloads');

    /*
     * THE PREVIEW HAS TO TAKE THE SAME OVERRIDE THE PURCHASE DOES.
     *
     * It read only the project's standing choice, so previewing a generation
     * you were about to make on a different provider showed the wrong one —
     * the same defect the refine preview shipped once, where a dialog whose
     * entire purpose is "see what will be sent" was confidently wrong.
     */
    const q = query || {};
    const override = {};
    if (q.quality) override.image_quality = String(q.quality);
    if (q.provider) override.image = String(q.provider);
    const cfg = spendContext(project, null, null, Object.keys(override).length ? override : null);
    const adapter = providers.get(providers.resolveId('image', cfg));

    const size = marketingSize(asset);
    const prompt = buildMarketingPrompt(asset, project);
    const payload = withTierModel({ prompt, aspect_ratio: asset.aspect_ratio },
        { project, tierOverride: Object.keys(override).length ? override : null }, adapter);

    /*
     * The ratio the provider will REALLY use.
     *
     * Meshy's nano-banana family offers no 2:3, so a one-sheet poster comes
     * back 3:4 — a different shape from the one that was chosen, and nothing
     * would have said so until the picture arrived.
     */
    let effectiveRatio = asset.aspect_ratio;
    try {
        const meshy = require('../lib/providers/meshy');
        const snap = meshy.snapMeshyRatio || (meshy._internal && meshy._internal.snapMeshyRatio);
        if (adapter && adapter.id === 'meshy' && snap) {
            effectiveRatio = snap(asset.aspect_ratio, payload.model);
        }
    } catch (_) { /* an unknown provider keeps the asset's own ratio */ }

    const notes = [];
    if (effectiveRatio !== asset.aspect_ratio) {
        notes.push(`${adapter.id} does not offer ${asset.aspect_ratio} on ${payload.model || 'this model'} — `
            + `it will generate ${effectiveRatio}.`);
    }
    if (!(project && project.style_preset)) {
        notes.push('This project has no style preset, so the artwork will not match the film.');
    }

    let cost = null;
    try {
        const { rateFor } = require('../lib/provider-pricing');
        const rate = rateFor(adapter.id, 'image', payload.model);
        if (rate) {
            cost = { usd: rate.usd_per_unit !== undefined ? rate.usd_per_unit : rate.usd_per_native,
                native: rate.native_per_unit, native_unit: rate.native_unit };
        }
    } catch (_) { /* an unpriced pair must not break a free preview */ }

    return reply(res, 200, {
        asset_id: assetId,
        provider: adapter && adapter.id,
        model: payload.model || null,
        prompt,
        prompt_length: prompt.length,
        negative_prompt: MARKETING_NEGATIVE,
        aspect_ratio: asset.aspect_ratio,
        effective_aspect_ratio: effectiveRatio,
        width: size.width,
        height: size.height,
        style_applied: !!(project && project.style_preset),
        estimated_cost: cost,
        notes,
        note: 'Nothing was generated and nothing was spent.',
    });
}

/**
 * Generate the artwork.
 *
 * This returned a `_hint` telling the caller to send the prompt to an image API
 * themselves, and had done since the day it shipped — the status moved to
 * 'generating' and nothing ever moved it back, so a marketing asset could sit
 * in that state permanently. It goes through the same fallback chain, the same
 * quality tier and the same metering as every other image in the engine.
 */
async function generateMarketingAsset(req, res, assetId) {
    const asset = db.prepare('SELECT * FROM film_marketing_assets WHERE id = ?').get(assetId);
    if (!asset) return notFound(res);
    const project = db.prepare('SELECT id, title, style_preset, provider_config FROM film_projects WHERE id = ?')
        .get(asset.project_id);

    const body = req.body || {};
    const { generateImageWithFallback } = require('../lib/image-fallback');
    const { spendContext } = require('../lib/provider-config');
    const { persistProviderMedia } = require('../lib/provider-media');
    const { withTierModel } = require('../lib/capability-payloads');
    const providers = require('../lib/providers');

    // A per-generation quality, exactly as the board has.
    const override = {};
    if (typeof body.quality === 'string' && body.quality.trim()) override.image_quality = body.quality.trim();
    if (typeof body.provider === 'string' && body.provider.trim()) override.image = body.provider.trim();
    const cfg = spendContext(project, null, null, Object.keys(override).length ? override : null);

    const size = marketingSize(asset);
    db.prepare("UPDATE film_marketing_assets SET status = 'generating' WHERE id = ?").run(assetId);

    try {
        // An edited prompt replaces the composed one whole — including the
        // style preset, which is normally appended. That is the point of an
        // override, and the confirmation says so where it is typed.
        const { promptOverride } = require('../lib/generation-override');
        const promptEdit = promptOverride(body);
        const factory = adapter => withTierModel({
            prompt: promptEdit || buildMarketingPrompt(asset, project),
            negative_prompt: MARKETING_NEGATIVE,
            aspect_ratio: asset.aspect_ratio || undefined,
            width: size.width,
            height: size.height,
        }, { project, tierOverride: Object.keys(override).length ? override : null }, adapter);

        const result = await generateImageWithFallback(factory, cfg, { timeout: 300000 });
        if (!result || !result.ok) {
            // Back to planned, not left in 'generating'. A status that only ever
            // moves forward is how an asset ends up permanently mid-flight.
            db.prepare("UPDATE film_marketing_assets SET status = 'planned' WHERE id = ?").run(assetId);
            return reply(res, 502, { error: 'Image generation failed', details: result && result.error,
                attempts: result && result._chain });
        }

        // Lands beside every other reference picture, so the same serving route
        // and the same thumbnailing apply with nothing new to remember.
        const fileName = `marketing_${String(asset.type || 'poster')}_${assetId.slice(0, 8)}.png`;
        const filePath = await persistProviderMedia(
            project.id, 'refsheets', fileName, result.data || result);

        const assetRowId = generateId();
        const bytes = (() => { try { return require('fs').statSync(filePath).size; } catch (_) { return 0; } })();
        db.prepare(`INSERT INTO film_assets
            (id, project_id, asset_type, file_path, file_name, format, mime_type, size_bytes, version, metadata)
            VALUES (?, ?, 'other', ?, ?, 'png', 'image/png', ?, 1, ?)`)
            .run(assetRowId, project.id, filePath, fileName, bytes,
                JSON.stringify({ kind: 'marketing', marketing_id: assetId, type: asset.type }));

        db.prepare("UPDATE film_marketing_assets SET image_path = ?, status = 'generated' WHERE id = ?")
            .run(fileName, assetId);

        return reply(res, 200, {
            asset: db.prepare('SELECT * FROM film_marketing_assets WHERE id = ?').get(assetId),
            provider: result.provider,
            model: result.provider_model || null,
            file_name: fileName,
            attempts: result._chain,
        });
    } catch (err) {
        db.prepare("UPDATE film_marketing_assets SET status = 'planned' WHERE id = ?").run(assetId);
        return reply(res, 500, { error: err.message });
    }
}

module.exports = { handleMarketing, buildMarketingPrompt, MARKETING_NEGATIVE };
