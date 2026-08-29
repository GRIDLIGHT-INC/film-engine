/**
 * How a line is SAID.
 *
 * The screenplay already carries the direction — `(quietly)`, `(laughing)`,
 * `(shouting)` — and the parser already extracts it. `buildVoicePayload` even
 * put it on the payload as `emotion`. And it was never sent, because
 * ElevenLabs has no `emotion` field: the writer's own delivery note was
 * extracted, carried, and dropped one function short of the request.
 *
 * There are three levers, and the first one is dangerous:
 *
 *   AUDIO TAGS   `[whispers] Don't sweetie me.` — the strongest, and honoured
 *                ONLY by eleven_v3. On any other model the tag is not ignored,
 *                it is SPOKEN: "[thoughtfully] Hello" becomes the words
 *                "thoughtfully hello". So a tag is emitted only when the model
 *                understands it, and only from a vocabulary this file declares.
 *   STYLE        0-1 expressiveness. Works on every model. Never sent before.
 *   STABILITY    Lower is more emotional range. Was hardcoded to 0.5.
 *
 * A direction nobody mapped is REFUSED rather than guessed into a tag, for the
 * same reason: an invented tag is read aloud, and the only way to find out is
 * to listen to a scene you have already paid for.
 */

/** Models that honour inline audio tags. Anything else hears them as words. */
const TAG_MODELS = Object.freeze(['eleven_v3', 'eleven_v3_conversational']);

function understandsTags(model) {
    return TAG_MODELS.includes(String(model || ''));
}

/**
 * The deliveries a screenplay actually asks for.
 *
 * `cues` are the words a writer types in a parenthetical. `tag` is what
 * ElevenLabs documents — not a paraphrase, because an unrecognised tag is
 * spoken. `stability` and `style` are the dials that work everywhere, so a
 * project on a non-tag model still gets some of the direction.
 *
 * Stability is INVERTED from intuition: lower means more variation, so an
 * emotional delivery wants a LOW number and a flat one a high number.
 */
const DELIVERIES = Object.freeze([
    {
        id: 'whisper', tag: '[whispers]', stability: 0.45, style: 0.35,
        cues: ['whisper', 'whispers', 'whispering', 'quietly', 'quiet', 'softly', 'under her breath', 'under his breath', 'hushed'],
    },
    {
        id: 'shout', tag: '[shouts]', stability: 0.25, style: 0.75,
        cues: ['shout', 'shouts', 'shouting', 'yelling', 'yells', 'screaming', 'screams', 'loudly'],
    },
    {
        id: 'angry', tag: '[angry]', stability: 0.30, style: 0.70,
        cues: ['angry', 'angrily', 'furious', 'furiously', 'seething', 'snapping', 'snaps'],
    },
    {
        id: 'laugh', tag: '[laughs]', stability: 0.35, style: 0.65,
        cues: ['laughing', 'laughs', 'chuckling', 'chuckles', 'giggling', 'amused'],
    },
    {
        id: 'cry', tag: '[crying]', stability: 0.30, style: 0.60,
        cues: ['crying', 'cries', 'tearful', 'through tears', 'sobbing', 'breaking'],
    },
    {
        id: 'sigh', tag: '[sighs]', stability: 0.55, style: 0.30,
        cues: ['sighing', 'sighs', 'sigh', 'weary', 'wearily', 'tired', 'resigned'],
    },
    {
        id: 'sarcastic', tag: '[sarcastic]', stability: 0.40, style: 0.60,
        cues: ['sarcastic', 'sarcastically', 'dry', 'drily', 'wry', 'wryly', 'mocking'],
    },
    {
        id: 'excited', tag: '[excited]', stability: 0.30, style: 0.70,
        cues: ['excited', 'excitedly', 'eager', 'eagerly', 'delighted', 'thrilled'],
    },
    {
        id: 'nervous', tag: '[nervously]', stability: 0.35, style: 0.55,
        cues: ['nervous', 'nervously', 'anxious', 'anxiously', 'hesitant', 'hesitantly', 'uncertain'],
    },
    {
        id: 'flat', tag: '[flatly]', stability: 0.75, style: 0.10,
        cues: ['flat', 'flatly', 'deadpan', 'toneless', 'cold', 'coldly', 'even'],
    },
    {
        id: 'gentle', tag: '[gently]', stability: 0.55, style: 0.40,
        cues: ['gently', 'gentle', 'kindly', 'warmly', 'tenderly', 'softening'],
    },
]);

/**
 * What a parenthetical asks for, or null.
 *
 * Matched on WHOLE WORDS against a declared vocabulary. Substring matching
 * would find "cry" inside "decrying" and "sad" inside "saddle", and a detector
 * that fires on ordinary description gets switched off within a day — the same
 * asymmetry the style-preset subject check is built around.
 *
 * `(beat)` and `(to JUNE)` deliberately resolve to nothing: a beat is timing
 * and an address is blocking, and neither is a way of speaking.
 */
