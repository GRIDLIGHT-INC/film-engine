/**
 * Budget & cost tracking
 * GET    /film/projects/:id/budget          — budget summary
 * POST   /film/projects/:id/budget          — create cost entry
 * GET    /film/projects/:id/budget/ledger   — paginated cost entries
 * GET    /film/projects/:id/budget/forecast  — spend forecast
 * PUT    /film/projects/:id/budget/limit    — set budget limit
 * DELETE /film/budget/:id                   — delete cost entry
 */
const { db, generateId } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_COST_TYPES = [
    'render_gpu', 'model_inference', 'voice_tts', 'music_generation',
    'image_generation', 'video_generation', 'storage', 'license', 'other'
];

function handleBudget(req, res, urlParts, query) {
    // /film/projects/:id/budget[/ledger|/forecast|/limit]
    if (urlParts[1] === 'projects' && urlParts[3] === 'budget') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');

        const sub = urlParts[4];

        if (sub === 'ledger' && req.method === 'GET') return listCostEntries(req, res, projectId, query);
        if (sub === 'forecast' && req.method === 'GET') return budgetForecast(req, res, projectId);
        if (sub === 'limit' && req.method === 'PUT') return setBudgetLimit(req, res, projectId);

        if (!sub) {
            if (req.method === 'GET') return budgetSummary(req, res, projectId);
            if (req.method === 'POST') return createCostEntry(req, res, projectId);
        }
    }

    // /film/budget/:id
    if (urlParts[1] === 'budget' && urlParts[2]) {
        const entryId = urlParts[2];
        if (!UUID_RE.test(entryId)) return badReq(res, 'Invalid cost entry ID');
        if (req.method === 'DELETE') return deleteCostEntry(req, res, entryId);
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function badReq(res, msg) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

// --- Budget Summary ---

function budgetSummary(req, res, projectId) {
    const project = db.prepare('SELECT id, budget_total, budget_currency FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const totals = db.prepare(
        'SELECT COALESCE(SUM(amount), 0) AS total_spent, COUNT(*) AS entry_count FROM film_cost_entries WHERE project_id = ?'
    ).get(projectId);

    const breakdown = db.prepare(
        'SELECT cost_type, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count FROM film_cost_entries WHERE project_id = ? GROUP BY cost_type ORDER BY amount DESC'
    ).all(projectId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        budget_total: project.budget_total || 0,
        budget_currency: project.budget_currency || 'USD',
        total_spent: totals.total_spent,
        remaining: (project.budget_total || 0) - totals.total_spent,
        entry_count: totals.entry_count,
        breakdown
    }));
}

// --- Create Cost Entry ---

function createCostEntry(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const body = req.body;
    if (body.amount === undefined || body.amount === null) return badReq(res, 'amount is required');
    if (!body.cost_type || !VALID_COST_TYPES.includes(body.cost_type)) {
        return badReq(res, `cost_type is required. Valid: ${VALID_COST_TYPES.join(', ')}`);
    }

    const amount = Number(body.amount);
    if (isNaN(amount) || amount < 0) return badReq(res, 'amount must be a non-negative number');

    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_cost_entries (id, project_id, cost_type, description, amount, currency,
            gpu_seconds, model_used, scene_id, shot_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, projectId,
        body.cost_type,
        (body.description || '').slice(0, 2000),
        amount,
        (body.currency || 'USD').slice(0, 10),
        body.gpu_seconds || 0,
        (body.model_used || '').slice(0, 200),
        body.scene_id && UUID_RE.test(body.scene_id) ? body.scene_id : null,
        body.shot_id && UUID_RE.test(body.shot_id) ? body.shot_id : null,
        now
    );

    const row = db.prepare('SELECT * FROM film_cost_entries WHERE id = ?').get(id);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(row));
}

// --- Paginated Cost Ledger ---

function listCostEntries(req, res, projectId, query) {
    let page = Math.max(1, parseInt(query.page) || 1);
    let limit = Math.min(200, Math.max(1, parseInt(query.limit) || 50));
    const offset = (page - 1) * limit;

    let whereClauses = ['project_id = ?'];
    const params = [projectId];

    if (query.cost_type && VALID_COST_TYPES.includes(query.cost_type)) {
        whereClauses.push('cost_type = ?');
        params.push(query.cost_type);
    }

    const where = whereClauses.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) AS count FROM film_cost_entries WHERE ${where}`).get(...params);

    const rows = db.prepare(
        `SELECT * FROM film_cost_entries WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        entries: rows,
        count: rows.length,
        total: total.count,
        page,
        limit,
        pages: Math.ceil(total.count / limit)
    }));
}

// --- Budget Forecast ---

function budgetForecast(req, res, projectId) {
    const project = db.prepare('SELECT id, budget_total, budget_currency FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const stats = db.prepare(`
        SELECT
            COALESCE(SUM(amount), 0) AS total_spent,
            COUNT(*) AS entry_count,
            MIN(created_at) AS first_entry,
            MAX(created_at) AS last_entry
        FROM film_cost_entries WHERE project_id = ?
    `).get(projectId);

    const budgetTotal = project.budget_total || 0;
    const remaining = budgetTotal - stats.total_spent;
    let avgDailySpend = 0;
    let projectedTotal = stats.total_spent;
    let daysUntilExhausted = null;

    if (stats.entry_count > 0 && stats.first_entry) {
        const firstDate = new Date(stats.first_entry);
        const lastDate = new Date(stats.last_entry);
        const now = new Date();
        const daysSinceFirst = Math.max(1, (now - firstDate) / (1000 * 60 * 60 * 24));

        avgDailySpend = stats.total_spent / daysSinceFirst;

        // Project 30 days from now
        projectedTotal = stats.total_spent + (avgDailySpend * 30);

        if (budgetTotal > 0 && avgDailySpend > 0) {
            daysUntilExhausted = remaining > 0 ? Math.ceil(remaining / avgDailySpend) : 0;
        }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        budget_total: budgetTotal,
        budget_currency: project.budget_currency || 'USD',
        total_spent: stats.total_spent,
        remaining,
        entry_count: stats.entry_count,
        first_entry: stats.first_entry,
        last_entry: stats.last_entry,
        avg_daily_spend: Math.round(avgDailySpend * 100) / 100,
        projected_30d_total: Math.round(projectedTotal * 100) / 100,
        days_until_exhausted: daysUntilExhausted
    }));
}

// --- Set Budget Limit ---

function setBudgetLimit(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const body = req.body;
    const fields = [];
    const values = [];

    if (body.budget_total !== undefined) {
        const total = Number(body.budget_total);
        if (isNaN(total) || total < 0) return badReq(res, 'budget_total must be a non-negative number');
        fields.push('budget_total = ?');
        values.push(total);
    }
    if (body.budget_currency !== undefined) {
        fields.push('budget_currency = ?');
        values.push(String(body.budget_currency).slice(0, 10));
    }

    if (fields.length === 0) return badReq(res, 'Provide budget_total and/or budget_currency');

    values.push(projectId);
    db.prepare(`UPDATE film_projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT id, budget_total, budget_currency FROM film_projects WHERE id = ?').get(projectId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(updated));
}

// --- Delete Cost Entry ---

function deleteCostEntry(req, res, entryId) {
    const result = db.prepare('DELETE FROM film_cost_entries WHERE id = ?').run(entryId);
    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Cost entry not found' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

module.exports = { handleBudget };
