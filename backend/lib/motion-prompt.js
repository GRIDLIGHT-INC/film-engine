/**
 * What a video model is actually told.
 *
 * `buildVideoPrompt` reused `buildStoryboardPrompt`, so a video generation was
 * handed the words for painting the frame from nothing — while that frame was
 * attached as `init_image`. Measured on a real 2B-shaped shot: 429 characters,
 * 82 of them motion and 347 re-describing the attached picture. And the one
 * genuinely motional field, `environment_motion`, reached only Runway.
 *
 * The engine's internal representation was never the problem. `motion.subject`,
 * `motion.environment`, `camera_control`, the previs path, `stagingPhrase` and
 * the pace numbers all exist and are correct. The loss happened at the last
 * inch, where one adapter compiled them properly and the rest were handed a
 * prompt built for a different job.
 *
 *   Director intent → structured shot → per-provider compiler → generation
 *
 * THE ORDER IS THE PROVIDER'S, NOT OURS. Runway documents camera motion, then
 * subject action, then additional detail. Seedance has sixteen times the room
 * and no such documented shape. So `SHAPES` holds one ordering per provider and
 * an adapter that declares nothing gets the conservative default.
 */

const { stagingPhrase } = require('./shot-staging');

/* ── the eight techniques, and where each is served ───────────────────── */

/**
 * Every technique in the ranked list, with its state stated.
 *
 * Written down because five of the eight were ALREADY BUILT and a plan that
 * rebuilt them would have spent on solved problems — and because the two that
 * are deferred must be named as work rather than quietly dropped.
 */
const TECHNIQUES = Object.freeze([
    { id: 'starting_image', rank: 1, name: 'Excellent starting image', state: 'built',
      served_by: 'plates → anchor → keyframe as init_image; video deliberately attaches no plates, '
               + 'because the keyframe was already generated from them' },
    { id: 'one_action', rank: 2, name: 'One clear primary action', state: 'counted',
      served_by: 'shotShape() counts actions and reports them before spend; the first action leads '
               + 'the compiled prompt and later ones are cut first when it does not fit' },
    { id: 'camera_behaviour', rank: 3, name: 'Explicit camera behaviour', state: 'built',
      served_by: 'camera_control + previs analyzePath; the compiler gives camera its own clause, '
               + 'independent of the subject' },
    { id: 'concrete_motion', rank: 4, name: 'Concrete motion, not interpretation', state: 'linted',
      served_by: 'prompt-lint INTERPRETIVE rules name the feeling and suggest the physical action' },
    { id: 'spatial', rank: 5, name: 'Clear spatial relationships', state: 'compiled',
      served_by: 'shot-staging stagingPhrase(), carried explicitly into the motion prompt — it '
               + 'reached video only via the image builder and would have been lost' },
    { id: 'direction_speed', rank: 6, name: 'Direction and speed', state: 'compiled',
      served_by: 'previs movePace()/legTimings() rendered as words; the numbers were computed and '
               + 'reached no prompt' },
    { id: 'temporal', rank: 7, name: 'Temporal progression', state: 'compiled',
      served_by: 'analyzePath already emits "while"/"then" for the camera; card.beats does the same '
               + 'for the subject, and is emitted ONLY when written' },
    { id: 'end_state', rank: 8, name: 'End-state constraints', state: 'compiled',
      served_by: 'card.end_state compiled into a closing clause; held internally as start (the '
               + 'keyframe) → movement → required end, never sent as a labelled section' },
]);

/**
 * Card fields this adds. Each must validate AND reach a prompt — a field that
 * validates and changes no output is decoration, which is the exact shape of
 * the `environment_motion` bug this file exists to fix.
 */
const NEW_CARD_FIELDS = Object.freeze([
    { id: 'environment_motion', what: 'What the world does while the subject acts.',
      sample: 'Flames erupt from the struck house.', bad: 42 },
    { id: 'end_state', what: 'Where things must be when the clip ends.',
      sample: 'The dragon fills the near foreground.', bad: 42 },
    { id: 'beats', what: 'Ordered subject beats, for a shot that evolves.',
      sample: ['the dragon closes', 'the house is struck'], bad: 'not an array' },
]);

/* -- what the subject is SAYING, and whether we see them say it --------- */

