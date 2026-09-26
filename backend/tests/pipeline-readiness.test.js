/**
 * Is the pipeline ready to take a screenplay to a finished shot?
 *
 * The acceptance this is judged against is a 30-second screenplay driven
 * through every stage. That fails today for a reason no error message states:
 * a NEW project is created with an empty provider_config, so every capability
 * falls through resolveId() to DEFAULT_PROVIDER — Gridlight — whether or not
 * Gridlight is running and whether or not a credentialed alternative is sitting
 * right there in the registry.
 *
 * providers/index.js already has the mechanism for this. PREFERRED_WHEN_CONFIGURED
 * is consulted on every resolve, is documented, and is an empty object, so it
 * has never once fired.
 *
 * Set-based over CAPABILITIES and over the adapter registry, because the
 * failure is per-capability: getting image and llm right while voice silently
 * points at a dead service is exactly the half-fix that reads as done and dies
 * on the day.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-ready-' + crypto.randomUUID().slice(0, 8));

const { ensureSchema } = require('../db/schema');
ensureSchema();

const { db } = require('../db/database');
const { CAPABILITIES, DEFAULT_PROVIDER } = require('../lib/providers/base');
const providers = require('../lib/providers');
const { PREFERRED_WHEN_CONFIGURED } = require('../lib/providers');
const { stages } = require('../lib/e2e-preflight');

// Credentials for every key-requiring adapter. Without these the resolve test
// below skips every capability and passes vacuously — which is precisely the
// shape of not-really-testing this standard exists to catch.
for (const adapter of providers.list()) {
    if (!adapter.requiresKey) continue;
    db.prepare(`INSERT INTO film_provider_credentials (provider, api_key, meta, updated_at)
                VALUES (?, ?, '{}', datetime('now'))
                ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key`)
        .run(adapter.id, 'test-key-' + adapter.id);
}

/** Adapters that serve a capability, are not the fallback, and need a key. */
function alternativesFor(capability) {
    return providers.list()
        .filter(a => a.id !== DEFAULT_PROVIDER)
        .filter(a => a.supports && a.supports(capability));
}

// ── The preference table must be real ───────────────────────────────────────

test('every capability with a hosted alternative names a preferred provider', () => {
    // Derived from the registry: whichever capabilities have a non-Gridlight
    // adapter must have a preference, or an unconfigured project silently
    // resolves them to a local service instead of the hosted one.
    const missing = CAPABILITIES
        .filter(c => alternativesFor(c).length > 0)
        .filter(c => !PREFERRED_WHEN_CONFIGURED[c]);

    assert.deepStrictEqual(missing, [],
        `capabilities that fall to '${DEFAULT_PROVIDER}' despite having a hosted adapter: ${missing.join(', ')}`);
});

test('every preferred provider exists and serves the capability it is named for', () => {
    const wrong = [];
    /*
     * A preference is an ORDERED LIST now, not one name: naming a single
     * provider that holds no key falls past every credentialed adapter beside
     * it and lands on the local gateway. The rule being checked is unchanged —
     * every provider named must exist and must serve the capability it is
     * named for — so the test walks the list rather than assuming one entry.
     */
    const preferredPairs = Object.entries(PREFERRED_WHEN_CONFIGURED)
        .flatMap(([capability, v]) => (Array.isArray(v) ? v : [v]).map(id => [capability, id]));
    for (const [capability, id] of preferredPairs) {
        if (!CAPABILITIES.includes(capability)) { wrong.push(`${capability} is not a capability`); continue; }
        const adapter = providers.get(id);
        if (!adapter) { wrong.push(`${capability} -> '${id}' is not registered`); continue; }
        if (!adapter.supports || !adapter.supports(capability)) wrong.push(`${capability} -> '${id}' does not serve it`);
        if (id === DEFAULT_PROVIDER) wrong.push(`${capability} -> naming the fallback as the preference is a no-op`);
    }
    assert.deepStrictEqual(wrong, [], wrong.join('; '));
});

test('a project with no configuration resolves to the credentialed provider', () => {
    // THE acceptance condition. A project created tomorrow has an empty
    // provider_config; every capability that can be served by a configured
    // hosted adapter must resolve to it with no setup at all.
    const wrong = [];
    const checked = [];
    for (const capability of CAPABILITIES) {
        const configured = alternativesFor(capability).filter(a => providers.isProviderConfigured(a.id));
        if (!configured.length) continue;                 // nothing to prefer
        checked.push(capability);

        const resolved = providers.resolveId(capability, {});
        if (resolved === DEFAULT_PROVIDER) {
            wrong.push(`${capability}: fell to '${DEFAULT_PROVIDER}' with ${configured.map(a => a.id).join('/')} available`);
        }
    }
    assert.ok(checked.length >= 5,
        `only ${checked.length} capabilities had a credentialed alternative — this test is passing vacuously`);
    assert.deepStrictEqual(wrong, [], wrong.join('; '));
});

