/**
 * Pure consistency application — payload in, payload out.
 *
 * These four functions were part of consistency-context.js, which requires
 * db/database at module scope because most of that module reads profiles and
 * assets. Applying an already-built consistency context to an already-built
 * payload needs no database at all, so keeping them there meant that anything
 * wanting to shape a payload had to open a database to do it — including
 * capability-payloads.js, whose whole point is to be callable without one.
 *
 * Split out rather than duplicated: consistency-context.js re-exports these, so
 * there is still exactly one definition and every existing import keeps working.
 *
 * Same lib/-holds-the-pure-logic split as pipeline-engine.js vs routes/pipeline.js.
 */

/** Upper-cased, trimmed name — the key consistency profiles are indexed by. */
function normalizeName(value) {
    return String(value || '').trim().toUpperCase();
}

/**
 * True when the caller expressed no seed preference, so a locked seed may be
 * substituted. An explicit seed always wins over the lock.
 */
function shouldUseLockedSeed(seed) {
    return seed === undefined || seed === null || seed === '' || seed === -1 || seed === '-1';
}

/**
 * What a locked subject contributes to a prompt, in what order, within budget.
 *
 * This is a SAFETY NET, not the plan. Whoever composes a prompt — an agent with
 * the shot in front of it — should decide what matters about a subject in this
 * frame, because a machine cutting a description at a comma cannot know that
 * "one wheel trim missing" is worth more than "bench seats in cracked tan
 * vinyl". But something has to hold the ceiling when nobody is composing: the
 * app's own Regen button, a batch run, the orchestrator.
 *
 * These used to be appended verbatim AFTER buildStoryboardPrompt had assembled
 * the prompt against the provider's ceiling, so the trimmer never saw the
 * largest contributor to its own output. On a real establishing shot the base
 * came to ~1,500 characters and three locked profiles added 3,445 more, for
 * 4,946 against a 4,000 ceiling. Three things went wrong at once and every one
 * of them looked like the model misbehaving:
 *
 *  - the ceiling was exceeded, so the provider truncated the TAIL, and the tail
 *    was the location — which is why the street stopped looking like the street;
 *  - a 653-character description of a lawn sprinkler sat FIRST, right after the
 *    quality tags, so the model read it as a primary subject and drew it the
 *    size of the car parked beside it;
 *  - the style preset, ahead of all of it, was outweighed three to one by object
 *    prose, and the look went with it.
 *
 * Ordering is the cheap half of the fix and costs nothing. A frame is OF a place
 * and its people; props are things in it. ADDITION_RANK mirrors the reference
 * selector's KIND_RANK for the same reason it exists there: with limited room,
 * identity and place outrank objects, because a viewer notices a different
 * street long before a different sprinkler.
 */
const ADDITION_RANK = { character: 0, location: 1, prop: 2, style: 3, voice: 9 };

/**
 * A subject whose picture is attached needs NAMING, not describing.
 *
 * Every one of the three subjects contributing prose to a real establishing
 * shot also had its plate attached as a reference image — 3,445 characters
 * spent describing pictures the model was already looking at. That is not
 * merely wasteful: it is what pushed the prompt past the ceiling, buried the
 * style preset, and gave a lawn sprinkler the same descriptive weight as the
 * street it sits in, so it was drawn the size of the car.
 *
 * The prose exists for the case the reference system cannot cover — a provider
 * taking an untagged array of images with nothing to say which is which, and a
 * subject with no plate at all. Both still get their full description. What
 * changes is that a plated subject contributes an identifier: its name and the
 * clause that says what it is, so the words and the picture bind to each other
 * and the rest of the room goes to the shot.
 */
const IDENTIFIER_CHARS = 120;

function identify(item) {
    const text = String(item.text || '').trim();
    const stop = text.search(/[.;]\s/);
    let head = (stop > 0 ? text.slice(0, stop) : text).trim();
    if (head.length > IDENTIFIER_CHARS) head = trimContract(head, IDENTIFIER_CHARS);
    const name = String(item.subject_name || '').trim();
    // Named, so an untagged reference array still has something to bind to.
    return name && !head.toLowerCase().startsWith(name.toLowerCase())
        ? `${name}: ${head}`
        : head;
}

/** Whether this subject's own picture is travelling with the prompt. */
function hasReference(ctx, item) {
    // Two shapes reach here: a consistency reference ({subject_name,
    // profile_type}) and a gathered plate ({name, kind}).
    return (ctx.references || []).some(r => r
        && String(r.subject_name || r.name || '').toLowerCase() === String(item.subject_name || '').toLowerCase()
        && String(r.profile_type || r.kind || '') === String(item.profile_type || ''));
}

/** Cut at a clause boundary; a description's opening is what the thing IS. */
function trimContract(text, budget) {
    const t = String(text || '');
    if (t.length <= budget) return t;
    const cut = t.slice(0, budget);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf(', '));
    return (stop > budget * 0.4 ? cut.slice(0, stop) : cut).trim();
}

