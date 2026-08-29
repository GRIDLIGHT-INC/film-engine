/**
 * Three numbers about a scene, and they are not each other.
 *
 *   page_eighths  — how much printed page it occupies.  Objective.
 *   screen_time   — how long the finished scene plays.  An estimate, with a range.
 *   shoot_effort  — how hard it is to film.             Independent of both.
 *
 * Keeping them apart IS the feature. "One page ≈ one minute" is a rule of thumb
 * that works across a whole conventionally formatted screenplay and is badly
 * wrong for a single scene: `The armies collide.` is 1/8 of a page and minutes
 * of film, while a dense page of overlapping dialogue plays in well under a
 * minute. Multiplying eighths by 7.5 seconds and calling the result a runtime is
 * confidently wrong exactly where it matters most — and a schedule then gets
 * built on it.
 *
 * So this reports BOTH numbers, plus a confidence and, when they disagree, the
 * reason. An estimate that explains itself can be argued with; a single figure
 * cannot.
 *
 * Nothing here is stored. It is derived from the screenplay every time, on the
 * precedent the home page set: a second copy of a measurement is a thing that
 * can disagree with the document it measures.
 */

const { elementLines, LINES_PER_PAGE } = require('./screenplay-pagination');

/** The page-per-minute convention, as seconds per eighth. */
const SECONDS_PER_EIGHTH = 60 / 8;   // 7.5

const CONFIDENCE = ['high', 'medium', 'low'];

/**
 * Words per minute by delivery.
 *
 * A range rather than one number because the same line of dialogue is a
 * different length in a comedy and a deathbed scene. `ordinary` is the default:
 * picking the fast rate would flatter every estimate.
 */
const DELIVERY_RATES = Object.freeze({
    ceremonial: 100,     // slow, emotional, ritual
    ordinary: 135,       // ordinary dramatic dialogue
    rapid: 175,          // comedy, argument
    overlapping: 200,    // very fast, characters talking over each other
});

/**
 * What an action line is describing, and how long that takes.
 *
 * Each class carries its own uncertainty, which is the point: `atomic` is
 * knowable within a second or two and `fight` is not knowable at all from the
 * text. A single seconds-per-word constant would give the two the same
 * confidence, which is the specific lie this module exists to avoid.
 *
 * `why` is required on every class. A duration with no reason is a magic number
 * that nobody can argue with later.
 */
const ACTION_CLASSES = Object.freeze({
    atomic: {
        min_seconds: 1, likely_seconds: 3, max_seconds: 6,
        why: 'a single observable act — opening a door, sitting, handing something over',
        match: /\b(opens?|closes?|sits?|stands?|picks? up|puts?|hands?|takes?|drops?|nods?|turns?|looks?|glances?|enters?|exits?)\b/i,
    },
    movement: {
        min_seconds: 3, likely_seconds: 8, max_seconds: 25,
        why: 'depends on a distance the page does not state',
        match: /\b(walks?|runs?|crosses|climbs?|drives?|approaches|hurries|wanders?|steps? (in|out|through))\b/i,
    },
    reaction: {
        min_seconds: 1, likely_seconds: 4, max_seconds: 15,
        why: 'a held moment: performance decides the length, not the writing',
        match: /\b(waits?|stares?|watches|hesitates?|pauses?|beat|silence|says nothing|considers?)\b/i,
    },
    sustained: {
        min_seconds: 10, likely_seconds: 45, max_seconds: 180,
        why: 'an activity with no stated end — the duration is a directing decision',
        match: /\b(searches?|waits? for|works? (on|through)|prepares?|cleans?|reads? through|goes? through|sorts?)\b/i,
    },
    fight: {
        min_seconds: 20, likely_seconds: 90, max_seconds: 300,
        why: 'choreography decides this; the page cannot',
        match: /\b(fights?|fighting|battle|brawl|chase|chases|collide|attacks?|struggles?|shoot-?out|explodes?)\b/i,
    },
    montage: {
        min_seconds: 20, likely_seconds: 60, max_seconds: 180,
        why: 'a collection of beats whose count and length are set in the edit',
        match: /\b(montage|series of shots|intercut)\b/i,
    },
    performance: {
        min_seconds: 45, likely_seconds: 150, max_seconds: 300,
        why: 'a song or dance runs for its own length, which the page rarely states',
        match: /\b(performs?|sings?|song|dances?|plays? the|recital|concert)\b/i,
    },
    time_passage: {
        min_seconds: 2, likely_seconds: 6, max_seconds: 30,
        why: 'cannot be taken literally — onscreen this is a cut or a dissolve',
        match: /\b(time passes|hours later|later that|after a while|days pass|as the sun)\b/i,
    },
    establishing: {
        min_seconds: 2, likely_seconds: 5, max_seconds: 15,
        why: 'held for as long as the edit needs, not as long as it is described',
        match: /\b(establishing|aerial|the city|skyline|wide on|we see the)\b/i,
    },
});

