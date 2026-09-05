/**
 * A resolution that reaches nothing is worse than no resolution.
 *
 * Measured: a prop plate came back 1376x768 on a project set to 2048x1080.
 * The size calculation was correct and the provider never saw it — Meshy's
 * text-to-image accepts `ai_model`, `prompt`, `aspect_ratio`,
 * `generate_multi_view`, `pose_mode` and `remove_background`, and NO width,
 * height, size or quality. The adapter turns a requested width and height into
 * an aspect ratio because that is the only thing the API has to put it in.
 *
 * So "the project's delivery size" is not one behaviour, it is three:
 *
 *   exact       the adapter sends pixels and gets them          bfl, google, openai
 *   snapped     it sends a pixel pair from a fixed list         runway
 *   ratio-only  the provider decides the pixels entirely        meshy, gridlight
 *
 * Set-based over the image adapters, because the whole failure is that one
 * subset behaves differently from the rest and nothing said so. Worse, the 2K
 * location floor shipped REPORTING SUCCESS on a ratio-only provider — a floor
 * that cannot be honoured and says it was is the one outcome worse than not
 * having a floor.
 */

const test = require('node:test');
const assert = require('node:assert');

const providers = require('../lib/providers');
const { plateImageSize, LOCATION_MIN_EDGE } = require('../lib/reference-plates');

const CONTROLS = ['exact', 'snapped', 'ratio-only'];

function imageAdapters() {
    return providers.list().filter(a => (a.capabilities || []).includes('image'));
}

test('every image adapter declares what it does with a requested size', () => {
    /*
     * Declared, never inferred — the same rule promptLimit, maxReferenceImages
     * and referenceMode already follow. An adapter that declares nothing gets
     * the STRICTEST reading, because over-promising is what produced a
     * confident 2048x1152 that arrived as 1376x768.
     */
    const undeclared = [];
    for (const a of imageAdapters()) {
        if (!a.sizeControl) { undeclared.push(a.id); continue; }
        assert.ok(CONTROLS.includes(a.sizeControl),
            `${a.id}: sizeControl "${a.sizeControl}" is not one of ${CONTROLS.join(', ')}`);
        assert.ok(a.sizeControlReason && a.sizeControlReason.length > 25,
            `${a.id}: declares "${a.sizeControl}" with no reason — the next reader cannot check it`);
    }
    assert.deepStrictEqual(undeclared, [],
        `these say nothing about whether a requested size reaches them: ${undeclared.join(', ')}`);
});

