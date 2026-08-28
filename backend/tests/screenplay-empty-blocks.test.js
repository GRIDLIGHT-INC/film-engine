/**
 * An empty block costs 32px and means nothing.
 *
 * Measured in a real browser on The Glass Harbour: the correct gap between a
 * line of dialogue and the next character cue is 16px — one blank line, drawn
 * by `.sp-character { margin-top: 1em }`. Each EMPTY block sitting between them
 * adds exactly 32px:
 *
 *      correct               16px
 *      + 1 empty block       48px
 *      + 2 empty blocks      80px
 *      + 3 empty blocks     112px
 *
 * ...which is the "extra space" in the report, and why it comes and goes: the
 * serialiser does `if (!text) return;`, so an empty block writes NOTHING to the
 * Fountain. The moment anything re-parses the document and rebuilds the editor,
 * every empty block vanishes at once. That is the "it fixes itself when I click
 * away" — the document was never wrong, only the DOM was.
 *
 * They accumulate because `onEditorInput` CREATES them: its orphan-adoption
 * branch calls createBlock(text, defaultType) even when text is '', so every
 * bare <div> the browser leaves behind in a contenteditable becomes a permanent
 * empty `action` block.
 *
 * Set-based over every element type an empty block can be, because the rule
 * must not be type-specific: a sweep that cleans `action` and leaves
 * `character` fixes the reported case and leaves the other eleven.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SPA = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');

/* ── the denominator, derived from code ──────────────────────────────── */

const { ELEMENT_TYPES } = require('../lib/screenplay-pagination');

/** Every type the EDITOR can put on a block, from its own formatting rules. */
function editorTypes() {
    const i = SPA.indexOf('nextType: {');
    const body = SPA.slice(i, SPA.indexOf('}', i));
    const keys = [...body.matchAll(/'([a-z-]+)':/g)].map(m => m[1]);
    const values = [...body.matchAll(/:\s*'([a-z-]+)'/g)].map(m => m[1]);
    return [...new Set([...ELEMENT_TYPES, ...keys, ...values])];
}

test('the type set is derived and covers the editor, not just the paginator', () => {
    const types = editorTypes();
    assert.ok(types.length >= 12, `expected the editor's full type set, got ${types.length}`);
    for (const t of ELEMENT_TYPES) assert.ok(types.includes(t), `${t} missing`);
    for (const t of ['section', 'synopsis'])
        assert.ok(types.includes(t), `${t} is an editor type and is not in the set`);
});

/* ── the rule itself ─────────────────────────────────────────────────── */

let blocks;
test('there is one shared rule for which empty blocks may be dropped', () => {
    blocks = require('../lib/screenplay-blocks');
    assert.strictEqual(typeof blocks.droppableEmpties, 'function');
    assert.ok(Array.isArray(blocks.KEEP_EMPTY), 'the exemptions must be a named list');
});

test('an empty block of ANY type is dropped when it does not hold the caret', () => {
    const b = require('../lib/screenplay-blocks');
    for (const type of editorTypes()) {
        if (b.KEEP_EMPTY.includes(type)) continue;
        const doc = [
            { type: 'dialogue', text: 'I know what I did.' },
            { type, text: '' },
            { type: 'character', text: 'RAY' },
        ];
        assert.deepStrictEqual(b.droppableEmpties(doc), [1],
            `an empty ${type} block survived — it costs 32px and serialises to nothing`);
    }
});

test('the block holding the caret is never dropped, whatever its type', () => {
    const b = require('../lib/screenplay-blocks');
    for (const type of editorTypes()) {
        const doc = [
            { type: 'dialogue', text: 'I know what I did.' },
            { type, text: '', hasCaret: true },
        ];
        assert.deepStrictEqual(b.droppableEmpties(doc), [],
            `the empty ${type} block you are typing into was dropped — that is where the cursor is`);
    }
});

test('a block with text is never dropped, however little text', () => {
    const b = require('../lib/screenplay-blocks');
    for (const type of editorTypes()) {
        assert.deepStrictEqual(b.droppableEmpties([{ type, text: 'a' }]), []);
        // whitespace only is empty — a space is not content in a screenplay
        assert.deepStrictEqual(b.droppableEmpties([{ type, text: '   ' }]), [0]);
    }
});

test('the exemptions are named, with the title page among them', () => {
    const b = require('../lib/screenplay-blocks');
    // A title page has no body text and is entirely meaningful; a page-break
    // indicator is a divider rather than a block. Exempt BY NAME, never by
    // pattern — a pattern would quietly excuse the next type that gets this
    // wrong.
    assert.ok(b.KEEP_EMPTY.includes('title-page'), 'the title page would be deleted');
    assert.deepStrictEqual(b.droppableEmpties([{ type: 'title-page', text: '' }]), []);
});

