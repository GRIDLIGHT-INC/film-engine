/**
 * THE ABLETONOSC CLIENT: A HANDSHAKE, CORRELATED REQUESTS, A HEARTBEAT, AND
 * A CLOSED LIST OF TYPED OPERATIONS.
 *
 * MUS-017. AbletonOSC (github.com/ideoforms/AbletonOSC, pinned below) is a
 * Remote Script inside Live that listens for OSC on UDP 11000 and answers on
 * 11001, to the address that asked. It is the transport under the Ableton
 * adapter of the MUS-016 DAW contract, and this module is everything the
 * sidecar knows about it:
 *
 * PINNED. One reviewed commit and one reviewed Live version. AbletonOSC
 * reports Live's major and minor version only, so the handshake can prove
 * 12.4 and cannot prove the 12.4.5 bugfix — `version_note` says so rather
 * than claiming it. A Live that answers with another version is connected and
 * readable, and refuses every mutation.
 *
 * CORRELATED. UDP carries no request id, so a reply is matched to its request
 * by address — and, for a per-track query, by the track id AbletonOSC echoes
 * as the first argument — first in, first out per key. A reply with no
 * waiting request is dropped and counted; a lost reply fails its own request
 * on its own timer and nothing else. `/live/error` names no request at all:
 * it is given to the waiting request its text names, else the oldest.
 *
 * SUPERVISED BY A HEARTBEAT. `/live/test` on a timer. Two misses in a row is a
 * disconnect: pending work fails, new work is refused until Live answers
 * again, and the retry backs off. An answer after a disconnect — or Live's
 * own `/live/startup` — is a reconnect and a fresh handshake, because a Live
 * that restarted may be a different version.
 *
 * ALLOWLISTED. `SIDECAR_OPS` is the only thing the sidecar will do: named,
 * typed operations over a reviewed set of addresses. There is no generic
 * address, no property setter and no delete. A mutation is confirmed by a
 * follow-up read, because AbletonOSC acknowledges no setter. Film Engine's
 * tracks carry a marker in their names (`⟨fe:…⟩`), since Live exposes no
 * stable track id over OSC; a rename is refused on any track without the
 * marker the caller's key produces.
 *
 * What AbletonOSC cannot do is declared in `UNSUPPORTED` and reported, never
 * pretended: it places no audio from a file and exports no render.
 */

const dgram = require('dgram');
const crypto = require('crypto');
const osc = require('./osc');

const ABLETONOSC_PIN = Object.freeze({
    repo: 'https://github.com/ideoforms/AbletonOSC',
    commit: '0ca6821',
    date: '2025-11-19',
    note: 'reviewed at this commit; install the Remote Script from exactly this tree',
});

const LIVE_SUPPORTED = Object.freeze({
    major: 12, minor: 4, reviewed: '12.4.5',
    note: 'AbletonOSC reports Live’s major and minor version only, so 12.4 is proven over OSC and the 12.4.5 bugfix is not; confirm it in Live › About.',
});

const OSC_PORTS = Object.freeze({ send: 11000, recv: 11001 });

/** Every OSC address the sidecar may send. Reviewed against the pinned commit; none deletes. */
const OSC_ADDRESSES = Object.freeze([
    '/live/test',
    '/live/application/get/version',
    '/live/song/get/tempo', '/live/song/set/tempo',
    '/live/song/get/num_tracks', '/live/song/get/track_names',
    '/live/song/create_audio_track',
    '/live/track/get/name', '/live/track/set/name',
    '/live/song/start_playing', '/live/song/stop_playing', '/live/song/get/is_playing',
    '/live/song/get/current_song_time', '/live/song/set/current_song_time',
]);

/** What AbletonOSC cannot do, why, and what Film Engine does instead. */
const UNSUPPORTED = Object.freeze([
    { what: 'place audio from a file', why: 'AbletonOSC has no message that loads an audio file into a clip slot or the arrangement; the Live Object Model it wraps does not expose one either',
        instead: 'drag each stem from the score package’s stems/ folder onto its Film Engine track at bar 1.1.1 — every stem is the same length and starts at zero, so one drop per track aligns the score' },
    { what: 'export a render', why: 'AbletonOSC has no message that renders or exports audio; export is a Live menu command with no API',
        instead: 'export stems from Live (File › Export Audio) and bring them back through the score package import, which validates them by hash and alignment' },
]);

