/**
 * Previs and the storyboard are the same decision, seen twice.
 *
 * Blocking already reaches the VIDEO payload — camera_control carries the
 * sampled path, the rig and the movement. It does not reach the IMAGE payload
 * at all, so a director who blocks a shot in 3D, solves a close-up on a 50 and
 * gets a camera 1.2m from the subject, then generates a keyframe... from the
 * scene card's text, as though the blocking never happened. The frame they
 * approve is not the frame they blocked, and the discrepancy only shows up
 * later in the video pass.
 *
 * You do not shoot a frame until you are happy with how the scene plays. That
 * only works if the two views agree, in both directions: what you block shapes
 * what you see, and what you see can be re-blocked.
 *
 * Set-based over the capability builders and the previs camera facets, because
 * "previs reaches generation" is true of one builder and one facet today —
 * exactly the half-done state an example-based test would pass.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-pvsb-' + crypto.randomUUID().slice(0, 8));

const { ensureSchema } = require('../db/schema');
ensureSchema();

const { buildStoryboardPrompt } = require('../lib/storyboard-prompt');
const { solveShot, SHOT_TYPES } = require('../lib/previs-blocking');
const { SENSORS } = require('../lib/previs-camera');

const PAYLOADS = path.join(__dirname, '..', 'lib', 'capability-payloads.js');
const PREVIS_ROUTE = path.join(__dirname, '..', 'routes', 'previs.js');

/**
 * The builders that DESCRIBE a shot visually. Audio builders are excluded
 * deliberately: a camera position cannot shape a music cue, and demanding it
 * would be asserting a design nobody chose.
 */
const VISUAL_BUILDERS = ['image', 'video'];

/**
 * Previs camera state that the prompt vocabulary can already express. Each maps
 * to an existing scene-card enum, so this is integration rather than new
 * vocabulary.
 */
const PREVIS_FACETS = ['framing', 'lens', 'angle', 'movement'];

test('every visual capability builder carries previs when a shot is blocked', () => {
    const src = fs.readFileSync(PAYLOADS, 'utf8');
    const missing = VISUAL_BUILDERS.filter(cap => {
        const start = src.indexOf(`    ${cap}(ctx) {`);
        if (start < 0) return true;
        const end = src.indexOf('\n    },', start);
        return !/previs/.test(src.slice(start, end));
    });
    assert.deepStrictEqual(missing, [],
        `these describe a shot but ignore its blocking: ${missing.join(', ')}`);
});

test('a blocked shot changes the storyboard prompt', () => {
    // The load-bearing one. If blocking does not alter the prompt, previs is a
    // drawing tool bolted to a film engine.
    const card = {
        shot_code: '1A',
        description: 'A woman stands in a doorway.',
        camera: { shot_type: 'wide', movement: 'static', lens: '24mm' },
        lighting: { type: 'natural' },
    };
    const blocked = solveShot({ shotType: 'close-up', focalMm: 50, sensor: SENSORS.super35, subject: { heightM: 1.7 } });

    const plain = buildStoryboardPrompt(card, [], null, null).prompt;
    const withPrevis = buildStoryboardPrompt(card, [], null, null, {
        previs: { shot_type: 'close-up', focal_mm: 50, distance_m: blocked.distanceM, camera_height_m: 1.6 },
    }).prompt;

    assert.notStrictEqual(withPrevis, plain, 'blocking did not change the prompt at all');
    assert.ok(/close-up/i.test(withPrevis), 'the blocked framing is absent from the prompt');
    assert.ok(/50mm lens/i.test(withPrevis), 'the blocked lens is absent from the prompt');
    assert.ok(/from subject/i.test(withPrevis),
        'the solved distance is absent — framing is a word again, not a measurement');
});

test('blocking overrides the scene card, because it is the approved version', () => {
    // The card says wide on a 24; the director then blocked a close-up on a 50.
    // Preferring the card would show them the shot they already rejected.
    const card = {
        shot_code: '1A',
        description: 'A woman stands in a doorway.',
        camera: { shot_type: 'wide', movement: 'static', lens: '24mm' },
        lighting: { type: 'natural' },
    };
    const { prompt } = buildStoryboardPrompt(card, [], null, null, {
        previs: { shot_type: 'close-up', focal_mm: 50 },
    });
    assert.ok(!/24\s*mm/i.test(prompt), 'the scene card lens survived over the blocked one');
    assert.ok(!/wide angle/i.test(prompt), 'the scene card framing survived over the blocked one');
});

