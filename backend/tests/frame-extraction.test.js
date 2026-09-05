const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

/**
 * RBF-003 — one frame-extraction helper.
 *
 * `-ss <t> -i clip -frames:v 1` was written out four times across three files,
 * and the epic's own line for this task is the reason: THREE COPIES IS HOW ONE
 * ACQUIRES A FIX THE OTHERS DO NOT. That is not hypothetical here — it had
 * already happened before this task was picked up:
 *
 *   review-proxy.js  knows that seeking past the end EXITS 0 AND WRITES
 *                    NOTHING, and retries at frame 0.
 *   mcp-tools.js     does not, so a sample past the end is silently lost and
 *                    the tool reports "the clip could not be sampled".
 *   characters.js    does not, so an orbit view is silently skipped with
 *                    `continue` — on a route whose whole job is producing views.
 *
 * So the helper is not tidying. It is the mechanism by which the one site that
 * learned the lesson teaches the other two.
 *
 * The denominator is DERIVED by scanning for the extraction itself, because the
 * epic says "three call sites" and there are four — review-proxy contains two,
 * and a test written against a hand-counted three would report a complete fix
 * with one site still on its own copy.
 */

const BACKEND = path.join(__dirname, '..');
const LIB = path.join(BACKEND, 'lib');
const ROUTES = path.join(BACKEND, 'routes');

/** Where the helper is allowed to live. */
const HELPER_FILE = 'ffmpeg.js';

/**
 * Excluded BY NAME WITH ITS REASON, never by pattern: `board-raster.js` runs
 * `-frames:v 1` over `-i pipe:0` to rasterise ONE IMAGE arriving on stdin.
 * There is no clip and no timestamp, so it is a different operation that
 * happens to share a flag — and an exclusion that matched on text would quietly
 * excuse the next site that really is an extraction.
 */
const NOT_AN_EXTRACTION = { 'board-raster.js': 'rasterises a single image from a pipe; no clip, no timestamp' };

function sourceFiles() {
    const out = [];
    for (const dir of [LIB, ROUTES]) {
        for (const f of fs.readdirSync(dir)) {
            if (f.endsWith('.js')) out.push({ name: f, path: path.join(dir, f) });
        }
    }
    return out;
}

/** Files that spawn a frame extraction, excluding the helper and the exemption. */
function extractionSites() {
    return sourceFiles()
        .filter(f => f.name !== HELPER_FILE && !NOT_AN_EXTRACTION[f.name])
        .map(f => ({ ...f, hits: (fs.readFileSync(f.path, 'utf8').match(/-frames:v/g) || []).length }))
        .filter(f => f.hits > 0);
}

/* ── fixtures ──────────────────────────────────────────────────────────────
 * CHEAP, on the lesson clip-coverage.test.js already records: a flat encode at
 * a tiny size carries a real container with a real duration and costs almost
 * nothing under full-suite contention, so what is measured is the code rather
 * than the machine's spare capacity. `testsrc` is used only where the test
 * needs frames that actually DIFFER over time.
 */
let TMP;
function ff() { return require('../lib/ffmpeg').resolveFfmpeg(); }

function makeClip(name, args) {
    const p = path.join(TMP, name);
    execFileSync(ff().bin, ['-y', '-loglevel', 'error', ...args, p], { stdio: 'pipe', timeout: 60000 });
    return p;
}

test.before(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-frameext-'));
});
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* temp */ } });

/* ── the set ───────────────────────────────────────────────────────────── */

test('the scan finds the extraction sites it is meant to police', () => {
    const all = sourceFiles().filter(f => /-frames:v/.test(fs.readFileSync(f.path, 'utf8')));
    assert.ok(all.length >= 2,
        `only ${all.length} file(s) mention -frames:v; this scan is looking in the wrong place `
        + 'and every assertion below would pass over an empty set');
    // The exemption must describe a file that really exists and really extracts.
    for (const [name, why] of Object.entries(NOT_AN_EXTRACTION)) {
        assert.ok(all.some(f => f.name === name),
            `${name} is exempted (${why}) but no longer matches; a stale exemption is a lie`);
    }
});

