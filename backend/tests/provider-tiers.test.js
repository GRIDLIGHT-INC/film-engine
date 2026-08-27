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

    /*
     * Resolution is by CREDENTIAL, not by hope. Seeded here because the local
     * gateway is now off unless switched on, so a database with no credentials
     * resolves to NOTHING — which is the honest answer and makes this assertion
     * about an empty machine rather than about routing.
     */
    require('../db/database').db.prepare(
        `INSERT INTO film_provider_credentials (provider, api_key, meta) VALUES ('openai', 'k', '{}')
         ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key`).run();
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

test('the static image preference and the standard tier stay in lockstep', () => {
    /*
     * Two orderings for one capability is how the board and the footage came to
     * use different providers. quality-tiers.js cannot be required from
     * providers/index.js — that would be a cycle — so the list is written out
     * there and held to the tier table here, exactly as flow-seed is held to
     * PIPELINE_STEPS.
     */
    const { PREFERRED_WHEN_CONFIGURED } = require('../lib/providers');
    const { IMAGE_TIERS } = require('../lib/quality-tiers');
    const expected = IMAGE_TIERS.standard.order.filter(id => id !== 'gridlight' && id !== 'runway');
    assert.deepStrictEqual(PREFERRED_WHEN_CONFIGURED.image, expected,
        'the image preference and the Standard tier disagree about provider order, so a project '
        + 'with no stated tier resolves somewhere the tier picker does not admit to');
});

test('a project that states no tier still gets a named model', () => {
    /*
     * Meshy's own default is nano-banana-pro — three times the credits of
     * nano-banana-2. A payload that names no model inherits that, so "I never
     * chose a quality" quietly meant "I chose the most expensive one".
     */
    const { withTierModel } = require('../lib/capability-payloads');
    // A tier resolves by CREDENTIAL, so the provider has to be reachable for
    // this to be testing the tier rather than the fallthrough.
    require('../db/database').db.prepare(
        `INSERT INTO film_provider_credentials (provider, api_key, meta) VALUES ('meshy', 'test-key', '{}')
         ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key`).run();

    const payload = withTierModel({ prompt: 'x' },
        { project: { provider_config: JSON.stringify({}) } }, providers.get('meshy'));
    assert.strictEqual(payload.model, 'nano-banana-2',
        'an unstated tier did not resolve to the standard model');
});

test('no tier pays a proxy fee for a model it could buy direct', () => {
    /*
     * Meshy RESELLS Google's models: nano-banana-pro IS gemini-3-pro-image. So
     * Precision through Meshy cost $0.180 for output Google sells at $0.134 —
     * 34% for nothing, on the tier a director reaches for when the frame
     * matters.
     *
     * Narrow on purpose. The first version of this compared every provider in
     * a tier's fallback list and demanded the cheapest lead, which would drive
     * every tier to the cheapest MODEL regardless of what the tier promises —
     * destroying the thing tiers exist for. The rule is only about the same
     * model sold twice, which is why SAME_MODEL is written down.
     */
    const { IMAGE_TIERS, SAME_MODEL } = require('../lib/quality-tiers');
    const { rateFor } = require('../lib/provider-pricing');
    const priceOf = ref => {
        const [provider, model] = ref.split(':');
        const r = rateFor(provider, 'image', model);
        return r ? (r.usd_per_unit !== undefined ? r.usd_per_unit : r.usd_per_native) : null;
    };

    const wrong = [];
    for (const [tier, spec] of Object.entries(IMAGE_TIERS)) {
        const chosen = spec.order.find(id => spec.models[id]);
        if (!chosen) continue;
        const chosenRef = `${chosen}:${spec.models[chosen]}`;

        for (const pair of SAME_MODEL) {
            if (!pair.includes(chosenRef)) continue;
            const other = pair.find(x => x !== chosenRef);
            // Only counts if the tier could actually have picked the other one.
            if (!spec.order.includes(other.split(':')[0])) continue;
            const mine = priceOf(chosenRef), theirs = priceOf(other);
            if (mine != null && theirs != null && theirs < mine) {
                wrong.push(`${tier}: leads with ${chosenRef} at $${mine}, but ${other} is the `
                    + `same model at $${theirs}`);
            }
        }
    }
    assert.deepStrictEqual(wrong, [],
        `a tier is paying a reseller for a model it could buy direct:\n  ${wrong.join('\n  ')}`);
});

test('the tier menu shows what an image costs', () => {
    // "Are we using the most cost-effective option" has to be answerable by
    // looking. The answer moves whenever a key is added, because a tier
    // resolves by credential — so it cannot live in documentation.
    const { tierMenu } = require('../lib/quality-tiers');
    for (const t of tierMenu({})) {
        if (!t.available) continue;
        assert.ok(typeof t.usd_per_image === 'number' && t.usd_per_image >= 0,
            `${t.label} resolves to ${t.resolves_to} but quotes no price`);
    }
});

