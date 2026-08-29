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

    /*
     * Follows ONE call level, and no further.
     *
     * A writer may normalise directly, or delegate to a helper that does —
     * `afterCardEdit()` normalises, saves and repaints, and three card
     * functions call it rather than repeating those three lines. Refusing to
     * follow the call would report a correct function as broken, and a check
     * that cries wolf is one that gets relaxed until it protects nothing.
     *
     * One level rather than a full walk, deliberately: an unbounded walk
     * follows the refresh callbacks into every function the page renders and
     * eventually finds a `normalizeEditor` somewhere unrelated, which is how a
     * detector comes to pass on a writer that normalises nothing. The same
     * bound the clip-coverage detector settled on for the same reason.
     */
    const normalises = body => {
        if (/normalizeEditor\s*\(/.test(body)) return true;
        for (const m of body.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)) {
            const callee = m[1];
            if (callee === 'function' || callee === 'if' || callee === 'for'
                || callee === 'while' || callee === 'switch' || callee === 'catch') continue;
            const inner = bodyOf(callee);
            if (inner && /normalizeEditor\s*\(/.test(inner)) return true;
        }
        return false;
    };

    const missing = [];
    for (const name of functionsThatMutateTheEditor()) {
        if (EXEMPT[name]) continue;
        if (!normalises(bodyOf(name))) missing.push(name);
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

test('the scene-number badge is display, and never becomes part of the heading', () => {
    /*
     * The editor injects `<span class="scene-number-gutter">1</span>` into every
     * scene heading. It is contenteditable="false" and drawn in the margin — and
     * it is part of the block's textContent, so anything that reads a heading
     * naively gets "1EXT. SUBURBAN STREET - DUSK". Writing that back puts the
     * scene number INTO the screenplay, where the next parse reads it as part of
     * the location and every location-keyed thing downstream — the plate, the
     * reconciler, the elements list — sees a new place.
     *
     * Caught by opening a real card in a browser, not by any source check: the
     * badge appears nowhere in the card code.
     */
    const src = SPA;
    assert.ok(/function blockText\(/.test(src) && /function setBlockText\(/.test(src),
        'no reader/writer pair that respects the injected badge');

    const bodyOf = name => {
        const i = src.indexOf(`function ${name}(`);
        if (i < 0) return '';
        let depth = 0, j = src.indexOf('{', i), end = j;
        for (; j < src.length; j++) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') { depth--; if (!depth) { end = j; break; } }
        }
        return src.slice(i, end);
    };
    for (const fn of ['blockText', 'setBlockText']) {
        assert.ok(/scene-number-gutter/.test(bodyOf(fn)),
            `${fn} does not exclude the badge — it would read or overwrite it`);
    }
    // The card editor must go through them rather than touching textContent.
    const save = bodyOf('saveIndexCard');
    assert.ok(/setBlockText\s*\(/.test(save),
        'saveIndexCard writes the heading directly, so the scene number would be written into the script');
    assert.ok(!/block\.textContent\s*=/.test(save),
        'saveIndexCard still assigns textContent, which destroys the badge and swallows the number');
    const open_ = bodyOf('openIndexCard');
    assert.ok(/blockText\s*\(/.test(open_),
        'openIndexCard reads the parsed heading, which carries the scene number');
});

test('editing a scene card cannot shorten the scene', () => {
    /*
     * This one is written from damage, not from theory.
     *
     * The card editor loaded `scene.preview` — a TRUNCATED display string —
     * into the synopsis field and wrote it straight back on save. Opening a
     * real scene and pressing Save replaced its first action paragraph with an
     * abbreviation of itself ("...parked at the kerb, nos...") and DELETED the
     * four paragraphs after it, because the writer replaced the first action
     * block and removed the rest.
     *
     * It was destructive rather than recoverable because the editor autosaves
     * over the CURRENT script version rather than creating one: there was no
     * v5 to roll back to, only a v4 that had already been overwritten.
     *
     * Two invariants, both bound to the specific function so a mutation to
     * either fails:
     *   - what is loaded into the field is the scene's real action;
     *   - what is written back is as many paragraphs as it holds.
     */
    // Comments stripped FIRST. The comment explaining this fix names
    // `scene.preview` — the very thing being refused — so a check that reads
    // the raw body fails against the corrected code and passes against a
    // version with the comment deleted. Exactly backwards, and this codebase
    // has paid for it before.
    const bodyOf = name => {
        const i = SPA.indexOf(`function ${name}(`);
        if (i < 0) return '';
        let depth = 0, j = SPA.indexOf('{', i), end = j;
        for (; j < SPA.length; j++) {
            if (SPA[j] === '{') depth++;
            else if (SPA[j] === '}') { depth--; if (!depth) { end = j; break; } }
        }
        return SPA.slice(i, end)
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
    };

    const open_ = bodyOf('openIndexCard');
    assert.ok(open_, 'openIndexCard is gone');
    assert.ok(!/scene\.preview/.test(open_),
        'openIndexCard loads the truncated preview into a field that is written back to the script');
    assert.ok(/sceneActionText\s*\(/.test(open_),
        'openIndexCard does not read the real action out of the screenplay');

    const reader = bodyOf('sceneActionText');
    assert.ok(/scene-heading/.test(reader) && /action/.test(reader),
        'sceneActionText does not walk the scene to its next heading');

    const save = bodyOf('saveIndexCard');
    assert.ok(/split\(/.test(save),
        'saveIndexCard writes the field as ONE block: a four-paragraph scene would come back as one');
    assert.ok(/forEach|for\s*\(/.test(save),
        'saveIndexCard does not write back more than one paragraph');
});
