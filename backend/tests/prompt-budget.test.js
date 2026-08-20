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

/**
 * A generated plate is findable by the list that displays it.
 *
 * Both halves of this were broken and neither failed loudly. The list built
 * URLs pointing at 'loc-refs' and 'prop-refs' while the plate builder wrote to
 * 'refsheets', so a URL came back and pointed at a directory the file was not
 * in. And the prop lookup searched the METADATA blob for a prop_id, while
 * migration 061 added a prop_id COLUMN precisely so a prop plate had somewhere
 * to link — which is what the builder writes. So a plate that existed, and was
 * correctly linked, rendered as nothing.
 *
 * Set-based over the plate kinds because the two faults were in different
 * kinds: locations had the wrong directory, props had the wrong column.
 */
test('the list reads plates from where the builder writes them', () => {
    const fs = require('fs');
    const { PLATE_KINDS } = require('../lib/reference-plates');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'locations.js'), 'utf8');

    // Scoped to the LIST functions, which are what the UI displays from. The
    // older generateLocationImage / generatePropImage still use their own
    // directory; they are unreachable from the UI now and are a duplicate that
    // should go, but they are not what this invariant is about.
    const listBodies = ['listLocations', 'listProps'].map(fn => {
        const i = src.indexOf(`function ${fn}(`);
        assert.ok(i > 0, `${fn} is gone`);
        return src.slice(i, src.indexOf('\n}', i));
    }).join('\n');

    for (const stale of ["'loc-refs'", "'prop-refs'"]) {
        assert.ok(!listBodies.includes(stale),
            `a list still builds a URL with ${stale}, which is not where plates are written`);
    }
    assert.ok(/PLATE_KINDS\.location\.subdir/.test(src) && /PLATE_KINDS\.prop\.subdir/.test(src),
        'the subdir is a literal again and can drift from the builder');

    // Props link by column, not by a LIKE against metadata — scoped to the
    // list for the same reason as above.
    assert.ok(!/metadata LIKE/.test(listBodies),
        'the prop plate lookup still searches metadata for a prop_id');
    assert.ok(/reference_image' AND prop_id = \?/.test(listBodies),
        'the prop plate lookup does not use the prop_id column');

    // And both kinds still agree with the builder about the asset type.
    for (const kind of ['location', 'prop']) {
        assert.strictEqual(PLATE_KINDS[kind].assetType, 'reference_image',
            `${kind} plates are no longer written as reference_image`);
    }
});

/**
 * The trimmer has to see the whole prompt, including the part it did not build.
 *
 * Locked consistency profiles append their prompt_contract AFTER
 * buildStoryboardPrompt has assembled against the provider ceiling — so the
 * ceiling was enforced on a string that then grew by thousands of characters.
 * On a real establishing shot: a ~1,500-character base plus three locked
 * profiles adding 3,445, for 4,946 against a 4,000 ceiling.
 *
 * Three symptoms, one cause, and all three looked like the model misbehaving.
 * The provider truncates the TAIL, and the tail was the location, so the street
 * stopped looking like the street. A 653-character description of a lawn
 * sprinkler sat FIRST, so it was drawn the size of the car beside it. And the
 * style preset was outweighed three to one by object prose, so the look went.
 */
const { fitAdditions, ADDITION_RANK } = require('../lib/consistency-apply');

const CONTRACTS = [
    { text: 'S'.repeat(653), profile_type: 'prop', subject_name: 'Sprinkler' },
    { text: 'C'.repeat(1936), profile_type: 'prop', subject_name: 'SEDAN' },
    { text: 'L'.repeat(856), profile_type: 'location', subject_name: 'STREET' },
    { text: 'M'.repeat(800), profile_type: 'character', subject_name: 'MAYA' },
];

test('additions never push the prompt past the provider ceiling', () => {
    const base = 'B'.repeat(1500);
    const out = fitAdditions(base, { prompt_addition_items: CONTRACTS }, { maxPromptChars: 4000 });
    const total = base.length + out.join(', ').length + 2;
    assert.ok(total <= 4000, `assembled prompt is ${total} against a ceiling of 4000`);
});

test('a place and its people outrank the objects in it', () => {
    // With limited room, a viewer notices a different street long before a
    // different sprinkler. Same reasoning as the reference selector's KIND_RANK.
    assert.ok(ADDITION_RANK.character < ADDITION_RANK.prop);
    assert.ok(ADDITION_RANK.location < ADDITION_RANK.prop);

    const out = fitAdditions('B'.repeat(3400), { prompt_addition_items: CONTRACTS }, { maxPromptChars: 4000 });
    const kinds = out.map(t => t[0]);      // M = character, L = location, S/C = props
    assert.strictEqual(kinds[0], 'M', 'a prop was described before the character in the shot');
    assert.strictEqual(kinds[1], 'L', 'a prop was described before the place the shot is in');
});

