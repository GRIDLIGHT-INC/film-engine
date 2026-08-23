/**
 * 3D generation goes to the provider the project chose.
 *
 * Every other capability resolves through the provider registry: the project's
 * provider_config names one, an env var can override, and Gridlight is the
 * fallback. routes/threed.js never asked. It called callGridlight directly, so
 * a project configured `model3d: meshy` — with a funded Meshy account already
 * generating its storyboard frames — sent every mesh request to a local
 * service on :8080 that was not running.
 *
 * What a director saw was "Backend offline", which is doubly misleading: the
 * Film Engine backend was fine, and the provider that could have served the
 * request was never contacted.
 *
 * Set-based over the operations and the subject kinds, because the failure is
 * per-route: wiring character generation and forgetting locations would look
 * fixed on the page a director happened to try first.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-3dprov-' + crypto.randomUUID().slice(0, 8));
require('../db/schema').ensureSchema();

const ROOT = path.join(__dirname, '..');
const providers = require('../lib/providers');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
const SRC = strip(fs.readFileSync(path.join(ROOT, 'routes/threed.js'), 'utf8'));

/** The subject kinds the router serves, derived from its own table. */
function modelSubjects() {
    const m = SRC.match(/MODEL_SUBJECTS\s*=\s*\{([^}]*)\}/);
    assert.ok(m, 'MODEL_SUBJECTS is gone — the derivation is wrong, not the code');
    return [...new Set([...m[1].matchAll(/'([a-z0-9_]+)'/g)].map(x => x[1]))];
}

test('the 3D router resolves a provider instead of assuming one', () => {
    assert.ok(/resolveGenerator|resolve\(/.test(SRC),
        'routes/threed.js never resolves a provider, so a project that chose Meshy still '
        + 'sends every mesh request to Gridlight and reports the backend as offline');
});

test('every model subject reaches the configured provider', () => {
    const kinds = modelSubjects();
    assert.ok(kinds.length >= 3, `expected at least 3 model subjects, found ${kinds.join(', ')}`);

    // The router must not call the gateway directly for a generation. Reading
    // an existing job or serving a file is different — those are gateway
    // bookkeeping, not a paid generation.
    const direct = [...SRC.matchAll(/callGridlight\(\s*THREED_ENDPOINTS\.(generate|fromImage|rig|retexture|animate)/g)]
        .map(m => m[1]);
    assert.deepStrictEqual([...new Set(direct)], [],
        'these generations bypass the provider registry and go straight to the gateway');
});

test('a project that chose Meshy resolves to Meshy for model3d', () => {
    const { resolveGenerator } = require('../lib/providers');
    const adapter = resolveGenerator('model3d', { model3d: 'meshy' });
    assert.ok(adapter, 'nothing resolved for model3d');
    assert.strictEqual(adapter.id || adapter.provider, 'meshy',
        `a project asking for meshy resolved to ${adapter.id || adapter.provider}`);
});

test('the payloads the router builds are ones the provider can act on', () => {
    /*
     * The router builds gateway-shaped payloads. Meshy infers image-to-mesh
     * from `image_url` or `image` and text-to-mesh otherwise — so a from-image
     * payload carrying `init_image` is read as text-to-mesh and refused for
     * having no prompt. Resolving the provider without translating the payload
     * would trade "backend offline" for "a prompt is required", which is not
     * an improvement.
     */
    const t = require('../lib/threed-prompt');
    const subject = t.normalizeSubject({ name: 'MAYA', appearance_prompt: 'tired, 30s' }, 'character');

    const text = t.build3DPayload(subject, {});
    assert.ok(String(text.prompt || '').trim(), 'the text payload carries no prompt');

    /*
     * The builders stay gateway-shaped — that is what Gridlight expects, and it
     * is still the fallback. What must hold is that the ROUTER translates
     * before handing over, so the assertion is on the translation rather than
     * on the builder.
     */
    const { threedPayloadFor } = require('../routes/threed');
    const { THREED_ENDPOINTS } = require('../lib/gridlight-client');
    const meshy = providers.list().find(a => (a.id || a.provider) === 'meshy');

    const fromImage = t.buildFromImagePayload(subject, 'http://example/plate.png', {});
    const sent = threedPayloadFor(meshy, THREED_ENDPOINTS.fromImage, fromImage);
    assert.ok(sent.image_url || sent.image,
        `the from-image payload reaches Meshy as ${Object.keys(sent).join(', ')} — it looks for `
        + 'image_url or image, so this would be read as text-to-mesh and refused for having no prompt');
    assert.strictEqual(sent.operation, 'image_to_mesh', 'the operation is not stated explicitly');

    const textSent = threedPayloadFor(meshy, THREED_ENDPOINTS.generate, text);
    assert.strictEqual(textSent.operation, 'text_to_mesh');
    // The gateway's model family is not Meshy's; an unrecognised name is
    // dropped so the adapter's own default applies rather than being rejected
    // with "AIModel must be one of [...]".
    assert.ok(!textSent.model || /^(meshy-|latest)/.test(String(textSent.model)),
        `a gateway model name (${textSent.model}) would reach Meshy and be refused`);
    assert.ok(String(textSent.prompt || '').trim(), 'the translated text payload lost its prompt');
});

test('the operations the router offers are ones the provider supports', () => {
    const meshy = providers.list().find(a => (a.id || a.provider) === 'meshy');
    assert.ok(meshy, 'no meshy adapter');
    assert.ok((meshy.capabilities || []).includes('model3d'), 'meshy does not declare model3d');

    const src = fs.readFileSync(path.join(ROOT, 'lib/providers/meshy.js'), 'utf8');
    const ops = [...new Set([...src.matchAll(/^\s{4}([a-z_]+):\s*\{\s*path:/gm)].map(m => m[1]))];
    for (const needed of ['text_to_mesh', 'image_to_mesh']) {
        assert.ok(ops.includes(needed), `meshy cannot ${needed}, so the router cannot delegate it`);
    }
});