/**
 * OFF-SCREEN IS NOT THE SAME AS SILENT, AND NEITHER REACHED THE MODEL.
 *
 * A scene card carries its dialogue and no prompt builder read it. Not the
 * storyboard builder (right: a still should not render speech), not the video
 * builder, not this one. So a model generating a man who talks for
 * fifty-five of a film's sixty-two seconds was never told he speaks -- and an
 * image-to-video model handed a keyframe of a closed mouth produces a man
 * standing silently. The lip-sync pass then fights the footage instead of
 * building on it.
 *
 * The WORDS are deliberately not sent. They buy little for lip shape at this
 * level, the lip-sync pass owns the phonemes, and a model handed a quoted
 * sentence is liable to paint it into the frame -- which this project's own
 * style preset forbids outright.
 *
 * V.O. and O.S. INVERT the instruction rather than removing it. The last two
 * shots of this film are a voice over an empty burning street and over a
 * logo; telling that model "he is speaking" would put a talking mouth where
 * there is deliberately nobody. So off-screen speech says the opposite out
 * loud. Saying nothing leaves the model to guess, and it guesses differently
 * every take.
 */
const OFF_SCREEN = /^(V\.?O\.?|O\.?S\.?|O\.?C\.?|VOICEOVER|OFF)$/i;

/** The extension on a cue, from either the structured field or the name. */
function cueExtension(line) {
    if (!line) return '';
    const explicit = String(line.extension || '').trim();
    if (explicit) return explicit;
    const m = String(line.character || '').match(/\(([^)]+)\)\s*$/);
    return m ? m[1].trim() : '';
}

function speakerName(line) {
    return String((line && line.character) || '').replace(/\([^)]*\)\s*$/, '').trim();
}

/** Is this line heard from somebody the camera can see? */
function isOnScreen(line) {
    return !OFF_SCREEN.test(cueExtension(line).replace(/[\s.]+/g, ''));
}

/**
 * The performance clause: who speaks, and whether the camera sees it.
 *
 * Returns '' for a shot with no dialogue, which is most of them -- a silent
 * shot must compile byte-identically to how it did before this existed.
 */
function performanceClause(card) {
    const lines = Array.isArray(card && card.dialogue) ? card.dialogue.filter(Boolean) : [];
    if (!lines.length) return '';

    const onScreen = lines.filter(isOnScreen);
    const offScreen = lines.filter(l => !isOnScreen(l));

    if (!onScreen.length) {
        return 'Nobody in frame is speaking: the voice heard over this shot is off-screen, so no mouth '
             + 'in frame moves and no character addresses the camera.';
    }

    const who = [...new Set(onScreen.map(speakerName).filter(Boolean))];
    const subject = who.length ? who.join(' and ') : 'the subject';
    let clause = `${subject} is SPEAKING ON CAMERA through this shot: lips and jaw moving naturally `
        + 'through a continuous line, breath and small head movement with the speech, eyes engaged. '
        + 'Not silent, not a held expression, mouth not closed.';
    if (offScreen.length) clause += ' A further line is heard off-screen from somebody not in frame.';
    return clause;
}


/* ── counting the shape of a shot (technique 2) ───────────────────────── */

/** Sentence- and clause-ish splitting, good enough to count independent acts. */
function splitActions(text) {
    return String(text || '')
        .split(/(?:[.;]|\b(?:and then|then|while|as)\b)/i)
        .map(s => s.trim())
        .filter(s => s.length > 8 && /\w/.test(s));
}

/**
 * DESCRIPTION, NEVER PREDICTION.
 *
 * `film_video_attempts` holds 0 rows and three of the four video paths record
 * nothing, so there is no outcome data to forecast adherence from. Counting is
 * defensible today; a percentage is not, and a confident wrong warning is how a
 * whole class of warning gets switched off.
 */
