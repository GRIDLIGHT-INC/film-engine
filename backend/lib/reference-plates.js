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

const { ISOLATED_KINDS, isolationNegativeFor, subjectPlateOpening, projectMedium } = require('./plate-isolation');
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
        // A prop plate must isolate its subject, or the plate carries a room
        // and a hand into every frame that references the object. The clause
        // is shared with the character sheet: two literals is how the two
        // came to ask for isolation with different force.
        // The isolation itself now LEADS the prompt; what stays here is the
        // one thing that is not covered by "nothing else visible".
        constraints: ['no people'],
    },
};

/**
 * THE FOUR SIDES OF A PLACE.
 *
 * Every view generated on the real production came back the same side of the
 * street, so 2AA — which shoots back the other way — could not be built. The
 * cause is the anchor, and it is not a bug in it: a plate contains no
 * information about what is behind its own camera, so a model asked to turn
 * round re-photographs what it can see, because that is the only thing it has.
 *
 * Refusing the old viewpoint in the negative was not enough. It told the model
 * not to repeat a FRAMING; nothing told it that the things in the reference are
 * no longer in shot. So each side states three things the old prose views could
 * not: how far the camera turned, which way, and where what you can see in the
 * reference has GONE.
 *
 * The compass is a convention, not a survey. We cannot know true north, and
 * "looking back across the bulb" is a sentence only the person who wrote it can
 * act on. So the plate the director already has IS north, and east, south and
 * west follow by right-hand quarter turns — arbitrary, consistent, and sayable
 * by a card, a picker and an agent alike.
 */
const COMPASS_VIEWS = Object.freeze([
    Object.freeze({
        name: 'north', bearing: 0, isAnchor: true,
        // Never generated. It is the picture the director gave us, and buying a
        // duplicate of it is the one certain waste in a sweep.
        turn: null, gone: null,
    }),
    Object.freeze({
        name: 'east', bearing: 90, isAnchor: false,
        turn: 'turned 90° to the RIGHT, on the spot',
        gone: 'what the reference image shows has swung away to the LEFT and is NOT in this frame',
        solo: 'standing in the middle of this place and facing EAST \u2014 the side to the RIGHT of an establishing view of it, and not that establishing view',
    }),
    Object.freeze({
        name: 'south', bearing: 180, isAnchor: false,
        turn: 'turned right round, 180° on the spot, to face the OPPOSITE way',
        gone: 'what the reference image shows is now directly BEHIND the camera and is NOT in this frame',
        solo: 'looking back the way an establishing photograph of this place faces \u2014 the side BEHIND that camera, so none of what an establishing shot of it shows is in frame',
    }),
    Object.freeze({
        name: 'west', bearing: 270, isAnchor: false,
        turn: 'turned 90° to the LEFT, on the spot',
        gone: 'what the reference image shows has swung away to the RIGHT and is NOT in this frame',
        solo: 'standing in the middle of this place and facing WEST \u2014 the side to the LEFT of an establishing view of it, and not that establishing view',
    }),
]);

/** The compass side a view name refers to, or null for a prose view. */
function compassView(name) {
    const n = String(name || '').trim().toLowerCase();
    return COMPASS_VIEWS.find(v => v.name === n) || null;
}

/**
 * Which sides a sweep would buy, and which it already has.
 *
 * Pure, so the button, the route and the agent tool all price the same sweep —
 * and so the refusal below is testable without spending anything.
 *
 * Refused outright with no anchor plate. Four sides generated independently are
 * four different streets: the blue house on the right of one is not the blue
 * house you see when you turn. Attempting it anyway would produce four
 * plausible pictures and a location that does not exist, which is worse than
 * refusing because it looks like it worked.
 */
