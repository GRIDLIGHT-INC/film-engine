/**
 * QUALITY IS THE CHOICE; THE PROVIDER IS AN IMPLEMENTATION DETAIL.
 *
 * "I would not expose provider names prominently in the normal UI. I'd have
 * Draft — Standard — Precision, with an optional Advanced → Model selector.
 * That protects you when, six months from now, a new model beats Nano Banana.
 * You change the routing table rather than redesigning Film Engine."
 *
 * Exactly right, and it is the reason this is a table rather than a set of
 * if-statements. Everything in this engine already reaches a generator through
 * resolve(capability, config); a tier is one more thing that config can say,
 * so a router that lives anywhere else would be a second way to choose a
 * provider — and two ways to choose is how the board and the footage came to
 * use different ones.
 *
 * Set-based over TWO registries, because the failure is different on each side:
 * an adapter that arrives without declaring its contract is assumed capable of
 * anything, and a tier that points at an adapter nobody wired is a menu entry
 * that fails at generation time.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-tiers-' + crypto.randomUUID().slice(0, 8));

// hasCredential() reads film_provider_credentials, so the schema has to exist
// before a tier can be resolved at all.
require('../db/schema').ensureSchema();
const providers = require('../lib/providers');

/**
 * What an image adapter must declare.
 *
 * Derived from the fields the EXISTING adapters carry rather than typed from
 * the description: each of these exists because getting it wrong cost a real
 * generation once — the prompt ceiling, the reference limit, whether a
 * reference is conditioned on or edited, and how large a picture the provider
 * can actually make.
 */
const IMAGE_CONTRACT = [
    'promptLimit', 'maxReferenceImages', 'referenceMode', 'maxImagePixels',
    'supportsNegativePrompt', 'supportsSeed',
    // supports() is asked by resolve() AND by the readiness checks. An adapter
    // that cannot answer it is treated as serving nothing and is silently
    // skipped as a preference — which looks exactly like the provider being
    // unconfigured. Three adapters shipped without it before this line existed.
    'supports', 'meter',
];
const VIDEO_CONTRACT = ['maxKeyframes', 'describeVideoRequest'];

test('every image adapter declares the whole contract', () => {
    const image = providers.list().filter(e => (e.capabilities || []).includes('image'));
    assert.ok(image.length >= 5,
        `expected the new image providers to be registered, found ${image.length}: `
        + image.map(e => e.id).join(', '));

    const gaps = [];
    for (const a of image) {
        for (const field of IMAGE_CONTRACT) {
            if (a[field] === undefined || a[field] === null) gaps.push(`${a.id}.${field}`);
        }
        // referenceMode decides whether a reference is conditioned on or EDITED,
        // and an adapter that does not say is assumed to edit — which is why a
        // new view had to be painted from words on three of four providers.
        if (a.referenceMode && !['condition', 'edit'].includes(a.referenceMode)) {
            gaps.push(`${a.id}.referenceMode=${a.referenceMode}`);
        }
    }
    assert.deepStrictEqual(gaps, [], `undeclared: ${gaps.join(', ')}`);
});

test('every video adapter can still say what it will send', () => {
    const video = providers.list().filter(e => (e.capabilities || []).includes('video'));
    assert.ok(video.length >= 3, `expected seedance alongside runway and gridlight, found ${video.length}`);
    const gaps = [];
    for (const a of video) {
        for (const field of VIDEO_CONTRACT) {
            if (a[field] === undefined || a[field] === null) gaps.push(`${a.id}.${field}`);
        }
    }
    assert.deepStrictEqual(gaps, [], `undeclared: ${gaps.join(', ')}`);
});

/*
 * Pricing is NOT re-asserted here. tests/ai-spend.test.js already derives the
 * same (provider, capability) pairs from this registry and holds each to a
 * published rate, a source, a check date and a matching meter unit — including
 * the fact that gridlight prices at zero deliberately rather than by omission.
 * A second copy of that rule got the self-hosted case wrong and failed on
 * correct code, which is the exact way a guard gets relaxed until it protects
 * nothing. One rule, one place.
 */

