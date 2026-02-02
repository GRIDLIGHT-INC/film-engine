/**
 * FILM-027 / FILM-039: Viseme Track Generation
 *
 * Maps phonemes to viseme mouth shapes and generates timed viseme tracks
 * for lip-sync animation. Supports standard MPEG-4 viseme set (15 visemes).
 *
 * Exports:
 *  - VISEME_MAP: phoneme → viseme mapping
 *  - VISEME_LIST: all 15 viseme codes
 *  - textToPhonemes(text) → phoneme array (approximate, English)
 *  - phonemesToVisemes(phonemes) → viseme array
 *  - buildVisemeTrack(text, durationMs, speed) → { visemes: [{ viseme, start_ms, end_ms }], duration_ms }
 *  - mergeVisemesWithAudio(visemeTrack, audioTimings) → adjusted track
 *  - buildVisemePayload(dialogueLine, voiceProfile) → payload for external viseme API
 */

// MPEG-4 standard viseme set (15 visemes)
const VISEME_LIST = [
    'sil',   // 0  - silence / rest
    'PP',    // 1  - p, b, m
    'FF',    // 2  - f, v
    'TH',    // 3  - th (theta, eth)
    'DD',    // 4  - t, d, n
    'kk',    // 5  - k, g, ng
    'CH',    // 6  - ch, j, sh, zh
    'SS',    // 7  - s, z
    'nn',    // 8  - n, l
    'RR',    // 9  - r
    'aa',    // 10 - a (father)
    'E',     // 11 - e (bed)
    'ih',    // 12 - i (bit)
    'oh',    // 13 - o (go)
    'ou',    // 14 - u (boot), oo
];

// Phoneme → viseme mapping (ARPAbet-like to MPEG-4 viseme)
const VISEME_MAP = {
    // Bilabials
    'P': 'PP', 'B': 'PP', 'M': 'PP',
    // Labiodentals
    'F': 'FF', 'V': 'FF',
    // Dentals
    'TH': 'TH', 'DH': 'TH',
    // Alveolars
    'T': 'DD', 'D': 'DD',
    // Velars
    'K': 'kk', 'G': 'kk', 'NG': 'kk',
    // Post-alveolars
    'CH': 'CH', 'JH': 'CH', 'SH': 'CH', 'ZH': 'CH',
    // Sibilants
    'S': 'SS', 'Z': 'SS',
    // Nasals & liquids
    'N': 'nn', 'L': 'nn',
    // Rhotics
    'R': 'RR',
    // Vowels
    'AA': 'aa', 'AE': 'aa', 'AH': 'aa',
    'EH': 'E', 'ER': 'E', 'EY': 'E',
    'IH': 'ih', 'IY': 'ih',
    'AO': 'oh', 'OW': 'oh', 'OY': 'oh',
    'UH': 'ou', 'UW': 'ou', 'W': 'ou',
    'Y': 'ih',
    'HH': 'sil',
    // Silence
    'SIL': 'sil', 'SP': 'sil',
};

// Simple English letter-to-phoneme rules (approximate, no dictionary needed)
const LETTER_PHONEME_MAP = {
    'a': 'AA', 'b': 'B', 'c': 'K', 'd': 'D', 'e': 'EH',
    'f': 'F', 'g': 'G', 'h': 'HH', 'i': 'IH', 'j': 'JH',
    'k': 'K', 'l': 'L', 'm': 'M', 'n': 'N', 'o': 'OW',
    'p': 'P', 'q': 'K', 'r': 'R', 's': 'S', 't': 'T',
    'u': 'UH', 'v': 'V', 'w': 'W', 'x': 'K', 'y': 'Y', 'z': 'Z',
};

const DIGRAPH_PHONEME_MAP = {
    'th': 'TH', 'sh': 'SH', 'ch': 'CH', 'ph': 'F',
    'ng': 'NG', 'wh': 'W', 'oo': 'UW', 'ee': 'IY',
    'ou': 'UW', 'ow': 'OW', 'ai': 'EY', 'ea': 'IY',
};

/**
 * Convert text to approximate phoneme sequence (English).
 * This is a simplified rule-based approach; real systems use G2P models.
 */
function textToPhonemes(text) {
    if (!text || typeof text !== 'string') return [];

    const normalized = text.toLowerCase().replace(/[^a-z\s]/g, '');
    const words = normalized.split(/\s+/).filter(Boolean);
    const phonemes = [];

    for (const word of words) {
        if (phonemes.length > 0) phonemes.push('SP'); // word boundary
        let i = 0;
        while (i < word.length) {
            const digraph = word.slice(i, i + 2);
            if (i + 1 < word.length && DIGRAPH_PHONEME_MAP[digraph]) {
                phonemes.push(DIGRAPH_PHONEME_MAP[digraph]);
                i += 2;
            } else {
                const ph = LETTER_PHONEME_MAP[word[i]];
                if (ph) phonemes.push(ph);
                i++;
            }
        }
    }

    return phonemes;
}

