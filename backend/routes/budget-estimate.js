/**
 * Budget Estimation Routes
 * GET    /film/projects/:id/budget/estimate           — Get/generate budget estimate
 * POST   /film/projects/:id/budget/estimate           — Create new estimate
 * PUT    /film/projects/:id/budget/estimate/:eid      — Update estimate
 * DELETE /film/projects/:id/budget/estimate/:eid      — Delete estimate
 * POST   /film/projects/:id/budget/estimate/analyze   — Analyze project for estimation
 * POST   /film/projects/:id/budget/estimate/web-search — Search web for cost data
 * POST   /film/projects/:id/budget/estimate/ai        — Request AI estimate
 * PUT    /film/characters/:id/cost                    — Set character cost fields
 * PUT    /film/locations/:id/cost                     — Set location cost fields
 * GET    /film/budget/templates                       — List available templates
 * GET    /film/budget/talent-tiers                    — List talent tier options
 * GET    /film/budget/location-types                  — List location type options
 */
const { db, generateId } = require('../db/database');
const {
    analyzeProject,
    generateEstimate,
    buildWebSearchQuery,
    getBudgetTemplates,
    getTalentTiers,
    getLocationTypes,
    TALENT_TIER_RATES,
    LOCATION_TYPE_RATES
} = require('../lib/budget-estimator');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_TALENT_TIERS = ['unknown', 'background', 'day_player', 'supporting', 'lead', 'star', 'a_list'];
const VALID_LOCATION_TYPES = ['unknown', 'practical', 'studio', 'backlot', 'remote', 'international'];

function handleBudgetEstimate(req, res, urlParts, query) {
    // /film/budget/templates
    if (urlParts[1] === 'budget' && urlParts[2] === 'templates' && req.method === 'GET') {
        return listTemplates(req, res);
    }

    // /film/budget/talent-tiers
    if (urlParts[1] === 'budget' && urlParts[2] === 'talent-tiers' && req.method === 'GET') {
        return listTalentTiers(req, res);
    }

    // /film/budget/location-types
    if (urlParts[1] === 'budget' && urlParts[2] === 'location-types' && req.method === 'GET') {
        return listLocationTypes(req, res);
    }

    // /film/characters/:id/cost
    if (urlParts[1] === 'characters' && urlParts[2] && urlParts[3] === 'cost') {
        const charId = urlParts[2];
        if (!UUID_RE.test(charId)) return badReq(res, 'Invalid character ID');
        if (req.method === 'PUT') return setCharacterCost(req, res, charId);
    }

    // /film/locations/:id/cost
    if (urlParts[1] === 'locations' && urlParts[2] && urlParts[3] === 'cost') {
        const locId = urlParts[2];
        if (!UUID_RE.test(locId)) return badReq(res, 'Invalid location ID');
        if (req.method === 'PUT') return setLocationCost(req, res, locId);
    }

    // /film/projects/:id/budget/estimate[/...]
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'budget' && urlParts[4] === 'estimate') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');

        const sub = urlParts[5];
        const estimateId = urlParts[5];

        // /film/projects/:id/budget/estimate/analyze
        if (sub === 'analyze' && req.method === 'POST') {
            return analyzeProjectEndpoint(req, res, projectId);
        }

        // /film/projects/:id/budget/estimate/web-search
        if (sub === 'web-search' && req.method === 'POST') {
            return webSearchEstimate(req, res, projectId);
        }

        // /film/projects/:id/budget/estimate/ai
        if (sub === 'ai' && req.method === 'POST') {
            return aiEstimate(req, res, projectId);
        }

        // /film/projects/:id/budget/estimate/:eid
        if (estimateId && UUID_RE.test(estimateId)) {
            if (req.method === 'GET') return getEstimate(req, res, projectId, estimateId);
            if (req.method === 'PUT') return updateEstimate(req, res, projectId, estimateId);
            if (req.method === 'DELETE') return deleteEstimate(req, res, projectId, estimateId);
        }

        // /film/projects/:id/budget/estimate
        if (!sub) {
            if (req.method === 'GET') return getOrGenerateEstimate(req, res, projectId, query);
            if (req.method === 'POST') return createEstimate(req, res, projectId);
        }
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}

function badReq(res, msg) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}

// --- List Templates ---
function listTemplates(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ templates: getBudgetTemplates() }));
}

// --- List Talent Tiers ---
function listTalentTiers(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tiers: getTalentTiers() }));
}

// --- List Location Types ---
function listLocationTypes(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ types: getLocationTypes() }));
}

