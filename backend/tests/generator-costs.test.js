/**
 * Evaluating what a generator costs, before using it.
 *
 * "Do we have estimates for each provider and links so we can decide which one
 * to use for generating images and videos?"
 *
 * The rate book had all of it — per-model USD, a source URL and a checked date
 * for every provider — and none of it was usable for DECIDING:
 *
 *  - The Budget page rendered one card per provider, so ranking meant expanding
 *    seven cards and sorting in your head.
 *  - The per-model table printed `1 image(s) per image` for every row, because
 *    the renderer used `native_per_unit` where the route was already serving
 *    `usd_per_native`. The one table that could compare models showed NO MONEY
 *    AT ALL. Declared, served, and thrown away at the last step.
 *  - Nothing converted the units. Runway and OpenAI bill per IMAGE, Meshy per
 *    CALL and BFL per MEGAPIXEL, so $0.030 and $0.042 are not comparable
 *    numbers. Priced naively, flux-2-pro leads the table at $0.030 when a
 *    1920x1080 frame is 2.07 MP and really costs $0.062 — wrong at the top of
 *    a table whose only purpose is ordering.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    compareGenerators, COMPARABLE, unitsPerWork, DEFAULT_FRAME,
} = require('../lib/generator-costs');
const providers = require('../lib/providers');
const { rateFor } = require('../lib/provider-pricing');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/**
 * The denominator, DERIVED: every adapter declaring a shoppable capability.
 * A list typed here would be exactly as complete as the day it was written,
 * and the next adapter would be missing from the comparison silently.
 */
function declaredPairs() {
    const pairs = [];
    for (const adapter of providers.list()) {
        for (const capability of adapter.capabilities || []) {
            if (COMPARABLE.includes(capability)) pairs.push({ provider: adapter.id, capability });
        }
    }
    return pairs;
}

test('every generator that can serve a shoppable capability is priced', () => {
    const pairs = declaredPairs();
    assert.ok(pairs.length >= 8, `expected the real adapter set, got ${pairs.length}`);

    const unpriced = pairs.filter(p => !rateFor(p.provider, p.capability));
    assert.deepStrictEqual(unpriced, [],
        'these can generate and cannot be priced, so their spend would report as zero');
});

test('every generator appears in the comparison for the capability it declares', () => {
    for (const capability of COMPARABLE) {
        const report = compareGenerators(capability);
        const seen = new Set(report.rows.map(r => r.provider));
        const expected = declaredPairs().filter(p => p.capability === capability).map(p => p.provider);
        for (const provider of expected) {
            assert.ok(seen.has(provider),
                `${provider} serves ${capability} and is missing from the comparison`);
        }
        assert.deepStrictEqual(report.unpriced, [],
            `${capability}: unpriced generators must be empty or named`);
    }
});

test('a price is converted to the work unit it is being compared against', () => {
    /*
     * The bug this pins, with real numbers. BFL bills per megapixel; at the
     * default 1920x1080 frame that is 2.0736 units, so a $0.030/MP model costs
     * $0.062 a frame. Treating the megapixel as a frame under-prices it by
     * more than half and moves it up the table.
     */
    assert.strictEqual(unitsPerWork('image', 'image', {}), 1);
    assert.strictEqual(unitsPerWork('call', 'image', {}), 1);
    assert.ok(Math.abs(unitsPerWork('megapixel', 'image', {}) - 2.0736) < 1e-9,
        'a 1920x1080 frame is 2.0736 megapixels');
    assert.strictEqual(unitsPerWork('second', 'video', { clip_seconds: 8 }), 8);

    // A larger delivery frame costs more from a per-megapixel provider and the
    // same from a per-image one. If both move, the conversion is not happening.
    const hd = compareGenerators('image', { frame: DEFAULT_FRAME });
    const uhd = compareGenerators('image', { frame: { width: 3840, height: 2160 } });
    const find = (r, unit) => r.rows.find(x => x.unit === unit && !x.self_hosted);

    // No registered provider bills per megapixel since Black Forest Labs was
    // removed (2026-09-30); the conversion itself is pinned above, and this
    // holds the table to it the day one is added again.
    const mpHd = find(hd, 'megapixel');
    const mpUhd = find(uhd, 'megapixel');
    if (mpHd && mpUhd) {
        assert.ok(mpUhd.usd_per_work > mpHd.usd_per_work * 3.9,
            'a 4K frame is 4x the megapixels and must cost about 4x from a per-MP provider');
    }

    const imgHd = find(hd, 'image');
    const imgUhd = find(uhd, 'image');
    assert.strictEqual(imgUhd.usd_per_work, imgHd.usd_per_work,
        'a per-image provider charges per image, so the frame size must not change its price');
});

test('the ordering is by the converted price, not the raw rate', () => {
    const rows = compareGenerators('image').rows.filter(r => !r.self_hosted);
    for (let i = 1; i < rows.length; i++) {
        assert.ok(rows[i].usd_per_work >= rows[i - 1].usd_per_work,
            `row ${i} (${rows[i].model}) is cheaper than the row above it — the table is not sorted`);
    }

    // A self-hosted zero must not lead: it is zero because nobody bills for it,
    // and at the top of a ranked table that reads as a recommendation.
    const all = compareGenerators('image').rows;
    const firstSelfHosted = all.findIndex(r => r.self_hosted);
    if (firstSelfHosted !== -1) {
        assert.strictEqual(firstSelfHosted, all.length - 1,
            'the self-hosted row must sort last, not lead the table at $0');
    }
});

