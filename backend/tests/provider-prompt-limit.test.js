/**
 * The prompt ceiling belongs to the provider, not to the engine.
 *
 * MAX_PROMPT_CHARS was a single constant — 1000, chosen as "the strictest of
 * the providers wired here", which is Runway's text_to_image limit. Every
 * prompt in the product was cut to it regardless of who was generating. So a
 * production running on Meshy, whose text-to-image documents no limit at all
 * and which routes to nano-banana and gpt-image-2, had its character
 * descriptions trimmed to fit a cap belonging to a provider it never called.
 *
 * The per-field allowances have the same problem one level down: 240 for an
 * appearance and 200 for a location are not facts about appearances and
 * locations, they are a carve-up of that 1000. If the ceiling moves, the
 * carve-up has to move with it or the extra room goes unused.
 *
 * Set-based over the adapters that serve `image`, because a limit missing from
 * one of them is invisible until someone generates with that one and quietly
 * gets a shorter prompt than they wrote.
 */

const test = require('node:test');
const assert = require('node:assert');

const providers = require('../lib/providers');
const sp = require('../lib/storyboard-prompt');

/** Everything that can actually produce an image. */
const IMAGE_ADAPTERS = providers.list().filter(a => a.supports && a.supports('image'));

test('there are image adapters to check', () => {
    assert.ok(IMAGE_ADAPTERS.length >= 3, `expected several, found ${IMAGE_ADAPTERS.map(a => a.id).join(', ')}`);
});

test('every image adapter declares what its prompt ceiling is', () => {
    const silent = IMAGE_ADAPTERS
        .filter(a => typeof a.promptLimit !== 'number' || !(a.promptLimit > 0))
        .map(a => a.id);
    assert.deepStrictEqual(silent, [],
        `these generate images and never say how much prompt they accept: ${silent.join(', ')}`);
});

test('the declared ceilings are not all the same number', () => {
    // If they were, this would be the old constant wearing a new coat.
    const limits = new Set(IMAGE_ADAPTERS.map(a => a.promptLimit));
    assert.ok(limits.size > 1,
        `every adapter declares ${[...limits][0]}, so nothing was actually made provider-specific`);
});

test('Runway keeps the limit that was measured against it', () => {
    // The 1000 was not arbitrary — it is Runway's documented text_to_image cap,
    // and the old constant's only mistake was applying it to everyone.
    const runway = IMAGE_ADAPTERS.find(a => a.id === 'runway');
    assert.ok(runway, 'runway no longer serves image');
    assert.strictEqual(runway.promptLimit, 1000);
});

test('allowances are a carve-up of the ceiling, not fixed numbers', () => {
    const tight = sp.allowancesFor(1000);
    const roomy = sp.allowancesFor(4000);
    const fields = ['action', 'appearance', 'location', 'style'];
    const stuck = fields.filter(f => roomy[f] <= tight[f]);
    assert.deepStrictEqual(stuck, [],
        `these did not grow with a bigger ceiling: ${stuck.join(', ')}`);
    // And at the old ceiling they must be what they always were, or every
    // existing project's prompts change shape for no reason.
    assert.strictEqual(tight.action, sp.ACTION_ALLOWANCE);
    assert.strictEqual(tight.appearance, sp.APPEARANCE_ALLOWANCE);
    assert.strictEqual(tight.location, sp.LOCATION_ALLOWANCE);
    assert.strictEqual(tight.style, sp.STYLE_ALLOWANCE);
});

test('a roomier provider actually receives more of what was written', () => {
    // The point of the whole change: not a bigger number in a config, but more
    // of the director's description reaching the model.
    const card = {
        shot_code: '1A', camera: { shot_type: 'medium', lens: '35mm' }, lighting: { type: 'natural' },
        description: 'D'.repeat(600), characters: ['MAYA'],
    };
    const chars = [{ name: 'MAYA', appearance_prompt: 'A'.repeat(600) }];
    const loc = { name: 'STREET', description: 'L'.repeat(600) };

    const atRunway = sp.buildStoryboardPrompt(card, chars, loc, 'S'.repeat(400), { maxPromptChars: 1000 }).prompt;
    const atMeshy = sp.buildStoryboardPrompt(card, chars, loc, 'S'.repeat(400), { maxPromptChars: 4000 }).prompt;

    assert.ok(atRunway.length <= 1000, `Runway prompt overran its own cap at ${atRunway.length}`);
    assert.ok(atMeshy.length > atRunway.length,
        'a provider with four times the room received exactly as much');
    assert.ok(atMeshy.length <= 4000, `overran the roomier cap too, at ${atMeshy.length}`);

    // Specifically: more of the APPEARANCE survives, which is the field the
    // whole complaint was about. Measured as the longest run of the filler, so
    // an incidental letter elsewhere in the prompt cannot be mistaken for it.
    const appearanceAt = s => Math.max(0, ...(s.match(/A+/g) || ['']).map(x => x.length));
    assert.ok(appearanceAt(atMeshy) > appearanceAt(atRunway),
        `appearance survived ${appearanceAt(atRunway)} chars at 1000 and ${appearanceAt(atMeshy)} at 4000`);
});

