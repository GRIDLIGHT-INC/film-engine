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
