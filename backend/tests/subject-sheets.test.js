/**
 * A location and a prop are workspaces too
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The character card became a sheet: official views, everything written,
 * wardrobe, palette, a concept band. Locations and props stayed a form in a
 * modal — which is the same gap the character card had, seen from two other
 * subjects, and the design handoffs in design_handoff_character_card/ describe
 * what they should be instead.
 *
 * Set-based over the region registries. A sheet that draws the plates and
 * silently drops the continuity states looks finished in a screenshot, which
 * is exactly how a half-built sheet ships.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-sheets-' + crypto.randomUUID().slice(0, 8));

const sheets = require('../lib/subject-sheets');
const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
const HANDOFF = path.join(__dirname, '..', '..', 'design_handoff_character_card');

const SUBJECTS = [
    { kind: 'location', regions: () => sheets.LOCATION_REGIONS, handoff: 'Location Card.dc.html' },
    { kind: 'prop', regions: () => sheets.PROP_REGIONS, handoff: 'Prop Card.dc.html' },
];

test('every region the design asks for is declared', () => {
    for (const s of SUBJECTS) {
        const regions = s.regions();
        assert.ok(regions.length >= 8, `${s.kind}: ${regions.length} regions is fewer than the design describes`);
        for (const r of regions) {
            assert.ok(r.id && r.title, `${s.kind}: a region with no id or title`);
            assert.ok(r.what && r.what.length > 15, `${s.kind}/${r.id}: does not say what it holds`);
            // The anchor is what the renderer must actually contain, so a
            // region cannot be declared and then quietly not drawn.
            assert.ok(r.anchor, `${s.kind}/${r.id}: no anchor to hold the renderer to`);
        }
    }
});

test('the design handoff each region came from is on disk', () => {
    for (const s of SUBJECTS) {
        assert.ok(fs.existsSync(path.join(HANDOFF, s.handoff)),
            `${s.handoff} is gone — the regions can no longer be checked against what was asked for`);
    }
});

test('every region is rendered by the sheet', () => {
    for (const s of SUBJECTS) {
        const name = `render${s.kind[0].toUpperCase()}${s.kind.slice(1)}Sheet`;
        const at = SRC.indexOf(`function ${name}(`);
        assert.notStrictEqual(at, -1, `there is no ${s.kind} sheet renderer`);
        const body = SRC.slice(at, at + 16000);
        const absent = s.regions().filter(r => !body.includes(r.anchor)).map(r => r.id);
        assert.deepEqual(absent, [],
            `${s.kind}: declared regions the sheet never draws: ${absent.join(', ')}`);
    }
});

test('every region is FED, not just drawn', () => {
    /*
     * The check this shipped without. Four regions rendered perfectly and were
     * fed by nothing — the prop plates, the prop's shot count, the location's
     * scene count, and the category picker — because the sheet was written
     * against the fields the LIST endpoint serves and opened against the single
     * GET. Each read the field it declares here, and each field must actually
     * arrive.
     */
    const { db } = require('../db/database');
    require('../db/schema').ensureSchema();
    const { handleLocations } = require('../routes/locations');

    const PROJECT = 'bd000000-0000-4000-8000-0000000000b1';
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
                { name: `probe ${s.kind} ${Date.now()}` });
            assert.ok(made.status === 201 || made.status === 200, JSON.stringify(made.body));
            const id = made.body.id;

            const one = await call('GET', ['film', plural, id]);
            const views = await call('GET', ['film', plural, id, 'plate', 'views']);
            assert.equal(views.status, 200,
                `${s.kind}: the sheet asks for plate/views and the route answers ${views.status}`);
            assert.ok(Array.isArray(views.body.views),
                `${s.kind}: plate/views answers a different shape than the sheet reads — `
                + 'which renders as "no plate yet" for a subject that has one');

            const served = { ...(one.body || {}), views: views.body.views };
            const starved = [];
            for (const r of s.regions()) {
                for (const field of (r.reads || [])) {
                    if (!(field in served)) starved.push(`${r.id}.${field}`);
                }
            }
            assert.deepEqual(starved, [],
                `${s.kind}: regions displaying fields the API never serves: ${starved.join(', ')}`);
        }
    })();
});

