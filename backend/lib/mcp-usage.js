/**
 * The agent host is the model, so its traffic is the LLM meter.
 *
 * This pipeline does not call an LLM API. It is driven from Claude Desktop (and
 * soon ChatGPT Desktop) over MCP, which is the whole point of
 * `tests/mcp-no-server-llm.test.js`: a tool that hands reasoning back to a
 * server-side LLM asks the user to hold a second key for a question the
 * connected model has already read. Nothing is billed per call.
 *
 * But the traffic is real, and it draws down a subscription window. A director
 * who runs out of Claude capacity halfway through a breakdown is blocked just
 * as hard as one who runs out of Meshy credits — the resource is simply
 * denominated differently. So MCP tool calls are metered in TOKENS and priced
 * at ZERO, and the report shows consumption against the windows Anthropic
 * actually uses rather than against dollars.
 *
 * Two honesty constraints shape everything here.
 *
 * FIRST, the token counts are estimates and are flagged as such. This process
 * sees the JSON going out and the JSON coming back; it does not see the host's
 * system prompt, its conversation history, or its tokeniser. Four characters
 * per token is the standard approximation, and what we count is a FLOOR on
 * what the host actually processed — the payload, not the context it landed
 * in. Claiming these as measured would be a lie with a decimal point on it.
 *
 * SECOND, there is no published ceiling to gauge against. Anthropic publishes
 * plan MULTIPLIERS — Pro at 5x free, Max 5x at five times Pro, Max 20x at
 * twenty — plus a rolling five-hour session window and a weekly reset. It
 * publishes no token count for any plan, deliberately. So `allowance_tokens`
 * starts NULL and the gauge reports consumption with no percentage until the
 * user calibrates it from what they observe. A progress bar reading "62% of
 * your Max plan" against a number this file invented would be worse than no
 * bar at all, because it would be believed and planned around.
 */

const { recordUsage } = require('./usage-meter');

/** Agent hosts that can drive this server over MCP. */
const HOSTS = ['claude-desktop', 'chatgpt-desktop', 'claude-code', 'unknown-host'];

/**
 * What a client calls itself, mapped to a host we can report on.
 *
 * MCP clients announce a free-text name at `initialize` — "Claude Desktop",
 * "claude-ai", "ChatGPT", "Claude Code" — and there is no registry of them.
 * Matching HOSTS literally would send every real client to `unknown-host` and
 * collapse the by-host breakdown into one useless row, which looks exactly
 * like the feature working.
 *
 * Matched on a lowercased, punctuation-stripped form so "Claude Desktop",
 * "claude-desktop" and "claude_desktop" are one host. Order matters: the more
 * specific pattern must win, or "claude code" is swallowed by the "claude"
 * rule and every Claude Code session is reported as Desktop.
 */
const HOST_PATTERNS = [
    [/claudecode|claude-?code/, 'claude-code'],
    [/chatgpt|openai/,          'chatgpt-desktop'],
    [/claude/,                  'claude-desktop'],
];

/**
 * Resolve a reported client name to a known host.
 *
 * An unrecognised client is `unknown-host` rather than dropped: the tokens
 * were spent whoever asked for them, and a host we cannot name is still a host
 * whose traffic belongs in the window total.
 */
function resolveHost(reported) {
    const key = String(reported || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key) return 'unknown-host';
    for (const [pattern, host] of HOST_PATTERNS) {
        if (pattern.test(key)) return host;
    }
    return 'unknown-host';
}

/** Which model family a host bills against, for the report's labelling. */
const HOST_LABEL = {
    'claude-desktop': 'Claude Desktop (Claude subscription)',
    'chatgpt-desktop': 'ChatGPT Desktop (OpenAI subscription)',
    'claude-code': 'Claude Code (Claude subscription)',
    'unknown-host': 'MCP host',
};

/**
 * The only figure Anthropic actually publishes: capacity relative to Pro.
 *
 * Kept as ratios rather than token counts so that calibrating ONE plan
 * calibrates the rest. A user who measures their own Max 5x ceiling gets a
 * Pro-equivalent for free, and nothing here pretends to know an absolute.
 */
const PLAN_MULTIPLIERS = { free: 1, pro: 5, max_5x: 25, max_20x: 100 };

/** Windows the limits are actually enforced over. */
const WINDOWS = {
    session: { hours: 5, label: 'rolling 5-hour session' },
    week: { hours: 168, label: 'weekly' },
};

/** ~4 characters per token. An approximation, always flagged as one. */
const CHARS_PER_TOKEN = 4;

function tokensFor(chars) {
    return Math.ceil(Math.max(0, Number(chars) || 0) / CHARS_PER_TOKEN);
}

/**
 * Record one MCP tool call as subscription-billed LLM traffic.
 *
 * Never throws: this runs after a tool has already done its work, and a
 * bookkeeping failure must not turn a completed call into an error the model
 * reads as a failure and retries.
 */
