/**
 * The sheets, against the designs they were drawn from
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The first build derived its regions from labels GREPPED out of the handoff
 * files, which produced ten headings and none of the structure underneath: one
 * textarea where the design has six named, collapsible, character-counted
 * sections; four pills where it has a plan of the room; a text field where it
 * has material rows with colour swatches. It looked like the design in a
 * screenshot and was not it.
 *
 * So the denominator is DERIVED FROM THE DESIGN FILES THEMSELVES. Every
 * uppercase mono label in a handoff is an element that design asks for, and the
 * sheet is held to rendering all of them — if the design changes, this changes
 * with it, and no reading of mine sits in between.
 *
 * The features that are not labels — what is fed to generation and what is not,
 * the character counts, the starred references — are declared in
 * DESIGN_FEATURES with the phrase from the design they come from, because a
 * marker saying "not sent" is the difference between a sheet and a form.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-design-' + crypto.randomUUID().slice(0, 8));

const sheets = require('../lib/subject-sheets');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
const HANDOFF = path.join(__dirname, '..', '..', 'design_handoff_character_card');

/**
 * Every element the design labels.
 *
 * A section title in these files is a JetBrains Mono span, uppercased, tracked
 * out at 0.13em or wider. Derived rather than transcribed: a list typed into a
 * test is only ever as complete as whoever typed it that afternoon, which is
 * exactly how ten headings came to stand in for a design with thirty-seven
 * elements.
 */
function designLabels(file) {
    const s = fs.readFileSync(path.join(HANDOFF, file), 'utf8').replace(/\s+/g, ' ');
    const out = [];
    const re = /<(span|div)[^>]*style="([^"]*)"[^>]*>([^<]{2,40})<\/\1>/g;
    for (let m = re.exec(s); m; m = re.exec(s)) {
        const [, , style, raw] = m;
        if (!style.includes('text-transform: uppercase')) continue;
        if (!style.includes('JetBrains Mono')) continue;
        const ls = /letter-spacing: ([\d.]+)em/.exec(style);
        if (!ls || Number(ls[1]) < 0.13) continue;
        const text = raw.trim();
        if (text && !out.includes(text)) out.push(text);
    }
    return out;
}

const SUBJECTS = [
    { kind: 'location', file: 'Location Card.dc.html', renderer: 'renderLocationSheet' },
    { kind: 'prop', file: 'Prop Card.dc.html', renderer: 'renderPropSheet' },
];

/** One function's body, bounded — a fixed slice runs into the next one. */
function fnBody(name) {
    const at = SRC.indexOf(`function ${name}(`);
    if (at === -1) return '';
    const next = SRC.indexOf('\n    function ', at + 10);
    return SRC.slice(at, next === -1 ? at + 24000 : next);
}

/**
 * The renderer, AND the shared pieces it calls.
 *
 * A sheet is not one function: the plate tile, the chip row and the reference
 * band are shared by both sheets on purpose, because two copies is how one of
 * them acquires the star that means "this conditions a frame" and the other
 * does not. Followed ONE level, like screenplay-mutators.test.js — an unbounded
 * walk ends up reading the whole page and passing on anything.
 */
const SHEET_HELPERS = ['ssTile', 'ssChips', 'ssRefs', 'ssPlateMeta', 'ssPlateControls',
    'ssSection', 'ssField', 'ssReach'];
function rendererBody(name) {
    const own = fnBody(name);
    assert.ok(own, `there is no ${name}`);
    const called = SHEET_HELPERS.filter(h => own.includes(`${h}(`)).map(fnBody).join('\n');
    return own + '\n' + called;
}

/*
 * The design's own text for one location and one prop.
 *
 * "The north window" is that diner's hard constraint and "01 · Master wide —
 * south to north" is that room's first plate — they are CONTENT, and requiring
 * them as page strings would hardcode one film into the app. What must exist is
 * the structure that renders them, which is why each names the feature that
 * covers it. Exempt by name with a reason, never by pattern.
 */
const IS_CONTENT = {
    'LOC-0031 · INT/EXT': 'loc-id-chip',
    'PRP-004 · hero prop': 'prop-id-chip',
    '01 · Master wide — south to north': 'loc-plate-slots',
};

