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

function generateMarketingAsset(req, res, assetId) {
    const asset = db.prepare('SELECT * FROM film_marketing_assets WHERE id = ?').get(assetId);
    if (!asset) return notFound(res);

    db.prepare('UPDATE film_marketing_assets SET status = ? WHERE id = ?').run('generating', assetId);

    const updated = db.prepare('SELECT * FROM film_marketing_assets WHERE id = ?').get(assetId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        ...updated,
        _hint: 'Send the prompt field to ImageGen API (POST /image) to generate the asset image'
    }));
}

module.exports = { handleMarketing };