const MARKER_RE = /⟨(fe:[0-9a-f]{10})⟩\s*$/;
const CONTROL_OR_BRACKET = /[⟨⟩\p{Cc}]/u;
const markerOf = feKey => 'fe:' + crypto.createHash('sha256').update(String(feKey)).digest('hex').slice(0, 10);
const markerIn = name => { const m = MARKER_RE.exec(String(name || '')); return m ? m[1] : null; };
const withMarker = (name, marker) => `${String(name).replace(MARKER_RE, '').trim()} ⟨${marker}⟩`;

function refuse(status, message) { const e = new Error(message); e.status = status; return e; }

async function readTracks(c) {
    const [n] = await c.ask('/live/song/get/num_tracks');
    const names = n > 0 ? await c.ask('/live/song/get/track_names') : [];
    return names.map((name, track_id) => ({ track_id, name, fe_marker: markerIn(name) }));
}

/**
 * The allowlist. Each operation states what it does, which addresses it
 * reaches, the type of every argument, and — when it changes Live — the read
 * that confirms it.
 */
const SIDECAR_OPS = Object.freeze({
    test: { what: 'Is Live answering: AbletonOSC’s own liveness check, which replies ok.', addresses: ['/live/test'], args: {},
        async run(c) { const [r] = await c.ask('/live/test'); return { ok: r === 'ok' }; } },
    live_version: { what: 'Live’s major and minor version as AbletonOSC reports it (no bugfix number).', addresses: ['/live/application/get/version'], args: {},
        async run(c) { const [major, minor] = await c.ask('/live/application/get/version'); return { major, minor, version: `${major}.${minor}` }; } },
    tempo_get: { what: 'The song tempo in beats per minute.', addresses: ['/live/song/get/tempo'], args: {},
        async run(c) { const [bpm] = await c.ask('/live/song/get/tempo'); return { bpm }; } },
    tempo_set: { what: 'Set the song tempo, within Live’s own range of 20 to 999 bpm.', addresses: ['/live/song/set/tempo', '/live/song/get/tempo'], args: { bpm: { type: 'number', min: 20, max: 999 } },
        mutates: true, confirm: 'reads the tempo back and requires it within 0.01 bpm of what was set',
        async run(c, a) {
            c.tell('/live/song/set/tempo', [{ type: 'f', value: a.bpm }]);
            const [bpm] = await c.ask('/live/song/get/tempo');
            if (Math.abs(bpm - a.bpm) > 0.01) throw refuse(502, `Live reports ${bpm} bpm after being asked for ${a.bpm}; the tempo change is not confirmed`);
            return { bpm };
        } },
    fe_tracks_read: { what: 'Every track in the set, in order, with the Film Engine marker its name carries (or none).', addresses: ['/live/song/get/num_tracks', '/live/song/get/track_names'], args: {},
        async run(c) { return { tracks: await readTracks(c) }; } },
    track_name_get: { what: 'One track’s name, by its position in the set.', addresses: ['/live/track/get/name'], args: { track_id: { type: 'integer', min: 0, max: 9999 } },
        async run(c, a) { const [, name] = await c.ask('/live/track/get/name', [a.track_id], a.track_id); return { track_id: a.track_id, name }; } },
    fe_track_create: { what: 'Create one audio track at the end of the set for a Film Engine key, named with that key’s marker — or return the track that already carries it.',
        addresses: ['/live/song/get/num_tracks', '/live/song/get/track_names', '/live/song/create_audio_track', '/live/track/set/name', '/live/track/get/name'],
        args: { fe_key: { type: 'fe_key' }, name: { type: 'string', max: 120 } }, mutates: true,
        confirm: 'reads the new track’s name back and requires the marker in it; a key whose marker is already on a track creates nothing',
        async run(c, a) {
            const marker = markerOf(a.fe_key);
            const existing = (await readTracks(c)).find(t => t.fe_marker === marker);
            if (existing) return { track_id: existing.track_id, name: existing.name, marker, created: false };
            c.tell('/live/song/create_audio_track', [-1]);
            const [n] = await c.ask('/live/song/get/num_tracks');
            const id = n - 1;
            const want = withMarker(a.name, marker);
            c.tell('/live/track/set/name', [id, want]);
            const [, got] = await c.ask('/live/track/get/name', [id], id);
            if (got !== want) throw refuse(502, `the new track at ${id} reads '${got}', not '${want}'; the create is not confirmed — read the set before trying again`);
            return { track_id: id, name: got, marker, created: true };
        } },
    fe_track_rename: { what: 'Rename a Film Engine track, keeping its marker — refused on any track whose name does not carry the marker of the key given.',
        addresses: ['/live/track/get/name', '/live/track/set/name'], args: { track_id: { type: 'integer', min: 0, max: 9999 }, fe_key: { type: 'fe_key' }, name: { type: 'string', max: 120 } }, mutates: true,
        confirm: 'reads the name back and requires exactly the name asked for, marker included',
        async run(c, a) {
            const marker = markerOf(a.fe_key);
            const [, current] = await c.ask('/live/track/get/name', [a.track_id], a.track_id);
            if (markerIn(current) !== marker) throw refuse(403, `track ${a.track_id} ('${current}') is not a Film Engine track for ${a.fe_key}: its name does not carry the marker ⟨${marker}⟩, and the sidecar changes no other track`);
            const want = withMarker(a.name, marker);
            c.tell('/live/track/set/name', [a.track_id, want]);
            const [, got] = await c.ask('/live/track/get/name', [a.track_id], a.track_id);
            if (got !== want) throw refuse(502, `track ${a.track_id} reads '${got}' after the rename to '${want}'; not confirmed`);
            return { track_id: a.track_id, name: got, marker };
        } },
    transport_play: { what: 'Start Live’s transport from where it is.', addresses: ['/live/song/start_playing', '/live/song/get/is_playing'], args: {}, mutates: true, confirm: 'reads is_playing back and requires it true',
        async run(c) { c.tell('/live/song/start_playing'); const [p] = await c.ask('/live/song/get/is_playing'); if (!p) throw refuse(502, 'Live is not playing after start_playing'); return { playing: true }; } },
    transport_stop: { what: 'Stop Live’s transport.', addresses: ['/live/song/stop_playing', '/live/song/get/is_playing'], args: {}, mutates: true, confirm: 'reads is_playing back and requires it false',
        async run(c) { c.tell('/live/song/stop_playing'); const [p] = await c.ask('/live/song/get/is_playing'); if (p) throw refuse(502, 'Live is still playing after stop_playing'); return { playing: false }; } },
    song_time_get: { what: 'Where Live’s playhead is, in beats.', addresses: ['/live/song/get/current_song_time'], args: {},
        async run(c) { const [beats] = await c.ask('/live/song/get/current_song_time'); return { beats }; } },
    song_time_set: { what: 'Move Live’s playhead to a position in beats.', addresses: ['/live/song/set/current_song_time', '/live/song/get/current_song_time'], args: { beats: { type: 'number', min: 0, max: 1e6 } },
        mutates: true, confirm: 'reads the song time back and requires it within a thousandth of a beat',
        async run(c, a) {
            c.tell('/live/song/set/current_song_time', [{ type: 'f', value: a.beats }]);
            const [beats] = await c.ask('/live/song/get/current_song_time');
            if (Math.abs(beats - a.beats) > 1e-3) throw refuse(502, `Live’s playhead reads ${beats} beats after being moved to ${a.beats}; not confirmed`);
            return { beats };
        } },
    is_playing_get: { what: 'Whether Live’s transport is running.', addresses: ['/live/song/get/is_playing'], args: {},
        async run(c) { const [p] = await c.ask('/live/song/get/is_playing'); return { playing: !!p }; } },
});

