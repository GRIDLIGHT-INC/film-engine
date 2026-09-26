/**
 * Budget & cost tracking
 * GET    /film/projects/:id/budget          — budget summary
 * POST   /film/projects/:id/budget          — create cost entry
 * GET    /film/projects/:id/budget/ledger   — paginated cost entries
 * GET    /film/projects/:id/budget/forecast  — spend forecast
 * PUT    /film/projects/:id/budget/limit    — set budget limit
 * DELETE /film/budget/:id                   — delete cost entry
 * GET    /film/projects/:id/spend           — AI spend: units, money, per minute
 * GET    /film/projects/:id/spend/usage     — the raw usage-event ledger
 * POST   /film/projects/:id/spend/backfill  — reconstruct spend from existing assets
 * GET    /film/spend/rates                  — the published rate book
 * PUT    /film/spend/rates                  — correct a rate for this install
 */
const { compareGenerators, COMPARABLE } = require('../lib/generator-costs');
const { db, generateId } = require('../db/database');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cost types the ledger accepts.
 *
 * The first nine are the original list. The rest were added when metering
 * started writing entries automatically: sfx, ambient, lip-sync, post and 3D
 * were all being filed under 'other' or 'music_generation', which made the
 * breakdown chart claim a scene's sound design was score. Derived here rather
 * than in usage-meter.js so the manual POST and the automatic writer cannot
 * disagree about what a valid type is.
 */