test('a per-generation quality reaches the payload and the project keeps its own', () => {
    /*
     * The tier is a project setting, which is the right default and the wrong
     * granularity for the moment that matters: a director looking at one frame
     * that came back wrong wants to spend more on THAT frame, and one trying
     * three compositions wants to spend less — neither wants to change a
     * setting and remember to put it back.
     *
     * So the override must reach the request AND leave the project alone.
     * Half of that is worse than neither: an override that silently rewrote
     * the project would shoot the rest of the board on whatever the last
     * difficult shot needed.
     */
    const { withTierModel } = require('../lib/capability-payloads');
    const adapter = providers.get('meshy');
    const project = { id: 'p1', provider_config: JSON.stringify({ image: 'meshy', image_quality: 'draft' }) };
    const before = project.provider_config;

    const standing = withTierModel({ prompt: 'x' }, { project }, adapter);
    const overridden = withTierModel({ prompt: 'x' },
        { project, tierOverride: { image_quality: 'precision' } }, adapter);

    assert.strictEqual(standing.model, 'nano-banana', 'the project tier did not apply');
    assert.strictEqual(overridden.model, 'nano-banana-pro', 'the per-call override did not reach the payload');
    assert.strictEqual(project.provider_config, before,
        'the override rewrote the project, so the next frame would inherit it');
});

test('no shared image payload names a model', () => {
    /*
     * IMAGE_DEFAULTS pre-set a local checkpoint name none of these providers
     * offers. Two consequences, and the second is the one that hid the first:
     * every provider fell through to its own default (nano-banana-pro on Meshy,
     * the most expensive model it sells), and withTierModel returns early when
     * a payload already names a model — so the quality tier was INERT on the
     * main board path while the picker showed three choices.
     */
    const { IMAGE_DEFAULTS } = require('../lib/capability-payloads');
    assert.ok(!('model' in IMAGE_DEFAULTS),
        `the shared image defaults name "${IMAGE_DEFAULTS.model}", which makes every quality tier a no-op`);
});

test('a per-generation quality moves the provider as well as the model', () => {
    /*
     * Both halves, together. The model alone is not enough: Draft's model lives
     * on BFL and Precision's on Google, so an override that changed the model
     * without changing which adapter is called would name a BFL model on a
     * Google request — which is a rejected call, and one that fails for a
     * reason resembling nothing the director did.
     *
     * Written after getting exactly this wrong while checking by hand: the
     * adapter was resolved from the project's config while the payload was
     * built with the override, which is a combination the route never produces.
     */
    const { withTierModel } = require('../lib/capability-payloads');
    const { spendContext } = require('../lib/provider-config');
    const { db } = require('../db/database');
    const crypto2 = require('crypto');

    const id = crypto2.randomUUID();
    db.prepare('INSERT INTO film_projects (id, title, provider_config) VALUES (?, ?, ?)')
        .run(id, 'tier override', JSON.stringify({ image_quality: 'precision' }));
    for (const p of ['bfl', 'google', 'meshy']) {
        db.prepare(`INSERT INTO film_provider_credentials (provider, api_key, meta) VALUES (?, 'k', '{}')
                    ON CONFLICT(provider) DO UPDATE SET api_key = excluded.api_key`).run(p);
    }
    const project = db.prepare('SELECT * FROM film_projects WHERE id = ?').get(id);

    const resolveBoth = override => {
        const cfg = spendContext(project, null, null, override);
        const adapter = providers.get(providers.resolveId('image', cfg));
        const payload = withTierModel({ prompt: 'x' }, { project, tierOverride: override }, adapter);
        return `${adapter.id}/${payload.model}`;
    };

    const seen = {
        standing: resolveBoth(null),
        draft: resolveBoth({ image_quality: 'draft' }),
        standard: resolveBoth({ image_quality: 'standard' }),
    };
    assert.notStrictEqual(seen.draft, seen.standing,
        'overriding the quality changed nothing about the request');
    assert.strictEqual(new Set(Object.values(seen)).size, 3,
        `three different qualities produced fewer than three different requests: ${JSON.stringify(seen)}`);
    for (const [tier, pair] of Object.entries(seen)) {
        const [provider, model] = pair.split('/');
        assert.ok(model && model !== 'undefined',
            `${tier} resolved to ${provider} with no model, so the provider picks its own default`);
    }
});

