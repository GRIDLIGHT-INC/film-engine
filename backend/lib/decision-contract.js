/**
 * The contract between the Shot Board and Previs.
 *
 * This is deliberately not another state model. Scene cards remain the durable
 * statement of intent and film_previs_blocking remains a workspace in which an
 * angle can be tried before it is applied. The registry only says which stored
 * choices are projections of the same director decision, and names deliberate
 * boundaries so a missing link cannot quietly become "intentional" later.
 */

const crypto = require('crypto');

const DECISIONS = [
    {
        id: 'shot.camera', covers: ['camera', 'camera_json'], canonical: 'scene_card',
        previs: 'camera_json', surfaces: ['board', 'previs'], staged_disclosure: true,
        payloads: ['image', 'video'],
    },
    {
        id: 'shot.direction', covers: ['direction'], canonical: 'scene_card',
        previs: 'director_json.direction', surfaces: ['board', 'previs'],
        staged_disclosure: true, payloads: ['image', 'video'],
    },
    {
        id: 'shot.lighting', covers: ['lighting'], canonical: 'scene_card',
        previs: 'director_json.lighting', surfaces: ['board', 'previs'],
        staged_disclosure: true, payloads: ['image', 'video'],
    },
    {
        id: 'shot.location_view', covers: ['location_view'], canonical: 'scene_card',
        previs: 'director_json.location_view', surfaces: ['board', 'previs'],
        staged_disclosure: true, payloads: ['image'],
        video_why: 'The chosen background view is baked into the approved keyframe used as the video init image; sending the location plate again would conflict with that composed frame.',
    },
    {
        id: 'shot.characters', covers: ['characters'], canonical: 'scene_card',
        previs: 'subjects_json', surfaces: ['board', 'previs'], staged_disclosure: true,
        payloads: ['image', 'video'],
    },
    {
        id: 'shot.props', covers: ['props', 'subjects_json'], canonical: 'scene_card',
        previs: 'subjects_json', surfaces: ['board', 'previs'], staged_disclosure: true,
        payloads: ['image'],
        video_why: 'Prop identity and placement are baked into the approved keyframe; image-to-video is conditioned on that frame rather than reattaching isolated prop plates.',
    },
];

const EXCEPTIONS = [
    /*
     * MOTION FIELDS — single-surface BY DESIGN, not by omission.
     *
     * A keyframe is a still. It cannot show what the world DOES while the
     * subject acts, where the shot must END, or the order things happen in — so
     * none of the three changes an image payload, and claiming otherwise would
     * be a promise the image builder does not keep.
     *
     * They are board-only for the same kind of reason: previs is where a CAMERA
     * is staged, and "flames erupt from the struck house" is not a camera
     * decision. Putting it on the stage would create a second place to write it
     * and a second answer to what the shot is.
     */
    { id: 'motion.environment', covers: ['environment_motion'],
      why: 'Video-only and board-only by design: a still cannot show what the world does, and it is not a camera decision, so it has no previs surface and no image payload.' },
    { id: 'motion.end_state', covers: ['end_state'],
      why: 'Video-only by design: a keyframe IS the start state, so an end state is meaningless to the image payload; compiled into a closing clause for video.' },
    { id: 'motion.beats', covers: ['beats'],
      why: 'Video-only by design: a still has no time. Emitted only when written, because imposing beats on every shot is the micromanagement that makes some models less reliable.' },

    {
        /*
         * A WORLD PIN IS A BINDING, NOT A DECISION SEEN TWICE.
         *
         * Every other entry in the contract is one creative choice with two
         * surfaces — write it on the board, stage it in previs, and the two must
         * agree. A world pin has only one meaning and one place to express it:
         * which reconstruction this shot is framed inside. There is no board
         * half to disagree with, and inventing one would create a second answer
         * to a question that has exactly one.
         *
         * It also must never be projected onto the scene card. The card is what
         * the shot IS; the world is where it is shot. Writing the pin into the
         * card would make a screenplay revision able to silently repoint a shot
         * at different geometry, which is the class of bug versioning exists to
         * prevent.
         */
        id: 'world.pin', covers: ['world_version_id', 'world_pinned_at'],
        why: 'The world pin binds a shot to one reconstruction. It is single-surface by design: there is no board-side half, and projecting it onto the scene card would let a rewrite repoint a shot at geometry nobody chose.',
    },
    {
        id: 'previs.director-storage', covers: ['director_json'],
        why: 'director_json is the Previs storage envelope for the direction, lighting and location-view decisions above; the semantic fields, not the envelope name, reach prompts.',
    },
    {
        id: 'previs.framing-target', covers: ['subject_json'],
        why: 'subject_json is the derived framing target used by the camera solve; named cast and props live in subjects_json and round-trip independently.',
    },
    {
        id: 'screenplay.source', covers: ['description', 'action', 'dialogue'],
        why: 'Screenplay-derived facts are visible context in Previs, not blocking decisions; editing them belongs to the screenplay and shot-card writing surfaces.',
    },
    {
        id: 'shot.domain-notes', covers: ['sfx_cues', 'notes'],
        why: 'Sound cues and production notes are not visual blocking; their dedicated tools remain their authoritative editing surfaces.',
    },
    {
        id: 'shot.duration-alias', covers: ['duration_seconds'],
        why: 'The card duration is represented on the Previs stage by duration_ms; exposing both units as independent choices would create two values that can disagree.',
    },
    {
        id: 'previs.spatial-workspace',
        covers: ['stage_json', 'rig', 'movement', 'path_json', 'moves_json', 'camera_keys_json', 'duration_ms'],
        why: 'These are Previs-native spatial and timing decisions. Authored camera keys are the source and their sampled path and semantic motion reach generation, but raw coordinates do not belong in the Shot Board form.',
    },
    {
        id: 'project.generation-policy',
        covers: ['aspect_ratio', 'provider_config', 'annotation_feedback', 'anchor_shot_id'],
        why: 'These are project-wide generation policies, not per-shot staged choices. Previs must disclose their effect, while project and Storyboard controls remain authoritative.',
    },
    {
        id: 'staging.unnamed', covers: [],
        why: 'Anonymous helpers are not generation intent: serialising scaffolding puts literal boxes and markers in the image; naming or typing a set_piece makes geometry semantic.',
    },
];

