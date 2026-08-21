/**
 * Phase 2 — structure you can author, keep, and export.
 *
 * Film Engine parses, stores and prints all 13 Fountain element types and lets
 * a writer produce **six**. Five are unreachable, in two different ways, and the
 * distinction decides the fix:
 *
 *   - `section` and `synopsis` are UNKNOWN: the editor's format rules have never
 *     heard of them.
 *   - `centered`, `lyrics` and `note` are STRANDED: the rules name them, say
 *     what follows them, and render them — and nothing can enter one. They
 *     appear only in Fountain that arrived from an import or over MCP.
 *
 * And what cannot be exported is worse than what cannot be typed. FDX drops
 * `section` and `synopsis` outright, so an outline written here vanishes on the
 * way to Final Draft; and it maps `note` to `Action`, which puts a private
 * production note into the screenplay body — the only one of the three defects
 * that changes what the script SAYS.
 *
 * Set-based over the five elements and the three export defects, because they
 * are not one bug and a fix for any one of them passes a test written against
 * another. The two questions this file answers are the phase's own acceptance:
 * can every element the editor knows be reached, and does an outline survive a
 * round trip to Final Draft.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

process.env.FILM_DATA_DIR = process.env.FILM_DATA_DIR
    || path.join(os.tmpdir(), 'film-engine-struct-' + crypto.randomUUID().slice(0, 8));

const { db, generateId } = require('../db/database');
require('../db/schema').ensureSchema();

const ROOT = path.join(__dirname, '..', '..');
const html = () => fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');

function callRoute(handler, method, urlPath, body) {
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
        Promise.resolve(handler({ method, body: body || {} }, res, parts, {}))
            .catch(err => resolve({ status: 500, body: { error: err.message, stack: err.stack } }));
    });
}

/**
 * The five, with the Fountain syntax that produces each.
 *
 * Every one has a FORCED MARKER in the format — the same mechanism `.` already
 * uses to force a scene heading. So the way in is the syntax itself, not a
 * toolbar: a writer types `# ACT ONE` and gets a section, exactly as they type
 * `> THE END <` and get a centered line. Anything else would be a second
 * convention to learn for a format that already has one.
 */
const UNREACHABLE = [
    { type: 'section',  line: '# ACT ONE',                  was: 'unknown'  },
    { type: 'synopsis', line: '= She walks out to the sluice.', was: 'unknown'  },
    { type: 'centered', line: '> THE END <',                was: 'stranded' },
    { type: 'lyrics',   line: '~ and the water went out',   was: 'stranded' },
    { type: 'note',     line: '[[check the tide tables]]',  was: 'stranded' },
];

// ── Can a writer produce it? ────────────────────────────────────────────

test('the editor knows every element the parser can emit', () => {
    // `nextType` is the editor's own declaration of what it can be in. An
    // element missing from it is one the editor has never heard of.
    const src = html();
    const nt = src.match(/nextType:\s*\{([\s\S]*?)\}/);
    assert.ok(nt, 'AUTO_FORMAT_RULES.nextType is gone');
    const known = [...nt[1].matchAll(/'([a-z-]+)'\s*:/g)].map(m => m[1]);

    const missing = UNREACHABLE
        .map(u => u.type.replace(/_/g, '-'))
        .filter(t => !known.includes(t));
    assert.deepStrictEqual(missing, [],
        `the editor still does not know: ${missing.join(', ')}`);
});

test('every previously unreachable element has a way in', () => {
    // The stranded class: known, renderable, and no route to it. Each of these
    // has a forced marker in Fountain, so detection from the line's own text is
    // the way in — the mechanism `.` already uses for a scene heading.
    const src = html();
    const patterns = src.match(/patterns:\s*\{([\s\S]*?)\n\s{8}\}/);
    assert.ok(patterns, 'AUTO_FORMAT_RULES.patterns is gone');

    const bodyOf = name => {
        const i = src.indexOf('function ' + name + '(');
        return i < 0 ? '' : src.slice(i, i + 4000);
    };
    const produced = new Set();
    for (const fn of ['autoDetectElementType', 'detectElementTypeImmediate']) {
        for (const m of bodyOf(fn).matchAll(/detectedType\s*=\s*'([a-z-]+)'|return\s+'([a-z-]+)'/g)) {
            produced.add(m[1] || m[2]);
        }
    }

    const stuck = UNREACHABLE
        .map(u => u.type.replace(/_/g, '-'))
        .filter(t => !produced.has(t));
    assert.deepStrictEqual(stuck, [],
        `no classifier can produce: ${stuck.join(', ')} — they remain unreachable by typing`);
});

