"""ONE PLUGIN JOB, IN ITS OWN PROCESS, THEN GONE.

A plugin is somebody else's code and it can take a process down with it: Kontakt
logged `PresetSlotManager::selectSlot: slot not found` while re-stating a live
instance and killed the sidecar mid-render. A segfault cannot be caught in
Python, so the only real containment is a process boundary — and this is it. The
sidecar supervises; each capture or render happens here and exits.

Two things fall out of that, both wanted:
  * the plugin is loaded FRESH for every job, so no job inherits the state, the
    voices or the damage of the one before it;
  * the editor gets a real main thread, because this process has nothing else on
    it — which is what macOS demands of a plugin window.

Reads one job as JSON on stdin, writes one result as JSON on stdout. Audio is
written to the path the job names, never carried through a pipe.
"""

import base64
import json
import os
import sys
import tempfile


ANSWER_PATH = None


def answer(payload):
    """
    The answer goes to a FILE, and then this process leaves without tidying up.

    Two things a plugin does that a pipe and a clean exit cannot survive:
    Kontakt prints its own log lines to stdout (`PresetSlotManager::selectSlot:
    slot not found`), which corrupts JSON on that channel; and it segfaults while
    being unloaded — measured here, AFTER a good render, so the exit code said
    "crash" about work that had completed. os._exit skips the destructors that
    crash, and the file is already written by then.
    """
    text = json.dumps(payload)
    if ANSWER_PATH:
        with open(ANSWER_PATH, 'w') as fh:
            fh.write(text)
    sys.stdout.write(text)
    sys.stdout.flush()
    os._exit(0)


def fail(stage, reason):
    answer({'ok': False, 'stage': stage, 'reason': reason})


def with_state(processor, state_b64):
    if not state_b64:
        return
    blob = base64.b64decode(state_b64)
    with tempfile.NamedTemporaryFile(suffix='.state', delete=False) as fh:
        fh.write(blob)
        path = fh.name
    try:
        processor.load_state(path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def read_state(processor):
    with tempfile.NamedTemporaryFile(suffix='.state', delete=False) as fh:
        path = fh.name
    try:
        processor.save_state(path)
        with open(path, 'rb') as fh:
            return base64.b64encode(fh.read()).decode('ascii')
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def main():
    try:
        job = json.load(sys.stdin)
    except Exception as exc:
        fail('job', f'the job is not JSON: {exc}')

    global ANSWER_PATH
    ANSWER_PATH = job.get('answer_path')
    op = job.get('op')
    args = job.get('args') or {}
    sample_rate = int(args.get('sample_rate') or 48000)

    try:
        import dawdreamer as dd
        import numpy as np
    except Exception as exc:
        fail('host', f'the plugin host library is missing: {type(exc).__name__}: {exc}')

    try:
        engine = dd.RenderEngine(sample_rate, 512)
        processor = engine.make_plugin_processor('instrument', args['plugin'])
    except Exception as exc:
        fail('plugin', f'{args.get("plugin")} would not load: {type(exc).__name__}: {exc}')

    if op == 'capture':
        try:
            with_state(processor, args.get('state_b64'))
            processor.open_editor()                     # returns when the person closes it
            state = read_state(processor)
        except Exception as exc:
            fail('editor', f'{type(exc).__name__}: {exc}')
        answer({'ok': True, 'state_b64': state, 'bytes': len(base64.b64decode(state))})

    if op == 'render':
        midi_path, out_path = args.get('midi_path'), args.get('out_path')
        length_ms = int(args.get('length_ms') or 0)
        if not midi_path or not os.path.exists(midi_path):
            fail('notes', 'there is no MIDI file to play')
        if not out_path:
            fail('job', 'the job names nowhere to write the audio')
        try:
            with_state(processor, args.get('state_b64'))
            try:
                processor.disable_nonmain_buses()       # Kontakt reports 64 outputs; a part is the main pair
            except Exception:
                pass
            processor.clear_midi()
            processor.load_midi(midi_path, beats=False)
            engine.load_graph([(processor, [])])
            engine.render(length_ms / 1000.0 + 2.0)     # a tail, so a release is not cut
            audio = engine.get_audio()
        except Exception as exc:
            fail('render', f'{type(exc).__name__}: {exc}')

        if audio.shape[0] > 2:
            audio = audio[:2]
        elif audio.shape[0] == 1:
            audio = np.vstack([audio, audio])
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0

        # A 32-bit float WAV, written here. The caller cuts it to the cue and
        # judges it; this process only plays the notes.
        import struct
        data = audio.T.astype('<f4').tobytes()
        with open(out_path, 'wb') as fh:
            fh.write(b'RIFF' + struct.pack('<I', 36 + len(data)) + b'WAVEfmt ')
            fh.write(struct.pack('<IHHIIHH', 16, 3, audio.shape[0], sample_rate,
                                 sample_rate * audio.shape[0] * 4, audio.shape[0] * 4, 32))
            fh.write(b'data' + struct.pack('<I', len(data)) + data)
        answer({'ok': True, 'peak': peak, 'seconds': audio.shape[1] / sample_rate})

    fail('job', f"'{op}' is not a job this worker performs")


if __name__ == '__main__':
    main()