function directorIntentFromCard(card) {
    const source = card || {};
    return {
        direction: source.direction || '',
        location_view: source.location_view || '',
        lighting: source.lighting || null,
        camera_note: (source.camera && source.camera.note) || '',
    };
}

function applyDirectorIntent(card, intent) {
    const out = card;
    const staged = intent || {};
    if (Object.prototype.hasOwnProperty.call(staged, 'direction')) out.direction = staged.direction || '';
    if (Object.prototype.hasOwnProperty.call(staged, 'location_view')) out.location_view = staged.location_view || '';
    if (Object.prototype.hasOwnProperty.call(staged, 'lighting')) {
        if (staged.lighting) out.lighting = staged.lighting;
        else delete out.lighting;
    }
    out.camera = { ...(out.camera || {}) };
    if (Object.prototype.hasOwnProperty.call(staged, 'camera_note')) {
        if (staged.camera_note) out.camera.note = staged.camera_note;
        else delete out.camera.note;
    }
    return out;
}

function normalizeNames(values) {
    return [...new Set((values || []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean))].sort();
}

function applicationFingerprints(row, card, options) {
    if (!row) return null;
    const camera = typeof row.camera_json === 'string' ? JSON.parse(row.camera_json || '{}') : (row.camera || {});
    const director = typeof row.director_json === 'string' ? JSON.parse(row.director_json || '{}') : (row.director || {});
    const subjects = typeof row.subjects_json === 'string' ? JSON.parse(row.subjects_json || '[]') : (row.subjects || []);
    const scene = card || {};
    const cardCamera = scene.camera || {};
    const known = new Set(normalizeNames((options && options.knownNames) || []));
    const stagedNames = normalizeNames(subjects.map(o => o && o.name));
    const staged = {
            camera: { position: camera.position, rotation: camera.rotation,
                focalMm: camera.focalMm, sensorId: camera.sensorId, fStop: camera.fStop,
                heightM: Array.isArray(camera.position) ? camera.position[1] : undefined,
                focusDistanceM: camera.focusDistanceM },
            movement: row.movement,
            director,
            names: known.size ? stagedNames.filter(name => known.has(name)) : stagedNames,
        };
    const projectedCard = {
            camera: { position: cardCamera.position, rotation: cardCamera.rotation,
                lens: cardCamera.lens, movement: cardCamera.movement, sensor: cardCamera.sensor,
                aperture: cardCamera.aperture, height_m: cardCamera.height_m,
                focus_distance_m: cardCamera.focus_distance_m },
            direction: scene.direction || '', location_view: scene.location_view || '',
            lighting: scene.lighting || null,
            characters: normalizeNames(scene.characters || []), props: normalizeNames(scene.props || []),
    };
    const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
    return { stage: hash(staged), card: hash(projectedCard) };
}

