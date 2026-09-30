/**
 * Any connected provider on every generate dialog, its own options drawn, and
 * both in what is sent.
 *
 * "I pressed generate for a shot node on the production side; on the modal I
 * should be able to select any provider who has been connected, and on this
 * modal the options for that provider would show. Once I click generate these
 * options along with the prompt would be passed in the payload to the
 * endpoint. This is what I'm looking for for any generate button."
 *
 * Set-based over every (capability, provider) the registry serves, derived from
 * providers.list(), so an adapter added later arrives with its options or is
 * named as offering none:
 *   - every option a provider offers REACHES its request: set it, and the body
 *     the adapter would send changes (a control that reaches nothing is the
 *     failure this codebase keeps paying for);
 *   - a value outside the provider's own vocabulary is refused by name;
 *   - the dialog's choice travels: override -> config -> resolve()'s funnel,
 *     applied only to the provider it was chosen for, never to a fallback;
 *   - a size chosen for one image reaches the payload (it reached nothing);
 *   - the page draws the pickers on EVERY dialog, read-only prompt or not, the
 *     shot node's Generate included, and every send carries the choices.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const providers = require('../lib/providers');
const go = require('../lib/generation-options');
const { generationOverride, imageOverride, generationOptions } = require('../lib/generation-override');
const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** What each adapter would send, from its own pure builder. */
const BUILD = {
    'image:muapi': p => require('../lib/providers/muapi-image').buildImageRequest(p).body,
    'image:google': p => require('../lib/providers/google-image').buildImageRequest(p),
    'image:meshy': p => require('../lib/providers/meshy').buildImageRequest(p),
    'image:runway': p => require('../lib/providers/runway').buildImageRequest(p),
    'image:openai': p => require('../lib/providers/openai-image').buildImageRequest(p),
    // The local gateway posts the payload as its body.
    'image:gridlight': p => p,
    'voice:elevenlabs': p => require('../lib/providers/elevenlabs').buildVoiceRequest(p),
    'sfx:elevenlabs': p => require('../lib/providers/elevenlabs').buildSfxRequest(p),
    'ambient:elevenlabs': p => require('../lib/providers/elevenlabs').buildAmbientRequest(p),
    'music:elevenlabs': p => require('../lib/providers/elevenlabs').buildMusicRequest(p),
    'model3d:meshy': p => require('../lib/providers/meshy').buildRequest(p),
};

const BASE = {
    image: () => ({ prompt: 'a quiet street at dusk', width: 1920, height: 1080 }),
    voice: () => ({ text: 'Get inside.', voice_id: 'abc' }),
    sfx: () => ({ prompt: 'a screen door', duration_s: 3 }),
    ambient: () => ({ prompt: 'crickets and a highway', duration_s: 20 }),
    music: () => ({ prompt: 'sparse piano', duration_s: 30 }),
    model3d: () => ({ operation: 'text_to_mesh', prompt: 'an old lamp post' }),
};

/** Values that differ from the provider's default, per control. */
function candidates(c) {
    if (c.type === 'choice') return c.choices.map(x => x.id);
    if (c.type === 'decimal') return [c.max, c.min];
    if (c.type === 'toggle') return c.default === true ? [false] : c.default === false ? [true] : [true, false];
    if (c.type === 'number') return [12345];
    if (c.type === 'text') return ['zebra stripes'];
    return [];
}

const PAIRS = [];
for (const a of providers.list()) {
    for (const cap of (a.capabilities || [])) {
        if (['video', 'llm', 'lipsync', 'post', 'world'].includes(cap)) continue;
        PAIRS.push([cap, a.id]);
    }
}

test('every (capability, provider) either offers options or is named as offering none', () => {
    assert.ok(PAIRS.length >= 10, `too few pairs derived: ${PAIRS.length}`);
    for (const [cap, id] of PAIRS) {
        const spec = go.controlsFor(cap, id);
        if (!spec) continue;               // stated: this provider offers nothing here
        assert.ok(BUILD[`${cap}:${id}`], `${cap} on ${id} offers options and the test has no builder for it`);
        assert.ok(spec.source, `${cap} on ${id}: options name no source`);
    }
});

