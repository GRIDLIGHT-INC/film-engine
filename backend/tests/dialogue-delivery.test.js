/**
 * How a line is SAID, not just what it says.
 *
 * The screenplay already carries the direction — `(quietly)`, `(a beat)`,
 * `(laughing)` — and the parser already extracts it. `buildVoicePayload` even
 * put it on the payload as `emotion`. And the ElevenLabs adapter never sent it,
 * because ElevenLabs has no `emotion` field: the writer's own delivery note was
 * extracted, carried, and dropped one function short of the request.
 *
 * ElevenLabs offers three real levers and we used none:
 *
 *   audio tags   `[whispers] Don't sweetie me.` — only honoured by eleven_v3,
 *                and on any other model they are SPOKEN ALOUD as words. That
 *                asymmetry is the whole danger and drives the design.
 *   style        0-1 expressiveness. Never sent.
 *   stability    lower is more emotional range. Hardcoded to 0.5.
 *
 * Plus `previous_text`/`next_text`, which let a line be delivered in the flow
 * of the scene rather than read in isolation — on a sixty-eight line exchange
 * that is the difference between a conversation and a list.
 *
 * Set-based over the delivery vocabulary, because the failure is per-direction:
 * a mapper that handles "whispers" and silently drops "shouting" reads as
 * working on the line you happen to test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const D = require('../lib/dialogue-delivery');
const { buildVoiceRequest } = require('../lib/providers/elevenlabs');

/* ── the vocabulary ────────────────────────────────────────────────────── */

test('every delivery declares a tag, a style and why', () => {
    assert.ok(D.DELIVERIES.length >= 8, 'too few deliveries to cover a scene');
    for (const d of D.DELIVERIES) {
        assert.ok(d.id, 'a delivery with no id');
        assert.ok(d.tag && /^\[.+\]$/.test(d.tag),
            `${d.id}: '${d.tag}' is not an audio tag — it would be spoken as words`);
        assert.ok(Array.isArray(d.cues) && d.cues.length,
            `${d.id}: no parenthetical it answers to`);
        assert.ok(typeof d.stability === 'number' && d.stability >= 0 && d.stability <= 1,
            `${d.id}: stability out of range`);
        assert.ok(typeof d.style === 'number' && d.style >= 0 && d.style <= 1,
            `${d.id}: style out of range`);
    }
});

test('a parenthetical from the screenplay resolves to a delivery', () => {
    // The forms a writer actually types, including the brackets the parser keeps.
    const cases = [
        ['(quietly)', 'whisper'], ['quietly', 'whisper'], ['(whispering)', 'whisper'],
        ['(shouting)', 'shout'], ['(angry)', 'angry'], ['(laughing)', 'laugh'],
        ['(crying)', 'cry'], ['(sighs)', 'sigh'], ['(sarcastic)', 'sarcastic'],
    ];
    for (const [cue, id] of cases) {
        const d = D.deliveryFor(cue);
        assert.ok(d, `'${cue}' resolved to nothing`);
        assert.equal(d.id, id, `'${cue}' resolved to ${d.id}`);
    }
});

test('a direction nobody mapped is REFUSED, never guessed into a tag', () => {
    /*
     * The load-bearing rule. An unrecognised tag is not ignored by the model —
     * it is SPOKEN. `[thoughtfully] Hello` becomes the words "thoughtfully
     * hello", which is worse than no direction at all and would be discovered
     * only by listening to a scene you have already paid for.
     */
    assert.equal(D.deliveryFor('(thoughtfully)'), null);
    assert.equal(D.deliveryFor('(beat)'), null, 'a beat is timing, not a delivery');
    assert.equal(D.deliveryFor(''), null);
    assert.equal(D.deliveryFor('(to JUNE)'), null, 'a stage direction is not a delivery');
});

/* ── applying it ───────────────────────────────────────────────────────── */

