/**
 * THE ABLETON SIDECAR: A SEPARATE, LOCALHOST-ONLY PROCESS BETWEEN FILM ENGINE
 * AND ABLETONOSC.
 *
 * MUS-017. Run it yourself, beside Live:
 *
 *   ABLETON_SIDECAR_TOKEN=<24+ random characters> node backend/ableton-sidecar.js
 *
 * It is separately permissioned by construction. The Film Engine server never
 * spawns it and holds no Live connection of its own; the sidecar runs only
 * when a person starts it, listens on 127.0.0.1 only, answers only a caller
 * carrying its token, talks only to a Live on this machine (the OSC host must
 * be loopback), and does only what `SIDECAR_OPS` lists — typed operations,
 * no generic OSC address, no property setter, no delete, and no mutation at
 * all against a Live version that has not been reviewed.
 *
 *   GET  /health  connection, versions, heartbeat, round trip, reconnects, last error
 *   GET  /ops     the allowlist and what AbletonOSC cannot do (free)
 *   POST /op      { op, args } → the operation's result
 *
 * Status codes say which rule answered: 401 no token, 403 not on the
 * allowlist (or not Film Engine's track), 400 an argument of the wrong type,
 * 503 Live is not answering, 409 Live is not the reviewed version, 504 Live
 * did not reply in time, 502 Live replied with something that does not
 * confirm the change.
 *
 * Environment: ABLETON_SIDECAR_TOKEN (required), ABLETON_SIDECAR_PORT (3190),
 * ABLETON_OSC_HOST (127.0.0.1), ABLETON_OSC_SEND_PORT (11000),
 * ABLETON_OSC_RECV_PORT (11001). Installation: docs/ableton-sidecar.md.
 */

const http = require('http');
const crypto = require('crypto');
const { createAbletonClient, SIDECAR_OPS, UNSUPPORTED, ABLETONOSC_PIN, LIVE_SUPPORTED, OSC_PORTS } = require('./lib/ableton-osc');

const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
const DEFAULT_PORT = 3190;
const BODY_LIMIT = 16 * 1024;

/** Read and refuse the configuration before anything listens. */
function sidecarConfig(env) {
    const e = env || {};
    const host = e.ABLETON_OSC_HOST || '127.0.0.1';
    if (!LOOPBACK.includes(host)) throw new Error(`ABLETON_OSC_HOST is '${host}': the sidecar only speaks to a Live on this machine, so it must be a loopback address (${LOOPBACK.join(', ')})`);
    const token = e.ABLETON_SIDECAR_TOKEN || '';
    if (token.length < 24) throw new Error('ABLETON_SIDECAR_TOKEN is required and must be at least 24 characters: every caller must present it, and a short one is guessable');
    const int = (v, d, name) => {
        if (v == null || v === '') return d;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number, not '${v}'`);
        return n;
    };
    return { host, token, port: int(e.ABLETON_SIDECAR_PORT, DEFAULT_PORT, 'ABLETON_SIDECAR_PORT'),
        sendPort: int(e.ABLETON_OSC_SEND_PORT, OSC_PORTS.send, 'ABLETON_OSC_SEND_PORT'), recvPort: int(e.ABLETON_OSC_RECV_PORT, OSC_PORTS.recv, 'ABLETON_OSC_RECV_PORT') };
}

function authorised(req, token) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    const a = Buffer.from(m[1]), b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, body) {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' });
    res.end(s);
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let n = 0; const chunks = [];
        req.on('data', c => { n += c.length; if (n > BODY_LIMIT) { reject(Object.assign(new Error(`the body is over ${BODY_LIMIT} bytes; an operation is a name and a few arguments`), { status: 413 })); req.destroy(); } else chunks.push(c); });
        req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (_) { reject(Object.assign(new Error('the body is not JSON'), { status: 400 })); } });
        req.on('error', reject);
    });
}

const allowlist = () => ({
    abletonosc_pin: ABLETONOSC_PIN, live_supported: LIVE_SUPPORTED, unsupported: UNSUPPORTED,
    ops: Object.fromEntries(Object.entries(SIDECAR_OPS).map(([k, v]) => [k, { what: v.what, args: v.args, mutates: !!v.mutates, confirm: v.confirm || null, addresses: v.addresses }])),
});

/** Listen on loopback in front of a started client. Port 0 is ephemeral (tests). */
function createSidecar(opts) {
    const o = opts || {};
    if (!o.client) throw new Error('createSidecar needs an AbletonOSC client');
    if (!o.token || o.token.length < 16) throw new Error('createSidecar needs a token');
    const server = http.createServer(async (req, res) => {
        if (!authorised(req, o.token)) return send(res, 401, { error: 'the sidecar answers only a caller carrying its token (Authorization: Bearer …)' });
        const url = new URL(req.url, 'http://127.0.0.1');
        try {
            if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, o.client.health());
            if (req.method === 'GET' && url.pathname === '/ops') return send(res, 200, allowlist());
            if (req.method === 'POST' && url.pathname === '/op') {
                const body = await readJson(req);
                if (typeof body.op !== 'string' || !Object.prototype.hasOwnProperty.call(SIDECAR_OPS, body.op)) {
                    return send(res, 403, { error: `'${body.op}' is not on the sidecar’s allowlist; it does only ${Object.keys(SIDECAR_OPS).join(', ')}` });
                }
                const result = await o.client.request(body.op, body.args || {});
                return send(res, 200, { op: body.op, ...result });
            }
            return send(res, 404, { error: 'the sidecar serves GET /health, GET /ops and POST /op' });
        } catch (e) {
            return send(res, e.status || (e.code === 'OSC_TIMEOUT' ? 504 : 502), { error: e.message });
        }
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(o.port == null ? DEFAULT_PORT : o.port, '127.0.0.1', () => {
            const addr = server.address();
            resolve({ url: `http://127.0.0.1:${addr.port}`, address: addr.address, port: addr.port, token: o.token,
                close: () => new Promise(r => server.close(() => r())) });
        });
    });
}

async function main() {
    let cfg;
    try { cfg = sidecarConfig(process.env); } catch (e) { console.error(`ableton-sidecar: ${e.message}`); process.exit(2); }
    const client = createAbletonClient({ host: cfg.host, sendPort: cfg.sendPort, recvPort: cfg.recvPort });
    await client.bind();
    const h = await client.start();
    const sc = await createSidecar({ client, token: cfg.token, port: cfg.port });
    console.log(`ableton-sidecar on ${sc.url} — AbletonOSC ${ABLETONOSC_PIN.commit}, OSC ${cfg.host}:${cfg.sendPort}→:${cfg.recvPort}`);
    console.log(h.connected ? `Live ${h.live_version} ${h.compatible ? 'is the reviewed version' : `— ${h.reason}`}` : `Live is not answering yet: ${h.reason}`);
    const quit = async () => { await sc.close(); await client.stop(); process.exit(0); };
    process.on('SIGINT', quit); process.on('SIGTERM', quit);
}

if (require.main === module) main();

module.exports = { sidecarConfig, createSidecar, DEFAULT_PORT };
