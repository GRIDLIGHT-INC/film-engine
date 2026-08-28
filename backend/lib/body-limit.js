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
const FILE_CARRYING_SEGMENTS = Object.freeze(['import', 'media']);

const JSON_LIMIT = 10 * 1024 * 1024;
const FILE_LIMIT = 150 * 1024 * 1024;   // base64-encoded Meshy GLBs can be large
const BUNDLE_LIMIT = 500 * 1024 * 1024;

function carriesFile(parts) {
    const list = Array.isArray(parts) ? parts : [];
    return list.length > 2 && FILE_CARRYING_SEGMENTS.includes(list[list.length - 1]);
}

function bodyLimitFor(parts) {
    return carriesFile(parts) ? FILE_LIMIT : JSON_LIMIT;
}

module.exports = { bodyLimitFor, carriesFile, FILE_CARRYING_SEGMENTS, JSON_LIMIT, FILE_LIMIT, BUNDLE_LIMIT };
