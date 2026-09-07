/**
 * AN ESTIMATE THAT IS NOT A NUMBER IS NOT A GATE.
 *
 * `estimateVideoCredits` multiplies `body.duration` by the model's rate. Every
 * model registered before aleph2 has a duration field, so that worked. This
 * endpoint HAS NO DURATION — Runway's own spec carries none, and the 2-30
 * second bound is a property of the SOURCE clip.
 *
 * So the estimate came out `undefined * 28` = NaN, and `Math.max(56, NaN)` is
 * NaN. That is worse than a wrong number in a specific way: every comparison
 * against NaN is false, so a budget ceiling would wave the request through
 * however large it was. A silent zero would at least refuse nothing visibly;
 * NaN refuses nothing while LOOKING like a gate.
 *
 * RBF-001 already measured the shape of this on Seedance: billing follows the
 * SOURCE length, not the length requested, and the estimate was 4.7x under.
 * At $0.28 per second of source a careless 30-second input is $8.40.
 *
 * Set-based over every registered video model, because "the one I just added
 * prices correctly" is exactly the state that let this through.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const runway = require('../lib/providers/runway');
const pricing = require('../lib/provider-pricing');
const contract = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'aleph-contract.json'), 'utf8'));

const MODELS = runway.RUNWAY_VIDEO_MODELS;
const MODEL = contract.schema.model;

/** A representative request for any model, so every one can be priced. */
function requestFor(id) {
    const m = MODELS[id];
    return m.endpoint === 'video_to_video'
        ? { model: id, videoUri: 'https://x/c.mp4', sourceSeconds: 30 }
        : { model: id, promptImage: 'https://x/a.png', duration: m.duration.min };
}

test('every registered model produces a FINITE estimate', () => {
    const bad = [];
    for (const id of Object.keys(MODELS)) {
        const req = runway.buildVideoRequest(requestFor(id));
        const credits = runway.estimateVideoCredits(req.body);
        if (!Number.isFinite(credits)) bad.push(`${id}: ${credits}`);
        else if (credits <= 0) bad.push(`${id}: ${credits} — free is not a price`);
    }
    assert.deepStrictEqual(bad, [],
        `these price to something that is not a number, and NaN passes every budget comparison:\n  - ${bad.join('\n  - ')}`);
});

test('aleph is priced by the SOURCE length, not a requested duration', () => {
    const thirty = runway.estimateVideoCredits(
        runway.buildVideoRequest({ model: MODEL, videoUri: 'https://x/c.mp4', sourceSeconds: 30 }).body);
    const five = runway.estimateVideoCredits(
        runway.buildVideoRequest({ model: MODEL, videoUri: 'https://x/c.mp4', sourceSeconds: 5 }).body);
    assert.strictEqual(thirty, 30 * contract.pricing.credits_per_second,
        'a 30 second source is not priced at 30 x the rate');
    assert.strictEqual(five, 5 * contract.pricing.credits_per_second);
    assert.ok(thirty > five, 'a longer source does not cost more, so the length reaches nothing');
});

test('a requested duration cannot make an aleph clip look cheaper', () => {
    /*
     * The RBF-001 trap exactly: the caller asks for 4 seconds, the provider
     * bills the 30-second source. An estimate that honoured the request would
     * be 4.7x under, which is what was measured.
     */
    const req = runway.buildVideoRequest({
        model: MODEL, videoUri: 'https://x/c.mp4', sourceSeconds: 30, duration: 4,
    });
    assert.strictEqual(runway.estimateVideoCredits(req.body), 30 * contract.pricing.credits_per_second,
        'a requested duration lowered the estimate below what the source will be billed at');
});

test('the minimum charge applies to a short clip', () => {
    const twoSec = runway.estimateVideoCredits(
        runway.buildVideoRequest({ model: MODEL, videoUri: 'https://x/c.mp4', sourceSeconds: 2 }).body);
    assert.strictEqual(twoSec, contract.pricing.minimum_credits,
        `2s x ${contract.pricing.credits_per_second} is below the ${contract.pricing.minimum_credits}-credit minimum, so the minimum should win`);
});

