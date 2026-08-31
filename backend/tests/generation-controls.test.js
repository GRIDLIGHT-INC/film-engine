/**
 * Every dial a generation takes, on the dialog that spends the money
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "For each generation when the prompt pops up, I should be able to select
 * also the provider, quality that I'm asking, all the available details."
 *
 * The prompt preview was built first and the rest was left half-wired, in the
 * shape this codebase keeps repeating — declared in one place, consumed
 * nowhere:
 *
 *   - `imageOverride` accepts provider/model/quality and is read by ten route
 *     sites, so IMAGE generations were largely controllable.
 *   - VIDEO translated provider and model by hand in routes/video-gen.js and
 *     silently DROPPED quality: `o.image_quality` had no `video_quality`
 *     counterpart, so choosing a tier for a clip changed nothing and said
 *     nothing.
 *   - MUSIC, AMBIENT and MODEL3D read no override at all. Their confirmations
 *     showed a prompt and offered no choice whatever.
 *   - `VIDEO_TIERS` exists in lib/video-tiers.js and was served to nobody; the
 *     dialog fetched `image_tiers` regardless of what was being generated, so
 *     a video confirmation offered image tiers or none.
 *   - Size was offered nowhere, for anything.
 *
 * So the denominator is DERIVED: the capabilities behind the paid actions the
 * page actually exposes, crossed with the controls a generation can take. A
 * control that does not apply to a capability is NAMED as not applying, never
 * silently absent — that distinction is the whole difference between "this
 * generation has no tier" and "we forgot to wire the tier".
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-gc-' + crypto.randomUUID().slice(0, 8));

const ROOT = path.join(__dirname, '..');
const UI = fs.readFileSync(path.join(ROOT, '..', 'src', 'index.html'), 'utf8');

/**
 * The paid actions the page exposes, and what each one generates.
 * Kept in lockstep with paid-preview.test.js, which owns the list of controls
 * that spend money — this adds the capability each one spends it on.
 */
const PAID_CAPABILITY = {
    generateVideoFor: 'video',
    generateAllVideos: 'video',
    generateSequence: 'video',
    generateModelFor: 'model3d',
    generateAllModels: 'model3d',
    generateScoreFor: 'music',
    generateAmbientFor: 'ambient',
    refineFrame: 'image',
    generateLocationImage: 'image',
    generateCharacterImage: 'image',
    generatePropImage: 'image',
    sweepLocationCompass: 'image',
};

const CAPABILITIES = [...new Set(Object.values(PAID_CAPABILITY))].sort();

test('the paid-action list and this one describe the same set', () => {
    /*
     * Derived rather than transcribed: paid-preview.test.js owns which controls
     * spend money, and a control added there without a capability here would
     * silently get no dials at all.
     */
    const src = fs.readFileSync(path.join(__dirname, 'paid-preview.test.js'), 'utf8');
    const block = src.match(/const PAID_ACTIONS = \[([\s\S]*?)\];/);
    assert.ok(block, 'PAID_ACTIONS is gone from paid-preview.test.js');
    const listed = [...block[1].matchAll(/'([A-Za-z_$][\w$]*)'/g)].map(m => m[1]);

    const missing = listed.filter(n => !PAID_CAPABILITY[n]);
    assert.deepStrictEqual(missing, [],
        `these paid actions have no capability declared here, so nothing checks that their `
        + `confirmation offers any control: ${missing.join(', ')}`);
});

test('the override translates to the right config keys for EVERY capability', () => {
    /*
     * The bug this replaces: video translated provider and model by hand and
     * dropped quality, and three capabilities translated nothing. A per-
     * capability translator written at each call site is how they came to
     * disagree.
     */
    const { generationOverride } = require('../lib/generation-override');

    for (const cap of CAPABILITIES) {
        const out = generationOverride(cap, { provider: 'acme', model: 'm-1', quality: 'draft' });
        assert.ok(out, `${cap}: an explicit provider/model/quality produced no override at all`);
        assert.strictEqual(out[cap], 'acme',
            `${cap}: the chosen provider was written to ${JSON.stringify(Object.keys(out))} `
            + `rather than to "${cap}" — resolve() reads the capability's own key, so the `
            + 'choice reaches nothing');
        assert.strictEqual(out[`${cap}_model`], 'm-1',
            `${cap}: the chosen model did not reach ${cap}_model`);
    }
});

