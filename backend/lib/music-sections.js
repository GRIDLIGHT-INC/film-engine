/**
 * ── A cue that changes over its own length ──────────────────────────────────
 *
 * A film cue is not one texture for three minutes. It is sparse under the
 * argument, it opens out when he finally says it, and it is gone before the
 * cut. film_music_cues carried ONE description for the whole thing, so the
 * only way to ask for that shape was to write it as a sentence and hope.
 *
 * ElevenLabs' POST /music takes a `composition_plan`: named sections, each
 * with its own direction, its own negatives and its own duration — and it
 * honours those durations (`respect_sections_durations` defaults true). That
 * is the mechanism for "influence the music at a specific moment", and it was
 * sitting behind an adapter that only ever sent a prompt string.
 *
 * SECTIONS ARE OPT-IN, AND THAT IS THE SAFETY. `prompt` and `composition_plan`
 * are mutually exclusive at the provider, so a cue that names no sections must
 * send exactly the request it sends today, byte for byte. Deriving sections for
 * a director who has not written any would silently change every cue in every
 * project on the day this shipped — and would be inventing the musical
 * judgement this engine deliberately hands to the model.
 *
 * ── The four limits, and how they are known ─────────────────────────────────
 *
 * Every one was PROBED against the live API with a deliberately invalid request
 * — free, because validation happens before generation — rather than taken from
 * memory. Each of them is otherwise a paid request that fails:
 *
 *   prompt XOR plan     422 "You must provide exactly one of `prompt` or
 *                       `composition_plan`."
 *   no length with plan 422 "You must not provide `music_length_ms` when
 *                       passing `composition_plan`."
 *   section duration    422 ge 3000 / le 120000
 *   lines is REQUIRED   422 "Field required" — even for an instrumental cue,
 *                       where the answer is an empty array.
 */

/* Probed: `Input should be greater than or equal to 3000` / `less than or equal to 120000`. */
const SECTION_MIN_MS = 3000;
const SECTION_MAX_MS = 120000;

/* The documented ceiling for a whole cue, and the same one music_length_ms carries. */
const CUE_MAX_MS = 600000;

const MAX_SECTIONS = Math.floor(CUE_MAX_MS / SECTION_MIN_MS);

const str = v => (typeof v === 'string' ? v.trim() : '');

/**
 * A director's list of style words, from what they actually typed.
 *
 * The provider wants a LIST, and a director writes a line. Split on the
 * separators a person uses; never on spaces, which would turn "wet asphalt"
 * into two unrelated styles.
 */
function styleList(text) {
    return String(text || '')
        .split(/[,;\n]|(?:\s+\/\s+)/)
        .map(s => s.trim())
        .filter(Boolean);
}

/**
 * Sections as a director writes them, checked against what the API will accept.
 *
 * Refused rather than repaired. A cue whose sections do not fit is a cue whose
 * shape the director has an opinion about, and quietly rounding a 130-second
 * section down to 120 gives them a different piece of music than they asked for
 * — and does it silently, which is the failure this codebase keeps paying for.
 */
function validateSections(sections) {
    const errors = [];
    if (!Array.isArray(sections)) return { valid: false, errors: ['sections must be an array'], sections: [] };

    const clean = [];
    sections.forEach((raw, i) => {
        const at = `section ${i + 1}`;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            errors.push(`${at} must be an object`);
            return;
        }
        const name = str(raw.name || raw.section_name);
        if (!name) errors.push(`${at} needs a name — it is how you refer to it afterwards`);
        else if (name.length > 100) errors.push(`${at}: the name must be 100 characters or fewer`);

        const direction = str(raw.direction || raw.prompt);
        if (!direction) errors.push(`${at} ("${name || i + 1}") needs a direction — a section with no words is the cue's own description repeated`);

        const ms = Math.round(Number(raw.duration_ms) > 0 ? Number(raw.duration_ms)
            : Number(raw.seconds) * 1000);
        if (!Number.isFinite(ms) || ms <= 0) {
            errors.push(`${at} ("${name || i + 1}") needs a length`);
        } else if (ms < SECTION_MIN_MS) {
            errors.push(`${at} ("${name || i + 1}") is ${(ms / 1000).toFixed(1)}s; the shortest the generator will make is ${SECTION_MIN_MS / 1000}s`);
        } else if (ms > SECTION_MAX_MS) {
            errors.push(`${at} ("${name || i + 1}") is ${Math.round(ms / 1000)}s; the longest a single section may be is ${SECTION_MAX_MS / 1000}s — split it`);
        }

        clean.push({ name, direction, duration_ms: ms, negative: str(raw.negative || raw.negative_prompt) });
    });

    const total = clean.reduce((sum, s) => sum + (Number(s.duration_ms) || 0), 0);
    if (clean.length > MAX_SECTIONS) errors.push(`${clean.length} sections is more than a ${CUE_MAX_MS / 1000}s cue can hold`);
    if (total > CUE_MAX_MS) {
        errors.push(`the sections total ${Math.round(total / 1000)}s; the longest cue the generator will make is ${CUE_MAX_MS / 1000}s`);
    }

    return { valid: errors.length === 0, errors, sections: clean, total_ms: total };
}

