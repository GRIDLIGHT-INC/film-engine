/**
 * A score for THIS scene, not for any scene.
 *
 * `buildMusicPrompt` reads the cue and `project.genre` and nothing else — the
 * `scene` it is handed is used solely to work out a duration. So a father
 * meeting the daughter he left nine years ago produced *"calm ambient
 * instrumental soundtrack, piano, acoustic guitar, ambient pad, Drama film
 * score"*, which is what every scene in every film produced, because none of it
 * came from the scene.
 *
 * The engine already holds the facts. This module turns them into a CUE — the
 * same object a director writes by hand — so the existing prompt builder, the
 * existing route and the existing MCP tools all work unchanged. It is a brief,
 * not a second generator.
 *
 * What it deliberately does NOT do is decide what the scene should sound like.
 * That is a judgement, and the connected agent is the model here: `music_brief`
 * hands over the facts and `music_cue_create` stores what the model concluded.
 * This file is the fallback for when nobody has written one — honest, derived,
 * and never inventing a mood the writing does not imply.
 */

/**
 * How long a music prompt may be.
 *
 * ElevenLabs documents no character limit for `/music`, so this is OURS and
 * says so — the same asymmetry that decides the image `promptLimit`, where
 * over-sending buys a rejection and under-sending costs some description.
 *
 * The number is chosen from what a music prompt IS: a description of a cue, not
 * of a scene. Measured on The Glass Harbour, the derived prompt came out at
 * over three thousand characters because `film_scenes.description` there is the
 * whole scene's action — camera moves, blocking, every beat. A music model is
 * being asked what it sounds like, and the musical words were at the very end
 * where a truncating model would drop them first.
 */
const MUSIC_PROMPT_LIMIT = 600;

/**
 * The action, as much of it as a cue can use.
 *
 * The first sentences carry what the scene IS; the rest is blocking and camera,
 * which describe a picture rather than a sound. Cut at a sentence boundary, so
 * the last thing the model reads is a complete thought.
 */
function summarise(description, budget) {
    const text = String(description || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= budget) return text;

    let out = '';
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
        if ((out + ' ' + sentence).trim().length > budget) break;
        out = (out + ' ' + sentence).trim();
    }
    // A single sentence longer than the whole budget still has to fit.
    return out || text.slice(0, budget).replace(/\s+\S*$/, '');
}

/**
 * The facts a score is built from, and where each lives.
 *
 * Declared so a fact that stops reaching the prompt fails a test rather than
 * quietly going missing — which is exactly what happened to the whole scene.
 */
const SCORE_INPUTS = Object.freeze([
    { id: 'int_ext', from: 'scene', what: 'Interior or exterior: a room is close and dry, a street is open and has air in it.' },
    { id: 'location', from: 'scene', what: 'Where it happens — the single most concrete thing a composer is given.' },
    { id: 'time_of_day', from: 'scene', what: 'Late afternoon and 3am are different pieces of music.' },
    { id: 'description', from: 'scene', what: 'What actually happens, in the writer’s own words.' },
    { id: 'characters', from: 'characters', what: 'Two people alone is a duet; a crowd is not.' },
    { id: 'dialogue', from: 'dialogue', what: 'How much talking there is, which decides whether the cue is underscore or carries the scene.' },
    { id: 'coverage', from: 'shots', what: 'How many shots: a long unbroken two-hander sits still, thirty cuts do not.' },
    { id: 'style_preset', from: 'project', what: 'The film’s own look, so the score belongs to the same picture.' },
]);

/**
 * How much of the scene is talking, as a band.
 *
 * The one derivation here that is a craft judgement rather than a
 * transcription: a cue under sixty-three lines of dialogue must stay out of the
 * way, and a melodic one there fights the words — the most common way a temp
 * score ruins a scene.
 */
function dialogueWeight(lines) {
    const n = Number(lines) || 0;
    if (n === 0) return { band: 'none', energy: 0.45, note: 'no dialogue — the cue can carry the scene' };
    if (n <= 6) return { band: 'light', energy: 0.35, note: 'sparse dialogue — the cue may breathe between lines' };
    if (n <= 24) return { band: 'steady', energy: 0.25, note: 'restrained underscore, sitting beneath the dialogue' };
    return { band: 'wall-to-wall', energy: 0.15, note: 'sparse underscore, well under the dialogue and never melodic' };
}

/** How still the scene is, from how much it is cut. */
function coverageFeel(shots) {
    const n = Number(shots) || 0;
    if (!n) return null;
    if (n <= 3) return 'held, unhurried, few changes';
    if (n <= 12) return 'measured, with room between changes';
    return 'restless, cutting often';
}

/**
 * The medium and mood the film's own look implies.
 *
 * Read as clauses rather than summarised, on the precedent `mediumFromStyle`
 * set: a tidy label throws away the words the composer would actually use.
 * Only the ones a listener could act on — a grade and a period read musically,
 * a lens does not.
 */
const STYLE_MUSICAL = [
    'noir', 'grain', 'anamorphic', 'muted', 'saturated', 'warm', 'cold', 'teal',
    'amber', 'sepia', 'monochrome', 'neon', 'pastel', 'bleak', 'sunlit', 'candle',
    '16mm', '35mm', '1970s', '1980s', '1990s', 'period', 'vintage',
];

