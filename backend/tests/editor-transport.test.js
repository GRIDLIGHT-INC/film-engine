const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/**
 * THINKING LIKE AN EDITOR.
 *
 * Reported from using it: "the slider of the playback is a bit clunky, I'd like
 * to be able to click one frame forward or back to select the exact frame in
 * and out". That is not a preference. A repair is defined by two frames, and a
 * scrubber a thousand pixels wide across a sixty-second cut moves about 60ms
 * per pixel — one and a half frames. THE MARKS CANNOT BE PLACED ACCURATELY AT
 * ALL by dragging, so the in-point lands wherever the mouse happened to be and
 * the generated section starts on a frame nobody chose.
 *
 * And the repair could be planned and priced on the page with NOTHING TO PRESS,
 * which I flagged when the marking surface was built and left open through two
 * more dispatches.
 */

/** Every control the editorial loop needs, and why each exists. */
const TRANSPORT = [
    { id: 'frame_back', handler: 'pbFrameStep',
      why: 'one frame back — the only way to place a mark on the frame you mean' },
    { id: 'frame_forward', handler: 'pbFrameStep',
      why: 'one frame forward, same reason' },
    { id: 'mark_in', handler: 'pbMarkIn', why: 'the point the repair starts from' },
    { id: 'mark_out', handler: 'pbMarkOut', why: 'the point it must arrive at' },
    { id: 'clear', handler: 'pbClearMarks', why: 'marks are placed by eye and got wrong constantly' },
    { id: 'run', handler: 'pbRunRepair',
      why: 'the repair was planned and priced on the page with nothing to press — '
        + 'a capability with no control is one that does not exist' },
];

/*
 * COMMENTS STRIPPED, line-based. Twice already in this session a scan matched
 * the COMMENT EXPLAINING the bug it hunts, so the file that fixes a defect
 * reports the defect. The block-comment regex is worse — a `/*` inside a
 * string opens a comment that eats real declarations — and every comment in
 * this page is a whole-line one, so dropping those lines never touches code.
 */
const CODE = SPA.split('\n').map(l => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l)).join('\n');

const bodyOf = (name, src) => {
    const text = src || CODE;
    const at = text.indexOf(`function ${name}`);
    if (at < 0) return '';
    let depth = 0;
    for (let i = text.indexOf('{', at); i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) return text.slice(at, i + 1);
    }
    return '';
};

/*
 * FOLLOWS ONE CALL LEVEL, the rule screenplay-mutators already sets. A step
 * that reads the rate through a named helper is not hardcoding it, and a check
 * that refuses to follow the call reports correct code as broken. One level
 * only — an unbounded walk eventually finds anything.
 */
const bodyAndCallees = (name) => {
    const body = bodyOf(name);
    let out = body;
    for (const m of body.matchAll(/\b(pb[A-Za-z]+)\s*\(/g)) {
        if (m[1] !== name) out += '\n' + bodyOf(m[1]);
    }
    return out;
};

test('every transport control exists and is bound to something clickable', () => {
    const missing = [];
    for (const c of TRANSPORT) {
        if (!new RegExp(`function\\s+${c.handler}\\s*\\(`).test(SPA)) {
            missing.push(`${c.id}: ${c.handler} is not defined`); continue;
        }
        if (!new RegExp(`onclick="${c.handler}\\(`).test(SPA)) {
            missing.push(`${c.id}: ${c.handler} is bound to nothing clickable`);
        }
    }
    assert.deepStrictEqual(missing, [], `controls an editor cannot reach: ${missing.join(', ')}`);
});

test('a frame step moves exactly one frame, at the timeline\'s own rate', () => {
    /*
     * Derived from the fps the timeline reports, never a constant. A 25fps
     * production stepped at 24 drifts a frame every second, which is precisely
     * the kind of error that is invisible until the marks are a second out.
     */
    const body = bodyAndCallees('pbFrameStep');
    assert.ok(body, 'there is no frame step');
    assert.match(body, /fps/, 'the step does not consult the frame rate');
    assert.ok(!/1000\s*\/\s*24|41\.6|\b41\b/.test(body),
        'the step hardcodes 24fps rather than reading the timeline\'s rate');
});

test('the keyboard drives it, because an editor does not reach for the mouse', () => {
    /*
     * Arrow keys for a frame and I/O for the marks are what every NLE uses.
     * Guarded so they do not fire while typing — a note field that eats the
     * left arrow is worse than no shortcut at all.
     */
    const handler = bodyOf('pbKeydown');
    assert.ok(handler, 'playback has no keyboard handler');
    for (const [key, why] of [
        ['ArrowLeft', 'one frame back'], ['ArrowRight', 'one frame forward'],
        ['i', 'mark in'], ['o', 'mark out'],
    ]) {
        assert.ok(handler.includes(key) || handler.includes(key.toUpperCase()),
            `no binding for ${key} (${why})`);
    }
    assert.match(handler, /INPUT|TEXTAREA|isContentEditable/,
        'the shortcuts fire while typing, so a note field would eat every arrow key');
});

test('the timecode an editor reads shows frames', () => {
    const tc = bodyOf('msToTc');
    assert.ok(tc, 'no timecode helper');
    assert.match(tc, /rate|fps/, 'the timecode does not use the frame rate, so it cannot show frames');
});

test('the run button spends, and says so before it does', () => {
    /*
     * Every paid control in this app goes through one confirmation that names
     * what it will cost. A repair is the most expensive thing on this page.
     */
    const body = bodyOf('pbRunRepair');
    assert.ok(body, 'there is no run handler');
    assert.match(body, /confirm|Confirm/, 'the repair runs with no confirmation');
    assert.match(body, /cost|usd|\$/i, 'the confirmation does not state the cost');
    assert.match(body, /repair/, 'the handler does not reach the repair route');
});

test('the cross-clip case is offered, not refused, on the page', () => {
    /*
     * DRIVE-IN's fault is the TRANSITION between two clips, and the page used
     * to say "spans a cut — repair each shot separately". That is the wrong
     * advice: neither shot is individually at fault, which is the whole reason
     * a bridge exists.
     */
    const render = bodyOf('pbRenderMarks');
    assert.ok(render, 'nothing renders the marks');
    assert.ok(!/repair each shot separately/i.test(render),
        'the page still tells an editor to repair each shot separately across a cut');
    assert.match(render, /bridge/i, 'the page never offers a bridge across the cut');
});