test('a quality tier is honoured where one exists, and named where it does not', () => {
    const { generationOverride, TIERS_FOR } = require('../lib/generation-override');

    for (const cap of CAPABILITIES) {
        const tiers = TIERS_FOR[cap];
        const out = generationOverride(cap, { quality: 'draft' });

        /*
         * DERIVED from the engine, not from TIERS_FOR itself. Asserting only
         * "if TIERS_FOR says there are tiers then they are honoured" lets a
         * capability be quietly demoted to null and pass — caught by mutation,
         * which is exactly how video quality was dropped in the first place.
         */
        const registryFile = { image: 'quality-tiers', video: 'video-tiers' }[cap];
        if (registryFile) {
            assert.ok(tiers,
                `${cap}: lib/${registryFile}.js defines tiers for it and TIERS_FOR says it has `
                + 'none — the choice reaches nothing and nothing says so');
        }

        if (tiers) {
            assert.ok(out && out[`${cap}_quality`],
                `${cap} has a tier registry and a chosen tier reached nothing — this is exactly `
                + 'how video quality was silently dropped');
        } else {
            /*
             * NAMED, not silently absent. "This capability has no tiers" and
             * "we forgot to wire the tiers" look identical from the outside,
             * and only one of them is a decision.
             */
            assert.ok(Object.prototype.hasOwnProperty.call(TIERS_FOR, cap),
                `${cap} is not in TIERS_FOR at all — a capability with no tiers must say so`);
        }
    }
});

test('an unknown tier is refused rather than passed through', () => {
    const { generationOverride } = require('../lib/generation-override');
    const out = generationOverride('image', { quality: 'ultra-max' });
    assert.ok(!out || !out.image_quality,
        'an invented tier was accepted and forwarded — it reaches the resolver, matches nothing, '
        + 'and the generation silently runs at the default while the dialog says otherwise');
});

test('the options a dialog offers are SERVED, never typed into the page', () => {
    /*
     * The card-vocabulary rule. A page holding its own list of providers or
     * tiers offers choices the resolver refuses, and the refusal reads as the
     * generation being broken.
     */
    const { generationOptions } = require('../lib/generation-override');

    for (const cap of CAPABILITIES) {
        const opts = generationOptions(cap);
        assert.ok(opts, `${cap}: no options served at all`);
        assert.ok(Array.isArray(opts.providers) && opts.providers.length,
            `${cap}: no providers offered, so the dialog can only show a project default`);

        for (const p of opts.providers) {
            assert.ok(p.id && typeof p.configured === 'boolean',
                `${cap}: a provider entry is missing its id or its credential state — an `
                + 'uncredentialed generator must be shown and marked, not hidden, or the dialog '
                + 'answers "which should I use" while withholding half the answer');
        }

        // Tiers: a list, or an explicit null with a reason.
        assert.ok(Array.isArray(opts.tiers) || opts.tiers === null,
            `${cap}: tiers is neither a list nor an explicit null`);
        if (opts.tiers === null) {
            assert.ok(opts.tiers_note,
                `${cap}: has no tiers and does not say why, so it is indistinguishable from a `
                + 'capability whose tiers were never wired');
        }

        // Size: same rule.
        assert.ok(Array.isArray(opts.sizes) || opts.sizes === null,
            `${cap}: sizes is neither a list nor an explicit null`);
        if (opts.sizes === null) {
            assert.ok(opts.sizes_note, `${cap}: has no sizes and does not say why`);
        }
    }
});

