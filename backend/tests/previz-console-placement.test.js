/**
 * DOES THE CONSOLE DRAW WHAT THE DESIGN DRAWS, AND IN THE RIGHT COLUMN?
 *
 * `world-console.test.js` is green at 14 tests, every one of them behavioural —
 * overlays toggle, lenses derive their FOV, measurements resolve. Not one of
 * them can see whether a REGION renders, or where. That is exactly the
 * blindness that let the character, location and prop sheets ship visibly
 * wrong against 70 passing tests: those checked PRESENCE of elements and
 * declarations, and the complaint was about ORDER, COLUMN and SIZE, which
 * nothing measured.
 *
 * THE DENOMINATOR IS THE DESIGN'S OWN HEADINGS. Fourteen regions, parsed out
 * of design_handoff_world_engine_previz/README.md between "Screens / Views"
 * and "Interactions & Behavior". A list typed here would be as complete as the
 * afternoon it was written, and the region added to the design next is exactly
 * the one that would be missed.
 *
 * THE COLUMNS ARE DERIVED TOO, from the layout section's own sentences —
 * "Center column contents, in order" and "Right column contents, in order".
 * Nothing about placement is my reading of the design.
 *
 * WHAT IT MEASURED WHEN IT WAS WRITTEN, before a single region was built:
 * SIX of the fourteen render — Header bar, Camera View, Camera Movement, Lens,
 * and the two modals — and EIGHT do not. The epic predicted seven; it was one
 * out, and the extra one is almost certainly a right-column panel the console
 * carries that the design does not draw at all (Measurements, Generation Risk
 * and Handover are product features added after the handoff, not regions of
 * it). The number is recomputed on every run rather than asserted, so the next
 * reader gets a current figure instead of this sentence.
 *
 * HOW PLACEMENT IS MEASURED WITHOUT A DOM. There is no jsdom and no bundler
 * here (ADR-002), so a rendered-DOM assertion is unavailable. What IS available
 * is better than the source-scan fallback the sheets had to use: the console is
 * built by a pure template function, so this EXECUTES it and reads column
 * membership out of the HTML it actually produces. A region that is
 * conditionally omitted is genuinely absent from that string, which a source
 * scan cannot tell.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const DESIGN = fs.readFileSync(
    path.join(ROOT, 'design_handoff_world_engine_previz', 'README.md'), 'utf8');

/* ── the denominator, from the design's own headings ────────────────────── */

const slug = (s) => s.toLowerCase()
    .replace(/\(.*?\)/g, ' ')          // "(hero panel)", "(206px)", "(right column)"
    .replace(/[—–-].*$/, ' ') // "Left rail — Shots" -> "Left rail"
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function designRegions() {
    const from = DESIGN.indexOf('## Screens / Views');
    const to = DESIGN.indexOf('## Interactions & Behavior');
    assert.ok(from > -1 && to > from, 'the design no longer has a Screens section; re-derive this');
    return DESIGN.slice(from, to).split('\n')
        .filter(l => l.startsWith('### '))
        .map(l => l.slice(4).trim())
        // "Screen: Previz / Shot Design Console" is the screen itself, not a region in it.
        .filter(h => !/^Screen:/.test(h))
        .map(h => ({ heading: h, slug: /^Modal:/.test(h) ? slug(h.replace(/^Modal:\s*/, '')) : slug(h),
                     modal: /^Modal:/.test(h) }));
}

/**
 * Which column each region belongs to, read out of the layout section rather
 * than decided here. The design states the centre and right columns as ordered
 * sentences; the rail and the full-width strips are stated in the numbered
 * layout list.
 */
