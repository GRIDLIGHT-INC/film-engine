/**
 * MuAPI is the house provider: its models must be selectable, and selecting
 * one must actually reach MuAPI
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "Relabel the Seedance 2.5 key in setup muapi (that's actually the key from
 *  muapi) and add muapi's video and image models in the appropriate prompt
 *  selections (when I click on generate and select the model). I will use
 *  muapi from now on for almost everything (especially images)."
 *
 * Three faults sat behind that, and only the first is the one that was asked
 * about:
 *
 *  1. The key is labelled `Seedance 2.5 (ByteDance)`. One MuAPI account issues
 *     one key that reaches both adapters, so the label names the model rather
 *     than the account the key belongs to.
 *
 *  2. `modelList()` reads ONE flat `adapter.models` per adapter, and four
 *     adapters here serve more than one capability. So the VIDEO dialog was
 *     offered Runway's IMAGE models, the 3D dialog was offered Meshy's image
 *     models, and Seedance -- which declares no models at all -- offered
 *     nothing, which is the reported gap. A model list is only meaningful
 *     relative to a capability.
 *
 *  3. THE ONE THAT COSTS MONEY SILENTLY. `buildImageRequest` posts every
 *     generation to MuAPI's TEXT-TO-IMAGE endpoint and attaches references as
 *     `image_urls`. MuAPI serves editing on a SEPARATE endpoint (`-edit`) and
 *     names the field `images_list` -- and FastAPI IGNORES an unknown field
 *     rather than refusing it. So every character plate, location plate and
 *     shot anchor was serialised, sent, and dropped on the floor. The frame
 *     came back plausible and conditioned on nothing, which is indistinguishable
 *     from conditioning being weak. Confirmed against the live API, free,
 *     because validation refuses before it bills.
 *
 * THE DENOMINATOR IS DERIVED, from two registries:
 *
 *   - `providers.list()` crossed with each adapter's declared capabilities,
 *     so an adapter added later is covered with nothing to remember.
 *   - MuAPI's own `/models` catalogue, snapshotted with its date by
 *     `tests/refresh-muapi-contract.js`, so a model we offer that MuAPI does
 *     not serve fails here rather than as a 404 on a paid generation.
 *
 * An example-based test passes on a half-done fix -- offering nano-banana-2
 * while nano-banana-pro still posts to the wrong endpoint looks identical from
 * the outside -- which is the exact failure this shape prevents.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = path.join(os.tmpdir(), 'film-engine-muapi-' + crypto.randomUUID().slice(0, 8));

const providers = require('../lib/providers');
const { generationOptions } = require('../lib/generation-override');
const contract = require('./fixtures/muapi-contract.json');

const CATALOGUE = new Set(contract.catalogue.map(m => m.name));
const ENDPOINTS = contract.endpoints;

/** Every (adapter, capability) pair the engine can resolve. Derived. */
function pairs() {
    const out = [];
    for (const a of providers.list()) {
        for (const c of (a.capabilities || [])) out.push({ adapter: a, id: a.id, capability: c });
    }
    return out;
}

// ---------------------------------------------------------------------------
// 1. A model list means nothing except relative to a capability
// ---------------------------------------------------------------------------

test('an adapter serving several capabilities declares its models per capability', () => {
    const multi = providers.list().filter(a => (a.capabilities || []).length > 1);
    assert.ok(multi.length >= 4, `expected several multi-capability adapters, saw ${multi.length}`);

    const offenders = [];
    for (const a of multi) {
        const flat = a.models && Object.keys(a.models).length;
        const byCap = a.modelsByCapability;
        if (!flat && !byCap) continue;               // offers no model choice at all — fine
        if (!byCap) { offenders.push(`${a.id}: one flat list served to [${a.capabilities.join(', ')}]`); continue; }
        for (const c of a.capabilities) {
            if (!(c in byCap)) offenders.push(`${a.id}: says nothing about its "${c}" models`);
        }
    }
    assert.deepStrictEqual(offenders, [],
        'a capability served the wrong models offers a choice the provider will refuse:\n  ' + offenders.join('\n  '));
});

test('no capability is offered a model belonging to a different one', () => {
    const bad = [];
    for (const { adapter, id, capability } of pairs()) {
        const opts = generationOptions(capability);
        if (!opts) continue;
        const mine = (opts.providers || []).find(p => p.id === id);
        if (!mine || !mine.models) continue;
        const byCap = adapter.modelsByCapability;
        if (!byCap) continue;
        const allowed = new Set(Object.keys(byCap[capability] || {}));
        for (const m of mine.models) {
            if (!allowed.has(m.id)) bad.push(`${id}:${capability} offers "${m.id}", which is not one of its ${capability} models`);
        }
    }
    assert.deepStrictEqual(bad, [], bad.join('\n  '));
});

