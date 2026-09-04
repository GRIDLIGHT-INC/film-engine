/**
 * The fields the cue contract promises must actually reach the generator
 * ─────────────────────────────────────────────────────────────────────────
 *
 * "Look at the prompt it actually sent — description, genre, instruments, and
 *  the project genre. That's it. No mood, no tempo_bpm, no key_signature, no
 *  reference_track. So 'D major, 60bpm, horns rather than trumpets, delicate
 *  becoming grand' was written, stored, and dropped."
 *
 * Measured against the real DRIVE-IN cue before the fix: four of the seven
 * fields `music_cue_create` names as reaching the generator reached nothing.
 *
 * TWO SEPARATE CAUSES, which is why it was four rather than one:
 *
 *  - `mood`, `tempo_bpm` and `key_signature` were returned as PAYLOAD FIELDS
 *    (`payload.mood`, `payload.tempo_bpm`, `payload.key`) and ElevenLabs takes
 *    none of them: its /music endpoint reads `prompt` text, and everything not
 *    in that string is a setting the director watches reach nothing. The mood
 *    was consulted only to look up default instruments and a tempo range —
 *    used as an INDEX into a table, never said out loud.
 *
 *  - `reference_track` WAS in the prompt, first, and `fitMusicPrompt` trims
 *    `parts[0]`. Its own comment says "the description is the longest part and
 *    the least musical" — true, and the description was not parts[0]; the
 *    reference was. So on any cue whose description is long the trim summarised
 *    the reference away and kept everything else, and with the tail alone over
 *    the ceiling it returned the tail whole: a 1039-character prompt against a
 *    600 limit, with the one field the director cares most about missing.
 *
 * THE DENOMINATOR IS THE TOOL'S OWN SENTENCE, parsed from the description
 * `music_cue_create` publishes. A hand-written list here would be a third place
 * to state the same contract, and the one that goes stale — this way, promising
 * a field and not sending it fails, and so does quietly dropping a promise.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-mcf-' + crypto.randomUUID().slice(0, 8));

const { buildMusicPrompt } = require('../lib/music-prompt');

/** The fields the tool promises, read from the promise itself. */
function promisedFields() {
    const m = require('../lib/mcp-tools');
    const list = (m.buildTools ? m.buildTools() : m.TOOLS) || [];
    const tool = (Array.isArray(list) ? list : Object.values(list))
        .find(t => t.name === 'music_cue_create');
    assert.ok(tool, 'music_cue_create is gone — the contract cannot be read');
    const said = String(tool.description);
    const m2 = /WHAT REACHES THE GENERATOR:\s*([^.]*?)\.\s/i.exec(said);
    assert.ok(m2, `the contract sentence is gone from the description: ${said.slice(0, 200)}`);
    const named = [...m2[1].matchAll(/`?\b([a-z_]{3,})\b`?/g)].map(x => x[1]);
    const known = new Set(['description', 'mood', 'genre', 'instruments', 'tempo_bpm',
                           'key_signature', 'reference_track']);
    return [...new Set(named.filter(f => known.has(f)))];
}

test('the contract names several fields, read from the tool itself', () => {
    const fields = promisedFields();
    assert.ok(fields.length >= 6,
        `expected the promised set, parsed ${JSON.stringify(fields)}`);
    assert.ok(fields.includes('tempo_bpm') && fields.includes('reference_track'),
        `the parse missed fields: ${JSON.stringify(fields)}`);
});

/** A cue shaped like the real one: a long description, and every knob set. */
function fullCue(overrides) {
    return Object.assign({
        cue_type: 'score',
        description: 'A studio ident fanfare that starts almost silent and earns its brass. '
            + 'ONE short rising motif is stated twice: first by a single fragile voice alone with '
            + 'nothing underneath it, then answered in full by warm harmonised horns at the moment '
            + 'the title lands on the screen. The first statement is the question, the second is '
            + 'the answer, and the whole piece is that one gesture. Nothing is busy: there is no '
            + 'melody beyond the motif, no countermelody, no ostinato, no rhythm section. Air and '
            + 'silence carry as much as the notes do. It ends by decaying into nothing rather than '
            + 'landing on a button.',
        mood: 'delicate becoming grand',
        genre: 'orchestral studio ident fanfare, golden-age Hollywood idiom',
        instruments: ['solo vibraphone', 'celeste', 'warm strings', 'French horn section'],
        tempo_bpm: 60,
        key_signature: 'D major',
        /*
         * The real one, verbatim: 232 characters. A short reference fits
         * whatever the fit does, so three separate mutations survived against
         * a tidy fixture — the budget has to actually be tight.
         */
        reference_track: 'a small solo statement answered by warm horns — the shape of a '
            + 'mid-century studio logo theme that opens with one fragile instrument and blooms '
            + 'into a full orchestral cadence, orchestrated with horns rather than trumpets',
        duration_ms: 15000,
    }, overrides || {});
}

