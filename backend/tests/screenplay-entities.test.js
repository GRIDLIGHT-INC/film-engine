/**
 * A screenplay names people; it also names transitions, and they are not people.
 *
 * Two faults in one report, from a real screenplay:
 *
 *  - `FADE OUT` was listed as a CHARACTER with a scene count, so
 *    `elements_list` reported a phantom undescribed character and every report
 *    built on scene presence counted it.
 *  - RAY MERCER (introduced in action) and RAY (cued in dialogue) became two
 *    entries for one person, as did JUNE MERCER / JUNE. A shot card naming the
 *    variant with no record would reach generation as a bare name — no plate,
 *    no locked profile, a different face every frame.
 *
 * And re-typing the line as `> FADE OUT.` changed nothing, which turned out to
 * be a third fault: the parser only honoured a forced transition after a blank
 * line, so a `>` written directly under an action paragraph was swallowed into
 * it as prose. A force that only works in some positions is not a force.
 */

const test = require('node:test');
const assert = require('node:assert');
const { parseFountain } = require('../lib/fountain-parser');
const { canonicaliseCharacterNames } = require('../routes/scripts');

/** Every transition phrase a screenplay actually ends a scene with. */
const TRANSITIONS = ['FADE OUT.', 'FADE IN:', 'CUT TO:', 'DISSOLVE TO:', 'SMASH CUT TO:', 'MATCH CUT TO:'];

test('a forced transition is forced wherever it appears', () => {
    for (const phrase of TRANSITIONS) {
        const withBlank = parseFountain(`He sits.\n\n> ${phrase}`).elements.map(e => e.type);
        const without = parseFountain(`He sits.\n> ${phrase}`).elements.map(e => e.type);
        assert.deepStrictEqual(without, withBlank,
            `"> ${phrase}" written straight under action is swallowed into it — so the author's `
            + 'explicit marker changes nothing, which is exactly what was reported');
        assert.ok(without.includes('transition'), `"> ${phrase}" did not become a transition`);
    }
});

test('centred text is still centred, not a transition', () => {
    // `>` also opens a centred line. Hoisting the forced-transition check must
    // not swallow it.
    assert.deepStrictEqual(parseFountain('> THE END <').elements.map(e => e.type), ['centered']);
});

test('a phrase made only of transition words is not a character', () => {
    /*
     * The detector matches TWO capitalised words. The stopword list held FADE
     * and OUT separately, so each was rejected alone and "FADE OUT" sailed
     * through — a character with a scene count, in every presence report.
     */
    const { handleScripts } = require('../routes/scripts');   // eslint-disable-line no-unused-vars
    const scripts = require('../routes/scripts');
    const detect = scripts.actionCapsInLine || null;
    if (!detect) {
        // Not exported; assert through the parser + extraction path instead.
        const parsed = parseFountain('INT. DINER - DAY\n\nHe waits.\n> FADE OUT.');
        const types = parsed.elements.map(e => e.type);
        assert.ok(types.includes('transition'),
            'FADE OUT must reach the extractor as a transition, never as action text');
        return;
    }
    for (const phrase of ['FADE OUT', 'CUT TO', 'MATCH CUT', 'IRIS OUT', 'THE END']) {
        assert.deepStrictEqual(Object.keys(detect(`The room empties. ${phrase}.`)), [],
            `"${phrase}" was detected as a character`);
    }
});

test('a dialogue cue that is a first name is the same person as the full name', () => {
    const canon = canonicaliseCharacterNames(
        ['RAY MERCER', 'JUNE MERCER', 'RAY', 'JUNE'], ['JUNE', 'RAY MERCER']);

    // Collapses to ONE name per person.
    const distinct = new Set([...canon.values()]);
    assert.strictEqual(distinct.size, 2,
        `four names for two people collapsed to ${distinct.size}: ${[...distinct].join(', ')}`);

    // And collapses onto the name that HAS a record, since the whole point is
    // to reach the row carrying the description and the plate.
    assert.strictEqual(canon.get('RAY'), 'RAY MERCER');
    assert.strictEqual(canon.get('JUNE MERCER'), 'JUNE');
});

test('a shared prefix that is not a name boundary is left alone', () => {
    // Word-boundary, never substring: RAY starts RAYMOND and they are two
    // people. A substring rule merges strangers.
    const canon = canonicaliseCharacterNames(['RAY', 'RAYMOND'], []);
    assert.strictEqual(canon.get('RAY'), 'RAY');
    assert.strictEqual(canon.get('RAYMOND'), 'RAYMOND');
});

test('with no records at all the fuller name wins', () => {
    // A fresh upload has no character rows yet, which is the normal case. The
    // full name is what the action line established.
    const canon = canonicaliseCharacterNames(['RAY', 'RAY MERCER'], []);
    assert.strictEqual(canon.get('RAY'), 'RAY MERCER');
    assert.strictEqual(canon.get('RAY MERCER'), 'RAY MERCER');
});

test('the prop categories the picker offers are the ones the database accepts', () => {
    /*
     * There were THREE answers and no two agreed: the CHECK constraint allowed
     * ten values, the page offered nine — two of which (`clothing`,
     * `personal`) the constraint REFUSES, so choosing either failed the insert
     * — and the MCP tool typed it as a free string, so an agent learned the
     * legal set only by reading a constraint violation.
     */
    const fs = require('fs');
    const path = require('path');
    const { PROP_CATEGORIES } = require('../lib/prop-categories');

    // The migration is the authority: it is what actually rejects a value.
    const migration = fs.readFileSync(
        path.join(__dirname, '..', 'db', 'migrations', '007_film_props.sql'), 'utf8');
    const check = /CHECK\s*\(\s*category\s+IN\s*\(([^)]*)\)/i.exec(migration);
    assert.ok(check, 'the category CHECK constraint is gone from the migration');
    const allowed = [...check[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort();

    assert.deepStrictEqual([...PROP_CATEGORIES].sort(), allowed,
        'the registry and the database disagree about what a prop may be');

    // The tool schema states the enum rather than leaving it to be discovered.
    const { listTools } = require('../lib/mcp-tools');
    const tool = listTools().find(t => t.name === 'prop_create');
    assert.deepStrictEqual(tool.inputSchema.properties.category.enum, [...PROP_CATEGORIES],
        'prop_create types category as a free string, so the legal set is learned from an error');

    // And the page cannot offer one the database refuses.
    const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    const at = SPA.indexOf('id="propCategorySelect"');
    assert.notStrictEqual(at, -1, 'the category picker is gone');
    const select = SPA.slice(at, SPA.indexOf('</select>', at));
    for (const value of [...select.matchAll(/value="([a-z-]+)"/g)].map(m => m[1])) {
        assert.ok(PROP_CATEGORIES.includes(value),
            `the picker offers "${value}", which the database refuses`);
    }
    assert.match(SPA, /prop_categories/,
        'the picker is hardcoded rather than filled from the server, so it will drift again');
});
