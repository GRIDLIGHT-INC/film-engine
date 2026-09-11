/**
 * THE ABLETON ADAPTER: THE MUS-016 DAW CONTRACT, OVER THE ABLETONOSC SIDECAR.
 *
 * MUS-017. The engine side of the Ableton integration. It speaks HTTP to the
 * separately run sidecar (`backend/ableton-sidecar.js`) and never OSC itself,
 * and it implements the six contract methods so the driver in
 * `lib/daw-adapter.js` holds it to every rule it holds the reference DAW to:
 * acknowledged, idempotent, bounded, timed, audited, supervised.
 *
 * IDENTITY. Live exposes no stable track id over OSC — a track is a position,
 * and positions move when somebody adds a track above. So a Film Engine track
 * carries a marker in its name, `⟨fe:<10 hex>⟩`, derived from its Film
 * Engine key, and the marker is its external id. A track without a marker
 * belongs to somebody else and is only ever read. The revision is a hash of
 * the name: the one property of a track this adapter writes, so the one whose
 * change means a person edited it in Live.
 *
 * WHAT IT DOES NOT DO, SAID IN EVERY ANSWER. AbletonOSC cannot place audio
 * from a file, so a push creates and names the tracks and sets the tempo, and
 * each acknowledgement says the audio is placed by hand — which stem, where.
 * It cannot export a render either, so there is nothing to pull: the plan is
 * empty with the reason, and a Live render comes back through the score
 * package import. Tempo is set from the first entry of the tempo map; Live's
 * tempo automation is not writable over OSC.
 */

const crypto = require('crypto');
const { validatePackage } = require('../music-package');
const { markerOf, markerIn, withMarker, UNSUPPORTED, ABLETONOSC_PIN } = require('../ableton-osc');

const OWNER = 'film-engine';
const revOf = name => crypto.createHash('sha256').update(String(name)).digest('hex').slice(0, 12);
const cleanName = s => String(s || 'track').replace(/[⟨⟩\p{Cc}]/gu, '').trim().slice(0, 100) || 'track';

const PULL_REASON = `AbletonOSC cannot export a render (${UNSUPPORTED.find(u => u.what === 'export a render').why}); ${UNSUPPORTED.find(u => u.what === 'export a render').instead}`;
const AUDIO_NOTE = UNSUPPORTED.find(u => u.what === 'place audio from a file').instead;

function createAbletonAdapter(opts) {
    const o = opts || {};
    if (!o.url) throw new Error('the Ableton adapter needs the sidecar url');
    const seen = new Map();

    async function http(method, path, body) {
        let r;
        try {
            r = await fetch(o.url + path, { method, headers: { Authorization: `Bearer ${o.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        } catch (e) { throw new Error(`the Ableton sidecar at ${o.url} is not reachable (${e.message}); start it with node backend/ableton-sidecar.js`); }
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { const e = new Error(j.error || `the sidecar answered ${r.status}`); e.status = r.status; throw e; }
        return j;
    }
    const op = (name, args) => http('POST', '/op', { op: name, args: args || {} });

    async function tracks() {
        const { tracks: list } = await op('fe_tracks_read');
        return list;
    }
    const asContract = t => (t.fe_marker
        ? { external_id: t.fe_marker, name: t.name, owner: OWNER, group: null, revision: revOf(t.name), position: t.track_id }
        : { external_id: `live:${t.track_id}`, name: t.name, owner: 'live', group: null, revision: revOf(t.name), position: t.track_id });

    return {
        id: 'ableton', label: 'Ableton Live (AbletonOSC sidecar)', version: `1.0.0+abletonosc.${ABLETONOSC_PIN.commit}`, transport: 'http→osc',
        pullReason: PULL_REASON,

        async status() {
            const h = await http('GET', '/health');
            return { connected: h.connected, version: h.live_version, compatible: h.compatible, reason: h.reason, pin: h.abletonosc_pin && h.abletonosc_pin.commit, version_note: h.version_note };
        },

        async sessionRead() {
            const list = await tracks();
            const { bpm } = await op('tempo_get');
            return { revision: revOf(list.map(t => t.name).join('\n')), group: null, grouping: 'name marker ⟨fe:…⟩ — AbletonOSC cannot create a group track',
                tempo_bpm: bpm, tracks: list.map(asContract) };
        },

        async push(req) {
            if (seen.has(req.idempotency_key)) return seen.get(req.idempotency_key);
            const v = validatePackage(req.package);
            if (!v.ok) return { request_id: req.request_id, accepted: false, error: v.errors.join('; ') };
            const done = [];
            try {
                const tempoMap = (v.manifest.timing && v.manifest.timing.tempo_map) || [];
                let tempo = null;
                if (tempoMap.length && tempoMap[0].bpm) tempo = (await op('tempo_set', { bpm: tempoMap[0].bpm })).bpm;
                let list = await tracks();
                for (const i of req.instructions) {
                    const marker = markerOf(i.fe_key);
                    const name = cleanName(i.name);
                    const t = list.find(x => x.fe_marker === marker);
                    let action;
                    if (t) {
                        action = 'update';
                        if (t.name !== withMarker(name, marker)) await op('fe_track_rename', { track_id: t.track_id, fe_key: i.fe_key, name });
                    } else {
                        const c = await op('fe_track_create', { fe_key: i.fe_key, name });
                        action = c.created ? 'create' : 'update';
                        list = await tracks();
                    }
                    done.push({ i, marker, action });
                }
                list = await tracks();
                const applied = done.map(({ i, marker, action }) => {
                    const t = list.find(x => markerIn(x.name) === marker);
                    return { fe_key: i.fe_key, external_id: marker, revision: t ? revOf(t.name) : null, action, audio: 'manual', stem_path: i.stem_path || null, place_at: '1.1.1' };
                });
                const ack = { request_id: req.request_id, accepted: true, applied, tempo_bpm: tempo,
                    tempo_note: tempoMap.length > 1 ? `the tempo map has ${tempoMap.length} changes; Live was set to the first (${tempoMap[0].bpm} bpm) — tempo automation is not writable over OSC` : null,
                    manual: AUDIO_NOTE };
                seen.set(req.idempotency_key, ack);
                return ack;
            } catch (e) {
                return { request_id: req.request_id, accepted: false, error: `${e.message}${done.length ? ` (after ${done.length} track(s); retrying is safe — a track carrying its marker is never created twice)` : ''}` };
            }
        },

        async pullAvailable() { return []; },

        async pull(req) { return { request_id: req.request_id, accepted: false, error: PULL_REASON }; },

        async transport(req) {
            if (req.command === 'play') { const r = await op('transport_play'); return { request_id: req.request_id, accepted: true, playing: r.playing }; }
            if (req.command === 'stop') { const r = await op('transport_stop'); return { request_id: req.request_id, accepted: true, playing: r.playing }; }
            if (req.command === 'locate') {
                const { bpm } = await op('tempo_get');
                const r = await op('song_time_set', { beats: (req.position_ms / 60000) * bpm });
                return { request_id: req.request_id, accepted: true, playhead_ms: Math.round((r.beats / bpm) * 60000), beats: r.beats, bpm };
            }
            return { request_id: req.request_id, accepted: false, error: `the Ableton adapter does not know the transport command ${req.command}` };
        },
    };
}

module.exports = { createAbletonAdapter, PULL_REASON };
