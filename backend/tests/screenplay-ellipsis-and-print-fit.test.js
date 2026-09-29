/**
 * TWO SCREENPLAY BUGS FOUND ON DRIVE-IN OUTREACH.
 *
 * 1. A dialogue line that opens with an ellipsis — "..same price." — kept
 *    turning back into a SCENE HEADING (".SAME PRICE."). Fountain forces a
 *    heading with ONE leading period; the page's editor tested /^\./ in five
 *    places, so an ellipsis matched. The backend parser already refused '..'.
 *
 * 2. Printed pages bled past the top and bottom of the paper. Breaks are
 *    placed from a line estimate that runs short; each print sheet is a fixed
 *    11in, so an overfull sheet spilled onto the next page and pushed every
 *    page after it down. The print window now measures and refits before it
 *    opens the dialog.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

function forcedHeading() {
    const m = /forcedSceneHeading:\s*(\/.+\/),/.exec(PAGE);
    assert.ok(m, 'forcedSceneHeading is gone from AUTO_FORMAT_RULES');
    const src = m[1];
    return new RegExp(src.slice(1, src.lastIndexOf('/')));
}

test('one leading period forces a heading; an ellipsis does not', () => {
    const re = forcedHeading();
    for (const yes of ['.SAME PRICE.', '.flashback', '.INT KITCHEN']) assert.ok(re.test(yes), `${yes} should be a forced heading`);
    for (const no of ['..same price.', '...', '. ', '.', '...and then']) assert.ok(!re.test(no), `${no} must NOT be a heading`);
});

test('no heading check in the page still tests a bare leading period', () => {
    assert.ok(!/trimmed\.startsWith\('\.'\)/.test(PAGE),
        'a heading detector still uses startsWith(\'.\'), which reads an ellipsis as a heading');
});

test('the page and the backend parser agree on the ellipsis', () => {
    const { parseFountain } = require('../lib/fountain-parser');
    const out = parseFountain('INT. ROOM - DAY\n\nMANNY\nA commercial...\n(pause)\n..same price.\n');
    const els = out.elements || [];
    assert.strictEqual(els.filter(e => e.type === 'scene_heading').length, 1, 'the backend made a second scene out of "..same price."');
    assert.deepStrictEqual(els[els.length - 1], { type: 'dialogue', text: '..same price.' });
});

test('the print window measures and refits every sheet before it prints', () => {
    const at = PAGE.indexOf('printWindow.onload = () => {');
    assert.ok(at > -1);
    const onload = PAGE.slice(at, at + 300);
    assert.ok(onload.indexOf('fitPrintSheets(printWindow.document)') > -1, 'no fitting pass before print');
    assert.ok(onload.indexOf('fitPrintSheets') < onload.indexOf('.print()'), 'the fit runs after the dialog opens');
    const fn = PAGE.slice(PAGE.indexOf('function fitPrintSheets('), PAGE.indexOf('function generatePrintHTML('));
    assert.match(fn, /scrollHeight > sheet\.clientHeight/, 'fitting no longer measures the sheet');
    assert.match(fn, /MAY_END_PAGE\[t\] === false/, 'a cue or heading could be left at the foot of a page');
    assert.match(fn, /print-page-number/, 'page numbers are not redrawn after refitting');
});

test('a sheet cannot spill onto the next physical page', () => {
    const css = PAGE.slice(PAGE.indexOf('.print-sheet {'), PAGE.indexOf('.print-sheet {') + 400);
    assert.match(css, /overflow: hidden/, 'a sheet that overflows pushes every later page down');
    const h = /height: ([\d.]+)in/.exec(css);
    assert.ok(h && Number(h[1]) < 11, 'a sheet exactly as tall as the paper spills its rounding onto the next page');
});
