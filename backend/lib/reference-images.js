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
function toDataUri(filePath) {
    if (!filePath) return null;
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_INLINE_BYTES) return null;
        const mime = MIME_BY_EXT[path.extname(filePath).toLowerCase()];
        if (!mime) return null;
        return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
    } catch (_) {
        return null;
    }
}

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
 * A viewer notices a different face long before a different porch, so identity
 * leads and always has. The scene anchor sits between identity and place
 * because it is a photograph of THIS scene as generated — same hour, same
 * weather, same grade — where the location plate is a photograph of the place
 * in the abstract. When both want the last slot the specific one wins, and the
 * anchor already contains the location, rendered.
 *
 * Everything below the anchor moved down one. The RELATIVE order is untouched,
 * so a project with no anchor selects exactly the references it selected
 * before — which is what makes this safe to add to a shipped board.
 */
const KIND_RANK = { character: 0, anchor: 1, location: 2, prop: 3, style: 4 };

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
    const limit = Math.min(opts.limit || MAX_REFERENCES, MAX_REFERENCES);

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
        out.push({ uri, tag, name: c.name, kind: c.kind });
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