test('every option a provider offers changes the request it would send', () => {
    let checked = 0;
    for (const [cap, id] of PAIRS) {
        const spec = go.controlsFor(cap, id);
        if (!spec) continue;
        const build = BUILD[`${cap}:${id}`];
        const plain = JSON.stringify(build(BASE[cap]()));
        for (const c of spec.controls) {
            const changed = candidates(c).some(v => {
                const p = BASE[cap]();
                const { values, refused } = go.readChosen(cap, id, null, { [c.key]: v });
                assert.deepEqual(refused, [], `${cap}/${id}/${c.key}=${v} was refused`);
                go.applyValues(cap, id, p, values);
                return JSON.stringify(build(p)) !== plain;
            });
            assert.ok(changed, `${cap} on ${id}: "${c.label}" reaches nothing in the request`);
            checked++;
        }
    }
    assert.ok(checked >= 20, `only ${checked} options were checked`);
});

test('a value outside the provider\'s vocabulary is refused by name', () => {
    const r = go.readChosen('image', 'muapi', null, { frame: '7:3', invented: 1 });
    assert.equal(Object.keys(r.values).length, 0);
    assert.ok(r.refused.some(x => /frame: 7:3 is not one of/.test(x)));
    assert.ok(r.refused.some(x => /invented: .* does not take this/.test(x)));
    const v = go.readChosen('voice', 'elevenlabs', null, { speed: 3 });
    assert.ok(v.refused.some(x => /speed: 3 is outside 0.7/.test(x)));
});

test('a chosen MuAPI frame is the ratio MuAPI receives, not a snap of the width and height', () => {
    const p = BASE.image();
    go.applyValues('image', 'muapi', p, { frame: '4:5' });
    const body = require('../lib/providers/muapi-image').buildImageRequest(p).body;
    assert.equal(body.aspect_ratio, '4:5');
    assert.ok(p.height > p.width, 'the payload took the chosen shape');
});

test('the dialog\'s choice travels: override, then the funnel, only on the provider it was chosen for', () => {
    const o = generationOverride('voice', { provider: 'elevenlabs', options: { stability: 0.2 } });
    assert.deepEqual(o.voice_options, { provider: 'elevenlabs', values: { stability: 0.2 } });

    const img = imageOverride({ provider: 'muapi', size: '4k_uhd', options: JSON.stringify({ frame: '1:1' }) });
    assert.equal(img.image, 'muapi');
    assert.equal(img.image_options.provider, 'muapi');
    assert.match(img.image_target_resolution, /^\d+x\d+$/);

    // Options without a provider named follow `options_provider` (the project's own).
    const d = generationOverride('music', { options: { vocals: true }, options_provider: 'elevenlabs' });
    assert.equal(d.music_options.provider, 'elevenlabs');

    const onIt = { width: 1920, height: 1080 };
    go.applyChosen('image', img, 'muapi', onIt);
    assert.equal(onIt.aspect_ratio, '1:1', 'applied to the provider it was chosen for');
    const fallback = { width: 1920, height: 1080 };
    go.applyChosen('image', img, 'google', fallback);
    assert.equal(fallback.aspect_ratio, undefined, 'a fallback does not inherit another vendor\'s switches');
    assert.ok(Math.max(fallback.width, fallback.height) > 1920, 'but the chosen size holds on any provider');

    // Video is left to its routes (lib/model-options.js).
    assert.equal(generationOverride('video', { provider: 'runway', options: { duration: 5 } }).video_options, undefined);
});

test('resolve()\'s funnel applies the choice to the payload an adapter receives', async () => {
    let seen = null;
    const fake = {
        id: 'optfake', label: 'Opt fake', kind: 'generator', capabilities: ['image'], requiresKey: false,
        supports: c => c === 'image', generate: async (cap, payload) => { seen = { ...payload }; return { ok: true, data: 'x' }; },
    };
    providers.register(fake);
    const orig = go.controlsFor;
    try {
        const cfg = { image: 'optfake', image_target_resolution: '3840x2160',
            image_options: { provider: 'optfake', values: { frame: '1:1' } } };
        await providers.resolve('image', cfg).generate('image', { prompt: 'p', width: 1920, height: 1080 });
        assert.ok(seen, 'the fake adapter was reached');
        assert.equal(seen.width, 3840, 'the size chosen for this one reached the adapter');
    } finally { go.controlsFor = orig; }
});

test('the options are served with each provider, for the dialog to draw', () => {
    for (const cap of ['image', 'voice', 'model3d']) {
        const g = generationOptions(cap);
        const withOptions = g.providers.filter(p => Array.isArray(p.options) && p.options.length);
        assert.ok(withOptions.length, `${cap}: no provider serves options`);
        for (const p of withOptions) {
            const spec = go.controlsFor(cap, p.id, p.default_model);
            assert.deepEqual(p.options.map(c => c.key), spec.controls.map(c => c.key), `${cap}/${p.id}`);
        }
    }
});

