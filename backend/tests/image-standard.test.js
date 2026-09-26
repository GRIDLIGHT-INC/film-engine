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

test('an image resolves to the house vendor over every pin, tier and default', () => {
    for (const cfg of [{}, { image_quality: 'draft' }, { image: 'bfl' }, { image: 'openai', image_model: 'gpt-image-2' },
        { image: 'runway', image_quality: 'precision' }]) {
        const r = providers.resolveIdWithReason('image', cfg);
        assert.strictEqual(r.id, 'muapi', `${JSON.stringify(cfg)} resolved ${r.id}`);
        assert.strictEqual(r.source, 'house_standard');
    }
    // A pin to another vendor of the SAME model is honoured.
    assert.strictEqual(providers.resolveId('image', { image: 'google' }), 'google');
    assert.strictEqual(providers.resolveId('image', { image: 'meshy' }), 'meshy');
});

test('every vendor of the standard is asked for Nano Banana Pro, whatever was pinned', () => {
    const { withTierModel } = require('../lib/capability-payloads');
    for (const [id, model] of Object.entries(std.STANDARD_MODELS)) {
        const payload = withTierModel({ prompt: 'x', model: 'nano-banana-2' },
            { project: { provider_config: JSON.stringify({ image_quality: 'draft', image_model: 'nano-banana' }) } },
            providers.get(id));
        assert.strictEqual(payload.model, model, `${id} was asked for ${payload.model}`);
    }
});

test('a refusal can only be walked to another vendor of the same model', () => {
    const { imageProviderChain } = require('../lib/image-fallback');
    const ids = imageProviderChain({}).map(a => a.id);
    assert.ok(ids.length >= 2, `the walk has ${ids.length} vendor(s)`);
    for (const id of ids) {
        assert.ok(std.isStandardProvider(id), `${id} is in the image walk and does not sell Nano Banana Pro`);
    }
});

test('a board frame is 4K in the shot’s own shape', () => {
    const { buildCapabilityPayload } = require('../lib/capability-payloads');
    const ctx = (aspect, res, card = {}) => ({
        shot: { id: 's1', shot_code: '1A', duration_ms: 5000 },
        sceneCard: { shot_code: '1A', description: 'A room.', camera: {}, ...card },
        scene: { id: 'sc1', project_id: 'p1' },
        project: { aspect_ratio: aspect, target_resolution: res, target_fps: 24 },
        keyframePath: null,
    });
    const hd = buildCapabilityPayload('image', ctx('16:9', '1280x720')).payload;
    assert.deepStrictEqual([hd.width, hd.height], [3840, 2160]);
    // A shot's own ratio outranks the project's, and still gets 4K.
    const vertical = buildCapabilityPayload('image', ctx('16:9', '1920x1080', { aspect_ratio: '9:16' })).payload;
    assert.deepStrictEqual([vertical.width, vertical.height], [2160, 3840]);
});

test('a plate is 2K for every kind, and the character turnaround is too', () => {
    const { plateImageSize } = require('../lib/reference-plates');
    for (const kind of std.PLATE_KINDS) {
        const s = plateImageSize({ aspect_ratio: '16:9', target_resolution: '1280x720' }, 3840 * 2160, kind,
            providers.get('muapi'));
        assert.deepStrictEqual([s.width, s.height], [2048, 1152], `${kind}`);
    }
    // The turnaround builds its own payload; it must read the standard, not a literal.
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'routes', 'characters.js'), 'utf8');
    assert.ok(!/width:\s*1024,\s*\n\s*height:\s*1024/.test(src), 'a character turnaround is still a 1024 square');
    assert.ok(/image-standard'\)\.plateSize\('1:1'\)/.test(src), 'the turnaround does not size from the standard');
});

test('the body MuAPI receives asks for the 4K tier on a board and the 2K tier on a plate', () => {
    const muapi = providers.get('muapi');
    const describe = p => muapi.describeImageRequest
        ? muapi.describeImageRequest(p)
        : require('../lib/providers/muapi-image').describeImageRequest(p);
    const board = describe({ prompt: 'x', model: 'nano-banana-pro', ...std.storyboardSize('16:9') });
    const plate = describe({ prompt: 'x', model: 'nano-banana-pro', ...std.plateSize('16:9') });
    const body = r => (r && (r.body || (r.request && r.request.body))) || r;
    assert.strictEqual(body(board).resolution, '4k', `a board left as ${JSON.stringify(body(board))}`);
    assert.strictEqual(body(plate).resolution, '2k', `a plate left as ${JSON.stringify(body(plate))}`);
    assert.match(String((board.url || '')), /nano-banana-pro/, 'the board did not go to the Nano Banana Pro endpoint');
});