test('an explicit project choice still wins over the preference', () => {
    /*
     * The preference is a default, not a policy. Choosing Gridlight back has to
     * keep working or the setting is a lie — but only once the gateway is
     * SWITCHED ON: a pin to a local service nobody enabled points at something
     * that certainly cannot run, and honouring it would make the switch
     * advisory for exactly the projects that had chosen it.
     */
    const { db } = require('../db/database');
    db.prepare(`INSERT INTO film_app_settings (key, value) VALUES ('gridlight_enabled', '1')
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    providers.refreshLocalGateway();

    for (const capability of Object.keys(PREFERRED_WHEN_CONFIGURED)) {
        // Images are the one policy, not a preference: the house standard
        // (lib/image-standard.js) overrules a pin to a vendor without Nano Banana Pro.
        if (capability === 'image') continue;
        assert.strictEqual(providers.resolveId(capability, { [capability]: DEFAULT_PROVIDER }), DEFAULT_PROVIDER,
            `${capability}: an explicit choice was overridden by the preference`);
    }

    db.prepare("UPDATE film_app_settings SET value = '' WHERE key = 'gridlight_enabled'").run();
    providers.refreshLocalGateway();
});

test('an uncredentialed preference does not hijack the capability', () => {
    // isProviderConfigured guards this: preferring a provider whose key is
    // absent would swap a reachable service for an unusable one.
    const runway = providers.get('runway');
    assert.ok(runway, 'runway is no longer registered; this check needs rewriting');
    if (!providers.isProviderConfigured('runway')) {
        assert.notStrictEqual(providers.resolveId('video', {}), 'runway',
            'video preferred runway with no credential stored');
    }
});

// ── Coverage of the pipeline the acceptance names ───────────────────────────

test('every capability the E2E path needs is either served or explicitly handed off', () => {
    // "Screenplay to final movie" is the acceptance. Each stage must resolve to
    // something, or be a stage we have deliberately handed to the NLE.
    const HANDED_OFF = new Set(['lipsync', 'post']);
    const needed = stages().map(s => s.capability).filter(Boolean);
    assert.ok(needed.length >= 8, `only ${needed.length} generating stages found`);

    const orphans = [...new Set(needed)]
        .filter(c => !HANDED_OFF.has(c))
        .filter(c => alternativesFor(c).length === 0);

    assert.deepStrictEqual(orphans, [],
        `capabilities with no hosted adapter and no handoff: ${orphans.join(', ')}`);
});

test('the readiness check can audit every project, not just the newest', () => {
    // The preflight picked the most recently updated project and said nothing
    // about that choice, so it audited a demo project while the real one sat
    // configured and unexamined.
    const cli = require('fs').readFileSync(path.join(__dirname, '..', 'preflight.js'), 'utf8');
    assert.ok(/--all/.test(cli), 'preflight cannot audit every project');
    assert.ok(/ORDER BY updated_at DESC/.test(cli), 'preflight no longer has a project selection to reason about');
});

test('a fresh project is created with a usable provider configuration', () => {
    // Belt and braces alongside the resolve-time preference: the row itself
    // should say what it will use, so the Provider Settings panel shows the
    // truth rather than an empty object.
    const { defaultProviderConfig } = require('../lib/providers');
    assert.strictEqual(typeof defaultProviderConfig, 'function', 'no defaultProviderConfig()');

    const cfg = defaultProviderConfig();
    const wrong = Object.entries(cfg).filter(([cap, id]) => {
        const adapter = providers.get(id);
        return !CAPABILITIES.includes(cap) || !adapter || !adapter.supports(cap);
    });
    assert.deepStrictEqual(wrong, [], `bad entries: ${JSON.stringify(wrong)}`);
});

// ── Provider choice has to survive the SQL that fetches it ──────────────────

test('every route that reads a project provider config actually SELECTs it', () => {
    // providerConfigOf(project) reads project.provider_config. A narrow SELECT
    // that omits the column returns undefined, providerConfigOf falls back to
    // {}, resolveGenerator picks the global default, and the project's provider
    // choice is silently ignored — with every layer above looking correct.
    //
    // That is exactly what happened to storyboards: the resolution was wired up
    // and documented as fixed, but `SELECT id, title, style_preset` meant the
    // fix could never take effect, so every storyboard rendered on whichever
    // provider the global preference named.
    //
    // Scanned rather than listed: the next route to call providerConfigOf gets
    // the same guard without anyone remembering to add it here.
    const fs = require('fs');
    const routesDir = path.join(__dirname, '..', 'routes');

    const offenders = [];
    for (const file of fs.readdirSync(routesDir).filter(f => f.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
        if (!src.includes('providerConfigOf')) continue;

        src.split('\n').forEach((line, i) => {
            if (!/FROM\s+film_projects/i.test(line)) return;
            const select = line.match(/SELECT\s+([\s\S]*?)\s+FROM\s+film_projects/i);
            if (!select) return;
            const cols = select[1].trim();
            if (cols === '*' || /provider_config/.test(cols)) return;
            offenders.push(`${file}:${i + 1} — SELECT ${cols}`);
        });
    }

    assert.deepStrictEqual(offenders, [],
        'these fetch a project for provider resolution but never select provider_config:\n  '
        + offenders.join('\n  '));
});

test('no storyboard path writes a raw callImageGen result to disk', () => {
    // callImageGen returns { buffer, provider, model } so provenance survives.
    // One call site kept `const imageBuffer = await callImageGen(...)` and wrote
    // the whole object to fs.writeFileSync, which fails at runtime with an
    // unhelpful type error — and only on the regenerate path, so a batch run
    // looked fine. Scanned rather than spot-checked: the next call site added
    // has to destructure too.
    const src = require('fs').readFileSync(
        path.join(__dirname, '..', 'routes', 'storyboard.js'), 'utf8');

    const undestructured = src.split('\n')
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /await callImageGen\(/.test(line))
        .filter(({ line }) => !/^\s*(const\s*\{|await callImageGen)/.test(line.trim()) === false
            ? false
            : !/\{\s*buffer/.test(line))
        // a call whose own line lacks `{ buffer` and is not a continuation
        .filter(({ line }) => /const\s+\w+\s*=\s*await callImageGen\(/.test(line));

    assert.deepStrictEqual(undestructured.map(u => `storyboard.js:${u.n}`), [],
        'these assign callImageGen() straight to a variable and will write an object to disk');
});

test('every storyboard image payload carries the project aspect ratio', () => {
    // dimensionsForAspect only helps if the route actually passes the project's
    // frame. Three paths build this payload — batch, stream and regenerate —
    // and each was written separately, so a fix applied to two of them leaves
    // the third quietly producing squares for a scope film.
    const src = require('fs').readFileSync(
        path.join(__dirname, '..', 'routes', 'storyboard.js'), 'utf8');

    const payloadStarts = [...src.matchAll(/applyConsistencyToImagePayload\(\{/g)].map(m => m.index);
    assert.ok(payloadStarts.length >= 3, `expected 3 payload sites, found ${payloadStarts.length}`);

    const missing = [];
    payloadStarts.forEach((start, i) => {
        const block = src.slice(start, src.indexOf('}, consistencyContext)', start));
        if (!/aspect_ratio/.test(block)) missing.push(`payload site #${i + 1}`);
    });
    assert.deepStrictEqual(missing, [],
        `these build an image payload without the project aspect: ${missing.join(', ')}`);
});

test('no storyboard path reads a variable its own scope never binds', () => {
    // `metadata` is bound only in the SSE path; the batch and regenerate paths
    // bind usedProvider/usedModel. A blanket edit crossed them, and the result
    // was a ReferenceError that failed all eight shots with "metadata is not
    // defined" — after generation had already been paid for.
    //
    // Cheap structural check: each block that destructures callImageGen must
    // then use those names, not the stream path's.
    const src = require('fs').readFileSync(
        path.join(__dirname, '..', 'routes', 'storyboard.js'), 'utf8');
    const lines = src.split('\n');

    const offenders = [];
    lines.forEach((line, i) => {
        if (!/provider:\s*metadata\s*&&/.test(line)) return;
        // Walk back to whichever destructuring opened this scope.
        for (let j = i; j >= 0 && j > i - 60; j--) {
            if (/const \{ buffer: imageBuffer, provider: usedProvider/.test(lines[j])) {
                offenders.push(`storyboard.js:${i + 1} reads metadata in a usedProvider scope`);
                break;
            }
            if (/await callImageGenStream\(/.test(lines[j])) break;   // correct scope
        }
    });
    assert.deepStrictEqual(offenders, [], offenders.join('\n  '));
});