test('the design files are still here to be checked against', () => {
    for (const s of SUBJECTS) {
        assert.ok(fs.existsSync(path.join(HANDOFF, s.file)),
            `${s.file} is gone — the sheets can no longer be held to what was asked for`);
        assert.ok(designLabels(s.file).length >= 15,
            `${s.file}: only ${designLabels(s.file).length} labels found — the parser no longer reads the design`);
    }
});

test('every element the design labels is on the sheet', () => {
    for (const s of SUBJECTS) {
        const body = rendererBody(s.renderer);
        const labels = designLabels(s.file);
        /*
         * Matched on the label's WORDS, not its exact string: the design writes
         * "Turntable · official views" and a page may reasonably write the
         * separator differently, but it may not silently omit the section.
         */
        /*
         * The registries count as the page.
         *
         * "Room layout" and "Architecture" are the description SECTIONS, which
         * live in lib/subject-sheets.js and are served to the sheet rather than
         * typed into it — that is the right place for them, and requiring the
         * literal in the SPA would push the registry back into the page.
         */
        const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'subject-sheets.js'), 'utf8');
        const surface = (body + '\n' + lib).toLowerCase();
        const missing = labels.filter(label => {
            if (IS_CONTENT[label]) return false;
            const words = label.split(/[·—\s]+/).filter(w => w.length > 2 && !/^\d+$/.test(w));
            if (!words.length) return false;
            return !words.every(w => surface.includes(w.toLowerCase()));
        });
        assert.deepEqual(missing, [],
            `${s.kind}: the design asks for these and the sheet has none of them: ${missing.join(' / ')}`);
    }
});

test('a label excused as content is really covered by a feature', () => {
    // A stale exemption makes the list a lie. Each must name a feature that
    // exists and that renders the structure the label is an instance of.
    const ids = new Set(sheets.DESIGN_FEATURES.map(f => f.id));
    const labels = new Set([...designLabels('Location Card.dc.html'), ...designLabels('Prop Card.dc.html')]);
    for (const [label, featureId] of Object.entries(IS_CONTENT)) {
        assert.ok(labels.has(label), `"${label}" is excused as content and is no longer in any design`);
        assert.ok(ids.has(featureId), `"${label}" claims feature ${featureId}, which does not exist`);
    }
});

test('every design feature is declared with the phrase it came from', () => {
    // A feature with no source phrase is one nobody can check against the
    // design — it becomes whatever the implementer remembered.
    assert.ok(sheets.DESIGN_FEATURES.length >= 20,
        `${sheets.DESIGN_FEATURES.length} features is fewer than the two designs describe`);
    for (const f of sheets.DESIGN_FEATURES) {
        assert.ok(['location', 'prop', 'both'].includes(f.subject), `${f.id}: unknown subject`);
        assert.ok(f.from && f.from.length > 3, `${f.id}: does not say where in the design it comes from`);
        assert.ok(f.anchor, `${f.id}: no anchor to hold the renderer to`);
        assert.ok(f.what && f.what.length > 15, `${f.id}: does not say what it is`);
    }
    const ids = sheets.DESIGN_FEATURES.map(f => f.id);
    assert.equal(new Set(ids).size, ids.length, 'two features share an id');
});

test('the phrase each feature cites is really in the design', () => {
    // A stale citation makes the whole registry a story. Checked against the
    // handoff text, so a feature invented here fails.
    const text = {};
    for (const s of SUBJECTS) {
        text[s.kind] = fs.readFileSync(path.join(HANDOFF, s.file), 'utf8').replace(/\s+/g, ' ');
    }
    for (const f of sheets.DESIGN_FEATURES) {
        const where = f.subject === 'both' ? ['location', 'prop'] : [f.subject];
        const found = where.some(k => text[k].includes(f.from));
        assert.ok(found, `${f.id}: cites "${f.from}", which is in no design file`);
    }
});

