/**
 * Watching the scene and hearing it.
 *
 * `lib/timeline.js` has picked an audio asset per shot since it was written and
 * playback ignored it entirely — so a director could watch the whole cut in
 * silence with the dialogue sitting on disk. Wiring it up surfaced two more:
 *
 * ONE asset per shot is right for a finished mix and wrong for dialogue. A shot
 * holds one file per LINE, so attaching one spoke the first line of a four-line
 * exchange and fell silent.
 *
 * And regenerating a shot's dialogue writes over the same per-line filenames
 * while inserting a new row each time: one four-line shot had SEVENTEEN rows
 * pointing at four files, so every line would have been spoken four times.
 *
 * The serving fix is pinned here too, because it is invisible from the API: the
 * file served perfectly to curl the entire time, and a browser could not play
 * it — piped with no Content-Length, Node falls back to chunked, and a media
 * element given a chunked response with no length stalls at readyState 0.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolveShotMedia } = require('../lib/timeline');
const SPA = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');

const asset = (over) => ({
    asset_type: 'audio_dialogue', file_path: '/d/audio/p/x.mp3',
    file_name: 'x.mp3', created_at: '2026-01-01', duration_ms: 1000, ...over,
});

test('a shot carries every line, in speaking order', () => {
    const media = resolveShotMedia([
        asset({ file_name: '1B_JUNE_3.mp3', file_path: '/a/1B_JUNE_3.mp3' }),
        asset({ file_name: '1B_RAY_0.mp3', file_path: '/a/1B_RAY_0.mp3' }),
        asset({ file_name: '1B_RAY_2.mp3', file_path: '/a/1B_RAY_2.mp3' }),
        asset({ file_name: '1B_JUNE_1.mp3', file_path: '/a/1B_JUNE_1.mp3' }),
    ]);
    assert.equal(media.audio_lines.length, 4, 'not every line came through');
    assert.deepEqual(media.audio_lines.map(l => l.index), [0, 1, 2, 3],
        'the lines are not in the order they are spoken');
});

test('ordered by the line index in the name, not by when it was made', () => {
    // created_at records when a line was GENERATED, so re-doing line 0 would
    // move it to the end of the scene.
    const media = resolveShotMedia([
        asset({ file_name: '1B_RAY_0.mp3', created_at: '2026-06-01' }),
        asset({ file_name: '1B_JUNE_1.mp3', created_at: '2026-01-01' }),
    ]);
    assert.deepEqual(media.audio_lines.map(l => l.file_name),
        ['1B_RAY_0.mp3', '1B_JUNE_1.mp3']);
});

test('a regenerated line is counted once, and it is the newest', () => {
    /*
     * Measured on the real project: shot 1D held 17 rows for 4 lines because
     * each regeneration inserts a row over the same filename. Without dedupe
     * every line plays four times.
     */
    const media = resolveShotMedia([
        asset({ file_name: '1D_JUNE_0.mp3', created_at: '2026-01-01', duration_ms: 111 }),
        asset({ file_name: '1D_JUNE_0.mp3', created_at: '2026-03-01', duration_ms: 999 }),
        asset({ file_name: '1D_JUNE_0.mp3', created_at: '2026-02-01', duration_ms: 555 }),
    ]);
    assert.equal(media.audio_lines.length, 1, 'a regenerated line is played more than once');
    assert.equal(media.audio_lines[0].duration_ms, 999,
        'an older row won — it describes a recording the bytes no longer hold');
});

test('a shot with no dialogue carries an empty list, not null', () => {
    // The player maps over this; null would throw on every silent shot.
    const media = resolveShotMedia([{ asset_type: 'storyboard', file_path: '/a/1A.png' }]);
    assert.deepEqual(media.audio_lines, []);
});

test('playback plays the lines, chained on the end of each', () => {
    assert.ok(/function pbPlayLine\(/.test(SPA), 'no line runner in playback');
    const i = SPA.indexOf('function pbPlayLine(');
    const body = SPA.slice(i, i + 900);
    assert.ok(/audio_lines|pb\.lines/.test(SPA.slice(SPA.indexOf('function loadShotIntoStage'), SPA.indexOf('function loadShotIntoStage') + 2500)),
        'loading a shot does not load its lines');
    assert.ok(/onended/.test(body),
        'the lines are not chained on `ended` — timing them against the clock would talk over '
        + 'the next line on any shot whose card duration disagrees with the recording');
});

test('the dialogue can be turned off, and it applies to the shot you are on', () => {
    assert.ok(/id="pbDialogue"/.test(SPA), 'no dialogue toggle in the transport');
    assert.ok(/function pbDialogueToggled\(/.test(SPA), 'the toggle is bound to nothing');
});

test('served media carries a length and accepts ranges', () => {
    /*
     * Invisible from the API and fatal in a browser: curl fetched the file
     * perfectly the whole time, while `<audio>` stalled at readyState 0,
     * because a piped response with no Content-Length becomes chunked and a
     * media element cannot compute a duration from it.
     */
    const src = fs.readFileSync(path.join(__dirname, '../lib/file-storage.js'), 'utf8');
    const i = src.indexOf('function serveFile(');
    const body = src.slice(i);

    /*
     * Scoped to the PLAIN 200 response, not the file.
     *
     * The first version of this checked the whole function for the string
     * 'Content-Length' — and the range branch sets one too, so deleting it from
     * the non-range response left the test green while every media element
     * stalled again. A check that cannot fail against the bug it was written
     * for is worse than none.
     */
    const plain = body.slice(body.lastIndexOf('res.writeHead(200,'));
    assert.ok(/'Content-Length'/.test(plain),
        'the plain 200 response pipes with no Content-Length, so media elements stall');
    assert.ok(/'Accept-Ranges'/.test(plain),
        'the plain 200 response does not advertise range support');
    assert.ok(/'Accept-Ranges'/.test(body), 'serveFile does not advertise range support');
    assert.ok(/206/.test(body) && /Content-Range/.test(body),
        'a range request is answered with the whole file, so scrubbing re-downloads it');
    assert.ok(/416/.test(body), 'an unsatisfiable range is not refused');
});
