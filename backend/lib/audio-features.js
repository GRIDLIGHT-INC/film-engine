/**
 * What a sound file actually IS, read from the file.
 *
 * A card built only from `film_assets` columns describes what was written down
 * when the file was made. That is not the same as what is on disk, and the
 * difference is the whole point of a technical card: an mp3 stored under a
 * `.wav` name, a mono take headed as stereo, a 44.1kHz cue in a 48kHz
 * delivery. Those are all invisible in the row and obvious in the stream.
 *
 * Read with the bundled encoder rather than a dependency — `lib/ffmpeg.js`
 * already resolves one, and this asks it a question rather than doing work.
 */

const fs = require('fs');
const { execFile } = require('child_process');
const { resolveFfmpeg } = require('./ffmpeg');

/**
 * The facts a sound card carries, and where each comes from.
 *
 * `from` is load-bearing and is rendered: a director looking at "48000 Hz"
 * should be able to tell whether that is what we ASKED for or what the file
 * turned out to be. Those disagree more often than anyone expects — every
 * audio file in this library was requested as 'wav' and arrived as 44.1kHz mp3.
 */
const SOUND_FACTS = Object.freeze([
    { id: 'kind',         label: 'What it is',   from: 'row',   what: 'Dialogue, score, effect or room tone — the asset type it was filed under.' },
    { id: 'belongs_to',   label: 'Belongs to',   from: 'link',  what: 'The shot or scene it was made for, and the character when it is a line.' },
    { id: 'duration_ms',  label: 'Length',       from: 'row',   what: 'How long it runs. The difference between a bed that covers the scene and one that stops.' },
    { id: 'size_bytes',   label: 'Size',         from: 'row',   what: 'What it costs to store and to hand over.' },
    { id: 'format',       label: 'Format',       from: 'row',   what: 'The container it was filed as — which is not always what the bytes are.' },
    { id: 'codec',        label: 'Codec',        from: 'probe', what: 'What the stream actually is, read from the file rather than from its name.' },
    { id: 'sample_rate',  label: 'Sample rate',  from: 'probe', what: 'Hz. Video runs at 48k; 44.1k is the CD rate and needs converting on the way in.' },
    { id: 'channels',     label: 'Channels',     from: 'probe', what: 'Mono or stereo. A stereo stream headed as mono plays at double speed.' },
    { id: 'bitrate_kbps', label: 'Bitrate',      from: 'probe', what: 'How much of the sound survived encoding. Low here cannot be recovered later.' },
    { id: 'provider',     label: 'Made by',      from: 'row',   what: 'The provider and model that generated it, or that it was imported.' },
    { id: 'created_at',   label: 'Made',         from: 'row',   what: 'When, so two takes of one line can be told apart.' },
]);

/* Probing spawns a process, and a library page asks for every file at once. */
const cache = new Map();
const MAX_CACHE = 500;

function cacheKey(file) {
    try {
        const st = fs.statSync(file);
        // Size and mtime, never the path alone: a regenerated take is written to
        // the same name, and a path-keyed cache would describe the old sound for
        // ever. The same rule the plate and waveform caches follow.
        return `${file}:${st.size}:${st.mtimeMs}`;
    } catch (_) { return null; }
}

/** Parse what `ffmpeg -i` says about the first audio stream. */
function parseProbe(text) {
    const out = {};
    const stream = /Stream #\d+:\d+[^\n]*: Audio: ([^\n]+)/.exec(text);
    if (!stream) return out;
    const parts = stream[1].split(',').map(s => s.trim());
    if (parts[0]) out.codec = parts[0].split(' ')[0];
    for (const p of parts.slice(1)) {
        const hz = /^(\d+) Hz$/.exec(p);
        if (hz) { out.sample_rate = Number(hz[1]); continue; }
        if (/^mono$/.test(p)) { out.channels = 1; out.channel_layout = 'mono'; continue; }
        if (/^stereo$/.test(p)) { out.channels = 2; out.channel_layout = 'stereo'; continue; }
        const kb = /^(\d+) kb\/s$/.exec(p);
        if (kb) { out.bitrate_kbps = Number(kb[1]); continue; }
        if (/^(fltp|s16|s16p|s32|u8|flt)$/.test(p)) { out.sample_fmt = p; continue; }
    }
    const dur = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(text);
    if (dur) {
        out.duration_ms = Math.round(
            (Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) * 1000);
    }
    return out;
}

/**
 * Read a file's audio features. NEVER throws and never rejects.
 *
 * A card with no technical detail is a card; a page that fails to render
 * because one file is missing or is not audio at all is not. The same rule
 * `stampAsset` and `waveformFor` already follow.
 */
async function featuresFor(file) {
    if (!file) return {};
    const key = cacheKey(file);
    if (!key) return {};                       // gone from disk: nothing to say
    if (cache.has(key)) return cache.get(key);

    let bin;
    try {
        const r = resolveFfmpeg();
        if (!r || !r.available) return {};
        bin = r.bin;
    } catch (_) { return {}; }

    const features = await new Promise((resolve) => {
        // `-i` with no output makes ffmpeg describe the input and exit non-zero,
        // which is the documented way to probe without a separate ffprobe.
        execFile(bin, ['-hide_banner', '-i', file], { timeout: 15000 },
            (err, stdout, stderr) => {
                const text = String(stderr || '') + String(stdout || '');
                try { resolve(parseProbe(text)); } catch (_) { resolve({}); }
            });
    });

    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, features);
    return features;
}

module.exports = { SOUND_FACTS, featuresFor, parseProbe };