test('images can be asked for at a specific size, up to 2K', () => {
    /*
     * "Say I want to use 2K images." Offered per generation, because a
     * director trying one hero frame larger should not have to change a
     * project setting and change it back.
     */
    const { generationOptions, generationOverride } = require('../lib/generation-override');

    const sizes = generationOptions('image').sizes;
    assert.ok(Array.isArray(sizes) && sizes.length,
        'no image sizes are offered, so the size of a generation cannot be chosen at all');
    assert.ok(sizes.some(s => Number(s.width) >= 2048 || /2K/i.test(String(s.label))),
        `no 2K option among ${sizes.map(s => s.label || s.id).join(', ')}`);

    const pick = sizes.find(s => Number(s.width) >= 2048) || sizes[sizes.length - 1];
    const out = generationOverride('image', { size: pick.id });
    assert.ok(out && (out.image_size || out.width),
        `choosing the size "${pick.id}" reached nothing — the dialog would show a size and `
        + 'generate at the project default');
});

test('every capability behind a paid action reads an override in its route', () => {
    /*
     * Derived from the ROUTE SOURCE, because a translator nothing calls is the
     * same as no translator. Music, ambient and model3d read none at all: their
     * confirmations offered a prompt and no choice whatever.
     */
    const ROUTE_FOR = {
        image: ['storyboard.js', 'locations.js', 'characters.js'],
        video: ['video-gen.js'],
        music: ['music-gen.js'],
        ambient: ['music-gen.js'],
        model3d: ['threed.js'],
    };

    for (const cap of CAPABILITIES) {
        const files = ROUTE_FOR[cap] || [];
        assert.ok(files.length, `${cap}: no route declared for it here`);
        /*
         * Bound to the RESOLUTION call rather than to the identifier appearing
         * somewhere in the file. A mutation that stubbed the import
         * (`const generationOverride = () => null`) still contained the name
         * and passed, while every choice was silently discarded.
         */
        const reads = files.some(f => {
            const p = path.join(ROOT, 'routes', f);
            if (!fs.existsSync(p)) return false;
            const src = fs.readFileSync(p, 'utf8')
                .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
            // the override must reach a provider resolution for THIS capability
            const overlay = new RegExp(
                `resolve(?:Generator|Id)?\\(\\s*['"\`]${cap}['"\`][^)]*(?:Override|override)`);
            const threaded = new RegExp(`spendContext\\([^;]*?${cap}[^;]*?[Oo]verride`);
            return overlay.test(src) || threaded.test(src)
                || /generationOverride\(\s*['"`]/.test(src);
        });
        assert.ok(reads,
            `${cap}: none of ${files.join(', ')} passes a per-generation override into provider `
            + 'resolution, so the provider and quality chosen in the dialog are discarded');
    }
});

test('the dialog fetches options for the capability being generated', () => {
    /*
     * It fetched `.image_tiers` unconditionally, so a video confirmation
     * offered image tiers or none at all — the controls were there and were
     * about the wrong thing.
     */
    const at = UI.indexOf('async function confirmExtras(');
    assert.ok(at > -1, 'confirmExtras is gone — this test cannot see how the dialog is built');
    /*
     * Comments stripped first. The comment explaining this fix names
     * `.image_tiers`, so an unstripped check reports the file that fixes the
     * bug as having the bug -- the trap the headline-plate work already paid
     * for. Line-based, because a `/*` inside a string opens a comment that runs
     * to the next close and eats real code.
     */
    const body = UI.slice(at, UI.indexOf('\n    }', at))
        .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    assert.ok(!/\.image_tiers/.test(body),
        'the confirmation still reads .image_tiers regardless of what is being generated, so a '
        + 'video or music confirmation shows image tiers or nothing');
    assert.match(body, /capability/,
        'the confirmation does not consult the capability at all when building its controls');
});

test('a provider that names its models offers them, by the name a director uses', () => {
    /*
     * Adapters declare models two ways: Google holds MODELS as an OBJECT keyed
     * by id -- so a typo is a refusal here rather than a paid request that
     * comes back as something else -- while others use a list. Assuming an
     * array served Google's three as null, and Nano Banana Pro, the only one a
     * director would deliberately ask for by name, was unreachable.
     *
     * Set-based over every adapter that declares models at all.
     */
    const { generationOptions } = require('../lib/generation-override');
    const providers = require('../lib/providers');

    let checked = 0;
    for (const cap of CAPABILITIES) {
        const served = generationOptions(cap).providers;
        for (const p of served) {
            const adapter = providers.list().find(a => a.id === p.id);
            if (!adapter) continue;
            /*
             * PER CAPABILITY. This compared against the adapter's single flat
             * `models`, which was the right question only while no adapter
             * served two capabilities with different models. Meshy declares four
             * IMAGE models and two MESH ones, and the flat count made serving
             * the correct two look like a shortfall of two.
             */
            const declaredModels = providers.modelsFor(adapter, cap);
            if (!declaredModels) continue;
            checked++;
            const declared = Array.isArray(declaredModels)
                ? declaredModels.length : Object.keys(declaredModels).length;
            assert.ok(Array.isArray(p.models) && p.models.length === declared,
                `${cap}/${p.id}: declares ${declared} models and serves `
                + `${p.models ? p.models.length : 'null'} — a picker cannot offer what it is not sent`);
            for (const m of p.models) {
                assert.ok(m.id && m.label,
                    `${cap}/${p.id}: a model is served without an id or a label; a raw id on a `
                    + 'button is not a name a director recognises');
            }
        }
    }
    assert.ok(checked > 0, 'no adapter declares models — this test is checking nothing');
});

test('Nano Banana Pro is reachable, and it is the model that does 2K', () => {
    /*
     * Named specifically because it was asked for specifically, and because the
     * DEFAULT is Nano Banana 2 — so reaching Pro requires the model picker to
     * exist. Without it, choosing Google gets you the flash model whatever the
     * dialog said.
     */
    const { generationOptions, generationOverride } = require('../lib/generation-override');
    const google = generationOptions('image').providers.find(p => p.id === 'google');
    assert.ok(google, 'google is not offered as an image generator at all');

    const pro = (google.models || []).find(m => /pro/i.test(m.label) || m.id === 'gemini-3-pro-image');
    assert.ok(pro, `Nano Banana Pro is not among ${(google.models || []).map(m => m.label).join(', ')}`);
    assert.ok((pro.sizes || []).includes('2K'),
        `${pro.label} does not offer 2K — it declares ${(pro.sizes || []).join('/')}`);

    // And choosing it reaches the resolver on the image key.
    const out = generationOverride('image', { provider: 'google', model: pro.id, size: '2k' });
    assert.strictEqual(out.image, 'google', 'the provider choice did not reach the image key');
    assert.strictEqual(out.image_model, pro.id, 'the model choice did not reach image_model');
    assert.ok(out.width >= 2048, `a 2K request resolved to ${out.width}px wide`);
});

test('the dialog can actually offer a model, not just carry one', () => {
    /*
     * CONFIRM_GEN_MODEL was declared and sent in confirmChoices while nothing
     * on the page ever set it — the declared-and-unconsumed shape, one level
     * up from the payload bugs it usually appears in.
     */
    assert.match(UI, /function pickGenModel\s*\(/,
        'there is no control that sets a model, so a director can choose a generator and never '
        + 'the model on it — and on Google the default is Nano Banana 2, not Pro');
    assert.match(UI, /paintGenModels\s*\(/,
        'nothing repaints the model list when a generator is chosen');
    const at = UI.indexOf('function pickGenerator(');
    const body = UI.slice(at, UI.indexOf('\n    }', at));
    assert.match(body, /paintGenModels/,
        'choosing a generator does not refresh the model list, so it shows another provider\'s '
        + 'models — choices the resolver refuses');
});