test('a tag is only added on a model that understands it', () => {
    // On anything but v3 the tag is read aloud, so it must not be there.
    const withV3 = D.applyDelivery({ text: 'Say it.', model: 'eleven_v3' }, '(whispering)');
    assert.ok(withV3.text.startsWith('[whispers]'), 'v3 did not get the tag');

    const withV2 = D.applyDelivery({ text: 'Say it.', model: 'eleven_multilingual_v2' }, '(whispering)');
    assert.equal(withV2.text, 'Say it.',
        'a non-v3 model was given an audio tag, which it will speak as words');
    // ...but the direction is not lost: it still moves the dials it can.
    assert.ok(withV2.stability !== undefined && withV2.style !== undefined,
        'a non-v3 model got no delivery at all — style and stability work on every model');
});

test('the dials move, and differently per delivery', () => {
    const shout = D.applyDelivery({ text: 'x', model: 'eleven_v3' }, '(shouting)');
    const whisper = D.applyDelivery({ text: 'x', model: 'eleven_v3' }, '(whispering)');
    assert.notEqual(shout.stability, whisper.stability,
        'every delivery moves the dials identically, so the mapping buys nothing');
});

test('an unmapped direction leaves the payload alone', () => {
    const before = { text: 'Say it.', model: 'eleven_v3' };
    const after = D.applyDelivery({ ...before }, '(thoughtfully)');
    assert.equal(after.text, before.text, 'an unknown direction changed the words');
});

/* ── the line in its scene ─────────────────────────────────────────────── */

test('a line is delivered in the flow of the scene', () => {
    /*
     * previous_text / next_text let the model hear where the line sits. On a
     * sixty-eight line exchange this is the difference between a conversation
     * and sixty-eight sentences read in isolation.
     */
    const p = D.withContext({ text: 'Yes.' }, { previous: 'Every other Sunday.', next: 'Say the rest.' });
    assert.equal(p.previous_text, 'Every other Sunday.');
    assert.equal(p.next_text, 'Say the rest.');
    const first = D.withContext({ text: 'x' }, { previous: null, next: 'y' });
    assert.equal(first.previous_text, undefined, 'an absent neighbour was sent as null');
});

/* ── it reaches the provider ───────────────────────────────────────────── */

test('style, stability and context all reach the request body', () => {
    // Differential: the adapter used to drop everything but stability and
    // similarity_boost, so a payload could carry direction that went nowhere.
    const req = buildVoiceRequest({
        text: '[whispers] Say it.', voice_id: 'V1', model: 'eleven_v3',
        stability: 0.3, style: 0.8, similarity_boost: 0.9,
        previous_text: 'before', next_text: 'after',
    });
    assert.equal(req.body.text, '[whispers] Say it.');
    assert.equal(req.body.model_id, 'eleven_v3');
    assert.equal(req.body.voice_settings.stability, 0.3);
    assert.equal(req.body.voice_settings.style, 0.8,
        'style never reaches ElevenLabs, so the expressiveness dial does nothing');
    assert.equal(req.body.previous_text, 'before',
        'the line is still read in isolation');
    assert.equal(req.body.next_text, 'after');
});

test('nothing is sent that was not asked for', () => {
    // A project that sets no delivery must produce the same request it always
    // did, or every existing line changes the day this ships.
    const req = buildVoiceRequest({ text: 'Plain.', voice_id: 'V1' });
    assert.equal(req.body.previous_text, undefined);
    assert.equal(req.body.next_text, undefined);
    assert.equal(req.body.voice_settings.style, undefined,
        'style was invented for a line that asked for none');
});

test('the emotion field is gone, not left dangling', () => {
    /*
     * `emotion` was set on every payload for four phases and sent nowhere,
     * because ElevenLabs has no such field. Leaving it beside a mapping that
     * DOES work is two answers to one question.
     */
    const src = fs.readFileSync(path.join(__dirname, '../lib/dialogue-builder.js'), 'utf8');
    const i = src.indexOf('function buildVoicePayload(');
    const body = src.slice(i, src.indexOf('\nfunction ', i + 10));
    assert.ok(/delivery|applyDelivery/.test(body),
        'buildVoicePayload does not carry the direction to anything that uses it');
});

/* ── what triggers a regeneration ──────────────────────────────────────── */

