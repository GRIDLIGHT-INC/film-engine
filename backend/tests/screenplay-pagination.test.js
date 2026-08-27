/**
 * A PAGE MAY NOT END BETWEEN THINGS THAT BELONG TOGETHER.
 *
 * Reported as "it adds double lines as I write, then fixes it when I leave the
 * screen and come back". The text was never damaged — the saved Fountain was
 * correct throughout, which is why returning to the page repaired it. What was
 * wrong was where the editor drew its page breaks: it counted lines and cut the
 * moment the count crossed 55, wherever that landed.
 *
 * On a real five-page screenplay that put THREE of five breaks in places the
 * format forbids — twice between a character cue and its dialogue, once between
 * a parenthetical and its dialogue. A cue stranded at the foot of a page leaves
 * its dialogue alone at the top of the next, where it reads as ACTION because
 * nothing above it says who is speaking.
 *
 * Set-based over ELEMENT_TYPES, the editor's own list of what it can produce,
 * because the failure is per type: fixing `character` while leaving
 * `parenthetical` and `scene-heading` broken passes any test written about the
 * case somebody happened to screenshot.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    ELEMENT_TYPES, MAY_END_PAGE, LINES_PER_PAGE, elementLines, pageBreakPositions,
} = require('../lib/screenplay-pagination');

test('every element type states whether a page may end after it', () => {
    /*
     * Declared per type rather than as a list of exceptions: a new element type
     * has to answer, instead of defaulting to breakable and being discovered in
     * a screenshot.
     */
    const missing = ELEMENT_TYPES.filter(t => typeof MAY_END_PAGE[t] !== 'boolean');
    assert.deepStrictEqual(missing, [],
        `these element types do not say whether a page may end after them: ${missing.join(', ')}`);

    const unknown = Object.keys(MAY_END_PAGE).filter(t => !ELEMENT_TYPES.includes(t));
    assert.deepStrictEqual(unknown, [],
        `the rule names types the editor cannot produce: ${unknown.join(', ')}`);

    /*
     * The ANSWERS are pinned, not just their presence.
     *
     * Every other assertion here derives its set FROM MAY_END_PAGE, so relaxing
     * the rule would shrink what is checked rather than fail anything — a
     * tautology, and mutation testing found it: flipping `parenthetical` to
     * breakable passed cleanly.
     *
     * These four are facts about screenplay format rather than preferences. A
     * cue without its dialogue, a parenthetical without the line it modifies, a
     * heading without its scene, and half a dual-dialogue are all things no
     * screenplay page is allowed to end on.
     */
    const MUST_NOT_END_A_PAGE = ['scene-heading', 'character', 'parenthetical', 'dual-dialogue'];
    const relaxed = MUST_NOT_END_A_PAGE.filter(t => MAY_END_PAGE[t] !== false);
    assert.deepStrictEqual(relaxed, [],
        `a page may now end on ${relaxed.join(', ')}, which orphans what follows`);
});

test('no page ends on an element that belongs with the next one', () => {
    /*
     * The whole rule, checked for EVERY keep-with-next type rather than for the
     * one that was reported. Each case builds a script whose break lands exactly
     * on that type and asserts the break moved up.
     */
    const keepWithNext = ELEMENT_TYPES.filter(t => MAY_END_PAGE[t] === false);
    assert.ok(keepWithNext.length >= 4,
        `expected several keep-with-next types, found ${keepWithNext.length}`);

    const broken = [];
    for (const type of keepWithNext) {
        // Fill to one line short of a page, then place the type under test so
        // the naive count breaks precisely after it.
        const blocks = [];
        let lines = 0;
        while (lines < LINES_PER_PAGE - 1) {
            blocks.push({ type: 'action', length: 50 });
            lines += elementLines('action', 50);
        }
        blocks.push({ type, length: 20 });               // the break would land here
        blocks.push({ type: 'dialogue', length: 40 });   // what it must not be split from
        blocks.push({ type: 'action', length: 50 });

        for (const at of pageBreakPositions(blocks)) {
            if (MAY_END_PAGE[blocks[at].type] === false) {
                broken.push(`${type}: a page still ends on "${blocks[at].type}"`);
            }
        }
    }
    assert.deepStrictEqual(broken, [],
        `page breaks orphan an element from what it belongs with:\n  ${broken.join('\n  ')}`);
});

