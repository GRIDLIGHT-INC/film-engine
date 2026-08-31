/**
 * The location and prop sheets, held to the design's GEOMETRY
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "The location and props card isn't even close to the design we made in html.
 * I want exactly the same design... For the orientation plan. I'll ask the LLM
 * to generate it and upload a picture in this section. I want no liberties."
 *
 * WHY A SECOND DESIGN TEST EXISTS. `subject-sheet-design.test.js` already
 * derives its denominator from these same canonical files and PASSES — it
 * derives the LABELS. So every uppercase heading renders, the sheet looks
 * complete in a screenshot, and the layout underneath is a different primitive:
 * the design's orientation plan is a CSS grid
 *
 *     grid-template-columns: 62px minmax(0,1fr) 62px
 *     grid-template-rows:    22px minmax(0,1fr) 22px
 *
 * with vertical-rl side labels and a 168px room box split into three zone
 * columns, and the page renders `.ss-plan-mid` as a flexbox with the sides at
 * 30% and a wrapping `.ss-plan-room`. A label test cannot see that. This one
 * derives the DECLARATIONS.
 *
 * Set-based over the declarations in both files, because the failure is
 * per-declaration and partial: the sheets already get some shapes right (the
 * 16:9 hero, the 1/1 prop tiles) while the compass grid is absent entirely, so
 * a test written against any one of them passes in the reported state.
 *
 * Written by claude as the agreed red target for the confer; codex implements
 * against it. Neither of us edits the other's file without saying so.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-fid-' + crypto.randomUUID().slice(0, 8));

const ROOT = path.join(__dirname, '..');
const UI = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');
const HANDOFF = path.join(ROOT, '..', 'design_handoff_character_card');

/** The two sheets this task is about, and the file each is drawn from. */
const KINDS = [
    { kind: 'location', design: 'Location Card.dc.html' },
    { kind: 'prop', design: 'Prop Card.dc.html' },
];

