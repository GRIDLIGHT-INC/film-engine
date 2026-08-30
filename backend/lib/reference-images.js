/**
 * Tagged reference images: continuity by picture rather than by paragraph.
 *
 * The problem this replaces. A screenplay upload creates character and location
 * rows that are name skeletons, so every keyframe invented its own Maya on its
 * own street. Filling those rows with prose helped and immediately hit a second
 * wall: Runway caps text_to_image at ~1000 characters, and a described
 * character plus a described location plus an auteur style runs past 2,000
 * before the shot action is added. Compressing the prose is a treadmill — and
 * the thing being compressed is precisely the continuity information.
 *
 * A reference image ends the treadmill. `gen4_image` takes up to THREE
 * `{ uri, tag }` references and lets the prompt name them: "@maya looks up at
 * the sky above @street". The picture is the description, so the prompt drops
 * from ~700 characters of wardrobe and architecture to ~150, and the identity
 * is exact rather than approximate.
 *
 * Three constraints shape everything here:
 *
 *  - **Three references, maximum.** Every shot has to choose. Characters
 *    present in the shot outrank the location, which outranks everything else,
 *    because a viewer notices a different face long before a different porch.
 *  - **The provider cannot read our disk.** Assets live at
 *    data/refsheets/{project}/… and Runway can only fetch a public URL — so
 *    local files are inlined as base64 data URIs, which it accepts.
 *  - **Tags must be prompt-safe.** They are substituted into prompt text, so a
 *    tag is lowercase alphanumeric; "MAYA" and "Maya Chen" both become `maya`.
 */

const fs = require('fs');
const path = require('path');

/** gen4_image accepts 1–3. Sending more is a validation failure, not a truncation. */
const MAX_REFERENCES = 3;

/** Inlining is cheap up to a point; past it the request itself gets unwieldy. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

const MIME_BY_EXT = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
};

/**
 * A tag the prompt can carry.
 *
 * Runway matches `@tag` in prompt text, so anything that is not a bare word
 * would break substitution. Collisions are the caller's problem to resolve —
 * `assignTags` handles that, because only it can see the whole set.
 */
function toTag(name) {
    const slug = String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .slice(0, 24);
    return slug || null;
}

/**
 * Unique tags across a set of names.
 *
 * Two characters called "Maya Chen" and "Maya Diaz" both slug to `maya`, and a
 * duplicate tag would silently make one reference shadow the other — the exact
 * failure mode this module exists to prevent, reintroduced one level down.
 */
function assignTags(names) {
    const used = new Set();
    const out = new Map();
    for (const name of names || []) {
        const base = toTag(name);
        if (!base) continue;
        let tag = base;
        let n = 2;
        while (used.has(tag)) tag = `${base}${n++}`;
        used.add(tag);
        out.set(name, tag);
    }
    return out;
}

/**
 * Local file -> data URI.
 *
 * Returns null rather than throwing: a missing plate should cost a shot its
 * reference, not fail the whole batch. The caller decides whether it can
 * proceed without it.
 */
/*
 * A small, bounded cache of encoded plates.
 *
 * Measured on the real project: the staleness report took SIX SECONDS while
 * every other call took 2-10ms. "The payload IS the fingerprint" is the right
 * decision and this is its cost — building an image payload inlines every
 * reference plate, so fingerprinting 76 keyframes read 19 distinct files 314
 * times and moved 487MB off disk for one JSON report. MAYA_front.png alone was
 * read 61 times, each read followed by base64-encoding a megabyte.
 *
 * A CACHE rather than a cheaper formula. Weakening the fingerprint would mark
 * every existing artefact stale — the "warning you cannot act on" this codebase
 * has already paid for — so the same bytes still produce the same hash and only
 * the reading is avoided.
 *
 * KEYED ON WHAT THE FILESYSTEM SAYS, never on the path alone. A plate is
 * written to the same per-view filename and OVERWRITES, so a path is not an
 * identity: cached on it, a regenerated plate would fingerprint as its old self
 * and the staleness report would go quietly wrong — worse than slow, because it
 * is the report that says whether anything is out of date.
 *
 * Bounded, because a server runs for days and an unbounded cache of megabyte
 * strings is a memory leak that looks like a performance fix. Oldest out first;
 * the working set of one report is a handful of plates.
 */
const DATA_URI_CACHE = new Map();
const DATA_URI_CACHE_MAX = 24;

