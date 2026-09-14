/**
 * NKS PRESETS: a library's own sounds, readable without opening the plugin.
 *
 * An `.nksf` is a RIFF file of four chunks:
 *   NISI  what the sound is — name, vendor, bank, types — as MessagePack
 *   NICA  controller assignments (not read here; nothing in Film Engine turns knobs)
 *   PLID  which plugin plays it
 *   PCHK  THE PLUGIN STATE — the same thing `capture` returns from the editor
 *
 * That last chunk is why this module exists: with 248 libraries, choosing a
 * sound by clicking through Kontakt is the cost, not the plugin. A preset can
 * be indexed and recalled by name instead.
 *
 * UNVERIFIED, and stated rather than assumed: whether a plugin accepts a PCHK
 * payload through the host's `load_state` — which wraps the state its own way —
 * can only be established against a real preset, and no library is installed on
 * the development machine yet. The reader is exact; the handover is checked the
 * only way it can be, by rendering and listening for silence.
 */

const fs = require('fs');
const path = require('path');

const CHUNKS = Object.freeze({
    NISI: 'what the sound is: name, vendor, bank, types (MessagePack)',
    NICA: 'controller assignments — not read: nothing here turns a knob',
    PLID: 'which plugin plays it',
    PCHK: 'the plugin state that recalls the patch',
});

/** Read a RIFF file into { id: payload }. Refuses anything that is not one. */
function riffChunks(bytes) {
    if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF') {
        throw Object.assign(new Error('not a RIFF file, so not an NKS preset'), { status: 400 });
    }
    const declared = bytes.readUInt32LE(4);
    if (declared + 8 > bytes.length + 8) {
        throw Object.assign(new Error('the preset declares more bytes than it has'), { status: 400 });
    }
    const form = bytes.toString('ascii', 8, 12);
    const out = {};
    let at = 12;
    while (at + 8 <= bytes.length) {
        const id = bytes.toString('ascii', at, at + 4);
        const size = bytes.readUInt32LE(at + 4);
        const start = at + 8, end = start + size;
        if (end > bytes.length) {
            throw Object.assign(new Error(`the ${id} chunk runs past the end of the preset`), { status: 400 });
        }
        out[id] = bytes.subarray(start, end);
        at = end + (size % 2);          // RIFF pads odd chunks to even
    }
    return { form, chunks: out };
}

/**
 * Enough MessagePack to read a summary: maps, arrays, strings, ints, bools,
 * null. Deliberately partial — this reads somebody else's metadata, so anything
 * it does not understand becomes null rather than a throw that loses the sound.
 */
function unpack(buf, at = 0) {
    if (at >= buf.length) return [null, at];
    const b = buf[at++];
    const str = n => [buf.toString('utf8', at, at + n), at + n];
    if (b <= 0x7f) return [b, at];                                  // positive fixint
    if (b >= 0xe0) return [b - 256, at];                            // negative fixint
    if ((b & 0xf0) === 0x80) return map(b & 0x0f, at);              // fixmap
    if ((b & 0xf0) === 0x90) return arr(b & 0x0f, at);              // fixarray
    if ((b & 0xe0) === 0xa0) return str(b & 0x1f);                  // fixstr
    switch (b) {
        case 0xc0: return [null, at];
        case 0xc2: return [false, at];
        case 0xc3: return [true, at];
        case 0xc4: { const n = buf[at]; return [buf.subarray(at + 1, at + 1 + n), at + 1 + n]; }
        case 0xc5: { const n = buf.readUInt16BE(at); return [buf.subarray(at + 2, at + 2 + n), at + 2 + n]; }
        case 0xc6: { const n = buf.readUInt32BE(at); return [buf.subarray(at + 4, at + 4 + n), at + 4 + n]; }
        case 0xca: return [buf.readFloatBE(at), at + 4];
        case 0xcb: return [buf.readDoubleBE(at), at + 8];
        case 0xcc: return [buf[at], at + 1];
        case 0xcd: return [buf.readUInt16BE(at), at + 2];
        case 0xce: return [buf.readUInt32BE(at), at + 4];
        case 0xd0: return [buf.readInt8(at), at + 1];
        case 0xd1: return [buf.readInt16BE(at), at + 2];
        case 0xd2: return [buf.readInt32BE(at), at + 4];
        case 0xd9: { const n = buf[at]; at += 1; return str(n); }
        case 0xda: { const n = buf.readUInt16BE(at); at += 2; return str(n); }
        case 0xdb: { const n = buf.readUInt32BE(at); at += 4; return str(n); }
        case 0xdc: { const n = buf.readUInt16BE(at); return arr(n, at + 2); }
        case 0xdd: { const n = buf.readUInt32BE(at); return arr(n, at + 4); }
        case 0xde: { const n = buf.readUInt16BE(at); return map(n, at + 2); }
        case 0xdf: { const n = buf.readUInt32BE(at); return map(n, at + 4); }
        default: return [null, buf.length];                         // not understood: stop, do not guess
    }
    function arr(n, from) {
        const out = [];
        let p = from;
        for (let i = 0; i < n; i++) { const [v, next] = unpack(buf, p); out.push(v); p = next; }
        return [out, p];
    }
    function map(n, from) {
        const out = {};
        let p = from;
        for (let i = 0; i < n; i++) {
            const [k, afterKey] = unpack(buf, p);
            const [v, afterValue] = unpack(buf, afterKey);
            out[String(k)] = v;
            p = afterValue;
        }
        return [out, p];
    }
}

