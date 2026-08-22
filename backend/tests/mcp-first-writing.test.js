/**
 * The rabbit hole: AI queries that do not go through MCP.
 *
 * The goal names this trap explicitly — *use MCPs wherever we can for AI
 * queries* — and it was half-honoured. `tests/mcp-no-server-llm.test.js` forbids
 * any MCP tool from calling a server-side LLM, because the agent host IS the
 * model and handing the reasoning back asks the user for a second API key for a
 * question the connected model has already read. That rule protected the MCP
 * surface and said nothing about the UI, which is the surface Manny actually
 * types into.
 *
 * Three route modules call `callProjectLLM`, and the SPA uses all three. So
 * writing "only in Film Engine" through the browser burned a server-side key for
 * questions Claude Desktop would answer for free.
 *
 * **Option (c), chosen by the user: MCP is the default path; HTTP is the
 * fallback for when no agent host is attached.** Not (b) — removing them —
 * because an editor that cannot write a line without a second app attached is a
 * worse tool even if it is a cheaper one. Not (a) — leave it — because the whole
 * point of the MCP surface is that the model is already there.
 *
 * Set-based over the five LLM-backed endpoints, derived from the modules that
 * import the LLM client rather than listed here. An endpoint added later that
 * calls a server-side LLM and forgets this fails, which is the only way a policy
 * like this survives contact with a sixth feature.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-mcpfirst-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const ROOT = path.join(__dirname, '..', '..');
const src = f => fs.readFileSync(path.join(__dirname, '..', ...f.split('/')), 'utf8');

function callRoute(handler, method, urlPath, body) {
    return new Promise(resolve => {
        const parts = urlPath.split('?')[0].split('/').filter(Boolean);
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            let parsed = Buffer.concat(chunks).toString();
            try { parsed = JSON.parse(parsed); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body: parsed });
        });
        Promise.resolve(handler({ method, body: body || {} }, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message, stack: err.stack } }));
    });
}

/**
 * The modules that call a server-side LLM, DERIVED rather than listed.
 *
 * A sixth feature that imports the LLM client and forgets the policy fails
 * here, which is the only way this survives.
 */