/** Check an op's arguments against its declared types; the message names the argument. */
function checkArgs(op, args) {
    const spec = SIDECAR_OPS[op].args || {};
    const a = args && typeof args === 'object' ? args : {};
    const out = {};
    for (const k of Object.keys(a)) if (!(k in spec)) return { ok: false, error: `${op} takes no argument '${k}'` };
    for (const [k, s] of Object.entries(spec)) {
        const v = a[k];
        if (v === undefined) return { ok: false, error: `${op} needs ${k} (${s.type})` };
        if (s.type === 'integer' && !Number.isInteger(v)) return { ok: false, error: `${k} must be a whole number` };
        if (s.type === 'number' && !(typeof v === 'number' && Number.isFinite(v))) return { ok: false, error: `${k} must be a number` };
        if ((s.type === 'integer' || s.type === 'number') && ((s.min != null && v < s.min) || (s.max != null && v > s.max))) return { ok: false, error: `${k} must be between ${s.min} and ${s.max}` };
        if (s.type === 'string' && (typeof v !== 'string' || !v.trim() || v.length > s.max || CONTROL_OR_BRACKET.test(v))) return { ok: false, error: `${k} must be a non-empty name of at most ${s.max} characters, without control characters or ⟨⟩` };
        if (s.type === 'fe_key' && !(typeof v === 'string' && /^fe:[a-z_]+:[A-Za-z0-9_.:-]{1,120}$/.test(v))) return { ok: false, error: `${k} must be a Film Engine key such as fe:track:<id>` };
        out[k] = v;
    }
    return { ok: true, args: out };
}

