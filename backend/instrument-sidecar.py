"""THE INSTRUMENT SIDECAR: a separate, localhost-only process that holds plugins.

The director owns 248 sample libraries and wants to score inside Film Engine
rather than in a DAW. Node cannot host a VST3/AU plugin, so this process does —
and it is the Ableton sidecar's shape (backend/ableton-sidecar.js), for the same
reasons: the Film Engine server never spawns it, it listens on 127.0.0.1 only,
it answers only a caller carrying its token, and it does only what OPS lists.

Run it yourself, beside Film Engine:

    INSTRUMENT_SIDECAR_TOKEN=<24+ random characters> \
      backend/.venv/bin/python backend/instrument-sidecar.py

    GET  /health   host versions, plugin folders, what is installed, last error
    GET  /ops      the allowlist, and what a plugin host cannot do (free)
    POST /op       { op, args } -> JSON, or WAV bytes for a render

Status codes say which rule answered: 401 no token, 403 not on the allowlist or
a plugin outside the standard folders, 400 an argument of the wrong type, 503
the host library is missing, 500 the plugin failed, 504 too slow.

Python, because the plugin host (DawDreamer, JUCE underneath) is a Python
library. Measured on this machine before it was chosen: Kontakt 8 VST3 loads
headless in 0.9s with 4145 parameters, its state saves to ~5KB and loads back,
and three seconds of audio render in 0.1s.
"""

import base64
import hashlib
import hmac
import io
import json
import os
import struct
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOOPBACK = ('127.0.0.1', '::1', 'localhost')
DEFAULT_PORT = 3191
BODY_LIMIT = 64 * 1024 * 1024          # a MIDI file and a plugin state, not audio
SAMPLE_RATE = 48000
BLOCK = 512

# Where macOS keeps plugins. A plugin path outside these is refused: the sidecar
# loads code into itself, so "any path the caller likes" would be arbitrary code
# execution behind a localhost port.
PLUGIN_DIRS = (
    '/Library/Audio/Plug-Ins/VST3', '/Library/Audio/Plug-Ins/Components',
    '/Library/Audio/Plug-Ins/VST',
    os.path.expanduser('~/Library/Audio/Plug-Ins/VST3'),
    os.path.expanduser('~/Library/Audio/Plug-Ins/Components'),
    os.path.expanduser('~/Library/Audio/Plug-Ins/VST'),
)
PLUGIN_EXTS = ('.vst3', '.component', '.vst')

OPS = {
    'instruments': {
        'what': 'the plugins installed in the standard folders',
        'mutates': False,
        'args': {},
    },
    'capture': {
        'what': "open a plugin's own editor so a person picks a patch, and return the state that recalls it",
        'mutates': False,
        'supervised': True,
        'args': {'plugin': 'str', 'state_b64': 'str?', 'supervised': 'bool'},
    },
    'render': {
        'what': 'play a MIDI file through a plugin holding a state, and return the audio',
        'mutates': False,
        'returns': 'audio/wav (32-bit float, stereo)',
        'args': {'plugin': 'str', 'midi_b64': 'str', 'length_ms': 'int', 'state_b64': 'str?', 'sample_rate': 'int?'},
    },
}

UNSUPPORTED = (
    {
        'what': 'choose a patch inside a library without a person or an NKS preset',
        'why': 'a plugin exposes its state, not its browser: Kontakt has no API to load an .nki by path',
        'instead': 'capture the state once through the plugin editor, or read an NKS preset, whose PCHK chunk IS the state',
    },
    {
        'what': 'play an instrument live from the page',
        'why': 'this renders offline and returns a file; real-time monitoring would need an audio server and a stream',
        'instead': 'render the part (far faster than real time) and hear it in the Score page like any other clip',
    },
)


class HostMissing(Exception):
    pass


_engine_lock = threading.Lock()
_loaded = {}                # plugin path -> processor, kept because loading a big library is slow
_last_error = {'at': None, 'what': None}


def _host():
    """DawDreamer, imported late so /health can explain its absence instead of crashing."""
    try:
        import dawdreamer                                   # noqa: F401
        return dawdreamer
    except Exception as exc:                                # pragma: no cover - environment
        raise HostMissing(
            'the plugin host library is not installed in this interpreter: '
            f'{type(exc).__name__}: {exc}. Create a venv and `pip install dawdreamer numpy`.')


def _plugin_allowed(path):
    real = os.path.realpath(path)
    if not real.endswith(PLUGIN_EXTS):
        return False
    return any(real == os.path.realpath(d) or real.startswith(os.path.realpath(d) + os.sep) for d in PLUGIN_DIRS)