test('every design feature is rendered', () => {
    for (const f of sheets.DESIGN_FEATURES) {
        const where = f.subject === 'both' ? SUBJECTS : SUBJECTS.filter(s => s.kind === f.subject);
        for (const s of where) {
            const body = rendererBody(s.renderer);
            /*
             * Matched as a WHOLE token, not a substring.
             *
             * `includes('ss-plan')` is satisfied by `ss-plan-x`, so renaming a
             * class kept every one of these green — nine of ten mutations
             * survived the first version of this check for exactly that
             * reason. The anchor must not be followed by another class
             * character.
             */
            const whole = new RegExp(
                f.anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_-])');
            assert.ok(whole.test(body),
                `${s.kind}/${f.id}: the design asks for this and the sheet does not draw it `
                + `(no "${f.anchor}") — from: ${f.from}`);
        }
    }
});

test('every field a design feature shows is served by the API', () => {
    /*
     * The check the first build shipped without, applied to the new structure:
     * six description sections, a list of continuity flags, material rows with
     * a colour — a region that renders them and is fed by nothing looks
     * finished and shows an empty sheet on every real subject.
     */
    const { db } = require('../db/database');
    require('../db/schema').ensureSchema();
    const { handleLocations } = require('../routes/locations');

    const PROJECT = 'cd000000-0000-4000-8000-0000000000c1';
    db.prepare(`INSERT OR IGNORE INTO film_projects (id, title, created_at, updated_at)
                VALUES (?, 'p', datetime('now'), datetime('now'))`).run(PROJECT);

    const call = (method, urlParts, body) => new Promise(resolve => {
        const res = {
            writeHead(status) { this._s = status; },
            end(payload) { resolve({ status: this._s, body: payload ? JSON.parse(payload) : null }); },
        };
        handleLocations({ method, body }, res, urlParts, {});
    });

    return (async () => {
        for (const s of SUBJECTS) {
            const plural = `${s.kind}s`;
            const made = await call('POST', ['film', 'projects', PROJECT, plural],
                { name: `design probe ${s.kind} ${Date.now()}` });
            const id = made.body.id;
            const one = await call('GET', ['film', plural, id]);
            const served = one.body || {};

            const starved = [];
            for (const f of sheets.DESIGN_FEATURES) {
                if (f.subject !== 'both' && f.subject !== s.kind) continue;
                for (const field of (f.reads || [])) {
                    if (!(field in served)) starved.push(`${f.id}.${field}`);
                }
            }
            assert.deepEqual(starved, [],
                `${s.kind}: features showing fields the API never serves: ${starved.join(', ')}`);
        }
    })();
});

test('the not-sent marker is on the field, not just in the helper', () => {
    /*
     * `ssReach('not-sent')` renders the mark and `ssReach` itself contains the
     * words "not sent" — so a check that reads the helper passes even when no
     * field asks for it. Swapping the sound notes to claim they reach the
     * prompt survived the first version of this test.
     */
    const loc = fnBody('renderLocationSheet');
    assert.ok(/ssReach\('not-sent'\)/.test(loc),
        'no field on the location sheet is marked as NOT reaching the prompt');
    // The mark is the section's own argument, so it sits after the field that
    // carries it rather than in the title — the window is the section body.
    assert.ok(/'ls-sound'[\s\S]{0,600}ssReach\('not-sent'\)/.test(loc),
        'the not-sent mark is not on the sound notes, which is the field it is for');
    // Bounded by the SECTION, not a character window: a window of 600 went out
    // of range the day the lighting section grew two fields, and reported the
    // feature broken while it worked.
    const lightingSection = loc.slice(loc.indexOf("'ls-lighting'"), loc.indexOf('ssSection(', loc.indexOf("'ls-lighting'")));
    assert.ok(/ssReach\('prompt'\)/.test(lightingSection),
        'lighting is not marked as reaching the prompt');
    assert.ok(/ssReach\('prompt'\)/.test(loc), 'nothing is marked as reaching the prompt');

    // And the prop's description is marked too — the mark was written into the
    // `what` argument, which ssSection escapes, so it rendered as literal
    // `<span …>` text on both sheets.
    const prop = fnBody('renderPropSheet');
    assert.ok(/'ps-description'[\s\S]{0,1400}ssReach\('prompt'\)/.test(prop),
        'the prop description is not marked as the text the generator receives');
});