function designColumns() {
    const centre = /Center column contents[^\n]+/.exec(DESIGN);
    const right = /Right column contents[^\n]+/.exec(DESIGN);
    assert.ok(centre && right, 'the layout sentences naming the column contents are gone');

    /*
     * AFTER THE LAST COLON, not the first. The sentence carries `gap: 12px`
     * inside it, so a lazy `[^:]*:` stops in the middle of the CSS and the
     * first region comes out slugged as "12px-camera-view" — which reads as
     * the design not placing Camera View anywhere.
     */
    const listed = (m) => m[0].slice(m[0].lastIndexOf(':') + 1)
        .split(/→|·/).map(s => slug(s.replace(/panel/i, ''))).filter(Boolean);
    const out = {};
    for (const s of listed(centre)) out[s] = 'center';
    for (const s of listed(right)) out[s] = 'right';

    for (const r of designRegions()) {
        if (r.modal) { out[r.slug] = 'modal'; continue; }
        if (out[r.slug]) continue;
        if (/^Left rail/.test(r.heading)) { out[r.slug] = 'left'; continue; }
        if (/full width/i.test(r.heading) || /^Header bar$/.test(r.heading)) { out[r.slug] = 'full'; continue; }
    }
    return out;
}

/* ── the console, rendered ──────────────────────────────────────────────── */

const { declSource: fnSource, renderConsole } = require('./console-render');

/*
 * PLACEMENT IS CHECKED WITH THE FEATURE FULLY ENABLED. Five regions are behind
 * their own flag (ICP-017) and every flag defaults OFF, so rendering with the
 * defaults would hide regions and report them as never built — a layout test
 * answering a question about configuration.
 */
const ALL_FLAGS = { world_engine: true, marble_generation: true, cinematography_ai: true,
                    reference_match: true, camera_explore: true, world_splats: true };

/**
 * Which structural column encloses a position in the rendered HTML.
 *
 * A div stack over the produced string. EVERY div is pushed, with or without a
 * class, so the stack stays balanced — counting only the interesting ones is
 * how a scan comes to attribute a region to whichever wrapper opened last
 * rather than to the one that still encloses it. That is the same defect the
 * sheet column scan shipped once, where a full-width band below both columns
 * was recorded as being in column 1.
 */
const WRAPPERS = { 'we-rail': 'left', 'we-center': 'center', 'we-right': 'right' };

function columnAt(html, index) {
    const stack = [];
    const tag = /<div\b([^>]*)>|<\/div>/g;
    let m;
    while ((m = tag.exec(html)) && m.index < index) {
        if (m[0] === '</div>') stack.pop();
        else {
            const cls = (/class="([^"]*)"/.exec(m[1] || '') || [])[1] || '';
            stack.push(cls.split(/\s+/).find(c => WRAPPERS[c]) || '');
        }
    }
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]) return WRAPPERS[stack[i]];
    return 'full';
}

/**
 * Where a region renders, or null if it does not.
 *
 * Found by its own heading rather than by a marker typed per region: a panel
 * carries its name as a `we-label`, the header bar is the console's own head,
 * and a modal is reached by an opener the console invokes. All three are
 * derived from what the design calls the region.
 */
function locate(region, html) {
    if (region.modal) {
        // A modal is not in this markup. It "renders" when the console can open
        // it — an opener nothing invokes is a region with no way in.
        const opener = [...UI.matchAll(/onclick="(worldOpen[A-Za-z]+)\(\)"/g)].map(x => x[1]);
        const words = region.slug.split('-').filter(w => w.length > 3);
        const hit = opener.find(o => words.some(w => o.toLowerCase().includes(w)));
        return hit && html.includes(hit) ? { column: 'modal', how: hit } : null;
    }
    if (/^Header bar$/.test(region.heading)) {
        const at = html.indexOf('we-head');
        return at > -1 ? { column: 'full', how: 'we-head' } : null;
    }
    // A panel is found by its own name, as the design writes it.
    const label = region.slug.replace(/-/g, ' ').toUpperCase();
    const at = html.toUpperCase().indexOf(`WE-LABEL">${label}`);
    if (at < 0) return null;
    return { column: columnAt(html, at), how: label };
}

/* ── regions the design draws that the console does not yet ─────────────── */

/**
 * NAMED, never dropped from the denominator. A gap written down is work; a gap
 * silently excluded is one nobody finds again — and a stale entry fails too,
 * because an exemption claiming a gap that no longer exists makes the whole
 * list a lie. ICP-017..021 promote these one at a time by building them.
 */
const NOT_BUILT = {
    'left-rail': 'ICP-020 builds the rail of shots',
    'explore-shot': 'ICP-019 builds it against camera_explore_brief and compareCameras',
    'spatial-world': 'ICP-020 builds it; the splat viewport itself is deferred to ICP-022',
    'camera-operate': 'ICP-020 builds the six-axis nudge controls',
    'blocking': 'ICP-020 builds it from the shot\'s real staged subjects',
    'secondary-strip': 'ICP-020 builds lighting, camera body and plate output',
    'advanced-strip': 'ICP-020 builds the collapsed disclosure chips',
};