test('no site extracts a frame on its own', () => {
    const rogue = extractionSites();
    assert.deepStrictEqual(rogue.map(r => `${r.name} (${r.hits})`), [],
        'these still spawn their own frame extraction instead of calling the shared helper — '
        + 'which is how one of them keeps a fix the others never get');
});

test('every former call site now reaches the helper', () => {
    /*
     * The other half of the same rule. Deleting the extraction without calling
     * the helper also empties the set above, and would read as a complete fix
     * while the feature is simply gone.
     */
    const FORMER = ['review-proxy.js', 'mcp-tools.js', 'characters.js'];
    for (const name of FORMER) {
        const f = sourceFiles().find(x => x.name === name);
        assert.ok(f, `${name} no longer exists; this test's premise is stale`);
        assert.match(fs.readFileSync(f.path, 'utf8'), /extractFrame/,
            `${name} neither extracts a frame nor calls extractFrame — the capability was dropped`);
    }
});

/* ── behaviour ─────────────────────────────────────────────────────────── */

test('it takes a frame from a real clip', () => {
    const { extractFrame } = require('../lib/ffmpeg');
    const clip = makeClip('flat.mp4',
        ['-f', 'lavfi', '-i', 'color=c=red:s=16x16:d=2', '-c:v', 'mpeg4', '-r', '10']);
    const out = path.join(TMP, 'a.png');
    const r = extractFrame(clip, { atSeconds: 1, out });
    assert.strictEqual(r.ok, true, `extraction failed: ${r.reason}`);
    assert.strictEqual(r.path, out);
    assert.ok(fs.existsSync(out) && fs.statSync(out).size > 0, 'no frame on disk');
});

test('seeking past the end still yields a frame, and says that it fell back', () => {
    /*
     * THE LESSON THIS HELPER EXISTS TO SPREAD. ffmpeg exits 0 for `-ss 30` on a
     * two-second clip and writes no file, so a caller gated on the throw sees
     * success and finds nothing. review-proxy already retried at frame 0; the
     * other two sites silently lost the frame.
     *
     * And the fallback is REPORTED. A caller that asked for 30s and is handed
     * frame 0 with no signal will label it "30.0s" — which is what shot_review
     * does with its sample labels.
     */
    const { extractFrame } = require('../lib/ffmpeg');
    const clip = makeClip('short.mp4',
        ['-f', 'lavfi', '-i', 'color=c=blue:s=16x16:d=1', '-c:v', 'mpeg4', '-r', '10']);
    const out = path.join(TMP, 'past.png');
    const r = extractFrame(clip, { atSeconds: 30, out });
    assert.strictEqual(r.ok, true, `a seek past the end produced no frame: ${r.reason}`);
    assert.ok(fs.existsSync(out) && fs.statSync(out).size > 0, 'no frame on disk');
    assert.strictEqual(r.fellBack, true,
        'the frame was taken from the start of the clip and the caller was not told');
});

test('a frame taken within the clip does not claim to have fallen back', () => {
    const { extractFrame } = require('../lib/ffmpeg');
    const clip = makeClip('ok.mp4',
        ['-f', 'lavfi', '-i', 'color=c=green:s=16x16:d=3', '-c:v', 'mpeg4', '-r', '10']);
    const r = extractFrame(clip, { atSeconds: 1, out: path.join(TMP, 'in.png') });
    assert.strictEqual(r.ok, true, r.reason);
    assert.ok(!r.fellBack, 'a normal extraction reported a fallback, which would make the flag noise');
});

test('sampling across a clip returns different frames', () => {
    /*
     * The defect behind shot_review. It called `probe(src)` — a function whose
     * signature is `probe(bin, args, opts)` and which RETURNS A PROMISE — read
     * `.durationSeconds` off that promise, got undefined, and fell to 0. So
     * every one of its five "samples across the clip" was frame 0, labelled
     * 0%, 25%, 50%, 75%, 100% with a timestamp each.
     *
     * Asserting the timestamps differ would have passed the whole time. The
     * PIXELS have to differ.
     */
    const { extractFrame } = require('../lib/ffmpeg');
    const clip = makeClip('moving.mp4',
        ['-f', 'lavfi', '-i', 'testsrc=size=32x32:rate=10:duration=3', '-c:v', 'mpeg4']);
    const digests = new Set();
    for (const [i, at] of [0, 1.4, 2.8].entries()) {
        const r = extractFrame(clip, { atSeconds: at, out: path.join(TMP, `s${i}.png`) });
        assert.strictEqual(r.ok, true, `sample at ${at}s failed: ${r.reason}`);
        digests.add(require('crypto').createHash('sha1')
            .update(fs.readFileSync(r.path)).digest('hex'));
    }
    assert.strictEqual(digests.size, 3,
        `three samples across a moving clip produced ${digests.size} distinct frame(s) — `
        + 'the seek is not being honoured');
});

