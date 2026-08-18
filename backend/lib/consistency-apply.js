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
 * Merge a shot's consistency context into an image payload: prompt/negative
 * additions, the locked seed, and reference images (promoting the first to the
 * IP-Adapter slot when nothing else claimed it).
 */
function applyConsistencyToImagePayload(payload, context) {
    const p = { ...(payload || {}) };
    const ctx = context || {};
    if (ctx.prompt_additions && ctx.prompt_additions.length) {
        p.prompt = [p.prompt, ...ctx.prompt_additions].filter(Boolean).join(', ');
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

module.exports = {
    normalizeName,
    shouldUseLockedSeed,
    applyConsistencyToImagePayload,
    applyConsistencyToVoicePayload,
};