test('the six sections are what the generator actually reads', () => {
    /*
     * buildPlatePrompt reads film_locations.description and nothing else. A
     * sheet that stores six sections and leaves that column alone takes a whole
     * set description and sends NONE of it — the fields fill and the plate
     * generates from an empty string.
     */
    const { db } = require('../db/database');
    require('../db/schema').ensureSchema();
    const { handleLocations } = require('../routes/locations');
    const PROJECT = 'ce000000-0000-4000-8000-0000000000e1';
    db.prepare(`INSERT OR IGNORE INTO film_projects (id, title, created_at, updated_at)
                VALUES (?, 'p', datetime('now'), datetime('now'))`).run(PROJECT);
    const call = (method, urlParts, body) => new Promise(resolve => {
        const res = {
            writeHead(st) { this._s = st; },
            end(p) { resolve({ status: this._s, body: p ? JSON.parse(p) : null }); },
        };
        handleLocations({ method, body }, res, urlParts, {});
    });

    return (async () => {
        const made = await call('POST', ['film', 'projects', PROJECT, 'locations'],
            { name: `compose probe ${Date.now()}` });
        const id = made.body.id;
        await call('PUT', ['film', 'locations', id], {
            description_sections: { layout: 'One long room, north window.', place: 'A 1955 diner.' },
        });
        const back = await call('GET', ['film', 'locations', id]);
        assert.match(back.body.description, /One long room, north window\./,
            'the sections do not reach `description`, which is the only thing the plate prompt reads');
        assert.match(back.body.description, /A 1955 diner\./);
        // In the template's ORDER: where things are, then what kind of room.
        assert.ok(back.body.description.indexOf('One long room') < back.body.description.indexOf('A 1955 diner'),
            'the sections compose in an order the template does not describe');

        // And a location with no sections keeps what it had.
        const plain = await call('POST', ['film', 'projects', PROJECT, 'locations'],
            { name: `plain probe ${Date.now()}`, description: 'typed before sections existed' });
        await call('PUT', ['film', 'locations', plain.body.id], { lighting_default: 'low sun' });
        const kept = await call('GET', ['film', 'locations', plain.body.id]);
        assert.equal(kept.body.description, 'typed before sections existed',
            'a location described before the sections existed had its description rewritten');

        /*
         * AND WRITING A SECTION MUST NOT SILENTLY REPLACE IT.
         *
         * Every location in every existing project is described the old way, so
         * composing over it means the first section anyone fills in destroys
         * the whole set description. Done to a real location while verifying
         * and recovered from the write-ahead log, which is not a recovery
         * anyone should have to make.
         */
        const clash = await call('PUT', ['film', 'locations', plain.body.id],
            { description_sections: { place: 'a room' } });
        assert.equal(clash.status, 409,
            'writing one section replaced an existing description without asking');
        assert.match(String(clash.body.hint || ''), /replace_description/,
            'the refusal does not say how to get past it');
        assert.equal(clash.body.existing_description, 'typed before sections existed',
            'the refusal does not hand back what it is protecting');
        const still = await call('GET', ['film', 'locations', plain.body.id]);
        assert.equal(still.body.description, 'typed before sections existed');

        // Deliberate is allowed, and it is what the sheet's "move it into a
        // section" button does — with the old text already in the sections.
        const forced = await call('PUT', ['film', 'locations', plain.body.id], {
            description_sections: { place: 'typed before sections existed' },
            replace_description: true,
        });
        assert.equal(forced.status, 200);
        const moved = await call('GET', ['film', 'locations', plain.body.id]);
        assert.equal(moved.body.description, 'typed before sections existed',
            'moving the text into a section lost it');

        assert.ok(/function ssImportDescription\(/.test(SRC), 'the sheet offers no way through the refusal');
        assert.ok(/onclick="ssImportDescription\(/.test(SRC), 'ssImportDescription is bound to nothing');
    })();
});

test('a plate with no view name fills the slot it is the identity of', () => {
    /*
     * Every plate generated before views existed carries no view name, so a
     * turntable that matches only on the name reported "locked 1/5" with the
     * front slot offering to generate — for a prop whose plate was sitting
     * right there. lib/plate-views.js ranks front first for the same reason:
     * it is the identity plate.
     */
    const fn = fnBody('ssViewFor') || SRC.match(/const ssViewFor = name => \{[\s\S]*?\n    \};/)[0];
    assert.ok(/bare/.test(fn), 'nothing looks for the view-less plate');
    assert.ok(/'front'/.test(fn),
        'a view-less plate does not fill the front slot, so an existing plate reads as missing');
});

test('both single GETs serve the plates from the shared reader', () => {
    // `views: []` still satisfies "the key is present", so the fed check cannot
    // see a route that stops looking. Bound to the reader both must call.
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'locations.js'), 'utf8');
    for (const [fn, kind] of [['getLocation', 'location'], ['getProp', 'prop']]) {
        const at = src.indexOf(`function ${fn}(`);
        assert.notStrictEqual(at, -1, `${fn} is gone`);
        const body = src.slice(at, src.indexOf('\nfunction ', at + 10));
        assert.ok(new RegExp(`plateViewsFor\\([a-zA-Z]+, '${kind}'\\)`).test(body),
            `${fn} does not read the plates, so the sheet opens on "no plate yet"`);
        /*
         * Bound to the gallery module's LOADERS, derived, not to one name.
         * This matched the literal `loadGallery(` and broke the day the routes
         * moved to `galleryForStrip` — the same shared reader, filtered — and
         * reported a working route as serving no gallery. A reader family is
         * what the check is about; which member a route calls is not.
         */
        const loaders = Object.keys(require('../lib/subject-gallery'))
            .filter(k => /^(load|gallery)/i.test(k) && /gallery/i.test(k));
        assert.ok(loaders.length, 'the gallery module exports no loader to bind to');
        assert.ok(loaders.some(l => new RegExp(`\\b${l}\\(`).test(body)),
            `${fn} serves no gallery — calls none of: ${loaders.join(', ')}`);
    }
});