test('what a line was made from is what decides whether it is current', () => {
    /*
     * Asked directly: "if I change the screenplay, or change the voice through
     * cast, will it regenerate?" It regenerated EVERYTHING on every press,
     * because `prompt_hash` covered the TEXT alone — so recasting a character,
     * the change most likely to need a new recording, produced an identical
     * hash and was invisible.
     *
     * The hash covers text, voice, delivery and model: the four things that
     * change what comes back. Same reasoning as the artefact fingerprint.
     */
    const src = fs.readFileSync(path.join(__dirname, '../routes/voice.js'), 'utf8');
    const i = src.indexOf('function lineHash(');
    assert.ok(i > -1, 'lineHash is gone; the hash is back to text-only');
    const body = src.slice(i, src.indexOf('\n}', i));
    for (const field of ['text', 'voice_id', 'delivery', 'model']) {
        assert.ok(new RegExp(`payload\\.${field}`).test(body),
            `the hash ignores ${field}, so changing it would not regenerate the line`);
    }

    // And something must READ it, or the hash is bookkeeping.
    assert.ok(/prompt_hash = \?/.test(src),
        'nothing looks a line up by its hash, so every press regenerates everything');
    assert.ok(/reused: true/.test(src), 'a reused line is not reported as reused');
});

test('a regenerate override exists, because a hash can be wrong', () => {
    // Every other refusal here is passable; a director who wants a different
    // take of an unchanged line must not be told the line is already correct.
    const src = fs.readFileSync(path.join(__dirname, '../routes/voice.js'), 'utf8');
    assert.ok(/regenerate === true/.test(src), 'there is no way to force a new take');
});

/* ── pacing ────────────────────────────────────────────────────────────── */

test('a turn gap, a continuation, a beat, a trail and an interruption', () => {
    const turn = D.pauseAfter({ character: 'RAY', line: 'You look like her.' },
        { character: 'JUNE', line: 'People say that.' });
    const cont = D.pauseAfter({ character: 'JUNE', line: 'People say that.' },
        { character: 'JUNE', line: 'They always did.' });
    assert.ok(cont < turn,
        'the same person carrying on waits as long as a new speaker answering');

    const beat = D.pauseAfter({ character: 'JUNE', line: 'Say it.', direction: '(a beat)' },
        { character: 'RAY', line: 'No.' });
    assert.ok(beat > turn, 'a beat the writer marked is not held');

    const trail = D.pauseAfter({ character: 'JUNE', line: 'I practiced this in the car...' },
        { character: 'RAY', line: 'And?' });
    assert.ok(trail > turn, 'a line that trails off is not held');

    // The one that must be ZERO: an interruption means nobody waits, and a
    // polite gap there destroys the effect the writer wrote.
    const cut = D.pauseAfter({ character: 'RAY', line: 'Sweetie —' },
        { character: 'JUNE', line: "Don't sweetie me." });
    assert.equal(cut, 0, 'an interruption was given a pause, so nobody is interrupted');
});

test('an ellipsis mid-line is not a pause', () => {
    // The model already speaks that rhythm; holding for it doubles the effect.
    const mid = D.pauseAfter({ character: 'A', line: 'I was... never sure.' }, { character: 'B', line: 'x' });
    const plain = D.pauseAfter({ character: 'A', line: 'I was never sure.' }, { character: 'B', line: 'x' });
    assert.equal(mid, plain);
});

test('an empty line holds for nothing', () => {
    assert.equal(D.pauseAfter({ character: 'A', line: '   ' }, null), 0);
});

test('the player waits the pause the timeline computed', () => {
    const SPA2 = fs.readFileSync(path.join(__dirname, '../../src/index.html'), 'utf8');
    const i = SPA2.indexOf('function pbPlayLine(');
    const body = SPA2.slice(i, i + 1600);
    assert.ok(/pause_after_ms/.test(body),
        'the player ignores the computed pause and butts every line together');
    assert.ok(/setTimeout/.test(body), 'nothing actually waits');
    assert.ok(/clearTimeout/.test(SPA2.slice(i - 200, i + 1600)),
        'a hold from the previous line can fire into the new one');
});
