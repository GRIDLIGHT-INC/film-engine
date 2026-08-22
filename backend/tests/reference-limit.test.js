/**
 * The reference ceiling belongs to the provider.
 *
 * `MAX_REFERENCES = 3` was a single constant applied to every provider, and it
 * is RUNWAY's documented limit for gen4_image. Meshy accepts five and OpenAI's
 * edits endpoint accepts many more — so a shot naming a character, a second
 * character, a location, a car and a bag silently dropped the last two,
 * whichever provider was about to run.
 *
 * That is exactly what happened on Wingfall 2B: DRAGON, MAYA and SUBURBAN
 * STREET took the three slots, and the SEDAN's plate and the grocery bag's
 * plate were discarded before the request was built. The car came back a modern
 * saloon and the bag came back generic — not because conditioning failed, but
 * because their pictures were never sent.
 *
 * Same defect the prompt ceiling already had, one level over: "the strictest of
 * the providers wired here" hardcoded as though it were a fact about the world.
 *
 * Set-based over every adapter serving `image`, because a limit declared on
 * three of four leaves the fourth silently on the strict default and nothing
 * says so.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const os = require('os');

/*
 * Real files on disk: selectReferences INLINES each plate as a data URI,
 * because no provider can read our disk — so a fixture with an invented path
 * silently yields nothing and every assertion about counts passes vacuously.
 */
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'reflimit-'));
function plate(name, kind) {
    const f = path.join(FIXTURE_DIR, `${name}.png`);
    fs.writeFileSync(f, PNG);
    return { name, kind, file_path: f };
}

/** Every adapter that serves the image capability. */
const IMAGE_ADAPTERS = (() => {
    const dir = path.join(__dirname, '..', 'lib', 'providers');
    const out = [];
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.js') || ['index.js', 'base.js', 'credentials.js', 'oauth.js'].includes(f)) continue;
        let mod;
        try { mod = require(path.join(dir, f)); } catch (_) { continue; }
        const caps = mod.capabilities || (mod.adapter && mod.adapter.capabilities) || [];
        const serves = Array.isArray(caps) ? caps.includes('image') : !!(caps && caps.image);
        if (serves || /image/i.test(f)) out.push({ file: f, mod });
    }
    return out;
})();

test('the adapter set is derived and covers the real providers', () => {
    const names = IMAGE_ADAPTERS.map(a => a.file).sort();
    assert.ok(names.length >= 3, `expected several image adapters, found: ${names.join(', ')}`);
    for (const expected of ['meshy.js', 'runway.js', 'openai-image.js']) {
        assert.ok(names.includes(expected), `${expected} is not in the image adapter set`);
    }
});

test('every image adapter declares its own reference ceiling', () => {
    // Silence means "the strict default", which is correct only if it was
    // chosen. An adapter that simply never said is indistinguishable from one
    // held deliberately low.
    const undeclared = [];
    for (const { file, mod } of IMAGE_ADAPTERS) {
        const a = mod.adapter || mod;
        const n = a.maxReferenceImages;
        if (!Number.isFinite(n) || n < 1) undeclared.push(file);
    }
    assert.deepStrictEqual(undeclared, [],
        'these serve image and never say how many references they take, so every shot on them '
        + `is capped at the strictest provider's limit: ${undeclared.join(', ')}`);
});

test('a declared ceiling is reachable — nothing clamps it back to three', () => {
    // The gatherer took `Math.min(opts.limit || MAX_REFERENCES, MAX_REFERENCES)`,
    // so a caller passing a higher limit got three anyway. A ceiling that
    // cannot be raised is not a ceiling, it is a constant with extra steps.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'reference-images.js'), 'utf8');
    assert.ok(!/Math\.min\(opts\.limit \|\| MAX_REFERENCES, MAX_REFERENCES\)/.test(src),
        'selectReferences still clamps every caller back to the default');

    const { selectReferences } = require('../lib/reference-images');
    const many = ['character', 'character', 'location', 'prop', 'prop']
        .map((kind, i) => plate(`S${i}`, kind));
    const got = selectReferences(many, { limit: 5, tagged: false });
    assert.strictEqual(got.length, 5,
        `asked for 5 references and got ${got.length} — the provider's ceiling is not honoured`);
});

test('an undeclared provider still falls back strictly, never to unlimited', () => {
    const { selectReferences, MAX_REFERENCES } = require('../lib/reference-images');
    const many = Array.from({ length: 9 }, (_, i) => plate(`U${i}`, 'prop'));
    const got = selectReferences(many, { tagged: false });
    assert.strictEqual(got.length, MAX_REFERENCES,
        'with no stated limit the gatherer did not fall back to the strict default');
});

test('the gatherer is told the ceiling of the provider that will actually run', () => {
    // Same rule the prompt ceiling already follows. Deriving it anywhere else
    // means the number belongs to whoever wrote that line rather than to the
    // provider about to receive the request.
    const storyboard = fs.readFileSync(path.join(__dirname, '..', 'routes', 'storyboard.js'), 'utf8');
    assert.ok(/maxReferenceImages/.test(storyboard),
        'no generation path passes the provider\'s reference ceiling to the gatherer');

    const refs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'shot-references.js'), 'utf8');
    assert.ok(/maxReferenceImages|limit/.test(refs),
        'the shared gatherer cannot be told a limit, so every path is stuck on the default');
});

test('ranking still decides WHICH references survive a real squeeze', () => {
    // Raising the ceiling must not disturb the order: identity before place
    // before objects, because a viewer notices a different face long before a
    // different porch.
    const { selectReferences } = require('../lib/reference-images');
    const pool = [plate('BAG', 'prop'), plate('STREET', 'location'), plate('MAYA', 'character')];
    const got = selectReferences(pool, { limit: 2, tagged: false });
    assert.deepStrictEqual(got.map(r => r.name), ['MAYA', 'STREET'],
        'the squeeze dropped identity or place before an object');
});
