/**
 * Everything that spawns the encoder must read the field the resolver returns.
 *
 * `resolveFfmpeg()` answers `{ available, bin, source }`. Two call sites read
 * `bin.path` — which is `undefined`, so `execFileSync(undefined, …)` throws and
 * the feature fails at the moment it is used: the character orbit's frame
 * cutting, and the `shot_review` tool that hands an agent the frames to compare.
 *
 * Both were written from memory of a different shape, and both look correct.
 * That is the argument for deriving the set: a consumer added next month reads
 * whatever its author guessed, and nothing says otherwise until someone runs it.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * Every field resolveFfmpeg can return, read from its SOURCE.
 *
 * Calling it once only samples the branch this machine happens to take: on an
 * install with an encoder you never see `reason`, which the unavailable branch
 * sets — so a consumer reading it would be reported as broken.
 */
function resolverFields() {
    // Every `return { available: … }` in the module. resolveFfmpeg() is a
    // caching wrapper whose own body contains no object literal, and calling it
    // once only samples the branch this machine takes — on a box with an
    // encoder you never see `reason`, which the unavailable branch sets.
    const src = fs.readFileSync(path.join(ROOT, 'lib/ffmpeg.js'), 'utf8');
    const fields = new Set();
    for (const m of src.matchAll(/return\s*\{([^}]*available[^}]*)\}/g)) {
        for (const k of m[1].matchAll(/(\w+)\s*:/g)) fields.add(k[1]);
    }
    return [...fields];
}

/** Every file that calls resolveFfmpeg, and the `<name>.<field>` reads near it. */
function consumers() {
    const out = [];
    const walk = dir => {
        for (const name of fs.readdirSync(dir)) {
            if (name === 'node_modules' || name === 'tests' || name === '.git') continue;
            const p = path.join(dir, name);
            const st = fs.statSync(p);
            if (st.isDirectory()) { walk(p); continue; }
            if (!name.endsWith('.js')) continue;
            const src = fs.readFileSync(p, 'utf8');
            if (!/resolveFfmpeg\s*\(/.test(src)) continue;
            out.push({ file: path.relative(ROOT, p), src });
        }
    };
    walk(ROOT);
    return out;
}

test('the resolver reports a binary under a name, and consumers exist', () => {
    const fields = resolverFields();
    assert.ok(fields.includes('bin'), `resolveFfmpeg no longer returns "bin": ${fields.join(', ')}`);
    assert.ok(fields.includes('available'), 'resolveFfmpeg no longer reports availability');
    assert.ok(consumers().length >= 4, 'the encoder is barely used — has the resolver moved?');
});

test('no consumer reads a field the resolver does not return', () => {
    const fields = new Set(resolverFields());
    const bad = [];
    for (const { file, src } of consumers()) {
        // The variable a consumer assigns the resolver's answer to.
        for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*resolveFfmpeg\s*\(/g)) {
            const name = m[1];
            for (const use of src.matchAll(new RegExp(`\\b${name}\\.(\\w+)`, 'g'))) {
                if (!fields.has(use[1])) bad.push(`${file}: ${name}.${use[1]}`);
            }
        }
    }
    assert.deepStrictEqual([...new Set(bad)], [],
        'these read a property the resolver never sets, so the spawn throws when it runs: '
        + [...new Set(bad)].join(' | '));
});

test('the encoder actually spawns from what the resolver hands back', (t) => {
    // Behavioural: the field is not merely present, it names a runnable binary.
    const { resolveFfmpeg } = require('../lib/ffmpeg');
    const r = resolveFfmpeg();
    // An install with no encoder is legitimate — but a bare `return` REPORTS
    // PASS, so this would claim to prove the binary runs while proving nothing.
    // Skipped visibly instead, so the suite total cannot hide a check that
    // never executed.
    if (!r.available) return t.skip('no encoder on this install, so nothing here was verified');
    const out = require('child_process').execFileSync(r.bin, ['-hide_banner', '-version'],
        { encoding: 'utf8', timeout: 15000 });
    assert.match(out, /ffmpeg version/i, 'the resolver pointed at something that is not ffmpeg');
});