// --- Set Character Cost ---
function setCharacterCost(req, res, charId) {
    const character = db.prepare('SELECT * FROM film_characters WHERE id = ?').get(charId);
    if (!character) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Character not found' }));
        return;
    }

    const body = req.body || {};
    const fields = [];
    const values = [];

    if (body.day_rate !== undefined) {
        const rate = Number(body.day_rate);
        if (isNaN(rate) || rate < 0) return badReq(res, 'day_rate must be a non-negative number');
        fields.push('day_rate = ?');
        values.push(rate);
    }

    if (body.shooting_days !== undefined) {
        const days = parseInt(body.shooting_days);
        if (isNaN(days) || days < 0) return badReq(res, 'shooting_days must be a non-negative integer');
        fields.push('shooting_days = ?');
        values.push(days);
    }

    if (body.travel_allowance !== undefined) {
        const travel = Number(body.travel_allowance);
        if (isNaN(travel) || travel < 0) return badReq(res, 'travel_allowance must be a non-negative number');
        fields.push('travel_allowance = ?');
        values.push(travel);
    }

    if (body.actor_name !== undefined) {
        fields.push('actor_name = ?');
        values.push(String(body.actor_name).slice(0, 200));
    }

    if (body.talent_tier !== undefined) {
        if (!VALID_TALENT_TIERS.includes(body.talent_tier)) {
            return badReq(res, `talent_tier must be one of: ${VALID_TALENT_TIERS.join(', ')}`);
        }
        fields.push('talent_tier = ?');
        values.push(body.talent_tier);
    }

    if (fields.length === 0) {
        return badReq(res, 'Provide at least one field to update');
    }

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(charId);

    db.prepare(`UPDATE film_characters SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM film_characters WHERE id = ?').get(charId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(updated));
}

// --- Set Location Cost ---
function setLocationCost(req, res, locId) {
    const location = db.prepare('SELECT * FROM film_locations WHERE id = ?').get(locId);
    if (!location) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Location not found' }));
        return;
    }

    const body = req.body || {};
    const fields = [];
    const values = [];

    if (body.daily_rate !== undefined) {
        const rate = Number(body.daily_rate);
        if (isNaN(rate) || rate < 0) return badReq(res, 'daily_rate must be a non-negative number');
        fields.push('daily_rate = ?');
        values.push(rate);
    }

    if (body.prep_days !== undefined) {
        const days = parseInt(body.prep_days);
        if (isNaN(days) || days < 0) return badReq(res, 'prep_days must be a non-negative integer');
        fields.push('prep_days = ?');
        values.push(days);
    }

    if (body.shoot_days !== undefined) {
        const days = parseInt(body.shoot_days);
        if (isNaN(days) || days < 0) return badReq(res, 'shoot_days must be a non-negative integer');
        fields.push('shoot_days = ?');
        values.push(days);
    }

    if (body.permits_cost !== undefined) {
        const cost = Number(body.permits_cost);
        if (isNaN(cost) || cost < 0) return badReq(res, 'permits_cost must be a non-negative number');
        fields.push('permits_cost = ?');
        values.push(cost);
    }

    if (body.location_type !== undefined) {
        if (!VALID_LOCATION_TYPES.includes(body.location_type)) {
            return badReq(res, `location_type must be one of: ${VALID_LOCATION_TYPES.join(', ')}`);
        }
        fields.push('location_type = ?');
        values.push(body.location_type);
    }

    if (fields.length === 0) {
        return badReq(res, 'Provide at least one field to update');
    }

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(locId);

    db.prepare(`UPDATE film_locations SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM film_locations WHERE id = ?').get(locId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(updated));
}

// --- Analyze Project ---
function analyzeProjectEndpoint(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const analysis = analyzeProject(db, projectId);
    if (!analysis) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Analysis failed' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(analysis));
}

