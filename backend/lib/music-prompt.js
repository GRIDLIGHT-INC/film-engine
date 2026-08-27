/**
 * FILM-090-093: Music Prompt Builder
 *
 * Pure functions for building music, SFX, and ambient generation payloads
 * from scene cards, music cues, and location data. No DB dependency.
 */

// ── Mood → Music Mapping ────────────────────────────────────────────

const MOOD_TO_MUSIC = {
    'tense': { tempo_range: [80, 110], instruments: ['strings', 'piano', 'low brass'], energy: 0.4, genre_hint: 'thriller' },
    'suspenseful': { tempo_range: [70, 100], instruments: ['strings', 'timpani', 'synth pad'], energy: 0.3, genre_hint: 'suspense' },
    'joyful': { tempo_range: [120, 140], instruments: ['acoustic guitar', 'ukulele', 'piano', 'flute'], energy: 0.8, genre_hint: 'pop' },
    'melancholic': { tempo_range: [60, 90], instruments: ['piano', 'cello', 'violin'], energy: 0.3, genre_hint: 'classical' },
    'romantic': { tempo_range: [70, 100], instruments: ['piano', 'strings', 'acoustic guitar'], energy: 0.4, genre_hint: 'romance' },
    'epic': { tempo_range: [100, 140], instruments: ['full orchestra', 'choir', 'timpani', 'brass'], energy: 0.9, genre_hint: 'orchestral' },
    'calm': { tempo_range: [60, 80], instruments: ['piano', 'acoustic guitar', 'ambient pad'], energy: 0.2, genre_hint: 'ambient' },
    'dark': { tempo_range: [60, 90], instruments: ['low strings', 'synth bass', 'distorted drone'], energy: 0.4, genre_hint: 'dark ambient' },
    'action': { tempo_range: [130, 160], instruments: ['drums', 'electric guitar', 'brass', 'synth'], energy: 0.9, genre_hint: 'action' },
    'mysterious': { tempo_range: [70, 100], instruments: ['harp', 'celeste', 'strings pizzicato', 'wind chimes'], energy: 0.3, genre_hint: 'mystery' },
    'comedic': { tempo_range: [110, 140], instruments: ['pizzicato strings', 'xylophone', 'tuba', 'clarinet'], energy: 0.6, genre_hint: 'comedy' },
    'horror': { tempo_range: [50, 80], instruments: ['dissonant strings', 'prepared piano', 'reverse cymbal'], energy: 0.3, genre_hint: 'horror' },
    'uplifting': { tempo_range: [100, 130], instruments: ['piano', 'strings', 'acoustic guitar', 'light drums'], energy: 0.7, genre_hint: 'inspirational' },
    'nostalgic': { tempo_range: [70, 100], instruments: ['piano', 'music box', 'strings'], energy: 0.3, genre_hint: 'nostalgia' },
};

// ── Location → Ambient Sound Mapping ────────────────────────────────

// Ambient loop bounds. The ceiling is the shortest limit across the ambient
// generators we support (ElevenLabs sound-generation caps at 30s), and the
// floor is that same endpoint's minimum. A loop is never longer than the bed it
// has to fill — a 4-second scene gets a 4-second loop, not a padded 30.
const AMBIENT_LOOP_MIN_S = 0.5;
const AMBIENT_LOOP_MAX_S = 30;
const DEFAULT_AMBIENT_BED_MS = 60000;

const LOCATION_TO_AMBIENT = {
    'office': 'quiet office ambiance, distant keyboard typing, air conditioning hum, muffled phone ringing',
    'street': 'city street sounds, passing cars, distant sirens, pedestrian footsteps, pigeons',
    'forest': 'forest ambiance, birdsong, rustling leaves, gentle wind, distant stream',
    'beach': 'ocean waves crashing, seagulls, gentle wind, distant conversation',
    'restaurant': 'restaurant ambiance, clinking glasses, muffled conversation, light background music',
    'bar': 'bar ambiance, glasses clinking, jukebox music, pool balls, muffled chatter',
    'hospital': 'hospital ambiance, beeping monitors, distant PA announcements, footsteps on linoleum',
    'car': 'car interior, engine hum, road noise, occasional turn signal',
    'subway': 'subway ambiance, train rumble, announcements, crowd noise, doors closing',
    'park': 'park ambiance, children playing, birdsong, dog barking, wind in trees',
    'library': 'library silence, page turning, distant whisper, clock ticking',
    'warehouse': 'warehouse ambiance, echo, distant machinery, dripping water',
    'church': 'church ambiance, reverberant space, distant organ, creaking pews',
    'apartment': 'apartment ambiance, muffled TV from neighbor, traffic outside, heating system',
    'courtroom': 'courtroom ambiance, murmuring gallery, gavel, paper shuffling',
    'school': 'school hallway, distant bell, children talking, lockers closing',
    'airport': 'airport ambiance, flight announcements, rolling luggage, distant jet engines',
    'rain': 'heavy rain on windows, thunder rumbling, rain on pavement',
};

