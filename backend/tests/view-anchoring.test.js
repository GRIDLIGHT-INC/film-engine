/**
 * AN EDIT CANNOT MOVE THE CAMERA, AND THE DIRECTOR SHOULD LEARN THAT FIRST.
 *
 * Attaching a reference means two different things depending on the provider,
 * and the difference is not a quality setting — it is structural. A
 * `condition` adapter GENERATES a new image conditioned on what it is given; an
 * `edit` adapter hands back a modified copy of it. So on an edit-mode provider
 * a new VIEW of a location is precisely the thing that cannot be produced from
 * the existing plate: asked to turn round, it re-photographs what it can see.
 *
 * The engine already handles this correctly at generation time — every
 * reference is dropped and the side is painted from the description, which is
 * the honest thing to do. What it did not do is SAY SO BEFORE THE MONEY IS
 * SPENT, name WHICH provider, or name the remedy. A director reading a loose
 * match afterwards concludes the feature does not work.
 *
 * And it never flagged the views already on disk. The diner has three plates
 * that are three independently imagined rooms; nothing on them records that,
 * so they look exactly like three sides of one place.
 *
 * Set-based over EVERY image adapter's declared referenceMode — four of seven
 * are edit-mode today, and a rule written against meshy alone is one that
 * breaks on the next adapter.
 */

const test = require('node:test');
const assert = require('node:assert');

const providers = require('../lib/providers');
const plates = require('../lib/reference-plates');

const imageAdapters = () => providers.list().filter((a) => (a.capabilities || []).includes('image'));

test('the denominator is every image adapter', () => {
    assert.ok(imageAdapters().length >= 5,
        `only ${imageAdapters().length} image adapters — the registry read is broken`);
});

test('every adapter is judged by its OWN declared reference mode', () => {
    assert.strictEqual(typeof plates.viewAnchoring, 'function',
        'nothing decides whether a provider can anchor a new view');
    const wrong = [];
    for (const a of imageAdapters()) {
        const v = plates.viewAnchoring(a);
        const shouldAnchor = a.referenceMode === 'condition';
        if (v.can_anchor !== shouldAnchor) {
            wrong.push(`${a.id}: can_anchor=${v.can_anchor} but referenceMode=${a.referenceMode}`);
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  - ${wrong.join('\n  - ')}`);
});

test('an adapter that declares nothing is treated as edit — the safe direction', () => {
    /*
     * Over-trusting is what produced four copies of one street. An unknown
     * adapter is assumed unable to turn the camera, which costs a slightly
     * looser plate; assuming it can costs a plate that is the wrong side.
     */
    assert.strictEqual(plates.viewAnchoring({ id: 'new-thing' }).can_anchor, false);
    assert.strictEqual(plates.viewAnchoring(null).can_anchor, false);
});

test('the warning names the provider, the reason, and a remedy', () => {
    const edit = imageAdapters().find((a) => a.referenceMode !== 'condition');
    assert.ok(edit, 'no edit-mode adapter to check against');
    const v = plates.viewAnchoring(edit);
    assert.ok(v.why.includes(edit.id),
        `the reason does not say WHICH provider — a director cannot act on "this provider"`);
    assert.match(v.why, /edit|cannot move the camera/i, 'the reason does not say why an edit cannot turn');
    assert.ok(Array.isArray(v.can_anchor_on), 'no remedy is named');
    assert.ok(v.can_anchor_on.length >= 1,
        'no provider is named as able to anchor a view — the warning explains and offers nothing');
    for (const id of v.can_anchor_on) {
        const a = imageAdapters().find((x) => x.id === id);
        assert.ok(a && a.referenceMode === 'condition',
            `${id} is offered as a remedy and is not a conditioning provider`);
    }
});

test('a conditioning provider is not warned about', () => {
    const cond = imageAdapters().find((a) => a.referenceMode === 'condition');
    assert.ok(cond, 'no conditioning adapter to check against');
    const v = plates.viewAnchoring(cond);
    assert.strictEqual(v.can_anchor, true);
    assert.ok(!v.why, 'a provider that CAN anchor was given a warning anyway');
});

test('the free compass plan warns before anything is paid for', () => {
    /*
     * The whole point. The generation result already explains it afterwards;
     * by then the plates exist and were billed.
     */
    const edit = imageAdapters().find((a) => a.referenceMode !== 'condition');
    const plan = plates.planCompassSweep({ existingViews: ['north'], provider: edit });
    assert.ok(plan.anchoring, 'the plan says nothing about anchoring');
    assert.strictEqual(plan.anchoring.can_anchor, false);
    assert.ok(plan.anchoring.why.includes(edit.id), 'the plan does not name the provider');
    assert.ok(plan.anchoring.can_anchor_on.length >= 1, 'the plan names no remedy');
});

test('the plan is unchanged when the provider can anchor', () => {
    const cond = imageAdapters().find((a) => a.referenceMode === 'condition');
    const plan = plates.planCompassSweep({ existingViews: ['north'], provider: cond });
    assert.strictEqual(plan.anchoring.can_anchor, true);
    assert.ok(!plan.anchoring.why);
});

test('a plan with no provider still plans, and says the anchoring is unknown', () => {
    /*
     * The free plan is reachable before a provider is resolved. Refusing there
     * would make the cheap preview unavailable exactly when it is most useful.
     */
    const plan = plates.planCompassSweep({ existingViews: ['north'] });
    assert.ok(plan.generate.length >= 1, 'the plan refused to plan without a provider');
    assert.ok(plan.anchoring, 'the plan omits anchoring entirely rather than saying it is unknown');
});

test('a generated view RECORDS whether it was anchored, so old ones can be flagged', () => {
    /*
     * Flagged, never deleted: those plates cost money and are a usable, if
     * loose, reverse angle. What was missing is that nothing on them said they
     * were painted from words — so three imagined rooms look exactly like three
     * sides of one place.
     */
    const { explorationMetadata } = require('../lib/subject-gallery');
    assert.strictEqual(typeof plates.viewMetadata, 'function',
        'nothing builds the stored metadata for a view, so anchoring cannot be persisted');
    const m = plates.viewMetadata({ view: 'east', anchored: false, referenceMode: 'edit', providerId: 'meshy' });
    assert.strictEqual(m.anchored, false);
    assert.strictEqual(m.reference_mode, 'edit');
    assert.strictEqual(m.view, 'east');
    const anchoredMeta = plates.viewMetadata({ view: 'east', anchored: true, referenceMode: 'condition', providerId: 'bfl' });
    assert.strictEqual(anchoredMeta.anchored, true);
});

test('a view with no recorded anchoring is reported as unknown, not as anchored', () => {
    /*
     * Every plate on disk predates this. Reading absence as "anchored" would
     * silently certify the three diner sides as matching, which is the opposite
     * of what they are.
     */
    assert.strictEqual(plates.anchoringOf({}), 'unknown');
    assert.strictEqual(plates.anchoringOf({ anchored: false }), 'painted');
    assert.strictEqual(plates.anchoringOf({ anchored: true }), 'anchored');
});

test('nothing in the anchoring path deletes a plate', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'reference-plates.js'), 'utf8');
    const fn = /function viewAnchoring[\s\S]*?\n}/.exec(src);
    assert.ok(fn, 'viewAnchoring is not in the file');
    assert.ok(!/unlink|rm\(|rmSync/.test(fn[0]),
        'the anchoring check removes files — an un-anchored view is loose, not worthless');
});