test('what is fed to generation is marked, and what is not is marked too', () => {
    /*
     * The design says it four ways — "canonical · fed to generation",
     * "prompt source", "→ prompt", "not sent" — and that distinction is the
     * whole difference between a sheet and a form. A box beside the visual
     * prompt that looks like it conditions a frame and does not is worse than
     * one that is absent.
     */
    const marked = sheets.DESIGN_FEATURES.filter(f => f.reach);
    assert.ok(marked.length >= 4, 'the sheet never says what reaches the generator');
    for (const f of marked) {
        assert.ok(['prompt', 'not-sent'].includes(f.reach), `${f.id}: unknown reach '${f.reach}'`);
    }
    assert.ok(marked.some(f => f.reach === 'not-sent'),
        'nothing is marked as NOT reaching the generator, which is the mark that matters most');
});

test('every structured field the sheet writes is a real column', () => {
    const { db } = require('../db/database');
    require('../db/schema').ensureSchema();
    for (const s of SUBJECTS) {
        const cols = new Set(db.prepare(`PRAGMA table_info(film_${s.kind}s)`).all().map(c => c.name));
        const missing = (sheets.FIELDS[s.kind] || []).filter(f => !cols.has(f));
        assert.deepEqual(missing, [], `${s.kind}: writes columns that do not exist: ${missing.join(', ')}`);
    }
});

test('an agent can write the structured fields too', () => {
    // If the app stores it, an agent can set it — a sheet field no tool can
    // write is a capability that exists on one surface only.
    const tools = require('../lib/mcp-tools').listTools();
    for (const s of SUBJECTS) {
        const tool = tools.find(t => t.name === `${s.kind}_update`);
        const props = Object.keys(tool.inputSchema.properties || {});
        const missing = (sheets.FIELDS[s.kind] || []).filter(f => !props.includes(f));
        assert.deepEqual(missing, [], `${s.kind}_update cannot set: ${missing.join(', ')}`);
    }
});