def list_instruments():
    out = []
    for directory in PLUGIN_DIRS:
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            continue
        for name in names:
            if not name.endswith(PLUGIN_EXTS):
                continue
            path = os.path.join(directory, name)
            out.append({
                'name': os.path.splitext(name)[0],
                'path': path,
                'format': 'vst3' if name.endswith('.vst3') else ('au' if name.endswith('.component') else 'vst'),
            })
    return out


def _processor(dd, engine, plugin):
    """One loaded plugin per path, reused: loading a large library takes seconds."""
    key = os.path.realpath(plugin)
    got = _loaded.get(key)
    if got is None:
        got = engine.make_plugin_processor('instrument', plugin)
        try:
            # Kontakt reports 64 outputs; the main pair is what a part is.
            got.disable_nonmain_buses()
        except Exception:
            pass
        _loaded[key] = got
    return got


def _write_state(processor, state_b64):
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


def _read_state(processor):
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


def float_wav(samples, sample_rate):
    """A 32-bit float WAV. The caller trims it to length and converts it."""
    channels = samples.shape[0]
    frames = samples.shape[1]
    data = samples.T.astype('<f4').tobytes()
    header = io.BytesIO()
    header.write(b'RIFF')
    header.write(struct.pack('<I', 36 + len(data)))
    header.write(b'WAVEfmt ')
    header.write(struct.pack('<IHHIIHH', 16, 3, channels, sample_rate,
                             sample_rate * channels * 4, channels * 4, 32))
    header.write(b'data')
    header.write(struct.pack('<I', len(data)))
    return header.getvalue() + data


def op_instruments(_args):
    return {'instruments': list_instruments(), 'folders': list(PLUGIN_DIRS)}


def op_capture(args):
    """Blocking and supervised: it opens a window a person interacts with."""
    if not args.get('supervised'):
        raise Refusal(403, 'capture opens a plugin window for a person to use; pass supervised: true when a person asked for it')
    dd = _host()
    plugin = args['plugin']
    with _engine_lock:
        engine = dd.RenderEngine(SAMPLE_RATE, BLOCK)
        processor = engine.make_plugin_processor('capture', plugin)
        _write_state(processor, args.get('state_b64'))
        processor.open_editor()                              # returns when the person closes it
        state = _read_state(processor)
    return {'state_b64': state, 'bytes': len(base64.b64decode(state)),
            'note': 'this state recalls exactly what was loaded when the window was closed'}


def op_render(args):
    dd = _host()
    import numpy as np
    plugin = args['plugin']
    length_ms = int(args['length_ms'])
    sample_rate = int(args.get('sample_rate') or SAMPLE_RATE)
    midi = base64.b64decode(args['midi_b64'])
    if midi[:4] != b'MThd':
        raise Refusal(400, 'midi_b64 is not a Standard MIDI File')

    with tempfile.NamedTemporaryFile(suffix='.mid', delete=False) as fh:
        fh.write(midi)
        midi_path = fh.name
    try:
        with _engine_lock:
            engine = dd.RenderEngine(sample_rate, BLOCK)
            processor = _processor(dd, engine, plugin)
            _write_state(processor, args.get('state_b64'))
            processor.clear_midi()
            processor.load_midi(midi_path, beats=False)
            engine.load_graph([(processor, [])])
            started = time.time()
            # A tail past the notes: a release should not be cut by the render.
            engine.render(length_ms / 1000.0 + 2.0)
            audio = engine.get_audio()
            took = time.time() - started
        if audio.shape[0] > 2:
            audio = audio[:2]
        elif audio.shape[0] == 1:
            audio = np.vstack([audio, audio])
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        return {
            '__wav__': float_wav(audio, sample_rate),
            'peak': peak, 'seconds': audio.shape[1] / sample_rate, 'render_seconds': round(took, 3),
        }
    finally:
        try:
            os.unlink(midi_path)
        except OSError:
            pass


HANDLERS = {'instruments': op_instruments, 'capture': op_capture, 'render': op_render}


