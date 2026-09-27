/**
 * The title page can be clicked and edited, and the PDF carries nothing the
 * browser added.
 *
 * The modal never opened: the form's field was `titlePageDraft` and the code
 * filled `titlePageDraftDate`, so `getElementById` returned null and the open
 * threw before the modal was shown — the button did nothing. Save closed it by
 * removing `active`, a class that shows nothing. Copyright and Notes were on
 * the form and read by nothing. Set-based over every field id the title-page
 * functions touch, so the next renamed field fails here rather than silently.
 *
 * The PDF printed "about:blank" bottom-left of every page: the browser's own
 * footer, drawn in the @page margins, naming the address of the pop-up the
 * print was written into. Zero @page margins leave it nowhere to go; the
 * screenplay margins move onto one sheet per page.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** A function's source, bounded by brace depth from its declaration. */
function fnSource(name) {
    const at = SPA.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
    assert.ok(at >= 0, `${name} is not defined`);
    let i = SPA.indexOf('(', at), depth = 0;
    for (; i < SPA.length; i++) { if (SPA[i] === '(') depth++; else if (SPA[i] === ')' && --depth === 0) break; }
    i = SPA.indexOf('{', i);
    depth = 0;
    const start = at;
    for (; i < SPA.length; i++) {
        if (SPA[i] === '{') depth++;
        else if (SPA[i] === '}' && --depth === 0) return SPA.slice(start, i + 1);
    }
    throw new Error(`${name} never closes`);
}

const TITLE_FNS = ['openTitlePageModal', 'saveTitlePage', 'clearTitlePage'];

test('every field the title-page code reads or writes exists on the form', () => {
    const ids = new Set();
    for (const f of TITLE_FNS) {
        for (const m of fnSource(f).matchAll(/getElementById\('(titlePage\w+)'\)/g)) ids.add(m[1]);
    }
    assert.ok(ids.size >= 8, `the scan found ${ids.size} field ids — it is not reading the functions`);
    const missing = [...ids].filter(id => !new RegExp(`id="${id}"`).test(SPA));
    assert.deepStrictEqual(missing, [], `the code touches fields the form does not have: ${missing.join(', ')}`);
});

test('every field on the form is filled when it opens and kept when it saves', () => {
    const form = SPA.slice(SPA.indexOf('id="titlePageModal"'), SPA.indexOf('<!-- FILM-131: Import Script Modal -->'));
    const fields = [...form.matchAll(/id="(titlePage(?!Modal)\w+)"/g)].map(m => m[1]);
    assert.ok(fields.length >= 8, `only ${fields.length} fields found on the form`);
    for (const f of fields) {
        assert.match(fnSource('openTitlePageModal'), new RegExp(`'${f}'`), `${f} is not filled when the modal opens`);
        assert.match(fnSource('saveTitlePage'), new RegExp(`'${f}'`), `${f} is not saved`);
    }
});

test('saving closes the modal the way every modal is closed', () => {
    const body = fnSource('saveTitlePage');
    assert.match(body, /closeModal\('titlePageModal'\)/);
    assert.ok(!/classList\.remove\('active'\)/.test(body), 'removing `active` closes nothing');
});

test('copyright and notes survive the trip through Fountain', () => {
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(fnSource('serializeTitlePageToFountain') + '\n' + fnSource('parseTitlePageFromFountain'), ctx);
    const tp = { title: 'Last Call', credit: 'Written by', author: 'M. Henri', draft_date: 'Sept 2026',
        copyright: '(c) 2026 M. Henri', notes: 'Second draft\nFor table read' };
    const back = ctx.parseTitlePageFromFountain(ctx.serializeTitlePageToFountain(tp) + 'INT. DINER - NIGHT\n');
    for (const k of Object.keys(tp)) assert.strictEqual(back[k], tp[k], `${k} did not round-trip`);
});

test('the title page is clickable on screen, outside the editable page', () => {
    assert.match(SPA, /id="titlePageCard"[^>]*onclick="openTitlePageModal\(\)"/s, 'no clickable title-page card');
    const card = SPA.indexOf('id="titlePageCard"');
    const editor = SPA.indexOf('id="screenplayEditor"');
    assert.ok(card > 0 && card < editor, 'the card is not placed before the editor');
    assert.match(fnSource('normalizeEditor'), /renderTitlePageCard\(\)/, 'the card is not refreshed when the editor changes');
});

test('the PDF leaves the browser no margin to print its header and footer in', () => {
    const css = fnSource('generatePrintHTML');
    assert.match(css, /@page\s*\{[^}]*margin:\s*0;/, 'the @page margin is not zero, so "about:blank" prints in it');
    assert.match(css, /\.print-sheet\s*\{[^}]*padding:/, 'the screenplay margins are not carried by each sheet');
    const exp = fnSource('exportToPDF');
    assert.match(exp, /paginateInto\(printable\);[\s\S]{0,120}?toPrintSheets\(printable\);/,
        'the export does not cut the paginated copy into sheets');
});

test('the printed script is a shooting script: scene numbers in both margins, eighths on the right', () => {
    const exp = fnSource('exportToPDF');
    assert.match(exp, /await loadScriptTiming\(\)/, 'the export does not read the numbers and eighths of the draft it prints');
    assert.match(exp, /paginateInto\(printable\);\s*shootingScriptMarks\(printable, SCRIPT_TIMING\);\s*toPrintSheets\(printable\);/);
    assert.ok(exp.indexOf("window.open('', '_blank')") < exp.indexOf('await loadScriptTiming'),
        'the print window is opened after an await, so the pop-up blocker refuses it');
    const marks = fnSource('shootingScriptMarks');
    assert.match(marks, /timingRowsForHeadings\(timing\)/, 'the marks do not use the shared heading rule');
    for (const cls of ['shoot-num-left', 'shoot-num-right', 'shoot-eighths']) {
        assert.match(marks, new RegExp(cls), `${cls} is never drawn`);
        assert.match(fnSource('generatePrintHTML'), new RegExp(`\\.${cls}`), `${cls} has no print style`);
    }
});

test('timing rows are matched to headings without the preamble row', () => {
    // The report opens with a heading-less row for whatever sits above the
    // first heading; matching by position without dropping it shifted every
    // scene by one — in the gutter AND in the print.
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(fnSource('timingRowsForHeadings'), ctx);
    const rows = ctx.timingRowsForHeadings({ scenes: [
        { heading: '', scene_number: 0, eighths: '1/8' },
        { heading: 'INT. DINER - NIGHT', scene_number: '1', eighths: '3/8' },
        { heading: 'EXT. LOT - NIGHT', scene_number: '2', eighths: '1 2/8' },
    ] });
    assert.deepStrictEqual(rows.map(r => r.scene_number), ['1', '2']);
    for (const user of ['renderScriptGutter', 'shootingScriptMarks']) {
        assert.match(fnSource(user), /timingRowsForHeadings\(/, `${user} matches rows to headings by raw position`);
    }
});
