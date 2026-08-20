/**
 * What a generated artefact was made from.
 *
 * Nothing in the pipeline recorded its inputs, so editing a character's
 * appearance, a location description, a style preset or a scene card left every
 * frame already generated from the old version looking valid forever. The only
 * signal was a director noticing. That is affordable at eight shots and
 * impossible at fifteen hundred, and it already cost us once: a character plate
 * generated in a stock clip-art style survived the fix to the builder that
 * produced it by fourteen hours, because it was cached and nothing knew it was
 * out of date.
 *
 * THE PAYLOAD IS THE FINGERPRINT. Every generated artefact already has exactly
 * one honest description of what it will be — the payload the provider would
 * receive, built by the single construction path in capability-payloads.js. If
 * that payload changes, the output would change; if it does not, it would not.
 * Hashing it means there is no second enumeration of "the inputs" to drift away
 * from the first, which is the failure mode a hand-written input list has.
 *
 * Two kinds cannot use their payload and say so explicitly: lipsync and post
 * build from artefacts that may not exist yet, so their payload builder throws
 * a PRECONDITION rather than describing anything. They fingerprint their
 * DEPENDENCIES instead — which is the correct semantics anyway, since a
 * lip-synced clip is stale exactly when its video or its dialogue is.
 *
 * Pure except for reads. No writes, no network, so a fingerprint can be
 * recomputed anywhere, including inside a gate that must not have side effects.
 */

const crypto = require('crypto');

/** Stable JSON: key order must not change a hash. */
function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort()
        .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function hash(value) {
    return crypto.createHash('sha256').update(canonical(value)).digest('hex').slice(0, 32);
}

function database() { return require('../db/database').db; }

/**
 * The 12 generated artefact kinds.
 *
 * `capability` ties a kind to the orchestrated step that produces it, so the
 * registry can be checked against STEP_CAPABILITY rather than trusted. Kinds
 * without one are not orchestrated: plates are generated on request, and the
 * scene card is written by the breakdown.
 */
const ARTEFACT_KINDS = {
    keyframe:        { capability: 'image',   scope: 'shot' },
    video:           { capability: 'video',   scope: 'shot' },
    voice:           { capability: 'voice',   scope: 'shot' },
    lipsync:         { capability: 'lipsync', scope: 'shot' },
    music:           { capability: 'music',   scope: 'scene' },
    sfx:             { capability: 'sfx',     scope: 'shot' },
    ambient:         { capability: 'ambient', scope: 'scene' },
    post:            { capability: 'post',    scope: 'shot' },
    character_plate: { capability: null,      scope: 'character' },
    location_plate:  { capability: null,      scope: 'location' },
    prop_plate:      { capability: null,      scope: 'prop' },
    scene_card:      { capability: null,      scope: 'shot' },
};

// Dependencies are DERIVED, never written here. The first version of this file
// hand-declared them and was wrong within a day: video takes the keyframe as
// its init_image and the list said it had no inputs at all, so a clip built on
// a stale frame would have passed any gate. PIPELINE_STEPS is the orchestrator's
// own graph; there is no second one.
for (const step of require('./pipeline-engine').PIPELINE_STEPS) {
    if (ARTEFACT_KINDS[step.id]) ARTEFACT_KINDS[step.id].dependsOn = step.depends.slice();
}

/**
 * Which of this kind's inputs are no longer what they were generated from.
 *
 * Returns [] when nothing is stale AND when nothing was ever stamped — an
 * unstamped project is outside the workflow, not suspect. That is what lets
 * this be wired into generation without changing behaviour for anyone who has
 * not opted in by generating since the feature landed.
 *
 * Reads only. A gate that mutates is a gate you cannot run twice.
 */
function staleInputs(kind, ids) {
    const spec = ARTEFACT_KINDS[kind];
    if (!spec || !(spec.dependsOn || []).length) return [];
    const db = database();
    const stale = [];

    for (const dep of spec.dependsOn) {
        const rows = db.prepare(
            `SELECT id, input_fingerprint, artefact_kind, file_name FROM film_assets
              WHERE artefact_kind = ? AND shot_id = ? AND input_fingerprint IS NOT NULL`)
            .all(dep, ids.shotId || null);
        if (!rows.length) continue;   // never stamped: not our business

        let current = null;
        try { current = fingerprintFor(dep, ids); } catch (_) { current = null; }
        for (const row of rows) {
            if (current === null) {
                stale.push({ kind: dep, asset_id: row.id, reason: 'its own inputs could not be read' });
            } else if (isStale(row, current)) {
                stale.push({ kind: dep, asset_id: row.id, file_name: row.file_name,
                    reason: 'changed since it was generated' });
            }
        }
    }
    return stale;
}

/** The payload a capability would send, or null when it cannot be built yet. */
function payloadFor(capability, shotId) {
    const { loadShotContext, buildCapabilityPayload } = require('./capability-payloads');
    const ctx = loadShotContext(shotId);
    if (!ctx) return null;
    try {
        const built = buildCapabilityPayload(capability, ctx);
        return built && built.payload !== undefined ? built.payload : built;
    } catch (err) {
        // A missing upstream artefact means "not ready", not "no inputs". The
        // caller falls back to dependency fingerprints.
        if (err && err.code === 'PRECONDITION') return null;
        throw err;
    }
}