/* ── failure states ────────────────────────────────────────────────────── */

test('every unusable input returns a reason and never throws', () => {
    const { extractFrame } = require('../lib/ffmpeg');
    const dir = fs.mkdtempSync(path.join(TMP, 'd-'));
    const text = path.join(TMP, 'not-a-clip.mp4');
    fs.writeFileSync(text, 'this is not a video');
    const empty = path.join(TMP, 'empty.mp4');
    fs.writeFileSync(empty, '');

    const cases = [
        ['a path that does not exist', path.join(TMP, 'missing.mp4')],
        ['a directory', dir],
        ['a text file wearing a .mp4 name', text],
        ['an empty file', empty],
        ['no path at all', undefined],
        ['a non-string path', 42],
    ];
    for (const [what, input] of cases) {
        let r;
        assert.doesNotThrow(() => { r = extractFrame(input, { out: path.join(TMP, 'x.png') }); },
            `${what} threw; a sampling failure must never take down the call that asked for it`);
        assert.strictEqual(r.ok, false, `${what} reported success`);
        assert.ok(typeof r.reason === 'string' && r.reason.length > 10,
            `${what} failed without a reason a caller can report: ${JSON.stringify(r.reason)}`);
    }
});

test('with no encoder it says so rather than failing as an unreadable file', () => {
    /*
     * Two different problems with two different remedies: "install ffmpeg" and
     * "this file is broken". Folding them together is what made a missing
     * encoder read as corrupt footage.
     */
    const { extractFrame } = require('../lib/ffmpeg');
    const r = extractFrame(path.join(TMP, 'anything.mp4'), {
        out: path.join(TMP, 'y.png'),
        ffmpeg: { available: false, reason: 'no encoder is available on this machine' },
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /encoder/i, `the reason does not name the encoder: ${r.reason}`);
});

test('no caller reads a promise as a value', () => {
    /*
     * The general form of the shot_review defect, held across the codebase:
     * `probe` is async, so `probe(x).durationSeconds` is undefined and every
     * guard built on it silently takes the zero branch.
     */
    /*
     * COMMENTS STRIPPED FIRST, LINE-BASED.
     *
     * The first version of this reported `mcp-tools.js` — matching the comment
     * that EXPLAINS the bug it was written to catch, so the file that fixes the
     * defect reports the defect. Stripping with the obvious block-comment regex
     * is worse: a `/*` inside a string opens a comment that runs to the next
     * close and eats real declarations, which this codebase has already paid
     * for once. Every comment line here begins with `*`, `//` or `/*`, so
     * dropping those lines never touches a line carrying code.
     */
    const stripComments = (src) => src.split('\n')
        .map(l => (/^\s*(\/\/|\/\*|\*)/.test(l) ? '' : l)).join('\n');
    const offenders = [];
    for (const f of sourceFiles()) {
        const s = stripComments(fs.readFileSync(f.path, 'utf8'));
        for (const m of s.matchAll(/(?<![.\w])probe\s*\(/g)) {
            const line = s.slice(0, m.index).split('\n').length;
            const stmt = s.slice(m.index, m.index + 200);
            const awaited = /await\s+probe\s*\($/.test(s.slice(Math.max(0, m.index - 10), m.index + 6));
            if (!awaited && !/^probe\s*\(\s*[\w.]+\s*,/.test(stmt)) {
                offenders.push(`${f.name}:${line}`);
            }
        }
    }
    assert.deepStrictEqual(offenders, [],
        `these call probe() without awaiting it or without its (bin, args) signature, so the `
        + `value they read is undefined: ${offenders.join(', ')}`);
});