test('several empty blocks are all reported, not just the first', () => {
    const b = require('../lib/screenplay-blocks');
    const doc = [
        { type: 'dialogue', text: 'Then you drove me home.' },
        { type: 'character', text: '' },
        { type: 'action', text: '' },
        { type: 'action', text: '', hasCaret: true },
        { type: 'character', text: 'RAY' },
    ];
    // 112px of blank in the screenshot: three empties, one of them the caret's.
    assert.deepStrictEqual(b.droppableEmpties(doc), [1, 2],
        'the sweep stopped early — the reported gap was several blocks, not one');
});

/* ── the page must actually use it ───────────────────────────────────── */

test('the editor never creates an empty block from an orphan node', () => {
    // The orphan-adoption branch called createBlock(text, defaultType) with
    // text === '', which is how a bare <div> from the browser became a
    // permanent 32px of nothing.
    const i = SPA.indexOf('function normalizeEditor');
    let depth = 0, j = SPA.indexOf('{', i), end = j;
    for (; j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}') { depth--; if (!depth) { end = j; break; } }
    }
    const body = SPA.slice(i, end);
    assert.match(body, /sweepEmptyBlocks\s*\(/,
        'the normaliser does not sweep the empty blocks it and the browser leave behind');
    // The guard itself, not merely a mention of the text: the branch must
    // REFUSE to adopt a textless node, and the way it refuses is to drop it.
    // NOTE the character class: bounding it with [^)] cannot cross the ')' in
    // blockHoldsCaret(node), so it matched nothing and passed against the bug.
    assert.match(body, /if\s*\([^{]*!text[^{]*\)\s*\{[^}]*node\.remove\(\)/,
        'the orphan branch still adopts a node with no text — that is how a bare <div> '
        + 'from the browser becomes 32px of permanent nothing');
});

test('the sweep exists on the page and mirrors the shared rule', () => {
    assert.match(SPA, /function sweepEmptyBlocks\s*\(/, 'no sweep on the page');
    const i = SPA.indexOf('function sweepEmptyBlocks');
    let depth = 0, j = SPA.indexOf('{', i), end = j;
    for (; j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}') { depth--; if (!depth) { end = j; break; } }
    }
    const body = SPA.slice(i, end);
    // The caret check is the whole safety of this: without it the sweep deletes
    // the block you are typing in.
    // Follow the call: the sweep may delegate the caret test, but the test it
    // delegates to must actually read the live selection. A predicate that
    // always returns false would sweep the line being typed.
    const caretCall = body.match(/(\w*[Cc]aret\w*)\s*\(/);
    assert.ok(caretCall,
        'the sweep does not consider where the caret is — it would delete the block being typed in');
    const pi = SPA.indexOf(`function ${caretCall[1]}(`);
    assert.ok(pi > 0, `${caretCall[1]} is called and never defined`);
    let pd = 0, pj = SPA.indexOf('{', pi), pend = pj;
    for (; pj < SPA.length; pj++) {
        if (SPA[pj] === '{') pd++;
        else if (SPA[pj] === '}') { pd--; if (!pd) { pend = pj; break; } }
    }
    assert.match(SPA.slice(pi, pend), /getSelection\(\)/,
        `${caretCall[1]}() does not read the live selection`);
    // It must consult the declared list, not inline the names: two places
    // holding the exemptions is how they drift apart.
    assert.match(body, /SP_KEEP_EMPTY\s*\.\s*includes\s*\(/,
        'the sweep does not consult the declared exemption list');
});

test('the two implementations agree on every type — held in lockstep', () => {
    // The SPA cannot require a node module (build.target is single-html), so
    // the rule exists twice. Two rules that disagree is how a fix survives in
    // tests and not on screen — the trap screenplay-pagination.js already
    // documents.
    const b = require('../lib/screenplay-blocks');
    const i = SPA.indexOf('const SP_KEEP_EMPTY');
    assert.ok(i > 0, 'the page does not declare its exemption list where it can be compared');
    const line = SPA.slice(i, SPA.indexOf(';', i));
    for (const t of b.KEEP_EMPTY)
        assert.ok(line.includes(`'${t}'`), `the page's exemption list is missing ${t}`);
    const pageTypes = [...line.matchAll(/'([a-z-]+)'/g)].map(m => m[1]);
    assert.deepStrictEqual(pageTypes, b.KEEP_EMPTY, 'the two exemption lists have drifted');
});