function recordHostUsage({ host, tool, projectId, shotId, sceneId, inboundChars, outboundChars, durationMs }) {
    try {
        const input = tokensFor(inboundChars);
        const output = tokensFor(outboundChars);
        if (input + output === 0) return null;

        return recordUsage({
            projectId: projectId || null,
            shotId: shotId || null,
            sceneId: sceneId || null,
            provider: 'anthropic',          // priced subscription:true, so $0
            capability: 'llm',
            model: resolveHost(host),
            unit: 'token',
            quantity: input + output,
            parts: { input, output, tool: tool || '', host: resolveHost(host), reported_as: String(host || '') },
            estimated: true,
            estimate_basis: `MCP tool payload measured at ~${CHARS_PER_TOKEN} characters per token; excludes the host's own prompt and history, so this is a floor`,
            latencyMs: durationMs || 0,
        });
    } catch (err) {
        console.error('[mcp-usage] failed to record host usage:', err.message);
        return null;
    }
}

/**
 * Subscription consumption, per window.
 *
 * Global rather than per project: the subscription is the person's, and one
 * pool is shared across every film they are working on — reporting it per
 * project would let two projects each show comfortable headroom while the
 * account is out of capacity. Pass a projectId to see one film's share of it.
 */
function subscriptionUsage(projectId) {
    const { db } = require('../db/database');

    const allowance = readAllowance();
    const out = { windows: {}, allowance_tokens: allowance.tokens, plan: allowance.plan };

    for (const [key, win] of Object.entries(WINDOWS)) {
        const since = new Date(Date.now() - win.hours * 3600 * 1000).toISOString();
        const params = [since];
        let where = "capability = 'llm' AND created_at >= ?";
        if (projectId) { where += ' AND project_id = ?'; params.push(projectId); }

        const row = db.prepare(`
            SELECT COALESCE(SUM(quantity), 0) AS tokens, COUNT(*) AS calls
            FROM film_usage_events WHERE ${where}
        `).get(...params);

        out.windows[key] = {
            hours: win.hours,
            label: win.label,
            tokens: Math.round(row.tokens),
            calls: row.calls,
            resets_at: new Date(Date.now() + win.hours * 3600 * 1000).toISOString(),
            // NULL, not zero, when nothing was calibrated. Zero would render as
            // an empty bar, which reads as "plenty of room left".
            pct: allowance.tokens > 0
                ? Math.round((row.tokens / allowance.tokens) * 1000) / 10
                : null,
        };
    }

    const byHost = db.prepare(`
        SELECT model AS host, COALESCE(SUM(quantity), 0) AS tokens, COUNT(*) AS calls
        FROM film_usage_events WHERE capability = 'llm' ${projectId ? 'AND project_id = ?' : ''}
        GROUP BY model ORDER BY tokens DESC
    `).all(...(projectId ? [projectId] : []));

    out.by_host = byHost.map(h => ({ ...h, label: HOST_LABEL[h.host] || h.host, tokens: Math.round(h.tokens) }));
    out.by_tool = topTools(db, projectId);
    out.plan_multipliers = PLAN_MULTIPLIERS;
    out.note = 'Anthropic publishes no token count for any plan — only capacity multipliers (Max 5x and 20x of Pro) and two windows: a rolling 5-hour session and a weekly reset. Consumption below is measured; the ceiling is whatever you calibrate it to. Counts are a floor: they cover the MCP payloads this server sent and received, not the host\'s own prompt and history.';
    return out;
}

/** Which tools move the most tokens — where the subscription actually goes. */
function topTools(db, projectId) {
    const rows = db.prepare(`
        SELECT parts, quantity FROM film_usage_events
        WHERE capability = 'llm' ${projectId ? 'AND project_id = ?' : ''}
    `).all(...(projectId ? [projectId] : []));

    const totals = new Map();
    for (const r of rows) {
        let tool = '';
        try { tool = (JSON.parse(r.parts || '{}') || {}).tool || ''; } catch (_) { /* ignore */ }
        if (!tool) continue;
        const cur = totals.get(tool) || { tool, tokens: 0, calls: 0 };
        cur.tokens += Number(r.quantity) || 0;
        cur.calls += 1;
        totals.set(tool, cur);
    }
    return [...totals.values()]
        .map(t => ({ ...t, tokens: Math.round(t.tokens) }))
        .sort((a, b) => b.tokens - a.tokens).slice(0, 15);
}

/** The user's own calibration, from app settings. Absent means uncalibrated. */
function readAllowance() {
    try {
        const { db } = require('../db/database');
        const rows = {};
        for (const r of db.prepare('SELECT key, value FROM film_app_settings').all()) rows[r.key] = r.value;

        const plan = rows.subscription_plan || null;
        const explicit = Number(rows.subscription_session_tokens) || 0;
        if (explicit > 0) return { tokens: explicit, plan };

        // A Pro-equivalent baseline scales to any plan through the published
        // multipliers, so one measurement calibrates all of them.
        const proBaseline = Number(rows.subscription_pro_baseline_tokens) || 0;
        if (proBaseline > 0 && plan && PLAN_MULTIPLIERS[plan]) {
            return { tokens: Math.round(proBaseline * (PLAN_MULTIPLIERS[plan] / PLAN_MULTIPLIERS.pro)), plan };
        }
        return { tokens: null, plan };
    } catch (_) {
        return { tokens: null, plan: null };
    }
}

module.exports = {    HOSTS,
    recordHostUsage, subscriptionUsage, tokensFor, resolveHost,};
