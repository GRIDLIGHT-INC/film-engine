/**
 * A LOCATION PLATE IS THE ONE REFERENCE THAT IS RE-SHOT FROM.
 *
 * A character or prop plate is a close-up filling its own frame, so the subject
 * owns most of the pixels. A location plate's subject is the whole environment
 * and any given shot uses a FRACTION of it — a corner of the street, one house
 * front, the far kerb. Detail that is adequate on a portrait is mush on a crop,
 * and every shot in the scene is built against it. That is why it declares a
 * floor at all.
 *
 * The floor was declared and unreachable: meshy is `ratio-only`, so a width and
 * height can only ever become an aspect ratio and the provider chooses the
 * pixels. Asking harder does nothing. Reaching the floor is a PROVIDER choice.
 *
 * "Capable" is therefore two conditions, not one — enough pixels AND a provider
 * that can be told a size. An adapter with a huge ceiling that ignores the
 * request is not capable, and treating area alone as the test is how a plate
 * comes back at 1376x768 from a provider the report called sufficient.
 *
 * Set-based over EVERY image adapter, because the answer differs per adapter
 * and a rule right about the two we happen to use is a rule that breaks on the
 * third.
 */

const test = require('node:test');
const assert = require('node:assert');

const providers = require('../lib/providers');
const plates = require('../lib/reference-plates');
const fallback = require('../lib/image-fallback');

const imageAdapters = () => providers.list().filter((a) => (a.capabilities || []).includes('image'));

/** A 16:9 project asking for the floor: 2048 x 1152. */
const FLOOR_PIXELS = 2048 * 1152;

test('the denominator is every image adapter, not the two in use', () => {
    assert.ok(imageAdapters().length >= 5,
        `only ${imageAdapters().length} image adapters — the registry read is broken`);
});

test('capability is enough pixels AND a size the provider will accept', () => {
    assert.strictEqual(typeof plates.canReachFloor, 'function',
        'nothing decides whether a provider can serve the location floor');
    const wrong = [];
    for (const a of imageAdapters()) {
        const can = plates.canReachFloor(a, FLOOR_PIXELS);
        const bigEnough = (a.maxImagePixels || 0) >= FLOOR_PIXELS;
        const tellable = a.sizeControl && a.sizeControl !== 'ratio-only';
        if (can !== (bigEnough && tellable)) {
            wrong.push(`${a.id}: canReachFloor=${can} but pixels=${bigEnough} tellable=${tellable}`);
        }
    }
    assert.deepStrictEqual(wrong, [], `\n  - ${wrong.join('\n  - ')}`);
});

test('a ratio-only provider is never capable, however large its ceiling', () => {
    /*
     * The trap this exists for. gridlight declares 2359296 pixels — exactly the
     * floor — and is ratio-only, so the number reaches nothing. Judging by area
     * alone would call it capable and the plate would come back at whatever it
     * chose.
     */
    const ratioOnly = imageAdapters().filter((a) => a.sizeControl === 'ratio-only');
    assert.ok(ratioOnly.length, 'no ratio-only adapter to check the rule against');
    for (const a of ratioOnly) {
        assert.strictEqual(plates.canReachFloor(a, FLOOR_PIXELS), false,
            `${a.id} is ratio-only and was called capable`);
    }
});

test('at least one credentialed provider can actually serve the floor', () => {
    /*
     * If none can, the floor is aspirational and every plate is below it. That
     * is a real state worth failing on rather than discovering per plate.
     */
    const capable = plates.capableProviders(FLOOR_PIXELS);
    assert.ok(capable.length >= 1,
        'no registered provider can reach the 2048 location floor — the floor cannot be met at all');
    for (const id of capable) {
        const a = imageAdapters().find((x) => x.id === id);
        assert.ok(a, `capableProviders named ${id}, which is not an image adapter`);
        assert.ok(plates.canReachFloor(a, FLOOR_PIXELS), `${id} is named capable and is not`);
    }
});

/*
 * Exercised over a KNOWN set of adapters, not the live chain. The live chain is
 * built from whatever credentials this shell happens to hold, and on this
 * machine it is empty — so every assertion about ordering would have passed
 * over nothing, which is the "check that only runs when there happens to be
 * data" trap.
 */
const FAKE = [
    { id: 'ratio-only-big', sizeControl: 'ratio-only', maxImagePixels: 99999999 },
    { id: 'exact-small', sizeControl: 'exact', maxImagePixels: 1000 },
    { id: 'exact-big', sizeControl: 'exact', maxImagePixels: 99999999 },
    { id: 'snapped-big', sizeControl: 'snapped', maxImagePixels: 99999999 },
];