// ── The tier table ──────────────────────────────────────────────────────

test('every tier resolves to an adapter that exists and can serve images', () => {
    const { IMAGE_TIERS, resolveTier } = require('../lib/quality-tiers');
    const names = Object.keys(IMAGE_TIERS);
    assert.deepStrictEqual(names.sort(), ['draft', 'precision', 'standard'],
        `the tier names changed: ${names.join(', ')}`);

    for (const [tier, spec] of Object.entries(IMAGE_TIERS)) {
        assert.ok(Array.isArray(spec.order) && spec.order.length,
            `${tier} names no providers`);
        assert.ok(spec.why && spec.why.length > 20,
            `${tier} does not say what it is FOR — a tier whose purpose is not written down becomes `
            + 'a name people guess at');
        for (const id of spec.order) {
            const adapter = providers.get(id);
            assert.ok(adapter, `${tier} routes to "${id}", which is not a registered provider`);
            assert.ok((adapter.capabilities || []).includes('image'),
                `${tier} routes to ${id}, which does not serve images`);
        }
    }

    // Resolution must be by CREDENTIAL, not by hope: a tier pointing at a
    // provider with no key has to fall through rather than fail at generation.
    const chosen = resolveTier('standard', {});
    assert.ok(chosen && chosen.provider,
        'no tier resolves at all — every project would fail to generate');
    assert.ok(chosen.reason, 'the resolution does not say why it chose what it chose');
});

test('auto picks a tier from what the request actually needs', () => {
    /*
     * "A simple new establishing shot might go straight to Nano Banana 2. But a
     * request like the Shot 3E dragon edit, where Film Engine needs the
     * existing shot, another pose reference, established geography and a camera
     * change, could automatically route to Nano Banana Pro."
     *
     * So auto is a function of the REQUEST, and the two things that make a
     * request hard are how many references it must reconcile and whether it is
     * editing an existing frame rather than making a new one.
     */
    const { autoTier } = require('../lib/quality-tiers');

    assert.strictEqual(autoTier({ referenceCount: 0 }), 'standard',
        'a plain new frame should not cost precision money');
    assert.strictEqual(autoTier({ referenceCount: 5, editingExistingFrame: true }), 'precision',
        'a continuity edit across several references is exactly the hard case');
    assert.strictEqual(autoTier({ referenceCount: 1, exploring: true }), 'draft',
        'exploring compositions should be cheap, or nobody explores');
});

test('a project can pin a provider, and pinning beats the tier', () => {
    /*
     * The Advanced escape hatch. A director who has learned that one model
     * handles their dragon must not be overruled by a table.
     */
    const { resolveTier } = require('../lib/quality-tiers');
    const pinned = resolveTier('draft', { image: 'openai' });
    assert.strictEqual(pinned.provider, 'openai',
        'an explicit provider choice was overridden by the tier table');
    assert.match(pinned.reason, /chose|pinned|explicit/i);
});

// ── The tier has to REACH a request, not just a column ───────────────────

test('the tier changes the model a provider is actually asked for', () => {
    /*
     * DIFFERENTIAL, because a stored tier and an applied tier look identical
     * from the outside. Standard and Precision both resolve to Google — the
     * difference between them IS the model, so a tier that reached the
     * provider and not the model would make the two settings generate the same
     * frame while the page showed a choice. That is this feature failing
     * silently, which is the only way features like this ever fail.
     */
    const { withTierModel } = require('../lib/capability-payloads');
    const adapter = providers.get('google');
    const ctxFor = extra => ({
        project: { provider_config: JSON.stringify({ image: 'google', ...extra }) },
    });

    const seen = new Map();
    for (const tier of ['draft', 'standard', 'precision']) {
        const payload = withTierModel({ prompt: 'x' }, ctxFor({ image_quality: tier }), adapter);
        assert.ok(payload.model, `${tier} named no model, so it reaches the provider as a default`);
        seen.set(tier, payload.model);
    }
    assert.strictEqual(new Set(seen.values()).size, seen.size,
        `two tiers ask for the same model, so choosing between them changes nothing: `
        + [...seen].map(([t, m]) => `${t}=${m}`).join(', '));

    // The Advanced pin outranks the table.
    const pinned = withTierModel({ prompt: 'x' },
        ctxFor({ image_quality: 'draft', image_model: 'gemini-3-pro-image' }), adapter);
    assert.strictEqual(pinned.model, 'gemini-3-pro-image');

    // A model belonging to one provider must never be sent to another.
    const wrong = withTierModel({ prompt: 'x' }, ctxFor({ image_quality: 'precision' }), providers.get('openai'));
    assert.ok(!wrong.model, 'a Google model was named on a request going to OpenAI');
});

