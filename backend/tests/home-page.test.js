/**
 * The home page the design asks for, block by block.
 *
 * The submitted design is six blocks and the built dashboard shared exactly one
 * of them by name. The rest was a quick-nav button row, a stat grid, a shot-status
 * bar and a milestone list — a report on the project rather than a way into the
 * work, which is what the design is: it opens on what you were doing, what needs
 * you, where the film is, and what is running right now.
 *
 * Set-based over the blocks, because a home page is exactly the thing that gets
 * half-built: two of six blocks look like progress and read like the same old
 * dashboard with a new heading. Each block is checked in three ways — it renders,
 * it is fed by real data, and the data is served — since a block with hardcoded
 * placeholder text passes any check that only looks for the markup.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-home-' + crypto.randomUUID().slice(0, 8));

const { ensureSchema } = require('../db/schema');
ensureSchema();

const INDEX_HTML = path.join(__dirname, '..', '..', 'src', 'index.html');
const html = () => fs.readFileSync(INDEX_HTML, 'utf8');

/**
 * The six blocks, derived from the submitted design.
 *
 * `element` is the container the block renders into; `feeds` is the field of the
 * home payload that fills it — named so a block cannot be satisfied by static
 * markup; `serves` is the key the API must return.
 */
const BLOCKS = [
    { id: 'greeting', element: 'homeGreeting', feeds: 'greeting', serves: 'greeting',
      why: 'who is here, which film, and how big it is' },
    { id: 'resume', element: 'homeResume', feeds: 'resume', serves: 'resume',
      why: 'pick up where you left off, without hunting for it' },
    { id: 'needs', element: 'homeNeeds', feeds: 'needs', serves: 'needs',
      why: 'what is actually blocking the film, each with a way in' },
    { id: 'phases', element: 'homePhases', feeds: 'phases', serves: 'phases',
      why: 'the whole film phase by phase, with real fractions' },
    { id: 'activity', element: 'homeActivity', feeds: 'activity', serves: 'activity',
      why: 'what happened, most recent first' },
    { id: 'running', element: 'homeRunning', feeds: 'running', serves: 'running',
      why: 'what is generating right now, and how far along' },
];

test('the block set matches the submitted design', () => {
    assert.strictEqual(BLOCKS.length, 6, 'the design has six blocks');
    const ids = new Set(BLOCKS.map(b => b.id));
    assert.strictEqual(ids.size, 6, 'two blocks share an id');
});

test('every block renders into a container of its own', () => {
    const src = html();
    const missing = BLOCKS.filter(b => !src.includes(`id="${b.element}"`)).map(b => b.id);
    assert.deepStrictEqual(missing, [],
        `these blocks have nowhere to render: ${missing.join(', ')}`);
});

test('every block is filled from the payload, not from static markup', () => {
    // A block hardcoded with the design's own sample text passes any check that
    // only looks for the container.
    const src = html();
    const unfed = BLOCKS.filter(b => !new RegExp(`home\\.${b.feeds}\\b`).test(src)).map(b => b.id);
    assert.deepStrictEqual(unfed, [],
        `these blocks render but read no data: ${unfed.join(', ')}`);
});

test('the API serves a field for every block', async () => {
    const { handleDashboard } = require('../routes/dashboard');
    const { db, generateId } = require('../db/database');
    const { Writable } = require('stream');

    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Home Test');

    const chunks = [];
    const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
    res.writeHead = function (code) { this.statusCode = code; return this; };
    res.setHeader = function () {};
    const body = await new Promise(resolve => {
        res.on('finish', () => {
            let parsed = Buffer.concat(chunks).toString();
            try { parsed = JSON.parse(parsed); } catch (_) { /* not json */ }
            resolve(parsed);
        });
        handleDashboard({ method: 'GET' }, res, ['film', 'projects', projectId, 'home'], {});
    });

    const missing = BLOCKS.filter(b => body[b.serves] === undefined).map(b => b.id);
    assert.deepStrictEqual(missing, [],
        `the home payload serves nothing for: ${missing.join(', ')} (got: ${Object.keys(body).join(', ')})`);
});

