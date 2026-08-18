/**
 * Tags are only emitted to a provider that can receive the images.
 *
 * The regression this exists to prevent, which shipped: Meshy's text-to-image
 * takes ai_model, prompt and aspect_ratio — there is no reference-image field.
 * The prompt builder emitted "@maya" and "@suburbanstreet" anyway, and those
 * tags REPLACED the appearance and location descriptions. The model received
 * two meaningless tokens where 500 characters of continuity information used
 * to be, so eight frames came back with a different woman on a different
 * street each time — worse than before the reference work existed.
 *
 * Set-based over the image-capable adapters, because the question is per
 * provider and the answer changes as adapters are added. An example-based test
 * ("meshy does not get tags") passes while a fifth adapter silently repeats it.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-refcap-' + crypto.randomUUID().slice(0, 8));

const { ensureSchema } = require('../db/schema');
ensureSchema();

const providers = require('../lib/providers');
const { buildStoryboardPrompt } = require('../lib/storyboard-prompt');

const IMAGE_ADAPTERS = providers.list().filter(a => a.supports && a.supports('image'));

const CARD = {
    shot_code: '1C',
    description: 'MAYA looks up as a shadow crosses the houses.',
    camera: { shot_type: 'medium', movement: 'tilt-up', lens: '35mm' },
    lighting: { type: 'blue-hour' },
    characters: [{ name: 'MAYA' }],
};
const CHARS = [{ name: 'MAYA', appearance_prompt: 'Mid-30s woman, olive skin, rust-orange cardigan, dark jeans, white sneakers.' }];
const LOC = { name: 'SUBURBAN STREET', description: 'Late-1970s cul-de-sac, faded siding, wet asphalt, basketball hoops.' };

test('every image-capable adapter declares whether it accepts reference images', () => {
    // Undeclared means unknown, and the caller then has to guess — which is how
    // tags reached a provider that could not receive the pictures they name.
    const undeclared = IMAGE_ADAPTERS
        .filter(a => typeof a.supportsReferenceImages !== 'boolean'
                  || typeof a.supportsReferenceTags !== 'boolean')
        .map(a => a.id);
    assert.deepStrictEqual(undeclared, [],
        `these serve image but never say whether references work: ${undeclared.join(', ')}`);
});

test('at least one image provider does accept references', () => {
    // Otherwise the whole tagged-reference path is dead code and the tests
    // below would pass vacuously.
    assert.ok(IMAGE_ADAPTERS.some(a => a.supportsReferenceImages),
        'no image adapter accepts reference images');
});

test('a prompt never carries a tag when references were not attached', () => {
    // The exact failure: "@maya" with nothing behind it, and the description it
    // displaced now missing.
    const { prompt } = buildStoryboardPrompt(CARD, CHARS, LOC, 'noir');
    assert.ok(!/@\w+/.test(prompt), `untagged build still emitted a tag: ${prompt}`);
    assert.ok(prompt.includes('rust-orange cardigan'),
        'the appearance description is missing and no tag replaced it');
    assert.ok(prompt.includes('cul-de-sac'), 'the location description is missing');
});

test('an explicitly empty reference list falls back to prose, not tags', () => {
    const { prompt } = buildStoryboardPrompt(CARD, CHARS, LOC, 'noir', { references: [] });
    assert.ok(!/@\w+/.test(prompt), 'an empty reference list still produced tags');
    assert.ok(prompt.includes('rust-orange cardigan'), 'prose did not come back');
});

test('tags appear only alongside the references that define them', () => {
    const refs = [{ name: 'MAYA', tag: 'maya', uri: 'data:image/png;base64,AAA' }];
    const { prompt } = buildStoryboardPrompt(CARD, CHARS, LOC, 'noir', { references: refs });

    assert.ok(prompt.includes('@maya'), 'a supplied reference did not produce its tag');
    // The location has no reference here, so it must still be described.
    assert.ok(!prompt.includes('@suburbanstreet'), 'a tag was emitted for an unreferenced subject');
    assert.ok(prompt.includes('cul-de-sac'), 'the unreferenced location lost its description');
});

test('every tag in a prompt has a matching attached reference', () => {
    // The invariant, stated directly: a tag with no image is a token that
    // refers to nothing.
    const refs = [
        { name: 'MAYA', tag: 'maya', uri: 'data:image/png;base64,AAA' },
        { name: 'SUBURBAN STREET', tag: 'suburbanstreet', uri: 'data:image/png;base64,BBB' },
    ];
    const { prompt } = buildStoryboardPrompt(CARD, CHARS, LOC, 'noir', { references: refs });
    const tags = (prompt.match(/@(\w+)/g) || []).map(t => t.slice(1));
    const attached = new Set(refs.map(r => r.tag));
    const dangling = tags.filter(t => !attached.has(t));
    assert.deepStrictEqual(dangling, [], `tags with no attached image: ${dangling.join(', ')}`);
});

test('the storyboard route gates references on the provider that will run', () => {
    // A declaration nothing consults is decoration. The route must ask the
    // lead provider whether references work before gathering them — and both
    // generation paths must do it, since a fix applied to one leaves the other
    // emitting dangling tags.
    const src = require('fs').readFileSync(
        path.join(__dirname, '..', 'routes', 'storyboard.js'), 'utf8');

    // Exclude the declaration — `function gatherShotReferences(projectId…` is
    // not a call site, and counting it made the gate look one short.
    const gathers = src.split('\n')
        .filter(l => /gatherShotReferences\(projectId/.test(l) && !/^function\s/.test(l.trim()))
        .length;
    const gated = (src.match(/supportsReferenceImages/g) || []).length;
    const tagged = (src.match(/supportsReferenceTags/g) || []).length;

    assert.ok(gathers >= 2, `expected 2+ gather sites, found ${gathers}`);
    assert.ok(gated >= gathers,
        `${gathers} gather site(s) but only ${gated} checked supportsReferenceImages`);
    assert.ok(tagged >= 1, 'nothing checks supportsReferenceTags, so tags reach providers that cannot read them');
});

test('a provider that takes pictures but cannot name them keeps the prose', () => {
    // Meshy conditions on an untagged array. Attaching the plate AND keeping
    // the description is strictly better than either alone — the picture fixes
    // identity, the words survive for a model that cannot read @tags.
    const refs = [{ name: 'MAYA', tag: 'maya', uri: 'data:image/png;base64,AAA' }];
    const { prompt } = buildStoryboardPrompt(CARD, CHARS, LOC, 'noir', { references: refs, tagged: false });

    assert.ok(!/@\w+/.test(prompt), `untaggable provider still got a tag: ${prompt}`);
    assert.ok(prompt.includes('rust-orange cardigan'),
        'the description was dropped for a provider that cannot read tags');
});
