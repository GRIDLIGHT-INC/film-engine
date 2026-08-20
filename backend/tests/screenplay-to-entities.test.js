/**
 * The path from a screenplay to entities generation can actually draw.
 *
 * Wingfall generated eight frames in which the title creature was a different
 * animal each time, and the cause was not the image model. `film_characters`
 * held exactly one row — MAYA, typed by hand. The DRAGON had no record at all,
 * so every keyframe invented one, and the project's style string (which
 * contains the words "anatomical beast") filled the vacuum with whatever it
 * felt like: a flayed quadruped in the establishing shot that the scene card
 * describes as "Empty, ordinary, still."
 *
 * Three things have to be true for that to stop happening, and none of them
 * was:
 *
 *   DETECT   The suggestions endpoint collects characters from `el.type ===
 *            'character'` — dialogue cues. A creature introduced in an action
 *            line in caps, which is exactly how screenplays introduce one, is
 *            invisible. The dragon was never even suggested.
 *
 *   CREATE   Nothing creates entities. Suggestions return
 *            `suggested_action: 'create'` and stop; INSERT INTO film_characters
 *            appears only in the manual CRUD route and the demo seeder. So the
 *            user hand-types every entity, and whatever they forget is
 *            re-invented per frame, silently.
 *
 *   DESCRIBE The breakdown READS appearance_prompt for context and never
 *            writes it. An entity that exists but has no description reaches
 *            buildStoryboardPrompt as a bare name, which is the same wrong
 *            subject one level down.
 *
 * Set-based over the entity kinds because the failure is per-kind and partial:
 * locations were fine (a real 200-character description, and the location plate
 * is genuinely consistent across all eight frames), characters were half-done,
 * props were absent entirely. A test written against "the dragon" passes the
 * moment one row exists and tells you nothing about the next production.
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-s2e-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
const { ensureSchema } = require('../db/schema');
ensureSchema();

const { handleScripts } = require('../routes/scripts');
const mcp = require('../lib/mcp-tools');

/**
 * A screenplay that introduces its characters the way screenplays do: one
 * speaks, one does not. The one that does not speak is the title character.
 */
const SCREENPLAY = `EXT. SUBURBAN STREET - DUSK

Wet asphalt. Basketball hoops. A sprinkler ticking over a lawn.

MAYA (30s), grocery bag on her hip, looks up.

MAYA

Get inside. GET INSIDE!

She drops the bag. Oranges roll into the gutter.

EXT. SUBURBAN STREET - CONTINUOUS

The DRAGON drops out of the low cloud, wings cracking like sailcloth.
`;

function call(method, urlPath, body) {
    return new Promise(resolve => {
        const parts = urlPath.split('?')[0].split('/').filter(Boolean);
        const chunks = [];
        const res = new Writable({ write(c, _e, n) { chunks.push(c); n(); } });
        res.statusCode = 200;
        res.writeHead = function (code) { this.statusCode = code; return this; };
        res.setHeader = function () {};
        res.on('finish', () => {
            let parsed = Buffer.concat(chunks).toString();
            try { parsed = JSON.parse(parsed); } catch (_) { /* not json */ }
            resolve({ status: res.statusCode, body: parsed });
        });
        Promise.resolve(handleScripts({ method, body: body || {} }, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message } }));
    });
}

async function projectWithScript() {
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Wingfall Test');
    const r = await call('POST', `/film/projects/${projectId}/script`, {
        fountain_content: SCREENPLAY, format: 'fountain', title: 'Wingfall',
    });
    assert.ok(r.status < 400, `script upload failed: ${JSON.stringify(r.body)}`);
    return projectId;
}

/**
 * The entity kinds a storyboard prompt reads. Each needs the same three things
 * from the pipeline, by different mechanisms — a location comes off a scene
 * heading, a prop can only really come from reading the action.
 */
const ENTITY_KINDS = [
    {
        id: 'character',
        table: 'film_characters',
        describedBy: 'appearance_prompt',
        mcpCreate: 'character_create',
        suggestionKey: 'unmatched_characters',
        // The one that was missing: introduced in action, never speaks.
        mustDetect: 'DRAGON',
    },
    {
        id: 'location',
        table: 'film_locations',
        describedBy: 'description',
        mcpCreate: 'location_create',
        suggestionKey: 'unmatched_locations',
        mustDetect: 'SUBURBAN STREET',
    },
    {
        id: 'prop',
        table: 'film_props',
        describedBy: 'visual_prompt',
        mcpCreate: 'prop_create',
        suggestionKey: 'unmatched_props',
        mustDetect: null,   // props come from the breakdown reading action, not a pattern
    },
];

test('the entity registry covers what a storyboard prompt reads', () => {
    const ids = ENTITY_KINDS.map(k => k.id).sort();
    assert.deepStrictEqual(ids, ['character', 'location', 'prop'],
        'gatherShotReferences reads exactly these three kinds');
});