function planCompassSweep({ existingViews = [], overwrite = false } = {}) {
    const have = new Set((existingViews || []).map(v => String(v || '').trim().toLowerCase()));
    const anchor = COMPASS_VIEWS.find(v => v.isAnchor);
    // The default, view-less plate IS the anchor side — that is what every
    // project already has, and re-labelling it would orphan it.
    const hasAnchor = have.has('') || have.has(anchor.name);
    if (!hasAnchor) {
        return {
            refused: true,
            reason: 'This location has no plate to turn from. Generate its reference plate first — '
                + 'the four sides are photographed FROM it, so that they are four sides of one place '
                + 'rather than four different streets.',
            anchor: anchor.name, generate: [], skipped: [],
        };
    }
    const sides = COMPASS_VIEWS.filter(v => !v.isAnchor);
    return {
        refused: false, anchor: anchor.name,
        generate: sides.filter(v => overwrite || !have.has(v.name)),
        skipped: overwrite ? [] : sides.filter(v => have.has(v.name)),
    };
}

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
    /*
     * A COMPASS side states the turn as a measurement; a prose view can only
     * state it as a sentence. Both lead, because whatever leads a prompt is
     * what the image is OF — and continuity leading is precisely how a "new
     * angle" came back as a regrade of the plate it was given.
     */
    const compass = compassView(view);
    const CONTINUOUS = 'Everything else is continuous: the same place, the same buildings, the same '
        + 'materials and colours, the same driveways and streetlights, the same ground and the same '
        + 'time of day';
    const lead = !view || !anchored ? []
        : compass
            ? [`The camera has ${compass.turn} from where the reference image was taken `
               + `(a bearing of ${compass.bearing}\u00b0 from it), and photographs a DIFFERENT side of `
               + `the same place. It is a new picture, not the same one: ${compass.gone}. ${CONTINUOUS}`]
            : [`A DIFFERENT camera position in the same place as the reference image: `
               + `${String(view).trim()}. The camera has moved — this is a new angle on it, not the same `
               + `photograph, and what the reference image shows is NOT in this frame. ${CONTINUOUS}`];

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
    // A compass side is still an ESTABLISHING plate — of that side. A prose
    // view replaces the framing because it IS one ("standing in the middle of
    // the bulb looking at MAYA's house"); "east" is a direction and says
    // nothing about how wide the shot is, so dropping the framing there would
    // leave the model to invent one and the four sides would not match.
    const framing = [(view && !compass) ? null : spec.framing, ...(spec.constraints || [])]
        .filter(Boolean).join(', ');

    const parts = [
        ...lead,
        // "reference plate" reads as a document to an image model the same way
        // "reference sheet" does. Ask for the photograph itself.
        // For a character or a prop the isolation rides WITH the medium: a real
        // style preset is largely a description of a scene, stated first and at
        // length, and an isolation clause further down is a footnote to it.
        // A LOCATION plate is exempt — it IS an environment, and asking one for
        // "no scenery" would ask for a picture of a place with no place in it.
        /*
         * For a character or a prop the EMPTY FRAME is the first thing said,
         * and the style follows scoped to look only. Isolation after the style
         * was measurably not enough: a real preset put 276 characters of rooms
         * and windows ahead of it.
         *
         * A LOCATION plate keeps the original order untouched — it IS an
         * environment, its style legitimately describes the place, and there is
         * nothing here to exclude.
         */
        /*
         * A subject plate takes the MEDIUM and nothing else from the look.
         *
         * The style preset describes finished frames, so on a plate it asks
         * for the room the plate exists to exclude. What has to match across a
         * production is what KIND of picture this is — photoreal, 3D render,
         * cel animation — and the mood board records exactly that.
         *
         * A LOCATION plate is untouched: it IS an environment, its style
         * legitimately describes the place, and there is nothing to exclude.
         */
        ...(ISOLATED_KINDS.includes(kind)
            ? [subjectPlateOpening(projectMedium(subject.project_id), `Studio image of the ${kind}`)]
            : [style ? `${style}. Photograph of the ${kind}`
                     : `photoreal cinematic photograph of the ${kind}`]),
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
        /*
         * No picture to turn from, so the side has to be said in words a model
         * can act on. "photographed facing south" is a fact about a compass and
         * describes nothing; what distinguishes a side, with no reference, is
         * its relationship to the establishing view of the same place — which
         * is a thing the description already implies.
         */
        parts.push(compass
            ? (compass.solo || `photographed facing ${compass.name}`)
            : `photographed ${String(view).trim()}`);
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
 * How large a plate should be generated.
 *
 * A plate never saw a resolution at all — it was generated at whatever the
 * provider defaulted to, while the frames referencing it followed the project.
 * A plate conditions every frame its subject appears in, so at a different size
 * from those frames it is either detail nobody asked for or a soft reference on
 * a sharp board.
 *
 * Same budget the board frame uses, so the two cannot disagree. A project with
 * no resolution set gets NOTHING rather than a guess — the provider's own
 * default is the right answer when nobody has stated one, and inventing a size
 * would silently reframe every plate in every existing project.
 */
/**
 * A LOCATION PLATE IS GENERATED AT 2K OR BETTER.
 *
 * It is the one reference that is RE-SHOT FROM. A character or prop plate is a
 * close-up filling its own frame, so the subject occupies most of the pixels;
 * a location plate's subject is the whole environment, and any given shot uses
 * a fraction of it — a corner of the street, one house front, the far kerb.
 * Detail that is adequate on a portrait is mush on a crop, and the plate is
 * what every shot in that scene is built against.
 *
 * 2048 on the long edge. Not applied to characters or props: their subject
 * already fills the frame, so a bigger canvas buys detail nobody crops into
 * and costs more on every provider that prices by the megapixel.
 */
const LOCATION_MIN_EDGE = 2048;

function plateImageSize(project, maxPixels, kind) {
    const p = project || {};
    const { imageBudget } = require('./capability-payloads');
    const stated = String(p.target_resolution || '').match(/^\s*\d+\s*x\s*\d+\s*$/i);

    if (kind !== 'location') {
        // Unchanged: a project that stated no resolution gets NOTHING rather
        // than a guess, because the provider's own default is the right answer
        // when nobody has said, and inventing a size would silently reframe
        // every plate in every existing project.
        if (!stated) return null;
        const d = imageBudget(p.aspect_ratio, p.target_resolution, maxPixels);
        return { width: d.width, height: d.height, clamped: !!d.clamped, below_floor: false };
    }

    /*
     * The floor holds whether or not the project settings are filled in.
     * "Always at least 2K" is somebody stating a size for this kind of plate,
     * which is a different thing from a project having stated none.
     */
    /*
     * The base SHAPE, unclamped.
     *
     * `imageBudget(…, null)` does not mean "no ceiling" — it falls back to a
     * default one, which returned 1672x944 for a 16:9 1920x1080 project and
     * made the floor calculation start from an already-shrunk frame. The cap
     * is applied deliberately below, once, against the real provider.
     */
    const UNCAPPED = Number.MAX_SAFE_INTEGER;
    const base = stated
        ? imageBudget(p.aspect_ratio, p.target_resolution, UNCAPPED)
        : imageBudget(p.aspect_ratio, `${LOCATION_MIN_EDGE}x${LOCATION_MIN_EDGE}`, UNCAPPED);

    /*
     * The long edge is set EXACTLY to the floor and the short edge derived
     * from the ratio. Scaling both by a factor and rounding each to a multiple
     * of eight overshoots — 2048x1160 instead of 2048x1152 — which is 16k
     * pixels over a provider whose ceiling is exactly 2048x1152, so the clamp
     * fired and delivered 2040x1152: under the floor, for eight pixels.
     */
    const ratio = base.width / base.height;
    const landscape = ratio >= 1;
    const even = n => Math.max(256, Math.round(n / 2) * 2);
    const wanted = landscape
        ? { width: LOCATION_MIN_EDGE, height: even(LOCATION_MIN_EDGE / ratio) }
        : { width: even(LOCATION_MIN_EDGE * ratio), height: LOCATION_MIN_EDGE };

    // Already bigger than the floor? Keep what the project asked for.
    if (Math.max(base.width, base.height) >= LOCATION_MIN_EDGE) {
        wanted.width = base.width; wanted.height = base.height;
    }

    const cap = Number(maxPixels) > 0 ? Number(maxPixels) : null;
    const asked = wanted.width * wanted.height;
    if (!cap || asked <= cap) {
        return { ...wanted, clamped: false, below_floor: false, floor_reason: null };
    }

    /*
     * The provider cannot serve it. Clamped and SAID — a floor that quietly
     * delivers less is worse than no floor, because the director stops
     * checking. Runway tops out at 1920x1080 and OpenAI at 1536x1024; neither
     * reaches a 2048 long edge, and that is a fact about them rather than
     * something to work around here.
     */
    const k = Math.sqrt(cap / asked);
    const clampEven = n => Math.max(256, Math.round((n * k) / 8) * 8);
    const got = { width: clampEven(wanted.width), height: clampEven(wanted.height) };
    return {
        ...got,
        clamped: true,
        asked_width: wanted.width,
        asked_height: wanted.height,
        below_floor: Math.max(got.width, got.height) < LOCATION_MIN_EDGE,
        floor_reason: `This provider caps an image at ${cap.toLocaleString()} pixels, so a location `
            + `plate comes back ${got.width}x${got.height} rather than the ${LOCATION_MIN_EDGE}px `
            + 'long edge a location wants. Meshy and BFL can serve it; Runway and OpenAI cannot.',
    };
}

/**
 * KEEP THE PLATE, CHANGE ONE THING.
 *
 * A plate could only be regenerated wholesale from words, so "the same street
 * but wetter" was a fresh roll of the dice on a picture that conditions every
 * frame the subject appears in. The director: "Not 100% sure how we're able to
 * generate plates or refine them for locations... this is a huge issue that
 * prevents me from finishing the storyboard."
 *
 * And this is the operation an EDIT-mode provider is actually for. A new VIEW
 * had to drop its references entirely, because /image-to-image hands back a
 * modified copy of what it is given and an edit cannot move the camera. A
 * refine keeps the camera and changes one thing — which is exactly what that
 * endpoint does well. The provider semantics that defeated the compass sweep
 * are the ones that make this the right tool.
 *
 * The instruction LEADS, and the subject is NOT re-described. The picture is
 * attached and already carries the place; saying it again in words pulls the
 * result back toward a fresh generation, which is the entire difference between
 * a refine and a regeneration. Both rules were paid for on the storyboard
 * refine and on the compass lead.
 */
function buildPlateRefinePrompt(kind, subject, instruction, stylePreset) {
    const what = String(instruction || '').trim();
    if (!what) throw new Error('a refine needs an instruction: what should change?');

    const parts = [
        `${what}.`,
        `Keep everything else in the reference image exactly as it is: the same ${kind === 'location'
            ? 'place, the same buildings and materials, the same camera position and framing'
            : 'object, the same shape and materials, the same camera position and framing'}.`,
    ];
    // The look only travels when the caller asks, because a style preset is a
    // sentence about the whole film and a refine is a sentence about one change.
    if (stylePreset && String(stylePreset).trim()) parts.push(String(stylePreset).trim());
    return parts.join(' ');
}

/** What a refine refuses: drifting into a different picture. */
const REFINE_NEGATIVE = 'different location, different object, different camera position, '
    + 'different framing, rebuilt scene, new composition, text, watermark, labels, captions';

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
async function generatePlate({ projectId, kind, subject, stylePreset, provider, aspectRatio,
    project, timeout, db,
    view, anchorPath, promptOverride: promptEdit, tierOverride }) {
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

    /*
     * AN EDIT CANNOT MOVE THE CAMERA.
     *
     * Whether attaching a reference means "condition a new image on this" or
     * "modify this picture" is a property of the PROVIDER, and this code
     * assumed the first for all of them. Meshy routes any reference to
     * /image-to-image and OpenAI to /images/edits; both hand back a modified
     * copy of what they were given. So a request for the OPPOSITE SIDE of a
     * street, anchored on a plate of this side, came back as that plate with a
     * colder grade — three times, on three differently-worded prompts, which is
     * what proved the wording was never the problem.
     *
     * A new VIEW is the one thing an edit cannot produce. On an edit-mode
     * provider it is generated from WORDS: the subject's own description and
     * the project's style preset, which is also the honest place for continuity
     * to come from here — the existing plate's geometry says nothing about what
     * is behind its own camera.
     *
     * Every reference goes, not just the anchor: a single mood-board image is
     * enough to route the call to the edit endpoint, so dropping the anchor
     * alone would leave a view that is an edit of the look plate instead.
     *
     * A subject's FIRST plate is unaffected — it has no view and no anchor.
     */
    const referenceMode = (provider && provider.referenceMode) || 'edit';
    const viewNeedsNewCamera = !!(view && String(view).trim());
    const editCannotTurn = viewNeedsNewCamera && referenceMode !== 'condition';

    const refs = editCannotTurn ? [] : [...(anchorRef ? [anchorRef] : []), ...styleRefs];
    const sentStyleRefs = editCannotTurn ? [] : styleRefs;
    const anchored = !!anchorPath && !editCannotTurn;

    const basePayload = {
        // The negative refuses the old viewpoint only where the old viewpoint
        // is actually attached. With nothing to repeat, refusing "identical
        // framing" spends the negative on a risk that is not present.
        negative_prompt: isolationNegativeFor(kind,
            anchored ? `${NEGATIVE}, ${VIEW_NEGATIVE}` : NEGATIVE),
        aspect_ratio: aspectRatio || undefined,
        // The project's delivery size, so a plate matches the frames that
        // reference it. Absent when the project states none — except for a
        // LOCATION, which has a 2K floor whether the project stated a size or
        // not, because it is the plate every shot in a scene is cropped from.
        ...(() => {
            const size = plateImageSize(project, provider && provider.maxImagePixels, kind);
            if (!size) return {};
            return {
                width: size.width,
                height: size.height,
                // Carried so the caller can report it. A floor that quietly
                // delivers less is worse than no floor, because the director
                // stops checking.
                ...(size.below_floor ? { __below_floor: size.floor_reason } : {}),
            };
        })(),
        ...(refs.length ? { reference_images: refs } : {}),
    };

    /*
     * Taken OFF the payload before anything is sent.
     *
     * The floor note is for the caller, not the provider: basePayload is
     * spread straight into provider.generate(), so an unrecognised field would
     * travel to Runway or Meshy with the request.
     */
    const belowFloor = basePayload.__below_floor || null;
    delete basePayload.__below_floor;

    /*
     * The quality tier reaches plates too.
     *
     * A plate conditions every frame its subject appears in, so generating one
     * outside the tier the production chose drags all of them with it — and a
     * setting that reached the board but not the plates would be the "three
     * paths out of four" gap this codebase has now shipped twice. Applied to
     * the base payload so the moderation retry below inherits it.
     */
    require('./capability-payloads').withTierModel(
        basePayload, { project, tierOverride: tierOverride || null }, provider);

    let result = await provider.generate('image', {
        ...basePayload,
        prompt: promptEdit || (buildPlatePrompt(kind, subject, stylePreset, view, anchored)
            + ((sentStyleRefs.length && sentStyleRefs[0].tag)
                ? `, in the light, palette and colour grade of @${sentStyleRefs[0].tag}` : '')),
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
            // The retry keeps the EDITED prompt: reverting to the composed text
            // here would discard what was written and report success.
            prompt: promptEdit || buildPlatePrompt(kind, subject, null, view, anchored),
        }, { timeout: timeout || 300000 });
        if (result.ok) styleApplied = false;
    }

    /*
     * How this plate was made, reported rather than assumed.
     *
     * "Anchored on the existing plate" and "painted from the description" give
     * visibly different results, and a director who is not told which one they
     * got will read a loose match as the feature not working. It also names the
     * lever: on the un-anchored path the location's DESCRIPTION is what carries
     * continuity, so a thin description gives a thin match.
     */
    const provenance = {
        anchored,
        reference_mode: referenceMode,
        ...(editCannotTurn ? {
            anchor_dropped: 'This provider edits the picture it is given rather than generating a new '
                + 'one from it, and an edit cannot move the camera — an anchored view comes back as the '
                + 'same view. This side was painted from the description and the style instead, so it '
                + 'shares the materials, era and light but not the exact layout. The location '
                + "description is what carries the match: the fuller it is, the closer the sides look.",
        } : {}),
    };

    if (!result.ok) return { ok: false, error: result.error, style_applied: styleApplied, ...provenance };

    ensureDir(projectId, spec.subdir);
    const fileName = plateFileName(kind, subject.name, view);

    let filePath;
    try {
        filePath = await persistProviderMedia(projectId, spec.subdir, fileName, result.data, { serveDir: 'images' });
    } catch (err) {
        return { ok: false, error: `plate generated but could not be stored: ${err.message}`, style_applied: styleApplied, ...provenance };
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
        // Busted, because a plate overwrites its own filename: without this the
        // page shows the picture that was just replaced.
        image_url: getFileUrl(spec.subdir, projectId, fileName, Date.now()),
        style_applied: styleApplied,
        // The size it was actually generated at, and — for a location that
        // could not reach the 2K floor — why. Reported rather than left to be
        // measured off the file.
        ...(basePayload.width ? { width: basePayload.width, height: basePayload.height } : {}),
        ...(belowFloor ? { below_resolution_floor: belowFloor } : {}),
        ...provenance,
    };
}

module.exports = {
    LOCATION_MIN_EDGE,
    COMPASS_VIEWS, compassView, planCompassSweep, plateImageSize,
    buildPlateRefinePrompt, REFINE_NEGATIVE,
    plateFileName, PLATE_KINDS, buildPlatePrompt, generatePlate, styleReferencesFor, NEGATIVE };