const VALID_COST_TYPES = [
    'render_gpu', 'model_inference', 'voice_tts', 'music_generation',
    'image_generation', 'video_generation', 'storage', 'license', 'other',
    'sfx_generation', 'ambient_generation', 'lipsync_generation',
    'post_production', 'model3d_generation'
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

    // /film/projects/:id/spend[/usage|/backfill]
    if (urlParts[1] === 'projects' && urlParts[3] === 'spend') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return badReq(res, 'Invalid project ID');
        const sub = urlParts[4];
        if (!sub && req.method === 'GET') return spendReport(req, res, projectId, query);
        if (sub === 'usage' && req.method === 'GET') return usageLedger(req, res, projectId, query);
        if (sub === 'backfill' && req.method === 'POST') return runBackfill(req, res, projectId);
        if (sub === 'record' && req.method === 'POST') return recordKnownSpend(req, res, projectId);
    }

    // /film/spend/subscription — MCP host traffic against the plan windows.
    if (urlParts[1] === 'spend' && urlParts[2] === 'subscription' && req.method === 'GET') {
        return subscriptionReport(req, res, query);
    }

    // /film/spend/compare — every generator that can serve a capability,
    // priced against one unit of real work so the numbers are comparable.
    if (urlParts[1] === 'spend' && urlParts[2] === 'compare' && req.method === 'GET') {
        return compareReport(req, res, query);
    }

    // /film/spend/rates — the rate book, and per-install corrections to it.
    if (urlParts[1] === 'spend' && urlParts[2] === 'rates') {
        if (req.method === 'GET') return listRateBook(req, res);
        if (req.method === 'PUT') return setRate(req, res);
        if (req.method === 'DELETE') return clearRate(req, res, query);
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


// --- AI spend ------------------------------------------------------------
//
// The estimation tab next door prices a live-action shoot: day rates, catering,
// grip, a 10% contingency. None of that is what this pipeline spends. These
// endpoints report what it DOES spend — tokens at Anthropic, credits at Meshy
// and Runway, characters and seconds at ElevenLabs — measured at the moment of
// each call rather than estimated up front.

function spendReport(req, res, projectId, query) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return notFound(res, 'Project not found');

    const { projectSpend } = require('../lib/usage-meter');
    const spend = projectSpend(projectId);

    // What has NOT been counted, said out loud. A spend report whose silence
    // could mean either "nothing was generated" or "nothing was tracked" is
    // worse than no report, because only one of those needs acting on.
    const untracked = db.prepare(`
        SELECT COUNT(*) AS n FROM film_assets
        WHERE project_id = ? AND asset_type NOT IN ('subtitle','export_package','fcpxml','edl','premiere_xml','lut','other')
          AND id NOT IN (SELECT REPLACE(source_ref,'asset:','') FROM film_usage_events WHERE source_ref IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM film_usage_events u WHERE u.project_id = film_assets.project_id AND u.source_ref IS NULL)
    `).get(projectId);

    /*
     * THE SUBSCRIPTION, ATTRIBUTED — never added.
     *
     * The LLM runs on a Claude subscription through the MCP host, so its
     * marginal cost is zero and the ledger correctly charges the project
     * nothing. But the fee is real money, and an agency billing a client for a
     * spot has to put a number against the reasoning that went into it.
     *
     * So it is reported as a SHARE of a fixed fee, measured from tokens this
     * install actually metered in the same period — never summed into
     * `measured_usd`, because a sunk monthly fee is not a variable cost of a
     * shot and adding it would make cost-per-shot wrong in both directions.
     */
    let subscription = null;
    try {
        const { subscriptionAttribution } = require('../lib/provider-pricing');
        const { readSettings } = require('./app-settings');
        const plan = String((readSettings() || {}).llm_subscription_plan || 'none');
        if (plan && plan !== 'none') {
            // The same calendar month the fee covers, across EVERY project:
            // attributing against this project's own tokens alone would hand it
            // the whole fee no matter how little of the month it used.
            const since = new Date(); since.setUTCDate(1); since.setUTCHours(0, 0, 0, 0);
            const iso = since.toISOString();
            const tok = q => db.prepare(
                `SELECT COALESCE(SUM(quantity), 0) AS n FROM film_usage_events
                  WHERE capability = 'llm' AND unit = 'token' AND created_at >= ?${q}`);
            const period = tok('').get(iso).n;
            const mine = tok(' AND project_id = ?').get(iso, projectId).n;
            subscription = subscriptionAttribution({
                plan, project_tokens: mine, period_tokens: period,
            });
            if (subscription) subscription.period_start = iso;
        }
    } catch (_) { /* an attribution that cannot be computed must not fail the report */ }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        ...spend,
        ...(subscription ? { subscription } : {}),
        untracked_assets: untracked.n,
        backfill_available: untracked.n > 0,
        note: spend.estimated_usd > 0
            ? 'Includes reconstructed history. Reconstructed spend is a floor — failed generations cost money and left no asset to count.'
            : 'Measured from live provider calls.',
    }));
}

function usageLedger(req, res, projectId, query) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(query.limit) || 100));

    const where = ['u.project_id = ?'];
    const params = [projectId];
    if (query.capability) { where.push('u.capability = ?'); params.push(query.capability); }
    if (query.provider) { where.push('u.provider = ?'); params.push(query.provider); }

    const clause = where.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) AS n FROM film_usage_events u WHERE ${clause}`).get(...params);
    const rows = db.prepare(`
        SELECT u.*, sh.shot_code FROM film_usage_events u
        LEFT JOIN film_shots sh ON sh.id = u.shot_id
        WHERE ${clause} ORDER BY u.created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, (page - 1) * limit);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        events: rows.map(r => ({ ...r, parts: safeJson(r.parts) })),
        count: rows.length, total: total.n, page, limit,
        pages: Math.ceil(total.n / limit),
    }));
}

