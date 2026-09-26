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