test('the real screenplay that reported this no longer breaks illegally', () => {
    /*
     * The actual file, parsed to the same block shapes the editor holds. An
     * invented sequence can be made to pass; this is the document that produced
     * the screenshots.
     */
    const fixture = path.join(__dirname, 'fixtures', 'page-break-orphans.fountain');
    if (!fs.existsSync(fixture)) return;    // fixture optional; the synthetic cases carry the rule

    const lines = fs.readFileSync(fixture, 'utf8').split('\n');
    const blocks = [];
    let prev = null;
    for (const raw of lines) {
        const t = raw.trim();
        if (!t) { prev = null; continue; }
        let type = 'action';
        if (/^(INT|EXT|EST|INT\.\/EXT)[. ]/i.test(t)) type = 'scene-heading';
        else if (/^\(.*\)$/.test(t)) type = 'parenthetical';
        else if (/^[A-Z][A-Z0-9 .'()\-]*$/.test(t) && t.length < 40 && !prev) type = 'character';
        else if (prev === 'character' || prev === 'parenthetical' || prev === 'dialogue') type = 'dialogue';
        blocks.push({ type, length: t.length });
        prev = type;
    }

    const offenders = pageBreakPositions(blocks)
        .filter(at => MAY_END_PAGE[blocks[at].type] === false)
        .map(at => `page ends on ${blocks[at].type} at block ${at}`);
    assert.deepStrictEqual(offenders, [], offenders.join('; '));
});

test('the editor uses this rule rather than a second copy of it', () => {
    /*
     * The SPA cannot require a node module — build.target is single-html — so
     * the rule is inlined there and held to this one by assertion, the same
     * arrangement flow-seed has with PIPELINE_STEPS. Two paginators that
     * disagree is how the fix survives in tests and not on screen.
     */
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    assert.ok(/MAY_END_PAGE/.test(html),
        'the editor does not consult the keep-with-next rule at all, so the page it draws '
        + 'can still break between a character cue and its dialogue');

    for (const type of ELEMENT_TYPES.filter(t => MAY_END_PAGE[t] === false)) {
        assert.ok(new RegExp(`'${type}'\\s*:\\s*false`).test(html),
            `the editor's copy of the rule does not mark '${type}' as keep-with-next`);
    }
});

test('no code reads the block next to a page break without stepping over it', () => {
    /*
     * The indicator is a divider with no data-element-type, so anything reading
     * the immediate sibling's TYPE sees undefined where a block should be.
     *
     * Most sibling walks in the editor loop with a type test and step over it
     * on their own — findSpeakingCharacter does, and returns the right speaker
     * with a break between the cue and its dialogue. The hazard is code that
     * reads `previousElementSibling.dataset.elementType` in ONE hop: Tab after a
     * scene heading silently changed behaviour when a break happened to land
     * between them.
     */
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    const offenders = [];
    const lines = html.split('\n');
    lines.forEach((line, i) => {
        // a one-hop read of a sibling's element type
        if (!/(?:previous|next)ElementSibling\s*;?\s*$/.test(line.trim())) return;
        const varName = (line.match(/(?:const|let|var)\s+(\w+)\s*=/) || [])[1];
        if (!varName) return;
        const window_ = lines.slice(i + 1, i + 4).join('\n');
        const readsType = new RegExp(`${varName}\\.dataset\\.elementType`).test(window_);
        const stepsOver = new RegExp(`while\\s*\\(${varName}[\\s\\S]{0,80}page-break-indicator`).test(window_);
        if (readsType && !stepsOver) offenders.push(`line ${i + 1}: reads ${varName}.dataset.elementType without skipping the indicator`);
    });

    assert.deepStrictEqual(offenders, [],
        `these would see a page break where a block should be:\n  ${offenders.join('\n  ')}`);
});
