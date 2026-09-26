/**
 * NOTES BECOME SOUND: a cue's MIDI rendered through instruments on this machine.
 *
 * GRD-3995. Phase 1 gave a cue notes; this plays them through a sample library,
 * offline, for nothing per render. The shape is the conform's: an executable
 * PROBED at runtime (never bundled — a library is gigabytes and operator
 * installed), reported when absent, and every result READ BACK before it is
 * believed.
 *
 * Two facts carry it.
 *
 * A SoundFont that LOADS but holds no instrument for a part — a drum part on a
 * font with no percussion bank, a program the library does not cover — renders,
 * exits 0 and writes a file of silence. (A path that does not exist is refused
 * outright by FluidSynth 2.6; the research assumed it rendered silence, and it
 * does not.) A render is therefore judged on its measured VOLUME, never on an
 * exit code or on a stream existing — the stitcher's audio sat at -91 dB for
 * months while every "is there an audio stream" check passed.
 *
 * A render is made of somebody's samples. So the library's licence is recorded
 * with every render, and a library this engine cannot name the licence of is
 * REFUSED rather than recorded as generated — a cue whose instruments' rights
 * are unknown is found at delivery, which is the wrong moment.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

/** What a sample library's licence may be recorded as. */
const LIBRARY_LICENSES = Object.freeze(['cc0', 'mit', 'ni_eula', 'third_party']);

/**
 * The libraries this engine knows the licence of, matched on the file's name.
 * Operator-installed paths only; nothing here is downloaded or bundled.
 */
const LIBRARIES = Object.freeze([
    {
        id: 'vsco-2-ce', name: 'VSCO 2 Community Edition', match: /vsco/i, license: 'cc0',
        role: 'the default orchestra', source: 'https://versilian-studios.com/vsco-community/',
    },
    {
        id: 'fluidr3-gm', name: 'FluidR3 GM', match: /fluidr3/i, license: 'mit',
        role: 'the General MIDI fallback', source: 'https://github.com/musescore/MuseScore/tree/master/share/sound',
    },
]);

/** Renderers considered, and which is wired. An omission that is stated is a decision. */
const RENDERERS = Object.freeze({
    fluidsynth: {
        status: 'wired',
        why: 'active, LGPL, installable with Homebrew (brew install fluid-synth); renders a MIDI file through a SoundFont offline',
    },
    'sfz-render': {
        status: 'not wired',
        why: 'better for orchestral SFZ libraries, but the sfizz project was archived in June 2026 — an unmaintained renderer is a dependency nobody will fix',
    },
});

// ── the executable ───────────────────────────────────────────────────────

let resolved = null;

function runs(bin) {
    const r = spawnSync(bin, ['--version'], { stdio: 'pipe', timeout: 8000 });
    return !r.error && r.status === 0;
}

/** Where FluidSynth is, in the shape every resolver here returns: { available, bin, source, reason }. */
function resolveFluidsynthUncached() {
    const declared = String(process.env.FLUIDSYNTH_PATH || '').trim();
    if (declared) {
        if (runs(declared)) return { available: true, bin: declared, source: 'env' };
        return {
            available: false, bin: null, source: 'env',
            reason: `FLUIDSYNTH_PATH is set to ${declared}, which will not run. Correct it or unset it.`,
        };
    }
    for (const candidate of ['fluidsynth', '/opt/homebrew/bin/fluidsynth', '/usr/local/bin/fluidsynth',
        '/opt/local/bin/fluidsynth', '/usr/bin/fluidsynth']) {
        if (runs(candidate)) return { available: true, bin: candidate, source: 'path' };
    }
    return {
        available: false, bin: null, source: null,
        reason: 'FluidSynth is not installed. Install it (brew install fluid-synth), or point FLUIDSYNTH_PATH at a build.',
    };
}

/** Cached on the AVAILABLE answer only, as the encoder is: installing it mid-session must be noticed. */
function resolveFluidsynth() {
    if (resolved) return resolved;
    const found = resolveFluidsynthUncached();
    if (found.available) resolved = found;
    return found;
}

// ── the library ──────────────────────────────────────────────────────────

function searchDirs() {
    return [
        process.env.FILM_SOUNDFONT_DIR,
        path.join(os.homedir(), 'Library', 'Audio', 'Sounds', 'Banks'),
        '/opt/homebrew/share/soundfonts', '/usr/local/share/soundfonts',
        '/usr/share/sounds/sf2', '/usr/share/soundfonts',
    ].filter(Boolean);
}

function isSoundfont(file) {
    try {
        const fd = fs.openSync(file, 'r');
        const head = Buffer.alloc(12);
        fs.readSync(fd, head, 0, 12, 0);
        fs.closeSync(fd);
        return head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'sfbk';
    } catch (_) { return false; }
}

