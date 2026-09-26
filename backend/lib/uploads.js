/**
 * A transfer that survives losing the connection.
 *
 * "A phone loses Wi-Fi mid-transfer and a restart from zero on a multi-gigabyte
 * file is a transfer that never completes." That is arithmetic rather than
 * pessimism: a 7GB ProRes take over a domestic connection is tens of minutes,
 * and every interruption costs the WHOLE transfer. Retrying from zero does not
 * converge however many times it is attempted.
 *
 * The base64 half of the task was already done — `readBody` takes raw bytes
 * when the content-type is media, so nothing inflates by a third any more. What
 * was missing is the half this is named for: a transfer that can be RESUMED, so
 * the ceiling stops being the length of an uninterrupted connection.
 *
 * THE SERVER HOLDS THE ONLY AUTHORITATIVE ANSWER to "how much do you have", and
 * that is what makes this safe. A client resuming from an offset it guessed
 * writes its bytes over the wrong part of the file: the transfer completes, the
 * size is right, and the middle is wrong. So an offset that is not exactly what
 * is on disk is REFUSED, and the refusal carries the true number so the client
 * can correct itself rather than guess again.
 *
 * ON DISK RATHER THAN IN A TABLE. A partial upload is transient state, not
 * project data — the same call `.waves`, the thumbnail cache and `deleted/`
 * already make. It survives a restart, which an in-memory map would not, and it
 * needs no migration to reclaim.
 *
 * NOTHING HERE WRITES THE FINAL FILE OR AN ASSET ROW. A completed transfer is
 * handed to `importMedia` exactly as a direct upload is, so the magic-byte
 * sniffing, the asset registration and the duration measurement all happen once
 * and in one place. "The bytes decide, never the name" is a rule this codebase
 * paid for, and the path built for the LARGEST files is the worst one to
 * exempt from it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DATA_DIR } = require('./file-storage');
const { MEDIA_IMPORTS } = require('./media-imports');

/** How long a transfer nobody has touched is kept before it can be swept. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const dir = () => path.join(DATA_DIR, 'uploads');

/*
 * The id IS the filename, so its shape is the containment.
 *
 * An id arrives from a request, which makes it exactly the same class of input
 * as the `file_path` that once turned a resource leak into a file-deletion
 * primitive. A strict hex shape refuses every traversal without needing to
 * reason about encodings — `..`, `a/b` and `..%2fx` are all simply not ids.
 * The resolve-and-contain below is defence in depth rather than the rule.
 */
const ID = /^[0-9a-f]{32}$/;

function pathsFor(id) {
    if (!ID.test(String(id || ''))) throw new Error(`unknown upload ${id}`);
    const base = path.join(dir(), id);
    const part = `${base}.part`;
    if (path.resolve(part) !== path.normalize(part) || !path.resolve(part).startsWith(path.resolve(dir()) + path.sep)) {
        throw new Error(`unknown upload ${id}`);
    }
    return { part, meta: `${base}.json` };
}

function readMeta(id) {
    const { part, meta } = pathsFor(id);
    if (!fs.existsSync(meta)) throw new Error(`unknown upload ${id}`);
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    /*
     * `received` is DERIVED from the file rather than stored beside it. A
     * counter and the bytes are two answers to one question, and the moment a
     * write is interrupted between them they disagree — which is precisely the
     * state this whole feature exists to recover from.
     */
    return { ...m, id, received: fs.existsSync(part) ? fs.statSync(part).size : 0 };
}

/** Open a transfer. Nothing is sent yet; this only agrees what is coming. */
function beginUpload(input) {
    const i = input || {};
    const total = Number(i.total_bytes);
    if (!Number.isInteger(total) || total <= 0) {
        throw new Error('invalid upload: total_bytes must be a positive whole number of bytes');
    }
    /*
     * The target is checked HERE, not at completion. A transfer that runs for
     * twenty minutes and is then told its destination does not exist has cost
     * the whole transfer to learn something knowable in the first millisecond —
     * the same reasoning that puts FCC-009's drive checks before the writer.
     */
    if (i.target !== undefined && i.target !== null && !MEDIA_IMPORTS[i.target]) {
        throw new Error(`unknown import target ${i.target}`);
    }

    fs.mkdirSync(dir(), { recursive: true });
    const id = crypto.randomBytes(16).toString('hex');
    const { part, meta } = pathsFor(id);
    fs.writeFileSync(part, Buffer.alloc(0));
    fs.writeFileSync(meta, JSON.stringify({
        total_bytes: total,
        mime: String(i.mime || 'application/octet-stream').split(';')[0].trim(),
        target: i.target || null,
        name: i.name || null,
        owner: i.owner || null,
        created_at: Date.now(),
    }));
    return { id, received: 0, total };
}