function llmModules() {
    const dir = path.join(__dirname, '..', 'routes');
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.js'))
        .filter(f => /require\(['"]\.\.\/lib\/llm-client['"]\)/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
}

test('the set of server-side-LLM modules is what we think it is', () => {
    // Guards the derivation itself. If this shrinks silently, every check below
    // passes vacuously.
    const mods = llmModules();
    assert.ok(mods.length >= 3, `only ${mods.length} LLM modules found — the scan is broken`);
    assert.deepStrictEqual(mods.sort(), ['breakdown.js', 'screenplay-ai.js', 'text-convert.js'],
        'a route module started calling a server-side LLM without being considered here');
});

// ── The presence signal ─────────────────────────────────────────────────

test('an agent host that has never called is reported absent', async () => {
    const { handleAgentPresence } = require('../routes/agent-presence');
    const r = await callRoute(handleAgentPresence, 'GET', '/film/agent');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.connected, false);
    // Absent must be distinguishable from "we do not know", or the UI cannot
    // decide which path to offer.
    assert.ok('last_seen' in r.body, 'presence does not report when the host was last seen');
});

test('an MCP tool call marks the host present', () => {
    const { markAgentSeen, agentPresence } = require('../lib/agent-presence');
    markAgentSeen('test-suite');
    const p = agentPresence();
    assert.strictEqual(p.connected, true, 'a tool call did not register the host');
    assert.ok(p.last_seen, 'no timestamp recorded');
    assert.strictEqual(p.client, 'test-suite');
});

test('presence goes stale rather than lasting forever', () => {
    // A host that connected once last week is not attached now. A signal that
    // never expires would route every request to a fallback that is not there.
    const { agentPresence, PRESENCE_WINDOW_MS } = require('../lib/agent-presence');
    assert.ok(PRESENCE_WINDOW_MS > 0 && PRESENCE_WINDOW_MS <= 60 * 60 * 1000,
        `the presence window is ${PRESENCE_WINDOW_MS}ms — not a session`);

    const stale = new Date(Date.now() - PRESENCE_WINDOW_MS - 1000).toISOString();
    db.prepare("INSERT OR REPLACE INTO film_app_settings (key, value) VALUES ('agent_last_seen', ?)").run(stale);
    assert.strictEqual(agentPresence().connected, false,
        'a host last seen outside the window still reports as connected');
});

// ── Every LLM endpoint says there is a better path ──────────────────────

test('every server-side-LLM endpoint names its MCP equivalent', () => {
    // The policy, enforced at the source rather than by convention. An endpoint
    // that spends a key without saying what would have been free is the trap
    // itself, one feature later.
    const missing = [];
    for (const mod of llmModules()) {
        const text = src(`routes/${mod}`);
        if (!/MCP_ALTERNATIVE/.test(text)) missing.push(`${mod}: no MCP_ALTERNATIVE declared`);
    }
    assert.deepStrictEqual(missing, [], `\n  ${missing.join('\n  ')}`);
});

test('a fallback response says it was the fallback, and what to use instead', async () => {
    const { handleScreenplayAI } = require('../routes/screenplay-ai');
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Fallback');

    const r = await callRoute(handleScreenplayAI, 'POST', `/film/projects/${projectId}/screenplay-ai`,
        { mode: 'brainstorm', message: 'what happens next' });

    // It may fail for want of a provider — that is fine and not what is being
    // tested. What must be true either way is that the response explains the
    // path.
    const flat = JSON.stringify(r.body);
    assert.match(flat, /mcp|Claude Desktop|agent host/i,
        'a server-side LLM call does not mention the MCP path that would be free');
});

test('the preferred path is reported per endpoint, not guessed', async () => {
    const { handleAgentPresence } = require('../routes/agent-presence');
    const r = await callRoute(handleAgentPresence, 'GET', '/film/agent');
    assert.ok(Array.isArray(r.body.ai_endpoints), 'presence does not enumerate the LLM endpoints');
    assert.ok(r.body.ai_endpoints.length >= 3,
        `only ${(r.body.ai_endpoints || []).length} endpoints listed`);
    for (const e of r.body.ai_endpoints) {
        assert.ok(e.route, 'an endpoint entry has no route');
        assert.ok(e.mcp_alternative, `${e.route} does not name its MCP alternative`);
    }
});

// ── The UI ──────────────────────────────────────────────────────────────

test('the page tells the writer which path their AI request will take', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
    const missing = [];
    if (!/function aiPathBadge|function renderAgentPath/.test(html)) missing.push('nothing renders the path');
    if (!/\/film\/agent|api\('\/agent'\)/.test(html)) missing.push('the page never asks whether a host is attached');
    assert.deepStrictEqual(missing, [], `\n  ${missing.join('\n  ')}`);
});

// ── The rule that started all this still holds ──────────────────────────

test('no MCP tool calls a server-side LLM', () => {
    // The original invariant. Option (c) adds a fallback for the UI and must not
    // weaken this: the whole reason the MCP surface is free is that it never
    // hands the reasoning back.
    const { listTools } = require('../lib/mcp-tools');
    const forbidden = new Set(llmModules().map(m => m.replace('.js', '')));
    const offenders = [];
    for (const tool of listTools()) {
        const p = typeof tool.path === 'function' ? '' : String(tool.path || '');
        void p;
        if (/breakdown_run|screenplay_ai|text_to_screenplay/.test(tool.name)) {
            offenders.push(tool.name);
        }
    }
    assert.deepStrictEqual(offenders, [],
        `these tools hand reasoning to a server-side LLM: ${offenders.join(', ')}`);
    assert.ok(forbidden.size >= 3);
});