test('the Meshy image rates match what Meshy publishes', () => {
    /*
     * These were wrong, and the wrongness was invisible: nano-banana-2 was
     * priced at 3 credits when Meshy's own page says SIX. That halved the
     * apparent cost of the tier most of a board is generated on, and it put a
     * reseller in front of buying the identical model from Google direct — a
     * routing decision taken on a number nobody had checked.
     *
     * Pinned to the published credit counts rather than to dollars, because the
     * dollar value of a credit is NOT published and is a per-plan assumption.
     */
    const { rateFor } = require('../lib/provider-pricing');
    const PUBLISHED_CREDITS = {
        'nano-banana': 3,
        'nano-banana-2': 6,
        'nano-banana-pro': 9,
        'gpt-image-2': 9,
        // Image-to-image is dearer for gpt-image-2 only, and board generation
        // always attaches references — so this is the path a real frame takes.
        'gpt-image-2-i2i': 12,
    };
    const wrong = [];
    for (const [model, credits] of Object.entries(PUBLISHED_CREDITS)) {
        const rate = rateFor('meshy', 'image', model);
        if (!rate) { wrong.push(`${model}: unpriced`); continue; }
        if (rate.native_per_unit !== credits) {
            wrong.push(`${model}: priced at ${rate.native_per_unit} credits, Meshy publishes ${credits}`);
        }
    }
    assert.deepStrictEqual(wrong, [], wrong.join('; '));

    // And the meter must reach the dearer entry when references travel, or the
    // rate exists and nothing ever selects it.
    const providersReg = require('../lib/providers');
    const meshy = providersReg.get('meshy');
    assert.strictEqual(meshy.meter('image', { model: 'gpt-image-2' }, null).model, 'gpt-image-2');
    assert.strictEqual(
        meshy.meter('image', { model: 'gpt-image-2', reference_images: ['a'] }, null).model,
        'gpt-image-2-i2i',
        'a referenced generation is metered at the text-to-image price');
});

test('every Meshy image model can deliver a widescreen frame', () => {
    /*
     * gpt-image-2 was listed as 1:1/3:2/2:3, so a 16:9 project snapped to
     * SQUARE on that model — a widescreen film boarded in a format it does not
     * ship in, with nothing said. Meshy documents 16:9 and 9:16 for it.
     */
    const meshy = require('../lib/providers/meshy');
    const snap = meshy.snapMeshyRatio || meshy._internal.snapMeshyRatio;
    const models = meshy.IMAGE_MODELS || meshy._internal.IMAGE_MODELS;
    const wrong = [];
    for (const model of models) {
        if (snap('16:9', model) !== '16:9') wrong.push(`${model}: 16:9 snaps to ${snap('16:9', model)}`);
        if (snap('9:16', model) !== '9:16') wrong.push(`${model}: 9:16 snaps to ${snap('9:16', model)}`);
    }
    assert.deepStrictEqual(wrong, [],
        `a widescreen project would be boarded square: ${wrong.join('; ')}`);
});

test('a provider receipt beats our rate book, and says which it was', () => {
    /*
     * Every figure in the spend report is our reading of a published price
     * list. That reading was wrong about nano-banana-2 by a factor of two for
     * days, and nothing could have noticed — a rate book cannot check itself.
     *
     * Meshy publishes a credit balance, so a generation can report what it
     * ACTUALLY cost. Where it does, that number wins, and the fact that it was
     * confirmed travels with it: "we measured $41" and "we think it was about
     * $41" are different claims and only one is defensible.
     */
    const { priceUsage } = require('../lib/provider-pricing');

    const book = priceUsage({ provider: 'meshy', capability: 'image',
        model: 'nano-banana', unit: 'call', quantity: 1 });
    assert.strictEqual(book.native_quantity, 3, 'the book no longer prices nano-banana at 3 credits');
    assert.strictEqual(book.provider_confirmed, false, 'a book figure claims to be confirmed');

    // A receipt that DISAGREES must be recorded as the receipt says, not
    // reconciled to the book — a disagreement means the book has drifted, and
    // smoothing it over is how the drift survives.
    const receipt = priceUsage({ provider: 'meshy', capability: 'image',
        model: 'nano-banana', unit: 'call', quantity: 1, native_charged: 9, provider_confirmed: true });
    assert.strictEqual(receipt.native_quantity, 9, 'the receipt was overruled by the rate book');
    assert.ok(receipt.amount_usd > book.amount_usd, 'the dearer receipt priced no higher than the book');
    assert.strictEqual(receipt.provider_confirmed, true);

    // The meter has to actually produce that shape, or the pricing path is
    // reachable only from a test.
    const meshy = providers.get('meshy');
    const withReceipt = meshy.meter('image', { model: 'nano-banana' }, { native_charged: 3 });
    assert.strictEqual(withReceipt.native_charged, 3);
    assert.strictEqual(withReceipt.provider_confirmed, true);
    const without = meshy.meter('image', { model: 'nano-banana' }, null);
    assert.ok(!without.provider_confirmed, 'an unconfirmed call claims confirmation');
});

