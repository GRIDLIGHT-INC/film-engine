/**
 * THE PLUGIN HOST, from Film Engine's side.
 *
 * The director owns 248 sample libraries and wants to score inside Film Engine:
 * Claude writes the notes, a library patch plays them, and the result is a take
 * on that track. Node cannot host a VST3/AU plugin, so `backend/instrument-sidecar.py`
 * does, and this is the client: the configuration, the typed operations, and the
 * refusals — never a raw call into somebody's plugin.
 *
 * The sidecar is a SEPARATE PROCESS a person starts, exactly as the Ableton one
 * is (MUS-017), and for the same reason: it loads third-party code into itself,
 * so it must not be something a web request can start, reach from another
 * machine, or point at an arbitrary file.
 *
 * Environment: INSTRUMENT_SIDECAR_URL (loopback only, default
 * http://127.0.0.1:3191), INSTRUMENT_SIDECAR_TOKEN. Both read here and never
 * stored — the token is a secret, so it lives in the process that needs it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DEFAULT_URL = 'http://127.0.0.1:3191';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Every operation the sidecar performs, and what Film Engine may ask of it. */
const HOST_OPERATIONS = Object.freeze({
    instruments: { what: 'the plugins installed on this machine', mutates: false, timeout_ms: 30000 },
    capture: {
        what: "open a plugin's editor so a person picks a patch, and keep the state that recalls it",
        mutates: false, supervised: true, timeout_ms: 0,        // a person is at the window; no ceiling
    },
    render: { what: 'play a part’s notes through a plugin holding a patch', mutates: false, timeout_ms: 900000 },
});

/** What a plugin host cannot do, stated so nobody builds toward it by accident. */
const UNSUPPORTED = Object.freeze([
    {
        what: 'browse a library and pick a patch by name, unaided',
        why: 'a plugin exposes its state, not its browser: Kontakt has no API that loads an .nki by path',
        instead: 'capture the state once through the editor, or read an NKS preset whose PCHK chunk IS the state',
    },
    {
        what: 'play an instrument live from the page',
        why: 'this renders offline and returns a file; live monitoring needs an audio server and a stream',
        instead: 'render the part — far faster than real time — and hear it in the Score page like any other clip',
    },
]);

function hostConfig(env = process.env) {
    const url = String(env.INSTRUMENT_SIDECAR_URL || DEFAULT_URL).trim();
    const token = String(env.INSTRUMENT_SIDECAR_TOKEN || '').trim();
    let parsed;
    try { parsed = new URL(url); } catch (_) {
        return { configured: false, reason: `INSTRUMENT_SIDECAR_URL is not a URL: ${url}` };
    }
    if (!LOOPBACK.has(parsed.hostname)) {
        return {
            configured: false,
            reason: `INSTRUMENT_SIDECAR_URL points at ${parsed.hostname}: the sidecar loads plugins into itself, `
                + 'so Film Engine only ever talks to one on this machine (127.0.0.1)',
        };
    }
    if (!token) {
        return {
            configured: false,
            reason: 'INSTRUMENT_SIDECAR_TOKEN is not set. Start the sidecar with a token of 24+ characters and '
                + 'give Film Engine the same one.',
        };
    }
    return { configured: true, url: parsed.origin, token };
}

const refusal = (stage, reason, extra = {}) => ({ ok: false, stage, reason, ...extra });

/**
 * One request, over node:http rather than fetch.
 *
 * DELIBERATE, and it cost a capture to learn: fetch gives up after five minutes
 * of waiting for response headers. A capture waits on a person at a plugin
 * window, and a big library's render can outlast that too — so the answer came
 * back to a closed socket and the work was lost. Here the only ceiling is the
 * one an operation declares.
 */
function request({ url, method = 'GET', token, body, timeoutMs = 0 }) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const payload = body == null ? null : Buffer.from(JSON.stringify(body));
        const req = http.request({
            hostname: target.hostname, port: target.port, path: target.pathname + target.search, method,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
            },
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        if (timeoutMs > 0) {
            req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`no answer within ${timeoutMs}ms`), { timedOut: true })));
        }
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function callSidecar(op, args, opts = {}) {
    const cfg = opts.config || hostConfig();
    if (!cfg.configured) return refusal('config', cfg.reason);
    const spec = HOST_OPERATIONS[op];
    if (!spec) return refusal('op', `'${op}' is not an operation the instrument sidecar performs`);

    const ms = opts.timeoutMs != null ? opts.timeoutMs : spec.timeout_ms;
    let res;
    try {
        res = await request({ url: `${cfg.url}/op`, method: 'POST', token: cfg.token, body: { op, args: args || {} }, timeoutMs: ms });
    } catch (err) {
        if (err.timedOut) return refusal('timeout', `the sidecar did not answer '${op}' within ${ms}ms`);
        return refusal('unreachable', `the instrument sidecar is not answering at ${cfg.url}: ${err.message}`, {
            fix: 'start it: INSTRUMENT_SIDECAR_TOKEN=<token> backend/.venv/bin/python backend/instrument-sidecar.py',
        });
    }

    const type = String(res.headers['content-type'] || '');
    if (type.startsWith('audio/')) {
        let meta = {};
        try { meta = JSON.parse(res.headers['x-render'] || '{}'); } catch (_) { meta = {}; }
        return { ok: true, audio: res.body, meta };
    }
    let body = {};
    try { body = JSON.parse(res.body.toString('utf8') || '{}'); } catch (_) { body = {}; }
    if (res.status >= 400) return refusal(res.status === 401 ? 'token' : 'sidecar', body.error || `the sidecar answered ${res.status}`, { status: res.status, detail: body });
    return { ok: true, ...body };
}