function toDataUri(filePath) {
    if (!filePath) return null;
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_INLINE_BYTES) return null;
        const mime = MIME_BY_EXT[path.extname(filePath).toLowerCase()];
        if (!mime) return null;

        // mtime AND size: a regeneration changes both, and a filesystem with a
        // coarse mtime cannot hide a change of length.
        const key = `${filePath}|${stat.size}|${stat.mtimeMs}`;
        const hit = DATA_URI_CACHE.get(key);
        if (hit !== undefined) {
            // Re-inserted so the most recently used survives eviction.
            DATA_URI_CACHE.delete(key);
            DATA_URI_CACHE.set(key, hit);
            return hit;
        }

        const uri = `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
        DATA_URI_CACHE.set(key, uri);
        while (DATA_URI_CACHE.size > DATA_URI_CACHE_MAX) {
            DATA_URI_CACHE.delete(DATA_URI_CACHE.keys().next().value);
        }
        return uri;
    } catch (_) {
        return null;
    }
}

/** For tests, and for anything that needs a cold read. */
function clearDataUriCache() { DATA_URI_CACHE.clear(); }
function dataUriCacheSize() { return DATA_URI_CACHE.size; }

/** An http(s) URL is already reachable; anything else needs inlining. */
function resolveUri(ref) {
    const direct = ref && (ref.uri || ref.url);
    if (typeof direct === 'string' && /^https?:\/\//i.test(direct)) return direct;
    if (typeof direct === 'string' && direct.startsWith('data:')) return direct;
    return toDataUri((ref && (ref.file_path || ref.path)) || direct || null);
}

/**
 * Choose which references a shot gets, and in what order.
 *
 * Priority is deliberate and not configurable, because the ranking is a
 * statement about what continuity means: identity first, place second,
 * everything else after. `candidates` entries are
 * `{ name, kind, file_path|uri, priority? }` where kind is
 * 'character' | 'location' | 'prop' | 'style'.
 */
/**
 * With three slots, what gets in.
 *
 * A viewer notices a different face long before a different porch, so among
 * the plates identity leads and always has.
 *
 * The scene anchor leads all of them, because it is not a plate. It is the
 * scene itself, already rendered — the location, the dressing and the subjects
 * in the positions they ended up in — and the new shot is a different camera
 * pointed at it. A plate says what a subject looks like in the abstract; the
 * anchor has already answered that for every subject in it, in situ and lit
 * the way the scene is lit. Ranking it behind the plates would spend the slots
 * re-establishing what the first reference already fixed.
 *
 * The plates the anchor makes redundant are dropped before selection (see
 * subjectsCoveredBy), so this does not push a subject out — it frees slots for
 * the subjects the anchor does NOT show, which are the ones that still need
 * one.
 *
 * Relative order among the plates is untouched, so a project with no anchor
 * selects exactly the references it selected before.
 */
const KIND_RANK = { anchor: 0, character: 1, location: 2, prop: 3, style: 4 };

/**
 * Where each kind of reference comes from.
 *
 * `entity` kinds are subjects with a table, a plate generator and a
 * film_assets column linking the plate to the row. The other two are not, and
 * saying so here is what stops a test deriving "every subject kind" from
 * KIND_RANK and then demanding a props table for the scene anchor:
 *
 *  - `frame`   — a keyframe already generated for a shot in this scene. It has
 *                no subject and no plate; it IS the output of one.
 *  - `project` — the look, which lives as free text on film_projects and as
 *                mood-board images. No table of its own by design.
 */
const KIND_SOURCE = {
    character: 'entity',
    anchor: 'frame',
    location: 'entity',
    prop: 'entity',
    style: 'project',
};

function selectReferences(candidates, options) {
    const opts = options || {};
    /*
     * The provider's ceiling, not a constant.
     *
     * This clamped every caller back to MAX_REFERENCES, so a provider taking
     * five got three — and MAX_REFERENCES is RUNWAY's documented limit for
     * gen4_image, chosen as "the strictest of the providers wired here" and
     * then applied to all of them. On a five-subject shot that silently dropped
     * the last two plates before the request was built: the car came back a
     * modern saloon and the bag came back generic, not because conditioning
     * failed but because their pictures were never sent.
     *
     * Same defect the prompt ceiling already had, one level over. An absent
     * limit still falls back to the strict default — never to unlimited, since
     * over-sending produces a rejection at the provider, which is worse than
     * trimming here where it can be reported.
     */
    const limit = Number.isFinite(opts.limit) && opts.limit > 0
        ? Math.floor(opts.limit)
        : MAX_REFERENCES;

    const ranked = (candidates || [])
        .filter(c => c && c.name)
        .map((c, i) => ({ ...c, _rank: KIND_RANK[c.kind] ?? 9, _i: i }))
        .sort((a, b) => (a._rank - b._rank) || (a._i - b._i));

    const tags = assignTags(ranked.map(c => c.name));
    const out = [];
    for (const c of ranked) {
        if (out.length >= limit) break;
        const uri = resolveUri(c);
        if (!uri) continue;                    // unreadable plate — skip, don't fail
        const tag = tags.get(c.name);
        if (!tag) continue;
        /*
         * `view` rides along when the candidate has one. A location now has
         * several plates and the shot picks the one it is pointed at — so
         * "SUBURBAN STREET" is no longer enough to say WHICH half of the street
         * the model was shown, which is the whole point of having views. Only
         * set when present, so nothing else changes shape.
         */
        out.push({ uri, tag, name: c.name, kind: c.kind, ...(c.view ? { view: c.view } : {}) });
    }
    return out;
}

/**
 * Which of a shot's subjects are covered by a reference.
 *
 * The prompt builder needs this to decide, per subject, between "@maya" and a
 * paragraph describing her — carrying both wastes the character budget on
 * information the picture already supplies.
 */
function taggedNames(references) {
    const map = new Map();
    for (const ref of references || []) {
        if (ref && ref.name && ref.tag) map.set(String(ref.name).toUpperCase(), ref.tag);
    }
    return map;
}

module.exports = {
    clearDataUriCache,
    dataUriCacheSize,
    MAX_REFERENCES,
    MAX_INLINE_BYTES,
    toTag,
    assignTags,
    toDataUri,
    resolveUri,
    selectReferences,
    taggedNames,
    KIND_RANK,
    KIND_SOURCE,
};
