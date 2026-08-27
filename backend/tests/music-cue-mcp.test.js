/**
 * An agent can write the music direction, not only press generate.
 *
 * "Is the place for music notes also available on MCP so I can instruct Claude
 * to add the notes?"
 *
 * It was not. `node_gen_music` let an agent GENERATE a cue and there was no
 * tool to create, read or change the cue that carries the direction — so the
 * one field that decides what the music is could only be typed by hand, while
 * the thing that spends money on it was fully reachable.
 *
 * That is the rule this codebase already states: a route that ships without a
 * tool is a thing the app can do and an agent cannot, and the hardest gap to
 * notice because there is no error to read. It is sharper here — the connected
 * model IS the writer, so composing a cue is exactly the work it should be
 * doing.
 *
 * Set-based over the fields the GENERATOR reads, because a tool that can set a
 * mood and not the instruments is a tool that looks complete and writes half
 * the brief.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-cuemcp-' + crypto.randomUUID().slice(0, 8));

const { db } = require('../db/database');
require('../db/schema').ensureSchema();

const { listTools, ALL_ROUTE_TOOLS } = require('../lib/mcp-tools');
const { handleAssets } = require('../routes/assets');

/** Every cue field the music prompt actually reads. */
function fieldsTheGeneratorReads() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'music-prompt.js'), 'utf8');
    const DERIVED = new Set(['duration_s', 'category', 'sound', 'seed']);
    return [...new Set([...src.matchAll(/\bcue\.([a-z_]+)/g)].map(m => m[1]))]
        .filter(f => !DERIVED.has(f));
}

function call(method, urlParts, body, query) {
    return new Promise(resolve => {
        const res = {
            writeHead(s) { this._s = s; },
            end(p) { resolve({ status: this._s, body: p ? JSON.parse(p) : null }); },
        };
        handleAssets({ method, body }, res, urlParts, query || {});
    });
}

// A real hex UUID: the route validates with UUID_RE, and 'mc…' is not hex.
const PROJECT = 'mc000000-0000-4000-8000-000000000001'.replace('mc', 'ac');
test.before(() => {
    db.prepare(`INSERT INTO film_projects (id, title, created_at, updated_at)
                VALUES (?, 'p', datetime('now'), datetime('now'))`).run(PROJECT);
});

test('an agent can create, read, change and remove a cue', () => {
    const names = new Set(listTools().map(t => t.name));
    const missing = ['music_cue_create', 'music_cue_list', 'music_cue_update', 'music_cue_delete']
        .filter(n => !names.has(n));
    assert.deepStrictEqual(missing, [],
        `an agent can generate music and cannot write the brief for it: ${missing.join(', ')}`);
});

test('the create tool can set every field the generator reads', () => {
    /*
     * Derived from the prompt builder. A tool that sets a mood and not the
     * instruments looks complete and writes half the brief — and the half it
     * drops is silently replaced by the mood table's defaults, so the result
     * looks deliberate.
     */
    const tool = ALL_ROUTE_TOOLS.find(t => t.name === 'music_cue_create');
    assert.ok(tool, 'music_cue_create has no registry entry to dispatch through');
    const props = Object.keys(tool.schema || {});
    const missing = fieldsTheGeneratorReads().filter(f => !props.includes(f));
    assert.deepStrictEqual(missing, [],
        `the generator reads these and an agent cannot set them: ${missing.join(', ')}`);
});

test('the description says what actually reaches the model', () => {
    /*
     * `description` is the free text that reaches the prompt and
     * `reference_track` is the style to match; `notes` is production-facing
     * and reaches nothing. A tool that does not say which is which invites an
     * agent to write the brief into the field nobody reads.
     */
    const tool = ALL_ROUTE_TOOLS.find(t => t.name === 'music_cue_create');
    assert.match(tool.description, /description/i,
        'the tool does not name the field that carries the brief');
    assert.match(String(tool.schema.description.description || ''), /reach|prompt|generator/i,
        'the description field does not say it reaches the generator');
});

test('the cue length is optional, and says what blank means', () => {
    // Blank scores the measured cut. An agent told nothing will guess a
    // number, and a guessed length is how every cue became thirty seconds.
    const tool = ALL_ROUTE_TOOLS.find(t => t.name === 'music_cue_create');
    assert.ok(!(tool.required || []).includes('duration_ms'), 'a cue length is being demanded');
    assert.match(String(tool.schema.duration_ms.description || ''), /measured|cut|omit|blank/i,
        'nothing tells an agent that omitting the length scores the real cut');
});

test('the routes those tools need actually exist', async () => {
    const created = await call('POST', ['film', 'projects', PROJECT, 'music-cues'],
        { title: 'Diner, under the dialogue', mood: 'melancholic',
          description: 'Holds under the dialogue, lifts when she stands.',
          reference_track: 'Blade Runner end titles',
          instruments: ['solo cello', 'brushed kit'] });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body).slice(0, 140));
    // createMusicCue returns the bare row, and update matches it.
    const id = created.body.id;

    const updated = await call('PUT', ['film', 'music-cues', id],
        { description: 'Out on the door, not the line before it.' });
    assert.strictEqual(updated.status, 200, 'a cue cannot be changed, so notes can only be written once');
    assert.match(updated.body.description, /Out on the door/);
    assert.strictEqual(updated.body.mood, 'melancholic',
        'updating the description replaced the rest of the cue');

    const removed = await call('DELETE', ['film', 'music-cues', id]);
    assert.strictEqual(removed.status, 200, 'a cue an agent can add cannot be removed');
});

test('the entity registry knows about cues, so the coverage stays derived', () => {
    /*
     * mcp-no-server-llm derives "which verbs need a tool" from a registry of
     * entities. A cue absent from it is a gap the derived test cannot see —
     * which is precisely how this one survived.
     */
    const src = fs.readFileSync(path.join(__dirname, 'mcp-no-server-llm.test.js'), 'utf8');
    assert.match(src, /music_cue_create/,
        'the entity registry does not cover music cues, so the next missing verb is invisible');
});
