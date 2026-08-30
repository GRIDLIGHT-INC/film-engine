/**
 * An image on the board has to be visible on the board
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Reported as "if I add images in the moodboard we don't see them", and the
 * cause is one confusion this codebase has already paid for once under
 * `servedUrlFor`: a perfectly good string that is not a URL.
 *
 * `importBoardImage` stores `imported.file_path` into `image_path` — an
 * absolute filesystem path — and the page renders
 *
 *     <img src="${API_BASE}${e.image_path}" onerror="this.style.display='none'">
 *
 * so the browser asks for
 *
 *     http://localhost:3100/<absolute path to the data directory>/refsheets/...
 *
 * which 404s, and `onerror` hides it. A broken image and no image look
 * identical from the outside, which is exactly how it was reported.
 *
 * THE STORED PATH MUST STAY A FILESYSTEM PATH. `look-development.js` reads
 * `row.image_path` off disk to attach the board's look to a shot, so rewriting
 * the column to a URL would fix the display and silently stop the look
 * conditioning any frame. The URL is DERIVED on read instead — the same split
 * every plate already uses.
 *
 * The assertions FETCH the URL. Asserting it is non-null would have passed the
 * entire time: the broken value was a perfectly good string.
 *
 * Set-based over the two ways an image reaches the board, because they are
 * separate writers — the upload route and the generic create — and a fix to one
 * leaves the other invisible.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');

/** A 1x1 PNG, as a data URI — the shape an upload actually arrives in. */
const PNG_1PX = 'data:image/png;base64,'
    + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function withServer(fn) {
    const dir = path.join(os.tmpdir(), 'fe-mood-' + crypto.randomUUID().slice(0, 8));
    fs.mkdirSync(dir, { recursive: true });
    const port = 3700 + Math.floor(Math.random() * 250);
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')],
        { env: { ...process.env, PORT: String(port), FILM_DATA_DIR: dir }, stdio: 'pipe' });
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', () => {});
    const base = `http://localhost:${port}`;
    const call = (m, p, b) => fetch(base + p, {
        method: m, headers: { 'Content-Type': 'application/json' },
        body: b ? JSON.stringify(b) : undefined,
    }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
    try {
        for (let i = 0; i < 120; i++) {
            try { if ((await fetch(base + '/api/health')).ok) break; } catch (_) {}
            await new Promise(r => setTimeout(r, 100));
        }
        return await fn({ base, call });
    } finally {
        proc.kill('SIGKILL');
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
}

test('a board image is served back at a URL that actually resolves', async () => {
    await withServer(async ({ base, call }) => {
        const made = await call('POST', '/film/projects', { title: 'Mood probe' });
        const pid = (made.body.project || made.body).id;
        assert.ok(pid, 'could not create a project');

        // WAY IN 1: the upload control on the page.
        const up = await call('POST', `/film/projects/${pid}/mood-board/import`,
            { data: PNG_1PX, name: 'ref.png', note: 'a film still' });
        assert.ok(up.status < 400, `import failed: ${JSON.stringify(up).slice(0, 200)}`);

        const board = await call('GET', `/film/projects/${pid}/mood-board`);
        const entries = (board.body.entries || []).filter(e => e.image_path || e.image_url);
        assert.strictEqual(entries.length, 1, 'the uploaded image is not on the board at all');

        const e = entries[0];
        assert.ok(e.image_url,
            'the entry carries no image_url — the page has only the filesystem path, which it '
            + 'prefixes with API_BASE and renders as a 404 that onerror hides');

        // FETCHED, not merely present. The broken value was a good string too.
        const got = await fetch(base + e.image_url);
        assert.strictEqual(got.status, 200,
            `GET ${e.image_url} returned ${got.status} — the board image is still not servable`);
        assert.match(String(got.headers.get('content-type') || ''), /image\//,
            'the URL resolves but does not serve an image');

        // And the stored path stays a PATH: the look reads it off disk.
        assert.ok(!e.image_path || path.isAbsolute(e.image_path),
            `image_path became ${e.image_path} — look-development.js reads this off disk, so `
            + 'turning it into a URL fixes the display and stops the look reaching any frame');
    });
});

test('an entry created with an image_path is served the same way', async () => {
    /*
     * WAY IN 2: the generic create, which an agent uses. It accepts
     * `image_path` directly, so an entry can exist with a path this route never
     * imported — and it must display exactly as an uploaded one does.
     */
    await withServer(async ({ base, call }) => {
        const made = await call('POST', '/film/projects', { title: 'Mood probe 2' });
        const pid = (made.body.project || made.body).id;

        const up = await call('POST', `/film/projects/${pid}/mood-board/import`,
            { data: PNG_1PX, name: 'ref2.png' });
        assert.ok(up.status < 400, 'import failed');
        const storedPath = up.body.file_path;
        assert.ok(storedPath, 'the import did not report a file_path to reuse');

        const created = await call('POST', `/film/projects/${pid}/mood-board`,
            { kind: 'image', note: 'pinned by hand', image_path: storedPath });
        assert.ok(created.status < 400, `create failed: ${JSON.stringify(created).slice(0, 200)}`);

        const board = await call('GET', `/film/projects/${pid}/mood-board`);
        const hand = (board.body.entries || []).find(x => x.note === 'pinned by hand');
        assert.ok(hand, 'the hand-pinned entry is missing');
        assert.ok(hand.image_url,
            'an entry created with image_path carries no image_url, so only uploaded images '
            + 'display and hand-pinned ones are invisible');

        const got = await fetch(base + hand.image_url);
        assert.strictEqual(got.status, 200, `GET ${hand.image_url} returned ${got.status}`);
    });
});

test('the page renders the served URL, and does not hide a failure in silence', () => {
    /*
     * Two separate faults in one line. It read the filesystem path, and it
     * swallowed the resulting 404 with `onerror="this.style.display='none'"` —
     * so a board that could not show its pictures looked like a board with no
     * pictures on it. The same rule the loading-placeholder work already set: a
     * failure a user cannot see is one nobody can report accurately.
     */
    const fn = SRC.match(/async function loadMoodBoardPage\(\)[\s\S]*?\n    \}/);
    assert.ok(fn, 'loadMoodBoardPage is gone — this test cannot see how the board is drawn');
    const body = fn[0];

    /*
     * Bound to the <img> SRC specifically. Matching the block for the word
     * `image_url` passed with the src reverted to image_path, because the name
     * still appeared in the click handler beside it — a mutation caught that.
     */
    const img = body.match(/<img src="\$\{API_BASE\}\$\{esc\(e\.([a-z_]+)\)\}"/);
    assert.ok(img, 'the board no longer renders an <img> built from API_BASE at all');
    assert.strictEqual(img[1], 'image_url',
        `the board image is drawn from e.${img[1]} — image_path is a filesystem path, so `
        + 'prefixing it with API_BASE asks the server for /Users/... and 404s');
    assert.ok(!/onerror\s*=\s*"this\.style\.display\s*=\s*'none'"/.test(body),
        'a board image that fails to load is still hidden silently, which is indistinguishable '
        + 'from no image at all — exactly how this was reported');
});

