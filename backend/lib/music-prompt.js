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
/**
 * The prompt, within the ceiling, with the musical words kept.
 *
 * A music model is being asked what the cue SOUNDS like. Measured on The Glass
 * Harbour, the assembled prompt came out over three thousand characters,
 * because `film_scenes.description` there is the whole scene's action — camera
 * moves, blocking, every beat — and the instruments and genre sat at the very
 * end, where a truncating model drops them first.
 *
 * So the trim takes from the FRONT: the description is the longest part and the
 * least musical, and cutting the instruments to keep a camera move would be the
 * wrong trade every time. Cut at a sentence boundary where possible, so the
 * model does not read half a thought.
 */
/**
 * Fit the cue into the prompt ceiling, cutting what matters least.
 *
 * This was `[first, ...rest]`: summarise the first part, keep the tail whole.
 * It broke in BOTH directions. `reference_track` was pushed before the
 * description, so the trim ate the reference and returned a 1039-character
 * prompt against a 600 ceiling; and once the facts were spoken the tail grew
 * past the ceiling on its own, so the fallback returned the tail and dropped
 * the DESCRIPTION — the field the contract calls "the one that matters most".
 *
 * So the parts are RANKED, the way `fitAdditions` ranks an image prompt, and
 * for the same reason: with limited room, deciding what to cut is a judgement
 * and a positional accident is not one.
 *
 *   0  the description        what the music DOES. Trimmable, with a floor.
 *   1  key and tempo          tiny, exact, and unguessable from prose.
 *   2  genre                  what kind of music this is.
 *   3  mood                   how it feels.
 *   4  instruments            what plays it.
 *   5  reference              "sounds like X" — the longest of the short parts.
 *   6  the project's genre    context, and the first thing to lose.
 *
 * The description keeps a FLOOR rather than a share: a cue reduced to
 * `orchestral, D major, 60 bpm` has lost the brief entirely, and the whole
 * point of the field is that it says what the music does against the scene.
 */
const DESCRIPTION_FLOOR = 180;
const REFERENCE_MAX_CHARS = 140;

/**
 * Cut prose at a CLAUSE boundary, not mid-thought.
 *
 * A word-boundary cut left the reference ending `...opens with one fragile
 * instrument and` — the last thing the model reads is a dangling conjunction,
 * which is worse than the shorter phrase would have been. The video prompt
 * already states the rule: cut so the last thing read is complete.
 */
function toClause(text) {
    let out = String(text || '').trim().replace(/[,;—-]\s*$/, '');
    const cut = Math.max(out.lastIndexOf(', '), out.lastIndexOf(' — '), out.lastIndexOf('; '));
    if (/\s(and|but|or|with|that|which|of|to|the|a|an|into|from)$/i.test(out) && cut > 20) {
        out = out.slice(0, cut);
    }
    return out.replace(/[,;—-]\s*$/, '').trim();
}

/**
 * THE LIMIT IS FOR A DERIVED PROMPT. A WRITTEN ONE IS NOT THE SAME THING.
 *
 * `MUSIC_PROMPT_LIMIT` is 600 characters and `scene-score` says plainly where
 * it came from: ElevenLabs documents no character limit for /music, so the
 * number is OURS, chosen because a prompt DERIVED from `film_scenes.description`
 * came out over three thousand characters of camera blocking with the musical
 * words at the very end.
 *
 * That reasoning is right about a derivation and wrong about a brief. A cue a
 * director wrote is already about the music — every sentence of it is the
 * musical direction — and capping it at 600 cuts the part that matters.
 *
 * Measured on this project's ident fanfare, a 1,562-character brief reached the
 * generator as:
 *
 *   "...the moment before a film begins at a drive-in, when the engines are
 *    off, the light is, in D major, 60 bpm, orchestral..."
 *
 * Cut mid-clause at "the light is". Everything after it was lost: the harp and
 * celeste opening, the horn MELODY on rising fourths and fifths, the earned
 * resolution, the decay to one vibraphone note, and the guards that say never
 * static, never ambient, never a pad. The first take of that cue came back
 * FLAT, the brief was rewritten specifically to fix flatness — and almost none
 * of the rewrite was ever sent.
 *
 * So a written description gets its own, much larger allowance, still ours and
 * still stated. A derivation keeps 600, because the argument for it there is
 * sound.
 */
const WRITTEN_PROMPT_LIMIT = Number(process.env.MUSIC_WRITTEN_PROMPT_LIMIT || 4000);

