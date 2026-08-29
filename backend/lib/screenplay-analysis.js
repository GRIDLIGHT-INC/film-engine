/**
 * Reading a screenplay the way a reader does, not the way a beat sheet does.
 *
 * The useful question is not "does this obey one famous structure?" but whether
 * the story creates a coherent, emotionally engaging experience through
 * character, conflict, causality and cinematic writing. The Academy's Nicholl
 * rubric groups that as Story, Voice, Characters, Craft and "Meaning and
 * Magic"; Sundance adds stakes, objectives, causality, scene function, subtext,
 * setup and payoff, tone and visual storytelling. The thirteen dimensions below
 * are those two, merged.
 *
 * Two design rules carry the whole feature.
 *
 * **The engine does not reason.** The connected agent IS the model here — that
 * is why `tests/mcp-no-server-llm.test.js` exists — so this module never calls
 * one. It builds a BRIEF (the screenplay, the rubric, the output schema, and
 * every fact the engine can compute for free) and it VALIDATES what comes back.
 * The judgement belongs to the model that has already read the script.
 *
 * **Diagnose before prescribing.** "Add an inciting incident on page 12" tells
 * a writer what story to write. "The protagonist's goal is not identifiable
 * until scene 14 — if that delay is deliberate, the earlier curiosity may need
 * strengthening; if not, the disruption may need to arrive sooner" tells them
 * what a reader experienced and hands the decision back. Every note therefore
 * carries evidence, an effect, a question and strategies — never a rewrite.
 *
 * That last one is also a practical constraint rather than only a creative
 * preference: the Nicholl rules prohibit AI-generated dialogue, characters and
 * scene description, so a tool that silently rewrites the author's work can
 * disqualify the screenplay it was helping. `validateNote` refuses drafted prose.
 */

const NICHOLL = 'Academy Nicholl scoring rubric';
const SUNDANCE = 'Sundance Collab screenwriting curriculum';

const CONFIDENCE = ['high', 'medium', 'low'];
const NOTE_KINDS = ['mechanical', 'interpretive'];

/**
 * The four layers of a report, in the order they are read.
 *
 * The map comes first because a note with no shared picture of the screenplay
 * is an assertion. Opportunities come last because a suggestion offered before
 * the diagnosis reads as a verdict.
 */
const LAYERS = Object.freeze([
    { id: 'map', title: 'Screenplay map',
      what: 'Characters, scenes, locations, chronology, goals, turning points, setups and payoffs — what is in the script, before any judgement about it.' },
    { id: 'observations', title: 'Observations',
      what: 'Specific patterns, each supported by a scene or page reference.' },
    { id: 'questions', title: 'Development questions',
      what: 'Questions that help the writer test their own intent, without prescribing one correct story.' },
    { id: 'opportunities', title: 'Revision opportunities',
      what: 'Prioritised, each explaining its likely impact, and preserving the writer\'s voice.' },
]);

/**
 * What every note carries.
 *
 * `question` is required and that is deliberate: a note that states a problem
 * and offers no way for the writer to test whether it IS a problem is a verdict.
 * `confidence` and `kind` are required so a reader can filter — a mechanical
 * certainty and an interpretive hunch should not be read with the same weight,
 * and a report that presents them identically teaches people to discount both.
 */
const NOTE_FIELDS = Object.freeze([
    { name: 'observation', required: true, what: 'What is true of the screenplay, stated plainly.' },
    { name: 'evidence', required: true, what: 'Where — scene number, page, or a short quotation.' },
    { name: 'effect', required: true, what: 'Why this may affect how an audience experiences the film.' },
    { name: 'question', required: true, what: 'A question that lets the writer test their intent.' },
    { name: 'strategies', required: true, what: 'One or more revision approaches. Approaches, never drafted prose.' },
    { name: 'confidence', required: true, what: `One of: ${CONFIDENCE.join(', ')}.` },
    { name: 'kind', required: true, what: `One of: ${NOTE_KINDS.join(', ')}.` },
]);

/** Fields that must never appear: they would be the tool writing the script. */
const FORBIDDEN_NOTE_FIELDS = Object.freeze(['rewrite', 'replacement', 'new_dialogue', 'draft']);