test('every row carries a source and a checked date', () => {
    for (const capability of COMPARABLE) {
        for (const row of compareGenerators(capability).rows) {
            assert.ok(row.source && /^https?:\/\//.test(row.source),
                `${row.provider}:${row.model} has no source URL — the rate cannot be re-verified`);
            assert.ok(row.checked && /^\d{4}-\d{2}-\d{2}$/.test(row.checked),
                `${row.provider}:${row.model} has no checked date`);
            assert.ok(Number.isInteger(row.checked_age_days) && row.checked_age_days >= 0,
                `${row.provider}:${row.model} has no usable checked age`);
        }
    }
});

test('a provider with no credential is listed and marked, never hidden', () => {
    /*
     * Hiding it answers "which should I use" while withholding "and this one
     * is half the price if you sign up" — which is the decision being made.
     *
     * PROBED BY REMOVING THE CREDENTIALS, not by reading the rows. Every
     * provider is credentialed on a working install, so an assertion of the
     * form "if unavailable then it says why" is vacuously true and passes just
     * as happily against a filter that drops them. The first version of this
     * test did exactly that, and a mutation inserting `continue` for
     * uncredentialed providers did not fail it.
     */
    const real = providers.isProviderConfigured;
    let starved;
    try {
        providers.isProviderConfigured = () => false;
        starved = COMPARABLE.map(c => compareGenerators(c));
    } finally {
        providers.isProviderConfigured = real;
    }

    const full = COMPARABLE.map(c => compareGenerators(c));

    starved.forEach((report, i) => {
        assert.strictEqual(report.rows.length, full[i].rows.length,
            `${COMPARABLE[i]}: rows disappeared when credentials did — an unusable price is `
            + 'still the information you need to decide whether to go and get a key');

        for (const row of report.rows) {
            assert.strictEqual(typeof row.available, 'boolean',
                `${row.provider} does not report whether it can actually be used`);
            // Adapters that need no key stay available; the rest must say why not.
            if (!row.available) {
                assert.ok(row.needs && row.needs.length,
                    `${row.provider} is unavailable and does not say what it needs`);
            }
        }

        assert.ok(report.rows.some(r => r.available === false),
            `${COMPARABLE[i]}: nothing reported as unavailable even with every credential removed, `
            + 'so the availability column cannot be reflecting credentials at all');
    });
});

test('an unshoppable capability is refused rather than priced as something else', () => {
    assert.throws(() => compareGenerators('voice'), /not a shoppable capability/);
    assert.throws(() => compareGenerators('lipsync'), /not a shoppable capability/);
});

test('the page renders the PRICE per model, not the conversion factor', () => {
    /*
     * The original defect, pinned. `qty(m.native_per_unit) + native_unit + per
     * + unit` renders "1 image(s) per image" — a perfectly well-formed string
     * carrying no money, which is why it survived every check that asked
     * whether the table rendered.
     */
    const at = SPA.indexOf('${rate.models.length} model rate(s)');
    assert.notStrictEqual(at, -1, 'the per-model rate table is gone from the Rates panel');
    const table = SPA.slice(at, at + 1400);
    assert.match(table, /m\.usd_per_native/,
        'the per-model table does not render the price the route already serves');
});

test('the comparison is reachable from the page', () => {
    // A capability with no control is indistinguishable from one that does not
    // exist — the lesson camera mode cost once already.
    assert.match(SPA, /switchBudgetTab\('compare'\)/, 'no Compare tab button');
    assert.match(SPA, /id="budgetTabCompare"/, 'no Compare panel to show');
    assert.match(SPA, /compare:\s*'budgetTabCompare'/, 'the Compare panel is not registered, so the tab shows nothing');
    assert.match(SPA, /function loadGeneratorCompare/, 'no loader');
    assert.match(SPA, /\/spend\/compare\?/, 'the page never calls the comparison route');

    for (const capability of COMPARABLE) {
        assert.ok(SPA.includes(`loadGeneratorCompare('${capability}')`),
            `no control to compare ${capability} generators`);
    }
});

test('the tool an agent uses is the same route the page uses', () => {
    const { listTools, ALL_ROUTE_TOOLS } = require('../lib/mcp-tools');

    // Listed AND dispatchable are different claims — plate_generate was listed,
    // described and schema'd for weeks while every call died before reaching a
    // route. So check the wire surface and the registry entry separately.
    assert.ok(listTools().some(t => t.name === 'spend_compare'),
        'spend_compare is not listed — an agent cannot price a choice it is asked to make');

    const tool = ALL_ROUTE_TOOLS.find(t => t.name === 'spend_compare');
    assert.ok(tool, 'spend_compare is listed but has no registry entry to dispatch through');
    assert.strictEqual(typeof tool.path, 'function');
    assert.match(tool.path({ capability: 'video', clip_seconds: 8 }),
        /^\/film\/spend\/compare\?capability=video/);
    assert.match(tool.description, /FREE/, 'the description must say it spends nothing');
});