test('every region declares what it displays', () => {
    // A region with no `reads` is one the check above cannot police.
    for (const s of SUBJECTS) {
        for (const r of s.regions()) {
            assert.ok(Array.isArray(r.reads),
                `${s.kind}/${r.id}: does not say which payload fields it shows`);
            /*
             * An empty list is invisible to the fed check — it passes by
             * declaring nothing. So a region that shows no payload field must
             * say WHY, on the exempt-by-name-with-a-reason rule: an omission
             * that is stated is a decision, one that is silent is a bug.
             */
            assert.ok(r.reads.length || (r.shows_nothing && r.shows_nothing.length > 15),
                `${s.kind}/${r.id}: declares no fields and gives no reason — `
                + 'an empty `reads` opts the region out of every check silently');
        }
    }
});

test('the prop category picker offers what the database accepts', () => {
    // It fell back to ['', whatever this prop already is] — one option, so the
    // category could not be changed at all. The same "a picker must not offer
    // what the database refuses" rule, failing by offering almost nothing.
    assert.ok(/api\('\/card-vocabulary'\)/.test(SRC),
        'the sheet never asks for the vocabulary, so the picker is empty');
    assert.ok(/window\.__propCategories = \['', \.\.\.vocab\.prop_categories\]/.test(SRC),
        'the vocabulary is fetched and never used');
});

test('every region has a way IN, not just a label', () => {
    /*
     * The character sheet shipped with three read-only dead ends — a reference
     * band that could only be filled from another modal, wardrobe with no way
     * to record any, a palette pointing at a table with no UI. A region with
     * no way in is a label.
     */
    for (const s of SUBJECTS) {
        const ways = sheets.AUTHORING.filter(a => a.subject === s.kind);
        const uncovered = s.regions().filter(r => r.readonly !== true
            && !ways.some(a => a.region === r.id)).map(r => r.id);
        assert.deepEqual(uncovered, [],
            `${s.kind}: regions a director can look at and not fill: ${uncovered.join(', ')}`);

        for (const a of ways) {
            assert.ok(['upload', 'generate', 'manual', 'derived'].includes(a.source),
                `${s.kind}/${a.id}: '${a.source}' is not a way anything gets in`);
            assert.ok(typeof a.spends === 'boolean',
                `${s.kind}/${a.id}: does not say whether it costs money`);
            assert.ok(SRC.includes(`function ${a.fn}(`) || SRC.includes(`async function ${a.fn}(`),
                `${s.kind}/${a.id}: ${a.fn} does not exist on the page`);
            assert.ok(new RegExp(`(onclick|onchange)="[^"]*${a.fn}\\(`).test(SRC),
                `${s.kind}/${a.id}: ${a.fn} is bound to nothing`);
        }
    }
});

test('a read-only region says why, rather than being an oversight', () => {
    for (const s of SUBJECTS) {
        for (const r of s.regions().filter(x => x.readonly)) {
            assert.ok(r.derived_from && r.derived_from.length > 8,
                `${s.kind}/${r.id}: read-only with no reason — an omission that is stated is a decision`);
        }
    }
});

test('every field the sheet stores is a real column', () => {
    /*
     * A sheet that writes a field nothing persists looks like it works until
     * the modal is reopened. Checked against the schema the migrations build.
     */
    const { db } = require('../db/database');
    require('../db/schema').ensureSchema();
    const cols = kind => new Set(
        db.prepare(`PRAGMA table_info(film_${kind}s)`).all().map(c => c.name));
    for (const s of SUBJECTS) {
        const have = cols(s.kind);
        const missing = (sheets.FIELDS[s.kind] || []).filter(f => !have.has(f));
        assert.deepEqual(missing, [],
            `${s.kind}: the sheet writes columns that do not exist: ${missing.join(', ')}`);
    }
});

