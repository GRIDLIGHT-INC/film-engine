/**
 * FluidSynth — a cue's written notes, played through instruments on this machine.
 *
 * GRD-3995. A `music` adapter that composes NOTHING: it renders the MIDI a cue
 * already has (Phase 1, music_midi_write or a part the director played) through
 * a SoundFont. So it answers every one of the six music workflows with
 * "unsupported" and the reason, and it is never a default — a project reaches it
 * by pinning it, or through the render route on the cue's notes.
 *
 * Self-hosted: no key, no bill. It is "configured" only when the renderer, a
 * SoundFont with a known licence and the encoder are all present — a keyless
 * adapter read as ready without asking is how a readiness report says go for a
 * render that will produce silence.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const render = require('../instrument-render');

const COMPOSES_NOTHING = 'renders notes a cue already has through a SoundFont; it composes nothing from words';

function meterFluidsynth(capability, payload, result) {
    if (capability !== 'music') return null;
    const p = payload || {};
    const ms = Number(p.length_ms) || Number(p.duration_ms) || Number(result && result.duration_ms)
        || (Number(p.duration_s || p.duration_seconds || p.duration) || 0) * 1000;
    if (!(ms > 0)) return null;
    return { unit: 'second', quantity: Math.round(ms / 10) / 100, model: 'fluidsynth' };
}

const adapter = {
    meter: meterFluidsynth,
    id: 'fluidsynth',
    kind: 'generator',
    label: 'FluidSynth (instruments on this machine)',
    requiresKey: false,
    capabilities: ['music'],
    music: {
        music_compose: { status: 'unsupported', reason: `FluidSynth ${COMPOSES_NOTHING}` },
        music_parts: { status: 'unsupported', reason: 'FluidSynth plays the parts a cue’s notes already have; it generates no new parts' },
        music_separate: { status: 'unsupported', reason: 'FluidSynth renders MIDI; it cannot split a recording into stems' },
        music_reference: { status: 'unsupported', reason: 'FluidSynth takes notes and a SoundFont, never a reference recording or melody' },
        music_video: { status: 'unsupported', reason: 'FluidSynth takes notes and a SoundFont, never the picture' },
        music_inpaint: { status: 'unsupported', reason: 'FluidSynth re-renders the whole note file; it cannot regenerate a range of a recording in context' },
    },
    renderers: render.RENDERERS,
    connection: {
        instructions: 'Nothing to paste. Install FluidSynth (brew install fluid-synth) and a SoundFont — FluidR3 GM (MIT) '
            + 'or VSCO 2 CE (CC0) — and set FILM_SOUNDFONT to its .sf2 path. sfz-render is not wired: the sfizz '
            + 'project was archived in June 2026.',
        helpUrl: 'https://www.fluidsynth.org/',
    },

    supports(capability) { return capability === 'music'; },

    /** Renderer, SoundFont and encoder, with what is missing and how to fix it. */
    available() { return render.availability(); },

    async generate(capability, payload) {
        if (capability !== 'music') return { ok: false, status: 400, error: `fluidsynth: unsupported capability '${capability}'` };
        const p = payload || {};
        if (!p.midi_path) {
            return {
                ok: false, status: 412, code: 'PRECONDITION',
                error: 'fluidsynth renders a cue’s written notes and this request carries none. Write them with '
                    + 'music_midi_write (or play a part in), then render from the cue’s notes.',
            };
        }
        const sf = render.resolveSoundfont({ soundfont: p.soundfont });
        if (!sf.available) return { ok: false, status: 503, code: 'NO_SOUNDFONT', stage: 'soundfont', error: sf.reason };

        const out = path.join(os.tmpdir(), `fe-fluidsynth-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
        const r = render.renderMidi({
            midiPath: p.midi_path, outPath: out, lengthMs: Number(p.length_ms || p.duration_ms),
            soundfont: sf.path, frameMs: Number(p.frame_ms) > 0 ? Number(p.frame_ms) : undefined,
        });
        if (!r.ok) {
            try { fs.unlinkSync(out); } catch (_) { /* never written */ }
            const status = ['renderer', 'encoder'].includes(r.stage) ? 503 : 422;
            return { ok: false, status, code: `RENDER_${String(r.stage).toUpperCase()}`, stage: r.stage, error: r.reason };
        }
        const data = fs.readFileSync(out);
        try { fs.unlinkSync(out); } catch (_) { /* already gone */ }
        return {
            ok: true, data, format: 'wav', mime: 'audio/wav',
            duration_ms: r.duration_ms, levels: r.levels,
            provider_model: 'fluidsynth', library: sf.library, library_id: sf.library_id, license: sf.license,
        };
    },
};

module.exports = { adapter, meterFluidsynth };
