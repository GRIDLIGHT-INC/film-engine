/**
 * OSC 1.0, THE SUBSET ABLETONOSC SPEAKS: A MESSAGE CODEC AND NOTHING ELSE.
 *
 * MUS-017. Types i (int32), f (float32), s (string), b (blob) and the
 * argument-less T, F and N — every type AbletonOSC sends or accepts. Every
 * field is padded to four bytes, as the specification requires. Written here
 * rather than taken from a package because the whole codec is smaller than
 * the dependency that would carry it (ADR-002).
 *
 * A packet that is not well formed is refused, never guessed at: a reply
 * read wrongly is a track name or a tempo that is silently wrong, and the
 * sidecar would then confirm a mutation against a value Live never sent.
 * Bundles are refused too — AbletonOSC does not send them, so one arriving is
 * something other than AbletonOSC.
 */

const pad4 = n => (n + 3) & ~3;

function str(s) {
    const raw = Buffer.from(String(s), 'utf8');
    const out = Buffer.alloc(pad4(raw.length + 1));
    raw.copy(out);
    return out;
}

/** Tag one argument. A plain number is an int when it is a whole int32, else a float; `{ type, value }` says which. */
function tagOf(a) {
    if (a && typeof a === 'object' && !Buffer.isBuffer(a) && 'type' in a) return [a.type, a.value];
    if (a === true) return ['T'];
    if (a === false) return ['F'];
    if (a === null) return ['N'];
    if (Buffer.isBuffer(a)) return ['b', a];
    if (typeof a === 'string') return ['s', a];
    if (typeof a === 'number' && Number.isFinite(a)) return [Number.isInteger(a) && a >= -2147483648 && a <= 2147483647 ? 'i' : 'f', a];
    throw new Error(`osc: cannot encode an argument of type ${typeof a}`);
}

function encode(address, args) {
    if (typeof address !== 'string' || !address.startsWith('/') || /[\s#*?,[\]{}]/.test(address)) throw new Error(`osc: '${address}' is not an OSC address (it must start with / and hold no pattern characters)`);
    let tags = ',';
    const parts = [];
    for (const a of args || []) {
        const [t, v] = tagOf(a);
        tags += t;
        if (t === 'i') { const b = Buffer.alloc(4); b.writeInt32BE(v); parts.push(b); }
        else if (t === 'f') { const b = Buffer.alloc(4); b.writeFloatBE(v); parts.push(b); }
        else if (t === 's') parts.push(str(v));
        else if (t === 'b') { const len = Buffer.alloc(4); len.writeInt32BE(v.length); const body = Buffer.alloc(pad4(v.length)); v.copy(body); parts.push(len, body); }
        else if (!['T', 'F', 'N'].includes(t)) throw new Error(`osc: type '${t}' is not one this codec speaks`);
    }
    return Buffer.concat([str(address), str(tags), ...parts]);
}

function readStr(buf, at) {
    const end = buf.indexOf(0, at);
    if (end < 0) throw new Error('osc: malformed packet: a string has no terminator');
    const next = pad4(end + 1);
    if (next > buf.length) throw new Error('osc: malformed packet: a string runs past the end');
    return [buf.toString('utf8', at, end), next];
}

function decode(buf) {
    if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length % 4 !== 0) throw new Error('osc: malformed packet: its length is not a multiple of four');
    if (buf[0] !== 0x2f) {
        if (buf.toString('utf8', 0, 7) === '#bundle') throw new Error('osc: bundles are not something AbletonOSC sends; refused');
        throw new Error('osc: malformed packet: the address does not start with /');
    }
    let [address, at] = readStr(buf, 0);
    if (at >= buf.length || buf[at] !== 0x2c) throw new Error('osc: malformed packet: no type tag string');
    let tags;
    [tags, at] = readStr(buf, at);
    const args = [];
    for (const t of tags.slice(1)) {
        if (t === 'i' || t === 'f') {
            if (at + 4 > buf.length) throw new Error(`osc: malformed packet: an '${t}' argument runs past the end`);
            args.push(t === 'i' ? buf.readInt32BE(at) : buf.readFloatBE(at)); at += 4;
        } else if (t === 's') { let s; [s, at] = readStr(buf, at); args.push(s); }
        else if (t === 'b') {
            if (at + 4 > buf.length) throw new Error('osc: malformed packet: a blob has no size');
            const n = buf.readInt32BE(at); at += 4;
            if (n < 0 || at + n > buf.length) throw new Error('osc: malformed packet: a blob runs past the end');
            args.push(Buffer.from(buf.subarray(at, at + n))); at += pad4(n);
        } else if (t === 'T') args.push(true);
        else if (t === 'F') args.push(false);
        else if (t === 'N') args.push(null);
        else throw new Error(`osc: malformed packet: type tag '${t}' is not one this codec speaks`);
    }
    return { address, args };
}

module.exports = { encode, decode };