function shotShape(card) {
    const c = card || {};
    const actions = splitActions(c.action || c.description || '');
    const env = splitActions(c.environment_motion || '');
    const subjects = [].concat(c.characters || [], c.props || []).filter(Boolean).length;
    const beats = Array.isArray(c.beats) ? c.beats.length : 0;
    const move = (c.camera && c.camera.movement) || 'static';
    const compound = beats > 1 || /,|\band\b/.test(String(move));

    const bits = [];
    if (actions.length) bits.push(`${actions.length} action${actions.length > 1 ? 's' : ''}`);
    if (env.length) bits.push(`${env.length} environment`);
    if (subjects) bits.push(`${subjects} subject${subjects > 1 ? 's' : ''}`);
    if (compound) bits.push('compound camera');
    if (beats) bits.push(`${beats} beats`);

    return {
        actions: actions.length,
        environment_interactions: env.length,
        subjects,
        beats,
        compound_camera: !!compound,
        summary: bits.join(' · ') || 'nothing written yet',
    };
}

/* ── direction and speed, from numbers already computed (technique 6) ─── */

/** Turn a leg's amount and duration into words a model acts on. */
function paceWords(previs) {
    const p = previs || {};
    const moves = Array.isArray(p.moves) ? p.moves : [];
    const seconds = Number(p.duration_ms || 0) / 1000;
    const out = [];
    for (const m of moves) {
        const amount = Number(m.amount);
        const secs = Number(m.duration_ms || p.duration_ms || 0) / 1000 || seconds;
        if (!amount || !secs) continue;
        const rate = amount / secs;
        const unit = m.unit === 'deg' ? '°/s' : 'm/s';
        // A number AND a word: the number is exact, the word is what a model
        // reads. Runway names direction, speed and timing as core components.
        const how = rate < 0.35 ? 'slowly' : rate < 1.2 ? 'steadily' : 'quickly';
        out.push(`${how} (${amount}${m.unit === 'deg' ? '°' : 'm'} over ${secs}s, ${rate.toFixed(2)}${unit})`);
    }
    return out;
}

/* ── the camera clause (techniques 3, 6, 7-camera) ────────────────────── */

function cameraClause(ctx) {
    const { previs, card, durationS } = ctx;
    let described = '';
    try {
        const keys = previs && (previs.cameraKeys || previs.path);
        if (Array.isArray(keys) && keys.length > 1) {
            described = require('./previs-blocking').analyzePath(keys).description || '';
        }
    } catch (_) { described = ''; }
    if (!described) {
        const mv = (card.camera && card.camera.movement) || '';
        if (mv && mv !== 'static') described = String(mv).replace(/-/g, ' ');
    }
    if (!described) return '';
    const pace = paceWords(previs);
    const how = pace.length ? ` ${pace.join(', then ')}` : '';
    // "the camera performs tracking forward", not "the camera tracking forward":
    // analyzePath returns a movement NAME, which is not a verb phrase.
    const verb = /^(?:moves?|pans?|tilts?|tracks?|dollies|cranes?|orbits?|pushes?|pulls?|holds?)\b/i.test(described)
        ? described : `performs a ${described}`;
    const over = durationS ? `Over ${durationS} seconds, ` : '';
    return `${over}the camera ${verb}${how}.`;
}

/* ── per-provider shapes ──────────────────────────────────────────────── */

/**
 * One ordering per provider, with its reason.
 *
 * `runway` follows Runway's own documented structure — camera motion, then
 * subject action, then additional detail. `default` leads with the subject,
 * which is the conservative choice for a provider that documents no shape:
 * whatever leads is what the model weights most, and what the shot is ABOUT is
 * the safer thing to lead with when nobody has told us otherwise.
 */
const SHAPES = Object.freeze({
    runway:  { order: ['camera', 'subject', 'performance', 'staging', 'environment', 'beats', 'end'],
               why: "Runway documents camera motion + subject action + additional motion details" },
    seedance:{ order: ['subject', 'performance', 'staging', 'environment', 'camera', 'beats', 'end'],
               why: '16,000 characters of room and no documented shape; subject leads' },
    default: { order: ['subject', 'performance', 'staging', 'environment', 'camera', 'beats', 'end'],
               why: 'conservative: lead with what the shot is about' },
});