/**
 * Which SoundFont a render would use, which library it is, and its licence.
 *
 * FILM_SOUNDFONT names one; otherwise the usual places are searched and a
 * library this engine knows is preferred over one it does not. A library
 * outside the registry needs FILM_SOUNDFONT_LICENSE stated by whoever
 * installed it — the licence is a claim a person makes, never a guess.
 */
function resolveSoundfont(opts = {}) {
    const declared = String(opts.soundfont || process.env.FILM_SOUNDFONT || '').trim();
    const declaredLicense = String(opts.license || process.env.FILM_SOUNDFONT_LICENSE || '').trim().toLowerCase() || null;
    let file = null, source = null;
    if (declared) {
        file = declared; source = opts.soundfont ? 'given' : 'env';
    } else {
        const found = [];
        for (const dir of (opts.searchDirs || searchDirs())) {
            let names = [];
            try { names = fs.readdirSync(dir).filter(n => /\.sf2$/i.test(n)).sort(); } catch (_) { continue; }
            for (const n of names) found.push(path.join(dir, n));
        }
        file = found.find(f => LIBRARIES.some(l => l.match.test(path.basename(f)))) || found[0] || null;
        source = file ? 'search' : null;
    }

    if (!file) {
        return {
            available: false, path: null, source: null,
            reason: 'No SoundFont is installed. Install one — FluidR3 GM (MIT) or VSCO 2 CE (CC0) — and set '
                + 'FILM_SOUNDFONT to its .sf2 path.',
        };
    }
    if (!fs.existsSync(file)) {
        return { available: false, path: file, source, reason: `the SoundFont at ${file} does not exist` };
    }
    if (!isSoundfont(file)) {
        return { available: false, path: file, source, reason: `${path.basename(file)} is not a SoundFont 2 file (.sf2)` };
    }
    if (declaredLicense && !LIBRARY_LICENSES.includes(declaredLicense)) {
        return {
            available: false, path: file, source,
            reason: `FILM_SOUNDFONT_LICENSE is "${declaredLicense}"; it must be one of ${LIBRARY_LICENSES.join(', ')}`,
        };
    }
    const lib = LIBRARIES.find(l => l.match.test(path.basename(file)));
    const license = declaredLicense || (lib && lib.license) || null;
    if (!license) {
        return {
            available: false, path: file, source,
            reason: `${path.basename(file)} is not a library this engine knows the licence of. Set `
                + `FILM_SOUNDFONT_LICENSE to ${LIBRARY_LICENSES.join(', ')}. A render whose instruments' `
                + 'licence is unknown is refused rather than recorded as generated.',
        };
    }
    return {
        available: true, path: file, source,
        library: lib ? lib.name : path.basename(file).replace(/\.sf2$/i, ''),
        library_id: lib ? lib.id : null,
        license, license_declared: !!declaredLicense,
    };
}

/** Everything a render needs, in one answer. Never throws. */
function availability(opts = {}) {
    const renderer = resolveFluidsynth();
    const soundfont = resolveSoundfont(opts);
    let encoder;
    try { encoder = require('./ffmpeg').resolveFfmpeg(); } catch (err) { encoder = { available: false, reason: err.message }; }
    const reasons = [], fixes = [];
    if (!renderer.available) { reasons.push(renderer.reason); fixes.push('brew install fluid-synth, or set FLUIDSYNTH_PATH'); }
    if (!soundfont.available) { reasons.push(soundfont.reason); fixes.push('install a SoundFont and set FILM_SOUNDFONT (and FILM_SOUNDFONT_LICENSE for a library this engine does not know)'); }
    if (!encoder.available) { reasons.push(encoder.reason); fixes.push('install ffmpeg, which trims the render to the cue’s length'); }
    return { ok: reasons.length === 0, renderer, soundfont, encoder: { available: !!encoder.available, source: encoder.source || null }, reasons, fixes };
}

// ── rendering ────────────────────────────────────────────────────────────

