/**
 * CLAUDE.md must describe the tree that exists, not the one it used to.
 *
 * CLAUDE.md is the file agents and new contributors read first: it carries the
 * architecture tree, the module inventory, the migration count and the list of
 * test commands. When it drifts, it does not merely go stale — it actively
 * misleads, because everything in it still reads as authoritative. At the time
 * this guard was written it claimed 39 migrations against 51 on disk, and was
 * missing 10 lib modules, 7 route modules and 28 test files.
 *
 * The check iterates the real directories rather than sampling names, because
 * drift arrives one forgotten file at a time and an example-based check ("is
 * pipeline-engine.js mentioned?") passes throughout.
 *
 * Deliberately loose about HOW something is documented: a filename appearing
 * anywhere in CLAUDE.md counts. The goal is that nothing is invisible, not that
 * prose follows a template.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md');
const BACKEND = path.join(__dirname, '..');

const doc = () => fs.readFileSync(CLAUDE_MD, 'utf8');
const jsFiles = dir => fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort();

test('CLAUDE.md exists and is substantial', () => {
    assert.ok(fs.existsSync(CLAUDE_MD), 'CLAUDE.md is missing');
    assert.ok(doc().length > 1000, 'CLAUDE.md is suspiciously short');
});

test('every backend/lib module is mentioned in CLAUDE.md', () => {
    const md = doc();
    const missing = jsFiles(path.join(BACKEND, 'lib')).filter(f => !md.includes(f));
    assert.deepStrictEqual(missing, [], `lib modules absent from CLAUDE.md: ${missing.join(', ')}`);
});

test('every backend/routes module is mentioned in CLAUDE.md', () => {
    const md = doc();
    const missing = jsFiles(path.join(BACKEND, 'routes')).filter(f => !md.includes(f));
    assert.deepStrictEqual(missing, [], `route modules absent from CLAUDE.md: ${missing.join(', ')}`);
});

test('every test file is mentioned in CLAUDE.md', () => {
    const md = doc();
    const missing = fs.readdirSync(path.join(BACKEND, 'tests'))
        .filter(f => f.endsWith('.test.js')).sort()
        .filter(f => !md.includes(f));
    assert.deepStrictEqual(missing, [], `test files absent from CLAUDE.md: ${missing.join(', ')}`);
});

test('the migration count in CLAUDE.md matches the migrations on disk', () => {
    const actual = fs.readdirSync(path.join(BACKEND, 'db', 'migrations')).filter(f => f.endsWith('.sql')).length;
    const md = doc();

    // Every "N migrations" claim in the document must agree with reality; the
    // count appears in more than one place and they have disagreed before.
    const claims = [...md.matchAll(/\((\d+)\s+migrations\)|\((\d+)\s+migrations\b|\b(\d+)\s+migrations\b/g)]
        .map(m => parseInt(m[1] || m[2] || m[3], 10))
        .filter(n => !Number.isNaN(n));

    assert.ok(claims.length > 0, 'CLAUDE.md no longer states a migration count');
    const wrong = claims.filter(n => n !== actual);
    assert.deepStrictEqual(wrong, [], `CLAUDE.md claims ${wrong.join('/')} migrations; ${actual} exist on disk`);
});

test('no lib module referenced by CLAUDE.md has been deleted', () => {
    // Drift runs both ways: a doc naming files that no longer exist sends
    // readers looking for code that was removed.
    const md = doc();
    // Dots are part of the name: without them "nle-export.test.js" is read as
    // the non-existent file "test.js". The lookbehind drops the same phantom
    // arising from glob patterns like `backend/tests/*.test.js`, which the
    // Testing section legitimately documents as a command to run.
    const referenced = [...md.matchAll(/(?<![*\w.-])([a-zA-Z0-9_][a-zA-Z0-9_.-]*\.js)\b/g)].map(m => m[1]);
    const known = new Set([
        ...jsFiles(path.join(BACKEND, 'lib')),
        ...jsFiles(path.join(BACKEND, 'routes')),
        ...fs.readdirSync(path.join(BACKEND, 'tests')).filter(f => f.endsWith('.js')),
        ...jsFiles(path.join(BACKEND, 'db')),
        ...jsFiles(path.join(BACKEND, 'lib', 'providers')),
        ...jsFiles(path.join(BACKEND, 'lib', 'node-handlers')),
        ...jsFiles(path.join(BACKEND, 'lib', 'daw')),
        // The backend root is scanned rather than listed: it held only
        // server.js when this guard was written, and hardcoding that name meant
        // the next root-level entry point (mcp-server.js) failed the check for
        // existing rather than for being undocumented.
        ...jsFiles(BACKEND),
        // Built front-end modules the page imports (ADR-008's splat viewer).
        ...jsFiles(path.join(BACKEND, '..', 'src', 'vendor')),
        'index.html', 'app.json',
        // Libraries whose NAME ends in .js. The pattern above cannot tell
        // "Three.js" the project from "three.js" the file, and prose that
        // weighs up a dependency has to be able to name it. Extend only for a
        // library's actual name, never to excuse a missing file.
        'Three.js', 'Node.js', 'Next.js', 'Vue.js', 'D3.js',
    ]);

    const dangling = [...new Set(referenced)].filter(f => !known.has(f));
    assert.deepStrictEqual(dangling, [], `CLAUDE.md references files that do not exist: ${dangling.join(', ')}`);
});
