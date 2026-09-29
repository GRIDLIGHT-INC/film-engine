const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lavfiSource } = require('./helpers');

/**
 * ONE LAVFI INPUT PER FFMPEG PROCESS.
 *
 * `-f lavfi -i color=… -f lavfi -i sine=…` deadlocks ffmpeg 9.0.2 when several
 * encodes run at once: the process sleeps at 0% CPU with its decoder, filter
 * and aac encoder threads waiting on each other, and the spawn dies at its
 * timeout with nothing on stderr. Twelve copies of repair-audio's fixture at a
 * time hung 3 to 4 of 12 on a quiet machine, every round; the same picture and
 * sound from one lavfi graph finished 36 of 36. Either half alone never hung.
 * That was the "schedule-dependent hang" of GRD-4580, which -nostdin did not
 * fix, and which showed only in the full suite because only the full suite
 * runs encodes side by side.
 *
 * The set is derived from the source: every argument array, and every array
 * pushed to by name, in tests/ and lib/. `lavfiSource` in tests/helpers.js is
 * the one way a fixture asks for a picture and a sound.
 */

const ROOT = path.join(__dirname, '..');
const LAVFI = /'-f',\s*'lavfi'/g;

function jsFiles(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...jsFiles(p));
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

/** Line comments out, strings kept: a comment may quote the old command. */
function code(src) {
    return src.split('\n').map(l => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l)).join('\n');
}

/** Where the array literal enclosing `at` opens, by bracket depth. */
function enclosingArray(src, at) {
    let depth = 0;
    for (let i = at; i >= 0; i--) {
        const c = src[i];
        if (c === ']') depth++;
        else if (c === '[') { if (depth === 0) return i; depth--; }
    }
    return -1;
}

/** Lines in one source where a single ffmpeg call gets two lavfi inputs. */
function doublesIn(raw) {
    const src = code(raw);
    const line = (at) => src.slice(0, at).split('\n').length;
    const hits = [];
    // Two in one array literal.
    const byArray = new Map();
    for (const m of src.matchAll(LAVFI)) {
        const open = enclosingArray(src, m.index);
        byArray.set(open, (byArray.get(open) || 0) + 1);
    }
    for (const [open, n] of byArray) if (n > 1) hits.push(`${line(open)} (${n} in one array)`);
    // One in an array, another pushed onto that same array by name.
    for (const m of src.matchAll(/(\w+)\.push\([^;]*'-f',\s*'lavfi'/g)) {
        if (new RegExp(`\\b${m[1]}\\s*=\\s*\\[[^\\]]*'-f',\\s*'lavfi'`).test(src)) hits.push(`${line(m.index)} (pushed onto ${m[1]})`);
    }
    return hits;
}

/** Every ffmpeg call site in tests/ and lib/ that gives one process two lavfi inputs. */
function doubleLavfi() {
    const found = [];
    for (const file of [...jsFiles(path.join(ROOT, 'tests')), ...jsFiles(path.join(ROOT, 'lib'))]) {
        // This file quotes the forbidden shape as the detector's own sample.
        if (file === __filename) continue;
        for (const h of doublesIn(fs.readFileSync(file, 'utf8'))) found.push(`${path.relative(ROOT, file)}:${h}`);
    }
    return found;
}

test('the scan sees lavfi inputs at all — an empty set would pass vacuously', () => {
    let n = 0;
    for (const file of jsFiles(path.join(ROOT, 'tests'))) n += (code(fs.readFileSync(file, 'utf8')).match(LAVFI) || []).length;
    assert.ok(n >= 20, `only ${n} lavfi inputs found in tests/; the scan is wrong`);
});

test('no ffmpeg call gives one process two lavfi inputs', () => {
    assert.deepStrictEqual(doubleLavfi(), [],
        'two lavfi inputs in one process deadlock ffmpeg under concurrency; use lavfiSource(video, audio) from tests/helpers.js');
});

test('the detector catches both shapes it exists for', () => {
    const arr = "sh(['-f', 'lavfi', '-i', 'color=c=red', '-f', 'lavfi', '-i', 'sine=frequency=440']);";
    const push = "const args = ['-f', 'lavfi', '-i', 'color=c=red'];\nargs.push('-f', 'lavfi', '-i', 'sine');";
    const apart = "make('a.png', ['-f', 'lavfi', '-i', 'color=c=blue']);\nmake('b.m4a', ['-f', 'lavfi', '-i', 'anullsrc']);";
    const one = "sh([...lavfiSource('color=c=red', 'sine=frequency=440')]);";
    assert.strictEqual(doublesIn(arr).length, 1, 'two lavfi inputs in one array were not caught');
    assert.strictEqual(doublesIn(push).length, 1, 'a lavfi input pushed onto an array holding one was not caught');
    assert.strictEqual(doublesIn(apart).length, 0, 'two separate calls were reported as one');
    assert.strictEqual(doublesIn(one).length, 0, 'the one-graph form was reported');
});

test('lavfiSource gives one input, and the picture and the sound as its two streams', () => {
    assert.deepStrictEqual(lavfiSource('color=c=red'), ['-f', 'lavfi', '-i', 'color=c=red']);
    assert.deepStrictEqual(lavfiSource('color=c=red', false), ['-f', 'lavfi', '-i', 'color=c=red']);
    assert.deepStrictEqual(lavfiSource('color=c=red', 'sine=frequency=440'),
        ['-f', 'lavfi', '-i', 'color=c=red[out0];sine=frequency=440[out1]']);

    const { resolveFfmpeg, inspectMedia } = require('../lib/ffmpeg');
    const ff = resolveFfmpeg();
    if (!ff.available) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-lavfi-'));
    try {
        const out = path.join(dir, 'av.mp4');
        require('child_process').execFileSync(ff.bin, ['-nostdin', '-y', '-loglevel', 'error',
            ...lavfiSource('color=c=red:s=64x48:d=1', 'sine=frequency=440:duration=1'),
            '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', out],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
        const info = inspectMedia(out);
        assert.ok(info.ok && info.hasAudio, `one graph did not give a picture and a sound: ${JSON.stringify(info)}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