test('each forced marker is actually matched by its pattern', () => {
    // A type the classifier can name is still unreachable if the regex that
    // triggers it never fires. Every marker is tested against the real pattern.
    const src = html();
    const grab = name => {
        const m = src.match(new RegExp(name + ':\\s*(/(?:[^/\\\\\\n]|\\\\.)+/[gimsuy]*)'));
        return m ? m[1] : null;
    };
    const wired = {
        section: grab('section'), synopsis: grab('synopsis'),
        centered: grab('centered'), lyrics: grab('lyrics'), note: grab('note'),
    };

    const broken = [];
    for (const u of UNREACHABLE) {
        const raw = wired[u.type];
        if (!raw) { broken.push(`${u.type}: no pattern declared`); continue; }
        const lit = raw.match(/^\/(.*)\/([gimsuy]*)$/);
        let re;
        try { re = new RegExp(lit[1], lit[2].replace('g', '')); }
        catch (err) { broken.push(`${u.type}: pattern will not compile — ${err.message}`); continue; }
        if (!re.test(u.line)) broken.push(`${u.type}: "${u.line}" does not match ${raw}`);
    }
    assert.deepStrictEqual(broken, [], `\n  ${broken.join('\n  ')}`);
});

// ── Does it survive the round trip? ─────────────────────────────────────

const OUTLINE = `Title: From the Mist

# ACT ONE

## The Harbour

= Ley walks out to the sluice at the lowest water since March.

EXT. HARBOUR - DAWN

The water is gone.

[[check the tide tables before the rewrite]]

MAREK
Lowest since March.

> THE END <
`;

test('an outline survives a round trip to Final Draft', () => {
    // The phase's stated acceptance. Structure the script here, export it, and
    // the act structure must still be there.
    const { parseFountain } = require('../lib/fountain-parser');
    const { generateFDX } = require('../lib/fdx-generator');
    const xml = generateFDX(parseFountain(OUTLINE), { Title: 'From the Mist' });

    const lost = [];
    if (!/ACT ONE/.test(xml)) lost.push('section (# ACT ONE)');
    if (!/The Harbour/.test(xml)) lost.push('section (## The Harbour)');
    if (!/lowest water since March/.test(xml)) lost.push('synopsis');
    assert.deepStrictEqual(lost, [], `Final Draft export dropped: ${lost.join(', ')}`);
});

test('a production note is not exported as script text', () => {
    // The worst of the three defects, and the only one that changes what the
    // script SAYS. FDX_TYPE_MAP.note = 'Action' put a private note into the
    // screenplay body.
    const map = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fdx-generator.js'), 'utf8')
        .match(/FDX_TYPE_MAP\s*=\s*\{([\s\S]*?)\}/)[1];
    assert.ok(!/note:\s*'Action'/.test(map),
        'a Fountain note is still exported as Action — it lands in the screenplay body');

    const { parseFountain } = require('../lib/fountain-parser');
    const { generateFDX } = require('../lib/fdx-generator');
    const xml = generateFDX(parseFountain(OUTLINE), {});
    assert.ok(!/<Text>check the tide tables before the rewrite<\/Text>/.test(xml)
        || /ScriptNote|Type="Note"/i.test(xml),
        'the note reached Final Draft as ordinary script text');
});

test('the three FDX defects are fixed as three different things', () => {
    // Dropped, wrongly promoted, lossy. A single "handle the rest as Action"
    // would satisfy a test for any one of them and re-commit the note bug.
    const map = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fdx-generator.js'), 'utf8')
        .match(/FDX_TYPE_MAP\s*=\s*\{([\s\S]*?)\}/)[1];
    const missing = ['section', 'synopsis'].filter(t => !new RegExp(`\\b${t}\\s*:`).test(map));
    assert.deepStrictEqual(missing, [], `still dropped on export: ${missing.join(', ')}`);
    // Boneyard stays dropped: it is text deliberately cut, and exporting it
    // would resurrect the cuts.
    assert.ok(!/\bboneyard\s*:/.test(map), 'boneyard is now exported — it should stay cut');
});

// ── The outline over MCP ────────────────────────────────────────────────