/**
 * A charge the provider made that this engine did not observe.
 *
 * Everything else in this file is measured at the moment of a call. That misses
 * a whole class of real money, and the class is not rare:
 *
 *   - A generation that was accepted, RENDERED and billed, then lost on this
 *     side. One clip on this install cost $1.70 and was reported as a failure,
 *     so the meter — which correctly declines to bill refusals — recorded
 *     nothing for a charge that had already happened.
 *   - Anything bought before the metering path covered it. Collected
 *     generations were unmetered until the handle started carrying its price.
 *   - A charge made outside the engine entirely: a console retry, a plan
 *     upgrade, a support credit going the other way.
 *
 * The alternative to a way in is a director doing arithmetic in a spreadsheet
 * beside the report, which is how the report stops being read at all.
 *
 * ALWAYS FLAGGED. It writes `estimated = 1` and a source_ref of `manual:`, so a
 * hand-entered figure can never be mistaken for one the engine watched happen —
 * the report already separates `measured_usd` from `estimated_usd`, and this
 * lands honestly on the second.
 */
function recordKnownSpend(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return notFound(res, 'Project not found');

    const b = req.body || {};
    const provider = String(b.provider || '').trim();
    const capability = String(b.capability || '').trim();
    if (!provider || !capability) {
        return badReq(res, 'provider and capability are required — a charge with no provider '
            + 'cannot be reconciled against an invoice, which is the only reason to record it');
    }
    const quantity = Number(b.quantity);
    if (!(quantity > 0)) return badReq(res, 'quantity must be greater than zero');

    try {
        const { recordUsage } = require('../lib/usage-meter');
        recordUsage({
            provider, capability,
            model: String(b.model || ''),
            unit: String(b.unit || 'call'),
            quantity,
            projectId,
            shotId: b.shot_id || null,
            sceneId: b.scene_id || null,
            /*
             * Priced from the rate book like anything else unless a figure is
             * given. An explicit `usd` wins, because a provider's own invoice
             * beats our reconstruction of it — that is the whole point of
             * `native_charged` elsewhere in this pipeline.
             */
            ...(Number(b.usd) > 0 ? { native_charged: Number(b.usd), provider_confirmed: true } : {}),
            estimated: !(Number(b.usd) > 0),
            estimate_basis: String(b.note || 'recorded by hand'),
            source_ref: `manual:${String(b.reference || b.note || 'entry').slice(0, 80)}`,
        });
    } catch (err) {
        return badReq(res, `could not record it: ${err.message}`);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
        project_id: projectId, recorded: true,
        provider, capability, quantity, unit: String(b.unit || 'call'),
        usd: Number(b.usd) > 0 ? Number(b.usd) : null,
        note: 'Recorded and flagged as hand-entered. It appears in spend_report and, unless an '
            + 'exact figure was supplied, counts toward estimated rather than measured spend.',
    }));
}

function runBackfill(req, res, projectId) {
    const project = db.prepare('SELECT id FROM film_projects WHERE id = ?').get(projectId);
    if (!project) return notFound(res, 'Project not found');

    const { backfillProject } = require('../lib/spend-backfill');
    const dryRun = !!(req.body && req.body.dry_run);
    const result = backfillProject(projectId, { dryRun });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...result, dry_run: dryRun }));
}

/**
 * What the agent host has consumed, against the windows the plan is enforced in.
 *
 * Global by default: the subscription is the person's and one pool is shared
 * across every film, so reporting it per project would let two projects each
 * show comfortable headroom while the account is out of capacity. Pass
 * project_id to see one film's share.
 */
function subscriptionReport(req, res, query) {
    const { subscriptionUsage } = require('../lib/mcp-usage');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(subscriptionUsage(query.project_id || null)));
}

function listRateBook(req, res) {
    const { listRates } = require('../lib/provider-pricing');
    const { rateOverrides } = require('../lib/usage-meter');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        rates: listRates(rateOverrides()),
        note: 'Rates are researched published defaults with the source and check date attached. Correcting one here overrides it for this install only; the default stays underneath, so a bad correction can be deleted rather than reconstructed.',
    }));
}

