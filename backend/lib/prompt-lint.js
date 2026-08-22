/**
 * Language that describes what is NOT in the frame.
 *
 * A scene card is written like a screenplay, which describes the whole world:
 * what is off frame, what is behind camera, what we never see. An image model
 * draws what you NAME, and negation is the least reliable instruction it takes
 * — so every one of those phrases puts the thing it is excluding into the
 * picture.
 *
 * On Wingfall 2B this cost an afternoon. The card said "shears the roofline off
 * the pale blue two-storey house JUST OFF FRAME" and every attempt drew that
 * house, in frame. It said "We never see its face" and one attempt drew the
 * face. It said the debris travels "past camera" and "the opened house BEHIND
 * CAMERA", and both were rendered in shot. Nothing was broken; the prompt was
 * asking for them.
 *
 * WARNS, NEVER BLOCKS, on the precedent the style check set: a director may
 * genuinely want a phrase this flags, and refusing the save would overrule the
 * author. It names the offending words, because "your description may contain
 * off-frame language" just sends someone back to re-read their own paragraph.
 */

/**
 * Each rule is a phrase that EXCLUDES something while naming it.
 *
 * Matched as whole phrases rather than single words: "past" and "never" appear
 * in ordinary description constantly, and a check that fires on those gets
 * switched off within a day and then protects nothing — the same asymmetry the
 * style-preset check is built around.
 */
const RULES = [
    {
        id: 'off_frame',
        pattern: /\b(?:just )?(?:off|out of) (?:the )?frame\b/gi,
        why: 'names something and then says it is outside the picture — the model draws it anyway',
        fix: 'describe only what is inside the rectangle, or leave the thing out entirely',
    },
    {
        id: 'behind_camera',
        pattern: /\bbehind (?:the )?camera\b/gi,
        why: 'the camera cannot see behind itself, but naming a thing there puts it in shot',
        fix: 'describe its EFFECT instead — "a long warm wedge of light lies across the wet road"',
    },
    {
        id: 'never_see',
        pattern: /\b(?:we )?never see\b|\bnot visible\b|\bunseen\b|\bhidden from (?:the )?camera\b/gi,
        why: 'negation is the least reliable instruction an image model takes, and it names the thing',
        fix: 'say what IS seen — "seen from behind, the back of its skull toward us"',
    },
    {
        id: 'past_camera',
        pattern: /\bpast (?:the )?camera\b|\btoward camera and past it\b/gi,
        why: 'describes motion continuing outside the frame, which reads as content to draw',
        fix: 'stop the description at the frame edge — "debris fills the air between us and her"',
    },
    {
        id: 'no_negative',
        pattern: /\b(?:no|without any|there (?:is|are) no) [a-z]/gi,
        why: 'a negative in the prompt names the thing it excludes; the negative_prompt is where exclusions belong',
        fix: 'move it to the negative prompt, or rephrase as what should be there instead',
    },
];

/**
 * Find every phrase in a description that describes something out of frame.
 *
 * Returns findings rather than a boolean, because "this paragraph has a problem"
 * is not actionable and "these four phrases are drawing things you said were
 * not there" is.
 */
function offFrameFindings(text) {
    const src = String(text || '');
    if (!src.trim()) return [];
    const out = [];
    for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        let m;
        while ((m = rule.pattern.exec(src))) {
            // The sentence it sits in, so a director can find it by eye rather
            // than hunting a character offset.
            const start = src.lastIndexOf('.', m.index) + 1;
            const endDot = src.indexOf('.', m.index);
            const sentence = src.slice(start, endDot === -1 ? src.length : endDot + 1).trim();
            out.push({
                rule: rule.id,
                phrase: m[0],
                sentence: sentence.length > 220 ? sentence.slice(0, 217) + '…' : sentence,
                why: rule.why,
                fix: rule.fix,
            });
            if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
        }
    }
    return out;
}

module.exports = { offFrameFindings, RULES };
