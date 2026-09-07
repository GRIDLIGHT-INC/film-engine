/**
 * THE ALEPH CONTRACT, FROM RUNWAY RATHER THAN FROM AN AGGREGATOR.
 *
 * The research that produced this epic read Runware's docs — a reseller's
 * description of somebody else's API. That is a secondary source, and building
 * an adapter on one is how a field name that exists in the wrapper and not in
 * the provider reaches production. MuAPI already cost this codebase exactly
 * that: `image_urls` was accepted, ignored, and every reference image was
 * silently discarded.
 *
 * So this file records what RUNWAY says, with the date and the URL, and holds
 * the record to being complete. It deliberately does NOT probe: Marble
 * validates before it bills, but RBF-001 measured a FAILED Seedance job still
 * charging $1.658, so "validation is free" is a property of a provider and not
 * a law. Establishing it for Runway is its own decision with its own spend, and
 * this task's criteria ask for a documentation check.
 *
 * Set-based over the FOUR things the task names — schema, duration window,
 * reference handling, credit rate — because three of four recorded is an
 * adapter written against a guess about the fourth.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'aleph-contract.json');
const contract = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

/** The four things the task requires be confirmed. */
const REQUIRED = ['schema', 'duration', 'references', 'pricing'];

test('the contract is recorded, dated, and sourced to Runway itself', () => {
    assert.ok(fs.existsSync(FIXTURE), 'no aleph-contract.json — nothing was recorded');
    const c = contract();
    assert.match(String(c.checked || ''), /^\d{4}-\d{2}-\d{2}$/, 'no checked date');
    assert.match(String(c.source || ''), /runwayml\.com/,
        'the source is not Runway — an aggregator is a secondary source and is what this task exists to replace');
    assert.ok(String(c.how || '').length > 40, 'the record does not say how it was obtained');
});

test('all four required areas are recorded, each with its own source', () => {
    const c = contract();
    const missing = REQUIRED.filter((k) => !c[k]);
    assert.deepStrictEqual(missing, [],
        `not confirmed: ${missing.join(', ')} — an adapter would be written against a guess about these`);
    for (const k of REQUIRED) {
        assert.ok(String(c[k].source || '').length > 10,
            `${k} is recorded with no source, so nobody can re-check it`);
    }
});

test('the schema names the endpoint and the model id an adapter would send', () => {
    const c = contract();
    assert.ok(c.schema.endpoint, 'no endpoint recorded');
    assert.ok(c.schema.model, 'no model id recorded');
    assert.ok(Array.isArray(c.schema.fields) && c.schema.fields.length >= 2,
        'the schema records fewer than two fields — that is not a request shape');
});

test('the duration window is two real numbers, not prose', () => {
    const c = contract();
    assert.ok(Number.isFinite(c.duration.min_seconds), 'no minimum duration');
    assert.ok(Number.isFinite(c.duration.max_seconds), 'no maximum duration');
    assert.ok(c.duration.max_seconds > c.duration.min_seconds, 'the window is inverted or empty');
});

test('the price is a number in a stated unit, so an estimate can be built', () => {
    const c = contract();
    assert.ok(Number.isFinite(c.pricing.credits_per_second), 'no per-second rate');
    assert.ok(c.pricing.unit, 'the rate has no unit, so it cannot be converted');
    /*
     * A minimum charge is the field an estimate gets wrong. RBF-001 overran
     * 4.7x partly because a minimum was not modelled — recorded here even when
     * it is zero, so its absence is a statement rather than an omission.
     */
    assert.ok('minimum_credits' in c.pricing,
        'no minimum charge recorded — an estimate that ignores one is wrong on every short clip');
});

test('reference handling says how many and where they attach', () => {
    const c = contract();
    assert.ok(Number.isFinite(c.references.max), 'no maximum number of references');
    assert.ok(Array.isArray(c.references.positions) && c.references.positions.length,
        'nothing records WHERE a reference attaches — first, last or a timestamp is the whole feature');
});

test('every difference from the aggregator is written down', () => {
    /*
     * The point of a first-party check is the DELTA. "No differences" is a
     * finding and must be stated as one; an absent field is indistinguishable
     * from nobody having looked.
     */
    const c = contract();
    assert.ok(Array.isArray(c.differences_from_aggregator),
        'the record does not say what differed from the aggregator docs the research used');
    for (const d of c.differences_from_aggregator) {
        assert.ok(String(d.field || '').length, 'a difference names no field');
        assert.ok(String(d.aggregator_said || '').length, 'a difference does not say what the aggregator said');
        assert.ok(String(d.runway_says || '').length, 'a difference does not say what Runway says');
    }
    assert.ok(String(c.differences_note || '').length > 20,
        'there is no statement about the comparison as a whole — an empty array could mean "none" or "not compared"');
});

test('NO adapter code was written — that is the next task', () => {
    /*
     * The task's own last criterion. Verifying a contract and then immediately
     * building against it in the same change removes the point of verifying:
     * the record and the code land together and nobody can tell which was
     * checked against which.
     */
    for (const f of ['backend/lib/providers/runway.js', 'backend/lib/mcp-tools.js']) {
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        assert.ok(!/aleph/i.test(src),
            `${f} already mentions aleph — the adapter was written before the contract was verified`);
    }
});

test('the record says plainly that it was not probed, and why', () => {
    /*
     * Marble's contract WAS probed, for nothing, because it validates before
     * billing. Recording the two the same way would imply this one was checked
     * against a live endpoint when it was not.
     */
    const c = contract();
    assert.match(String(c.how), /not probed|documentation|no request/i,
        'the record does not distinguish a documentation check from a live probe');
    assert.ok(String(c.probe_note || '').length > 40,
        'nothing states whether a free probe is even possible here — RBF-001 measured a failed '
        + 'Seedance job still billing, so it cannot be assumed from Marble');
});