/**
 * Convert phoneme array to viseme array.
 */
function phonemesToVisemes(phonemes) {
    if (!Array.isArray(phonemes)) return [];
    return phonemes.map(ph => VISEME_MAP[ph] || 'sil');
}

/**
 * Build a timed viseme track from text.
 *
 * @param {string} text - The dialogue text
 * @param {number} durationMs - Total duration of the audio in ms
 * @param {number} [speed=1.0] - Speech speed multiplier
 * @returns {{ visemes: Array<{viseme: string, start_ms: number, end_ms: number, phoneme: string}>, duration_ms: number, phoneme_count: number }}
 */
function buildVisemeTrack(text, durationMs, speed) {
    const spd = speed || 1.0;
    const dur = durationMs || estimateDuration(text, spd);

    const phonemes = textToPhonemes(text);
    if (phonemes.length === 0) {
        return { visemes: [{ viseme: 'sil', start_ms: 0, end_ms: dur, phoneme: 'SIL' }], duration_ms: dur, phoneme_count: 0 };
    }

    const visemeFrames = [];
    const timePerPhoneme = dur / phonemes.length;

    for (let i = 0; i < phonemes.length; i++) {
        const viseme = VISEME_MAP[phonemes[i]] || 'sil';
        const startMs = Math.round(i * timePerPhoneme);
        const endMs = Math.round((i + 1) * timePerPhoneme);

        // Merge consecutive identical visemes
        if (visemeFrames.length > 0 && visemeFrames[visemeFrames.length - 1].viseme === viseme) {
            visemeFrames[visemeFrames.length - 1].end_ms = endMs;
        } else {
            visemeFrames.push({
                viseme,
                start_ms: startMs,
                end_ms: endMs,
                phoneme: phonemes[i],
            });
        }
    }

    return {
        visemes: visemeFrames,
        duration_ms: dur,
        phoneme_count: phonemes.length,
    };
}

/**
 * Merge/adjust a viseme track with actual audio timing data.
 * Audio timings come from the voice generation service (word-level timestamps).
 */
function mergeVisemesWithAudio(visemeTrack, audioTimings) {
    if (!audioTimings || !Array.isArray(audioTimings) || audioTimings.length === 0) {
        return visemeTrack;
    }

    // audioTimings: [{ word, start_ms, end_ms }]
    // Re-distribute visemes across the actual audio word timings
    const newVisemes = [];
    let visemeIdx = 0;
    const originalVisemes = visemeTrack.visemes;

    for (const wordTiming of audioTimings) {
        const wordPhonemes = textToPhonemes(wordTiming.word);
        if (wordPhonemes.length === 0) continue;

        const timePerPh = (wordTiming.end_ms - wordTiming.start_ms) / wordPhonemes.length;

        for (let i = 0; i < wordPhonemes.length; i++) {
            const viseme = VISEME_MAP[wordPhonemes[i]] || 'sil';
            const startMs = Math.round(wordTiming.start_ms + i * timePerPh);
            const endMs = Math.round(wordTiming.start_ms + (i + 1) * timePerPh);

            if (newVisemes.length > 0 && newVisemes[newVisemes.length - 1].viseme === viseme) {
                newVisemes[newVisemes.length - 1].end_ms = endMs;
            } else {
                newVisemes.push({ viseme, start_ms: startMs, end_ms: endMs, phoneme: wordPhonemes[i] });
            }
        }
    }

    return {
        visemes: newVisemes.length > 0 ? newVisemes : visemeTrack.visemes,
        duration_ms: visemeTrack.duration_ms,
        phoneme_count: visemeTrack.phoneme_count,
        audio_aligned: newVisemes.length > 0,
    };
}

/**
 * Build payload for external viseme generation API (if using server-side G2P).
 */
function buildVisemePayload(dialogueLine, voiceProfile) {
    const line = dialogueLine || {};
    const profile = voiceProfile || {};

    return {
        text: line.line || line.text || '',
        language: profile.language || 'en',
        model: profile.viseme_model || 'phoneme-to-viseme-v1',
        format: 'mpeg4',
        include_phonemes: true,
        include_timings: true,
        speed: profile.speed || 1.0,
    };
}

function estimateDuration(text, speed) {
    if (!text) return 1000;
    // ~150 words per minute, ~5 chars per word
    const chars = text.length;
    const words = chars / 5;
    const minutes = words / 150;
    return Math.max(500, Math.round((minutes * 60 * 1000) / (speed || 1.0)));
}

module.exports = {
    VISEME_LIST,
    VISEME_MAP,
    LETTER_PHONEME_MAP,
    DIGRAPH_PHONEME_MAP,
    textToPhonemes,
    phonemesToVisemes,
    buildVisemeTrack,
    mergeVisemesWithAudio,
    buildVisemePayload,
};