// --- Get or Generate Estimate ---
function getOrGenerateEstimate(req, res, projectId, query) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    // Check for existing estimate
    const existing = db.prepare(
        'SELECT * FROM film_budget_estimates WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(projectId);

    if (existing && query.refresh !== 'true') {
        // Return existing estimate with parsed JSON fields
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ...existing,
            line_items: JSON.parse(existing.line_items || '[]'),
            assumptions: JSON.parse(existing.assumptions || '[]'),
            missing_data: JSON.parse(existing.missing_data || '[]'),
            ai_estimated_fields: JSON.parse(existing.ai_estimated_fields || '[]'),
            web_searched_fields: JSON.parse(existing.web_searched_fields || '[]')
        }));
        return;
    }

    // Generate new estimate
    const template = query.template || 'indie';
    const estimate = generateEstimate(db, projectId, { template });

    if (!estimate) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Estimate generation failed' }));
        return;
    }

    // Save estimate to database
    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_budget_estimates (
            id, project_id, name, template, currency, total_estimated,
            above_the_line, below_the_line, production, post_production, other_costs,
            contingency_pct, line_items, assumptions, missing_data,
            shooting_days_estimate, complexity_score, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, projectId, 'Budget Estimate', template, 'USD', estimate.total_estimated,
        estimate.above_the_line, estimate.below_the_line, 0, estimate.post_production, estimate.other_costs,
        estimate.contingency_pct, JSON.stringify(estimate.line_items), JSON.stringify(estimate.assumptions),
        JSON.stringify(estimate.missing_data), estimate.stats.shooting_days_estimate, estimate.stats.complexity_score,
        now, now
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, ...estimate }));
}

// --- Create Estimate ---
function createEstimate(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const body = req.body || {};
    const template = body.template || 'custom';
    const name = body.name || 'Budget Estimate';

    const estimate = generateEstimate(db, projectId, {
        template,
        contingencyPct: body.contingency_pct || 10,
        includeEstimates: body.include_estimates !== false
    });

    if (!estimate) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Estimate generation failed' }));
        return;
    }

    const id = generateId();
    const now = new Date().toISOString();

    db.prepare(`
        INSERT INTO film_budget_estimates (
            id, project_id, name, template, currency, total_estimated,
            above_the_line, below_the_line, production, post_production, other_costs,
            contingency_pct, line_items, assumptions, missing_data,
            shooting_days_estimate, complexity_score, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, projectId, name, template, 'USD', estimate.total_estimated,
        estimate.above_the_line, estimate.below_the_line, 0, estimate.post_production, estimate.other_costs,
        estimate.contingency_pct, JSON.stringify(estimate.line_items), JSON.stringify(estimate.assumptions),
        JSON.stringify(estimate.missing_data), estimate.stats.shooting_days_estimate, estimate.stats.complexity_score,
        now, now
    );

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, ...estimate }));
}

// --- Get Specific Estimate ---
function getEstimate(req, res, projectId, estimateId) {
    const estimate = db.prepare(
        'SELECT * FROM film_budget_estimates WHERE id = ? AND project_id = ?'
    ).get(estimateId, projectId);

    if (!estimate) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Estimate not found' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        ...estimate,
        line_items: JSON.parse(estimate.line_items || '[]'),
        assumptions: JSON.parse(estimate.assumptions || '[]'),
        missing_data: JSON.parse(estimate.missing_data || '[]'),
        ai_estimated_fields: JSON.parse(estimate.ai_estimated_fields || '[]'),
        web_searched_fields: JSON.parse(estimate.web_searched_fields || '[]')
    }));
}

// --- Update Estimate ---
function updateEstimate(req, res, projectId, estimateId) {
    const estimate = db.prepare(
        'SELECT * FROM film_budget_estimates WHERE id = ? AND project_id = ?'
    ).get(estimateId, projectId);

    if (!estimate) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Estimate not found' }));
        return;
    }

    const body = req.body || {};
    const fields = [];
    const values = [];

    if (body.name !== undefined) {
        fields.push('name = ?');
        values.push(String(body.name).slice(0, 200));
    }

    if (body.template !== undefined) {
        fields.push('template = ?');
        values.push(body.template);
    }

    if (body.line_items !== undefined) {
        fields.push('line_items = ?');
        values.push(JSON.stringify(body.line_items));

        // Recalculate totals
        let aboveTheLine = 0, belowTheLine = 0, postProduction = 0, otherCosts = 0;
        for (const item of body.line_items) {
            const amount = item.amount || 0;
            if (item.category === 'above_the_line') aboveTheLine += amount;
            else if (item.category === 'below_the_line_production') belowTheLine += amount;
            else if (item.category === 'post_production') postProduction += amount;
            else otherCosts += amount;
        }
        fields.push('above_the_line = ?', 'below_the_line = ?', 'post_production = ?', 'other_costs = ?');
        values.push(aboveTheLine, belowTheLine, postProduction, otherCosts);
        fields.push('total_estimated = ?');
        values.push(aboveTheLine + belowTheLine + postProduction + otherCosts);
    }

    if (body.assumptions !== undefined) {
        fields.push('assumptions = ?');
        values.push(JSON.stringify(body.assumptions));
    }

    if (body.missing_data !== undefined) {
        fields.push('missing_data = ?');
        values.push(JSON.stringify(body.missing_data));
    }

    if (body.contingency_pct !== undefined) {
        fields.push('contingency_pct = ?');
        values.push(Number(body.contingency_pct) || 10);
    }

    if (fields.length === 0) {
        return badReq(res, 'Provide at least one field to update');
    }

    fields.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(estimateId);

    db.prepare(`UPDATE film_budget_estimates SET ${fields.join(', ')} WHERE id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM film_budget_estimates WHERE id = ?').get(estimateId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        ...updated,
        line_items: JSON.parse(updated.line_items || '[]'),
        assumptions: JSON.parse(updated.assumptions || '[]'),
        missing_data: JSON.parse(updated.missing_data || '[]'),
        ai_estimated_fields: JSON.parse(updated.ai_estimated_fields || '[]'),
        web_searched_fields: JSON.parse(updated.web_searched_fields || '[]')
    }));
}

