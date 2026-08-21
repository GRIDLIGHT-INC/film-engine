/**
 * Reference plates for locations and props.
 *
 * Characters got a reference sheet generator early; locations and props never
 * did. The consequence was not cosmetic: lib/reference-images.js has ranked
 * `location` and `prop` as referenceable kinds since it was written, so the
 * selector was ready to attach plates that nothing could produce. Continuity
 * stopped at the actor — the street fell back to prose in every shot, which is
 * both weaker (an image IS the architecture) and expensive (prose competes for
 * a ~1000-character prompt ceiling).
 *
 * One implementation for both kinds. They differ only in prompt framing and
 * which film_assets column links the result, and duplicating a generator per
 * subject type is how the character path ended up with a moderation fallback
 * and a style fix the others would not have inherited.
 *
 * Characters keep their own route because they need a THREE-VIEW turnaround
 * (front/side/back) for identity; a location has no side view. The shared parts
 * — style handling, the moderation retry, persistence, registration — live
 * here so a fix lands once.
 */

const { db, generateId } = require('../db/database');
const { persistProviderMedia } = require('./provider-media');
const { getFileUrl, ensureDir } = require('./file-storage');

/** Where a plate for each kind is stored and how it is linked. */
const PLATE_KINDS = {
    location: {
        table: 'film_locations',
        fkColumn: 'location_id',
        subdir: 'refsheets',
        assetType: 'reference_image',
        // An establishing plate, deliberately empty of people: the plate defines
        // the PLACE, and a figure in it would be re-described by every shot that
        // references it and fight the shot's own blocking.
        framing: 'establishing wide shot of the location, no people, no characters, eye level, natural perspective',
    },
    prop: {
        table: 'film_props',
        fkColumn: 'prop_id',
        subdir: 'refsheets',
        assetType: 'reference_image',
        framing: 'single object product shot, centred, plain seamless background, no people',
    },
};

/**
 * The prompt for a plate.
 *
 * Mirrors buildRefSheetPrompt's shape deliberately: description first, then
 * framing, then the project look. `stylePreset` is applied when present and
 * dropped by the caller on a moderation refusal — see generatePlate.
 */
function buildPlatePrompt(kind, subject, stylePreset) {
    const spec = PLATE_KINDS[kind];
    if (!spec) throw new Error(`reference-plates: unknown kind '${kind}'`);

    // Same ordering rule as the character sheet: the look decides the medium,
    // so it leads. "location reference plate, wide establishing" trailing a
    // style meant the plate's kind was settled before the film's look was
    // mentioned — survivable for a street, fatal for a person.
    const style = stylePreset && String(stylePreset).trim();
    const parts = [
        // "reference plate" reads as a document to an image model the same way
        // "reference sheet" does. Ask for the photograph itself.
        style ? `${style}. Photograph of the ${kind}` : `photoreal cinematic photograph of the ${kind}`,
        spec.framing,
    ];

    if (subject.name) parts.push(String(subject.name).toLowerCase());
    // visual_prompt is the generation-facing field for a prop — it is what
    // prop_create documents as "what reaches the image prompt" — and the plate
    // builder only ever read `description`, so the one field written for
    // generation never reached the plate generated from it.
    if (subject.visual_prompt) parts.push(subject.visual_prompt);
    if (subject.description) parts.push(subject.description);

    // Locations carry their lighting on the row; a plate that ignores it would
    // anchor the wrong time of day for every shot set there.
    if (kind === 'location') {
        if (subject.lighting_default) parts.push(subject.lighting_default);
        if (subject.time_of_day_default) parts.push(subject.time_of_day_default);
    }
    if (kind === 'prop' && subject.category) parts.push(subject.category);

    // How big the thing is, on the plate that establishes it.
    //
    // This reached the KEYFRAME prompt and never the plate, which is backwards.
    // A plate is a close-up filling its own frame, and conditioning transfers
    // appearance rather than scale — so the model reproduces what it was shown,
    // and a thirty-centimetre sprinkler plated at full-frame came back the size
    // of the car beside it. Fixing it downstream means arguing with the plate
    // in every shot the subject appears in; fixing it here fixes it once.
    //
    // No frame fraction: a plate has no lens, no distance and no other subject
    // to be a fraction OF. What applies is the anchor and the plain measure,
    // which is what scalePhrase falls back to when no coverage is passed.
    // Undeclared dimensions say nothing at all rather than guessing.
    try {
        const { scalePhrase } = require('./subject-scale');
        const note = scalePhrase(subject.name || kind, kind === 'location' ? 'prop' : kind, subject, null);
        if (note) parts.push(note);
    } catch (_) { /* a subject with no declared size plates exactly as before */ }

    return parts.filter(Boolean).join(', ');
}

