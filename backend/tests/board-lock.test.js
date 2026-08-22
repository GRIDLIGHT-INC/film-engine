/**
 * Locking a board: "I feel it's done."
 *
 * A storyboard is finished work. Every frame on it was paid for, judged and
 * kept — and every one of them sits behind a Regen button that costs money and
 * REPLACES the picture. Nothing distinguished "this frame is a draft" from
 * "this frame is the shot", so the only protection was remembering.
 *
 * A lock is that distinction, made explicit and reversible.
 *
 * Set-based over every path that writes a frame, derived from the call sites of
 * registerStoryboardAsset rather than listed here — a lock that covers Regen
 * and not the whole-board generate is worse than no lock, because it teaches a
 * director the board is safe and then lets one button replace all of it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'storyboard.js'), 'utf8');

/** Every function that writes a storyboard frame to disk and registers it. */
const WRITING_PATHS = (() => {
    const out = new Set();
    const lines = SRC.split('\n');
    let current = null;
    for (const line of lines) {
        const m = line.match(/^(?:async )?function (\w+)\(/);
        if (m) current = m[1];
        if (/registerStoryboardAsset\(/.test(line) && current && current !== 'registerStoryboardAsset') {
            out.add(current);
        }
    }
    return [...out];
})();

test('the set of frame-writing paths is derived and non-trivial', () => {
    assert.ok(WRITING_PATHS.length >= 5,
        `expected every frame-writing path, found ${WRITING_PATHS.length}: ${WRITING_PATHS.join(', ')}`);
});

test('every path that replaces a frame honours the lock', () => {
    // The failure this prevents is partial coverage: a lock on Regen alone
    // teaches a director the board is safe, and then "Generate All" replaces
    // every frame on it.
    const unguarded = WRITING_PATHS.filter(fn => {
        const at = SRC.indexOf(`function ${fn}(`);
        const next = SRC.indexOf('\nfunction ', at + 10);
        const nextAsync = SRC.indexOf('\nasync function ', at + 10);
        const ends = [next, nextAsync].filter(x => x > 0);
        const body = SRC.slice(at, ends.length ? Math.min(...ends) : SRC.length);
        return !/boardLocked|board_locked/.test(body);
    });
    assert.deepStrictEqual(unguarded, [],
        `these replace a frame and ignore the board lock: ${unguarded.join(', ')}`);
});

test('the lock is stored on the project and is reversible', () => {
    const migrations = fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations'))
        .map(f => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f), 'utf8')).join('\n');
    assert.ok(/board_locked_at/.test(migrations),
        'nothing stores the lock, so it cannot survive a restart');

    const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'projects.js'), 'utf8');
    assert.ok(/board-lock/.test(routes), 'there is no route to lock or unlock a board');
    assert.ok(/DELETE/.test(routes), 'a lock with no way off is a trap, not a decision');
});

test('the refusal says what to do, and is overridable', () => {
    // A refusal a director cannot act on becomes a reason to turn the feature
    // off. It names the unlock, and takes an explicit override for the case
    // where one frame genuinely needs redoing.
    assert.ok(/ignore_lock/.test(SRC),
        'a locked board cannot be overridden for a single deliberate regeneration');
    assert.ok(/BOARD_LOCKED/.test(SRC),
        'the refusal has no machine-readable code, so an agent cannot tell it from a real failure');
});

test('a locked board is visible wherever a frame is generated from', () => {
    const HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'index.html'), 'utf8');
    assert.ok(/board_locked|boardLock/.test(HTML),
        'the page never shows whether the board is locked, so the buttons look broken instead');
    assert.ok(/toggleBoardLock|lockBoard/.test(HTML),
        'there is no way to lock the board from the board');
});

test('locking does not block reading, planning or costing', () => {
    // A lock protects the PICTURES. Editing a card, previewing a prompt or
    // reading the board must stay free — otherwise "done" means "frozen", and
    // a director stops locking anything.
    const at = SRC.indexOf('function shotPromptPreview(');
    const body = SRC.slice(at, at + 3000);
    assert.ok(!/boardLocked/.test(body),
        'the free prompt preview refuses when the board is locked, which protects nothing');
});

/**
 * The routes actually RUN.
 *
 * Every check above is a source grep, and all of them passed while
 * GET/PUT/DELETE board-lock returned 500 on the first real call: the handlers
 * called `json()`, which does not exist in routes/projects.js — that module
 * writes its responses directly. A test that asserts a route EXISTS cannot tell
 * you it runs, and the difference is the whole feature.
 */
const os = require('os');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-boardlock-' + crypto.randomUUID().slice(0, 8));

test('lock, read and unlock all return JSON rather than 500', async () => {
    const { db, generateId } = require('../db/database');
    require('../db/schema').ensureSchema();
    const { handleProjects } = require('../routes/projects');

    const pid = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(pid, 'Lock Test');

    const call = (method) => new Promise(resolve => {
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (c) { this.statusCode = c; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            let body = Buffer.concat(chunks).toString();
            try { body = JSON.parse(body); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body });
        });
        Promise.resolve(handleProjects({ method, body: {} }, res,
            ['film', 'projects', pid, 'board-lock'], {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });

    const before = await call('GET');
    assert.strictEqual(before.status, 200, JSON.stringify(before.body));
    assert.strictEqual(before.body.locked, false, 'a new project starts locked');

    const locked = await call('PUT');
    assert.strictEqual(locked.status, 200, JSON.stringify(locked.body));
    assert.strictEqual(locked.body.locked, true);
    assert.ok(locked.body.locked_at, 'a lock with no timestamp cannot answer "when did we call this done"');

    // Locking twice keeps the ORIGINAL moment.
    const again = await call('PUT');
    assert.strictEqual(again.body.locked_at, locked.body.locked_at,
        're-locking re-stamped the timestamp, destroying when the board was finished');

    const unlocked = await call('DELETE');
    assert.strictEqual(unlocked.status, 200, JSON.stringify(unlocked.body));
    assert.strictEqual(unlocked.body.locked, false, 'a lock with no way off is a trap');
});
