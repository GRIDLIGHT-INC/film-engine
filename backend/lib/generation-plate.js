/**
 * The generation plate — geometry truth, handed to a model that owns everything
 * else.
 *
 * World Engine stops at geometry. The plate is a deliberately ugly render that
 * fixes the camera, the framing and where each subject stands; the image model
 * supplies appearance, identity, light and polish. That division is the whole
 * point of the bridge: asking a diffusion model to reinvent perspective is how
 * a shot comes back as a different street.
 *
 * A PLATE IS A REFERENCE, NOT A NEW MECHANISM. `KIND_RANK` already ranks the
 * anchor first and the prompt already names it "the first reference image"; a
 * plate is that same semantic role with a different source — previs geometry
 * rather than a previous frame. It is inserted at rank 0 and everything
 * downstream works unchanged, which is why the five existing kinds keep their
 * relative order and a project with no plate sends exactly what it sent before.
 *
 * Free. No provider, no meter, no model — this is a local render, and the free
 * step that precedes every paid generation must stay free or it stops being the
 * thing you check first.
 */

/** Stated, so a reader does not have to infer it from the absence of requires. */
const SPENDS = false;

/**
 * What a plate produces.
 *
 * Three outputs rather than one, because the geometry is worth more than a
 * picture of it: depth lets a model separate the planes it was given, and the
 * masks say which pixels are which subject. Each declares WHY, so an output
 * nobody consumes is visible as an output nobody consumes.
 */
const PLATE_OUTPUTS = Object.freeze([
    {
        id: 'image', assetKind: 'plate_image', ext: '.png',
        why: 'the framing itself — camera, lens and where every subject stands, '
            + 'rendered flat so nothing about it reads as a finished frame',
    },
    {
        id: 'depth', assetKind: 'plate_depth', ext: '.png',
        why: 'so the model can separate foreground from background rather than '
            + 'inferring the layers from a flat picture',
    },
    {
        id: 'segmentation', assetKind: 'plate_masks', ext: '.png',
        why: 'which pixels are which subject, so identity references attach to '
            + 'the right figure instead of the nearest one',
    },
]);

/**
 * A plate is NOT fingerprinted as a generated artefact.
 *
 * The keyframe fingerprint means "this was generated from the card's current
 * image payload". A plate was not — it is a render of geometry — so stamping it
 * would mark every frame built from that card as behind the moment somebody
 * rendered one, which is the "warning you cannot act on" this codebase already
 * paid for once.
 */
const WHY_NOT_FINGERPRINTED =
    'A plate is a render of geometry, not a generation from the scene card\'s payload. '
    + 'Fingerprinting it as a keyframe would report every frame built from that card as '
    + 'stale the moment a plate is rendered — a warning nobody can act on.';

/**
 * How the prompt refers to the plate.
 *
 * Where the provider preserves tags it is named; where it does not, it is
 * identified by POSITION — which is unambiguous precisely because the plate
 * ranks first. The anchor already works this way, and the reason is the same:
 * a model handed several pictures with no way to tell which one fixes the
 * geometry will average them.
 */
function platePromptLead(opts) {
    const tag = opts && opts.tag;
    const which = tag ? `@${tag}` : 'the first reference image';
    return `${which} is a geometric plate: it fixes the camera, the framing, and where each `
        + 'subject stands. Reproduce that geometry exactly — it is not a style reference, and '
        + 'nothing about its flat grey appearance should reach the finished frame.';
}

/**
 * The raster a plate is rendered at.
 *
 * Delegated to `buildVideoFrame`, which is the ONE place the shape of a shot is
 * decided. A plate rendered at a different shape from the frame it seeds is
 * either cropped afterwards — a 9:16 centre crop of a landscape frame keeps 32%
 * of its width — or silently reframes the shot.
 */
function plateSizeFor(project, aspectOverride) {
    const { buildVideoFrame } = require('./video-prompt');
    const frame = buildVideoFrame(project || {}, aspectOverride || null);
    return { width: frame.width, height: frame.height, aspect: frame.aspect || null };
}

