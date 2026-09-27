/**
 * One version, stated once, reported everywhere.
 *
 * `backend/package.json` is the source. Every other place a version is declared
 * — the app manifests, the lockfile, the iOS marketing version, the README
 * badge — must say the same, and the running servers must READ it rather than
 * carry a literal: a literal is how the health check said 0.1.0 while the
 * manifest said something else.
 *
 * Set-based over the declaration sites, and the sites are held to the repo: any
 * top-level manifest that carries a "version" and is not in the list fails.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const VERSION = require('../package.json').version;

/** Every place a version is declared, and how to read it there. */
const SITES = {
    'backend/package.json': s => JSON.parse(s).version,
    'backend/package-lock.json': s => { const j = JSON.parse(s); return [j.version, j.packages[''].version]; },
    'gridlight.json': s => JSON.parse(s).version,
    'src/app.json': s => JSON.parse(s).version,
    'ios/FilmEngine.xcodeproj/project.pbxproj': s => [...s.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(m => m[1]),
    'README.md': s => [...s.matchAll(/badge\/version-([0-9][0-9A-Za-z.-]*?)-/g)].map(m => m[1]),
};

test('the version is a plain semantic version', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

for (const [file, readVersion] of Object.entries(SITES)) {
    test(`${file} declares ${VERSION}`, () => {
        const found = [].concat(readVersion(read(file)));
        assert.ok(found.length, `${file} declares no version at all`);
        for (const v of found) assert.strictEqual(v, VERSION, `${file} says ${v}`);
    });
}

test('the servers report the package version, never a literal', () => {
    for (const f of ['backend/server.js', 'backend/mcp-server.js', 'backend/lib/mcp-build.js']) {
        const src = read(f);
        assert.ok(!/version:\s*'\d+\.\d+\.\d+'/.test(src), `${f} carries a literal version`);
        assert.ok(!/\|\|\s*'\d+\.\d+\.\d+'/.test(src), `${f} falls back to a literal version`);
    }
    assert.match(read('backend/server.js'), /require\('\.\/package\.json'\)\.version/);
    assert.match(read('backend/mcp-server.js'), /require\('\.\/package\.json'\)\.version/);
});

test('no manifest declares a version the list does not know', () => {
    const tracked = execFileSync('git', ['ls-files', '*.json'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n').filter(f => f && !f.includes('node_modules') && !f.startsWith('backend/tests/')
            && !f.startsWith('docs/') && !f.startsWith('design_handoff') && !f.includes('.xcassets/'));
    const stray = tracked.filter(f => {
        if (SITES[f]) return false;
        try { return typeof JSON.parse(read(f)).version === 'string'; } catch (_) { return false; }
    });
    assert.deepStrictEqual(stray, [], `manifests carrying a version outside the list: ${stray.join(', ')}`);
});