// --- Delete Estimate ---
function deleteEstimate(req, res, projectId, estimateId) {
    const result = db.prepare(
        'DELETE FROM film_budget_estimates WHERE id = ? AND project_id = ?'
    ).run(estimateId, projectId);

    if (result.changes === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Estimate not found' }));
        return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
}

// --- Web Search Estimate ---
async function webSearchEstimate(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const body = req.body || {};
    if (!body.item) {
        return badReq(res, 'item is required (missing data item to search for)');
    }

    // Build search query
    const query = body.query || buildWebSearchQuery(body.item);

    // Return the suggested query - actual search will be done client-side or via separate service
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        query,
        item: body.item,
        instructions: 'Use this query to search the web for cost estimates. Results should be parsed and the value entered manually or via the update endpoint.',
        suggested_sources: [
            'SAG-AFTRA rate sheets',
            'AICP bid forms',
            'Production Weekly',
            'Backstage casting rates',
            'FilmLA permit information'
        ]
    }));
}

// --- AI Estimate ---
async function aiEstimate(req, res, projectId) {
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(projectId);
    if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
    }

    const body = req.body || {};
    const items = body.items || [];

    if (items.length === 0) {
        return badReq(res, 'items array is required (missing data items to estimate)');
    }

    // Get project analysis for context
    const analysis = analyzeProject(db, projectId);

    // Build AI request payload
    const payload = {
        type: 'budget_estimate',
        context: {
            project_title: project.title,
            genre: project.genre,
            runtime_estimate: analysis.stats.total_duration_ms / 60000,
            character_count: analysis.stats.character_count,
            location_count: analysis.stats.location_count,
            scene_count: analysis.stats.scene_count,
            shot_count: analysis.stats.shot_count,
            vfx_shot_count: analysis.stats.vfx_shot_count,
            complexity_score: analysis.stats.complexity_score,
            shooting_days_estimate: analysis.stats.shooting_days_estimate
        },
        items_to_estimate: items.map(item => ({
            field: item.field,
            entity_type: item.entity_type,
            entity_name: item.entity_name,
            additional_context: item.tier || item.location_type || item.context
        }))
    };

    // For now, return a placeholder response with suggested estimates based on tiers
    // In production, this would call Gridlight AI
    const estimates = items.map(item => {
        let suggestedValue = 0;
        let reasoning = '';

        if (item.entity_type === 'character') {
            const tier = item.tier || 'unknown';
            const rates = TALENT_TIER_RATES[tier] || TALENT_TIER_RATES.unknown;
            suggestedValue = Math.round((rates.min + rates.max) / 2);
            reasoning = `Based on ${rates.label} tier rates ($${rates.min.toLocaleString()}-$${rates.max.toLocaleString()} per ${rates.unit})`;
        } else if (item.entity_type === 'location') {
            const type = item.location_type || 'unknown';
            const rates = LOCATION_TYPE_RATES[type] || LOCATION_TYPE_RATES.unknown;
            suggestedValue = Math.round((rates.min + rates.max) / 2);
            reasoning = `Based on ${rates.label} rates ($${rates.min.toLocaleString()}-$${rates.max.toLocaleString()} per day)`;
        }

        return {
            field: item.field,
            entity_type: item.entity_type,
            entity_id: item.entity_id,
            entity_name: item.entity_name,
            value: suggestedValue,
            confidence: 'medium',
            reasoning,
            source: 'ai_estimate',
            estimated_at: new Date().toISOString()
        };
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        estimates,
        context_used: payload.context,
        note: 'These are AI-generated estimates based on industry averages. Actual costs may vary significantly.'
    }));
}

module.exports = { handleBudgetEstimate };