test('the shot itself is never cut to make room for a prop', () => {
    // The base prompt is the action, the camera and the look. An object in the
    // frame does not get to displace the frame.
    const base = 'B'.repeat(3980);
    const out = fitAdditions(base, { prompt_addition_items: CONTRACTS }, { maxPromptChars: 4000 });
    assert.deepStrictEqual(out, [], 'additions were emitted with no room left for them');
});

test('with no ceiling nothing is trimmed, so a permissive provider loses nothing', () => {
    const out = fitAdditions('B'.repeat(100), { prompt_addition_items: CONTRACTS }, {});
    assert.strictEqual(out.length, CONTRACTS.length);
    assert.strictEqual(out.join('').length, CONTRACTS.reduce((n, c) => n + c.text.length, 0));
});

test('a trimmed description keeps its opening, which is what the thing IS', () => {
    const items = [{ text: 'A four-door sedan, forest green. Rust along the sills. Bench seats in tan vinyl.',
                     profile_type: 'prop', subject_name: 'SEDAN' }];
    const out = fitAdditions('', { prompt_addition_items: items }, { maxPromptChars: 60 });
    assert.ok(out[0].startsWith('A four-door sedan'),
        'the cut landed somewhere other than the front, so the object is no longer identified');
});

/**
 * A subject whose picture is attached needs naming, not describing.
 *
 * On a real establishing shot all three subjects contributing prose also had
 * their plates attached as references — 3,445 characters spent describing
 * pictures the model was already looking at. That is not merely wasteful: it
 * pushed the prompt past the ceiling, buried the style preset, and gave a lawn
 * sprinkler the same descriptive weight as the street it sits in, so it was
 * drawn the size of the car parked beside it.
 */
const { hasReference } = require('../lib/consistency-apply');

const PLATED = {
    prompt_addition_items: [
        { text: 'Late-1970s North American full-size four-door sedan, long flat hood. Rust along the sills. '
              + 'Bench seats in cracked tan vinyl.', profile_type: 'prop', subject_name: 'SEDAN' },
    ],
    references: [{ subject_name: 'SEDAN', profile_type: 'prop' }],
};

test('an unplated subject keeps its full description', () => {
    // The prose exists for exactly this: a subject with no picture, and a
    // provider handed an untagged array with nothing to say which is which.
    const unplated = { prompt_addition_items: PLATED.prompt_addition_items, references: [] };
    const out = fitAdditions('', unplated, { maxPromptChars: 4000 });
    assert.ok(/tan vinyl/.test(out[0]), 'a subject with no plate lost its description');
});

test('a reference for a different subject does not shorten this one', () => {
    const other = {
        prompt_addition_items: PLATED.prompt_addition_items,
        references: [{ subject_name: 'SUBURBAN STREET', profile_type: 'location' }],
    };
    assert.strictEqual(hasReference(other, PLATED.prompt_addition_items[0]), false);
    assert.ok(/tan vinyl/.test(fitAdditions('', other, { maxPromptChars: 4000 })[0]));
});


/**
 * A subject travels as a picture AND its description. Both, always.
 *
 * Shortening a described subject to a name because its plate is attached was
 * tried and reverted. The reasoning was sound — a plate shows what a subject
 * looks like, so describing it again is redundant — and it was wrong in
 * practice for one reason: the picture does not always arrive. A provider takes
 * three references and a shot can want five, and one generation path was
 * attaching none at all. Every time the picture was missing, the shortened
 * subject travelled with neither words nor image, and the model built whatever
 * was still described at length — which is how an establishing shot came back
 * as a product photograph of a car on grey seamless.
 *
 * A redundant description costs room. A missing one costs the shot.
 */
test('a subject with a plate keeps its full description', () => {
    const items = [{ text: `A green four-door sedan. ${'C'.repeat(900)}`,
                     profile_type: 'prop', subject_name: 'SEDAN' }];
    const plated = { prompt_addition_items: items,
                     references: [{ subject_name: 'SEDAN', profile_type: 'prop' }] };
    const out = fitAdditions('', plated, { maxPromptChars: 4000 });
    assert.ok(out[0].length > 500,
        'a description was dropped because a picture was attached; the picture does not always arrive');
});