/**
 * The PLATE LAYOUT each sheet's design asks for, read from the design itself.
 *
 * Reported three times as "the location and prop plates are still not fixed",
 * and every previous pass checked that the regions RENDER — which they do. The
 * fault is that all three sheets reuse the CHARACTER's plate grid: two columns
 * of 3/4 portraits. That is right for a turnaround and wrong for both others.
 *
 *   location   a 16/9 hero, full width, then three 4/3 tiles in a row
 *   prop       five 1/1 tiles, auto-fitting
 *   character  2-up portraits — already correct, and asserted so it stays
 *
 * A location plate is landscape because a location IS landscape; shown in a
 * portrait crop it is the wrong picture of the right place, which is precisely
 * what a plate exists to prevent.
 */
const PLATE_LAYOUTS = [
    { kind: 'location', file: 'Location Card.dc.html', cls: 'ls-plate', hero: '16/9', rest: '4/3' },
    { kind: 'prop', file: 'Prop Card.dc.html', cls: 'ps-plate', hero: '1/1', rest: '1/1' },
];

test('each sheet uses the plate shape its own design asks for', () => {
    for (const spec of PLATE_LAYOUTS) {
        const design = fs.readFileSync(path.join(HANDOFF, spec.file), 'utf8');

        // Derived: the aspect ratios the design's own plate tiles declare.
        const ratios = [...new Set([...design.matchAll(/aspect-ratio:\s*([0-9]+\s*\/\s*[0-9]+)/g)]
            .map(m => m[1].replace(/\s+/g, '')))];
        assert.ok(ratios.includes(spec.hero),
            `${spec.kind}: the design does not declare ${spec.hero} — this test's reading is stale `
            + `(it declares ${ratios.join(', ')})`);

        // The page must have a plate rule OF ITS OWN for this kind, at that
        // shape. Reusing .cs-plate is the defect: it is the character's.
        const rule = new RegExp(`\\.${spec.cls}\\b[^}]*aspect-ratio\\s*:\\s*${spec.hero.replace('/', '\\s*/\\s*')}`);
        assert.ok(rule.test(SRC),
            `${spec.kind}: no .${spec.cls} rule at ${spec.hero} — the sheet is still using the `
            + "character's portrait grid, which is the wrong shape for this subject");
    }
});