/** Only the page's own stylesheet — matching the whole file would match the design's own markup if it were ever inlined. */
function pageStyles() {
    return [...UI.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
}

/**
 * Every layout declaration the design states, per kind.
 *
 * TEMPLATE PLACEHOLDERS ARE EXCLUDED, and that is a correction to the number I
 * gave in Frame: `{{ refColumns }}` and `{{ viewColumns }}` are computed at
 * render time, so there is no literal rule a page could declare to match them.
 * Counting them made the denominator 20; the assertable set is 17.
 */
/**
 * Declarations that belong to a region this change does not compose.
 *
 * Exempt BY NAME with the reason, never by pattern. `minmax(0,1fr) 300px` is
 * real -- it is the location design's CONCEPT ART & REFERENCES footer (line
 * 236) -- but we borrowed it for the BODY, where the design uses a flex row.
 * Requiring it while the footer is uncomposed forces the broken body rule back
 * or invites dead CSS, which is the cosmetic satisfaction this suite refuses.
 * Named here and in the report's `deferred:` rather than silently dropped.
 */
const NOT_COMPOSED_HERE = {
    /*
     * EMPTY, and kept rather than deleted -- an empty object asserts on every
     * run that every declaration the designs state is composed somewhere.
     * `minmax(0,1fr) 300px` sat here while the Concept art & references footer
     * was uncomposed; the footer now exists, so the exemption is gone and the
     * declaration is required again.
     */
};

function layoutDeclarations(designFile) {
    const src = fs.readFileSync(path.join(HANDOFF, designFile), 'utf8');
    const out = [];
    for (const prop of ['grid-template-columns', 'grid-template-rows', 'aspect-ratio', 'writing-mode']) {
        const seen = new Set();
        for (const m of src.matchAll(new RegExp(`${prop}:\\s*([^;"]+)`, 'g'))) {
            const value = m[1].replace(/\s+/g, ' ').trim();
            if (value.includes('{{')) continue;          // computed, not a literal rule
            if (seen.has(value)) continue;
            seen.add(value);
            if (NOT_COMPOSED_HERE[`${prop}|${value}`]) continue;
            out.push({ prop, value });
        }
    }
    return out;
}

/** Whitespace-insensitive: `repeat(3, minmax(0,1fr))` and `repeat(3,minmax(0, 1fr))` are one rule. */
function declared(styles, prop, value) {
    const norm = s => s.replace(/\s+/g, '').toLowerCase();
    const target = norm(`${prop}:${value}`);
    return [...styles.matchAll(new RegExp(`${prop}\\s*:\\s*([^;}]+)`, 'gi'))]
        .some(m => norm(`${prop}:${m[1]}`) === target);
}

/**
 * The class a declaration belongs to, and whether any markup WEARS it.
 *
 * WHY THIS EXISTS: the first version of the test below asked only whether a
 * declaration appeared anywhere in the stylesheet. A rule nothing wears
 * satisfies that perfectly, and two did -- `.ls-support-grid` and
 * `.ps-states-grid` were declared and appeared nowhere else in the page. So
 * 2 of the 17 read as green while nothing on screen had that geometry. codex
 * caught it in the confer critique; it is the exact failure this suite was
 * written to prevent.
 *
 * "Worn" means the class name occurs OUTSIDE its own CSS rule. That is
 * deliberately looser than `class="..."`: `ssTile(v, label, caption, 'ps-plate')`
 * passes the class as an ARGUMENT and assigns it with `class="${cls}"`, so the
 * literal never appears in markup. My own first sweep reported `ps-plate` as
 * dead on exactly that basis -- a false positive that would have deleted a live
 * rule.
 */
function classesDeclaring(styles, prop, value) {
    const norm = s => s.replace(/\s+/g, '').toLowerCase();
    const target = norm(`${prop}:${value}`);
    const out = [];
    for (const m of styles.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const selector = m[1], body = m[2];
        const has = [...body.matchAll(new RegExp(`${prop}\\s*:\\s*([^;}]+)`, 'gi'))]
            .some(d => norm(`${prop}:${d[1]}`) === target);
        if (!has) continue;
        for (const c of selector.matchAll(/\.([a-z0-9-]+)/gi)) out.push(c[1]);
    }
    return [...new Set(out)];
}

/** Does anything outside the stylesheet name this class? */
function worn(cls) {
    const outsideCss = UI.replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ');
    return new RegExp(`\\b${cls.replace(/-/g, '\\-')}\\b`).test(outsideCss);
}

test('the denominator is derived from both canonical files, and is not small', () => {
    let total = 0;
    for (const k of KINDS) {
        const decls = layoutDeclarations(k.design);
        assert.ok(decls.length >= 6,
            `${k.kind}: only ${decls.length} layout declarations derived — the read is broken, and `
            + 'a denominator that is too small reports the gap as closed');
        total += decls.length;
    }
    assert.strictEqual(total, 17,
        `expected 17 assertable layout declarations across the two designs, derived ${total}. `
        + 'If the designs changed, this number moves with them — but it must be stated, because '
        + 'the whole claim is "exactly the same".');
});

test('every layout declaration is declared AND worn by rendered markup', () => {
    const styles = pageStyles();
    const missing = [];
    for (const k of KINDS) {
        for (const d of layoutDeclarations(k.design)) {
            if (!declared(styles, d.prop, d.value)) missing.push(`${k.kind}: ${d.prop}: ${d.value}`);
        }
    }
    assert.deepStrictEqual(missing, [],
        'the design states these and the page declares none of them, so the sheet is a different '
        + 'layout wearing the right labels:\n  ' + missing.join('\n  '));

    /*
     * AND THE RULE MUST BE WORN. Declared-but-unworn is not fidelity, it is
     * dead CSS that happens to contain the right characters.
     */
    const unworn = [];
    for (const k of KINDS) {
        for (const d of layoutDeclarations(k.design)) {
            const classes = classesDeclaring(styles, d.prop, d.value);
            if (!classes.length) continue;                 // already reported above
            if (classes.some(worn)) continue;
            unworn.push(`${k.kind}: ${d.prop}: ${d.value}  (declared by .${classes.join(', .')} — worn by nothing)`);
        }
    }
    assert.deepStrictEqual(unworn, [],
        'these are declared and no markup wears them, so the geometry is in the stylesheet and '
        + 'not on the screen:\n  ' + unworn.join('\n  '));
});

test('the orientation plan is the design\'s compass grid, not a flex approximation', () => {
    /*
     * Named separately from the loop because this is the region the user
     * pointed at, and because its four declarations are meaningless apart: a
     * page could declare the columns and lay the rows out by hand, which reads
     * as correct in source and wrong on screen.
     */
    const styles = pageStyles();
    const design = fs.readFileSync(path.join(HANDOFF, 'Location Card.dc.html'), 'utf8');

    for (const [prop, value] of [
        ['grid-template-columns', '62px minmax(0,1fr) 62px'],
        ['grid-template-rows', '22px minmax(0,1fr) 22px'],
        ['writing-mode', 'vertical-rl'],
    ]) {
        assert.ok(design.includes(`${prop}: ${value}`),
            `this test's reading is stale: the design no longer states ${prop}: ${value}`);
        assert.ok(declared(styles, prop, value),
            `the orientation plan does not declare ${prop}: ${value} — the compass rose is still `
            + 'a flexbox with the sides at a percentage');
    }

    // The room box: a fixed height split into three zones.
    assert.ok(/height:\s*168px/.test(design), "this test's reading is stale: the room box is no longer 168px");
    assert.ok(/height:\s*168px/.test(styles),
        'the room box is not 168px — the design fixes its height so the compass labels align to it');
    assert.ok(declared(styles, 'grid-template-columns', '1fr 1fr 1fr'),
        'the room is not split into three zone columns');
});

test('the orientation plan can hold an uploaded picture, as its own media kind', () => {
    /*
     * "I'll ask the LLM to generate it and upload a picture in this section."
     * Its own target, NEVER `location-plate`: see the isolation test below for
     * what reusing that would do.
     */
    const { MEDIA_IMPORTS } = require('../lib/media-imports');
    const spec = MEDIA_IMPORTS['orientation-plan'];
    assert.ok(spec,
        'there is no `orientation-plan` import target, so a director cannot put a picture in the '
        + `section that asks for one (targets: ${Object.keys(MEDIA_IMPORTS).join(', ')})`);
    assert.strictEqual(spec.kind, 'image', 'the orientation plan target is not an image kind');

    // And a control for it, in the orientation region rather than on the card.
    assert.ok(/uploadControl\('orientation-plan'|data-import-target="orientation-plan"/.test(UI),
        'the page offers no upload for the orientation plan');
});

test('an uploaded orientation plan is NEVER gathered as a shot reference', async () => {
    /*
     * THE INVARIANT THAT MATTERS MOST, and codex's point in Frame.
     *
     * gatherShotReferences selects `asset_type IN ('character_sheet',
     * 'reference_image')` scoped by location_id. Filing a top-down floor
     * schematic under either would put it in the reference package of EVERY
     * shot in that location — a diagram conditioning the film. Behavioural,
     * because the storage decision is invisible in source: an orientation
     * image written as a reference_image looks exactly like a plate.
     */
    const db = require('../db/database');
    require('../db/schema').ensureSchema?.();

    const { gatherShotReferences } = require('../lib/shot-references');
    assert.ok(typeof gatherShotReferences === 'function', 'gatherShotReferences is gone');

    const { ORIENTATION_ASSET_TYPE } = require('../lib/media-imports');
    assert.ok(ORIENTATION_ASSET_TYPE,
        'lib/media-imports does not name the asset_type an orientation plan is stored under, so '
        + 'nothing states how it is kept out of the reference gather');
    assert.ok(!['reference_image', 'character_sheet'].includes(ORIENTATION_ASSET_TYPE),
        `an orientation plan is stored as "${ORIENTATION_ASSET_TYPE}", which gatherShotReferences `
        + 'selects — every shot in that location would be conditioned on a floor diagram');
});

test('the LLM authors the plan over MCP, with no server-side model', () => {
    /*
     * "I'll ask the LLM to generate it." The connected agent IS the model here,
     * which is why mcp-no-server-llm.test.js exists. So: a FREE brief the model
     * reads, and a write tool it calls. A route that called a server-side LLM
     * would ask for a second API key to answer a question the attached model
     * has already read the material for.
     */
    const { buildTools } = require('../lib/mcp-tools');
    const tools = buildTools ? buildTools() : require('../lib/mcp-tools').TOOLS;
    const names = (Array.isArray(tools) ? tools : Object.values(tools || {})).map(t => t.name);

    const brief = names.find(n => /orientation.*brief|brief.*orientation/.test(n));
    const write = names.find(n => /orientation.*(write|set|update)/.test(n));
    assert.ok(brief,
        'no orientation brief tool — the model has no free way to read what the plan is written '
        + `from (tools: ${names.length})`);
    assert.ok(write,
        'no orientation write tool — the model can read the brief and cannot record the plan');

    // And the route behind it must not reach a server-side LLM.
    const routeSrc = fs.readFileSync(path.join(ROOT, 'routes', 'locations.js'), 'utf8');
    assert.ok(!/llm-client|callLLM|require\(['"]\.\.\/lib\/llm/.test(routeSrc),
        'routes/locations.js reaches a server-side LLM, which hands the reasoning back and asks '
        + 'the user for a second key to answer what the connected model already has in context');
});

test('the canonical design files are TRACKED, or every design test is a local accident', () => {
    /*
     * Found while writing this: `design_handoff_character_card/Location Card.dc.html`
     * and `Prop Card.dc.html` are on disk and UNTRACKED. Both this suite and
     * subject-sheet-design.test.js read them, so on a fresh clone both fail --
     * and the existing one has been reported as passing on the strength of
     * files that exist only on one machine.
     */
    const { execFileSync } = require('child_process');
    const tracked = execFileSync('git', ['ls-files', 'design_handoff_character_card/'],
        { cwd: path.join(ROOT, '..'), encoding: 'utf8' });
    for (const k of KINDS) {
        assert.ok(tracked.includes(k.design),
            `${k.design} is not tracked by git — the design tests read it, so they pass here and `
            + 'fail on a fresh clone');
    }
});

/**
 * COMPOSITION — where a region sits, not just what it declares
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The assertions above hold every layout DECLARATION the design states, and
 * they pass. A browser comparison showed the sheet still does not look like the
 * design, because a declaration says nothing about WHICH COLUMN a region is in
 * or HOW WIDE that column is. Measured, app against design:
 *
 *     compass rails    62px … 62px      identical
 *     compass rows     22px 168px 22px  identical
 *     left column      design ~499px    app 1188px   (.ss-grid = 1188px 300px)
 *
 * So the compass geometry is pixel-exact and stretched across a column two and
 * a half times too wide, which is why the room box reads as a letterbox rather
 * than a floor plan. codex named this in the confer critique; I acknowledged it
 * and we shipped without closing it. These three assertions close it.
 *
 * Every expected value is DERIVED FROM THE DESIGN FILE, so a design change
 * moves the test with it and no reading of mine sits in between.
 */

/** The design's own body-column declarations, read from the file. */
function bodyColumns(designFile) {
    const src = fs.readFileSync(path.join(HANDOFF, designFile), 'utf8');
    return [...src.matchAll(/flex:\s*(\d+\s+\d+\s+\d+px)/g)].map(m => m[1].replace(/\s+/g, ' '));
}

test('LOCATION composes narrow-left / wide-right, as the design does', () => {
    /*
     * The design's body is a FLEX ROW with two flex-column children -- there is
     * no `grid-template-columns` for it anywhere in the file. My first version
     * asserted a bounded first GRID token, which rejected a correct flex
     * implementation of the very thing it was asking for. codex caught it.
     * Derived from the design's own declarations now, so the contract is what
     * the design states rather than one way of achieving it.
     */
    const design = fs.readFileSync(path.join(HANDOFF, 'Location Card.dc.html'), 'utf8');
    const bases = [...design.matchAll(/flex:\s*(\d+ \d+ \d+px)/g)].map(m => m[1]);
    assert.ok(bases.includes('1 1 480px') && bases.includes('1 1 520px'),
        `this test's reading is stale: the design's body columns are now ${bases.join(' / ')}`);
    assert.ok(/max-width:\s*560px/.test(design),
        "this test's reading is stale: the plates column no longer caps at 560px");

    const styles = pageStyles();
    const norm = t => t.replace(/\s+/g, ' ');

    /*
     * The PLATES column is bounded and the DESCRIPTION column grows. That
     * asymmetry is the whole finding: ours computed 1188px / 300px, the
     * inverse, which stretched the compass from the design's 457px to 1130px.
     */
    const first = styles.match(/\.ls-grid\s*>\s*\.ss-col:first-child[^{]*\{([^}]*)\}/);
    const last = styles.match(/\.ls-grid\s*>\s*\.ss-col:last-child[^{]*\{([^}]*)\}/);
    assert.ok(first && last,
        'the location body has no first/last column rules, so nothing bounds the plates column');
    assert.ok(/flex\s*:\s*1 1 480px/.test(norm(first[1])) && /max-width\s*:\s*560px/.test(norm(first[1])),
        `the plates column is "${norm(first[1]).slice(0, 70)}" -- the design bounds it at `
        + 'flex 1 1 480px / max-width 560px');
    assert.ok(/flex\s*:\s*1 1 520px/.test(norm(last[1])),
        `the description column is "${norm(last[1]).slice(0, 70)}" -- the design grows it at flex 1 1 520px`);

    const body = styles.match(/\.ss-grid\.ls-grid[^{]*\{([^}]*)\}/);
    assert.ok(body && /display\s*:\s*flex/.test(body[1]),
        'the location body is not a flex row; the design wraps two flex columns');
});

test('the ORIENTATION header is one row, title left and note right', () => {
    const design = fs.readFileSync(path.join(HANDOFF, 'Location Card.dc.html'), 'utf8');
    const at = design.indexOf('Orientation plan');
    const header = design.slice(Math.max(0, at - 300), at);
    assert.ok(/display:\s*flex/.test(header) && /justify-content:\s*space-between/.test(header),
        "this test's reading is stale: the orientation header is no longer a space-between row");

    /*
     * Ours computes `display:block`, so the note wraps beneath the title. The
     * design puts "keeps geography consistent across plates" on the same line,
     * right-aligned -- the pattern every section header on both sheets uses.
     */
    /*
     * BOUND TO ssSection, the ONE builder every region on both sheets uses.
     * It emits `<h4>title</h4>` then `<p class="ss-what">note</p>` -- two block
     * elements -- so the note wraps beneath the title on every section, not
     * just this one. My first version looked for any `.ss-*-head` rule with
     * flex on it and passed without ever reaching the header that is actually
     * rendered.
     */
    const fnAt = UI.indexOf('function ssSection(');
    assert.ok(fnAt > -1, 'ssSection is gone -- this test cannot see how a section header is built');
    let jj = UI.indexOf('{', fnAt), dd = 0, ee = -1;
    for (let k = jj; k < UI.length; k++) {
        if (UI[k] === '{') dd++;
        else if (UI[k] === '}') { dd--; if (!dd) { ee = k + 1; break; } }
    }
    const fn = UI.slice(fnAt, ee < 0 ? fnAt + 4000 : ee);

    const headClass = (fn.match(/class="(ss-[a-z-]*head[a-z-]*)"/) || [])[1];
    assert.ok(headClass,
        'ssSection does not wrap the title and its note in a header element, so they stack as '
        + 'separate blocks -- the design puts them on one row, title left and note right');

    const styles = pageStyles();
    /*
     * The STANDALONE rule. `.ss-region-head > h4 { … }` also starts with the
     * class name, so a loose match reads the TITLE's typography and reports the
     * header as not being a row. codex hit exactly that.
     */
    const rule = styles.match(new RegExp(`\\.${headClass}\\s*\\{([^}]*)\\}`));
    assert.ok(rule, `.${headClass} is emitted and has no CSS rule`);
    assert.ok(/display\s*:\s*flex/.test(rule[1]) && /justify-content\s*:\s*space-between/.test(rule[1]),
        `.${headClass} is not a space-between row, so every section note wraps to its own line`);
});

test('PROP puts the turntable full width ABOVE the two-column body', () => {
    const design = fs.readFileSync(path.join(HANDOFF, 'Prop Card.dc.html'), 'utf8');
    const turntable = design.indexOf('{{ viewColumns }}');
    const body = design.indexOf('minmax(0, 1fr) 400px');
    assert.ok(turntable > -1 && body > -1 && turntable < body,
        "this test's reading is stale: the turntable no longer precedes the prop body");

    /*
     * Ours keeps the official views inside column one, so the five turntable
     * plates are squeezed into half the card. codex raised this in the confer
     * critique and it is still open.
     */
    const at = UI.indexOf('function renderPropSheet');
    assert.ok(at > -1, 'renderPropSheet is gone');
    let j = UI.indexOf('{', at), d = 0, e = -1;
    for (let k = j; k < UI.length; k++) {
        if (UI[k] === '{') d++;
        else if (UI[k] === '}') { d--; if (!d) { e = k + 1; break; } }
    }
    const fn = UI.slice(at, e < 0 ? at + 20000 : e);
    const views = fn.indexOf("'ps-plates'");
    const grid = fn.indexOf('ss-grid');
    assert.ok(views > -1, 'the prop sheet no longer renders its turntable');
    assert.ok(grid === -1 || views < grid,
        'the prop turntable is rendered INSIDE the two-column body, so its five official views '
        + 'are squeezed into half the card; the design places them full width above it');
});


/**
 * TYPOGRAPHY — the section title and its note
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Added because "exactly the same" plausibly covers type, and because leaving
 * it out would have meant patching layout now and typography later. Derived
 * from BOTH designs, which agree: the section-title style appears 6 times in
 * the location card and 8 in the prop card, and the note style 3 and 4 times.
 * Two files agreeing on one style is what makes it the system rather than one
 * heading's decoration.
 *
 *     design title : 'JetBrains Mono' 10.5px / 0.2em / uppercase / rgba(232,232,234,0.5)
 *     design note  : 'JetBrains Mono' 10px / rgba(232,232,234,0.32)
 *     ours title   : 11px / .08em / uppercase / var(--text-muted)   -- no mono
 *     ours note    : 11px / var(--text-muted)                       -- no mono
 *
 * Bound to the rules ssSection's output actually wears, not searched
 * page-wide: two of my three composition assertions first passed against the
 * broken sheet on exactly that mistake.
 */

/** The one style both designs use most for a section title / its note. */
function typeSystem() {
    /*
     * The TITLE by frequency -- uppercase mono recurs 6x in the location card
     * and 8x in the prop card, which is what makes it the system rather than
     * one heading's decoration. The NOTE structurally: the span that FOLLOWS a
     * title, which is what a section note is.
     *
     * Frequency alone got the note wrong: the most common non-uppercase mono
     * style is a 9px caption used elsewhere on the card, and the test then
     * reported the note as wrong against a size the design never sets for it.
     * Row-capture got it wrong too -- a non-greedy scan to `</div>` stops at
     * the first NESTED close and found only 2 headers. Following the title is
     * both simple and correct.
     */
    const titles = new Map(), notes = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    for (const k of KINDS) {
        const src = fs.readFileSync(path.join(HANDOFF, k.design), 'utf8');
        for (const m of src.matchAll(/<span style="([^"]*JetBrains Mono[^"]*text-transform: uppercase[^"]*)"/g)) {
            bump(titles, m[1].replace(/\s+/g, ' ').trim());
            /*
             * Bounded to the SAME ROW: everything up to the first `</div>`
             * after the title. An unbounded window picks up the 9px caption
             * from the block below, which is what made the note derive as 9px.
             */
            const rest = src.slice(m.index + m[0].length);
            const row = rest.slice(0, rest.indexOf('</div>'));
            const next = row.match(/<span style="([^"]*JetBrains Mono[^"]*)"/);
            if (next && !/text-transform: uppercase/.test(next[1])) {
                bump(notes, next[1].replace(/\s+/g, ' ').trim());
            }
        }
    }
    const top = m => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    return { title: top(titles), note: top(notes) };
}

test('the section title and note use the design\'s type system', () => {
    const sys = typeSystem();
    assert.ok(sys.title && sys.title[1] >= 6,
        `this test's reading is stale: no section-title style recurs across the designs (${
            sys.title ? sys.title[1] : 0} occurrences)`);

    const size = (sys.title[0].match(/font-size:\s*([\d.]+)px/) || [])[1];
    const track = (sys.title[0].match(/letter-spacing:\s*([\d.]+)em/) || [])[1];
    assert.ok(size && track, `could not read the design's title metrics from "${sys.title[0]}"`);

    const styles = pageStyles();
    const h4 = styles.match(/\.ss-region\s*>\s*h4[^{]*\{([^}]*)\}/);
    assert.ok(h4, 'there is no .ss-region > h4 rule, so section titles have no style of their own');

    assert.ok(/JetBrains Mono|ui-monospace|monospace/.test(h4[1]),
        `section titles are not monospaced; the design sets 'JetBrains Mono' on every one of the `
        + `${sys.title[1]} it draws`);
    assert.ok(new RegExp(`font-size\\s*:\\s*${size}px`).test(h4[1]),
        `section titles are ${(h4[1].match(/font-size\s*:\s*([^;]+)/) || [])[1]} where the design `
        + `sets ${size}px`);
    // `.2em` and `0.2em` are the same tracking; a leading zero is a style choice.
    assert.ok(new RegExp(`letter-spacing\\s*:\\s*0?\\.?${String(track).replace(/^0?\./, '')}em`).test(h4[1]),
        `section titles track at ${(h4[1].match(/letter-spacing\s*:\s*([^;]+)/) || [])[1]} where `
        + `the design sets ${track}em — the difference is what makes the design's headings read `
        + 'as a system rather than as small bold text');

    /*
     * THE NOTE IS DELIBERATELY NOT ASSERTED, and this is a finding rather than
     * a gap.
     *
     * There is no single note style to hold anything to. Reading every section
     * header in the location design, the note beside the title is 10.5px after
     * "Master plates", 10px after "Orientation plan", 9.5px after "Room
     * layout", 9px after the plate tiles. The design sizes a note by context,
     * so picking one and calling it canonical would be inventing a rule the
     * design does not state -- and the test would then fail a correct
     * implementation, which is the mistake this suite has already made twice.
     *
     * The TITLE is different: uppercase mono at 10.5px / 0.2em recurs 6 times
     * in the location card and 8 in the prop card, unvaryingly. That is a
     * system, and it is asserted above.
     *
     * What IS asserted about the note is structural, in the header test: it
     * shares one space-between row with its title rather than wrapping beneath
     * it. That is the thing the screenshot showed to be wrong.
     */
    assert.ok(sys.note, 'no note style could be derived at all — the header structure has changed');
});