test('every previs facet reaches the prompt', () => {
    const { prompt } = buildStoryboardPrompt(
        { shot_code: '1A', description: 'x', camera: {}, lighting: { type: 'natural' } },
        [], null, null,
        { previs: { shot_type: 'low-angle', focal_mm: 85, movement: 'dolly-in', camera_height_m: 0.4 } });

    const found = {
        framing: /low.angle|looking up/i.test(prompt),
        lens: /85\s*mm/i.test(prompt),
        angle: /low.angle|looking up/i.test(prompt),
        movement: /moving closer|dolly|push/i.test(prompt),
    };
    const missing = PREVIS_FACETS.filter(f => !found[f]);
    assert.deepStrictEqual(missing, [], `previs facets that never reach the prompt: ${missing.join(', ')}`);
});

test('both round-trip directions exist as routes', () => {
    // card -> previs is /solve (a scene card becomes a camera position).
    // previs -> card is the write-back, without which a blocking session is a
    // sketch the rest of the pipeline never sees.
    const src = fs.readFileSync(PREVIS_ROUTE, 'utf8');
    const directions = {
        'card -> previs (solve)': /'solve'/.test(src),
        'previs -> card (apply)': /'apply'|applyBlockingToCard|to-storyboard/.test(src),
    };
    const missing = Object.entries(directions).filter(([, ok]) => !ok).map(([k]) => k);
    assert.deepStrictEqual(missing, [], `missing round-trip direction: ${missing.join(', ')}`);
});

test('every previs shot type is expressible in the prompt vocabulary', () => {
    // Set-based over the previs registry: a framing you can block but cannot
    // describe is a shot you can compose and never generate.
    const unexpressible = Object.keys(SHOT_TYPES).filter(st => {
        const { prompt } = buildStoryboardPrompt(
            { shot_code: 'x', description: 'a subject', camera: {}, lighting: { type: 'natural' } },
            [], null, null, { previs: { shot_type: st, focal_mm: 35 } });
        return !prompt || prompt.length < 20;
    });
    assert.deepStrictEqual(unexpressible, [], `previs shot types with no prompt form: ${unexpressible.join(', ')}`);
});


test('a card can say a low angle without being blocked in 3D', () => {
    // VALID_SHOT_TYPES mixes three independent axes — framing (wide, medium,
    // close-up), angle (low-angle, high-angle) and rig (tracking, dolly) — and
    // `shot_type` holds exactly one. So "a low-angle wide" is unsayable there:
    // you pick the framing or the angle and lose the other.
    //
    // `camera.height_m` is the second axis and the scene-card schema has always
    // VALIDATED it, but the prompt read camera height from previs blocking
    // ONLY. A director could write it, the card would save, and it reached
    // nothing unless somebody had also opened the 3D stage — the same defect
    // class as a mood-board spec that validates and is consumed nowhere.
    const { buildStoryboardPrompt } = require('../lib/storyboard-prompt');
    const wide = { action: 'Three house fronts.', camera: { shot_type: 'wide', lens: '32mm' } };

    const flat = buildStoryboardPrompt(wide, [], null, '', {}).prompt;
    assert.ok(!/low angle/.test(flat), 'an angle appeared on a card that names none');

    const low = buildStoryboardPrompt(
        { ...wide, camera: { ...wide.camera, height_m: 0.4 } }, [], null, '', {}).prompt;
    assert.ok(/wide angle shot/.test(low), 'the framing was lost when the angle was added');
    assert.ok(/low angle, camera looking up/.test(low),
        'camera.height_m validates on the card and still reaches no prompt');

    const high = buildStoryboardPrompt(
        { ...wide, camera: { ...wide.camera, height_m: 3 } }, [], null, '', {}).prompt;
    assert.ok(/high angle, camera looking down/.test(high));
});

test('blocking still beats the card for camera height', () => {
    // The card is what was written; the blocking is what was staged and
    // approved. A card height that overrode the stage would show a director the
    // shot they had already moved past.
    const { buildStoryboardPrompt } = require('../lib/storyboard-prompt');
    const card = { action: 'A street.', camera: { shot_type: 'wide', height_m: 0.4 } };
    // The flat facet shape the other tests here use, standing in for blocking.
    const staged = buildStoryboardPrompt(card, [], null, '', {
        previs: { shot_type: 'wide', focal_mm: 32, camera_height_m: 1.6 },
    }).prompt;
    assert.ok(!/low angle/.test(staged),
        'the card height overrode the staged camera');
});
