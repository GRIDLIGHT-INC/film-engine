/**
 * Two things a plate has to get right, and one thing a keyframe prompt does not.
 *
 * SHEET FURNITURE. The character plate builder leads with "character reference
 * sheet", and an image model takes that literally: the first real plate came
 * back with a handwritten "FRONT / mid 30s" caption, a colour-swatch chart
 * labelled in gibberish, and a strip of tape. The person underneath was right —
 * photoreal, correct wardrobe — but a plate conditions every frame the subject
 * appears in, so baked-in captions and swatches bleed into all of them. The
 * negative prompt said "text, watermark" and nothing about labels, charts,
 * annotations or handwriting, which is most of what actually appeared.
 *
 * ADAPTIVE BUDGET. A keyframe prompt spends APPEARANCE_ALLOWANCE on describing
 * a character and LOCATION_ALLOWANCE on describing a place. When a plate for
 * that subject is ATTACHED to the request, the picture already says all of it —
 * so the prose is at best redundant and at worst contradicts the image. The
 * budget it consumes should go to the things no image carries: the action, and
 * the camera. Today the allowances are the same either way.
 *
 * Set-based over the plate kinds and over the subject kinds, because the
 * failure is per-kind: the location plate came out clean while the character
 * plate came out covered in annotations, from the same builder.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { NEGATIVE, buildPlatePrompt } = require('../lib/reference-plates');
const { buildRefSheetPrompt, REFSHEET_NEGATIVE } = require('../routes/characters');
const sp = require('../lib/storyboard-prompt');

/** Everything that produces a reference plate, and the negative it sends. */
const PLATE_BUILDERS = [
    { id: 'character', negative: () => REFSHEET_NEGATIVE,
      prompt: style => buildRefSheetPrompt({ name: 'MAYA', appearance_prompt: 'mid-30s woman' }, 'front', style) },
    { id: 'location', negative: () => NEGATIVE,
      prompt: style => buildPlatePrompt('location', { name: 'STREET', description: 'a cul-de-sac' }, style) },
    { id: 'prop', negative: () => NEGATIVE,
      prompt: style => buildPlatePrompt('prop', { name: 'BAG', visual_prompt: 'paper bag' }, style) },
];

/**
 * What actually appeared on the first real plate, plus its obvious neighbours.
 * A plate is a picture of a subject; every one of these is a picture of a
 * DOCUMENT about the subject.
 */
const SHEET_FURNITURE = ['text', 'label', 'annotation', 'caption', 'handwriting', 'chart', 'swatch', 'watermark'];

test('every plate builder refuses sheet furniture in its negative', () => {
    const gaps = [];
    for (const b of PLATE_BUILDERS) {
        const neg = String(b.negative() || '').toLowerCase();
        const missing = SHEET_FURNITURE.filter(w => !neg.includes(w));
        if (missing.length) gaps.push(`${b.id}: negative never mentions ${missing.join(', ')}`);
    }
    assert.deepStrictEqual(gaps, [], `\n  ${gaps.join('\n  ')}`);
});

test('no plate prompt asks for a document about the subject', () => {
    // "reference sheet" is what produced the captions. A plate is a photograph
    // of a thing, not a page describing it.
    const asking = PLATE_BUILDERS
        .filter(b => /reference sheet|character sheet|model sheet/i.test(b.prompt('teal and amber')))
        .map(b => b.id);
    assert.deepStrictEqual(asking, [],
        `these ask an image model for a sheet, and it draws one: ${asking.join(', ')}`);
});

test('a plate still says which view it is, or a turnaround is meaningless', () => {
    // The fix must not throw away the thing that makes three plates a
    // turnaround rather than three unrelated pictures.
    const front = buildRefSheetPrompt({ name: 'MAYA', appearance_prompt: 'x' }, 'front', null);
    const side = buildRefSheetPrompt({ name: 'MAYA', appearance_prompt: 'x' }, 'side', null);
    assert.ok(/front/i.test(front) && /side/i.test(side), 'the view is gone from the prompt');
    assert.notStrictEqual(front, side, 'every view now produces the same prompt');
});

// ── Adaptive budget ────────────────────────────────────────────────────────

