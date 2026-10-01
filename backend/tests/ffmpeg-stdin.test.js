/**
 * GRD-4580 — no ffmpeg process may read stdin.
 *
 * ffmpeg reads its standard input for interactive commands (`q`, `?`, `+`) unless
 * it is told not to. A spawn that leaves stdin attached lets the encoder wait on,
 * or steal bytes from, whatever that descriptor happens to be — and the suite
 * showed it as a schedule-dependent hang: repair-audio passed alone and timed out
 * at 120s when other files ran beside it. Of 84 encoder spawns, only lib/music-renderer.js passed
 * `-nostdin`.
 *
 * The rule, held at EVERY spawn of the encoder in lib/, routes/, the entry points
 * and tests/: the argument list opens with `-nostdin`, and stdin is `ignore`.
 * (A site that feeds ffmpeg its input on stdin keeps the pipe; Node closes it.)
 * Both, because they are different guarantees — `-nostdin` is ffmpeg's promise
 * not to read, `ignore` is ours that there is nothing to read.
 *
 * The set is DERIVED: every spawnSync / execFileSync / execFile / spawn call in a
 * file that mentions ffmpeg. A call that runs something else is exempted BY SITE
 * with its reason, and an exemption that names no call fails, so the list cannot
 * quietly outlive the code it excuses.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'vendor', '.git', 'data', '.venv']);

// file|first-argument → why it is not the encoder.
const NOT_FFMPEG = {
    'lib/instrument-render.js|bin': 'probes FluidSynth (`--version`), not ffmpeg',
    'lib/instrument-render.js|fl.bin': 'runs FluidSynth to render MIDI',
    'lib/set-build.js|bin': 'probes Blender (`--version`), not ffmpeg',
    'lib/set-build.js|blender.bin': 'runs Blender headless to build a set',
    'tests/instrument-host.test.js|venv': 'starts the Python instrument sidecar',
    "tests/music-bundle.test.js|'tar'": 'unpacks a bundle with tar',
    "tests/music-rights.test.js|'zip'": 'builds an archive with zip',
    "tests/room-scan.test.js|'xcrun'": 'finds and runs swiftc to compile the phone\'s wall geometry',
    "tests/room-scan.test.js|path.join(dir, 'w')": 'runs that compiled geometry harness',
};

function jsFiles(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) jsFiles(p, out);
        else if (p.endsWith('.js') && !p.includes(`${path.sep}src${path.sep}`)) out.push(p);
    }
    return out;
}

// Split a call's argument text at top-level commas, skipping strings and nesting.
function splitArgs(s) {
    const parts = []; let depth = 0, cur = '', q = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) { cur += c; if (c === '\\') { cur += s[++i] || ''; continue; } if (c === q) q = null; continue; }
        if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
        if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i + 2) + 1; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
        if ('([{'.includes(c)) depth++;
        if (')]}'.includes(c)) depth--;
        if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
}

// The text between a call's parentheses, by depth, skipping strings.
function callBody(s, open) {
    let depth = 1, q = null, i = open;
    for (; i < s.length && depth; i++) {
        const c = s[i];
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
        if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i + 2) + 1; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '(') depth++; else if (c === ')') depth--;
    }
    return s.slice(open, i - 1);
}

function spawnSites() {
    const sites = [];
    for (const file of jsFiles(ROOT)) {
        const src = fs.readFileSync(file, 'utf8');
        if (!/ffmpeg/i.test(src)) continue;
        const rel = path.relative(ROOT, file).split(path.sep).join('/');
        const lines = src.split('\n');
        const re = /\b(spawnSync|execFileSync|execFile|spawn)\s*\(/g;
        let m;
        while ((m = re.exec(src))) {
            const line = src.slice(0, m.index).split('\n').length;
            if (/^\s*(\*|\/\/)/.test(lines[line - 1])) continue; // prose, not a call
            const args = splitArgs(callBody(src, m.index + m[0].length));
            sites.push({ rel, line, fn: m[1], bin: args[0], argv: args[1] || '', opts: args[2] || '' });
        }
    }
    return sites;
}

const SITES = spawnSites();
const FF_SITES = SITES.filter(s => !NOT_FFMPEG[`${s.rel}|${s.bin}`]);

test('the set is real: ffmpeg is spawned from lib/ and from tests/', () => {
    // An empty set would pass every rule below and prove nothing.
    assert.ok(FF_SITES.length >= 60, `found only ${FF_SITES.length} ffmpeg spawn sites`);
    assert.ok(FF_SITES.some(s => s.rel.startsWith('lib/')), 'no lib/ site found');
    assert.ok(FF_SITES.some(s => s.rel.startsWith('tests/')), 'no tests/ site found');
});

test('every exemption names a call that exists', () => {
    const seen = new Set(SITES.map(s => `${s.rel}|${s.bin}`));
    const stale = Object.keys(NOT_FFMPEG).filter(k => !seen.has(k));
    assert.deepStrictEqual(stale, [], `exemptions with no call behind them: ${stale.join(', ')}`);
});

test('every ffmpeg spawn tells ffmpeg not to read stdin (-nostdin first)', () => {
    const bad = FF_SITES.filter(s => !/^\[\s*['"]-nostdin['"]/.test(s.argv))
        .map(s => `${s.rel}:${s.line} ${s.fn}(${s.bin}, ${s.argv.slice(0, 40)}…)`);
    assert.deepStrictEqual(bad, [], `${bad.length}/${FF_SITES.length} ffmpeg spawns without -nostdin:\n${bad.join('\n')}`);
});

test('every ffmpeg spawn gives it no stdin to read (stdio stdin is ignore)', () => {
    // One exception, by rule rather than by name: a site that hands ffmpeg its
    // INPUT through stdin (`input:` beside `-i pipe:0`). Node writes that finite
    // buffer and closes the pipe, so there is still nothing left to wait on.
    const feeds = s => /\binput\s*:/.test(s.opts) && /['"]pipe:0['"]/.test(s.argv);
    const bad = FF_SITES.filter(s => !feeds(s) && !/stdio\s*:\s*(\[\s*)?['"]ignore['"]/.test(s.opts))
        .map(s => `${s.rel}:${s.line} ${s.fn}(${s.bin}, …, ${s.opts.slice(0, 50) || '<no options>'})`);
    assert.deepStrictEqual(bad, [], `${bad.length}/${FF_SITES.length} ffmpeg spawns with stdin attached:\n${bad.join('\n')}`);
});
