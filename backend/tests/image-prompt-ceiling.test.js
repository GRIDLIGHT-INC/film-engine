/**
 * The ceiling every image prompt is built against.
 *
 * `promptLimit` on an adapter is not a preference — it decides how much of what
 * a director wrote survives into the request. Meshy's was 4000, chosen by us as
 * a guess matched to the models it proxies, with a note to raise it if a longer
 * prompt was ever seen to work.
 *
 * It was seen. On a real production every shot sat against that ceiling — nine
 * of nine between 3632 and 3992 — and eight ended MID-CLAUSE, the last thing
 * the model read being a parked car's paint, with the closing quality tags cut
 * entirely. On 2B the subject descriptions wanted 4355 characters and got 945:
 * DRAGON kept 891 of 891 while MAYA, the protagonist, was cut to 165. That
 * split was arrival order surviving as policy rather than a decision.
 *
 * Meshy then accepted an 11,671-character prompt and returned an image. So the
 * ceiling was never protecting anything; it was amputating the back of every
 * request in the film.
 *
 * This file exists so that number cannot quietly walk back, and so the same
 * mistake is not made on a different adapter.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const providers = require('../lib/providers');

/*
 * The longest prompt observed to be ACCEPTED by Meshy, in a real generation
 * against the live adapter — Wingfall 2B, which produced v22.
 *
 * This is evidence, not a target. It is the floor Meshy's declared ceiling has
 * to clear, because a ceiling below a prompt we have watched succeed is a
 * ceiling that throws away work for no reason.
 */
const MEASURED_ACCEPTED = 11671;

/*
 * What each image adapter declares, and why. Runway's is documented by Runway;
 * OpenAI's is the Images API's own length; Gridlight is a swappable local agent
 * held strict on purpose, because over-guessing produces a rejection at the
 * provider where trimming here can at least be reported.
 *
 * Meshy is the only one of the four whose provider documents no limit at all,
 * which is why it is the only one that could be raised on evidence.
 */
const EXPECTED = {
    meshy: { min: MEASURED_ACCEPTED, exact: 16000, documented: false },
    /*
     * Google states Gemini's input limit in TOKENS, not characters, and the
     * context window for these models is far larger than any prompt this engine
     * assembles. 16000 characters is roughly 4k tokens — comfortably inside it —
     * and matches the largest figure already used here rather than inventing a
     * new one. NOT documented as a character count, so it is marked as such.
     */
    google: { exact: 16000, documented: false },
    /*
     * MuAPI proxies the same Nano Banana (Gemini) models google-image reaches
     * directly, so the ceiling is theirs and the reasoning above applies
     * unchanged: stated in TOKENS upstream, not characters, and 16000
     * characters is comfortably inside the context these models carry. Matched
     * to the sibling adapter rather than invented, and marked undocumented
     * because no character count is published.
     */
    muapi: { exact: 16000, documented: false },
    /*
     * BFL publishes no character limit for FLUX.2. Held at 4000, matching
     * OpenAI's documented figure, on the same reasoning Meshy's was set:
     * matched to a comparable model rather than assumed unbounded.
     *
     * UNVERIFIED AND WORTH RE-CHECKING: FLUX.1 truncated at the T5 encoder's
     * 512 tokens SILENTLY rather than rejecting. If FLUX.2 inherits that, a
     * long prompt loses its tail — where the location and the style sit — with
     * nothing reported. A silent truncation is worse than a rejection, so this
     * number should be confirmed against a real long-prompt generation before
     * the draft tier is used at volume.
     */
    bfl: { exact: 4000, documented: false },
    runway: { exact: 1000, documented: true },
    openai: { exact: 4000, documented: true },
    gridlight: { exact: 1000, documented: true },
};

function imageAdapters() {
    const out = new Map();
    for (const entry of providers.list()) {
        const id = entry.id || entry.provider || entry.name;
        const caps = entry.capabilities || [];
        if (!caps.includes('image')) continue;
        out.set(id, entry);
    }
    return out;
}