/** Peak and mean level in dB, measured by the encoder. */
function measureLevels(file, ffmpeg) {
    const ff = ffmpeg || require('./ffmpeg').resolveFfmpeg();
    let text = '';
    try {
        const r = spawnSync(ff.bin, ['-hide_banner', '-nostats', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
            { stdio: 'pipe', timeout: 120000 });
        text = `${r.stderr || ''}${r.stdout || ''}`;
    } catch (_) { text = ''; }
    const num = re => { const m = re.exec(text); return m ? Number(m[1]) : null; };
    return { max_db: num(/max_volume:\s*(-?[\d.]+|-inf)\s*dB/), mean_db: num(/mean_volume:\s*(-?[\d.]+)\s*dB/) };
}

const fail = (stage, reason) => ({ ok: false, stage, reason });

/**
 * The half of a render that is the same whoever played it: cut to the cue,
 * read it back, and refuse silence.
 *
 * Shared by the SoundFont renderer below and by the plugin host in
 * `lib/instrument-host.js`, because "a render is judged on its volume" is one
 * rule and two copies is how one of them keeps a fix the other does not.
 *
 * @param {string} rawPath  what the renderer produced, any length, any format
 * @param {string} outPath  where the finished 48kHz/24-bit stereo file goes
 */
function finishRender({ rawPath, outPath, lengthMs, frameMs = 1000 / 24, sampleRate = 48000, silenceDb = -60, ffmpeg } = {}) {
    let ff = ffmpeg;
    if (!ff) { try { ff = require('./ffmpeg').resolveFfmpeg(); } catch (err) { ff = { available: false, reason: err.message }; } }
    if (!ff.available) return fail('encoder', ff.reason);
    if (!rawPath || !fs.existsSync(rawPath)) return fail('render', 'the renderer produced no file');
    if (!(Number(lengthMs) > 0)) return fail('length', 'there is no length to render to');

    // A release tail runs past the last note and a quiet end is shorter: pad, then cut.
    try {
        execFileSync(ff.bin, ['-y', '-loglevel', 'error', '-i', rawPath, '-af', 'apad',
            '-t', (Number(lengthMs) / 1000).toFixed(3), '-ar', String(sampleRate), '-ac', '2', '-c:a', 'pcm_s24le', outPath],
        { stdio: 'pipe', timeout: 600000 });
    } catch (err) {
        return fail('encoder', `the render could not be trimmed to length: ${String(err.stderr || err.message).trim().slice(0, 200)}`);
    }

    const { inspectMedia } = require('./ffmpeg');
    const seen = inspectMedia(outPath, { ffmpeg: ff });
    if (!seen.ok) return fail('readback', seen.reason);
    const durationMs = Math.round(seen.durationSeconds * 1000);
    if (Math.abs(durationMs - Number(lengthMs)) > frameMs) {
        return fail('length', `the render is ${durationMs}ms and the cue is ${Math.round(lengthMs)}ms`);
    }
    const levels = measureLevels(outPath, ff);
    if (!(levels.max_db > silenceDb)) {
        return fail('silence', `the render peaks at ${levels.max_db == null ? 'nothing measurable' : levels.max_db + ' dB'} — `
            + 'silence. Nothing was loaded to play these notes (a SoundFont with no instrument for the part, '
            + 'or a plugin state holding no patch).');
    }
    return { ok: true, file: outPath, duration_ms: durationMs, levels };
}

/**
 * Render a MIDI file through a SoundFont to a 48kHz, 24-bit stereo WAV exactly
 * the cue's length, and prove it: read back, length within one frame, peak
 * above silence. Every failure names its stage.
 */
function renderMidi({ midiPath, outPath, lengthMs, soundfont, frameMs = 1000 / 24, gain = 0.9,
    sampleRate = 48000, silenceDb = -60, fluidsynth, ffmpeg } = {}) {
    const fl = fluidsynth || resolveFluidsynth();
    if (!fl.available) return fail('renderer', fl.reason);
    let ff = ffmpeg;
    if (!ff) { try { ff = require('./ffmpeg').resolveFfmpeg(); } catch (err) { ff = { available: false, reason: err.message }; } }
    if (!ff.available) return fail('encoder', ff.reason);
    if (!midiPath || !fs.existsSync(midiPath)) return fail('notes', 'there is no MIDI file to render');
    if (!(Number(lengthMs) > 0)) return fail('length', 'the cue has no length to render to');

    const raw = path.join(os.tmpdir(), `fe-render-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
    // Options, then the SoundFont, then the MIDI file. -F renders offline as fast as the machine allows.
    const r = spawnSync(fl.bin, ['-n', '-i', '-q', '-g', String(gain), '-r', String(sampleRate), '-T', 'wav', '-F', raw,
        String(soundfont || ''), midiPath], { stdio: 'pipe', timeout: 600000 });
    if (r.error || !fs.existsSync(raw)) {
        const said = String((r.stderr || '') + (r.stdout || '')).trim().split('\n').slice(-3).join(' ');
        return fail('renderer', `fluidsynth produced no file${said ? `: ${said}` : ''}`);
    }

    // Cut to the cue, read back, refuse silence — the one rule, shared with the plugin host.
    const finished = finishRender({ rawPath: raw, outPath, lengthMs, frameMs, sampleRate, silenceDb, ffmpeg: ff });
    try { fs.unlinkSync(raw); } catch (_) { /* gone is fine */ }
    if (!finished.ok) return finished;
    return { ...finished, renderer: 'fluidsynth', renderer_source: fl.source };
}

module.exports = {    LIBRARIES, RENDERERS,
    resolveFluidsynth, resolveFluidsynthUncached, resolveSoundfont, availability,
    measureLevels, renderMidi, finishRender,};