function fitMusicPrompt(parts, limitOverride) {
    const { MUSIC_PROMPT_LIMIT: DERIVED_LIMIT, summarise } = require('./scene-score');
    const MUSIC_PROMPT_LIMIT = Number(limitOverride) > 0 ? Number(limitOverride) : DERIVED_LIMIT;
    const list = (Array.isArray(parts) ? parts : [])
        .map(p => (typeof p === 'string' ? { text: p, rank: 2 } : p))
        .filter(p => p && String(p.text || '').trim());

    const joined = list.map(p => p.text).join(', ');
    if (joined.length <= MUSIC_PROMPT_LIMIT) return joined;

    const described = list.find(p => p.rank === 0);
    const others = list.filter(p => p !== described).sort((a, b) => a.rank - b.rank);

    /*
     * The short facts first, in rank order, while they fit — leaving the
     * description its floor. Then the description takes whatever is left.
     */
    const reserve = described ? DESCRIPTION_FLOOR + 2 : 0;
    const kept = [];
    let used = 0;
    for (const part of others) {
        const cost = part.text.length + (kept.length ? 2 : 0);
        if (used + cost > MUSIC_PROMPT_LIMIT - reserve) continue;   // skipped, not truncated
        kept.push(part);
        used += cost;
    }

    if (!described) return kept.map(p => p.text).join(', ');

    const room = MUSIC_PROMPT_LIMIT - used - (kept.length ? 2 : 0);
    // Trailing full stop stripped: the parts are comma-joined, and `…brass., in
    // D major` reads as two sentences colliding rather than one list.
    const head = summarise(described.text, Math.max(DESCRIPTION_FLOOR, room)).replace(/\.\s*$/, '');

    /*
     * No second pass to reclaim the reserve. There was one, and once
     * `reference_track` was capped to a phrase nothing was ever skipped for
     * size any more — so it never fired on any cue that could be constructed,
     * including a maximal one with fourteen instruments. Unexercised code that
     * looks like a safeguard is worse than none: it reads as covering a case
     * nobody has checked.
     */
    return [head, ...kept.map(p => p.text)].filter(Boolean).join(', ');
}