// ---------------------------------------------------------------------------
// 2. MuAPI's models reach the dialogs the user actually picks from
// ---------------------------------------------------------------------------

const MUAPI_ADAPTERS = { muapi: ['image'], seedance: ['video', 'post'] };

test('every MuAPI capability offers at least one model on the generate dialog', () => {
    const missing = [];
    for (const [id, caps] of Object.entries(MUAPI_ADAPTERS)) {
        for (const cap of caps) {
            const opts = generationOptions(cap);
            const mine = opts && (opts.providers || []).find(p => p.id === id);
            if (!mine) { missing.push(`${id}: absent from the "${cap}" dialog entirely`); continue; }
            if (!mine.models || !mine.models.length) missing.push(`${id}:${cap} offers no model to choose`);
        }
    }
    assert.deepStrictEqual(missing, [],
        'a capability with no model menu is one where MuAPI cannot be chosen:\n  ' + missing.join('\n  '));
});

// ---------------------------------------------------------------------------
// 3. Every model we offer exists at MuAPI
// ---------------------------------------------------------------------------

test('every MuAPI image model resolves to real endpoints in the catalogue', () => {
    const { MODELS } = require('../lib/providers/muapi-image');
    const unknown = [];
    for (const [id, spec] of Object.entries(MODELS)) {
        if (!CATALOGUE.has(spec.slug)) unknown.push(`${id}: text-to-image slug "${spec.slug}" is not in MuAPI's catalogue`);
        if (!spec.editSlug) unknown.push(`${id}: declares no editing endpoint, so references cannot be sent`);
        else if (!CATALOGUE.has(spec.editSlug)) unknown.push(`${id}: edit slug "${spec.editSlug}" is not in MuAPI's catalogue`);
    }
    assert.deepStrictEqual(unknown, [], unknown.join('\n  '));
});

test('every Seedance model resolves to a real endpoint for each workflow it runs', () => {
    const seedance = require('../lib/providers/seedance');
    const adapter = seedance.adapter;
    const byCap = adapter.modelsByCapability || {};
    assert.deepStrictEqual(Object.keys(byCap).sort(), ['post', 'video'],
        'Seedance serves video and post; a capability missing here is one with no model menu');
    const unknown = [];
    let checked = 0;
    for (const [cap, models] of Object.entries(byCap)) {
        for (const [id, spec] of Object.entries(models || {})) {
            const workflows = spec.workflows || [];
            assert.ok(workflows.length, `${cap}:${id} names no workflow, so nothing can be checked`);
            for (const w of workflows) {
                checked++;
                const endpoint = `seedance-2.5-${w}${spec.suffix || ''}`;
                if (!CATALOGUE.has(endpoint)) unknown.push(`${cap}:${id} -> "${endpoint}" is not in MuAPI's catalogue`);
            }
        }
    }
    assert.deepStrictEqual(unknown, [], unknown.join('\n  '));
    assert.ok(checked >= 24, `only ${checked} endpoints checked — the model registry has gone empty`);
});

// ---------------------------------------------------------------------------
// 4. The request we build is one MuAPI accepts -- with the references ON it
// ---------------------------------------------------------------------------

const REFS = ['https://example.test/plate-a.png', 'https://example.test/plate-b.png'];

test('a referenced generation goes to the editing endpoint and carries the pictures', () => {
    const { MODELS, buildImageRequest } = require('../lib/providers/muapi-image');
    assert.ok(Object.keys(MODELS).length >= 4, 'the MuAPI image registry has gone empty');
    const wrong = [];
    for (const id of Object.keys(MODELS)) {
        const req = buildImageRequest({
            prompt: 'a wet cul-de-sac at blue hour', model: id,
            width: 1920, height: 1080, reference_images: REFS,
        });
        const slug = req.url.split('/').pop();
        const accepts = ENDPOINTS[slug];
        if (!accepts) { wrong.push(`${id}: posts to "${slug}", which was never probed against MuAPI`); continue; }

        /*
         * The reference field is DERIVED as the one the editing endpoint accepts
         * and its text-to-image twin does not -- that difference IS what makes
         * an edit an edit. Reading the probe's `required` flag instead would be
         * wrong: the probe supplies every field, so a supplied one comes back as
         * a type error rather than a missing one.
         */
        const plain = ENDPOINTS[MODELS[id].slug] || {};
        const refField = Object.keys(accepts).find(f => !(f in plain));
        if (!refField) { wrong.push(`${id}: "${slug}" accepts nothing its text-to-image twin does not — the pictures have nowhere to go`); continue; }
        const carried = req.body[refField];
        if (!Array.isArray(carried) || carried.length !== REFS.length) {
            wrong.push(`${id}: "${slug}" requires ${refField}, and the body carries ${JSON.stringify(req.body[refField])} — the plates are dropped`);
        }
    }
    assert.deepStrictEqual(wrong, [], 'references silently dropped:\n  ' + wrong.join('\n  '));
});

