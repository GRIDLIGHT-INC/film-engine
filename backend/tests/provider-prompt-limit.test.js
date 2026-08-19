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
    // whole complaint was about.
    const appearanceAt = s => (s.match(/A+/g) || [''])[0].length;
    assert.ok(appearanceAt(atMeshy) > appearanceAt(atRunway),
        `appearance survived ${appearanceAt(atRunway)} chars at both ceilings`);
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
