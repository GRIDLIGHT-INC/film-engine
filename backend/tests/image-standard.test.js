/**
 * THE HOUSE IMAGE STANDARD, held at every place a picture is decided.
 *
 * "First default that we'll never waiver from. When we create image storyboard
 *  shots, let's create them in 4K. Plates (location, characters, props) in 2K.
 *  All images use nano banana pro."
 *
 * Four places decide what a picture is — which vendor, which model, what the
 * fallback walk may reach, and the raster — and a rule held at three of them
 * is a rule a refusal or a pin quietly routes around. Each is asserted here,
 * and the last assertion reads the body MuAPI would actually be sent, because
 * a 4K request that leaves as a 2K tier is the standard failing silently.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-imgstd-' + crypto.randomUUID().slice(0, 8));

require('../db/schema').ensureSchema();
const { db } = require('../db/database');
const providers = require('../lib/providers');
const std = require('../lib/image-standard');

function credential(id) {
    db.prepare(`INSERT OR REPLACE INTO film_provider_credentials (provider, api_key, meta, updated_at)
        VALUES (?, 'test-key-not-a-real-one', '{}', datetime('now'))`).run(id);
}
for (const id of ['muapi', 'google', 'meshy', 'bfl', 'openai', 'runway']) credential(id);

test('every vendor the standard names is a registered image adapter that sells the model', () => {
    for (const [id, model] of Object.entries(std.STANDARD_MODELS)) {
        const a = providers.get(id);
        assert.ok(a && a.supports('image'), `${id} is named by the standard and serves no image`);
        const ids = providers.modelIdsFor(a, 'image');
        assert.ok(!ids || ids.includes(model), `${id} does not offer ${model}`);
    }
    assert.strictEqual(std.STANDARD_PROVIDERS[0], 'muapi', 'MuAPI is not first');
});

/*
 * "Any image prompt should be able to be sent to flux 2 dev or any of our other
 *  providers." Nano Banana Pro is the DEFAULT, not a lock: when nobody names a
 * provider or a model it is what runs, and when somebody does, what they named
 * runs. The denominator is every registered adapter that serves images, so a
 * provider added later is choosable or this fails.
 */
const IMAGE_ADAPTERS = providers.list().filter(a => a.supports && a.supports('image')).map(a => a.id);

function withGateway(on, fn) {
    const prev = process.env.GRIDLIGHT_ENABLED;
    process.env.GRIDLIGHT_ENABLED = on ? '1' : '0';
    providers.refreshLocalGateway();
    try { return fn(); } finally {
        if (prev === undefined) delete process.env.GRIDLIGHT_ENABLED; else process.env.GRIDLIGHT_ENABLED = prev;
        providers.refreshLocalGateway();
    }
}

test('with nothing chosen an image resolves to the house vendor, over tier and default', () => {
    for (const cfg of [{}, { image_quality: 'draft' }, { image_quality: 'precision' }]) {
        const r = providers.resolveIdWithReason('image', cfg);
        assert.strictEqual(r.id, 'muapi', `${JSON.stringify(cfg)} resolved ${r.id}`);
        assert.strictEqual(r.source, 'house_standard');
    }
});

test('the gateway offers the catalog\'s image models, so flux2-dev can be picked', () => {
    const cat = require('../lib/model-catalog').current();
    const want = ((cat && cat.models) || []).filter(m => (m.capabilities || []).includes('image')).map(m => m.id);
    assert.ok(want.includes('flux2-dev'), `the catalog lists no flux2-dev image model: ${want.join(', ')}`);
    assert.deepStrictEqual(providers.modelIdsFor(providers.get('gridlight'), 'image'), want);
    const { withTierModel } = require('../lib/capability-payloads');
    const p = withTierModel({ prompt: 'x' }, { project: { provider_config: '{}' },
        tierOverride: { image: 'gridlight', image_model: 'flux2-dev' } }, providers.get('gridlight'));
    assert.strictEqual(p.model, 'flux2-dev', `choosing flux2-dev on the gateway sent ${p.model}`);
});

