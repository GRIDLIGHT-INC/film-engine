/**
 * How big a thing is, said so an image model can act on it.
 *
 * A diffusion model has no metric understanding, and a reference plate makes
 * scale WORSE rather than better: a plate is a close-up filling its own frame,
 * and conditioning transfers appearance rather than size, so the model
 * reproduces what it was shown. The sprinkler plate produced a sprinkler the
 * size of the car parked beside it. The plate was doing its job — nothing was
 * telling the model how big the thing is.
 *
 * Set-based over the phrasings, because each covers a case the others cannot:
 * a frame fraction needs a lens and a distance, an anchor works on any shot,
 * and a plain measure is the floor. A version that emits only the first is
 * silent on every unblocked shot, which is most of them.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    ANCHORS, sizeOf, fractionPhrase, anchorPhrase, scalePhrase, scaleNegative,
} = require('../lib/subject-scale');

test('an undeclared size produces no scale language at all', () => {
    // An invented default is indistinguishable from a deliberate one and would
    // be wrong silently, which is the failure this exists to end.
    assert.strictEqual(scalePhrase('X', 'prop', {}), null);
    assert.strictEqual(scalePhrase('X', 'prop', { height_m: 0 }), null);
    assert.strictEqual(scalePhrase('X', 'character', { height_m: null }), null);
    assert.strictEqual(sizeOf('prop', { height_m: 'tall' }), null);
});

test('the frame fraction is only claimed when a coverage is given', () => {
    // It is computed from what the lens covers at ONE distance — the camera's
    // distance to what it is framing. Everything else in the shot is somewhere
    // else, and pricing a mid-ground car at the subject's coverage said a
    // five-metre car fills most of a 7.5m frame.
    const framed = scalePhrase('Sprinkler', 'prop', { height_m: 0.3 }, 7.5);
    assert.match(framed, /frame width/);
    const other = scalePhrase('SEDAN', 'prop', { length_m: 5.5 });
    assert.ok(!/frame width/.test(other), 'a subject at unknown distance claimed a frame fraction');
    assert.match(other, /parked car/, 'it fell back to no scale language at all');
});

test('a fraction is rounded to something a person would say', () => {
    // "0.04 of frame width" is a number nobody composes with, and a model does
    // not distinguish a twenty-third from a twenty-fifth.
    assert.match(fractionPhrase(0.5), /half/);
    assert.match(fractionPhrase(0.25), /quarter/);
    assert.match(fractionPhrase(0.04), /one 25th/);
    assert.match(fractionPhrase(0.95), /filling the frame/);
    assert.strictEqual(fractionPhrase(0), null);
});

test('a person is the anchor, so a person is not anchored to a door', () => {
    const maya = scalePhrase('MAYA', 'character', { height_m: 1.7 });
    assert.match(maya, /1\.7m tall/);
    assert.ok(!/front door/.test(maya), 'a human was measured against a doorframe');

    // Something far from human scale still gets one, because it needs it.
    assert.match(scalePhrase('DRAGON', 'character', { height_m: 20 }), /two-storey house/);
});

test('every anchor is a thing whose size is common knowledge', () => {
    // An anchor the model has no reliable sense of is worse than none: it
    // sounds precise and means nothing.
    for (const a of ANCHORS) {
        assert.ok(a.m > 0, `${a.name} has no size`);
        assert.ok(/^a /.test(a.name), `${a.name} does not read inside a sentence`);
    }
    // Spread across the range, or everything anchors to the same object.
    const sizes = ANCHORS.map(a => a.m).sort((x, y) => x - y);
    assert.ok(sizes[sizes.length - 1] / sizes[0] > 20, 'the anchors cover too narrow a range');
});

test('the negative names the failure that actually happens', () => {
    // Things come out too big, never too small: a plate fills its own frame and
    // the model matches what it was shown.
    const n = scaleNegative('Sprinkler', 'prop', { height_m: 0.3 });
    assert.match(n, /Sprinkler larger than/);
    // And it names a TIGHT bound. "Larger than a house" is a bound a wrong
    // image can satisfy.
    assert.match(n, /car tyre/);
    // A large subject cannot be inflated in the way that matters, so it gets none.
    assert.strictEqual(scaleNegative('SEDAN', 'prop', { length_m: 5.5 }), null);
});

test('the largest declared dimension is what reads as how big it is', () => {
    assert.strictEqual(sizeOf('prop', { height_m: 1.4, length_m: 5.5, width_m: 2 }), 5.5);
    // A character is its height; a person lying down is still a person.
    assert.strictEqual(sizeOf('character', { height_m: 1.7 }), 1.7);
});

/**
 * Setting a size has to be possible everywhere the subject is.
 *
 * Set-based over the surfaces, because a size that can only be set in one place
 * is a size most subjects will never have — and an undeclared subject silently
 * contributes no scale language at all, which is indistinguishable from the
 * feature not existing.
 */
const fs = require('fs');
const path = require('path');

test('every surface that edits a subject can set its size', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    for (const field of ['height_m', 'width_m', 'length_m']) {
        assert.ok(html.includes(`data-field="${field}"`), `the UI cannot set ${field}`);
    }

    const { PRODUCTION_TOOLS } = require('../lib/mcp-tools');
    const gaps = [];
    for (const [tool, fields] of [['prop_create', ['height_m', 'width_m', 'length_m']],
                                  ['prop_update', ['height_m', 'width_m', 'length_m']],
                                  ['character_create', ['height_m']],
                                  ['character_update', ['height_m']]]) {
        const t = PRODUCTION_TOOLS.find(x => x.name === tool);
        if (!t) { gaps.push(`${tool} is missing`); continue; }
        for (const f of fields) if (!t.schema[f]) gaps.push(`${tool} cannot set ${f}`);
    }
    assert.deepStrictEqual(gaps, [], gaps.join('; '));
});

test('the routes store a size as a number, and refuse nonsense', () => {
    // The prompt divides by it. A string that looks like a number survives a
    // length-capped write and then breaks the arithmetic silently.
    for (const file of ['locations.js', 'characters.js']) {
        const src = fs.readFileSync(path.join(__dirname, '..', 'routes', file), 'utf8');
        assert.ok(/height_m/.test(src), `${file} does not accept height_m`);
        assert.ok(/Number\.isFinite\(n\) \|\| n <= 0/.test(src),
            `${file} does not refuse a size that is not a positive number`);
    }
});

test('the gap is reported as work, not as a status', () => {
    // "Set sizes" is ignorable. "The DRAGON has no size and appears in 4 shots"
    // is a job, and ordering by shot count puts the expensive one first.
    const { missingSizes } = require('../lib/subject-scale');
    assert.strictEqual(typeof missingSizes, 'function');
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'subject-scale.js'), 'utf8');
    assert.ok(/shots:/.test(src), 'the report does not say how many shots a gap affects');
    assert.ok(/plated/.test(src), 'the report does not flag the plate-without-size combination');
});
