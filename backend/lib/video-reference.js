/**
 * What a video model will be shown, and what each picture is FOR.
 *
 * A generic `references[]` is the thing that failed before. Plates were once
 * attached to every clip as an untagged array, so a T-pose studio photograph on
 * a seamless backdrop travelled beside a composed street and the model had to
 * guess which was the truth. They were removed, deliberately — on image-to-video
 * the keyframe IS the init_image and was already generated from those plates.
 *
 * What makes references work is not quantity, it is ROLES. `recompose` proved
 * that: two pictures only behaved once each had a job. So a reference here is
 * semantic — Film Engine says "this is MAYA's face", "this is the street" — and
 * each adapter translates that into whatever its model understands.
 *
 * Keeping the vocabulary here rather than in the adapter is the point: these
 * APIs change, and Film Engine's understanding of a shot should not.
 */

/** What a reference can be FOR. Ordered by how much a viewer notices it. */
const ROLES = Object.freeze([
    'keyframe',    // the board — what the shot looks like at frame 0
    'character',   // who is in it
    'creature',    // what else is alive in it
    'prop',        // objects that must match
    'location',    // where it is
    'style',       // the look, never the subject
    'motion',      // a clip showing a move to imitate
    'audio',       // a track to sync or match
]);

/** Roles that arrive as a still, a clip, or a sound. */
const SOURCE_OF_ROLE = Object.freeze({
    keyframe: 'image', character: 'image', creature: 'image', prop: 'image',
    location: 'image', style: 'image', motion: 'video', audio: 'audio',
});

/**
 * Rank when there is not room for everything.
 *
 * Mirrors KIND_RANK on the image side for the same reason it exists there: with
 * limited room, identity outranks place and place outranks objects. The
 * keyframe is 0 because it is not a reference to be consistent with — it is the
 * shot.
 */
const ROLE_RANK = Object.freeze({
    keyframe: 0, character: 1, creature: 2, location: 3, prop: 4,
    style: 5, motion: 6, audio: 7,
});

/**
 * Per-model contracts.
 *
 * Declared with a REASON, the same series `promptLimit`, `maxReferenceImages`,
 * `referenceMode`, `maxKeyframes` and `sizeControl` already follow. A model that
 * declares nothing falls back to keyframe-only: over-sending is a rejection at
 * the provider that costs a generation, while under-sending costs some
 * conditioning here, where it can be reported.
 */
const KEYFRAME_ONLY = Object.freeze({
    roles: Object.freeze(['keyframe']), maxImages: 1, maxVideos: 0, maxAudio: 0,
    why: 'image-to-video: the keyframe is the init_image and was already generated '
        + 'from the plates, so re-sending them asks the model which picture is the truth',
});

const CONTRACTS = Object.freeze({
    hailuo3: Object.freeze({
        roles: Object.freeze(['keyframe', 'character', 'creature', 'prop', 'location', 'style', 'motion', 'audio']),
        maxImages: 9, maxVideos: 3, maxAudio: 3,
        why: 'Runway documents H3 taking keyframes plus image, video and audio references; '
            + 'at 2 credits per image a full role package costs about 18 credits',
    }),
    seedance2_5: Object.freeze({
        roles: Object.freeze(['keyframe', 'character', 'creature', 'prop', 'location', 'style', 'motion', 'audio']),
        maxImages: 30, maxVideos: 10, maxAudio: 10,
        why: 'Runway documents Seedance 2.5 at up to 30 images, 10 videos and 10 audio; '
            + 'the images are free and the VIDEO is billed per second, so a clip is a cost decision',
    }),
});

/** The contract a model generates under. Unknown models get keyframe-only. */
function contractFor(model) {
    return CONTRACTS[String(model || '').trim()] || KEYFRAME_ONLY;
}

function sourceOf(ref) {
    return (ref && ref.sourceType) || SOURCE_OF_ROLE[ref && ref.role] || 'image';
}

/**
 * Choose what actually travels, and report everything that does not.
 *
 * Dropping silently is the failure this exists to prevent: a prompt naming a
 * subject whose picture was quietly discarded is strictly worse than one that
 * never mentioned it.
 */
function selectReferences(references, contract) {
    const c = contract || KEYFRAME_ONLY;
    const list = Array.isArray(references) ? references : [];
    const selected = [];
    const dropped = [];
    const room = { image: c.maxImages, video: c.maxVideos, audio: c.maxAudio };

    const ranked = list
        .map((ref, i) => ({ ref, i }))
        .sort((a, b) => (ROLE_RANK[a.ref.role] ?? 99) - (ROLE_RANK[b.ref.role] ?? 99)
            || (b.ref.priority || 0) - (a.ref.priority || 0) || a.i - b.i);

    for (const { ref } of ranked) {
        if (!ROLES.includes(ref.role)) {
            dropped.push({ ...ref, reason: `unknown role "${ref.role}" — not one of ${ROLES.join(', ')}` });
            continue;
        }
        if (!c.roles.includes(ref.role)) {
            dropped.push({ ...ref, reason: `this model takes no ${ref.role} reference` });
            continue;
        }
        const kind = sourceOf(ref);
        if (!(room[kind] > 0)) {
            dropped.push({ ...ref, reason: `no room left: the model takes ${c[
                kind === 'image' ? 'maxImages' : kind === 'video' ? 'maxVideos' : 'maxAudio']} ${kind} references` });
            continue;
        }
        room[kind] -= 1;
        selected.push(ref);
    }
    return { selected, dropped };
}

/** What the selection will be billed for, for the estimator. */
function referenceCounts(selected) {
    const out = { imageReferences: 0, videoReferences: 0, audioReferences: 0, videoReferenceSeconds: 0 };
    for (const ref of selected || []) {
        const kind = sourceOf(ref);
        if (kind === 'image') out.imageReferences += 1;
        else if (kind === 'audio') out.audioReferences += 1;
        else {
            out.videoReferences += 1;
            out.videoReferenceSeconds += Number(ref.durationSeconds) || 0;
        }
    }
    return out;
}

module.exports = { ROLES, ROLE_RANK, SOURCE_OF_ROLE, CONTRACTS, KEYFRAME_ONLY, contractFor, selectReferences, referenceCounts };