test('every image adapter declares an explicit prompt ceiling', () => {
    const adapters = imageAdapters();
    assert.ok(adapters.size >= 4,
        `expected at least 4 image adapters, found ${[...adapters.keys()].join(', ')}`);

    const missing = [...adapters.entries()]
        .filter(([, a]) => !(Number(a.promptLimit) > 0))
        .map(([id]) => id);
    assert.deepStrictEqual(missing, [],
        'an adapter with no declared ceiling falls back to the strict default, which '
        + 'silently trims a provider that may take far more');
});

test('each image adapter holds the ceiling it is supposed to hold', () => {
    const adapters = imageAdapters();
    const wrong = [];

    for (const [id, adapter] of adapters) {
        const want = EXPECTED[id];
        if (!want) {
            wrong.push(`${id}: a new image adapter with no declared expectation — `
                + 'add it here with its number and the reason, or it inherits a guess');
            continue;
        }
        const got = Number(adapter.promptLimit);
        if (want.exact !== undefined && got !== want.exact) {
            wrong.push(`${id}: declares ${got}, expected ${want.exact}`);
        }
        if (want.min !== undefined && !(got >= want.min)) {
            wrong.push(`${id}: declares ${got}, below the ${want.min}-character prompt `
                + 'this provider was measured accepting in a real generation');
        }
    }
    assert.deepStrictEqual(wrong, [],
        'a declared ceiling moved without the evidence moving with it');
});

test('raising one adapter did not move the others', () => {
    /*
     * The failure this guards is the one that created the problem: a number
     * belonging to ONE provider applied to everybody. Runway's 1000 was once
     * imposed on every prompt in the product. Meshy going to 16000 must not
     * become the new universal either.
     */
    const adapters = imageAdapters();
    const drifted = [];
    for (const [id, adapter] of adapters) {
        if (id === 'meshy') continue;
        const want = EXPECTED[id];
        if (want && Number(adapter.promptLimit) !== want.exact) {
            drifted.push(`${id}: ${adapter.promptLimit} (expected ${want.exact})`);
        }
    }
    assert.deepStrictEqual(drifted, [],
        'another adapter moved when only Meshy had evidence to move on');
});

test('the ceiling is read from the adapter, never hardcoded in a route', () => {
    /*
     * Preview and paid generation must be built against the SAME ceiling, and
     * the only way that holds under change is for neither to know a number.
     * A route carrying its own literal is how the preview came to promise
     * something the purchase did not send, one confer ago.
     */
    const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const offenders = [];
    for (const rel of ['routes/storyboard.js', 'lib/capability-payloads.js']) {
        const src = strip(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
        for (const m of src.matchAll(/maxPromptChars\s*:\s*([^,\n}]+)/g)) {
            const value = m[1].trim();
            if (/^\d+$/.test(value)) offenders.push(`${rel}: maxPromptChars hardcoded to ${value}`);
        }
    }
    assert.deepStrictEqual(offenders, [],
        'a route that hardcodes the ceiling cannot follow an adapter that changes');
});

test('preview and paid generation resolve the same ceiling', () => {
    /*
     * Both paths go through buildCapabilityPayload, so they share
     * imagePromptLimit by construction. Asserted rather than assumed, because
     * "they use the same function" is exactly what stopped being true the last
     * time a paid route grew its own builder.
     */
    const payloadSrc = fs.readFileSync(
        path.join(__dirname, '..', 'lib/capability-payloads.js'), 'utf8');
    const derives = /const\s+promptLimit\s*=\s*[\s\S]{0,180}imagePromptLimit\(ctx\.project\)/
        .test(payloadSrc);
    const uses = (payloadSrc.match(/maxPromptChars:\s*promptLimit/g) || []).length;
    assert.ok(derives && uses >= 1,
        'the shared payload path no longer derives its default ceiling from the adapter');

    const boardSrc = fs.readFileSync(
        path.join(__dirname, '..', 'routes/storyboard.js'), 'utf8');
    const ownBuilders = (boardSrc.match(/\bbuildStoryboardPrompt\s*\(/g) || []).length;
    assert.strictEqual(ownBuilders, 0,
        'the board builds a prompt outside the shared path, so it can diverge from the preview');
});
