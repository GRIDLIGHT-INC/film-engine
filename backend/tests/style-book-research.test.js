/**
 * The style book: does the design cover everything it touches?
 *
 * A director's style book — named shots, camera details, reference stills and
 * clips — is only useful if it reaches the places a shot is actually decided.
 * This test does not check that the feature is BUILT. It checks that the
 * research document names every surface the feature must touch, and that the
 * set is DERIVED FROM CODE rather than from the request.
 *
 * That distinction is the whole point. The request says "leverage this in any
 * section, moodboard or even when generating a shot" — three surfaces named
 * loosely. The code says there are ten camera facets, eight mood-board specs,
 * two prompt builders and a previs stage, and a design that covers the three
 * named ones is the half-done fix this standard exists to prevent.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DOC = path.join(__dirname, '..', '..', 'docs', 'plans', 'style-book-research.md');

function doc() {
    assert.ok(fs.existsSync(DOC), `the research document does not exist at ${DOC}`);
    return fs.readFileSync(DOC, 'utf8');
}

/** Every camera facet a shot carries — what a style-book entry must be able to set. */
function cameraFacets() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'scene-card-schema.js'), 'utf8');
    return [...new Set([...src.matchAll(/card\.camera\.([a-z_]+)/g)].map(m => m[1]))];
}

/** Where a look already lands, so the design cannot invent a ninth channel. */
function specKinds() {
    return Object.keys(require('../lib/look-development').SPEC_KINDS);
}

/** What a reference can BE — the entry's visuals. */
function mediaKinds() {
    return Object.keys(require('../lib/media-kinds').MEDIA_KINDS || {});
}

/** The top-bar rail the request asks for a button in. */
function railIds() {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    const at = html.indexOf('var RAIL = [');
    assert.notStrictEqual(at, -1, 'the rail registry is gone');
    const block = html.slice(at, html.indexOf('];', at));
    return [...block.matchAll(/id:'([a-z]+)'/g)].map(m => m[1]);
}

test('the document exists and is a research deliverable, not a stub', () => {
    const d = doc();
    assert.ok(d.length > 4000, `the document is ${d.length} characters — that is a stub, not research`);
    for (const heading of ['Prior art', 'Trade-off', 'Recommendation']) {
        assert.ok(new RegExp(heading, 'i').test(d), `the document has no "${heading}" section`);
    }
});

test('every camera facet a shot carries is accounted for', () => {
    /*
     * A style-book entry that can name a lens but not an aperture, a height or
     * a sensor is a note, not something a shot can be generated from. Derived
     * from the schema so a facet added later is in the denominator.
     */
    const d = doc();
    const missing = cameraFacets().filter(f => !d.includes(f));
    assert.deepStrictEqual(missing, [],
        `the design does not say what a style-book entry does with: ${missing.join(', ')}`);
});

test('every mood-board spec kind is accounted for', () => {
    // The board is the existing answer to "the look of this film". A style book
    // that ignores it is a second, competing answer — which is exactly how the
    // codebase ended up with two paginators and three prop-category lists.
    const d = doc();
    const missing = specKinds().filter(k => !d.includes(k));
    assert.deepStrictEqual(missing, [],
        `the design does not reconcile with these board specs: ${missing.join(', ')}`);
});

test('the visuals an entry can hold are named, pictures AND video', () => {
    // "always have pictures or even videos" — and the engine already has a
    // registry of what a media file can be.
    const d = doc();
    for (const kind of ['image', 'video']) {
        assert.ok(mediaKinds().includes(kind), `media-kinds no longer registers ${kind}`);
        assert.ok(new RegExp(`\\b${kind}\\b`).test(d), `the design never says what an entry does with ${kind}`);
    }
});

test('the way in is placed against the real rail, not an imagined one', () => {
    const d = doc();
    const ids = railIds();
    assert.ok(ids.length >= 5, `the rail has ${ids.length} entries — the registry is not being read`);
    assert.ok(d.includes('RAIL'), 'the design does not say where the button goes in the rail registry');
    // "before terms" — the design must name the neighbour it sits beside.
    assert.ok(ids.some(id => d.includes(id)),
        `the design names no existing rail entry to sit beside: ${ids.join(', ')}`);
});

test('the storage decision is grounded in an existing precedent', () => {
    /*
     * A style book is the DIRECTOR's, not a project's — and every reference
     * collection in this codebase (mood board, continuity, bible, marketing)
     * is `project_id NOT NULL`. Exactly one thing here already solves
     * "save it once, reuse it across every project", and the design has to
     * either follow it or say why not.
     */
    const d = doc();
    assert.match(d, /project_id IS NULL|library flow|film_flows/,
        'the design does not reckon with the flows library, the one existing cross-project precedent');
    assert.match(d, /film_mood_board|film_continuity_refs|film_story_bible/,
        'the design does not compare against the project-scoped collections it resembles');
});

test('agent reachability is addressed, because that is how this pipeline is driven', () => {
    // The standing rabbit hole: use MCP wherever we can for AI queries. A
    // style book an agent cannot read is one that cannot reach a generation
    // the agent is composing.
    const d = doc();
    assert.match(d, /MCP/, 'the design never says how an agent reaches the style book');
});

test('the prompt builders that would consume an entry are named', () => {
    // Where a style-book entry would actually change a picture. Both, because
    // a design covering the storyboard and not the clip is the split that has
    // already cost this codebase twice.
    const d = doc();
    for (const builder of ['buildStoryboardPrompt', 'buildVideoPrompt']) {
        assert.ok(d.includes(builder), `the design does not say how an entry reaches ${builder}`);
    }
});
