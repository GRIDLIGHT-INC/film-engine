/**
 * THE LOCAL GATEWAY IS OFF UNTIL SOMEBODY TURNS IT ON.
 *
 * "Re-add the gridlight endpoints, but we have to turn them on in the settings
 *  for us to be able to use them."
 *
 * Gridlight declares `requiresKey: false`, so isProviderConfigured() has always
 * answered TRUE for it whether or not anything is listening on the port. It is
 * also DEFAULT_PROVIDER — the floor every resolution falls to — which means a
 * capability with no hosted adapter resolves to a service that may not be
 * running, and the only symptom is a connection refused at generation time,
 * per capability, after the director has committed to the work.
 *
 * Set-based over the TEN capabilities it declares, in BOTH states, because the
 * failure would be partial: making `lipsync` respect the switch while `post`
 * still falls through leaves one dead endpoint behind and every example-based
 * test passes.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-gridlight-' + crypto.randomUUID().slice(0, 8));

require('../db/schema').ensureSchema();
const providers = require('../lib/providers');

const GRIDLIGHT = providers.get('gridlight');
const CAPS = (GRIDLIGHT.capabilities || []).slice();

/*
 * A temp database has no credentials, so without this every hosted provider is
 * unconfigured and EVERYTHING resolves to null — which would make "it does not
 * resolve to gridlight" pass for the wrong reason. Seeding them is what makes
 * the fallthrough meaningful.
 */
(function seedCredentials() {
    const { db } = require('../db/database');
    for (const a of providers.list()) {
        if (!a.requiresKey) continue;
        db.prepare(`INSERT INTO film_provider_credentials (provider, api_key, meta) VALUES (?, 'test-key', '{}')
                    ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key`).run(a.id);
    }
})();

/** Flip the switch the way the settings route does. */
function setEnabled(on) {
    const { db } = require('../db/database');
    db.prepare(`INSERT INTO film_app_settings (key, value) VALUES ('gridlight_enabled', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(on ? '1' : '');
    if (providers.refreshLocalGateway) providers.refreshLocalGateway();
}

test('the gateway declares the capabilities this test is about', () => {
    assert.ok(CAPS.length >= 10,
        `gridlight declares ${CAPS.length} capabilities; this set was written against 10`);
});

test('OFF by default: nothing resolves to a local service nobody enabled', () => {
    /*
     * The default matters more than the switch. A feature that is on until you
     * find the setting is one every existing project is already using without
     * having chosen to — and here "using" means pointing real generation at a
     * port that is probably closed.
     */
    setEnabled(false);
    const leaked = [];
    for (const cap of CAPS) {
        const id = providers.resolveId(cap, {});
        if (id === 'gridlight') leaked.push(`${cap} still resolves to the disabled gateway`);
    }
    assert.deepStrictEqual(leaked, [], leaked.join('; '));
});

test('OFF: a capability with no other provider says so rather than pretending', () => {
    /*
     * lipsync and post have no hosted adapter at all. With the gateway off the
     * honest answer is "nothing serves this", NOT a silent fallback — an
     * unavailable capability that reports a provider is how a run gets started
     * and dies at the last step.
     */
    setEnabled(false);
    for (const cap of CAPS) {
        const others = providers.list().filter(a =>
            a.id !== 'gridlight' && (a.capabilities || []).includes(cap));
        const id = providers.resolveId(cap, {});
        if (!others.length) {
            assert.strictEqual(id, null,
                `${cap} has no provider but resolves to "${id}" — a run would start and fail at that step`);
        } else {
            assert.ok(id && id !== 'gridlight',
                `${cap} has hosted providers but resolved to "${id}"`);
        }
    }
});

test('OFF: an explicit per-project choice of the gateway is still refused', () => {
    // Otherwise the switch is advisory: a project pinned to gridlight before it
    // was turned off would keep using it, which is the state the switch exists
    // to end.
    setEnabled(false);
    for (const cap of CAPS) {
        const id = providers.resolveId(cap, { [cap]: 'gridlight' });
        assert.notStrictEqual(id, 'gridlight',
            `${cap} pinned to the gateway still resolves to it while it is switched off`);
    }
});

test('ON: every capability it declares is reachable again', () => {
    setEnabled(true);
    const unreachable = [];
    for (const cap of CAPS) {
        // Images follow the house standard (lib/image-standard.js): Nano Banana
        // Pro, which the gateway does not sell, so a pin to it is overruled.
        if (cap === 'image') continue;
        const id = providers.resolveId(cap, { [cap]: 'gridlight' });
        if (id !== 'gridlight') unreachable.push(`${cap} -> ${id}`);
    }
    assert.deepStrictEqual(unreachable, [],
        `switched on and still not selectable: ${unreachable.join(', ')}`);
    setEnabled(false);
});

test('the switch is a real setting, described, and defaults to off', () => {
    const { SETTINGS } = require('../routes/app-settings');
    assert.ok(SETTINGS && SETTINGS.gridlight_enabled,
        'the gateway switch is not in the settings allow-list, so a PUT would drop it');
    assert.strictEqual(SETTINGS.gridlight_enabled.default, '',
        'the local gateway defaults to ON, so every existing project starts pointed at a port '
        + 'that is probably closed');
    assert.ok((SETTINGS.gridlight_enabled.description || '').length > 40,
        'the switch does not say what it does');
});

test('the provider catalogue reports the gateway as needing to be enabled', () => {
    /*
     * requiresKey: false made it read as "no key needed — ready", which is the
     * opposite of the truth once it is off. Whatever the panel shows has to
     * distinguish "nothing to configure" from "switched off".
     */
    setEnabled(false);
    assert.strictEqual(providers.isProviderConfigured('gridlight'), false,
        'a disabled gateway still reports itself configured, so every readiness check lies');
    setEnabled(true);
    assert.strictEqual(providers.isProviderConfigured('gridlight'), true,
        'an enabled gateway reports itself unavailable');
    setEnabled(false);
});
