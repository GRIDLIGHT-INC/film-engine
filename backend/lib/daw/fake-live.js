/**
 * A FAKE LIVE: THE ABLETONOSC SUBSET, OVER REAL UDP, WITH NO ABLETON IN IT.
 *
 * MUS-017. The sidecar's protocol harness. It answers the reviewed addresses
 * in `OSC_ADDRESSES` the way AbletonOSC at the pinned commit does — replies on
 * the reply port, a per-track reply leading with the track id, `/live/error`
 * carrying text and nothing else, `/live/startup` when it comes up — and
 * keeps a set in memory: tracks, tempo, song time, transport.
 *
 * It misbehaves on request, in the ways a real Live does: `silent` never
 * answers (Live closed, or AbletonOSC not selected), `shuffle` answers out of
 * order, `dropNext` loses a reply, `version` answers as another Live, and
 * `stop()` then `start()` is Live quitting and relaunching on the same port.
 *
 * It exists so the correlation, timeout, reconnect and allowlist rules are
 * tested over the network rather than asserted; it proves the protocol, not
 * Live. Nothing Ableton ships is in it.
 */

const dgram = require('dgram');
const osc = require('../osc');

function createFakeLive(opts) {
    const o = opts || {};
    const faults = { ...(o.faults || {}) };
    const version = o.version || [12, 4];
    const st = { tracks: [], tempo: 120, song_time: 0, playing: false };
    const drops = new Map();
    let sock = null, port = o.port || 0, started = 0;

    function reply(address, args, to) {
        if (!sock) return;
        const buf = osc.encode(address, args);
        const send = () => { if (sock) sock.send(buf, o.replyPort, to || '127.0.0.1'); };
        if (faults.shuffle) setTimeout(send, Math.floor(Math.random() * 25)); else if (faults.delayMs) setTimeout(send, faults.delayMs); else send();
    }
    const error = (address, why, to) => reply('/live/error', [`Error handling OSC message ${address}: ${why}`], to);

    function handle(m, to) {
        const a = m.args;
        const track = i => (Number.isInteger(i) && i >= 0 && i < st.tracks.length ? st.tracks[i] : null);
        switch (m.address) {
            case '/live/test': return reply('/live/test', ['ok'], to);
            case '/live/application/get/version': return reply(m.address, version, to);
            case '/live/song/get/tempo': return reply(m.address, [{ type: 'f', value: st.tempo }], to);
            case '/live/song/set/tempo': st.tempo = Math.round(a[0] * 1000) / 1000; return undefined;
            case '/live/song/get/num_tracks': return reply(m.address, [st.tracks.length], to);
            case '/live/song/get/track_names': return reply(m.address, st.tracks.map(t => t.name), to);
            case '/live/song/create_audio_track': {
                const at = a[0] === -1 || a[0] == null ? st.tracks.length : a[0];
                if (!(at >= 0 && at <= st.tracks.length)) return error(m.address, 'list index out of range', to);
                st.tracks.splice(at, 0, { name: `${st.tracks.length + 1}-Audio` });
                return undefined;
            }
            case '/live/track/get/name': { const t = track(a[0]); return t ? reply(m.address, [a[0], t.name], to) : error(m.address, 'list index out of range', to); }
            case '/live/track/set/name': { const t = track(a[0]); if (!t) return error(m.address, 'list index out of range', to); t.name = String(a[1]); return undefined; }
            case '/live/song/start_playing': st.playing = true; return undefined;
            case '/live/song/stop_playing': st.playing = false; return undefined;
            case '/live/song/get/is_playing': return reply(m.address, [st.playing], to);
            case '/live/song/get/current_song_time': return reply(m.address, [{ type: 'f', value: st.song_time }], to);
            case '/live/song/set/current_song_time': st.song_time = a[0]; return undefined;
            default: return error(m.address, `unknown OSC address ${m.address}`, to);
        }
    }

    return {
        get port() { return port; },
        start() {
            return new Promise((res, rej) => {
                sock = dgram.createSocket('udp4');
                sock.on('error', () => { /* a reply to a client that went away */ });
                sock.on('message', (buf, rinfo) => {
                    if (faults.silent) return;
                    let m; try { m = osc.decode(buf); } catch (_) { return; }
                    const left = drops.get(m.address) || 0;
                    if (left > 0) { drops.set(m.address, left - 1); return; }
                    handle(m, rinfo.address);
                });
                sock.once('error', rej);
                sock.bind(port, '127.0.0.1', () => {
                    port = sock.address().port;
                    if (started++ > 0 && !faults.silent) reply('/live/startup', []);
                    res();
                });
            });
        },
        stop() { return new Promise(r => { if (!sock) return r(); const s = sock; sock = null; s.close(r); }); },
        setTracks(names) { st.tracks = names.map(name => ({ name })); },
        renameTrack(i, name) { st.tracks[i].name = name; },
        dropNext(address, n) { drops.set(address, (drops.get(address) || 0) + (n || 1)); },
        setFault(k, v) { faults[k] = v; },
        state() { return { tracks: st.tracks.map(t => ({ ...t })), tempo: st.tempo, song_time: st.song_time, playing: st.playing }; },
    };
}

module.exports = { createFakeLive };
