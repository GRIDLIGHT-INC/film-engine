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
 * What the orientation plan says about the side being photographed.
 *
 * THE PLAN WAS WRITTEN FOR THE PLATES AND NEVER REACHED THEM.
 *
 * `orientation_plan` is documented, on its own tool, as "what keeps four
 * plates of one room describing the same room" -- and buildPlatePrompt read
 * `description`, `lighting_default` and `time_of_day_default` and stopped.
 * So the field a director fills in to say what is on the north side was
 * stored, drawn as a compass diagram, and then not consulted by the one
 * process it exists to constrain: each side went on being generated from the
 * same paragraph as every other side, which is exactly how four views of one
 * street come back as four different streets.
 *
 * Only the FACING edge is pushed. Naming the other three would put them in
 * frame -- an image model has no way to act on "and behind you is the harbour"
 * except to paint the harbour. The marker rides with the anchor plate alone,
 * for the same reason: the sides inherit it by being photographed FROM that
 * picture, and stating it on a side that faces away from it would summon a
 * second copy of the one landmark the plan exists to keep singular.
 */
function orientationEdge(subject, view) {
    let plan = subject && subject.orientation_plan;
    if (typeof plan === 'string') { try { plan = JSON.parse(plan); } catch (_) { plan = null; } }
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return '';

    // No view means the default plate, and the default plate IS the anchor
    // side -- the same equivalence planCompassSweep makes.
    const compass = compassView(view) || COMPASS_VIEWS.find(v => v.isAnchor);
    if (!compass) return '';

    const said = [];
    const here = String(plan[compass.name] || '').trim();
    if (here) said.push(`on this side: ${here}`);
    // Interior zones are in frame from every side, so they travel with all of
    // them; a plan with none is an exterior and says nothing.
    const zones = (Array.isArray(plan.interior) ? plan.interior : [])
        .map(x => String(x || '').trim()).filter(Boolean);
    if (zones.length) said.push(`the space holds ${zones.join(', ')}`);
    if (compass.isAnchor && !compassView(view)) {
        const marker = String(plan.marker || '').trim();
        if (marker) said.push(marker);
    }
    return said.join(', ');
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
function planCompassSweep({ existingViews = [], overwrite = false, provider = null } = {}) {
    const have = new Set((existingViews || []).map(v => String(v || '').trim().toLowerCase()));
    const anchor = COMPASS_VIEWS.find(v => v.isAnchor);
    // The default, view-less plate IS the anchor side — that is what every
    // project already has, and re-labelling it would orphan it.
    const hasAnchor = have.has('') || have.has(anchor.name);
    if (!hasAnchor) {
        return {
            refused: true,
            /*
             * The warning belongs HERE, on the free plan, not only on the
             * result. By the time the result explains it the plates exist and
             * were billed — and a director reading a loose match afterwards
             * concludes the feature does not work.
             */
            anchoring: viewAnchoring(provider),
            reason: 'This location has no plate to turn from. Generate its reference plate first — '
                + 'the four sides are photographed FROM it, so that they are four sides of one place '
                + 'rather than four different streets.',
            anchor: anchor.name, generate: [], skipped: [],
        };
    }
    const sides = COMPASS_VIEWS.filter(v => !v.isAnchor);
    return {
        refused: false, anchor: anchor.name, anchoring: viewAnchoring(provider),
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
        // What the orientation plan says about THIS side. See orientationEdge:
        // the field exists for this and was never read here.
        const edge = orientationEdge(subject, view);
        if (edge) parts.push(edge);
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
 * 2048 on the long edge — and now for characters and props too, because the
 * house standard makes every plate 2K (lib/image-standard.js). The name stays
 * because the floor-reaching logic and its reports were written against it.
 */
const LOCATION_MIN_EDGE = require('./image-standard').SIZES.plate.longEdge;

/**
 * Will the provider actually be told this size?
 *
 * Three behaviours, and the difference is invisible from the payload: `exact`
 * sends pixels and gets them, `snapped` sends a pixel pair from a fixed list,
 * and `ratio-only` cannot be told a size at all — a requested width and height
 * can only become an aspect ratio, and the provider chooses the pixels.
 *
 * An adapter that declares nothing is read as NOT honouring it. Over-promising
 * is exactly what produced a confident 2048x1152 that arrived as 1376x768.
 */
function sizeIsHonoured(adapter) {
    /*
     * `snapped` counts. Runway answers at the nearest pixel pair from a
     * documented list and Google at the nearest size TIER — neither reproduces
     * the ask exactly, but both are TOLD it, so the ceiling check below is
     * meaningful and a big request genuinely returns a big picture.
     *
     * `ratio-only` does not: a width and height can only become an aspect
     * ratio, the provider chooses the pixels, and no ceiling arithmetic here
     * changes what comes back.
     */
    return !!adapter && adapter.sizeControl && adapter.sizeControl !== 'ratio-only';
}

/**
 * Can this provider actually serve a plate of `floorPixels`?
 *
 * TWO conditions, and treating it as one is the trap. Enough pixels is
 * necessary and not sufficient: a `ratio-only` adapter turns a width and height
 * into an aspect ratio and chooses the pixels itself, so the number reaches
 * nothing however large its ceiling. gridlight declares exactly the floor and
 * is ratio-only — judged on area alone it would be called capable, and the
 * plate would come back at whatever it decided.
 */
/** Why the floor was missed, and who could serve it instead. */
function floorReason(adapter, floorPixels) {
    const base = adapter && adapter.sizeControlReason
        ? 'This provider cannot be told a size \u2014 a width and height can only become an '
          + `aspect ratio, so it chooses the pixels. ${adapter.sizeControlReason}`
        : 'This provider cannot be told a size; a width and height can only become an '
          + 'aspect ratio, so the provider chooses the pixels.';
    const able = capableProviders(floorPixels);
    return able.length
        ? `${base} Providers that can serve this plate: ${able.join(', ')}.`
        : `${base} No registered provider can serve this plate at that size.`;
}

/**
 * The pixels a location plate needs at this project's aspect.
 *
 * Asked of the sizing code itself — what would an ideal provider be sent? —
 * rather than re-deriving the aspect here. A second computation of the same
 * number is how the floor the chooser enforces comes to differ from the floor
 * the report measures against.
 */
function locationFloorPixels(project) {
    const perfect = { sizeControl: 'exact', maxImagePixels: Number.MAX_SAFE_INTEGER };
    const s = plateImageSize(project || {}, perfect.maxImagePixels, 'location', perfect);
    return s ? s.width * s.height : LOCATION_MIN_EDGE * LOCATION_MIN_EDGE;
}

/**
 * Which provider generates THIS plate.
 *
 * For every kind but location, the project's own choice, unchanged. A location
 * plate is the one reference re-shot from by every shot in the scene, so it
 * declares a floor — and reaching that floor is a PROVIDER choice, not a
 * setting: a ratio-only adapter turns a size into an aspect ratio and picks the
 * pixels itself.
 *
 * A demotion is returned, never swallowed. Generating somewhere the director
 * did not choose is defensible and has to be said.
 */
function plateProviderFor(kind, projectConfig, project) {
    const { resolve } = require('./providers');
    const chosen = resolve('image', projectConfig || {});
    if (kind !== 'location') return { provider: chosen, floor: null };

    const need = locationFloorPixels(project);
    if (canReachFloor(chosen, need)) {
        return { provider: chosen, floor: { needed_pixels: need, moved: null, capable: capableProviders(need) } };
    }
    const { imageProviderChain } = require('./image-fallback');
    const chain = imageProviderChain(projectConfig || {}, { needsPixels: need });
    const lead = chain[0];
    // Nothing credentialed can serve it: keep the project's choice and let the
    // size report say the floor was missed. Silently generating nothing would
    // be worse than a plate that is honestly below the floor.
    if (!lead || !canReachFloor(lead, need)) {
        return { provider: chosen, floor: chain.floor || { needed_pixels: need, moved: null, capable: capableProviders(need) } };
    }
    return { provider: lead, floor: chain.floor };
}

/**
 * Can this provider anchor a NEW VIEW on an existing plate?
 *
 * Attaching a reference means two different things and the difference is
 * structural, not a quality setting. A `condition` adapter GENERATES a new
 * image conditioned on what it is given; an `edit` adapter hands back a
 * modified copy of it. A new view is precisely what an edit cannot produce —
 * asked to turn round, it re-photographs what it can see.
 *
 * An adapter that declares nothing is read as EDIT. Over-trusting is what
 * produced four copies of one street: assuming it can turn costs a plate of the
 * wrong side, while assuming it cannot costs a slightly looser one.
 */
function viewAnchoring(provider) {
    const mode = (provider && provider.referenceMode) || 'edit';
    if (mode === 'condition') return { can_anchor: true, reference_mode: mode, why: null, can_anchor_on: [] };
    const able = conditioningProviders();
    const who = (provider && provider.id) || 'this provider';
    return {
        can_anchor: false,
        reference_mode: mode,
        why: `${who} edits the picture it is given rather than generating a new one from it, and an `
            + 'edit cannot move the camera — an anchored view comes back as the same view. This side '
            + 'will be painted from the location description and the style instead, so it shares the '
            + 'materials, era and light but not the exact layout. The description is what carries the '
            + `match: the fuller it is, the closer the sides look.${able.length
                ? ` Providers that CAN turn the camera from an existing plate: ${able.join(', ')}.`
                : ' No registered provider can anchor a new view.'}`,
        can_anchor_on: able,
    };
}

/** Registered image providers that generate FROM a reference rather than editing it. */
function conditioningProviders() {
    const providers = require('./providers');
    return providers.list()
        .filter(a => (a.capabilities || []).includes('image') && a.referenceMode === 'condition')
        .map(a => a.id);
}

/**
 * What a stored view records about how it was made.
 *
 * `anchored` is persisted so a plate on disk can say whether it is a turn of
 * the approved side or a fresh imagining of the same place. Without it three
 * independently painted rooms look exactly like three sides of one.
 */
function viewMetadata({ view, anchored, referenceMode, providerId }) {
    return {
        view: view || '',
        anchored: !!anchored,
        reference_mode: referenceMode || 'edit',
        ...(providerId ? { generated_on: providerId } : {}),
    };
}

/**
 * How to describe a stored view's anchoring.
 *
 * ABSENCE IS 'unknown', never 'anchored'. Every plate on disk predates this,
 * and reading a missing field as anchored would silently certify the three
 * diner sides as matching — the opposite of what they are.
 */
function anchoringOf(metadata) {
    const m = metadata || {};
    if (typeof m.anchored !== 'boolean') return 'unknown';
    return m.anchored ? 'anchored' : 'painted';
}

function canReachFloor(adapter, floorPixels) {
    if (!adapter) return false;
    if (!sizeIsHonoured(adapter)) return false;
    return Number(adapter.maxImagePixels || 0) >= Number(floorPixels || 0);
}

/**
 * Which registered providers could serve it — the remedy, not just the problem.
 *
 * A refusal that explains why the floor was missed and names nothing to do
 * about it sends the reader to the provider list to work it out themselves.
 */
function capableProviders(floorPixels) {
    const providers = require('./providers');
    return providers.list()
        .filter(a => (a.capabilities || []).includes('image') && canReachFloor(a, floorPixels))
        .map(a => a.id);
}

function plateImageSize(project, maxPixels, kind, adapter) {
    const p = project || {};
    /*
     * EVERY PLATE IS 2K — character, location and prop alike — by the house
     * standard (lib/image-standard.js). The long edge is exactly 2048 in the
     * project's shape, whatever the project delivers at: a plate is a reference
     * the frames are built from, not a deliverable, and a plate at the delivery
     * size made a 720p project's references soft and a character turnaround a
     * literal 1024 square. `kind` is still taken so a caller reads the same
     * signature; it no longer changes the answer.
     */
    const std = require('./image-standard');
    const wanted = std.plateSize(p.aspect_ratio, std.projectResolution(p));
    // The floor is the project's own long edge: a plate is made at the
    // resolution in its technical settings, and "below the floor" means below it.
    const floorEdge = Math.max(wanted.width, wanted.height);

    const cap = Number(maxPixels) > 0 ? Number(maxPixels) : null;
    const asked = wanted.width * wanted.height;
    const honoured = sizeIsHonoured(adapter);
    if (!cap || asked <= cap) {
        /*
         * Fits the ceiling — but on a provider that cannot be told a size, the
         * number reaches nothing and the plate comes back at whatever the
         * provider chooses. Reporting the floor as met there is the one
         * outcome worse than not having a floor: it is a promise that is
         * checked and found true while the file on disk is 1376x768.
         */
        if (!honoured) {
            return {
                ...wanted, clamped: false, honoured: false, below_floor: true,
                floor_reason: floorReason(adapter, wanted.width * wanted.height),
            };
        }
        return { ...wanted, clamped: false, honoured: true, below_floor: false, floor_reason: null };
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
        honoured,
        below_floor: !honoured || Math.max(got.width, got.height) < floorEdge,
        /*
         * WHICH reason. A provider that cannot be told a size at all is not
         * merely capped — the number reaches nothing, and reporting only the
         * ceiling would suggest a smaller ask might work. It would not.
         */
        floor_reason: !honoured
            ? floorReason(adapter, asked)
            /*
             * DERIVED, not "BFL and Google". That was typed, and a typed list
             * of vendors is wrong the day one is added, removed or loses its
             * credential — while still reading as authoritative advice.
             */
            : `This provider caps an image at ${cap.toLocaleString()} pixels, so a location `
              + `plate comes back ${got.width}x${got.height} rather than the ${floorEdge}px `
              + `long edge a location wants. ${capableProviders(asked).length
                  ? `Providers that can serve this plate: ${capableProviders(asked).join(', ')}.`
                  : 'No registered provider can serve this plate at that size.'}`,
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
 * Copy the plate that is ABOUT TO BE OVERWRITTEN out of the way.
 *
 * ORDERING IS THE WHOLE POINT. The first version of this archived after the
 * replacement had already been written to the same filename — so every
 * `versions/{name}_v{n}.png` it produced was a second copy of the NEW picture,
 * and the attempt a director wanted back was gone from the disk while the row
 * that named it still claimed to point at it. A version store that keeps the
 * ledger and loses the bytes is worse than none, because it reports success.
 *
 * So this runs BEFORE the write, and it touches the filesystem only. Nothing
 * in the ledger moves until `commitPriorPlate` is told the replacement exists,
 * because a generation can still fail after this point and a subject must not
 * be left with every plate marked superseded and nothing standing in for them.
 *
 * `opts.rows` lets a caller that identifies its prior plates some other way —
 * the orbit turnaround matches on the view in the metadata, not the filename —
 * hand them in rather than have them looked up again.
 *
 * Never throws. Returns null when there is nothing to keep.
 */
function stashPriorPlate(projectId, subject, spec, fileName, opts) {
    const fs_ = require('fs');
    const path_ = require('path');
    try {
        const prior = (opts && Array.isArray(opts.rows) && opts.rows.length)
            ? opts.rows
            : db.prepare(
                `SELECT id, version, file_path, file_name, metadata FROM film_assets
                  WHERE project_id = ? AND ${spec.fkColumn} = ? AND asset_type = ? AND file_name = ?
                  ORDER BY version DESC`).all(projectId, subject.id, spec.assetType, fileName);
        if (!prior.length) return null;

        const highest = prior.reduce((n, r) => Math.max(n, Number(r.version) || 1), 1);
        const stash = { rows: prior, version: highest + 1, moved: [] };

        for (const row of prior) {
            let meta = {};
            try { meta = JSON.parse(row.metadata || '{}'); } catch (_) { meta = {}; }
            // An already-archived version owns its own copy and its own name.
            if (meta.plate_role === 'superseded') continue;
            const livePath = row.file_path || '';
            // Only the row still pointing at the file we are about to write
            // over needs its bytes rescued.
            if (!livePath || path_.basename(livePath) !== fileName) continue;
            if (!fs_.existsSync(livePath)) continue;
            const base = path_.basename(fileName, path_.extname(fileName));
            const ext = path_.extname(fileName) || '.png';
            const dest = path_.join(path_.dirname(livePath), 'versions',
                `${base}_v${Number(row.version) || 1}${ext}`);
            fs_.mkdirSync(path_.dirname(dest), { recursive: true });
            fs_.copyFileSync(livePath, dest);
            stash.moved.push({ id: row.id, dest, file_name: path_.basename(dest) });
        }
        return stash;
    } catch (_) {
        // Nothing was copied, so nothing is half-done. The caller carries on
        // and the incoming plate takes a version above whatever is there.
        return null;
    }
}

/**
 * The replacement landed. Move the ledger to match the disk.
 *
 * Re-points every row that was stashed at its archived copy and marks it
 * `superseded` — a role `sendableSql()` already excludes, so a kept version
 * can never be picked up as the reference by a gather query.
 *
 * Never throws: failing to bookkeep an old attempt must not fail a generation
 * that has already succeeded and been paid for. Returns the version number the
 * INCOMING plate should carry.
 */
function commitPriorPlate(stash) {
    if (!stash) return 1;
    try {
        const moved = new Map((stash.moved || []).map(m => [m.id, m]));
        for (const row of stash.rows) {
            let meta = {};
            try { meta = JSON.parse(row.metadata || '{}'); } catch (_) { meta = {}; }
            if (meta.plate_role === 'superseded') continue;
            const m = moved.get(row.id);
            if (m) {
                db.prepare('UPDATE film_assets SET file_path = ?, file_name = ? WHERE id = ?')
                    .run(m.dest, m.file_name, row.id);
            }
            meta.plate_role = 'superseded';
            meta.superseded_at = new Date().toISOString();
            db.prepare('UPDATE film_assets SET metadata = ? WHERE id = ?')
                .run(JSON.stringify(meta), row.id);
        }
        return stash.version;
    } catch (_) {
        /*
         * The bookkeeping failed and the generation did not. Falling back to
         * the old destructive behaviour here would be the worst of both, so
         * the prior rows are left exactly as they are and the incoming plate
         * takes a version above them — a duplicate reference is visible and
         * recoverable; a deleted one is not.
         */
        return (stash && stash.version) || 2;
    }
}

/**
 * Keep the plate that is being replaced, instead of deleting it.
 *
 * Regenerating a plate used to `DELETE FROM film_assets` for that view and
 * write the new picture over the same filename, inserting the replacement at a
 * hard-coded `version: 1`. So the column existed, never moved, and every
 * earlier attempt was gone from both the ledger and the disk.
 *
 * That is the exact defect the storyboard version store was built to end, and
 * the reasoning transfers without modification: a generation is a coin flip
 * you have already paid for, so the attempt you preferred is often an earlier
 * one. A plate costs the same money as a frame and is MORE consequential,
 * because every frame of that subject is conditioned on it.
 *
 * The live plate keeps the plain filename, so nothing that links to it has to
 * change. The outgoing picture is copied to `versions/{name}_v{n}.png` and its
 * row is kept, re-pointed at the copy and marked `superseded` — a role
 * `sendableSql()` already excludes, so a kept version can never be picked up
 * as the reference by a gather query.
 *
 * Never throws. Failing to archive an old attempt must not fail a generation
 * that has already succeeded and been paid for.
 *
 * Returns the version number the INCOMING plate should carry.
 */
function supersedePlate(projectId, subject, spec, fileName, incomingPath) {
    /*
     * Kept as one call for any caller that archives after the fact. It is the
     * WRONG ORDER — by the time it runs the replacement has already been
     * written over the picture it is meant to keep — so the two halves are
     * exported separately and every path inside this repo uses those instead.
     */
    void incomingPath;
    return commitPriorPlate(stashPriorPlate(projectId, subject, spec, fileName));
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
    view, anchorPath, promptOverride: promptEdit, tierOverride,
    /*
     * Exploring rather than plating.
     *
     * The same prompt building, the same style, the same references and the
     * same fallback chain — only the destination and the role change. A second
     * generator for explorations is how one of them would acquire the medium
     * fix or the look-board attachment and the other would not, which is the
     * exact trap `reference-plates.js` was created to close for locations and
     * props.
     */
    explore, exploreToken }) {
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
            // The adapter itself, so the report knows whether the size reaches it.
            const size = plateImageSize(project, provider && provider.maxImagePixels, kind, provider);
            if (!size) return {};
            return {
                width: size.width,
                height: size.height,
                // Carried so the caller can report it. A floor that quietly
                // delivers less is worse than no floor, because the director
                // stops checking.
                ...(size.below_floor ? { __below_floor: size.floor_reason } : {}),
                ...(size.honoured === false ? { __size_ignored: true } : {}),
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
    const sizeIgnored = !!basePayload.__size_ignored;
    delete basePayload.__below_floor;
    delete basePayload.__size_ignored;

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
    }, {
        timeout: timeout || 300000,
        /*
         * WHAT THIS GENERATION IS, written onto the handle.
         *
         * The character road has stamped this since plate-delivery existed;
         * locations and props did not, so a 2K plate that outran the window
         * could be collected but not FILED without the caller naming the
         * subject by hand. A plate knows its own subject at the moment it is
         * asked for. Say so then.
         */
        jobMeta: { plate: { kind, subject_id: subject.id, view: view || '', explore: !!explore } },
    });

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
        // One sentence, from the same helper the FREE plan warns with — so what
        // a director is told before paying and after paying cannot differ.
        ...(editCannotTurn ? { anchor_dropped: viewAnchoring(provider).why } : {}),
    };

    if (!result.ok) return { ok: false, error: result.error, style_applied: styleApplied, ...provenance };

    ensureDir(projectId, spec.subdir);
    const { explorationFileName, explorationMetadata } = require('./subject-gallery');
    /*
     * An exploration NEVER takes the plate's filename.
     *
     * A plate is written to a per-view name and overwrites, so an exploration
     * sharing it would replace the approved picture on disk the moment it was
     * generated — the image every frame of this subject is conditioned on,
     * gone, with nothing said.
     */
    const fileName = explore
        ? explorationFileName(kind, subject.name, view, exploreToken)
        : plateFileName(kind, subject.name, view);

    /*
     * Rescue the outgoing picture BEFORE the new one is written over its name.
     * An exploration stashes nothing: it replaces nothing, which is the whole
     * reason its filename is unique.
     */
    const stash = explore ? null : stashPriorPlate(projectId, subject, spec, fileName);

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
     *
     * It is no longer a DELETE: the prior rows are archived and marked
     * superseded, which keeps them out of every gather query just as firmly
     * while leaving the pictures on disk.
     */
    // An exploration replaces nothing: keeping every attempt is the point of
    // exploring, and the whole reason its filename is unique.
    let nextVersion = 1;
    if (!explore) {
        nextVersion = commitPriorPlate(stash);
    }

    const assetId = generateId();
    db.prepare(
        `INSERT INTO film_assets (id, project_id, ${spec.fkColumn}, asset_type, file_path, file_name,
            format, mime_type, version, metadata, provider, provider_model)
         VALUES (?, ?, ?, ?, ?, ?, 'png', 'image/png', ?, ?, ?, ?)`
    ).run(assetId, projectId, subject.id, spec.assetType,
        typeof filePath === 'string' ? filePath : (filePath && filePath.path) || '',
        fileName,
        nextVersion,
        JSON.stringify(explore
            // Born a concept. Inert until somebody promotes it, or every
            // exploration would immediately condition the next frame.
            ? explorationMetadata({ kind, style_applied: styleApplied,
                ...(view ? { view: String(view).trim() } : {}) })
            : { kind: `${kind}_plate`, style_applied: styleApplied,
                // Which view of the subject this is. Absent means the original,
                // view-less plate, which is what every existing project has.
                //
                // A view also records HOW it was made. Without that, a side
                // painted from the description looks identical on the shelf to
                // a side turned from the approved plate — which is why the
                // diner's three plates read as three sides of one room when
                // they are three independently imagined rooms.
                ...(view ? viewMetadata({
                    view: String(view).trim(), anchored,
                    referenceMode, providerId: result.provider || provider.id,
                }) : {}) }),
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
        // The size we computed reached nothing. Said plainly, because the
        // width/height in this response would otherwise read as what was
        // generated — and it is not.
        ...(sizeIgnored ? { requested_size_ignored: true } : {}),
        ...provenance,
    };
}

module.exports = {
    stashPriorPlate, commitPriorPlate, supersedePlate,
    LOCATION_MIN_EDGE, sizeIsHonoured, canReachFloor, capableProviders, floorReason,
    viewAnchoring, conditioningProviders, viewMetadata, anchoringOf,
    locationFloorPixels, plateProviderFor,
    COMPASS_VIEWS, compassView, orientationEdge, planCompassSweep, plateImageSize,
    buildPlateRefinePrompt, REFINE_NEGATIVE,
    plateFileName, PLATE_KINDS, buildPlatePrompt, generatePlate, styleReferencesFor, NEGATIVE };
