/**
 * A score for THIS scene, not for any scene.
 *
 * `buildMusicPrompt` reads the cue and `project.genre` and nothing else. The
 * `scene` argument it is handed is used SOLELY to work out a duration. So a
 * father meeting his estranged daughter in a diner after nine years produced
 *
 *     "calm ambient instrumental soundtrack, piano, acoustic guitar,
 *      ambient pad, Drama film score"
 *
 * — which is what every scene in every film produced, because none of it came
 * from the scene. Reported as "we have this tool but it doesn't seem to work":
 * it ran, it returned a file, and the file was wallpaper.
 *
 * The engine already holds everything needed. This suite is set-based over
 * SCORE_INPUTS — the facts a score should be built from — and every assertion
 * is DIFFERENTIAL: change the fact, and what the provider receives must change.
 * Asserting that a field is READ is not enough; the whole defect was a scene
 * that was passed in and ignored.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const S = require('../lib/scene-score');
const { buildMusicPrompt } = require('../lib/music-prompt');

/** A scene with everything filled in, so removing one fact is the only variable. */
function fullScene(over) {
    return {
        id: 'sc1', project_id: 'p1', scene_number: 1,
        int_ext: 'INT', location: 'THE GLASS HARBOUR DINER', time_of_day: 'LATE AFTERNOON',
        description: 'A father meets the daughter he left nine years ago.',
        ...over,
    };
}
function fullContext(over) {
    return {
        characters: ['RAY MERCER', 'JUNE'],
        dialogue_lines: 63,
        shot_count: 13,
        cut_ms: 216000,
        ...over,
    };
}
const project = { genre: 'Drama', style_preset: 'muted teal and amber, 1970s anamorphic, heavy grain' };

/* ── the registry ──────────────────────────────────────────────────────── */

test('every score input says where it comes from and what it contributes', () => {
    assert.ok(S.SCORE_INPUTS.length >= 8,
        `only ${S.SCORE_INPUTS.length} inputs — the scene holds more than that`);
    for (const input of S.SCORE_INPUTS) {
        assert.ok(input.id, 'an input with no id');
        assert.ok(input.from && /^(scene|project|shots|characters|dialogue)$/.test(input.from),
            `${input.id}: '${input.from}' is not somewhere the engine keeps facts`);
        assert.ok(input.what && input.what.length > 15,
            `${input.id}: does not say what it contributes to a score`);
    }
});

test('the registry covers every column of film_scenes a score could use', () => {
    /*
     * Derived from the schema rather than typed: a column added to film_scenes
     * later is either in the registry or explicitly not a musical fact, and
     * both are decisions. `id`, `project_id` and the machine fields are not.
     */
    const migrations = fs.readdirSync(path.join(__dirname, '../db/migrations'))
        .map(f => fs.readFileSync(path.join(__dirname, '../db/migrations', f), 'utf8')).join('\n');
    for (const column of ['int_ext', 'location', 'time_of_day', 'description']) {
        assert.ok(new RegExp(`\\b${column}\\b`).test(migrations),
            `film_scenes no longer has ${column}; this suite is describing an old schema`);
        assert.ok(S.SCORE_INPUTS.some(i => i.id === column),
            `'${column}' is a fact about the scene and reaches no score`);
    }
});

/* ── every input must CHANGE the prompt ────────────────────────────────── */

test('every declared input changes what the provider receives', () => {
    /*
     * Differential, one input at a time. A registry entry that is read and then
     * dropped looks identical to one that is used, which is exactly how the
     * scene argument was passed in and ignored for four phases.
     */
    const base = S.scoreBrief(fullScene(), fullContext(), project);
    const basePrompt = buildMusicPrompt(S.cueFromBrief(base), fullScene(), project, {}).prompt;

    const variants = {
        int_ext: () => S.scoreBrief(fullScene({ int_ext: 'EXT' }), fullContext(), project),
        location: () => S.scoreBrief(fullScene({ location: 'A CATHEDRAL' }), fullContext(), project),
        time_of_day: () => S.scoreBrief(fullScene({ time_of_day: 'NIGHT' }), fullContext(), project),
        description: () => S.scoreBrief(fullScene({ description: 'A car chase through a burning city.' }), fullContext(), project),
        characters: () => S.scoreBrief(fullScene(), fullContext({ characters: [] }), project),
        dialogue: () => S.scoreBrief(fullScene(), fullContext({ dialogue_lines: 0 }), project),
        coverage: () => S.scoreBrief(fullScene(), fullContext({ shot_count: 1 }), project),
        style_preset: () => S.scoreBrief(fullScene(), fullContext(), { ...project, style_preset: 'bright primary colours, flat cartoon' }),
    };

    for (const input of S.SCORE_INPUTS) {
        const make = variants[input.id];
        assert.ok(make, `no differential probe for '${input.id}' — it is untested`);
        const changed = buildMusicPrompt(S.cueFromBrief(make()), fullScene(), project, {}).prompt;
        assert.notEqual(changed, basePrompt,
            `changing '${input.id}' left the prompt identical — it reaches no score`);
    }
});

test('a talking scene is scored as underscore, not as melody', () => {
    /*
     * The one derivation that is a craft judgement rather than a transcription.
     * Sixty-three lines of dialogue means the music sits UNDER two people
     * talking; a melodic cue there fights the words, which is the most common
     * way a temp score ruins a scene.
     */
    const talky = S.scoreBrief(fullScene(), fullContext({ dialogue_lines: 63 }), project);
    const silent = S.scoreBrief(fullScene(), fullContext({ dialogue_lines: 0 }), project);
    assert.ok(/underscore|sparse|under dialogue|restrained/i.test(talky.description),
        'a 63-line scene is not scored as underscore');
    assert.notEqual(talky.energy, silent.energy,
        'a wall-to-wall dialogue scene and a silent one get the same energy');
});

