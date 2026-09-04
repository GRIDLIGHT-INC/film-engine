/**
 * Guard: no test file may open the developer's real database.
 *
 * db/database.js resolves its path at IMPORT time from FILM_DATA_DIR, falling
 * back to ~/.gridlight/film-engine/data. A test that requires it without
 * setting that variable first therefore opens whatever database happens to be
 * on the machine — and then passes or fails on ambient state rather than on the
 * code under test.
 *
 * That is not hypothetical. providers-openai-image.test.js did exactly this and
 * failed with "no such table: film_provider_credentials" on any machine where
 * the server had never been run, while passing anywhere it had. The failure was
 * carried for a while as "pre-existing", which is what an environment-dependent
 * test buys you: it stops being read as a bug.
 *
 * The check is set-based over every *.test.js rather than pinned to the one file
 * that broke, because the next test to require the database will reintroduce it.
 *
 * The ordering check below was not enough, and the gap cost a real database.
 * subject-gallery.test.js set FILM_DATA_DIR inside a before() hook and required
 * db/database on the next line — textually in the right order, so this guard
 * passed — while an EARLIER describe block had already required a lib that
 * pulls the database in transitively. The real database opened at that first
 * import, and the suite wrote 26 projects and 222 assets into the working film
 * library.
 *
 * Transitive requires cannot be resolved statically, so the rule is stronger
 * and simpler instead: a file that isolates must isolate BEFORE ITS FIRST
 * REQUIRE OF ANYTHING. You cannot know what a lib pulls in, so the only safe
 * moment is before the first one.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TESTS_DIR = __dirname;
const DB_REQUIRE = /require\(\s*['"]\.\.\/db\/(database|schema)['"]\s*\)/;
const ENV_SET = /process\.env\.FILM_DATA_DIR\s*=/;

function testFiles() {
    return fs.readdirSync(TESTS_DIR).filter(f => f.endsWith('.test.js')).sort();
}

test('the test directory is non-empty (guard is actually iterating something)', () => {
    assert.ok(testFiles().length > 0, 'no test files found — the scan below would vacuously pass');
});

test('every test file that requires the database isolates FILM_DATA_DIR first', () => {
    const offenders = [];

    for (const file of testFiles()) {
        const src = fs.readFileSync(path.join(TESTS_DIR, file), 'utf8');

        const dbMatch = src.match(DB_REQUIRE);
        if (!dbMatch) continue;

        const envMatch = src.match(ENV_SET);
        if (!envMatch) {
            offenders.push(`${file}: requires db/${dbMatch[1]} but never sets FILM_DATA_DIR`);
            continue;
        }
        // Ordering matters: db/database resolves its path when it is imported,
        // so setting the variable afterwards has no effect at all.
        if (envMatch.index > dbMatch.index) {
            offenders.push(`${file}: sets FILM_DATA_DIR after requiring db/${dbMatch[1]} — too late to take effect`);
        }
    }

    assert.deepStrictEqual(offenders, [], `test files that would open the real database:\n  ${offenders.join('\n  ')}`);
});

test('isolation is established before the first require of anything', () => {
    /*
     * Not merely before requiring db/database — before ANY require.
     *
     * A lib that reaches the database transitively opens it at that moment, and
     * no static check can enumerate which libs those are. Setting the variable
     * first costs nothing and closes the whole class; setting it later is safe
     * only by luck about somebody else's import graph.
     */
    const offenders = [];
    for (const file of testFiles()) {
        if (file === path.basename(__filename)) continue;
        const src = fs.readFileSync(path.join(TESTS_DIR, file), 'utf8');
        const env = src.search(ENV_SET);
        if (env === -1) continue;              // spawns a server, or needs no database

        /*
         * The first require of a LOCAL module — `./` or `../`.
         *
         * node:test, assert, fs, path and os cannot open a database, and
         * flagging the forty files that require them before isolating would
         * make this check cry wolf until somebody switched it off, taking the
         * one real case with it. A local module is the one that might pull the
         * database in transitively, and it is the only kind that matters here.
         *
         * Comments are stripped first, so the explanation of this very rule
         * does not count as a require.
         */
        const code = src.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
            .replace(/\/\/.*$/gm, m => ' '.repeat(m.length));
        /*
         * TOP-LEVEL local requires only.
         *
         * A require inside a function body does not run at import time, so it
         * cannot open anything before isolation is established —
         * decision-parity.test.js loads its contract lazily inside
         * loadContract(), and flagging that would be a false alarm on a file
         * that is correct. Anchored to a top-level `const … = require('../…')`,
         * which is how every one of these files actually imports, and which a
         * body-indented require cannot match.
         */
        const firstRequire = code.search(/^const\s[^\n]*?require\(\s*['"]\.\.?\//m);
        if (firstRequire === -1) continue;

        if (env > firstRequire) {
            const line = src.slice(0, env).split('\n').length;
            const reqLine = src.slice(0, firstRequire).split('\n').length;
            offenders.push(`${file}: sets FILM_DATA_DIR at line ${line}, after the first LOCAL require `
                + `at line ${reqLine} — a lib required in between may already have opened the real database`);
        }
    }
    assert.deepStrictEqual(offenders, [],
        `isolation set too late:\n  ${offenders.join('\n  ')}`);
});

test('no test file hard-codes the default data directory', () => {
    const offenders = [];
    for (const file of testFiles()) {
        if (file === path.basename(__filename)) continue;
        const src = fs.readFileSync(path.join(TESTS_DIR, file), 'utf8');
        if (/\.gridlight[\/\\]film-engine/.test(src)) {
            offenders.push(file);
        }
    }
    assert.deepStrictEqual(offenders, [], `test files pointing at the real data dir: ${offenders.join(', ')}`);
});

test('db/database still resolves its path at import time, so require order matters', () => {
    // The ordering check above is only meaningful because db/database.js reads
    // FILM_DATA_DIR once, at module scope. If that ever became a lazy lookup,
    // "sets FILM_DATA_DIR too late" would stop being a bug and this guard would
    // be enforcing a rule that no longer exists — so pin the mechanism itself
    // rather than trusting a comment about it.
    const src = fs.readFileSync(path.join(TESTS_DIR, '..', 'db', 'database.js'), 'utf8');

    const envRead = src.search(/process\.env\.FILM_DATA_DIR/);
    const dbOpen = src.search(/new Database\(/);

    assert.ok(envRead !== -1, 'db/database.js no longer reads FILM_DATA_DIR');
    assert.ok(dbOpen !== -1, 'db/database.js no longer opens a database at module scope');
    assert.ok(
        envRead < dbOpen,
        'db/database.js now opens its database before reading FILM_DATA_DIR — the isolation contract changed'
    );

    // And it must be bound to a module-scope constant, not read inside a
    // function: a per-call lookup would resolve after imports had run, making
    // require order irrelevant and this whole guard theatre. Checking only for
    // "not indented" is not enough — `function dataDir(){ return process.env...`
    // also starts at column 0, and passed an earlier version of this assertion.
    const line = src.split('\n').find(l => l.includes('process.env.FILM_DATA_DIR'));
    assert.match(
        line,
        /^const\s+\w+\s*=\s*process\.env\.FILM_DATA_DIR/,
        `FILM_DATA_DIR must be bound to a module-scope const; found: "${line.trim()}"`
    );
});


/**
 * No two test files may gamble on the same port range.
 *
 * `pipeline-scope` drew from 18400-18900, `consistency-routes` from 18100-18700
 * and `providers-elevenlabs` from 18100-18800 — three overlapping ranges, so
 * under the full suite's parallelism two servers periodically raced for one
 * port and the loser's client read ECONNRESET. That surfaced as FOUR product
 * failures in a scope gate which passes perfectly in isolation: the most
 * expensive kind of flake, because it accuses working code.
 *
 * Derived from the source rather than a list, so a file added later is in the
 * denominator with nothing to remember.
 */
test('no two test files can draw the same port', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = __dirname;
    const ranges = [];
    for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.test.js'))) {
        const src = fs.readFileSync(path.join(dir, name), 'utf8');
        for (const m of src.matchAll(/(\d{4,5}) \+ Math\.floor\(Math\.random\(\) \* (\d+)\)/g)) {
            ranges.push({ name, lo: Number(m[1]), hi: Number(m[1]) + Number(m[2]) - 1 });
        }
    }
    assert.ok(ranges.length >= 5,
        `the port scan found ${ranges.length} ranges — it is broken, not the suite`);

    const clashes = [];
    for (let i = 0; i < ranges.length; i++) {
        for (let j = i + 1; j < ranges.length; j++) {
            const a = ranges[i], b = ranges[j];
            if (a.name === b.name) continue;
            if (a.lo <= b.hi && b.lo <= a.hi) {
                clashes.push(`${a.name} [${a.lo}-${a.hi}] overlaps ${b.name} [${b.lo}-${b.hi}]`);
            }
        }
    }
    assert.deepStrictEqual(clashes, [], `overlapping port ranges:\n  ${clashes.join('\n  ')}`);
});
