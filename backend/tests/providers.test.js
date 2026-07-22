/**
 * Unit tests for the provider adapter layer (lib/providers/*).
 * Pure — no server, no DB.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../lib/providers');
const { CAPABILITIES, DEFAULT_PROVIDER } = require('../lib/providers/base');
const { gridlightAdapter, endpointFor, ENDPOINTS } = require('../lib/providers/gridlight-adapter');

describe('providers/base', () => {
    it('exposes the capability list and gridlight default', () => {
        assert.ok(CAPABILITIES.includes('image'));
        assert.ok(CAPABILITIES.includes('video'));
        assert.ok(CAPABILITIES.includes('voice'));
        assert.equal(DEFAULT_PROVIDER, 'gridlight');
    });
});

describe('providers/gridlight-adapter', () => {
    it('maps capabilities to the historical endpoint paths', () => {
        assert.equal(endpointFor('image'), '/image');
        assert.equal(endpointFor('video'), '/video');
        assert.equal(endpointFor('music'), '/music');
        assert.equal(endpointFor('sfx'), '/music');
        assert.equal(endpointFor('ambient'), '/music');
        assert.equal(endpointFor('voice'), '/voice');
        assert.equal(endpointFor('lipsync'), '/lipsync');
        assert.equal(endpointFor('post'), '/postprocess');
        assert.equal(endpointFor('model3d'), '/3d/generate');
        assert.equal(endpointFor('nope'), null);
    });

    it('supports() reflects the endpoint map', () => {
        assert.equal(gridlightAdapter.supports('image'), true);
        assert.equal(gridlightAdapter.supports('stock'), false);
    });

    it('is a generator that needs no per-provider key', () => {
        assert.equal(gridlightAdapter.kind, 'generator');
        assert.equal(gridlightAdapter.requiresKey, false);
        assert.deepEqual(Object.keys(ENDPOINTS).sort(), gridlightAdapter.capabilities.slice().sort());
    });

    it('generate() rejects an unsupported capability without calling out', async () => {
        const r = await gridlightAdapter.generate('stock', {});
        assert.equal(r.ok, false);
        assert.match(r.error, /unsupported capability/);
    });
});

describe('providers/registry resolve', () => {
    it('defaults every capability to gridlight when unconfigured', () => {
        for (const cap of CAPABILITIES) {
            assert.equal(providers.resolveId(cap, {}), 'gridlight');
            assert.equal(providers.resolve(cap, {}).id, 'gridlight');
        }
    });

    it('honors a per-project provider choice for a registered provider', () => {
        // Register a throwaway adapter so the test doesn't depend on which
        // optional providers (openai/elevenlabs/…) happen to be present.
        providers.register({ id: '__test_img__', kind: 'generator', capabilities: ['image'], supports: (c) => c === 'image' });
        assert.equal(providers.resolveId('image', { image: '__test_img__' }), '__test_img__');
        assert.equal(providers.resolve('image', { image: '__test_img__' }).id, '__test_img__');
    });

    it('falls back to gridlight for an unknown configured provider', () => {
        assert.equal(providers.resolve('image', { image: 'does-not-exist' }).id, 'gridlight');
    });

    it('unknown capability still returns the default adapter', () => {
        assert.equal(providers.resolve('teleport', {}).id, 'gridlight');
    });

    it('registry exposes gridlight via get()/list()', () => {
        assert.equal(providers.get('gridlight').id, 'gridlight');
        assert.ok(providers.list().some(a => a.id === 'gridlight'));
    });
});
