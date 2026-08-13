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
 * Known limit: this catches a DIRECT require of db/database or db/schema, which
 * is the form that has actually occurred. A file that pulls the database in
 * transitively (requiring a lib that requires it) is not detected statically —
 * the "leaves the real database untouched" case below is the empirical backstop.
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
