/**
 * AN OVERSIZE UPLOAD MUST SAY SO, NOT LOOK LIKE A DEAD SERVER.
 *
 * The server answers 413 correctly. The page is the half that was uneven: of
 * the eight functions that take a file from an input and send it, exactly ONE
 * checked the size first. The other seven pushed the whole file — on a phone,
 * over mobile data — to find out, and what came back reached `api()` as a
 * failure the user reads as "Backend offline". That is indistinguishable from
 * the engine being down, on the one feature where large files are the point.
 *
 * Set-based over the uploaders DERIVED FROM THE PAGE, not a list typed here:
 * seven of eight being fixed is exactly the state this prevents, and an
 * uploader added next month is in the denominator with nothing to remember.
 *
 * The limit itself is MIRRORED from backend/lib/body-limit.js rather than
 * invented, and the two are held equal over real URLs. A client ceiling that
 * disagreed with the server's would either refuse a file the server would take
 * — worse than no check — or wave through one it will not.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const UI = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const limits = require('../lib/body-limit');

function fnSource(name) {
    const at = UI.indexOf(`function ${name}(`);
    if (at < 0) return null;
    let d = 0;
    for (let i = UI.indexOf('{', at); i < UI.length; i++) {
        if (UI[i] === '{') d++;
        else if (UI[i] === '}' && --d === 0) return UI.slice(at, i + 1);
    }
    return null;
}

/** Every function that takes a file from an input and sends it. THE registry. */
function uploaders() {
    const names = [...new Set([...UI.matchAll(/function ([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]))];
    const found = names.filter((n) => {
        const b = fnSource(n) || '';
        return /\.files\s*(?:&&|\[)/.test(b) && /\b(?:api|fetch)\(/.test(b);
    });
    assert.ok(found.length >= 6,
        `the uploader scan found ${found.length} — it is broken, and every check below `
        + 'would pass over a set that is too small');
    return found;
}

/** Run the page's mirrored limit rule in isolation. */
function pageLimitFor() {
    const src = ['UPLOAD_BODY_LIMITS', 'uploadLimitFor']
        .map((n) => {
            const f = fnSource(n);
            if (f) return f;
            const m = new RegExp(`const ${n}\\s*=\\s*[^;]+;`).exec(UI);
            return m ? m[0] : null;
        });
    assert.ok(src.every(Boolean), 'the page has no mirrored upload-limit rule');
    // eslint-disable-next-line no-new-func
    return new Function(`${src.join('\n')}; return uploadLimitFor;`)();
}

/** The server's rule, as server.js actually composes it. */
function serverLimitFor(url) {
    const parts = ['film', ...String(url).split('?')[0].split('/').filter(Boolean)];
    return limits.limitForPath(parts);
}

/** Real upload URLs, plus the shapes that decide each branch. */
const URLS = [
    '/projects/import',                       // bundle — its own, larger ceiling
    '/shots/s1/media/video/import',
    '/shots/s1/storyboard/import',
    '/shots/s1/previs/image/import',
    '/projects/p1/models/import',
    '/characters/c1/refsheet/import',
    '/locations/l1/plate/import',
    '/props/p1/plate/import',
    '/projects/p1/mood-board/import',
    '/style-book/e1/media',                   // ends in `media`, not `import`
    '/music-sessions/s1/stems',               // a batch of stems: files, not JSON
    '/music-cues/c1/audio',                   // ordinary JSON ceiling
    '/uploads/0123456789abcdef0123456789abcdef', // one piece of a resumable upload (an edit)
    '/edits/e1/cut',                          // an edit's XML or EDL, as JSON
    '/projects/p1/script',
];

test('the registry is real, and the server exposes one composed rule', () => {
    assert.ok(uploaders().length >= 6);
    assert.strictEqual(typeof limits.limitForPath, 'function',
        'body-limit.js does not expose the composed rule, so server.js still holds a second copy');
});

test('every uploader refuses an oversize file before sending it', () => {
    const missing = uploaders().filter((n) => !/checkUploadSize\s*\(/.test(fnSource(n) || ''));
    assert.deepStrictEqual(missing, [],
        `these send the file and let the server refuse it, which reads as the engine being down: ${missing.join(', ')}`);
});

test('the page ceiling agrees with the server on every upload shape', () => {
    const pageFor = pageLimitFor();
    const bad = [];
    for (const url of URLS) {
        const mine = pageFor(url);
        const theirs = serverLimitFor(url);
        if (mine !== theirs) bad.push(`${url}: page ${mine} vs server ${theirs}`);
    }
    assert.deepStrictEqual(bad, [], `the client and server disagree about the ceiling:\n  - ${bad.join('\n  - ')}`);
});

test('the bundle ceiling is not flattened into the ordinary one', () => {
    const pageFor = pageLimitFor();
    assert.ok(pageFor('/projects/import') > pageFor('/shots/s1/media/video/import'),
        'a bundle import must keep its larger ceiling, or a normal project export cannot be re-imported');
    assert.ok(pageFor('/shots/s1/media/video/import') > pageFor('/music-cues/c1/audio'),
        'a file-carrying path must beat the JSON default, or a photograph is refused');
});

test('the refusal names the size and the limit, and allows what fits', () => {
    const src = ['UPLOAD_BODY_LIMITS', 'uploadLimitFor', 'checkUploadSize'].map((n) => {
        const f = fnSource(n);
        if (f) return f;
        const m = new RegExp(`const ${n}\\s*=\\s*[^;]+;`).exec(UI);
        return m ? m[0] : null;
    });
    assert.ok(src.every(Boolean), 'the page has no shared upload-size check');
    // eslint-disable-next-line no-new-func
    const check = new Function(`${src.join('\n')}; return checkUploadSize;`)();

    const url = '/shots/s1/media/video/import';
    // Under the ceiling: silent.
    assert.doesNotThrow(() => check({ name: 'a.mp4', size: 1024 }, url));

    // Over it: a sentence carrying BOTH numbers, so the user can act.
    let msg = '';
    try { check({ name: 'big.mp4', size: 400 * 1048576 }, url); } catch (e) { msg = e.message; }
    assert.ok(msg, 'an oversize file was accepted');
    assert.match(msg, /400/, 'the message does not say how big the file is');
    assert.match(msg, /\b1\d\dMB\b|\b\d{2,3}MB\b/, 'the message does not state the limit');
    assert.ok(msg.length > 40, `"${msg}" is too terse to act on`);

    // The base64 inflation is why the file ceiling is below the body ceiling.
    const bodyMax = new Function(`${src.join('\n')}; return uploadLimitFor;`)()(url);
    let just = '';
    try { check({ name: 'x.mp4', size: bodyMax - 1 }, url); } catch (e) { just = e.message; }
    assert.ok(just,
        'a file just under the BODY limit was accepted — base64 makes it a third larger, so it will 413');
});