/**
 * Fit the additions into what is left of the ceiling.
 *
 * The base prompt is the shot itself — action, camera, look — and is never cut
 * to make room for a description of an object in it.
 */
function fitAdditions(basePrompt, ctx, opts) {
    const items = Array.isArray(ctx.prompt_addition_items) && ctx.prompt_addition_items.length
        ? ctx.prompt_addition_items.slice()
        : (ctx.prompt_additions || []).map(text => ({ text, profile_type: 'prop', subject_name: '' }));

    items.sort((a, b) => (ADDITION_RANK[a.profile_type] ?? 5) - (ADDITION_RANK[b.profile_type] ?? 5));

    /*
     * A SUBJECT WHOSE PICTURE IS ATTACHED IS NOT DESCRIBED.
     *
     * "Descriptions of the items sent as a picture shouldn't be there, polluting
     * and potentially changing the final board shot." The picture is the
     * description, and the prompt's reference key names it ("Reference 2:
     * character MANNY"). Prose about it competed with the picture and, for a
     * location, carried the text written to generate the EMPTY set plate
     * ("no people, no bottle, the tabletop completely bare") into a shot with
     * a man and a bottle in it.
     *
     * Decided against what is ACTUALLY attached (the references passed in), so
     * a subject whose picture did not make the cut keeps its words: travelling
     * with neither is the failure a previous version of this rule caused.
     */
    for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].subject_name && hasReference(ctx, items[i])) items.splice(i, 1);
    }

    /*
     * ADDITION_RANK orders by KIND — identity before place before objects —
     * which is the right tiebreak and is not the same question as "what is this
     * shot of". It cannot tell the protagonist from a parked car, because both
     * are subjects; on a real frame that left the SEDAN's 1936-character
     * contract outweighing MAYA's 817.
     *
     * While the ceiling was 4000 the trimmer hid it: the sedan was cut to 210
     * and priority appeared to work. Raising the ceiling removed the pressure
     * and with it the only thing enforcing order — so the ranking has to be
     * explicit now that nothing is accidentally doing it.
     *
     * rankContributions is derived from DECLARED data — the framing subject,
     * then what the card puts in shot, then merely-locked incidentals — never
     * from a type hierarchy and never from first textual mention, because a car
     * can be a hero object and prose routinely opens on geography.
     */
    const shot = (opts && opts.shot) || null;
    if (shot) {
        // Required here rather than at module scope: storyboard-prompt is the
        // heavier module and a top-level import risks a cycle through it.
        const { trimToAllowance, rankContributions } = require('./storyboard-prompt');
        const ranked = rankContributions(
            items.map(i => ({ subject: i.subject_name, kind: i.profile_type,
                chars: String(i.text || '').length, __item: i })), shot);
        items.length = 0;
        for (const r of ranked) {
            const item = r.__item;
            // A capped contribution is cut at a clause boundary, never to a
            // character count — that is the mid-clause amputation this work
            // exists to remove.
            items.push(r.chars < String(item.text || '').length
                ? { ...item, text: trimToAllowance(item.text, r.chars) }
                : item);
        }
    }

    /*
     * (A subject whose picture IS attached was removed above. This was once
     * "not shortened because a plate is attached", reverted because the
     * decision was made against the profiles rather than the pictures really
     * in the payload; it is now made against the pictures.)
     *
     * The history of that revert: a plate shows what
     * a subject looks like, so describing it again is redundant — and it was
     * wrong in practice for one reason: the picture does not always arrive. A
     * provider takes three references and a shot can want five; one generation
     * path was attaching none at all. Every time the picture was missing, the
     * shortened subject travelled with neither words nor image, and the model
     * built whatever was still described at length. A redundant description
     * costs room. A missing one costs the shot.
     *
     * SHORTENED because the ANCHOR shows it, which is a different bet.
     *
     * A plate may or may not win one of three slots. The anchor ranks 0, so it
     * is attached whenever there is an anchor at all — and it does not show the
     * subject in the abstract, it shows it in this scene, in position, at the
     * right scale, lit the way the scene is lit. Re-describing that is not
     * redundancy against a maybe; it is redundancy against the most specific
     * picture in the payload.
     *
     * It cost the whole budget once. A real 1B anchored on 1A sent 3,990
     * characters against a 4,000 ceiling, of which 2,517 described the
     * cul-de-sac, the sprinkler and the sedan — all three plainly visible in
     * the attached frame — so the shot's own action line and the anamorphic
     * look were competing for the 1,473 that were left.
     *
     * The subject keeps its NAME. Shortening to nothing is the failure the
     * revert was about; shortening to "the SEDAN, as in the reference image"
     * still tells the model which thing is meant and which picture answers it.
     */
    const covered = new Set(((opts && opts.anchorCovers) || []).map(n => String(n || '').toUpperCase()));
    const sized = covered.size
        ? items.map(i => (covered.has(String(i.subject_name || '').toUpperCase())
            ? { ...i, text: identify(i), shortened: true }
            : i))
        : items;

    const ceiling = Number(opts && opts.maxPromptChars) > 0 ? Number(opts.maxPromptChars) : 0;
    if (!ceiling) return sized.map(i => i.text);

    let room = ceiling - String(basePrompt || '').length - 2;
    if (room <= 0) return [];

    const out = [];
    for (let i = 0; i < sized.length; i++) {
        // An even split of what is LEFT, so the last subject is not the one
        // that vanishes, and anything a subject does not use is inherited by
        // the ones after it rather than wasted.
        const share = Math.floor(room / (sized.length - i)) - 2;
        if (share <= 40) break;              // too little room to say anything true
        const text = trimContract(sized[i].text, share);
        if (!text) continue;
        out.push(text);
        room -= text.length + 2;
    }
    return out;
}