test('the usage meter forwards a receipt rather than dropping it', () => {
    // The adapter can read a real charge and the ledger still record our
    // estimate — the measurement taken and thrown away one function later.
    const src = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'lib', 'usage-meter.js'), 'utf8');
    const call = src.slice(src.indexOf('pricing.priceUsage({'));
    const body = call.slice(0, call.indexOf('});'));
    for (const field of ['native_charged', 'provider_confirmed']) {
        assert.ok(body.includes(field), `the meter drops ${field} before pricing`);
    }
});

test('a pinned model is checked against the provider that would run it', () => {
    /*
     * The Advanced model field was free text, and every image adapter here
     * falls back to its own default rather than refusing an unknown model. So a
     * typo — a trailing space, "nanobanana-pro", a model belonging to a
     * different provider — was stored, sent, and silently ignored, and Meshy's
     * default is its MOST expensive model. Invisible, and three times the price
     * the director thought they had chosen.
     *
     * Set-based over the image adapters: one that declares no model list cannot
     * be checked, and that is a gap worth naming rather than an exemption.
     */
    const image = providers.list().filter(a => (a.capabilities || []).includes('image'));
    const undeclared = image.filter(a => a.requiresKey && !a.models).map(a => a.id);
    assert.deepStrictEqual(undeclared, [],
        `these adapters declare no model list, so a pinned model cannot be validated `
        + `against them and a typo would be billed at their default: ${undeclared.join(', ')}`);

    // And the route must actually refuse one.
    const { handleProviders } = require('../routes/providers');
    const { db } = require('../db/database');
    const id = require('crypto').randomUUID();
    db.prepare('INSERT INTO film_projects (id, title, provider_config) VALUES (?, ?, ?)')
        .run(id, 'model pin', '{}');

    const res = { statusCode: 0, body: null, setHeader() {},
        end(b) { this.body = JSON.parse(b || '{}'); }, writeHead(c) { this.statusCode = c; } };
    handleProviders({ method: 'PUT', body: { config: { image: 'meshy', image_model: 'nanobanana-pro' } } },
        res, ['film', 'projects', id, 'providers'], {});
    assert.strictEqual(res.statusCode, 400, 'a model the provider does not offer was accepted');
    assert.ok(Array.isArray(res.body.available_models) && res.body.available_models.length,
        'the refusal does not say what IS available, so it cannot be acted on');

    // The real one still saves.
    const ok = { statusCode: 0, body: null, setHeader() {},
        end(b) { this.body = JSON.parse(b || '{}'); }, writeHead(c) { this.statusCode = c; } };
    handleProviders({ method: 'PUT', body: { config: { image: 'meshy', image_model: 'nano-banana' } } },
        ok, ['film', 'projects', id, 'providers'], {});
    assert.strictEqual(ok.body.config.image_model, 'nano-banana');
});

test('every Meshy image model is selectable, and an unknown one never reaches the provider', () => {
    /*
     * "Can I go into another project and use nano-banana-2 or nano-banana-pro?"
     *
     * Derived from the adapter's own list rather than typed here, so a model
     * Meshy adds later is covered or this fails.
     */
    const { withTierModel } = require('../lib/capability-payloads');
    const meshy = providers.get('meshy');
    const models = Object.keys(meshy.models);
    assert.ok(models.length >= 4, `expected Meshy's four image models, found ${models.length}`);

    for (const model of models) {
        const payload = withTierModel({ prompt: 'x' },
            { project: { id: 'p', provider_config: JSON.stringify({ image: 'meshy', image_model: model }) } },
            meshy);
        assert.strictEqual(payload.model, model,
            `pinning ${model} sent ${payload.model} instead`);
    }

    /*
     * And an unknown name must NOT travel. Every image adapter falls back to
     * its own default rather than refusing, and Meshy's default is its dearest
     * model — so a typo is silent and costs three times what was chosen.
     *
     * This was checked in two places and one undid the other: withTierModel
     * rejected the name and fell through to resolveTier, whose pinned branch
     * re-applied it unconditionally. Two checks with one cancelling the other
     * is worse than neither, because it reads as validated.
     */
    const typo = withTierModel({ prompt: 'x' },
        { project: { id: 'p', provider_config: JSON.stringify({ image: 'meshy', image_quality: 'standard', image_model: 'nanobanana-2' }) } },
        meshy);
    assert.ok(models.includes(typo.model),
        `an unknown pinned model reached the provider as "${typo.model}"`);

    const { resolveTier } = require('../lib/quality-tiers');
    const r = resolveTier('standard', { image: 'meshy', image_model: 'nanobanana-2' });
    assert.match(r.reason, /not one it offers/i,
        'the substitution is silent — a director would believe their pin applied');
});
