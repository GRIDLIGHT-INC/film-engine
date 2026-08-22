/**
 * Playback starts on the shot you were looking at.
 *
 * "If I use playback it doesn't use the shot I selected in the board, it uses
 * the first one."
 *
 * `loadPlayback` set `pb.index = 0` unconditionally, so watching the shot you
 * have just spent an hour on meant scrubbing past everything before it — every
 * time, on a board that is only going to get longer.
 *
 * Nothing on the board recorded which shot a director was working on, which is
 * why the page had nothing better to start from. That is the actual gap: the
 * viewer tracks its own index, the Direct modal knows its shot, and neither
 * left a mark anyone else could read.
 *
 * Set-based over the places a shot becomes "the one you are on", because a mark
 * dropped by one of them and not the others gives playback a stale answer,
 * which is worse than always starting at the top: it is right often enough to
 * be trusted and wrong without saying so.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** Every entry point that means "I am working on this shot now". */
const MARKERS = [
    { fn: 'openFrameViewer', why: 'opening a frame full-screen' },
    { fn: 'editShotCard', why: 'directing a shot' },
    { fn: 'regenerateStoryboard', why: 'generating a shot' },
];

test('the places that mean "I am on this shot" all leave the same mark', () => {
    for (const { fn, why } of MARKERS) {
        const at = HTML.indexOf(`function ${fn}(`);
        assert.ok(at > 0, `${fn} is gone`);
        const body = HTML.slice(at, at + 1600);
        assert.ok(/markCurrentShot\(/.test(body),
            `${why} does not record which shot you are on, so playback cannot start there`);
    }
});

test('playback starts at the marked shot, not always the first', () => {
    const at = HTML.indexOf('async function loadPlayback(');
    assert.ok(at > 0, 'loadPlayback is gone');
    const body = HTML.slice(at, at + 3000);
    assert.ok(!/pb\.index = 0;\s*pb\.localMs = 0;/.test(body)
        || /playbackStartIndex\(/.test(body),
        'playback still hard-starts at the first shot');
    assert.ok(/playbackStartIndex\(/.test(body),
        'nothing resolves which shot playback should open on');
});

test('an unknown or missing mark falls back to the first shot', () => {
    // A mark can name a shot that is not in the timeline — deleted, or in a
    // scene that has no clips. Starting nowhere would be worse than starting at
    // the top, so the fallback has to be explicit rather than an exception.
    const at = HTML.indexOf('function playbackStartIndex(');
    assert.ok(at > 0, 'playbackStartIndex is not defined');
    const body = HTML.slice(at, at + 1200);
    assert.ok(/return 0|idx < 0|=== -1/.test(body),
        'a mark naming a shot the timeline does not contain has no defined behaviour');

    // It must read the shape the timeline actually returns. `entries`, not
    // `items` — the first version looked up pb.items, which is always
    // undefined, so it silently returned 0 every time and the fix did nothing.
    const load = HTML.slice(HTML.indexOf('async function loadPlayback('),
        HTML.indexOf('async function loadPlayback(') + 3000);
    assert.ok(/playbackStartIndex\((?:timeline && )?timeline\.entries|entries\)/.test(load),
        'playbackStartIndex is handed something other than the timeline entries, so it can only ever return 0');
});

test('there is a way to play from a specific shot deliberately', () => {
    // The mark is a convenience; "start here" is an instruction, and a director
    // should be able to give it without first opening the shot for another
    // reason.
    assert.ok(/playFromShot\(/.test(HTML), 'no control plays from a chosen shot');
    assert.ok(/playFromShot\('\$\{f\.shot_id\}'\)/.test(HTML),
        'the control is not on a frame, so "which shot" is unanswerable');
});