test('no request carries a field its endpoint does not accept', () => {
    const { MODELS, buildImageRequest } = require('../lib/providers/muapi-image');
    const stray = [];
    for (const id of Object.keys(MODELS)) {
        for (const refs of [[], REFS]) {
            const req = buildImageRequest({
                prompt: 'a wet cul-de-sac at blue hour', model: id, seed: 1234,
                width: 1920, height: 1080, reference_images: refs,
            });
            const slug = req.url.split('/').pop();
            const accepts = ENDPOINTS[slug] || {};
            for (const field of Object.keys(req.body)) {
                if (!(field in accepts)) {
                    stray.push(`${id} (${refs.length} refs) -> "${slug}" ignores "${field}"`);
                }
            }
        }
    }
    assert.deepStrictEqual(stray, [],
        'a field the endpoint ignores is a setting that silently reaches nothing:\n  ' + stray.join('\n  '));
});

test('an adapter claims a control only where the endpoint really offers one', () => {
    const { adapter, MODELS } = require('../lib/providers/muapi-image');
    /*
     * `supportsSeed` was declared true and MuAPI accepts no seed field on any
     * nano endpoint, so "same seed, same frame" was never true here. A claimed
     * control that reaches nothing is worse than an absent one: it is relied on.
     */
    const anySeed = Object.values(MODELS).some(s =>
        ['slug', 'editSlug'].some(k => s[k] && ENDPOINTS[s[k]] && 'seed' in ENDPOINTS[s[k]]));
    assert.strictEqual(adapter.supportsSeed, anySeed,
        `supportsSeed is ${adapter.supportsSeed} but MuAPI ${anySeed ? 'does' : 'does not'} accept a seed on any nano endpoint`);
});

// ---------------------------------------------------------------------------
// 5. The key is labelled for the account it belongs to
// ---------------------------------------------------------------------------

test('both adapters on the one MuAPI account are labelled MuAPI in setup', () => {
    for (const id of Object.keys(MUAPI_ADAPTERS)) {
        const a = providers.get(id);
        assert.ok(a, `${id} is not registered`);
        assert.match(a.label, /MuAPI/i,
            `${id} is labelled "${a.label}" — the key pasted here is a MuAPI account key, and a label naming the model instead is why it was pasted twice`);
    }
});

// ---------------------------------------------------------------------------
// 6. Every model we offer is priced, at the catalogue's own figure
// ---------------------------------------------------------------------------

test('every offered MuAPI model is priced, and priced at what MuAPI charges', () => {
    const pricing = require('../lib/provider-pricing');
    const book = pricing.RATE_BOOK || pricing.rateBook;
    assert.ok(book, 'the rate book is not reachable for checking');

    const cost = name => (contract.catalogue.find(m => m.name === name) || {}).cost;
    const wrong = [];

    const { MODELS } = require('../lib/providers/muapi-image');
    const imageBook = book['muapi:image'];
    assert.ok(imageBook, 'muapi:image is unpriced — an unpriced generation reports as free');
    for (const id of Object.keys(MODELS)) {
        const entry = (imageBook.models || {})[id];
        if (!entry) { wrong.push(`muapi:image has no rate for "${id}"`); continue; }
        const listed = cost(MODELS[id].slug);
        if (listed !== undefined && Number(entry.usd_per_native) !== Number(listed)) {
            wrong.push(`muapi:image "${id}" priced ${entry.usd_per_native}, MuAPI lists ${listed}`);
        }
    }
    /* Nothing may be priced under a name MuAPI does not serve. */
    for (const id of Object.keys(imageBook.models || {})) {
        if (!MODELS[id]) wrong.push(`muapi:image prices "${id}", which no adapter offers and MuAPI may not serve`);
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n  '));
});
