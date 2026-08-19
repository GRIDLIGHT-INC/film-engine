/**
 * Phase 3 — deciding a look before generating, and catching a style that
 * describes a subject.
 *
 * The defect this exists for shipped: a project's style_preset read
 *
 *   "Guillermo del Toro gothic: teal/amber, wet streets, mist,
 *    ANATOMICAL BEAST, anamorphic, grain"
 *
 * and "anatomical beast" is not a look, it is a thing. It was appended to every
 * image prompt in the production, so the establishing shot — whose scene card
 * says "Empty, ordinary, still." — came back with a flayed quadruped standing
 * in the middle of the road, and the sprinkler insert came back with a gargoyle
 * at its base. Nobody wrote those shots. The style did.
 *
 * A style preset is a free-text column with no validation and no surface where
 * a look is assembled, so there was never a moment at which someone could have
 * noticed. This adds both: the check, and the board the check belongs to.
 *
 * Set-based over a corpus of styles that must pass and must fail, because the
 * failure mode of a validator is asymmetric — one that rejects nothing is
 * useless, and one that rejects real cinematography is worse than useless
 * because it gets turned off.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-look-' + crypto.randomUUID().slice(0, 8));

const { ensureSchema } = require('../db/schema');
ensureSchema();

const look = require('../lib/look-development');

/**
 * Styles that describe a LOOK. Every one must pass — a validator that rejects
 * real cinematographic vocabulary will be switched off within a day, and then
 * it protects nothing.
 */
const MUST_PASS = [
    'teal and amber palette, wet streets, mist, anamorphic, 35mm film grain',
    'Guillermo del Toro gothic: teal/amber, wet streets, anamorphic, grain',
    'high contrast black and white, hard shadows, 1940s film noir',
    'soft natural light, pastel palette, shallow depth of field, Kodak Portra',
    'desaturated, handheld, documentary realism, available light',
    'neon-lit, rain-slicked, cyberpunk, volumetric haze, anamorphic flares',
    'warm golden hour, long lenses, gauzy diffusion',
    'cold clinical fluorescents, symmetrical framing, wide lenses',
];

/**
 * Styles carrying a SUBJECT. Every one must be caught — these are things that
 * will be drawn into frames nobody wrote them into.
 */
const MUST_FAIL = [
    'teal/amber, wet streets, mist, anatomical beast, anamorphic, grain',
    'moody lighting, a dragon, film grain',
    'noir palette, woman in a red dress, hard shadows',
    'gothic, gargoyle, wet stone, anamorphic',
    'warm light, a horse in the background, 35mm',
];

test('the corpus is big enough to mean something', () => {
    assert.ok(MUST_PASS.length >= 8 && MUST_FAIL.length >= 5,
        'a validator checked against two examples proves nothing');
});

test('no real cinematographic style is rejected', () => {
    const wrong = MUST_PASS.filter(s => !look.validateStylePreset(s).ok)
        .map(s => `${s} → ${JSON.stringify(look.validateStylePreset(s).subjects)}`);
    assert.deepStrictEqual(wrong, [],
        `these describe a look and were rejected; a validator this noisy gets switched off:\n  ${wrong.join('\n  ')}`);
});

test('every style carrying a subject is caught', () => {
    const missed = MUST_FAIL.filter(s => look.validateStylePreset(s).ok);
    assert.deepStrictEqual(missed, [],
        `these put a thing in every frame of the production and passed:\n  ${missed.join('\n  ')}`);
});

test('the warning names the offending words, not just the fact of them', () => {
    // "Your style may contain a subject" sends the director back to read their
    // own string. Naming the word is the difference between a warning and a fix.
    const r = look.validateStylePreset('teal/amber, wet streets, anatomical beast, grain');
    assert.strictEqual(r.ok, false);
    assert.ok(r.subjects.some(w => /beast/i.test(w)),
        `the offending word was not named; got ${JSON.stringify(r.subjects)}`);
    assert.ok(String(r.detail || '').length > 20, 'no explanation of why this matters');
});

test('an empty or absent style is not an error', () => {
    // Plenty of projects have no style at all, and a validator that fails them
    // would block project creation for no reason.
    for (const v of ['', null, undefined, '   ']) {
        assert.strictEqual(look.validateStylePreset(v).ok, true, `empty style rejected: ${JSON.stringify(v)}`);
    }
});

test('validation warns, it does not block', () => {
    // Previs already set this precedent: errors block a save, warnings do not.
    // A director may genuinely want a creature in every frame of a creature
    // film, and refusing to save it would be the tool overruling the author.
    const r = look.validateStylePreset('gothic, gargoyle, wet stone');
    assert.strictEqual(r.ok, false, 'expected this to be flagged');
    assert.strictEqual(r.severity, 'warning',
        'a style preset check that blocks would overrule a director who meant it');
});


test('the warning reaches the project API, not just the library', () => {
    // A validator nothing calls is a library. This is the exact string that
    // shipped, so the check is proven against the real defect rather than a
    // synthetic one.
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'projects.js'), 'utf8');
    assert.ok(/validateStylePreset/.test(src), 'routes/projects.js never validates the style preset');
    assert.ok(/style_warning/.test(src), 'the warning is computed and never returned to the caller');

    const real = 'Guillermo del Toro gothic: teal/amber, wet streets, mist, anatomical beast, anamorphic, grain';
    const r = look.validateStylePreset(real);
    assert.strictEqual(r.ok, false, 'the style that shipped the defect still passes');
    assert.deepStrictEqual(r.subjects, ['beast']);
});