/** The NISI summary, or an empty one. A sound with unreadable metadata is still a sound. */
function summaryOf(nisi) {
    if (!nisi || nisi.length < 5) return {};
    try {
        // A four-byte version leads the MessagePack payload.
        const [value] = unpack(nisi, 4);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) {
        return {};
    }
}

const first = (summary, keys) => {
    for (const k of keys) if (summary[k] != null && summary[k] !== '') return summary[k];
    return null;
};

/** What a preset is, without loading anything. */
function readPreset(file) {
    const bytes = fs.readFileSync(file);
    const { form, chunks } = riffChunks(bytes);
    if (!chunks.PCHK) {
        throw Object.assign(new Error('this preset carries no plugin state (no PCHK chunk), so nothing could recall it'), { status: 400 });
    }
    const summary = summaryOf(chunks.NISI);
    const types = first(summary, ['types', 'modes']) || [];
    return {
        file, form,
        chunks: Object.keys(chunks),
        name: String(first(summary, ['name']) || path.basename(file).replace(/\.nksf?$/i, '')),
        vendor: String(first(summary, ['vendor', 'author']) || ''),
        library: String(first(summary, ['bankchain', 'bank', 'product']) || ''),
        tags: (Array.isArray(types) ? types.flat() : []).filter(t => typeof t === 'string').slice(0, 20),
        comment: String(first(summary, ['comment']) || ''),
        state_bytes: Math.max(0, chunks.PCHK.length - 4),
    };
}

/**
 * The state that recalls this preset. The four-byte version prefix is dropped:
 * what a plugin wants is the chunk it wrote, not NKS's envelope around it.
 */
function presetState(file) {
    try {
        const { chunks } = riffChunks(fs.readFileSync(file));
        if (!chunks.PCHK) return { ok: false, reason: `${path.basename(file)} carries no plugin state (no PCHK chunk)` };
        return { ok: true, state: chunks.PCHK.subarray(4), envelope: 'nksf/PCHK' };
    } catch (err) {
        return { ok: false, reason: err.message };
    }
}

/** Every `.nksf` under a folder, shallow-first and bounded: a library is not a filesystem crawl. */
function findPresets(dir, { limit = 5000, maxDepth = 6 } = {}) {
    const out = [];
    const walk = (at, depth) => {
        if (out.length >= limit || depth > maxDepth) return;
        let entries = [];
        try { entries = fs.readdirSync(at, { withFileTypes: true }); } catch (_) { return; }
        for (const entry of entries) {
            if (out.length >= limit) return;
            const full = path.join(at, entry.name);
            if (entry.isDirectory()) walk(full, depth + 1);
            else if (/\.nksf?$/i.test(entry.name)) out.push(full);
        }
    };
    walk(dir, 0);
    return out;
}

module.exports = { CHUNKS, riffChunks, unpack, readPreset, presetState, findPresets };