/** Which waiting request a reply belongs to: the address, plus the echoed track id for a per-track query. */
const keyOf = (address, trackId) => (trackId == null ? address : `${address}#${trackId}`);

function createAbletonClient(opts) {
    const o = opts || {};
    const host = o.host || '127.0.0.1';
    let sendPort = o.sendPort == null ? OSC_PORTS.send : o.sendPort;
    const timeoutMs = o.timeoutMs || 1500;
    const heartbeatMs = o.heartbeatMs || 2000;
    const sock = dgram.createSocket('udp4');
    const pending = new Map();   // key → [{ resolve, reject, timer, address, at }]
    const st = { connected: false, compatible: false, live_version: null, reason: 'not started', last_heartbeat_at: null, rtt_ms: null,
        reconnects: 0, handshakes: 0, last_error: null, unmatched: 0, misses: 0, everConnected: false };
    let hbTimer = null, stopped = false, backoff = heartbeatMs, handshaking = null, seq = 0;

    sock.on('error', e => { st.last_error = `socket: ${e.message}`; });
    sock.on('message', buf => {
        let m;
        try { m = osc.decode(buf); } catch (e) { st.last_error = e.message; return; }
        if (m.address === '/live/startup') { st.last_error = 'Live announced /live/startup; handshaking again'; handshake(); return; }
        if (m.address === '/live/error') { routeError(m.args.join(' ')); return; }
        const perTrack = m.address.startsWith('/live/track/');
        const key = keyOf(m.address, perTrack ? m.args[0] : null);
        const q = pending.get(key);
        if (!q || !q.length) { st.unmatched++; return; }
        const w = q.shift();
        if (!q.length) pending.delete(key);
        clearTimeout(w.timer);
        w.resolve(m.args);
    });

    function drop(key, w) {
        const q = pending.get(key) || [];
        const i = q.indexOf(w); if (i >= 0) q.splice(i, 1);
        if (!q.length) pending.delete(key);
        clearTimeout(w.timer);
    }

    /** /live/error carries text, not a request: the waiting request it names, else the oldest. */
    function routeError(text) {
        st.last_error = `Live reported /live/error: ${text}`;
        let best = null;
        for (const [key, q] of pending) for (const w of q) {
            const named = text.includes(w.address);
            if (!best || (named && !best.named) || (named === best.named && w.seq < best.w.seq)) best = { key, w, named };
        }
        if (!best) return;
        drop(best.key, best.w);
        best.w.reject(new Error(`Live reported /live/error: ${text}`));
    }

    function tell(address, args) {
        if (!OSC_ADDRESSES.includes(address)) throw new Error(`${address} is not a reviewed AbletonOSC address`);
        sock.send(osc.encode(address, args || []), sendPort, host);
    }

    function ask(address, args, trackId) {
        if (!OSC_ADDRESSES.includes(address)) return Promise.reject(new Error(`${address} is not a reviewed AbletonOSC address`));
        return new Promise((resolve, reject) => {
            const key = keyOf(address, trackId);
            const w = { resolve, reject, address, seq: seq++ };
            w.timer = setTimeout(() => {
                drop(key, w);
                const e = new Error(`${address} timed out after ${timeoutMs} ms with no reply from Live`); e.code = 'OSC_TIMEOUT';
                reject(e);
            }, timeoutMs);
            if (!pending.has(key)) pending.set(key, []);
            pending.get(key).push(w);
            try { sock.send(osc.encode(address, args || []), sendPort, host); } catch (e) { drop(key, w); reject(e); }
        });
    }

    function failPending(why) {
        for (const q of pending.values()) for (const w of q) { clearTimeout(w.timer); w.reject(new Error(why)); }
        pending.clear();
    }

    const ctx = { ask, tell };

    function handshake() {
        if (handshaking) return handshaking;
        handshaking = (async () => {
            const t0 = Date.now();
            try {
                const t = await SIDECAR_OPS.test.run(ctx);
                if (!t.ok) throw new Error('Live answered /live/test with something other than ok');
                st.rtt_ms = Date.now() - t0;
                const v = await SIDECAR_OPS.live_version.run(ctx);
                const wasDown = st.everConnected && !st.connected;
                st.live_version = v.version;
                st.compatible = v.major === LIVE_SUPPORTED.major && v.minor === LIVE_SUPPORTED.minor;
                st.reason = st.compatible ? null : `Live ${v.version} is not the reviewed version (${LIVE_SUPPORTED.major}.${LIVE_SUPPORTED.minor}, build ${LIVE_SUPPORTED.reviewed}); reads are allowed and every change is refused`;
                st.connected = true; st.misses = 0; backoff = heartbeatMs;
                st.last_heartbeat_at = new Date().toISOString();
                st.handshakes++;
                if (wasDown) st.reconnects++;
                st.everConnected = true;
                return true;
            } catch (e) {
                st.connected = false;
                st.reason = `Live did not complete the handshake (${e.message}) — is Live running, with AbletonOSC selected as a control surface and listening on ${host}:${sendPort}?`;
                st.last_error = e.message;
                return false;
            } finally { handshaking = null; }
        })();
        return handshaking;
    }

    async function beat() {
        if (stopped) return;
        if (!st.connected) {
            if (!(await handshake())) backoff = Math.min(backoff * 2, 1000);
        } else {
            const t0 = Date.now();
            try {
                await SIDECAR_OPS.test.run(ctx);
                st.rtt_ms = Date.now() - t0; st.misses = 0; st.last_heartbeat_at = new Date().toISOString();
            } catch (_) {
                st.misses++;
                if (st.misses >= 2) {
                    st.connected = false;
                    st.reason = `Live stopped answering the heartbeat (${st.misses} misses in a row); reconnecting`;
                    failPending('disconnected from Live: the heartbeat stopped answering, so this request’s outcome is unknown');
                }
            }
        }
        if (!stopped) { hbTimer = setTimeout(beat, st.connected ? heartbeatMs : backoff); hbTimer.unref(); }
    }

    return {
        get recvPort() { try { return sock.address().port; } catch (_) { return null; } },
        bind() {
            return new Promise((res, rej) => {
                sock.once('error', rej);
                sock.bind(o.recvPort == null ? OSC_PORTS.recv : o.recvPort, host, () => { sock.removeListener('error', rej); res(); });
            });
        },
        setSendPort(p) { sendPort = p; },
        async start() { await handshake(); hbTimer = setTimeout(beat, heartbeatMs); hbTimer.unref(); return this.health(); },
        async stop() { stopped = true; clearTimeout(hbTimer); failPending('the client was stopped'); await new Promise(r => { try { sock.close(r); } catch (_) { r(); } }); },
        health() {
            return { connected: st.connected, compatible: st.connected && st.compatible, live_version: st.live_version, abletonosc_pin: ABLETONOSC_PIN,
                version_note: LIVE_SUPPORTED.note, reason: st.reason, last_heartbeat_at: st.last_heartbeat_at, rtt_ms: st.rtt_ms,
                pending: [...pending.values()].reduce((n, q) => n + q.length, 0), reconnects: st.reconnects, handshakes: st.handshakes,
                unmatched_replies: st.unmatched, last_error: st.last_error, ports: { host, send: sendPort, recv: this.recvPort } };
        },
        /** Run an allowlisted operation. Refused while disconnected, and refused to mutate an unreviewed Live. */
        async request(op, args) {
            const def = Object.prototype.hasOwnProperty.call(SIDECAR_OPS, op) ? SIDECAR_OPS[op] : null;
            if (!def) throw refuse(403, `'${op}' is not on the sidecar’s allowlist`);
            const c = checkArgs(op, args);
            if (!c.ok) throw refuse(400, c.error);
            if (!st.connected) throw refuse(503, `not connected to Live: ${st.reason}`);
            if (def.mutates && !st.compatible) throw refuse(409, `refused: ${st.reason || 'Live is not a compatible version'} (the reviewed version is ${LIVE_SUPPORTED.major}.${LIVE_SUPPORTED.minor})`);
            return def.run(ctx, c.args);
        },
    };
}

module.exports = {
    ABLETONOSC_PIN, LIVE_SUPPORTED, OSC_PORTS, OSC_ADDRESSES, SIDECAR_OPS, UNSUPPORTED,
    markerOf, markerIn, withMarker, checkArgs, createAbletonClient,
};
