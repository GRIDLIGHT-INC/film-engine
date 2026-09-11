const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.GRIDLIGHT_ENABLED = '0';

const providers = require('../lib/providers');
const { CAPABILITIES, isCapability } = require('../lib/providers/base');
const BACKEND = path.join(__dirname, '..');

test('every advertised capability has at least one registered adapter', () => {
    const uncovered = CAPABILITIES.filter(capability =>
        !providers.list().some(adapter => adapter.supports && adapter.supports(capability)));
    assert.deepStrictEqual(uncovered, [],
        `capabilities with no provider adapter: ${uncovered.join(', ')}`);
});

test('stock is not accepted as a capability when no licensed catalog ships', () => {
    assert.strictEqual(isCapability('stock'), false);
    const adapter = providers.resolve('stock', {});
    assert.ok(adapter && adapter.unavailable, 'an unsupported stock request did not refuse');
});

/**
 * Every runtime file, DERIVED: a hand-typed list of two files is only as
 * complete as the afternoon it was written, and the page carried two more
 * copies (a capability label, a canvas colour) that the list never saw.
 */
function runtimeFiles() {
    const out = [];
    for (const dir of ['lib', 'routes']) {
        const walk = d => {
            for (const f of fs.readdirSync(d)) {
                const p = path.join(d, f);
                if (fs.statSync(p).isDirectory()) walk(p);
                else if (f.endsWith('.js')) out.push(p);
            }
        };
        walk(path.join(BACKEND, dir));
    }
    for (const f of fs.readdirSync(BACKEND)) if (f.endsWith('.js')) out.push(path.join(BACKEND, f));
    out.push(path.join(BACKEND, '..', 'src', 'index.html'));
    return out;
}

test('no runtime file, and not the page, still names the removed capability', () => {
    const files = runtimeFiles();
    assert.ok(files.length > 100, `the runtime scan found only ${files.length} files`);
    // A string literal or an object key — never prose: "a stock asset render"
    // in a comment is English, `stock: 'Stock'` is a registry copy.
    const literal = /['"]stock['"]|\bstock\s*:\s*['"#]/;
    const offenders = files.filter(file => literal.test(fs.readFileSync(file, 'utf8')));
    assert.deepStrictEqual(offenders.map(f => path.relative(path.join(BACKEND, '..'), f)), [],
        'the removed capability is still named as a literal in runtime code or on the page');
});

test('rights provenance remains independent of provider capabilities', () => {
    const migration = fs.readFileSync(path.join(BACKEND, 'db', 'migrations', '044_provider_layer.sql'), 'utf8');
    assert.match(migration, /license_source/);
    assert.match(migration, /licensed_catalog/);
    assert.ok(!/stock/i.test(migration), 'rights provenance is still coupled to the removed capability');
});
