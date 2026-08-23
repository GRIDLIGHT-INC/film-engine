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
        /*
         * DEFAULT framing — what to photograph when nobody said. A view
         * replaces it, because a view IS a framing.
         */
        framing: 'establishing wide shot of the location, eye level, natural perspective',
        /*
         * INVARIANTS — what makes this a plate rather than a shot. These survive
         * any view.
         *
         * A plate defines the PLACE, and a figure in it would be re-described by
         * every shot that references it and fight that shot's own blocking. So
         * "no people" is not a framing choice, it is the thing that makes the
         * reference reusable.
         */
        constraints: ['no people', 'no characters'],
    },
    prop: {
        table: 'film_props',
        fkColumn: 'prop_id',
        subdir: 'refsheets',
        assetType: 'reference_image',
        framing: 'single object product shot, centred',
        // A prop plate must isolate its subject: a plain ground and nobody
        // holding it, or the plate carries a room and a hand into every frame
        // that references the object.
        constraints: ['plain seamless background', 'no people'],
    },
};

/**
 * The prompt for a plate.
 *
 * Mirrors buildRefSheetPrompt's shape deliberately: description first, then
 * framing, then the project look. `stylePreset` is applied when present and
 * dropped by the caller on a moderation refusal — see generatePlate.
 */
/**
 * @param {string} [view] - which view of the subject this plate is.
 * @param {boolean} [anchored] - a plate of the same subject is travelling as a
 *   reference, so this one must MATCH it rather than invent the place again.
 */