test('every image provider can be chosen, and the choice is what runs', () => {
    assert.ok(IMAGE_ADAPTERS.length >= 5, `only ${IMAGE_ADAPTERS.length} image adapters found; the scan is wrong`);
    assert.ok(IMAGE_ADAPTERS.includes('gridlight'), 'the gateway serves no image, so flux2-dev could never be chosen');
    withGateway(true, () => {
        for (const id of IMAGE_ADAPTERS) {
            const r = providers.resolveIdWithReason('image', { image: id, image_quality: 'precision' });
            assert.strictEqual(r.id, id, `a choice of ${id} resolved ${r.id}`);
            assert.strictEqual(r.explicit, true, `${id} was chosen and is not reported as chosen`);
        }
    });
});

test('a switched-off gateway is not reached by choosing it; the default runs and says why', () => {
    withGateway(false, () => {
        const r = providers.resolveIdWithReason('image', { image: 'gridlight' });
        assert.notStrictEqual(r.id, 'gridlight', 'a choice reached a gateway that is switched off');
    });
});

test('with no model chosen every vendor of the standard is asked for Nano Banana Pro', () => {
    const { withTierModel } = require('../lib/capability-payloads');
    for (const [id, model] of Object.entries(std.STANDARD_MODELS)) {
        const payload = withTierModel({ prompt: 'x' },
            { project: { provider_config: JSON.stringify({ image_quality: 'draft' }) } }, providers.get(id));
        assert.strictEqual(payload.model, model, `${id} was asked for ${payload.model}`);
    }
});

test('a chosen model is the model asked for, on every provider that offers it', () => {
    const { withTierModel } = require('../lib/capability-payloads');
    const picks = [];
    for (const id of IMAGE_ADAPTERS) {
        const ids = providers.modelIdsFor(providers.get(id), 'image');
        const other = ids ? ids.find(m => m !== std.STANDARD_MODELS[id]) : 'flux2-dev';
        if (other) picks.push([id, other]);
    }
    assert.ok(picks.length >= 4, `only ${picks.length} providers offer a model to choose`);
    for (const [id, model] of picks) {
        // Per generation, as the confirmation dialog sends it.
        const perGen = withTierModel({ prompt: 'x' }, { project: { provider_config: '{}' },
            tierOverride: { image: id, image_model: model } }, providers.get(id));
        assert.strictEqual(perGen.model, model, `${id}: chose ${model} for this generation, asked for ${perGen.model}`);
        // And as the project's own pin.
        const pinned = withTierModel({ prompt: 'x' }, { project: { provider_config: JSON.stringify({ image: id, image_model: model }) } },
            providers.get(id));
        assert.strictEqual(pinned.model, model, `${id}: pinned ${model}, asked for ${pinned.model}`);
    }
});

test('with nothing chosen a refusal walks only to another vendor of the same model', () => {
    const { imageProviderChain } = require('../lib/image-fallback');
    const ids = imageProviderChain({}).map(a => a.id);
    assert.ok(ids.length >= 2, `the walk has ${ids.length} vendor(s)`);
    for (const id of ids) {
        assert.ok(std.isStandardProvider(id), `${id} is in the image walk and does not sell Nano Banana Pro`);
    }
});

test('a chosen provider outside the standard is never walked away from', () => {
    const { imageProviderChain } = require('../lib/image-fallback');
    for (const id of ['bfl', 'openai', 'runway']) {
        const ids = imageProviderChain({ image: id }).map(a => a.id);
        assert.deepStrictEqual(ids, [id], `chose ${id}; a refusal would walk to ${ids.slice(1).join(', ')}`);
    }
});