test('outline_get and outline_write are on the MCP surface', () => {
    const { listTools } = require('../lib/mcp-tools');
    const names = listTools().map(t => t.name);
    const missing = ['outline_get', 'outline_write'].filter(n => !names.includes(n));
    assert.deepStrictEqual(missing, [], `missing MCP tools: ${missing.join(', ')}`);
});

test('the outline reads back the structure that was written', async () => {
    const { handleScripts } = require('../routes/scripts');
    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Outline');
    await callRoute(handleScripts, 'POST', `/film/projects/${projectId}/script`,
        { fountain_content: OUTLINE });

    const r = await callRoute(handleScripts, 'GET', `/film/projects/${projectId}/outline`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    const flat = JSON.stringify(r.body);
    assert.match(flat, /ACT ONE/, 'the outline has no sections');
    assert.match(flat, /The Harbour/, 'the outline lost the nested section');
    assert.match(flat, /lowest water since March/, 'the outline has no synopsis');
    // Depth is what makes it an outline rather than a list.
    const depths = (r.body.outline || []).filter(n => n.type === 'section').map(n => n.depth);
    assert.ok(depths.includes(1) && depths.includes(2),
        `section depth was not preserved: ${JSON.stringify(depths)}`);
});

// ── The handoff to the pipeline ─────────────────────────────────────────

test('every project sub-route the scripts module handles is reachable', () => {
    // The fourth occurrence of this in one codebase: a handler exists, no route
    // reaches it, and the module-level test passes because it calls the handler
    // directly. `outline` shipped this way — GET returned the project and POST
    // returned "Method not allowed", because the generic /projects/:id route
    // swallowed it.
    //
    // Derived from the module's own routing so the next sub-route is checked
    // without anyone remembering to.
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'scripts.js'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    const subs = new Set();
    for (const m of routeSrc.matchAll(/\bsub === '(\w+)'/g)) subs.add(m[1]);
    assert.ok(subs.size >= 3, `only ${subs.size} sub-routes found — the scan is broken`);

    const unreachable = [...subs].filter(sub => !new RegExp(`parts\\[3\\] === '${sub}'`).test(serverSrc));
    assert.deepStrictEqual(unreachable, [],
        `routes/scripts.js handles these and server.js never routes to them: ${unreachable.join(', ')}`);
});

test('an appended chapter can reach shots over MCP', async () => {
    // The goal's acceptance criterion is a finished film, and breakdown_run is
    // deliberately absent from MCP under the no-server-LLM rule. So the path
    // from a written scene to a shot must exist and be provably walkable —
    // otherwise phase 1 ships a screenplay that cannot become a movie.
    const { handleScripts } = require('../routes/scripts');
    const { handleShots } = require('../routes/shots');
    const { handleScenes } = require('../routes/scenes');

    const projectId = generateId();
    db.prepare('INSERT INTO film_projects (id, title) VALUES (?, ?)').run(projectId, 'Handoff');
    await callRoute(handleScripts, 'POST', `/film/projects/${projectId}/script`,
        { fountain_content: 'EXT. HARBOUR - DAWN\n\nThe water is gone.\n' });
    await callRoute(handleScripts, 'POST', `/film/projects/${projectId}/script/append`,
        { fountain: 'EXT. SLUICE - MORNING\n\nLEY wades out to the gate.\n' });

    const list = await callRoute(handleScenes, 'GET', `/film/projects/${projectId}/scenes`);
    const appended = list.body.scenes.find(s => String(s.location).includes('SLUICE'));
    assert.ok(appended, 'the appended scene is not in the scene list');

    const made = await callRoute(handleShots, 'POST', '/film/shots', {
        scene_id: appended.id,
        cards: [{ shot_code: '2A', action: 'LEY wades out to the gate.', camera: { shot_type: 'wide' } }],
    });
    assert.ok(made.status < 400, `a shot could not be created on an appended scene: ${JSON.stringify(made.body)}`);

    const shots = db.prepare('SELECT * FROM film_shots WHERE scene_id = ?').all(appended.id);
    assert.strictEqual(shots.length, 1, 'the appended scene has no shot');

    const { listTools } = require('../lib/mcp-tools');
    const names = listTools().map(t => t.name);
    for (const tool of ['shot_tag', 'shot_create']) {
        assert.ok(names.includes(tool), `${tool} is missing — the handoff cannot be driven from Claude Desktop`);
    }
    assert.ok(!names.includes('breakdown_run'),
        'breakdown_run is back on the MCP surface — it hands reasoning to a server-side LLM');
});
