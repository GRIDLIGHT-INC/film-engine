/**
 * Every inline script on the page parses.
 *
 * A stray parenthesis in one renderer is a SyntaxError for its whole <script>
 * block, so every function in it is undefined and the page is blank. The
 * suite stayed green through exactly that (2026-10-01): each test extracts the
 * functions it checks, and nothing compiled the page as the browser does.
 * Blocks with attributes are included; only external, module and JSON blocks
 * are skipped.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

for (const rel of ['src/index.html', 'ios/FilmEngine/Web/index.html']) {
    test(`${rel}: every inline script compiles`, () => {
        const html = fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
        const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
            .filter(m => !/\bsrc=|type="module"|application\/json|text\/template/.test(m[1]));
        assert.ok(blocks.length >= 2, `found ${blocks.length} inline scripts, so the scan is broken`);
        const bad = [];
        blocks.forEach((m, i) => {
            try { new vm.Script(m[2], { filename: `${rel}#script${i + 1}` }); }
            catch (err) { bad.push(`script ${i + 1}: ${err.message}`); }
        });
        assert.deepEqual(bad, [], 'a syntax error blanks every function in its block');
    });
}