test('nothing is invented for a scene that says nothing', () => {
    // An empty scene must not acquire a mood the writer never implied: a
    // confident wrong cue is worse than a plain one, because it sounds
    // deliberate.
    const bare = S.scoreBrief({ id: 'x', project_id: 'p' }, {}, {});
    assert.ok(bare.description.length < 200, 'a bare scene produced an elaborate brief');
    assert.ok(!/night|day|interior|exterior/i.test(bare.description),
        'a scene with no time or place was given one');
});

/* ── length ────────────────────────────────────────────────────────────── */

test('a cue is written to the length of the cut, dialogue included', () => {
    /*
     * `sceneCutLength` reads MEASURED CLIPS, and a scene with no footage
     * returns null and falls to thirty seconds. The Glass Harbour diner scene
     * has no clips and 216 seconds of measured dialogue: scoring it at 30
     * writes a cue for a scene that does not exist.
     */
    assert.equal(S.cueSeconds({ cut_ms: 216000 }), 216);
    assert.equal(S.cueSeconds({ cut_ms: null, dialogue_ms: 216000 }), 216,
        'a dialogue-only scene falls back to a default instead of its own length');
    // An explicit choice always wins: a cue running past its scene is a real
    // decision.
    assert.equal(S.cueSeconds({ cut_ms: 10000, dialogue_ms: 5000, cue_ms: 45000 }), 45);
    assert.equal(S.cueSeconds({}), null,
        'a scene with nothing measured must return null, not a made-up number');
});

test('the length source is named, because a default is not a measurement', () => {
    assert.equal(S.cueSeconds({ cut_ms: 1000, explain: true }).source, 'footage');
    assert.equal(S.cueSeconds({ dialogue_ms: 1000, explain: true }).source, 'dialogue');
    assert.equal(S.cueSeconds({ cue_ms: 1000, explain: true }).source, 'cue');
    assert.equal(S.cueSeconds({ explain: true }).source, 'nothing measured');
});

/* ── the model does the listening ──────────────────────────────────────── */

test('there is a free brief, and no server-side model writes the music direction', () => {
    /*
     * What a scene should SOUND like is a judgement, and the connected agent is
     * the model here. The engine assembles the facts and validates the answer;
     * it does not ask a second LLM what the music should be.
     */
    const tools = require('../lib/mcp-tools');
    const names = new Set((tools.listTools ? tools.listTools() : tools.TOOLS).map(t => t.name));
    assert.ok(names.has('music_brief'),
        'no tool hands the model the scene, so the musical direction can only be typed by hand');
    assert.ok(names.has('music_cue_create'), 'nothing stores what the model decided');

    const src = fs.readFileSync(path.join(__dirname, '../lib/scene-score.js'), 'utf8');
    assert.ok(!/llm-client|callLLM/.test(src),
        'the score brief reaches for a server-side model');
});

test('the brief carries the facts, not a conclusion', () => {
    const brief = S.scoreBrief(fullScene(), fullContext(), project);
    assert.ok(brief.facts && typeof brief.facts === 'object',
        'the brief states no facts, so a model has nothing to reason from');
    for (const key of ['location', 'time_of_day', 'characters', 'dialogue_lines']) {
        assert.ok(key in brief.facts, `the brief omits ${key}`);
    }
});

/* ── a music prompt is not a screenplay ────────────────────────────────── */

test('the prompt fits what a music model will read', () => {
    /*
     * Measured on the real scene: the derived prompt came out at over three
     * thousand characters, because `film_scenes.description` on The Glass
     * Harbour is the WHOLE scene's action — camera moves, blocking, every beat.
     * A music model is being asked what the cue sounds like, not what happens,
     * and a prompt that long either fails or buries the musical words at the end.
     *
     * The same lesson the image prompt already paid for: an allowance is a rule
     * for deciding what to cut, and the musical facts outrank the prose.
     */
    const { MUSIC_PROMPT_LIMIT } = require('../lib/scene-score');
    assert.ok(MUSIC_PROMPT_LIMIT > 0 && MUSIC_PROMPT_LIMIT <= 2000,
        'no stated ceiling for a music prompt');

    const wordy = fullScene({
        description: 'A 1941 diner, re-topped in 1952. ' + 'The camera drifts across the formica. '.repeat(120),
    });
    const brief = S.scoreBrief(wordy, fullContext(), project);
    const prompt = buildMusicPrompt(S.cueFromBrief(brief), wordy, project, {}).prompt;
    assert.ok(prompt.length <= MUSIC_PROMPT_LIMIT,
        `the prompt is ${prompt.length} characters — a whole scene of action, not a cue`);
});

test('the musical words survive the trim; the prose is what goes', () => {
    // Cutting the instruments to keep a camera move would be the wrong trade
    // every time.
    const wordy = fullScene({ description: 'X. '.repeat(900) });
    const brief = S.scoreBrief(wordy, fullContext({ dialogue_lines: 63 }), project);
    assert.ok(/underscore/i.test(brief.description),
        'the dialogue note was trimmed away in favour of the action prose');
    assert.ok(/amber|anamorphic|1970s|grain|muted/i.test(brief.description),
        'the film’s look was trimmed away');
});

test('a short description is untouched', () => {
    const brief = S.scoreBrief(fullScene(), fullContext(), project);
    assert.ok(brief.description.includes('A father meets the daughter he left nine years ago.'),
        'a one-line description was trimmed for no reason');
});
