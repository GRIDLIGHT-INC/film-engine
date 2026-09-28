/**
 * A shot's dialogue reaches the model, and says whether we SEE it spoken.
 *
 * Reported by the director: "the dialogue doesn't seem to transfer on the
 * shot list... and on the storyboard either... how will the video AI
 * generator know about the dialogue if it's not transferred into the shot."
 *
 * He was right, and the gap was wider than the symptom. `card.dialogue` was
 * written by the breakdown, stored, fingerprinted, read by voice generation,
 * the music context, the timeline and four reports — and read by NO prompt
 * builder and NO surface in the app. A film in which one man talks for
 * fifty-five of sixty-two seconds would have generated clips of a man
 * standing silently, and nothing anywhere would have said so.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const mp = require('../lib/motion-prompt');

const say = (line, extra) => ({ card: { action: 'He walks toward camera.',
    dialogue: [{ character: 'MANNY', line, ...(extra || {}) }] } });

test('a speaking shot tells the model the mouth is moving', () => {
    const { prompt } = mp.buildMotionPrompt(say('Everybody tells you it takes three months.'));
    assert.match(prompt, /SPEAKING ON CAMERA/,
        'the video model is not told the subject speaks, so it generates a closed mouth and the '
        + 'lip-sync pass has to fight the footage');
    assert.match(prompt, /MANNY/, 'the clause does not name who is speaking');
});

test('the WORDS are never sent to the video model', () => {
    /*
     * Deliberate. The lip-sync pass owns the phonemes, the words buy little
     * for lip shape, and a model handed a quoted sentence is liable to paint
     * it into the frame — which this production's style preset forbids
     * outright ("No on-screen text or logos").
     */
    const line = 'Everybody tells you a commercial takes three months.';
    const { prompt } = mp.buildMotionPrompt(say(line));
    assert.ok(!prompt.includes(line), 'the literal dialogue reached the video prompt');
    assert.ok(!prompt.includes('three months'), 'part of the line reached the video prompt');
});

test('a VOICE-OVER says the opposite: nobody in frame speaks', () => {
    /*
     * The failure this prevents is concrete. The last two shots of the
     * reference production are a voice over an empty burning street and over
     * a logo. "He is speaking" there would put a talking mouth where the
     * director deliberately put nobody — and saying NOTHING leaves the model
     * to guess, which it does differently every take.
     */
    for (const cue of [{ extension: 'V.O.' }, { extension: 'O.S.' }, { extension: 'VO' }]) {
        const { prompt } = mp.buildMotionPrompt(say('I only take one of these at a time.', cue));
        assert.match(prompt, /Nobody in frame is speaking/, `${cue.extension} was treated as on-camera`);
        assert.ok(!/SPEAKING ON CAMERA/.test(prompt), `${cue.extension} still claims on-camera speech`);
    }
});

test('the cue is read from the NAME too, not only a structured field', () => {
    // Cards written before the extension was carried store it as part of the
    // character name, if at all. Both shapes must resolve the same way.
    const { prompt } = mp.buildMotionPrompt({ card: { action: 'The car goes.',
        dialogue: [{ character: 'MANNY (V.O.)', line: 'So — what is your date?' }] } });
    assert.match(prompt, /Nobody in frame is speaking/,
        'a V.O. written into the character name read as on-camera speech');
});

test('a silent shot compiles exactly as it did before', () => {
    // Most shots have no dialogue. Adding a facet must not move them.
    const silent = { card: { action: 'He reaches the car and pulls the door.' } };
    const { prompt } = mp.buildMotionPrompt(silent);
    assert.ok(!/SPEAKING/i.test(prompt) && !/Nobody in frame/.test(prompt),
        'a shot with no dialogue gained a performance clause');
    assert.strictEqual(mp.performanceClause({}), '');
    assert.strictEqual(mp.performanceClause({ dialogue: [] }), '');
});

test('every provider shape carries the performance, not just the default', () => {
    // Runway leads with camera and Seedance with subject; a facet added to one
    // ordering and not the others is how two providers come to generate
    // different films from one card.
    for (const shape of ['runway', 'seedance', 'default']) {
        assert.ok(mp.SHAPES[shape].order.includes('performance'),
            `the ${shape} shape drops the performance clause`);
    }
});

test('the app SHOWS what a shot says', () => {
    /*
     * The other half of the report. `card.dialogue` was read nowhere in the
     * page: not the shot card, not the board tile. The production graph passed
     * a COUNT. So the field that decides the voice track was invisible to the
     * person directing it.
     */
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    assert.match(page, /function dialogueTag\(/, 'the board tile still says nothing about dialogue');
    assert.match(page, /DialogueGroup/, 'the shot card still has nowhere to show the lines');
    assert.match(page, /function cueExtensionOf\(/, 'the page cannot tell a V.O. from on-camera speech');

    const tags = page.slice(page.indexOf('function storyboardFacetTags'), page.indexOf('function dialogueTag'));
    assert.match(tags, /dialogueTag\(f\)/, 'the tag exists and the tile never renders it');

    // And the board must actually be SENT the lines, or the tag has nothing.
    const board = fs.readFileSync(path.join(__dirname, '..', 'routes', 'storyboard.js'), 'utf8');
    assert.match(board, /dialogue:\s*sceneCard\.dialogue/,
        'the board payload does not carry dialogue, so the tile cannot show it');
});