test('the phase fractions are declared once, and the page renders what it is served', () => {
    /*
     * This used to assert that home's phases matched the SPA's `var PHASES` —
     * the phase track — on the reasoning that a second list would drift from
     * the navigation. That match was a COINCIDENCE, and it stopped being true
     * when the menu was reorganised into four groups: the track is where you
     * work, and these six are how far the film has got. They are different
     * questions and collapsing one into the other would throw away either a
     * menu group or a measurement.
     *
     * What actually prevents drift is that there is only one list: lib/home.js
     * declares the six, and homePhasesHtml renders whatever it is handed. So
     * that is what is checked — the page must not grow its own copy.
     */
    const { PHASES } = require('../lib/home');
    assert.deepEqual(PHASES.map(p => p.id),
        ['write', 'plan', 'look', 'make', 'edit', 'deliver'],
        'the progress phases changed; the home page measures these six');

    const src = html();
    const render = src.slice(src.indexOf('function homePhasesHtml'),
        src.indexOf('function homeActivityHtml'));
    assert.ok(/\(phases \|\| \[\]\)\.map/.test(render),
        'homePhasesHtml no longer renders the served list');
    for (const id of PHASES.map(p => p.id)) {
        assert.ok(!new RegExp(`id:\\s*'${id}'`).test(render),
            `the page declares its own '${id}' phase — a second copy that will drift`);
    }
});

test('every needs-you item carries a way in', () => {
    // The design puts a link on each line. An item that names a problem and not
    // its page is a to-do list that makes you find the page yourself.
    const src = html();
    const fn = src.slice(src.indexOf('function homeNeedsHtml('));
    assert.ok(fn.length > 0, 'nothing renders the needs list');
    const body = fn.slice(0, fn.indexOf('\n    }'));
    assert.ok(/navigateTo\(/.test(body), 'a needs item does not link anywhere');
});


/**
 * Every button on the home page has to DO something.
 *
 * Resume did nothing at all: it called openFrameViewer, whose frame list is
 * filled only by loadStoryboard, so from the home page the lookup always missed
 * and the function returned silently. No error, no message — indistinguishable
 * from a working button until you press it, which is precisely the failure the
 * nav-chrome work went looking for and this page shipped anyway.
 *
 * Derived from the markup rather than listed, so a seventh button added later
 * is checked too.
 */
test('every handler the home page calls is actually defined', () => {
    const src = html();
    // Every home render function, which is where the page's own buttons live.
    // Bounded by the first and the last rather than by a pair in the middle, so
    // a block added between them is inside the region rather than skipped.
    const first = src.indexOf('function homeGreetingHtml');
    const last = src.indexOf('function homeRunningHtml');
    assert.ok(first > 0 && last > first, 'the home render functions moved');
    const region = src.slice(first, src.indexOf('\n    }', last) + 6);
    const called = new Set();
    for (const m of region.matchAll(/onclick="(?:event\.preventDefault\(\);)?([A-Za-z_$][\w$]*)\(/g)) {
        called.add(m[1]);
    }
    // Two distinct handlers across six blocks is correct — most blocks navigate
    // — so this guards the SCAN rather than the count: if the regex stopped
    // matching, every name would resolve vacuously.
    const sites = [...region.matchAll(/onclick=/g)].length;
    assert.ok(sites >= 5, `found only ${sites} onclick sites in the home blocks — the scan is broken`);
    assert.ok(called.size >= 2, `found only ${called.size} distinct handlers`);

    const missing = [...called].filter(fn =>
        !new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\(`).test(src));
    assert.deepStrictEqual(missing, [],
        `home page calls handlers that do not exist: ${missing.join(', ')}`);
});

test('resume opens the frame rather than silently doing nothing', () => {
    const src = html();
    assert.ok(/onclick="resumeShot\(/.test(src),
        'Resume is not wired to a resume handler');
    const fn = src.slice(src.indexOf('async function resumeShot'), src.indexOf('async function resumeShot') + 400);
    assert.ok(/navigateTo\('storyboard'\)/.test(fn),
        'Resume does not take you to the board, so closing the viewer leaves you where you were not working');
    assert.ok(/openFrameViewer\(/.test(fn), 'Resume does not open the frame');
});

test('the frame viewer loads the board when it does not have it', () => {
    // The root cause. FRAME_VIEWER.frames is populated by loadStoryboard, so
    // any caller from another page found an empty list and hit `return`.
    const src = html();
    const start = src.indexOf('async function openFrameViewer');
    assert.ok(start > 0, 'openFrameViewer is not async, so it cannot load the board it needs');
    const fn = src.slice(start, start + 900);
    assert.ok(/await loadStoryboard\(\)/.test(fn),
        'openFrameViewer still assumes the board is already loaded');
    assert.ok(/setStatus\(/.test(fn),
        'a shot that genuinely cannot be found still fails silently');
});
