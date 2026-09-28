/**
 * THE PICTURE A PERSON SEES IS THE PICTURE THE MODEL GETS.
 *
 * Reported as "the character plates for all the monsters do not show". They
 * were not missing: five creatures had approved plates that reached the image
 * request in every frame they appeared in, and showed nothing on their cards.
 *
 * The cause is one this function has now been fixed for THREE TIMES, from
 * three different directions. Its own comments record the first two — one
 * query said `has_plate` while another found no picture, then a `front`-only
 * pattern hid a character plated in profile. This was the third: the card
 * asked for `asset_type = 'character_sheet'` while the reference gatherer
 * takes `IN ('character_sheet','reference_image')`.
 *
 * Two queries answering one question is how a display comes to disagree with
 * the generator. So this test does not check a query — it checks that the two
 * ASK THE SAME THING, which is the only form of this fix that stays fixed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const BACKEND = path.join(__dirname, '..');
const uncommented = file =>
    fs.readFileSync(path.join(BACKEND, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every asset_type set a query uses when looking for a character's plate. */
function plateTypeSets(code) {
    const sets = [];
    // `asset_type IN ( ... )`
    for (const m of code.matchAll(/asset_type\s+IN\s*\(([^)]*)\)/gi)) {
        sets.push(m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).sort().join('|'));
    }
    // `asset_type = '...'`
    for (const m of code.matchAll(/asset_type\s*=\s*'([a-z_]+)'/gi)) sets.push(m[1]);
    return sets;
}

test('the character card and the reference gatherer accept the same plate types', () => {
    const gatherer = uncommented('lib/shot-references.js');
    const card = uncommented('routes/characters.js');

    const gathererSets = plateTypeSets(gatherer).filter(s => s.includes('character_sheet'));
    assert.ok(gathererSets.length, 'the gatherer no longer selects character plates by asset_type');
    const expected = 'character_sheet|reference_image';
    assert.ok(gathererSets.includes(expected),
        `the gatherer accepts ${gathererSets.join(' / ')} — update this test deliberately if that changed`);

    const narrow = plateTypeSets(card).filter(s => s === 'character_sheet');
    assert.deepStrictEqual(narrow, [],
        'a query in routes/characters.js still asks for character_sheet ALONE. A character plated with a '
        + 'reference_image — an upload, or a subject refiled from a prop — is conditioned on that plate in '
        + 'every frame and shows no picture on its card.');
});

test('a plate the gatherer would send is a plate the card can show', () => {
    /*
     * Stated as the rule rather than as two SQL strings, so the next person
     * reading this knows WHY both lists must match rather than only that they
     * do. A picture good enough to spend money on is good enough to look at.
     */
    const card = uncommented('routes/characters.js');
    const queries = [...card.matchAll(/asset_type\s+IN\s*\(([^)]*)\)/gi)]
        .map(m => m[1].toLowerCase());
    assert.ok(queries.length >= 2,
        'fewer plate lookups than expected in routes/characters.js — has one been narrowed again?');
    for (const q of queries) {
        assert.ok(q.includes('character_sheet') && q.includes('reference_image'),
            `a character plate lookup accepts only ${q.trim()}`);
    }
});

test('the plate filename convention is NAME_view.png, not kind_NAME.png', () => {
    /*
     * Learned the hard way in the same session: five plates were renamed to
     * `character_SWARMER.png` by analogy with the prop and location
     * convention. Characters do not use it — `routes/characters.js` writes
     * `${safeName}_${frame.view}.png`, which is why MANNY's are
     * `MANNY_front.png`. Getting this wrong means a regeneration writes a
     * different filename, the archiver finds no predecessor, and the subject
     * ends up with two live reference plates.
     */
    const card = uncommented('routes/characters.js');
    assert.match(card, /\$\{safeName\}_\$\{frame\.view\}\.png/,
        'the character plate filename convention changed — the archiver matches on file_name, so a '
        + 'change here silently stops a regeneration from superseding the plate it replaces');
});