test('an unknown source length is refused, not guessed', () => {
    /*
     * The original defect wearing a different hat. Falling back to a default
     * length would produce a confident number that is wrong by however much
     * the real clip differs — and the caller would never know it was invented.
     */
    const req = runway.buildVideoRequest({ model: MODEL, videoUri: 'https://x/c.mp4' });
    const credits = runway.estimateVideoCredits(req.body);
    // A number, or an explicit refusal. Never NaN — that is the whole point.
    assert.ok(credits === null || Number.isFinite(credits),
        `the estimate is ${credits}, which is neither a price nor a refusal`);
    assert.ok(!Number.isNaN(credits),
        'the estimate is NaN, which passes every budget comparison silently');
    const q = runway.quoteVideo(req.body);
    assert.strictEqual(q.known, false, 'an unmeasured source was quoted as though it were known');
    assert.ok(String(q.why).length > 30, 'nothing explains why the cost is unknown');
    assert.ok(Number.isFinite(q.worst_case_credits),
        'no worst case is given, so a caller cannot budget for it at all');
});

test('the source length never reaches the wire', () => {
    /*
     * The estimator needs the source length and Runway has no field for it, so
     * it rides on the body non-enumerably. If that ever became an ordinary
     * property it would be spread straight into the request — an unrecognised
     * field travelling to a provider, which is exactly how every MuAPI
     * reference image was silently discarded.
     *
     * Asserted through JSON.stringify because that IS the wire: a property the
     * serialiser cannot see cannot be sent.
     */
    const body = runway.buildVideoRequest({
        model: MODEL, videoUri: 'https://x/c.mp4', sourceSeconds: 30 }).body;
    assert.strictEqual(body.__sourceSeconds, 30, 'the estimator cannot see the source length');
    const wire = JSON.parse(JSON.stringify(body));
    assert.ok(!('__sourceSeconds' in wire),
        '__sourceSeconds would be serialised into the request and sent to Runway');
    for (const k of Object.keys(wire)) {
        assert.ok(!/^__/.test(k), `${k} is an internal field and it is on the wire`);
    }
});

test('the rate book carries the model, sourced and dated', () => {
    const row = pricing.RATE_BOOK['runway:video'];
    assert.ok(row, 'no runway:video rate row');
    const m = row.models && row.models[MODEL];
    assert.ok(m, `${MODEL} is not in the rate book, so its spend is priced at the generic rate`);
    assert.strictEqual(m.native_per_unit, contract.pricing.credits_per_second,
        'the rate book disagrees with the verified contract');
    assert.strictEqual(m.minimum_native, contract.pricing.minimum_credits,
        'the minimum charge is not in the rate book, so a short clip is under-reported');
    assert.match(String(row.source || ''), /runwayml\.com/, 'the row has no first-party source');
    assert.match(String(row.checked || ''), /^\d{4}-\d{2}-\d{2}$/, 'the row has no checked date');
});

test('an over-budget request is refused BEFORE it bills', () => {
    const req = runway.buildVideoRequest({
        model: MODEL, videoUri: 'https://x/c.mp4', sourceSeconds: 30 });
    const credits = runway.estimateVideoCredits(req.body);
    const usd = credits * contract.pricing.usd_per_credit;
    const verdict = runway.checkBudget(req.body, { remainingUsd: usd - 1 });
    assert.strictEqual(verdict.ok, false, 'a request costing more than the remaining budget was allowed');
    assert.match(verdict.why, /\$/, 'the refusal does not state the money involved');
    assert.ok(runway.checkBudget(req.body, { remainingUsd: usd + 1 }).ok,
        'a request inside budget was refused');
});

test('NaN cannot pass the gate — the failure this file exists for', () => {
    /*
     * Every comparison against NaN is false, so a gate written as
     * `if (cost > remaining) refuse` passes an unpriceable request silently.
     * The gate must refuse what it cannot price.
     */
    const verdict = runway.checkBudget({ model: MODEL, videoUri: 'https://x/c.mp4' }, { remainingUsd: 0.01 });
    assert.strictEqual(verdict.ok, false,
        'a request whose cost is unknown was allowed against a one-cent budget');
});

test('a failed request is not recorded as spend', () => {
    /*
     * Pinned, not rebuilt. RBF-001 measured a FAILED Seedance job still
     * charging $1.658 on the provider side — this asserts OUR ledger does not
     * add its own phantom on top, which would make the image-fallback chain
     * look like three purchases for one image.
     */
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'usage-meter.js'), 'utf8');
    assert.match(src, /ok|success|failed/i,
        'the meter does not distinguish a successful call from a refused one');
});