/**
 * An evenly-split starting point for a cue of this length.
 *
 * STRUCTURAL, NOT MUSICAL. It says nothing about what any section should sound
 * like — every one carries the cue's own direction until a director writes into
 * it. That split has to exist because a 202-second scene CANNOT be one section
 * and the director should not have to do the arithmetic to find that out; what
 * it must not do is invent the shape of the music, which is the judgement this
 * hands to whoever is directing.
 */
function splitToFit(totalMs, direction) {
    const total = Math.max(SECTION_MIN_MS, Math.min(CUE_MAX_MS, Math.round(Number(totalMs) || 0)));
    const count = Math.max(1, Math.ceil(total / SECTION_MAX_MS));
    const each = Math.round(total / count);
    const out = [];
    for (let i = 0; i < count; i++) {
        const ms = i === count - 1 ? total - each * (count - 1) : each;
        out.push({
            name: count === 1 ? 'whole cue' : `part ${i + 1} of ${count}`,
            direction: str(direction),
            duration_ms: Math.max(SECTION_MIN_MS, ms),
            negative: '',
        });
    }
    return out;
}

/**
 * The cue's plan, in NEUTRAL form.
 *
 * Deliberately not a provider body. ElevenLabs takes two different shapes for
 * the same idea and WHICH ONE depends on the model — music_v1 wants
 * `sections`, music_v2 wants `chunks` — and that is a fact about the adapter,
 * exactly like promptLimit and referenceMode. Emitting one of them here would
 * put a provider's model contract in the middle of the cue library and would
 * be wrong for any other generator.
 *
 * Globals come from the SAME parts the plain prompt is built from — the builder
 * already joins them with ', ', so they are a list that happens to be printed
 * as a sentence. Re-splitting the finished prompt, or writing a second list
 * beside it, is how the sectioned cue and the plain one come to describe
 * different films.
 */
function compositionPlan(globalParts, sections, negativeGlobal) {
    const positive = (Array.isArray(globalParts) ? globalParts : styleList(globalParts))
        .map(p => str(p)).filter(Boolean);
    return {
        positive_global_styles: positive,
        negative_global_styles: styleList(negativeGlobal),
        sections: (sections || []).map(s => ({
            section_name: str(s.name) || 'section',
            direction: str(s.direction),
            positive_local_styles: styleList(s.direction),
            negative_local_styles: styleList(s.negative),
            duration_ms: Math.max(SECTION_MIN_MS, Math.min(SECTION_MAX_MS, Math.round(Number(s.duration_ms) || 0))),
        })),
    };
}

/** How the sections a director wrote line up against the cut they play over. */
function sectionFit(sections, cutMs) {
    const total = (sections || []).reduce((sum, s) => sum + (Number(s.duration_ms) || 0), 0);
    const cut = Number(cutMs) || 0;
    if (!total || !cut) return { total_ms: total, cut_ms: cut, difference_ms: 0, note: null };
    const diff = total - cut;
    return {
        total_ms: total,
        cut_ms: cut,
        difference_ms: diff,
        // Reported, never corrected: a cue that stops eight seconds before the
        // scene does is a decision, and padding it would overrule one.
        note: Math.abs(diff) < 1000 ? null
            : (diff > 0
                ? `the cue runs ${(diff / 1000).toFixed(1)}s past the end of the cut`
                : `the cue stops ${(-diff / 1000).toFixed(1)}s before the end of the cut`),
    };
}

module.exports = {
    SECTION_MIN_MS, SECTION_MAX_MS, CUE_MAX_MS, MAX_SECTIONS,
    styleList, validateSections, splitToFit, compositionPlan, sectionFit,
};