test('a chosen model is not walked onto another vendor, which would sell a different model', async () => {
    const { runImageFallbackChain } = require('../lib/image-fallback');
    const seen = [];
    const refuse = (id) => ({ id, supports: c => c === 'image', generate: async (_c, p) => { seen.push([id, p.model]); return { ok: false, error: 'content policy refused' }; } });
    const payload = { prompt: 'x', model: 'nano-banana-2' };
    Object.defineProperty(payload, '__model_for', { value: 'muapi', enumerable: false, configurable: true, writable: true });
    Object.defineProperty(payload, '__model_explicit', { value: true, enumerable: false, configurable: true, writable: true });
    await runImageFallbackChain([refuse('muapi'), refuse('google')], payload);
    assert.deepStrictEqual(seen.map(s => s[0]), ['muapi'], `the chosen model was walked to ${seen.slice(1).map(s => s[0]).join(', ')}`);
    assert.strictEqual(seen[0][1], 'nano-banana-2', `the chosen model left as ${seen[0][1]}`);
});

/*
 * The size is the PROJECT's. "If I select 4K then the picture is 4K… it
 * shouldn't be hardwired." Every assertion below changes the technical setting
 * and requires the picture to follow — a constant would pass any one of them.
 */
const RESOLUTION_CASES = [
    { res: '1280x720', board16x9: [1280, 720], plate16x9: [1280, 720], tier: '2k' },
    { res: '2048x1080', board16x9: [2048, 1152], plate16x9: [2048, 1152], tier: '2k' },
    { res: '3840x2160', board16x9: [3840, 2160], plate16x9: [3840, 2160], tier: '4k' },
];

test('a board frame follows the project resolution, in the shot’s own shape', () => {
    const { buildCapabilityPayload } = require('../lib/capability-payloads');
    const ctx = (aspect, res, card = {}) => ({
        shot: { id: 's1', shot_code: '1A', duration_ms: 5000 },
        sceneCard: { shot_code: '1A', description: 'A room.', camera: {}, ...card },
        scene: { id: 'sc1', project_id: 'p1' },
        project: { aspect_ratio: aspect, target_resolution: res, target_fps: 24 },
        keyframePath: null,
    });
    for (const c of RESOLUTION_CASES) {
        const p = buildCapabilityPayload('image', ctx('16:9', c.res)).payload;
        assert.deepStrictEqual([p.width, p.height], c.board16x9, c.res);
    }
    // A shot's own ratio outranks the project's and turns the long edge.
    const vertical = buildCapabilityPayload('image', ctx('16:9', '3840x2160', { aspect_ratio: '9:16' })).payload;
    assert.deepStrictEqual([vertical.width, vertical.height], [2160, 3840]);
    // No readable resolution is the 2K default, never a 4K constant.
    const none = buildCapabilityPayload('image', ctx('16:9', null)).payload;
    assert.deepStrictEqual([none.width, none.height], [2048, 1152]);
});

test('a plate follows the project resolution for every kind, and the turnaround does too', () => {
    const { plateImageSize } = require('../lib/reference-plates');
    for (const c of RESOLUTION_CASES) {
        for (const kind of std.PLATE_KINDS) {
            const s = plateImageSize({ aspect_ratio: '16:9', target_resolution: c.res }, 3840 * 2160, kind,
                providers.get('muapi'));
            assert.deepStrictEqual([s.width, s.height], c.plate16x9, `${kind} at ${c.res}`);
        }
    }
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'routes', 'characters.js'), 'utf8');
    assert.ok(!/width:\s*1024,\s*\n\s*height:\s*1024/.test(src), 'a character turnaround is still a 1024 square');
    assert.ok(/plateSize\('1:1',\s*\n?\s*require\('\.\.\/lib\/image-standard'\)\.projectResolution\(/.test(src),
        'the turnaround does not size from the project resolution');
});

test('the body MuAPI receives asks for the tier the project resolution needs', () => {
    const describe = p => require('../lib/providers/muapi-image').describeImageRequest(p);
    const body = r => (r && (r.body || (r.request && r.request.body))) || r;
    for (const c of RESOLUTION_CASES) {
        const board = describe({ prompt: 'x', model: 'nano-banana-pro', ...std.storyboardSize('16:9', c.res) });
        assert.strictEqual(body(board).resolution, c.tier, `${c.res}: ${JSON.stringify(body(board))}`);
        assert.match(String(board.url || ''), /nano-banana-pro/, 'not the Nano Banana Pro endpoint');
    }
});