/**
 * The fingerprint of one artefact kind for one subject.
 *
 * `ids` carries whichever identifier the kind's scope needs — shotId for a
 * shot-scoped kind, charId/locId/propId for a plate. Passing the whole bag is
 * deliberate: callers rarely know which one a kind wants, and requiring them to
 * is how the wrong id gets passed silently.
 */
function fingerprintFor(kind, ids) {
    const spec = ARTEFACT_KINDS[kind];
    if (!spec) throw new Error(`artefact-fingerprint: unknown kind '${kind}'`);
    const db = database();

    if (kind === 'scene_card') {
        const shot = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(ids.shotId);
        if (!shot) return null;
        let card = {};
        try { card = JSON.parse(shot.scene_card_yaml || '{}'); } catch (_) { card = {}; }
        return hash({ kind, card });
    }

    if (kind === 'character_plate') {
        const { buildRefSheetPrompt } = require('../routes/characters');
        const ch = db.prepare('SELECT * FROM film_characters WHERE id = ?').get(ids.charId);
        if (!ch) return null;
        const style = projectStyle(db, ch.project_id);
        // All three views, because a sheet is the set of them: regenerating one
        // view against a changed description must not leave the others looking
        // current.
        return hash({ kind, views: ['front', 'side', 'back'].map(v => buildRefSheetPrompt(ch, v, style)) });
    }

    if (kind === 'location_plate' || kind === 'prop_plate') {
        const { buildPlatePrompt } = require('./reference-plates');
        const isLoc = kind === 'location_plate';
        const row = isLoc
            ? db.prepare('SELECT * FROM film_locations WHERE id = ?').get(ids.locId)
            : db.prepare('SELECT * FROM film_props WHERE id = ?').get(ids.propId);
        if (!row) return null;
        return hash({ kind, prompt: buildPlatePrompt(isLoc ? 'location' : 'prop', row, projectStyle(db, row.project_id)) });
    }

    // Orchestrated capabilities.
    const payload = payloadFor(spec.capability, ids.shotId);
    if (payload !== null) return hash({ kind, payload });

    // Payload unavailable (lipsync/post before their inputs exist). Fall back to
    // what this kind is derived FROM, which is the propagation rule anyway.
    const deps = (spec.dependsOn || []).map(d => ({ d, f: fingerprintFor(d, ids) }));
    const card = db.prepare('SELECT scene_card_yaml FROM film_shots WHERE id = ?').get(ids.shotId);
    return hash({ kind, deps, card: card ? card.scene_card_yaml : null });
}

function projectStyle(db, projectId) {
    const p = db.prepare('SELECT style_preset FROM film_projects WHERE id = ?').get(projectId);
    return (p && p.style_preset) || null;
}

/**
 * Is this artefact out of date?
 *
 * An artefact with no recorded fingerprint is NOT stale — it predates the
 * feature and is outside the workflow. Treating an absent fingerprint as stale
 * would retroactively invalidate every asset in every existing project, which
 * is both wrong and the fastest way to get staleness switched off.
 */
function isStale(artefact, currentFingerprint) {
    const recorded = artefact && artefact.input_fingerprint;
    if (!recorded) return false;
    if (!currentFingerprint) return false;
    return recorded !== currentFingerprint;
}

/**
 * Stamp an asset with the fingerprint of what produced it.
 *
 * Called at persist time, beside the INSERT rather than inside it, so a
 * generator that saves an asset and fails to stamp it is a visible omission in
 * the route rather than a silent NULL. Never throws: a fingerprint that cannot
 * be computed must not fail a generation that already succeeded and cost money.
 * It records nothing instead, which reads as "outside the workflow" — the same
 * state as an asset that predates the feature.
 */
function stampAsset(assetId, kind, ids) {
    if (!assetId || !ARTEFACT_KINDS[kind]) return null;
    let fingerprint = null;
    try { fingerprint = fingerprintFor(kind, ids || {}); } catch (_) { return null; }
    if (!fingerprint) return null;
    try {
        database().prepare(
            `UPDATE film_assets SET input_fingerprint = ?, artefact_kind = ?, fingerprinted_at = datetime('now')
              WHERE id = ?`).run(fingerprint, kind, assetId);
    } catch (_) { return null; }
    return fingerprint;
}

/**
 * Bless an artefact as still correct for its current inputs.
 *
 * Staleness had exactly one remedy: regenerate. But "the inputs changed" is not
 * the same as "the output is now wrong" — a description can be rewritten in
 * ways a good plate still satisfies, and regenerating then spends money to
 * replace something the director already chose. Worse, generation is not
 * deterministic, so "just regenerate it" is a coin flip against an image they
 * liked.
 *
 * Re-stamping is the honest record of what happened: a human looked at this
 * output beside those inputs and said it still holds. It never touches the
 * file — accepting is a statement about the artefact, not a new one.
 */
function acceptAsCurrent(assetId, kind, ids) {
    return stampAsset(assetId, kind, ids);
}

module.exports = { ARTEFACT_KINDS, fingerprintFor, isStale, staleInputs, stampAsset, acceptAsCurrent, hash, canonical };