/** Where a transfer got to. The one question a resuming client asks. */
function uploadStatus(id) {
    const m = readMeta(id);
    return { id, received: m.received, total: m.total_bytes, mime: m.mime, target: m.target };
}

/**
 * Take the next piece — and only the next one.
 *
 * The offset is not advice. A chunk written anywhere but the end produces a
 * file of exactly the right length whose middle is wrong: it completes, it
 * validates, and it is broken in a way nothing downstream can see.
 */
function appendChunk(id, offset, chunk) {
    const m = readMeta(id);
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
    if (!bytes.length) throw new Error('invalid chunk: empty');

    const at = Number(offset);
    if (at !== m.received) {
        throw new Error(`wrong offset: this upload holds ${m.received} bytes, `
            + `and the chunk claims to start at ${at}. Resume from ${m.received}.`);
    }
    if (m.received + bytes.length > m.total_bytes) {
        throw new Error(`chunk is larger than declared: ${m.received + bytes.length} bytes would `
            + `exceed the ${m.total_bytes} this upload said it would send`);
    }

    const { part, meta } = pathsFor(id);
    fs.appendFileSync(part, bytes);
    // Touched, so a sweep can tell a live transfer from an abandoned one.
    const now = new Date();
    fs.utimesSync(meta, now, now);
    return { id, received: m.received + bytes.length, total: m.total_bytes };
}

/**
 * Close the transfer and hand the bytes on.
 *
 * REFUSES A SHORT FILE. A truncated upload finalised anyway produces a clip
 * that plays and ends early — the shape this codebase has already paid for
 * twice, where the file was perfectly valid and the missing part looked like a
 * decision.
 */
function completeUpload(id) {
    const m = readMeta(id);
    if (m.received !== m.total_bytes) {
        throw new Error(`upload is incomplete: ${m.received} of ${m.total_bytes} bytes arrived. `
            + `Resume from ${m.received} rather than finalising a truncated file.`);
    }
    const { part, meta } = pathsFor(id);
    const bytes = fs.readFileSync(part);
    fs.rmSync(part, { force: true });
    fs.rmSync(meta, { force: true });
    return { id, bytes, mime: m.mime, target: m.target, name: m.name, owner: m.owner };
}

/**
 * Close a finished transfer WITHOUT reading it: hand over the path of the
 * bytes on disk, for a destination that moves the file into place itself.
 *
 * `completeUpload` reads the whole file into memory, which is right for a
 * plate and wrong for an edit exported at ProRes — gigabytes that only need
 * to change directory. Same refusal of a short file; the caller owns the
 * returned path from here and must move or delete it.
 */
function claimUpload(id) {
    const m = readMeta(id);
    if (m.received !== m.total_bytes) {
        throw new Error(`upload is incomplete: ${m.received} of ${m.total_bytes} bytes arrived. `
            + `Resume from ${m.received} rather than finalising a truncated file.`);
    }
    const { part, meta } = pathsFor(id);
    const claimed = `${part}.claimed`;
    fs.renameSync(part, claimed);
    fs.rmSync(meta, { force: true });
    return { id, path: claimed, bytes: m.total_bytes, mime: m.mime, name: m.name, owner: m.owner };
}

/** Give up on a transfer and give the disk back. */
function abandonUpload(id) {
    const { part, meta } = pathsFor(id);
    fs.rmSync(part, { force: true });
    fs.rmSync(meta, { force: true });
    return { id, abandoned: true };
}

/**
 * Reclaim transfers nobody came back for.
 *
 * A phone that walks away mid-take leaves its partial file behind, and on
 * multi-gigabyte takes a handful of those fills a disk. Age is measured from
 * the last CHUNK rather than from creation, or a slow transfer over a poor
 * connection would be swept out from under itself.
 */
function sweepUploads(maxAgeMs = STALE_AFTER_MS) {
    const d = dir();
    if (!fs.existsSync(d)) return { swept: [] };
    const cutoff = Date.now() - maxAgeMs;
    const swept = [];
    for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.json')) continue;
        const id = f.slice(0, -'.json'.length);
        if (!ID.test(id)) continue;
        if (fs.statSync(path.join(d, f)).mtimeMs > cutoff) continue;
        abandonUpload(id);
        swept.push(id);
    }
    return { swept };
}

module.exports = {    claimUpload,
    beginUpload, appendChunk, uploadStatus, completeUpload, abandonUpload, sweepUploads,};