const SCENE = { id: null, scene_number: 1, location: 'DRIVE-IN', time_of_day: 'NIGHT' };
const PROJECT = { genre: 'Commercial' };

test('every promised field reaches the text the provider actually receives', () => {
    /*
     * The PROMPT, not the payload object. ElevenLabs reads `prompt`; a value
     * returned beside it as `payload.tempo_bpm` is a setting nothing consumes,
     * which is exactly how three of these were lost.
     */
    const missing = [];
    for (const field of promisedFields()) {
        const withIt = buildMusicPrompt(fullCue(), SCENE, PROJECT, {}).prompt;
        const without = buildMusicPrompt(fullCue({ [field]: null }), SCENE, PROJECT, {}).prompt;
        if (withIt === without) {
            missing.push(`${field}: setting it changes nothing in the prompt the provider receives`);
        }
    }
    assert.deepStrictEqual(missing, [], missing.join('\n  '));
});

test('the musical facts survive a long description', () => {
    /*
     * The specific failure. A short cue kept everything; the real one, whose
     * description runs past the ceiling, lost the reference to the trim. The
     * facts are SHORT and load-bearing, so they must never be what is cut.
     */
    const p = buildMusicPrompt(fullCue(), SCENE, PROJECT, {});
    const lost = [];
    if (!/60\s*bpm/i.test(p.prompt)) lost.push('tempo_bpm (60) is not in the prompt');
    if (!/D major/i.test(p.prompt)) lost.push('key_signature (D major) is not in the prompt');
    if (!/delicate becoming grand/i.test(p.prompt)) lost.push('mood is not in the prompt');
    if (!/warm horns/i.test(p.prompt)) lost.push('reference_track is not in the prompt');
    assert.deepStrictEqual(lost, [],
        `prompt was ${p.prompt.length} chars:\n  ` + lost.join('\n  ') + `\n  ---\n${p.prompt}`);
});

test('the prompt honours its own ceiling', () => {
    /*
     * The ceiling that APPLIES to this cue, read from the one function that
     * decides it — not a typed 600. A cue somebody wrote earns the larger
     * written allowance; a derivation does not. Asserting the derived ceiling
     * against an authored cue is asserting the wrong rule, which is what this
     * test did until the two-ceiling design landed and it was not updated.
     */
    const { promptLimitFor } = require('../lib/music-prompt');
    const cue = fullCue();
    const limit = promptLimitFor(cue);
    const p = buildMusicPrompt(cue, SCENE, PROJECT, {});
    assert.ok(p.prompt.length <= limit,
        `the prompt is ${p.prompt.length} characters against its own ${limit} ceiling`);
    assert.strictEqual(p.prompt_source, 'written', 'a cue with a written description read as derived');
});

test('what gets cut is the description, never a musical fact', () => {
    /*
     * Stated as a rule rather than left to the ordering: the description is the
     * longest part and the least musical, so it is what gives way. A trim that
     * ate the key signature to keep three more sentences of prose would be the
     * wrong trade every time.
     */
    const long = fullCue({ description: 'A '.repeat(600) + 'fanfare.' });
    const p = buildMusicPrompt(long, SCENE, PROJECT, {});
    assert.match(p.prompt, /D major/i, 'the key was cut to make room for prose');
    assert.match(p.prompt, /60\s*bpm/i, 'the tempo was cut to make room for prose');
    assert.match(p.prompt, /warm horns/i, 'the reference was cut to make room for prose');
});