test('setting the quality tier does not wipe the provider choices', () => {
    /*
     * The route built a fresh config object and wrote it over the column. That
     * was harmless while the only caller was a page that re-sends every field,
     * and destructive the moment anything sent one — an agent calling
     * quality_set would have silently cleared every per-capability provider on
     * the project, and nothing would have failed. The next generation would
     * just have resolved somewhere else.
     */
    const { db } = require('../db/database');
    const { handleProviders } = require('../routes/providers');
    const crypto2 = require('crypto');

    const id = crypto2.randomUUID();
    db.prepare('INSERT INTO film_projects (id, title, provider_config) VALUES (?, ?, ?)')
        .run(id, 'tier merge', JSON.stringify({ image: 'openai', video: 'runway' }));

    const res = { statusCode: 0, body: null, setHeader() {},
        end(b) { this.body = JSON.parse(b || '{}'); }, writeHead(c) { this.statusCode = c; } };
    handleProviders(
        { method: 'PUT', body: { config: { image_quality: 'precision' } } },
        res, ['film', 'projects', id, 'providers'], {});

    const saved = JSON.parse(db.prepare('SELECT provider_config FROM film_projects WHERE id = ?').get(id).provider_config);
    assert.strictEqual(saved.image_quality, 'precision', 'the tier did not save');
    assert.strictEqual(saved.image, 'openai', 'setting a tier cleared the image provider choice');
    assert.strictEqual(saved.video, 'runway', 'setting a tier cleared the video provider choice');
});

test("a tier's model never travels to the provider it was not chosen for", async () => {
    /*
     * The fallback chain walks PAST a provider that declines, so the adapter
     * changes mid-flight while the payload does not. Carrying Google's model
     * on to the next provider is a rejected request — and rejected for a
     * reason that looks nothing like the refusal that started the walk, so the
     * fallback reads as broken rather than the model name being wrong.
     *
     * Most adapters guard themselves (runway's own source records learning
     * this), but the local gateway passes `p.model` straight through by
     * design, which is why the strip lives in the chain rather than in each
     * adapter.
     */
    const { withTierModel } = require('../lib/capability-payloads');
    const { runImageFallbackChain } = require('../lib/image-fallback');

    const payload = withTierModel({ prompt: 'x' },
        { project: { provider_config: JSON.stringify({ image: 'google', image_quality: 'precision' }) } },
        providers.get('google'));
    assert.ok(payload.model, 'the tier named no model, so this proves nothing');
    assert.ok(!Object.keys(payload).includes('__model_for'),
        'the ownership marker is enumerable and would be serialised into the request body');

    const seen = [];
    const fake = (id, ok) => ({
        id, capabilities: ['image'], promptLimit: 9000,
        generate: async (_c, p) => {
            seen.push(`${id}:${p.model || '(none)'}`);
            return ok ? { ok: true, data: Buffer.from('x') } : { ok: false, error: 'content moderation' };
        },
    });
    await runImageFallbackChain([fake('google', false), fake('gridlight', true)], payload);

    assert.deepStrictEqual(seen, ['google:gemini-3-pro-image', 'gridlight:(none)'],
        'a model chosen for one provider reached another');
});
