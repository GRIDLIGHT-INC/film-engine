/**
 * Unit tests for the provider adapter layer (lib/providers/*).
 * Pure — no server, no DB.
 */
/*
 * Isolated, and the gateway pinned OFF.
 *
 * localGatewayEnabled() reads film_app_settings, so once the switch existed
 * this file — which sets no FILM_DATA_DIR — began resolving against whatever
 * the real database happened to say. A unit test whose answer depends on the
 * developer's own settings is one that passes on their machine and fails in
 * CI, which is the failure test-isolation.test.js exists to prevent.
 */
const os = require('os');
const path = require('path');
process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-providers-' + Date.now());
process.env.GRIDLIGHT_ENABLED = '0';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const providers = require('../lib/providers');
const { CAPABILITIES, DEFAULT_PROVIDER } = require('../lib/providers/base');
const { gridlightAdapter, endpointFor, ENDPOINTS } = require('../lib/providers/gridlight-adapter');

describe('providers/base', () => {
    it('exposes the capability list and gridlight default', () => {
        assert.ok(CAPABILITIES.includes('image'));
        assert.ok(CAPABILITIES.includes('llm'));
        assert.ok(CAPABILITIES.includes('video'));
        assert.ok(CAPABILITIES.includes('voice'));
        assert.equal(DEFAULT_PROVIDER, 'gridlight');
    });
});

describe('providers/gridlight-adapter', () => {
    it('maps capabilities to the historical endpoint paths', () => {
        assert.equal(endpointFor('image'), '/image');
        assert.equal(endpointFor('llm'), '/chat/intelligent');
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
        assert.equal(gridlightAdapter.supports('llm'), true);
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
    it('falls back to gridlight only when nothing credentialed can serve the capability', () => {
        // This used to assert gridlight for ALL eleven, which pinned the bug it
        // was meant to document: an unconfigured project pointed every
        // capability at a local service even when a credentialed hosted adapter
        // was registered beside it. PREFERRED_WHEN_CONFIGURED exists for
        // exactly that and was an empty object, so it had never fired.
        //
        // The fallback is still correct where there is genuinely nothing else,
        // which is what this now asserts — derived from the registry rather
        // than from a list, so adding an adapter cannot silently invalidate it.
        for (const cap of CAPABILITIES) {
            const alternative = providers.list().some(a =>
                a.id !== 'gridlight' && a.supports && a.supports(cap) && providers.isProviderConfigured(a.id));

            const resolved = providers.resolveId(cap, {});
            if (alternative) {
                assert.notEqual(resolved, 'gridlight',
                    `${cap} fell to gridlight despite a credentialed alternative`);
            } else {
                /*
                 * The local gateway is OFF unless switched on, so with no
                 * credentialed alternative the honest answer is NOTHING — not
                 * a fallback to a service that may not be running. That was the
                 * old behaviour and its only symptom was a connection refused
                 * at generation time, per capability, after the work had been
                 * committed to.
                 */
                assert.strictEqual(resolved, null,
                    `${cap} has no credentialed provider and the gateway is off, so it must `
                    + `report nothing rather than "${resolved}"`);
            }
        }
    });

    it('honors a per-project provider choice for a registered provider', () => {
        // Register a throwaway adapter so the test doesn't depend on which
        // optional providers (openai/elevenlabs/…) happen to be present.
        providers.register({ id: '__test_img__', kind: 'generator', capabilities: ['image'], supports: (c) => c === 'image' });
        assert.equal(providers.resolveId('image', { image: '__test_img__' }), '__test_img__');
        assert.equal(providers.resolve('image', { image: '__test_img__' }).id, '__test_img__');
    });

    it('refuses in words for an unknown configured provider', () => {
        /*
         * This used to fall to the local gateway. With the gateway off that
         * would be a swap onto a service nobody enabled, so resolution hands
         * back a refusing adapter instead: still an object with generate(), so
         * the thirty-one call sites do not crash, but it answers with what is
         * missing rather than failing at a socket.
         */
        const a = providers.resolve('image', { image: 'does-not-exist' });
        assert.ok(a && typeof a.generate === 'function', 'resolution returned nothing to call');
        assert.ok(a.unavailable, `swapped to "${a.id}" rather than refusing`);
    });

    it('unknown capability refuses rather than inventing a provider', () => {
        const a = providers.resolve('teleport', {});
        assert.ok(a && typeof a.generate === 'function');
        assert.ok(a.unavailable, `swapped to "${a.id}"`);
    });

    it('registry exposes gridlight via get()/list()', () => {
        assert.equal(providers.get('gridlight').id, 'gridlight');
        assert.ok(providers.list().some(a => a.id === 'gridlight'));
    });
});