/**
 * Merge a shot's consistency context into an image payload: prompt/negative
 * additions, the locked seed, and reference images (promoting the first to the
 * IP-Adapter slot when nothing else claimed it).
 */
function applyConsistencyToImagePayload(payload, context, opts) {
    const p = { ...(payload || {}) };
    const ctx = context || {};

    /*
     * Which pictures are ACTUALLY going, decided before the prompt is written.
     *
     * A provider takes three references; a shot can want five. On the film's
     * two biggest frames the card names MAYA, the DRAGON, the sedan and the
     * sewer plate, plus the street — so two of those five subjects travel as
     * words alone, and WHICH two is decided by the selector, not by the card.
     *
     * Shortening a subject to an identifier is only right when its picture is
     * in the payload. Deciding that against the profiles available rather than
     * the references attached would drop the sedan's description on a frame
     * whose sedan reference had just been cut for room — which is exactly the
     * failure that turned an establishing shot into a product shot, repeated on
     * the shots that can least afford it.
     */
    const attached = (Array.isArray(p.reference_images) && p.reference_images.length)
        ? p.reference_images
        : (ctx.references || []);

    // A composed prompt is the whole prompt. Appending subject contracts to it
    // turned a deliberate 1,573-character composition into 5,024 characters
    // against a 4,000 ceiling — and since a provider truncates the tail, what
    // survived was precisely the material the composer had chosen to leave out.
    if (!(opts && opts.promptIsFinal) && ctx.prompt_additions && ctx.prompt_additions.length) {
        const forPrompt = { ...ctx, references: attached };
        p.prompt = [p.prompt, ...fitAdditions(p.prompt, forPrompt, opts)].filter(Boolean).join(', ');
    }
    if (ctx.negative_additions && ctx.negative_additions.length) {
        p.negative_prompt = [p.negative_prompt, ...ctx.negative_additions].filter(Boolean).join(', ');
    }
    if (shouldUseLockedSeed(p.seed) && ctx.locked_seed !== null && ctx.locked_seed !== undefined) p.seed = ctx.locked_seed;
    if (ctx.references && ctx.references.length) {
        // Do not clobber references the caller already attached. The storyboard
        // route selects TAGGED plates per shot and emits matching @tags in the
        // prompt; replacing them here would leave those tags referring to
        // nothing, which is strictly worse than having used prose.
        if (!Array.isArray(p.reference_images) || p.reference_images.length === 0) {
            p.reference_images = ctx.references;
        }
        p.input_refs = ctx.input_refs || [];
        if (!p.ip_adapter_image) {
            const primary = ctx.references[0];
            p.ip_adapter_image = primary.file_path || primary.file_name || null;
            p.ip_adapter_weight = primary.weight || 0.7;
        }
    }
    return p;
}

/**
 * Merge a character's locked voice profile into a voice payload.
 *
 * Voice consistency is indexed by character, not carried as references or a
 * seed: identity for speech is a voice id and its settings. A context with no
 * entry for this character is a no-op, which is why every capability can be
 * handed the same context object.
 */
function applyConsistencyToVoicePayload(payload, context, characterName) {
    const p = { ...(payload || {}) };
    const key = normalizeName(characterName || p.character_name);
    const voice = context && context.voice && context.voice.by_character && context.voice.by_character[key];
    if (!voice) return p;
    if (voice.voice_id) p.voice_id = voice.voice_id;
    if (voice.provider_model && !p.model) p.model = voice.provider_model;
    if (voice.settings) {
        if (voice.settings.language) p.language = voice.settings.language;
        if (voice.settings.speed) p.speed = voice.settings.speed;
        if (voice.settings.stability) p.stability = voice.settings.stability;
        if (voice.settings.similarity_boost) p.similarity_boost = voice.settings.similarity_boost;
    }
    p.consistency_profile_id = voice.profile_id;
    return p;
}

module.exports = {    fitAdditions,
    ADDITION_RANK,
    identify,
    hasReference,
    fitAdditions,
    ADDITION_RANK,
    normalizeName,
    applyConsistencyToImagePayload,
    applyConsistencyToVoicePayload,};
