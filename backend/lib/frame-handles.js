/**
 * A FRAME THE PROVIDER CAN FETCH.
 *
 * RBF-001 was asked one question and answered two. The verdict was
 * `style-references`; the other finding was that the request cannot be made at
 * all without this. `images_list` refuses data URIs — `URL scheme should be
 * 'http' or 'https'` — and every other reference in this codebase travels as
 * base64, so that road is closed. Film Engine serves media locally, and a
 * provider cannot reach a local address.
 *
 * THIS HANDS LOCAL FILES TO AN EXTERNAL SERVICE, so the shape matters more than
 * the feature. The precedent is close and was expensive: `addMedia` took a
 * `file_path` from a request body verbatim, and the day a delete was wired up
 * that unvalidated input became a file-deletion primitive. The lesson recorded
 * there is that closing a "nothing happens" bug can PROMOTE an unvalidated
 * input into an action.
 *
 * So a handle is an OPAQUE ID resolved against a server-side map — never a
 * signed path, never an encoded one. A caller cannot express a path at all,
 * which removes traversal as a category rather than defending against it. What
 * is mintable is decided here, once, from a path this process resolved itself.
 *
 * IN MEMORY, DELIBERATELY. Handles live minutes and a restart losing them is
 * the right outcome: a URL that outlives the process that issued it is a URL
 * nobody is tracking. No table, no migration, and nothing to clean up.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isOwnedPath } = require('./file-storage');

/**
 * Long enough for a provider to fetch and retry, short enough that a URL left
 * in a log is worthless by the time anybody reads it.
 */
const HANDLE_TTL_MS = 15 * 60 * 1000;

const HANDLE_REFUSALS = Object.freeze([
    { code: 'no_public_base', why: 'without an address that reaches this machine there is no URL to '
        + 'give, and handing out a localhost one buys a provider-side fetch failure that reads as a '
        + 'credential fault' },
    { code: 'bad_public_base', why: 'a provider fetches over http(s); anything else is a setting that '
        + 'cannot work, and file:// would be an instruction to read the provider\'s own disk' },
    { code: 'path_outside_data', why: 'only files this engine already stores may be handed out — '
        + 'anything else turns a serving route into an arbitrary file read' },
    { code: 'no_file', why: 'a handle to nothing produces a 404 at the provider, which reads as our '
        + 'service being broken rather than the frame being absent' },
    { code: 'handle_unknown', why: 'an id nobody minted, or one already revoked' },
    { code: 'handle_expired', why: 'past its window; a URL that works forever is a URL that leaks' },
]);

const refuse = (code, reason) => ({ ok: false, code, reason });

/** id -> { path, scope, expiresAt }. Opaque in, absolute path out. */
const store = new Map();

function sweep(now) {
    for (const [id, h] of store) if (h.expiresAt <= now) store.delete(id);
}

/**
 * The address a provider would reach this machine on.
 *
 * NOT GUESSED. `location.hostname` works for a browser on the LAN and means
 * nothing to a service on the internet, and there is no way to discover a
 * tunnel or a proxy from inside the process. An operator states it or there is
 * no answer.
 */
function publicBase(explicit) {
    const raw = explicit !== undefined ? explicit : (process.env.FILM_ENGINE_PUBLIC_URL || '');
    return String(raw || '').trim().replace(/\/+$/, '');
}

/**
 * Mint a handle for a file this engine stores. Never throws.
 */
function mintHandle(filePath, opts) {
    const o = opts || {};
    const base = publicBase(o.publicBase);
    if (!base) {
        return refuse('no_public_base',
            'This provider fetches reference images over http(s) and cannot reach a local address, '
            + 'so there is no URL to give it. Set FILM_ENGINE_PUBLIC_URL to an address that reaches '
            + 'this machine from outside — a tunnel or a reverse proxy in front of the API. Until '
            + 'then a repair can be planned but not generated.');
    }
    let parsed;
    try { parsed = new URL(base); } catch (_) { parsed = null; }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
        return refuse('bad_public_base',
            `FILM_ENGINE_PUBLIC_URL is "${base}", which is not an http or https address. A provider `
            + 'fetches over http(s); anything else cannot be fetched at all.');
    }

    if (typeof filePath !== 'string' || !filePath) {
        return refuse('path_outside_data', 'no file was given to hand out');
    }
    /*
     * REAL-PATHED ON BOTH SIDES, and the nearest existing ancestor is resolved
     * for a path that may not exist yet. On macOS /var is a symlink to
     * /private/var, so comparing a resolved target against an unresolved root
     * refuses every legitimate file — and makes the check appear to work while
     * doing nothing, since everything then looks outside. Recorded once already
     * in the style-book path work; not repeated here.
     */
    // Ours: under the data folder, or under a folder a project chose.
    if (!isOwnedPath(filePath)) {
        return refuse('path_outside_data',
            'that file is not one this engine stores, and only stored media may be handed to a provider');
    }
    let stat = null;
    try { stat = fs.statSync(filePath); } catch (_) { stat = null; }
    if (!stat || !stat.isFile()) {
        return refuse('no_file', `there is no file at ${path.basename(filePath)} to hand out`);
    }

    const now = Date.now();
    sweep(now);
    /*
     * 128 bits from the CSPRNG. The id is the only thing standing between the
     * internet and this file for the life of the handle, so it is not a
     * counter, not a hash of the path, and not derived from anything a caller
     * can see — all three of which would make one handle predict another.
     */
    const id = crypto.randomBytes(16).toString('hex');
    const ttl = Number(o.ttlMs) > 0 ? Number(o.ttlMs) : HANDLE_TTL_MS;
    const expiresAt = now + ttl;
    store.set(id, { path: filePath, scope: o.scope || null, expiresAt });

    return { ok: true, id, url: `${base}/film/frame-handle/${id}`, expiresAt, scope: o.scope || null };
}

/** The file a handle names, or why not. Never throws. */
function resolveHandle(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) {
        /*
         * DEFENCE IN DEPTH, and stated as such because it is not what stops an
         * attack: the Map lookup already returns undefined for a path, so
         * removing this check is behaviourally invisible today — a mutation
         * proved it. It is kept for what it guards against LATER: a store
         * changed from a Map to a plain object would make `__proto__` and
         * `constructor` meaningful keys, and an unbounded id would become an
         * unbounded lookup. Claiming it as the boundary would be a lie; keeping
         * it costs one regex.
         */
        return refuse('handle_unknown', 'that is not a handle this engine issued');
    }
    const h = store.get(id);
    if (!h) return refuse('handle_unknown', 'that handle is not known, or has already been revoked');
    if (h.expiresAt <= Date.now()) {
        store.delete(id);
        return refuse('handle_expired', 'that handle has expired; plan the repair again to mint a new one');
    }
    return { ok: true, path: h.path, scope: h.scope, expiresAt: h.expiresAt };
}

/**
 * Drop every handle for one plan.
 *
 * Scoped rather than global: a director cancelling one repair must not break
 * another that is mid-fetch. "The frames of one plan, not the media tree" is
 * the acceptance criterion, and this is the half of it that ends early.
 */
function revokeScope(scope) {
    if (!scope) return 0;
    let n = 0;
    for (const [id, h] of store) if (h.scope === scope) { store.delete(id); n += 1; }
    return n;
}

module.exports = {
    mintHandle, resolveHandle, revokeScope, publicBase,
    HANDLE_TTL_MS, HANDLE_REFUSALS,
};