test('the location sheet leads with ONE hero plate, not a row of equals', () => {
    /*
     * The design gives 01 · Master its own full-width block above the others,
     * because the establishing plate is what every shot in the scene is
     * re-photographed against — it is not one of four, it is the one.
     */
    const design = fs.readFileSync(path.join(HANDOFF, 'Location Card.dc.html'), 'utf8');
    assert.ok(/grid-template-columns:\s*repeat\(3,/.test(design),
        "this test's reading is stale: the design no longer lays the other plates three-up");

    assert.ok(/ls-plates-hero|ls-hero/.test(SRC),
        'the location sheet has no hero plate — every plate is rendered the same size, so the '
        + 'establishing plate does not read as the one the scene is built on');
    assert.ok(/\.ls-plates-rest[^}]*repeat\(3/.test(SRC),
        'the remaining location plates are not laid out three-up as the design asks');
});

/**
 * The plate, as the design draws it
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Reported three times, and each earlier fix changed the plate's SHAPE while
 * leaving the two things that actually read as unfinished:
 *
 *   1. The sheet body sits FLUSH to the modal frame. All three designs put a
 *      ~30px gutter on their column blocks; `.ss-grid` had none at all, so
 *      "MASTER PLATES" began 2px from the modal edge and the right column ran
 *      into the other one. The character sheet does not have this bug because
 *      it never used `.ss-grid` — it has its own `.cs-col-l` with padding,
 *      which is precisely why the fault was invisible on the one sheet anyone
 *      compared against.
 *
 *   2. The label and the `generate →` affordance sit OUTSIDE the tile — the
 *      label in a `<figcaption>` beneath it, and `generate →` centred in the
 *      middle of the empty box. The design puts both INSIDE, absolutely
 *      positioned: the label top-left, `generate →` bottom-left. That is what
 *      makes a plate read as a numbered slot on a contact sheet rather than a
 *      captioned photograph, and it is why the sheets were reported as "not
 *      the same quality as the character sheets".
 *
 * Derived from the handoffs rather than from my reading of the screenshots: the
 * design states each offset literally, so a design that moves takes this test
 * with it.
 */

/** Every sheet whose plates the design draws, with the page rule that draws them. */
const PLATE_SHEETS = [
    { kind: 'character', design: 'Character Card.dc.html', cls: 'cs-tile' },
    { kind: 'location',  design: 'Location Card.dc.html',  cls: 'ls-plate' },
    { kind: 'prop',      design: 'Prop Card.dc.html',      cls: 'ps-plate' },
];

test('every sheet body carries the gutter its design draws, none sits flush to the frame', () => {
    /*
     * Derived: the design's own column blocks. Reading the smallest horizontal
     * padding any of them uses keeps this honest if the design tightens up —
     * what it cannot do is silently permit zero, which is the reported state.
     */
    for (const sheet of PLATE_SHEETS) {
        const design = fs.readFileSync(path.join(HANDOFF, sheet.design), 'utf8');
        const gutters = [...design.matchAll(/padding:\s*\d+px\s+(\d+)px/g)].map(m => Number(m[1]));
        const wanted = Math.min(...gutters.filter(n => n >= 20));
        assert.ok(wanted >= 20,
            `${sheet.kind}: this test's reading is stale — the design no longer puts a gutter on `
            + 'its column blocks');
    }

    /*
     * The rule that lays out a subject sheet's two columns. The character sheet
     * uses .cs-col-l/.cs-col-r and already has this; the location and prop
     * sheets share .ss-grid and had nothing.
     */
    /*
     * ON THE CONTAINER OR ON ITS COLUMNS -- the design does the latter.
     *
     * This required padding on `.ss-grid` itself, which was right while the
     * body was a single padded grid. The design pads each COLUMN instead
     * (`28px 28px 32px 32px` on the plates column, `28px 32px 32px 30px` on
     * the description one) and the sheets now follow it, so the old assertion
     * failed a body that is closer to the design than the one it was written
     * for. The invariant it protects is unchanged: nothing renders flush to
     * the modal frame.
     */
    const container = SRC.match(/\.ss-grid\s*\{([^}]*)\}/);
    assert.ok(container, '.ss-grid is gone — this test cannot see how the sheets are laid out');

    const columnPads = [...SRC.matchAll(/\.(?:ls|ps)-grid\s*>\s*\.ss-col[^{]*\{([^}]*)\}/g)]
        .map(m => (m[1].match(/padding\s*:\s*([^;]+)/) || [])[1])
        .filter(Boolean);
    const containerPad = (container[1].match(/padding:\s*([^;]+)/) || [])[1];

    assert.ok(containerPad || columnPads.length,
        'neither the sheet body nor its columns carry a gutter, so the sheets render flush to '
        + 'the modal frame: "MASTER PLATES" begins against the edge and the right column runs '
        + 'into it. The design puts ~30px on every column block.');

    const gutters = (containerPad ? [containerPad] : columnPads)
        .map(v => v.trim().split(/\s+/).map(x => parseInt(x, 10)))
        .map(sides => (sides.length > 1 ? sides[1] : sides[0]));
    for (const horizontal of gutters) {
        assert.ok(horizontal >= 20,
            `a sheet column's horizontal gutter is ${horizontal}px — the design draws ~30px, and `
            + 'anything this tight still reads as flush to the frame');
    }
});

test('a plate carries its number and its generate affordance INSIDE the tile', () => {
    /*
     * Set-based over all three sheets, because this failed PARTIALLY: the
     * character tile has had `.tl { position:absolute; bottom:6px; left:8px }`
     * since it was written, so a check against the character sheet alone
     * passes in exactly the state being reported.
     */
    for (const sheet of PLATE_SHEETS) {
        const design = fs.readFileSync(path.join(HANDOFF, sheet.design), 'utf8');

        // The design's own evidence that a label is placed inside the tile.
        assert.ok(/position:\s*absolute;\s*top:\s*\d+px;\s*left:\s*\d+px/.test(design)
               || /position:\s*absolute;\s*bottom:\s*\d+px;\s*left:\s*\d+px/.test(design),
            `${sheet.kind}: this test's reading is stale — the design no longer positions plate `
            + 'labels inside the tile');

        // The page must place a label inside THIS sheet's plate, not beneath it.
        const inside = new RegExp(`\\.${sheet.cls}\\s+\\.(?:tl|ss-num|ss-gen)\\b[^}]*position\\s*:\\s*absolute`);
        assert.ok(inside.test(SRC),
            `${sheet.kind}: .${sheet.cls} has no absolutely-positioned label inside it, so the `
            + 'plate number renders in a caption underneath and `generate →` floats in the middle '
            + 'of the box. The design puts the number top-left and `generate →` bottom-left, '
            + 'inside the tile.');
    }
});

