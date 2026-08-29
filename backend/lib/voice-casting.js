/**
 * Hearing the dialogue before anything is shot.
 *
 * Dialogue generation shipped in phase 4 and was unreachable from the app:
 * `POST /shots/:id/voice/generate` existed, no page had a voice control of any
 * kind, and `film_voice_profiles` held zero rows. So a line could only be heard
 * by curl or by an agent, and only for a SHOT — which means only after a
 * breakdown, which is after the point where hearing it would change what you
 * write.
 *
 * It would also have been the same voice every time. `buildVoicePayload` reads
 * `voiceProfile.voice_id`; the column did not exist, so that branch was dead and
 * the ElevenLabs adapter fell through to its default. Migration 089 adds the
 * column the builder was already reading, rather than adding a parallel casting
 * system beside it.
 *
 * The scopes below are the places dialogue actually lives, and the two marked
 * `before_breakdown` are the answer to the question that prompted this: a
 * director should be able to hear a line, and a whole scene, while writing.
 */

/**
 * Where dialogue exists, and where it can be heard.
 *
 * `spends` and `before_breakdown` are declared per scope rather than inferred:
 * whether pressing something costs money, and whether it is available while you
 * are still writing, are the two things a director needs to know about each of
 * these, and inferring either from the route shape is how one of them ends up
 * wrong.
 */
const DIALOGUE_SCOPES = Object.freeze([
    {
        id: 'voice',
        title: 'A voice, auditioned',
        what: 'One line, spoken by one catalogue voice, attached to nothing. This is how a part is cast.',
        when: 'While casting, before anything is generated.',
        route: 'POST /film/audition',
        tool: 'voice_audition',
        ui: 'auditionVoice(',
        spends: true,
        before_breakdown: true,
    },
    {
        id: 'character',
        title: 'A character, cast',
        what: 'Which catalogue voice this character speaks in, for every line they have.',
        when: 'Once, in planning. Everything downstream reads it.',
        route: 'PUT /film/characters/:id/voice',
        tool: 'voice_cast',
        ui: 'castCharacterVoice(',
        spends: false,
        before_breakdown: true,
    },
    {
        id: 'line',
        title: 'One line from the screenplay',
        what: 'A single speech, in the voice its character is cast in.',
        when: 'While writing — does this line play?',
        route: 'POST /film/audition',
        tool: 'voice_audition',
        ui: 'auditionVoice(',
        spends: true,
        before_breakdown: true,
    },
    {
        id: 'scene',
        title: 'A table read',
        what: 'Every spoken line in a scene, in order, each in its character’s cast voice.',
        when: 'Before the breakdown — how does the scene play out loud?',
        route: 'POST /film/scenes/:id/table-read',
        tool: 'table_read',
        ui: 'runTableRead(',
        spends: true,
        before_breakdown: true,
    },
    {
        id: 'shot',
        title: 'A shot’s dialogue',
        what: 'The take that ships: registered against the shot and consumed by lip-sync and the mix.',
        when: 'Production. This is the real generation, not an audition.',
        route: 'POST /film/shots/:id/voice/generate',
        tool: 'node_gen_voice',
        ui: 'generateVoiceForShot(',
        spends: true,
        before_breakdown: false,
    },
    {
        id: 'project',
        title: 'Every line in the film',
        what: 'Batch: all dialogue for every shot that has any.',
        when: 'Production, once the cast is settled.',
        route: 'POST /film/projects/:id/voice/batch',
        tool: 'node_gen_voice',
        ui: 'generateAllVoices(',
        spends: true,
        before_breakdown: false,
    },
]);

/**
 * A catalogue voice, in the shape a director chooses by.
 *
 * ElevenLabs returns labels as a free-form object; the fields lifted out are
 * the ones a casting decision is actually made on. `preview_url` matters most:
 * a list of names is a dropdown, and a list you can HEAR is a casting session
 * — and the preview costs nothing, because the provider hosts it.
 */
function normaliseVoice(v) {
    const labels = (v && v.labels) || {};
    return {
        voice_id: v.voice_id || v.id || null,
        name: v.name || null,
        gender: labels.gender || null,
        age: labels.age || null,
        accent: labels.accent || null,
        description: labels.description || v.description || null,
        use_case: labels.use_case || labels['use case'] || null,
        preview_url: v.preview_url || null,
        category: v.category || null,
        // Learned from a refusal, not read from `category` — every voice in the
        // list reports "premade", including ones a free plan cannot use.
        usable: v.usable !== false,
        unusable_reason: v.unusable_reason || null,
    };
}

/* ── casting from what the character sheet says ────────────────────────── */

/**
 * The age band the provider actually labels with.
 *
 * ElevenLabs uses `young | middle_aged | old`; a character sheet says "30s",
 * "20-30", "late 40s". Parsed from the numbers rather than matched against a
 * list of phrasings, because a writer types whatever they type and a suggester
 * that handles "30s" and not "20-30" silently stops working for half the cast.
 *
 * NOTHING RECORDED MEANS NULL, never a guess. A guessed band filters the whole
 * catalogue on an invention, which is worse than not filtering — the director
 * would not know why the good voice is missing.
 */
function ageBand(ageRange) {
    const text = String(ageRange || '').toLowerCase();
    if (!text.trim()) return null;
    if (/\b(teen|teens|teenager|child|kid|young)\b/.test(text)) return 'young';
    if (/\b(elderly|old|senior)\b/.test(text)) return 'old';

    const numbers = (text.match(/\d+/g) || []).map(Number).filter(n => n > 0 && n < 120);
    if (!numbers.length) return null;
    // A range is judged at its midpoint; "30s" reads as 30.
    const age = numbers.reduce((a, b) => a + b, 0) / numbers.length;
    if (age < 35) return 'young';
    if (age < 62) return 'middle_aged';
    return 'old';
}

