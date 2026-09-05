const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

process.env.FILM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-range-'));
const { serveFile, ensureDir, getFilePath } = require('../lib/file-storage');

/**
 * THE BLACK SCREEN.
 *
 * Playback showed nothing — every clip, including ones this session never
 * touched. The server answered curl in 8ms and the browser span forever with
 * NO error, which is what made it look like missing footage.
 *
 * `Range: bytes=-20000` is a SUFFIX range: RFC 7233 says it is the LAST 20000
 * bytes. This served the FIRST 20001 and labelled them `bytes 0-20000/...`.
 *
 * That is fatal for exactly the files this engine produces. ffmpeg writes the
 * `moov` atom at the END unless asked for +faststart — measured at 99% of the
 * file on every clip here — so a player's first move is a suffix range to find
 * it. Handed the head instead, it cannot parse the container, and it waits: a
 * valid 206 with real bytes in it is not an error, so nothing is ever reported.
 *
 * Set-based over the range forms a media element actually sends, because the
 * two that worked are the two anybody would test by hand.
 */

let TMP, FILE, SIZE;
const PROJECT = 'range-test';

test.before(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-range-src-'));
    ensureDir(PROJECT, 'video');
    FILE = getFilePath(PROJECT, 'video', 'probe.mp4');
    // Distinctive head and tail, so serving the wrong end is unmistakable.
    const body = Buffer.alloc(100000, 0x41);          // 'A'
    Buffer.from('HEAD-MARKER').copy(body, 0);
    Buffer.from('TAIL-MARKER').copy(body, body.length - 11);
    fs.writeFileSync(FILE, body);
    SIZE = body.length;
});
test.after(() => {
    for (const d of [TMP, process.env.FILM_DATA_DIR]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* temp */ }
    }
});

/**
 * Ask the real serving function, over a real socket.
 *
 * TIMED OUT AND CLOSED ON EVERY PATH. The first version of this had neither,
 * so a branch that failed to end the response hung the whole test file until
 * the runner was killed — no output, no failure, nothing to read. A harness
 * that can hang is one that cannot report the bug it was written for.
 */
function get(rangeHeader) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            try { serveFile(res, PROJECT, 'video', 'probe.mp4'); }
            catch (err) {
                if (!res.headersSent) res.writeHead(500);
                res.end(String(err.message));
            }
        });
        const done = (v) => { try { server.close(); } catch (_) { /* already closed */ } resolve(v); };
        const guard = setTimeout(() => done({ status: 0, headers: {}, body: Buffer.alloc(0), timedOut: true }), 8000);
        server.listen(0, '127.0.0.1', () => {
            const opts = { host: '127.0.0.1', port: server.address().port, path: '/x' };
            if (rangeHeader) opts.headers = { Range: rangeHeader };
            const req = http.get(opts, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => { clearTimeout(guard);
                    done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
            });
            req.on('error', (e) => { clearTimeout(guard);
                done({ status: 0, headers: {}, body: Buffer.alloc(0), error: e.message }); });
        });
    });
}

/*
 * Every form RFC 7233 defines, with what each must return. A player uses all
 * three: the open-ended one to stream, the explicit one to seek, and the
 * SUFFIX one to find a moov atom that ffmpeg wrote at the end.
 */
const FORMS = [
    { range: null, status: 200, first: 'HEAD', why: 'no range at all — the whole file' },
    { range: 'bytes=0-', status: 206, first: 'HEAD', why: 'open-ended from the start: streaming' },
    { range: 'bytes=0-99', status: 206, first: 'HEAD', len: 100, why: 'an explicit window' },
    { range: 'bytes=99989-', status: 206, first: 'TAIL', why: 'open-ended from an offset: seeking' },
    { range: 'bytes=-11', status: 206, first: 'TAIL', len: 11,
      why: 'A SUFFIX RANGE — the LAST 11 bytes. This is how a player finds a moov atom '
        + 'written at the end of the file, which is every clip this engine produces.' },
];

test('every range form a player sends returns the bytes it asked for', async () => {
    const wrong = [];
    for (const f of FORMS) {
        const r = await get(f.range);
        if (r.timedOut) { wrong.push(`${f.range || '(none)'}: the server never answered`); continue; }
        if (r.status !== f.status) { wrong.push(`${f.range || '(none)'}: status ${r.status} (${f.why})`); continue; }
        const head = r.body.slice(0, 11).toString();
        const tail = r.body.slice(-11).toString();
        const marker = f.first === 'HEAD' ? head : tail;
        const want = f.first === 'HEAD' ? 'HEAD-MARKER' : 'TAIL-MARKER';
        if (marker !== want) {
            wrong.push(`${f.range}: served the ${f.first === 'HEAD' ? 'wrong start' : 'WRONG END'} `
                + `— got "${head}"…"${tail}" (${f.why})`);
        }
        if (f.len && r.body.length !== f.len) {
            wrong.push(`${f.range}: ${r.body.length} bytes, expected ${f.len}`);
        }
    }
    assert.deepStrictEqual(wrong, [], `range forms served wrongly:\n  ${wrong.join('\n  ')}`);
});

test('a suffix range reports the range it actually served', async () => {
    /*
     * The header is what a player trusts. Serving the head and LABELLING it
     * `bytes 0-20000/` is worse than refusing: the player believes it holds the
     * tail, finds no moov atom in it, and waits forever without an error.
     */
    const r = await get('bytes=-11');
    assert.strictEqual(r.status, 206);
    assert.strictEqual(r.headers['content-range'], `bytes ${SIZE - 11}-${SIZE - 1}/${SIZE}`,
        `a suffix range was reported as ${r.headers['content-range']}`);
    assert.strictEqual(r.headers['content-length'], '11');
});

test('a suffix longer than the file returns the whole file, not a negative offset', async () => {
    const r = await get(`bytes=-${SIZE + 5000}`);
    assert.strictEqual(r.status, 206);
    assert.strictEqual(r.body.length, SIZE, 'a suffix larger than the file did not clamp to the file');
    assert.strictEqual(r.headers['content-range'], `bytes 0-${SIZE - 1}/${SIZE}`);
});

test('a zero-length suffix is refused rather than served as the whole file', async () => {
    // RFC 7233: "bytes=-0" is unsatisfiable.
    const r = await get('bytes=-0');
    assert.strictEqual(r.status, 416, `bytes=-0 answered ${r.status}`);
});