function buildMusicPrompt(musicCue, scene, project, opts) {
    const cue = musicCue || {};
    const mood = cue.mood || 'calm';
    const moodConfig = MOOD_TO_MUSIC[mood] || MOOD_TO_MUSIC['calm'];

    /*
     * THE DESCRIPTION LEADS, AND IT IS WHAT GIVES WAY.
     *
     * `fitMusicPrompt` summarises `parts[0]` and keeps the rest whole, and its
     * own comment says why: the description is the longest part and the least
     * musical. That was true and the description was NOT parts[0] --
     * `reference_track` was pushed before it. So on any cue whose description
     * runs long the trim summarised the REFERENCE away, and with the remaining
     * tail already over the ceiling it returned that tail whole: a 1039
     * character prompt against a 600 limit, missing the one note a director
     * cares most about. Measured on the real DRIVE-IN cue.
     */
    const promptParts = [];

    promptParts.push({ rank: 0, text: cue.description
        || `${mood} ${moodConfig.genre_hint} instrumental soundtrack` });

    /*
     * THE MUSICAL FACTS, SAID OUT LOUD.
     *
     * `mood`, `tempo_bpm` and `key_signature` were returned as fields on the
     * payload -- `payload.mood`, `payload.tempo_bpm`, `payload.key` -- and
     * ElevenLabs reads none of them: /music takes a prompt STRING, so anything
     * not in it is a knob the director watches reach nothing. The mood was
     * consulted only as an index into a table of default instruments and a
     * tempo range; it was never spoken.
     *
     * They are short, they are load-bearing, and they follow the description
     * precisely so the trim above can never be what removes them.
     *
     * ONLY WHAT WAS WRITTEN. A tempo derived from the mood table is a guess,
     * and a guessed tempo in the prompt is indistinguishable from a chosen one
     * -- the mistake this engine has already paid for on lenses and on subject
     * scale. The derived value still travels as `tempo_bpm` for callers that
     * want a number; it is not asserted to the model as the director's.
     */
    if (cue.genre) promptParts.push({ rank: 2, text: cue.genre });
    if (cue.mood) promptParts.push({ rank: 3, text: String(cue.mood).trim() });

    const instruments = cue.instruments
        ? (typeof cue.instruments === 'string' ? JSON.parse(cue.instruments) : cue.instruments)
        : moodConfig.instruments;
    if (instruments && instruments.length > 0) {
        promptParts.push({ rank: 4, text: instruments.join(', ') });
    }

    if (cue.key_signature) promptParts.push({ rank: 1, text: `in ${String(cue.key_signature).trim()}` });
    if (cue.tempo_bpm) promptParts.push({ rank: 1, text: `${Math.round(Number(cue.tempo_bpm))} bpm` });

    /*
     * "Sounds like X" is the clearest single note a director gives. Named as a
     * REFERENCE rather than pasted in raw, so it reads as a style to match
     * instead of a title to quote.
     */
    if (cue.reference_track) {
        /*
         * Capped, because a reference is a PHRASE. The one on the real cue runs
         * to 232 characters -- longer than every other fact put together -- and
         * carrying it whole pushed the prompt past its ceiling, which meant it
         * was dropped entirely and the clearest note a director gives reached
         * nothing. Its opening is the load-bearing half; the rest elaborates.
         */
        const { summarise } = require('./scene-score');
        promptParts.push({ rank: 5,
            text: `in the style of ${toClause(summarise(String(cue.reference_track).trim(), REFERENCE_MAX_CHARS))}` });
    }

    if (project && project.genre) {
        promptParts.push({ rank: 6, text: `${project.genre} film score` });
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

    /*
     * A cue WITH a description was written by someone; one without it is
     * derived from the scene. Only the first earns the larger allowance — which
     * is the same rule the ambient builder follows two functions down, and the
     * one `music_brief` states outright: a cue somebody wrote always beats the
     * derivation.
     */
    const authored = String(cue.description || '').trim().length > 0;

    return {
        type: 'score',
        prompt: fitMusicPrompt(promptParts, authored ? WRITTEN_PROMPT_LIMIT : 0),
        prompt_source: authored ? 'written' : 'derived',
        /*
         * The same parts, before they were joined.
         *
         * A composition plan wants a LIST of global styles and the prompt is
         * that list printed with commas. Re-splitting the finished string, or
         * writing a second list beside it, is how a sectioned cue and a plain
         * one come to describe different films.
         */
        // Plain strings: a composition plan wants a LIST of styles, and the
        // rank is a budgeting concern that has no meaning to the provider.
        prompt_parts: promptParts.filter(Boolean).map(p => p.text),
        negative_prompt: (cue.negative_prompt || '').trim(),
        sections: Array.isArray(cue.sections) ? cue.sections : [],
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
        sample_rate: 48000,
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
        for (const raw of sceneCard.sfx_cues) {
            /*
             * A cue may be a STRING or an object, like every other list on a
             * scene card — characters and props both take either.
             *
             * Found on the live database: two shots carry string cues, and
             * reading `cue.description` off a string gives undefined, so both
             * would have generated a request with NO PROMPT — a paid call with
             * nothing in it, or a provider rejection, and neither says why. The
             * MCP tool describes sfx_cues as "an array" with no shape, so an
             * agent writing strings is doing the obvious thing.
             */
            const cue = typeof raw === 'string' ? { description: raw } : (raw || {});
            const text = String(cue.description || cue.sound || '').trim();
            // A cue with nothing usable in it is DROPPED rather than sent
            // empty: a request with no prompt costs money and returns noise.
            if (!text) continue;
            sfxCues.push({
                type: 'sfx',
                prompt: text,
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
/**
 * The bed a scene sits in.
 *
 * This read the scene's LOCATION NAME and its TIME OF DAY and nothing else, so
 * every ambient bed in a production was assembled from a lookup table and a
 * director had no way to say a word about it. Two things it never read:
 *
 * `film_locations.sound_notes` — a column called sound notes, with a textarea on
 * the Locations page placeholdered "Traffic two streets over, a screen door,
 * gulls...", stored since migration 006 and reaching nothing but the call sheet.
 * The one field in this database whose entire purpose is to describe how a place
 * SOUNDS was invisible to the only thing that generates how a place sounds.
 *
 * `direction` — what this scene needs, as opposed to what the place is like.
 * The room tone of a diner is a property of the diner; "the fridge compressor
 * cuts out halfway through" is a property of the scene, and the two are
 * different notes that were both unsayable.
 *
 * The direction LEADS, because it is the specific thing about this scene; the
 * place and the hour follow. Nothing is invented — a scene with neither gets
 * exactly the bed it got before.
 */
function buildAmbientPrompt(scene, location, opts) {
    let promptParts = [];
    const options = opts || {};

    const direction = String(options.direction || '').trim();
    if (direction) promptParts.push(direction);

    /*
     * A CUE SOMEBODY WROTE BEATS THE DERIVATION — INCLUDING BY SILENCE.
     *
     * This appended the location's generic ambience, the INT/EXT modifier and a
     * time-of-day modifier on TOP of whatever the director wrote, unconditionally.
     * For a bed that nobody briefed that is the whole value of the function. For
     * a written cue it is the derivation arguing with the brief.
     *
     * It is not a cosmetic overlap. A diegetic element — a radio playing out of
     * a drive-in speaker — was briefed as exactly that and sent as
     *
     *   "...cone crackle, carrier hiss., ambient sounds of DRIVE-IN THEATRE - LOT,
     *    outdoor, nighttime atmosphere, quieter, occasional distant sound"
     *
     * so the generator was asked for a tinny radio AND for the open-air lot it
     * is heard in, at once, while the cue's own negative prompt was busy
     * excluding crickets. The scene already has a separate bed cue for the lot;
     * this one asked for the lot a second time and diluted the thing it was for.
     *
     * It also blew the provider's limit: ElevenLabs documents 450 characters and
     * a written brief plus this tail reached 461, so the call 400'd on length
     * for a prompt the author never saw.
     *
     * So the derivation now fills a GAP rather than decorating an answer.
     */
    if (!direction) {
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
    }

    // What the location's own sound notes say. Appended rather than leading:
    // it describes the place in general, and the scene's direction is about
    // this scene.
    const soundNotes = String((location && location.sound_notes) || '').trim();
    if (!direction && soundNotes) promptParts.push(soundNotes);

    // INT/EXT and time-of-day modifiers, on the same terms: they describe the
    // place in general, and a written cue has already said where it is.
    if (!direction) {
        if (scene.int_ext === 'EXT') promptParts.push('outdoor');
        const timeKey = (scene.time_of_day || 'day').toLowerCase();
        const timeMod = TIME_AMBIENT_MODIFIER[timeKey] || '';
        if (timeMod) promptParts.push(timeMod.trim().replace(/^,\s*/, ''));
    }

    // An ambient bed is a loop, not a full-length render. Scenes run minutes and
    // generators cap well below that, so we ask for a short seamless loop and
    // tile it to length at mix time (see buildMixPayload). duration_s is the
    // LOOP; bed_duration_s is what that loop has to cover.
    /*
     * How long the bed has to cover.
     *
     * `scene.estimated_duration` is 0 on every scene in every real project, and
     * 0 is falsy — so this fell to a 30-second default for a scene of any
     * length, exactly as the SCORE did until it was measured. The caller passes
     * what the cut actually measures; the fallback is named rather than silent.
     */
    const measured = Number(options.bed_ms) > 0 ? Number(options.bed_ms) : 0;
    const bedMs = measured || scene.estimated_duration || DEFAULT_AMBIENT_BED_MS;
    const bedSeconds = bedMs / 1000;
    const loopSeconds = Math.max(AMBIENT_LOOP_MIN_S, Math.min(AMBIENT_LOOP_MAX_S, bedSeconds));

    /*
     * The provider's documented ceiling, enforced here rather than discovered as
     * a 400. ElevenLabs takes 450 characters; a prompt assembled past that
     * failed the whole call, and the author could not have known because the
     * assembled string is not what they wrote. Trimmed at a boundary so the
     * tail reads as a sentence rather than a severed word.
     */
    const AMBIENT_PROMPT_MAX = 450;
    let prompt = promptParts.join(', ');
    if (prompt.length > AMBIENT_PROMPT_MAX) {
        const cut = prompt.slice(0, AMBIENT_PROMPT_MAX);
        const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '));
        prompt = (at > AMBIENT_PROMPT_MAX * 0.6 ? cut.slice(0, at) : cut).trim();
    }

    return {
        type: 'ambient',
        prompt,
        prompt_trimmed: promptParts.join(', ').length > AMBIENT_PROMPT_MAX,
        prompt_parts: promptParts.filter(Boolean),
        negative_prompt: String(options.negative_prompt || '').trim(),
        bed_source: measured ? (options.bed_source || 'measured')
            : (scene.estimated_duration ? 'scene estimate' : 'default'),
        duration_s: loopSeconds,
        bed_duration_s: bedSeconds,
        model: 'musicgen-ambient',
        loopable: true,
        crossfade_s: 5.0,
        output_format: 'wav',
        sample_rate: 48000,
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