test('a cue that sets nothing produces no invented facts', () => {
    /*
     * The other direction. An unset key must not appear as a guess: an invented
     * key is indistinguishable from a chosen one, and this engine has paid for
     * that mistake on lenses and on subject scale already.
     */
    const bare = { cue_type: 'score', description: 'quiet underscore', duration_ms: 15000 };
    const p = buildMusicPrompt(bare, SCENE, PROJECT, {});
    assert.ok(!/ in [A-G][#b]? (major|minor)/i.test(p.prompt),
        `a key was invented for a cue that names none: ${p.prompt}`);
});

// ---------------------------------------------------------------------------
// The composition plan
// ---------------------------------------------------------------------------

test('a section plan does not repeat the whole description as a style on every chunk', () => {
    /*
     * A "style" is a tag — `orchestral`, `warm horns`. The cue's full
     * description was travelling as one 785-character style, on EVERY chunk, so
     * a four-section plan sent it four times and the body came to 7KB.
     *
     * This is not proven to be what returned `elevenlabs 500` — the exact body
     * this adapter builds was sent to the live API and generated successfully,
     * so that failure is not reproducible here. It is wrong on its own terms.
     */
    const { compositionPlan } = require('../lib/music-sections');
    const { buildMusicRequest } = require('../lib/providers/elevenlabs');
    const p = buildMusicPrompt(fullCue(), SCENE, PROJECT, {});
    const plan = compositionPlan(p.prompt_parts, [
        { name: 'question', direction: 'a single fragile voice', duration_ms: 4000 },
        { name: 'answer', direction: 'warm horns beneath it', duration_ms: 4000 },
    ], p.negative_prompt);
    const body = buildMusicRequest({ ...p, composition_plan: plan }).body;

    const chunks = body.composition_plan.chunks || [];
    assert.ok(chunks.length === 2, `expected two chunks, saw ${chunks.length}`);
    const worst = Math.max(...chunks.flatMap(c => (c.positive_styles || []).map(s => String(s).length)));
    assert.ok(worst <= 200,
        `a style of ${worst} characters is a paragraph, not a tag — the description is being `
        + 'repeated on every chunk');
});

test('a provider 500 is retried once, because it is the provider failing and it bills nothing', () => {
    /*
     * `elevenlabs 500: Internal Server error` is an upstream fault, and a
     * failed generation is not billed. It was surfaced to the caller as a dead
     * end, so a transient error read as "sections do not work" — which is what
     * happened, twice in a row, and the workaround was to stop using sections.
     *
     * Retried on 5xx ONLY: a 422 is our body and would buy the same refusal
     * twice, which is the rule lib/image-fallback.js already states.
     */
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'providers', 'elevenlabs.js'), 'utf8');
    /*
     * Read the SET, not the word. Grepping for `retr` matched the comment
     * explaining the retry, so emptying the status set survived — the check
     * passed against an adapter that retries nothing.
     */
    const m = /const RETRY_STATUS = new Set\(\[([^\]]*)\]\)/.exec(src);
    assert.ok(m, 'RETRY_STATUS is gone — a provider 500 is a dead end again');
    const codes = m[1].split(',').map(x => Number(x.trim())).filter(Number.isFinite);
    for (const upstream of [500, 502, 503]) {
        assert.ok(codes.includes(upstream), `${upstream} is not retried, and it bills nothing`);
    }
    for (const ours of [400, 401, 404, 422]) {
        assert.ok(!codes.includes(ours),
            `${ours} is our own request — replaying it buys the same refusal twice`);
    }
    assert.match(src, /callElevenLabsOnce\(/, 'the retry does not actually call through twice');
});

test('nothing in the prompt ends on a dangling conjunction', () => {
    /*
     * A word-boundary cut left the reference ending "...opens with one fragile
     * instrument and" — the last thing the model reads is half a thought, which
     * is worse than the shorter phrase. Cut at a clause boundary instead, the
     * rule buildVideoPrompt already follows.
     */
    const long = fullCue({
        reference_track: 'a small solo statement answered by warm horns — the shape of a '
            + 'mid-century studio logo theme that opens with one fragile instrument and blooms '
            + 'into a full orchestral cadence, orchestrated with horns rather than trumpets',
    });
    const p = buildMusicPrompt(long, SCENE, PROJECT, {});
    for (const clause of p.prompt.split(', ')) {
        assert.ok(!/\s(and|but|or|with|that|which|of|to|the|into|from)$/i.test(clause.trim()),
            `a clause ends mid-thought: "${clause.trim()}"\n  in: ${p.prompt}`);
    }
});

test('the description survives a cue whose facts fill the prompt on their own', () => {
    /*
     * The floor. Once the musical facts were spoken they came to more than the
     * ceiling by themselves, and the fallback returned them and dropped the
     * DESCRIPTION — the field the contract calls the one that matters most.
     * Ranking alone does not prevent that; a reserved minimum does.
     */
    const p = buildMusicPrompt(fullCue(), SCENE, PROJECT, {});
    assert.match(p.prompt, /studio ident fanfare that starts almost silent/i,
        `the description was squeezed out by the short facts:\n  ${p.prompt}`);
});