/** Is the host there, and what does it hold? Never throws. */
async function health(opts = {}) {
    const cfg = opts.config || hostConfig();
    if (!cfg.configured) {
        return { ok: false, configured: false, reasons: [cfg.reason], fixes: ['see docs/instrument-sidecar.md'] };
    }
    try {
        const res = await request({ url: `${cfg.url}/health`, token: cfg.token, timeoutMs: opts.timeoutMs || 10000 });
        let body = {};
        try { body = JSON.parse(res.body.toString('utf8') || '{}'); } catch (_) { body = {}; }
        if (res.status >= 400) {
            return { ok: false, configured: true, reachable: true, reasons: [body.error || `the sidecar answered ${res.status}`], fixes: [] };
        }
        return {
            ok: !!body.ok, configured: true, reachable: true,
            host: body.host || null, instruments_found: body.instruments_found || 0,
            kontakt: body.kontakt || null, loaded_plugins: body.loaded_plugins || [],
            busy: body.busy || null, queued: body.queued || 0,
            reasons: body.ok ? [] : [...(body.reasons || []), body.host && body.host.reason].filter(Boolean),
            fixes: body.ok ? [] : ['install the host library in the sidecar’s venv, or install a plugin'],
        };
    } catch (err) {
        return {
            ok: false, configured: true, reachable: false,
            reasons: [`the instrument sidecar is not answering at ${cfg.url}: ${err.message}`],
            fixes: ['start it: INSTRUMENT_SIDECAR_TOKEN=<token> backend/.venv/bin/python backend/instrument-sidecar.py'],
        };
    }
}

/** Everything a render needs: the sidecar, a plugin, and the encoder that finishes the file. */
async function availability(opts = {}) {
    const state = await health(opts);
    let encoder;
    try { encoder = require('./ffmpeg').resolveFfmpeg(); } catch (err) { encoder = { available: false, reason: err.message }; }
    const reasons = [...state.reasons];
    const fixes = [...state.fixes];
    if (!encoder.available) { reasons.push(encoder.reason); fixes.push('install ffmpeg, which trims a render to the part’s length'); }
    return { ok: state.ok && !!encoder.available, sidecar: state, encoder: { available: !!encoder.available, source: encoder.source || null }, reasons, fixes };
}

/** The plugins installed on this machine, as the sidecar sees them. */
async function instruments(opts = {}) {
    return callSidecar('instruments', {}, opts);
}

/**
 * Open a plugin's editor so a person loads the patch they want, and keep the
 * state that recalls it. Supervised: it puts a window in front of somebody.
 */
async function capture({ plugin, state, supervised }, opts = {}) {
    if (!supervised) {
        return refusal('supervised', 'capture opens a plugin window for a person to use; say so with supervised: true');
    }
    const startedAt = Date.now() / 1000;
    const answer = await callSidecar('capture', {
        plugin, supervised: true,
        ...(state ? { state_b64: Buffer.isBuffer(state) ? state.toString('base64') : String(state) } : {}),
    }, opts);
    if (answer.ok) return answer;

    /*
     * A CAPTURE THE CONNECTION LOST IS NOT LOST.
     *
     * Somebody stood at a plugin window and chose a sound; if the answer came
     * back to a dropped socket, the work is still on the sidecar. This is the
     * same rule the provider handles follow — the expensive part already
     * happened, so reach for the result rather than asking for it again.
     */
    if (!['unreachable', 'timeout'].includes(answer.stage)) return answer;
    const cfg = opts.config || hostConfig();
    if (!cfg.configured) return answer;
    try {
        const res = await request({ url: `${cfg.url}/last-capture`, token: cfg.token, timeoutMs: 10000 });
        const body = JSON.parse(res.body.toString('utf8') || '{}');
        if (res.status < 400 && body.state_b64 && Number(body.at) >= startedAt) {
            return { ok: true, ...body, recovered: 'the connection dropped; this is the patch you chose, kept by the sidecar' };
        }
    } catch (_) { /* the sidecar is genuinely gone; the original refusal stands */ }
    return answer;
}

/**
 * Play a part's notes through a plugin holding a patch, and finish the file the
 * way every render here is finished: cut to the part's length, read back, and
 * refused if it is silent.
 */
async function renderPart({ plugin, state, midi, lengthMs, outPath, frameMs, sampleRate = 48000 }, opts = {}) {
    if (!Buffer.isBuffer(midi) || midi.subarray(0, 4).toString('ascii') !== 'MThd') {
        return refusal('notes', 'there are no notes to play: pass the part’s MIDI file');
    }
    if (!(Number(lengthMs) > 0)) return refusal('length', 'there is no length to render to');

    const answer = await callSidecar('render', {
        plugin, midi_b64: midi.toString('base64'), length_ms: Math.round(lengthMs), sample_rate: sampleRate,
        ...(state ? { state_b64: Buffer.isBuffer(state) ? state.toString('base64') : String(state) } : {}),
    }, opts);
    if (!answer.ok) return answer;

    const raw = path.join(os.tmpdir(), `fe-instrument-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    fs.writeFileSync(raw, answer.audio);
    const { finishRender } = require('./instrument-render');
    const finished = finishRender({ rawPath: raw, outPath, lengthMs, frameMs, sampleRate });
    try { fs.unlinkSync(raw); } catch (_) { /* gone is fine */ }
    if (!finished.ok) {
        return finished.stage === 'silence'
            ? { ...finished, reason: `${finished.reason} This plugin state holds no patch — capture one, or choose a preset.` }
            : finished;
    }
    return { ...finished, renderer: 'plugin', plugin, render_seconds: answer.meta && answer.meta.render_seconds };
}

module.exports = {    UNSUPPORTED,
    hostConfig, callSidecar, health, availability, instruments, capture, renderPart,};