/* ── the tests ──────────────────────────────────────────────────────────── */

test('the region set is derived from the design and is not a typed list', () => {
    const regions = designRegions();
    assert.ok(regions.length >= 12,
        `only ${regions.length} regions parsed out of the design — the scan is broken, and a scan `
        + 'that finds too few reports the gap as closed');
    // Named anchors, so a heading rewrite that empties the scan is caught.
    for (const want of ['camera-view', 'direct-the-shot', 'explore-shot', 'lens']) {
        assert.ok(regions.some(r => r.slug === want), `the design no longer names ${want}`);
    }
});

test('every region the design draws has a column the design states', () => {
    const cols = designColumns();
    const unplaced = designRegions().filter(r => !cols[r.slug]).map(r => r.heading);
    assert.deepStrictEqual(unplaced, [],
        `these regions are drawn by the design and placed nowhere by it: ${unplaced.join(', ')}`);
});

test('the column scan can actually TELL the columns apart', () => {
    /*
     * A scan that answers "full" for everything passes every placement
     * assertion whose expected column happens to be full, and is indi-
     * stinguishable from a working one. This proves it discriminates before
     * anything is asserted with it.
     */
    const html = renderConsole(ALL_FLAGS);
    const centre = html.indexOf('we-center');
    const right = html.indexOf('we-right');
    assert.ok(centre > -1 && right > -1, 'the console renders neither a centre nor a right column');
    assert.strictEqual(columnAt(html, html.indexOf('CAMERA VIEW')), 'center');
    assert.strictEqual(columnAt(html, html.indexOf('we-label">LENS')), 'right');
    assert.strictEqual(columnAt(html, html.indexOf('we-head')), 'full');
});

test('EVERY built region renders, and in the column the design puts it in', () => {
    const html = renderConsole(ALL_FLAGS);
    const cols = designColumns();
    const wrong = [];
    for (const r of designRegions()) {
        if (NOT_BUILT[r.slug]) continue;
        const found = locate(r, html);
        if (!found) { wrong.push(`${r.heading}: does not render at all`); continue; }
        if (found.column !== cols[r.slug]) {
            wrong.push(`${r.heading}: renders in the ${found.column} column, the design puts it in `
                + `the ${cols[r.slug]}`);
        }
    }
    assert.deepStrictEqual(wrong, [],
        'the console disagrees with the design about what it draws and where:\n  ' + wrong.join('\n  '));
});

test('every unbuilt region is named with the task that builds it, and is really absent', () => {
    /*
     * The stale half is the one that matters. When ICP-018 builds Direct the
     * Shot, this fails until the entry is removed — so a region cannot be
     * built and left out of the placement check, which is precisely how a
     * region comes to render in the wrong column with the suite green.
     */
    const html = renderConsole(ALL_FLAGS);
    const regions = designRegions();
    const stale = [];
    for (const [s, why] of Object.entries(NOT_BUILT)) {
        const r = regions.find(x => x.slug === s);
        assert.ok(r, `NOT_BUILT names "${s}", which the design does not draw`);
        assert.match(why, /ICP-\d+/, `${s}: the entry names no task that will build it`);
        if (locate(r, html)) stale.push(s);
    }
    assert.deepStrictEqual(stale, [],
        `these now render and are still excluded from the placement check — promote them by `
        + `deleting their NOT_BUILT entry: ${stale.join(', ')}`);
});

test('the gap is measured, not asserted', () => {
    /*
     * The number this task exists to establish, computed rather than typed, so
     * the next dispatch reads a current figure rather than yesterday's.
     */
    const html = renderConsole(ALL_FLAGS);
    const regions = designRegions();
    const built = regions.filter(r => locate(r, html));
    assert.strictEqual(built.length + Object.keys(NOT_BUILT).length, regions.length,
        `${built.length} render and ${Object.keys(NOT_BUILT).length} are excused, which does not `
        + `account for all ${regions.length} regions the design draws`);
});