const CARD = {
    shot_code: '1A',
    description: 'She stops at the door, turns, and looks back down the street as the light fails.',
    camera: { shot_type: 'medium', lens: '35mm', movement: 'dolly-in' },
    lighting: { type: 'natural' },
    characters: ['MAYA'],
};
const CHARS = [{ name: 'MAYA', appearance_prompt: 'A'.repeat(400) }];
const LOCATION = { name: 'STREET', description: 'B'.repeat(400) };

/** The subjects whose prose a plate can replace. */
const SUBJECT_KINDS = [
    { id: 'character', ref: { name: 'MAYA', kind: 'character', file_path: '/tmp/m.png' }, filler: 'A' },
    { id: 'location', ref: { name: 'STREET', kind: 'location', file_path: '/tmp/s.png' }, filler: 'B' },
];

test('a plate replaces its subject prose ONLY where the provider can name it', () => {
    // I got this backwards first time and a test caught it.
    //
    // The tempting rule is "a picture is attached, so drop the words". That is
    // right for a provider that reads @tags: the tag binds THIS image to THAT
    // subject, so the paragraph is redundant. It is wrong for one that takes an
    // untagged array — with two references and no names, nothing tells the model
    // which picture is the woman and which is the street, so the words are the
    // only thing carrying identity. Dropping them there trades a redundancy for
    // a wrong subject.
    const refs = SUBJECT_KINDS.map(k => ({ ...k.ref, tag: k.id, uri: 'data:image/png;base64,AAA' }));

    const tagged = sp.buildStoryboardPrompt(CARD, CHARS, LOCATION, 'teal and amber',
        { references: refs, tagged: true }).prompt;
    const untagged = sp.buildStoryboardPrompt(CARD, CHARS, LOCATION, 'teal and amber',
        { references: refs, tagged: false }).prompt;

    assert.ok(!tagged.includes('A'.repeat(50)),
        'a taggable provider was sent the plate AND the paragraph describing it');
    assert.ok(untagged.includes('A'.repeat(50)),
        'an untaggable provider lost the words that say which picture is the subject');
    assert.ok(untagged.length > tagged.length,
        'the two paths produce the same prompt, so the distinction does nothing');
});

test('the action survives on both paths, because no plate carries it', () => {
    const refs = SUBJECT_KINDS.map(k => ({ ...k.ref, tag: k.id, uri: 'data:image/png;base64,AAA' }));
    for (const tagged of [true, false]) {
        const prompt = sp.buildStoryboardPrompt(CARD, CHARS, LOCATION, 'teal and amber',
            { references: refs, tagged }).prompt;
        assert.ok(prompt.includes('She stops at the door'),
            `the action was trimmed away (tagged=${tagged}) while subject prose was kept`);
    }
});

test('a subject with no plate still gets described', () => {
    // The guarantee that keeps a project which has never generated a plate
    // working exactly as before.
    const prompt = sp.buildStoryboardPrompt(CARD, CHARS, LOCATION, 'teal and amber', {}).prompt;
    assert.ok(prompt.includes('A'.repeat(50)), 'a character with no plate lost its description');
});

/**
 * One generator per subject kind, and the UI uses it.
 *
 * Locations and props had TWO image generators: lib/reference-plates.js, which
 * carries the style-leads ordering, the sheet-furniture negative, the prop
 * visual_prompt and the staleness stamp — and an older pair,
 * generateLocationImage / generatePropImage, which had none of them. The MCP
 * tool called the first; the button in the UI called the second. So the same
 * click produced a materially worse plate depending on where you clicked it.
 *
 * CLAUDE.md already warns about exactly this in the note explaining why
 * locations and props share one implementation. A second one existed anyway.
 */
test('the UI generates plates through the plate builder, not the old path', () => {
    const fs = require('fs');
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    const old = (html.match(/\/image\/generate/g) || []).length;
    assert.strictEqual(old, 0,
        'the UI still calls image/generate, a second generator that never inherited the plate fixes');
    for (const kind of ['locations', 'props', 'characters']) {
        const re = new RegExp(`/${kind}/'?\\s*\\+[^;]*(plate|refsheet)/generate`);
        assert.ok(re.test(html), `${kind} has no button reaching the plate builder`);
    }
});
