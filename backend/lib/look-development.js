/**
 * Look development: deciding how a film looks, and catching a style that
 * quietly describes a subject.
 *
 * The defect this exists for shipped. A project's style_preset read
 * "…teal/amber, wet streets, mist, ANATOMICAL BEAST, anamorphic, grain", and
 * that string is appended to every image prompt in the production. So the
 * establishing shot — scene card: "Empty, ordinary, still." — came back with a
 * flayed quadruped standing in the road, and the sprinkler insert came back
 * with a gargoyle at its base. Nobody wrote those shots; the style did.
 *
 * A style preset is a free-text column, applied everywhere, validated nowhere,
 * and there was no surface on which a look was ever assembled — so there was
 * no moment at which anyone could have noticed. This module is that moment.
 *
 * It WARNS, never blocks. Previs set the precedent: errors stop a save,
 * warnings do not. A creature film may legitimately want a creature in every
 * frame, and a tool that refuses to save that is overruling its author.
 */

/**
 * Words that name a THING rather than a quality of light.
 *
 * Deliberately concrete and deliberately short. The asymmetry matters: a
 * validator that rejects real cinematographic vocabulary gets switched off
 * within a day and then protects nothing, so the list covers subjects that
 * plausibly appear in a style string — creatures, people, animals, objects —
 * and stops well short of guessing.
 */
const SUBJECT_WORDS = [
    // Creatures and figures — the category that actually bit us.
    'beast', 'creature', 'monster', 'dragon', 'gargoyle', 'demon', 'ghost', 'zombie',
    'alien', 'robot', 'android', 'skeleton', 'corpse', 'body',
    // People.
    'man', 'woman', 'child', 'girl', 'boy', 'person', 'people', 'crowd', 'figure',
    'soldier', 'knight', 'priest', 'dancer',
    // Animals.
    'horse', 'dog', 'cat', 'bird', 'wolf', 'snake', 'insect', 'spider',
    // Objects that get drawn.
    'car', 'sword', 'gun', 'castle', 'ship', 'train', 'house', 'tree', 'flower',
];

/**
 * Words that look like subjects but are established cinematographic vocabulary.
 *
 * Without this, "body" in "body of light" and the "grain" in "film grain" start
 * failing real styles — and a false positive here is more expensive than a
 * miss, because it teaches the director to ignore the warning.
 */
const LOOK_EXCEPTIONS = new Set([
    'bodycam', 'bodies',      // "bodies of light" reads as a look
    'housing', 'household',
    'carbon', 'cartoon',
    'birdseye', 'birdlike',
]);

const WORD_RE = /[a-z][a-z'-]*/gi;

/**
 * Does this style preset describe a subject as well as a look?
 *
 * @returns {{ ok: boolean, severity: string, subjects: string[], detail: string }}
 */
function validateStylePreset(style) {
    const text = String(style || '').trim();
    // No style at all is normal and must never be an error — plenty of projects
    // have none, and failing them would block project creation for no reason.
    if (!text) return { ok: true, severity: 'ok', subjects: [], detail: '' };

    const words = (text.toLowerCase().match(WORD_RE) || []);
    const found = [];
    for (const raw of words) {
        const word = raw.replace(/[^a-z]/g, '');
        if (!word || LOOK_EXCEPTIONS.has(word)) continue;
        // Match the bare word and its simple plural only. Substring matching
        // turns "grainy" into "rain" and every style into a failure.
        const hit = SUBJECT_WORDS.find(sw => word === sw || word === sw + 's' || word === sw + 'es');
        if (hit && !found.includes(hit)) found.push(hit);
    }

    if (!found.length) return { ok: true, severity: 'ok', subjects: [], detail: '' };

    return {
        ok: false,
        severity: 'warning',
        subjects: found,
        detail: `A style preset is applied to EVERY image prompt in the production, so a subject named here `
            + `is drawn into frames nobody wrote it into — this is how an establishing shot described as `
            + `"empty, ordinary, still" came back with a creature standing in the road. `
            + `Move ${found.map(w => `"${w}"`).join(', ')} onto the character or prop it belongs to, `
            + `and keep the style to light, palette, lens and grain. Saved either way.`,
    };
}

module.exports = { validateStylePreset, SUBJECT_WORDS, LOOK_EXCEPTIONS };