test('a location plate leads with a provider that can serve the floor', () => {
    const ordered = fallback.orderForFloor(FAKE.slice(), FLOOR_PIXELS);
    assert.ok(plates.canReachFloor(ordered[0], FLOOR_PIXELS),
        `the chain leads with ${ordered[0].id}, which cannot serve the floor`);
    assert.deepStrictEqual(ordered.map((a) => a.id).slice(0, 2), ['exact-big', 'snapped-big'],
        'capable providers are not in front, or their relative order was not preserved');
});

test('nothing is dropped or added by reordering', () => {
    const ordered = fallback.orderForFloor(FAKE.slice(), FLOOR_PIXELS);
    assert.deepStrictEqual(ordered.map((a) => a.id).sort(), FAKE.map((a) => a.id).sort(),
        'reordering lost or invented a provider');
});

test('an already-capable lead is left where it is', () => {
    /*
     * A project that pinned a capable provider must not be moved. Demotion is
     * only defensible when the pin genuinely cannot serve the plate.
     */
    const already = [FAKE[2], FAKE[0], FAKE[1]];
    const ordered = fallback.orderForFloor(already, FLOOR_PIXELS);
    assert.strictEqual(ordered[0].id, 'exact-big');
    assert.strictEqual(ordered.floor.moved, null, 'a capable lead was reported as demoted');
});

test('an ordinary image request is NOT reordered', () => {
    /*
     * The floor is a location-plate rule. Reordering every image generation
     * would silently move a whole production's frames to another vendor, which
     * is the "spend that goes somewhere nobody chose" defect one level up.
     */
    const plain = fallback.imageProviderChain({}).map((a) => a.id);
    const forFloor = fallback.imageProviderChain({}, { needsPixels: FLOOR_PIXELS }).map((a) => a.id);
    assert.deepStrictEqual(plain, fallback.imageProviderChain({}).map((a) => a.id),
        'the unordered chain is not stable');
    assert.deepStrictEqual(plain.slice().sort(), forFloor.slice().sort(),
        'reordering dropped or added a provider rather than reordering');
});

test('a demotion is REPORTED, never silent', () => {
    /*
     * If the project pinned a provider and it cannot serve the floor, the plate
     * is generated somewhere the director did not choose. That is defensible
     * and it must be said — an unexplained vendor switch is exactly how a bill
     * arrives from a company nobody signed up with.
     */
    const ordered = fallback.orderForFloor(FAKE.slice(), FLOOR_PIXELS);
    assert.ok(ordered.floor, 'the chain does not report anything about the floor');
    assert.strictEqual(typeof ordered.floor.needed_pixels, 'number');
    assert.ok(Array.isArray(ordered.floor.capable), 'the report does not name who can serve it');
    assert.ok(ordered.floor.moved, 'a ratio-only lead was demoted and nothing was reported');
    assert.strictEqual(ordered.floor.moved.from, 'ratio-only-big');
    assert.ok(String(ordered.floor.why).length > 30,
        'a provider was demoted and the report does not say why');
    assert.ok(ordered.floor.why.includes('ratio-only-big'),
        'the reason does not name the provider that was demoted');
});

test('a plate that cannot meet the floor names the providers that could', () => {
    const ratioOnly = imageAdapters().find((a) => a.sizeControl === 'ratio-only');
    const size = plates.plateImageSize(
        { aspect_ratio: '16:9', target_resolution: '2048x1080' },
        ratioOnly.maxImagePixels, 'location', ratioOnly);
    assert.strictEqual(size.below_floor, true, 'a ratio-only provider reported the floor as met');
    assert.ok(size.floor_reason, 'no reason given');
    const named = plates.capableProviders(FLOOR_PIXELS)
        .filter((id) => size.floor_reason.includes(id));
    assert.ok(named.length >= 1,
        `the reason explains the problem and names no remedy — it should name one of `
        + `${plates.capableProviders(FLOOR_PIXELS).join(', ')}`);
});

test('a size the provider ignored is never reported as delivered', () => {
    const ratioOnly = imageAdapters().find((a) => a.sizeControl === 'ratio-only');
    const size = plates.plateImageSize(
        { aspect_ratio: '16:9', target_resolution: '2048x1080' },
        ratioOnly.maxImagePixels, 'location', ratioOnly);
    assert.strictEqual(size.honoured, false,
        'a ratio-only provider reported the requested size as honoured');
});
