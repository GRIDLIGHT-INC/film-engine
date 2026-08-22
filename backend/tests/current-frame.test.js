/**
 * Every surface shows the version you SELECTED.
 *
 * Reported twice from use: "if I select a version it's not the one that shows
 * when we go back to the storyboard."
 *
 * Selecting became a pointer — `film_shots.current_frame_version` — and the
 * file on disk is copied to match. But every surface that paints a frame still
 * asked for `ORDER BY version DESC LIMIT 1`, the HIGHEST version, and keys its
 * URL to that number. So after selecting v13 of 17 the picture on disk is v13
 * and the board requests `?v=17` — which the browser already has cached from
 * when v17 was current, so it serves the frame you just moved away from.
 *
 * Silent, and it looks exactly like selecting not working.
 *
 * Set-based over the surfaces, because they each query independently and a fix
 * to one leaves the others lying — which is worse than all of them being wrong,
 * since the board and previs would then disagree with each other.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Every query that resolves "the frame this shot is showing". */
const SURFACES = [
    { file: 'routes/storyboard.js', what: 'the board' },
    { file: 'routes/previs.js', what: 'the previs stage' },
];

/*
 * Functions whose job genuinely IS "the newest attempt": the version allocator
 * and the archiver that copies the outgoing picture aside. Exempted by name
 * rather than by pattern, because the pattern is identical and only the
 * QUESTION differs — and an exemption that matches on text would quietly
 * excuse the next surface that gets it wrong.
 */
const NEWEST_IS_CORRECT = new Set([
    'archiveExistingFrame', 'registerStoryboardAsset', 'currentFrameVersion',
]);

/** The function each character offset falls inside. */
function functionAt(src, index) {
    let fn = null;
    const re = /^(?:async )?function (\w+)\(/gm;
    let m;
    while ((m = re.exec(src)) && m.index < index) fn = m[1];
    return fn;
}

test('no surface resolves the current frame by taking the highest version', () => {
    const offenders = [];
    for (const { file, what } of SURFACES) {
        const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const re = /asset_type = 'storyboard'[\s\S]{0,200}?ORDER BY (?:a\.)?version DESC[\s\S]{0,60}?LIMIT 1/g;
        let m;
        while ((m = re.exec(src))) {
            const fn = functionAt(src, m.index);
            if (fn && NEWEST_IS_CORRECT.has(fn)) continue;
            // The guard may sit just outside the matched SQL, so look at the
            // whole statement it belongs to.
            const window = src.slice(Math.max(0, m.index - 700), m.index + m[0].length + 200);
            if (/current_frame_version|currentFrameVersion/.test(window)) continue;
            offenders.push(`${file}:${fn || '?'} — ${what}`);
        }
    }
    assert.deepStrictEqual([...new Set(offenders)], [],
        'these paint the frame a shot is showing but ask for the HIGHEST version, so after '
        + `selecting an earlier one they serve the wrong picture: ${[...new Set(offenders)].join('; ')}`);
});

test('the board reports the selected version, not the newest', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes/storyboard.js'), 'utf8');
    const at = src.indexOf('asset_version:');
    assert.ok(at > 0, 'the board no longer reports a version');
    const around = src.slice(Math.max(0, at - 2000), at + 200);
    assert.ok(/currentFrameVersion\(/.test(around),
        'the board derives asset_version without consulting the pointer, so the URL it builds '
        + 'names a different version than the picture on disk');
});

test('previs keys its frame to the selected version too', () => {
    const src = fs.readFileSync(path.join(ROOT, 'routes/previs.js'), 'utf8');
    const at = src.indexOf('function shotKeyframe(');
    assert.ok(at > 0, 'shotKeyframe is gone');
    const body = src.slice(at, src.indexOf('\n}', at));
    assert.ok(/current_frame_version|currentFrameVersion/.test(body),
        'previs paints whichever version is highest, so it disagrees with the board after a selection');
});

test('the version used for cache-busting is the version on disk', () => {
    // The whole point: the ?v= key must name the picture actually served, or
    // the browser is asked for a URL it already has under a different picture.
    const html = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');
    const fn = html.slice(html.indexOf('function frameSrc('), html.indexOf('function frameSrc(') + 400);
    assert.ok(/asset_version/.test(fn), 'frameSrc no longer keys the URL to a version');
});
