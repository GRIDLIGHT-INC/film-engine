/**
 * How large a request body a path is allowed to carry.
 *
 * Its own module because `server.js` calls start() at import — requiring it to
 * read one function would boot a listener — and because this is a rule, not a
 * branch: the same reasoning that gave `lib/media-kinds.js` a home.
 *
 * DERIVED FROM THE URL SHAPE, never a list of endpoints, because that list
 * rots. The four plate and mood-board imports added after the original list
 * would each have inherited the 10MB JSON default and refused a normal
 * photograph, and the failure surfaces as a destroyed connection rather than a
 * message.
 *
 * `media` sits beside `import` for exactly that reason. A style-book visual is
 * posted to /film/style-book/:id/media — which ends in `media`, not `import` —
 * so it inherited 10MB, and a 4K frame grab, the normal case for a shot
 * reference, base64-encodes well past that. Refused, it reaches the page as a
 * network error, which api() reports as "Backend offline": indistinguishable
 * from a dead server, on the one feature where large files are the point.
 */

/** Last path segments that mean "this request carries a file". */
// `stems` is a batch of audio files posted to a score session
// (/film/music-sessions/:id/stems): a 24-bit 48 kHz stereo minute is ~17MB
// raw, so a handful of stems clears the JSON default on the first real cue.
const FILE_CARRYING_SEGMENTS = Object.freeze(['import', 'media', 'stems']);

const JSON_LIMIT = 10 * 1024 * 1024;
/*
 * One PIECE of a resumable transfer, not a whole file.
 *
 * A chunk path ends in a session id, so it matched neither `import` nor `media`
 * and fell into the JSON default. Ten megabytes happens to be a sensible chunk
 * — but by accident, and this module's whole doctrine is that a ceiling is
 * derived from the shape rather than fallen into.
 *
 * Deliberately far below FILE_LIMIT: a chunk is meant to be small, so that
 * losing one to a dropped connection costs seconds rather than minutes. A
 * 150MB piece would defeat the granularity the transfer exists for.
 */
const CHUNK_LIMIT = 16 * 1024 * 1024;
const FILE_LIMIT = 150 * 1024 * 1024;   // base64-encoded Meshy GLBs can be large
const BUNDLE_LIMIT = 500 * 1024 * 1024;

function carriesFile(parts) {
    const list = Array.isArray(parts) ? parts : [];
    return list.length > 2 && FILE_CARRYING_SEGMENTS.includes(list[list.length - 1]);
}

function bodyLimitFor(parts) {
    return carriesFile(parts) ? FILE_LIMIT : JSON_LIMIT;
}

/**
 * The whole rule, bundle branch included.
 *
 * `server.js` composed this inline as `isBundleImport ? BUNDLE : bodyLimitFor`,
 * which made the real ceiling a two-part expression living outside the module
 * that owns it — and left the page with nothing single to mirror. A client
 * ceiling that disagrees with the server's is worse than none: it refuses a
 * file the server would have taken.
 */
function limitForPath(parts) {
    const list = Array.isArray(parts) ? parts : [];
    const isBundleImport = list[1] === 'projects' && list[2] === 'import';
    if (isBundleImport) return BUNDLE_LIMIT;
    // A piece of a resumable transfer, which is neither a JSON body nor a
    // whole file. Named by shape like everything else here.
    if (list[1] === 'uploads' && list[2]) return CHUNK_LIMIT;
    return bodyLimitFor(list);
}

module.exports = {
    bodyLimitFor, limitForPath, carriesFile,
    FILE_CARRYING_SEGMENTS, JSON_LIMIT, FILE_LIMIT, BUNDLE_LIMIT, CHUNK_LIMIT,
};