/*
 * THE DECISIONS A DIRECTOR CAN SEE AND LOCK, ONE CHIP EACH.
 *
 * The six registry decisions plus the move. Movement is an EXCEPTION in the
 * registry above — Previs-native, video-only — which is exactly why it gets
 * its own chip: it is the one decision a keyframe cannot show, so a director
 * has to be able to lock it separately from the camera it belongs to.
 *
 * The ids are the registry's without the `shot.` prefix, so a chip, a lock and
 * a payload name the same thing.
 */
const DECISION_CHIPS = Object.freeze([
    { id: 'camera',        label: 'Camera',    decision: 'shot.camera' },
    { id: 'direction',     label: 'Direction', decision: 'shot.direction' },
    { id: 'lighting',      label: 'Lighting',  decision: 'shot.lighting' },
    { id: 'location_view', label: 'Set view',  decision: 'shot.location_view' },
    { id: 'characters',    label: 'Cast',      decision: 'shot.characters' },
    { id: 'props',         label: 'Props',     decision: 'shot.props' },
    { id: 'movement',      label: 'Move',      decision: 'previs.spatial-workspace' },
]);

/**
 * One fingerprint pair PER DECISION: what the stage holds, and what the card
 * holds, for that decision alone.
 *
 * The same material applicationFingerprints hashes as a whole, cut along the
 * chip lines — so "applied" per decision and "applied" for the shot can never
 * disagree about what was compared. `has` is whether the STAGE says anything
 * about it; a decision nobody has touched is "none", not "trying".
 *
 * options.characterNames / options.propNames split the staged subjects by
 * what the project knows them to be. A staged name the project does not know
 * is scaffolding (see staging.unnamed) and is counted as neither.
 */
function decisionParts(row, card, options) {
    if (!row) return null;
    const j = (v, d) => { if (typeof v !== 'string') return v == null ? d : v; try { return JSON.parse(v || ''); } catch (_) { return d; } };
    const camera = j(row.camera_json, {}) || {};
    const director = j(row.director_json, {}) || {};
    const subjects = j(row.subjects_json, []) || [];
    const moves = j(row.moves_json, []) || [];
    const scene = card || {};
    const cardCamera = scene.camera || {};
    const opts = options || {};
    const chars = new Set(normalizeNames(opts.characterNames || []));
    const props = new Set(normalizeNames(opts.propNames || []));
    const staged = normalizeNames(subjects.map(o => o && o.name));
    const hash = value => crypto.createHash('sha256').update(JSON.stringify(value === undefined ? null : value)).digest('hex').slice(0, 32);
    const present = v => v != null && v !== '' && !(Array.isArray(v) && !v.length)
        && !(typeof v === 'object' && !Array.isArray(v) && !Object.values(v).some(x => x != null && x !== ''));
    const pairs = {
        camera: [
            { position: camera.position, rotation: camera.rotation, focalMm: camera.focalMm,
              sensorId: camera.sensorId, fStop: camera.fStop, focusDistanceM: camera.focusDistanceM },
            { position: cardCamera.position, rotation: cardCamera.rotation, lens: cardCamera.lens,
              sensor: cardCamera.sensor, aperture: cardCamera.aperture, height_m: cardCamera.height_m,
              focus_distance_m: cardCamera.focus_distance_m },
        ],
        direction: [director.direction || '', scene.direction || ''],
        lighting: [director.lighting || null, scene.lighting || null],
        location_view: [director.location_view || '', scene.location_view || ''],
        characters: [staged.filter(n => chars.has(n)), normalizeNames(scene.characters || [])],
        props: [staged.filter(n => props.has(n)), normalizeNames(scene.props || [])],
        movement: [{ movement: row.movement || null, moves }, cardCamera.movement || null],
    };
    const out = {};
    for (const chip of DECISION_CHIPS) {
        const [stage, onCard] = pairs[chip.id];
        const stageHas = chip.id === 'movement' ? !!(row.movement || moves.length) : present(stage);
        out[chip.id] = { stage: hash(stage), card: hash(onCard), has: stageHas };
    }
    return out;
}

module.exports = { DECISIONS, EXCEPTIONS, DECISION_CHIPS, directorIntentFromCard, applyDirectorIntent, applicationFingerprints, decisionParts, normalizeNames };