/**
 * What a plate was rendered from, recorded so it can be traced.
 *
 * A plate that cannot be traced back to the geometry that produced it is not
 * reproducible, and a director looking at a frame six weeks later has no way to
 * ask what it was built on.
 */
function buildPlateRecord(input) {
    const o = input || {};
    return {
        shot_id: o.shotId || null,
        world_version_id: o.worldVersionId || null,
        camera: o.camera ? JSON.parse(JSON.stringify(o.camera)) : null,
        blocking_snapshot: {
            subjects: (o.subjects || []).map(s => ({
                name: s.name, position: s.position, size: s.size, isTarget: !!s.isTarget,
            })),
        },
        size: plateSizeFor(o.project, o.aspectOverride),
        outputs: PLATE_OUTPUTS.map(x => x.id),
        created_at: new Date().toISOString(),
    };
}

/**
 * Is this plate still attached to geometry that exists?
 *
 * `detached` rather than `stale`, and the distinction is the actionable one:
 * you cannot regenerate a plate against a world version that has been deleted,
 * so telling a director it is "out of date" asks for work they cannot do. The
 * same reasoning film_assets already follows for a shot-scoped file whose shot
 * is gone.
 */
function plateState(record, world) {
    const wanted = record && record.world_version_id;
    if (!wanted) return 'current';            // never claimed a world; nothing to detach from
    return world && world.exists ? 'current' : 'detached';
}

/*
 * A camera move, said in words.
 *
 * Where a provider takes structured camera data it gets the path; where it does
 * not — which is most of them — the move has to survive as prose or it is
 * staged, approved, and then simply not asked for. The clip then ignores it and
 * it reads as the model failing.
 */
const DIRECTION_WORDS = Object.freeze({
    'dolly-in': 'pushes in', 'push-in': 'pushes in', 'tracking-forward': 'moves forward',
    'dolly-out': 'pulls back', 'pull-out': 'pulls back', 'tracking-back': 'moves back',
    'tracking-left': 'tracks left', 'tracking-right': 'tracks right',
    'crane-up': 'cranes up', 'crane-down': 'cranes down',
    'pan-left': 'pans left', 'pan-right': 'pans right',
    'tilt-up': 'tilts up', 'tilt-down': 'tilts down',
    'zoom-in': 'zooms in', 'zoom-out': 'zooms out', 'orbit': 'orbits the subject',
});

function moveProse(move) {
    const m = move || {};
    const movement = String(m.movement || 'static');
    // A locked-off shot says nothing. Inventing a move is worse than silence.
    if (!movement || movement === 'static') return '';

    const verb = DIRECTION_WORDS[movement] || movement.replace(/-/g, ' ');
    const parts = [`The camera ${verb}`];
    if (Number(m.amountM) > 0) parts.push(`${Number(m.amountM)} metres`);
    const secs = Number(m.durationMs) > 0 ? Number(m.durationMs) / 1000 : null;
    if (secs) parts.push(`over ${secs % 1 === 0 ? secs : secs.toFixed(1)} seconds`);

    const rot = m.rotate || {};
    const turns = [];
    if (Number(rot.tiltDeg)) turns.push(`tilting ${Number(rot.tiltDeg) > 0 ? 'up' : 'down'} ${Math.abs(Number(rot.tiltDeg))} degrees`);
    if (Number(rot.panDeg)) turns.push(`panning ${Number(rot.panDeg) > 0 ? 'left' : 'right'} ${Math.abs(Number(rot.panDeg))} degrees`);
    if (Number(rot.rollDeg)) turns.push(`rolling ${Math.abs(Number(rot.rollDeg))} degrees`);

    let out = parts.join(' ');
    if (turns.length) out += ` while ${turns.join(' and ')}`;
    return out + '.';
}

module.exports = {
    SPENDS, PLATE_OUTPUTS, WHY_NOT_FINGERPRINTED, DIRECTION_WORDS,
    platePromptLead, plateSizeFor, buildPlateRecord, plateState, moveProse,
};
