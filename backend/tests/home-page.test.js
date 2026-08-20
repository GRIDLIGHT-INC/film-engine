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

test('the phase fractions are the six the app already uses', () => {
    // The UI declares write/plan/look/make/edit/deliver for its phase track.
    // A home page inventing a second list would drift from the navigation on
    // the first change to either.
    const src = html();
    const declared = src.slice(src.indexOf('var PHASES = ['), src.indexOf('var PHASES = [') + 900);
    for (const id of ['write', 'plan', 'look', 'make', 'edit', 'deliver']) {
        assert.ok(new RegExp(`id:'${id}'`).test(declared), `the phase track lost ${id}`);
    }
    assert.ok(/PHASE_IDS|FE_PHASES|var PHASES/.test(src), 'no shared phase list to build the home page from');
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