const DEFAULT_ACTION_CLASS = 'atomic';

/**
 * Phrases that make a runtime estimate unreliable.
 *
 * Flagged, never corrected: none of these is bad writing. `They fight.` is a
 * perfectly good action line and simply does not say how long the fight is. The
 * flag exists so a low confidence can name the line that caused it — a
 * confidence with no cause is one nobody can act on.
 */
const AMBIGUOUS_PHRASES = Object.freeze([
    'they fight', 'time passes', 'searches everywhere', 'a montage',
    'the song continues', 'chaos erupts', 'they drive across town',
    'after a while', 'hours later', 'the battle rages', 'a chaotic chase',
]);

/**
 * What makes a scene hard to SHOOT, which has nothing to do with its length.
 *
 * `The bridge explodes.` is 1/8 of a page and can consume a shooting day, while
 * three pages of two people at a table is a morning. A schedule built from page
 * count alone budgets the first like a doorway.
 *
 * Every factor carries a `probe`: a line of action that must trigger it. A
 * factor no text can ever fire looks like coverage and provides none, and the
 * test runs each probe through the real estimator rather than trusting the
 * regex by eye.
 */
const COMPLEXITY_FACTORS = Object.freeze({
    night_exterior: {
        weight: 2, label: 'night exterior',
        match: /^ext\b.*\b(night|dusk|dawn)\b/i, matchOn: 'heading',
        probe: 'They stand in the road.', probe_heading: 'EXT. BRIDGE - NIGHT',
    },
    stunt: {
        weight: 3, label: 'stunt or action',
        match: /\b(fights?|fighting|falls? from|leaps?|crashes?|jumps? from|stunt|chase)\b/i,
        probe: 'The car leaps the gap.',
    },
    effect: {
        weight: 3, label: 'practical or visual effect',
        match: /\b(explodes?|explosion|fire|burns?|smoke|rain|storm|blood|transforms?|vanishes)\b/i,
        probe: 'The bridge explodes.',
    },
    vehicle: {
        weight: 2, label: 'vehicles',
        match: /\b(car|truck|van|motorcycle|bus|train|boat|drives?|driving)\b/i,
        probe: 'The car pulls up outside.',
    },
    crowd: {
        weight: 2, label: 'crowd or background',
        match: /\b(crowd|crowds|mob|audience|throng|commuters|the armies|onlookers)\b/i,
        probe: 'A crowd gathers on the pavement.',
    },
    animal: {
        weight: 2, label: 'animals',
        match: /\b(dog|dogs|horse|horses|cat|cats|bird|birds|animal)\b/i,
        probe: 'A dog barks at the gate.',
    },
    child: {
        weight: 2, label: 'children',
        match: /\b(child|children|kid|kids|baby|toddler|infant)\b/i,
        probe: 'A child runs past.',
    },
    water: {
        weight: 2, label: 'water',
        match: /\b(underwater|swims?|river|ocean|sea|pool|flood|rain-soaked)\b/i,
        probe: 'She swims to the far bank.',
    },
    height: {
        weight: 2, label: 'work at height',
        match: /\b(rooftop|roof|cliff|ladder|scaffold|balcony|crane)\b/i,
        probe: 'He edges along the rooftop.',
    },
});

/* ── page eighths ──────────────────────────────────────────────────────── */

/**
 * Eighths of a page from a line count.
 *
 * Rounded UP, and never zero: a production records 1/8 as the floor, because a
 * scene that occupies almost no page still occupies a strip on the board and
 * still has to be shot.
 */
