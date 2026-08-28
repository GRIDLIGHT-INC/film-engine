/**
 * A character turnaround from ONE orbit, not three separate generations.
 *
 * The technique is "the 360 video character trick": generate a short clip that
 * orbits the character, then take frames from it as the sheet.
 *
 * It is better here for a structural reason rather than a stylistic one. A
 * three-view turnaround today is THREE INDEPENDENT generations — front, side
 * and back, each its own roll of the dice — so they can disagree about the
 * face, the wardrobe and the build. This codebase has already paid for exactly
 * that: the newest of the three rows was the BACK view, and it was the picture
 * attached to every frame the character appeared in.
 *
 * Frames of one continuous motion cannot disagree with each other. That is the
 * whole argument, and it is also cheaper: a 5-second Gen-4 Turbo orbit is 25
 * credits against roughly 45 for three plates.
 *
 * Pure — no I/O, no database. The route does the generating and the frame
 * extraction; this decides what to ask for and where to cut.
 */
const { VIEW_RANK } = require('./plate-views');

/**
 * Where an orbit is worth stopping.
 *
 * Named with the plate vocabulary rather than in degrees, because `headlinePlate`
 * and the shot gatherer select by view name — a frame labelled "72°" is a
 * picture nothing can choose. Front leads because the orbit is SEEDED from the
 * approved front plate and because front is the view that attaches to a shot.
 *
 * Four, not more: past the back the orbit repeats the other side, and a
 * turnaround with eight nearly-identical three-quarters is harder to choose
 * from, not easier.
 */
const ORBIT_VIEWS = Object.freeze([
    Object.freeze({ view: 'front', degrees: 0 }),
    Object.freeze({ view: 'three-quarter', degrees: 45 }),
    Object.freeze({ view: 'side', degrees: 90 }),
    Object.freeze({ view: 'back-three-quarter', degrees: 135 }),
    Object.freeze({ view: 'back', degrees: 180 }),
]);

/**
 * The views that ARE the character's identity.
 *
 * The guide is explicit twice — "an optional turnaround bootstrap, not the
 * final identity source", and in the defaults, "optional bootstrap and angle
 * discovery tool". So an orbit frame may fill a view that does not exist yet,
 * and may refresh a non-identity angle, but must never silently replace an
 * APPROVED identity anchor: front is the picture that attaches to every shot
 * the character appears in, and a cheap orbit frame overwriting it is the exact
 * failure the guide is warning about.
 */
const IDENTITY_VIEWS = Object.freeze(['front']);

/** May an orbit frame take this view's slot? */
function mayOverwrite(view, existing) {
    if (!IDENTITY_VIEWS.includes(view)) return true;      // any other angle: refresh freely
    return !(existing && existing.approved);              // bootstrap only into an empty slot
}

/** What the turnaround being replaced costs: three image generations. */
const REPLACES = Object.freeze({ generations: 3, credits: 45, note: 'three separate plate generations' });

/** Gen-4 Turbo, the draft tier — 5 credits a second. */
const ORBIT_CREDITS_PER_SECOND = 5;

/**
 * Where to cut the clip.
 *
 * Spread across the WHOLE clip in view order rather than at literal bearings:
 * the model is being asked for a slow orbit, not driven by a rig, so the
 * honest mapping is "early frames are the front, late frames are the back".
 * Asking for a frame at an exact degree would claim a precision the generation
 * does not have.
 */
function orbitPlan(opts) {
    const o = opts || {};
    const seconds = Number(o.seconds) > 0 ? Number(o.seconds) : 5;
    const views = Array.isArray(o.views) && o.views.length ? o.views : ORBIT_VIEWS;
    const last = views.length - 1;

    const frames = views.map((v, i) => ({
        view: v.view,
        degrees: v.degrees,
        // The front is frame 0 exactly; the rest spread to just inside the end,
        // because the final frame of a generated clip is often the softest.
        atSeconds: last === 0 ? 0 : Number(((seconds * 0.92) * (i / last)).toFixed(2)),
        rank: VIEW_RANK[v.view],
    }));

    const credits = Math.round(seconds * ORBIT_CREDITS_PER_SECOND);
    return {
        seconds,
        frames,
        credits,
        usd: credits * 0.01,
        comparedTo: REPLACES,
        saving: REPLACES.credits - credits,
    };
}

/**
 * What to ask the video model for.
 *
 * Two things decide whether this produces a turnaround or a performance:
 *
 *  - THE CAMERA MOVES AND THE SUBJECT DOES NOT. A character who walks or turns
 *    gives you different POSES, which is not a turnaround; a turnaround is one
 *    pose seen from several angles.
 *  - IT IS STILL A PLATE. The same isolation the still plates use applies —
 *    an empty frame, no room, no scenery — because whatever is behind the
 *    character here is dragged into every frame that references them.
 */
function orbitPrompt(character, medium, opts) {
    const o = opts || {};
    const name = String((character && character.name) || 'the character').toUpperCase();
    const appearance = String((character && character.appearance_prompt) || '').trim();
    const look = String(medium || '').trim() || 'photoreal, shot on a real camera';

    const prompt = [
        `${look}. Full-body studio turntable of ${name}`,
        appearance ? `— ${appearance}` : '',
        '. The camera orbits slowly and steadily around the figure through a full turn,',
        'starting from directly in front. The subject holds still: same pose, same expression,',
        'same wardrobe throughout — only the camera moves.',
        'Even, flat lighting. Empty frame, plain seamless backdrop, nothing else in shot.',
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').replace(/ \./g, '.');

    return {
        prompt,
        negative_prompt: 'background, room, interior, furniture, window, street, scene, scenery, '
            + 'other people, walking, changing pose, changing expression, text, labels, watermark',
        // Seeded from the plate that was already approved. Without it the orbit
        // invents a new person and the sheet is of somebody else.
        init_image: o.frontPlateUri || undefined,
        motion: { subject: 'the subject holds still', environment: 'camera orbits the subject' },
        camera_control: { type: 'orbit' },
    };
}

module.exports = { ORBIT_VIEWS, IDENTITY_VIEWS, mayOverwrite, ORBIT_CREDITS_PER_SECOND, REPLACES, orbitPlan, orbitPrompt };