// ── Time of Day → Ambient Modifier ──────────────────────────────────

const TIME_AMBIENT_MODIFIER = {
    'day': '', // No modifier
    'night': ', nighttime atmosphere, quieter, occasional distant sound',
    'dawn': ', early morning, birds waking up, quiet',
    'dusk': ', evening atmosphere, cicadas, settling quiet',
    'morning': ', morning activity, birds chirping',
    'evening': ', evening wind down, distant sounds',
};

/**
 * Build a music generation payload from a music cue and scene context.
 *
 * @param {object} musicCue - film_music_cues row
 * @param {object} scene - film_scenes row
 * @param {object} project - film_projects row
 * @returns {object} Payload for POST /music (type: 'score')
 */
/**
 * @param {object} musicCue
 * @param {object} scene
 * @param {object} [project]
 * @param {{db?: object}} [opts] a database handle for measuring the cut. Left
 *        out, one is required lazily — so every existing caller measures the
 *        real length with no change at the call site, which is the point.
 */
function buildMusicPrompt(musicCue, scene, project, opts) {
    const cue = musicCue || {};
    const mood = cue.mood || 'calm';
    const moodConfig = MOOD_TO_MUSIC[mood] || MOOD_TO_MUSIC['calm'];

    const promptParts = [];

    /*
     * "Sounds like X" is the clearest music note a director gives, and
     * `reference_track` was stored and read by nothing. Named as a REFERENCE
     * rather than pasted in raw, so it reads as a style to match instead of a
     * title to quote.
     */
    if (cue.reference_track) {
        promptParts.push(`in the style of ${String(cue.reference_track).trim()}`);
    }

    // Cue description or auto-generated
    if (cue.description) {
        promptParts.push(cue.description);
    } else {
        promptParts.push(`${mood} ${moodConfig.genre_hint} instrumental soundtrack`);
    }

    // Genre
    if (cue.genre) {
        promptParts.push(cue.genre);
    }

    // Instruments
    const instruments = cue.instruments
        ? (typeof cue.instruments === 'string' ? JSON.parse(cue.instruments) : cue.instruments)
        : moodConfig.instruments;
    if (instruments && instruments.length > 0) {
        promptParts.push(instruments.join(', '));
    }

    // Project style hint
    if (project && project.genre) {
        promptParts.push(`${project.genre} film score`);
    }

    /*
     * THE LENGTH OF THE CUT, not an estimate.
     *
     * In order: what the composer asked for, then the measured length of the
     * footage in this scene, then thirty seconds. The middle one is new and is
     * the one that matters — `scene.estimated_duration` is 0 on every real
     * scene, and 0 is falsy, so every cue was written at the default.
     *
     * A cue longer than the cut is a legitimate choice — an underscore running
     * past a scene is ordinary — so an explicit `duration_ms` still wins.
     */
    let durationMs = null;
    let durationSource = 'default';
    let durationNote = null;

    if (cue.duration_ms) {
        durationMs = cue.duration_ms;
        durationSource = 'cue';
    } else if (scene && scene.id) {
        try {
            // Lazily required rather than demanded at the call site: this
            // module is used by the route, the orchestrator and the flow
            // canvas, and threading a handle through all three to fix one
            // number is how two of them end up still guessing.
            const handle = (opts && opts.db) || require('../db/database').db;
            const measured = require('./clip-coverage').sceneCutLength(handle, scene.id);
            if (measured) { durationMs = measured; durationSource = 'measured'; }
        } catch (_) { /* a measurement that fails must not stop a generation */ }
    }
    if (!durationMs && scene && scene.estimated_duration) {
        durationMs = scene.estimated_duration;
        durationSource = 'estimate';
    }
    if (!durationMs) {
        durationMs = 30000;
        durationSource = 'default';
        // A silent default is the problem, not the default. Told this, a
        // director can shoot the scene first or set the cue length by hand.
        durationNote = 'No footage has been measured for this scene yet, so the cue is 30 seconds. '
            + 'Generate the shots first, or set the cue length by hand, to score the real cut.';
    }
    const durationS = durationMs / 1000;

    // Tempo
    const tempoBpm = cue.tempo_bpm || Math.round(
        (moodConfig.tempo_range[0] + moodConfig.tempo_range[1]) / 2
    );

    return {
        type: 'score',
        prompt: promptParts.join(', '),
        duration_s: durationS,
        duration_source: durationSource,
        ...(durationNote ? { duration_note: durationNote } : {}),
        model: 'musicgen-large',
        tempo_bpm: tempoBpm,
        key: cue.key_signature || '',
        genre: cue.genre || moodConfig.genre_hint,
        mood,
        energy: moodConfig.energy,
        instruments: instruments || [],
        output_format: 'wav',
        sample_rate: 44100,
        seed: cue.seed || null,
        loopable: false,
        stream: true,
    };
}