function eighthsFromLines(lines) {
    const raw = (Number(lines) || 0) / LINES_PER_PAGE * 8;
    return Math.max(1, Math.ceil(raw));
}

/**
 * The way a stripboard writes it: `4/8`, never `1/2`.
 *
 * The denominator is kept so that a column of scene lengths adds without
 * converting between halves, quarters and eighths on the way down.
 */
function formatEighths(eighths) {
    const n = Math.max(1, Math.round(Number(eighths) || 0));
    const whole = Math.floor(n / 8);
    const part = n % 8;
    if (!whole) return `${part}/8`;
    if (!part) return String(whole);
    return `${whole} ${part}/8`;
}

/** Lines a block occupies, using the editor's own measure. */
function blockLines(block) {
    return elementLines(block.type, (block.text || '').length);
}

/* ── screen time ───────────────────────────────────────────────────────── */

function wordCount(text) {
    return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/** Seconds for a number of spoken words at a delivery rate. */
function dialogueSeconds(words, wpm) {
    const rate = Number(wpm) || DELIVERY_RATES.ordinary;
    return (Number(words) || 0) / rate * 60;
}

/** What an action line describes, and therefore how long it plausibly runs. */
function classifyAction(text) {
    const line = String(text || '');
    // Ordered by specificity: `performs the song` is a performance rather than
    // the movement its verb would otherwise match.
    const order = ['performance', 'montage', 'fight', 'time_passage', 'sustained',
        'establishing', 'reaction', 'movement', 'atomic'];
    for (const name of order) {
        const spec = ACTION_CLASSES[name];
        if (spec.match.test(line)) return { class: name, ...spec };
    }
    return { class: DEFAULT_ACTION_CLASS, ...ACTION_CLASSES[DEFAULT_ACTION_CLASS] };
}

/** Phrases in this text whose duration cannot be read from the page. */
function ambiguousDurations(text) {
    const line = String(text || '');
    const out = [];
    for (const phrase of AMBIGUOUS_PHRASES) {
        const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const m = line.match(re);
        if (m) out.push({ phrase: m[0], why: 'the page does not say how long this lasts' });
    }
    return out;
}

/* ── one scene ─────────────────────────────────────────────────────────── */

/**
 * Estimate a scene three ways.
 *
 * @param {{heading: string, blocks: Array<{type: string, text: string}>}} scene
 */
function estimateScene(scene, opts) {
    const blocks = (scene && scene.blocks) || [];
    const heading = (scene && scene.heading) || '';
    const delivery = (opts && opts.delivery) || 'ordinary';
    const wpm = DELIVERY_RATES[delivery] || DELIVERY_RATES.ordinary;

    let lines = heading ? elementLines('scene-heading', heading.length) : 0;
    let min = 0, likely = 0, max = 0;
    const notes = [];
    const classesSeen = new Set();

    for (const block of blocks) {
        lines += blockLines(block);
        const text = block.text || '';

        if (block.type === 'dialogue' || block.type === 'lyrics') {
            const secs = dialogueSeconds(wordCount(text), wpm);
            // The spread is the delivery range: the same words are slower in a
            // ceremonial scene and faster in an argument.
            min += dialogueSeconds(wordCount(text), DELIVERY_RATES.overlapping);
            likely += secs;
            max += dialogueSeconds(wordCount(text), DELIVERY_RATES.ceremonial);
            continue;
        }
        if (block.type === 'character' || block.type === 'parenthetical') {
            // A cue is not spoken. A parenthetical is a direction on the line
            // beneath it, and timing it separately would double-count the beat.
            continue;
        }
        if (block.type === 'transition' || block.type === 'scene-heading') continue;

        const cls = classifyAction(text);
        classesSeen.add(cls.class);
        min += cls.min_seconds;
        likely += cls.likely_seconds;
        max += cls.max_seconds;
        for (const a of ambiguousDurations(text)) {
            notes.push(`"${a.phrase}" — ${a.why}.`);
        }
    }

    const page_eighths = eighthsFromLines(lines);
    const page_baseline_seconds = page_eighths * SECONDS_PER_EIGHTH;

    /*
     * Confidence is about the SPREAD, not about the mean.
     *
     * A scene whose maximum is several times its minimum is not an estimate
     * anyone should schedule against, however plausible the middle number
     * looks. An ambiguous phrase drops it outright, because that is the case
     * where the page genuinely withholds the answer.
     */
    const spread = likely > 0 ? max / Math.max(likely, 1) : 1;
    let confidence = 'high';
    if (spread > 1.6 || classesSeen.has('sustained')) confidence = 'medium';
    if (notes.length || classesSeen.has('fight') || classesSeen.has('performance')
        || classesSeen.has('montage')) confidence = 'low';

    /*
     * Do the two methods disagree?
     *
     * Reported rather than reconciled. Averaging them would produce one number
     * that is wrong in a new way and hides which method produced it — and the
     * disagreement is itself the useful signal: it says "this scene is not what
     * its page count suggests", which is exactly what a schedule needs to know.
     */
    const ratio = page_baseline_seconds > 0 ? likely / page_baseline_seconds : 1;
    const disagreement = (ratio > 1.75 || ratio < 0.55)
        ? {
            page_says: Math.round(page_baseline_seconds),
            content_says: Math.round(likely),
            why: ratio > 1
                ? 'what happens here takes longer than the page it occupies'
                : 'this plays faster than its page count suggests',
        }
        : null;

    const production = scoreComplexity(heading, blocks);

    return {
        heading,
        page_eighths,
        eighths: formatEighths(page_eighths),
        page_baseline_seconds: Math.round(page_baseline_seconds),
        screen_time: {
            minimum_seconds: Math.round(min),
            likely_seconds: Math.round(likely),
            maximum_seconds: Math.round(max),
            confidence,
        },
        production,
        disagreement,
        timing_notes: notes,
    };
}

/** How hard this is to shoot — independent of how long it plays. */
function scoreComplexity(heading, blocks) {
    const action = blocks
        .filter(b => b.type !== 'dialogue' && b.type !== 'character' && b.type !== 'parenthetical')
        .map(b => b.text || '').join(' ');
    const reasons = [];
    let score = 0;
    for (const spec of Object.values(COMPLEXITY_FACTORS)) {
        const subject = spec.matchOn === 'heading' ? heading : action;
        if (spec.match.test(subject)) { reasons.push(spec.label); score += spec.weight; }
    }
    return {
        effort_score: score,
        complexity: score >= 6 ? 'high' : score >= 3 ? 'medium' : 'low',
        reasons,
    };
}

/* ── the whole screenplay ──────────────────────────────────────────────── */

/**
 * Both runtimes for a screenplay, and never a blended one.
 *
 * `page_runtime_seconds` is the convention, which is what a reader or a
 * financier will quote. `likely_runtime_seconds` is what the content suggests.
 * Where they differ, the scenes that caused it are the ones carrying a
 * `disagreement`.
 */
function estimateScreenplay(scenes, opts) {
    const out = (scenes || []).map(s => estimateScene(s, opts));
    const total_eighths = out.reduce((n, s) => n + s.page_eighths, 0);
    return {
        scenes: out,
        total_eighths,
        eighths: formatEighths(total_eighths),
        pages: Math.round((total_eighths / 8) * 10) / 10,
        page_runtime_seconds: Math.round(total_eighths * SECONDS_PER_EIGHTH),
        likely_runtime_seconds: Math.round(out.reduce((n, s) => n + s.screen_time.likely_seconds, 0)),
        minimum_runtime_seconds: Math.round(out.reduce((n, s) => n + s.screen_time.minimum_seconds, 0)),
        maximum_runtime_seconds: Math.round(out.reduce((n, s) => n + s.screen_time.maximum_seconds, 0)),
        low_confidence_scenes: out.filter(s => s.screen_time.confidence === 'low').length,
        disagreeing_scenes: out.filter(s => s.disagreement).length,
    };
}

module.exports = {
    SECONDS_PER_EIGHTH, CONFIDENCE, DELIVERY_RATES, ACTION_CLASSES,
    AMBIGUOUS_PHRASES, COMPLEXITY_FACTORS,
    eighthsFromLines, formatEighths, blockLines,
    dialogueSeconds, classifyAction, ambiguousDurations,
    estimateScene, scoreComplexity, estimateScreenplay,
};
