/**
 * Image generation survives a provider refusal.
 *
 * Three adapters serve `image`, and the pipeline used exactly one: whichever
 * resolveGenerator returned. When Runway declined a prompt on moderation,
 * all eight shots failed together — with two other credentialed image
 * providers sitting in the registry untried.
 *
 * That refusal is not even deterministic: the same prompt for the same shot
 * passed and then failed minutes apart, so "the provider said no" is a
 * condition to route around, not a verdict on the shot.
 *
 * Set-based over the registry rather than a hardcoded chain. An example-based
 * test ("runway falls back to openai") passes while a third provider is still
 * never reached, which is the same one-provider failure one step along.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-imgfb-' + crypto.randomUUID().slice(0, 8));

const { ensureSchema } = require('../db/schema');
ensureSchema();
const { db } = require('../db/database');

const providers = require('../lib/providers');
const { imageProviderChain, isRefusal } = require('../lib/image-fallback');

// Credential every keyed adapter so the chain is not empty by accident.
for (const a of providers.list()) {
    if (!a.requiresKey) continue;
    db.prepare(`INSERT INTO film_provider_credentials (provider, api_key, meta, updated_at)
                VALUES (?, ?, '{}', datetime('now'))
                ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key`)
        .run(a.id, 'test-key');
}

const IMAGE_PROVIDERS = providers.list().filter(a => a.supports && a.supports('image'));

test('the registry really does have more than one image provider', () => {
    // If this ever drops to one, the fallback is pointless and the failure it
    // guards is unavoidable — worth failing loudly rather than passing vacuously.
    assert.ok(IMAGE_PROVIDERS.length >= 2,
        `only ${IMAGE_PROVIDERS.length} image provider(s); a chain cannot help`);
});

test('the chain contains every credentialed vendor of the house model, and nothing else', () => {
    const chain = imageProviderChain({});
    const ids = chain.map(a => a.id);

    // The house standard (lib/image-standard.js): a refusal may only be walked
    // to another vendor of Nano Banana Pro, never onto a different model.
    const { isStandardProvider } = require('../lib/image-standard');
    const expected = IMAGE_PROVIDERS
        .filter(a => providers.isProviderConfigured(a.id) && isStandardProvider(a.id))
        .map(a => a.id);

    assert.deepStrictEqual([...ids].sort(), [...expected].sort(),
        `chain ${ids.join(',')} != credentialed image providers ${expected.join(',')}`);

    for (const a of chain) {
        assert.ok(a.supports('image'), `${a.id} is in the image chain but does not serve image`);
    }
});

test('the project’s explicit choice of a house-model vendor leads the chain', () => {
    // A fallback that ignores the configured provider would silently override a
    // deliberate decision — the whole point is to survive refusal, not to
    // re-decide which provider the production uses. A pin to a vendor that does
    // not sell Nano Banana Pro is overruled by the house standard instead.
    const { isStandardProvider } = require('../lib/image-standard');
    for (const a of IMAGE_PROVIDERS) {
        if (!providers.isProviderConfigured(a.id) || !isStandardProvider(a.id)) continue;
        const chain = imageProviderChain({ image: a.id });
        assert.strictEqual(chain[0].id, a.id, `configuring '${a.id}' did not put it first`);
    }
});

test('every provider appears at most once', () => {
    // A duplicate would retry the same refusal and bill for it twice.
    const ids = imageProviderChain({ image: 'runway' }).map(a => a.id);
    assert.strictEqual(new Set(ids).size, ids.length, `duplicates in chain: ${ids.join(',')}`);
});

test('a refusal is recognised, and an ordinary failure is not', () => {
    // Advancing on a refusal is the point. Advancing on "no credit" or a
    // network error too is fine, but advancing on a MALFORMED REQUEST would
    // just re-send the same bad payload to every provider in turn.
    assert.ok(isRefusal('runway: task abc failed — Text prompt did not pass moderation'));
    assert.ok(isRefusal('openai 429: You have no credits remaining.'));
    assert.ok(isRefusal('gridlight 503: service unavailable'));

    assert.ok(!isRefusal('runway 400: Validation of body failed — ratio: Invalid option'),
        'a malformed request must not be replayed to every provider');
    assert.ok(!isRefusal(''), 'an empty error should not trigger a chain walk');
});

test('every image call site resolves through the chain, not a single provider', () => {
    // A chain nothing calls is decoration. All three storyboard paths run
    // through callImageGen, so the check is that callImageGen itself uses it.
    const src = require('fs').readFileSync(
        path.join(__dirname, '..', 'routes', 'storyboard.js'), 'utf8');

    const fn = src.slice(src.indexOf('async function callImageGen('), src.indexOf('async function callImageGenStream('));
    assert.ok(fn.length > 100, 'callImageGen not found');
    // Either entry point counts — generateImageWithFallback walks the chain
    // internally. What must NOT survive is resolving a single adapter and
    // calling it directly, which is the shape that failed all eight shots.
    assert.ok(/generateImageWithFallback|imageProviderChain/.test(fn),
        'callImageGen does not use the fallback chain');
    assert.ok(!/resolveGenerator\('image'/.test(fn),
        'callImageGen still resolves exactly one provider and cannot fall back');

    const callSites = (src.match(/await callImageGen\(/g) || []).length;
    assert.ok(callSites >= 3, `expected 3+ call sites inheriting the chain, found ${callSites}`);
});

test('exhausted-credit wording from every provider advances the chain', () => {
    // Each provider phrases this differently, and matching one phrasing meant a
    // chain that stopped at the first empty account instead of walking past it.
    const WORDINGS = [
        'openai 429: You have no credits remaining. Add credits to continue using the API.',
        'runway: runway 400: You do not have enough credits to run this task.',
        'provider: insufficient balance for this request',
        'provider 402: billing required',
        'provider: quota exceeded',
    ];
    const missed = WORDINGS.filter(w => !isRefusal(w));
    assert.deepStrictEqual(missed, [],
        `these stop the chain instead of advancing it:\n  ${missed.join('\n  ')}`);
});
