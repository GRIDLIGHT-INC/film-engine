/**
 * Phase 1: flow CRUD + validation.
 *
 * GET    /film/projects/:id/flows   — flows visible to a project (its own + library)
 * POST   /film/projects/:id/flows   — create from { name, nodes, edges }
 * GET    /film/flows/:id            — one flow with its nodes and edges
 * PUT    /film/flows/:id            — replace the graph; bumps version
 * DELETE /film/flows/:id            — delete
 * POST   /film/flows/:id/validate   — validate without running
 *
 * Built-in flows are readable but never writable: the seeded shot pipeline is
 * what proves the graph engine reproduces PIPELINE_STEPS, and that guarantee
 * only holds while nothing can edit the row. The UI offers duplicate-to-edit.
 *
 * One handler export dispatched by parts[1], per ADR-002.
 */

const { db, generateId } = require('../db/database');
const { validateGraph, graphFingerprint } = require('../lib/flow-graph');
const { runFlow, runFlowStream, cancelFlowRun, getFlowRun } = require('../lib/flow-executor');
const { projectedCost, budgetStatus } = require('../lib/flow-cost');
const { listTemplates, instantiate } = require('../lib/flow-templates');
const { loadShotContext } = require('../lib/capability-payloads');
const { NODE_TYPES } = require('../lib/flow-node-types');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Built-in ids are readable slugs, not UUIDs, so flow ids accept both.
const FLOW_ID_RE = /^[\w-]{1,64}$/;

function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// ── Row <-> graph ───────────────────────────────────────────────────────

/**
 * Node ids are namespaced per flow on disk (`<flowId>:<nodeId>`) so two flows
 * can both contain a node called "video". The API speaks the short form, so the
 * canvas never has to know about the prefix.
 */
const qualify = (flowId, nodeId) => `${flowId}:${nodeId}`;
const unqualify = (flowId, rowId) => (rowId.startsWith(`${flowId}:`) ? rowId.slice(flowId.length + 1) : rowId);

function loadGraph(flowId) {
    const flow = db.prepare('SELECT * FROM film_flows WHERE id = ?').get(flowId);
    if (!flow) return null;

    const nodeRows = db.prepare('SELECT * FROM film_flow_nodes WHERE flow_id = ? ORDER BY created_at, id').all(flowId);
    const edgeRows = db.prepare('SELECT * FROM film_flow_edges WHERE flow_id = ? ORDER BY created_at, id').all(flowId);

    const nodes = nodeRows.map(r => {
        let config = {};
        try { config = JSON.parse(r.config || '{}'); } catch (_) { config = {}; }
        return {
            id: unqualify(flowId, r.id),
            type: r.node_type,
            label: r.label || '',
            config,
            x: r.position_x,
            y: r.position_y,
        };
    });

    const edges = edgeRows.map(r => ({
        id: unqualify(flowId, r.id),
        from: unqualify(flowId, r.from_node),
        fromPort: r.from_port,
        to: unqualify(flowId, r.to_node),
        toPort: r.to_port,
    }));

    return {
        id: flow.id,
        project_id: flow.project_id,
        owner: flow.owner || '',
        name: flow.name,
        description: flow.description || '',
        is_builtin: !!flow.is_builtin,
        version: flow.version,
        created_at: flow.created_at,
        updated_at: flow.updated_at,
        nodes,
        edges,
        fingerprint: graphFingerprint({ nodes, edges }),
    };
}