/** A function's source, bounded by brace depth from its declaration. */
function fnBody(name) {
    const at = SPA.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
    assert.ok(at >= 0, `${name} is not in the page`);
    let i = SPA.indexOf('(', at), p = 0;
    for (; i < SPA.length; i++) { if (SPA[i] === '(') p++; else if (SPA[i] === ')' && --p === 0) break; }
    i = SPA.indexOf('{', i);
    let d = 0;
    for (let j = i; j < SPA.length; j++) {
        if (SPA[j] === '{') d++;
        else if (SPA[j] === '}' && --d === 0) return SPA.slice(at, j + 1);
    }
    return SPA.slice(at);
}

test('every dialog draws the provider pickers, read-only prompt or not', () => {
    const paid = fnBody('confirmPaidImage');
    assert.match(paid, /confirmPickers\(/, 'confirmPaidImage builds the pickers');
    // The pickers sit OUTSIDE the editable branch: a clip's read-only prompt
    // hid them, so no video dialog could choose its generator.
    const tpl = paid.slice(paid.indexOf('body.innerHTML = `'));
    assert.ok(tpl.indexOf('${pickers}') >= 0 && tpl.indexOf('${pickers}') < tpl.indexOf("o.editable === false"),
        'the pickers are drawn before, not inside, the editable branch');
    assert.match(paid, /\.\.\.confirmChoices\(\)/, 'confirmPaidImage sends every choice');
});

test('the shot node\'s Generate has the same pickers and sends what was picked', () => {
    assert.match(fnBody('confirmGeneration'), /confirmPickers\('image'\)/);
    assert.match(fnBody('confirmGeneration'), /paintGenOptions\(\)/);
    assert.match(fnBody('regenerateStoryboard'), /\.\.\.confirmChoices\(\)/);
    // The graph's shot node reaches the board's own regenerate, and so its dialog.
    assert.match(fnBody('pgRunNode'), /n\.type === 'shot'\) return pgBusy\([^;]*regenerateStoryboard\(n\.id\)/);
});

test('the sound node\'s Generate draws the pickers and sends the choices', () => {
    const snd = fnBody('pgGenerateSound');
    assert.doesNotMatch(snd, /describe:/, 'a describe-only dialog draws no pickers');
    assert.match(snd, /send: async choices/);
    assert.match(snd, /JSON\.stringify\(choices/);
});

test('the choices carry the provider\'s options and whom they are for', () => {
    const c = fnBody('confirmChoices');
    assert.match(c, /options: \{ \.\.\.chosenOptions \}/);
    assert.match(c, /options_provider/);
    const paint = fnBody('paintGenOptions');
    assert.match(paint, /CONFIRM_GEN_PROVIDER \|\| CONFIRM_GEN_DEFAULT/, 'before a pick, the project\'s own provider\'s options are drawn');
    for (const t of ['choice', 'decimal', 'toggle', 'number', 'text']) {
        assert.match(fnBody('genOptionsHtml'), new RegExp(`c\\.type === '${t}'`), `no control for ${t}`);
    }
});

test('a clip picked for a provider is not sent, priced or described as another provider\'s model', () => {
    const { applyTier } = require('../routes/video-gen');
    const production = require('../lib/video-tiers').resolveVideoTier('production');
    assert.ok(production.preferredModel, 'the production tier prefers a model');
    const reg = require('../lib/providers');
    // The tier's model stays where its provider offers it...
    const home = reg.list().find(a => (reg.modelIdsFor(a, 'video') || []).includes(production.preferredModel));
    assert.ok(home, 'some provider offers the tier model');
    assert.equal(applyTier(production, { body: {} }, null, null, home.id).model, production.preferredModel);
    // ...and is dropped on every video provider that does not.
    for (const a of reg.list().filter(x => (x.capabilities || []).includes('video'))) {
        if ((reg.modelIdsFor(a, 'video') || []).includes(production.preferredModel)) continue;
        assert.equal(applyTier(production, { body: {} }, null, null, a.id).model, undefined,
            `${a.id} would be sent ${production.preferredModel}, a model it does not sell`);
    }
    // A model somebody chose still wins.
    assert.equal(applyTier(production, { body: { model: 'seedance-2.5-4k' } }, null, null, 'seedance').model, 'seedance-2.5-4k');
});