function buildPlatePrompt(kind, subject, stylePreset, view, anchored) {
    const spec = PLATE_KINDS[kind];
    if (!spec) throw new Error(`reference-plates: unknown kind '${kind}'`);

    // Same ordering rule as the character sheet: the look decides the medium,
    // so it leads. "location reference plate, wide establishing" trailing a
    // style meant the plate's kind was settled before the film's look was
    // mentioned — survivable for a street, fatal for a person.
    const style = stylePreset && String(stylePreset).trim();

    /*
     * When another view is travelling as a reference, the CAMERA MOVE leads.
     *
     * The first version trailed it behind "the same location as the reference
     * image", and the model reproduced the reference almost exactly: same
     * houses in the same places, same basketball hoop, same storm drain — a
     * regrade of the plate it was given rather than a new angle on the street.
     *
     * The shot anchor learned this already: "the same scene as this picture"
     * reads as "reproduce this picture" unless the change is stated first and
     * plainly. So the new position leads, what stays continuous follows, and
     * the negative refuses the old viewpoint outright.
     */
    const lead = (view && anchored)
        ? [`A DIFFERENT camera position in the same place as the reference image: `
           + `${String(view).trim()}. The camera has moved — this is a new angle on it, not the same `
           + 'photograph. Everything else is continuous: the same buildings, the same materials and '
           + 'colours, the same driveways and streetlights, the same ground and the same time of day']
        : [];

    /*
     * The view REPLACES the default framing; the invariants always survive.
     *
     * `framing` and `constraints` were one fused string, so the default framing
     * was appended to EVERY plate — including one asked for a specific view.
     * A request for "standing in the middle of the bulb looking at MAYA's
     * house" was told, in the same prompt, to produce an establishing wide of
     * the whole location, and did: the boilerplate outranked what was asked
     * for. A view IS a framing.
     *
     * Registry-driven rather than a `kind === 'location'` conditional, because
     * `prop` fuses the same two ideas and would rot the same way.
     */
    const framing = [view ? null : spec.framing, ...(spec.constraints || [])]
        .filter(Boolean).join(', ');

    const parts = [
        ...lead,
        // "reference plate" reads as a document to an image model the same way
        // "reference sheet" does. Ask for the photograph itself.
        style ? `${style}. Photograph of the ${kind}` : `photoreal cinematic photograph of the ${kind}`,
        framing,
    ];

    if (subject.name) parts.push(String(subject.name).toLowerCase());

    /*
     * Which view of the place this is, and — when another view is travelling as
     * a reference — that it must MATCH that one rather than invent the location
     * again.
     *
     * Generated independently, four views of a cul-de-sac produce four
     * different cul-de-sacs: the blue house on the right of one is not the blue
     * house you see when you turn. Anchoring each new view on an existing one
     * is what closes the set, and it is the same mechanism the shot anchor uses,
     * pointed at plates.
     */
    /*
     * The view is stated ONCE, and where depends on whether there is an anchor.
     *
     * Anchored, it is already the subject of the leading camera-change clause —
     * repeating it here as "photographed <view>" said the same thing twice, and
     * the second statement competes with the lead for exactly the instruction
     * the lead was placed first to win. Unanchored there is no move to describe,
     * so the view is simply what was photographed.
     */
    if (view && !anchored) {
        parts.push(`photographed ${String(view).trim()}`);
    }
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
/*
 * Refusing the reference's own viewpoint.
 *
 * A new view generated against an existing plate came back as that plate: the
 * positive said "different position" and the negative said nothing, so the
 * cheapest way to satisfy "same location" was to copy it. This is the mirror of
 * the shot anchor's negative, which refuses DIScontinuity — here the thing to
 * refuse is sameness of angle.
 */
const VIEW_NEGATIVE = 'same camera position, same viewpoint, identical framing, repeated composition, '
    + 'copy of the reference image, unchanged angle';

const NEGATIVE = 'blurry, low quality, distorted, multiple angles, collage, '
    + 'text, label, labels, annotation, annotations, caption, handwriting, chart, colour chart, '
    + 'swatch, swatches, watermark, logo, arrows, callouts, measurement marks';

/**
 * The board's look, as at most one tagged, inlined reference.
 *
 * `db` is passed rather than required, because this module is used from routes
 * that already hold a connection and from tests that must not open one. No
 * board, no database, or an unreadable image all mean the plate generates
 * exactly as it did before.
 */
function styleReferencesFor(db, projectId) {
    if (!db || !projectId) return [];
    try {
        const { styleReferences } = require('./look-development');
        const { selectReferences } = require('./reference-images');
        return selectReferences(styleReferences(db, projectId, 1), { limit: 1 });
    } catch (_) { return []; }
}


/**
 * The file a plate lives in, including which VIEW of the subject it is.
 *
 * Plates were named `location_<name>.png` — one file per subject — so
 * generating a second view of a place wrote over the first and the set could
 * never grow past one. A location has one plate looking into the cul-de-sac,
 * and every shot pointing the other way was handed a picture of what was behind
 * the camera.
 *
 * The default (no view) keeps EXACTLY its old name, or every project that
 * already has a plate loses it the moment this ships.
 */
function plateFileName(kind, subjectName, view) {
    const safe = String(subjectName || kind).replace(/[^a-zA-Z0-9_-]/g, '_');
    const v = String(view || '').trim();
    if (!v) return `${kind}_${safe}.png`;
    const safeView = v.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48).replace(/_+$/, '');
    return `${kind}_${safe}__${safeView}.png`;
}

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
async function generatePlate({ projectId, kind, subject, stylePreset, provider, aspectRatio, timeout, db,
    view, anchorPath }) {
    const spec = PLATE_KINDS[kind];
    if (!spec) return { ok: false, error: `unknown plate kind '${kind}'` };
    if (!subject || !subject.id) return { ok: false, error: `${kind} not found` };
    if (!provider || typeof provider.generate !== 'function') {
        return { ok: false, error: 'no image provider resolved' };
    }

    let styleApplied = !!(stylePreset && String(stylePreset).trim());

    /*
     * The look board, as a PICTURE and not only as words.
     *
     * The board has composed into `style_preset` since it was built, and its
     * pinned images reached storyboard frames — but never the plates. That is
     * the wrong way round: a plate conditions every frame its subject appears
     * in, so a plate generated outside the film's look drags every one of those
     * frames with it, and the look has to be re-argued in each. Fixing it here
     * fixes it once.
     *
     * ONE image, not three. A plate has exactly one subject and the board is
     * there for its grade and palette; two or three look plates start voting on
     * what the object is, and the thing being established stops being the
     * thing. The prompt says what it is for where the provider can hear it.
     */
    const styleRefs = styleReferencesFor(db, projectId);
    const platePrompt = (style, refs) => {
        const base = buildPlatePrompt(kind, subject, style, view, !!anchorPath);
        return (refs && refs.length && refs[0].tag)
            ? `${base}, in the light, palette and colour grade of @${refs[0].tag}`
            : base;
    };

    /*
     * The existing view of this subject, so a new one MATCHES rather than
     * invents the place again. It leads the reference list: the prompt tells
     * the model this is the same location from a different position, and the
     * picture it means has to be the first thing attached.
     */
    let anchorRef = null;
    if (anchorPath) {
        try {
            const { toDataUri } = require('./reference-images');
            const uri = toDataUri(anchorPath);
            if (uri) anchorRef = { name: subject.name, kind: 'anchor', tag: 'sameplace', uri };
        } catch (_) { anchorRef = null; }
    }

    const refs = [...(anchorRef ? [anchorRef] : []), ...styleRefs];
    const basePayload = {
        negative_prompt: anchorPath ? `${NEGATIVE}, ${VIEW_NEGATIVE}` : NEGATIVE,
        aspect_ratio: aspectRatio || undefined,
        ...(refs.length ? { reference_images: refs } : {}),
    };

    let result = await provider.generate('image', {
        ...basePayload,
        prompt: platePrompt(stylePreset, styleRefs),
    }, { timeout: timeout || 300000 });

    // Same refusal path as character sheets: retry once without the style
    // rather than losing the plate entirely.
    if (!result.ok && styleApplied && /moderation/i.test(String(result.error || ''))) {
        // The look goes in full: its words AND its picture. Retrying with the
        // reference still attached would re-send the thing that may have been
        // refused, and report `style_applied: false` while the look was in fact
        // still applied — a worse lie than dropping it.
        delete basePayload.reference_images;
        result = await provider.generate('image', {
            ...basePayload,
            prompt: buildPlatePrompt(kind, subject, null, view, !!anchorPath),
        }, { timeout: timeout || 300000 });
        if (result.ok) styleApplied = false;
    }

    if (!result.ok) return { ok: false, error: result.error, style_applied: styleApplied };

    ensureDir(projectId, spec.subdir);
    const fileName = plateFileName(kind, subject.name, view);

    let filePath;
    try {
        filePath = await persistProviderMedia(projectId, spec.subdir, fileName, result.data, { serveDir: 'images' });
    } catch (err) {
        return { ok: false, error: `plate generated but could not be stored: ${err.message}`, style_applied: styleApplied };
    }

    /*
     * Replace THIS VIEW, not every plate the subject has.
     *
     * A plate is the current canonical reference for a subject seen a
     * particular way, and leaving stale copies of the same view behind would
     * let the gather query pick an older look at random. But deleting them all
     * would mean generating a second view of a location destroys the first,
     * which is the whole reason a location could only ever have one.
     */
    db.prepare(`DELETE FROM film_assets
                WHERE project_id = ? AND ${spec.fkColumn} = ? AND asset_type = ? AND file_name = ?`)
        .run(projectId, subject.id, spec.assetType, fileName);

    const assetId = generateId();
    db.prepare(
        `INSERT INTO film_assets (id, project_id, ${spec.fkColumn}, asset_type, file_path, file_name,
            format, mime_type, version, metadata, provider, provider_model)
         VALUES (?, ?, ?, ?, ?, ?, 'png', 'image/png', 1, ?, ?, ?)`
    ).run(assetId, projectId, subject.id, spec.assetType,
        typeof filePath === 'string' ? filePath : (filePath && filePath.path) || '',
        fileName,
        JSON.stringify({ kind: `${kind}_plate`, style_applied: styleApplied,
            // Which view of the subject this is. Absent means the original,
            // view-less plate, which is what every existing project has.
            ...(view ? { view: String(view).trim() } : {}) }),
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

module.exports = {
    plateFileName, PLATE_KINDS, buildPlatePrompt, generatePlate, styleReferencesFor, NEGATIVE };
