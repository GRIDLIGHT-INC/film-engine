/**
 * The turnaround, corrected to the guide.
 *
 * Two things the guide (Film_Engine_Character_Sheets_Guide.docx) says that the
 * first orbit implementation got wrong:
 *
 *  1. A TURNAROUND IS FIVE VIEWS — front, left ¾, profile, back ¾, back
 *     (§4 "Turnaround board", and the practical defaults table). Four leaves
 *     the back three-quarter unshot, which is the angle a camera moving behind
 *     a character actually lands on.
 *
 *  2. THE 360 ORBIT IS A BOOTSTRAP, NOT THE IDENTITY SOURCE. The guide is
 *     explicit twice: "Offer frame extraction as an optional turnaround
 *     bootstrap — not as the final identity source", and in the defaults,
 *     "360 video turnaround: Optional bootstrap and angle discovery tool."
 *     The first implementation overwrote every view it produced, including
 *     FRONT — which is the identity anchor, the picture that attaches to every
 *     shot the character appears in. A cheap orbit frame silently replacing an
 *     approved anchor is precisely the failure the guide is warning about.
 *
 * Set-based over the five views, because a turnaround that gets three right and
 * mislabels the back is the state the old three-plate path was already in.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { VIEW_RANK, orderByViewSql } = require('../lib/plate-views');
const orbit = require('../lib/character-orbit');
const ROUTE = fs.readFileSync(path.join(__dirname, '../routes/characters.js'), 'utf8');

/** The turnaround the guide specifies, in the order it specifies. */
const GUIDE_VIEWS = ['front', 'three-quarter', 'side', 'back-three-quarter', 'back'];

test('every view the guide names is a view plate selection knows', () => {
    for (const v of GUIDE_VIEWS) {
        assert.ok(Object.prototype.hasOwnProperty.call(VIEW_RANK, v),
            `"${v}" is in the guide's turnaround and not in VIEW_RANK — `
            + 'headlinePlate and the shot gatherer could never choose it');
    }
});

test('the views rank front-first and back-last, so identity still wins', () => {
    assert.strictEqual(VIEW_RANK.front, 0, 'front is no longer the identity view');
    const ranks = GUIDE_VIEWS.map(v => VIEW_RANK[v]);
    for (let i = 1; i < ranks.length; i++) {
        assert.ok(ranks[i] > ranks[i - 1],
            `${GUIDE_VIEWS[i]} does not rank after ${GUIDE_VIEWS[i - 1]} — `
            + 'the ordering no longer walks front to back');
    }
    assert.match(orderByViewSql(), /CASE/i);
});

test('the orbit plans all five, in guide order', () => {
    assert.deepStrictEqual(orbit.ORBIT_VIEWS.map(v => v.view), GUIDE_VIEWS,
        'the orbit does not produce the turnaround the guide specifies');
});

test('each view sits at the angle its name means', () => {
    const degrees = Object.fromEntries(orbit.ORBIT_VIEWS.map(v => [v.view, v.degrees]));
    assert.strictEqual(degrees.front, 0);
    assert.strictEqual(degrees['three-quarter'], 45);
    assert.strictEqual(degrees.side, 90);
    assert.strictEqual(degrees['back-three-quarter'], 135);
    assert.strictEqual(degrees.back, 180);
});

test('the orbit is a BOOTSTRAP: it never overwrites an approved identity anchor', () => {
    assert.strictEqual(typeof orbit.IDENTITY_VIEWS, 'object',
        'nothing names which views are identity anchors, so nothing can protect them');
    assert.ok(orbit.IDENTITY_VIEWS.includes('front'),
        'front is not treated as an identity anchor');
    assert.strictEqual(orbit.mayOverwrite('front', { approved: true }), false,
        'an orbit frame would replace an approved front anchor');
    assert.strictEqual(orbit.mayOverwrite('front', { approved: false }), true,
        'with no approved anchor the orbit should be allowed to bootstrap one');
    assert.strictEqual(orbit.mayOverwrite('back', { approved: true }), true,
        'a non-identity view should still be refreshable by an orbit');
});

test('the route asks before it replaces, rather than deleting every view', () => {
    const i = ROUTE.indexOf('async function generateOrbit(');
    assert.ok(i > 0, 'generateOrbit not found');
    let depth = 0, j = ROUTE.indexOf('{', i), end = j;
    for (; j < ROUTE.length; j++) {
        if (ROUTE[j] === '{') depth++;
        else if (ROUTE[j] === '}') { depth--; if (!depth) { end = j; break; } }
    }
    const body = ROUTE.slice(i, end);
    assert.match(body, /mayOverwrite\s*\(/,
        'the orbit deletes the stale row for every view it produces, including the identity '
        + 'anchor — the guide calls this a bootstrap, not the identity source');
    assert.match(body, /kept|skipped|protected/i,
        'a view the orbit declined to overwrite is not reported, so it looks like it worked');
});

test('the guide itself is in the repo, so the rules can be re-read', () => {
    assert.ok(fs.existsSync(path.join(__dirname, '../../Film_Engine_Character_Sheets_Guide.docx')),
        'the guide these rules come from is not in the repo');
});