test('the declaration matches what the adapter actually sends', () => {
    /*
     * Derived from the source, because a declaration nobody checks is a
     * comment. An adapter claiming `exact` must put pixels in its body; one
     * claiming `ratio-only` must not pretend to.
     */
    const fs = require('fs');
    const path = require('path');
    const FILES = {
        meshy: 'meshy.js', runway: 'runway.js', openai: 'openai-image.js',
        google: 'google-image.js', bfl: 'bfl-image.js', gridlight: 'gridlight-adapter.js',
    };
    const wrong = [];
    for (const a of imageAdapters()) {
        const file = FILES[a.id];
        if (!file) continue;
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'providers', file), 'utf8');
        const sendsPixels = /body\.(width|height|size|image_size)\s*=|"size":|\bsize:\s/.test(src);
        if (a.sizeControl === 'exact' && !sendsPixels) {
            wrong.push(`${a.id} claims exact and sends no pixel dimensions`);
        }
        if (a.sizeControl === 'ratio-only' && sendsPixels) {
            wrong.push(`${a.id} claims ratio-only and does send pixel dimensions`);
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  ${wrong.join('\n  ')}`);
});

test('a ratio-only provider never claims the 2K floor was met', () => {
    /*
     * THE BUG THIS FILE EXISTS FOR.
     *
     * The floor computed 2048x1152 for Meshy, saw it under Meshy's ceiling,
     * and reported below_floor: false — on the provider both real projects
     * use, where the number is discarded into an aspect ratio and the plate
     * comes back at whatever Meshy chooses.
     */
    const project = { aspect_ratio: '16:9', target_resolution: '2048x1080' };
    const ratioOnly = imageAdapters().filter(a => a.sizeControl === 'ratio-only');
    assert.ok(ratioOnly.length, 'no ratio-only adapter — this guard is untested');

    for (const a of ratioOnly) {
        const size = plateImageSize(project, a.maxImagePixels, 'location', a);
        assert.strictEqual(size.honoured, false,
            `${a.id}: reports the requested size as honoured, and it reaches nothing`);
        assert.strictEqual(size.below_floor, true,
            `${a.id}: claims the ${LOCATION_MIN_EDGE}px floor was met on a provider that `
            + 'cannot be told a size at all');
        assert.match(String(size.floor_reason || ''), /aspect ratio|only a ratio|cannot be told/i,
            `${a.id}: does not say WHY the floor cannot be met`);
    }
});

test('a provider that IS told a size reports it as honoured', () => {
    /*
     * `snapped` counts alongside `exact`: Runway answers at the nearest pixel
     * pair from a documented list and Google at the nearest size TIER, so
     * neither reproduces the ask exactly — but both are told it, and a large
     * request genuinely returns a large picture. Only `ratio-only` throws the
     * number away.
     */
    const project = { aspect_ratio: '16:9', target_resolution: '2048x1080' };
    const told = imageAdapters().filter(a => a.sizeControl && a.sizeControl !== 'ratio-only');
    assert.ok(told.length, 'no adapter is told a requested size — the whole feature is dead');

    for (const a of told) {
        const size = plateImageSize(project, a.maxImagePixels, 'location', a);
        assert.strictEqual(size.honoured, true,
            `${a.id}: is told the size and reports it as ignored`);
    }
});

test('a size TIER is not a pixel pair, and is not claimed to be', () => {
    // Google's image_size is 512px/1K/2K/4K. Declaring that `exact` would
    // promise pixels it does not reproduce — the test caught exactly that.
    const google = imageAdapters().find(a => a.id === 'google');
    // Adapters are listed from the registry regardless of credentials, so a
    // missing one is a broken registry rather than an unconfigured install —
    // and bailing quietly would report pass for a check that never ran.
    assert.ok(google, 'no google image adapter in the registry; this check never ran');
    assert.strictEqual(google.sizeControl, 'snapped',
        'google sends a size tier, not a pixel pair');
});

test('an unknown adapter is read strictly, not optimistically', () => {
    // Over-promising is what produced a confident 2048x1152 arriving as
    // 1376x768. With nothing declared, assume the size does not reach.
    const size = plateImageSize({ aspect_ratio: '16:9', target_resolution: '2048x1080' },
        4194304, 'location', { id: 'mystery' });
    assert.strictEqual(size.honoured, false,
        'an adapter that declares nothing is assumed to honour the size');
});

test('the comparison table says which generators ignore your resolution', () => {
    /*
     * It changes which generator you should pick and is invisible from price
     * alone — a plate came back 1376x768 on a project set to 2048x1080 and the
     * only way to find out was to open the file and read its pixels.
     *
     * It applies to STORYBOARD FRAMES as much as to plates: both go through
     * the same adapter, so on a ratio-only provider every frame in a
     * production comes back at whatever that provider chooses.
     */
    const { compareGenerators } = require('../lib/generator-costs');
    const rows = compareGenerators('image').rows;

    const undeclared = rows.filter(r => typeof r.honours_resolution !== 'boolean');
    assert.deepStrictEqual(undeclared.map(r => `${r.provider}:${r.model}`), [],
        'these rows do not say whether the project resolution reaches them');

    // The distinction has to be real in the data, or the column is decoration.
    assert.ok(rows.some(r => r.honours_resolution), 'no generator honours a resolution');
    assert.ok(rows.some(r => !r.honours_resolution), 'no generator ignores one — the guard is untested');

    for (const r of rows.filter(x => !x.honours_resolution)) {
        assert.ok(r.size_note && r.size_note.length > 25,
            `${r.provider}: ignores the resolution with no reason a person can act on`);
    }

    const fs = require('fs');
    const path = require('path');
    const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    assert.match(SPA, /ignores your resolution/,
        'the comparison table renders the flag nowhere, so the decision stays invisible');
});

test('a declared ceiling is what the provider returns, not what its models could', () => {
    /*
     * Meshy's ceiling was declared 2048x2048 with the note "no published
     * limit, held at what the models it proxies actually reach". The models do
     * reach 2K — Meshy does not expose it. Every image it has actually
     * returned is 1376x768 at 16:9 or 1024x1024 at 1:1, about one megapixel,
     * for nano-banana-2 and nano-banana-pro alike.
     *
     * The distinction matters because the comparison table reports the ceiling
     * as what you would GET. Claiming 4.2MP from a provider that returns 1.06
     * is the same over-promise that let a "2048x1152" plate arrive as
     * 1376x768.
     */
    const meshy = imageAdapters().find(a => a.id === 'meshy');
    assert.ok(meshy, 'no meshy image adapter in the registry; this check never ran');

    assert.ok(meshy.maxImagePixels <= 1376 * 768 * 1.02,
        `meshy declares ${meshy.maxImagePixels} pixels; every image it has returned is `
        + 'about 1.06MP, and its API has no way to ask for more');

    // A ratio-only provider's ceiling can only ever be an observation, so it
    // must be justified rather than assumed.
    for (const a of imageAdapters().filter(x => x.sizeControl === 'ratio-only' && x.maxImagePixels)) {
        assert.ok(a.sizeControlReason && /aspect ratio|no width|cannot be told|chooses the pixels/i
            .test(a.sizeControlReason),
        `${a.id}: declares a pixel ceiling without explaining that the size cannot be requested`);
    }
});

test('a model that cannot reach 2K is not sold on its provider reaching it', () => {
    /*
     * Google's draft model, gemini-3.1-flash-lite-image, is 1K ONLY — Google's
     * own docs say so — while its other two reach 4K. "This provider does 2K"
     * is true of the provider and false of the model the draft tier would
     * actually run, which is the same over-promise as claiming Meshy does 2K
     * because the models behind it can, one level further down.
     */
    const { compareGenerators } = require('../lib/generator-costs');
    const google = compareGenerators('image').rows.filter(r => r.provider === 'google');
    assert.ok(google.length, 'no google rows in the generator comparison; this check never ran');

    const draft = google.find(r => r.tier && r.tier.id === 'draft');
    assert.ok(draft, 'no draft-tier google row to check');
    assert.strictEqual(draft.max_size, '1K',
        'the draft model is reported as reaching more than 1K — Google documents it as 1K only');

    const better = google.filter(r => r.max_size && r.max_size !== '1K');
    assert.ok(better.length, 'no google model reports a size above 1K, so 2K is unreachable there too');

    // And every row that can say, says.
    for (const r of google) {
        assert.ok(r.max_size, `${r.model}: no maximum size reported, so the tier cannot be judged`);
    }

    const fs = require('fs');
    const path = require('path');
    const SPA = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    assert.match(SPA, /max \$\{esc\(x\.max_size\)\}/,
        'the per-model maximum is computed and never shown');
});