/** Replace a flow's topology. Caller validates first. */
function writeGraph(flowId, graph) {
    const write = db.transaction(() => {
        db.prepare('DELETE FROM film_flow_edges WHERE flow_id = ?').run(flowId);
        db.prepare('DELETE FROM film_flow_nodes WHERE flow_id = ?').run(flowId);

        const insertNode = db.prepare(
            `INSERT INTO film_flow_nodes (id, flow_id, node_type, label, config, position_x, position_y)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        for (const n of graph.nodes) {
            insertNode.run(
                qualify(flowId, n.id), flowId, n.type, n.label || '',
                JSON.stringify(n.config || {}),
                Number(n.x) || 0, Number(n.y) || 0
            );
        }

        const insertEdge = db.prepare(
            `INSERT INTO film_flow_edges (id, flow_id, from_node, from_port, to_node, to_port)
             VALUES (?, ?, ?, ?, ?, ?)`
        );
        for (const e of graph.edges) {
            insertEdge.run(
                qualify(flowId, e.id || `${e.from}.${e.fromPort}->${e.to}.${e.toPort}`),
                flowId,
                qualify(flowId, e.from), e.fromPort,
                qualify(flowId, e.to), e.toPort
            );
        }
    });
    write();
}

/** Pull { nodes, edges } out of a request body, tolerating absent arrays. */
function graphFromBody(body) {
    return {
        nodes: Array.isArray(body && body.nodes) ? body.nodes : [],
        edges: Array.isArray(body && body.edges) ? body.edges : [],
    };
}

// ── Handlers ────────────────────────────────────────────────────────────

function listFlows(req, res, projectId) {
    // A project sees its own flows plus every library flow (project_id IS NULL),
    // which is what makes "save it once, reuse it everywhere" true.
    const rows = db.prepare(
        `SELECT id, project_id, owner, name, description, is_builtin, version, created_at, updated_at
         FROM film_flows
         WHERE project_id = ? OR project_id IS NULL
         ORDER BY is_builtin DESC, updated_at DESC`
    ).all(projectId);

    const counts = db.prepare(
        'SELECT flow_id, COUNT(*) AS n FROM film_flow_nodes GROUP BY flow_id'
    ).all().reduce((acc, r) => { acc[r.flow_id] = r.n; return acc; }, {});

    return json(res, 200, {
        flows: rows.map(r => ({
            ...r,
            is_builtin: !!r.is_builtin,
            scope: r.project_id ? 'project' : 'library',
            node_count: counts[r.id] || 0,
        })),
    });
}

/** Create a flow from a built-in template. */
function createFromTemplate(req, res, projectId) {
    const body = req.body || {};
    const templateId = String(body.template_id || '');

    let graph;
    try {
        graph = instantiate(templateId, { projectId, sceneId: body.scene_id, shotId: body.shot_id });
    } catch (err) {
        return json(res, 400, { error: err.message });
    }

    const result = validateGraph(graph);
    if (!result.ok) return json(res, 500, { error: 'Template produced an invalid graph', errors: result.errors });

    const flowId = generateId();
    const meta = listTemplates().find(t => t.id === templateId) || { name: templateId, description: '' };
    db.prepare(
        `INSERT INTO film_flows (id, project_id, owner, name, description, is_builtin, version)
         VALUES (?, ?, '', ?, ?, 0, 1)`
    ).run(flowId, projectId, body.name || meta.name, meta.description);
    writeGraph(flowId, graph);

    return json(res, 201, loadGraph(flowId));
}

function createFlow(req, res, projectId) {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return json(res, 400, { error: 'name is required' });

    const graph = graphFromBody(body);
    const result = validateGraph(graph);
    if (!result.ok) return json(res, 400, { error: 'Invalid flow graph', errors: result.errors });

    const flowId = generateId();
    db.prepare(
        `INSERT INTO film_flows (id, project_id, owner, name, description, is_builtin, version)
         VALUES (?, ?, ?, ?, ?, 0, 1)`
    ).run(
        flowId,
        body.scope === 'library' ? null : projectId,
        String(body.owner || ''),
        name,
        String(body.description || '')
    );
    writeGraph(flowId, graph);

    return json(res, 201, loadGraph(flowId));
}

function getFlow(req, res, flowId) {
    const flow = loadGraph(flowId);
    if (!flow) return json(res, 404, { error: 'Flow not found' });
    return json(res, 200, flow);
}

function updateFlow(req, res, flowId) {
    const existing = db.prepare('SELECT * FROM film_flows WHERE id = ?').get(flowId);
    if (!existing) return json(res, 404, { error: 'Flow not found' });
    if (existing.is_builtin) {
        return json(res, 409, {
            error: 'Built-in flows cannot be edited. Duplicate it first.',
            hint: 'POST /film/projects/:id/flows with this flow\'s nodes and edges',
        });
    }

    const body = req.body || {};
    const graph = graphFromBody(body);
    const result = validateGraph(graph);
    if (!result.ok) return json(res, 400, { error: 'Invalid flow graph', errors: result.errors });

    db.prepare(
        `UPDATE film_flows SET name = ?, description = ?, version = version + 1, updated_at = datetime('now')
         WHERE id = ?`
    ).run(
        body.name !== undefined ? String(body.name) : existing.name,
        body.description !== undefined ? String(body.description) : existing.description,
        flowId
    );
    writeGraph(flowId, graph);

    return json(res, 200, loadGraph(flowId));
}

function deleteFlow(req, res, flowId) {
    const existing = db.prepare('SELECT * FROM film_flows WHERE id = ?').get(flowId);
    if (!existing) return json(res, 404, { error: 'Flow not found' });
    if (existing.is_builtin) return json(res, 409, { error: 'Built-in flows cannot be deleted' });

    db.prepare('DELETE FROM film_flows WHERE id = ?').run(flowId);
    return json(res, 200, { deleted: flowId });
}

/**
 * Validate a graph without saving it. Takes the body's graph when present so the
 * canvas can check work in progress, and falls back to the stored one.
 */
function validateFlow(req, res, flowId) {
    const body = req.body || {};
    let graph;

    if (Array.isArray(body.nodes) || Array.isArray(body.edges)) {
        graph = graphFromBody(body);
    } else {
        const stored = loadGraph(flowId);
        if (!stored) return json(res, 404, { error: 'Flow not found' });
        graph = { nodes: stored.nodes, edges: stored.edges };
    }

    const result = validateGraph(graph);
    return json(res, 200, {
        ok: result.ok,
        errors: result.errors,
        fingerprint: graphFingerprint(graph),
        node_count: graph.nodes.length,
        edge_count: graph.edges.length,
    });
}

/**
 * Execute a flow.
 *
 * Context comes from the shot when one is named, so a flow authored once runs
 * against any shot — the reusability the whole feature is for. Without a shot
 * it still runs; nodes needing shot data simply skip.
 */
/** Context for a run: shot if named, else project. Shared by both run paths. */
function runContext(body) {
    let ctx = {};
    if (body.shot_id) {
        ctx = loadShotContext(body.shot_id) || {};
        if (!ctx.shot) return { error: 'Shot not found' };
    } else if (body.project_id) {
        ctx.project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(body.project_id) || null;
        if (!ctx.project) return { error: 'Project not found' };
    }
    ctx.vars = body.vars || {};
    return { ctx };
}

/** SSE variant. A fan-out is minutes of work; a blocking response tells the user nothing until it is over. */
async function runFlowStreamRoute(req, res, flowId) {
    const stored = loadGraph(flowId);
    if (!stored) return json(res, 404, { error: 'Flow not found' });

    const body = req.body || {};
    const resolved = runContext(body);
    if (resolved.error) return json(res, 404, { error: resolved.error });

    return runFlowStream({ nodes: stored.nodes, edges: stored.edges }, resolved.ctx, {
        flowId, params: body, ignoreBudget: !!body.ignore_budget,
    }, res);
}

async function runFlowRoute(req, res, flowId) {
    const stored = loadGraph(flowId);
    if (!stored) return json(res, 404, { error: 'Flow not found' });

    const body = req.body || {};
    let ctx = {};

    if (body.shot_id) {
        ctx = loadShotContext(body.shot_id) || {};
        if (!ctx.shot) return json(res, 404, { error: 'Shot not found' });
    } else if (body.project_id) {
        ctx.project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(body.project_id) || null;
        if (!ctx.project) return json(res, 404, { error: 'Project not found' });
    }
    ctx.vars = body.vars || {};

    try {
        const run = await runFlow({ nodes: stored.nodes, edges: stored.edges }, ctx, {
            flowId,
            params: body,
            ignoreBudget: !!body.ignore_budget,
        });
        // A budget refusal is not a malformed request — 402 says "this would
        // cost more than you allowed" and the canvas can offer the override.
        const budgetRefused = (run.errors || []).some(e => e.code === 'BUDGET_EXCEEDED');
        return json(res, budgetRefused ? 402 : (run.status === 'failed' ? 422 : 200), run);
    } catch (err) {
        return json(res, 500, { error: err.message });
    }
}

function getRun(req, res, runId) {
    const run = getFlowRun(runId);
    if (!run) return json(res, 404, { error: 'Run not found' });

    let snapshot = {};
    try { snapshot = JSON.parse(run.graph_snapshot || '{}'); } catch (_) { snapshot = {}; }

    return json(res, 200, {
        ...run,
        graph_snapshot: snapshot,
        nodes: run.nodes.map(n => {
            let outputs = {};
            try { outputs = JSON.parse(n.outputs || '{}'); } catch (_) { outputs = {}; }
            return { ...n, outputs };
        }),
    });
}

/** Variants produced by a fan-out, for the canvas to show side by side. */
function getBranches(req, res, runId) {
    const run = db.prepare('SELECT id FROM film_flow_runs WHERE id = ?').get(runId);
    if (!run) return json(res, 404, { error: 'Run not found' });

    const branches = db.prepare(
        'SELECT * FROM film_flow_branches WHERE run_id = ? ORDER BY branch_key'
    ).all(runId);

    const nodeRuns = db.prepare('SELECT * FROM film_flow_node_runs WHERE run_id = ?').all(runId);

    return json(res, 200, {
        branches: branches.map(b => ({
            ...b,
            selected: !!b.selected,
            variant_config: (() => { try { return JSON.parse(b.variant_config || '{}'); } catch (_) { return {}; } })(),
            nodes: nodeRuns.filter(n => n.branch_id === b.id).map(n => ({ node_id: n.node_id, status: n.status })),
        })),
    });
}

/**
 * Resolve a paused select gate by choosing a branch.
 *
 * Records the choice; re-running the flow with the branch pinned is what
 * actually carries it downstream, so the decision is data rather than a
 * transient bit of executor state.
 */
function selectBranch(req, res, runId) {
    const body = req.body || {};
    const key = String(body.branch_key || '');
    if (!key) return json(res, 400, { error: 'branch_key is required' });

    const branch = db.prepare('SELECT * FROM film_flow_branches WHERE run_id = ? AND branch_key = ?').get(runId, key);
    if (!branch) return json(res, 404, { error: 'Branch not found for this run' });

    db.prepare('UPDATE film_flow_branches SET selected = 0 WHERE run_id = ?').run(runId);
    db.prepare('UPDATE film_flow_branches SET selected = 1 WHERE id = ?').run(branch.id);

    return json(res, 200, { run_id: runId, selected: key });
}

/** What a run would cost, and whether the budget allows it. Checked before running. */
function estimateFlow(req, res, flowId) {
    const stored = loadGraph(flowId);
    if (!stored) return json(res, 404, { error: 'Flow not found' });

    const projectId = (req.body && req.body.project_id) || stored.project_id || null;
    const cost = projectedCost({ nodes: stored.nodes, edges: stored.edges });
    const budget = projectId ? budgetStatus(db, projectId, cost.total) : { wouldExceed: false, limit: 0, spent: 0 };

    return json(res, 200, { ...cost, budget });
}

/**
 * FOG-001: applying this flow to a selection on the Production graph, planned
 * for free — what each shot binds, what it costs, the total and the budget
 * answer. `targets` is a comma-separated list of graph node keys.
 */
function applyPlanRoute(req, res, flowId, query) {
    const q = query || {};
    const raw = Array.isArray(q.targets) ? q.targets.join(',') : String(q.targets || '');
    const targets = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))];
    if (!targets.length) return json(res, 400, { error: 'targets is required: a comma-separated list of graph node keys (shot:<id>, seq:<id>)' });
    let vars = {};
    if (q.vars) { try { vars = JSON.parse(q.vars) || {}; } catch (_) { return json(res, 400, { error: 'vars must be JSON' }); } }
    const plan = require('../lib/flow-apply').planApply(db, { flowId, projectId: q.project_id || null, targets, vars });
    if (plan.error) return json(res, plan.status || 400, { error: plan.error });
    return json(res, 200, plan);
}

function cancelRun(req, res, runId) {
    const run = getFlowRun(runId);
    if (!run) return json(res, 404, { error: 'Run not found' });
    return json(res, 200, cancelFlowRun(runId));
}

// ── Router ──────────────────────────────────────────────────────────────

function handleFlows(req, res, urlParts, query) {
    // /film/projects/:id/flows
    if (urlParts[1] === 'projects' && urlParts[2] && urlParts[3] === 'flows') {
        const projectId = urlParts[2];
        if (!UUID_RE.test(projectId)) return json(res, 400, { error: 'Invalid project ID' });

        if (!urlParts[4] && req.method === 'GET') return listFlows(req, res, projectId);
        if (!urlParts[4] && req.method === 'POST') return createFlow(req, res, projectId);
        if (urlParts[4] === 'from-template' && req.method === 'POST') return createFromTemplate(req, res, projectId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/flow-templates — the ready-made shelf.
    if (urlParts[1] === 'flow-templates' && !urlParts[2] && req.method === 'GET') {
        return json(res, 200, { templates: listTemplates() });
    }

    // /film/flows/node-types — the palette the canvas draws from. Served from
    // the runtime registry so the UI can never offer a node the server refuses.
    if (urlParts[1] === 'flows' && urlParts[2] === 'node-types' && req.method === 'GET') {
        return json(res, 200, NODE_TYPES);
    }

    // /film/flows/:id[/validate|/run]
    if (urlParts[1] === 'flows' && urlParts[2]) {
        const flowId = urlParts[2];
        if (!FLOW_ID_RE.test(flowId)) return json(res, 400, { error: 'Invalid flow ID' });

        if (urlParts[3] === 'validate' && req.method === 'POST') return validateFlow(req, res, flowId);
        if (urlParts[3] === 'run' && req.method === 'POST') {
            // urlParts[4] matters: matching only on 'run' silently served the
            // blocking handler to clients asking for a stream.
            if (urlParts[4] === 'stream') return runFlowStreamRoute(req, res, flowId);
            return runFlowRoute(req, res, flowId);
        }
        if (urlParts[3] === 'estimate' && req.method === 'POST') return estimateFlow(req, res, flowId);
        if (urlParts[3] === 'apply-plan' && req.method === 'GET') return applyPlanRoute(req, res, flowId, query);
        if (!urlParts[3] && req.method === 'GET') return getFlow(req, res, flowId);
        if (!urlParts[3] && req.method === 'PUT') return updateFlow(req, res, flowId);
        if (!urlParts[3] && req.method === 'DELETE') return deleteFlow(req, res, flowId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    // /film/flow-runs/:id[/cancel]
    if (urlParts[1] === 'flow-runs' && urlParts[2]) {
        const runId = urlParts[2];
        if (!UUID_RE.test(runId)) return json(res, 400, { error: 'Invalid run ID' });

        if (!urlParts[3] && req.method === 'GET') return getRun(req, res, runId);
        if (urlParts[3] === 'cancel' && req.method === 'POST') return cancelRun(req, res, runId);
        if (urlParts[3] === 'branches' && req.method === 'GET') return getBranches(req, res, runId);
        if (urlParts[3] === 'select' && req.method === 'POST') return selectBranch(req, res, runId);
        return json(res, 405, { error: 'Method not allowed' });
    }

    return json(res, 404, { error: 'Not found' });
}

// runContext is exported for lib/mcp-tools.js: a node invoked over MCP must see
// the same context the same node sees inside a flow, and two copies of this
// loader would be two answers to "what does this shot look like".
module.exports = { handleFlows, loadGraph, writeGraph, runContext };