/**
 * Build an SFX generation payload from a scene card.
 * Extracts action-based sound effects.
 *
 * @param {object} sceneCard - Parsed scene_card_yaml
 * @param {object} scene - film_scenes row
 * @returns {Array<object>} Array of payloads for POST /music (type: 'sfx')
 */
function buildSFXPrompts(sceneCard, scene) {
    const sfxCues = [];

    // Extract from explicit sfx_cues if present
    if (sceneCard.sfx_cues && Array.isArray(sceneCard.sfx_cues)) {
        for (const cue of sceneCard.sfx_cues) {
            sfxCues.push({
                type: 'sfx',
                prompt: cue.description || cue.sound,
                duration_s: cue.duration_s || 3.0,
                model: 'audiogen',
                category: cue.category || 'foley',
                output_format: 'wav',
                sample_rate: 48000,
                seed: null,
                stream: true,
            });
        }
    }

    return sfxCues;
}

/**
 * Build an ambient audio generation payload from scene context.
 *
 * @param {object} scene - film_scenes row
 * @param {object|null} location - film_locations row
 * @returns {object} Payload for POST /music (type: 'ambient')
 */
function buildAmbientPrompt(scene, location) {
    let promptParts = [];

    // Try to match location to known ambient
    const locationName = (scene.location || '').toLowerCase();
    let matchedAmbient = null;
    for (const [key, ambient] of Object.entries(LOCATION_TO_AMBIENT)) {
        if (locationName.includes(key)) {
            matchedAmbient = ambient;
            break;
        }
    }

    if (matchedAmbient) {
        promptParts.push(matchedAmbient);
    } else if (location && location.description) {
        promptParts.push(`ambient sounds of ${location.description}`);
    } else if (scene.location) {
        promptParts.push(`ambient sounds of ${scene.location}`);
    } else {
        promptParts.push('quiet room ambiance');
    }

    // INT/EXT modifier
    if (scene.int_ext === 'EXT') {
        promptParts.push('outdoor');
    }

    // Time of day modifier
    const timeKey = (scene.time_of_day || 'day').toLowerCase();
    const timeMod = TIME_AMBIENT_MODIFIER[timeKey] || '';
    if (timeMod) {
        promptParts.push(timeMod.trim().replace(/^,\s*/, ''));
    }

    // An ambient bed is a loop, not a full-length render. Scenes run minutes and
    // generators cap well below that, so we ask for a short seamless loop and
    // tile it to length at mix time (see buildMixPayload). duration_s is the
    // LOOP; bed_duration_s is what that loop has to cover.
    const bedMs = scene.estimated_duration || DEFAULT_AMBIENT_BED_MS;
    const bedSeconds = bedMs / 1000;
    const loopSeconds = Math.max(AMBIENT_LOOP_MIN_S, Math.min(AMBIENT_LOOP_MAX_S, bedSeconds));

    return {
        type: 'ambient',
        prompt: promptParts.join(', '),
        duration_s: loopSeconds,
        bed_duration_s: bedSeconds,
        model: 'musicgen-ambient',
        loopable: true,
        crossfade_s: 5.0,
        output_format: 'wav',
        sample_rate: 44100,
        seed: null,
        stream: true,
    };
}

module.exports = {
    buildMusicPrompt,
    buildSFXPrompts,
    buildAmbientPrompt,
    MOOD_TO_MUSIC,
    LOCATION_TO_AMBIENT,
    TIME_AMBIENT_MODIFIER,
};
