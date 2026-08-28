/**
 * EVERY way a screenplay is written or edited must leave the editor sound.
 *
 * The empty-block and furniture fixes both landed in `onEditorInput`, which is
 * the TYPING path. That is one way in. There are thirteen others, and none of
 * them normalised anything:
 *
 *   - the AI writes into the screenplay (three separate insert paths)
 *   - a prose conversion is accepted
 *   - undo and redo restore an innerHTML snapshot wholesale
 *   - Enter builds a block by hand after preventDefault
 *   - scenes are reordered, which rebuilds the editor
 *   - a version is loaded, the Fountain is rendered, the title page is rewritten
 *   - an element's type is changed from the dropdown
 *
 * A PROGRAMMATIC DOM CHANGE DOES NOT FIRE `input`. So all of those left the
 * editor in whatever state they made and waited for the writer's next
 * keystroke to tidy up — which is exactly the shape of the reported bug, one
 * level up from where it was fixed.
 *
 * Set-based over the mutators DERIVED FROM THE SOURCE, so the fourteenth way in
 * fails this test instead of quietly shipping.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SPA = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');

/* ── the denominator ─────────────────────────────────────────────────── */

/** Anything that changes the STRUCTURE of the editor's children. */
const STRUCTURAL = /editor\.innerHTML\s*[+]?=|screenplayEditor'\)\.innerHTML\s*[+]?=|editor\.appendChild|editor\.insertBefore|editor\.replaceChild|editor\.removeChild/;

/**
 * Exempt BY NAME, each with the reason it cannot leave the editor unsound.
 * Never by pattern — a pattern would quietly excuse the next one that does.
 */
const EXEMPT = Object.freeze({
    captureEditorState: 'reads innerHTML for the undo stack; changes nothing',
    exportToPDF: 'reads innerHTML to print; changes nothing',
    formatBold: 'execCommand on a selection, which fires a native input event',
    formatItalic: 'execCommand on a selection, which fires a native input event',
    formatUnderline: 'execCommand on a selection, which fires a native input event',
    onEditorInput: 'IS the normaliser',
    normalizeEditor: 'IS the normaliser',
    sweepEmptyBlocks: 'part of the normaliser',
});

function functionsThatMutateTheEditor() {
    const lines = SPA.split('\n');
    const starts = [];
    lines.forEach((l, i) => {
        const m = l.match(/^\s*(?:async\s+)?function (\w+)\s*\(/);
        if (m) starts.push({ line: i + 1, name: m[1] });
    });
    const owner = n => {
        let best = null;
        for (const f of starts) { if (f.line <= n) best = f; else break; }
        return best ? best.name : '(top level)';
    };
    const found = new Set();
    lines.forEach((l, i) => {
        if (l.length < 400 && STRUCTURAL.test(l)) found.add(owner(i + 1));
    });
    return [...found].sort();
}

test('the editor really is written to from many places', () => {
    const all = functionsThatMutateTheEditor();
    assert.ok(all.length >= 12,
        `expected the editor to have many writers, found ${all.length}: ${all.join(', ')}`);
    // The ones this bug was actually reported through must be in the set.
    for (const n of ['renderFountainToEditor', 'editorUndo', 'appendAIContent', 'acceptConversion'])
        assert.ok(all.includes(n), `${n} is not detected as an editor writer`);
});

test('every exemption is real — none names a function that does not exist', () => {
    for (const name of Object.keys(EXEMPT)) {
        assert.ok(new RegExp(`function ${name}\\s*\\(`).test(SPA),
            `${name} is exempted and does not exist — a stale exemption is a lie`);
        assert.ok(EXEMPT[name] && EXEMPT[name].length > 10,
            `${name} is exempted without a reason`);
    }
});

test('EVERY way of writing a screenplay leaves the editor normalised', () => {
    const bodyOf = name => {
        const i = SPA.indexOf(`function ${name}(`);
        if (i < 0) return '';
        let depth = 0, j = SPA.indexOf('{', i), end = j;
        for (; j < SPA.length; j++) {
            if (SPA[j] === '{') depth++;
            else if (SPA[j] === '}') { depth--; if (!depth) { end = j; break; } }
        }
        return SPA.slice(i, end);
    };

    const missing = [];
    for (const name of functionsThatMutateTheEditor()) {
        if (EXEMPT[name]) continue;
        const body = bodyOf(name);
        if (!/normalizeEditor\s*\(/.test(body)) missing.push(name);
    }
    assert.deepStrictEqual(missing, [],
        'these change the editor and never normalise it, so the writer sees whatever they left '
        + 'behind until the next keystroke: ' + missing.join(', '));
});

/* ── what the normaliser has to be ───────────────────────────────────── */

test('there is exactly one normaliser, and the typing path uses it too', () => {
    const defs = (SPA.match(/function normalizeEditor\s*\(/g) || []).length;
    assert.strictEqual(defs, 1, `expected one normalizeEditor, found ${defs}`);
    const i = SPA.indexOf('function onEditorInput(');
    let depth = 0, j = SPA.indexOf('{', i), end = j;
    for (; j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}') { depth--; if (!depth) { end = j; break; } }
    }
    assert.match(SPA.slice(i, end), /normalizeEditor\s*\(/,
        'typing goes through a different path from everything else — that is how they drift');
});

test('the normaliser does all three jobs, not just the one that was reported', () => {
    const i = SPA.indexOf('function normalizeEditor(');
    assert.ok(i > 0, 'no normalizeEditor');
    let depth = 0, j = SPA.indexOf('{', i), end = j;
    for (; j < SPA.length; j++) {
        if (SPA[j] === '{') depth++;
        else if (SPA[j] === '}') { depth--; if (!depth) { end = j; break; } }
    }
    const body = SPA.slice(i, end);
    assert.match(body, /Furniture\s*\(/, 'the normaliser does not protect the editor\'s furniture');
    assert.match(body, /createBlock\s*\(/, 'the normaliser does not adopt orphan text into blocks');
    assert.match(body, /sweepEmptyBlocks\s*\(/, 'the normaliser does not sweep empty blocks');
});

test('normalising is safe to call twice — it runs after every write', () => {
    // Idempotence matters because several paths write and then call it, and
    // some of those call each other. A normaliser that is not idempotent turns
    // one edit into a cascade.
    const blocks = require('../lib/screenplay-blocks');
    const doc = [
        { type: 'dialogue', text: 'I know what I did.' },
        { className: 'page-break-indicator', text: '' },
        { type: 'action', text: '' },
        { type: 'character', text: 'RAY' },
    ];
    const first = blocks.droppableEmpties(doc);
    const after = doc.filter((_, i) => !first.includes(i));
    assert.deepStrictEqual(blocks.droppableEmpties(after), [],
        'a second pass would keep removing things — the normaliser is not idempotent');
});