test('an unknown provider falls back to the strictest, never to unlimited', () => {
    // Guessing high on an undeclared provider produces a rejected request or a
    // silent truncation at the provider's end, which is worse than trimming here
    // where it can be reported.
    const fallback = sp.buildStoryboardPrompt(
        { shot_code: '1A', camera: {}, lighting: {}, description: 'D'.repeat(3000) }, [], null, null, {}).prompt;
    assert.ok(fallback.length <= sp.MAX_PROMPT_CHARS,
        `no ceiling given and the prompt ran to ${fallback.length}`);
});

/**
 * Nothing is trimmed while the prompt still fits.
 *
 * The per-field allowances were applied unconditionally, so a 570-character
 * style was cut to 560 in a prompt totalling 2,085 against a ceiling of 4,000 —
 * throwing away the tail of a director's look with 1,900 characters of headroom
 * going unused. The clause that vanished was "wet reflective ground with
 * specular sheen", which is exactly the sort of thing someone put on the board
 * deliberately.
 *
 * An allowance is a way of deciding WHAT TO CUT when something must be cut. It
 * is not a target to shrink every field to. So the prompt is assembled whole
 * first, and the allowances only come into play if the result overruns.
 *
 * Set-based over the allowance-bearing fields, because trimming one of them
 * needlessly is as wrong as trimming all four and much harder to notice.
 */
const ALLOWANCE_FIELDS = [
    { id: 'action', filler: 'D', put: (card) => { card.description = 'D'.repeat(400); } },
    { id: 'appearance', filler: 'A', put: (_c, chars) => { chars[0].appearance_prompt = 'A'.repeat(400); } },
    { id: 'location', filler: 'L', put: (_c, _ch, loc) => { loc.description = 'L'.repeat(400); } },
];

test('a field is not trimmed when the whole prompt fits', () => {
    const broken = [];
    for (const field of ALLOWANCE_FIELDS) {
        const card = { shot_code: '1A', description: 'x', camera: { shot_type: 'medium' }, lighting: { type: 'natural' }, characters: ['MAYA'] };
        const chars = [{ name: 'MAYA', appearance_prompt: 'x' }];
        const loc = { name: 'STREET', description: 'x' };
        field.put(card, chars, loc);

        // Roomy ceiling: everything together is far short of it.
        const { prompt } = sp.buildStoryboardPrompt(card, chars, loc, 'teal and amber', { maxPromptChars: 4000 });
        const longest = Math.max(0, ...(prompt.match(new RegExp(field.filler + '+', 'g')) || ['']).map(x => x.length));
        if (prompt.length > 4000) { broken.push(`${field.id}: prompt overran the ceiling`); continue; }
        if (longest < 400) {
            broken.push(`${field.id}: cut to ${longest} of 400 in a ${prompt.length}-char prompt `
                + `with ${4000 - prompt.length} characters of headroom unused`);
        }
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('the style survives whole when there is room for it', () => {
    // The exact case reported: 570 characters of composed look, cut to 560, in
    // a prompt less than half the ceiling.
    const style = 'S'.repeat(570);
    const { prompt } = sp.buildStoryboardPrompt(
        { shot_code: '1A', description: 'She stops.', camera: {}, lighting: { type: 'natural' } },
        [], null, style, { maxPromptChars: 4000 });
    // Containment, not a regex: a filler letter collides with ordinary words
    // in the prompt ("She stops." begins with an S), and the first match is not
    // the one under test.
    assert.ok(prompt.includes(style),
        `the look did not survive whole with room to spare (prompt ${prompt.length}/4000)`);
});

test('but a prompt that would overrun is still cut to fit', () => {
    // The allowances still do their job when they have to. Losing the guarantee
    // in the other direction would send a prompt a provider rejects.
    const { prompt } = sp.buildStoryboardPrompt(
        { shot_code: '1A', description: 'D'.repeat(3000), camera: {}, lighting: { type: 'natural' }, characters: ['MAYA'] },
        [{ name: 'MAYA', appearance_prompt: 'A'.repeat(3000) }],
        { name: 'STREET', description: 'L'.repeat(3000) },
        'S'.repeat(1000), { maxPromptChars: 1000 });
    assert.ok(prompt.length <= 1000, `overran its ceiling at ${prompt.length}`);
});
