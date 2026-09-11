/**
 * THE REFERENCE DAW: THE ADAPTER CONTRACT, IMPLEMENTED IN MEMORY.
 *
 * MUS-016. Every rule the driver enforces is proven against this adapter,
 * and it can be told to misbehave in each of the ways a real DAW can —
 * answer without an acknowledgement, echo the wrong request, hang, touch a
 * track that is not Film Engine's, return bytes other than the ones it
 * advertised — so the driver's refusals are tested rather than assumed. It is
 * the protocol a transport adapter (AbletonOSC, MUS-017) must satisfy, with
 * no transport: nothing here opens a socket or a file.
 *
 * It keeps its own honour of the contract: pushes and pulls are deduplicated
 * by idempotency key, Film Engine's tracks live in one group owned by
 * 'film-engine', and anything else in the session belongs to somebody else.
 */

const crypto = require('crypto');
const { validatePackage } = require('../music-package');

const GROUP = 'Film Engine';

function createMemoryDaw(opts) {
    const o = opts || {};
    const fault = o.fault || {};
    const st = { tracks: [], playhead_ms: 0, revision: 1, rendered: null, seen: new Map(), counts: {} };
    let next = 1;
    const hang = () => new Promise(() => { /* never answers */ });
    const count = m => { st.counts[m] = (st.counts[m] || 0) + 1; };
    const rev = () => `r${st.revision++}`;

    const adapter = {
        id: 'memory', label: 'Reference DAW (in memory)', version: '1.0.0', transport: 'none', reference: true,

        async status() {
            count('status');
            if (fault.status === 'slow') return hang();
            return { connected: true, version: '1.0.0', compatible: true, reason: null };
        },

        async sessionRead() {
            count('sessionRead');
            if (fault.session_read === 'slow') return hang();
            return { revision: `s${st.revision}`, group: GROUP, playhead_ms: st.playhead_ms,
                tracks: st.tracks.map(t => ({ external_id: t.external_id, name: t.name, owner: t.owner, group: t.group, revision: t.revision })) };
        },

        async push(req) {
            count('push');
            if (fault.push === 'slow') return hang();
            if (st.seen.has(req.idempotency_key)) return st.seen.get(req.idempotency_key);
            const v = validatePackage(req.package);
            if (!v.ok) return { request_id: req.request_id, accepted: false, error: v.errors.join('; ') };
            const applied = [];
            for (const i of req.instructions) {
                let t = i.action === 'update' ? st.tracks.find(x => x.external_id === i.external_id && x.owner === 'film-engine') : null;
                const created = !t;
                if (!t) { t = { external_id: `mem-trk-${next++}`, owner: 'film-engine', group: GROUP }; st.tracks.push(t); }
                const stem = (v.manifest.stems || []).find(s => s.key === i.fe_key);
                t.name = i.name; t.fe_key = i.fe_key; t.audio_sha = stem ? stem.sha256 : null; t.revision = rev();
                applied.push({ fe_key: i.fe_key, external_id: t.external_id, revision: t.revision, action: created ? 'create' : 'update' });
            }
            if (fault.push === 'touch_foreign') {
                const foreign = st.tracks.find(t => t.owner !== 'film-engine');
                if (foreign) applied.push({ fe_key: 'fe:track:somebody-else', external_id: foreign.external_id, revision: rev(), action: 'update' });
            }
            let ack = { request_id: req.request_id, accepted: true, applied };
            if (fault.push === 'no_ack') ack = undefined;
            if (fault.push === 'wrong_request_id') ack = { ...ack, request_id: 'not-your-request' };
            st.seen.set(req.idempotency_key, ack);
            return ack;
        },

        async pullAvailable() {
            count('pullAvailable');
            if (!st.rendered) return [];
            return [{ item_id: `render-${st.rendered.sha.slice(0, 12)}`, kind: 'stems', revision: st.rendered.revision, sha256: st.rendered.sha, bytes: st.rendered.bytes.length }];
        },

        async pull(req) {
            count('pull');
            if (fault.pull === 'slow') return hang();
            if (st.seen.has(req.idempotency_key)) return st.seen.get(req.idempotency_key);
            if (!st.rendered) return { request_id: req.request_id, accepted: false, error: 'nothing has been rendered' };
            let bytes = st.rendered.bytes;
            if (fault.pull === 'wrong_bytes') { bytes = Buffer.from(bytes); bytes[bytes.length - 30] ^= 0xff; }
            let ack = { request_id: req.request_id, accepted: true, item_id: req.item_id, package: bytes };
            if (fault.pull === 'no_ack') ack = { package: bytes };
            if (fault.pull === 'wrong_request_id') ack = { ...ack, request_id: 'not-your-request' };
            st.seen.set(req.idempotency_key, ack);
            return ack;
        },

        async transport(req) {
            count('transport');
            if (fault.transport === 'slow') return hang();
            if (req.command === 'locate') st.playhead_ms = req.position_ms;
            if (req.command === 'stop') st.playing = false;
            if (req.command === 'play') st.playing = true;
            if (fault.transport === 'no_ack') return undefined;
            if (fault.transport === 'wrong_request_id') return { request_id: 'not-your-request', accepted: true };
            return { request_id: req.request_id, accepted: true, playhead_ms: st.playhead_ms, playing: !!st.playing };
        },

        // ── Test and harness controls: what a person does in the DAW ──
        addForeignTrack(name) { st.tracks.push({ external_id: `mem-trk-${next++}`, name, owner: 'user', group: '', revision: rev() }); },
        editTrack(externalId) { const t = st.tracks.find(x => x.external_id === externalId); if (t) t.revision = rev(); },
        deleteTrack(externalId) { st.tracks = st.tracks.filter(x => x.external_id !== externalId); },
        renderFrom(bytes) { st.rendered = { bytes, sha: crypto.createHash('sha256').update(bytes).digest('hex'), revision: rev() }; },
        calls(method) { const m = { push: 'push', pull: 'pull', transport: 'transport', status: 'status', session_read: 'sessionRead' }[method] || method; return st.counts[m] || 0; },
        state() { return { tracks: st.tracks.map(t => ({ ...t })), playhead_ms: st.playhead_ms, playing: !!st.playing }; },
    };
    return adapter;
}

module.exports = { createMemoryDaw, GROUP };
