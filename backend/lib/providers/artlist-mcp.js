/**
 * Artlist MCP provider adapter (AI Toolkit — generative image + video).
 *
 * Artlist exposes its 100+ AI models (Sora 2 Pro, Kling, Veo, Seedance, Imagen,
 * FLUX, Nano Banana, ...) through a remote MCP server at https://mcp.artlist.io/mcp.
 * Film Engine's backend connects to it as an MCP client over OAuth (the user
 * signs in once via the "Connect Artlist" button in Provider Settings — the same
 * browser sign-in they'd use for the Claude connector).
 *
 * This adapter:
 *   - declares a `connection` spec so Settings shows what users must do,
 *   - calls MCP tools/list (on connect) and tools/call (on generate) over
 *     Streamable-HTTP JSON-RPC using the stored OAuth access token,
 *   - normalizes tool results (image/video bytes or URL) into our {ok,data} shape.
 *
 * Tool NAMES/argument shapes are discovered at connect time (stored in
 * credentials.meta.tools) and can be overridden per capability via
 * meta.image_tool / meta.video_tool, since the live tool catalog is the source
 * of truth once connected.
 */

const { getCredential } = require('./credentials');

const DEFAULT_MCP_URL = 'https://mcp.artlist.io/mcp';

function mcpUrl() {
    const { meta } = getCredential('artlist-mcp');
    return (meta && meta.mcp_url) || process.env.ARTLIST_MCP_URL || DEFAULT_MCP_URL;
}

function supports(capability) {
    return capability === 'image' || capability === 'video';
}

/** One JSON-RPC call to the MCP server over Streamable-HTTP. */
async function mcpCall(method, params, { url, token, timeout } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout || 300000);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream',
                ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params || {} }),
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.status === 401) return { ok: false, status: 401, error: 'artlist-mcp: unauthorized (reconnect in Settings)' };
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { ok: false, status: res.status, error: `artlist-mcp ${res.status}: ${text.slice(0, 200)}` };
        }
        // Server may answer as JSON or as an SSE stream carrying one JSON-RPC message.
        const ctype = res.headers.get('content-type') || '';
        let msg;
        if (ctype.includes('text/event-stream')) {
            const body = await res.text();
            const line = body.split('\n').find(l => l.startsWith('data:'));
            msg = line ? JSON.parse(line.slice(5).trim()) : null;
        } else {
            msg = await res.json();
        }
        if (msg && msg.error) return { ok: false, status: 502, error: `artlist-mcp: ${msg.error.message || 'rpc error'}` };
        return { ok: true, result: msg && msg.result };
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') return { ok: false, status: 504, error: 'artlist-mcp: request timed out' };
        return { ok: false, status: 500, error: `artlist-mcp: ${err.message}` };
    }
}

/** List available tools (used by the connect flow to populate meta.tools). */
async function listTools(token) {
    const r = await mcpCall('tools/list', {}, { url: mcpUrl(), token });
    if (!r.ok) return r;
    return { ok: true, tools: (r.result && r.result.tools) || [] };
}

function pickTool(capability, meta) {
    if (capability === 'image' && meta && meta.image_tool) return meta.image_tool;
    if (capability === 'video' && meta && meta.video_tool) return meta.video_tool;
    // Heuristic over discovered tools.
    const tools = (meta && meta.tools) || [];
    const want = capability === 'video' ? /video|veo|kling|sora|seedance|ray/i : /image|imagen|flux|banana|photo|picture/i;
    const hit = tools.find(t => want.test(t.name || ''));
    return hit ? hit.name : (capability === 'video' ? 'generate_video' : 'generate_image');
}

/** Normalize an MCP tools/call result into { data: Buffer|{image_url} , meta }. */
async function normalizeToolResult(result) {
    const content = (result && result.content) || [];
    // image/video content blocks: { type:'image'|'resource', data?, url?, mimeType? }
    for (const block of content) {
        if (block.type === 'image' && block.data) {
            return { data: Buffer.from(block.data, 'base64'), contentType: block.mimeType || 'image/png' };
        }
        if ((block.type === 'resource' || block.type === 'resource_link') && (block.url || (block.resource && block.resource.uri))) {
            const url = block.url || block.resource.uri;
            try {
                const r = await fetch(url);
                if (r.ok) return { data: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') || '' };
            } catch (_) { /* fall through to url */ }
            return { data: { image_url: url }, contentType: '' };
        }
    }
    // Some servers return a URL in a text block or structured output.
    const text = content.find(b => b.type === 'text' && b.text);
    const url = text && (text.text.match(/https?:\/\/\S+\.(?:png|jpg|jpeg|webp|mp4|mov|webm)/i) || [])[0];
    if (url) return { data: { image_url: url }, contentType: '' };
    return null;
}

const adapter = {
    id: 'artlist-mcp',
    kind: 'mcp',
    label: 'Artlist (AI Toolkit / MCP)',
    requiresKey: false, // OAuth, not an API key
    capabilities: ['image', 'video'],

    connection: {
        instructions: 'Requires a paid Artlist plan with AI credits. Click "Connect Artlist" and sign in — no API key needed. If connect fails with "too many entities", Artlist has capped OAuth-client registration for your account (no self-serve cleanup is documented): either paste an existing OAuth client below to skip registration, or ask Artlist support to reset the dynamic client-registration limit.',
        oauth: { connectPath: '/providers/artlist-mcp/connect', mcpUrl: DEFAULT_MCP_URL },
        // Optional: reuse an existing Artlist OAuth client instead of dynamic
        // registration (avoids the per-tenant client-entity limit).
        fields: [
            { key: 'client_id', label: 'OAuth Client ID (optional — skips auto-registration)', type: 'text', required: false },
            { key: 'client_secret', label: 'OAuth Client Secret (optional)', type: 'password', required: false },
        ],
    },

    supports,
    listTools,

    async generate(capability, payload, opts) {
        if (!supports(capability)) {
            return { ok: false, status: 400, error: `artlist-mcp: unsupported capability '${capability}'` };
        }
        const { meta } = getCredential('artlist-mcp');
        const token = meta && meta.access_token;
        if (!token) {
            return { ok: false, status: 401, error: 'artlist-mcp: not connected. Connect Artlist in Provider Settings.' };
        }

        const toolName = pickTool(capability, meta);
        const args = {
            prompt: (payload && payload.prompt) || '',
            ...(payload && payload.model ? { model: payload.model } : {}),
            ...(payload && payload.width && payload.height ? { width: payload.width, height: payload.height } : {}),
        };
        const call = await mcpCall('tools/call', { name: toolName, arguments: args }, { url: mcpUrl(), token, timeout: opts && opts.timeout });
        if (!call.ok) return call;

        const norm = await normalizeToolResult(call.result);
        if (!norm) return { ok: false, status: 502, error: 'artlist-mcp: tool returned no image/video content' };

        return {
            ok: true,
            status: 200,
            data: norm.data,
            contentType: norm.contentType,
            provider: 'artlist-mcp',
            provider_model: toolName,
            provider_job_id: '',
            meta: { tool: toolName, format: capability === 'video' ? 'mp4' : 'png', license_source: 'generated' },
        };
    },
};

module.exports = { adapter, mcpCall, pickTool, normalizeToolResult, DEFAULT_MCP_URL };
