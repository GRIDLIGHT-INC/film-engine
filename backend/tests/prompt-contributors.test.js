const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'lib', 'storyboard-prompt.js');

/*
 * WE-5.14 · A contributor id that is not in PROMPT_PRIORITY is dropped in
 * SILENCE.
 *
 * `add(id, text)` collects into a Map and the assembly walks PROMPT_PRIORITY,
 * so an id nobody registered contributes nothing, throws nothing and logs
 * nothing — the prompt simply comes out without it. That is how the generation
 * plate travelled as reference 0 with no sentence explaining what it was: the
 * lead was written, called, and swallowed.
 *
 * Derived from the source rather than a list, so the next contributor added is
 * in the denominator with nothing to remember.
 */
test('every add() id is registered in PROMPT_PRIORITY', () => {
    const src = fs.readFileSync(SRC, 'utf8');

    const registered = new Set();
    const table = /const PROMPT_PRIORITY\s*=\s*\[([\s\S]*?)\n\];/.exec(src);
    assert.ok(table, 'PROMPT_PRIORITY table not found — this scan is reading the wrong shape');
    for (const m of table[1].matchAll(/\{\s*id:\s*'([^']+)'/g)) registered.add(m[1]);
    assert.ok(registered.size >= 8, `only found ${registered.size} registered ids; the scan is not reading the table`);

    const added = new Set();
    for (const m of src.matchAll(/\badd\(\s*'([^']+)'/g)) added.add(m[1]);
    assert.ok(added.size >= 8, `only found ${added.size} add() call sites; the scan is not reading the calls`);

    const orphans = [...added].filter(id => !registered.has(id));
    assert.deepStrictEqual(orphans, [],
        `these contributors are collected and never emitted: ${orphans.join(', ')}`);
});

/* The plate must be registered ahead of the anchor — it fixes the camera, the
 * anchor only fixes the look. */
test('the plate outranks the anchor', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    const ids = [.../const PROMPT_PRIORITY\s*=\s*\[([\s\S]*?)\n\];/.exec(src)[1]
        .matchAll(/\{\s*id:\s*'([^']+)'/g)].map(m => m[1]);
    assert.ok(ids.includes('plate'), 'the plate is not a registered contributor');
    assert.ok(ids.indexOf('plate') < ids.indexOf('anchor'),
        'the plate must lead the anchor: it fixes the camera, not the look');
});