function setRate(req, res) {
    const body = req.body || {};
    if (!body.provider || !body.capability) return badReq(res, 'provider and capability are required');

    const perUnit = body.native_per_unit === undefined || body.native_per_unit === null
        ? null : Number(body.native_per_unit);
    const usd = body.usd_per_native === undefined || body.usd_per_native === null
        ? null : Number(body.usd_per_native);
    if (perUnit === null && usd === null) return badReq(res, 'Provide native_per_unit and/or usd_per_native');
    if ((perUnit !== null && !(perUnit >= 0)) || (usd !== null && !(usd >= 0))) {
        return badReq(res, 'rates must be non-negative numbers');
    }

    const { rateFor } = require('../lib/provider-pricing');
    if (!rateFor(body.provider, body.capability)) {
        return badReq(res, `no such rate: ${body.provider}:${body.capability}`);
    }

    const id = generateId();
    db.prepare(`
        INSERT INTO film_provider_rates (id, provider, capability, model, native_per_unit, usd_per_native, note, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, capability, COALESCE(model, '')) DO UPDATE SET
            native_per_unit = excluded.native_per_unit,
            usd_per_native  = excluded.usd_per_native,
            note            = excluded.note,
            updated_at      = excluded.updated_at
    `).run(id, body.provider, body.capability, body.model || null, perUnit, usd,
           String(body.note || '').slice(0, 500), new Date().toISOString());

    require('../lib/usage-meter').invalidateRateCache();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        ok: true,
        rate: rateFor(body.provider, body.capability, body.model, require('../lib/usage-meter').rateOverrides()),
        // Rates change; what was consumed does not. Past events keep the rate
        // that priced them, so a correction cannot silently rewrite history.
        applies_to: 'calls made from now on — existing usage events keep the rate they were priced at',
    }));
}

function clearRate(req, res, query) {
    if (!query.provider || !query.capability) return badReq(res, 'provider and capability are required');
    const result = db.prepare(
        "DELETE FROM film_provider_rates WHERE provider = ? AND capability = ? AND COALESCE(model,'') = ?"
    ).run(query.provider, query.capability, query.model || '');
    require('../lib/usage-meter').invalidateRateCache();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cleared: result.changes, reverted_to: 'the researched published default' }));
}

function safeJson(raw) {
    try { return JSON.parse(raw || '{}'); } catch (_) { return {}; }
}

function notFound(res, msg) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg }));
}


/**
 * GET /film/spend/compare?capability=image|video[&project_id=&clip_seconds=]
 *
 * Free. Reads two registries and spends nothing — the point is to decide
 * BEFORE generating, which is exactly when a price is useful.
 *
 * `project_id` is optional and only supplies the delivery frame, because the
 * per-megapixel providers cannot be priced without one. Passing a project
 * therefore prices the comparison for THAT film's frame rather than for a
 * default nobody chose.
 */
function compareReport(req, res, query) {
    const capability = String(query.capability || 'image');
    if (!COMPARABLE.includes(capability)) {
        return badReq(res, `capability must be one of: ${COMPARABLE.join(', ')}`);
    }

    const opts = {};

    const seconds = Number(query.clip_seconds);
    if (Number.isFinite(seconds) && seconds > 0) opts.clip_seconds = seconds;

    if (query.project_id) {
        if (!UUID_RE.test(query.project_id)) return badReq(res, 'Invalid project ID');
        const project = db.prepare(
            'SELECT target_resolution, aspect_ratio FROM film_projects WHERE id = ?'
        ).get(query.project_id);
        if (!project) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Project not found' }));
        }
        const m = /^(\d+)\s*[xX*]\s*(\d+)$/.exec(String(project.target_resolution || ''));
        // An unparseable or absent resolution falls back rather than guessing:
        // a made-up frame would silently reprice every megapixel row.
        if (m) opts.frame = { width: Number(m[1]), height: Number(m[2]) };
    }

    let report;
    try {
        report = compareGenerators(capability, opts);
    } catch (err) {
        return badReq(res, err.message);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(report));
}

module.exports = { handleBudget, VALID_COST_TYPES };