/**
 * The thirteen dimensions.
 *
 * `kind` decides who answers it. MECHANICAL means the engine computes it
 * exactly, for free, every time — asking a model to count parentheticals is
 * slower, costs tokens and is less reliable than a regex. INTERPRETIVE means
 * only a reader can answer it, and that is the entire point of the feature.
 * Declared per dimension so the split cannot quietly drift into "ask the model
 * everything".
 */
const DIMENSIONS = Object.freeze([
    {
        id: 'premise', title: 'Premise and dramatic engine', kind: 'interpretive',
        central_question: 'Does the premise generate actions, complications and difficult choices?',
        look_for: [
            'A clearly identifiable protagonist or central group',
            'A goal, problem, or dramatic question',
            'Opposition preventing an easy solution',
            'Consequences if the protagonist fails',
            'A premise capable of sustaining the script\'s length',
            'Something distinctive about the situation, perspective or execution',
        ],
        note: 'The question is not "is the idea original" but whether the premise actively starts the movie forward.',
        sources: [NICHOLL, SUNDANCE],
    },
    {
        id: 'structure', title: 'Story structure and narrative progression', kind: 'interpretive',
        central_question: 'Does the script have an effective beginning, middle and end that takes the reader on a journey?',
        look_for: [
            'A strong opening that establishes expectations',
            'An inciting disruption or meaningful change',
            'Escalating complications',
            'Significant turning points',
            'A climax arising from earlier choices',
            'A resolution that answers the central dramatic question',
            'Setup and payoff relationships',
            'Understandable progression, even if the story is nonlinear',
        ],
        note: 'Three-act structure may be DESCRIBED but must not be enforced as a universal formula. Departing from it deliberately is a craft choice, not an error.',
        sources: [NICHOLL, SUNDANCE],
    },
    {
        id: 'causality', title: 'Causality and story logic', kind: 'interpretive',
        central_question: 'Do actions emerge from character, or happen because they are convenient for the plot?',
        look_for: [
            'Whether one event causes or motivates the next',
            'Whether decisions have consequences',
            'Whether essential information appears before it is needed',
            'Whether solutions are properly established',
            'Whether coincidences disproportionately help the protagonist',
            'Whether characters act consistently with what they know',
            'Unresolved story threads, promises, objects or relationships',
            'Contradictions in time, location, character knowledge or motivation',
        ],
        sources: [NICHOLL, SUNDANCE],
    },
    {
        id: 'character', title: 'Character construction', kind: 'interpretive',
        central_question: 'Does the script understand whether each character changes, refuses to change, causes change in others, or is destroyed by an inability to change?',
        look_for: [
            'External want: what they consciously pursue',
            'Internal need: what they may need to learn or confront',
            'Motivation: why the goal matters',
            'Stakes: what success or failure means personally',
            'Strengths, flaws, fears, contradictions and values',
            'Agency: whether they make consequential choices',
            'Relationships and sources of conflict',
            'Change, revelation, failure to change, or deliberate steadfastness',
            'Distinctive behaviour and worldview',
        ],
        note: 'A protagonist does not need a conventional positive transformation. Steadfastness can be the point.',
        sources: [NICHOLL, SUNDANCE],
    },
    {
        id: 'conflict', title: 'Conflict, obstacles, stakes and escalation', kind: 'interpretive',
        central_question: 'Does conflict propel the story, and does the cost of failure rise?',
        look_for: [
            'What each major character wants in a scene or sequence',
            'Who or what opposes them',
            'Whether objectives are incompatible',
            'How tactics change when an approach fails',
            'Whether complications intensify',
            'Whether the cost of failure increases',
            'Whether choices become progressively more difficult',
            'Whether conflicts are external, interpersonal and internal',
        ],
        note: 'Conflict is not constant arguing. Avoidance, concealment, environmental resistance, moral pressure and incompatible needs are all conflict.',
        sources: [NICHOLL, SUNDANCE],
    },
    {
        id: 'scene_function', title: 'Scene effectiveness', kind: 'interpretive',
        central_question: 'Does each scene change at least one story value, and could it be removed without meaningful loss?',
        look_for: [
            'Character objective',
            'Obstacle or resistance',
            'Narrative purpose',
            'New information, decision, reversal or consequence',
            'Emotional movement between the start and the end',
            'Connection to surrounding scenes',
            'Whether it enters late and leaves at an effective moment',
            'Whether the same function is repeated elsewhere',
        ],
        note: 'A strong scene commonly turns a value: trust to suspicion, safety to danger, hope to disappointment, ignorance to knowledge.',
        sources: [SUNDANCE],
    },
    {
        id: 'pacing', title: 'Pacing and rhythm', kind: 'interpretive',
        central_question: 'Does tension escalate, plateau, or disappear — and is that deliberate?',
        look_for: [
            'Overall distribution of major developments',
            'Long stretches without a decision, revelation or complication',
            'Scene-length variation',
            'Dialogue-to-action balance',
            'Repeated conversations or exposition',
            'Rapid changes that lack emotional processing',
            'Late introduction of essential story material',
            'Momentum entering and leaving sequences',
        ],
        note: 'Pacing is not speed. A slow scene can grip if tension, curiosity or emotional pressure is changing underneath it.',
        sources: [NICHOLL, SUNDANCE],
    },
    {
        id: 'dialogue', title: 'Dialogue and subtext', kind: 'interpretive',
        central_question: 'Does this line belong to that character, pursue an objective, and change the scene?',
        look_for: [
            'Distinct character voices',
            'Consistency with background, setting, relationship and tone',
            'Clear intention behind what is said',
            'Subtext: the difference between the words and the underlying intent',
            'Exposition disguised as unnatural conversation',
            'Characters stating emotions already visible in their behaviour',
            'Repetitious greetings, confirmations and filler',
            'Speeches implausibly polished for the situation',
            'Interruption, avoidance, silence and changes of tactic',
        ],
        note: 'Short dialogue is not the same as good dialogue. Do not equate brevity with quality.',
        sources: [NICHOLL, SUNDANCE],
    },
    {
        id: 'visual', title: 'Visual and cinematic storytelling', kind: 'interpretive',
        central_question: 'Does the screenplay communicate through what an audience can see and hear?',
        look_for: [
            'Character revealed through behaviour rather than explanation',
            'Internal states externalised through choices, action, imagery or sound',
            'Filmable action descriptions',
            'Important visual motifs and contrasts',
            'Descriptions of thoughts that cannot appear onscreen',
            'Camera directions that do not contribute meaningfully',
            'Information communicated twice, in both action and dialogue',
        ],
        sources: [NICHOLL],
    },
    {
        id: 'theme', title: 'Theme, meaning and emotional effect', kind: 'interpretive',
        central_question: 'Is the story about something, and does the ending develop or complicate that?',
        look_for: [
            'Recurring moral or thematic questions',
            'Different characters embodying different answers',
            'Whether important choices express the theme',
            'Emotional turning points',
            'Whether the script earns its intended emotional response',
            'Heavy-handed speeches that explain the theme',
            'Disconnects between the stated message and the dramatic outcome',
        ],
        note: 'Theme is not a topic like "family" or "justice". It is the screenplay\'s evolving perspective on that subject.',
        sources: [NICHOLL],
    },
    {
        id: 'tone', title: 'Tone, genre, world and consistency', kind: 'interpretive',
        central_question: 'Is every tonal or genre departure deliberate rather than accidental?',
        look_for: [
            'An identifiable tonal promise',
            'Deliberate rather than accidental tonal changes',
            'Consistent rules for the story world',
            'Genre expectations established and handled consciously',
            'A balance of familiarity and surprise',
            'Character behaviour appropriate to the world',
            'Payoffs for rules or devices introduced earlier',
        ],
        note: 'A script may break genre conventions. The break should read as intentional.',
        sources: [SUNDANCE],
    },
    {
        id: 'voice', title: 'Voice and originality', kind: 'interpretive',
        central_question: 'Does the work feel authored by someone with a particular perspective?',
        look_for: [
            'Distinctive selection of detail',
            'A recognisable attitude toward the material',
            'Fresh character perspectives',
            'Specific rather than generic settings and behaviour',
            'Surprising but credible choices',
            'Consistency of narrative personality',
            'Clichés, and mechanical reversals of clichés',
        ],
        note: 'Originality cannot be calculated from surface similarity. Frame this through reader response, not comparison to other work.',
        sources: [NICHOLL],
    },
    {
        id: 'format', title: 'Readability and professional presentation', kind: 'mechanical',
        central_question: 'Does the presentation get out of the way of the reading?',
        look_for: [
            'Valid scene headings',
            'Consistent character names',
            'Balanced action-paragraph length',
            'Overuse of parentheticals, transitions, capitalisation or camera directions',
            'Dense blocks of action',
            'Scenes with no action following the heading',
            'Repeated words and formatting anomalies',
        ],
        note: 'These matter and must not dominate the report. Minor formatting deviations do not invalidate a strong screenplay.',
        sources: [NICHOLL],
    },
]);

