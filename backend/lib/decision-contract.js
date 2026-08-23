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
        covers: ['stage_json', 'rig', 'movement', 'path_json', 'moves_json', 'duration_ms'],
        why: 'These are Previs-native spatial and timing decisions. Their semantic projection reaches generation, but raw coordinates and sampled paths do not belong in the Shot Board form.',
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
            camera: { focalMm: camera.focalMm, sensorId: camera.sensorId, fStop: camera.fStop,
                heightM: Array.isArray(camera.position) ? camera.position[1] : undefined,
                focusDistanceM: camera.focusDistanceM },
            movement: row.movement,
            director,
            names: known.size ? stagedNames.filter(name => known.has(name)) : stagedNames,
        };
    const projectedCard = {
            camera: { lens: cardCamera.lens, movement: cardCamera.movement, sensor: cardCamera.sensor,
                aperture: cardCamera.aperture, height_m: cardCamera.height_m,
                focus_distance_m: cardCamera.focus_distance_m },
            direction: scene.direction || '', location_view: scene.location_view || '',
            lighting: scene.lighting || null,
            characters: normalizeNames(scene.characters || []), props: normalizeNames(scene.props || []),
    };
    const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
    return { stage: hash(staged), card: hash(projectedCard) };
}

module.exports = { DECISIONS, EXCEPTIONS, directorIntentFromCard, applyDirectorIntent, applicationFingerprints, normalizeNames };