test('the served URL follows the file it points at, whatever directory that is', () => {
    /*
     * `mood-board-image` always lands in `refsheets`, so both fixtures above
     * pass just as happily against a hardcoded subdir — a fixture agreeing with
     * the bug. But the generic create takes ANY path, and pinning a storyboard
     * frame you already made as a look reference is an obvious thing to do.
     * Hardcoded, that entry 404s.
     *
     * Set-based over the directories the import registry actually writes to.
     */
    const { withImageUrl } = require('../routes/mood-board');
    const { MEDIA_IMPORTS } = require('../lib/media-imports');

    const subdirs = [...new Set(Object.values(MEDIA_IMPORTS).map(s => s.subdir))].filter(Boolean);
    assert.ok(subdirs.length >= 2,
        "this test's reading is stale: the import registry now writes to one directory only");

    for (const subdir of subdirs) {
        const abs = path.join('/data', subdir, 'proj-1', 'pic.png');
        const out = withImageUrl({ id: 'x', image_path: abs, created_at: '2026-01-01 00:00:00' });
        assert.ok(out.image_url, `${subdir}: no url derived`);
        assert.ok(out.image_url.includes(subdir),
            `a file in ${subdir}/ was served as ${out.image_url} — the directory is being assumed `
            + 'rather than read from the path, so anything not in the default one 404s');
        assert.ok(out.image_url.includes('proj-1') && out.image_url.includes('pic.png'),
            `${subdir}: the url lost the project or the filename — ${out.image_url}`);
    }
});