function styleClauses(stylePreset) {
    const text = String(stylePreset || '');
    if (!text.trim()) return null;
    const clauses = text.split(/(?<=[.!?])\s+|\n+|,/)
        .map(c => c.trim())
        .filter(c => c && STYLE_MUSICAL.some(w =>
            new RegExp(`(^|\\s)${w}(\\s|$|,)`, 'i').test(c)));
    return clauses.length ? clauses.slice(0, 3).join(', ') : null;
}

/**
 * The brief: every fact, and a description built only from what is there.
 *
 * Nothing is invented. A scene with no time and no place gets no time and no
 * place in its description — a confident wrong cue is worse than a plain one,
 * because it sounds deliberate.
 */
function scoreBrief(scene, context, project) {
    const s = scene || {};
    const c = context || {};
    const p = project || {};

    const facts = {
        int_ext: s.int_ext || null,
        location: s.location || null,
        time_of_day: s.time_of_day || null,
        description: s.description || null,
        characters: Array.isArray(c.characters) ? c.characters : [],
        dialogue_lines: Number(c.dialogue_lines) || 0,
        shot_count: Number(c.shot_count) || 0,
        genre: p.genre || null,
        style: styleClauses(p.style_preset),
    };

    const weight = dialogueWeight(facts.dialogue_lines);
    const feel = coverageFeel(facts.shot_count);

    /*
     * The musical facts are reserved FIRST, and the prose gets what is left.
     *
     * Cutting the instruments to keep a camera move would be the wrong trade
     * every time: the model is being asked what the cue sounds like. So the
     * short, load-bearing clauses are measured, and the description is
     * summarised into whatever budget remains.
     */
    const musical = [];
    if (facts.location) {
        musical.push(facts.int_ext
            ? `${facts.int_ext === 'EXT' ? 'exterior' : 'interior'}: ${facts.location.toLowerCase()}`
            : facts.location.toLowerCase());
    }
    if (facts.time_of_day) musical.push(String(facts.time_of_day).toLowerCase());
    if (facts.characters.length === 1) musical.push('one character alone');
    else if (facts.characters.length === 2) musical.push('two characters');
    else if (facts.characters.length > 2) musical.push(`${facts.characters.length} characters`);
    musical.push(weight.note);
    if (feel) musical.push(feel);
    if (facts.style) musical.push(facts.style);

    const reserved = musical.join('; ').length + 2;
    const parts = [];
    const summary = summarise(facts.description, Math.max(80, MUSIC_PROMPT_LIMIT - reserved));
    if (summary) parts.push(summary);
    parts.push(...musical);

    return {
        facts,
        description: parts.join('; '),
        energy: weight.energy,
        dialogue_band: weight.band,
        // Left NULL rather than guessed: a mood is the judgement this module
        // exists to hand to the model, and picking one here would quietly
        // become the answer nobody chose.
        mood: null,
        genre: null,
        instruments: null,
    };
}

/** The brief as the cue object the existing prompt builder already reads. */
function cueFromBrief(brief) {
    if (!brief) return null;
    return {
        /*
         * Marked as a DERIVATION, so it takes the 600-character ceiling rather
         * than the allowance written for a director's own brief. Without this
         * flag the description below — the scene's action, summarised — reads
         * as somebody having written the cue.
         */
        derived: true,
        description: brief.description,
        mood: brief.mood || undefined,
        genre: brief.genre || undefined,
        instruments: brief.instruments || undefined,
        energy: brief.energy,
    };
}

/**
 * How long the cue runs, and where the number came from.
 *
 * `sceneCutLength` reads MEASURED CLIPS, so a scene with no footage returns
 * null and falls to thirty seconds. The Glass Harbour diner scene has no clips
 * and 216 seconds of measured dialogue — scoring it at 30 writes a cue for a
 * scene that does not exist.
 *
 * An explicit cue length always wins: a cue running past its scene, or stopping
 * before it, is a real decision. Nothing measured returns NULL, never a number,
 * because "no footage" and "a zero-length scene" are different answers.
 */
function cueSeconds({ cue_ms, cut_ms, dialogue_ms, card_ms, explain } = {}) {
    const pick = (ms, source) => (explain
        ? { seconds: Math.round(Number(ms) / 1000), source }
        : Math.round(Number(ms) / 1000));

    if (Number(cue_ms) > 0) return pick(cue_ms, 'cue');
    if (Number(cut_ms) > 0) return pick(cut_ms, 'footage');
    // Not yet shot: the longer of what the cards plan and what the dialogue
    // runs. A shot is held for its lines, so dialogue can outrun the cards;
    // a quiet scene of held shots outruns its dialogue.
    if (Number(card_ms) > Number(dialogue_ms || 0)) return pick(card_ms, 'shot cards');
    if (Number(dialogue_ms) > 0) return pick(dialogue_ms, 'dialogue');
    return explain ? { seconds: null, source: 'nothing measured' } : null;
}

module.exports = {
    SCORE_INPUTS, STYLE_MUSICAL, MUSIC_PROMPT_LIMIT, summarise,
    dialogueWeight, coverageFeel, styleClauses,
    scoreBrief, cueFromBrief, cueSeconds,
};
