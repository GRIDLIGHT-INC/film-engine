/**
 * An anchor covers where a subject STANDS, not who they are in close-up.
 *
 * "Why would she be looking away from the dragon for a CU reaction shot... and
 * MAYA looks different. We should have complete control with adding reference
 * plates such as MAYA even when anchoring the last scene."
 *
 * Anchoring drops a subject's plate when the anchor's card names that subject,
 * on the reasoning that the frame already shows them. That is true of PLACEMENT
 * and false of IDENTITY the moment the anchor does not show a face: 2A has MAYA
 * with her back to camera, so it carries her position and the light and not one
 * pixel of what she looks like. A close-up built on it had nothing to go on and
 * came back as somebody else.
 *
 * Two things follow. A director must be able to force a plate through
 * explicitly — that is the ask. And a CLOSE-UP must keep its subject's plate by
 * default, because a close-up is about the face and a wide anchor never shows
 * one; leaving that to be remembered means the next close-up fails the same way.
 *
 * Set-based over the three places coverage is computed, because an override
 * honoured by two of them is worse than none: the prompt would shorten a
 * subject to a name while the picture that gives the name meaning was dropped,
 * which is the exact state the contract-shortening revert exists to prevent.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Every site that decides which subjects an anchor covers. */
const COVERAGE_SITES = [
    { file: 'lib/capability-payloads.js', why: 'the shared payload path' },
    { file: 'lib/shot-references.js', why: 'the plate gatherer' },
    { file: 'routes/storyboard.js', why: 'the per-shot regenerate' },
];

test('the coverage sites are still the three we think they are', () => {
    for (const { file } of COVERAGE_SITES) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        assert.ok(/subjectsCoveredBy\(/.test(src), `${file} no longer computes anchor coverage`);
    }
});

test('every coverage site can be told to keep a plate', () => {
    for (const { file, why } of COVERAGE_SITES) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        /*
         * Per LINE, not by a paren-matching regex: one call site passes
         * `database()` as its first argument, and `[^)]*` stops at that inner
         * paren — so the check read `database(` and reported a working site as
         * broken.
         */
        const calls = src.split('\n').filter(l => /subjectsCoveredBy\(/.test(l)
            && !/function subjectsCoveredBy/.test(l));
        const withoutKeep = calls.filter(l => !/keep|force/i.test(l));
        assert.deepStrictEqual(withoutKeep, [],
            `${why} (${file}) computes coverage without honouring a forced plate, so a subject `
            + 'would be shortened to a name in the prompt while its picture was dropped');
    }
});

test('a forced subject is not covered, however the anchor names it', () => {
    const { subjectsCoveredBy } = require('../lib/shot-anchor');
    const db = fakeDb({ characters: ['MAYA', 'DRAGON'], props: ['SEDAN'] });
    const anchor = { shot: { id: 'a1' }, cross_scene: true };

    const all = subjectsCoveredBy(db, anchor);
    assert.ok(all.has('MAYA'), 'the fixture does not reproduce coverage');

    // Case-insensitively, because a card says "Maya" and a director types MAYA.
    for (const spelling of [['MAYA'], ['maya'], ['  Maya  ']]) {
        const kept = subjectsCoveredBy(db, anchor, spelling);
        assert.ok(!kept.has('MAYA'), `forcing ${JSON.stringify(spelling)} did not free MAYA's plate`);
        assert.ok(kept.has('DRAGON'), 'forcing one subject freed another');
    }
});

test('a close-up keeps its subject plate without being asked', () => {
    /*
     * The case that failed. A wide anchor showing someone from behind carries
     * no facial information at all, and a close-up is nothing BUT facial
     * information — so this cannot be left to be remembered.
     */
    const { platesForcedBy } = require('../lib/shot-anchor');
    assert.ok(typeof platesForcedBy === 'function',
        'nothing derives which plates a shot must keep from its own framing');

    const closeUp = platesForcedBy({ camera: { shot_type: 'close-up' }, characters: ['MAYA'] });
    assert.deepStrictEqual([...closeUp].sort(), ['MAYA'],
        'a close-up does not keep its character plate, so identity comes only from the anchor');

    const wide = platesForcedBy({ camera: { shot_type: 'wide' }, characters: ['MAYA'] });
    assert.deepStrictEqual([...wide], [],
        'a wide forces plates it does not need, which spends reference slots on subjects the '
        + 'anchor genuinely does cover');
});

test('the override is reachable from a generation', () => {
    const routes = fs.readFileSync(path.join(ROOT, 'routes', 'storyboard.js'), 'utf8');
    assert.ok(/keep_plates/.test(routes), 'no generation parameter forces a plate through');
    const html = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');
    assert.ok(/keep_plates|keepPlates/.test(html),
        'the page cannot force a plate, so the control exists only for agents');
});

/** A database stub carrying one anchor card. */
function fakeDb(card) {
    return {
        prepare(sql) {
            return {
                get() {
                    if (/scene_card_yaml/.test(sql)) return { scene_card_yaml: JSON.stringify(card) };
                    return { location: 'SUBURBAN STREET' };
                },
            };
        },
    };
}