/**
 * A cue whose FACTS alone nearly fill the prompt — twelve instruments, a long
 * mood, a long genre and a 232-character reference. This is what a director who
 * uses the fields actually writes, and it is the only shape that exercises the
 * budget: a tidy fixture fits under the ceiling, the fit never runs, and three
 * separate mutations to it survived.
 */
function factsHeavyCue(overrides) {
    return Object.assign(fullCue(), {
        mood: 'delicate becoming grand, warm, hopeful, unhurried, nostalgic, intimate at the '
            + 'start and full-hearted at the close',
        genre: 'orchestral studio ident fanfare, golden-age Hollywood idiom, mid-century warmth, '
            + 'scored for a small ensemble',
        instruments: ['solo vibraphone', 'celeste', 'warm strings', 'French horn section',
            'solo French horn', 'timpani', 'harp', 'suspended cymbal (brushed)', 'upright bass',
            'glockenspiel', 'tremolo strings', 'muted trumpet'],
    }, overrides || {});
}

test('a facts-heavy cue keeps its description, and stays inside the ceiling', () => {
    /*
     * THE FLOOR. Once the musical facts were spoken they came to more than the
     * ceiling on their own, and the old fallback returned them and dropped the
     * description — the field the contract calls the one that matters most.
     */
    const { promptLimitFor } = require('../lib/music-prompt');
    const cue = factsHeavyCue();
    const limit = promptLimitFor(cue);
    const p = buildMusicPrompt(cue, SCENE, PROJECT, {});
    assert.ok(p.prompt.length <= limit,
        `${p.prompt.length} characters against its own ${limit} ceiling`);
    assert.match(p.prompt, /studio ident fanfare that starts almost silent/i,
        `the description was squeezed out by the facts:\n  ${p.prompt}`);
    assert.match(p.prompt, /in D major/, 'the key was lost');
    assert.match(p.prompt, /60 bpm/, 'the tempo was lost');
});

test('no fact is dropped while the prompt has room for it', () => {
    /*
     * `summarise` cuts at a sentence boundary and so usually takes LESS than
     * the room it was given, which turned the reserve into dead space: the real
     * cue settled 155 characters short with the reference dropped for want of
     * room it was not using.
     */
    const { MUSIC_PROMPT_LIMIT } = require('../lib/scene-score');
    const p = buildMusicPrompt(factsHeavyCue(), SCENE, PROJECT, {});
    const headroom = MUSIC_PROMPT_LIMIT - p.prompt.length;
    assert.match(p.prompt, /in the style of/,
        `the reference was dropped with ${headroom} characters spare:\n  ${p.prompt}`);
});

test('a cue with every field written at length still carries its description', () => {
    /*
     * THE FLOOR, at the point it actually bites. A director who fills every
     * field generously — fourteen instruments, a long mood, a long genre —
     * produces facts totalling more than the ceiling minus the description's
     * first sentence, and without a reserved minimum the description is dropped
     * entirely. Proven by mutation: floor 0 loses it on exactly this cue.
     */
    const { promptLimitFor } = require('../lib/music-prompt');
    const maximal = factsHeavyCue({
        mood: 'delicate becoming grand, warm, hopeful, unhurried, nostalgic, intimate at the '
            + 'start and full-hearted at the close, never triumphal, never martial',
        genre: 'orchestral studio ident fanfare, golden-age Hollywood idiom, mid-century warmth, '
            + 'scored for a small ensemble rather than a full symphony orchestra',
        instruments: ['solo vibraphone', 'celeste', 'warm strings', 'French horn section',
            'solo French horn', 'timpani', 'harp', 'suspended cymbal (brushed)', 'upright bass',
            'glockenspiel', 'tremolo strings', 'muted trumpet', 'bass clarinet', 'pizzicato cellos'],
    });
    const limit = promptLimitFor(maximal);
    const p = buildMusicPrompt(maximal, SCENE, PROJECT, {});
    assert.ok(p.prompt.length <= limit,
        `${p.prompt.length} characters against its own ${limit} ceiling`);
    assert.match(p.prompt, /studio ident fanfare that starts almost silent/i,
        `the description was dropped entirely for the facts:\n  ${p.prompt}`);
});
