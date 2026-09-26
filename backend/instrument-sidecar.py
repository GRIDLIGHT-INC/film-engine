"""THE INSTRUMENT SIDECAR: a separate, localhost-only process that holds plugins.

The director owns 248 sample libraries and wants to score inside Film Engine
rather than in a DAW. Node cannot host a VST3/AU plugin, so this supervises
processes that can (see instrument-worker.py) — and it is the Ableton sidecar's
shape (backend/ableton-sidecar.js), for the same reasons: the Film Engine server
never spawns it, it listens on 127.0.0.1 only, it answers only a caller carrying
its token, and it does only what OPS lists.

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
headless in 0.9s with 4145 parameters, its state saves and loads back (547KB
with a library patch in it), and a six-second part rendered in 4.4s.
"""

import base64
import hmac
import json
import os
import subprocess
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
# A render is minutes at worst (a big library loads slowly); a capture has none,
# because a person is deciding.
RENDER_TIMEOUT = 900

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
_last_error = {'at': None, 'what': None}
_last_capture = {}          # the patch somebody last chose, in case the caller lost the answer

# ── this process supervises; the plugins live in children ────────────────
#
# Two facts forced it, both met on this machine rather than read about:
#
#   * macOS shows a plugin window only from a process's MAIN thread, and an HTTP
#     server answers on worker threads ("Plugin UI windows can only be shown
#     from the main thread").
#   * A plugin can take its host down. Kontakt logged `PresetSlotManager::
#     selectSlot: slot not found` while being re-stated and killed this process
#     mid-render; a segfault cannot be caught in Python.
#
# So a job runs in its own short-lived worker: it gets a real main thread for the
# editor, it loads the plugin fresh so it inherits nothing, and when it dies it
# costs one job rather than the sidecar. One at a time — audio is not reentrant —
# and /health says what is running, because a queue nobody can see reads as a
# sidecar that has died.

_busy = {'op': None, 'since': None}
WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'instrument-worker.py')


def run_worker(op, args, timeout=None):
    """
    One plugin job, in its own process.

    A plugin is somebody else's code: Kontakt logged `PresetSlotManager::
    selectSlot: slot not found` while re-stating a live instance and took this
    process down with it, mid-render. A segfault cannot be caught in Python, so
    the containment is the process boundary — a crash costs one job and the
    sidecar keeps answering. It also gives the editor a real main thread, which
    is the only place macOS will show a plugin window.
    """
    if not os.path.exists(WORKER):
        raise Refusal(500, f'the worker is missing at {WORKER}')
    answer_path = tempfile.NamedTemporaryFile(suffix='.json', delete=False).name
    with _engine_lock:                                   # one plugin at a time; audio is not reentrant
        _busy.update(op=op, since=time.time())
        try:
            proc = subprocess.run(
                [sys.executable, WORKER],
                input=json.dumps({'op': op, 'args': args, 'answer_path': answer_path}),
                capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise Refusal(504, f'the plugin did not finish {op} within {timeout}s')
        finally:
            _busy.update(op=None, since=None)

    # THE ANSWER, NOT THE EXIT CODE. A plugin can fall over while it is being
    # unloaded — measured here, after a render that had already produced its
    # audio — so work that finished is work that counts. What decides is whether
    # the worker wrote its answer; stdout cannot be trusted, because Kontakt
    # prints its own log lines there.
    answer = None
    try:
        with open(answer_path) as fh:
            answer = json.loads(fh.read() or 'null')
    except Exception:
        answer = None
    finally:
        try:
            os.unlink(answer_path)
        except OSError:
            pass
    if answer and proc.returncode != 0:
        answer['plugin_crashed_on_exit'] = True

    if not answer:
        tail = (proc.stderr or '').strip().split('\n')[-3:]
        _last_error.update(at=time.time(), what=f'{op}: worker exited {proc.returncode} with no answer')
        raise Refusal(502, f'the plugin crashed during {op} (exit {proc.returncode}). '
                           f'{" ".join(tail)[:300]}')
    if not answer.get('ok'):
        _last_error.update(at=time.time(), what=f"{op}: {answer.get('reason')}")
        raise Refusal(422 if answer.get('stage') in ('notes', 'render') else 502,
                      f"{answer.get('stage', 'plugin')}: {answer.get('reason', 'the plugin refused')}")
    return answer


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


def op_instruments(_args):
    return {'instruments': list_instruments(), 'folders': list(PLUGIN_DIRS)}


def op_capture(args):
    """Blocking and supervised: it opens a window a person interacts with."""
    if not args.get('supervised'):
        raise Refusal(403, 'capture opens a plugin window for a person to use; pass supervised: true when a person asked for it')
    # No ceiling: a person is deciding. The caller has its own patience.
    got = run_worker('capture', {'plugin': args['plugin'], 'state_b64': args.get('state_b64')}, timeout=None)
    state = got['state_b64']
    answer = {'state_b64': state, 'bytes': len(base64.b64decode(state)), 'plugin': args['plugin'], 'at': time.time(),
              'note': 'this state recalls exactly what was loaded when the window was closed'}
    # KEPT, because a person stood at that window: if the answer goes back to a
    # dropped connection the patch is still here, at GET /last-capture. A capture
    # can outlast any HTTP client's patience, and losing it means doing it again.
    _last_capture.clear()
    _last_capture.update(answer)
    return answer


def op_render(args):
    length_ms = int(args['length_ms'])
    sample_rate = int(args.get('sample_rate') or SAMPLE_RATE)
    midi = base64.b64decode(args['midi_b64'])
    if midi[:4] != b'MThd':
        raise Refusal(400, 'midi_b64 is not a Standard MIDI File')

    with tempfile.NamedTemporaryFile(suffix='.mid', delete=False) as fh:
        fh.write(midi)
        midi_path = fh.name
    out_path = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name
    started = time.time()
    try:
        got = run_worker('render', {
            'plugin': args['plugin'], 'state_b64': args.get('state_b64'),
            'midi_path': midi_path, 'out_path': out_path,
            'length_ms': length_ms, 'sample_rate': sample_rate,
        }, timeout=RENDER_TIMEOUT)
        with open(out_path, 'rb') as fh:
            wav = fh.read()
        return {
            '__wav__': wav, 'peak': got.get('peak'), 'seconds': got.get('seconds'),
            'render_seconds': round(time.time() - started, 3),
        }
    finally:
        for path in (midi_path, out_path):
            try:
                os.unlink(path)
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
           'folders': list(PLUGIN_DIRS), 'last_error': _last_error,
           # What the main thread is doing, because while a capture has a window
           # open everything else waits behind it — and a queue nobody can see
           # reads as the sidecar having died.
           'busy': ({'op': _busy['op'], 'seconds': round(time.time() - _busy['since'], 1)}
                    if _busy['op'] else None)}
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
        if self.path == '/last-capture':
            if not _last_capture:
                return self._send(404, {'error': 'nothing has been captured since this sidecar started'})
            return self._send(200, dict(_last_capture))
        return self._send(404, {'error': 'not found', 'paths': ['/health', '/ops', '/op', '/last-capture']})

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