// A plate is a photograph of a subject, not a page about it. "text, watermark"
// was too narrow: what actually appeared on the first real plate was captions,
// a colour-swatch chart and handwriting, none of which those two words cover.
const NEGATIVE = 'blurry, low quality, distorted, multiple angles, collage, '
    + 'text, label, labels, annotation, annotations, caption, handwriting, chart, colour chart, '
    + 'swatch, swatches, watermark, logo, arrows, callouts, measurement marks';

/**
 * Generate, store and register one plate.
 *
 * Returns { ok, asset_id, file_name, image_url, style_applied, error }.
 *
 * `style_applied` is reported rather than assumed: a look written for the FILM
 * can be refused when it lands beside a literal subject description, and a
 * plate generated without the style is still worth having — but a director who
 * is told nothing will believe their look is anchored when it is not.
 */
async function generatePlate({ projectId, kind, subject, stylePreset, provider, aspectRatio, timeout }) {
    const spec = PLATE_KINDS[kind];
    if (!spec) return { ok: false, error: `unknown plate kind '${kind}'` };
    if (!subject || !subject.id) return { ok: false, error: `${kind} not found` };
    if (!provider || typeof provider.generate !== 'function') {
        return { ok: false, error: 'no image provider resolved' };
    }

    let styleApplied = !!(stylePreset && String(stylePreset).trim());
    const basePayload = {
        negative_prompt: NEGATIVE,
        aspect_ratio: aspectRatio || undefined,
    };

    let result = await provider.generate('image', {
        ...basePayload,
        prompt: buildPlatePrompt(kind, subject, stylePreset),
    }, { timeout: timeout || 300000 });

    // Same refusal path as character sheets: retry once without the style
    // rather than losing the plate entirely.
    if (!result.ok && styleApplied && /moderation/i.test(String(result.error || ''))) {
        result = await provider.generate('image', {
            ...basePayload,
            prompt: buildPlatePrompt(kind, subject, null),
        }, { timeout: timeout || 300000 });
        if (result.ok) styleApplied = false;
    }

    if (!result.ok) return { ok: false, error: result.error, style_applied: styleApplied };

    ensureDir(projectId, spec.subdir);
    const safeName = String(subject.name || kind).replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${kind}_${safeName}.png`;

    let filePath;
    try {
        filePath = await persistProviderMedia(projectId, spec.subdir, fileName, result.data, { serveDir: 'images' });
    } catch (err) {
        return { ok: false, error: `plate generated but could not be stored: ${err.message}`, style_applied: styleApplied };
    }

    // Replace rather than accumulate: a plate is the current canonical
    // reference for its subject, and leaving stale ones behind would let the
    // gather query pick an older look at random.
    db.prepare(`DELETE FROM film_assets
                WHERE project_id = ? AND ${spec.fkColumn} = ? AND asset_type = ?`)
        .run(projectId, subject.id, spec.assetType);

    const assetId = generateId();
    db.prepare(
        `INSERT INTO film_assets (id, project_id, ${spec.fkColumn}, asset_type, file_path, file_name,
            format, mime_type, version, metadata, provider, provider_model)
         VALUES (?, ?, ?, ?, ?, ?, 'png', 'image/png', 1, ?, ?, ?)`
    ).run(assetId, projectId, subject.id, spec.assetType,
        typeof filePath === 'string' ? filePath : (filePath && filePath.path) || '',
        fileName,
        JSON.stringify({ kind: `${kind}_plate`, style_applied: styleApplied }),
        result.provider || provider.id || null,
        result.provider_model || null);

    // A plate defines a subject's medium for every frame that references it,
    // which is exactly why a stale one is so damaging: the clip-art character
    // plate poisoned every shot it appeared in and nothing knew.
    require('./artefact-fingerprint').stampAsset(assetId, `${kind}_plate`,
        kind === 'location' ? { locId: subject.id } : { propId: subject.id });

    return {
        ok: true,
        asset_id: assetId,
        file_name: fileName,
        image_url: getFileUrl(spec.subdir, projectId, fileName),
        style_applied: styleApplied,
    };
}

module.exports = { PLATE_KINDS, buildPlatePrompt, generatePlate, NEGATIVE };