/** What each part contributes, built once and ordered per provider. */
function parts(ctx) {
    const card = ctx.card || {};
    const acts = splitActions(card.action || card.description || '');
    return {
        // ONE PRIMARY ACTION leads; the rest follow and are cut first.
        subject: acts.length ? acts[0].replace(/\s+$/, '') + '.' : '',
        extra_actions: acts.slice(1),
        performance: performanceClause(card),
        staging: stagingPhrase(ctx.previs) || '',
        environment: String(card.environment_motion || '').trim(),
        camera: cameraClause(ctx),
        beats: Array.isArray(card.beats) && card.beats.length > 1
            ? `First ${card.beats[0]}, then ${card.beats.slice(1).join(', then ')}.` : '',
        end: String(card.end_state || '').trim()
            ? `By the end of the shot: ${String(card.end_state).trim().replace(/\.?$/, '.')}` : '',
    };
}

/**
 * Build the motion prompt for one provider shape.
 *
 * Cut order when it does not fit is the rule the image prompt already follows:
 * the least load-bearing goes first. Secondary actions, then beats, then the
 * end state, then the environment — and the SUBJECT and the SPATIAL LOCKS are
 * never cut, because without them the model is guessing at the two things the
 * shot is most likely to get wrong.
 */
function buildMotionPrompt(ctx, shapeId) {
    const shape = SHAPES[shapeId] || SHAPES.default;
    const p = parts(ctx);
    const limit = Number(ctx.limit) || 1000;

    const optional = ['extra', 'beats', 'end', 'environment'];
    const chosen = { ...p, extra: p.extra_actions.length ? p.extra_actions.join('. ') + '.' : '' };

    const assemble = () => shape.order
        .map(k => (k === 'subject' ? [chosen.subject, chosen.extra].filter(Boolean).join(' ') : chosen[k]))
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

    let text = assemble();
    for (const drop of optional) {
        if (text.length <= limit) break;
        chosen[drop] = '';
        text = assemble();
    }

    /*
     * THE CAMERA AND THE SPATIAL LOCKS ARE NEVER CUT — the SUBJECT is trimmed
     * to make room for them.
     *
     * A naive tail-truncation loses whatever sits last in the provider's own
     * order, and on the default shape that is the camera. The rule this engine
     * already states: "the camera move survives with the subject: it is short,
     * and without it the clip has no move." Staging is protected for the same
     * reason — it is the technique this pipeline most depends on and it is
     * short. So the long thing gives way, cut at a clause boundary, so the last
     * thing the model reads is a complete instruction.
     */
    if (text.length > limit) {
        const fixed = shape.order.filter(k => k !== 'subject')
            .map(k => chosen[k]).filter(Boolean).join(' ').trim();
        const room = limit - fixed.length - 1;
        if (room > 40) {
            let subj = [chosen.subject, chosen.extra].filter(Boolean).join(' ');
            subj = subj.slice(0, room);
            const lastStop = Math.max(subj.lastIndexOf('. '), subj.lastIndexOf(', '));
            if (lastStop > 40) subj = subj.slice(0, lastStop + 1);
            chosen.subject = subj.trim();
            chosen.extra = '';
            text = assemble();
        }
        // Still over only if the fixed parts alone exceed the ceiling, which
        // means the camera clause itself is enormous — truncate then, and say so.
        if (text.length > limit) text = text.slice(0, limit).replace(/[^.]*$/, '').trim() || text.slice(0, limit);
    }

    return { prompt: text, shape: shapeId || 'default', limit, order: shape.order, why: shape.why };
}

/** Compile for a named provider, using its own shape and its own ceiling. */
function compileFor(providerId, ctx) {
    // An explicit ceiling from the caller WINS: a deliberate clamp is a
    // decision, and reading the provider's own maximum over the top of it
    // would make the clamp look applied while the prompt ran past it.
    let limit = Number(ctx && ctx.limit) > 0 ? Number(ctx.limit) : 0;
    if (!limit) {
        limit = 1000;
        try {
            const a = require('./providers').get ? require('./providers').get(providerId) : null;
            const found = a || require('./providers').list().find(x => x.id === providerId);
            if (found && found.promptLimit) limit = found.promptLimit;
        } catch (_) { /* the conservative default stands */ }
    }
    const shapeId = SHAPES[providerId] ? providerId : 'default';
    return buildMotionPrompt({ ...ctx, limit }, shapeId);
}

module.exports = {    TECHNIQUES,
    performanceClause, cueExtension, speakerName, isOnScreen, NEW_CARD_FIELDS, SHAPES,
    buildMotionPrompt, compileFor, shotShape, paceWords,};