test('every entity kind can be created without hand-typing it', async () => {
    const projectId = await projectWithScript();
    const suggestions = await call('GET', `/film/projects/${projectId}/screenplay/suggestions`);
    assert.ok(suggestions.status < 400, `suggestions failed: ${JSON.stringify(suggestions.body)}`);

    const applied = await call('POST', `/film/projects/${projectId}/screenplay/suggestions/apply`, {
        // Props come from reading the action, not from matching a slug, so they
        // arrive through the body the way the breakdown supplies them.
        props: [{ name: 'Grocery bag', visual_prompt: 'brown paper grocery bag, oranges spilling' }],
    });
    const broken = [];
    if (applied.status >= 400) {
        broken.push(`no apply endpoint (${applied.status}): entities must be typed by hand`);
    } else {
        for (const kind of ENTITY_KINDS) {
            const n = db.prepare(`SELECT COUNT(*) c FROM ${kind.table} WHERE project_id = ?`).get(projectId).c;
            if (!n) broken.push(`${kind.id}: apply created none`);
        }
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

test('a character introduced in action, who never speaks, is still found', async () => {
    // The whole Wingfall failure in one assertion. Detection keyed on dialogue
    // cues cannot see a creature, and a creature is exactly what the film is of.
    const projectId = await projectWithScript();
    const r = await call('GET', `/film/projects/${projectId}/screenplay/suggestions`);
    const names = (r.body.unmatched_characters || []).map(c => String(c.name).toUpperCase());
    assert.ok(names.includes('DRAGON'),
        `the title creature was never suggested; found only: ${names.join(', ') || '(none)'}`);
});

test('every entity kind is creatable over MCP, so an agent can fill a production', () => {
    // The rabbit hole: AI work should go through MCP. character_update and
    // location_update both require an existing id, and nothing creates one, so
    // an agent host could describe entities it was powerless to bring into
    // existence.
    const tools = new Set(mcp.listTools().map(t => t.name));
    const missing = ENTITY_KINDS.filter(k => !tools.has(k.mcpCreate)).map(k => k.mcpCreate);
    assert.deepStrictEqual(missing, [], `no MCP tool to create these: ${missing.join(', ')}`);
});

test('no entity reaches generation as a bare name or a placeholder', async () => {
    const projectId = await projectWithScript();
    await call('POST', `/film/projects/${projectId}/screenplay/suggestions/apply`, {
        characters: [{ name: 'DRAGON', appearance_prompt: 'vast winged reptile, teal scales, tan wing membranes' }],
        locations: [{ name: 'SUBURBAN STREET', description: 'Late-1970s cul-de-sac, weathered two-storey houses' }],
        props: [{ name: 'Grocery bag', visual_prompt: 'brown paper grocery bag, oranges spilling' }],
    });

    const bad = [];
    for (const kind of ENTITY_KINDS) {
        const rows = db.prepare(
            `SELECT name, ${kind.describedBy} AS described FROM ${kind.table} WHERE project_id = ?`).all(projectId);
        for (const row of rows) {
            const d = String(row.described || '').trim();
            if (!d) { bad.push(`${kind.id} ${row.name}: ${kind.describedBy} is empty`); continue; }
            // The placeholder that reached real prompts: "EXT location (3
            // mentions in screenplay)" was generated as a description and shipped
            // into the image prompt as though it described a place.
            if (/\(\d+ mentions?/i.test(d) || /^(EXT|INT)\s+location/i.test(d)) {
                bad.push(`${kind.id} ${row.name}: ${kind.describedBy} is a placeholder (${JSON.stringify(d.slice(0, 60))})`);
            }
        }
    }
    assert.deepStrictEqual(bad, [], `\n  ${bad.join('\n  ')}`);
});


test('a non-speaking character is present in the scene it appears in', async () => {
    // PAR-008. Presence was keyed on dialogue cues, so on Wingfall the scenes
    // read ["MAYA"], [], ["MAYA"] and the DRAGON — the title creature — was
    // present in no scene at all. Every report built on presence (sides, DOOD,
    // continuity) inherits that hole, which is why it is repaired before the
    // reports are written rather than after.
    const projectId = await projectWithScript();
    const scenes = db.prepare('SELECT scene_number, characters_present FROM film_scenes WHERE project_id = ? ORDER BY scene_number')
        .all(projectId);
    assert.ok(scenes.length, 'no scenes were created from the screenplay');

    const everyone = new Set();
    for (const sc of scenes) {
        let list = [];
        try { list = JSON.parse(sc.characters_present || '[]'); } catch (_) { list = []; }
        for (const n of list) everyone.add(String(n).toUpperCase());
    }
    assert.ok(everyone.has('MAYA'), 'the speaking character is missing from presence');
    assert.ok(everyone.has('DRAGON'),
        `the non-speaking character is present in no scene; found: ${[...everyone].join(', ') || '(none)'}`);
});

test('a possessive is the same subject, not a new one', () => {
    // The apostrophe lives inside the caps class so O'BRIEN survives as one
    // name — which also meant "the SEDAN's roof" captured SEDAN', a phantom one
    // keystroke from the real thing. The two then diverge: two rows, two
    // plates, two descriptions, and a report listing the car twice while each
    // half looks perfectly correct.
    const { actionCapsInLine } = require('../routes/scripts');
    const names = line => Object.keys(actionCapsInLine(line));

    for (const line of ["The SEDAN's roof is dulled to chalk.", "The SEDAN\u2019s roof is dulled to chalk."]) {
        assert.deepStrictEqual(names(line), ['SEDAN'], `possessive leaked into the name: ${line}`);
    }
    // Straight and curly, because a screenplay written in a word processor has
    // the curly one and a screenplay written in an editor has the other.
    assert.deepStrictEqual(names("O'BRIEN steps off the porch."), ["O'BRIEN"],
        'an internal apostrophe was stripped, splitting one name into a shorter wrong one');
    assert.deepStrictEqual(names('MAYA runs flat-out down the street.'), ['MAYA']);
});
