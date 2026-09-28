/**
 * When the picture is in the payload, the prose stops describing it.
 *
 * `lib/storyboard-prompt.js` has said the right thing since it was written:
 * "A reference image beats a paragraph: `@maya` IS the wardrobe, where 240
 * characters of prose only approximates it." But `@maya` requires a provider
 * that can READ a tag, and one adapter of eight can. Everywhere else the
 * prompt carried an untagged array of pictures AND every subject's full
 * description — on a six-subject frame, 8,187 characters of a 16,000 ceiling
 * spent describing photographs the model was already holding.
 *
 * The prose cannot simply go: untagged, it is also the LABEL that says which
 * of six attached pictures is the colossus. So it is reduced to what a
 * photograph cannot carry.
 */

const test = require('node:test');
const assert = require('node:assert');

const { condenseForPlate } = require('../lib/storyboard-prompt');

const MANNY = 'THE ATTACHED REFERENCE PHOTOGRAPH IS THE AUTHORITY ON THIS MAN’S FACE. '
    + 'He is a real, specific, living person. FACE: broad and full, wide across the cheekbones, '
    + 'deep-set eyes with fine crow’s feet, warm olive-tan skin with real open pores. '
    + 'BUILD, CRITICAL: SHORT AND THICK-SET, 1.73m (5 feet 8 inches) and 82kg of muscle. '
    + 'DO NOT make him tall, slim, slender or lanky. If the result looks like a tall slim man, it is wrong. '
    + 'WARDROBE: a striped shirt, cuffs rolled to mid-forearm.';

test('a directive the plate did not fix is ALWAYS kept', () => {
    /*
     * These clauses exist because the model kept getting something wrong that
     * the plate did not fix — this one cost four regenerations and a "that
     * doesn't look like me". Condensing must never be what undoes that work.
     */
    const out = condenseForPlate(MANNY);
    for (const clause of ['BUILD, CRITICAL', 'DO NOT make him tall', 'it is wrong']) {
        assert.ok(out.includes(clause), `condensing dropped a directive: ${clause}`);
    }
});

test('the opening line is kept, because it labels the picture', () => {
    // Untagged, the model holds N photographs and no names. The first line is
    // what says which one this paragraph is about.
    assert.ok(condenseForPlate(MANNY).startsWith('THE ATTACHED REFERENCE PHOTOGRAPH'),
        'the identifying opening was dropped, leaving the plate unlabelled');
});

test('prose the photograph already shows is dropped', () => {
    const out = condenseForPlate(MANNY);
    assert.ok(!out.includes('crow'), 'face detail the plate shows is still being described');
    assert.ok(out.length < MANNY.length * 0.6,
        `condensing saved too little: ${MANNY.length} -> ${out.length}`);
});

test('a decimal is not mistaken for the end of a sentence', () => {
    // "0.7m at the shoulder" and "1.73m (5 feet 8 inches)" must not split.
    const text = 'SWARMER: dog-sized. It stands 0.7m at the shoulder and 1.3m long. CRITICAL: six legs.';
    const out = condenseForPlate(text);
    assert.ok(out.includes('CRITICAL: six legs.'), 'the directive was lost to a bad sentence split');
    assert.ok(!/0\.$|1\.$/.test(out), 'a decimal was split as a sentence boundary');
});

test('condensing never returns nothing, and never grows the text', () => {
    // A failure here would silently strip a subject from the prompt entirely,
    // which is the exact defect the audit calls an ERROR.
    for (const input of ['', 'One sentence only.', 'A. B. C.', MANNY]) {
        const out = condenseForPlate(input);
        assert.ok(out.length <= String(input).length, 'condensing made the text longer');
        if (String(input).trim()) assert.ok(out.length > 0, 'condensing emptied a description');
    }
});

test('a subject with NO plate keeps its whole description', () => {
    /*
     * Asserted at the call site, not on the helper: where there is no picture
     * the prose is all there is, and shortening it would be removing the only
     * thing the model has to go on. The condition is `platedHere`.
     */
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'storyboard-prompt.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(code, /platedHere\s*\?/,
        'the condenser is applied unconditionally, so an unplated subject loses its description');
    assert.match(code, /opts\.references\s*\|\|\s*\[\]/,
        'nothing checks whether the subject’s own picture is actually attached');
});