/* ── mechanical checks: what the engine can answer exactly ─────────────── */

function note(fields) {
    return { confidence: 'high', kind: 'mechanical', ...fields };
}

/** Scene headings that will not parse, dense action, parenthetical overuse. */
function checkFormat(fountain) {
    const lines = String(fountain || '').split('\n');
    const out = [];

    // A heading a parser cannot read is a scene that will not break down.
    const headingish = [];
    lines.forEach((line, i) => {
        const t = line.trim();
        if (/^(INT|EXT|INT\.\/EXT|I\/E)\b/i.test(t)) headingish.push({ line: i + 1, text: t });
    });
    const malformed = headingish.filter(h => !/^(INT\.|EXT\.|INT\.\/EXT\.|I\/E\.)/i.test(h.text)
        || !/[-–—]/.test(h.text));
    if (malformed.length) {
        out.push(note({
            observation: `${malformed.length} scene heading${malformed.length === 1 ? '' : 's'} `
                + 'may not parse as a slugline.',
            evidence: malformed.slice(0, 5).map(h => `line ${h.line}: ${h.text}`).join(' · '),
            effect: 'A heading the parser cannot read produces no scene, so nothing downstream — '
                + 'breakdown, shots, schedule — knows that scene exists.',
            question: 'Are these intended as scene headings, or as action?',
            strategies: ['Use INT./EXT., a location, and a dash before the time of day.'],
        }));
    }

    // A wall of action is a wall a reader skims.
    const paragraphs = String(fountain || '').split(/\n\s*\n/);
    const dense = paragraphs.filter(p => {
        const t = p.trim();
        if (!t || /^[A-Z0-9 .'()\-]+$/.test(t)) return false;      // cue lines, headings
        if (/^(INT|EXT)/i.test(t)) return false;
        return t.length > 320;
    });
    if (dense.length) {
        out.push(note({
            observation: `${dense.length} action paragraph${dense.length === 1 ? '' : 's'} `
                + `${dense.length === 1 ? 'runs' : 'run'} longer than about four lines.`,
            evidence: dense.slice(0, 3).map(p => `"${p.trim().slice(0, 60)}…"`).join(' · '),
            effect: 'Dense blocks are skimmed, and what is skimmed is not read — the images '
                + 'inside them do not reach the reader.',
            question: 'Does each of these paragraphs hold one image, or several?',
            strategies: ['Break on beats, so each paragraph carries one picture.'],
            confidence: 'medium',
        }));
    }

    // Parentheticals are a direction on a line the actor already has.
    const parens = lines.filter(l => /^\s*\([a-z][^)]*\)\s*$/.test(l)).length;
    const cues = lines.filter(l => /^[A-Z][A-Z0-9 .'\-]{1,38}$/.test(l.trim()) && l.trim().length > 1).length;
    if (cues > 8 && parens / cues > 0.35) {
        out.push(note({
            observation: `${parens} parentheticals across roughly ${cues} dialogue cues.`,
            evidence: `${Math.round((parens / cues) * 100)}% of speeches carry a direction.`,
            effect: 'Frequent parentheticals read as distrust of the line and of the performer.',
            question: 'Which of these are doing work the line itself could do?',
            strategies: ['Keep the ones that reverse the apparent meaning; cut the ones that restate it.'],
            confidence: 'medium',
        }));
    }

    // Near-duplicate character names split one person into two everywhere
    // downstream: two rows, two plates, two voices.
    const names = {};
    for (const l of lines) {
        const t = l.trim();
        if (/^[A-Z][A-Z0-9 .'\-]{1,38}$/.test(t) && t.length > 2 && !/^(INT|EXT|FADE|CUT)/.test(t)) {
            names[t] = (names[t] || 0) + 1;
        }
    }
    const keys = Object.keys(names);
    const pairs = [];
    for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
            const a = keys[i], b = keys[j];
            if (a === b) continue;
            // One character of difference on names of real length: a typo, not
            // two people. Bounded to avoid pairing every short cue with another.
            if (Math.abs(a.length - b.length) <= 1 && a.length > 4
                && (a.startsWith(b.slice(0, -1)) || b.startsWith(a.slice(0, -1)))) {
                pairs.push(`${a} / ${b}`);
            }
        }
    }
    if (pairs.length) {
        out.push(note({
            observation: `${pairs.length} pair${pairs.length === 1 ? '' : 's'} of character names differ by one character.`,
            evidence: pairs.slice(0, 4).join(' · '),
            effect: 'Two spellings become two characters: two entity rows, two reference plates, '
                + 'two voices, and every report counts them separately.',
            question: 'Are these the same person?',
            strategies: ['Settle on one spelling and use it in every cue.'],
        }));
    }

    return out;
}

const MECHANICAL_CHECKS = Object.freeze({ format: checkFormat });

/** Run every mechanical check, keyed by the dimension it answers. */
function runMechanical(fountain) {
    const out = {};
    for (const [id, fn] of Object.entries(MECHANICAL_CHECKS)) {
        try { out[id] = fn(fountain) || []; } catch (_) { out[id] = []; }
    }
    return out;
}

/* ── validation ────────────────────────────────────────────────────────── */

function validateNote(n) {
    const errors = [];
    if (!n || typeof n !== 'object') return { valid: false, errors: ['note must be an object'] };

    for (const field of NOTE_FIELDS) {
        if (!field.required) continue;
        const v = n[field.name];
        if (v === undefined || v === null || v === '') { errors.push(`missing '${field.name}'`); continue; }
        if (field.name === 'strategies') {
            if (!Array.isArray(v) || !v.length) errors.push("'strategies' must be a non-empty array");
        } else if (typeof v !== 'string') {
            errors.push(`'${field.name}' must be a string`);
        }
    }
    if (n.confidence !== undefined && !CONFIDENCE.includes(n.confidence)) {
        errors.push(`confidence must be one of: ${CONFIDENCE.join(', ')}`);
    }
    if (n.kind !== undefined && !NOTE_KINDS.includes(n.kind)) {
        errors.push(`kind must be one of: ${NOTE_KINDS.join(', ')}`);
    }
    for (const forbidden of FORBIDDEN_NOTE_FIELDS) {
        if (n[forbidden] !== undefined) {
            errors.push(`'${forbidden}' is not accepted: a note offers strategies, never rewritten prose. `
                + 'Generated dialogue or scene description can disqualify the screenplay from competitions '
                + 'that prohibit AI-written material.');
        }
    }
    return { valid: errors.length === 0, errors };
}

function validateAnalysis(a) {
    const errors = [];
    if (!a || typeof a !== 'object') return { valid: false, errors: ['analysis must be an object'] };

    if (a.score !== undefined || a.rating !== undefined || a.grade !== undefined) {
        errors.push('an overall score is not accepted: a number gets quoted without the reasoning '
            + 'that produced it. Report observations with evidence instead.');
    }
    for (const layer of LAYERS) {
        if (a[layer.id] === undefined) { errors.push(`missing layer '${layer.id}'`); continue; }
    }
    for (const layer of ['observations', 'opportunities']) {
        const items = a[layer];
        if (items === undefined) continue;
        if (!Array.isArray(items)) { errors.push(`'${layer}' must be an array of notes`); continue; }
        items.forEach((n, i) => {
            const res = validateNote(n);
            if (!res.valid) errors.push(`${layer}[${i}]: ${res.errors.join('; ')}`);
        });
    }
    if (a.questions !== undefined && !Array.isArray(a.questions)) {
        errors.push("'questions' must be an array");
    }
    if (a.map !== undefined && (typeof a.map !== 'object' || Array.isArray(a.map))) {
        errors.push("'map' must be an object");
    }
    return { valid: errors.length === 0, errors };
}

/* ── the brief ─────────────────────────────────────────────────────────── */

const INSTRUCTIONS = `Read the screenplay and report on it.

DIAGNOSE BEFORE PRESCRIBING. Say what a reader experiences and why, then hand
the decision back to the writer. "The protagonist's goal is not identifiable
until scene 14; if that delay is deliberate, the earlier source of curiosity may
need strengthening — if not, the disruption may need to arrive sooner" is a
note. "Add an inciting incident on page 12" is a verdict.

Every observation and every opportunity must carry evidence — a scene number, a
page, or a short quotation. A note with no evidence cannot be checked or argued
with.

Do NOT write replacement dialogue, scene description or character material.
Offer strategies and questions. Generated prose can disqualify a screenplay from
competitions that prohibit AI-written material.

Do NOT give an overall score. Structure is described, never enforced: a script
that departs from three-act shape may be doing so deliberately, and the report
should ask rather than correct.

The mechanical findings below were computed from the text and are already
reliable. Do not recount them — build on them, or ignore them if they are not
worth a writer's attention.`;

/**
 * Everything the model needs, and nothing it has to be told twice.
 *
 * The mechanical findings travel WITH the brief so the model is not asked to
 * count parentheticals — arithmetic it does more slowly and less reliably than
 * a regex, and which would cost tokens on every run.
 */
function buildBrief(input) {
    const { title, fountain, scenes, timing } = input || {};
    return {
        title: title || null,
        screenplay: String(fountain || ''),
        scene_count: Array.isArray(scenes) ? scenes.length : null,
        scenes: Array.isArray(scenes)
            ? scenes.map(s => ({ scene_number: s.scene_number, heading: s.heading || s.location || null }))
            : [],
        timing: timing || null,
        instructions: INSTRUCTIONS,
        dimensions: DIMENSIONS.map(d => ({
            id: d.id, title: d.title, kind: d.kind,
            central_question: d.central_question,
            look_for: d.look_for,
            note: d.note || null,
            sources: d.sources,
        })),
        layers: LAYERS,
        note_schema: NOTE_FIELDS,
        confidence_levels: CONFIDENCE,
        mechanical: runMechanical(fountain),
    };
}

/* ── samples, used by the schema tests and by the tool descriptions ────── */

function sampleNote() {
    return {
        observation: 'The protagonist\'s goal is not identifiable until scene 14.',
        evidence: 'Scenes 1-13 establish routine; RAY first states what he wants on p.17.',
        effect: 'A reader may not know what to hope for during the first quarter.',
        question: 'Is the delayed reveal deliberate, and if so what is holding attention until then?',
        strategies: [
            'Strengthen the earlier source of curiosity so the delay is doing work.',
            'Or let the disruption arrive sooner and keep the reveal for its consequences.',
        ],
        confidence: 'medium',
        kind: 'interpretive',
    };
}

function sampleAnalysis() {
    return {
        map: { characters: ['RAY', 'MAYA'], scenes: 14, locations: ['DINER'], turning_points: [] },
        observations: [sampleNote()],
        questions: ['What does Ray believe about himself that the ending disproves?'],
        opportunities: [sampleNote()],
    };
}

module.exports = {
    DIMENSIONS, LAYERS, NOTE_FIELDS, CONFIDENCE, NOTE_KINDS,
    FORBIDDEN_NOTE_FIELDS, MECHANICAL_CHECKS, INSTRUCTIONS,
    runMechanical, validateNote, validateAnalysis, buildBrief,
    sampleNote, sampleAnalysis,
};