test('the generate affordance is bottom-left, not centred in the middle of the plate', () => {
    /*
     * The reported symptom, specifically: on both sheets `generate →` rendered
     * centred at the top of the tile because the empty slot was a flex box with
     * `align-items:center; justify-content:center`. The design puts it at
     * `bottom: 8px; left: 9px`.
     */
    const design = fs.readFileSync(path.join(HANDOFF, 'Location Card.dc.html'), 'utf8');
    assert.ok(/generate/.test(design) && /bottom:\s*\d+px;\s*left:\s*\d+px/.test(design),
        "this test's reading is stale: the design no longer anchors `generate →` bottom-left");

    const rule = SRC.match(/\.ss-gen\s*\{([^}]*)\}/);
    assert.ok(rule,
        'there is no .ss-gen rule — `generate →` is still centred inside the empty plate rather '
        + 'than anchored bottom-left where the design draws it');
    assert.ok(/position\s*:\s*absolute/.test(rule[1]) && /bottom\s*:/.test(rule[1])
           && /left\s*:/.test(rule[1]),
        '.ss-gen does not anchor to the bottom-left of the tile');
    assert.ok(!/justify-content\s*:\s*center/.test(rule[1]),
        '.ss-gen is still centring itself — that is the state that was reported');
});

test('the plate renderer emits the in-tile label and affordance, not just a CSS rule for them', () => {
    /*
     * The CSS rule existing says nothing about whether anything wears the
     * class. Caught by mutation: renaming `ss-num` inside ssTile left every
     * rule-shaped assertion green while the page went back to rendering the
     * label in a caption underneath — the exact reported state, with a test
     * suite reporting it fixed.
     *
     * Bound to ssTile's own body rather than searched page-wide, because
     * `ss-num` appearing anywhere in a 2MB file is not evidence that the plate
     * uses it.
     */
    const fn = SRC.match(/function ssTile\s*\([^)]*\)\s*\{([\s\S]*?)\n    \}/);
    assert.ok(fn, 'ssTile is gone — this test cannot see how a plate is drawn');
    const body = fn[1];

    assert.ok(/class="ss-num"/.test(body),
        'ssTile does not emit the ss-num label, so the plate number renders beneath the tile in '
        + 'a caption rather than over the picture where the design puts it');
    assert.ok(/class="ss-gen"/.test(body),
        'ssTile does not emit the ss-gen affordance — `generate →` is back in the middle of the '
        + 'empty box instead of bottom-left');

    /*
     * Both belong INSIDE the tile div, not after it.
     *
     * Bounded by the tile's OWN closing tag, found as the last `</div>` before
     * the caption — the first one belongs to the empty-slot div nested inside,
     * so a slice to it is too short and reports a correct renderer as broken.
     */
    const tileOpen = body.indexOf('class="${cls}"');
    const capAt = body.indexOf('${caption ?');
    assert.ok(tileOpen > -1 && capAt > tileOpen, 'ssTile no longer draws a tile div and a caption');
    const tileRegion = body.slice(tileOpen, capAt);
    const tileClose = tileRegion.lastIndexOf('</div>');
    assert.ok(tileClose > -1, 'the tile div is never closed');
    const insideTile = tileRegion.slice(0, tileClose);
    assert.ok(/class="ss-num"/.test(insideTile) && /class="ss-gen"/.test(insideTile),
        'the label and the generate affordance are emitted OUTSIDE the tile div — absolute '
        + 'positioning then anchors them to the figure, not to the picture');

    // And the empty slot must not re-centre its contents.
    assert.ok(!/ss-empty[^`]*justify-content:\s*center/.test(body),
        'the empty plate still centres its contents, which is what put `generate →` in the '
        + 'middle of the box');
});