function deliveryFor(direction) {
    const text = String(direction || '').replace(/[()]/g, ' ').toLowerCase();
    if (!text.trim()) return null;
    for (const d of DELIVERIES) {
        for (const cue of d.cues) {
            const re = new RegExp(`(^|\\s)${cue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
            if (re.test(text)) return d;
        }
    }
    return null;
}

/**
 * Apply a direction to a payload.
 *
 * The tag goes in ONLY when the model understands it. The dials move either
 * way, so a project on multilingual_v2 still gets some of the direction rather
 * than none — and nothing is invented for a direction nobody mapped.
 */
function applyDelivery(payload, direction) {
    const d = deliveryFor(direction);
    if (!d) return payload;

    const out = { ...payload, stability: d.stability, style: d.style, delivery: d.id };
    if (understandsTags(payload.model) && !String(payload.text || '').trimStart().startsWith('[')) {
        out.text = `${d.tag} ${String(payload.text || '').trim()}`;
    }
    return out;
}

/**
 * The lines either side, so a line is spoken in the flow of the scene.
 *
 * ElevenLabs uses these for prosody only — they are not spoken. On a
 * sixty-eight line exchange it is the difference between a conversation and
 * sixty-eight sentences read in isolation. An absent neighbour is OMITTED
 * rather than sent as null, because the first line of a scene genuinely has
 * nothing before it and an empty string is a claim that it does.
 */
function withContext(payload, { previous, next } = {}) {
    const out = { ...payload };
    if (previous) out.previous_text = String(previous);
    if (next) out.next_text = String(next);
    return out;
}

/* ── how long to leave before the next line ───────────────────────────── */

/**
 * The pause AFTER a line, in milliseconds.
 *
 * Generated lines butt against each other, and a scene played that way sounds
 * like a list being read rather than two people talking: real speech has a beat
 * between turns, a longer one where the writer marked one, and a held silence
 * where a line trails off.
 *
 * These are playback pacing, not a claim about the finished edit — an editor
 * decides the real rhythm. They are stated here so the numbers can be argued
 * with rather than buried in the player.
 */
const PAUSE = Object.freeze({
    /* A different person answering. The ordinary turn gap in conversation. */
    turn: 700,
    /* The same person carrying on. Shorter — they have not stopped speaking. */
    continuation: 300,
    /* The writer wrote a beat. That is an instruction, and the longest pause. */
    beat: 1400,
    /* A line that trails off. The silence is the point of the ellipsis. */
    trail: 900,
    /* A question waiting for its answer. */
    question: 250,
    /* An interruption. The next speaker cuts in, so there is no gap at all. */
    interrupt: 0,
});

/** Words that mean "hold here" when a writer puts them in a parenthetical. */
const BEAT_CUES = ['beat', 'a beat', 'pause', 'long pause', 'silence', 'waits', 'hesitates'];

/**
 * How long to hold after this line before the next one starts.
 *
 * `next` decides whether this is a turn or a continuation, because the same
 * person carrying on has not actually stopped speaking. An em-dash ending is an
 * interruption and gets NO gap: the next line cutting in is the whole point,
 * and inserting a polite pause there destroys the effect the writer wrote.
 */
function pauseAfter(line, next) {
    const text = String((line && line.line) || '').trim();
    const direction = String((line && line.direction) || '').toLowerCase();
    if (!text) return 0;

    // An interruption wins over everything: the point is that nobody waits.
    if (/[—–-]{1,2}$/.test(text)) return PAUSE.interrupt;

    let ms = (next && next.character && line.character
        && String(next.character).toUpperCase() === String(line.character).toUpperCase())
        ? PAUSE.continuation
        : PAUSE.turn;

    // A beat the WRITER marked, in this line's direction or the next line's.
    const marked = [direction, String((next && next.direction) || '').toLowerCase()]
        .some(d => BEAT_CUES.some(cue =>
            new RegExp(`(^|\\s)${cue}(\\s|$)`).test(d.replace(/[()]/g, ' '))));
    if (marked) ms += PAUSE.beat;

    // Trailing off. Only at the END — an ellipsis mid-sentence is a rhythm the
    // model already speaks, and pausing for it would double the effect.
    if (/(\.\.\.|…)$/.test(text)) ms += PAUSE.trail;
    else if (/\?$/.test(text)) ms += PAUSE.question;

    return ms;
}

/** Every pause in a shot, so the timeline can hold long enough for them. */
function totalPauseMs(lines) {
    const list = lines || [];
    return list.reduce((total, line, i) => total + pauseAfter(line, list[i + 1]), 0);
}

module.exports = { DELIVERIES, TAG_MODELS, PAUSE, BEAT_CUES, understandsTags,
    deliveryFor, applyDelivery, withContext, pauseAfter, totalPauseMs };
