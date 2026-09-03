/**
 * The orientation plan has to reach the plate it was written for.
 *
 * `orientation_plan` is documented on its own tool as "what keeps four plates
 * of one room describing the same room". It was stored, drawn as a compass
 * diagram on the sheet, and then never read by buildPlatePrompt -- which took
 * `description`, `lighting_default` and `time_of_day_default` and stopped. So
 * every side of a location was generated from the same paragraph as every
 * other side, which is precisely how four views of one street come back as
 * four different streets. A director filling in "north: the collapsing masonry
 * frontage" was writing into a field nothing downstream consulted.
 *
 * Two failures, both silent, and both are tested here: the plan not reaching
 * the prompt, and the store cutting it to 200 characters on the way in because
 * the cap was set to the width of the diagram's label rather than to what the
 * generator needs to be told.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-orientation-' + crypto.randomUUID().slice(0, 8));

const { buildPlatePrompt, orientationEdge } = require('../lib/reference-plates');

const PLAN = {
    north: 'The collapsing side. Continuous masonry and brick frontage, four to eight storeys, '
        + 'stone banding, cornices and heavy window heads, fire escapes on the upper floors.',
    east: 'Downstream -- the canyon runs on and ends at a far intersection where police vehicles '
        + 'cross right to left and never turn in.',
    south: 'The foreground kerb, where the hydrant runs hard across the near lane.',
    west: '',
    interior: [],
    marker: 'THE COLLAPSING FACADE, mid-block on the north side',
};

const LOCATION = {
    name: 'CITY STREETS',
    description: 'a four-lane cross-street that reads as a canyon',
    lighting_default: 'night, rain, sodium street lighting',
    time_of_day_default: 'night',
    orientation_plan: JSON.stringify(PLAN),
};

// -- 1. The facing side reaches the prompt -------------------------------

test('the plate for a side is told what is on that side', () => {
    const east = buildPlatePrompt('location', LOCATION, null, 'east', true);
    assert.ok(east.includes('ends at a far intersection'),
        'the east plate was generated without a word of what the plan says is east');

    const north = buildPlatePrompt('location', LOCATION, null, 'north', true);
    assert.ok(north.includes('stone banding'),
        'the north plate was generated without a word of what the plan says is north');
});

// -- 2. And ONLY the facing side -----------------------------------------

test('the other three sides stay out of frame', () => {
    /*
     * An image model has no way to act on "and behind you is the hydrant"
     * except to paint the hydrant. Naming every edge on every plate would put
     * the whole location in all four frames -- the opposite of what the plan
     * is for.
     */
    const east = buildPlatePrompt('location', LOCATION, null, 'east', true);
    assert.ok(!east.includes('hydrant'), 'the south edge leaked into the east plate');
    assert.ok(!east.includes('stone banding'), 'the north edge leaked into the east plate');
});

// -- 3. The marker rides with the anchor plate only ----------------------

test('the one landmark is named once, on the plate the others are shot from', () => {
    /*
     * The sides are photographed FROM the default plate and inherit the marker
     * by being anchored on it. Restating it on a side that faces away from it
     * asks for a second copy of the single landmark the plan exists to keep
     * singular.
     */
    const anchor = buildPlatePrompt('location', LOCATION, null, null, false);
    assert.ok(anchor.includes('THE COLLAPSING FACADE'),
        'the establishing plate does not name the landmark every other view is measured against');

    const south = buildPlatePrompt('location', LOCATION, null, 'south', true);
    assert.ok(!south.includes('THE COLLAPSING FACADE'),
        'the marker was restated on a side that faces away from it');
});

// -- 4. A location with no plan generates exactly as before --------------

test('an unplanned location is unchanged', () => {
    const bare = { name: 'A STREET', description: 'a street' };
    assert.strictEqual(orientationEdge(bare, 'east'), '');
    assert.strictEqual(orientationEdge({ ...bare, orientation_plan: 'not json' }, 'east'), '');
    assert.strictEqual(orientationEdge({ ...bare, orientation_plan: JSON.stringify(PLAN) }, 'west'), '',
        'an edge nobody wrote invented something to say');
});

// -- 5. Interior zones travel with every side ----------------------------

test('what the room contains is in frame from all four sides', () => {
    const room = {
        name: 'NORTHLINE INTERIOR',
        orientation_plan: JSON.stringify({
            north: 'the windscreen', interior: ['driver seat left', 'passenger seat right'], marker: '',
        }),
    };
    for (const view of ['north', 'east', 'south', 'west']) {
        assert.ok(orientationEdge(room, view).includes('passenger seat right'),
            `the ${view} view of a room forgot what is in the room`);
    }
});

// -- 6. The store keeps the whole edge, not the label's worth of it ------

test('an edge is not cut to the width of the compass diagram', () => {
    /*
     * 200 characters fits "North . harbour window + door" and nothing anyone
     * writes for a generator. Every edge written for Northline ran 400-900
     * and was cut mid-word on save -- silently, with a 200 OK and the stump
     * echoed back, the same way lighting_default was cut at fifty.
     */
    const src = require('fs').readFileSync(
        path.join(__dirname, '..', 'routes', 'locations.js'), 'utf8');
    const block = src.slice(src.indexOf('if (body.orientation_plan !== undefined)'), )
        .slice(0, 1600);
    // Only the caps on TEXT. `obj.interior.slice(0, 3)` is how many zones a
    // room has, which is a property of the diagram and correctly three.
    const caps = [...block.matchAll(/String\([^)]*\)\.slice\(0,\s*(\d+)\)/g)]
        .map(m => Number(m[1]));
    assert.ok(caps.length >= 3, 'the orientation plan write no longer caps its fields -- check this test');
    assert.ok(Math.min(...caps) >= 300,
        `an orientation plan field is capped at ${Math.min(...caps)} characters, `
        + 'which cuts a written edge mid-word on save');
});