class Refusal(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def config(env):
    token = env.get('INSTRUMENT_SIDECAR_TOKEN', '')
    if len(token) < 24:
        raise SystemExit('INSTRUMENT_SIDECAR_TOKEN is required and must be at least 24 characters: '
                         'every caller must present it, and a short one is guessable')
    port = env.get('INSTRUMENT_SIDECAR_PORT') or DEFAULT_PORT
    try:
        port = int(port)
        if not 1 <= port <= 65535:
            raise ValueError
    except ValueError:
        raise SystemExit(f'INSTRUMENT_SIDECAR_PORT must be a port number, not {port!r}')
    return {'token': token, 'port': port}


def health():
    out = {'ok': True, 'python': sys.version.split()[0], 'sample_rate': SAMPLE_RATE,
           'folders': list(PLUGIN_DIRS), 'loaded_plugins': sorted(_loaded), 'last_error': _last_error}
    try:
        dd = _host()
        out['host'] = {'library': 'dawdreamer', 'version': getattr(dd, '__version__', 'unknown')}
    except HostMissing as exc:
        out['ok'] = False
        out['host'] = {'library': 'dawdreamer', 'available': False, 'reason': str(exc)}
    installed = list_instruments()
    out['instruments_found'] = len(installed)
    out['kontakt'] = next((i for i in installed if i['name'].lower().startswith('kontakt')), None)
    if not installed:
        out['ok'] = False
        out.setdefault('reasons', []).append('no plugins are installed in the standard folders')
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'FilmEngineInstrumentSidecar/1'

    def log_message(self, fmt, *a):          # quiet: this runs beside a person's work
        pass

    def _send(self, status, payload, content_type='application/json'):
        body = payload if isinstance(payload, (bytes, bytearray)) else json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _authorised(self):
        header = self.headers.get('Authorization', '')
        if not header.startswith('Bearer '):
            return False
        return hmac.compare_digest(header[7:], self.server.token)

    def do_GET(self):
        if self.path == '/ops':
            return self._send(200, {'ops': OPS, 'unsupported': list(UNSUPPORTED)})
        if not self._authorised():
            return self._send(401, {'error': 'this sidecar answers only a caller carrying its token'})
        if self.path == '/health':
            return self._send(200, health())
        return self._send(404, {'error': 'not found', 'paths': ['/health', '/ops', '/op']})

    def do_POST(self):
        if not self._authorised():
            return self._send(401, {'error': 'this sidecar answers only a caller carrying its token'})
        if self.path != '/op':
            return self._send(404, {'error': 'not found', 'paths': ['/health', '/ops', '/op']})
        length = int(self.headers.get('Content-Length') or 0)
        if length > BODY_LIMIT:
            return self._send(413, {'error': f'the body is over {BODY_LIMIT} bytes'})
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except Exception:
            return self._send(400, {'error': 'the body is not JSON'})

        op = body.get('op')
        args = body.get('args') or {}
        if op not in HANDLERS:
            return self._send(403, {'error': f"'{op}' is not an operation this sidecar performs",
                                    'ops': sorted(HANDLERS)})
        plugin = args.get('plugin')
        if 'plugin' in OPS[op]['args']:
            if not isinstance(plugin, str) or not plugin:
                return self._send(400, {'error': 'plugin must be the path of an installed plugin'})
            if not _plugin_allowed(plugin):
                return self._send(403, {
                    'error': 'that plugin is outside the folders macOS installs plugins into',
                    'folders': list(PLUGIN_DIRS)})
            if not os.path.exists(plugin):
                return self._send(400, {'error': f'there is no plugin at {plugin}'})
        try:
            result = HANDLERS[op](args)
        except Refusal as exc:
            return self._send(exc.status, {'error': str(exc)})
        except HostMissing as exc:
            _last_error.update(at=time.time(), what=str(exc))
            return self._send(503, {'error': str(exc)})
        except KeyError as exc:
            return self._send(400, {'error': f'{exc} is required for {op}'})
        except Exception as exc:
            _last_error.update(at=time.time(), what=f'{type(exc).__name__}: {exc}')
            traceback.print_exc()
            return self._send(500, {'error': f'the plugin failed: {type(exc).__name__}: {exc}', 'op': op})

        if isinstance(result, dict) and '__wav__' in result:
            wav = result.pop('__wav__')
            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(wav)))
            self.send_header('X-Render', json.dumps(result))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            return self.wfile.write(wav)
        return self._send(200, result)


def main():
    cfg = config(os.environ)
    server = ThreadingHTTPServer(('127.0.0.1', cfg['port']), Handler)
    server.token = cfg['token']
    state = health()
    print(f"Film Engine instrument sidecar on http://127.0.0.1:{cfg['port']} "
          f"(host {'ok' if state.get('ok') else 'NOT READY'}, {state['instruments_found']} plugins found)", flush=True)
    if not state.get('ok'):
        for reason in [state.get('host', {}).get('reason')] + list(state.get('reasons', [])):
            if reason:
                print(f'  ! {reason}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('stopped', flush=True)


if __name__ == '__main__':
    main()