test('the field registry and the sheet agree, in both directions', () => {
    /*
     * FIELDS drives the schema check, the route check and the tool check — so a
     * field quietly dropped from it disappears from all three at once and every
     * one of them still passes. Held against what the sheet actually renders.
     */
    const NOT_A_SIMPLE_INPUT = {
        // Named with its control, on the rule manual-edit.test.js follows: a
        // repeating list is not one input, and refusing to say so would push a
        // real editor out of the registry.
        prop: { continuity_states: 'addPropState' },
    };
    for (const s of SUBJECTS) {
        const name = `render${s.kind[0].toUpperCase()}${s.kind.slice(1)}Sheet`;
        // Bounded to THIS renderer: a fixed slice runs into the next function
        // and reports the location sheet as editing a prop's materials.
        const at = SRC.indexOf(`function ${name}(`);
        assert.notStrictEqual(at, -1, `there is no ${name}`);
        const next = SRC.indexOf('\n    function ', at + 10);
        const body = SRC.slice(at, next === -1 ? at + 16000 : next);
        const rendered = new Set([...body.matchAll(/ssField\('([a-z_0-9]+)'/g)].map(m => m[1]));
        const declared = new Set(sheets.FIELDS[s.kind] || []);
        const exempt = NOT_A_SIMPLE_INPUT[s.kind] || {};

        const undeclared = [...rendered].filter(f => !declared.has(f));
        assert.deepEqual(undeclared, [],
            `${s.kind}: the sheet edits fields the registry does not declare: ${undeclared.join(', ')}`);

        const unrendered = [...declared].filter(f => !rendered.has(f) && !exempt[f]);
        assert.deepEqual(unrendered, [],
            `${s.kind}: the registry declares fields the sheet never renders: ${unrendered.join(', ')}`);

        for (const [field, control] of Object.entries(exempt)) {
            assert.ok(declared.has(field), `${s.kind}: ${field} is exempted and no longer declared`);
            assert.ok(SRC.includes(`function ${control}(`) || SRC.includes(`async function ${control}(`),
                `${s.kind}: ${field} claims ${control}, which is not on the page`);
        }
    }
});

test('the card stays two buttons, and what moved has a home', () => {
    // The character card learned this: eight buttons on a 260px tile is a
    // worse place to work than a sheet with room, and "simpler" only counts if
    // everything that moved is still reachable.
    for (const s of SUBJECTS) {
        for (const moved of sheets.RELOCATED.filter(r => r.subject === s.kind)) {
            assert.ok(SRC.includes(moved.now),
                `${s.kind}: '${moved.action}' was taken off the card and its new home is missing`);
        }
    }
});

test('an agent can set everything a person can', () => {
    /*
     * If the app stores it, a person can type it — and the other way round:
     * a field on the sheet that no tool can write is a capability that exists
     * on one surface only.
     */
    const tools = require('../lib/mcp-tools').listTools();
    for (const s of SUBJECTS) {
        const tool = tools.find(t => t.name === `${s.kind}_update`);
        assert.ok(tool, `${s.kind}_update is gone`);
        const props = Object.keys(tool.inputSchema.properties || {});
        const missing = (sheets.FIELDS[s.kind] || []).filter(f => !props.includes(f));
        assert.deepEqual(missing, [],
            `${s.kind}_update cannot set: ${missing.join(', ')}`);
    }
});

test('the routes accept every field the sheet writes', () => {
    // Props are served by routes/locations.js — the two share a router because
    // a prop plate and a location plate are the same operation. Read from the
    // module that actually dispatches, not from a filename guessed off the
    // subject's name.
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'locations.js'), 'utf8');
    for (const s of SUBJECTS) {
        const missing = (sheets.FIELDS[s.kind] || []).filter(f => !src.includes(f));
        assert.deepEqual(missing, [],
            `the ${s.kind} update route never reads: ${missing.join(', ')}`);
    }
    assert.ok(/UPDATE film_props/.test(src) && /UPDATE film_locations/.test(src),
        'the subjects moved to another router and this test is now reading the wrong file');
});