/**
 * The character's gender, in the provider's vocabulary.
 *
 * READ, never inferred. Both characters on the real project have no gender
 * recorded, and guessing one from a name is wrong in principle and wrong in
 * fact — DRAGON is not a woman because the name reads that way to a regex.
 */
function voiceGender(character) {
    const text = String((character && character.gender) || '').trim().toLowerCase();
    if (!text) return null;
    if (/^f|woman|girl/.test(text)) return 'female';
    if (/^m(?!ixed)|man|boy/.test(text)) return 'male';
    if (/non-?binary|neutral|enby|they/.test(text)) return 'neutral';
    return null;
}

/**
 * The catalogue, ordered for THIS character.
 *
 * Ranked rather than filtered: a director may want a voice the sheet does not
 * predict, and removing it would make that choice unavailable without saying
 * so. `why` travels with each suggestion, because a reordering nobody can check
 * is indistinguishable from an arbitrary one.
 *
 * A voice already cast to somebody else is FLAGGED and pushed down, not hidden:
 * two characters in a scene sounding identical is the failure this exists to
 * prevent, but one performer doubling two small parts is a real choice and
 * hiding the voice would make it unsayable.
 */
function suggestVoices(character, catalogue, takenBy) {
    const gender = voiceGender(character);
    const band = ageBand(character && character.age_range);
    const taken = takenBy || {};

    const missing = [];
    if (!gender) missing.push('gender');
    if (!band) missing.push('age_range');

    const scored = (catalogue || []).map(v => {
        const why = [];
        let score = 0;
        if (gender && v.gender === gender) { score += 4; why.push(gender); }
        if (band && v.age === band) { score += 2; why.push(String(v.age).replace('_', ' ')); }
        const takenName = taken[v.voice_id] || null;
        if (takenName) score -= 3;
        // A voice this plan has been refused ranks below everything: still
        // listed, because upgrading is a real option, but never suggested.
        if (v.usable === false) score -= 20;
        return { ...v, score, why, taken_by: takenName };
    });

    scored.sort((a, b) => b.score - a.score
        || String(a.name || '').localeCompare(String(b.name || '')));

    return {
        for: (character && character.name) || null,
        matched_on: { gender: gender || null, age: band || null },
        missing,
        note: missing.length
            ? `No ${missing.join(' or ')} recorded for ${(character && character.name) || 'this character'}, `
              + 'so the catalogue is not narrowed by it. Fill it in on the character to get better suggestions.'
            : null,
        suggested: scored,
    };
}

/**
 * A payload for hearing a line, attached to nothing.
 *
 * Deliberately carries no shot, scene or asset type. An audition that
 * registered against a shot would be indistinguishable from a take, and the
 * pipeline would then ship a reading the director was only trying out.
 */
function auditionPayload({ text, voice_id, model, language, speed, stability, similarity_boost }) {
    const line = String(text || '').trim();
    if (!line) {
        const err = new Error('An audition needs text to speak.');
        err.code = 'NO_TEXT';
        throw err;
    }
    const payload = {
        text: line,
        ...(voice_id ? { voice_id } : {}),
        ...(model ? { model } : {}),
        ...(language ? { language } : {}),
        ...(speed ? { speed } : {}),
        ...(stability !== undefined ? { stability } : {}),
        ...(similarity_boost !== undefined ? { similarity_boost } : {}),
    };
    return payload;
}

/**
 * The spoken lines of a scene, in order, with who says each.
 *
 * A parenthetical is DIRECTION on the line beneath it, not speech: read aloud
 * it becomes "quietly, get inside". It travels beside the line so a reader can
 * see it and a generator can use it as emotion, and never inside the text.
 */
function tableRead(elements) {
    const out = [];
    let speaker = null;
    let direction = null;

    for (const el of elements || []) {
        const type = String(el.element_type || el.type || '').replace(/_/g, '-');
        const text = String(el.text || '').trim();

        if (type === 'character') { speaker = text.replace(/\s*\(CONT'D\)\s*$/i, '').trim(); direction = null; continue; }
        if (type === 'parenthetical') { direction = text; continue; }
        if (type === 'dialogue') {
            if (!text) continue;
            out.push({
                character: speaker || null,
                line: text,
                direction: direction || null,
                index: out.length,
            });
            direction = null;
            continue;
        }
        // Action, a heading or a transition ends the speech that preceded it.
        if (type === 'action' || type === 'scene-heading' || type === 'transition') {
            speaker = null; direction = null;
        }
    }
    return out;
}

/**
 * Who has not been cast.
 *
 * The failure this replaces was silent: every line generated, nothing errored,
 * and the film came back in the provider's default voice. A director cannot
 * hear "this was never cast" — they hear a choice somebody appears to have
 * made. So it is reported as work, not discovered in the mix.
 */
function castingGaps(characters) {
    const list = characters || [];
    const uncast = list.filter(c => !c.voice_id).map(c => ({ id: c.id, name: c.name }));
    return {
        total: list.length,
        cast: list.length - uncast.length,
        uncast,
        warning: uncast.length
            ? `${uncast.length} character(s) have no voice cast. Their lines will generate in the `
              + 'provider’s DEFAULT voice, which sounds like a decision rather than an omission.'
            : null,
    };
}

module.exports = {
    DIALOGUE_SCOPES, normaliseVoice, auditionPayload, tableRead, castingGaps,
    ageBand, voiceGender, suggestVoices,
};
